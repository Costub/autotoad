# AUTOTOAD — Implementation Specification

A browser-based real-time voice instrument. The user's voice is the sound engine; their hands (webcam-tracked) are the control surface. Core capabilities: dynamic autotune to a key/scale, formant-preserving pitch shifting, a diatonic harmonizer (polyphony), voice-to-synth instrument modes, and a quantized looper for stacking layers. UI is a Game Boy-era pixel-art console aesthetic built around the mascot: a pixel toad that hops between lilypads (scale notes) as you sing — always croaking in perfect key.

Everything runs client-side. No backend. Deploy target: Vercel static hosting.

---

## 1. Goals and non-goals

### Goals
- Sub-60ms mic-to-speaker latency for the live effect chain.
- Autotune with adjustable retune speed (0ms hard snap → 300ms transparent).
- Formant-preserving pitch shift ±24 semitones, plus independent formant-only shift.
- Harmonizer: up to 4 additional voices at *diatonically correct* intervals.
- Voice-to-MIDI mode driving Tone.js instruments (chiptune lead, FM bass, pluck).
- Looper: quantized record/overdub of layers, each layer with its own engine settings.
- Hand-gesture control of live parameters via MediaPipe Hands, including continuous slide/drag gestures (air faders and an XY pad), not just discrete poses.
- Global FX bus: lush reverb and tempo-synced delay, gesture-controllable in real time.
- Pixel-art UI: pitch rendered as a toad sprite hopping along a scrolling lilypad staff, PixiJS.
- The whole experience must feel sleek and effortless: every control eased, every audio change ramped, 60fps UI, zero jank (see section 8, Design language & feel — it is a requirement, not a nice-to-have).

### Non-goals (do not build)
- No server, accounts, or persistence beyond localStorage for settings. NOTE: localStorage is fine in this standalone Vite app (this is NOT a claude.ai artifact).
- No mobile-first support in v1 (desktop Chrome/Edge primary; Firefox best-effort; Safari explicitly deferred).
- No offline audio export in v1 (stretch goal: render loop stack to WAV).
- No CREPE / ML pitch detection in v1 (YIN/MPM only; leave a seam for it).

---

## 2. Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Build | Vite + TypeScript (strict) | SPA, no SSR |
| UI framework | React 18 | UI shell, routing-free single page |
| Canvas/visuals | PixiJS v8 | Pixel-art renderer; `roundPixels: true`, nearest-neighbor scaling |
| Audio graph | Web Audio API + AudioWorklet | All DSP off main thread |
| Pitch shift | `signalsmith-stretch` (WASM build) | Formant-preserving shift; one instance per voice. If the npm/WASM wrapper proves unusable, fall back to SoundTouchJS (accept loss of formant preservation, keep the same internal interface) |
| Pitch detection | `pitchy` (McLeod Pitch Method) | Runs inside a worklet on a ring buffer |
| Synths/FX/transport | Tone.js v15 | MIDI-mode instruments, metronome, looper clock, FX sends |
| Hand tracking | `@mediapipe/tasks-vision` HandLandmarker | Runs in a Web Worker at ~30fps |
| State | Zustand | Single store; audio params mirrored into a SharedArrayBuffer/params bus |
| Styling | Plain CSS modules | Pixel font: "Press Start 2P" or similar bundled bitmap font |

Install: `npm i react react-dom pixi.js tone pitchy zustand @mediapipe/tasks-vision signalsmith-stretch` (verify exact package name for the signalsmith WASM wrapper at implementation time; if no maintained npm wrapper exists, vendor the WASM build under `src/audio/wasm/` with its JS glue).

### Cross-origin isolation requirement
`SharedArrayBuffer` requires COOP/COEP headers. Configure:
- Vite dev: `server.headers` → `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`.
- Vercel: `vercel.json` headers block with the same two headers on `/(.*)`.
- MediaPipe WASM assets must then be served same-origin: copy them into `public/mediapipe/` at build time rather than loading from CDN.
- If COOP/COEP turns out to be untenable, fall back to `port.postMessage` for the params bus (a `ParamsBus` abstraction, section 4.2, must hide which transport is used).

---

## 3. Architecture overview

Three execution contexts:

1. **Audio render thread (AudioWorklet)** — `ToadProcessor`, the single DSP worklet. Receives raw mic audio, runs pitch detection, pitch correction, harmonizer voices, and outputs the processed mix. Reads control params from the params bus every block. 128-sample blocks at the context sample rate (assume 48000 Hz; never hardcode — read `sampleRate` global in the worklet).
2. **Main thread** — React UI, PixiJS visualizer, Tone.js graph (MIDI-mode instruments + looper transport + FX), Zustand store, audio graph wiring.
3. **Vision worker (Web Worker)** — MediaPipe HandLandmarker consuming webcam frames, emitting a compact `GestureFrame` ~30 times/sec to the main thread, which maps it to params and writes the params bus.

