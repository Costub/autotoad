import { useEffect, useRef } from 'react';
import { engine } from '../audio/engine';
import { useStore } from '../state/store';
import styles from './LooperPanel.module.css';

const BAR_OPTIONS = [1, 2, 4, 8] as const;
const MAX_LAYERS = 8;

export function LooperPanel() {
  const bpm = useStore((state) => state.bpm);
  const bars = useStore((state) => state.bars);
  const metronomeOn = useStore((state) => state.metronomeOn);
  const looperState = useStore((state) => state.looperState);
  const layers = useStore((state) => state.looperLayers);
  const set = useStore((state) => state.set);
  const progressRef = useRef<HTMLSpanElement>(null);
  const locked = layers.length > 0 || looperState === 'armed' || looperState === 'recording';
  const canRecord = layers.length < MAX_LAYERS || looperState === 'armed' || looperState === 'recording';

  useEffect(() => {
    let frame = 0;
    const update = (): void => {
      if (progressRef.current) {
        progressRef.current.style.transform = `scaleX(${engine.getLoopProgress()})`;
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, []);

  const recordClass = [
    styles.record,
    looperState === 'armed' ? styles.recordArmed : '',
    looperState === 'recording' ? styles.recording : '',
  ].join(' ');

  return (
    <section className={styles.panel} aria-label="Looper">
      <div className={styles.heading}>
        <span>Loop</span>
        <span className={styles.status}>{statusLabel(looperState, layers.length)}</span>
        <span className={styles.status}>{layers.length}/{MAX_LAYERS}</span>
      </div>
      <div className={styles.body}>
        <div className={styles.strip}>
          <div className={styles.stepper} aria-label="Loop tempo">
            <span className={styles.label}>Tempo</span>
            <button
              className={styles.button}
              type="button"
              disabled={locked}
              onClick={() => set({ bpm: Math.max(60, bpm - 1) })}
            >
              −
            </button>
            <span className={styles.readout}>{bpm} BPM</span>
            <button
              className={styles.button}
              type="button"
              disabled={locked}
              onClick={() => set({ bpm: Math.min(180, bpm + 1) })}
            >
              +
            </button>
          </div>

          <div className={styles.bars} aria-label="Loop bars">
            <span className={styles.label}>Bars</span>
            {BAR_OPTIONS.map((option) => (
              <button
                key={option}
                className={`${styles.button} ${bars === option ? styles.active : ''}`}
                type="button"
                aria-pressed={bars === option}
                disabled={locked}
                onClick={() => set({ bars: option })}
              >
                {option}
              </button>
            ))}
          </div>

          <button
            className={`${styles.button} ${metronomeOn ? styles.active : ''}`}
            type="button"
            aria-pressed={metronomeOn}
            onClick={() => set({ metronomeOn: !metronomeOn })}
          >
            {metronomeOn ? 'Metro on' : 'Metro off'}
          </button>

          <button
            className={recordClass}
            type="button"
            disabled={!canRecord}
            aria-pressed={looperState === 'armed' || looperState === 'recording'}
            onClick={() => engine.toggleLoopRecord()}
          >
            {recordLabel(looperState)}
          </button>

          <span className={styles.progress} aria-label="Loop position">
            <span ref={progressRef} className={styles.progressFill} />
          </span>

          <button
            className={styles.clearAll}
            type="button"
            disabled={layers.length === 0 && looperState === 'idle'}
            onClick={() => engine.clearAllLoops()}
          >
            Clear all
          </button>
          {layers.length === 0 ? (
            <span className={styles.empty}>no layers yet — record to stack</span>
          ) : null}
        </div>
        <div className={styles.laneList}>
          {layers.map((layer) => (
            <div
              key={layer.id}
              className={`${styles.lane} ${layer.muted ? styles.laneMuted : ''}`}
            >
              <span className={styles.snapshot}>#{layer.id} {layer.snapshot}</span>
              <button
                className={`${styles.button} ${layer.muted ? '' : styles.active}`}
                type="button"
                aria-pressed={!layer.muted}
                onClick={() => engine.toggleLoopLayerMute(layer.id)}
              >
                {layer.muted ? 'Unmute' : 'Mute'}
              </button>
              <label className={styles.miniRange}>
                Vol
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={layer.gain}
                  onChange={(event) => engine.setLoopLayerGain(layer.id, Number(event.currentTarget.value))}
                />
              </label>
              <label className={styles.miniRange}>
                Rev
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={layer.reverbSend}
                  onChange={(event) => engine.setLoopLayerReverb(layer.id, Number(event.currentTarget.value))}
                />
              </label>
              <button
                className={styles.button}
                type="button"
                aria-label={`Clear layer ${layer.id}`}
                onClick={() => engine.clearLoopLayer(layer.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function statusLabel(state: string, layerCount: number): string {
  if (state === 'armed') return 'armed';
  if (state === 'recording') return 'recording';
  if (layerCount > 0) return 'playing';
  return 'ready';
}

function recordLabel(state: string): string {
  if (state === 'armed') return 'Cancel arm';
  if (state === 'recording') return 'Cancel rec';
  return '● Record';
}
