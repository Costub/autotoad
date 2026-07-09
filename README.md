# AUTOTOAD

AUTOTOAD is a browser-based voice instrument: tuner toad, autotune,
harmonizer, instruments, FX, and quantized looping.

## Run locally

```powershell
npm.cmd install
npm.cmd run dev -- --host 127.0.0.1 --port 4174
```

Open `http://127.0.0.1:4174/` in Chrome or Edge with headphones connected.

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

The repo includes `vercel.json` headers for COOP/COEP (required for the
SharedArrayBuffer params bus). Deploy through GitHub or:

```powershell
vercel deploy
```
