import workletUrl from './worklets/toad-processor.ts?worker&url';
import { createParamsBus, P, type ParamsBus } from './paramsBus';
import { HARMONY_PRESETS } from './theory/harmony';
import { SCALE_ORDER } from '../types';
import { useStore, type AppState } from '../state/store';

const WORKLET_READY_TIMEOUT_MS = 3000;
const WORKLET_LOAD_TIMEOUT_MS = 3000;
const PITCH_WINDOW_SAMPLES = 2048; // samples

interface ReadyMessage {
  type: 'ready';
}

interface ShiftersReadyMessage {
  type: 'shifters-ready';
  latencySamples: number;
}

export type EngineStartStage = 'engine' | 'microphone' | 'warming up';

function isReadyMessage(value: unknown): value is ReadyMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'ready'
  );
}

function isShiftersReadyMessage(value: unknown): value is ShiftersReadyMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'shifters-ready' &&
    'latencySamples' in value &&
    typeof value.latencySamples === 'number'
  );
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  bus: ParamsBus = createParamsBus();
  node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private unsubscribeStore: (() => void) | null = null;

  async start(onStage?: (stage: EngineStartStage) => void): Promise<void> {
    if (this.ctx && this.ctx.state !== 'closed') {
      return;
    }

    useStore.getState().set({ error: null });

    try {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      await this.ctx.resume();
      this.bus = createParamsBus();
      onStage?.('engine');

      try {
        const workletModuleUrl = import.meta.env.DEV
          ? new URL('./worklets/toad-processor.ts', import.meta.url).href
          : workletUrl;
        await withTimeout(
          this.ctx.audioWorklet.addModule(workletModuleUrl),
          WORKLET_LOAD_TIMEOUT_MS,
          'worklet-load-timeout',
        );
      } catch {
        throw new Error('worklet-load');
      }

      onStage?.('microphone');
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
          },
          video: false,
        });
      } catch {
        throw new Error('microphone-denied');
      }

      onStage?.('warming up');
      this.node = new AudioWorkletNode(this.ctx, 'toad-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { sab: this.bus.sab },
      });
      if (this.bus.mode === 'message') {
        this.bus.attachPort(this.node.port);
      }
      const shifterLatencySamples = await this.waitForWorkletReady(
        this.node.port,
      );

      this.syncStoreToBus(useStore.getState());
      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.source.connect(this.node);
      this.node.connect(this.ctx.destination);

      this.unsubscribeStore = useStore.subscribe((state) => {
        this.syncStoreToBus(state);
      });
      const browserLatencySeconds =
        this.ctx.baseLatency + (this.ctx.outputLatency ?? 0);
      const shifterLatencySeconds =
        shifterLatencySamples / this.ctx.sampleRate;
      const detectionWindowSeconds =
        PITCH_WINDOW_SAMPLES / 2 / this.ctx.sampleRate;
      useStore.getState().set({
        latencyMs:
          (browserLatencySeconds +
            shifterLatencySeconds +
            detectionWindowSeconds) *
          1000,
      });
    } catch (cause) {
      const message =
        cause instanceof Error && cause.message === 'microphone-denied'
          ? 'AUTOTOAD needs your microphone — it IS the instrument. Allow mic access and reload.'
          : 'Audio engine failed to load. Try a Chromium browser (Chrome/Edge).';
      useStore.getState().set({ error: message, micReady: false });
      this.stop();
      throw cause;
    }
  }

  stop(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.source?.disconnect();
    this.source = null;
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close();
    }
    this.ctx = null;
  }

  private waitForWorkletReady(port: MessagePort): Promise<number> {
    return new Promise((resolve, reject) => {
      let processorReady = false;
      let shiftersReady = false;
      let latencySamples = 0;
      const timeoutId = globalThis.setTimeout(() => {
        port.removeEventListener('message', handleMessage);
        reject(new Error('worklet-ready-timeout'));
      }, WORKLET_READY_TIMEOUT_MS);

      const handleMessage = (event: MessageEvent<unknown>): void => {
        if (isReadyMessage(event.data)) {
          processorReady = true;
        } else if (isShiftersReadyMessage(event.data)) {
          shiftersReady = true;
          latencySamples = event.data.latencySamples;
        } else {
          return;
        }
        if (!processorReady || !shiftersReady) {
          return;
        }
        globalThis.clearTimeout(timeoutId);
        port.removeEventListener('message', handleMessage);
        resolve(latencySamples);
      };

      port.addEventListener('message', handleMessage);
      port.start();
    });
  }

  private syncStoreToBus(state: AppState): void {
    const harmonyIntervals = HARMONY_PRESETS[state.harmonyPreset];
    this.bus.set(P.bypass, state.bypass ? 1 : 0);
    this.bus.set(P.retuneMs, state.retuneMs);
    this.bus.set(P.correctionAmount, state.correctionAmount);
    this.bus.set(P.keyTonic, state.key.tonicPc);
    this.bus.set(P.scaleId, SCALE_ORDER.indexOf(state.key.scale));
    this.bus.set(P.formantShift, state.formantShift);
    this.bus.set(P.pitchShift, state.pitchShift);
    this.bus.set(P.harmonyVoices, harmonyIntervals.length);
    this.bus.set(P.harmonyInterval0, harmonyIntervals[0] ?? 0);
    this.bus.set(P.harmonyInterval1, harmonyIntervals[1] ?? 0);
    this.bus.set(P.harmonyInterval2, harmonyIntervals[2] ?? 0);
    this.bus.set(P.harmonyInterval3, harmonyIntervals[3] ?? 0);
    this.bus.set(P.harmonySpread, state.harmonySpread);
    this.bus.set(P.dryLevel, state.dryLevel);
    this.bus.set(P.wetLevel, state.wetLevel);
    this.bus.set(P.inputGain, 1);
  }
}

export const engine = new AudioEngine();

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);

    promise.then(
      (value) => {
        globalThis.clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}
