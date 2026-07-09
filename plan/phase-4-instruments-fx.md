# Phase 4 — Instrument Modes + FX Bus

## Goal

Three additions:

0. **Test harness (build this FIRST — section 4.0)**: a switchable demo input (generated out-of-tune melody played through the whole DSP chain instead of the mic), a file input (load any local audio file as the voice source), an input level meter, a "take recorder" that records the master output to a downloadable file, and a BPM control + metronome (moved up from Phase 5). This exists so every later feature — and the already-built autotune/harmonizer — can be tested deterministically without a good mic performance.
1. **Voice-to-MIDI instrument mode**: a note-segmentation state machine converts the tracker stream into note events driving one of four Tone.js instrument presets (chiptune / fmBass / pluck / choirPad). Modes: Effect ↔ Instrument ↔ Both. Optional chord-follow (instrument also receives harmony notes). Legato toggle.
2. **Global FX bus**: lush convolution reverb + tempo-synced feedback delay as a shared send bus for voice and instruments (looper joins in Phase 5), with UI controls and single-choke-point ramped parameter setting.

Also in this phase: Tone.js is introduced for the first time (context sharing — get this right), master gain + limiter, and the full panic behavior.

## Prerequisites

Phase 3 complete.

## Files to create / modify

```
create: src/audio/demoInput.ts       (generated demo melody + file loading)
create: src/audio/takeRecorder.ts    (master-output recorder)
create: src/audio/metronome.ts       (BPM click, reused by the Phase 5 looper)
create: src/audio/midi/voiceToMidi.ts
create: src/audio/instruments/presets.ts
create: src/audio/fx/fxBus.ts
create: tests/voiceToMidi.test.ts
modify: src/audio/engine.ts          (Tone context, master chain, input-source switching, note-event pump, mode switching)
modify: src/ui/StartGate.tsx         (offer demo mode when the mic is denied)
modify: src/audio/worklets/toad-processor.ts  (only if telemetry gaps found; ideally none)
modify: src/ui/ControlsPanel.tsx     (Input/Tempo strip + Instrument group + FX group)
modify: src/ui/pixi/pitchScene.ts    (croak bubbles on noteOn)
modify: src/state/store.ts           (inputSource, isRecordingTake — see 4.0)
```

---

## 4.0 Test harness (implement this section FIRST, before 4.1)

Everything here is plumbing around the existing engine; none of it touches the worklet.

### 4.0.1 Input source switching

Add to the store: `inputSource: 'mic' | 'demo' | 'file'` (default `'mic'`, not persisted later). The engine keeps ONE connection into the worklet at a time:

```ts
// engine.ts
setInputSource(src: 'mic' | 'demo' | 'file', fileBuffer?: AudioBuffer): void {
  // 1. Disconnect the current source node from this.node (keep the mic MediaStream
  //    alive — don't stop tracks; switching back must be instant).
  // 2. 'mic'  -> reconnect the existing MediaStreamAudioSourceNode.
  //    'demo' -> create AudioBufferSourceNode from getDemoBuffer(ctx), loop = true,
  //              start(), connect to worklet. Recreate on every switch (sources are one-shot).
  //    'file' -> same but with the decoded user file buffer, loop = true.
  // 3. Old demo/file source nodes: stop() and drop.
}
```

UI: a small segmented control at the left end of the dock: **Mic / Demo / File…** — "File…" opens `<input type="file" accept="audio/*">`; decode with `ctx.decodeAudioData(await file.arrayBuffer())`, downmix to mono if needed (average channels into a fresh mono AudioBuffer), then `setInputSource('file', buffer)`.

### 4.0.2 `src/audio/demoInput.ts` — generated demo melody

A deterministic, deliberately out-of-tune "sung" melody rendered ONCE with `OfflineAudioContext` and cached. This is the canonical test signal for autotune and harmony — no assets needed:

