# Phase 1 — Tuner Toad

## Goal

A working real-time **pitch tracker with visualization**, end to end:

- StartGate modal (headphones confirmation + mic permission + asset load) that creates the single AudioContext on click.
- `AudioEngine` that opens the mic with raw constraints, loads the `ToadProcessor` AudioWorklet, and wires `mic → worklet → destination` (worklet outputs **silence** this phase — bypass; we only analyze).
- `ParamsBus` (SharedArrayBuffer param/telemetry transport with postMessage fallback).
- Full pitch-detection smoothing pipeline inside the worklet (gate → octave-jump rejection → median filter → one-pole smoother → note hysteresis).
- PixiJS `PitchStage`: scrolling lilypad staff for the selected key/scale, toad sprite (placeholder square) tracking your sung pitch, voiced/unvoiced behavior.
- Key/scale selectors in the dock (minimal — full ControlsPanel comes in Phase 2).
- Unit tests for the smoothing pipeline.

**No audible output in this phase.** The user sees their pitch; they don't hear processing.

## Prerequisites

Phase 0 complete (`scales.ts`, store, shell, COOP/COEP working).

## Files to create

```
src/audio/paramsBus.ts
src/audio/dsp/envelope.ts
src/audio/dsp/pitchTracker.ts
src/audio/worklets/toad-processor.ts
src/audio/engine.ts
src/ui/StartGate.tsx
src/ui/pixi/PitchStage.tsx
src/ui/pixi/pitchScene.ts
src/ui/pixi/sprites.ts
tests/smoothing.test.ts
```

Files to modify: `src/App.tsx`, `src/ui/Console.tsx` (mount StartGate + PitchStage + key/scale selects).

---

## 1.1 `src/audio/paramsBus.ts`

A fixed-layout `Float64Array` shared between main thread and worklet. Main writes params, worklet writes telemetry. Public API identical whether backed by SAB or postMessage.

### Layout — define as a `const enum P` (exact indices; later phases extend, never reorder)

```ts
export const enum P {
  // main -> worklet
  bypass = 0,            // 0|1
  retuneMs = 1,          // 0..400 ms
  correctionAmount = 2,  // 0..1
  keyTonic = 3,          // 0..11 pitch class
  scaleId = 4,           // index into SCALE_ORDER
  formantShift = 5,      // -12..+12 semitones
  pitchShift = 6,        // -24..+24 semitones
  harmonyVoices = 7,     // 0..4
  harmonyInterval0 = 8,  // signed scale steps (see Phase 3)
  harmonyInterval1 = 9,
  harmonyInterval2 = 10,
  harmonyInterval3 = 11,
  harmonySpread = 12,    // 0..1
  dryLevel = 13,         // 0..1
  wetLevel = 14,         // 0..1
  inputGain = 15,        // 0..2
  // 16..19 reserved
  // worklet -> main (telemetry)
  detectedFreq = 20,     // Hz, 0 if unvoiced
  detectedClarity = 21,  // 0..1
  correctedFreq = 22,    // Hz (Phase 2+; 0 for now)
  rmsLevel = 23,         // 0..1
  stableNote = 24,       // MIDI int, -1 if none
  smoothedMidi = 25,     // MIDI float, 0 if unvoiced
  workletP95Us = 26,     // rolling p95 of process() duration, microseconds
  shifterLatencySamps = 27, // Phase 2+
  LENGTH = 32,
}
```

### Implementation

```ts
export interface ParamsBus {
  readonly mode: 'sab' | 'message';
  set(index: P, value: number): void;
  get(index: P): number;
  /** SAB mode: the buffer to hand to the worklet. Message mode: null. */
  readonly sab: SharedArrayBuffer | null;
  /** Message mode only: attach the worklet port for both directions. */
  attachPort(port: MessagePort): void;
}

export function createParamsBus(): ParamsBus { ... }
```

- **SAB mode** (when `typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated`): allocate `new SharedArrayBuffer(P.LENGTH * 8)`, wrap in `Float64Array`. `set`/`get` are plain reads/writes (Float64 tearing is acceptable for control data; do not bother with Atomics — values are independent scalars).
- **Message mode fallback**: keep a local `Float64Array(P.LENGTH)`. `set()` writes locally and marks dirty; a `setInterval` (16 ms) posts `{ type: 'params', data: Float64Array }` (a copy) over the port when dirty. Incoming `{ type: 'telemetry', data }` messages (worklet sends every 4 blocks) overwrite indices 20+ of the local array. `get()` reads the local array.
- The **worklet side** needs a mirror: put a small `WorkletBusView` class in the worklet file itself (Phase 1.4) — reads params from the SAB Float64Array (received via `processorOptions`) or from the last params message; writes telemetry directly to the SAB or posts every 4 blocks.

