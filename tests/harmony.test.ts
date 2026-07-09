import { describe, expect, it } from 'vitest';
import {
  HARMONY_PRESETS,
  resolveInterval,
} from '../src/audio/theory/harmony';
import { SCALE_INTERVALS } from '../src/audio/theory/scales';
import type { KeyConfig, ScaleName } from '../src/types';

const cMajor: KeyConfig = { tonicPc: 0, scale: 'major' };
const aMinor: KeyConfig = { tonicPc: 9, scale: 'naturalMinor' };
const cMinorPentatonic: KeyConfig = {
  tonicPc: 0,
  scale: 'minorPentatonic',
};

describe('resolveInterval', () => {
  it.each([
    [64, 2, 3],
    [65, 2, 4],
    [60, 2, 4],
    [59, 2, 3],
    [60, 4, 7],
    [60, 7, 12],
    [60, -7, -12],
    [60, -2, -3],
    [64, -1, -2],
    [60, 9, 16],
    [60, -9, -15],
    [61, 2, 4],
  ])(
    'resolves C major note %i by %i steps to %i semitones',
    (note, steps, expected) => {
      expect(resolveInterval(note, cMajor, steps)).toBe(expected);
    },
  );

  it.each([
    [57, 2, 3],
    [59, 2, 3],
    [60, 4, 7],
  ])(
    'resolves A natural minor note %i by %i steps',
    (note, steps, expected) => {
      expect(resolveInterval(note, aMinor, steps)).toBe(expected);
    },
  );

  it('handles pentatonic scale-length octave wrapping', () => {
    expect(resolveInterval(60, cMinorPentatonic, 5)).toBe(12);
    expect(resolveInterval(60, cMinorPentatonic, 2)).toBe(5);
  });

  it('maps chromatic scale steps directly to semitones', () => {
    const chromatic: KeyConfig = { tonicPc: 0, scale: 'chromatic' };
    for (let note = 48; note <= 72; note += 1) {
      for (let steps = -12; steps <= 12; steps += 1) {
        expect(resolveInterval(note, chromatic, steps)).toBe(steps);
      }
    }
  });

  it('wraps every full scale length by exactly one octave', () => {
    for (const [scale, intervals] of Object.entries(SCALE_INTERVALS)) {
      const key: KeyConfig = { tonicPc: 0, scale: scale as ScaleName };
      for (let note = 48; note <= 72; note += 1) {
        if (!intervals.includes(((note % 12) + 12) % 12)) {
          continue;
        }
        expect(resolveInterval(note, key, intervals.length)).toBe(12);
        expect(resolveInterval(note, key, -intervals.length)).toBe(-12);
        expect(resolveInterval(note, key, 0)).toBe(0);
      }
    }
  });

  it('provides the specified preset interval ordering', () => {
    expect(HARMONY_PRESETS.off).toEqual([]);
    expect(HARMONY_PRESETS.duet).toEqual([2]);
    expect(HARMONY_PRESETS.triad).toEqual([2, 4]);
    expect(HARMONY_PRESETS.choir).toEqual([2, 4, -7]);
    expect(HARMONY_PRESETS.octaves).toEqual([7, -7]);
  });
});
