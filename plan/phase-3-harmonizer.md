# Phase 3 — Harmonizer

## Goal

Up to 4 additional voices singing **diatonically correct** intervals with the lead:

- `harmony.ts` — scale-step interval resolution (the musical brain), exhaustively unit-tested.
- Worklet drives shifter voices 1–4 from the pool created in Phase 2, each with per-voice detune and constant-power pan controlled by `harmonySpread`.
- Harmony presets in the UI: Off / Duet / Triad / Choir / Octaves.
- Smooth (ramped) muting of harmony voices during unvoiced segments.
- Tadpole sprites swimming at the harmony rows in the visualizer.
- Per-voice target-note telemetry for verification.

## Prerequisites

Phase 2 complete: shifter pool of 5 exists, lead correction works.

## Files to create / modify

```
create: src/audio/theory/harmony.ts
create: tests/harmony.test.ts
modify: src/audio/worklets/toad-processor.ts   (harmony voices, stereo pan/mix)
modify: src/audio/paramsBus.ts                 (telemetry for per-voice notes — see 3.3)
modify: src/ui/ControlsPanel.tsx               (Harmony group: preset buttons + spread slider)
modify: src/ui/pixi/pitchScene.ts              (tadpoles)
modify: src/state/store.ts / engine subscription (harmonyPreset -> bus intervals)
```

---

## 3.1 `src/audio/theory/harmony.ts` (worklet-safe — copy this)

`intervalSteps` are signed **scale steps**, not semitones. +2 = "a third above" (two scale degrees up). This context-dependence is the entire point of the feature.

```ts
import type { KeyConfig } from '../../types';
import { SCALE_INTERVALS, degreeOf, snapToScale } from './scales';

/**
 * Semitone offset from `stableNoteMidi` to the note `intervalSteps` scale-degrees away.
 * If stableNoteMidi is not in the scale, snap it to the scale first, then step;
 * the returned offset is still relative to the ORIGINAL stableNoteMidi.
 */
export function resolveInterval(
  stableNoteMidi: number,
  key: KeyConfig,
  intervalSteps: number,
): number {
  const intervals = SCALE_INTERVALS[key.scale];
  const len = intervals.length;

  let base = stableNoteMidi;
  let deg = degreeOf(base, key);
  if (deg === -1) {
    base = snapToScale(base, key);
    deg = degreeOf(base, key); // now guaranteed >= 0
  }

  // Absolute degree index on an infinite scale ladder, then step.
  const baseOctaveOffset = base - (key.tonicPc + intervals[deg]!); // multiple-of-12 anchor below/at base
  const targetDegRaw = deg + intervalSteps;
  const octaveShift = Math.floor(targetDegRaw / len);              // handles negative steps correctly
  const targetDeg = ((targetDegRaw % len) + len) % len;
  const target = baseOctaveOffset + key.tonicPc + intervals[targetDeg]! + 12 * octaveShift;

  return target - stableNoteMidi;
}

/** Preset name -> interval steps (order = voice order). */
export const HARMONY_PRESETS = {
  off:     [] as number[],
  duet:    [2],
  triad:   [2, 4],
  choir:   [2, 4, -7],
  octaves: [7, -7],
} as const;
```

Note on `baseOctaveOffset`: `key.tonicPc + intervals[deg]` is the pitch class of `base` expressed in 0..22 range; `base - that` is the octave anchor (a multiple of 12). Verify with the worked examples below before trusting it — if your derivation differs, fix the code until ALL test cases pass.

## 3.2 `tests/harmony.test.ts` — exhaustive (all must pass)

C major (`{tonicPc: 0, scale: 'major'}`) unless stated. Test EVERY row:

| stableNote | steps | expected target | expected return |
|---|---|---|---|
| E4 = 64 | +2 | G4 = 67 | **+3** |
| F4 = 65 | +2 | A4 = 69 | **+4** |
| C4 = 60 | +2 | E4 = 64 | +4 |
| B3 = 59 | +2 | D4 = 62 | +3 |
| C4 = 60 | +4 | G4 = 67 | +7 |
| C4 = 60 | +7 | C5 = 72 | +12 |
| C4 = 60 | −7 | C3 = 48 | −12 |
| C4 = 60 | −2 | A3 = 57 | −3 |
| E4 = 64 | −1 | D4 = 62 | −2 |
| C4 = 60 | +9 | E5 = 76 | +16 (octave wrap) |
| C4 = 60 | −9 | A2 = 45 | −15 |
| **C#4 = 61 (not in scale)** | +2 | snap→62 (D), +2 steps → F4=65 | 65−61 = **+4** |
| A minor (tonicPc 9, naturalMinor): A3 = 57 | +2 | C4 = 60 | +3 |
| A minor: B3 = 59 | +2 | D4 = 62 | +3 |
| A minor: C4 = 60 | +4 | G4 = 67 | +7 |
| minorPentatonic tonic C (len 5): C4=60 | +5 | C5 = 72 | +12 |
| minorPentatonic C: C4=60 | +2 | F4 = 65 | +5 |
| chromatic: any note | +n | +n semitones exactly | n |

Also property tests: for every scale, every in-scale note 48..72, `resolveInterval(n, key, len) === 12` and `resolveInterval(n, key, -len) === -12` (full wrap = octave); `resolveInterval(n, key, 0) === 0`.

## 3.3 ParamsBus additions

Extend telemetry (indices 28–31 were free; adjust `LENGTH` if needed):

