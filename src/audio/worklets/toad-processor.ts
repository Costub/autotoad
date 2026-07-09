import { CorrectionSmoother } from '../dsp/correction';
import { EnvelopeFollower } from '../dsp/envelope';
import { PitchTracker } from '../dsp/pitchTracker';
import { ShifterPool, type Shifter } from '../dsp/shifterPool';
import { P, type ParamIndex } from '../paramsBus';
import { midiToFreq, snapToScale } from '../theory/scales';
import { SCALE_ORDER, type KeyConfig } from '../../types';

declare const sampleRate: number;
declare function registerProcessor(
  name: string,
  processorCtor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

const TELEMETRY_MESSAGE_BLOCKS = 4; // render blocks
const PERF_WINDOW_BLOCKS = 256; // render blocks
const PERF_PERCENTILE_INDEX = Math.floor((PERF_WINDOW_BLOCKS - 1) * 0.95);
const MICROSECONDS_PER_MILLISECOND = 1000;
const SHIFTER_POOL_SIZE = 5; // lead + four future harmony voices
const UNVOICED_RAMP_MS = 10; // ms
const GAIN_RAMP_TAU_MS = 5; // ms
const MIN_RAMP_SAMPLES = 64; // samples
const LONG_UNVOICED_MS = 250; // ms
const DEFAULT_BLOCK_SAMPLES = 128; // samples

interface ParamsMessage {
  type: 'params';
  data: Float64Array;
}

function isParamsMessage(value: unknown): value is ParamsMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const message = value as Partial<ParamsMessage>;
  return message.type === 'params' && message.data instanceof Float64Array;
}

function readSharedBuffer(options: AudioWorkletNodeOptions): SharedArrayBuffer | null {
  const processorOptions = options.processorOptions;
  if (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof processorOptions === 'object' &&
    processorOptions !== null &&
    'sab' in processorOptions &&
    processorOptions.sab instanceof SharedArrayBuffer
  ) {
    return processorOptions.sab;
  }
  return null;
}

class WorkletBusView {
  private readonly values: Float64Array;
  private readonly shared: boolean;
  private blocksSinceTelemetry = 0;

  constructor(
    private readonly port: MessagePort,
    sharedBuffer: SharedArrayBuffer | null,
  ) {
    this.shared = sharedBuffer !== null;
    this.values = sharedBuffer
      ? new Float64Array(sharedBuffer)
      : new Float64Array(P.LENGTH);

    if (!this.shared) {
      port.addEventListener('message', this.handleMessage);
      port.start();
    }
  }

  get(index: ParamIndex): number {
    return this.values[index] ?? 0;
  }

  set(index: ParamIndex, value: number): void {
    this.values[index] = value;
  }

  flushTelemetryIfNeeded(): void {
    if (this.shared) {
      return;
    }

    this.blocksSinceTelemetry += 1;
    if (this.blocksSinceTelemetry < TELEMETRY_MESSAGE_BLOCKS) {
      return;
    }

    this.blocksSinceTelemetry = 0;
    this.port.postMessage({
      type: 'telemetry',
      data: this.values.slice(),
    });
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (!isParamsMessage(event.data)) {
      return;
    }

    const source = event.data.data;
    const end = Math.min(P.detectedFreq, source.length);
    for (let index = 0; index < end; index += 1) {
      this.values[index] = source[index] ?? 0;
    }
  };
}

class ToadProcessor extends AudioWorkletProcessor {
  private readonly bus: WorkletBusView;
  private readonly tracker = new PitchTracker(sampleRate);
  private readonly envelope = new EnvelopeFollower(sampleRate);
  private readonly correction = new CorrectionSmoother(sampleRate);
  private readonly perfDurations = new Float64Array(PERF_WINDOW_BLOCKS);
  private readonly perfScratch = new Float64Array(PERF_WINDOW_BLOCKS);
  private readonly wetBlock = new Float32Array(DEFAULT_BLOCK_SAMPLES);
  private readonly dryBlock = new Float32Array(DEFAULT_BLOCK_SAMPLES);
  private readonly key: KeyConfig = { tonicPc: 0, scale: 'major' };
  private pool: ShifterPool | null = null;
  private leadShifter: Shifter | null = null;
  private dryDelay: Float32Array | null = null;
  private dryWriteIndex = 0;
  private dryGain = 0;
  private wetGain = 0;
  private unvoicedBlocks = 0;
  private shifterResetForSilence = false;
  private perfIndex = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    this.bus = new WorkletBusView(this.port, readSharedBuffer(options));
    this.port.postMessage({ type: 'ready' });
    void this.initializeShifters();
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const canMeasure = typeof performance !== 'undefined';
    const startedAt = canMeasure ? performance.now() : 0;
    const input = inputs[0]?.[0];
    const output = outputs[0];

    if (input && input.length > 0) {
      const { rms } = this.envelope.processBlock(input);
      const analysis = this.tracker.analyze(input, rms);
      const voiced = analysis.voiced;
      this.bus.set(P.detectedFreq, analysis.freq);
      this.bus.set(P.detectedClarity, analysis.clarity);
      this.bus.set(P.rmsLevel, rms);
      this.bus.set(P.stableNote, analysis.stableNote ?? -1);
      this.bus.set(P.smoothedMidi, analysis.smoothedMidi);

      if (
        this.pool &&
        this.leadShifter &&
        this.dryDelay &&
        input.length === DEFAULT_BLOCK_SAMPLES
      ) {
        this.processCorrection(input, output, analysis.smoothedMidi, voiced);
      } else {
        silenceOutput(output);
        this.bus.set(P.correctedFreq, 0);
      }
    } else {
      silenceOutput(output);
    }

