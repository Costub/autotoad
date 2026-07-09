import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { SCALE_ORDER, type ScaleName } from '../types';
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

export function ControlsPanel() {
  const key = useStore((state) => state.key);
  const retuneMs = useStore((state) => state.retuneMs);
  const correctionAmount = useStore((state) => state.correctionAmount);
  const pitchShift = useStore((state) => state.pitchShift);
  const formantShift = useStore((state) => state.formantShift);
  const wetLevel = useStore((state) => state.wetLevel);
  const bypass = useStore((state) => state.bypass);
  const latencyMs = useStore((state) => state.latencyMs);
  const set = useStore((state) => state.set);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        set({ bypass: true });
      }
    };
    globalThis.addEventListener('keydown', handleKeyDown);
    return () => globalThis.removeEventListener('keydown', handleKeyDown);
  }, [set]);

  return (
    <div className={styles.panel}>
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
  );
}
