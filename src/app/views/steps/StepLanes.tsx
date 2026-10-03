/**
 * Lanes shared by the drum and melodic step editors: the numbered step ruler
 * (which also carries the playhead) and the velocity lane. Both follow a
 * grid (16 steps a bar for drums; the roll's chosen grid for melodic parts).
 */
import { memo, useRef, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import type { Id } from '../../../project/types';
import { newGestureId } from '../../../ui/components';
import { session } from '../../instance';
import { STEP_GRID, cellColumn, cellIndices, cellLabel, clampVelocity, type GridSpec, type VelocityVoice } from './model';
import grid from './StepGrid.module.css';

/** The CSS custom property that sets how many cells a beat has in the shared column template. */
export function gridStyle(spec: GridSpec): CSSProperties {
  return { '--per-beat': String(spec.perBeat) } as CSSProperties;
}

/** Cell numbers (1-16 on the 1/16 grid), beat starts emphasised. The current cell lights amber while the clip plays. */
export const StepNumbers = memo(function StepNumbers(props: { label?: ReactNode; className?: string; grid?: GridSpec }) {
  const spec = props.grid ?? STEP_GRID;
  return (
    <div className={[grid.cols, grid.numbers, props.className].filter(Boolean).join(' ')} style={gridStyle(spec)} data-cells={spec.cells}>
      {/* The label may hold controls, so only the decorative numbers are hidden from assistive tech. */}
      <div className={grid.numbersLabel}>{props.label}</div>
      {cellIndices(spec.cells).map((s) => {
        const l = cellLabel(s, spec);
        return (
          <div key={s} className={grid.num} style={{ gridColumn: cellColumn(s, spec.perBeat) }} data-beat={l.beat || undefined} data-ph-step={s} aria-hidden="true">
            {l.text}
          </div>
        );
      })}
    </div>
  );
});

export interface VelocityLaneProps {
  /** Per step: velocity 0..1 of what starts there (the loudest, for chords), or null when nothing does. */
  values?: readonly (number | null)[];
  /** Per step: how many notes start there (shown when more than one). */
  counts?: readonly number[];
  /** Set every note starting on `step` to `velocity`; `gesture` groups one drag into one undo step. */
  onSet?(step: number, velocity: number, gesture: string): void;
  /**
   * Per-note mode (the piano roll): per cell, the notes starting there, drawn
   * as one bar each (chord voices side by side, selected ones highlighted).
   */
  voices?: readonly (readonly VelocityVoice[])[];
  /** With a selection only the selected notes are edited; without one, every note on the cell. */
  hasSelection?: boolean;
  onSetNotes?(ids: Id[], velocity: number, gesture: string): void;
  /** A drag (with a selection) reached a step whose notes are not selected: say why nothing changes there (once a drag). */
  onUnselected?(): void;
  /** Column layout (default: 16 steps). */
  grid?: GridSpec;
  title: string;
  hint: ReactNode;
  className?: string;
}

/**
 * Velocity bars under the steps. Press on a bar and drag vertically to set
 * how hard it plays; keep dragging sideways to draw across steps. The whole
 * drag is one undo step. Keyboard users change velocity on the focused step
 * (Up/Down or +/-), so this surface is pointer-only.
 */
export function VelocityLane({ values, counts, onSet, voices, hasSelection = false, onSetNotes, onUnselected, grid: spec = STEP_GRID, title, hint, className }: VelocityLaneProps) {
  const colRefs = useRef<(HTMLDivElement | null)[]>([]);
  const latest = useRef({ values, voices, hasSelection, onSet, onSetNotes, onUnselected });
  latest.current = { values, voices, hasSelection, onSet, onSetNotes, onUnselected };
  const drag = useRef<{ pointerId: number; gesture: string; told: boolean } | null>(null);
  const cells = voices ? voices.length : spec.cells;

  const columnAt = (x: number): number => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < cells; i++) {
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
    const col = columnAt(e.clientX);
    const el = colRefs.current[col];
    if (col < 0 || !el) return;
    const r = el.getBoundingClientRect();
    const inner = Math.max(1, r.height - 6);
    const v = clampVelocity((r.bottom - 3 - e.clientY) / inner);
    const l = latest.current;
    if (l.voices) {
      const here = l.voices[col] ?? [];
      const targets = l.hasSelection ? here.filter((x) => x.selected) : here;
      if (targets.length === 0 && here.length > 0 && !d.told) {
        d.told = true;
        l.onUnselected?.();
      }
      if (targets.length === 0 || targets.every((x) => Math.abs(x.velocity - v) < 0.005)) return;
      l.onSetNotes?.(
        targets.map((x) => x.id),
        v,
        d.gesture,
      );
      return;
    }
    const cur = l.values?.[col];
    if (cur === null || cur === undefined || Math.abs(cur - v) < 0.005) return;
    l.onSet?.(col, v, d.gesture);
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
    drag.current = { pointerId: e.pointerId, gesture: newGestureId('steps-velocity'), told: false };
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
      style={gridStyle(spec)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      aria-hidden="true"
      data-testid="velocity-lane"
      data-cells={cells}
    >
      <div className={grid.velLabel}>
        <span className={grid.velTitle}>{title}</span>
        <span className={grid.velHint}>{hint}</span>
      </div>
      {cellIndices(cells).map((s) => {
        const ref = (el: HTMLDivElement | null) => {
          colRefs.current[s] = el;
        };
        const style = { gridColumn: cellColumn(s, spec.perBeat) };
        if (voices) {
          const here = voices[s] ?? [];
          const picked = hasSelection ? here.filter((x) => x.selected) : [];
          const shown = picked.length ? picked : here;
          const top = shown.reduce((m, x) => Math.max(m, x.velocity), 0);
          return (
            <div key={s} ref={ref} className={grid.velCol} style={style} data-empty={here.length ? undefined : true} data-step={s} data-picked={picked.length || undefined}>
              {here.length > 0 && (
                <>
                  <div className={grid.velVoices}>
                    {here.map((x) => (
                      <div
                        key={x.id}
                        className={grid.velVoice}
                        data-voice-id={x.id}
                        data-selected={x.selected || undefined}
                        data-dim={(hasSelection && !x.selected) || undefined}
                        style={{ height: `calc((100% - 6px) * ${x.velocity})`, '--vel': String(x.velocity) } as CSSProperties}
                      />
                    ))}
                  </div>
                  <span className={grid.velValue}>{Math.round(top * 100)}</span>
                  {here.length > 1 && (
                    <span className={grid.velCount} data-picked={picked.length || undefined}>
                      {picked.length ? `${picked.length}/${here.length}` : `×${here.length}`}
                    </span>
                  )}
                </>
              )}
            </div>
          );
        }
        const v = values?.[s];
        const has = v !== null && v !== undefined;
        const count = counts?.[s] ?? 0;
        return (
          <div key={s} ref={ref} className={grid.velCol} style={style} data-empty={has ? undefined : true} data-step={s}>
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
