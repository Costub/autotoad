# Phase 5 — Looper

## Goal

A quantized, sample-accurate loop station.

**The core user experience, stated plainly (this is the contract):** you press Record, sing/beatbox for the loop length, and the moment recording ends the layer **immediately starts looping and keeps playing on its own**. You then press Record again and perform a new part **over** the still-playing layers; that becomes layer 2, also looping. Repeat up to 8 stacked layers, each independently mutable/removable, all staying in time with each other indefinitely. Recording never interrupts playback of existing layers.

Scope:

- Tempo (default 90 BPM) + bars (default 2, 4/4) → exact loop length in samples. BPM control and the metronome already exist from Phase 4.0.4 — reuse that metronome; this phase adds the count-in and loop-boundary logic on top of it.
- **Capture happens inside `ToadProcessor`** (the worklet copies its own output blocks into a preallocated buffer) — never MediaRecorder.
- Record arm/disarm quantized to loop boundaries; armed state visible in UI.
- Each finished layer plays back via `AudioBufferSourceNode` looping sample-accurately, all layers phase-locked to a shared `loopEpoch`.
- Up to 8 layers; overdub = a new layer; per-layer mute/volume/clear + reverb send; engine-settings snapshot per layer for display.
- Latency compensation so layers align with what the performer heard.
- Firefly row in the visualizer (one per layer, pulsing on the loop boundary).

## Prerequisites

Phase 4 complete (Transport/Tone available, FX bus exists).

## Files to create / modify

```
create: src/audio/looper/looper.ts
create: src/ui/LooperPanel.tsx
create: tests/looper.test.ts
modify: src/audio/worklets/toad-processor.ts   (capture path)
modify: src/audio/engine.ts                    (looper integration, panic stops record)
modify: src/state/store.ts                     (layers UI state, recording/armed state)
modify: src/ui/pixi/pitchScene.ts              (fireflies)
modify: src/ui/Console.tsx                     (mount LooperPanel in the Loop dock group)
```

---

## 5.1 Timing model (pure math — put in `looper.ts`, test it)

```ts
export interface LoopSpec {
  bpm: number;         // beats per minute
  bars: number;        // 4/4 assumed
  sampleRate: number;  // Hz
}
export function loopLengthSamples(s: LoopSpec): number {
  // bars * 4 beats * (60/bpm) seconds * sampleRate, rounded to nearest integer sample.
  return Math.round(s.bars * 4 * (60 / s.bpm) * s.sampleRate);
}
/** Next loop-boundary time in CONTEXT SAMPLES at-or-after `nowSamples`,
 *  given the epoch (context sample count at loop position 0). */
export function nextBoundarySamples(nowSamples: number, epochSamples: number, loopLen: number): number {
  if (nowSamples <= epochSamples) return epochSamples;
  const k = Math.ceil((nowSamples - epochSamples) / loopLen);
  return epochSamples + k * loopLen;
}
```

Everything is anchored to **`loopEpoch`**: the AudioContext time (converted to samples: `ctx.currentTime * sampleRate`) at which loop position 0 first occurs — set once when the transport starts, stored in the looper. BPM/bars changes are only allowed while no layers exist (v1 simplification: disable the tempo/bars controls once layer 1 exists; re-enable after clearing all layers).

## 5.2 Worklet capture path (protocol — implement exactly)

The worklet knows time as `currentFrame` (global in AudioWorkletGlobalScope; if unavailable, count samples processed since construction — but `currentFrame` exists in Chromium). Main thread ↔ worklet messages over `node.port`:

```ts
// main -> worklet
{ type: 'record-arm', startFrame: number, lengthSamples: number, recordingId: number }
{ type: 'record-cancel' }
// worklet -> main
{ type: 'record-done', recordingId: number, buffer: ArrayBuffer /* Float32Array.buffer, transferred */,
  channels: 1, actualStartFrame: number }
```

Worklet behavior:

