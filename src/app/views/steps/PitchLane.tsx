/**
 * Melodic steps: a small piano roll for one bar of the clip.
 *
 * Rows are pitches (only in-key rows while Musical Assist is on, every
 * semitone otherwise), columns are the bar's 16 steps. Click an empty cell to
 * add a one-step note (you hear it), drag on to make it longer, click a note
 * to remove it, drag a note to move it, drag its right edge to change its
 * length. Notes longer than a bar continue visibly on the next page. The
 * velocity lane underneath sets how hard the notes on each step play.
 *
 * Keyboard: the roll is one tab stop with a cell cursor. Arrows move,
 * Enter/Space add or remove, Shift+Left/Right shorten/lengthen, +/- change
 * velocity, Page Up/Down jump an octave.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { TICKS_PER_BAR, TICKS_PER_STEP, type Clip, type Id, type Note } from '../../../project/types';
import { keyLabel, noteName } from '../../../music/scales';
import * as cmd from '../../../state/commands';
import { setStepPage } from '../../../state/uiStore';
import { IconButton, Tooltip, newGestureId } from '../../../ui/components';
import { session, useProject } from '../../instance';
import {
  STEPS,
  STEP_INDICES,
  clampVelocity,
  focusPitch,
  nearestRow,
  pageNoteViews,
  pageStartTick,
  percent,
  pitchRows,
  stepColumn,
  stepSpan,
  stepsLabel,
  type NoteView,
  type PitchRow,
} from './model';
import { audition, auditionBlip, useKeyBurst, type Audition } from './shared';
import { StepNumbers, VelocityLane } from './StepLanes';
import grid from './StepGrid.module.css';
import styles from './PitchLane.module.css';

/** Row height in px (the CSS reads it from --row-h). */
export const ROW_H = 18;
const MIN_TICKS = 6;

export interface PitchLaneProps {
  trackId: Id;
  slot: number;
  page: number;
  clip: Clip;
  kind: 'bass' | 'poly' | 'sampler';
}

type Drag =
  | { kind: 'draw'; pointerId: number; noteId: Id; tick: number; step: number; duration: number; gesture: string; sound: Audition }
  | { kind: 'resize'; pointerId: number; noteId: Id; tick: number; duration: number; gesture: string }
  | {
      kind: 'body';
      pointerId: number;
      noteId: Id;
      x0: number;
      y0: number;
      moved: boolean;
      movable: boolean;
      grabStep: number;
      grabRow: number;
      startStep: number;
      startRow: number;
      offset: number;
      tick: number;
      pitch: number;
      velocity: number;
      gesture: string;
      sound: Audition | null;
      refusedShown: boolean;
    }
  | { kind: 'key'; pointerId: number; sound: Audition };

/* ------------------------------------------------------------------ */
/* Rows and notes                                                      */
/* ------------------------------------------------------------------ */

const RowBack = memo(function RowBack({ row, index }: { row: PitchRow; index: number }) {
  return (
    <>
      <div
        className={styles.rowLabel}
        style={{ gridRow: index + 1 }}
        data-root={row.root || undefined}
        data-black={row.black || undefined}
        data-out={row.outOfKey || undefined}
        data-c={row.pitch % 12 === 0 || undefined}
        data-row-label={row.pitch}
        title={row.outOfKey ? `${row.name} is outside the key` : undefined}
      >
        <span className={`${styles.rowName} mono`}>{row.name}</span>
        {row.root && <span className={styles.rootTag}>root</span>}
        {row.outOfKey && <span className={styles.outTag}>off key</span>}
      </div>
      <div className={styles.rowStripe} style={{ gridRow: index + 1 }} data-root={row.root || undefined} data-black={row.black || undefined} data-out={row.outOfKey || undefined} data-c={row.pitch % 12 === 0 || undefined} />
    </>
  );
});

function sameView(a: NoteView, b: NoteView): boolean {
  return (
    a.id === b.id &&
    a.pitch === b.pitch &&
    a.velocity === b.velocity &&
    a.first === b.first &&
    a.last === b.last &&
    a.fromPrev === b.fromPrev &&
    a.toNext === b.toNext &&
    a.fillFrom === b.fillFrom &&
    a.fillTo === b.fillTo
  );
}

