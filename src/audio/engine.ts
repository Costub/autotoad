import * as Tone from 'tone';
import workletUrl from './worklets/toad-processor.ts?worker&url';
import { createParamsBus, P, type ParamsBus } from './paramsBus';
import { getDemoBuffer } from './demoInput';
import { createFxBus, type FxBus } from './fx/fxBus';
import { createInstrument, type InstrumentInstance } from './instruments/presets';
import { Looper } from './looper/looper';
import { Metronome } from './metronome';
import { VoiceToMidi, type V2MEvent } from './midi/voiceToMidi';
import { TakeRecorder } from './takeRecorder';
import { HARMONY_PRESETS, resolveInterval } from './theory/harmony';
import { SCALE_ORDER, type InputSourceName } from '../types';
import { useStore, type AppState } from '../state/store';
import { pushBubbleEvent } from '../ui/pixi/bubbleEvents';

const WORKLET_READY_TIMEOUT_MS = 3000;
const WORKLET_LOAD_TIMEOUT_MS = 3000;
const PITCH_WINDOW_SAMPLES = 2048;
const DELAY_DIVISIONS = ['8n', '8n.', '4n', '2n'] as const;

interface ReadyMessage { type: 'ready' }
interface ShiftersReadyMessage { type: 'shifters-ready'; latencySamples: number }
export interface EngineStartOptions { skipMic?: boolean }
export type EngineStartStage = 'engine' | 'microphone' | 'warming up';

const isReadyMessage = (value: unknown): value is ReadyMessage =>
  typeof value === 'object' && value !== null && 'type' in value && value.type === 'ready';

const isShiftersReadyMessage = (value: unknown): value is ShiftersReadyMessage =>
  typeof value === 'object' && value !== null && 'type' in value &&
  value.type === 'shifters-ready' && 'latencySamples' in value &&
  typeof value.latencySamples === 'number';

export class AudioEngine {
  ctx: AudioContext | null = null;
  bus: ParamsBus = createParamsBus();
  node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private bufferSource: AudioBufferSourceNode | null = null;
  private currentSource: AudioNode | null = null;
  private fileBuffer: AudioBuffer | null = null;
  private voiceGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private fxBus: FxBus | null = null;
  private instrument: InstrumentInstance | null = null;
  private metronome: Metronome | null = null;
  private looper: Looper | null = null;
  private takeRecorder: TakeRecorder | null = null;
  private v2m = new VoiceToMidi();
  private unsubscribeStore: (() => void) | null = null;
  private frameId: number | null = null;
  private lastState: AppState | null = null;
  private activeInstrumentNotes = new Set<number>();

