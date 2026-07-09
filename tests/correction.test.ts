import { describe, expect, it } from 'vitest';
import { CorrectionSmoother } from '../src/audio/dsp/correction';

const SAMPLE_RATE_HZ = 48_000;
const BLOCK_SAMPLES = 128;
const BLOCK_MS = (BLOCK_SAMPLES / SAMPLE_RATE_HZ) * 1000;

describe('CorrectionSmoother', () => {
  it('hard-snaps immediately at zero retune time', () => {
    const correction = new CorrectionSmoother(SAMPLE_RATE_HZ);
    const result = correction.process(60.3, 60, 1, 0, true);
    expect(result.appliedTarget).toBe(60);
    expect(result.correctionSemitones).toBeCloseTo(-0.3, 9);
  });

  it('covers about 63% of a target change after one time constant', () => {
    const correction = new CorrectionSmoother(SAMPLE_RATE_HZ);
    correction.process(60, 60, 1, 200, true);
    const blockCount = Math.round(200 / BLOCK_MS);
    let result = correction.process(60, 72, 1, 200, true);
    for (let block = 1; block < blockCount; block += 1) {
      result = correction.process(60, 72, 1, 200, true);
    }
    const covered = (result.appliedTarget - 60) / 12;
    expect(covered).toBeGreaterThan(0.58);
    expect(covered).toBeLessThan(0.68);
  });

  it('produces no correction when correction amount is zero', () => {
    const correction = new CorrectionSmoother(SAMPLE_RATE_HZ);
    const result = correction.process(63.4, 60, 0, 0, true);
    expect(result.correctionSemitones).toBe(0);
  });

  it('freezes while unvoiced and resets cleanly on re-entry', () => {
    const correction = new CorrectionSmoother(SAMPLE_RATE_HZ);
    correction.process(60, 60, 1, 200, true);
    const moving = correction.process(60, 67, 1, 200, true);
    const silent = correction.process(0, 0, 1, 200, false);
    expect(silent.appliedTarget).toBe(moving.appliedTarget);

    const returned = correction.process(72.2, 72, 1, 200, true);
    expect(returned.appliedTarget).toBe(72);
  });

  it('continues a glide when the target changes mid-sustain', () => {
    const correction = new CorrectionSmoother(SAMPLE_RATE_HZ);
    correction.process(60, 60, 1, 200, true);
    const beforeChange = correction.process(60, 67, 1, 200, true);
    const afterChange = correction.process(60, 64, 1, 200, true);
    expect(afterChange.appliedTarget).toBeGreaterThan(beforeChange.appliedTarget);
    expect(afterChange.appliedTarget).toBeLessThan(64);
  });
});
