import { useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { P } from '../audio/paramsBus';
import { useStore } from '../state/store';
import {
  SCALE_ORDER,
  type DelayDivision,
  type EngineMode,
  type HarmonyPresetName,
  type InstrumentName,
  type ScaleName,
} from '../types';
import styles from './controls.module.css';

const VALUE_HIDE_DELAY_MS = 800;

const KEY_NAMES = [
  'C',
  'C♯',
  'D',
  'D♯',
  'E',
  'F',
  'F♯',
  'G',
  'G♯',
  'A',
  'A♯',
  'B',
] as const;

const SCALE_LABELS: Record<ScaleName, string> = {
  major: 'Major',
  naturalMinor: 'Natural minor',
  harmonicMinor: 'Harmonic minor',
  majorPentatonic: 'Major pentatonic',
  minorPentatonic: 'Minor pentatonic',
  blues: 'Blues',
  dorian: 'Dorian',
  mixolydian: 'Mixolydian',
  chromatic: 'Chromatic',
};

const HARMONY_OPTIONS: ReadonlyArray<{
  value: HarmonyPresetName;
  label: string;
}> = [
  { value: 'off', label: 'Off' },
  { value: 'triad', label: 'Triad' },
  { value: 'duet', label: 'Duet' },
  { value: 'choir', label: 'Choir' },
  { value: 'octaves', label: 'Octaves' },
];

const MODE_OPTIONS: Array<{ value: EngineMode; label: string }> = [
  { value: 'effect', label: 'Effect' },
  { value: 'instrument', label: 'Instrument' },
  { value: 'both', label: 'Both' },
];
const INSTRUMENT_OPTIONS: Array<{ value: InstrumentName; label: string }> = [
  { value: 'chiptune', label: 'Chiptune' },
  { value: 'fmBass', label: 'FM Bass' },
  { value: 'pluck', label: 'Pluck' },
  { value: 'choirPad', label: 'Choir Pad' },
];
const DELAY_OPTIONS: DelayDivision[] = ['8n', '8n.', '4n', '2n'];

interface RangeControlProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  formatValue: (value: number) => string;
  onChange: (value: number) => void;
}

function RangeControl({
  label,
  min,
  max,
  step,
  value,
  formatValue,
  onChange,
}: RangeControlProps) {
  const [showValue, setShowValue] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (hideTimerRef.current !== null) {
        globalThis.clearTimeout(hideTimerRef.current);
      }
    },
    [],
  );

  const revealValue = (): void => {
    setShowValue(true);
    if (hideTimerRef.current !== null) {
      globalThis.clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = globalThis.setTimeout(() => {
      setShowValue(false);
    }, VALUE_HIDE_DELAY_MS);
  };

  return (
    <label className={styles.rangeControl}>
      <span className={styles.controlLabel}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={revealValue}
        onFocus={revealValue}
        onChange={(event) => {
          revealValue();
          onChange(Number(event.currentTarget.value));
        }}
      />
      <span
        className={`${styles.valueReadout} ${
          showValue ? styles.valueReadoutVisible : ''
        }`}
        aria-hidden={!showValue}
      >
        {formatValue(value)}
      </span>
    </label>
  );
}

const signedSemitones = (value: number): string =>
  `${value > 0 ? '+' : ''}${value} st`;

