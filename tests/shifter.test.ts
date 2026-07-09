import { describe, expect, it } from 'vitest';
import { ShifterPool } from '../src/audio/dsp/shifterPool';

const SAMPLE_RATE = 48000; // Hz
const BLOCK = 128; // samples
const INPUT_FREQ = 220; // Hz
const BLOCKS = 400; // ~1.07 s of audio — enough to flush shifter latency

function runSine(
  shifter: {
    process(input: Float32Array, output: Float32Array): void;
    latencySamples: number;
  },
  blocks: number,
): Float32Array {
  const input = new Float32Array(BLOCK);
  const collected = new Float32Array(BLOCK * blocks);
  let phase = 0;
  for (let block = 0; block < blocks; block += 1) {
    for (let index = 0; index < BLOCK; index += 1) {
      input[index] = Math.sin(phase);
      phase += (2 * Math.PI * INPUT_FREQ) / SAMPLE_RATE;
    }
    const output = collected.subarray(block * BLOCK, (block + 1) * BLOCK);
    shifter.process(input, output);
  }
  return collected;
}

function rms(data: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < data.length; index += 1) {
    sum += data[index]! * data[index]!;
  }
  return Math.sqrt(sum / data.length);
}

/** Rough frequency estimate from rising zero crossings. */
function estimateFreq(data: Float32Array): number {
  let crossings = 0;
  for (let index = 1; index < data.length; index += 1) {
    if (data[index - 1]! < 0 && data[index]! >= 0) crossings += 1;
  }
  return crossings / (data.length / SAMPLE_RATE);
}

describe('ShifterPool (Signalsmith WASM adapter)', () => {
  it('loads the signalsmith engine with sane latency', async () => {
    const pool = await ShifterPool.create(1, SAMPLE_RATE, new ArrayBuffer(0));
    expect(pool.kind).toBe('signalsmith');
    expect(pool.latencySamples).toBeGreaterThan(0);
    expect(pool.latencySamples).toBeLessThan(SAMPLE_RATE * 0.1); // < 100 ms
  });

  it('passes audio through at unity transpose', async () => {
    const pool = await ShifterPool.create(1, SAMPLE_RATE, new ArrayBuffer(0));
    const shifter = pool.get(0);
    shifter.setTranspose(0);
    shifter.setFormant(0);
    shifter.setFormantBaseHz(INPUT_FREQ);
    const out = runSine(shifter, BLOCKS);
    const settled = out.subarray(out.length / 2);
    expect(rms(settled)).toBeGreaterThan(0.5); // sine rms is ~0.707
    expect(estimateFreq(settled)).toBeCloseTo(INPUT_FREQ, -1); // within ~5 Hz
  });

  it('transposes +12 semitones to roughly double the frequency', async () => {
    const pool = await ShifterPool.create(1, SAMPLE_RATE, new ArrayBuffer(0));
    const shifter = pool.get(0);
    shifter.setTranspose(12);
    shifter.setFormant(0);
    shifter.setFormantBaseHz(INPUT_FREQ);
    const out = runSine(shifter, BLOCKS);
    const settled = out.subarray(out.length / 2);
    expect(rms(settled)).toBeGreaterThan(0.05);
    const freq = estimateFreq(settled);
    expect(freq).toBeGreaterThan(INPUT_FREQ * 2 * 0.92);
    expect(freq).toBeLessThan(INPUT_FREQ * 2 * 1.08);
  });

  it('survives reset() and keeps processing', async () => {
    const pool = await ShifterPool.create(1, SAMPLE_RATE, new ArrayBuffer(0));
    const shifter = pool.get(0);
    shifter.setTranspose(3);
    runSine(shifter, 50);
    shifter.reset();
    const out = runSine(shifter, BLOCKS);
    expect(rms(out.subarray(out.length / 2))).toBeGreaterThan(0.05);
  });

  it('creates five independent voices', async () => {
    const pool = await ShifterPool.create(5, SAMPLE_RATE, new ArrayBuffer(0));
    expect(pool.kind).toBe('signalsmith');
    const outputs = [0, 1, 2, 3, 4].map((index) => {
      const shifter = pool.get(index);
      shifter.setTranspose(index * 3);
      return runSine(shifter, 200);
    });
    for (const out of outputs) {
      expect(rms(out.subarray(out.length / 2))).toBeGreaterThan(0.02);
    }
  });
});
