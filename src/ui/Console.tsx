import { SCALE_ORDER, type ScaleName } from '../types';
import { useStore } from '../state/store';
import { StartGate } from './StartGate';
import { PitchStage } from './pixi/PitchStage';
import styles from './Console.module.css';

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

export function Console() {
  const started = useStore((state) => state.started);
  const key = useStore((state) => state.key);
  const set = useStore((state) => state.set);

  return (
    <>
      {!started ? <StartGate /> : null}
      <main className={styles.console}>
        <header className={styles.wordmarkBar}>
          <h1 className={styles.wordmark}>AUTOTOAD</h1>
          <span className={styles.status}>
            {started ? 'listening' : 'sleeping'}
          </span>
        </header>

        <section className={styles.stageFrame} aria-label="Pitch stage">
          <div className={styles.stage}>
            <PitchStage />
          </div>
        </section>

        <div className={styles.dock} aria-label="Controls dock">
          <label className={styles.control}>
            <span>Key</span>
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

          <label className={styles.control}>
            <span>Scale</span>
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
        </div>
      </main>
    </>
  );
}
