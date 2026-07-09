import { useEffect, useState } from 'react';
import { engine } from '../audio/engine';
import { useStore } from '../state/store';
import { ControlsPanel } from './ControlsPanel';
import { HelpOverlay } from './HelpOverlay';
import { LooperPanel } from './LooperPanel';
import { StartGate } from './StartGate';
import { PitchStage } from './pixi/PitchStage';
import styles from './Console.module.css';

export function Console() {
  const started = useStore((state) => state.started);
  const performanceMode = useStore((state) => state.performanceMode);
  const metronomeOn = useStore((state) => state.metronomeOn);
  const set = useStore((state) => state.set);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === 'p') {
        set({ performanceMode: !useStore.getState().performanceMode });
      }
    };
    globalThis.addEventListener('keydown', handleKeyDown);
    return () => globalThis.removeEventListener('keydown', handleKeyDown);
  }, [set]);

  return (
    <>
      {!started ? <StartGate /> : null}
      {helpOpen ? <HelpOverlay onClose={() => setHelpOpen(false)} /> : null}
      <main className={`${styles.console} ${performanceMode ? styles.performanceMode : ''}`}>
        <header className={styles.wordmarkBar}>
          <h1 className={styles.wordmark}>AUTOTOAD</h1>
          <div className={styles.headerActions}>
            <span className={styles.status}>
              {started ? 'live' : 'sleeping'}
            </span>
            {started ? (
              <>
                <button
                  className={styles.headerButton}
                  type="button"
                  onClick={() => setHelpOpen(true)}
                >
                  Help
                </button>
                <button
                  className={`${styles.headerButton} ${performanceMode ? styles.headerButtonActive : ''}`}
                  type="button"
                  onClick={() => set({ performanceMode: !performanceMode })}
                >
                  Perf
                </button>
              </>
            ) : null}
          </div>
        </header>

        <section className={styles.stageFrame} aria-label="Pitch stage">
          <div className={styles.stage}>
            <PitchStage />
          </div>
        </section>

        {performanceMode ? (
          <div className={styles.perfStrip}>
            <button type="button" onClick={() => engine.toggleLoopRecord()}>● Loop</button>
            <button type="button" onClick={() => engine.toggleTake()}>● Take</button>
            <button
              type="button"
              aria-pressed={metronomeOn}
              onClick={() => set({ metronomeOn: !metronomeOn })}
            >
              {metronomeOn ? 'Metro on' : 'Metro off'}
            </button>
            <button type="button" onClick={() => engine.panic()}>Panic</button>
            <button type="button" onClick={() => set({ performanceMode: false })}>Exit Perf</button>
            <span>P also exits</span>
          </div>
        ) : null}
        <div className={styles.dock} aria-label="Controls dock">
          <ControlsPanel />
          <LooperPanel />
        </div>
      </main>
    </>
  );
}