function InputMeter() {
  const fillRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = 0;
    const update = (): void => {
      const rms = engine.bus.get(P.rmsLevel);
      const voiced = engine.bus.get(P.detectedFreq) > 0;
      if (fillRef.current) {
        fillRef.current.style.transform = `scaleY(${Math.min(1, rms * 8)})`;
        fillRef.current.style.backgroundColor = voiced ? 'var(--accent)' : 'var(--muted)';
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <span className={styles.meter} aria-label="Input level"><span ref={fillRef} /></span>;
}

function Segment<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className={styles.segment} aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          className={value === option.value ? styles.segmentActive : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ControlsPanel() {
  const key = useStore((state) => state.key);
  const retuneMs = useStore((state) => state.retuneMs);
  const correctionAmount = useStore((state) => state.correctionAmount);
  const pitchShift = useStore((state) => state.pitchShift);
  const formantShift = useStore((state) => state.formantShift);
  const wetLevel = useStore((state) => state.wetLevel);
  const bypass = useStore((state) => state.bypass);
  const latencyMs = useStore((state) => state.latencyMs);
  const harmonyPreset = useStore((state) => state.harmonyPreset);
  const harmonySpread = useStore((state) => state.harmonySpread);
  const inputSource = useStore((state) => state.inputSource);
  const isRecordingTake = useStore((state) => state.isRecordingTake);
  const engineMode = useStore((state) => state.engineMode);
  const instrument = useStore((state) => state.instrument);
  const legato = useStore((state) => state.legato);
  const chordFollow = useStore((state) => state.chordFollow);
  const reverbSend = useStore((state) => state.reverbSend);
  const reverbDecay = useStore((state) => state.reverbDecay);
  const delaySend = useStore((state) => state.delaySend);
  const delayTime = useStore((state) => state.delayTime);
  const delayFeedback = useStore((state) => state.delayFeedback);
  const bpm = useStore((state) => state.bpm);
  const metronomeOn = useStore((state) => state.metronomeOn);
  const set = useStore((state) => state.set);
  const fileRef = useRef<HTMLInputElement>(null);
  const [takeSeconds, setTakeSeconds] = useState(0);

  useEffect(() => {
    if (!isRecordingTake) {
      setTakeSeconds(0);
      return;
    }
    const startedAt = performance.now();
    const timer = globalThis.setInterval(() => {
      setTakeSeconds(Math.floor((performance.now() - startedAt) / 1000));
    }, 250);
    return () => globalThis.clearInterval(timer);
  }, [isRecordingTake]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        engine.panic();
      }
    };
    globalThis.addEventListener('keydown', handleKeyDown);
    return () => globalThis.removeEventListener('keydown', handleKeyDown);
  }, [set]);

  return (
    <div className={styles.panel}>
      <div className={`${styles.groupRow} ${styles.compactRow}`}>
        <div className={styles.groupHeading}><span>Input</span></div>
        <div className={styles.strip}>
          <Segment
            label="Input source"
            value={inputSource}
            options={[
              { value: 'mic', label: 'Mic' },
              { value: 'demo', label: 'Demo' },
              { value: 'file', label: 'File…' },
            ]}
            onChange={(value) => {
              if (value === 'file') fileRef.current?.click();
              else void engine.setInputSource(value);
            }}
          />
          <InputMeter />
          <input
            ref={fileRef}
            className={styles.fileInput}
            type="file"
            accept="audio/*"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void engine.loadFile(file);
            }}
          />
          <span className={styles.inlineLabel}>Tempo</span>
          <button className={styles.stepButton} type="button" onClick={() => set({ bpm: Math.max(60, bpm - 1) })}>−</button>
          <span className={styles.bpm}>{bpm} BPM</span>
          <button className={styles.stepButton} type="button" onClick={() => set({ bpm: Math.min(180, bpm + 1) })}>+</button>
          <button className={`${styles.toggle} ${metronomeOn ? styles.segmentActive : ''}`} type="button" onClick={() => set({ metronomeOn: !metronomeOn })}>Click</button>
          <button className={`${styles.take} ${isRecordingTake ? styles.takeActive : ''}`} type="button" onClick={() => engine.toggleTake()}>
            ● Take{isRecordingTake ? ` ${takeSeconds}s` : ''}
          </button>
        </div>
      </div>
      <div className={styles.groupRow}>
        <div className={styles.groupHeading}>
          <span>Tune</span>
          <span className={styles.latency}>~{Math.round(latencyMs)} ms</span>
        </div>

        <div className={styles.controls}>
          <label className={styles.selectControl}>
            <span className={styles.controlLabel}>Key</span>
            <select
              value={key.tonicPc}
              onChange={(event) => {
                set({
                  key: {
                    ...key,
                    tonicPc: Number(event.currentTarget.value),
                  },
                });
              }}
            >
              {KEY_NAMES.map((name, index) => (
                <option key={name} value={index}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <label className={`${styles.selectControl} ${styles.scaleControl}`}>
            <span className={styles.controlLabel}>Scale</span>
            <select
              value={key.scale}
              onChange={(event) => {
                set({
                  key: {
                    ...key,
                    scale: event.currentTarget.value as ScaleName,
                  },
                });
              }}
            >
              {SCALE_ORDER.map((scale) => (
                <option key={scale} value={scale}>
                  {SCALE_LABELS[scale]}
                </option>
              ))}
            </select>
          </label>

          <RangeControl
            label="Retune"
            min={0}
            max={400}
            step={1}
            value={retuneMs}
            formatValue={(value) => (value === 0 ? 'snap' : `${value} ms`)}
            onChange={(value) => set({ retuneMs: value })}
          />
          <RangeControl
            label="Amount"
            min={0}
            max={1}
            step={0.01}
            value={correctionAmount}
            formatValue={(value) => `${Math.round(value * 100)}%`}
            onChange={(value) => set({ correctionAmount: value })}
          />
          <RangeControl
            label="Pitch"
            min={-24}
            max={24}
            step={1}
            value={pitchShift}
            formatValue={signedSemitones}
            onChange={(value) => set({ pitchShift: value })}
          />
          <RangeControl
            label="Formant"
            min={-12}
            max={12}
            step={1}
            value={formantShift}
            formatValue={signedSemitones}
            onChange={(value) => set({ formantShift: value })}
          />
          <RangeControl
            label="Mix"
            min={0}
            max={1}
            step={0.01}
            value={wetLevel}
            formatValue={(value) => `${Math.round(value * 100)}% wet`}
            onChange={(value) => {
              set({ wetLevel: value, dryLevel: 1 - value });
            }}
          />

          <button
            className={`${styles.bypass} ${bypass ? styles.bypassActive : ''}`}
            type="button"
            aria-pressed={bypass}
            onClick={() => set({ bypass: !bypass })}
          >
            Bypass
          </button>
        </div>
      </div>

      <div className={`${styles.groupRow} ${styles.harmonyRow}`}>
        <div className={styles.groupHeading}>
          <span>Harmony</span>
        </div>
        <div className={styles.harmonyControls}>
          <div className={styles.presetButtons} aria-label="Harmony preset">
            {HARMONY_OPTIONS.map((option) => {
              const active = harmonyPreset === option.value;
              const suggested =
                harmonyPreset === 'off' && option.value === 'triad';
              return (
                <button
                  key={option.value}
                  className={`${styles.presetButton} ${
                    active ? styles.presetButtonActive : ''
                  } ${suggested ? styles.presetButtonSuggested : ''}`}
                  type="button"
                  aria-pressed={active}
                  onClick={() => set({ harmonyPreset: option.value })}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <div className={styles.spreadControl}>
            <RangeControl
              label="Spread"
              min={0}
              max={1}
              step={0.01}
              value={harmonySpread}
              formatValue={(value) => `${Math.round(value * 100)}%`}
              onChange={(value) => set({ harmonySpread: value })}
            />
          </div>
        </div>
      </div>
      <div className={`${styles.groupRow} ${styles.compactRow}`}>
        <div className={styles.groupHeading}><span>Instrument</span></div>
        <div className={styles.strip}>
          <Segment label="Engine mode" options={MODE_OPTIONS} value={engineMode} onChange={(value) => set({ engineMode: value })} />
          <Segment label="Instrument preset" options={INSTRUMENT_OPTIONS} value={instrument} onChange={(value) => set({ instrument: value })} />
          <button className={`${styles.toggle} ${legato ? styles.segmentActive : ''}`} type="button" onClick={() => set({ legato: !legato })}>Legato</button>
          <button
            className={`${styles.toggle} ${chordFollow ? styles.segmentActive : ''}`}
            type="button"
            disabled={harmonyPreset === 'off'}
            onClick={() => set({ chordFollow: !chordFollow })}
          >
            Chord follow
          </button>
        </div>
      </div>
      <div className={`${styles.groupRow} ${styles.fxRow}`}>
        <div className={styles.groupHeading}><span>FX</span></div>
        <div className={styles.fxControls}>
          <RangeControl label="Reverb" min={0} max={1} step={0.01} value={reverbSend} formatValue={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ reverbSend: v })} />
          <RangeControl label="Decay" min={0.5} max={8} step={0.1} value={reverbDecay} formatValue={(v) => `${v.toFixed(1)} s`} onChange={(v) => set({ reverbDecay: v })} />
          <RangeControl label="Delay" min={0} max={1} step={0.01} value={delaySend} formatValue={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ delaySend: v })} />
          <Segment label="Delay division" options={DELAY_OPTIONS.map((value) => ({ value, label: value }))} value={delayTime} onChange={(value) => set({ delayTime: value })} />
          <RangeControl label="Feedback" min={0} max={0.75} step={0.01} value={delayFeedback} formatValue={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ delayFeedback: v })} />
          <button className={styles.toggle} type="button" onClick={() => engine.panic()}>Panic</button>
        </div>
      </div>
    </div>
  );
}
