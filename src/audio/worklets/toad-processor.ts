import { CorrectionSmoother } from '../dsp/correction';
import { EnvelopeFollower } from '../dsp/envelope';
import { PitchTracker } from '../dsp/pitchTracker';
import { ShifterPool, type Shifter } from '../dsp/shifterPool';
import { P, type ParamIndex } from '../paramsBus';
import { resolveInterval } from '../theory/harmony';
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
const HARMONY_VOICE_COUNT = 4;
const MAX_DETUNE_CENTS = 12; // cents at maximum spread
const DETUNE_SIGN = [1, -1, 0.5, -0.5] as const;
const PAN_POSITION = [-0.6, 0.6, -0.3, 0.3] as const;
const HARMONY_GAIN_SILENCE = 0.001;
const HALF_PI = Math.PI / 2;
const HARMONY_INTERVAL_PARAMS = [
  P.harmonyInterval0,
  P.harmonyInterval1,
  P.harmonyInterval2,
  P.harmonyInterval3,
] as const;
const HARMONY_NOTE_PARAMS = [
  P.harmonyNote0,
  P.harmonyNote1,
  P.harmonyNote2,
  P.harmonyNote3,
] as const;

interface ParamsMessage {
  type: 'params';
  data: Float64Array;
}

interface RecordArmMessage {
  type: 'record-arm';
  startFrame: number;
  lengthSamples: number;
  recordingId: number;
}

interface RecordCancelMessage {
  type: 'record-cancel';
}

interface RecordingState {
  recordingId: number;
  startFrame: number;
  lengthSamples: number;
  buffer: Float32Array;
  actualStartFrame: number;
}

function isParamsMessage(value: unknown): value is ParamsMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const message = value as Partial<ParamsMessage>;
  return message.type === 'params' && message.data instanceof Float64Array;
}

function isRecordArmMessage(value: unknown): value is RecordArmMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<RecordArmMessage>;
  return message.type === 'record-arm' &&
    typeof message.startFrame === 'number' &&
    typeof message.lengthSamples === 'number' &&
    typeof message.recordingId === 'number';
}

