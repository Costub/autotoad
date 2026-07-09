// Formant-preserving pitch shifting via the vendored Signalsmith Stretch WASM
// core (src/audio/wasm/signalsmithCore.js). The hand-rolled granular shifter is
// retained as a runtime fallback if WASM initialization fails; it cannot
// preserve or shift formants.

import SignalsmithCore, {
  type SignalsmithWasmModule,
} from '../wasm/signalsmithCore.js';

/** One pitch-shifter voice. All setters take semitones. */
export interface Shifter {
  process(input: Float32Array, output: Float32Array): void;
  setTranspose(semitones: number): void;
  setFormant(semitones: number): void;
  /** Detected fundamental in Hz for formant analysis; 0 = auto-detect. */
  setFormantBaseHz(hz: number): void;
  readonly latencySamples: number;
  reset(): void;
}

export type ShifterKind = 'signalsmith' | 'granular';

// --- Signalsmith Stretch adapter --------------------------------------------

const STRETCH_BLOCK_SECONDS = 1024 / 48000; // s — STFT block (~21.3 ms; 1024 samples at 48 kHz)
const STRETCH_INTERVAL_DIVISOR = 4; // interval = block/4 (hop size)
const TONALITY_LIMIT_HZ = 8000; // Hz — Signalsmith's recommended vocal tonality limit
const SPLIT_COMPUTATION = 1; // spread FFT work across render blocks (live use)
const MIN_IO_BUFFER_SAMPLES = 256; // samples — floor for the WASM I/O buffer length

class SignalsmithShifter implements Shifter {
  readonly latencySamples: number;
  private readonly tonalityLimitNormalized: number;
  private readonly sampleRate: number;
  private readonly bufferLength: number;
  private inputPointer: number;
  private outputPointer: number;
  private transposeSemitones = 0;
  private formantSemitones = 0;
  private formantBaseNormalized = 0; // fraction of sample rate; 0 = auto-detect

  constructor(
    private readonly wasm: SignalsmithWasmModule,
    sampleRate: number,
  ) {
    this.sampleRate = sampleRate;
    this.tonalityLimitNormalized = TONALITY_LIMIT_HZ / sampleRate;
    wasm._main();
    const blockSamples = Math.round(STRETCH_BLOCK_SECONDS * sampleRate);
    const intervalSamples = Math.round(blockSamples / STRETCH_INTERVAL_DIVISOR);
    wasm._configure(1, blockSamples, intervalSamples, SPLIT_COMPUTATION);
    wasm._reset();
    this.latencySamples = wasm._inputLatency() + wasm._outputLatency();
    this.bufferLength = Math.max(this.latencySamples, MIN_IO_BUFFER_SAMPLES);
    const basePointer = wasm._setBuffers(1, this.bufferLength);
    this.inputPointer = basePointer;
    this.outputPointer = basePointer + this.bufferLength * 4;
  }

  process(input: Float32Array, output: Float32Array): void {
    const wasm = this.wasm;
    wasm._setTransposeSemitones(
      this.transposeSemitones,
      this.tonalityLimitNormalized,
    );
    // compensatePitch=1 keeps the original spectral envelope (formant
    // preservation) and applies formantSemitones as an independent shift.
    wasm._setFormantSemitones(this.formantSemitones, 1);
    wasm._setFormantBase(this.formantBaseNormalized);

    // Re-view the heap on every access: WASM memory may grow and detach views.
    const inputView = new Float32Array(
      this.heapBuffer(),
      this.inputPointer,
      input.length,
    );
    inputView.set(input);
    wasm._process(input.length, output.length);
    const outputView = new Float32Array(
      this.heapBuffer(),
      this.outputPointer,
      output.length,
    );
    output.set(outputView);
  }

  setTranspose(semitones: number): void {
    this.transposeSemitones = semitones;
  }

  setFormant(semitones: number): void {
    this.formantSemitones = semitones;
  }

  setFormantBaseHz(hz: number): void {
    this.formantBaseNormalized = hz > 0 ? hz / this.sampleRate : 0;
  }

  reset(): void {
    // _reset clears processing state but leaves the configuration and the
    // _setBuffers allocation intact (verified by the shifter smoke test).
    this.wasm._reset();
  }

  private heapBuffer(): ArrayBuffer {
    return this.wasm.exports
      ? (this.wasm.exports.memory.buffer as ArrayBuffer)
      : (this.wasm.HEAP8.buffer as ArrayBuffer);
  }
}

// --- Granular fallback (no formant preservation) -----------------------------

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
  private readonly grainWindow = new Float32Array(GRAIN_SAMPLES);
  private writeIndex = 0;
  private grainPhase = 0.25;
  private transposeRatio = 1;

  constructor() {
    for (let index = 0; index < GRAIN_SAMPLES; index += 1) {
      this.grainWindow[index] =
        0.5 - 0.5 * Math.cos((TWO_PI * index) / GRAIN_SAMPLES);
    }
  }

  process(input: Float32Array, output: Float32Array): void {
    for (let index = 0; index < input.length; index += 1) {
      this.ring[this.writeIndex] = input[index]!;

      if (Math.abs(this.transposeRatio - 1) < UNITY_RATIO_EPSILON) {
        output[index] = this.readDelayed(this.latencySamples);
      } else {
        const secondPhase = (this.grainPhase + 0.5) % 1;
        const windowIndex =
          Math.floor(this.grainPhase * GRAIN_SAMPLES) % GRAIN_SAMPLES;
        const firstWindow = this.grainWindow[windowIndex]!;
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
      if (typeof console !== 'undefined') {
        console.warn(
          'AUTOTOAD: granular shifter fallback does not preserve or shift formants.',
        );
      }
    }
  }

  setFormantBaseHz(_hz: number): void {
    // Granular shifting has no formant analysis; nothing to do.
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

// --- Pool --------------------------------------------------------------------

export class ShifterPool {
  private constructor(
    private readonly shifters: Shifter[],
    readonly kind: ShifterKind,
  ) {}

  static async create(
    size: number,
    sampleRate: number,
    _wasmBytes: ArrayBuffer,
  ): Promise<ShifterPool> {
    try {
      const shifters: Shifter[] = [];
      for (let index = 0; index < size; index += 1) {
        // One WASM module instance per voice: the stretch engine is a single
        // global object per module, and instances must never be shared.
        const wasm = await SignalsmithCore();
        shifters.push(new SignalsmithShifter(wasm, sampleRate));
      }
      return new ShifterPool(shifters, 'signalsmith');
    } catch (cause) {
      // FALLBACK: granular — no formant preservation.
      if (typeof console !== 'undefined') {
        console.warn(
          'AUTOTOAD: Signalsmith WASM init failed; using granular fallback.',
          cause,
        );
      }
      const shifters: Shifter[] = [];
      for (let index = 0; index < size; index += 1) {
        shifters.push(new GranularShifter());
      }
      return new ShifterPool(shifters, 'granular');
    }
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