```ts
// 8 notes, 500 ms each, ~4.3 s total, rendered at ctx.sampleRate:
const MELODY_MIDI  = [60, 62, 64, 65, 67, 65, 64, 62];       // C D E F G F E D
const DETUNE_CENTS = [40, -35, 45, -40, 30, -45, 35, -30];   // deliberately off-key
// Per note: sawtooth OscillatorNode at midiToFreq(midi + cents/100),
//   vibrato: LFO (sine, 5.5 Hz) -> GainNode(scale: ±0.4% of freq) -> osc.frequency
//     (±0.4% ≈ ±7 cents — keeps clarity high while sounding voice-like),
//   tone: lowpass BiquadFilter at 1200 Hz (rounds the saw toward a hum),
//   envelope: gain 0 -> 0.5 over 30 ms, hold, -> 0 over 80 ms; 30 ms gap between notes.
export async function getDemoBuffer(ctx: AudioContext): Promise<AudioBuffer>; // cached singleton
```

Why sawtooth: strong harmonics → the MPM detector locks with clarity ≈ 0.95+, so the whole pipeline (gate → correction → harmony) engages exactly as it does for a clean sung note. With Key=C / Major, autotune must pull every note to pitch (the detunes vanish); with Triad, telemetry must show the stacked thirds.

### 4.0.3 `src/audio/takeRecorder.ts` — record the output