- On `record-arm`: allocate `new Float32Array(lengthSamples)` **immediately** (in the message handler, not in `process()` — allocation in process is a p95 killer) and store `{ startFrame, writeIndex: -1 }`.
- In `process()`: the block spans `[currentFrame, currentFrame + 128)`. Mix a **mono capture signal** = the same wet+dry mix that goes to the output, pre-FX (i.e. what the worklet outputs, summed L+R × 0.5 — FX live on the Tone side so worklet output IS pre-FX, matching the spec: layers are recorded pre-FX so global FX stay live on playback).
- If the recording window overlaps this block, copy the overlapping samples to the right offsets (handle partial first/last blocks — startFrame is generally mid-block). When `writeIndex` reaches `lengthSamples`, post `record-done` with the buffer **transferred** (`port.postMessage(msg, [buffer])`) and clear state.
- `record-cancel` drops the pending/in-flight recording.

## 5.3 `src/audio/looper/looper.ts` — main-thread engine

```ts
export interface Layer {
  id: number;
  buffer: AudioBuffer;
  gain: GainNode;             // per-layer volume (ramped changes)
  reverbSend: Tone.Gain;      // per-layer reverb send (delay send is global-only in v1)
  source: AudioBufferSourceNode; // loop=true, recreated on unmute-after-stop
  muted: boolean;
  snapshot: string;           // human-readable engine settings at record time, e.g. "Autotune·Triad" / "FM Bass"
}

export class Looper {
  layers: Layer[] = [];              // max 8
  state: 'idle' | 'armed' | 'recording' | 'playing';
  // ...
  armRecord(): void;    // quantize to next boundary (or start transport if first ever)
  disarm(): void;
  clearLayer(id: number): void;
  setLayerGain(id: number, v: number): void;   // ramped
  toggleMute(id: number): void;                // ramped gain to 0 / back
  clearAll(): void;
}
```

Behavior details:

