import { describe, expect, it } from 'vitest';
import { P } from '../src/audio/paramsBus';
import { SmoothingPipeline } from '../src/audio/dsp/pitchTracker';

const SAMPLE_RATE_HZ = 48_000;
const CLEAR = 0.95;

describe('SmoothingPipeline', () => {
  it('converges quickly on a steady tone', () => {
    const pipeline = new SmoothingPipeline(SAMPLE_RATE_HZ);
    let result = pipeline.push(60, CLEAR);

    for (let frame = 1; frame < 200; frame += 1) {
      result = pipeline.push(60, CLEAR);
      if (frame >= 20) {
        expect(result.smoothedMidi).toBeCloseTo(60, 1);
      }
      expect(result.stableNote).toBe(60);
    }
  });

  it('rejects a low-clarity one-frame octave glitch', () => {
    const pipeline = new SmoothingPipeline(SAMPLE_RATE_HZ);
    for (let frame = 0; frame < 30; frame += 1) {
      pipeline.push(60, CLEAR);
    }

    const glitch = pipeline.push(72, 0.92);
    expect(glitch.smoothedMidi).toBeLessThanOrEqual(60.5);
    expect(glitch.stableNote).toBe(60);

    for (let frame = 0; frame < 30; frame += 1) {
      const result = pipeline.push(60, CLEAR);
      expect(result.smoothedMidi).toBeLessThanOrEqual(60.5);
      expect(result.stableNote).toBe(60);
    }
  });

  it('accepts a legitimate high-clarity jump', () => {
    const pipeline = new SmoothingPipeline(SAMPLE_RATE_HZ);
    for (let frame = 0; frame < 100; frame += 1) {
      pipeline.push(60, CLEAR);
    }

    let frameChanged = -1;
    for (let frame = 0; frame < 100; frame += 1) {
      const result = pipeline.push(67, 0.98);
      if (result.stableNote === 67 && frameChanged < 0) {
        frameChanged = frame;
      }
    }
    expect(frameChanged).toBeGreaterThanOrEqual(0);
    expect(frameChanged).toBeLessThan(15);
  });

  it('does not flicker while hovering around a note boundary', () => {
    const pipeline = new SmoothingPipeline(SAMPLE_RATE_HZ);
    pipeline.push(60, CLEAR);
    let previous = 60;
    let changes = 0;

    for (let frame = 0; frame < 200; frame += 1) {
      const midi = frame % 2 === 0 ? 60.45 : 60.55;
      const result = pipeline.push(midi, CLEAR);
      if (result.stableNote !== previous) {
        changes += 1;
        previous = result.stableNote ?? previous;
      }
    }
    expect(changes).toBeLessThanOrEqual(1);
  });

  it('clears identity after silence and resets when voice returns', () => {
    const pipeline = new SmoothingPipeline(SAMPLE_RATE_HZ);
    for (let frame = 0; frame < 30; frame += 1) {
      pipeline.push(60, CLEAR);
    }

    let result = pipeline.push(Number.NaN, 0);
    expect(result.voiced).toBe(false);
    for (let frame = 0; frame < 6; frame += 1) {
      result = pipeline.push(Number.NaN, 0);
    }
    expect(result.stableNote).toBeNull();

    result = pipeline.push(67, CLEAR);
    expect(result.voiced).toBe(true);
    expect(result.smoothedMidi).toBeCloseTo(67, 1);
  });
});

describe('ParamsBus layout', () => {
  it('has unique indices and enough reserved capacity', () => {
    const indices = Object.entries(P)
      .filter(([name]) => name !== 'LENGTH')
      .map(([, value]) => value);
    expect(new Set(indices).size).toBe(indices.length);
    expect(P.LENGTH).toBeGreaterThanOrEqual(28);
  });
});
