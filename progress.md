# AUTOTOAD Progress

Last updated: 2026-07-09

## Current status

Phases 0–6 are implemented. Every phase is maintained as an individual
milestone commit.

| Phase | Status | Commit |
|---|---|---|
| 0 — Scaffold | Complete | `22e972f` |
| 1 — Tuner Toad | Complete | `335b50e` |
| 2 — Autotune | Implemented with documented shifter fallback | `c763e00` |
| 3 — Harmonizer | Complete; manual audio QA remains | `9edf7e3` |
| 4 — Instruments + FX | Complete; manual audio QA remains | `7198f5b` |
| 5 — Looper | Complete; manual loop/audio QA remains | `36be127` |
| 6 — Hands + polish | Complete; manual webcam/audio/deploy QA remains | this commit |

## What is implemented

### Phase 0 — foundation

- Vite, React, and strict TypeScript SPA.
- COOP/COEP headers in Vite dev/preview and Vercel configuration.
- Zustand app store with tuning, harmony, instrument, FX, and looper state.
- Music-theory scale definitions, MIDI/frequency conversion, cached scale
  snapping, and scale-degree lookup.
- Required source directory structure and dark console shell.
- All dependencies installed, including PixiJS, Tone.js, pitchy, MediaPipe,
  Zustand, and `signalsmith-stretch`.

### Phase 1 — tuner toad

- Headphones/start gate with microphone permission and progress states.
- Exactly one interactive-latency `AudioContext`.
- Raw microphone constraints with echo cancellation, noise suppression, and
  automatic gain control disabled.
- `ParamsBus` with SharedArrayBuffer mode and postMessage fallback.
- AudioWorklet pitch analysis using pitchy.
- RMS gating, octave-glitch rejection, five-frame MIDI-space median filtering,
  one-pole smoothing, note hysteresis, and silence reset.
- Worklet ready handshake and process-time p95 telemetry.
- PixiJS stage with scale-aware lilypad rows, pitch trace, recentering, and a
  voiced/submerged placeholder toad.
- Key and scale selection.

### Phase 2 — autotune

- Testable correction-target state machine:
  - scale snapping;
  - correction amount;
  - hard snap at 0 ms;
  - retune-time target smoothing;
  - frozen target during silence;
  - clean re-entry and key-change glide continuity.
- Audible stereo worklet output.
- Five-instance `ShifterPool` seam.
- Low-latency granular pitch-shifter fallback for the lead voice.
- Global pitch shift from −24 to +24 semitones.
- Latency-matched dry path and click-free dry/wet/bypass gain ramps.
- Long-unvoiced shifter reset.
- Browser + shifter + detector-window latency calculation and display.
- Tune panel with key, scale, retune, amount, pitch, formant, mix, bypass,
  transient value labels, and Esc safety bypass.
- Corrected-pitch ghost toad and hard-retune hop animation.
- Bounded worklet module-load timeout and Vite development URL fallback.

### Phase 3 — harmonizer

- Diatonic interval resolver using signed scale steps rather than fixed
  semitones, including negative steps, octave wrapping, pentatonic scales,
  chromatic scales, and out-of-scale input snapping.
- Presets:
  - Off: no harmony;
  - Duet: third above;
  - Triad: third + fifth;
  - Choir: third + fifth + octave below;
  - Octaves: octave above + octave below.
- Four additional render-thread shifter voices from the existing pool.
- Deterministic per-voice detune and constant-power stereo pan controlled by
  Spread.
- Per-voice gain ramps; recently disabled voices continue processing until
  silent, then reset.
- Equal-power-ish headroom scaling as voices are added.
- Per-voice harmony-note telemetry at ParamsBus indices 28–31.
- Harmony preset buttons and Spread control.
- Four fading/wiggling tadpole placeholders tracking harmony-note rows.
- Granular window lookup tables so five voices do not calculate cosine windows
  for every output sample.

### Phase 4 — instruments, FX, and deterministic test harness

