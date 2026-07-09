import { useStore } from '../state/store';
import { ControlsPanel } from './ControlsPanel';
import { LooperPanel } from './LooperPanel';
import { StartGate } from './StartGate';
import { PitchStage } from './pixi/PitchStage';
import styles from './Console.module.css';

export function Console() {
  const started = useStore((state) => state.started);

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
          <ControlsPanel />
          <LooperPanel />
        </div>
      </main>
    </>
  );
}
