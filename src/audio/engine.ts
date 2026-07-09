import workletUrl from './worklets/toad-processor.ts?worker&url';
import { createParamsBus, P, type ParamsBus } from './paramsBus';
import { SCALE_ORDER } from '../types';
import { useStore, type AppState } from '../state/store';

const WORKLET_READY_TIMEOUT_MS = 3000;
const WORKLET_LOAD_TIMEOUT_MS = 3000;

interface ReadyMessage {
  type: 'ready';
}

function isReadyMessage(value: unknown): value is ReadyMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'ready'
  );
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  bus: ParamsBus = createParamsBus();
  node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private unsubscribeStore: (() => void) | null = null;

  async start(): Promise<void> {
    if (this.ctx && this.ctx.state !== 'closed') {
      return;
    }

    useStore.getState().set({ error: null });

    try {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      await this.ctx.resume();
      this.bus = createParamsBus();

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

      this.node = new AudioWorkletNode(this.ctx, 'toad-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { sab: this.bus.sab },
      });
      if (this.bus.mode === 'message') {
        this.bus.attachPort(this.node.port);
      }
      await this.waitForWorkletReady(this.node.port);

      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.source.connect(this.node);
      this.node.connect(this.ctx.destination);

      this.syncStoreToBus(useStore.getState());
      this.unsubscribeStore = useStore.subscribe((state) => {
        this.syncStoreToBus(state);
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

  private waitForWorkletReady(port: MessagePort): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        port.removeEventListener('message', handleMessage);
        reject(new Error('worklet-ready-timeout'));
      }, WORKLET_READY_TIMEOUT_MS);

      const handleMessage = (event: MessageEvent<unknown>): void => {
        if (!isReadyMessage(event.data)) {
          return;
        }
        globalThis.clearTimeout(timeoutId);
        port.removeEventListener('message', handleMessage);
        resolve();
      };

      port.addEventListener('message', handleMessage);
      port.start();
    });
  }

  private syncStoreToBus(state: AppState): void {
    this.bus.set(P.bypass, state.bypass ? 1 : 0);
    this.bus.set(P.retuneMs, state.retuneMs);
    this.bus.set(P.correctionAmount, state.correctionAmount);
    this.bus.set(P.keyTonic, state.key.tonicPc);
    this.bus.set(P.scaleId, SCALE_ORDER.indexOf(state.key.scale));
    this.bus.set(P.formantShift, state.formantShift);
    this.bus.set(P.pitchShift, state.pitchShift);
    this.bus.set(P.harmonyVoices, 0);
    this.bus.set(P.harmonyInterval0, 0);
    this.bus.set(P.harmonyInterval1, 0);
    this.bus.set(P.harmonyInterval2, 0);
    this.bus.set(P.harmonyInterval3, 0);
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