### Audio graph wiring (main thread)

```
mic (MediaStreamSource, processed constraints OFF)
  └─> ToadProcessor (AudioWorkletNode)   // detection + correction + harmony
        ├─> dryWetMixer ─┬─> masterGain ─> limiter (DynamicsCompressor) ─> destination
        │                ├─> reverbSend ─> Tone.Reverb ──┐
        │                └─> delaySend ─> Tone.FeedbackDelay ─┴─> fxReturn ─> masterGain
        └─> looperInputTap (GainNode)   // what the looper records (pre-FX)

Tone.js graph (separate, but shares the same AudioContext via Tone.setContext):
  voiceMIDI events ─> active Tone instrument ─> instrumentGain ─> masterGain (+ FX sends)
  looper players (one BufferSource/Tone.Player per layer) ─> layerGains ─> masterGain (+ FX sends)
```

All three sources (live voice mix, instruments, looper layers) share the single global FX bus via per-source send gains — see section 5.11.

Critical: create ONE AudioContext with `{ latencyHint: 'interactive' }` and hand it to Tone via `Tone.setContext(new Tone.Context(rawCtx))` so worklet audio and Tone audio share a clock.

### getUserMedia constraints (non-negotiable)

```ts
navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  },
  video: false, // webcam requested separately by the vision worker path
});
```

Browser DSP (AEC/NS/AGC) destroys pitch-detection accuracy and adds latency. The start screen must include a headphones gate: a modal stating headphones are required, with a "I'm wearing headphones" confirm button, before the mic is opened.

---

## 4. Repository structure

```
autotoad/
├─ index.html
├─ vite.config.ts
├─ vercel.json
├─ public/
│  ├─ mediapipe/                  # vendored HandLandmarker wasm + model
│  └─ sprites/                    # pixel-art spritesheets (placeholder art OK)
├─ src/
│  ├─ main.tsx
│  ├─ App.tsx
│  ├─ state/
│  │  └─ store.ts                 # Zustand: key, scale, engine mode, retune, voices, looper state
│  ├─ audio/
│  │  ├─ engine.ts                # AudioEngine class: context, graph wiring, start/stop
│  │  ├─ paramsBus.ts             # ParamsBus: SAB (or message) param transport, typed layout
│  │  ├─ fx/
│  │  │  └─ fxBus.ts              # global reverb + tempo-synced delay send bus
│  │  ├─ worklets/
│  │  │  └─ toad-processor.ts      # the AudioWorkletProcessor (built as separate entry)
│  │  ├─ dsp/
│  │  │  ├─ pitchTracker.ts       # pitchy wrapper + smoothing (worklet-safe, no DOM)
│  │  │  ├─ shifterPool.ts        # N signalsmith-stretch instances, worklet-safe
│  │  │  └─ envelope.ts           # RMS follower for voiced/unvoiced + MIDI velocity
│  │  ├─ theory/
│  │  │  ├─ scales.ts             # scale definitions, note<->freq, snap-to-scale
│  │  │  └─ harmony.ts            # diatonic interval resolution
│  │  ├─ midi/
│  │  │  └─ voiceToMidi.ts        # note segmentation state machine
│  │  ├─ instruments/
│  │  │  └─ presets.ts            # Tone.js instrument presets (chiptune, fmBass, pluck, choirPad)
│  │  └─ looper/
│  │     └─ looper.ts             # quantized record/overdub engine
│  ├─ vision/
│  │  ├─ handWorker.ts            # Web Worker: MediaPipe HandLandmarker loop
│  │  └─ gestureMapper.ts         # GestureFrame -> param changes (main thread)
│  ├─ ui/
│  │  ├─ Console.tsx              # the "handheld console" frame layout
│  │  ├─ StartGate.tsx            # headphones + permissions gate
│  │  ├─ ControlsPanel.tsx        # key/scale/engine/retune/voices controls
│  │  ├─ LooperPanel.tsx          # track lanes, record/mute/clear
│  │  └─ pixi/
│  │     ├─ PitchStage.tsx        # React wrapper mounting the Pixi app
│  │     └─ pitchScene.ts         # toad sprite, scrolling lilypad staff, tadpoles, fireflies
│  └─ types.ts                    # shared types: GestureFrame, ParamLayout, NoteEvent, ...
└─ tests/
   ├─ theory.test.ts
   ├─ voiceToMidi.test.ts
   └─ smoothing.test.ts
```

