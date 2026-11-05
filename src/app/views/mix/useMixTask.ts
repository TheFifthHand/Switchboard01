/**
 * Mix readouts (loudness, Glue, limiter, spectrum, A/B trim) ride on the
 * meters' shared animation-frame loop (src/ui/components/meterScheduler):
 * one loop for every meter and readout on screen, which sleeps once nothing
 * moves (a stopped, silent Mix view runs no animation frames at all) and
 * wakes with sound, a key or pointer press, or `meterWake()`.
 *
 * `frame(now, dt)` runs on the loop's drawing frames (at most 30 a second)
 * and returns true while it still has something to show or settle; that keeps
 * the loop awake. Display only: nothing here times audio.
 */
import { useEffect, useRef } from 'react';
import { addMeterTask } from '../../../ui/components/meterScheduler';

export interface MixTask {
  /** A drawing frame: update the DOM; true while busy (something still changing or to settle). */
  frame(now: number, dt: number): boolean;
  /** While the loop sleeps: true when this readout has something new to show (the loop then wakes). */
  probe?(): boolean;
}

export function useMixTask(task: MixTask, active = true): void {
  const ref = useRef(task);
  useEffect(() => {
    ref.current = task;
  });
  useEffect(() => {
    if (!active) return;
    let busy = true;
    let dtAcc = 0;
    return addMeterTask({
      frame(now, dt, write) {
        dtAcc += dt;
        if (!write) return busy;
        busy = ref.current.frame(now, dtAcc * 1000);
        dtAcc = 0;
        return busy;
      },
      probe() {
        return ref.current.probe?.() ?? false;
      },
    });
  }, [active]);
}