Initialize defaults after creation from the store values (bypass 1, dry 0, wet 1, inputGain 1, key C major, retuneMs 80, correctionAmount 1).

---

## 1.2 `src/audio/dsp/envelope.ts` (worklet-safe)

```ts
/** Block RMS + simple envelope follower with separate attack/release, for
 *  voiced gating and (later) MIDI velocity. All times in ms. */
export class EnvelopeFollower {
  private env = 0;
  constructor(private sampleRate: number,
              private attackMs = 5,    // ms
              private releaseMs = 80) {} // ms
  /** Returns { rms, env } for the block. */
  processBlock(input: Float32Array): { rms: number; env: number } {
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i]! * input[i]!;
    const rms = Math.sqrt(sum / input.length);
    const tauMs = rms > this.env ? this.attackMs : this.releaseMs;
    const blockMs = (input.length / this.sampleRate) * 1000;
    this.env += (rms - this.env) * (1 - Math.exp(-blockMs / tauMs));
    return { rms, env: this.env };
  }
}
```

---

## 1.3 `src/audio/dsp/pitchTracker.ts` (worklet-safe — copy this closely)

Wraps `pitchy`. `pitchy` is pure JS (no DOM) so it bundles into the worklet fine. API reminder: `PitchDetector.forFloat32Array(windowSize)` then `detector.findPitch(window, sampleRate)` → `[freqHz, clarity]`.

Constants (all named, with units):

```ts
const WINDOW_SIZE = 2048;            // samples — analysis window
const CLARITY_GATE = 0.9;            // below this → unvoiced
const RMS_GATE = 0.01;               // below this → unvoiced (check RMS FIRST — pitfall #1)
const OCTAVE_JUMP_SEMITONES = 9;     // per-frame jump bigger than this is suspect
const OCTAVE_JUMP_CLARITY_OK = 0.97; // unless clarity is at least this
const GLITCH_HOLD_FRAMES = 3;        // frames we keep lastGoodFreq through a glitch
const MEDIAN_LEN = 5;                // voiced frames in the median filter
const SMOOTH_TAU_MS = 8;             // ms — one-pole smoother
const HYST_HARD_CENTS = 60;          // cents past boundary → immediate note change
const HYST_SOFT_CENTS = 40;          // cents past boundary sustained…
const HYST_SOFT_MS = 80;             // …for this long → note change
```

Class shape and per-block algorithm (implement in this exact order):

```ts
export class PitchTracker {
  constructor(sampleRate: number) { /* detector, ring buffer WINDOW_SIZE, state */ }

  /** Push a 128-sample block; returns analysis for this block. */
  analyze(block: Float32Array, rms: number): {
    freq: number;            // raw detected Hz, 0 if unvoiced
    clarity: number;
    smoothedMidi: number;    // smoothed MIDI float, 0 if unvoiced
    voiced: boolean;
    stableNote: number | null; // hysteresis note identity (integer MIDI)
  } {
    // 0. Append block to ring buffer; copy the last WINDOW_SIZE samples into a
    //    preallocated linear Float32Array for the detector (no allocation per call).
    // 1. [freq, clarity] = detector.findPitch(window, sampleRate)
    // 2. GATE: voiced = rms >= RMS_GATE && clarity >= CLARITY_GATE && freq > 40 && freq < 2000
    // 3. OCTAVE-JUMP REJECTION: if voiced && lastGoodFreq > 0:
    //      jump = |freqToMidiFloat(freq) - freqToMidiFloat(lastGoodFreq)|
    //      if jump > OCTAVE_JUMP_SEMITONES && clarity < OCTAVE_JUMP_CLARITY_OK:
    //        glitchCount++
    //        if glitchCount <= GLITCH_HOLD_FRAMES: freq = lastGoodFreq (keep continuity)
    //        else: treat as genuinely unvoiced this frame (freq = 0, voiced = false)
    //      else: glitchCount = 0
    //    if voiced: lastGoodFreq = freq
    // 4. MEDIAN over the last MEDIAN_LEN *voiced* frames in MIDI-FLOAT space
    //    (unvoiced frames do not enter the median buffer; if fewer than 3 voiced
    //    frames buffered, pass the raw midiFloat through).
    // 5. ONE-POLE on the median output:
    //      alpha = 1 - exp(-blockMs / SMOOTH_TAU_MS)     // blockMs = 128/sr*1000
    //      smoothed += (median - smoothed) * alpha
    //    On the transition unvoiced->voiced, RESET smoothed = median (no glide up
    //    from a stale value).
    // 6. NOTE HYSTERESIS (stableNote): candidate = round(smoothed).
    //    distCents = (smoothed - currentStableNote) * 100.
    //    Change stableNote to candidate when |smoothed - candidate| boundary is
    //    crossed by > HYST_HARD_CENTS toward candidate, i.e.
    //    |distCents| > 50 + HYST_HARD_CENTS ... simpler operational rule:
    //      if candidate !== stableNote:
    //        centsPast = (|smoothed - stableNote| - 0.5) * 100  // cents beyond the halfway boundary
    //        if centsPast > HYST_HARD_CENTS -> switch now
    //        else if centsPast > HYST_SOFT_CENTS: accumulate time; if accumulated
    //             > HYST_SOFT_MS -> switch; else keep old note
    //        else reset accumulator
    //    On unvoiced for > 5 consecutive frames: stableNote = null.
  }

  reset(): void; // clears ring buffer, median, smoothed, stableNote
}
```

