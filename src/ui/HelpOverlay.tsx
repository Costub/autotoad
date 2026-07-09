import type { ReactNode } from 'react';
import styles from './HelpOverlay.module.css';

interface HelpOverlayProps {
  onClose: () => void;
}

export function HelpOverlay({ onClose }: HelpOverlayProps) {
  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-labelledby="autotoad-help-title">
      <section className={styles.panel}>
        <header className={styles.header}>
          <h2 id="autotoad-help-title" className={styles.title}>AUTOTOAD field guide</h2>
          <button className={styles.close} type="button" onClick={onClose}>Close</button>
        </header>
        <div className={styles.content}>
          <HelpCard title="Core controls">
            <li><strong>Input</strong>: Mic is live voice, Demo is a built-in melody, File loops local audio.</li>
            <li><strong>Retune</strong>: lower is robotic snap; higher glides more naturally.</li>
            <li><strong>Amount</strong>: how strongly notes are pulled into the selected key/scale.</li>
            <li><strong>Pitch</strong>: shifts the tuned voice in semitones.</li>
            <li><strong>Mix</strong>: blends dry voice and tuned voice.</li>
            <li><strong>Bypass / Panic</strong>: Bypass disables voice processing; Panic also releases synth notes and cancels loop recording.</li>
          </HelpCard>

          <HelpCard title="Harmony, instruments, and FX">
            <li><strong>Harmony</strong>: adds scale-aware duet/triad/choir/octave voices.</li>
            <li><strong>Spread</strong>: widens harmony with pan and tiny detune offsets.</li>
            <li><strong>Effect</strong>: voice FX only. <strong>Instrument</strong>: voice drives synth only. <strong>Both</strong>: both at once.</li>
            <li><strong>Legato</strong>: smoother synth note changes. <strong>Chord follow</strong>: synth follows the harmony preset.</li>
            <li><strong>Reverb / Delay</strong>: global effects; loop layers are recorded dry enough that FX stay live.</li>
          </HelpCard>

          <HelpCard title="Looper">
            <li><strong>Metro</strong>: turns the metronome click on or off.</li>
            <li><strong>Tempo/Bars</strong>: set before recording. They lock while layers exist.</li>
            <li><strong>Record</strong>: first press gives a count-in, records one loop, then immediately plays it back.</li>
            <li>Press <strong>Record</strong> again mid-loop to arm the next overdub. Existing layers keep playing.</li>
            <li>Each layer has mute, volume, reverb send, and clear controls.</li>
          </HelpCard>

          <HelpCard title="Stage and shortcuts">
            <li><strong>Note labels</strong> on the left show pitch rows; the toad climbs as pitch rises.</li>
            <li><strong>Green ghost</strong>: corrected pitch. <strong>Tadpoles</strong>: harmony notes.</li>
            <li><strong>Amber fireflies</strong>: loop layers; they pulse on loop boundaries.</li>
            <li><strong>Esc</strong>: Panic. <strong>P</strong>: enter/exit performance mode.</li>
            <li><strong>Perf mode</strong>: hides the full dock; use Exit Perf or press P to return.</li>
          </HelpCard>
        </div>
      </section>
    </div>
  );
}

function HelpCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.card}>
      <h3>{title}</h3>
      <ul>{children}</ul>
    </section>
  );
}
