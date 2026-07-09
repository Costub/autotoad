# AUTOTOAD — Implementation Plan (Read This First)

This directory contains the complete phase-wise implementation plan for AUTOTOAD, a browser-based real-time voice instrument (autotune + harmonizer + voice-to-synth + looper, controlled by webcam hand gestures, rendered with a pixel-art toad UI). The master specification lives in [`../autotoad.md`](../autotoad.md) — the phase files below are derived from it and are the **authoritative work orders**. If a phase file and the spec ever seem to conflict, the phase file wins (it resolves ambiguities deliberately).

## How to use this plan (instructions for the implementing agent)

1. **Implement exactly one phase per session.** Do not start work from a later phase early, and do not "improve" earlier phases beyond what the current phase file asks.
2. **Read the entire phase file before writing any code.** Each file contains: Goal → Prerequisites → Files to create/modify → Detailed specifications (with code you should copy or closely follow) → Tests → Acceptance checklist → Common mistakes.
3. **Where a phase file gives literal code, use it as written** (adapting only imports/paths if needed). The code blocks encode DSP correctness decisions that are easy to get wrong. Do not "simplify" them.
4. **Where a phase file gives an interface but not an implementation**, implement to the interface exactly — signatures, names, and units (ms, cents, semitones, Hz) must match, because later phases depend on them.
5. **Run the verification steps at the end of every phase** and fix failures before declaring done. `npm run test` and `npm run build` must both pass at the end of every phase.
6. **Never delete or rename files created by earlier phases** unless the phase file explicitly says to modify them.
7. If something is genuinely impossible as specified (e.g. an npm package doesn't exist), use the documented fallback in the phase file. Every risky dependency has a fallback documented. Leave a `// FALLBACK:` comment explaining what you did.

## Phase index

| Phase | File | Deliverable (demoable) |
|---|---|---|
| 0 | [phase-0-scaffold.md](phase-0-scaffold.md) | Project scaffold: Vite+React+TS strict, COOP/COEP headers, Zustand store, music-theory module fully tested, app shell with design tokens |
| 1 | [phase-1-tuner-toad.md](phase-1-tuner-toad.md) | "Tuner toad": mic → worklet pitch detection with full smoothing pipeline → PixiJS toad tracking your pitch against a key/scale. No audio output yet |
| 2 | [phase-2-autotune.md](phase-2-autotune.md) | Real-time autotune: formant-preserving pitch correction with adjustable retune speed, controls panel, latency display |
| 3 | [phase-3-harmonizer.md](phase-3-harmonizer.md) | Up to 4 diatonic harmony voices with presets (Duet/Triad/Choir/Octaves), stereo spread, tadpole sprites |
| 4 | [phase-4-instruments-fx.md](phase-4-instruments-fx.md) | Test harness (demo/file input, output take recorder, BPM + metronome, level meter) + voice-to-MIDI instrument mode (4 Tone.js presets) + global FX bus (reverb + tempo-synced delay) |
| 5 | [phase-5-looper.md](phase-5-looper.md) | Quantized looper: sample-accurate record/overdub of up to 8 layers with latency compensation |
| 6 | [phase-6-hands-polish.md](phase-6-hands-polish.md) | MediaPipe hand-gesture control (grab-faders, slides, XY pad, flicks), gesture HUD, performance mode, settings persistence, Vercel deploy, final feel audit |

Phases must be done strictly in order. Each phase ends in a state you can run and demo (`npm run dev`).

## Global conventions (apply in every phase)

These repeat the cross-cutting rules from the spec (§7–§8). Violating any of these is a bug even if the feature "works".

- **TypeScript strict mode everywhere. Zero `any` under `src/audio/**`.** Use `unknown` + narrowing if you must.
- **The worklet bundle must never import DOM-touching code.** Nothing under `src/audio/worklets/` or `src/audio/dsp/` may reference `window`, `document`, `navigator`, or React. Pure math + typed arrays only. `src/audio/theory/` must also be worklet-safe (it's imported by the worklet).
- **Every audible gain change is ramped.** Minimum 64-sample linear ramp in the worklet; `setTargetAtTime`/`rampTo(value, 0.05)` on main-thread nodes. Direct `someGain.gain.value = x` assignments are forbidden except at node-creation time. This is grep-able — keep it that way.
- **One AudioContext, ever.** Created only inside the StartGate click handler with `{ latencyHint: 'interactive' }`. Tone.js (from Phase 4 on) must be attached to it via `Tone.setContext(new Tone.Context(rawCtx))` **before any Tone object is constructed**.
- **No magic numbers in DSP code.** Every constant is named with a comment stating its unit: `const RETUNE_TAU_MIN_MS = 1; // ms`.
- **Perf budget:** main thread ≤ 4 ms/frame scripting in performance mode; worklet `process()` p95 ≤ 1.5 ms per 128-sample block at 48 kHz.
- **Error surfaces:** mic denied, webcam denied, SharedArrayBuffer unavailable, WASM load failure — each shows a specific friendly message in the UI, never a blank screen or a raw exception.
- **Design tokens (defined in Phase 0, used everywhere):** background `#0E1B1E`, panel `#152528`, hairline `#24393D`, text `#E8F1EE`, muted `#8FA6A3`, accent green `#5DCB6A`, amber `#F2B24C` (record/loop pulses ONLY). Font: Inter (or system fallback) at exactly 13/15/20 px, weights 400/500. Pixel font appears only inside the Pixi stage and the wordmark. UI transitions 150–250 ms `cubic-bezier(0.25, 0.1, 0.25, 1)`.
- **Testing:** Vitest. Pure-logic modules (theory, smoothing, voiceToMidi, looper math, gesture mapping math) get unit tests in the phase that creates them. DSP audio quality is verified manually via each phase's acceptance checklist.

## Architecture recap (one paragraph)

Three execution contexts: (1) an **AudioWorklet** (`ToadProcessor`) doing all per-sample DSP — pitch detection, correction, harmony, loop capture; (2) the **main thread** running React UI, the PixiJS visualizer, Tone.js instruments/FX/transport, and the Zustand store; (3) a **vision Web Worker** running MediaPipe HandLandmarker (~30 fps) posting compact `GestureFrame`s to the main thread. Main thread and worklet communicate through a `ParamsBus` — a fixed-layout `Float64Array` over a `SharedArrayBuffer` (with a `postMessage` fallback hidden behind the same API). Everything is client-side; deploy target is Vercel static hosting with COOP/COEP headers (required for SAB).