**Extract the pure smoothing chain (steps 3–6) into a separately exported class `SmoothingPipeline`** with method `push(midiFloatOrNaN: number, clarity: number): { smoothedMidi: number; voiced: boolean; stableNote: number | null }` so tests can drive it with synthetic sequences without pitchy. `PitchTracker.analyze` = detector + gate + `SmoothingPipeline.push`.

---

## 1.4 `src/audio/worklets/toad-processor.ts`

The single `AudioWorkletProcessor`. **This file and everything it imports must be DOM-free.** Allowed imports: `types.ts`, `theory/scales.ts`, `dsp/*`, `pitchy`.

Phase-1 responsibilities per 128-sample `process()` call:

1. If no input connected yet, return `true`.
2. `envelope.processBlock(input)` → rms.
3. `tracker.analyze(input, rms)`.
4. Write telemetry to the bus view: `detectedFreq`, `detectedClarity`, `rmsLevel`, `smoothedMidi`, `stableNote` (or -1), `correctedFreq = 0`.
5. Output **silence** (leave output buffers zeroed) — this phase is analysis-only. Do NOT pass audio through; feedback squeal risk with speakers.
6. Perf sampling: wrap the body with `const t0 = performance.now()` / `t1`; keep a 256-entry ring of durations; every 256 blocks compute p95 and write `P.workletP95Us` (microseconds). (`performance.now` exists in AudioWorkletGlobalScope in Chromium; guard with `typeof performance !== 'undefined'`.)

Skeleton:

```ts
/// <reference types="@types/audioworklet" /> // if unavailable, declare the 3 globals below
// declare const sampleRate: number;
// declare function registerProcessor(name: string, ctor: unknown): void;
// declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(); }

import { PitchTracker } from '../dsp/pitchTracker';
import { EnvelopeFollower } from '../dsp/envelope';
import { P } from '../paramsBus';           // only the const enum — erased at compile time

class WorkletBusView { /* SAB Float64Array from options.processorOptions.sab,
                          or local array + port messages (see 1.1) */ }

class ToadProcessor extends AudioWorkletProcessor {
  // NOTE: never hardcode 48000 — use the `sampleRate` global.
  constructor(options: AudioWorkletNodeOptions) { super(); /* bus, tracker, envelope */ }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean { ...; return true; }
}
registerProcessor('toad-processor', ToadProcessor); // NAME MUST MATCH engine.ts EXACTLY (pitfall #6)
```

If importing `const enum P` across the worklet boundary causes build issues (isolatedModules), change `P` from `const enum` to a plain object literal `export const P = { ... } as const` with a companion type — do this in `paramsBus.ts` so both sides share it.

### Vite bundling of the worklet

In `engine.ts` load it with:

```ts
import workletUrl from './worklets/toad-processor.ts?worker&url';
await ctx.audioWorklet.addModule(workletUrl);
```

`?worker&url` makes Vite bundle the file (and its imports) as a self-contained script and gives you its URL — this works for AudioWorklet in both dev and build. If dev-mode loading fails (some Vite versions serve unbundled modules in dev), the fallback is `new URL('./worklets/toad-processor.ts', import.meta.url).href` in dev only:

```ts
const url = import.meta.env.DEV
  ? new URL('./worklets/toad-processor.ts', import.meta.url).href
  : workletUrl;
```

Verify registration by having the processor `this.port.postMessage({ type: 'ready' })` in its constructor and awaiting that message in the engine with a 3-second timeout → surface a friendly error if it never arrives.

---

## 1.5 `src/audio/engine.ts`

