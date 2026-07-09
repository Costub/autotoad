# Phase 0 — Project Scaffold

## Goal

A running Vite + React + TypeScript (strict) SPA with:
- COOP/COEP headers in dev and a `vercel.json` for production (needed for `SharedArrayBuffer` later),
- all dependencies installed,
- the repository directory structure in place,
- the shared types file,
- the Zustand store with the full app state shape,
- **`src/audio/theory/scales.ts` fully implemented and unit-tested** (Phase 1 depends on it),
- an app shell (`App.tsx`, `Console.tsx`) with the design tokens as CSS variables.

No audio, no Pixi rendering, no mic access in this phase. `npm run dev` shows the console frame with a placeholder stage area; `npm run test` passes; `npm run build` succeeds.

## Prerequisites

None. Empty repo except `autotoad.md` and `plan/`.

## Steps

### 0.1 Scaffold and dependencies

```bash
npm create vite@latest . -- --template react-ts
npm i react react-dom pixi.js tone pitchy zustand @mediapipe/tasks-vision
npm i -D vitest @types/node
```

Also attempt `npm i signalsmith-stretch`. If the package does not exist or fails to install, **do not block** — Phase 2 documents the fallback. Just skip it and note it in your summary.

Add to `package.json` scripts: `"test": "vitest run"`.

### 0.2 `tsconfig` — strict

Ensure the app tsconfig has (Vite's template mostly does; verify):

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler"
  }
}
```

### 0.3 `vite.config.ts` — exact content

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// COOP/COEP make the page cross-origin isolated, which enables SharedArrayBuffer.
// The same two headers are set for production in vercel.json.
export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
```

### 0.4 `vercel.json` — exact content

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    }
  ]
}
```

### 0.5 Directory structure

Create these directories now (empty dirs may need a `.gitkeep`):

```
public/mediapipe/          # vendored MediaPipe wasm+model (filled in Phase 6)
public/sprites/            # pixel-art spritesheets (placeholders OK; filled later)
src/state/
src/audio/worklets/
src/audio/dsp/
src/audio/theory/
src/audio/midi/
src/audio/instruments/
src/audio/looper/
src/audio/fx/
src/vision/
src/ui/pixi/
tests/
```

### 0.6 `src/types.ts` — exact content

```ts
// Shared types used across main thread, worklet, and vision worker.
// This file must stay worklet-safe: types + const enums only, no DOM.

export type ScaleName =
  | 'major' | 'naturalMinor' | 'harmonicMinor' | 'majorPentatonic'
  | 'minorPentatonic' | 'blues' | 'dorian' | 'mixolydian' | 'chromatic';

/** Ordered list — the ParamsBus stores a scale as an index into this array. */
export const SCALE_ORDER: readonly ScaleName[] = [
  'major', 'naturalMinor', 'harmonicMinor', 'majorPentatonic',
  'minorPentatonic', 'blues', 'dorian', 'mixolydian', 'chromatic',
] as const;

export interface KeyConfig {
  /** Tonic pitch class 0–11 (C=0, C#=1, … B=11). */
  tonicPc: number;
  scale: ScaleName;
}

export type EngineMode = 'effect' | 'instrument' | 'both';
export type InstrumentName = 'chiptune' | 'fmBass' | 'pluck' | 'choirPad';
export type HarmonyPresetName = 'off' | 'duet' | 'triad' | 'choir' | 'octaves';
export type DelayDivision = '8n' | '8n.' | '4n' | '2n';

export interface NoteEvent {
  type: 'noteOn' | 'noteOff' | 'pitchBend';
  midi: number;          // MIDI note number for on/off; ignored for bend
  velocity?: number;     // 1..127, noteOn only
  cents?: number;        // pitchBend only
  time: number;          // AudioContext currentTime seconds
}

export interface HandFrame {
  handedness: 'Left' | 'Right';
  pinch: number;                       // 0..1 normalized thumb–index distance
  pinchClosed: boolean;                // hysteresis: closes < 0.25, opens > 0.35
  height: number;                      // wrist y, 0 bottom .. 1 top
  x: number;                           // wrist x, 0..1
  indexTip: { x: number; y: number };  // 0..1
  velocity: { dx: number; dy: number };// frame-widths/sec, EMA over 3 frames
  fingersUp: number;                   // 0..5
  fist: boolean;
}

export interface GestureFrame {
  t: number; // performance.now() ms at capture
  hands: HandFrame[];
}
```

### 0.7 `src/audio/theory/scales.ts` — implement fully (copy this)

This module is pure math, worklet-safe, and used by everything. Implement exactly:

```ts
import type { KeyConfig, ScaleName } from '../../types';