- Switchable Mic, generated Demo, and local audio File inputs; file audio is
  decoded and downmixed to mono before entering the existing worklet chain.
- Cached deterministic eight-note, deliberately detuned demo melody.
- Direct-telemetry input level meter and microphone-denied demo startup.
- Master-output Take recorder with elapsed time and `.webm` download.
- 60–180 BPM control and quarter-note metronome with first-beat accent.
- One shared raw/Tone audio context, master gain, and safety limiter.
- Tested voice-to-MIDI segmentation with onset/off holds, hysteresis,
  re-attacks, velocity, legato note changes, and forced all-off.
- Effect, Instrument, and Both modes.
- Chiptune, FM Bass, Pluck, and Choir Pad Tone.js presets.
- Optional legato and diatonic chord-follow behavior.
- Global reverb send with debounced dual-IR A/B crossfade.
- Tempo-synced feedback delay with filtered output and 75% feedback clamp.
- Ramped FX, metronome, and mode changes through engine choke points.
- Full panic behavior for bypassing voice and releasing active synth notes.
- Note-on croak bubbles with pooled Pixi graphics and note-off pops.

### Phase 5 — quantized loop station

- Worklet-side loop capture protocol:
  - `record-arm` preallocates the capture buffer outside `process()`;
  - render blocks copy the processor's own pre-FX stereo output to mono;
  - partial first/last blocks are handled by absolute frame overlap;
  - `record-done` transfers the recorded `ArrayBuffer` back to the main thread.
- Pure loop timing helpers for exact sample counts, next-boundary quantization,
  one-bar count-in math, and latency-compensation rotation.
- Main-thread `Looper` engine:
  - first recording gets a one-bar metronome count-in;
  - subsequent recordings arm for the next loop boundary;
  - finished recordings immediately become native looping
    `AudioBufferSourceNode` layers;
  - every layer starts with the correct offset against the shared loop epoch;
  - existing layers keep playing while new overdubs record;
  - up to 8 layers are enforced.
- Latency compensation rotates each captured loop by browser output latency,
  worklet shifter latency, and a store-tweakable sample offset.
- Per-layer mute, volume, clear, and local reverb-send controls with ramped
  gain changes.
- Loop layers route through the master bus and FX bus, so Take recording and
  global reverb/delay affect the loop stack.
- Panic cancels an armed/in-flight loop recording without deleting existing
  layers.
- Dedicated Loop dock section with BPM lockout, bar selection, click toggle,
  Record/Cancel states, loop-position progress line, 8-layer counter, and
  layer lanes.
- BPM and bars are locked while layers exist and re-enabled after clearing all
  layers.
- Pixi firefly row: one amber firefly per layer pulses at the loop boundary;
  muted layers dim; armed/recording shows a blinking amber slot.

### Phase 6 — hands and polish

- Same-origin MediaPipe asset pipeline:
  - `scripts/copy-mediapipe.mjs` copies wasm files to `public/mediapipe/wasm`;
  - `predev` and `prebuild` run the copy automatically;
  - `public/mediapipe/README.md` documents the required hand model path;
  - missing `hand_landmarker.task` fails soft with a friendly status.
- Worker-based hand tracking path:
  - main thread owns webcam permission and frame capture;
  - worker owns `HandLandmarker` inference;
  - frames are capped to 480px-wide camera constraints;
  - a single in-flight frame flag drops frames under load.
- Pure gesture math and mapper state machines:
  - pinch hysteresis;
  - relative grab-fader control;
  - finger-slide deadzone;
  - right-hand XY pad;
  - flick instrument switching with refractory period;
  - right-fist looper record toggle;
  - both-fists panic;
  - hand-entry guard before ambient height/pinch mappings.
- Gesture mappings write only through store/engine choke points, never directly
  to audio nodes or the ParamsBus.
- rAF-smoothed gesture targets for live parameter motion.
- Gesture HUD on the stage bottom edge with live held-parameter labels and XY
  crosshair.
