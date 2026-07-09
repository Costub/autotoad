import type {
  DelayDivision,
  EngineMode,
  GestureFrame,
  HarmonyPresetName,
  HandFrame,
  InstrumentName,
} from '../types';

export interface LandmarkPoint {
  x: number;
  y: number;
  z?: number;
}

export interface GestureSnapshot {
  retuneMs: number;
  formantShift: number;
  wetLevel: number;
  dryLevel: number;
  pitchShift: number;
  harmonySpread: number;
  harmonyPreset: HarmonyPresetName;
  reverbDecay: number;
  reverbSend: number;
  delayTime: DelayDivision;
  delayFeedback: number;
  instrument: InstrumentName;
  engineMode: EngineMode;
  xyPadMode: boolean;
}

export interface GestureOutput {
  updates: Partial<GestureSnapshot>;
  events: Array<'recordToggle' | 'panic' | 'instrumentPrev' | 'instrumentNext'>;
  held: Record<string, boolean>;
  hud: HudItem[];
  xy: { x: number; y: number } | null;
}

export interface HudItem {
  hand: 'Left' | 'Right';
  param: string;
  value: string;
}

interface HandRuntime {
  presentSince: number;
  lastSeen: number;
  pinchClosed: boolean;
  wasPinching: boolean;
  owner: GestureOwner;
  grabY: number;
  grabValue: number;
  grabParam: keyof GestureSnapshot | '';
  grabRange: RangeSpec | null;
  lastGrabHeight: number;
  lastGrabTime: number;
  slideAnchorX: number;
  slideAnchorValue: number;
  slideStableSince: number;
  lastFlickAt: number;
  fistSince: number | null;
  recordFiredForHold: boolean;
  stableFingers: number;
  fingersSince: number;
  pitchZone: -12 | 0 | 12;
}

type GestureOwner = 'none' | 'fist' | 'grab' | 'xy' | 'slide' | 'ambient';

interface RangeSpec {
  min: number;
  max: number;
}

const PINCH_CLOSE = 0.25;
const PINCH_OPEN = 0.35;
const HAND_ENTRY_GUARD_MS = 500;
const FINGER_STABLE_MS = 250;
const FIST_RECORD_MS = 300;
const BOTH_FISTS_MS = 500;
const RECORD_REFRACTORY_MS = 800;
const PANIC_REFRACTORY_MS = 800;
const FLICK_REFRACTORY_MS = 400;
const FLICK_THRESHOLD = 2.5;
const SLIDE_DEADZONE = 0.03;
const SLIDE_STILLNESS = 0.005;
const SLIDE_REANCHOR_MS = 150;
const DELAY_DIVISIONS: DelayDivision[] = ['8n', '8n.', '4n', '2n'];
const HARMONY_BY_FINGERS: HarmonyPresetName[] = [
  'off',
  'duet',
  'triad',
  'choir',
  'octaves',
];

export function updatePinchClosed(previous: boolean, pinch: number): boolean {
  if (previous) return pinch <= PINCH_OPEN;
  return pinch < PINCH_CLOSE;
}

export function grabFaderTarget(
  grabValue: number,
  grabY: number,
  height: number,
  range: RangeSpec,
): number {
  return clamp(
    grabValue + ((height - grabY) / 0.5) * (range.max - range.min),
    range.min,
    range.max,
  );
}

export function fingerSlideTarget(
  anchorValue: number,
  anchorX: number,
  currentX: number,
  range: RangeSpec,
): number {
  const dx = currentX - anchorX;
  if (Math.abs(dx) < SLIDE_DEADZONE) return anchorValue;
  return clamp(anchorValue + dx * (range.max - range.min), range.min, range.max);
}

