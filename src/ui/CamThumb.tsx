import { useEffect, useRef, useState } from 'react';
import {
  addGestureRuntimeListener,
  gestureRuntime,
} from '../vision/gestureMapper';
import styles from './CamThumb.module.css';

const WIDTH = 120;
const HEIGHT = 90;

export function CamThumb() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState(gestureRuntime.status);

  useEffect(() => addGestureRuntimeListener(() => setStatus(gestureRuntime.status)), []);

  useEffect(() => {
    let frame = 0;
    const draw = (): void => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        if (gestureRuntime.video) {
          ctx.save();
          ctx.scale(-1, 1);
          ctx.drawImage(gestureRuntime.video, -WIDTH, 0, WIDTH, HEIGHT);
          ctx.restore();
        }
        ctx.fillStyle = '#5dcb6a';
        for (const hand of gestureRuntime.landmarks) {
          for (const point of hand.points) {
            ctx.beginPath();
            ctx.arc((1 - point.x) * WIDTH, point.y * HEIGHT, 1.7, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className={styles.thumb} aria-label="Gesture camera thumbnail">
      <canvas ref={canvasRef} className={styles.canvas} width={WIDTH} height={HEIGHT} />
      {gestureRuntime.video ? null : <div className={styles.status}>{status}</div>}
    </div>
  );
}
