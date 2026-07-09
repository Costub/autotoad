import * as Tone from 'tone';
import type { FxBus, SourceFxSends } from '../fx/fxBus';
import type { AppState } from '../../state/store';
import { useStore } from '../../state/store';

export interface LoopSpec {
  bpm: number;
  bars: number;
  sampleRate: number;
}

export interface Layer {
  id: number;
  buffer: AudioBuffer;
  gain: GainNode;
  reverbSend: Tone.Gain;
  source: AudioBufferSourceNode;
  muted: boolean;
  snapshot: string;
  fxSends: SourceFxSends;
}

interface RecordDoneMessage {
  type: 'record-done';
  recordingId: number;
  buffer: ArrayBuffer;
  channels: 1;
  actualStartFrame: number;
}

export type LooperState = 'idle' | 'armed' | 'recording' | 'playing';

const MAX_LAYERS = 8;
const ARM_SAFETY_SECONDS = 0.15;
const START_SAFETY_SECONDS = 0.05;
const RAMP_SECONDS = 0.03;
const BEATS_PER_BAR = 4;

export function loopLengthSamples(s: LoopSpec): number {
  return Math.round(s.bars * BEATS_PER_BAR * (60 / s.bpm) * s.sampleRate);
}

export function oneBarSamples(bpm: number, sampleRate: number): number {
  return Math.round(BEATS_PER_BAR * (60 / bpm) * sampleRate);
}

export function nextBoundarySamples(
  nowSamples: number,
  epochSamples: number,
  loopLen: number,
): number {
  if (nowSamples <= epochSamples) return epochSamples;
  const k = Math.ceil((nowSamples - epochSamples) / loopLen);
  return epochSamples + k * loopLen;
}

export function rotateLeft(
  input: Float32Array<ArrayBufferLike>,
  amount: number,
): Float32Array<ArrayBuffer> {
  const output = new Float32Array(input.length);
  if (input.length === 0) return output;
  const offset = positiveModulo(amount, input.length);
  if (offset === 0) {
    output.set(input);
    return output;
  }
  output.set(input.subarray(offset));
  output.set(input.subarray(0, offset), input.length - offset);
  return output;
}

export class Looper {
  layers: Layer[] = [];
  state: LooperState = 'idle';

  private epochSamples: number | null = null;
  private loopLenSamples = 0;
  private nextLayerId = 1;
  private recordingId = 1;
  private activeRecordingId: number | null = null;
  private pendingSnapshot = '';
  private stateTimer: number | null = null;

  constructor(
    private readonly ctx: AudioContext,
    private readonly node: AudioWorkletNode,
    private readonly masterGain: GainNode,
    private readonly fxBus: FxBus,
    private readonly shifterLatencySamples: number,
  ) {
    this.node.port.addEventListener('message', this.handleMessage);
    this.node.port.start();
    this.mirrorToStore();
  }

  armRecord(): void {
    if (this.layers.length >= MAX_LAYERS || this.activeRecordingId !== null) {
      return;
    }

    const state = useStore.getState();
    this.loopLenSamples = loopLengthSamples({
      bpm: state.bpm,
      bars: state.bars,
      sampleRate: this.ctx.sampleRate,
    });
    const nowSamples = Math.round(this.ctx.currentTime * this.ctx.sampleRate);
    let startFrame: number;

    if (this.epochSamples === null || this.layers.length === 0) {
      startFrame =
        nowSamples +
        Math.round(ARM_SAFETY_SECONDS * this.ctx.sampleRate) +
        oneBarSamples(state.bpm, this.ctx.sampleRate);
      this.epochSamples = startFrame;
      Tone.getTransport().start();
      state.set({ metronomeOn: true });
    } else {
      startFrame = nextBoundarySamples(
        nowSamples,
        this.epochSamples,
        this.loopLenSamples,
      );
    }

    const recordingId = this.recordingId;
    this.recordingId += 1;
    this.activeRecordingId = recordingId;
    this.pendingSnapshot = snapshotFromState(state);
    this.state = 'armed';
    this.node.port.postMessage({
      type: 'record-arm',
      startFrame,
      lengthSamples: this.loopLenSamples,
      recordingId,
    });
    this.scheduleRecordingState(startFrame, recordingId);
    this.mirrorToStore();
  }