- Mirrored camera thumbnail with landmark-dot canvas overlay and visibility
  toggle.
- Gesture-owned sliders glow green while held.
- Performance mode toggle:
  - hides the full dock and enlarges the stage;
  - keeps HUD and a minimal loop/take/panic strip;
  - `P` toggles performance mode.
- Settings persistence in `localStorage` key `autotoad-settings-v1`, limited to
  whitelisted musical/UI settings. Runtime state, telemetry, layers, input
  source, errors, and take-recording state are not persisted.
- Root `README.md` with run, verify, deploy, and MediaPipe model instructions.

## Automated verification

Run:

```powershell
npm.cmd run test
npm.cmd run build
```

Current result:

- 7 test files passed.
- 57 tests passed.
- Strict TypeScript production build passed.
- Production output contains a separately bundled AudioWorklet.
- Production output contains a separately bundled vision worker.
- `npm.cmd run preview -- --host 127.0.0.1 --port 4176` served
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.
- No explicit `any` under `src/`.
- No direct `.gain.value = ...` assignments.

The tests cover:

- scale and MIDI/frequency theory;
- pitch smoothing and note hysteresis;
- correction-target timing and unvoiced behavior;
- every required harmony example;
- full-scale positive/negative octave-wrap properties;
- chromatic and pentatonic harmony behavior;
- ParamsBus layout uniqueness.
- voice-to-MIDI onset/release timing, note changes, re-attacks, velocity
  mapping, and randomized note-on/note-off balance.
- loop length, next-boundary quantization, and loop-buffer rotation for latency
  compensation.
- gesture pinch hysteresis, relative grab mapping, finger-slide deadzone,
  flick refractory behavior, fist-hold record toggle, hand-entry guard, and
  fist-vs-pinch priority.

## How to test in Chrome

Use desktop Chrome or Edge. The embedded Codex browser cannot reliably complete
the microphone/AudioWorklet permission path.

1. Keep headphones connected.
2. Run `npm.cmd run dev -- --host 127.0.0.1 --port 4174`.
3. Open `http://127.0.0.1:4174/`.
4. Reload after code changes so Chrome receives the latest worklet module.
5. Press **I'm wearing headphones — start** and allow microphone access.

### Tuner test

- Sing a C-major scale with Key=C and Scale=Major.
- The green toad should track the sung pitch without octave flicker.
- Hum and whistle: both should track.
- Say “sssss” or stop singing: the toad should submerge.
- Change key/scale: lilypad rows should update immediately.

### Autotune test

- Set Mix=100% wet and Amount=100%.
- Retune=0 should sound hard-quantized.
- Retune≈200 ms should glide more naturally.
- Pitch at +12/−12 should move an octave.
- Mix=50% should not sound obviously hollow or comb-filtered.
- Click Bypass, then press Esc; transitions should not click.
- Note the displayed latency; target is ≤60 ms.

### Harmonizer test

- Set Key=C, Scale=Major, Harmony=Triad.
- Sing E4: expected notes are E4, G4, B4.
- Sing F4: expected notes are F4, A4, C5.
- Try Duet, Choir, and Octaves.
- Spread=0 should sound centered/tight.
- Spread=1 should sound wider and slightly detuned.
- Harmony appearance/disappearance should fade without clicks.
- Tadpoles should occupy the active harmony rows.

### Phase 4 test harness, instruments, and FX

1. Select **Demo**, Key=C, Scale=Major, Mix=100%, Amount=100%, Retune=0.
   Compare Bypass on/off; the deliberate detuning should disappear when active.
2. Select Harmony=Triad and Both mode. Choose each instrument preset; the
   generated melody should drive distinct notes while voice harmonies remain.
3. Enable Chord follow; each synth note should gain the selected diatonic
   harmony. Toggle Legato and compare note transitions.
4. Switch Mic → Demo → File and back. File opens an audio picker and loops the
   decoded local file through the complete processing chain.