Vite must build the worklet as its own entry (`toad-processor`) and the engine loads it with `audioContext.audioWorklet.addModule(workletUrl)` using Vite's `?worker&url` / `new URL(..., import.meta.url)` pattern. Do not import DOM-touching modules into the worklet bundle.

---

## 5. Module specifications

### 5.1 `theory/scales.ts`

```ts
export type ScaleName = 'major' | 'naturalMinor' | 'harmonicMinor' | 'majorPentatonic'
  | 'minorPentatonic' | 'blues' | 'dorian' | 'mixolydian' | 'chromatic';
export interface KeyConfig { tonicMidi: number; /* 0-11 pitch class, e.g. C=0 */ scale: ScaleName; }

export const SCALE_INTERVALS: Record<ScaleName, number[]>; // semitone offsets from tonic, e.g. major [0,2,4,5,7,9,11]

export function freqToMidiFloat(freq: number): number;      // 69 + 12*log2(f/440)
export function midiToFreq(midi: number): number;           // 440 * 2^((m-69)/12)
export function snapToScale(midiFloat: number, key: KeyConfig): number;
// snapToScale: returns the nearest MIDI note whose pitch class ∈ scale.
// Tie-break upward. Must be O(1)-ish: precompute a 128-entry lookup per KeyConfig
// and cache it keyed by (tonic, scale); the worklet calls this every block.
export function degreeOf(midiNote: number, key: KeyConfig): number; // scale degree index 0..len-1, or -1
```

### 5.2 `audio/paramsBus.ts`

A fixed-layout `Float64Array` over a `SharedArrayBuffer`, written by main thread, read by worklet each `process()` call. Layout (export as `const enum P`):

```
0  bypass            0|1
1  retuneMs          0..400
2  correctionAmount  0..1        (blend between detected and target pitch)
3  keyTonic          0..11
4  scaleId           integer index into ScaleName order
5  formantShift      -12..+12 semitones (formant only)
6  pitchShift        -24..+24 semitones (global, pre-correction)
7  harmonyVoices     0..4
8  harmonyIntervals  bitpacked: 4 x int8 → encode as 4 slots [8..11] instead, one per voice, values = diatonic steps (e.g. +2 = third above, +4 = fifth above, -7 = octave below in scale steps)
12 harmonySpread     0..1        (detune+pan randomization amount)
13 dryLevel          0..1
14 wetLevel          0..1
15 inputGain         0..2
16..19 reserved
--- worklet -> main (read side telemetry) ---
20 detectedFreq      Hz, 0 if unvoiced
21 detectedClarity   0..1
22 correctedFreq     Hz
23 rmsLevel          0..1
```

If SAB is unavailable, `ParamsBus` degrades to `port.postMessage({params})` throttled to one message per 16ms, plus a telemetry message from worklet to main every 4 blocks. The public API must be identical either way: `bus.set(P.retuneMs, 120)`, `bus.get(P.detectedFreq)`.

### 5.3 `audio/dsp/pitchTracker.ts` (worklet-side)

Wraps `pitchy`'s `PitchDetector.forFloat32Array(windowSize)`.

- Window: 2048 samples, hop: 128 (analyze on every block using a ring buffer of the last 2048 input samples).
- Output per block: `{ freq: number, clarity: number }`.
- **Smoothing pipeline (implement exactly, in this order):**
  1. Gate: if `clarity < 0.9` or `rms < 0.01` → mark frame unvoiced (`freq = 0`).
  2. Octave-jump rejection: if voiced and `|midiFloat(freq) - midiFloat(lastGoodFreq)| > 9` semitones within one frame, and `clarity < 0.97`, treat as unvoiced glitch (keep lastGoodFreq for continuity for up to 3 frames).
  3. Median filter over the last 5 voiced frames (in MIDI-float space, not Hz).
  4. One-pole smoother on the median output: `smoothed += (median - smoothed) * (1 - exp(-blockDur / tau))` with `tau = 8ms`.
- Hysteresis for *note identity* (used by autotune target selection and MIDI mode): the current target note only changes when the smoothed pitch is >60 cents past the boundary toward the new note, OR has been >40 cents past for >80ms. Expose `getStableNote(): number | null`.

### 5.4 `audio/worklets/toad-processor.ts`

The single `AudioWorkletProcessor`. Responsibilities per 128-sample block:

1. Copy input into the analysis ring buffer; compute RMS (via `envelope.ts`).
2. Run `pitchTracker.analyze()`.
3. Compute **correction ratio**:
   - `targetMidi = snapToScale(smoothedMidiFloat, key)` blended by `correctionAmount`.
   - Retune-speed smoothing on the target: `appliedTarget += (targetMidi - appliedTarget) * (1 - exp(-blockDur / retuneTau))` where `retuneTau = retuneMs / 1000`. With `retuneMs = 0`, `appliedTarget = targetMidi` immediately (hard snap).
   - `correctionSemitones = appliedTarget - smoothedMidiFloat` (0 when unvoiced → pass dry).
   - Total lead-voice shift = `pitchShift + correctionSemitones`.
4. Feed the input block to the **shifter pool**:
   - Voice 0 (lead): shift = total lead shift; formant shift = `formantShift` param.
   - Voices 1..N (harmony): shift = lead shift + `harmony.resolveInterval(stableNote, key, intervalSteps)` semitones (see 5.5). Apply per-voice static detune (±(spread * 12) cents) and per-voice constant-power pan; pan is applied by writing voices into a stereo output with per-voice gains.
5. Mix: `out = dry * dryLevel + sum(voices) * wetLevel`. Unvoiced frames: harmony voices are muted with a 10ms ramp (never hard-cut — click-free ramps on ALL gain changes, 64-sample linear minimum).
6. Write telemetry (detectedFreq, clarity, correctedFreq, rms) to the bus.

**Shifter latency note:** signalsmith-stretch introduces its own latency (typically ~1500–4000 samples depending on config). Configure the smallest viable block/interval settings for live use; delay the DRY path by the reported `inputLatency + outputLatency` so dry/wet stay phase-coherent. Expose the total latency to the UI for display.

### 5.5 `audio/theory/harmony.ts`

```ts
// intervalSteps: signed number of SCALE steps (not semitones). +2 = "a third above" in-scale.
export function resolveInterval(stableNoteMidi: number, key: KeyConfig, intervalSteps: number): number;
// Returns SEMITONE offset from stableNoteMidi to the note `intervalSteps` scale-degrees away.
// If stableNoteMidi is not in the scale (degreeOf === -1), first snap it to scale, then step.
// Must handle octave wrap (steps beyond scale length add/subtract 12 per wrap).
```

Example, C major, sung note = E4 (64), intervalSteps = +2 → G4 → returns +3. Sung note = F4 (65), +2 → A4 → returns +4. This context-dependence is the entire point; unit-test it exhaustively.

Default harmony presets (UI buttons): `Duet` [+2], `Triad` [+2, +4], `Choir` [+2, +4, -7], `Octaves` [+7, -7].

### 5.6 `audio/midi/voiceToMidi.ts`

State machine converting the tracker stream into `NoteEvent`s (`noteOn(midi, velocity)`, `noteOff(midi)`, optional `pitchBend(cents)` continuous):

- IDLE → NOTE_ON when: voiced AND stableNote available AND rms > onThreshold (0.02) for ≥ 30ms. Velocity = mapped from peak RMS during onset (0.02→0.3 rms → 40→120 velocity, clamped).
- NOTE_ON → retrigger (noteOff+noteOn) when stableNote changes (hysteresis already handled by tracker) OR an amplitude re-attack occurs (rms rises >6dB above its 100ms trailing minimum) — this makes fast "da-da-da" articulation work.
- NOTE_ON → NOTE_OFF when unvoiced OR rms < offThreshold (0.012, deliberately below onThreshold) for ≥ 60ms.
- Legato mode toggle: when on, note changes send pitch glide instead of retrigger (use `Tone.Synth.setNote`).
- Send continuous pitch bend of `(smoothedMidiFloat - stableNote) * 100` cents when bend is enabled (chromatic-expressive mode); disabled by default in scale mode.

### 5.7 `audio/instruments/presets.ts`

Four Tone.js presets, each a factory returning `{ synth: Tone.PolySynth | Tone.Synth, out: Tone.Gain }`:

- `chiptune`: square oscillator, tiny decay, `Tone.BitCrusher(4)` + slapback `FeedbackDelay('16n', 0.15)`.
- `fmBass`: `Tone.FMSynth`, harmonicity 1, modIndex ~8, output pitched −12 from sung note.
- `pluck`: `Tone.PluckSynth` into short plate `Reverb`.
- `choirPad`: `Tone.PolySynth(Tone.AMSynth)` slow attack, chorus + long reverb (pairs with harmonizer intervals: MIDI mode can optionally receive chord notes = stable note + resolved harmony intervals).

### 5.8 `audio/looper/looper.ts`