  disarm(): void {
    if (this.activeRecordingId === null) return;
    this.node.port.postMessage({ type: 'record-cancel' });
    this.activeRecordingId = null;
    this.pendingSnapshot = '';
    this.clearStateTimer();
    this.state = this.layers.length > 0 ? 'playing' : 'idle';
    if (this.layers.length === 0) {
      this.epochSamples = null;
    }
    this.mirrorToStore();
  }

  clearLayer(id: number): void {
    const layer = this.layers.find((candidate) => candidate.id === id);
    if (!layer) return;
    safeStop(layer.source);
    layer.source.disconnect();
    layer.gain.disconnect();
    layer.fxSends.dispose();
    this.layers = this.layers.filter((candidate) => candidate.id !== id);
    if (this.layers.length === 0 && this.activeRecordingId === null) {
      this.epochSamples = null;
      this.state = 'idle';
    }
    this.mirrorToStore();
  }

  setLayerGain(id: number, value: number): void {
    const layer = this.layers.find((candidate) => candidate.id === id);
    if (!layer) return;
    layer.gain.gain.setTargetAtTime(clamp01(value), this.ctx.currentTime, RAMP_SECONDS);
    this.mirrorToStore({ id, gain: clamp01(value) });
  }

  setLayerReverb(id: number, value: number): void {
    const layer = this.layers.find((candidate) => candidate.id === id);
    if (!layer) return;
    layer.reverbSend.gain.rampTo(clamp01(value), RAMP_SECONDS);
    this.mirrorToStore({ id, reverbSend: clamp01(value) });
  }

  toggleMute(id: number): void {
    const layer = this.layers.find((candidate) => candidate.id === id);
    if (!layer) return;
    layer.muted = !layer.muted;
    layer.gain.gain.setTargetAtTime(
      layer.muted ? 0 : useStore.getState().looperLayers.find((item) => item.id === id)?.gain ?? 1,
      this.ctx.currentTime,
      RAMP_SECONDS,
    );
    this.mirrorToStore({ id, muted: layer.muted });
  }

  clearAll(): void {
    this.disarm();
    for (const layer of this.layers) {
      safeStop(layer.source);
      layer.source.disconnect();
      layer.gain.disconnect();
      layer.fxSends.dispose();
    }
    this.layers = [];
    this.epochSamples = null;
    this.loopLenSamples = 0;
    this.state = 'idle';
    this.mirrorToStore();
  }

  getProgress(): number {
    if (this.epochSamples === null || this.loopLenSamples <= 0) return 0;
    const nowSamples = this.ctx.currentTime * this.ctx.sampleRate;
    return positiveModulo(nowSamples - this.epochSamples, this.loopLenSamples) /
      this.loopLenSamples;
  }

  getVisualState(): {
    progress: number;
    state: LooperState;
    layers: Array<{ id: number; muted: boolean }>;
  } {
    return {
      progress: this.getProgress(),
      state: this.state,
      layers: this.layers.map((layer) => ({ id: layer.id, muted: layer.muted })),
    };
  }

  dispose(): void {
    this.node.port.removeEventListener('message', this.handleMessage);
    this.clearAll();
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (!isRecordDoneMessage(event.data)) return;
    if (event.data.recordingId !== this.activeRecordingId) return;
    this.finishRecording(event.data);
  };

  private finishRecording(message: RecordDoneMessage): void {
    const raw = new Float32Array(message.buffer);
    const latencySamples =
      Math.round((this.ctx.baseLatency + (this.ctx.outputLatency ?? 0)) * this.ctx.sampleRate) +
      this.shifterLatencySamples +
      useStore.getState().looperLatencyOffsetSamples;
    const compensated = rotateLeft(raw, Math.max(0, latencySamples));
    const buffer = new AudioBuffer({
      numberOfChannels: 1,
      length: compensated.length,
      sampleRate: this.ctx.sampleRate,
    });
    buffer.copyToChannel(compensated, 0);
    const gain = new GainNode(this.ctx, { gain: 1 });
    gain.connect(this.masterGain);
    const fxSends = this.fxBus.connectSource(gain, { reverbScale: 1, delayScale: 1 });
    const source = this.createLayerSource(buffer, gain);
    const layer: Layer = {
      id: this.nextLayerId,
      buffer,
      gain,
      reverbSend: fxSends.reverb,
      source,
      muted: false,
      snapshot: this.pendingSnapshot,
      fxSends,
    };
    this.nextLayerId += 1;
    this.layers = [...this.layers, layer].slice(0, MAX_LAYERS);
    this.activeRecordingId = null;
    this.pendingSnapshot = '';
    this.clearStateTimer();
    this.state = 'playing';
    this.mirrorToStore();
  }