```
28 harmonyNote0   // MIDI int target of harmony voice 0, -1 if inactive
29 harmonyNote1
30 harmonyNote2
31 harmonyNote3
```

(If you set LENGTH=32 in Phase 1 this fits exactly.)

## 3.4 Worklet changes

Per block, after computing the lead shift (Phase 2 step 4):

```ts
// Params: harmonyVoices (0..4), harmonyInterval0..3 (signed scale steps),
//         harmonySpread (0..1).
const MAX_DETUNE_CENTS = 12;    // cents at spread=1 — per-voice static detune
const UNVOICED_RAMP_MS = 10;    // ms
// Per-voice STATIC properties (computed once at init, deterministic per index):
//   detuneCents[i] = MAX_DETUNE_CENTS * DETUNE_SIGN[i]  where DETUNE_SIGN = [+1,-1,+0.5,-0.5]
//   panPos[i]      = PAN_POS[i] where PAN_POS = [-0.6, +0.6, -0.3, +0.3]  (-1 L .. +1 R)
// Applied detune = detuneCents[i] * spread / 100 semitones; applied pan angle scales with spread.

// For voice i in 0..harmonyVoices-1 (these are shifter pool indices 1..4):
//   if voiced && stableNote !== null:
//     semis = resolveInterval(stableNote, key, intervals[i])
//     voiceShift = leadShift + semis + detuneSemis(i, spread)
//     shifter[i+1].setTranspose(voiceShift); shifter[i+1].setFormant(formantShift);
//     shifter[i+1].process(input, voiceBuf[i])
//     telemetry harmonyNote{i} = stableNote + semis (post-correction target ≈ appliedTargetRound + semis)
//   Per-voice gain target = (voiced && i < harmonyVoices) ? 1 : 0, RAMPED (one-pole tau 5ms
//   or linear >= 64 samples) — harmony voices mute smoothly on unvoiced, never hard-cut.
//   Constant-power pan into stereo out:
//     angle = (panPos[i] * spread * 0.5 + 0.5) * PI/2   // 0..PI/2
//     outL += voiceBuf[i][s] * cos(angle) * g;  outR += voiceBuf[i][s] * sin(angle) * g;
// Lead voice pans center. Dry stays center. Keep per-voice gain state across blocks.
// IMPORTANT: process() must still run shifters for RECENTLY active voices while their
// gain ramps to 0 (don't stop feeding a shifter mid-ramp — click). Once gain < 0.001,
// stop processing that voice and reset() its shifter.
// Inactive voices cost nothing: skip process entirely.
```

Headroom: with up to 5 voices summing, scale the wet sum by `1 / sqrt(1 + activeVoices)` (equal-power-ish) so adding voices doesn't clip; ramp this factor too.

## 3.5 Store/engine wiring

`harmonyPreset` → on change, engine subscription writes `P.harmonyVoices = HARMONY_PRESETS[preset].length` and `P.harmonyInterval0..3` (unused slots = 0). `harmonySpread` → `P.harmonySpread`.

## 3.6 UI — Harmony group in ControlsPanel

Five small toggle buttons: **Off · Duet · Triad · Choir · Octaves** (exclusive select, active = accent green), plus a **Spread** slider (0–1). Per §8 the default *pre-selected but off* state: `harmonyPreset` starts `'off'` but Triad renders as the "next" suggestion (subtle outline) — implementation: just make Triad the first non-off button; no extra logic needed beyond the default.

## 3.7 Visualizer — tadpoles

For each active harmony voice with `harmonyNote{i} >= 0`: a tadpole sprite at `yForMidi(harmonyNote{i})`, x slightly behind the toad (x = toadX − 24 − i·10), gentle sine wiggle (±2 px, per-voice phase offset). Fade in/out over ~120 ms with voice activity. Skip wiggle under `prefers-reduced-motion`.

## Acceptance checklist

- [ ] `tests/harmony.test.ts`: every table row + property tests pass.
- [ ] In C major with Triad: singing E then F yields (E,G,B) then (F,A,C) — **verify via telemetry**: log `harmonyNote0/1` + `stableNote` from the bus in a temporary console interval; remove the log after verifying.
- [ ] Duet/Choir/Octaves all sound correct; Octaves has no third (just ±12).
- [ ] Harmony voices fade in/out smoothly at voiced/unvoiced boundaries — no clicks or hard cuts (headphone check at high gain).
- [ ] Spread=0: all voices center/no detune (tight doubling). Spread=1: audible stereo width and chorus-like detune.
- [ ] 5 total voices sustain without glitches on the dev machine; worklet p95 ≤ 1.5 ms. If not achievable, document the measured p95 and add a `latencyHint: 'playback'` fallback path behind a store flag (per spec §Phase 3 acceptance).
- [ ] Tadpoles appear on the correct rows and track preset changes.
- [ ] `npm run test` and `npm run build` pass.

## Common mistakes to avoid

1. Treating interval steps as semitones — the whole feature is scale-steps. +2 in C major from E is +3 semitones, from F is +4.
2. Negative-step octave wrap: `Math.floor(-1 / 7) === -1` is what you want; do NOT use `Math.trunc` or `(a/b)|0`.
3. Recomputing per-voice detune/pan randomly per block — they're static per voice index (random per block = noise).
4. Hard-cutting a shifter's output when a voice deactivates — ramp the gain first, then stop feeding and `reset()`.
5. Forgetting the headroom scaling — 5 summed voices of the same phrase WILL clip the limiterless output.
