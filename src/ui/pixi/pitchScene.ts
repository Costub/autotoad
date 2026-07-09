import {
  Application,
  Container,
  Graphics,
  Text,
  TextureStyle,
  type Ticker,
} from 'pixi.js';
import { degreeOf, freqToMidiFloat } from '../../audio/theory/scales';
import { P } from '../../audio/paramsBus';
import type { KeyConfig } from '../../types';
import { placeholderSprites } from './sprites';
import { drainBubbleEvents } from './bubbleEvents';

const VISIBLE_ROWS = 25;
const ROW_DIVISOR = 26;
const LILYPADS_PER_ROW = 7;
const LILYPAD_SPACING_PX = 110;
const LILYPAD_DRIFT_PX_PER_SECOND = 12;
const TOAD_X_RATIO = 0.3;
const TOAD_SINK_PX = 6;
const TOAD_ALPHA_TAU_SECONDS = 0.1;
const CENTER_TAU_SECONDS = 2;
const CENTER_HISTORY_FRAMES = 180;
const CENTER_MEDIAN_INTERVAL_FRAMES = 30;
const TRACE_POINTS = 256;
const TRACE_X_STEP_PX = 2;
const HARMONY_VOICE_COUNT = 4;
const TADPOLE_FADE_TAU_SECONDS = 0.12;
const TADPOLE_WIGGLE_PX = 2;
const BUBBLE_COUNT = 8;
const MAX_FIREFLIES = 8;
const FIREFLY_Y_PX = 18;
const FIREFLY_SPACING_PX = 22;
const FIREFLY_START_X_PX = 42;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const TADPOLE_NOTE_PARAMS = [
  P.harmonyNote0,
  P.harmonyNote1,
  P.harmonyNote2,
  P.harmonyNote3,
] as const;

interface RowVisual {
  root: Container;
  lilypads: Container[];
  ripple: Container;
  label: Text;
}

interface BubbleVisual {
  graphic: Graphics;
  midi: number;
  velocity: number;
  age: number;
  popping: number;
}

export interface PitchSceneDeps {
  readBus: (index: number) => number;
  getKey: () => KeyConfig;
  getLooper: () => {
    progress: number;
    state: string;
    layers: Array<{ id: number; muted: boolean }>;
  };
}

export interface PitchScene {
  destroy(): void;
}

