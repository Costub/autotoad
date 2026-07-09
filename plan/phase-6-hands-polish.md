# Phase 6 — Hands + Polish

## Goal

The final phase, in two halves:

**A. Hand-gesture control**: MediaPipe HandLandmarker in a Web Worker → `GestureFrame`s → a gesture mapper with continuous slide gestures (grab-fader, finger slide, air XY pad, flick) driving live parameters, plus a gesture HUD and webcam thumbnail with landmark overlay.

**B. Polish + ship**: performance-mode UI, settings persistence (localStorage), Vercel deploy with verified COOP/COEP, and a full feel-audit against spec §8.

Gestures are **additive** — every parameter remains controllable on-screen; denying the webcam must leave the app fully functional.

## Prerequisites

Phases 0–5 complete.

## Files to create / modify

```
create: src/vision/handWorker.ts        (Web Worker)
create: src/vision/gestureMapper.ts
create: src/vision/gestureMath.ts       (pure helpers — testable)
create: src/ui/GestureHud.tsx
create: src/ui/CamThumb.tsx
create: tests/gestureMapper.test.ts
modify: src/audio/engine.ts / App.tsx   (vision startup — AFTER audio is running)
modify: src/ui/Console.tsx              (performance mode, HUD mount)
modify: src/state/store.ts              (persistence, gesture state mirror)
public/mediapipe/                        (vendored wasm + model — see 6.1)
```

---

## 6.1 Vendoring MediaPipe assets (COEP requires same-origin)

CDN loading will fail under COEP. Vendor at build time:

1. Copy the wasm fileset from `node_modules/@mediapipe/tasks-vision/wasm/` → `public/mediapipe/wasm/` (add an npm `postinstall` or a small copy script run in `predev`/`prebuild`: `node scripts/copy-mediapipe.mjs`).
2. Download the model once and commit it: `hand_landmarker.task` (float16) from Google's storage (`https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task`) → `public/mediapipe/hand_landmarker.task`. If network access is unavailable at implementation time, add the copy script + a README note in `public/mediapipe/` telling the user to place the file there, and make the vision path fail soft with the friendly message "Hand tracking model missing — see public/mediapipe/README".

## 6.2 `src/vision/handWorker.ts` (Web Worker)

Main thread owns the camera (worker `getUserMedia` is flaky); worker owns inference:

