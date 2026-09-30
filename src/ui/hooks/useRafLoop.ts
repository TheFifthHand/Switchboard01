/**
 * Run a callback on every animation frame while `active` — for visuals only
 * (meters, playheads). Never use it to time audio: the audio clock is the
 * timing authority. The loop stops when inactive and on unmount; the latest
 * callback is always used without restarting the loop.
 */
import { useEffect, useRef } from 'react';

export type RafCallback = (deltaMs: number, now: number) => void;

export function useRafLoop(callback: RafCallback, active: boolean): void {
  const cb = useRef(callback);
  useEffect(() => {
    cb.current = callback;
  });

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = now - last;
      last = now;
      cb.current(dt, now);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active]);
}
