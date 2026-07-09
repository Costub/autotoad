# Phase 2 — Autotune

## Goal

The app now **processes and outputs audio**: formant-preserving pitch correction of the live voice with an adjustable retune speed, plus the real controls panel.

- `Shifter` abstraction wrapping **signalsmith-stretch** (WASM) — one instance for the lead voice this phase; the pool API is built now, filled in Phase 3.
- Correction math in the worklet: snap-to-scale target, retune-speed smoothing, correction amount blend, global pitch shift, independent formant shift.
- Dry-path delay line so dry/wet stay phase-coherent despite shifter latency.
- Click-free voiced/unvoiced and note-transition behavior (all gains ramped).
- `ControlsPanel` in the dock: key, scale, retune slider (0–400 ms), correction amount, pitch shift, formant shift, dry/wet, bypass.
- Ghost toad in the visualizer showing the corrected pitch.
- Measured round-trip latency displayed in the UI.

## Prerequisites

Phase 1 complete and passing.

## Files to create / modify

```
create: src/audio/dsp/shifterPool.ts
create: src/ui/ControlsPanel.tsx
create: src/ui/controls.module.css        (slider/select styles)
modify: src/audio/worklets/toad-processor.ts   (correction + shifting + mixing)
modify: src/audio/engine.ts                    (unmute path, latency measurement)
modify: src/ui/pixi/pitchScene.ts              (ghost toad, hop animation)
modify: src/ui/Console.tsx                     (mount ControlsPanel)
modify: src/state/store.ts                     (only if a field is missing)
```

---

## 2.1 The shifter dependency — resolve FIRST

Try, in order; stop at the first that works. Whatever you choose, hide it behind the `Shifter` interface in 2.2 so nothing else in the codebase knows which library is used.