export function computeHandFrame(
  landmarks: LandmarkPoint[],
  handedness: 'Left' | 'Right',
  previous: { pinchClosed: boolean; indexTip: { x: number; y: number }; t: number } | null,
  t: number,
): HandFrame | null {
  const wrist = landmarks[0];
  const thumbTip = landmarks[4];
  const indexTipRaw = landmarks[8];
  const middleMcp = landmarks[9];
  if (!wrist || !thumbTip || !indexTipRaw || !middleMcp) return null;
  const handScale = Math.max(0.001, distance(wrist, middleMcp));
  const indexTip = { x: 1 - indexTipRaw.x, y: 1 - indexTipRaw.y };
  const pinch = clamp(distance(thumbTip, indexTipRaw) / (handScale * 2.2), 0, 1);
  const pinchClosed = updatePinchClosed(previous?.pinchClosed ?? false, pinch);
  const dt = Math.max(1, t - (previous?.t ?? t - 33)) / 1000;
  const velocity = previous
    ? {
        dx: ((indexTip.x - previous.indexTip.x) / dt) * 0.55,
        dy: ((indexTip.y - previous.indexTip.y) / dt) * 0.55,
      }
    : { dx: 0, dy: 0 };
  const fingersUp =
    fingerUp(landmarks, 8, 6) +
    fingerUp(landmarks, 12, 10) +
    fingerUp(landmarks, 16, 14) +
    fingerUp(landmarks, 20, 18) +
    thumbUp(landmarks, handedness);
  return {
    handedness: handedness === 'Left' ? 'Right' : 'Left',
    pinch,
    pinchClosed,
    height: 1 - wrist.y,
    x: 1 - wrist.x,
    indexTip,
    velocity,
    fingersUp,
    fist: fingersUp === 0,
  };
}

export class GestureMapperCore {
  private readonly hands = new Map<'Left' | 'Right', HandRuntime>();
  private bothFistsSince: number | null = null;
  private lastPanicAt = -Infinity;

  process(frame: GestureFrame, snapshot: GestureSnapshot): GestureOutput {
    const output: GestureOutput = { updates: {}, events: [], held: {}, hud: [], xy: null };
    const left = frame.hands.find((hand) => hand.handedness === 'Left');
    const right = frame.hands.find((hand) => hand.handedness === 'Right');
    this.expireMissingHands(frame);

    if (left?.fist && right?.fist) {
      this.bothFistsSince ??= frame.t;
      if (
        frame.t - this.bothFistsSince >= BOTH_FISTS_MS &&
        frame.t - this.lastPanicAt >= PANIC_REFRACTORY_MS
      ) {
        output.events.push('panic');
        this.lastPanicAt = frame.t;
      }
    } else {
      this.bothFistsSince = null;
    }

    for (const hand of frame.hands) {
      this.processHand(hand, frame.t, snapshot, output);
    }
    return output;
  }