```ts
export class AudioEngine {
  ctx: AudioContext | null = null;
  bus: ParamsBus;
  node: AudioWorkletNode | null = null;

  /** Called ONLY from the StartGate click handler (autoplay policy). */
  async start(): Promise<void> {
    // 1. ctx = new AudioContext({ latencyHint: 'interactive' }); await ctx.resume()
    // 2. bus = createParamsBus()
    // 3. await ctx.audioWorklet.addModule(workletUrl)  (see 1.4)
    // 4. mic: navigator.mediaDevices.getUserMedia({ audio: {
    //        echoCancellation: false, noiseSuppression: false,
    //        autoGainControl: false, channelCount: 1 }, video: false })
    //    — EXACTLY these constraints. Browser AEC/NS/AGC destroys pitch detection.
    // 5. node = new AudioWorkletNode(ctx, 'toad-processor', {
    //        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    //        processorOptions: { sab: bus.sab } })
    //    if bus.mode === 'message': bus.attachPort(node.port)
    //    await the { type:'ready' } message (timeout 3s → throw friendly error)
    // 6. ctx.createMediaStreamSource(stream).connect(node); node.connect(ctx.destination)
    //    (worklet outputs silence this phase, so this is safe)
    // 7. push initial params from the Zustand store into the bus; then
    //    useStore.subscribe(...) to keep bus params in sync with store changes
    //    (key.tonicPc -> P.keyTonic, SCALE_ORDER.indexOf(scale) -> P.scaleId, etc.)
  }
  stop(): void { /* disconnect, stream.getTracks().forEach(t => t.stop()), ctx.close() */ }
}
export const engine = new AudioEngine(); // module singleton
```

Error handling: wrap each step; on failure set `useStore.set({ error: <specific friendly message> })`:
- mic denied → "AUTOTOAD needs your microphone — it IS the instrument. Allow mic access and reload."
- worklet load failure → "Audio engine failed to load. Try a Chromium browser (Chrome/Edge)."
- SAB unavailable → not an error; silently use message mode (log to console once).

---

## 1.6 `src/ui/StartGate.tsx`

