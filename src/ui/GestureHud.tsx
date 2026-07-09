import { useEffect, useRef } from 'react';
import { gestureRuntime } from '../vision/gestureMapper';
import styles from './GestureHud.module.css';

export function GestureHud() {
  const itemsRef = useRef<HTMLDivElement>(null);
  const xyRef = useRef<HTMLDivElement>(null);
  const crosshairRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let frame = 0;
    const update = (): void => {
      const items = gestureRuntime.hud;
      if (itemsRef.current) {
        itemsRef.current.textContent = items.length > 0
          ? items.map((item) => `${item.hand[0]} · ${item.param} · ${item.value}`).join('   ')
          : gestureRuntime.status;
      }
      if (xyRef.current && crosshairRef.current) {
        const xy = gestureRuntime.xy;
        xyRef.current.classList.toggle(styles.xyVisible!, xy !== null);
        if (xy) {
          crosshairRef.current.style.left = `${Math.round(xy.x * 100)}%`;
          crosshairRef.current.style.top = `${Math.round((1 - xy.y) * 100)}%`;
        }
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className={styles.hud} aria-label="Gesture HUD">
      <div ref={itemsRef} className={styles.items} />
      <div ref={xyRef} className={styles.xy} aria-hidden="true">
        <span ref={crosshairRef} className={styles.crosshair} />
      </div>
    </div>
  );
}