- User sets tempo (default 90 BPM) and bars (default 2, 4/4). Loop length = bars·4·60/BPM seconds, converted to an exact sample count.
- Transport = `Tone.Transport`; metronome = simple synth click, toggleable, count-in of 1 bar before first record.
- Record source: the `looperInputTap` (post-effect wet signal) captured via a dedicated recording worklet or `MediaStreamAudioDestinationNode → MediaRecorder` is NOT acceptable (compressed, laggy). Implement capture in `ToadProcessor` itself: when the bus flag `recordArm` is set with a target start time (in context samples), the worklet copies its OUTPUT blocks into a preallocated Float32Array of exactly loop-length samples, then posts the buffer (transferable) to main.
- Quantization: record start/stop snap to the loop boundary — pressing record mid-loop arms it for the next boundary. The armed state must be visible in UI.
- Each completed layer becomes an `AudioBufferSourceNode` scheduled in a sample-accurate loop (`loop = true`, `loopEnd = loopLengthSeconds`), started at a shared `loopEpoch` context time so all layers stay locked. Store per-layer: buffer, gain node, engine-settings snapshot (for display), mute state.
- Max 8 layers. Overdub = just another layer (no destructive merge in v1).
- Latency compensation: shift recorded buffers earlier by the measured chain latency (`context.baseLatency + context.outputLatency + shifter latency`) so layers align with what the performer heard.

### 5.9 `vision/handWorker.ts` + `gestureMapper.ts`

Worker loop: HandLandmarker in VIDEO mode on webcam frames at ≤30fps (use `requestVideoFrameCallback` on main thread posting ImageBitmaps, or OffscreenCanvas). Emit:

```ts
interface GestureFrame {
  t: number;
  hands: Array<{
    handedness: 'Left' | 'Right';
    pinch: number;        // normalized thumb-index distance 0..1 (calibrated to hand size via wrist–middle-MCP distance)
    pinchClosed: boolean; // pinch < 0.25 with hysteresis (release at > 0.35) — the "grab" state for drag gestures
    height: number;       // wrist y, 0 bottom .. 1 top of frame
    x: number;            // wrist x 0..1
    indexTip: { x: number; y: number }; // fingertip position 0..1, for slide/point gestures
    velocity: { dx: number; dy: number }; // indexTip velocity in frame-widths/sec (EMA over 3 frames)
    fingersUp: number;    // 0..5 extended-finger count
    fist: boolean;        // all fingers curled
  }>;
}
```

`gestureMapper.ts` (main thread) maps frames → store/params with per-target one-pole smoothing (tau 80ms) and deadzones.

**Slide gestures (continuous drags — implement as a small state machine per hand):**
- **Grab-fader**: pinch closed = grab an invisible fader; while held, vertical drag adjusts the bound parameter *relatively* (delta from grab point, ±0.5 frame-height = full range), so values never jump to the hand position. Release keeps the value. This is the primary precision gesture.
- **Finger slide**: with an open hand and index extended, horizontal indexTip slides sweep the bound parameter; a 0.03 frame-width deadzone prevents idle drift, and 150ms of stillness commits the value.
- **Air XY pad**: a dedicated mode (toggled in UI) where the right indexTip becomes a 2D controller — x = delay feedback, y = reverb send — with the current position echoed as a soft crosshair in the gesture HUD.
- **Flick**: indexTip velocity > 2.5 frame-widths/sec horizontally = discrete flick event (used for preset next/prev).
- All slide-driven values get an extra release-inertia stage: on release, the value glides to rest over ~120ms rather than freezing, which makes gestures feel physical instead of quantized.

Default mapping (must be a data-driven table, easily remapped):

| Gesture | Parameter |
|---|---|
| Right pinch distance (open-hand) | wet/dry mix |
| Right grab-fader (pinch + vertical drag) | retuneMs (fine control, 0–400ms) |
| Left grab-fader | formantShift |
| Right finger slide (horizontal) | delayTime (snaps to synced divisions with hysteresis) |
| Left finger slide (horizontal) | reverbDecay |
| Air XY pad mode (right indexTip) | x = delayFeedback, y = reverbSend |
| Right height | pitchShift, quantized to octaves (−12/0/+12) with hysteresis |
| Left fingersUp (0–4) | harmonyVoices |
| Left height | harmonySpread |
| Right flick left/right | instrument preset prev/next |
| Right fist held 300ms | looper record arm/disarm |
| Both fists 500ms | panic: bypass on |

Gestures are additive to the on-screen controls, never the only way to change something. If the webcam is denied, the app functions fully without gestures.

