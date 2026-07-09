import { useEffect } from 'react';
import { engine } from '../audio/engine';
import { useStore } from '../state/store';
import { CamThumb } from './CamThumb';
import { ControlsPanel } from './ControlsPanel';
import { GestureHud } from './GestureHud';
import { LooperPanel } from './LooperPanel';
import { StartGate } from './StartGate';
import { PitchStage } from './pixi/PitchStage';
import styles from './Console.module.css';

export function Console() {
  const started = useStore((state) => state.started);
  const performanceMode = useStore((state) => state.performanceMode);
  const camThumbVisible = useStore((state) => state.camThumbVisible);
  const xyPadMode = useStore((state) => state.xyPadMode);
  const gestureStatus = useStore((state) => state.gestureStatus);
  const set = useStore((state) => state.set);

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
      <main className={`${styles.console} ${performanceMode ? styles.performanceMode : ''}`}>
        <header className={styles.wordmarkBar}>
          <h1 className={styles.wordmark}>AUTOTOAD</h1>
          <div className={styles.headerActions}>
            <span className={styles.status}>
              {started ? gestureStatus : 'sleeping'}
            </span>
            {started ? (
              <>
                <button
                  className={`${styles.headerButton} ${xyPadMode ? styles.headerButtonActive : ''}`}
                  type="button"
                  onClick={() => set({ xyPadMode: !xyPadMode })}
                >
                  XY
                </button>
                <button
                  className={`${styles.headerButton} ${camThumbVisible ? styles.headerButtonActive : ''}`}
                  type="button"
                  onClick={() => set({ camThumbVisible: !camThumbVisible })}
                >
                  Cam
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
            {started ? <GestureHud /> : null}
            {started && camThumbVisible ? <CamThumb /> : null}
          </div>
        </section>

        {performanceMode ? (
          <div className={styles.perfStrip}>
            <button type="button" onClick={() => engine.toggleLoopRecord()}>● Loop</button>
            <button type="button" onClick={() => engine.toggleTake()}>● Take</button>
            <button type="button" onClick={() => engine.panic()}>Panic</button>
            <span>P toggles performance mode</span>
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