/** Semitone offsets from the tonic for each scale. */
export const SCALE_INTERVALS: Record<ScaleName, readonly number[]> = {
  major:           [0, 2, 4, 5, 7, 9, 11],
  naturalMinor:    [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor:   [0, 2, 3, 5, 7, 8, 11],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues:           [0, 3, 5, 6, 7, 10],
  dorian:          [0, 2, 3, 5, 7, 9, 10],
  mixolydian:      [0, 2, 4, 5, 7, 9, 10],
  chromatic:       [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export function freqToMidiFloat(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// --- Snap table cache -------------------------------------------------------
// snapToScale is called every 128-sample block in the worklet, so it must be
// O(1): precompute, for each of 128 MIDI notes, the nearest in-scale note.
// Cache key: tonicPc * 16 + scaleIndex (scaleIndex from SCALE_ORDER).

const snapCache = new Map<string, Int8Array /* 128 entries: snapped midi note */>();

function buildSnapTable(key: KeyConfig): Int8Array {
  const intervals = SCALE_INTERVALS[key.scale];
  const inScale = new Array<boolean>(12).fill(false);
  for (const iv of intervals) inScale[(key.tonicPc + iv) % 12] = true;

  const table = new Int8Array(128);
  for (let m = 0; m < 128; m++) {
    if (inScale[m % 12]) { table[m] = m; continue; }
    // Search outward; tie-break UPWARD (check +d before -d).
    for (let d = 1; d <= 6; d++) {
      const up = m + d, down = m - d;
      if (up < 128 && inScale[up % 12]) { table[m] = up; break; }
      if (down >= 0 && inScale[((down % 12) + 12) % 12]) { table[m] = down; break; }
    }
  }
  return table;
}

function getSnapTable(key: KeyConfig): Int8Array {
  const cacheKey = `${key.tonicPc}:${key.scale}`;
  let t = snapCache.get(cacheKey);
  if (!t) { t = buildSnapTable(key); snapCache.set(cacheKey, t); }
  return t;
}

/**
 * Nearest MIDI note whose pitch class is in the scale. Input is a float
 * (e.g. 63.4); we round to the nearest integer note first, then snap that.
 * If the rounded note is exactly between two in-scale notes, ties break upward.
 */
export function snapToScale(midiFloat: number, key: KeyConfig): number {
  const table = getSnapTable(key);
  const m = Math.min(127, Math.max(0, Math.round(midiFloat)));
  const snapped = table[m]!;
  // Rounding first can pick the wrong side when midiFloat sits between two
  // in-scale notes with a non-scale note in the middle. Fix by comparing the
  // snapped candidates of floor and ceil and choosing the closer in float space.
  const mf = Math.min(127, Math.max(0, Math.floor(midiFloat)));
  const mc = Math.min(127, Math.max(0, Math.ceil(midiFloat)));
  const a = table[mf]!, b = table[mc]!;
  if (a === b) return snapped;
  const da = Math.abs(midiFloat - a), db = Math.abs(midiFloat - b);
  return db <= da ? b : a; // tie-break upward (b >= a)
}

/** Scale-degree index (0..len-1) of a MIDI note in the key, or -1 if not in scale. */
export function degreeOf(midiNote: number, key: KeyConfig): number {
  const intervals = SCALE_INTERVALS[key.scale];
  const pcRel = (((midiNote % 12) - key.tonicPc) % 12 + 12) % 12;
  return intervals.indexOf(pcRel);
}
```

### 0.8 `src/state/store.ts` — full state shape

Zustand store. Actions are simple setters; the wiring to the audio engine happens in later phases (via a subscribe in `engine.ts`), so keep the store pure data + setters.

```ts
import { create } from 'zustand';
import type {
  EngineMode, HarmonyPresetName, InstrumentName, KeyConfig, DelayDivision,
} from '../types';

export interface AppState {
  // lifecycle
  started: boolean;               // StartGate passed
  micReady: boolean;
  error: string | null;           // user-facing error message, null = none

  // tuning
  key: KeyConfig;                 // default { tonicPc: 0, scale: 'major' }
  retuneMs: number;               // 0..400, default 80
  correctionAmount: number;       // 0..1, default 1
  pitchShift: number;             // semitones -24..24, default 0
  formantShift: number;           // semitones -12..12, default 0
  dryLevel: number;               // 0..1, default 0
  wetLevel: number;               // 0..1, default 1
  bypass: boolean;                // default false

  // harmony
  harmonyPreset: HarmonyPresetName; // default 'off' (but 'triad' pre-selected in UI)
  harmonySpread: number;            // 0..1, default 0.3

  // instrument
  engineMode: EngineMode;           // default 'effect'
  instrument: InstrumentName;       // default 'chiptune'
  legato: boolean;                  // default false
  chordFollow: boolean;             // default false

  // fx
  reverbSend: number;               // 0..1, default 0.18
  reverbDecay: number;              // seconds 0.5..8, default 2.2
  delaySend: number;                // 0..1, default 0
  delayTime: DelayDivision;         // default '8n.'
  delayFeedback: number;            // 0..0.75, default 0.35

  // looper
  bpm: number;                      // default 90
  bars: number;                     // default 2
  metronomeOn: boolean;             // default true

  // telemetry mirrored for UI (written by a rAF loop, NOT per-block)
  latencyMs: number;                // measured chain latency, for display

  // actions — one setter per field group
  set: (partial: Partial<AppState>) => void;
}

export const useStore = create<AppState>((set) => ({
  started: false, micReady: false, error: null,
  key: { tonicPc: 0, scale: 'major' },
  retuneMs: 80, correctionAmount: 1, pitchShift: 0, formantShift: 0,
  dryLevel: 0, wetLevel: 1, bypass: false,
  harmonyPreset: 'off', harmonySpread: 0.3,
  engineMode: 'effect', instrument: 'chiptune', legato: false, chordFollow: false,
  reverbSend: 0.18, reverbDecay: 2.2, delaySend: 0, delayTime: '8n.', delayFeedback: 0.35,
  bpm: 90, bars: 2, metronomeOn: true,
  latencyMs: 0,
  set: (partial) => set(partial),
}));
```

Note: per-frame telemetry (detected pitch etc.) will NOT live in this store — the Pixi scene reads it straight from the ParamsBus at 60 fps (Phase 1). Only slow values (latency, layer lists) mirror into Zustand.

### 0.9 App shell + design tokens

- `src/index.css`: define CSS variables `--bg:#0E1B1E; --panel:#152528; --hairline:#24393D; --text:#E8F1EE; --muted:#8FA6A3; --accent:#5DCB6A; --amber:#F2B24C;` plus `--ease: cubic-bezier(0.25, 0.1, 0.25, 1);`. Body: background `var(--bg)`, color `var(--text)`, font-family `Inter, system-ui, sans-serif`, `font-size: 15px`. Load Inter from a bundled local `@font-face` if convenient or just use `system-ui` for now (no external CDN — COEP will block cross-origin resources without CORP headers).
- `src/App.tsx`: renders `<Console />`.
- `src/ui/Console.tsx`: a centered column, max-width ~960px — a top wordmark bar ("AUTOTOAD" text placeholder), a large stage area (empty dark rounded panel with a 160:144 aspect-ratio inner box, `background: var(--panel)`, hairline border), and below it a slim horizontal dock placeholder (`div` with hairline top border) where control groups will go. No modals, nothing scrolls.
- Delete Vite's template boilerplate (logos, counter demo, default App.css contents).

### 0.10 Tests — `tests/theory.test.ts`

Write Vitest tests for `scales.ts`. Minimum cases (all must pass):

```ts
// freqToMidiFloat / midiToFreq round-trip: for m in [36..84], midiToFreq→freqToMidiFloat ≈ m (±1e-9)
// freqToMidiFloat(440) === 69; midiToFreq(69) === 440
// snapToScale in C major: 60→60, 61→62 (tie-break upward: C# is 1 from C and 1 from D → D),
//   63→64 (D# → E, since 63 is 1 from 62 and 1 from 64 → upward), 60.4→60, 61.6→62
// snapToScale in A naturalMinor (tonicPc 9): 68→69, 61→62 (in scale: A B C D E F G)
// snapToScale chromatic: identity for all integers 0..127
// degreeOf: C major — 60→0, 64→2, 67→4, 61→-1; works across octaves (72→0)
// snap table cache: calling snapToScale 10_000 times completes < 50ms (sanity, not strict)
```

## Acceptance checklist (verify before finishing)

- [ ] `npm run dev` serves the app; the console shell renders (wordmark, empty stage panel, dock strip) with the correct palette.
- [ ] In the browser console on the dev page: `crossOriginIsolated === true`.
- [ ] `npm run test` — all theory tests pass.
- [ ] `npm run build` succeeds with no TS errors.
- [ ] `tsconfig` strict is on; no `any` anywhere in `src/`.
- [ ] Directory structure from step 0.5 exists.

## Common mistakes to avoid

1. Loading Google Fonts or any CDN asset — COEP `require-corp` blocks cross-origin resources without CORP headers, and the page will visibly break. Bundle everything locally.
2. Putting telemetry values (pitch, rms) in the Zustand store — that causes React re-renders at audio rate. Store shape above deliberately excludes them.
3. Forgetting `worker: { format: 'es' }` in Vite config — needed for module workers later.
4. Implementing `snapToScale` with a linear search per call instead of the cached table — the worklet will call it every block.
