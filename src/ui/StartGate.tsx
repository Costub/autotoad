import { useState } from 'react';
import { engine } from '../audio/engine';
import { useStore } from '../state/store';
import styles from './StartGate.module.css';

const GATE_FADE_MS = 200;
const COMPLETE_HOLD_MS = 120;

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, durationMs);
  });
}

export function StartGate() {
  const error = useStore((state) => state.error);
  const set = useStore((state) => state.set);
  const [loading, setLoading] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [step, setStep] = useState('ready');

  const start = async (demo = false): Promise<void> => {
    if (loading) {
      return;
    }

    setLoading(true);
    setStep('context');
    setProgress(0.18);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    setStep('engine');
    setProgress(0.52);

    try {
      await engine.start({ skipMic: demo }, (stage) => {
        setStep(stage);
        if (stage === 'microphone') {
          setProgress(0.7);
        } else if (stage === 'warming up') {
          setProgress(0.86);
        }
      });
      setStep(demo ? 'demo ready' : 'microphone');
      setProgress(1);
      await wait(COMPLETE_HOLD_MS);
      setDismissing(true);
      await wait(GATE_FADE_MS);
      set({ started: true, micReady: !demo });
    } catch {
      setLoading(false);
      setProgress(0);
      setStep('ready');
    }
  };

  return (
    <div
      className={`${styles.gate} ${dismissing ? styles.gateDismissing : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="start-gate-title"
    >
      <div className={styles.content}>
        <p className={styles.wordmark}>AUTOTOAD</p>
        <h2 id="start-gate-title" className={styles.title}>
          Your voice is the instrument
        </h2>
        <p className={styles.warning}>
          Headphones required — the toad feeds back without them
        </p>

        {error ? (
          <div className={styles.error} role="alert">
            <p>{error}</p>
            <button
              className={styles.startButton}
              type="button"
              onClick={() => void start(true)}
              disabled={loading}
            >
              {loading ? 'Loading demo…' : 'Start with demo input instead'}
            </button>
          </div>
        ) : (
          <div className={styles.action}>
            <button
              className={styles.startButton}
              type="button"
              onClick={() => void start(false)}
              disabled={loading}
            >
              {loading ? 'Waking the toad…' : "I'm wearing headphones — start"}
            </button>
            <div className={styles.progressTrack} aria-hidden="true">
              <div
                className={styles.progressFill}
                style={{ transform: `scaleX(${progress})` }}
              />
            </div>
            <p className={styles.step} aria-live="polite">
              {loading ? step : '\u00A0'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