1. **`signalsmith-stretch` npm package.** Check it installed in Phase 0 (`node_modules/signalsmith-stretch`). Read its README/`.d.ts` for the real API. It is a WASM time/pitch-stretch library by Signalsmith Audio; the wrapper typically exposes creation with a sample rate + channel count, a way to set pitch/transpose (semitones or ratio) and formant shift, and a push/pull or process(input, output) sample interface, plus `inputLatency`/`outputLatency`. **Configure for lowest latency**: smallest documented block/interval preset (the C++ library's `configure(channels, blockSamples, intervalSamples)` — 'preset cheaper' equivalents ~ blockSamples ≈ 0.04·sr is default; for live use try ≈ 1024/512 at 48 kHz and verify quality).
   - The worklet cannot fetch WASM by URL relative to the bundle in all setups; if the wrapper needs a wasm URL, put the `.wasm` file in `public/` and pass `new URL('/stretch.wasm', origin)`… but inside a worklet there's no `document` — pass the URL string in via `processorOptions`. If the wrapper supports inlined/base64 WASM, prefer that (simplest inside a worklet).
2. **Vendored build**: if the npm wrapper is broken/unmaintained, vendor its WASM+JS glue under `src/audio/wasm/` and load per above.
3. **Fallback — SoundTouchJS** (`npm i soundtouchjs`) or a hand-rolled granular pitch shifter: accept loss of formant preservation. `setFormant()` becomes a no-op that logs one warning. Keep the identical `Shifter` interface. Leave `// FALLBACK: soundtouch — no formant preservation` at the top of the adapter.

**WASM inside the AudioWorklet**: instantiate the WASM module inside the worklet (compile from bytes passed via `processorOptions` as an `ArrayBuffer`, fetched on the main thread — `WebAssembly.instantiate(bytes)` works in AudioWorkletGlobalScope; `fetch` does NOT exist there). Pattern:

```ts
// main thread (engine.ts): const wasmBytes = await (await fetch(wasmUrl)).arrayBuffer();
// pass in processorOptions: { sab, wasmBytes }   (structured-cloned)
// worklet: await-able init — but process() may run before init completes, so:
//   until shiftersReady, output DRY-delayed audio (or silence) and skip shifting.
```

## 2.2 `src/audio/dsp/shifterPool.ts` (worklet-safe)

```ts
/** One formant-preserving pitch shifter voice. All setters take SEMITONES. */
export interface Shifter {
  /** Process exactly one 128-sample block; writes 128 samples of output.
   *  Output is delayed by `latencySamples` relative to input. */
  process(input: Float32Array, output: Float32Array): void;
  setTranspose(semitones: number): void;   // may be called every block; must be cheap
  setFormant(semitones: number): void;
  readonly latencySamples: number;         // inputLatency + outputLatency, constant after init
  reset(): void;                           // call after long unvoiced gaps (pitfall #2)
}

export class ShifterPool {
  /** size = max voices (5: lead + 4 harmony). Instances are NEVER shared across
   *  voices (each is stateful — spec pitfall #2). */
  static async create(size: number, sampleRate: number, wasmBytes: ArrayBuffer): Promise<ShifterPool>;
  get(index: number): Shifter;
  readonly latencySamples: number; // same for all instances
}
```

This phase: create the pool with size 5 but only voice 0 is used. (Creating all 5 now avoids a Phase 3 re-init and lets you measure worst-case memory early.)

## 2.3 Worklet changes — correction math (implement exactly)

Add to `ToadProcessor.process()`, after the Phase-1 analysis steps:

```ts
// Named constants (units in comments):
const RETUNE_TAU_FLOOR_MS = 1;    // ms — retuneMs=0 means hard snap; avoid div-by-0
const UNVOICED_RAMP_MS = 10;      // ms — wet mute ramp on unvoiced
const MIN_RAMP_SAMPLES = 64;      // samples — minimum linear gain ramp

// 1. Read params from bus: retuneMs, correctionAmount, pitchShift, formantShift,
//    keyTonic, scaleId, dryLevel, wetLevel, bypass.
// 2. key = { tonicPc: keyTonic, scale: SCALE_ORDER[scaleId] }
// 3. If voiced:
//      rawTarget   = snapToScale(smoothedMidi, key)                       // integer note
//      targetMidi  = smoothedMidi + (rawTarget - smoothedMidi) * correctionAmount
//      // retune smoothing on the TARGET (not on the ratio):
//      if (retuneMs <= RETUNE_TAU_FLOOR_MS) appliedTarget = targetMidi;   // hard snap
//      else appliedTarget += (targetMidi - appliedTarget) * (1 - exp(-blockMs / retuneMs));
//      correctionSemis = appliedTarget - smoothedMidi
//    Else (unvoiced): correctionSemis = 0 and FREEZE appliedTarget (do not decay).
//      On the unvoiced->voiced transition, reset appliedTarget = targetMidi (no swoop).
// 4. leadShift = pitchShift + correctionSemis
// 5. shifter0.setTranspose(leadShift); shifter0.setFormant(formantShift);
//    shifter0.process(inputBlock, wetBlock)
// 6. DRY DELAY: push inputBlock through a ring-buffer delay of exactly
//    pool.latencySamples so dry and wet are time-aligned.
// 7. Mix into output (stereo, same signal both channels for now):
//      out = dryDelayed * dryGain + wetBlock * wetGain
//    where dryGain/wetGain are RAMPED per-sample toward their targets:
//      target dry = bypass ? 1 : dryLevel;  target wet = bypass ? 0 : (voiced ? wetLevel : 0)
//    Ramp: linear interpolation from current to target across the block, but cap
//    the per-block step so a full 0..1 swing takes >= MIN_RAMP_SAMPLES samples.
//    (Simplest correct approach: one-pole per sample with tau = 5 ms.)
// 8. Telemetry: correctedFreq = voiced ? midiToFreq(appliedTarget) : 0;
//    also write shifterLatencySamps once after init.
```

Key/scale change mid-sustain (spec pitfall #7): the snap table changes but `appliedTarget` glides toward the new target through the same retune smoothing — never reset `appliedTarget` on key change.

Long-unvoiced handling (spec pitfall #2): count consecutive unvoiced blocks; after ~250 ms unvoiced, call `shifter.reset()` once (guard so it doesn't fire every block).

Pitch detection stays on the **input** ring buffer — never analyze the output (spec pitfall #5).

## 2.4 Engine changes

- Params bus defaults change: `bypass 0`, `dryLevel 0`, `wetLevel 1` (defaults must sound produced out of the gate — retuneMs 80 already set).
- **Latency measurement + display**: `totalLatencyMs = (ctx.baseLatency + (ctx.outputLatency ?? 0)) * 1000 + pool.latencySamples / sr * 1000 + WINDOW_LAG_MS` where `WINDOW_LAG_MS = (2048/2) / sr * 1000` (detection window group delay ≈ 21 ms). Write to `store.latencyMs` once after start. Display it as quiet muted text in the dock ("~48 ms").
- The worklet posts `{ type:'shifters-ready' }` once WASM init completes; until then the engine can keep the gate's progress line on "warming up".

## 2.5 `src/ui/ControlsPanel.tsx`

The single slim dock below the stage, grouped **Tune** (this phase) with hairline dividers reserved for Harmony/Instrument/FX/Loop groups (empty placeholders okay).

Controls (custom-styled — native `input[type=range]` restyled via CSS is fine):

| Control | Range/values | Store field | Notes |
|---|---|---|---|
| Key | C..B select | `key.tonicPc` | moved from Phase 1 into this panel |
| Scale | SCALE_ORDER select | `key.scale` | |
| Retune | 0–400 ms slider | `retuneMs` | label shows "snap" at 0 |
| Amount | 0–100% slider | `correctionAmount` | |
| Pitch | −24..+24 st, step 1 | `pitchShift` | |
| Formant | −12..+12 st, step 1 | `formantShift` | |
| Dry/Wet | two 0–1 sliders (or one crossfader) | `dryLevel`/`wetLevel` | |
| Bypass | toggle + Esc key | `bypass` | Esc = panic: bypass on (full panic behavior extended in Phase 4) |

Style spec (from §8): track = 1px hairline `var(--hairline)`; thumb = 10px solid circle `var(--text)`, accent when active; the current value appears as small inline text on interaction and fades out 800 ms after the last change (CSS transition on opacity + a `setTimeout`). All store writes are plain `set()`; the engine's store subscription (Phase 1.5) forwards to the bus — verify every new field is forwarded.

## 2.6 Visualizer changes

- **Ghost toad**: second sprite (alpha ~0.35) at `yForMidi(freqToMidiFloat(correctedFreq))` when voiced. With slow retune the ghost and toad visibly converge — this is the retune-speed visualization.
- **Hop animation**: when `retuneMs === 0` and `stableNote` changes, play a 2-frame hop (scale y squash 1 frame, then translate to new row) instead of gliding.

## Tests

Extend `tests/smoothing.test.ts` or add `tests/correction.test.ts` for the pure correction math (extract it into a small exported function/class so it's testable without the worklet):

1. retuneMs=0 → appliedTarget equals snapped target immediately on the first voiced block.
2. retuneMs=200 → after 200 ms of blocks, appliedTarget has covered ≈63% of the distance to target (one-pole tau semantics, tolerance ±5%).
3. correctionAmount=0 → correctionSemis === 0 for any input.
4. Unvoiced blocks freeze appliedTarget; the first voiced block after unvoiced resets it to target (no swoop).
5. Key change mid-glide: target changes, appliedTarget continues gliding from its current value (no jump).

## Acceptance checklist

- [ ] retuneMs=0 → hard-quantized T-Pain effect; retuneMs≈200 → transparent/natural on a sung phrase.
- [ ] No clicks at note transitions or voiced/unvoiced boundaries. Verify: record ~10 s of output (chrome tab capture or `MediaRecorder` on `ctx.destination` via a `MediaStreamAudioDestinationNode` **temporarily** for this test) and inspect the waveform for discontinuities; or at minimum careful headphone listening at high gain.
- [ ] ±12 semitone `pitchShift` does not chipmunk (formant preservation audible). If on the SoundTouch fallback, note this is expected to fail and document it.
- [ ] Formant slider alone changes timbre (character) without changing pitch.
- [ ] Dry/wet at 50/50 sounds phase-coherent (no comb-filter hollowness) — proves the dry delay is right.
- [ ] Latency shown in UI; ≤ 60 ms on desktop Chrome (if the shifter config can't get there, minimize and document the number).
- [ ] Worklet p95 ≤ 1.5 ms per block with one shifter voice active.
- [ ] Esc toggles bypass with a click-free ramp.
- [ ] `npm run test` and `npm run build` pass.

## Common mistakes to avoid

1. Sharing one shifter across dry/wet or across future voices — stateful, never share (pitfall #2).
2. Smoothing the correction **ratio** instead of the **target note** — sounds wobbly. Smooth `appliedTarget` in MIDI space as written.
3. Letting `appliedTarget` decay toward 0 or the raw pitch during unvoiced gaps — causes an audible swoop on re-entry. Freeze it, reset on re-voicing.
4. Forgetting the dry-path delay — dry/wet mixing then comb-filters.
5. Calling `fetch()` inside the worklet for WASM — it doesn't exist there. Pass bytes via `processorOptions`.
6. Setting `gain.value` directly for bypass/unvoiced muting — everything ramps.
