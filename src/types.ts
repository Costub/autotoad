// Shared types used across main thread, worklet, and vision worker.
// This file must stay worklet-safe: types + const enums only, no DOM.

export type ScaleName =
  | 'major' | 'naturalMinor' | 'harmonicMinor' | 'majorPentatonic'
  | 'minorPentatonic' | 'blues' | 'dorian' | 'mixolydian' | 'chromatic';

/** Ordered list — the ParamsBus stores a scale as an index into this array. */
export const SCALE_ORDER: readonly ScaleName[] = [
  'major', 'naturalMinor', 'harmonicMinor', 'majorPentatonic',
  'minorPentatonic', 'blues', 'dorian', 'mixolydian', 'chromatic',
] as const;

export interface KeyConfig {
  /** Tonic pitch class 0–11 (C=0, C#=1, … B=11). */
  tonicPc: number;
  scale: ScaleName;
}

export type EngineMode = 'effect' | 'instrument' | 'both';
export type InstrumentName = 'chiptune' | 'fmBass' | 'pluck' | 'choirPad';
export type HarmonyPresetName = 'off' | 'duet' | 'triad' | 'choir' | 'octaves';
export type DelayDivision = '8n' | '8n.' | '4n' | '2n';
export type InputSourceName = 'mic' | 'demo' | 'file';

export interface NoteEvent {
  type: 'noteOn' | 'noteOff' | 'pitchBend';
  midi: number;
  velocity?: number;
  cents?: number;
  time: number;
}

export interface HandFrame {
  handedness: 'Left' | 'Right';
  pinch: number;
  pinchClosed: boolean;
  height: number;
  x: number;
  indexTip: { x: number; y: number };
  velocity: { dx: number; dy: number };
  fingersUp: number;
  fist: boolean;
}

export interface GestureFrame {
  t: number;
  hands: HandFrame[];
}
