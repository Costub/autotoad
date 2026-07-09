import { useEffect, useRef } from 'react';
import { Application } from 'pixi.js';
import { engine } from '../../audio/engine';
import type { ParamIndex } from '../../audio/paramsBus';
import { useStore } from '../../state/store';
import { createPitchScene } from './pitchScene';
import styles from './PitchStage.module.css';

const STAGE_WIDTH_PX = 640;
const STAGE_HEIGHT_PX = 576;

export function PitchStage() {
  const started = useStore((state) => state.started);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!started || !hostRef.current) {
      return;
    }

    const host = hostRef.current;
    const app = new Application();
    let disposed = false;
    let initialized = false;
    let scene: ReturnType<typeof createPitchScene> | null = null;

    const mount = async (): Promise<void> => {
      await app.init({
        width: STAGE_WIDTH_PX,
        height: STAGE_HEIGHT_PX,
        background: 0x0e1b1e,
        antialias: false,
        roundPixels: true,
      });
      initialized = true;
      if (disposed) {
        app.destroy(true);
        return;
      }

      app.canvas.className = styles.canvas!;
      host.appendChild(app.canvas);
      scene = createPitchScene(app, {
        readBus: (index) => engine.bus.get(index as ParamIndex),
        getKey: () => useStore.getState().key,
      });
    };

    void mount();

    return () => {
      disposed = true;
      if (initialized) {
        scene?.destroy();
        app.destroy(true);
      }
    };
  }, [started]);

  if (!started) {
    return null;
  }

  return <div ref={hostRef} className={styles.host} />;
}