function isRecordCancelMessage(value: unknown): value is RecordCancelMessage {
  return typeof value === 'object' &&
    value !== null &&
    (value as Partial<RecordCancelMessage>).type === 'record-cancel';
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
  private readonly harmonyBlocks = [
    new Float32Array(DEFAULT_BLOCK_SAMPLES),
    new Float32Array(DEFAULT_BLOCK_SAMPLES),
    new Float32Array(DEFAULT_BLOCK_SAMPLES),
    new Float32Array(DEFAULT_BLOCK_SAMPLES),
  ] as const;
  private readonly harmonyShifters: Array<Shifter | null> = [
    null,
    null,
    null,
    null,
  ];
  private readonly harmonyGains = new Float64Array(HARMONY_VOICE_COUNT);
  private readonly harmonyTargets = new Float64Array(HARMONY_VOICE_COUNT);
  private readonly harmonyPanLeft = new Float64Array(HARMONY_VOICE_COUNT);
  private readonly harmonyPanRight = new Float64Array(HARMONY_VOICE_COUNT);
  private readonly harmonyProcessing = new Uint8Array(HARMONY_VOICE_COUNT);
  private readonly key: KeyConfig = { tonicPc: 0, scale: 'major' };
  private pool: ShifterPool | null = null;
  private leadShifter: Shifter | null = null;
  private dryDelay: Float32Array | null = null;
  private dryWriteIndex = 0;
  private dryGain = 0;
  private wetGain = 0;
  private headroomGain = 1;
  private unvoicedBlocks = 0;
  private shifterResetForSilence = false;
  private perfIndex = 0;
  private recording: RecordingState | null = null;
  private fallbackFrame = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    this.bus = new WorkletBusView(this.port, readSharedBuffer(options));
    this.port.addEventListener('message', this.handleMessage);
    this.port.start();
    this.port.postMessage({ type: 'ready' });
    void this.initializeShifters();
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const canMeasure = typeof performance !== 'undefined';
    const startedAt = canMeasure ? performance.now() : 0;
    const input = inputs[0]?.[0];
    const output = outputs[0];
    const blockStart = this.currentFrame();
    const blockSize = output?.[0]?.length ?? input?.length ?? DEFAULT_BLOCK_SAMPLES;

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
        this.processCorrection(
          input,
          output,
          analysis.smoothedMidi,
          voiced,
          analysis.stableNote,
        );
      } else {
        silenceOutput(output);
        this.bus.set(P.correctedFreq, 0);
      }
    } else {
      silenceOutput(output);
    }

    this.captureOutputIfNeeded(output, blockStart, blockSize);
    this.fallbackFrame += blockSize;
    if (canMeasure) {
      this.recordPerformance(performance.now() - startedAt);
    }
    this.bus.flushTelemetryIfNeeded();
    return true;
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (isRecordArmMessage(event.data)) {
      const lengthSamples = Math.max(1, Math.round(event.data.lengthSamples));
      this.recording = {
        recordingId: event.data.recordingId,
        startFrame: Math.round(event.data.startFrame),
        lengthSamples,
        buffer: new Float32Array(lengthSamples),
        actualStartFrame: Math.round(event.data.startFrame),
      };
    } else if (isRecordCancelMessage(event.data)) {
      this.recording = null;
    }
  };

  private currentFrame(): number {
    const audioGlobal = globalThis as unknown as { currentFrame?: number };
    return typeof audioGlobal.currentFrame === 'number'
      ? audioGlobal.currentFrame
      : this.fallbackFrame;
  }

  private captureOutputIfNeeded(
    output: Float32Array[] | undefined,
    blockStart: number,
    blockSize: number,
  ): void {
    const recording = this.recording;
    if (!recording || !output || blockSize <= 0) return;
    const recordEnd = recording.startFrame + recording.lengthSamples;
    const blockEnd = blockStart + blockSize;
    const overlapStart = Math.max(blockStart, recording.startFrame);
    const overlapEnd = Math.min(blockEnd, recordEnd);
    if (overlapStart >= overlapEnd) return;

    const left = output[0];
    const right = output[1];
    for (let frame = overlapStart; frame < overlapEnd; frame += 1) {
      const blockIndex = frame - blockStart;
      const writeIndex = frame - recording.startFrame;
      const leftSample = left?.[blockIndex] ?? 0;
      const rightSample = right?.[blockIndex] ?? leftSample;
      recording.buffer[writeIndex] = (leftSample + rightSample) * 0.5;
    }

    if (overlapEnd >= recordEnd) {
      const transfer = recording.buffer.buffer;
      this.port.postMessage({
        type: 'record-done',
        recordingId: recording.recordingId,
        buffer: transfer,
        channels: 1,
        actualStartFrame: recording.actualStartFrame,
      }, [transfer]);
      this.recording = null;
    }
  }

  private async initializeShifters(): Promise<void> {
    this.pool = await ShifterPool.create(
      SHIFTER_POOL_SIZE,
      sampleRate,
      new ArrayBuffer(0),
    );
    this.leadShifter = this.pool.get(0);
    for (let index = 0; index < HARMONY_VOICE_COUNT; index += 1) {
      this.harmonyShifters[index] = this.pool.get(index + 1);
    }
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
    stableNote: number | null,
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
    const formantShift = this.bus.get(P.formantShift);
    shifter.setTranspose(leadShift);
    shifter.setFormant(formantShift);
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
        for (let index = 0; index < HARMONY_VOICE_COUNT; index += 1) {
          this.harmonyShifters[index]?.reset();
          this.harmonyProcessing[index] = 0;
        }
        this.shifterResetForSilence = true;
      }
    }

    const bypass = this.bus.get(P.bypass) >= 0.5;
    const requestedHarmonyVoices = Math.max(
      0,
      Math.min(
        HARMONY_VOICE_COUNT,
        Math.round(this.bus.get(P.harmonyVoices)),
      ),
    );
    const activeHarmonyVoices =
      voiced && stableNote !== null ? requestedHarmonyVoices : 0;
    const spread = Math.max(0, Math.min(1, this.bus.get(P.harmonySpread)));
    this.prepareHarmonyVoices(
      input,
      stableNote,
      activeHarmonyVoices,
      leadShift,
      formantShift,
      spread,
    );

    const targetDry = bypass ? 1 : this.bus.get(P.dryLevel);
    const targetWet = bypass ? 0 : voiced ? this.bus.get(P.wetLevel) : 0;
    const targetHeadroom = 1 / Math.sqrt(1 + activeHarmonyVoices);
    const dryAlpha = gainAlpha(GAIN_RAMP_TAU_MS);
    const wetTauMs =
      targetWet < this.wetGain ? UNVOICED_RAMP_MS : GAIN_RAMP_TAU_MS;
    const wetAlpha = gainAlpha(wetTauMs);
    const harmonyAttackAlpha = gainAlpha(GAIN_RAMP_TAU_MS);
    const harmonyReleaseAlpha = gainAlpha(UNVOICED_RAMP_MS);
    const channelCount = output?.length ?? 0;

    for (let index = 0; index < input.length; index += 1) {
      this.dryGain += (targetDry - this.dryGain) * dryAlpha;
      this.wetGain += (targetWet - this.wetGain) * wetAlpha;
      this.headroomGain +=
        (targetHeadroom - this.headroomGain) * dryAlpha;

      let harmonyLeft = 0;
      let harmonyRight = 0;
      for (
        let voiceIndex = 0;
        voiceIndex < HARMONY_VOICE_COUNT;
        voiceIndex += 1
      ) {
        const harmonyAlpha =
          this.harmonyTargets[voiceIndex]! <
          this.harmonyGains[voiceIndex]!
            ? harmonyReleaseAlpha
            : harmonyAttackAlpha;
        const currentHarmonyGain = this.harmonyGains[voiceIndex]!;
        this.harmonyGains[voiceIndex] =
          currentHarmonyGain +
          (this.harmonyTargets[voiceIndex]! - currentHarmonyGain) *
            harmonyAlpha;
        const harmonySample =
          this.harmonyBlocks[voiceIndex]![index]! *
          this.harmonyGains[voiceIndex]!;
        harmonyLeft += harmonySample * this.harmonyPanLeft[voiceIndex]!;
        harmonyRight += harmonySample * this.harmonyPanRight[voiceIndex]!;
      }

      const delayedDry = this.dryBlock[index]! * this.dryGain;
      const leadWet = this.wetBlock[index]!;
      const left =
        delayedDry +
        (leadWet + harmonyLeft) * this.headroomGain * this.wetGain;
      const right =
        delayedDry +
        (leadWet + harmonyRight) * this.headroomGain * this.wetGain;
      if (channelCount > 0) {
        output![0]![index] = left;
      }
      if (channelCount > 1) {
        output![1]![index] = right;
      }
      for (let channel = 2; channel < channelCount; channel += 1) {
        output![channel]![index] = (left + right) * 0.5;
      }
    }

    this.resetSilentHarmonyVoices();
    this.bus.set(
      P.correctedFreq,
      voiced ? midiToFreq(correctionFrame.appliedTarget) : 0,
    );
  }

  private prepareHarmonyVoices(
    input: Float32Array,
    stableNote: number | null,
    activeVoiceCount: number,
    leadShift: number,
    formantShift: number,
    spread: number,
  ): void {
    for (
      let voiceIndex = 0;
      voiceIndex < HARMONY_VOICE_COUNT;
      voiceIndex += 1
    ) {
      const active = stableNote !== null && voiceIndex < activeVoiceCount;
      this.harmonyTargets[voiceIndex] = active ? 1 : 0;

      const panAngle =
        (PAN_POSITION[voiceIndex]! * spread * 0.5 + 0.5) * HALF_PI;
      this.harmonyPanLeft[voiceIndex] = Math.cos(panAngle);
      this.harmonyPanRight[voiceIndex] = Math.sin(panAngle);

      const shifter = this.harmonyShifters[voiceIndex]!;
      if (active) {
        const intervalSteps = Math.round(
          this.bus.get(HARMONY_INTERVAL_PARAMS[voiceIndex]!),
        );
        const semitoneOffset = resolveInterval(
          stableNote,
          this.key,
          intervalSteps,
        );
        const detuneSemitones =
          (MAX_DETUNE_CENTS * DETUNE_SIGN[voiceIndex]! * spread) / 100;
        shifter.setTranspose(
          leadShift + semitoneOffset + detuneSemitones,
        );
        shifter.setFormant(formantShift);
        shifter.process(input, this.harmonyBlocks[voiceIndex]!);
        this.harmonyProcessing[voiceIndex] = 1;
        this.bus.set(
          HARMONY_NOTE_PARAMS[voiceIndex]!,
          stableNote + semitoneOffset,
        );
      } else {
        this.bus.set(HARMONY_NOTE_PARAMS[voiceIndex]!, -1);
        if (this.harmonyGains[voiceIndex]! > HARMONY_GAIN_SILENCE) {
          shifter.process(input, this.harmonyBlocks[voiceIndex]!);
          this.harmonyProcessing[voiceIndex] = 1;
        } else {
          this.harmonyBlocks[voiceIndex]!.fill(0);
        }
      }
    }
  }

  private resetSilentHarmonyVoices(): void {
    for (
      let voiceIndex = 0;
      voiceIndex < HARMONY_VOICE_COUNT;
      voiceIndex += 1
    ) {
      if (
        this.harmonyTargets[voiceIndex] === 0 &&
        this.harmonyGains[voiceIndex]! <= HARMONY_GAIN_SILENCE &&
        this.harmonyProcessing[voiceIndex] === 1
      ) {
        this.harmonyShifters[voiceIndex]!.reset();
        this.harmonyProcessing[voiceIndex] = 0;
        this.harmonyBlocks[voiceIndex]!.fill(0);
      }
    }
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
