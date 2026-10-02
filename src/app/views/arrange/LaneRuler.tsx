/**
 * The ruler over the song lane: bar numbers, the bar under the pointer, and
 * the loop.
 *
 *   ⟲ Loop ════════════════════╗        ← the loop band (teal), its ends drag to block edges
 *   1    5    9   13   17   21   25 …    ← bar numbers: a click plays the song from that bar
 *
 * - A click (or Enter on the focused ruler, ←/→ to choose) plays the song from
 *   that bar.
 * - A drag across the ruler (past DRAG_THRESHOLD_PX) loops every block from
 *   the one under the press to the one under the pointer; the band follows,
 *   snapped to block edges, and the loop is set when the pointer comes up.
 *   Esc, a cancelled pointer or a lost capture leave the loop as it was. Near
 *   the lane's ends the lane scrolls.
 * - The band's two ends drag to other block edges (never past each other); a
 *   plain click on an end still plays from that bar.
 *
 * Geometry is read once per press; pointer moves only compute from it. The
 * band re-renders only when the snapped loop changes.
 */
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { LaneIcon } from './laneIcons';
import { loopEdgeDrag, loopFromDrag, sameSpan, spanX, type LoopSpan } from './laneLoop';
import { DRAG_THRESHOLD_PX, autoScrollVelocity } from './songDrag';
import { barToX, blockAtBar, rulerMarks, xToBar, type SongLayout } from './songLayout';
import styles from './SongPanel.module.css';

export interface LaneRulerProps {
  layout: SongLayout;
  /** Block names in song order (what the ruler says about a bar). */
  names: readonly string[];
  /** The looped blocks, or null. */
  loop: LoopSpan | null;
  contentRef: RefObject<HTMLDivElement | null>;
  scrollerRef: RefObject<HTMLDivElement | null>;
  /** Width of the scrolled content (px), for the auto-scroll limit. */
  contentWidth: number;
  onPlayFromBar(bar: number): void;
  /** A drag on the ruler or its band set the loop (null never comes from here: the Loop toggle and menus clear it). */
  onLoop(span: LoopSpan): void;
}

interface RulerPress {
  pointerId: number;
  el: HTMLElement;
  /** 'ruler': a click or a new loop; 'start' / 'end': an end of the band. */
  mode: 'ruler' | 'start' | 'end';
  /** Client x at the press. */
  x0: number;
  /** Lane x at the press. */
  lane0: number;
  /** Client x of the content's left edge when scrollLeft is 0. */
  contentLeft0: number;
  /** Visible lane edges (client x), for auto-scroll. */
  left: number;
  right: number;
  scroll: number;
  clientX: number;
  base: LoopSpan | null;
  dragging: boolean;
}