### 5.10 `ui/pixi/pitchScene.ts`

Scene metaphor: a pond at night, side-scrolling. The toad is your voice.

- 160×144-proportioned stage (Game Boy ratio) scaled up integer-multiples, `SCALE_MODES.NEAREST`.
- Horizontal scrolling staff: rows = scale notes across ~2 octaves around the singer's median pitch (auto-recenter slowly). Scale-note rows render as lilypads drifting left; non-scale rows are faint water ripples.
- Toad sprite (placeholder: 8×8 green square until art exists) whose y = smoothedMidiFloat mapped to row space, drawn with a trailing ripple line (the pitch trace scrolls left). Voiced = toad visible and mouth open; unvoiced = toad ducks underwater (submerged silhouette), matching the voiced/unvoiced gate.
- Corrected pitch shown as a ghost toad; when correction is active the two converge — this visualizes retune speed. On a hard snap (retuneMs=0) the toad *hops* to the target lilypad with a 2-frame jump animation.
- Harmony voices: smaller tadpole sprites swimming at their interval rows, trailing the toad.
- MIDI mode: note-on spawns a croak bubble; velocity = bubble size, popping on note-off.
- Looper layers: a firefly row at top (one firefly per layer), all pulsing in sync on the loop boundary; muted layers dim.
- Keep the render loop allocation-free; read telemetry from ParamsBus at 60fps, not via React state.
- Asset seam: all sprites referenced through a single `sprites.ts` manifest so placeholder squares can be swapped for real spritesheets in `public/sprites/` (toad idle/hop/duck/croak, tadpole swim, lilypad, firefly) without touching scene logic.

---

### 5.11 `audio/fx/fxBus.ts`

One global send-FX bus shared by voice, instruments, and looper layers. Two effects only in v1 — do them extremely well rather than shipping a rack.

```ts
export interface FxBus {
  reverb: Tone.Reverb;          // decay 0.5–8s (default 2.2s), preDelay 20ms
  delay: Tone.FeedbackDelay;    // tempo-synced: '8n' | '8n.' | '4n' | '2n' (default '8n.')
  connectSource(node: AudioNode | Tone.ToneAudioNode): { reverbSend: Tone.Gain; delaySend: Tone.Gain };
  setParam(name: FxParam, value: number): void; // ALWAYS ramps via rampTo(value, 0.05) — never sets .value directly
}
```

- **Reverb**: `Tone.Reverb` (convolution). Regenerate the impulse asynchronously on decay changes, crossfading old→new over 80ms so decay sweeps are click-free. A gentle low-cut (~150 Hz) on the reverb input keeps the wet mix from getting muddy with bass layers.
- **Delay**: `Tone.FeedbackDelay` synced to `Tone.Transport` divisions so looper layers and delay repeats always lock rhythmically. Feedback clamped to 0.75 max (self-oscillation guard). A one-pole high-cut (~4 kHz) inside the feedback path makes repeats decay naturally darker — this is what makes it sound expensive.
- Exposed params (`FxParam`): `reverbSend`, `reverbDecay`, `delaySend`, `delayTime` (indexed division), `delayFeedback`. All live in the Zustand store (FX runs on the Tone side, not in the worklet, so they do NOT go through ParamsBus); the gesture mapper and UI both write through `setParam`, which is the single choke point guaranteeing ramped changes.
- Per-source sends: live voice and instruments get UI send knobs; looper layers each get a small reverb-send control in their lane (delay send is global-only in v1). Layers are recorded pre-FX (see 5.8), so FX remain live and tweakable on playing loops — turning the reverb down affects every layer at once, which is the right behavior for a performance instrument.
- Defaults on first load: reverbSend 0.18, delaySend 0.0 — subtle polish out of the box, never a bathroom.



## 6. Implementation phases (each ends demoable; do them in order)

### Phase 1 — Tuner toad
Scope: StartGate (headphones + mic permission), AudioEngine with worklet loading, pitchTracker with full smoothing pipeline, ParamsBus telemetry, PitchStage rendering live pitch vs. selected key/scale. No audio output (bypass=1, dry muted).
Acceptance:
- Singing a C-major scale in key of C shows the sprite landing on consecutive platforms with no visible octave flips or flicker.
- Whistling and humming both track; speech shows voiced/unvoiced gating (sprite disappears on "sss").
- CPU: worklet `process()` under 30% of block budget (measure with `performance.now()` sampling, log p95).
- Unit tests for scales.ts and the smoothing pipeline (feed synthetic freq sequences with injected octave glitches; assert output stability) pass.

