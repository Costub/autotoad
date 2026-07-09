import { describe, expect, it } from 'vitest';
import type { GestureFrame, HandFrame } from '../src/types';
import {
  GestureMapperCore,
  fingerSlideTarget,
  grabFaderTarget,
  updatePinchClosed,
  type GestureSnapshot,
} from '../src/vision/gestureMath';

const baseSnapshot: GestureSnapshot = {
  retuneMs: 200,
  formantShift: 0,
  wetLevel: 1,
  dryLevel: 0,
  pitchShift: 0,
  harmonySpread: 0.3,
  harmonyPreset: 'off',
  reverbDecay: 2.2,
  reverbSend: 0.18,
  delayTime: '8n.',
  delayFeedback: 0.35,
  instrument: 'chiptune',
  engineMode: 'effect',
  xyPadMode: false,
};

describe('gesture math', () => {
  it('applies pinch hysteresis', () => {
    let closed = false;
    for (const pinch of [0.4, 0.3]) closed = updatePinchClosed(closed, pinch);
    expect(closed).toBe(false);
    closed = updatePinchClosed(closed, 0.24);
    expect(closed).toBe(true);
    closed = updatePinchClosed(closed, 0.3);
    expect(closed).toBe(true);
    closed = updatePinchClosed(closed, 0.36);
    expect(closed).toBe(false);
  });

  it('keeps grab-fader mapping relative to the grab point', () => {
    expect(grabFaderTarget(200, 0.5, 0.75, { min: 0, max: 400 })).toBe(400);
    expect(grabFaderTarget(300, 0.1, 0.1, { min: 0, max: 400 })).toBe(300);
  });

  it('applies finger-slide deadzone', () => {
    expect(fingerSlideTarget(2.2, 0.5, 0.52, { min: 0.5, max: 8 })).toBe(2.2);
    expect(fingerSlideTarget(2.2, 0.5, 0.55, { min: 0.5, max: 8 })).toBeGreaterThan(2.2);
  });
});

describe('gesture mapper state machines', () => {
  it('fires one flick event inside the refractory window', () => {
    const mapper = new GestureMapperCore();
    const frame = (t: number): GestureFrame => ({
      t,
      hands: [hand({ velocity: { dx: 3, dy: 0 }, fingersUp: 5 })],
    });
    expect(mapper.process(frame(600), baseSnapshot).events).toEqual(['instrumentNext']);
    expect(mapper.process(frame(633), baseSnapshot).events).toEqual([]);
    expect(mapper.process(frame(666), baseSnapshot).events).toEqual([]);
  });

  it('requires a right-fist hold before record toggle', () => {
    const mapper = new GestureMapperCore();
    const at250 = mapper.process({ t: 250, hands: [hand({ fist: true, fingersUp: 0 })] }, baseSnapshot);
    expect(at250.events).toEqual([]);
    const at320 = mapper.process({ t: 570, hands: [hand({ fist: true, fingersUp: 0 })] }, baseSnapshot);
    expect(at320.events).toEqual(['recordToggle']);
  });

  it('guards ambient height mapping on hand entry', () => {
    const mapper = new GestureMapperCore();
    const early = mapper.process({ t: 0, hands: [hand({ height: 0.9, fingersUp: 1 })] }, baseSnapshot);
    expect(early.updates.pitchShift).toBeUndefined();
    const late = mapper.process({ t: 520, hands: [hand({ height: 0.9, fingersUp: 1 })] }, baseSnapshot);
    expect(late.updates.pitchShift).toBe(12);
  });

  it('gives fist pose priority over pinch grab', () => {
    const mapper = new GestureMapperCore();
    const output = mapper.process({
      t: 0,
      hands: [hand({ fist: true, fingersUp: 0, pinchClosed: true, pinch: 0.1 })],
    }, baseSnapshot);
    expect(output.held['Right:fist']).toBe(true);
    expect(output.updates.retuneMs).toBeUndefined();
  });
});

function hand(overrides: Partial<HandFrame> = {}): HandFrame {
  return {
    handedness: 'Right',
    pinch: 0.6,
    pinchClosed: false,
    height: 0.5,
    x: 0.5,
    indexTip: { x: 0.5, y: 0.5 },
    velocity: { dx: 0, dy: 0 },
    fingersUp: 1,
    fist: false,
    ...overrides,
  };
}
