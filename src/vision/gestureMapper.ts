import { engine } from '../audio/engine';
import { useStore, type AppState } from '../state/store';
import type { GestureFrame, InstrumentName } from '../types';
import {
  GestureMapperCore,
  type GestureOutput,
  type GestureSnapshot,
  type HudItem,
  type LandmarkPoint,
} from './gestureMath';

interface WorkerGestureMessage {
  type: 'gesture-frame';
  frame: GestureFrame;
  landmarks: Array<{ handedness: 'Left' | 'Right'; points: LandmarkPoint[] }>;
}

interface WorkerReadyMessage {
  type: 'ready';
}

interface WorkerErrorMessage {
  type: 'error';
  message: string;
}

type WorkerMessage = WorkerGestureMessage | WorkerReadyMessage | WorkerErrorMessage;

export const gestureRuntime = {
  status: 'Gestures off',
  video: null as HTMLVideoElement | null,
  landmarks: [] as Array<{ handedness: 'Left' | 'Right'; points: LandmarkPoint[] }>,
  hud: [] as HudItem[],
  xy: null as GestureOutput['xy'],
  active: false,
};

const listeners = new Set<() => void>();
const INSTRUMENTS: InstrumentName[] = ['chiptune', 'fmBass', 'pluck', 'choirPad'];
const SMOOTH_TAU_MS = 80;
let worker: Worker | null = null;
let mapper: GestureMapperCore | null = null;
let frameLoopStarted = false;
let inFlight = false;
let rafId: number | null = null;
let lastRafTime = 0;
let targetUpdates: Partial<GestureSnapshot> = {};
let smoothed: Partial<GestureSnapshot> = {};
let lastHeldJson = '{}';