Records the **master output** (everything you hear) to a downloadable file. MediaRecorder is fine HERE (it's a bounce, not the sample-accurate looper — that rule from Phase 5 is unchanged):

```ts
export class TakeRecorder {
  constructor(ctx: AudioContext, masterGain: GainNode) {
    // dest = ctx.createMediaStreamDestination(); masterGain.connect(dest);
    // recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' })
    //   (feature-detect with MediaRecorder.isTypeSupported; fall back to default mime).
  }
  start(): void;                     // collect chunks via ondataavailable
  async stop(): Promise<void>;       // onstop -> Blob -> triggger download:
  // a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  // a.download = `autotoad-take-${new Date().toISOString().replace(/[:.]/g,'-')}.webm`; a.click();
  // then URL.revokeObjectURL after a tick.
}
```

UI: a **● Take** button in the dock (right end): idle → recording (amber dot + elapsed seconds, the ONLY other permitted amber use besides looper) → click again stops and downloads. Mirror `isRecordingTake` in the store. Panic does NOT stop a take (it records the panic silence — that's fine and simplest).

### 4.0.4 `src/audio/metronome.ts` — BPM + click (moved up from Phase 5)

```ts
export class Metronome {
  // Tone.getTransport().bpm.value follows store.bpm (ramp: bpm.rampTo(v, 0.1)).
  // Click: short Tone.Synth blip scheduled with transport.scheduleRepeat('4n', ...):
  //   beat 1 of each bar = 2000 Hz, other beats = 1000 Hz, duration '32n'.
  // Output through a Tone.Gain gated (RAMPED) by store.metronomeOn.
  // start(): starts the Transport if not running; stop(): stops click scheduling only.
}
```

UI: a **Tempo** mini-group in the dock: BPM stepper (60–180, default 90) + metronome toggle (click icon). The Transport also drives the tempo-synced delay (4.5), so BPM changes audibly retime the delay — that's correct and desirable. Phase 5 will reuse this exact metronome and add the count-in + boundary logic; do not duplicate it there.

### 4.0.5 Input level meter + mic-denied demo mode

- **Level meter**: a 4 px-wide vertical bar next to the input switch, height driven by `P.rmsLevel` read in the existing rAF loop (direct DOM style update, not React state). Green normally; turns muted-gray when the tracker is unvoiced. This single element answers "is any signal even reaching the engine?" — the most common "it doesn't work" cause.
- **StartGate change**: if the mic is denied, the error panel now ALSO shows a second button: **"Start with demo input instead"** → `engine.start({ skipMic: true })` (engine skips getUserMedia, sets `inputSource: 'demo'`, connects the demo buffer). The app must be fully explorable without any microphone.

### 4.0.6 Manual test (do this before moving to 4.1)

Switch to Demo input, Key=C, Scale=Major, Mix=100% wet, Amount=100%, Retune=0: the out-of-tune melody comes out snapped to C major (compare with Bypass on — the detuning is obvious). Enable Triad: harmony thirds stack. Start a Take, let it run one loop, stop: a `.webm` downloads and plays back the processed audio.

---

## 4.1 Tone.js context sharing (do this FIRST, exactly)

In `engine.start()`, immediately after creating the raw AudioContext and **before constructing any Tone object anywhere**:

```ts
import * as Tone from 'tone';
Tone.setContext(new Tone.Context(rawCtx));
```

One context total (spec pitfall #3). Enforce with a comment and by making `engine.ts` the only file that imports Tone *for setup*; presets/fxBus receive constructed Tone objects' parents implicitly through module import — that's fine, they're only *called* after setup.

### Master chain (engine)

Rewire output:

```
worklet.connect(voiceGain) ──> masterGain ──> limiter ──> ctx.destination
instruments out (4.4)      ──> masterGain (+ FX sends)
fxReturn (4.5)             ──> masterGain
```

- `masterGain = new GainNode(ctx, { gain: 0.9 })`.
- `limiter = new DynamicsCompressorNode(ctx, { threshold: -6, knee: 4, ratio: 12, attack: 0.003, release: 0.25 })` — transparent safety, not a crutch; gain-stage so normal use shows ≤ ~3 dB reduction.
- Remove the Phase-1 direct `node.connect(ctx.destination)`.

## 4.2 `src/audio/midi/voiceToMidi.ts` — state machine (copy this logic exactly)

Pure logic, main-thread (it consumes bus telemetry at rAF/tick rate, ~60 Hz — NOT in the worklet). Testable without audio.

```ts
// Constants (units in names/comments):
const ON_RMS = 0.02;          // rms threshold to start a note
const OFF_RMS = 0.012;        // rms threshold to end a note (deliberately < ON_RMS)
const ON_HOLD_MS = 30;        // rms must exceed ON_RMS this long before noteOn
const OFF_HOLD_MS = 60;       // rms below OFF_RMS (or unvoiced) this long before noteOff
const REATTACK_DB = 6;        // dB rise above trailing minimum -> retrigger
const REATTACK_WINDOW_MS = 100; // trailing-minimum window
const VEL_RMS_LO = 0.02, VEL_RMS_HI = 0.3;  // rms -> velocity 40..120 mapping, clamped

export interface VoiceToMidiInput {
  t: number;            // ms timestamp
  voiced: boolean;
  stableNote: number | null;
  smoothedMidi: number; // for pitch bend
  rms: number;
}

export type V2MEvent =
  | { type: 'noteOn'; midi: number; velocity: number }
  | { type: 'noteOff'; midi: number }
  | { type: 'setNote'; midi: number }            // legato glide
  | { type: 'pitchBend'; cents: number };

export class VoiceToMidi {
  legato = false;
  bendEnabled = false;   // off by default in scale mode
  /** Feed one telemetry frame; returns 0..n events, in order. */
  push(f: VoiceToMidiInput): V2MEvent[] { ... }
  /** Force-close any open note (panic / mode switch). */
  allOff(): V2MEvent[] { ... }
}
```

State machine:

- **IDLE → NOTE_ON**: `voiced && stableNote !== null && rms > ON_RMS` continuously for ≥ `ON_HOLD_MS`. Emit `noteOn(stableNote, velocity)`; velocity = linear map of the **peak rms seen during the onset hold window** from [VEL_RMS_LO..VEL_RMS_HI] → [40..120], clamped.
- **NOTE_ON, stableNote changes** (tracker hysteresis already debounced it): if `legato` emit `setNote(newNote)`, else emit `noteOff(old)` + `noteOn(new, lastVelocity)`.
- **NOTE_ON, amplitude re-attack**: keep a rolling minimum of rms over the last `REATTACK_WINDOW_MS`; if current rms > min × 10^(REATTACK_DB/20), emit `noteOff` + `noteOn` (velocity from current rms). Then reset the rolling min to current rms (avoid double-triggers). This makes "da-da-da" articulation retrigger.
- **NOTE_ON → NOTE_OFF**: `(!voiced || rms < OFF_RMS)` continuously for ≥ `OFF_HOLD_MS`. Emit `noteOff`.
- **Pitch bend**: while NOTE_ON and `bendEnabled`, emit `pitchBend((smoothedMidi - currentNote) * 100)` each frame (cents).
- **Invariant (test it)**: every `noteOn` is matched by exactly one `noteOff`/`setNote`-chain-terminating `noteOff` before the next `noteOn` of the machine; `allOff()` closes any open note.

## 4.3 Engine: the event pump

A `requestAnimationFrame` loop (main thread) — this can live in `engine.ts`:

1. Read `rmsLevel`, `stableNote`, `smoothedMidi`, `detectedFreq` from the bus.
2. `events = v2m.push({...})` — only when `engineMode !== 'effect'`.
3. Dispatch to the active instrument (4.4): `noteOn → synth.triggerAttack(midiToFreqNote, Tone.now(), vel/127)`, `noteOff → triggerRelease`, `setNote → synth.setNote` (Tone.Synth only; for PolySynth presets, treat setNote as retrigger).
4. **Chord follow**: if `chordFollow` and harmony active, also trigger `stableNote + resolveInterval(...)` for each active interval on the same on/off events (use `HARMONY_PRESETS[store.harmonyPreset]`).
5. Mode switching: on `engineMode` change — entering `'instrument'`: ramp worklet wet to 0 via `P.wetLevel` (store keeps its value; use a separate `P.bypass`-like mute? Simplest: engine writes `P.wetLevel = mode === 'instrument' ? 0 : store.wetLevel`). Leaving instrument mode or switching instrument preset: `v2m.allOff()` and dispatch.
6. **Panic** (Esc / UI button — extend Phase 2's handler): set bypass, `v2m.allOff()`, dispatch offs, (Phase 5 adds: stop record).

The same rAF loop is a good place to also mirror `workletP95Us` into a dev-only overlay (optional).

## 4.4 `src/audio/instruments/presets.ts`

```ts
export interface InstrumentInstance {
  triggerAttack(midi: number, velocity01: number): void;
  triggerRelease(midi: number): void;
  setNote(midi: number): void;      // legato; retrigger if not supported
  releaseAll(): void;
  out: Tone.Gain;                    // connect to masterGain; fx sends tap this
  dispose(): void;
}
export function createInstrument(name: InstrumentName): InstrumentInstance;
```

Presets (exact recipes; tweak envelope numbers by ear only if something is obviously broken):

- **chiptune**: `Tone.Synth` `{ oscillator: { type: 'square' }, envelope: { attack: 0.005, decay: 0.08, sustain: 0.5, release: 0.05 } }` → `Tone.BitCrusher(4)` → out. Slapback: `Tone.FeedbackDelay('16n', 0.15)` with wet 0.2, in series after the crusher.
- **fmBass**: `Tone.FMSynth` `{ harmonicity: 1, modulationIndex: 8, envelope: { attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.1 } }`; **pitch −12** from sung note (subtract 12 in triggerAttack/setNote).
- **pluck**: `Tone.PluckSynth { attackNoise: 1, dampening: 3500, resonance: 0.9 }` → small `Tone.Reverb({ decay: 0.8, wet: 0.25 })` (this tiny plate is part of the preset, separate from the global bus) → out.
- **choirPad**: `Tone.PolySynth(Tone.AMSynth, { envelope: { attack: 0.4, release: 1.2 } })` → `Tone.Chorus(2.5, 3.5, 0.5).start()` → out. Pairs with chordFollow.

Only ONE instrument instance exists at a time; switching disposes the old one **after** `releaseAll()` + 200 ms (let releases ring briefly, then dispose). Preset-internal effects stay inside the preset; the **global** FX bus (4.5) is separate.

## 4.5 `src/audio/fx/fxBus.ts`

```ts
export type FxParam = 'reverbSend' | 'reverbDecay' | 'delaySend' | 'delayTime' | 'delayFeedback';

export interface FxBus {
  connectSource(node: AudioNode | Tone.ToneAudioNode): { reverbSend: Tone.Gain; delaySend: Tone.Gain };
  setParam(name: FxParam, value: number): void; // THE single choke point — always ramps
  dispose(): void;
}
export function createFxBus(): FxBus;
```

Implementation requirements:

- **Reverb**: `Tone.Reverb({ decay: 2.2, preDelay: 0.02 })`, `await reverb.generate()` during StartGate preload if possible (or fire-and-forget at creation). Input chain: `Tone.Filter(150, 'highpass')` → reverb (low-cut keeps wet un-muddy). `reverb.wet = 1` (it's a send effect — 100% wet on the bus).
  - **Decay changes**: `Tone.Reverb` regenerates its IR async on `decay` set. To make sweeps click-free: keep **two** Reverb instances (A/B); on decay change, set decay on the idle one, `await generate()`, then crossfade A→B over 80 ms with two ramped gains, and swap roles. Debounce decay changes to at most one regeneration per 150 ms (a slider drag would otherwise queue dozens).
- **Delay**: `Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.35, maxDelay: 2 })`, wet 1. Feedback **clamped to 0.75** in `setParam` regardless of input. Inside the feedback path add a high-cut: simplest reliable structure in Tone is `delay` → `Tone.Filter(4000, 'lowpass')` on the OUTPUT plus keeping native feedback ≤0.75; if you build a manual feedback loop (Delay + Gain + Filter) to get the filter truly in-loop, that's better — do it if straightforward: `input → delayNode → filter(4k lowpass) → feedbackGain → delayNode`, output tapped after filter.
  - `delayTime` is one of `['8n','8n.','4n','2n']` (store as the string; `setParam` receives an index 0–3). Tone converts notation using the Transport BPM — already wired to `store.bpm` by the metronome (4.0.4). Ramp delay-time changes (`delay.delayTime.rampTo(newValue, 0.05)`) to avoid pitch-chirp artifacts, and accept the brief tape-style pitch slew (that's the good-sounding behavior).
- **Sends**: `connectSource(node)` creates two `Tone.Gain(0)` nodes from that node into reverb-input and delay-input. Returns them so the engine can map store values → per-source send levels.
- **Both FX outputs** (`fxReturn`) connect to `masterGain`.
- **`setParam` ramps everything**: `param.rampTo(value, 0.05)` — never `.value =` (except construction). FX params do NOT go through the ParamsBus (they live on the Tone side); the Zustand store is their source of truth and `setParam` is the only write path from both UI and (later) gestures.

Engine wiring: `connectSource(worklet voiceGain)` and `connectSource(instrument.out)` (re-connect on instrument switch); voice sends follow `store.reverbSend/delaySend`; instrument sends follow the same values in v1.

## 4.6 UI — Instrument + FX groups

**Instrument group**: mode 3-way segmented control (Effect / Instrument / Both); preset 4-way (Chiptune / FM Bass / Pluck / Choir Pad); Legato toggle; Chord-follow toggle (only enabled when harmony preset ≠ off).

**FX group**: Reverb send (0–1), Reverb decay (0.5–8 s), Delay send (0–1), Delay time (segmented 8n / 8n. / 4n / 2n), Delay feedback (0–0.75). All write to the store; a store subscription calls `fxBus.setParam` — keep that single choke point.

## 4.7 Visualizer — croak bubbles

On each `noteOn` dispatched by the event pump, push a bubble event into a small queue the Pixi scene consumes: circle spawning at the toad's mouth, radius ∝ velocity (8–20 px), floating up-left, **pops** (1-frame star) on the matching noteOff. Pool max 8 bubble sprites, reuse.

## 4.8 Tests — `tests/voiceToMidi.test.ts`

Synthetic frame sequences at 16 ms steps:

1. Silence → no events.
2. rms 0.1 voiced note 60 sustained 500 ms → exactly one noteOn(60), velocity in [40..120]; then rms→0 → exactly one noteOff after ≥ OFF_HOLD_MS.
3. Onset shorter than ON_HOLD_MS (one 16 ms frame of rms 0.1) → no noteOn.
4. Note change 60→64 mid-note, legato off → noteOff(60)+noteOn(64) adjacent; legato on → single setNote(64).
5. "da-da-da": rms dips to 0.015 (above OFF_RMS? no—0.015 > 0.012 stays on) then re-attacks +8 dB → retrigger via re-attack rule; three attacks → three noteOns, two intermediate noteOffs.
6. rms decaying slowly through [OFF_RMS..ON_RMS] band → no spurious retriggers (hysteresis works).
7. Invariant fuzz: 2000 random frames → after `allOff()`, open-note count is 0, and noteOn/noteOff counts balance.
8. Velocity mapping: rms 0.02 → ~40; rms 0.3 → ~120; rms 0.5 → 120 (clamp).

## Acceptance checklist

Test harness (4.0):
- [ ] Demo input plays the out-of-tune melody through the full chain; with Retune=0 in C major it comes out in tune (obvious against Bypass), and Triad stacks correct thirds (telemetry check).
- [ ] File input: loading a local song/vocal file processes it live; switching Mic ↔ Demo ↔ File is instant and click-free.
- [ ] Take recorder: start → amber indicator + elapsed time → stop downloads a playable `.webm` of exactly what was heard.
- [ ] BPM control + metronome click work; changing BPM audibly retimes the synced delay.
- [ ] Input level meter moves with signal on all three input sources; denying the mic at StartGate offers and successfully starts demo mode.

Instruments + FX:
- [ ] Humming a melody with "da" articulation retriggers cleanly; sustained slides in legato mode glide (also verifiable with the demo input: its 30 ms note gaps must produce 8 distinct noteOns per pass).
- [ ] "ta-ta-ta" at 120 BPM eighth notes → 8 distinct notes in 2 seconds (count console-logged noteOns while a metronome app plays).
- [ ] No stuck notes after 5 minutes of mixed use — switch modes/presets mid-note, panic mid-note; synth always goes silent.
- [ ] Both mode: corrected voice + instrument sound together.
- [ ] Chord follow with Triad: instrument plays 3-note chords tracking the sung root.
- [ ] Sweeping reverbDecay 0.5→8 s **while singing**: no clicks or dropouts (A/B crossfade works).
- [ ] Delay repeats stay rhythmic across delayTime changes; feedback at slider max never self-oscillates (leave it 60 s at max feedback with input — level must stay bounded).
- [ ] Defaults on fresh load: reverbSend 0.18, delaySend 0 — first sung note sounds "produced", not bathroom-y.
- [ ] Limiter shows ≤ ~3 dB reduction in normal use (inspect `limiter.reduction` in console).
- [ ] `npm run test` and `npm run build` pass; worklet p95 still ≤ 1.5 ms.

## Common mistakes to avoid

1. Constructing ANY Tone object before `Tone.setContext(...)` — silent dual-context drift, impossible-to-debug latency (spec pitfall #3). Audit import side effects: don't create Tone objects at module top level, only inside factory functions.
2. Running voiceToMidi inside the worklet — it belongs on the main thread at ~60 Hz off telemetry.
3. `PolySynth.setNote` doesn't exist — legato glide only for mono `Tone.Synth`-family; retrigger for poly presets.
4. Forgetting `releaseAll()` before disposing an instrument on preset switch → stuck notes.
5. Letting UI write `reverb.decay` directly — everything goes through `fxBus.setParam` (the ramp/crossfade choke point).
6. Setting delay feedback above 0.75 anywhere, including gesture mapping later.
