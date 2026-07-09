# AUTOTOAD Progress

Last updated: 2026-07-09

## Current status

Phases 0–4 are implemented. Every phase is maintained as an individual
milestone commit.

| Phase | Status | Commit |
|---|---|---|
| 0 — Scaffold | Complete | `22e972f` |
| 1 — Tuner Toad | Complete | `335b50e` |
| 2 — Autotune | Implemented with documented shifter fallback | `c763e00` |
| 3 — Harmonizer | Complete; manual audio QA remains | `9edf7e3` |
| 4 — Instruments + FX | Complete; manual audio QA remains | this commit |
| 5 — Looper | Not started | — |
| 6 — Hands + polish | Not started | — |

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

## Automated verification

Run:

```powershell
npm.cmd run test
npm.cmd run build
```

Current result:

- 5 test files passed.
- 44 tests passed.
- Strict TypeScript production build passed.
- Production output contains a separately bundled AudioWorklet.
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
- audio glitches under five-voice load;
- perceived formant quality.

### Performance measurements still needed

- Record the actual displayed latency in Chrome.
- Confirm `workletP95Us ≤ 1500` with four harmony voices active.
- Confirm the stage remains near 60 fps during five-voice operation.

The granular implementation is optimized with lookup windows, inactive-voice
skipping, and post-ramp reset, but the real device measurement is authoritative.

### Browser QA environment

- Phase 1 startup-gate layout was inspected in the Codex in-app browser.
- That embedded browser could not complete the microphone/AudioWorklet path.
- During the Phase 4 smoke pass the in-app browser backend was available but
  exposed no open tab, so the new control layout and audio interactions could
  not be interactively inspected by the agent.
- Chrome remains the authoritative manual environment for the provided test
  procedure.

### Visual assets and future phases

- Toad, ghost, lilypads, tadpoles, ripples, and fireflies are placeholder Pixi
  graphics, not final sprite art.
- Quantized recording/overdub looper is Phase 5 and is not implemented.
- MediaPipe hand tracking, gesture controls, persistence, performance mode, and
  deployment polish are Phase 6 and are not implemented.
- Safari support remains deferred by the project specification.

## Engineering decisions

- Phase work orders remain authoritative and are implemented in order.
- High-frequency telemetry is read directly from ParamsBus by Pixi, never put
  into React state.
- Worklet/DSP/theory modules remain DOM-free.
- Every audible mix change is smoothed in the render thread.
- `P` is a runtime `as const` object instead of a `const enum` so the exact bus
  layout can be shared by Vite's main bundle, worklet bundle, and tests.
