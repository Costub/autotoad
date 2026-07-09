import {
  HandLandmarker,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';
import visionWasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import visionWasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import { computeHandFrame, type LandmarkPoint } from './gestureMath';
import type { GestureFrame } from '../types';

interface FrameMessage {
  type: 'frame';
  bitmap: ImageBitmap;
  t: number;
}

type WorkerInbound = FrameMessage;

interface HandHistory {
  pinchClosed: boolean;
  indexTip: { x: number; y: number };
  t: number;
}

let landmarker: HandLandmarker | null = null;
let initializing: Promise<void> | null = null;
let frameCount = 0;
const previousByHand = new Map<'Left' | 'Right', HandHistory>();

self.addEventListener('message', (event: MessageEvent<WorkerInbound>) => {
  if (event.data.type !== 'frame') return;
  void handleFrame(event.data);
});

async function ensureLandmarker(): Promise<void> {
  if (landmarker) return;
  initializing ??= (async () => {
    const origin = self.location.origin;
    const modelUrl = new URL('/mediapipe/hand_landmarker.task', origin).toString();
    landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: modelUrl,
      },
      runningMode: 'VIDEO',
      numHands: 2,
    });
    self.postMessage({ type: 'ready' });
  })();
  await initializing;
}

const fileset = {
  wasmLoaderPath: visionWasmLoaderUrl,
  wasmBinaryPath: visionWasmBinaryUrl,
};

async function handleFrame(message: FrameMessage): Promise<void> {
  try {
    await ensureLandmarker();
    const result = landmarker!.detectForVideo(message.bitmap, message.t);
    message.bitmap.close();
    frameCount += 1;
    const hands: GestureFrame['hands'] = [];
    const landmarksForUi: Array<{ handedness: 'Left' | 'Right'; points: LandmarkPoint[] }> = [];
    for (let index = 0; index < result.landmarks.length; index += 1) {
      const handedness =
        result.handedness[index]?.[0]?.categoryName === 'Left' ? 'Left' : 'Right';
      const landmarks = result.landmarks[index]!.map(toPoint);
      const mirroredHand = handedness === 'Left' ? 'Right' : 'Left';
      const previous = previousByHand.get(mirroredHand);
      const hand = computeHandFrame(landmarks, handedness, previous ?? null, message.t);
      if (!hand) continue;
      hands.push(hand);
      previousByHand.set(hand.handedness, {
        pinchClosed: hand.pinchClosed,
        indexTip: hand.indexTip,
        t: message.t,
      });
      if (frameCount % 2 === 0) {
        landmarksForUi.push({ handedness: hand.handedness, points: landmarks });
      }
    }
    self.postMessage({
      type: 'gesture-frame',
      frame: { t: message.t, hands },
      landmarks: landmarksForUi,
    });
  } catch (error) {
    message.bitmap.close();
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Hand tracking failed',
    });
  }
}

function toPoint(point: NormalizedLandmark): LandmarkPoint {
  return { x: point.x, y: point.y, z: point.z };
}
