/**
 * Lanes shared by the drum and melodic step editors: the numbered step ruler
 * (which also carries the playhead) and the velocity lane.
 */
import { memo, useRef, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { newGestureId } from '../../../ui/components';
import { session } from '../../instance';
import { STEP_INDICES, clampVelocity, stepColumn } from './model';
import grid from './StepGrid.module.css';

/** Step numbers 1-16, beat starts emphasised. The current step lights amber while the clip plays. */
export const StepNumbers = memo(function StepNumbers(props: { label?: ReactNode; className?: string }) {
  return (
    <div className={[grid.cols, grid.numbers, props.className].filter(Boolean).join(' ')}>
      {/* The label may hold controls, so only the decorative numbers are hidden from assistive tech. */}
      <div className={grid.numbersLabel}>{props.label}</div>
      {STEP_INDICES.map((s) => (
        <div key={s} className={grid.num} style={{ gridColumn: stepColumn(s) }} data-beat={s % 4 === 0 || undefined} data-ph-step={s} aria-hidden="true">
          {s + 1}
        </div>
      ))}
    </div>
  );
});

export interface VelocityLaneProps {
  /** Per step: velocity 0..1 of what starts there (the loudest, for chords), or null when nothing does. */
  values: readonly (number | null)[];
  /** Per step: how many notes start there (shown when more than one). */
  counts?: readonly number[];
  /** Set every note starting on `step` to `velocity`; `gesture` groups one drag into one undo step. */
  onSet(step: number, velocity: number, gesture: string): void;
  title: string;
  hint: string;
  className?: string;
}

/**
 * Velocity bars under the steps. Press on a bar and drag vertically to set
 * how hard it plays; keep dragging sideways to draw across steps. The whole
 * drag is one undo step. Keyboard users change velocity on the focused step
 * (Up/Down or +/-), so this surface is pointer-only.
 */
export function VelocityLane({ values, counts, onSet, title, hint, className }: VelocityLaneProps) {
  const colRefs = useRef<(HTMLDivElement | null)[]>([]);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const drag = useRef<{ pointerId: number; gesture: string } | null>(null);

  const columnAt = (x: number): number => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < colRefs.current.length; i++) {
      const el = colRefs.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right) return i;
      const d = Math.min(Math.abs(x - r.left), Math.abs(x - r.right));
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return best;
  };

  const setFrom = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const step = columnAt(e.clientX);
    if (step < 0 || valuesRef.current[step] === null || valuesRef.current[step] === undefined) return;
    const el = colRefs.current[step];
    if (!el) return;
    const r = el.getBoundingClientRect();
    const inner = Math.max(1, r.height - 6);
    const v = clampVelocity((r.bottom - 3 - e.clientY) / inner);
    if (Math.abs((valuesRef.current[step] ?? -1) - v) < 0.005) return;
    onSet(step, v, d.gesture);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (drag.current) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    session.store.endGesture();
    drag.current = { pointerId: e.pointerId, gesture: newGestureId('steps-velocity') };
    setFrom(e);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === e.pointerId) setFrom(e);
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    session.store.endGesture();
  };

  return (
    <div
      className={[grid.cols, grid.velocity, className].filter(Boolean).join(' ')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      aria-hidden="true"
      data-testid="velocity-lane"
    >
      <div className={grid.velLabel}>
        <span className={grid.velTitle}>{title}</span>
        <span className={grid.velHint}>{hint}</span>
      </div>
      {STEP_INDICES.map((s) => {
        const v = values[s];
        const has = v !== null && v !== undefined;
        const count = counts?.[s] ?? 0;
        return (
          <div
            key={s}
            ref={(el) => {
              colRefs.current[s] = el;
            }}
            className={grid.velCol}
            style={{ gridColumn: stepColumn(s) }}
            data-empty={has ? undefined : true}
            data-step={s}
          >
            {has && (
              <>
                <div className={grid.velBar} style={{ height: `calc((100% - 6px) * ${v})`, '--vel': String(v) } as CSSProperties} />
                <span className={grid.velValue}>{Math.round(v * 100)}</span>
                {count > 1 && <span className={grid.velCount}>×{count}</span>}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