export function addGestureRuntimeListener(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function warmupVisionAssets(): Promise<'ready' | 'missing'> {
  try {
    const [model] = await Promise.all([
      fetch('/mediapipe/hand_landmarker.task', { cache: 'force-cache' }),
      fetch('/mediapipe/wasm/vision_wasm_internal.wasm', { cache: 'force-cache' }),
    ]);
    return model.ok ? 'ready' : 'missing';
  } catch {
    return 'missing';
  }
}

export async function startVision(): Promise<void> {
  if (gestureRuntime.active || worker) return;
  const assets = await warmupVisionAssets();
  if (assets === 'missing') {
    setVisionStatus('Hand tracking model missing — see public/mediapipe/README');
    useStore.getState().set({ gestureStatus: gestureRuntime.status, gesturesEnabled: false });
    return;
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { max: 480 }, height: { max: 360 }, frameRate: { max: 30 } },
      audio: false,
    });
  } catch {
    setVisionStatus('Gestures off — webcam unavailable');
    useStore.getState().set({ gestureStatus: gestureRuntime.status, gesturesEnabled: false });
    return;
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;
  video.style.position = 'fixed';
  video.style.width = '1px';
  video.style.height = '1px';
  video.style.opacity = '0';
  video.style.pointerEvents = 'none';
  video.style.left = '-2px';
  video.style.bottom = '0';
  document.body.appendChild(video);
  await video.play();
  gestureRuntime.video = video;
  mapper = new GestureMapperCore();
  worker = new Worker(new URL('./handWorker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', handleWorkerMessage);
  gestureRuntime.active = true;
  setVisionStatus('Gestures warming up');
  useStore.getState().set({ gesturesEnabled: true, gestureStatus: gestureRuntime.status });
  startFramePump(video);
  startSmoothingLoop();
}

function handleWorkerMessage(event: MessageEvent<WorkerMessage>): void {
  inFlight = false;
  if (event.data.type === 'ready') {
    setVisionStatus('Gestures ready');
    useStore.getState().set({ gestureStatus: gestureRuntime.status });
    return;
  }
  if (event.data.type === 'error') {
    setVisionStatus(event.data.message.includes('hand_landmarker')
      ? 'Hand tracking model missing — see public/mediapipe/README'
      : `Gestures off — ${event.data.message}`);
    useStore.getState().set({ gestureStatus: gestureRuntime.status, gesturesEnabled: false });
    return;
  }
  const output = mapper?.process(event.data.frame, snapshotFromStore(useStore.getState()));
  if (!output) return;
  applyDiscreteEvents(output);
  targetUpdates = { ...targetUpdates, ...output.updates };
  gestureRuntime.landmarks = event.data.landmarks;
  gestureRuntime.hud = output.hud;
  gestureRuntime.xy = output.xy;
  const heldJson = JSON.stringify(output.held);
  if (heldJson !== lastHeldJson) {
    lastHeldJson = heldJson;
    useStore.getState().set({ gestureHeld: output.held });
  }
  emitRuntime();
}

function startFramePump(video: HTMLVideoElement): void {
  if (frameLoopStarted) return;
  frameLoopStarted = true;
  const pump = async (now: number): Promise<void> => {
    if (!worker || !gestureRuntime.active) return;
    if (!inFlight && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      try {
        inFlight = true;
        const bitmap = await createImageBitmap(video);
        worker.postMessage({ type: 'frame', bitmap, t: now }, [bitmap]);
      } catch {
        inFlight = false;
      }
    }
    scheduleNextVideoFrame(video, pump);
  };
  scheduleNextVideoFrame(video, pump);
}

function scheduleNextVideoFrame(
  video: HTMLVideoElement,
  callback: (now: number) => void | Promise<void>,
): void {
  if ('requestVideoFrameCallback' in video) {
    video.requestVideoFrameCallback((now) => {
      void callback(now);
    });
  } else {
    requestAnimationFrame((now) => {
      void callback(now);
    });
  }
}

function startSmoothingLoop(): void {
  if (rafId !== null) return;
  const tick = (time: number): void => {
    const dt = lastRafTime === 0 ? 16.7 : Math.min(50, time - lastRafTime);
    lastRafTime = time;
    const alpha = 1 - Math.exp(-dt / SMOOTH_TAU_MS);
    const next: Partial<AppState> = {};
    for (const [key, target] of Object.entries(targetUpdates)) {
      if (typeof target !== 'number') {
        (next as Record<string, unknown>)[key] = target;
        continue;
      }
      const current = typeof smoothed[key as keyof GestureSnapshot] === 'number'
        ? smoothed[key as keyof GestureSnapshot] as number
        : Number((useStore.getState() as unknown as Record<string, number>)[key]);
      const value = current + (target - current) * alpha;
      (smoothed as Record<string, number>)[key] = value;
      (next as Record<string, number>)[key] = value;
    }
    if (Object.keys(next).length > 0) {
      if (typeof next.wetLevel === 'number') next.dryLevel = 1 - next.wetLevel;
      useStore.getState().set(next);
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function applyDiscreteEvents(output: GestureOutput): void {
  const state = useStore.getState();
  for (const event of output.events) {
    if (event === 'recordToggle') {
      engine.toggleLoopRecord();
    } else if (event === 'panic') {
      engine.panic();
    } else if (event === 'instrumentPrev' || event === 'instrumentNext') {
      const current = INSTRUMENTS.indexOf(state.instrument);
      const delta = event === 'instrumentNext' ? 1 : -1;
      const next = INSTRUMENTS[(current + delta + INSTRUMENTS.length) % INSTRUMENTS.length]!;
      state.set({ instrument: next });
    }
  }
}

function snapshotFromStore(state: AppState): GestureSnapshot {
  return {
    retuneMs: state.retuneMs,
    formantShift: state.formantShift,
    wetLevel: state.wetLevel,
    dryLevel: state.dryLevel,
    pitchShift: state.pitchShift,
    harmonySpread: state.harmonySpread,
    harmonyPreset: state.harmonyPreset,
    reverbDecay: state.reverbDecay,
    reverbSend: state.reverbSend,
    delayTime: state.delayTime,
    delayFeedback: state.delayFeedback,
    instrument: state.instrument,
    engineMode: state.engineMode,
    xyPadMode: state.xyPadMode,
  };
}

function setVisionStatus(status: string): void {
  gestureRuntime.status = status;
  emitRuntime();
}

function emitRuntime(): void {
  for (const listener of listeners) listener();
}
