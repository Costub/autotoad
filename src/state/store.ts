import { create } from 'zustand';
import type {
  DelayDivision,
  EngineMode,
  HarmonyPresetName,
  InstrumentName,
  KeyConfig,
} from '../types';

export interface AppState {
  started: boolean;
  micReady: boolean;
  error: string | null;

  key: KeyConfig;
  retuneMs: number;
  correctionAmount: number;
  pitchShift: number;
  formantShift: number;
  dryLevel: number;
  wetLevel: number;
  bypass: boolean;

  harmonyPreset: HarmonyPresetName;
  harmonySpread: number;

  engineMode: EngineMode;
  instrument: InstrumentName;
  legato: boolean;
  chordFollow: boolean;

  reverbSend: number;
  reverbDecay: number;
  delaySend: number;
  delayTime: DelayDivision;
  delayFeedback: number;

  bpm: number;
  bars: number;
  metronomeOn: boolean;

  latencyMs: number;

  set: (partial: Partial<AppState>) => void;
}

export const useStore = create<AppState>((set) => ({
  started: false,
  micReady: false,
  error: null,
  key: { tonicPc: 0, scale: 'major' },
  retuneMs: 80,
  correctionAmount: 1,
  pitchShift: 0,
  formantShift: 0,
  dryLevel: 0,
  wetLevel: 1,
  bypass: false,
  harmonyPreset: 'off',
  harmonySpread: 0.3,
  engineMode: 'effect',
  instrument: 'chiptune',
  legato: false,
  chordFollow: false,
  reverbSend: 0.18,
  reverbDecay: 2.2,
  delaySend: 0,
  delayTime: '8n.',
  delayFeedback: 0.35,
  bpm: 90,
  bars: 2,
  metronomeOn: true,
  latencyMs: 0,
  set: (partial) => set(partial),
}));