Full-screen overlay (the app's only modal). Content: wordmark, one-line pitch ("Your voice is the instrument"), a **headphones warning** ("Headphones required — the toad feeds back without them"), and a single button **"I'm wearing headphones — start"**. On click:

1. Button enters loading state; a thin 2px progress line under it advances through labeled steps (context → engine → microphone).
2. `await engine.start()`.
3. `set({ started: true, micReady: true })`; the gate fades out over 200 ms (opacity, `var(--ease)`).

If `error` is set in the store, the gate shows the error message in place of the button (pixel-styled panel, muted text, no raw stack traces). No spinner anywhere — the progress line is the only load indicator.

---

## 1.7 PixiJS stage

### `src/ui/pixi/sprites.ts` — asset seam

```ts
// All visual assets referenced through this manifest so placeholder graphics
// can be swapped for real spritesheets in public/sprites/ without touching scene code.
export interface SpriteFactory {
  toad(): PIXI.Container;      // placeholder: 12x12 rect, fill 0x5DCB6A
  toadGhost(): PIXI.Container; // Phase 2: same, alpha 0.35
  tadpole(): PIXI.Container;   // Phase 3: 6x6 rect
  lilypad(): PIXI.Container;   // 24x6 rounded rect, 0x5DCB6A alpha 0.5
  ripple(): PIXI.Container;    // 24x2 rect, 0x24393D
  firefly(): PIXI.Container;   // Phase 5: 4x4 rect, 0xF2B24C
}
export const placeholderSprites: SpriteFactory = { ... }; // PIXI.Graphics-based
```

### `src/ui/pixi/pitchScene.ts`

Pixi v8. Init: `await app.init({ width: 640, height: 576, background: 0x0E1B1E, antialias: false, roundPixels: true })` (640×576 = 160×144 × 4). `TextureStyle.defaultOptions.scaleMode = 'nearest'`.

Scene contract:

```ts
export interface PitchSceneDeps {
  readBus: (index: number) => number;        // ParamsBus.get
  getKey: () => KeyConfig;                   // from store (read per frame, cheap)
}
export function createPitchScene(app: PIXI.Application, deps: PitchSceneDeps): { destroy(): void };
```

Per-frame (`app.ticker`, must be allocation-free after setup):

1. Read `smoothedMidi`, `detectedFreq`, `rmsLevel`, `stableNote` from the bus.
2. **Row space**: 2 octaves (25 semitone rows) centered on a slowly-recentering `centerMidi` (one-pole toward the median of the last ~3 s of voiced `smoothedMidi`, tau ≈ 2 s; initialize 60). `yForMidi(m) = height/2 - (m - centerMidi) * rowHeight` with `rowHeight = height / 26`.
3. **Rows**: for each visible integer MIDI row, if `degreeOf(row, key) >= 0` show a row of lilypad sprites drifting left (~12 px/s, wrap around); else a faint ripple line. Pre-create max-rows sprites once; reposition/re-skin per frame (or on key change only).
4. **Toad**: if voiced (`detectedFreq > 0`): visible at `x = width*0.3`, `y = yForMidi(smoothedMidi)` (position itself needs no extra easing — smoothedMidi is already smooth). If unvoiced: swap to "submerged" look (placeholder: alpha 0.25 + sink 6 px). Ramp alpha over ~100 ms, don't pop.
5. **Pitch trace**: ring buffer of the last ~256 (x-step, y) points drawn as a polyline scrolling left from the toad (reuse one `PIXI.Graphics`, `.clear()` per frame is fine).
6. Nothing else this phase (ghost toad = Phase 2, tadpoles = Phase 3, bubbles = Phase 4, fireflies = Phase 5).
7. Respect `matchMedia('(prefers-reduced-motion: reduce)')`: no lilypad drift, keep pitch trace.

### `src/ui/pixi/PitchStage.tsx`

React wrapper: `useEffect` → create app, append canvas to a div, `createPitchScene`, cleanup on unmount. Canvas sized to fill the stage panel while preserving 160:144 ratio at integer scale (`image-rendering: pixelated`). Renders `null` until `started`.

### Console wiring

`Console.tsx`: when `!started` render `<StartGate/>` overlay; stage shows `<PitchStage/>`. Dock gets two selects this phase: **Key** (C..B, 12 pitch classes) and **Scale** (from `SCALE_ORDER`), bound to `store.key`. Style per design tokens (hairline borders, no default browser look is fine to defer — Phase 2 builds real controls).

---

## 1.8 Tests — `tests/smoothing.test.ts`

Drive `SmoothingPipeline` directly with synthetic sequences (blockMs = 128/48000*1000 ≈ 2.667 ms per push):

1. **Steady tone**: 200 pushes of midiFloat 60.0 (clarity 0.95) → smoothedMidi converges within 0.05 of 60 by push 20; stableNote 60 throughout after warmup.
2. **Octave glitch rejection**: steady 60.0 with a single-frame 72.0 (clarity 0.92) injected → smoothedMidi never exceeds 60.5; stableNote never leaves 60.
3. **Legit jump**: 100 frames of 60.0 then 100 frames of 67.0 (clarity 0.98 during the jump) → stableNote becomes 67 within 15 frames of the change.
4. **Hysteresis**: oscillate midiFloat between 60.45 and 60.55 (±5 cents around the C/C# boundary region — i.e. hovering at the halfway point) for 200 frames → stableNote changes at most once (no flicker).
5. **Unvoiced gating**: NaN (unvoiced) frames → voiced=false; 6+ consecutive unvoiced → stableNote null; re-voicing resets the smoother (first voiced smoothedMidi within 0.2 of the new input, no glide from the old value).

Also add a trivial test that `P` indices are unique and `LENGTH >= 28`.

## Acceptance checklist

- [ ] StartGate flow works; denying the mic shows the friendly error, not a blank screen.
- [ ] Singing a C-major scale in key of C: the toad lands on consecutive lilypad rows with **no visible octave flips or flicker**.
- [ ] Whistling and humming both track. Saying "sssss" makes the toad submerge (unvoiced gate works).
- [ ] Changing key/scale re-renders the lilypad rows immediately.
- [ ] Worklet p95 (read `P.workletP95Us` in console via `engine.bus.get(26)`) ≤ 800 µs — well under the 1.5 ms budget (this phase has no shifting yet).
- [ ] 60 fps stage (check DevTools performance panel; no per-frame allocations in the ticker).
- [ ] `npm run test` and `npm run build` pass. `crossOriginIsolated === true` and bus mode is `'sab'` in Chrome.

## Common mistakes to avoid

1. Gating on clarity before RMS — pitchy's clarity is garbage at low RMS (spec pitfall #1). RMS first.
2. Running the median filter in Hz instead of MIDI-float space — octave errors then skew asymmetrically.
3. Letting the worklet pass audio through this phase — output must stay silent.
4. `registerProcessor` name ≠ `AudioWorkletNode` name — silent failure, no sound AND no error (spec pitfall #6). The `ready` handshake in 1.4/1.5 exists to catch this.
5. Reading telemetry through React state — the Pixi ticker must read the bus directly.
6. Hardcoding 48000 in the worklet — use the `sampleRate` global.
