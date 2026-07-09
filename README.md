# AUTOTOAD

AUTOTOAD is a browser-based voice instrument: tuner toad, autotune,
harmonizer, instruments, FX, quantized looping, and optional webcam gestures.

## Run locally

```powershell
npm.cmd install
npm.cmd run dev -- --host 127.0.0.1 --port 4174
```

Open `http://127.0.0.1:4174/` in Chrome or Edge with headphones connected.

## Hand tracking assets

COOP/COEP requires MediaPipe assets to be served same-origin.

The wasm files are copied from `node_modules/@mediapipe/tasks-vision/wasm` by:

```powershell
npm.cmd run copy:mediapipe
```

The hand model must be placed manually at:

```text
public/mediapipe/hand_landmarker.task
```

Download the float16 model from:

https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task

If the model is absent, AUTOTOAD still runs normally and shows:

```text
Hand tracking model missing — see public/mediapipe/README
```

## Verify

```powershell
npm.cmd run test
npm.cmd run build
npm.cmd run preview -- --host 127.0.0.1 --port 4174
```

In the production preview, verify:

```js
crossOriginIsolated === true
```

After audio starts:

```js
const { engine } = await import('/src/audio/engine.ts');
engine.bus.mode === 'sab'
```

## Deploy

The repo includes `vercel.json` headers for COOP/COEP. Deploy through GitHub or:

```powershell
vercel deploy
```

Before production deployment, make sure `public/mediapipe/hand_landmarker.task`
is present if gesture control should be enabled. The app remains usable without
the model.