  private processHand(
    hand: HandFrame,
    t: number,
    snapshot: GestureSnapshot,
    output: GestureOutput,
  ): void {
    const runtime = this.runtimeFor(hand, t);
    runtime.lastSeen = t;
    runtime.pinchClosed = updatePinchClosed(runtime.pinchClosed, hand.pinch);

    if (hand.fist) {
      runtime.owner = 'fist';
      runtime.fistSince ??= t;
      runtime.wasPinching = runtime.pinchClosed;
      output.held[`${hand.handedness}:fist`] = true;
      output.hud.push({ hand: hand.handedness, param: 'fist', value: 'hold' });
      if (
        hand.handedness === 'Right' &&
        t - runtime.fistSince >= FIST_RECORD_MS &&
        !runtime.recordFiredForHold &&
        t - runtime.lastFlickAt >= RECORD_REFRACTORY_MS
      ) {
        output.events.push('recordToggle');
        runtime.recordFiredForHold = true;
        runtime.lastFlickAt = t;
      }
      return;
    }

    runtime.fistSince = null;
    runtime.recordFiredForHold = false;

    if (hand.handedness === 'Right' && snapshot.xyPadMode) {
      runtime.owner = 'xy';
      output.updates.delayFeedback = clamp(hand.indexTip.x * 0.75, 0, 0.75);
      output.updates.reverbSend = clamp(hand.indexTip.y, 0, 1);
      output.held.delayFeedback = true;
      output.held.reverbSend = true;
      output.xy = { x: hand.indexTip.x, y: hand.indexTip.y };
      output.hud.push({
        hand: 'Right',
        param: 'xy',
        value: `${Math.round(hand.indexTip.x * 100)}:${Math.round(hand.indexTip.y * 100)}`,
      });
      runtime.wasPinching = runtime.pinchClosed;
      return;
    }

    if (runtime.pinchClosed) {
      if (!runtime.wasPinching || runtime.owner !== 'grab') {
        const grab = grabBinding(hand.handedness, snapshot);
        runtime.grabY = hand.height;
        runtime.grabValue = grab.value;
        runtime.grabParam = grab.param;
        runtime.grabRange = grab.range;
        runtime.lastGrabHeight = hand.height;
        runtime.lastGrabTime = t;
      }
      runtime.owner = 'grab';
      if (runtime.grabRange && runtime.grabParam) {
        const value = grabFaderTarget(
          runtime.grabValue,
          runtime.grabY,
          hand.height,
          runtime.grabRange,
        );
        output.updates[runtime.grabParam] = value as never;
        output.held[runtime.grabParam] = true;
        output.hud.push({
          hand: hand.handedness,
          param: labelForParam(runtime.grabParam),
          value: formatGestureValue(runtime.grabParam, value),
        });
      }
      runtime.lastGrabHeight = hand.height;
      runtime.lastGrabTime = t;
      runtime.wasPinching = true;
      return;
    }

    if (runtime.wasPinching) {
      runtime.grabParam = '';
      runtime.grabRange = null;
    }
    runtime.wasPinching = false;

    const openHand = hand.fingersUp >= 3;
    if (hand.handedness === 'Right' && openHand && Math.abs(hand.velocity.dx) > FLICK_THRESHOLD) {
      if (t - runtime.lastFlickAt >= FLICK_REFRACTORY_MS) {
        output.events.push(hand.velocity.dx > 0 ? 'instrumentNext' : 'instrumentPrev');
        runtime.lastFlickAt = t;
        output.hud.push({ hand: 'Right', param: 'flick', value: hand.velocity.dx > 0 ? 'next' : 'prev' });
      }
      runtime.owner = 'slide';
      return;
    }

    if (openHand) {
      const slide = slideBinding(hand.handedness, snapshot);
      if (runtime.owner !== 'slide') {
        runtime.slideAnchorX = hand.indexTip.x;
        runtime.slideAnchorValue = slide.value;
        runtime.slideStableSince = t;
      }
      runtime.owner = 'slide';
      const value = fingerSlideTarget(
        runtime.slideAnchorValue,
        runtime.slideAnchorX,
        hand.indexTip.x,
        slide.range,
      );
      if (slide.param === 'delayTimeIndex') {
        output.updates.delayTime = DELAY_DIVISIONS[Math.round(value)] ?? '8n.';
        output.held.delayTime = true;
        output.hud.push({ hand: hand.handedness, param: 'delay', value: output.updates.delayTime });
      } else {
        output.updates[slide.param] = value as never;
        output.held[slide.param] = true;
        output.hud.push({
          hand: hand.handedness,
          param: labelForParam(slide.param),
          value: formatGestureValue(slide.param, value),
        });
      }
      if (Math.abs(hand.indexTip.x - runtime.slideAnchorX) < SLIDE_STILLNESS) {
        if (t - runtime.slideStableSince >= SLIDE_REANCHOR_MS) {
          runtime.slideAnchorX = hand.indexTip.x;
          runtime.slideAnchorValue = value;
          runtime.slideStableSince = t;
        }
      } else {
        runtime.slideStableSince = t;
      }
      return;
    }

    if (t - runtime.presentSince < HAND_ENTRY_GUARD_MS) {
      runtime.owner = 'none';
      return;
    }

    runtime.owner = 'ambient';
    if (hand.handedness === 'Right') {
      output.updates.wetLevel = clamp(1 - hand.pinch, 0, 1);
      output.updates.dryLevel = 1 - output.updates.wetLevel;
      output.updates.pitchShift = pitchZone(hand.height, runtime.pitchZone);
      runtime.pitchZone = output.updates.pitchShift as -12 | 0 | 12;
      output.held.wetLevel = true;
      output.held.pitchShift = true;
      output.hud.push({
        hand: 'Right',
        param: 'mix/oct',
        value: `${Math.round(output.updates.wetLevel * 100)}% ${output.updates.pitchShift}`,
      });
    } else {
      output.updates.harmonySpread = clamp(hand.height, 0, 1);
      output.held.harmonySpread = true;
      if (hand.fingersUp !== runtime.stableFingers) {
        runtime.stableFingers = hand.fingersUp;
        runtime.fingersSince = t;
      } else if (t - runtime.fingersSince >= FINGER_STABLE_MS) {
        output.updates.harmonyPreset =
          HARMONY_BY_FINGERS[Math.max(0, Math.min(4, hand.fingersUp))] ?? 'off';
        output.held.harmonyPreset = true;
      }
      output.hud.push({
        hand: 'Left',
        param: 'spread',
        value: `${Math.round((output.updates.harmonySpread ?? snapshot.harmonySpread) * 100)}%`,
      });
    }
  }