- **First record** (no transport running): start `Tone.getTransport()` and the metronome, set `loopEpoch` = a near-future context time (+0.15 s safety), schedule the **1-bar count-in**: recording actually starts at `epoch + 1 bar` — i.e. send `record-arm` with `startFrame = (epoch + barSamples) * ...` expressed in frames. Metronome accents beat 1.
- **Subsequent records**: `record-arm` at `nextBoundarySamples(now, epoch, loopLen)` — pressing record mid-loop arms for the next boundary. UI shows the armed state (amber pulse).
- **On `record-done`**:
  1. Build an `AudioBuffer` (1 channel, loopLen samples) from the transferred Float32Array.
  2. **Latency compensation**: rotate the buffer left by `latencySamples = Math.round((ctx.baseLatency + (ctx.outputLatency ?? 0)) * sampleRate) + shifterLatencySamples` — i.e. `compensated[i] = raw[(i + latencySamples) % loopLen]`. Rotating (not shifting with silence) is correct because the recording is exactly one loop long and loops seamlessly. Expose `latencySamples` as a store-tweakable offset for the acceptance test.
  3. Create source: `loop = true`, `loopStart = 0`, `loopEnd = loopLen / sampleRate`. Start **phase-aligned**: `const pos = ((ctx.currentTime + 0.05) * sr - epochFrames) % loopLen; source.start(ctx.currentTime + 0.05, pos / sr)`. All layers started this way stay locked forever (they share the context clock; buffer loops don't drift).
  4. Wire: source → layer.gain → masterGain; also `fxBus.connectSource(layer.gain)` reverb send only.
  5. Push to `layers`, mirror a UI-safe summary into the store (id, snapshot, muted, gain — NOT the AudioBuffer).
- **Metronome**: reuse `src/audio/metronome.ts` from Phase 4.0.4 (do NOT create a second click). This phase only adds: starting it automatically when arming the first record, the count-in accent behavior, and (optionally) auto-muting the click once at least one layer is playing unless `metronomeOn` is explicitly on.
- **Overdub** = pressing record again = new layer (no destructive merge). At 8 layers, record button disabled.
- **Panic** (extend Phase 4 handler): `record-cancel`, disarm, keep layers playing (bypass only kills the live voice).

Snapshot string: derive from store at arm time: engineMode, instrument (if instrument/both), harmonyPreset (if not off), e.g. `"Voice · Triad"`, `"FM Bass"`, `"Voice+Chiptune"`.

## 5.4 `src/ui/LooperPanel.tsx`

Loop group in the dock (may expand to a second slim row):

- Transport strip: BPM (number stepper 60–180, disabled when layers exist), Bars (1/2/4/8, same lock), Metronome toggle, **Record** button (states: idle → armed [amber pulse] → recording [solid amber] → back), loop-position indicator (thin progress line, driven by rAF from `(ctxTime*sr - epoch) % loopLen`).
- Layer lanes (up to 8 rows, only existing layers shown): snapshot label, mute toggle, volume mini-slider, reverb-send mini-slider, clear (×) button. Muted lanes dim to 40% opacity.
- Amber (`--amber`) is used ONLY here and for the fireflies — record/loop pulses (design rule).

## 5.5 Visualizer — fireflies

One firefly sprite per layer in a row at the top of the stage. All pulse (scale/alpha blip) **in sync at the loop boundary** — compute boundary proximity from the same epoch math each frame. Muted layers dim. Recording-armed shows a dedicated blinking firefly slot.

## 5.6 Tests — `tests/looper.test.ts`

Pure timing math only (no audio in tests):

1. `loopLengthSamples({ bpm: 90, bars: 2, sampleRate: 48000 })` === `Math.round(2*4*(60/90)*48000)` = 256000.
2. `loopLengthSamples` bpm 120 bars 4 sr 44100 → 352800.
3. `nextBoundarySamples(0, 1000, 500)` → 1000 (before epoch → epoch).
4. `nextBoundarySamples(1000, 1000, 500)` → 1000 (exactly on boundary → same).
5. `nextBoundarySamples(1001, 1000, 500)` → 1500; `(2499, 1000, 500)` → 2500.
6. Buffer rotation: rotating [0,1,2,3,4] left by 2 → [2,3,4,0,1]; rotate by 0 → identity; rotate by len → identity.

## Acceptance checklist

- [ ] **The core loop-station flow works end to end**: record layer 1 → it starts looping by itself the instant recording ends and keeps playing; record layer 2 over it while it plays (existing layers never stop or stutter during recording); stack at least 3 layers this way. Also verifiable hands-free with the Demo/File input from Phase 4.0 as the performance source.
- [ ] Record a 2-bar beatbox layer, then a hummed fmBass line (instrument mode), then an autotuned lead with Choir: **all three loop locked, no audible drift over 5 minutes** (leave it running).
- [ ] A Take recording (Phase 4.0.3) made while loops play captures the full loop stack + live voice — this is how you export a finished jam.
- [ ] Alignment: with metronome on, record a single sharp click exactly on a beat; on playback it lands within ±10 ms of the metronome click (listen for flamming; if off, tune the latency-compensation constant and note the final value).
- [ ] Pressing record mid-loop arms (amber pulse) and starts exactly at the next boundary; count-in of 1 bar occurs before the very first recording.
- [ ] Mute/unmute is click-free and stays phase-locked (unmuting a layer after 30 s is still in time).
- [ ] Clearing all layers re-enables BPM/bars.
- [ ] Global reverb/delay changes audibly affect already-playing layers (pre-FX recording verified).
- [ ] 8-layer cap enforced; fireflies pulse in sync on the boundary.
- [ ] Panic during recording cancels cleanly; no corrupt layer appears.
- [ ] `npm run test`, `npm run build` pass; worklet p95 still ≤ 1.5 ms **while recording**.

## Common mistakes to avoid

1. Using MediaRecorder / MediaStreamAudioDestinationNode for capture — compressed and laggy; explicitly forbidden by the spec. Capture is worklet-side block copying.
2. Allocating the capture Float32Array inside `process()` — allocate in the port message handler.
3. Starting layer sources with `source.start(when)` without the offset argument — layers must start at the correct **loop position**, not position 0.
4. Shifting (zero-padding) instead of **rotating** for latency compensation — creates a gap at the seam.
5. Scheduling layer playback through `Tone.Transport.schedule` per-iteration — use native looping `AudioBufferSourceNode`s; the transport only drives the metronome and delay sync.
6. Storing `AudioBuffer`s in Zustand — keep heavy objects in the Looper class; the store gets plain UI summaries.