const NoteBlock = memo(
  function NoteBlock({ view, row }: { view: NoteView; row: number }) {
    const span = view.last - view.first + 1;
    return (
      <div
        className={styles.note}
        data-note-id={view.id}
        data-from-prev={view.fromPrev || undefined}
        data-to-next={view.toNext || undefined}
        style={
          {
            gridRow: row + 1,
            gridColumn: stepSpan(view.first, view.last),
            '--vel': String(view.velocity),
            '--from': String(view.fillFrom),
            '--to': String(view.fillTo),
          } as CSSProperties
        }
      >
        <span className={styles.noteBody} />
        {span >= 2 && <span className={styles.noteName}>{noteName(view.pitch)}</span>}
        {view.fromPrev && <span className={styles.contPrev}>◂</span>}
        {view.toNext ? <span className={styles.contNext}>▸</span> : <span className={styles.handle} data-handle="" />}
      </div>
    );
  },
  (a, b) => a.row === b.row && sameView(a.view, b.view),
);

/* ------------------------------------------------------------------ */
/* Lane                                                                */
/* ------------------------------------------------------------------ */

function notesStartingAt(notes: readonly Note[], tick: number, pitch?: number): Note[] {
  return notes.filter((n) => n.tick >= tick && n.tick < tick + TICKS_PER_STEP && (pitch === undefined || n.pitch === pitch));
}

function noteCovering(notes: readonly Note[], tick: number, pitch: number): Note | undefined {
  return notes.find((n) => n.pitch === pitch && n.tick < tick && n.tick + n.duration > tick);
}

