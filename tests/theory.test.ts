import { describe, expect, it } from 'vitest';
import {
  degreeOf,
  freqToMidiFloat,
  midiToFreq,
  snapToScale,
} from '../src/audio/theory/scales';
import type { KeyConfig } from '../src/types';

const cMajor: KeyConfig = { tonicPc: 0, scale: 'major' };
const aNaturalMinor: KeyConfig = { tonicPc: 9, scale: 'naturalMinor' };
const chromatic: KeyConfig = { tonicPc: 0, scale: 'chromatic' };

describe('frequency and MIDI conversion', () => {
  it('maps concert A exactly in both directions', () => {
    expect(freqToMidiFloat(440)).toBe(69);
    expect(midiToFreq(69)).toBe(440);
  });

  it('round-trips the practical vocal MIDI range', () => {
    for (let midi = 36; midi <= 84; midi += 1) {
      expect(freqToMidiFloat(midiToFreq(midi))).toBeCloseTo(midi, 9);
    }
  });
});

describe('snapToScale', () => {
  it('snaps to C major and breaks ties upward', () => {
    expect(snapToScale(60, cMajor)).toBe(60);
    expect(snapToScale(61, cMajor)).toBe(62);
    expect(snapToScale(63, cMajor)).toBe(64);
    expect(snapToScale(60.4, cMajor)).toBe(60);
    expect(snapToScale(61.6, cMajor)).toBe(62);
  });

  it('snaps to A natural minor across pitch classes', () => {
    expect(snapToScale(68, aNaturalMinor)).toBe(69);
    expect(snapToScale(61, aNaturalMinor)).toBe(62);
    expect(snapToScale(62, aNaturalMinor)).toBe(62);
  });

  it('keeps every chromatic MIDI note unchanged', () => {
    for (let midi = 0; midi < 128; midi += 1) {
      expect(snapToScale(midi, chromatic)).toBe(midi);
    }
  });

  it('uses the cached lookup path for repeated calls', () => {
    const start = performance.now();
    for (let iteration = 0; iteration < 10_000; iteration += 1) {
      snapToScale(61.4, cMajor);
    }
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('degreeOf', () => {
  it('returns scale degrees and rejects notes outside the scale', () => {
    expect(degreeOf(60, cMajor)).toBe(0);
    expect(degreeOf(64, cMajor)).toBe(2);
    expect(degreeOf(67, cMajor)).toBe(4);
    expect(degreeOf(61, cMajor)).toBe(-1);
    expect(degreeOf(72, cMajor)).toBe(0);
  });
});