### Phase 2 — Autotune
Scope: shifterPool with signalsmith-stretch (single lead voice), correction math with retuneMs, dry-path latency alignment, ControlsPanel (key, scale, retune slider, correction amount, dry/wet), formant + pitch shift sliders.
Acceptance:
- retuneMs=0 produces the hard-quantized effect; retuneMs≈200 sounds natural on a sung phrase.
- No clicks on note transitions or voiced/unvoiced boundaries (verify by recording output and inspecting waveform for discontinuities).
- ±12 semitone shift does not chipmunk (formant preservation audibly working).
- Round-trip latency measured and displayed; ≤60ms on a desktop Chrome test.

### Phase 3 — Harmonizer
Scope: 4-voice shifter pool, harmony.ts with exhaustive tests, presets (Duet/Triad/Choir/Octaves), per-voice detune/pan via harmonySpread, harmony sprites in the visualizer.
Acceptance:
- In C major, singing E then F with Triad preset yields (E,G,B) then (F,A,C) — verified by telemetry logging of per-voice target notes.
- Harmony voices mute smoothly during unvoiced segments.
- 5 total voices sustain real-time on a mid-range laptop (no glitches at 128-sample blocks; if not achievable, document and raise context buffer via `latencyHint` fallback).

### Phase 4 — Instrument modes + FX bus
Scope: voiceToMidi state machine + tests, four Tone presets, mode switch (Effect mode ↔ Instrument mode ↔ Both), optional chord-follow (instrument receives harmony notes too). Plus `fxBus.ts` (5.11): reverb + synced delay with send routing from voice and instruments, and their UI controls.
Acceptance:
- Humming a melody with "da" articulation retriggers cleanly; sustained slides in legato mode glide.
- "ta-ta-ta" at 120 BPM eighth notes produces 8 distinct notes (test with a metronome recording).
- No stuck notes after 5 minutes of use (noteOff invariant: every noteOn has a matching off on unvoiced/mode-switch/panic).
- Sweeping reverbDecay 0.5→8s while singing produces no clicks or dropouts; delay repeats stay locked to the metronome across delayTime changes; delayFeedback at max never self-oscillates.

### Phase 5 — Looper
Scope: looper.ts, worklet capture path, LooperPanel with lanes (record/mute/volume/clear), metronome + count-in, latency-compensated alignment.
Acceptance:
- Record a 2-bar beatbox layer, then a hummed bass (fmBass instrument mode), then autotuned lead + Choir: all three loop locked with no audible drift over 5 minutes.
- Layer alignment: a click recorded on the beat plays back within ±10ms of the metronome.
- Record arm/boundary quantization behaves per spec (mid-loop press starts at next boundary).

### Phase 6 — Hands + polish
Scope: handWorker, gestureMapper with the full default table including all slide gestures (grab-fader, finger slide, air XY pad, flick — section 5.9), a gesture HUD overlay (thin, elegant readout showing which parameter each hand is holding and its live value, with the XY crosshair), webcam preview thumbnail with landmark overlay, performance-mode UI (big visualizer, minimal chrome), settings persistence, Vercel deploy config. Ends with a dedicated feel pass auditing the app against section 8 in full.
Acceptance:
- All table gestures work with no jitter (parameter values visibly smooth); denying webcam leaves everything else functional.
- Grab-fader: grabbing never causes a value jump (relative control verified); release inertia glide is visible in the HUD and audible.
- Air XY pad controlling delayFeedback/reverbSend feels continuous — no stepping audible during slow circles of the fingertip.
- Full app cold-start to sound in <4s on broadband.
- `npm run build` deploys to Vercel with COOP/COEP headers verified (check `crossOriginIsolated === true` in console).
- Section 8 checklist passes in a manual audit (record it in the PR description).

---

## 7. Cross-cutting requirements

- **TypeScript strict**, no `any` in `src/audio/**`. The worklet bundle must not import anything touching `window`/`document`.
- **All gain changes ramped** (min 64 samples linear or `setTargetAtTime`); grep-able rule: direct `gain.value =` assignments are forbidden outside initialization.
- **Panic button** (UI + Esc key + both-fists gesture): bypass DSP, all notes off, stop record.
- **Autoplay policy**: AudioContext is created/resumed only from the StartGate click handler.
- **Perf budget**: main thread ≤ 4ms/frame scripting during performance mode; worklet p95 ≤ 1.5ms per 128-sample block at 48kHz.
- **Testing**: Vitest. Pure-logic modules (theory, smoothing, voiceToMidi, looper timing math) need thorough unit tests; DSP audio quality is validated by the acceptance criteria above, manually.
- **Error surfaces**: mic denied, webcam denied, SAB unavailable, WASM load failure — each gets a specific, friendly pixel-styled message, never a blank screen.
- **Code style**: small modules, every DSP constant named and commented with units (ms, cents, semitones). No magic numbers inline.

