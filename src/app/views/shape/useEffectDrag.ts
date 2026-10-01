/**
 * Drag an effect card by its grip to a new place in the part's chain.
 *
 * - 6 px of movement starts the drag (a press without movement does nothing);
 *   the card follows the pointer and a teal bar shows where it will land.
 * - Dropping moves the effect (one routing edit, one undo step); Escape,
 *   losing the window or dropping where it started changes nothing.
 * - Refused while a performance take records (the edit lock), with the
 *   reason. The card's Move earlier / Move later buttons are the keyboard
 *   alternative.
 * The card's position is updated directly on the DOM while dragging; React
 * renders only when the landing place changes.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Id } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { session } from '../../instance';
import { notify } from '../../runtime';
import { focusLater } from './shared';

export const DRAG_THRESHOLD_PX = 6;
const EDGE_PX = 36;
const SCROLL_STEP = 14;

export interface EffectDragView {
  /** The effect being dragged. */
  id: Id;
  /** Where it would land: index among the other effects (0 = first). */
  index: number;
  /** Its index when the drag started. */
  from: number;
}

interface Gesture {
  id: Id;
  pointerId: number;
  startX: number;
  startY: number;
  startScroll: number;
  started: boolean;
  from: number;
  index: number;
  card: HTMLElement | null;
  scroller: HTMLElement | null;
  cleanup(): void;
}

/** Insertion index among `others` (cells in reading order) for a pointer at (x, y). */
export function dropIndex(cells: readonly DOMRect[], x: number, y: number): number {
  let n = 0;
  for (const r of cells) if (y > r.bottom || (y >= r.top && x > r.left + r.width / 2)) n++;
  return n;
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/**
 * `effects` are the chain's effects in order; `cellOf(id)` finds a card's grid cell and `cardOf(id)`
 * the card that follows the pointer.
 */
export function useEffectDrag(opts: { effects: readonly Id[]; lock: string | null; nameOf(id: Id): string; cellOf(id: Id): HTMLElement | null; cardOf(id: Id): HTMLElement | null }) {
  const [view, setView] = useState<EffectDragView | null>(null);
  const g = useRef<Gesture | null>(null);
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });

  const end = useCallback((commit: boolean) => {
    const cur = g.current;
    if (!cur) return;
    g.current = null;
    cur.cleanup();
    if (cur.card) {
      cur.card.style.transform = '';
      cur.card.removeAttribute('data-dragging');
    }
    setView(null);
    if (!commit || !cur.started || cur.index === cur.from) return;
    const { nameOf, effects } = latest.current;
    const others = effects.filter((e) => e !== cur.id);
    const name = nameOf(cur.id);
    if (!session.accepted(cmd.moveEffect(session.store, cur.id, cur.index))) return;
    const after = others[cur.index - 1];
    const where = cur.index === 0 ? 'first in the chain' : `after ${nameOf(after)}`;
    notify(`Moved ${name}: it now comes ${where}.`, 'info', 'undo');
    focusLater(`rack-${cur.id}-name`);
  }, []);

  // A part change or a lock mid-drag cancels it.
  useEffect(() => {
    if (opts.lock) end(false);
  }, [opts.lock, end]);
  useEffect(() => () => end(false), [end]);

  const onGripDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, id: Id) => {
      if (e.button !== 0 || !e.isPrimary) return;
      const { lock, effects, cardOf } = latest.current;
      if (lock) {
        notify(lock, 'warn');
        return;
      }
      const from = effects.indexOf(id);
      if (from < 0) return;
      e.preventDefault();
      end(false);
      const grip = e.currentTarget;
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer: the window listeners still follow it */
      }
      const card = cardOf(id);
      const scroller = scrollParent(card);
      const pointerId = e.pointerId;

      const move = (ev: PointerEvent) => {
        const cur = g.current;
        if (!cur || ev.pointerId !== pointerId) return;
        if (!cur.started) {
          if (Math.hypot(ev.clientX - cur.startX, ev.clientY - cur.startY) < DRAG_THRESHOLD_PX) return;
          cur.started = true;
          cur.card?.setAttribute('data-dragging', '');
          setView({ id: cur.id, index: cur.from, from: cur.from });
        }
        ev.preventDefault();
        const sc = cur.scroller;
        if (sc) {
          const r = sc.getBoundingClientRect();
          if (ev.clientY < r.top + EDGE_PX) sc.scrollTop -= SCROLL_STEP;
          else if (ev.clientY > r.bottom - EDGE_PX) sc.scrollTop += SCROLL_STEP;
        }
        const scrolled = sc ? sc.scrollTop - cur.startScroll : 0;
        if (cur.card) cur.card.style.transform = `translate(${ev.clientX - cur.startX}px, ${ev.clientY - cur.startY + scrolled}px)`;
        const { effects: list, cellOf } = latest.current;
        const others = list.filter((x) => x !== cur.id);
        const rects = others.map((x) => cellOf(x)?.getBoundingClientRect()).filter((r): r is DOMRect => !!r);
        const index = dropIndex(rects, ev.clientX, ev.clientY);
        if (index !== cur.index) {
          cur.index = index;
          setView({ id: cur.id, index, from: cur.from });
        }
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        end(true);
      };
      const cancel = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) end(false);
      };
      const key = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        ev.stopPropagation();
        end(false);
      };
      const blur = () => end(false);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('keydown', key, true);
      window.addEventListener('blur', blur);
      g.current = {
        id,
        pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startScroll: scroller?.scrollTop ?? 0,
        started: false,
        from,
        index: from,
        card,
        scroller,
        cleanup: () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', cancel);
          window.removeEventListener('keydown', key, true);
          window.removeEventListener('blur', blur);
          try {
            if (grip.hasPointerCapture(pointerId)) grip.releasePointerCapture(pointerId);
          } catch {
            /* already released */
          }
        },
      };
    },
    [end],
  );

  return { drag: view, onGripDown };
}