  private runtimeFor(hand: HandFrame, t: number): HandRuntime {
    const existing = this.hands.get(hand.handedness);
    if (existing) return existing;
    const created: HandRuntime = {
      presentSince: t,
      lastSeen: t,
      pinchClosed: hand.pinchClosed,
      wasPinching: false,
      owner: 'none',
      grabY: hand.height,
      grabValue: 0,
      grabParam: '',
      grabRange: null,
      lastGrabHeight: hand.height,
      lastGrabTime: t,
      slideAnchorX: hand.indexTip.x,
      slideAnchorValue: 0,
      slideStableSince: t,
      lastFlickAt: -Infinity,
      fistSince: null,
      recordFiredForHold: false,
      stableFingers: hand.fingersUp,
      fingersSince: t,
      pitchZone: 0,
    };
    this.hands.set(hand.handedness, created);
    return created;
  }

  private expireMissingHands(frame: GestureFrame): void {
    const seen = new Set(frame.hands.map((hand) => hand.handedness));
    for (const hand of this.hands.keys()) {
      if (!seen.has(hand)) {
        this.hands.delete(hand);
      }
    }
  }
}

function grabBinding(
  hand: 'Left' | 'Right',
  snapshot: GestureSnapshot,
): { param: keyof GestureSnapshot; value: number; range: RangeSpec } {
  if (hand === 'Left') {
    return { param: 'formantShift', value: snapshot.formantShift, range: { min: -12, max: 12 } };
  }
  return { param: 'retuneMs', value: snapshot.retuneMs, range: { min: 0, max: 400 } };
}

function slideBinding(
  hand: 'Left' | 'Right',
  snapshot: GestureSnapshot,
): { param: keyof GestureSnapshot | 'delayTimeIndex'; value: number; range: RangeSpec } {
  if (hand === 'Left') {
    return { param: 'reverbDecay', value: snapshot.reverbDecay, range: { min: 0.5, max: 8 } };
  }
  return {
    param: 'delayTimeIndex',
    value: DELAY_DIVISIONS.indexOf(snapshot.delayTime),
    range: { min: 0, max: 3 },
  };
}

function pitchZone(height: number, previous: -12 | 0 | 12): -12 | 0 | 12 {
  if (previous === -12 && height < 0.38) return -12;
  if (previous === 12 && height > 0.61) return 12;
  if (height < 0.33) return -12;
  if (height > 0.66) return 12;
  return 0;
}

function fingerUp(landmarks: LandmarkPoint[], tip: number, pip: number): 0 | 1 {
  const tipPoint = landmarks[tip];
  const pipPoint = landmarks[pip];
  return tipPoint && pipPoint && tipPoint.y < pipPoint.y - 0.02 ? 1 : 0;
}

function thumbUp(landmarks: LandmarkPoint[], handedness: 'Left' | 'Right'): 0 | 1 {
  const thumb = landmarks[4];
  const indexMcp = landmarks[5];
  if (!thumb || !indexMcp) return 0;
  const spread = handedness === 'Left' ? thumb.x - indexMcp.x : indexMcp.x - thumb.x;
  return spread > 0.05 ? 1 : 0;
}

function distance(a: LandmarkPoint, b: LandmarkPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function labelForParam(param: string): string {
  if (param === 'retuneMs') return 'retune';
  if (param === 'formantShift') return 'formant';
  if (param === 'reverbDecay') return 'decay';
  return param;
}

function formatGestureValue(param: string, value: number): string {
  if (param === 'retuneMs') return `${Math.round(value)} ms`;
  if (param === 'formantShift') return `${value > 0 ? '+' : ''}${value.toFixed(1)} st`;
  if (param === 'reverbDecay') return `${value.toFixed(1)} s`;
  return value.toFixed(2);
}