    if (canMeasure) {
      this.recordPerformance(performance.now() - startedAt);
    }
    this.bus.flushTelemetryIfNeeded();
    return true;
  }

  private async initializeShifters(): Promise<void> {
    this.pool = await ShifterPool.create(
      SHIFTER_POOL_SIZE,
      sampleRate,
      new ArrayBuffer(0),
    );
    this.leadShifter = this.pool.get(0);
    this.dryDelay = new Float32Array(
      this.pool.latencySamples + DEFAULT_BLOCK_SAMPLES * 2,
    );
    this.bus.set(P.shifterLatencySamps, this.pool.latencySamples);
    this.port.postMessage({
      type: 'shifters-ready',
      latencySamples: this.pool.latencySamples,
    });
  }

  private processCorrection(
    input: Float32Array,
    output: Float32Array[] | undefined,
    smoothedMidi: number,
    voiced: boolean,
  ): void {
    const shifter = this.leadShifter!;
    const pool = this.pool!;
    const scaleIndex = Math.max(
      0,
      Math.min(SCALE_ORDER.length - 1, Math.round(this.bus.get(P.scaleId))),
    );
    this.key.tonicPc = Math.max(
      0,
      Math.min(11, Math.round(this.bus.get(P.keyTonic))),
    );
    this.key.scale = SCALE_ORDER[scaleIndex] ?? 'major';

    const snappedTarget = voiced
      ? snapToScale(smoothedMidi, this.key)
      : smoothedMidi;
    const correctionFrame = this.correction.process(
      smoothedMidi,
      snappedTarget,
      this.bus.get(P.correctionAmount),
      this.bus.get(P.retuneMs),
      voiced,
    );
    const leadShift =
      this.bus.get(P.pitchShift) + correctionFrame.correctionSemitones;
    shifter.setTranspose(leadShift);
    shifter.setFormant(this.bus.get(P.formantShift));
    shifter.process(input, this.wetBlock);
    this.processDryDelay(input, this.dryBlock, pool.latencySamples);

    if (voiced) {
      this.unvoicedBlocks = 0;
      this.shifterResetForSilence = false;
    } else {
      this.unvoicedBlocks += 1;
      const unvoicedMs =
        (this.unvoicedBlocks * DEFAULT_BLOCK_SAMPLES * 1000) / sampleRate;
      if (
        unvoicedMs >= LONG_UNVOICED_MS &&
        !this.shifterResetForSilence
      ) {
        shifter.reset();
        this.shifterResetForSilence = true;
      }
    }

    const bypass = this.bus.get(P.bypass) >= 0.5;
    const targetDry = bypass ? 1 : this.bus.get(P.dryLevel);
    const targetWet = bypass ? 0 : voiced ? this.bus.get(P.wetLevel) : 0;
    const dryAlpha = gainAlpha(GAIN_RAMP_TAU_MS);
    const wetTauMs =
      targetWet < this.wetGain ? UNVOICED_RAMP_MS : GAIN_RAMP_TAU_MS;
    const wetAlpha = gainAlpha(wetTauMs);
    const channelCount = output?.length ?? 0;

    for (let index = 0; index < input.length; index += 1) {
      this.dryGain += (targetDry - this.dryGain) * dryAlpha;
      this.wetGain += (targetWet - this.wetGain) * wetAlpha;
      const mixed =
        this.dryBlock[index]! * this.dryGain +
        this.wetBlock[index]! * this.wetGain;
      for (let channel = 0; channel < channelCount; channel += 1) {
        output![channel]![index] = mixed;
      }
    }

    this.bus.set(
      P.correctedFreq,
      voiced ? midiToFreq(correctionFrame.appliedTarget) : 0,
    );
  }

  private processDryDelay(
    input: Float32Array,
    output: Float32Array,
    latencySamples: number,
  ): void {
    const delay = this.dryDelay!;
    for (let index = 0; index < input.length; index += 1) {
      delay[this.dryWriteIndex] = input[index]!;
      const readIndex =
        (this.dryWriteIndex - latencySamples + delay.length) % delay.length;
      output[index] = delay[readIndex]!;
      this.dryWriteIndex = (this.dryWriteIndex + 1) % delay.length;
    }
  }

  private recordPerformance(durationMs: number): void {
    this.perfDurations[this.perfIndex] = durationMs;
    this.perfIndex += 1;
    if (this.perfIndex < PERF_WINDOW_BLOCKS) {
      return;
    }

    this.perfIndex = 0;
    this.perfScratch.set(this.perfDurations);
    this.perfScratch.sort();
    this.bus.set(
      P.workletP95Us,
      this.perfScratch[PERF_PERCENTILE_INDEX]! * MICROSECONDS_PER_MILLISECOND,
    );
  }
}

function gainAlpha(tauMs: number): number {
  const effectiveTauSamples = Math.max(
    MIN_RAMP_SAMPLES,
    (tauMs / 1000) * sampleRate,
  );
  return 1 - Math.exp(-1 / effectiveTauSamples);
}

function silenceOutput(output: Float32Array[] | undefined): void {
  if (!output) {
    return;
  }
  for (let channel = 0; channel < output.length; channel += 1) {
    output[channel]!.fill(0);
  }
}

registerProcessor('toad-processor', ToadProcessor);