export const LaneRuler = memo(function LaneRuler({ layout, names, loop, contentRef, scrollerRef, contentWidth, onPlayFromBar, onLoop }: LaneRulerProps) {
  const marks = useMemo(() => rulerMarks(layout), [layout]);
  const [bar, setBar] = useState<number | null>(null);
  const [preview, setPreview] = useState<LoopSpan | null>(null);
  const hoverRef = useRef<HTMLDivElement>(null);
  const press = useRef<RulerPress | null>(null);
  const previewRef = useRef<LoopSpan | null>(null);
  const swallowClick = useRef(false);
  const raf = useRef(0);
  const live = useRef({ layout, loop, contentWidth });
  live.current = { layout, loop, contentWidth };

  const totalBars = layout.totalBars;
  const value = bar ?? 0;
  const at = blockAtBar(layout, value);
  const valueText = at ? `Bar ${value + 1}, in ${names[at.index] ?? 'a block'} (block ${at.index + 1})` : `Bar ${value + 1}`;
  useEffect(() => {
    if (bar !== null && bar >= totalBars) setBar(totalBars ? totalBars - 1 : null);
  }, [bar, totalBars]);

  const showHover = (b: number | null) => {
    const el = hoverRef.current;
    if (!el) return;
    if (b === null) {
      delete el.dataset.on;
      return;
    }
    el.dataset.on = '';
    el.style.transform = `translate3d(${barToX(live.current.layout, b).toFixed(1)}px, 0, 0)`;
    const label = el.firstElementChild;
    // A click (or Enter) plays from the bar it marks: the label says so.
    if (label) label.textContent = `Play from bar ${b + 1}`;
  };
  const rulerAt = (clientX: number) => {
    const c = contentRef.current;
    if (!c) return null;
    return xToBar(live.current.layout, clientX - c.getBoundingClientRect().left);
  };

  /* ---- loop drag ---- */
  const setShown = (span: LoopSpan | null) => {
    if (sameSpan(previewRef.current, span)) return;
    previewRef.current = span;
    setPreview(span);
  };
  const update = (p: RulerPress) => {
    const L = live.current.layout;
    const x = p.clientX - p.contentLeft0 + p.scroll;
    if (p.mode === 'ruler') setShown(loopFromDrag(L, p.lane0, x));
    else if (p.base) setShown(loopEdgeDrag(L, p.base, p.mode, x));
  };
  const stopScroll = () => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
  };
  const autoScroll = (p: RulerPress) => {
    if (raf.current || !autoScrollVelocity(p.clientX, p.left, p.right)) return;
    let last = performance.now();
    const step = (now: number) => {
      raf.current = 0;
      const scroller = scrollerRef.current;
      if (press.current !== p || !p.dragging || !scroller) return;
      const v = autoScrollVelocity(p.clientX, p.left, p.right);
      if (!v) return;
      const dt = Math.min(50, Math.max(0, now - last));
      last = now;
      const max = Math.max(0, live.current.contentWidth - (p.right - p.left));
      const next = Math.max(0, Math.min(max, p.scroll + (v * dt) / 1000));
      if (Math.abs(next - p.scroll) >= 0.01) {
        p.scroll = next;
        scroller.scrollLeft = next;
        update(p);
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };
  /** The click after a drag (or a drag cancelled with Esc) is not a click; forget that once its pointer is up. */
  const swallowSoon = () => {
    window.setTimeout(() => {
      swallowClick.current = false;
    }, 0);
  };
  /** End a press: `commit` sets the loop it shows; `stillDown` (Esc) waits for the button to come up. */
  const end = (commit: boolean, stillDown = false) => {
    const p = press.current;
    press.current = null;
    stopScroll();
    window.removeEventListener('keydown', onKey, true);
    if (!p) return;
    try {
      if (p.el.hasPointerCapture(p.pointerId)) p.el.releasePointerCapture(p.pointerId);
    } catch {
      /* gone */
    }
    if (!p.dragging) return;
    swallowClick.current = true;
    if (!stillDown) swallowSoon();
    const span = previewRef.current;
    setShown(null);
    if (commit && span && !sameSpan(span, live.current.loop)) onLoop(span);
  };
  // Stable for add/removeEventListener (reads the press through the ref).
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  onKeyRef.current = (e: KeyboardEvent) => {
    if (!press.current?.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && e.type === 'keydown') end(false, true);
  };
  const onKey = useMemo(() => (e: KeyboardEvent) => onKeyRef.current(e), []);
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      window.removeEventListener('keydown', onKey, true);
    },
    [onKey],
  );

  const band = preview ?? loop;
  const bx = band ? spanX(layout, band) : null;

  return (
    <div
      className={styles.ruler}
      role="slider"
      tabIndex={0}
      aria-label="Song position: arrow keys choose a bar, Enter plays the song from it"
      aria-valuemin={1}
      aria-valuemax={Math.max(1, totalBars)}
      aria-valuenow={value + 1}
      aria-valuetext={valueText}
      data-testid="song-ruler"
      data-looping={preview ? '' : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0 || !e.isPrimary) return;
        const scroller = scrollerRef.current;
        const content = contentRef.current;
        if (!scroller || !content) return;
        const endEl = (e.target as Element).closest<HTMLElement>('[data-loop-end]');
        const mode = (endEl?.dataset.loopEnd as 'start' | 'end' | undefined) ?? 'ruler';
        const scroll = scroller.scrollLeft;
        const r = scroller.getBoundingClientRect();
        const contentLeft0 = content.getBoundingClientRect().left + scroll;
        press.current = {
          pointerId: e.pointerId,
          el: e.currentTarget,
          mode,
          x0: e.clientX,
          lane0: e.clientX - contentLeft0 + scroll,
          contentLeft0,
          left: r.left,
          right: r.right,
          scroll,
          clientX: e.clientX,
          base: live.current.loop,
          dragging: false,
        };
        if (mode !== 'ruler') e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* not an active pointer */
        }
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (!p || e.pointerId !== p.pointerId) {
          showHover(rulerAt(e.clientX)?.bar ?? null);
          return;
        }
        p.clientX = e.clientX;
        if (!p.dragging) {
          if (Math.abs(e.clientX - p.x0) < DRAG_THRESHOLD_PX) return;
          p.dragging = true;
          showHover(null);
          window.addEventListener('keydown', onKey, true);
        }
        update(p);
        autoScroll(p);
      }}
      onPointerUp={(e) => {
        if (press.current && e.pointerId === press.current.pointerId) end(true);
        else if (swallowClick.current) swallowSoon();
      }}
      onPointerCancel={() => {
        end(false);
        swallowSoon();
      }}
      onLostPointerCapture={(e) => {
        // Only the end of our own capture (a finger's implicit capture of the band's end is handed over to the ruler).
        if (press.current && e.pointerId === press.current.pointerId && e.target === press.current.el) end(false);
      }}
      onPointerLeave={() => {
        if (!press.current) showHover(bar);
      }}
      onClick={(e) => {
        if (swallowClick.current) {
          swallowClick.current = false;
          return;
        }
        const hit = rulerAt(e.clientX);
        if (!hit) return;
        setBar(hit.bar);
        onPlayFromBar(hit.bar);
      }}
      onFocus={() => showHover(value)}
      onBlur={() => showHover(null)}
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        let next: number | null = null;
        if (e.key === 'ArrowLeft') next = value - 1;
        else if (e.key === 'ArrowRight') next = value + 1;
        else if (e.key === 'PageUp') next = value - 4;
        else if (e.key === 'PageDown') next = value + 4;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = totalBars - 1;
        else if (e.key === 'Enter') {
          e.preventDefault();
          onPlayFromBar(value);
          return;
        } else return;
        e.preventDefault();
        const v = Math.max(0, Math.min(totalBars - 1, next));
        setBar(v);
        showHover(v);
      }}
    >
      {marks.map((m) => (
        <span key={m.bar} className={styles.mark} data-label={m.label || undefined} data-start={m.blockStart || undefined} style={{ left: m.x }}>
          {m.label && <span className={`${styles.markNum} mono`}>{m.bar + 1}</span>}
        </span>
      ))}
      <span className={styles.endMark} style={{ left: layout.contentWidth - 1 }} />
      {bx && (
        <>
          <div className={styles.loopBand} data-testid="loop-band" data-preview={preview ? '' : undefined} style={{ left: bx.left, width: bx.right - bx.left }} aria-hidden="true">
            <span className={styles.loopLabel}>
              <LaneIcon name="loop" size={10} />
              Loop
            </span>
            <span className={styles.loopEnd} data-loop-end="start" data-testid="loop-start" />
            <span className={styles.loopEnd} data-loop-end="end" data-testid="loop-end" />
          </div>
          <div className={styles.loopLine} data-preview={preview ? '' : undefined} style={{ left: bx.left }} aria-hidden="true" />
          <div className={styles.loopLine} data-preview={preview ? '' : undefined} style={{ left: bx.right }} aria-hidden="true" />
        </>
      )}
      <div ref={hoverRef} className={styles.rulerHover} aria-hidden="true">
        <span className={`${styles.rulerHoverLabel} mono`} />
      </div>
    </div>
  );
});