  private createLayerSource(
    buffer: AudioBuffer,
    gain: GainNode,
  ): AudioBufferSourceNode {
    const source = new AudioBufferSourceNode(this.ctx, { buffer, loop: true });
    source.loopStart = 0;
    source.loopEnd = buffer.length / buffer.sampleRate;
    source.connect(gain);
    const when = this.ctx.currentTime + START_SAFETY_SECONDS;
    const epoch = this.epochSamples ?? Math.round(when * this.ctx.sampleRate);
    const posSamples = positiveModulo(
      Math.round(when * this.ctx.sampleRate) - epoch,
      buffer.length,
    );
    source.start(when, posSamples / this.ctx.sampleRate);
    return source;
  }

  private scheduleRecordingState(startFrame: number, recordingId: number): void {
    this.clearStateTimer();
    const startTimeMs =
      Math.max(0, (startFrame / this.ctx.sampleRate - this.ctx.currentTime) * 1000);
    this.stateTimer = globalThis.setTimeout(() => {
      if (this.activeRecordingId === recordingId && this.state === 'armed') {
        this.state = 'recording';
        this.mirrorToStore();
      }
    }, startTimeMs);
  }

  private clearStateTimer(): void {
    if (this.stateTimer !== null) {
      globalThis.clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
  }

  private mirrorToStore(
    layerPatch?: Partial<{
      id: number;
      gain: number;
      reverbSend: number;
      muted: boolean;
    }>,
  ): void {
    const existing = useStore.getState().looperLayers;
    const uiLayers = this.layers.map((layer) => {
      const previous = existing.find((item) => item.id === layer.id);
      return {
        id: layer.id,
        snapshot: layer.snapshot,
        muted: layerPatch?.id === layer.id && layerPatch.muted !== undefined
          ? layerPatch.muted
          : layer.muted,
        gain: layerPatch?.id === layer.id && layerPatch.gain !== undefined
          ? layerPatch.gain
          : previous?.gain ?? 1,
        reverbSend: layerPatch?.id === layer.id && layerPatch.reverbSend !== undefined
          ? layerPatch.reverbSend
          : previous?.reverbSend ?? 1,
      };
    });
    useStore.getState().set({
      looperState: this.state,
      looperLayers: uiLayers,
      looperEpochSamples: this.epochSamples ?? 0,
      loopLengthSamples: this.loopLenSamples,
    });
  }
}

function isRecordDoneMessage(value: unknown): value is RecordDoneMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<RecordDoneMessage>;
  return message.type === 'record-done' &&
    typeof message.recordingId === 'number' &&
    message.buffer instanceof ArrayBuffer &&
    message.channels === 1 &&
    typeof message.actualStartFrame === 'number';
}

function snapshotFromState(state: AppState): string {
  const harmony = state.harmonyPreset === 'off'
    ? ''
    : ` · ${capitalize(state.harmonyPreset)}`;
  if (state.engineMode === 'instrument') return instrumentLabel(state.instrument);
  if (state.engineMode === 'both') {
    return `Voice+${instrumentLabel(state.instrument)}${harmony}`;
  }
  return `Voice${harmony}`;
}

function instrumentLabel(name: AppState['instrument']): string {
  if (name === 'fmBass') return 'FM Bass';
  if (name === 'choirPad') return 'Choir Pad';
  return capitalize(name);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function safeStop(source: AudioBufferSourceNode): void {
  try {
    source.stop();
  } catch {
    // Already stopped.
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}
