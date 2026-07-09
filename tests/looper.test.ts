import { describe, expect, it } from 'vitest';
import {
  loopLengthSamples,
  nextBoundarySamples,
  rotateLeft,
} from '../src/audio/looper/looper';

describe('looper timing math', () => {
  it('computes loop length at 90 BPM, 2 bars, 48 kHz', () => {
    expect(loopLengthSamples({ bpm: 90, bars: 2, sampleRate: 48_000 }))
      .toBe(Math.round(2 * 4 * (60 / 90) * 48_000));
  });

  it('computes loop length at 120 BPM, 4 bars, 44.1 kHz', () => {
    expect(loopLengthSamples({ bpm: 120, bars: 4, sampleRate: 44_100 }))
      .toBe(352_800);
  });

  it('returns the epoch before or on the first boundary', () => {
    expect(nextBoundarySamples(0, 1000, 500)).toBe(1000);
    expect(nextBoundarySamples(1000, 1000, 500)).toBe(1000);
  });

  it('returns the next boundary after the epoch', () => {
    expect(nextBoundarySamples(1001, 1000, 500)).toBe(1500);
    expect(nextBoundarySamples(2499, 1000, 500)).toBe(2500);
  });
});

describe('looper latency compensation rotation', () => {
  it('rotates left by an offset', () => {
    expect(Array.from(rotateLeft(new Float32Array([0, 1, 2, 3, 4]), 2)))
      .toEqual([2, 3, 4, 0, 1]);
  });

  it('leaves zero and full-length rotations unchanged', () => {
    expect(Array.from(rotateLeft(new Float32Array([0, 1, 2, 3, 4]), 0)))
      .toEqual([0, 1, 2, 3, 4]);
    expect(Array.from(rotateLeft(new Float32Array([0, 1, 2, 3, 4]), 5)))
      .toEqual([0, 1, 2, 3, 4]);
  });
});