export function createPitchScene(
  app: Application,
  deps: PitchSceneDeps,
): PitchScene {
  TextureStyle.defaultOptions.scaleMode = 'nearest';

  const width = app.screen.width;
  const height = app.screen.height;
  const rowHeight = height / ROW_DIVISOR;
  const world = new Container();
  const rows = createRows(width);
  const traceGlow = new Graphics();
  const trace = new Graphics();
  const bubbles: BubbleVisual[] = Array.from({ length: BUBBLE_COUNT }, () => ({
    graphic: new Graphics(),
    midi: -1,
    velocity: 0,
    age: -1,
    popping: 0,
  }));
  const ghostToad = placeholderSprites.toadGhost();
  const toad = placeholderSprites.toad();
  const tadpoles = [
    placeholderSprites.tadpole(),
    placeholderSprites.tadpole(),
    placeholderSprites.tadpole(),
    placeholderSprites.tadpole(),
  ] as const;
  const fireflies = Array.from({ length: MAX_FIREFLIES }, () =>
    placeholderSprites.firefly(),
  );
  const armedFirefly = placeholderSprites.firefly();
  const tadpoleAlpha = new Float64Array(HARMONY_VOICE_COUNT);
  const tadpoleY = new Float64Array(HARMONY_VOICE_COUNT);
  const traceY = new Float32Array(TRACE_POINTS);
  const traceVoiced = new Uint8Array(TRACE_POINTS);
  const centerHistory = new Float64Array(CENTER_HISTORY_FRAMES);
  const centerScratch = new Float64Array(CENTER_HISTORY_FRAMES);
  const reducedMotion = globalThis.matchMedia(
    '(prefers-reduced-motion: reduce)',
  ).matches;

  for (const row of rows) {
    world.addChild(row.root);
  }
  world.addChild(traceGlow);
  world.addChild(trace);
  for (const bubble of bubbles) {
    bubble.graphic.visible = false;
    world.addChild(bubble.graphic);
  }
  for (const tadpole of tadpoles) {
    tadpole.visible = false;
    world.addChild(tadpole);
  }
  for (const firefly of fireflies) {
    firefly.visible = false;
    world.addChild(firefly);
  }
  armedFirefly.visible = false;
  world.addChild(armedFirefly);
  world.addChild(ghostToad);
  world.addChild(toad);
  app.stage.addChild(world);

  let centerMidi = 60;
  let centerTargetMidi = 60;
  let centerHistoryCount = 0;
  let centerHistoryWriteIndex = 0;
  let centerMedianFrames = 0;
  let driftPx = 0;
  let traceWriteIndex = 0;
  let traceCount = 0;
  let toadAlpha = 0.25;
  let lastStableNote = -1;
  let hopFramesRemaining = 0;

  const yForMidi = (midi: number): number =>
    height / 2 - (midi - centerMidi) * rowHeight;

  const update = (ticker: Ticker): void => {
    const deltaSeconds = Math.min(ticker.deltaMS / 1000, 0.05);
    const detectedFreq = deps.readBus(P.detectedFreq);
    const correctedFreq = deps.readBus(P.correctedFreq);
    const smoothedMidi = deps.readBus(P.smoothedMidi);
    const stableNote = deps.readBus(P.stableNote);
    const hardRetune = deps.readBus(P.retuneMs) <= 1;
    const voiced = detectedFreq > 0 && smoothedMidi > 0;
    const looper = deps.getLooper();

    if (voiced) {
      centerHistory[centerHistoryWriteIndex] = smoothedMidi;
      centerHistoryWriteIndex =
        (centerHistoryWriteIndex + 1) % CENTER_HISTORY_FRAMES;
      centerHistoryCount = Math.min(
        CENTER_HISTORY_FRAMES,
        centerHistoryCount + 1,
      );
      centerMedianFrames += 1;
      if (centerMedianFrames >= CENTER_MEDIAN_INTERVAL_FRAMES) {
        centerMedianFrames = 0;
        centerTargetMidi = medianOfHistory(
          centerHistory,
          centerScratch,
          centerHistoryCount,
        );
      }
    }

    const centerAlpha = 1 - Math.exp(-deltaSeconds / CENTER_TAU_SECONDS);
    centerMidi += (centerTargetMidi - centerMidi) * centerAlpha;
    if (!reducedMotion) {
      driftPx =
        (driftPx + LILYPAD_DRIFT_PX_PER_SECOND * deltaSeconds) %
        LILYPAD_SPACING_PX;
    }

    updateRows(rows, deps.getKey(), centerMidi, rowHeight, driftPx, height);

    const toadX = width * TOAD_X_RATIO;
    const toadY = voiced
      ? yForMidi(smoothedMidi)
      : yForMidi(centerMidi) + TOAD_SINK_PX;
    const targetAlpha = voiced ? 1 : 0.25;
    const alphaAmount =
      1 - Math.exp(-deltaSeconds / TOAD_ALPHA_TAU_SECONDS);
    toadAlpha += (targetAlpha - toadAlpha) * alphaAmount;
    if (
      voiced &&
      hardRetune &&
      stableNote >= 0 &&
      lastStableNote >= 0 &&
      stableNote !== lastStableNote
    ) {
      hopFramesRemaining = 2;
    }
    if (stableNote >= 0) {
      lastStableNote = stableNote;
    }

    const squashFrame = hopFramesRemaining === 2;
    const toadBob = reducedMotion
      ? 0
      : Math.sin(app.ticker.lastTime * 0.006) * (voiced ? 1.8 : 0.7);
    toad.scale.y = squashFrame ? 0.65 : 1;
    toad.position.set(toadX, toadY + (squashFrame ? 4 : 0) + toadBob);
    toad.rotation = reducedMotion ? 0 : Math.sin(app.ticker.lastTime * 0.004) * 0.045;
    toad.alpha = toadAlpha;
    if (hopFramesRemaining > 0) {
      hopFramesRemaining -= 1;
    }

    for (const event of drainBubbleEvents()) {
      if (event.type === 'off') {
        const bubble = bubbles.find((candidate) => candidate.age >= 0 && candidate.midi === event.midi);
        if (bubble) {
          bubble.popping = 1;
          bubble.velocity = 0;
        }
        continue;
      }
      const bubble = bubbles.find((candidate) => candidate.age < 0) ??
        bubbles.reduce((oldest, candidate) => candidate.age > oldest.age ? candidate : oldest);
      bubble.midi = event.midi;
      bubble.velocity = event.velocity;
      bubble.age = 0;
      bubble.popping = 0;
      bubble.graphic.position.set(toadX + 7, toadY - 4);
    }
    for (const bubble of bubbles) {
      if (bubble.age < 0) continue;
      bubble.age += deltaSeconds;
      bubble.graphic.clear();
      const radius = 8 + (bubble.velocity / 127) * 12;
      const wasPopping = bubble.popping > 0;
      if (wasPopping) {
        bubble.graphic
          .star(0, 0, 6, radius * 1.35, radius * 0.35)
          .stroke({ width: 2, color: 0x5dcb6a, alpha: 0.9 });
        bubble.popping -= 1;
      } else {
        bubble.graphic
          .circle(0, 0, radius * 1.45)
          .fill({ color: 0x5dcb6a, alpha: Math.max(0, 0.12 - bubble.age * 0.035) })
          .circle(0, 0, radius)
          .stroke({ width: 2, color: 0x5dcb6a, alpha: Math.max(0, 0.75 - bubble.age * 0.25) });
      }
      bubble.graphic.visible = true;
      if (!reducedMotion) {
        bubble.graphic.x -= deltaSeconds * 15;
        bubble.graphic.y -= deltaSeconds * 28;
      }
      if (!wasPopping && (bubble.age > 3 || bubble.velocity === 0)) {
        bubble.graphic.visible = false;
        bubble.age = -1;
      }
    }

    if (voiced && correctedFreq > 0) {
      ghostToad.visible = true;
      ghostToad.position.set(toadX, yForMidi(freqToMidiFloat(correctedFreq)));
      ghostToad.alpha = 0.35;
    } else {
      ghostToad.visible = false;
    }

    const tadpoleAlphaAmount =
      1 - Math.exp(-deltaSeconds / TADPOLE_FADE_TAU_SECONDS);
    for (
      let voiceIndex = 0;
      voiceIndex < HARMONY_VOICE_COUNT;
      voiceIndex += 1
    ) {
      const harmonyNote = deps.readBus(TADPOLE_NOTE_PARAMS[voiceIndex]!);
      const active = harmonyNote >= 0;
      const currentTadpoleAlpha = tadpoleAlpha[voiceIndex]!;
      tadpoleAlpha[voiceIndex] =
        currentTadpoleAlpha +
        ((active ? 1 : 0) - currentTadpoleAlpha) * tadpoleAlphaAmount;
      if (active) {
        tadpoleY[voiceIndex] = yForMidi(harmonyNote);
      }

      const tadpole = tadpoles[voiceIndex]!;
      tadpole.visible = tadpoleAlpha[voiceIndex]! > 0.001;
      tadpole.alpha = tadpoleAlpha[voiceIndex]!;
      const wiggle = reducedMotion
        ? 0
        : Math.sin(app.ticker.lastTime * 0.003 + voiceIndex * 1.7) *
          TADPOLE_WIGGLE_PX;
      tadpole.position.set(
        toadX - 24 - voiceIndex * 10 + wiggle,
        tadpoleY[voiceIndex]!,
      );
    }

    updateFireflies(
      fireflies,
      armedFirefly,
      looper,
      app.ticker.lastTime,
    );

    traceY[traceWriteIndex] = voiced ? yForMidi(smoothedMidi) : toadY;
    traceVoiced[traceWriteIndex] = voiced ? 1 : 0;
    traceWriteIndex = (traceWriteIndex + 1) % TRACE_POINTS;
    traceCount = Math.min(TRACE_POINTS, traceCount + 1);
    drawTrace(
      traceGlow,
      traceY,
      traceVoiced,
      traceWriteIndex,
      traceCount,
      toadX,
      true,
    );
    drawTrace(
      trace,
      traceY,
      traceVoiced,
      traceWriteIndex,
      traceCount,
      toadX,
    );
  };

  app.ticker.add(update);

  return {
    destroy(): void {
      app.ticker.remove(update);
      app.stage.removeChild(world);
      world.destroy({ children: true });
    },
  };
}