- **Main side** (a small `startVision()` in `gestureMapper.ts` or a `vision/index.ts`): `getUserMedia({ video: { width: 480, height: 360, frameRate: 30 } })` — ≤480 px wide, non-negotiable (spec pitfall #4: bigger frames starve the machine). Play it into a hidden `<video>`; use `requestVideoFrameCallback` to `createImageBitmap(video)` and `worker.postMessage({ type:'frame', bitmap, t }, [bitmap])`. **Drop frames while the worker is busy**: keep an `inFlight` flag; skip capture until the worker replies.
- **Worker side**: create `FilesetResolver.forVisionTasks('/mediapipe/wasm')` → `HandLandmarker.createFromOptions(..., { baseOptions: { modelAssetPath: '/mediapipe/hand_landmarker.task' }, runningMode: 'VIDEO', numHands: 2 })`. On each frame message: `detectForVideo(bitmap, t)`, `bitmap.close()`, compute the `GestureFrame` (below), post it back (+ raw landmarks for the thumbnail overlay, decimated to every other frame).

### GestureFrame computation (put pure parts in `gestureMath.ts` and unit-test)

MediaPipe landmark indices: wrist 0, thumb tip 4, index tip 8, index PIP 6, middle tip 12 / PIP 10, ring 16/14, pinky 20/18, middle MCP 9. Coordinates are normalized [0..1], **y down** — flip to y-up (`1 - y`) for `height`. Mirror x (`1 - x`) so it acts like a mirror for the user.

```ts
handScale   = dist(wrist, middleMCP)                       // hand-size calibration
pinch       = clamp(dist(thumbTip, indexTip) / (handScale * 2.2), 0, 1)
pinchClosed = hysteresis: closes when pinch < 0.25, opens when pinch > 0.35
height      = 1 - wrist.y ; x = 1 - wrist.x
indexTip    = { x: 1 - lm[8].x, y: 1 - lm[8].y }
fingerUp(tip, pip) = lm[tip].y < lm[pip].y - 0.02          // raw y (down = larger)
fingersUp   = count over index/middle/ring/pinky + thumb (thumb: x-distance from index MCP > threshold)
fist        = fingersUp === 0
velocity    = EMA over last 3 frames of Δ indexTip / Δt (frame-widths per second)
handedness  = from MediaPipe's handedness output — NOTE: after mirroring x, swap the label
              (MediaPipe reports handedness for the camera image; the user's right hand
              appears as 'Left' in an unmirrored image).
```

## 6.3 `src/vision/gestureMapper.ts` — main thread

Consumes `GestureFrame`s (~30 fps), maintains per-hand state machines, writes parameters through the **existing** choke points only: `store.set` → engine subscription → ParamsBus, and `fxBus.setParam` via store. Never writes audio nodes directly.

### Universal smoothing

Every gesture-driven value passes a per-target one-pole (`tau = 80 ms`) before hitting the store, and the store→UI slider is additionally visually eased (the sliders from Phase 2 already animate; verify they don't teleport). Vision runs at 30 fps but params update at 60 fps: run the mapper's smoothing inside the existing rAF pump (Phase 4.3), interpolating toward the latest gesture value.

### Slide-gesture state machines (per hand; implement as specified)

- **Grab-fader** (primary precision gesture): on `pinchClosed` rising edge → record `grabY = height` and `grabValue = current param value`. While held: `value = clamp(grabValue + (height - grabY) / 0.5 * range, min, max)` — **relative** control, ±0.5 frame-height = full range; the value NEVER jumps to the hand position. On release: keep value, then apply **release inertia**: continue the last value-velocity, decaying to zero over ~120 ms (exponential decay of the delta).
- **Finger slide**: active when hand open (`fingersUp >= 3`, not pinching): horizontal indexTip.x movement beyond a **0.03 frame-width deadzone** (from the slide-start anchor) maps relatively to the bound param; 150 ms of stillness (|dx| < 0.005/frame) commits the value and re-anchors.
- **Air XY pad** (UI-toggled mode, right hand): `indexTip.x → delayFeedback (0..0.75)`, `indexTip.y → reverbSend (0..1)`, absolute mapping with the 80 ms smoothing; crosshair echoed in the HUD. While XY mode is on, the right hand's other slide gestures are disabled (mode exclusivity).
- **Flick**: `|velocity.dx| > 2.5` frame-widths/s with open hand → one discrete event (prev/next instrument preset); refractory period 400 ms.
- **Discrete poses**: right fist held 300 ms → looper record arm/disarm toggle (refractory 800 ms); both fists 500 ms → panic. Left `fingersUp` (0–4, only when left hand open-ish and not pinching and stable 250 ms) → harmonyVoices count (maps to preset: 0=off 1=duet 2=triad 3=choir 4=octaves — document this simplification in a comment).

### Default mapping table (data-driven — a `GestureBinding[]` array, easily remapped)

| Gesture | Parameter | Range |
|---|---|---|
| Right pinch distance (open hand, not grabbed) | wet/dry mix (`wetLevel`, `dryLevel = 1 − wet·0.5`… simplest: map to `wetLevel` 0..1) | 0..1 |
| Right grab-fader | `retuneMs` | 0..400 ms |
| Left grab-fader | `formantShift` | −12..+12 st |
| Right finger slide (horizontal) | `delayTime` — snaps to the 4 divisions with hysteresis (¼ zone borders ±10%) | index 0..3 |
| Left finger slide (horizontal) | `reverbDecay` | 0.5..8 s |
| Air XY pad (right indexTip) | x=`delayFeedback`, y=`reverbSend` | 0..0.75 / 0..1 |
| Right height (when no other right gesture active) | `pitchShift` quantized to −12/0/+12 with hysteresis (zones 0–0.33/0.33–0.66/0.66–1, ±0.05 hysteresis) | octaves |
| Left fingersUp | harmony preset | 0..4 |
| Left height (when no other left gesture active) | `harmonySpread` | 0..1 |
| Right flick ←/→ | instrument preset prev/next | — |
| Right fist 300 ms | looper record toggle | — |
| Both fists 500 ms | panic (bypass on, all notes off, cancel record) | — |

Conflict rule (encode in the state machine): per hand, exactly one gesture owns the hand at a time, priority: fist-poses > grab-fader > XY pad > finger slide > pinch-distance/height ambient mappings. Ambient (height/pinch) mappings only apply when nothing else owns the hand AND the hand has been present ≥ 500 ms (prevents param jumps when a hand enters the frame).

## 6.4 Gesture HUD + cam thumbnail + control glow

- **`GestureHud.tsx`**: a thin overlay strip on the stage's bottom edge: for each hand currently owning a gesture, show `L`/`R`, the parameter name, and its live value (e.g. `R · retune · 142 ms`) in muted text; XY mode shows a soft crosshair mini-map. Updates via a 60 fps rAF read of a small mutable gesture-state object (not React state per frame — use a ref + direct DOM text updates, or a tiny Pixi layer).
- **`CamThumb.tsx`**: small (~120 px) webcam preview bottom-right of the stage, mirrored, with landmark dots drawn from the worker's decimated landmark messages on a canvas overlay. Toggleable.
- **Control glow**: while a gesture holds a parameter, the corresponding on-screen slider gets a lily-green glow (`box-shadow` + accent thumb) and moves in real time. Implement via a `gestureHeld: Record<string, boolean>` slice in the store updated on own/release edges (edge events are low-rate; fine for React).

## 6.5 Polish (spec §8 — do all of these)

1. **Performance mode**: a toggle (and auto after 5 s of no pointer movement? No — keep it manual, one button top-right): hides everything but the stage (scaled up), the HUD, and a minimal transport strip; 150 ms opacity crossfade; nothing scrolls; Esc exits (Esc still panics — use a dedicated key, `P`, or the same button to exit; document the choice).
2. **Settings persistence**: persist to localStorage (key `autotoad-settings-v1`) a whitelisted subset of the store: key, retuneMs, correctionAmount, pitchShift, formantShift, dry/wet, harmonyPreset, harmonySpread, engineMode, instrument, legato, chordFollow, all FX params, bpm, bars, metronomeOn, camThumb visible, XY-pad mode. Load on boot (before StartGate), save debounced 300 ms on change. Never persist: started, error, telemetry, layers, `inputSource` (always boot to mic), `isRecordingTake`.
3. **StartGate as preloader**: gate now preloads in parallel behind its single progress line: worklet module, shifter WASM bytes, reverb IR generation, MediaPipe wasm+model `fetch` warmup (vision worker starts lazily on gate completion; webcam permission is requested at gate time but denial is non-fatal → toast "Gestures off — webcam unavailable", everything else proceeds).
4. **`prefers-reduced-motion`**: verify ambient drift off, transitions to 50 ms, pitch trace kept.
5. **Deploy**: `npm run build` → deploy to Vercel (`vercel deploy` or git integration; if the implementing agent can't deploy, produce the build and verify `npm run preview` serves with COOP/COEP and `crossOriginIsolated === true`, and document the deploy steps in the README).
6. **Cold-start budget**: gate-click → first sound < 4 s on broadband: check bundle sizes (`vite build --report` or rollup-plugin-visualizer optional), lazy-load MediaPipe (it must NOT block audio start).
7. **Optional (only if time permits, after everything above passes) — real formant preservation**: Phase 2 shipped on the granular fallback because `signalsmith-stretch@1.3.2` only exposes its own AudioWorkletNode, not a raw block API. The fix is to vendor the Signalsmith WASM core (compile or extract the raw module), load its bytes via `processorOptions` (the Phase 2.1 pattern), and implement a real `Shifter` adapter behind the existing interface in [shifterPool.ts](../src/audio/dsp/shifterPool.ts) — nothing outside that file changes. Treat as its own session; skip freely.

## 6.6 Tests — `tests/gestureMapper.test.ts`

Pure `gestureMath.ts` + mapper state machines with synthetic `GestureFrame` sequences (30 fps steps):

1. Pinch hysteresis: pinch sequence 0.4→0.3→0.24→0.3→0.36 → closed becomes true at 0.24, stays true at 0.3, false at 0.36.
2. Grab-fader relativity: param at 200; grab at height 0.5, drag to 0.75 → param ≈ 200 + (0.25/0.5)·400 = 400-capped… (retune range 0–400: expect 300 before smoothing settles; test the target math pre-smoothing). Release → value retained. Re-grab at a different height → **no jump** (value unchanged at grab instant).
3. Finger-slide deadzone: 0.02 frame-width wiggle → no param change; 0.05 movement → change.
4. Flick: velocity 3.0 → one event; sustained high velocity 10 frames → still one event (refractory).
5. Fist hold: fist for 250 ms → nothing; 320 ms → one record-toggle event.
6. Hand-entry guard: hand appears and immediately has height 0.9 → ambient height mapping does nothing for the first 500 ms.
7. Priority: pinchClosed + fingersUp 0 conflict → fist pose wins.

## Acceptance checklist (final — includes the §8 feel audit)

Gestures:
- [ ] All mapping-table gestures work; parameter motion is visibly smooth (no stepping) — slow circles on the XY pad produce continuous delayFeedback/reverbSend change with nothing audible stepping.
- [ ] Grab-fader never jumps on grab; release inertia is visible in the HUD and audible.
- [ ] Denying the webcam: everything else fully functional, friendly toast shown.
- [ ] Vision worker holds ~30 fps without starving audio (worklet p95 unchanged) — frames downscaled ≤480 px, frame-dropping confirmed under load.
- [ ] HUD shows held params live; on-screen controls glow green and track gesture motion.

Polish / feel (§8 audit — record results in the PR/commit description):
- [ ] Palette audit: only the 7 tokens; amber only on record/loop; no gradients on UI surfaces.
- [ ] Typography: 13/15/20 px only, weights 400/500; pixel font only in stage + wordmark.
- [ ] Every UI transition 150–250 ms with the standard bezier; hovers 100 ms; nothing snaps/bounces.
- [ ] 60 fps sustained in performance mode; main-thread scripting ≤ 4 ms/frame (DevTools performance trace while singing + gesturing + 3 loop layers).
- [ ] Zero layout shift after StartGate; no spinners anywhere; panel/mode switches crossfade.
- [ ] Defaults sound produced with zero configuration (retuneMs 80, reverbSend 0.18); limiter ≤ 3 dB in normal use.
- [ ] `prefers-reduced-motion` respected.
- [ ] Settings persist across reload; cleared layers don't resurrect.
- [ ] Cold start gate-click → sound < 4 s.
- [ ] Production build deployed (or `npm run preview` verified) with `crossOriginIsolated === true`; ParamsBus in `'sab'` mode; MediaPipe loads same-origin.
- [ ] `npm run test` and `npm run build` pass.

## Common mistakes to avoid

1. Loading MediaPipe from CDN — COEP blocks it. Same-origin `/mediapipe/` only.
2. Full-resolution webcam frames into the worker — ≤480 px wide, and drop frames while inference is busy (spec pitfall #4).
3. Absolute grab-fader mapping (value jumps to hand position on grab) — the spec's #1 gesture-feel requirement is relative control.
4. Writing gesture values straight to audio nodes or the ParamsBus — go through the store/`fxBus.setParam` choke points so UI, persistence, and glow all stay coherent.
5. Updating React state at 30–60 Hz for HUD/landmarks — refs + direct canvas/DOM updates only; React re-renders are for edges (own/release).
6. Forgetting handedness swap after mirroring — left/right bindings end up inverted.
7. Letting the vision worker start before audio — audio start must never wait on the ~5 MB model download.
