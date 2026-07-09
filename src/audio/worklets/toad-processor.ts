import { EnvelopeFollower } from '../dsp/envelope';
import { PitchTracker } from '../dsp/pitchTracker';
import { P, type ParamIndex } from '../paramsBus';

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
  private readonly perfDurations = new Float64Array(PERF_WINDOW_BLOCKS);
  private readonly perfScratch = new Float64Array(PERF_WINDOW_BLOCKS);
  private perfIndex = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    this.bus = new WorkletBusView(this.port, readSharedBuffer(options));
    this.port.postMessage({ type: 'ready' });
  }

  process(inputs: Float32Array[][], _outputs: Float32Array[][]): boolean {
    const canMeasure = typeof performance !== 'undefined';
    const startedAt = canMeasure ? performance.now() : 0;
    const input = inputs[0]?.[0];

    if (input && input.length > 0) {
      const { rms } = this.envelope.processBlock(input);
      const analysis = this.tracker.analyze(input, rms);
      this.bus.set(P.detectedFreq, analysis.freq);
      this.bus.set(P.detectedClarity, analysis.clarity);
      this.bus.set(P.correctedFreq, 0);
      this.bus.set(P.rmsLevel, rms);
      this.bus.set(P.stableNote, analysis.stableNote ?? -1);
      this.bus.set(P.smoothedMidi, analysis.smoothedMidi);
    }

    if (canMeasure) {
      this.recordPerformance(performance.now() - startedAt);
    }
    this.bus.flushTelemetryIfNeeded();
    return true;
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

registerProcessor('toad-processor', ToadProcessor);