  async start(
    optionsOrStage?: EngineStartOptions | ((stage: EngineStartStage) => void),
    stageCallback?: (stage: EngineStartStage) => void,
  ): Promise<void> {
    if (this.ctx && this.ctx.state !== 'closed') return;
    const options = typeof optionsOrStage === 'function' ? {} : (optionsOrStage ?? {});
    const onStage = typeof optionsOrStage === 'function' ? optionsOrStage : stageCallback;
    useStore.getState().set({ error: null });

    try {
      const rawCtx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = rawCtx;
      // Tone must share the one raw context before any Tone object is constructed.
      Tone.setContext(new Tone.Context(rawCtx));
      await rawCtx.resume();
      this.bus = createParamsBus();
      onStage?.('engine');

      try {
        const moduleUrl = import.meta.env.DEV
          ? new URL('./worklets/toad-processor.ts', import.meta.url).href
          : workletUrl;
        await withTimeout(rawCtx.audioWorklet.addModule(moduleUrl), WORKLET_LOAD_TIMEOUT_MS, 'worklet-load-timeout');
      } catch {
        throw new Error('worklet-load');
      }

      if (!options.skipMic) {
        onStage?.('microphone');
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
            video: false,
          });
          this.micSource = rawCtx.createMediaStreamSource(this.stream);
        } catch {
          throw new Error('microphone-denied');
        }
      }

      onStage?.('warming up');
      this.node = new AudioWorkletNode(rawCtx, 'toad-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { sab: this.bus.sab },
      });
      if (this.bus.mode === 'message') this.bus.attachPort(this.node.port);
      const shifterLatencySamples = await this.waitForWorkletReady(this.node.port);

      this.voiceGain = new GainNode(rawCtx, { gain: 1 });
      this.masterGain = new GainNode(rawCtx, { gain: 0.9 });
      this.limiter = new DynamicsCompressorNode(rawCtx, {
        threshold: -6, knee: 4, ratio: 12, attack: 0.003, release: 0.25,
      });
      this.node.connect(this.voiceGain);
      this.voiceGain.connect(this.masterGain);
      this.masterGain.connect(this.limiter).connect(rawCtx.destination);

      this.fxBus = createFxBus(this.masterGain);
      this.fxBus.connectSource(this.voiceGain);
      this.instrument = createInstrument(useStore.getState().instrument);
      this.instrument.out.connect(this.masterGain);
      this.fxBus.connectSource(this.instrument.out);
      this.metronome = new Metronome(this.masterGain);
      this.metronome.start();
      this.looper = new Looper(rawCtx, this.node, this.masterGain, this.fxBus, shifterLatencySamples);
      this.takeRecorder = new TakeRecorder(rawCtx, this.masterGain);

      this.lastState = null;
      this.syncState(useStore.getState());
      this.unsubscribeStore = useStore.subscribe((state) => this.syncState(state));
      if (options.skipMic) {
        await this.setInputSource('demo');
      } else {
        await this.setInputSource('mic');
      }
      this.startEventPump();

      const browserLatency = rawCtx.baseLatency + (rawCtx.outputLatency ?? 0);
      useStore.getState().set({
        latencyMs: (browserLatency + shifterLatencySamples / rawCtx.sampleRate +
          PITCH_WINDOW_SAMPLES / 2 / rawCtx.sampleRate) * 1000,
        micReady: !options.skipMic,
      });
    } catch (cause) {
      const denied = cause instanceof Error && cause.message === 'microphone-denied';
      useStore.getState().set({
        error: denied
          ? 'AUTOTOAD needs microphone permission for live input. You can still explore everything with the demo melody.'
          : 'Audio engine failed to load. Try a Chromium browser (Chrome/Edge).',
        micReady: false,
      });
      this.stop();
      throw cause;
    }
  }

  async setInputSource(source: InputSourceName, fileBuffer?: AudioBuffer): Promise<void> {
    if (!this.ctx || !this.node) return;
    this.currentSource?.disconnect(this.node);
    this.bufferSource?.stop();
    this.bufferSource = null;

    if (source === 'mic') {
      if (!this.micSource) return;
      this.currentSource = this.micSource;
    } else {
      if (fileBuffer) this.fileBuffer = fileBuffer;
      const buffer = source === 'demo' ? await getDemoBuffer(this.ctx) : this.fileBuffer;
      if (!buffer) return;
      const player = new AudioBufferSourceNode(this.ctx, { buffer, loop: true });
      player.start();
      this.bufferSource = player;
      this.currentSource = player;
    }
    this.currentSource.connect(this.node);
    useStore.getState().set({ inputSource: source });
  }

  async loadFile(file: File): Promise<void> {
    if (!this.ctx) return;
    const decoded = await this.ctx.decodeAudioData(await file.arrayBuffer());
    const mono = new AudioBuffer({
      length: decoded.length,
      sampleRate: decoded.sampleRate,
      numberOfChannels: 1,
    });
    const target = mono.getChannelData(0);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const source = decoded.getChannelData(channel);
      for (let index = 0; index < target.length; index += 1) {
        target[index] = target[index]! + source[index]! / decoded.numberOfChannels;
      }
    }
    await this.setInputSource('file', mono);
  }

  toggleTake(): void {
    const state = useStore.getState();
    if (state.isRecordingTake) {
      void this.takeRecorder?.stop().then(() => state.set({ isRecordingTake: false }));
    } else {
      this.takeRecorder?.start();
      state.set({ isRecordingTake: true });
    }
  }

  toggleLoopRecord(): void {
    const looperState = useStore.getState().looperState;
    if (looperState === 'armed' || looperState === 'recording') {
      this.looper?.disarm();
    } else {
      this.looper?.armRecord();
    }
  }

  clearLoopLayer(id: number): void {
    this.looper?.clearLayer(id);
  }

  setLoopLayerGain(id: number, value: number): void {
    this.looper?.setLayerGain(id, value);
  }

  setLoopLayerReverb(id: number, value: number): void {
    this.looper?.setLayerReverb(id, value);
  }

  toggleLoopLayerMute(id: number): void {
    this.looper?.toggleMute(id);
  }

  clearAllLoops(): void {
    this.looper?.clearAll();
  }

  getLoopProgress(): number {
    return this.looper?.getProgress() ?? 0;
  }

  getLoopVisualState(): ReturnType<Looper['getVisualState']> {
    return this.looper?.getVisualState() ?? {
      progress: 0,
      state: 'idle',
      layers: [],
    };
  }

  panic(): void {
    this.looper?.disarm();
    useStore.getState().set({ bypass: true });
    this.dispatchEvents(this.v2m.allOff());
    this.instrument?.releaseAll();
    this.activeInstrumentNotes.clear();
  }

  stop(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.currentSource?.disconnect();
    this.bufferSource?.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.looper?.dispose();
    this.metronome?.dispose();
    this.instrument?.dispose();
    this.fxBus?.dispose();
    this.node?.disconnect();
    this.masterGain?.disconnect();
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close();
    this.ctx = null;
    this.node = null;
    this.stream = null;
    this.micSource = null;
    this.currentSource = null;
    this.bufferSource = null;
    this.instrument = null;
    this.fxBus = null;
    this.metronome = null;
    this.looper = null;
    this.lastState = null;
    useStore.getState().set({
      looperState: 'idle',
      looperLayers: [],
      looperEpochSamples: 0,
      loopLengthSamples: 0,
    });
  }

  private startEventPump(): void {
    const tick = (time: number): void => {
      const state = useStore.getState();
      if (state.engineMode !== 'effect') {
        this.v2m.legato = state.legato;
        const stable = this.bus.get(P.stableNote);
        const frequency = this.bus.get(P.detectedFreq);
        this.dispatchEvents(this.v2m.push({
          t: time,
          voiced: frequency > 0,
          stableNote: stable >= 0 ? Math.round(stable) : null,
          smoothedMidi: this.bus.get(P.smoothedMidi),
          rms: this.bus.get(P.rmsLevel),
        }));
      }
      this.frameId = requestAnimationFrame(tick);
    };
    this.frameId = requestAnimationFrame(tick);
  }

  private dispatchEvents(events: V2MEvent[]): void {
    const state = useStore.getState();
    for (const event of events) {
      if (event.type === 'pitchBend') continue;
      const notes = [event.midi];
      if (state.chordFollow) {
        for (const interval of HARMONY_PRESETS[state.harmonyPreset]) {
          notes.push(event.midi + resolveInterval(event.midi, state.key, interval));
        }
      }
      if (event.type === 'setNote' && !state.chordFollow) {
        for (const activeMidi of this.activeInstrumentNotes) {
          pushBubbleEvent({ type: 'off', midi: activeMidi, velocity: 0 });
        }
        this.instrument?.setNote(event.midi);
        this.activeInstrumentNotes.clear();
        this.activeInstrumentNotes.add(event.midi);
        pushBubbleEvent({ type: 'on', midi: event.midi, velocity: 95 });
        continue;
      }
      if (event.type === 'setNote') {
        this.releaseActiveInstrumentNotes();
      }
      for (const midi of notes) {
        if (event.type === 'noteOn') {
          this.instrument?.triggerAttack(midi, event.velocity / 127);
          this.activeInstrumentNotes.add(midi);
          pushBubbleEvent({ type: 'on', midi, velocity: event.velocity });
        } else if (event.type === 'noteOff') {
          this.instrument?.triggerRelease(midi);
          this.activeInstrumentNotes.delete(midi);
          pushBubbleEvent({ type: 'off', midi, velocity: 0 });
        } else {
          this.instrument?.triggerAttack(midi, 0.75);
          this.activeInstrumentNotes.add(midi);
        }
      }
    }
  }

  private syncState(state: AppState): void {
    const previous = this.lastState;
    if (previous && (
      previous.engineMode !== state.engineMode ||
      previous.instrument !== state.instrument ||
      previous.harmonyPreset !== state.harmonyPreset ||
      previous.chordFollow !== state.chordFollow
    )) {
      this.v2m.allOff();
      this.releaseActiveInstrumentNotes();
    }
    if (previous && previous.instrument !== state.instrument && this.masterGain && this.fxBus) {
      const old = this.instrument;
      this.instrument = createInstrument(state.instrument);
      this.instrument.out.connect(this.masterGain);
      this.fxBus.connectSource(this.instrument.out);
      globalThis.setTimeout(() => old?.dispose(), 200);
    }

    this.syncStoreToBus(state);
    if (!previous || previous.bpm !== state.bpm) this.metronome?.setBpm(state.bpm);
    if (!previous || previous.metronomeOn !== state.metronomeOn) this.metronome?.setEnabled(state.metronomeOn);
    if (!previous || previous.reverbSend !== state.reverbSend) this.fxBus?.setParam('reverbSend', state.reverbSend);
    if (!previous || previous.reverbDecay !== state.reverbDecay) this.fxBus?.setParam('reverbDecay', state.reverbDecay);
    if (!previous || previous.delaySend !== state.delaySend) this.fxBus?.setParam('delaySend', state.delaySend);
    if (!previous || previous.delayTime !== state.delayTime) {
      this.fxBus?.setParam('delayTime', DELAY_DIVISIONS.indexOf(state.delayTime));
    }
    if (!previous || previous.delayFeedback !== state.delayFeedback) {
      this.fxBus?.setParam('delayFeedback', state.delayFeedback);
    }
    this.lastState = state;
  }

  private releaseActiveInstrumentNotes(): void {
    for (const midi of this.activeInstrumentNotes) {
      this.instrument?.triggerRelease(midi);
      pushBubbleEvent({ type: 'off', midi, velocity: 0 });
    }
    this.instrument?.releaseAll();
    this.activeInstrumentNotes.clear();
  }

  private syncStoreToBus(state: AppState): void {
    const harmony = HARMONY_PRESETS[state.harmonyPreset];
    this.bus.set(P.bypass, state.bypass ? 1 : 0);
    this.bus.set(P.retuneMs, state.retuneMs);
    this.bus.set(P.correctionAmount, state.correctionAmount);
    this.bus.set(P.keyTonic, state.key.tonicPc);
    this.bus.set(P.scaleId, SCALE_ORDER.indexOf(state.key.scale));
    this.bus.set(P.formantShift, state.formantShift);
    this.bus.set(P.pitchShift, state.pitchShift);
    this.bus.set(P.harmonyVoices, harmony.length);
    this.bus.set(P.harmonyInterval0, harmony[0] ?? 0);
    this.bus.set(P.harmonyInterval1, harmony[1] ?? 0);
    this.bus.set(P.harmonyInterval2, harmony[2] ?? 0);
    this.bus.set(P.harmonyInterval3, harmony[3] ?? 0);
    this.bus.set(P.harmonySpread, state.harmonySpread);
    this.bus.set(P.dryLevel, state.engineMode === 'instrument' ? 0 : state.dryLevel);
    this.bus.set(P.wetLevel, state.engineMode === 'instrument' ? 0 : state.wetLevel);
    this.bus.set(P.inputGain, 1);
  }

  private waitForWorkletReady(port: MessagePort): Promise<number> {
    return new Promise((resolve, reject) => {
      let processorReady = false;
      let shiftersReady = false;
      let latency = 0;
      const timeout = globalThis.setTimeout(() => {
        port.removeEventListener('message', handle);
        reject(new Error('worklet-ready-timeout'));
      }, WORKLET_READY_TIMEOUT_MS);
      const handle = (event: MessageEvent<unknown>): void => {
        if (isReadyMessage(event.data)) processorReady = true;
        else if (isShiftersReadyMessage(event.data)) {
          shiftersReady = true;
          latency = event.data.latencySamples;
        } else return;
        if (processorReady && shiftersReady) {
          globalThis.clearTimeout(timeout);
          port.removeEventListener('message', handle);
          resolve(latency);
        }
      };
      port.addEventListener('message', handle);
      port.start();
    });
  }
}

export const engine = new AudioEngine();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { globalThis.clearTimeout(timeout); resolve(value); },
      (error: unknown) => { globalThis.clearTimeout(timeout); reject(error); },
    );
  });
}