## 8. Design language & feel (a spec, not a vibe)

The brief in one line: pixel-art heart inside a sleek, modern shell. The playful retro world lives *inside* the PixiJS stage; everything around it — panels, sliders, typography — is clean, quiet, and precise, like premium audio hardware housing a tiny game.

### Visual language
- **Palette (pond at night)**: deep ink teal background `#0E1B1E`, panel surface `#152528`, hairline borders `#24393D`, primary text `#E8F1EE`, muted text `#8FA6A3`, lily-green accent `#5DCB6A` (active states, toad), firefly amber `#F2B24C` (record/loop pulses only — scarcity keeps it meaningful). Nothing else. No gradients on UI surfaces.
- **Typography**: one clean grotesque (e.g. Inter or Instrument Sans) for all UI at exactly three sizes (13/15/20px, weights 400/500 only). The pixel bitmap font appears ONLY inside the PixiJS stage and the app wordmark — never in controls or body text.
- **Layout**: the stage is the hero, centered, with generous negative space; controls live in a single slim dock below it, grouped by module (Tune / Harmony / Instrument / FX / Loop) with hairline dividers. No modals except the StartGate; no nested panels; nothing scrolls in performance mode.
- **Controls**: custom slider and knob components (native inputs restyled or headless). Track = hairline, thumb = small solid circle, current value as quiet inline text that appears on interaction and fades 800ms after. Signature detail: while a gesture holds a parameter, its on-screen control glows lily-green and moves in real time — hands and UI are always telling the same story.

### Motion standards
- Every UI transition: 150–250ms, `cubic-bezier(0.25, 0.1, 0.25, 1)`. Hover states 100ms. Nothing snaps, nothing bounces.
- Every parameter is double-smoothed: audio-side ramps (worklet ramps / `rampTo`) AND visual easing of the control — a slider driven by a gesture must move like it's on rails, not teleporting between frames. Interpolate gesture-driven UI at 60fps between 30fps vision frames.
- The PixiJS scene animates continuously but calmly: drifting lilypads, occasional ripple. Ambient motion has a strict budget — it must never distract from the pitch trace.
- `prefers-reduced-motion`: ambient animation off, transitions to 50ms, pitch trace and functional feedback kept.

### Performance & smoothness (hard requirements)
- 60fps sustained in performance mode; zero layout shift after StartGate; interactions must never await audio work (all engine calls fire-and-forget with optimistic UI).
- No spinners in the core flow. The only load moment is the StartGate, which doubles as the asset preloader (worklet, WASM, MediaPipe, reverb impulse) behind a single subtle progress line, so the instrument opens instantly and warm.
- Panel/mode switches crossfade (150ms opacity) — content never pops in.

### Sound feel
- Defaults must sound good with zero configuration: retuneMs 80, one harmony voice off but pre-selected (Triad), reverbSend 0.18. First sung note out of the gate should already feel produced.
- The limiter is transparent, not a crutch: gain-stage sends so normal use never hits more than ~3dB of reduction.

## 9. Known pitfalls (read before coding)

1. `pitchy` clarity is unreliable at very low RMS — always gate on RMS *first*, then clarity.
2. signalsmith-stretch instances are stateful; never share one across voices, and call its reset on long unvoiced gaps to avoid smeared re-entry.
3. Tone.js and the raw context WILL drift apart if you create two contexts. One context. `Tone.setContext` first, before any Tone object is constructed.
4. MediaPipe frames must be downscaled (≤ 480px wide) before inference or the worker starves the machine.
5. Do not run pitch detection on the *output* — always on the pre-shift input ring buffer.
6. Vite worklet bundling: `new AudioWorkletNode` names must match `registerProcessor('toad-processor', ...)` exactly; a silent mismatch is the most common "no sound, no error" failure.
7. When the user changes key/scale mid-sustain, recompute the snap table but glide `appliedTarget` (never jump) — otherwise it clicks.

## 10. Stretch goals (only after Phase 6)
- Vocoder mode (voice modulator → synth carrier, 16-band filterbank in the worklet).
- WAV export of the loop stack (offline render of layer buffers).
- CREPE-tiny "studio mode" detection toggle.
- Real pixel-art spritesheets (toad animations, lilypads, fireflies) + themed pond "biomes" per scale (major = sunny pond, minor = midnight swamp, blues = neon bayou).