5. Move Reverb/Decay and Delay/Feedback controls. Change delay division and
   BPM; the delay timing should follow tempo without clicks.
6. Toggle Click and step BPM. The first beat of each four-beat bar is higher.
7. Press **Take**, let the demo play, then press it again. Confirm the
   downloaded `.webm` plays the complete master mix.
8. Press **Panic** or Esc during a synth note. Voice bypasses and every synth
   note must release; the Take recorder intentionally continues.
9. Deny microphone permission after a fresh reload and use **Start with demo
   input instead**; the app should remain fully explorable.

### Phase 5 looper test

1. Select **Demo** as the input source. Keep Click enabled.
2. In the **Loop** section, set Tempo=90 and Bars=2. Press **Record**.
   The button should amber-pulse during the one-bar count-in, turn solid while
   recording, then return to idle/playing as layer 1 appears and immediately
   loops.
3. Press **Record** mid-loop. It should arm until the next boundary while layer
   1 keeps playing, then record layer 2 over it. Repeat to at least 3 layers.
4. Try Effect, Instrument, and Both modes before recording new layers; each
   layer lane should keep the snapshot label from record time.
5. Mute/unmute layers, move Vol and Rev sliders, and clear a single layer. The
   remaining layers should stay in time.
6. Clear all layers. BPM and Bars controls should become editable again.
7. Stack 8 layers; Record should disable at the cap.
8. Press **Take** while loops play, then stop it. The downloaded `.webm` should
   include the loop stack plus any live voice/instrument input.
9. Press **Panic** while armed or recording. No corrupt layer should appear, and
   previously recorded layers should keep playing.
10. Watch the stage top row: fireflies should pulse together on loop boundaries,
    muted layers should dim, and the armed/recording slot should blink amber.

### Phase 6 gestures and polish test

1. Run `npm.cmd run copy:mediapipe`. Confirm wasm assets exist under
   `public/mediapipe/wasm`.
2. For gesture QA, place `hand_landmarker.task` at
   `public/mediapipe/hand_landmarker.task`. Without it, the app should still
   start and show **Hand tracking model missing — see public/mediapipe/README**.
3. Start the app and allow microphone access. Webcam denial should leave all
   audio/UI features functional and show **Gestures off — webcam unavailable**.
4. Toggle **Cam** and verify the mirrored thumbnail appears with landmark dots
   when the model/camera are available.
5. Right pinch-and-drag vertically: Retune should move relatively with no jump
   on grab; the Retune slider should glow green and the HUD should show the
   held value.
6. Left pinch-and-drag vertically: Formant should move relatively.
7. Right open-hand horizontal slide: Delay division should step through the
   four divisions after the deadzone. Left open-hand slide should move Reverb
   Decay.
8. Toggle **XY**. Right index movement should drive Delay Feedback on x and
   Reverb on y with the HUD crosshair active.
9. Right-hand flick left/right should switch instrument presets once per flick.
10. Right fist held about 300 ms should toggle loop record; both fists held
    about 500 ms should trigger Panic.
11. Press **Perf** or `P`. The dock should hide, stage should enlarge, HUD
    should remain, and the minimal loop/take/panic strip should stay usable.
12. Change settings, reload, and verify persisted settings return while loop
    layers, input source, take-recording state, and runtime errors do not.

### Telemetry verification

In Chrome DevTools Console:

```js
const { engine } = await import('/src/audio/engine.ts');
const { P } = await import('/src/audio/paramsBus.ts');
const timer = setInterval(() => console.table({
  stable: engine.bus.get(P.stableNote),
  harmony0: engine.bus.get(P.harmonyNote0),
  harmony1: engine.bus.get(P.harmonyNote1),
  harmony2: engine.bus.get(P.harmonyNote2),
  harmony3: engine.bus.get(P.harmonyNote3),
  workletP95Us: engine.bus.get(P.workletP95Us),
  busMode: engine.bus.mode,
}), 500);
```

For C-major Triad:

