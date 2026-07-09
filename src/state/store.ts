import { create } from 'zustand';
import type {
  DelayDivision,
  EngineMode,
  HarmonyPresetName,
  InstrumentName,
  KeyConfig,
  InputSourceName,
} from '../types';
import type { LooperState } from '../audio/looper/looper';

export interface LooperLayerSummary {
  id: number;
  snapshot: string;
  muted: boolean;
  gain: number;
  reverbSend: number;
}

export interface AppState {
  started: boolean;
  micReady: boolean;
  error: string | null;
  inputSource: InputSourceName;
  isRecordingTake: boolean;

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
  looperState: LooperState;
  looperLayers: LooperLayerSummary[];
  looperEpochSamples: number;
  loopLengthSamples: number;
  looperLatencyOffsetSamples: number;

  performanceMode: boolean;

  latencyMs: number;

  set: (partial: Partial<AppState>) => void;
}

type PersistedSettings = Pick<AppState,
  | 'key'
  | 'retuneMs'
  | 'correctionAmount'
  | 'pitchShift'
  | 'formantShift'
  | 'dryLevel'
  | 'wetLevel'
  | 'harmonyPreset'
  | 'harmonySpread'
  | 'engineMode'
  | 'instrument'
  | 'legato'
  | 'chordFollow'
  | 'reverbSend'
  | 'reverbDecay'
  | 'delaySend'
  | 'delayTime'
  | 'delayFeedback'
  | 'bpm'
  | 'bars'
  | 'metronomeOn'
>;

const STORAGE_KEY = 'autotoad-settings-v2';
const LEGACY_STORAGE_KEY = 'autotoad-settings-v1';
/** Keys persisted by v1 that no longer exist (camera/gesture removal). */
const LEGACY_KEYS = ['camThumbVisible', 'xyPadMode'] as const;

const defaultState = {
  started: false,
  micReady: false,
  error: null,
  inputSource: 'mic',
  isRecordingTake: false,
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
  looperState: 'idle',
  looperLayers: [],
  looperEpochSamples: 0,
  loopLengthSamples: 0,
  looperLatencyOffsetSamples: 0,
  performanceMode: false,
  latencyMs: 0,
} satisfies Omit<AppState, 'set'>;

export const useStore = create<AppState>((set) => ({
  ...defaultState,
  ...loadPersistedSettings(),
  inputSource: 'mic',
  started: false,
  error: null,
  looperLayers: [],
  looperState: 'idle',
  set: (partial) => set(partial),
}));

let persistTimer: number | null = null;

useStore.subscribe((state) => {
  if (typeof localStorage === 'undefined') return;
  if (persistTimer !== null) globalThis.clearTimeout(persistTimer);
  persistTimer = globalThis.setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selectPersistedSettings(state)));
  }, 300);
});

function loadPersistedSettings(): Partial<PersistedSettings> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedSettings> & Record<string, unknown>;
    for (const legacyKey of LEGACY_KEYS) delete parsed[legacyKey];
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return sanitizePersisted(parsed);
  } catch {
    return {};
  }
}

function selectPersistedSettings(state: AppState): PersistedSettings {
  return {
    key: state.key,
    retuneMs: state.retuneMs,
    correctionAmount: state.correctionAmount,
    pitchShift: state.pitchShift,
    formantShift: state.formantShift,
    dryLevel: state.dryLevel,
    wetLevel: state.wetLevel,
    harmonyPreset: state.harmonyPreset,
    harmonySpread: state.harmonySpread,
    engineMode: state.engineMode,
    instrument: state.instrument,
    legato: state.legato,
    chordFollow: state.chordFollow,
    reverbSend: state.reverbSend,
    reverbDecay: state.reverbDecay,
    delaySend: state.delaySend,
    delayTime: state.delayTime,
    delayFeedback: state.delayFeedback,
    bpm: state.bpm,
    bars: state.bars,
    metronomeOn: state.metronomeOn,
  };
}

function sanitizePersisted(value: Partial<PersistedSettings>): Partial<PersistedSettings> {
  return {
    ...value,
    bpm: value.bpm ? Math.min(180, Math.max(60, value.bpm)) : undefined,
    bars: value.bars && [1, 2, 4, 8].includes(value.bars) ? value.bars : undefined,
  };
}
