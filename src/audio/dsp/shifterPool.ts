// FALLBACK: granular shifter — no independent formant preservation.

/** One pitch-shifter voice. All setters take semitones. */
export interface Shifter {
  process(input: Float32Array, output: Float32Array): void;
  setTranspose(semitones: number): void;
  setFormant(semitones: number): void;
  readonly latencySamples: number;
  reset(): void;
}

const GRAIN_SAMPLES = 1024; // samples
const BASE_DELAY_SAMPLES = 128; // samples
const RING_SAMPLES = 8192; // samples, power of two
const RING_MASK = RING_SAMPLES - 1;
const TWO_PI = Math.PI * 2;
const UNITY_RATIO_EPSILON = 0.0001;

let formantWarningShown = false;

class GranularShifter implements Shifter {
  readonly latencySamples =
    BASE_DELAY_SAMPLES + Math.floor(GRAIN_SAMPLES / 2);
  private readonly ring = new Float32Array(RING_SAMPLES);
  private writeIndex = 0;
  private grainPhase = 0.25;
  private transposeRatio = 1;

  process(input: Float32Array, output: Float32Array): void {
    for (let index = 0; index < input.length; index += 1) {
      this.ring[this.writeIndex] = input[index]!;

      if (Math.abs(this.transposeRatio - 1) < UNITY_RATIO_EPSILON) {
        output[index] = this.readDelayed(this.latencySamples);
      } else {
        const secondPhase = (this.grainPhase + 0.5) % 1;
        const firstWindow = 0.5 - 0.5 * Math.cos(TWO_PI * this.grainPhase);
        const secondWindow = 1 - firstWindow;
        const firstDelay =
          BASE_DELAY_SAMPLES + this.grainPhase * GRAIN_SAMPLES;
        const secondDelay =
          BASE_DELAY_SAMPLES + secondPhase * GRAIN_SAMPLES;
        output[index] =
          this.readDelayed(firstDelay) * firstWindow +
          this.readDelayed(secondDelay) * secondWindow;

        this.grainPhase += (1 - this.transposeRatio) / GRAIN_SAMPLES;
        if (this.grainPhase < 0) {
          this.grainPhase += 1;
        } else if (this.grainPhase >= 1) {
          this.grainPhase -= 1;
        }
      }

      this.writeIndex = (this.writeIndex + 1) & RING_MASK;
    }
  }

  setTranspose(semitones: number): void {
    this.transposeRatio = Math.pow(2, semitones / 12);
  }

  setFormant(semitones: number): void {
    if (semitones !== 0 && !formantWarningShown) {
      formantWarningShown = true;
      console.warn(
        'AUTOTOAD: granular shifter fallback does not preserve or shift formants.',
      );
    }
  }

  reset(): void {
    this.ring.fill(0);
    this.writeIndex = 0;
    this.grainPhase = 0.25;
  }

  private readDelayed(delaySamples: number): number {
    let readPosition = this.writeIndex - delaySamples;
    while (readPosition < 0) {
      readPosition += RING_SAMPLES;
    }
    const lowerIndex = Math.floor(readPosition) & RING_MASK;
    const upperIndex = (lowerIndex + 1) & RING_MASK;
    const fraction = readPosition - Math.floor(readPosition);
    const lower = this.ring[lowerIndex]!;
    return lower + (this.ring[upperIndex]! - lower) * fraction;
  }
}

export class ShifterPool {
  private constructor(private readonly shifters: Shifter[]) {}

  static async create(
    size: number,
    _sampleRate: number,
    _wasmBytes: ArrayBuffer,
  ): Promise<ShifterPool> {
    const shifters: Shifter[] = [];
    for (let index = 0; index < size; index += 1) {
      shifters.push(new GranularShifter());
    }
    return new ShifterPool(shifters);
  }

  get(index: number): Shifter {
    const shifter = this.shifters[index];
    if (!shifter) {
      throw new RangeError(`Shifter voice ${index} is outside the pool.`);
    }
    return shifter;
  }

  get latencySamples(): number {
    return this.shifters[0]?.latencySamples ?? 0;
  }
}
