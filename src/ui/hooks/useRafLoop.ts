/**
 * Run a callback on every animation frame while `active` — for visuals only
 * (meters, playheads, the spectrum). Never use it to time audio: the audio
 * clock is the timing authority. The loop stops when inactive and on unmount,
 * pauses while the tab is hidden, and always calls the latest callback
 * without restarting.
 *
 * `fps` caps the rate (e.g. 30 for a spectrum): frames that come sooner are
 * skipped, and the callback's delta covers the time since its last call.
 */
import { useEffect, useRef } from 'react';

export type RafCallback = (deltaMs: number, now: number) => void;

export interface RafLoopOptions {
  /** Highest call rate (calls per second); default: every frame. */
  fps?: number;
}

export function useRafLoop(callback: RafCallback, active: boolean, options: RafLoopOptions = {}): void {
  const cb = useRef(callback);
  useEffect(() => {
    cb.current = callback;
  });
  const fps = options.fps;

  useEffect(() => {
    if (!active) return;
    // A little slack, so a 30 fps cap on a 60 Hz screen takes every second frame.
    const minGap = fps && fps > 0 ? 1000 / fps - 2 : 0;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < minGap) return;
      const dt = now - last;
      last = now;
      cb.current(dt, now);
    };
    const start = () => {
      if (raf || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);
    start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [active, fps]);
}