function createRows(width: number): RowVisual[] {
  const rows: RowVisual[] = [];
  for (let rowIndex = 0; rowIndex < VISIBLE_ROWS; rowIndex += 1) {
    const root = new Container();
    const lilypads: Container[] = [];
    for (
      let lilypadIndex = 0;
      lilypadIndex < LILYPADS_PER_ROW;
      lilypadIndex += 1
    ) {
      const lilypad = placeholderSprites.lilypad();
      root.addChild(lilypad);
      lilypads.push(lilypad);
    }
    const ripple = placeholderSprites.ripple();
    ripple.scale.x = width / 24;
    root.addChild(ripple);
    const label = new Text({
      text: '',
      style: {
        fill: 0x8fa6a3,
        fontFamily: 'monospace',
        fontSize: 11,
        fontWeight: '500',
      },
    });
    label.anchor.set(0, 0.5);
    label.position.set(8, 0);
    root.addChild(label);
    rows.push({ root, lilypads, ripple, label });
  }
  return rows;
}

function noteLabel(midi: number): string {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12] ?? 'C';
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

function updateRows(
  rows: RowVisual[],
  key: KeyConfig,
  centerMidi: number,
  rowHeight: number,
  driftPx: number,
  height: number,
): void {
  const centerRow = Math.round(centerMidi);
  const firstMidi = centerRow + Math.floor(VISIBLE_ROWS / 2);

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    const midi = firstMidi - rowIndex;
    const inScale = degreeOf(midi, key) >= 0;
    row.root.y = height / 2 - (midi - centerMidi) * rowHeight;
    row.ripple.visible = !inScale;
    row.label.text = noteLabel(midi);
    row.label.alpha = inScale ? 0.74 : 0.32;

    for (
      let lilypadIndex = 0;
      lilypadIndex < row.lilypads.length;
      lilypadIndex += 1
    ) {
      const lilypad = row.lilypads[lilypadIndex]!;
      lilypad.visible = inScale;
      lilypad.x =
        -LILYPAD_SPACING_PX / 2 +
        lilypadIndex * LILYPAD_SPACING_PX -
        driftPx;
      lilypad.y = Math.sin((driftPx + lilypadIndex * 29 + rowIndex * 17) * 0.04) * 1.4;
      lilypad.rotation = Math.sin((driftPx + lilypadIndex * 19) * 0.025) * 0.04;
    }
  }
}

