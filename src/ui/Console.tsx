import styles from './Console.module.css';

export function Console() {
  return (
    <main className={styles.console}>
      <header className={styles.wordmarkBar}>
        <h1 className={styles.wordmark}>AUTOTOAD</h1>
      </header>

      <section className={styles.stageFrame} aria-label="Pitch stage">
        <div className={styles.stage} />
      </section>

      <div className={styles.dock} aria-label="Controls dock" />
    </main>
  );
}
