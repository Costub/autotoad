# AUTOTOAD Progress

## Current phase

Phase 2 — Autotune

## Completed

- Read the master specification and all phase work orders.
- Created the Vite + React + strict TypeScript project structure.
- Added COOP/COEP configuration for local development, preview, and Vercel.
- Added the shared cross-context types and the complete Zustand state shape.
- Implemented the cached music-theory scale utilities and their unit tests.
- Built the initial console shell with the required design tokens.
- Installed the full dependency set, including `signalsmith-stretch`.
- Verified 7/7 theory tests pass and the production build succeeds.
- Visually verified the 1280×720 shell: centered 960 px console, 160:144
  stage, no page overflow, required palette, and no browser console errors.
- Verified the dev response includes `Cross-Origin-Opener-Policy: same-origin`
  and `Cross-Origin-Embedder-Policy: require-corp`.

## Phase 0 status

Complete.

## Phase 1 completed

- Added a fixed-layout `ParamsBus` with SharedArrayBuffer and message fallbacks.
- Added the RMS/envelope follower and pitch tracker with octave-glitch rejection,
  MIDI-space median filtering, one-pole smoothing, and note hysteresis.
- Added the silent analysis-only `ToadProcessor` AudioWorklet with telemetry,
  ready handshake, and rolling process-time p95 measurement.
- Added the single-context `AudioEngine` with raw microphone constraints,
  store-to-bus synchronization, and friendly failure messages.
- Added the headphones StartGate and progress-line startup flow.
- Added the PixiJS pitch stage with scale-aware lilypad rows, submerged/voiced
  toad states, scrolling pitch trace, slow recentering, and reduced-motion mode.
- Added key and scale selectors to the controls dock.
- Added smoothing and ParamsBus layout tests; 13/13 tests pass.
- Production build emits the self-contained AudioWorklet bundle successfully.
- Added the documented Vite dev-mode AudioWorklet URL fallback and a bounded
  module-load timeout so startup cannot remain stuck indefinitely.

## Phase 1 status

Complete.

Runtime notes:

- Startup gate layout, progress state, overflow, and console health were verified
  in the in-app browser.
- The in-app browser cannot complete this microphone/AudioWorklet path; it stalls
  at browser permission despite the page remaining error-free.
- The user confirmed microphone permission and successful runtime operation in
  Chrome, the primary supported browser.
- COOP/COEP response headers remain correct (`same-origin` / `require-corp`).

## Decisions and notes

- The phase work orders are authoritative and are being implemented in order.
- The supplied palette and shell specification serve as the accepted Phase 0 design.
- No audio, microphone, Pixi scene, or vision behavior is included in Phase 0.
- The in-app browser's read-only evaluator does not expose isolation globals;
  the required HTTP headers were verified directly from the dev server response.
- `P` is a runtime `as const` object rather than a `const enum` so Vite can share
  the exact layout across the main bundle, worklet bundle, and runtime tests.

## Phase 2 completed

- Added testable MIDI-space correction target smoothing with hard-snap,
  correction amount, retune-time, unvoiced freeze, and key-change continuity.
- Added a five-voice `ShifterPool` seam and a low-latency granular shifter
  fallback for the lead voice.
- Added audible worklet output with scale correction, global pitch shift,
  latency-matched dry mixing, click-free gain ramps, and long-silence reset.
- Added shifter-ready startup handshaking and end-to-end latency calculation.
- Replaced the temporary dock with the Tune controls panel: key, scale, retune,
  amount, pitch, formant, mix, bypass, transient values, and Esc safety bypass.
- Added the corrected-pitch ghost toad and hard-retune hop animation.
- Added correction tests; 18/18 total tests pass.

## Phase 2 in progress

- Chrome runtime and audio-quality verification.

## Next

- Reload the running Chrome tab and verify audible correction, mix coherence,
  bypass ramping, displayed latency, and worklet p95.
- Commit and push Phase 2 after runtime acceptance.

## Phase 2 dependency note

- `signalsmith-stretch@1.3.2` is an official AudioWorkletNode wrapper, not a
  block-level WASM API that can be instantiated inside `ToadProcessor`.
- Following the documented fallback, Phase 2 currently uses a granular shifter.
  Pitch shifting is active, but independent formant shift/preservation is not;
  the adapter logs one warning when a non-zero formant value is requested.