function medianOfHistory(
  history: Float64Array,
  scratch: Float64Array,
  count: number,
): number {
  for (let index = 0; index < count; index += 1) {
    scratch[index] = history[index]!;
  }
  for (let index = 1; index < count; index += 1) {
    const value = scratch[index]!;
    let cursor = index - 1;
    while (cursor >= 0 && scratch[cursor]! > value) {
      scratch[cursor + 1] = scratch[cursor]!;
      cursor -= 1;
    }
    scratch[cursor + 1] = value;
  }
  return count > 0 ? scratch[Math.floor(count / 2)]! : 60;
}

function drawTrace(
  trace: Graphics,
  yValues: Float32Array,
  voicedValues: Uint8Array,
  writeIndex: number,
  count: number,
  toadX: number,
  glow = false,
): void {
  trace.clear();
  let drawing = false;
  for (let age = count - 1; age >= 0; age -= 1) {
    const index = (writeIndex - 1 - age + TRACE_POINTS) % TRACE_POINTS;
    if (voicedValues[index] === 0) {
      drawing = false;
      continue;
    }
    const x = toadX - age * TRACE_X_STEP_PX;
    const y = yValues[index]!;
    if (!drawing) {
      trace.moveTo(x, y);
      drawing = true;
    } else {
      trace.lineTo(x, y);
    }
  }
  trace.stroke(glow
    ? { width: 10, color: 0x5dcb6a, alpha: 0.16 }
    : { width: 2, color: 0xbdf0a5, alpha: 0.72 });
}

function updateFireflies(
  fireflies: Container[],
  armedFirefly: Container,
  looper: {
    progress: number;
    state: string;
    layers: Array<{ id: number; muted: boolean }>;
  },
  timeMs: number,
): void {
  const boundaryDistance = Math.min(looper.progress, 1 - looper.progress);
  const pulse = Math.exp(-boundaryDistance * 70);
  for (let index = 0; index < fireflies.length; index += 1) {
    const firefly = fireflies[index]!;
    const layer = looper.layers[index];
    firefly.visible = layer !== undefined;
    if (!layer) continue;
    firefly.position.set(
      FIREFLY_START_X_PX + index * FIREFLY_SPACING_PX,
      FIREFLY_Y_PX,
    );
    firefly.alpha = (layer.muted ? 0.25 : 0.72) + (layer.muted ? 0 : pulse * 0.28);
    const scale = 1 + pulse * (layer.muted ? 0.25 : 1.15);
    firefly.scale.set(scale);
  }

  const armed = looper.state === 'armed' || looper.state === 'recording';
  armedFirefly.visible = armed;
  if (armed) {
    const index = Math.min(looper.layers.length, fireflies.length - 1);
    const blink = looper.state === 'recording'
      ? 1
      : 0.45 + Math.sin(timeMs * 0.012) * 0.35;
    armedFirefly.position.set(
      FIREFLY_START_X_PX + index * FIREFLY_SPACING_PX,
      FIREFLY_Y_PX,
    );
    armedFirefly.alpha = Math.max(0.2, blink);
    armedFirefly.scale.set(looper.state === 'recording' ? 1.8 : 1.25);
  }
}