- E4: `stable=64`, `harmony0=67`, `harmony1=71`.
- F4: `stable=65`, `harmony0=69`, `harmony1=72`.

Stop the temporary console timer with:

```js
clearInterval(timer);
```

Expected production isolation: `crossOriginIsolated === true` and
`engine.bus.mode === "sab"`.

## Known limitations and things not completed

### Signalsmith/formant limitation

The installed `signalsmith-stretch@1.3.2` package is an official Web Audio
wrapper that creates its own separate `AudioWorkletNode`. It does not export the
raw block-level WASM API required by AUTOTOAD's single `ToadProcessor`.

Phase 2 therefore uses the plan's permitted hand-rolled granular fallback:

- pitch correction and pitch shifting are implemented;
- independent formant shifting is currently a no-op;
- formant preservation is not guaranteed;
- the adapter logs one warning if a non-zero Formant value is requested;
- the ±12 semitone “no chipmunk” acceptance item is not guaranteed.

A future fix requires vendoring/adapting the raw Signalsmith WASM core behind
the existing `Shifter` interface.

### Runtime checks requiring a human listener

The agent cannot hear the output. These remain manual:

- hard vs natural retune sound quality;
- click detection at note and voiced/unvoiced transitions;
- 50/50 dry/wet phase coherence by ear;
- harmony musical balance and stereo width;
- instrument preset balance, reverb/delay feel, and metronome level;
- take playback and source-switch click checks;
- loop capture alignment, overdub smoothness, mute/unmute click checks, and
  whether the default latency compensation needs a manual sample offset on the
  target machine;
- long-run loop drift checks over 5 minutes;
- webcam gesture feel, lighting robustness, handedness, and HUD/thumbnail
  behavior with the actual MediaPipe model installed;
- audio glitches under five-voice load;
- perceived formant quality.

### Performance measurements still needed

- Record the actual displayed latency in Chrome.
- Confirm `workletP95Us ≤ 1500` with four harmony voices active.
- Confirm `workletP95Us ≤ 1500` while worklet capture is recording a loop.
- Confirm the stage remains near 60 fps during five-voice operation.
- Confirm vision worker stays near 30 fps without increasing audio worklet p95
  while singing, gesturing, and playing three loop layers.

The granular implementation is optimized with lookup windows, inactive-voice
skipping, and post-ramp reset, but the real device measurement is authoritative.

### Browser QA environment

- Phase 1 startup-gate layout was inspected in the Codex in-app browser.
- That embedded browser could not complete the microphone/AudioWorklet path.
- During the Phase 4 smoke pass the in-app browser backend was available but
  exposed no open tab, so the new control layout and audio interactions could
  not be interactively inspected by the agent.
- Phase 5 automated math/build verification passed, but audible loop alignment
  and drift verification still require desktop Chrome with speakers/headphones.
- Phase 6 automated mapper/build verification passed. Live gesture verification
  requires the hand model file plus desktop Chrome webcam permission.
- Chrome remains the authoritative manual environment for the provided test
  procedure.

### Visual assets and future phases

- Toad, ghost, lilypads, tadpoles, ripples, and fireflies are placeholder Pixi
  graphics, not final sprite art.
- The MediaPipe wasm files are vendored, but `hand_landmarker.task` could not be
  downloaded in this restricted environment. Add it at
  `public/mediapipe/hand_landmarker.task` to enable live hand tracking.
- Production deployment has not been pushed through Vercel from this
  environment; `README.md` documents the deploy command and required
  COOP/COEP checks.
- Safari support remains deferred by the project specification.

## Engineering decisions

- Phase work orders remain authoritative and are implemented in order.
- High-frequency telemetry is read directly from ParamsBus by Pixi, never put
  into React state.
- Worklet/DSP/theory modules remain DOM-free.
- Every audible mix change is smoothed in the render thread.
- `P` is a runtime `as const` object instead of a `const enum` so the exact bus
  layout can be shared by Vite's main bundle, worklet bundle, and tests.