export function PitchLane({ trackId, slot, page, clip, kind }: PitchLaneProps) {
  const assist = useProject((p) => p.assist);
  const root = useProject((p) => p.root);
  const scale = useProject((p) => p.scale);

  const clipTicks = clip.bars * TICKS_PER_BAR;
  const a = pageStartTick(page);
  const usedKey = useMemo(() => [...new Set(clip.notes.map((n) => n.pitch))].sort((x, y) => x - y).join(','), [clip.notes]);
  const rows = useMemo(() => pitchRows({ assist, root, scale, used: usedKey ? usedKey.split(',').map(Number) : [] }), [assist, root, scale, usedKey]);
  const rowOf = useMemo(() => new Map(rows.map((r, i) => [r.pitch, i])), [rows]);
  const views = useMemo(() => pageNoteViews(clip.notes, page, clipTicks), [clip.notes, page, clipTicks]);

  const { values, counts } = useMemo(() => {
    const v: (number | null)[] = STEP_INDICES.map(() => null);
    const c = STEP_INDICES.map(() => 0);
    for (const n of clip.notes) {
      if (n.tick < a || n.tick >= a + TICKS_PER_BAR) continue;
      const s = Math.floor((n.tick - a) / TICKS_PER_STEP);
      v[s] = Math.max(v[s] ?? 0, n.velocity);
      c[s] += 1;
    }
    return { values: v, counts: c };
  }, [clip.notes, a]);

  const [cursor, setCursor] = useState(() => ({ step: 0, pitch: rows[nearestRow(rows, focusPitch(clip.notes, kind))]?.pitch ?? 60 }));
  const [announce, setAnnounce] = useState('');
  const cursorRow = rowOf.get(cursor.pitch) ?? nearestRow(rows, cursor.pitch);
  const cursorPitch = rows[cursorRow]?.pitch ?? cursor.pitch;

  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLButtonElement>(null);
  const colRefs = useRef<(HTMLDivElement | null)[]>([]);
  const drag = useRef<Drag | null>(null);
  const burst = useKeyBurst();

  // Latest values for event handlers.
  const cur = useRef({ trackId, slot, page, clip, rows, clipTicks });
  useLayoutEffect(() => {
    cur.current = { trackId, slot, page, clip, rows, clipTicks };
  });

  /* ---------- scrolling ---------- */

  const [view, setView] = useState({ atTop: true, atBottom: false });
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = { atTop: el.scrollTop <= 1, atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 1 };
    setView((v) => (v.atTop === next.atTop && v.atBottom === next.atBottom ? v : next));
  }, []);
  const scrollRaf = useRef(0);
  const onScroll = () => {
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      measure();
    });
  };
  useEffect(() => () => cancelAnimationFrame(scrollRaf.current), []);

  // Opening a clip (or switching Musical Assist) centres the lane on its notes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const r = cur.current.rows;
    if (!el || r.length === 0) return;
    const target = nearestRow(r, focusPitch(cur.current.clip.notes, kind));
    el.scrollTop = Math.max(0, target * ROW_H - el.clientHeight / 2 + ROW_H / 2);
    setCursor((c) => ({ ...c, pitch: r[target].pitch }));
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, slot, clip.id, assist, scale, root, kind]);

  const scrollOctave = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    const r = cur.current.rows;
    const topRow = Math.round(el.scrollTop / ROW_H);
    const target = nearestRow(r, (r[topRow]?.pitch ?? 60) + dir * 12);
    el.scrollTo({ top: target * ROW_H, behavior: 'smooth' });
  };

  /* ---------- hit testing ---------- */

  /**
   * Step under x (0..15). With `beyond`, a pointer right of the last column
   * keeps counting into the following bars (for drawing and stretching notes
   * past the page edge).
   */
  const stepAt = (x: number, beyond = false): { step: number; frac: number } => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < colRefs.current.length; i++) {
      const el = colRefs.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x < r.right) return { step: i, frac: (x - r.left) / Math.max(1, r.width) };
      const d = x < r.left ? r.left - x : x - r.right;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const r = colRefs.current[best]?.getBoundingClientRect();
    if (beyond && r && best === STEPS - 1 && x >= r.right) {
      const stride = Math.max(1, r.width + 3);
      const over = (x - r.right) / stride;
      return { step: STEPS - 1 + Math.ceil(over), frac: over % 1 };
    }
    return { step: best, frac: r && x >= r.right ? 1 : 0 };
  };

  const rowAt = (y: number): number => {
    const g = gridRef.current;
    const n = cur.current.rows.length;
    if (!g || n === 0) return 0;
    const r = g.getBoundingClientRect();
    return Math.min(n - 1, Math.max(0, Math.floor((y - r.top) / (r.height / n))));
  };

  const noteById = (id: Id): Note | undefined => cur.current.clip.notes.find((n) => n.id === id);

  /* ---------- pointer ---------- */

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.pointerType === 'mouse' && e.button !== 0) || drag.current) return;
    const target = e.target as HTMLElement;
    if (target === cursorRef.current) return;
    const c = cur.current;
    const keyEl = target.closest<HTMLElement>('[data-row-label]');
    const noteEl = target.closest<HTMLElement>('[data-note-id]');
    const handleEl = target.closest<HTMLElement>('[data-handle]');
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    session.store.endGesture();

    if (keyEl) {
      // The note names are keys: hear the pitch.
      drag.current = { kind: 'key', pointerId: e.pointerId, sound: audition(c.trackId, Number(keyEl.dataset.rowLabel), 0.8) };
      return;
    }

    if (noteEl) {
      const note = noteById(noteEl.dataset.noteId ?? '');
      if (!note) return;
      if (handleEl) {
        drag.current = { kind: 'resize', pointerId: e.pointerId, noteId: note.id, tick: note.tick, duration: note.duration, gesture: newGestureId('steps-length') };
        return;
      }
      const at = stepAt(e.clientX);
      const row = rowAt(e.clientY);
      const startsHere = note.tick >= pageStartTick(c.page);
      drag.current = {
        kind: 'body',
        pointerId: e.pointerId,
        noteId: note.id,
        x0: e.clientX,
        y0: e.clientY,
        moved: false,
        movable: startsHere,
        grabStep: at.step,
        grabRow: row,
        startStep: Math.floor((note.tick - pageStartTick(c.page)) / TICKS_PER_STEP),
        startRow: rowOf.get(note.pitch) ?? row,
        offset: note.tick % TICKS_PER_STEP,
        tick: note.tick,
        pitch: note.pitch,
        velocity: note.velocity,
        gesture: newGestureId('steps-move'),
        sound: null,
        refusedShown: false,
      };
      return;
    }

    // Empty cell: add a one-step note and keep dragging to make it longer.
    const { step } = stepAt(e.clientX);
    const row = rowAt(e.clientY);
    const pitch = c.rows[row]?.pitch;
    if (pitch === undefined) return;
    const tick = pageStartTick(c.page) + step * TICKS_PER_STEP;
    setCursor({ step, pitch });
    const covering = noteCovering(c.clip.notes, tick, pitch);
    if (covering) {
      // A gap between cells inside a long note: treat it as a press on that note.
      drag.current = {
        kind: 'body',
        pointerId: e.pointerId,
        noteId: covering.id,
        x0: e.clientX,
        y0: e.clientY,
        moved: false,
        movable: false,
        grabStep: step,
        grabRow: row,
        startStep: 0,
        startRow: row,
        offset: 0,
        tick: covering.tick,
        pitch: covering.pitch,
        velocity: covering.velocity,
        gesture: newGestureId('steps-move'),
        sound: null,
        refusedShown: false,
      };
      return;
    }
    const r = cmd.addNote(session.store, c.trackId, c.slot, { tick, pitch, velocity: cmd.DEFAULT_STEP_VELOCITY, duration: TICKS_PER_STEP });
    if (!session.accepted(r) || !r.noteId) return;
    drag.current = { kind: 'draw', pointerId: e.pointerId, noteId: r.noteId, tick, step, duration: TICKS_PER_STEP, gesture: newGestureId('steps-length'), sound: audition(c.trackId, pitch, cmd.DEFAULT_STEP_VELOCITY) };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const c = cur.current;
    if (d.kind === 'draw') {
      const { step } = stepAt(e.clientX, true);
      const dur = Math.max(1, step - d.step + 1) * TICKS_PER_STEP;
      if (dur === d.duration) return;
      if (cmd.setNoteDuration(session.store, c.trackId, c.slot, d.noteId, Math.min(dur, c.clipTicks - d.tick), d.gesture).changed) d.duration = dur;
      return;
    }
    if (d.kind === 'resize') {
      const { step, frac } = stepAt(e.clientX, true);
      const within = e.shiftKey ? step + Math.round(frac * 4) / 4 : step + 1;
      const end = pageStartTick(c.page) + within * TICKS_PER_STEP;
      const dur = Math.min(c.clipTicks - d.tick, Math.max(MIN_TICKS, end - d.tick));
      if (dur === d.duration) return;
      const r = cmd.setNoteDuration(session.store, c.trackId, c.slot, d.noteId, dur, d.gesture);
      if (r.changed) d.duration = dur;
      else if (r.refused) {
        session.accepted(r);
        drag.current = null;
      }
      return;
    }
    if (d.kind === 'body') {
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
      d.moved = true;
      if (!d.movable) return;
      const newStep = Math.min(15, Math.max(0, d.startStep + (stepAt(e.clientX).step - d.grabStep)));
      const newRow = Math.min(c.rows.length - 1, Math.max(0, d.startRow + (rowAt(e.clientY) - d.grabRow)));
      const pitch = c.rows[newRow]?.pitch ?? d.pitch;
      const tick = Math.min(c.clipTicks - 1, pageStartTick(c.page) + newStep * TICKS_PER_STEP + d.offset);
      if (tick === d.tick && pitch === d.pitch) return;
      const r = cmd.moveNote(session.store, c.trackId, c.slot, d.noteId, { tick, pitch }, d.gesture);
      if (r.changed) {
        const pitchChanged = pitch !== d.pitch;
        d.tick = tick;
        d.pitch = pitch;
        if (pitchChanged) {
          d.sound?.release();
          d.sound = audition(c.trackId, pitch, d.velocity);
        }
      } else if (r.refused && !d.refusedShown) {
        d.refusedShown = true;
        session.accepted(r);
      }
    }
  };

  // Leaving Steps mid-press (switching view, part or clip) must not leave an auditioned note hanging.
  useEffect(
    () => () => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.kind === 'draw' || d.kind === 'key') d.sound.release();
      else if (d.kind === 'body') d.sound?.release();
      session.store.endGesture();
    },
    [],
  );

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    const c = cur.current;
    if (d.kind === 'draw' || d.kind === 'key') d.sound.release();
    if (d.kind === 'body') {
      d.sound?.release();
      if (!d.moved && e.type === 'pointerup') session.accepted(cmd.removeNote(session.store, c.trackId, c.slot, d.noteId));
      else if (d.moved && d.movable) setCursor({ step: Math.floor((d.tick - pageStartTick(c.page)) / TICKS_PER_STEP), pitch: d.pitch });
    }
    session.store.endGesture();
  };

  /* ---------- keyboard ---------- */

  // Reads this render's props (not the ref), so labels never lag an edit behind.
  const describe = (step: number, pitch: number, onPage = page): string => {
    const notes = clip.notes;
    const tick = pageStartTick(onPage) + step * TICKS_PER_STEP;
    const name = noteName(pitch);
    const n = notesStartingAt(notes, tick, pitch)[0];
    if (n) return `${name}, step ${step + 1}: note, ${stepsLabel(n.duration)}, velocity ${percent(n.velocity)}`;
    if (noteCovering(notes, tick, pitch)) return `${name}, step ${step + 1}: held from an earlier step`;
    return `${name}, step ${step + 1}: empty`;
  };

  const moveCursor = (step: number, rowIndex: number, onPage = page) => {
    const r = cur.current.rows;
    const ri = Math.min(r.length - 1, Math.max(0, rowIndex));
    const pitch = r[ri]?.pitch ?? cursorPitch;
    setCursor({ step, pitch });
    setAnnounce(`${onPage !== page ? `Bar ${onPage + 1}. ` : ''}${describe(step, pitch, onPage)}`);
  };

  /** The note under the cursor: one starting on the cell, else one held through it. */
  const noteAtCursor = (): Note | undefined => {
    const notes = clip.notes;
    const tick = pageStartTick(page) + cursor.step * TICKS_PER_STEP;
    return notesStartingAt(notes, tick, cursorPitch)[0] ?? noteCovering(notes, tick, cursorPitch);
  };

  const onCursorKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const c = cur.current;
    const step = cursor.step;
    const octaveRows = (dir: 1 | -1) => nearestRow(c.rows, cursorPitch + dir * 12);
    switch (e.key) {
      case 'ArrowUp':
        moveCursor(step, cursorRow - 1);
        break;
      case 'ArrowDown':
        moveCursor(step, cursorRow + 1);
        break;
      case 'PageUp':
        moveCursor(step, octaveRows(1));
        break;
      case 'PageDown':
        moveCursor(step, octaveRows(-1));
        break;
      case 'Home':
        moveCursor(0, cursorRow);
        break;
      case 'End':
        moveCursor(15, cursorRow);
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        if (e.shiftKey) {
          const n = noteAtCursor();
          if (!n) break;
          let dur: number;
          if (dir > 0) dur = (Math.floor(n.duration / TICKS_PER_STEP) + 1) * TICKS_PER_STEP;
          else dur = n.duration > TICKS_PER_STEP ? (Math.ceil(n.duration / TICKS_PER_STEP) - 1) * TICKS_PER_STEP : Math.max(MIN_TICKS, n.duration - MIN_TICKS);
          dur = Math.min(dur, c.clipTicks - n.tick);
          if (session.accepted(cmd.setNoteDuration(session.store, c.trackId, c.slot, n.id, dur, burst(`len:${n.id}`)))) setAnnounce(`${noteName(n.pitch)}: ${stepsLabel(dur)}`);
          break;
        }
        const next = step + dir;
        if (next > 15 && page < c.clip.bars - 1) {
          setStepPage(c.trackId, page + 1);
          moveCursor(0, cursorRow, page + 1);
        } else if (next < 0 && page > 0) {
          setStepPage(c.trackId, page - 1);
          moveCursor(15, cursorRow, page - 1);
        } else moveCursor(Math.min(15, Math.max(0, next)), cursorRow);
        break;
      }
      case 'Enter':
      case ' ': {
        if (e.repeat) break;
        const tick = pageStartTick(page) + step * TICKS_PER_STEP;
        const covering = notesStartingAt(c.clip.notes, tick, cursorPitch).length === 0 ? noteCovering(c.clip.notes, tick, cursorPitch) : undefined;
        if (covering) {
          if (session.accepted(cmd.removeNote(session.store, c.trackId, c.slot, covering.id))) setAnnounce(`${noteName(cursorPitch)} removed`);
          break;
        }
        const r = cmd.toggleStep(session.store, c.trackId, c.slot, page * 16 + step, cursorPitch, cmd.DEFAULT_STEP_VELOCITY);
        if (session.accepted(r)) {
          if (r.added) auditionBlip(c.trackId, cursorPitch, cmd.DEFAULT_STEP_VELOCITY);
          setAnnounce(`${noteName(cursorPitch)}, step ${step + 1}: ${r.added ? 'note added' : 'note removed'}`);
        }
        break;
      }
      case '+':
      case '=':
      case '-':
      case '_': {
        const n = noteAtCursor();
        if (!n) break;
        const v = clampVelocity(n.velocity + (e.key === '+' || e.key === '=' ? 0.1 : -0.1));
        if (session.accepted(cmd.setNoteVelocity(session.store, c.trackId, c.slot, n.id, v, burst(`vel:${n.id}`)))) setAnnounce(`Velocity ${percent(v)}`);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  // Keep the cursor cell in view while moving it from the keyboard.
  useEffect(() => {
    if (document.activeElement === cursorRef.current) cursorRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [cursor, cursorRow]);

  /* ---------- velocity ---------- */

  const setVelocity = useCallback((step: number, velocity: number, gesture: string) => {
    const c = cur.current;
    const tick = pageStartTick(c.page) + step * TICKS_PER_STEP;
    for (const n of notesStartingAt(c.clip.notes, tick)) {
      if (!session.accepted(cmd.setNoteVelocity(session.store, c.trackId, c.slot, n.id, velocity, gesture))) return;
    }
  }, []);

  const inKey = assist && scale !== 'chromatic';
  const keyText = inKey ? keyLabel(root, scale) : 'All notes';

  return (
    <div className={styles.melodic}>
      <StepNumbers
        className={styles.gutter}
        label={
          <div className={styles.octNav}>
            <IconButton icon="chevronUp" label="Show higher notes (an octave up)" size="sm" variant="ghost" onClick={() => scrollOctave(1)} disabled={view.atTop} className={styles.octBtn} />
            <IconButton icon="chevronDown" label="Show lower notes (an octave down)" size="sm" variant="ghost" onClick={() => scrollOctave(-1)} disabled={view.atBottom} className={styles.octBtn} />
            <Tooltip
              tip={inKey ? `Rows show the notes of ${keyLabel(root, scale)} (Musical Assist is on).` : 'Rows show all 12 notes (Musical Assist is off).'}
              detail="Switch Musical Assist or the key on the keyboard strip."
            >
              <span className={styles.keyInfo} tabIndex={0} aria-label={inKey ? `Rows in key: ${keyText}` : 'Rows: all 12 notes'}>
                {keyText}
              </span>
            </Tooltip>
          </div>
        }
      />
      <div ref={scrollRef} className={`${styles.scroller} ${styles.gutter}`} onScroll={onScroll} style={{ '--row-h': `${ROW_H}px` } as CSSProperties}>
        <div
          ref={gridRef}
          className={`${grid.cols} ${styles.roll}`}
          style={{ gridTemplateRows: `repeat(${rows.length}, var(--row-h))` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onLostPointerCapture={onPointerEnd}
          data-testid="pitch-roll"
        >
          {rows.map((r, i) => (
            <RowBack key={r.pitch} row={r} index={i} />
          ))}
          {STEP_INDICES.map((s) => (
            <div
              key={s}
              ref={(el) => {
                colRefs.current[s] = el;
              }}
              className={styles.col}
              style={{ gridColumn: stepColumn(s), gridRow: '1 / -1' }}
              data-beat={s % 4 === 0 || undefined}
              data-ph-step={s}
              data-col={s}
            />
          ))}
          {views.map((v) => {
            const row = rowOf.get(v.pitch);
            return row === undefined ? null : <NoteBlock key={v.id} view={v} row={row} />;
          })}
          <button
            ref={cursorRef}
            type="button"
            data-steps-entry=""
            className={styles.cursor}
            style={{ gridRow: cursorRow + 1, gridColumn: stepColumn(cursor.step) }}
            aria-label={`Note grid, bar ${page + 1}. ${describe(cursor.step, cursorPitch)}`}
            aria-describedby="steps-roll-help"
            onKeyDown={onCursorKey}
            onFocus={() => setAnnounce('')}
          />
        </div>
      </div>
      <span id="steps-roll-help" className="visually-hidden">
        Arrow keys move. Enter adds or removes a note. Shift with Left or Right changes its length. Plus and minus change velocity. Page Up and Page Down jump an octave.
      </span>
      <span className="visually-hidden" aria-live="polite">
        {announce}
      </span>
      <VelocityLane className={`${styles.velocity} ${styles.gutter}`} values={values} counts={counts} onSet={setVelocity} title="Velocity" hint="Drag · per step" />
    </div>
  );
}
