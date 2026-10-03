/**
 * Melodic steps: a piano roll for one bar of the clip at a time.
 *
 * Rows are pitches (only in-key rows while Musical Assist is on, every
 * semitone otherwise), columns are the cells of the chosen grid (1/16, 1/32,
 * 1/8 or 1/16 triplets). Notes are spelled by the key.
 *
 * Mouse and pen:
 * - A click on an empty cell adds a note there (you hear it) and selects it;
 *   dragging on draws it longer. A click on a note selects it; Shift- or
 *   Ctrl-click adds it to the selection or takes it out. Double-click, or
 *   Delete, removes the selected notes (a toast offers Undo).
 * - Shift-drag on empty grid draws a selection box.
 * - Dragging a note moves every selected note, across bars: hold the pointer
 *   past the left or right edge for a moment and the page turns. Snapping
 *   follows the grid; hold Alt to place freely. The right edge of a note
 *   changes its length (all selected notes together).
 *
 * Touch: a swipe up or down scrolls the roll. A tap adds a note or removes
 * one; a press that rests (or starts sideways) draws, moves or resizes, as a
 * mouse drag does. The note names sound on a tap.
 *
 * Keyboard: the roll is one tab stop with a cell cursor (see the help text
 * at the bottom). Every gesture is one undo step through the notes commands.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { TICKS_PER_BAR, type Clip, type Id, type Note } from '../../../project/types';
import { keyLabel, keyShortName, noteName, stepsPerOctave, type MusicalKey } from '../../../music/scales';
import * as cmd from '../../../state/commands';
import { setStepPage } from '../../../state/uiStore';
import { IconButton, Tooltip, newGestureId } from '../../../ui/components';
import { session, useProject, useUi } from '../../instance';
import { notify } from '../../runtime';
import { MOD_ARIA, MOD_KEY } from '../ClipMenu';
import {
  anchorNote,
  cellColumn,
  cellIndices,
  cellSpan,
  cellWords,
  clampMovePitch,
  clampMoveTicks,
  clampVelocity,
  focusPitch,
  gridSpec,
  isTap,
  landsFree,
  nearestRow,
  notesInBox,
  pageNoteViews,
  pageOfTick,
  pageStartTick,
  percent,
  pitchRows,
  plannedPitches,
  plural,
  previewMovedNotes,
  scaleStepsBetween,
  selectedNotes,
  stepsLabel,
  touchIntent,
  velocityVoices,
  TOUCH_HOLD,
  type MovePlan,
  type NoteView,
  type PitchRow,
} from './model';
import { audition, auditionBlip, noteClipboard, selectedIdsFor, selectionKey, setSelectedIds, useKeyBurst, useSelectedIds, type Audition } from './shared';
import { StepNumbers, VelocityLane, gridStyle } from './StepLanes';
import grid from './StepGrid.module.css';
import styles from './PitchLane.module.css';

/** Row height in px (the CSS reads it from --row-h). */
export const ROW_H = 18;
const MIN_TICKS = 6;
/** Pointer travel (px) before a press on a note becomes a move or a box. */
const DRAG_PX = 4;
/** A second press on the same note within this time (ms) is a double-click. */
const DOUBLE_MS = 400;
/** Holding a dragged selection past the page edge this long (ms) turns the page. */
export const EDGE_TURN_MS = 400;
/** Still held there, the next bars follow at this pace (ms), slow enough to let go on the bar you want. */
export const EDGE_REPEAT_MS = 700;
/** The note drawn while the pointer is still down (added on release, as one undo step). */
const DRAW_ID = '__draw';

export interface PitchLaneProps {
  trackId: Id;
  slot: number;
  page: number;
  clip: Clip;
  kind: 'bass' | 'poly' | 'sampler';
}

type Target = { on: 'label'; pitch: number } | { on: 'note'; note: Note; handle: boolean } | { on: 'empty'; cell: number; row: number };

interface Mods {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

const NO_MODS: Mods = { shift: false, ctrl: false, alt: false };
const NO_MOVE: MovePlan = { dTick: 0, dPitch: 0, steps: 0, key: null };

type Drag =
  | { kind: 'draw'; pointerId: number; tick: number; pitch: number; cell: number; duration: number; sound: Audition }
  | { kind: 'resize'; pointerId: number; anchorId: Id; ids: Id[]; start: Map<Id, { tick: number; duration: number }>; delta: number; gesture: string }
  | {
      kind: 'press';
      pointerId: number;
      noteId: Id;
      ids: Id[];
      x0: number;
      y0: number;
      lastX: number;
      lastY: number;
      alt: boolean;
      toggleOff: boolean;
      collapse: boolean;
      mod: boolean;
      grabTick: number;
      anchorPitch: number;
      moved: boolean;
      plan: MovePlan;
      sound: Audition | null;
      edgeSide: number;
      edgeTimer: number;
      /** Pages turned since the pointer reached the edge (the first waits EDGE_TURN_MS, the next EDGE_REPEAT_MS). */
      edgeTurns: number;
    }
  | { kind: 'box'; pointerId: number; x0: number; y0: number; base: Id[]; moved: boolean }
  | { kind: 'key'; pointerId: number; sound: Audition }
  | { kind: 'touch'; pointerId: number; x0: number; y0: number; t0: number; target: Target; timer: number };

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
  function NoteBlock({ view, row, perBeat, name, selected }: { view: NoteView; row: number; perBeat: number; name: string; selected: boolean }) {
    const span = view.last - view.first + 1;
    return (
      <div
        className={styles.note}
        data-note-id={view.id}
        data-selected={selected || undefined}
        data-from-prev={view.fromPrev || undefined}
        data-to-next={view.toNext || undefined}
        style={
          {
            gridRow: row + 1,
            gridColumn: cellSpan(view.first, view.last, perBeat),
            '--vel': String(view.velocity),
            '--from': String(view.fillFrom),
            '--to': String(view.fillTo),
          } as CSSProperties
        }
      >
        <span className={styles.noteBody} />
        {span >= 2 && <span className={styles.noteName}>{name}</span>}
        {view.fromPrev && <span className={styles.contPrev}>◂</span>}
        {view.toNext ? <span className={styles.contNext}>▸</span> : <span className={styles.handle} data-handle="" />}
      </div>
    );
  },
  (a, b) => a.row === b.row && a.perBeat === b.perBeat && a.name === b.name && a.selected === b.selected && sameView(a.view, b.view),
);

/**
 * The key the rows follow, in a target of at least 32 px: the full name
 * ('G Dorian') where it fits, else the short one ('G Dor'); the tooltip and
 * the accessible name always say it in full.
 */
function KeyChip({ text, short, label, tip, detail }: { text: string; short: string; label: string; tip: string; detail: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const el = ref.current;
    const m = measure.current;
    if (!el || !m) return;
    const check = () => setFits(m.offsetWidth <= el.clientWidth - 8);
    check();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [text]);
  return (
    <Tooltip tip={tip} detail={detail}>
      <span ref={ref} className={styles.keyInfo} role="note" tabIndex={0} aria-label={label} data-short={!fits || undefined}>
        <span ref={measure} className={styles.keyMeasure} aria-hidden="true">
          {text}
        </span>
        <span aria-hidden="true">{fits ? text : short}</span>
      </span>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/* Lane                                                                */
/* ------------------------------------------------------------------ */

function notesStartingAt(notes: readonly Note[], tick: number, len: number, pitch?: number): Note[] {
  return notes.filter((n) => n.tick >= tick && n.tick < tick + len && (pitch === undefined || n.pitch === pitch));
}

function noteCovering(notes: readonly Note[], tick: number, pitch: number): Note | undefined {
  return notes.find((n) => n.pitch === pitch && n.tick < tick && n.tick + n.duration > tick);
}

export function PitchLane({ trackId, slot, page, clip, kind }: PitchLaneProps) {
  const assist = useProject((p) => p.assist);
  const root = useProject((p) => p.root);
  const scale = useProject((p) => p.scale);
  const gridName = useUi((s) => s.stepGrid);
  const spec = useMemo(() => gridSpec(gridName), [gridName]);
  const key: MusicalKey = useMemo(() => ({ root, scale }), [root, scale]);
  const inKeyOnly = assist && scale !== 'chromatic';
  const g = spec.ticks;

  const clipTicks = clip.bars * TICKS_PER_BAR;
  const a = pageStartTick(page);
  const selKey = selectionKey(trackId, slot, clip.id);
  const rawSel = useSelectedIds(selKey);
  const selSet = useMemo(() => {
    const exists = new Set(clip.notes.map((n) => n.id));
    return new Set(rawSel.filter((id) => exists.has(id) || id === DRAW_ID));
  }, [rawSel, clip.notes]);

  const [preview, setPreview] = useState<Note[] | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const shown = preview ?? clip.notes;

  const usedKey = useMemo(() => [...new Set(clip.notes.map((n) => n.pitch))].sort((x, y) => x - y).join(','), [clip.notes]);
  const rows = useMemo(() => pitchRows({ assist, root, scale, used: usedKey ? usedKey.split(',').map(Number) : [] }), [assist, root, scale, usedKey]);
  const rowOf = useMemo(() => new Map(rows.map((r, i) => [r.pitch, i])), [rows]);
  const views = useMemo(() => pageNoteViews(shown, page, clipTicks, g), [shown, page, clipTicks, g]);
  const voices = useMemo(() => velocityVoices(clip.notes, page, spec, selSet), [clip.notes, page, spec, selSet]);
  const nameOf = useCallback((p: number) => noteName(p, key), [key]);

  // The keyboard cursor: a cell (as a tick inside the page, so it survives a grid change) and a pitch.
  const [cursor, setCursor] = useState(() => ({ tick: 0, pitch: rows[nearestRow(rows, focusPitch(clip.notes, kind))]?.pitch ?? 60 }));
  const [announce, setAnnounce] = useState('');
  const cursorCell = Math.min(spec.cells - 1, Math.max(0, Math.floor(cursor.tick / g)));
  const cursorRow = rowOf.get(cursor.pitch) ?? nearestRow(rows, cursor.pitch);
  const cursorPitch = rows[cursorRow]?.pitch ?? cursor.pitch;

  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLButtonElement>(null);
  const colRefs = useRef<(HTMLDivElement | null)[]>([]);
  const drag = useRef<Drag | null>(null);
  /** The last click that ended on a note (for double-click), and whether that click created it. */
  const lastClick = useRef<{ noteId: Id; at: number; x: number; y: number; created: boolean } | null>(null);
  /** The cursor was last placed from the keyboard: paste goes there (else to the shown bar's start). */
  const keyCursor = useRef(false);
  /** A finger owns the roll (after a hold or a sideways start): the browser must not scroll. */
  const touchOwned = useRef(false);
  const burst = useKeyBurst();

  // Latest values for event handlers (first layout effect: later ones read it).
  const cur = useRef({ trackId, slot, page, clip, rows, clipTicks, spec, key, inKeyOnly, selKey });
  useLayoutEffect(() => {
    cur.current = { trackId, slot, page, clip, rows, clipTicks, spec, key, inKeyOnly, selKey };
  });

  /* ---------- selection ---------- */

  const getSel = (): Id[] => {
    const c = cur.current;
    const exists = new Set(c.clip.notes.map((n) => n.id));
    return selectedIdsFor(c.selKey).filter((id) => exists.has(id));
  };
  const setSel = (ids: readonly Id[]) => setSelectedIds(cur.current.selKey, ids);

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

  // While a finger owns the roll, the browser must not scroll it (touchmove is passive in React: listen natively).
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const stop = (e: TouchEvent) => {
      if (touchOwned.current && e.cancelable) e.preventDefault();
    };
    el.addEventListener('touchmove', stop, { passive: false });
    return () => el.removeEventListener('touchmove', stop);
  }, []);

  /* ---------- hit testing ---------- */

  /**
   * Cell under x. With `beyond`, a pointer right of the last column keeps
   * counting into the following bars (for drawing and stretching notes past
   * the page edge).
   */
  const cellAt = (x: number, beyond = false): { cell: number; frac: number } => {
    const n = cur.current.spec.cells;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const el = colRefs.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x < r.right) return { cell: i, frac: (x - r.left) / Math.max(1, r.width) };
      const d = x < r.left ? r.left - x : x - r.right;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const r = colRefs.current[best]?.getBoundingClientRect();
    if (beyond && r && best === n - 1 && x >= r.right) {
      const stride = Math.max(1, r.width + 1);
      const over = (x - r.right) / stride;
      return { cell: n - 1 + Math.ceil(over), frac: over % 1 };
    }
    return { cell: best, frac: r && x >= r.right ? 1 : 0 };
  };

  /** The clip tick under x on the shown page (continuous; held inside the page). */
  const rawTickAt = (x: number): number => {
    const c = cur.current;
    const { cell, frac } = cellAt(x);
    return pageStartTick(c.page) + (cell + frac) * c.spec.ticks;
  };

  const rowAt = (y: number): number => {
    const el = gridRef.current;
    const n = cur.current.rows.length;
    if (!el || n === 0) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(n - 1, Math.max(0, Math.floor((y - r.top) / (r.height / n))));
  };

  /** -1 left of the first column, 1 right of the last, else 0. */
  const edgeOf = (x: number): number => {
    const first = colRefs.current[0]?.getBoundingClientRect();
    const last = colRefs.current[cur.current.spec.cells - 1]?.getBoundingClientRect();
    if (first && x < first.left) return -1;
    if (last && x > last.right) return 1;
    return 0;
  };

  const noteById = (id: Id): Note | undefined => cur.current.clip.notes.find((n) => n.id === id);

  const targetAt = (el: Element | null, x: number, y: number): Target | null => {
    const c = cur.current;
    const keyEl = el?.closest<HTMLElement>('[data-row-label]');
    if (keyEl) return { on: 'label', pitch: Number(keyEl.dataset.rowLabel) };
    const noteEl = el?.closest<HTMLElement>('[data-note-id]');
    if (noteEl) {
      const note = noteById(noteEl.dataset.noteId ?? '');
      if (note) return { on: 'note', note, handle: !!el?.closest('[data-handle]') };
    }
    const { cell } = cellAt(x);
    const row = rowAt(y);
    if (c.rows[row] === undefined) return null;
    // A gap between cells inside a long note: that note.
    const covering = noteCovering(c.clip.notes, pageStartTick(c.page) + cell * c.spec.ticks, c.rows[row].pitch);
    if (covering) return { on: 'note', note: covering, handle: false };
    return { on: 'empty', cell, row };
  };

  const cursorFor = (note: Note) => {
    const c = cur.current;
    if (note.tick >= pageStartTick(c.page) && note.tick < pageStartTick(c.page) + TICKS_PER_BAR) setCursor({ tick: note.tick - pageStartTick(c.page), pitch: note.pitch });
  };

  const focusRoll = () => {
    keyCursor.current = false;
    if (document.activeElement !== cursorRef.current) cursorRef.current?.focus({ preventScroll: true });
  };

  /* ---------- edits shared by pointer and keys ---------- */

  const deleteIds = (ids: readonly Id[], verb = 'Deleted') => {
    const c = cur.current;
    if (ids.length === 0) return;
    const r = cmd.deleteNotes(session.store, c.trackId, c.slot, ids);
    if (!session.accepted(r)) return;
    setSel(getSel().filter((id) => !ids.includes(id)));
    lastClick.current = null;
    const text = `${verb} ${plural(r.deleted, 'note')}`;
    notify(`${text}.`, 'info', 'undo');
    setAnnounce(text);
  };

  /** One drop of a dragged selection, as one undo step (see MovePlan). */
  const commitMove = (ids: readonly Id[], plan: MovePlan): void => {
    const c = cur.current;
    if (plan.dTick === 0 && plan.dPitch === 0 && plan.steps === 0) return;
    const sel = selectedNotes(c.clip.notes, new Set(ids));
    if (sel.length === 0) return;
    const store = session.store;
    let r: ReturnType<typeof cmd.moveNotes> | ReturnType<typeof cmd.transposeNotes>;
    if (!plan.key || plan.steps === 0) {
      r = cmd.moveNotes(store, c.trackId, c.slot, ids, plan.dTick, plan.dPitch, undefined, { collide: 'replace' });
    } else if (plan.dTick === 0) {
      r = cmd.transposeNotes(store, c.trackId, c.slot, ids, plan.steps, { inScale: plan.key, collide: 'replace' });
    } else {
      const pitches = plannedPitches(sel, plan);
      const deltas = [...new Set(sel.map((n) => (pitches.get(n.id) ?? n.pitch) - n.pitch))];
      if (deltas.length === 1) {
        r = cmd.moveNotes(store, c.trackId, c.slot, ids, plan.dTick, deltas[0], undefined, { collide: 'replace' });
      } else {
        // Chord voices move by different semitones in the key: time, then pitch, joined into one undo step.
        const timeFirst = new Map(sel.map((n) => [n.id, { tick: n.tick + plan.dTick, pitch: n.pitch }]));
        const pitchFirst = new Map(sel.map((n) => [n.id, { tick: n.tick, pitch: pitches.get(n.id) ?? n.pitch }]));
        const grouped = !session.recordingNotes;
        if (grouped) store.beginGroup('notes:Move notes');
        try {
          if (landsFree(c.clip.notes, timeFirst)) {
            cmd.moveNotes(store, c.trackId, c.slot, ids, plan.dTick, 0, undefined, { collide: 'refuse' });
            r = cmd.transposeNotes(store, c.trackId, c.slot, ids, plan.steps, { inScale: plan.key, collide: 'replace' });
          } else if (landsFree(c.clip.notes, pitchFirst)) {
            cmd.transposeNotes(store, c.trackId, c.slot, ids, plan.steps, { inScale: plan.key, collide: 'refuse' });
            r = cmd.moveNotes(store, c.trackId, c.slot, ids, plan.dTick, 0, undefined, { collide: 'replace' });
          } else {
            const anchor = anchorNote(sel);
            const d = anchor ? (pitches.get(anchor.id) ?? anchor.pitch) - anchor.pitch : 0;
            r = cmd.moveNotes(store, c.trackId, c.slot, ids, plan.dTick, d, undefined, { collide: 'replace' });
          }
        } finally {
          if (grouped) store.endGroup();
        }
      }
    }
    if (!session.accepted(r)) return;
    if (r.replaced > 0) notify(`Moved ${plural(sel.length, 'note')}. Replaced ${plural(r.replaced, 'note')}.`, 'info', 'undo');
    else if (r.message) notify(r.message);
    const moved = selectedNotes(session.store.getState().tracks.find((t) => t.id === c.trackId)?.clips[c.slot]?.notes ?? [], new Set(ids));
    const anchor = anchorNote(moved);
    if (anchor) setAnnounce(`Moved ${plural(moved.length, 'note')}: ${nameOf(anchor.pitch)}, bar ${pageOfTick(anchor.tick) + 1}`);
  };

  /* ---------- pointer: starting a gesture ---------- */

  const startPress = (pointerId: number, note: Note, x: number, y: number, mods: Mods, fromTouch: boolean): void => {
    const c = cur.current;
    const sel = getSel();
    const isSel = sel.includes(note.id);
    const mod = mods.shift || mods.ctrl;
    const lc = lastClick.current;
    if (!fromTouch && !mod && lc && lc.noteId === note.id && !lc.created && performance.now() - lc.at < DOUBLE_MS && Math.hypot(x - lc.x, y - lc.y) < DRAG_PX * 2) {
      // Double-click: remove the selection (the first click selected this note).
      lastClick.current = null;
      deleteIds(isSel ? sel : [note.id]);
      return;
    }
    let ids: Id[];
    let toggleOff = false;
    let collapse = false;
    if (mod) {
      if (isSel) {
        toggleOff = true;
        ids = sel;
      } else {
        ids = [...sel, note.id];
        setSel(ids);
      }
    } else if (!isSel) {
      ids = [note.id];
      setSel(ids);
    } else {
      ids = sel;
      collapse = sel.length > 1;
    }
    cursorFor(note);
    setAnnounce(`${nameOf(note.pitch)} selected${ids.length > 1 ? `, ${ids.length} notes in the selection` : ''}`);
    drag.current = {
      kind: 'press',
      pointerId,
      noteId: note.id,
      ids,
      x0: x,
      y0: y,
      lastX: x,
      lastY: y,
      alt: mods.alt,
      toggleOff,
      collapse,
      mod,
      grabTick: rawTickAt(x),
      anchorPitch: note.pitch,
      moved: false,
      plan: NO_MOVE,
      sound: audition(c.trackId, note.pitch, note.velocity),
      edgeSide: 0,
      edgeTimer: 0,
      edgeTurns: 0,
    };
  };

  const startDraw = (pointerId: number, cell: number, row: number): void => {
    const c = cur.current;
    const pitch = c.rows[row]?.pitch;
    if (pitch === undefined) return;
    const tick = pageStartTick(c.page) + cell * c.spec.ticks;
    const duration = Math.min(c.spec.ticks, c.clipTicks - tick);
    setCursor({ tick: cell * c.spec.ticks, pitch });
    drag.current = { kind: 'draw', pointerId, tick, pitch, cell, duration, sound: audition(c.trackId, pitch, cmd.DEFAULT_STEP_VELOCITY) };
    setSel([DRAW_ID]);
    setPreview([...c.clip.notes, { id: DRAW_ID, tick, pitch, velocity: cmd.DEFAULT_STEP_VELOCITY, duration }]);
  };

  const startResize = (pointerId: number, note: Note): void => {
    const sel = getSel();
    const isSel = sel.includes(note.id);
    const ids = isSel && sel.length > 1 ? sel : [note.id];
    if (!isSel) setSel([note.id]);
    const notes = cur.current.clip.notes;
    const start = new Map(ids.flatMap((id) => {
      const n = notes.find((x) => x.id === id);
      return n ? [[id, { tick: n.tick, duration: n.duration }] as const] : [];
    }));
    drag.current = { kind: 'resize', pointerId, anchorId: note.id, ids, start, delta: 0, gesture: newGestureId('steps-length') };
  };

  /** What a press does once it is a gesture (a mouse press at once; a finger after a hold or a sideways start). */
  const begin = (pointerId: number, target: Target, x: number, y: number, mods: Mods, fromTouch: boolean): void => {
    session.store.endGesture();
    const c = cur.current;
    if (target.on === 'label') {
      // The note names are keys: a mouse press plays the pitch (a finger plays it on a tap only).
      if (!fromTouch) drag.current = { kind: 'key', pointerId, sound: audition(c.trackId, target.pitch, 0.8) };
      return;
    }
    if (target.on === 'note') {
      if (target.handle) startResize(pointerId, target.note);
      else startPress(pointerId, target.note, x, y, mods, fromTouch);
      return;
    }
    if (mods.shift) {
      drag.current = { kind: 'box', pointerId, x0: x, y0: y, base: mods.ctrl ? getSel() : [], moved: false };
      return;
    }
    startDraw(pointerId, target.cell, target.row);
  };

  const capture = (pointerId: number) => {
    try {
      gridRef.current?.setPointerCapture(pointerId);
    } catch {
      /* synthetic pointer */
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) return;
    const target = targetAt(e.target as Element, e.clientX, e.clientY);
    if (!target) return;
    if (e.pointerType === 'touch') {
      // Wait: a swipe scrolls (touch-action: pan-y), a tap adds or removes, a rest or a sideways start edits.
      if (!e.isPrimary) return;
      const pointerId = e.pointerId;
      const timer = window.setTimeout(() => {
        const d = drag.current;
        if (!d || d.kind !== 'touch' || d.pointerId !== pointerId) return;
        d.timer = 0;
        drag.current = null;
        touchOwned.current = true;
        capture(pointerId);
        begin(pointerId, d.target, d.x0, d.y0, NO_MODS, true);
        if (!drag.current) touchOwned.current = false;
      }, TOUCH_HOLD);
      drag.current = { kind: 'touch', pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), target, timer };
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    capture(e.pointerId);
    focusRoll();
    begin(e.pointerId, target, e.clientX, e.clientY, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey }, false);
  };

  /* ---------- pointer: during a gesture ---------- */

  const updateMove = (d: Extract<Drag, { kind: 'press' }>): void => {
    const c = cur.current;
    const sel = selectedNotes(c.clip.notes, new Set(d.ids));
    if (sel.length === 0) return;
    const raw = rawTickAt(d.lastX) - d.grabTick;
    const want = d.alt ? Math.round(raw) : Math.round(raw / c.spec.ticks) * c.spec.ticks;
    const dTick = clampMoveTicks(sel, want, c.clipTicks);
    const targetPitch = c.rows[rowAt(d.lastY)]?.pitch ?? d.anchorPitch;
    const plan: MovePlan = c.inKeyOnly
      ? { dTick, dPitch: 0, steps: scaleStepsBetween(d.anchorPitch, targetPitch, c.key), key: c.key }
      : { dTick, dPitch: clampMovePitch(sel, targetPitch - d.anchorPitch), steps: 0, key: null };
    const was = d.plan;
    if (plan.dTick === was.dTick && plan.dPitch === was.dPitch && plan.steps === was.steps) return;
    d.plan = plan;
    const ids = new Set(d.ids);
    setPreview(previewMovedNotes(c.clip.notes, ids, plan));
    const grabbed = sel.find((n) => n.id === d.noteId) ?? sel[0];
    const before = plannedPitches([grabbed], was).get(grabbed.id);
    const after = plannedPitches([grabbed], plan).get(grabbed.id) ?? grabbed.pitch;
    if (before !== after) {
      d.sound?.release();
      d.sound = audition(c.trackId, after, grabbed.velocity);
    }
  };

  /** A dragged selection held past the page edge turns the page after EDGE_TURN_MS (again while it stays there). */
  const updateEdge = (d: Extract<Drag, { kind: 'press' }>): void => {
    const c = cur.current;
    const side = edgeOf(d.lastX);
    const next = c.page + side;
    const can = side !== 0 && next >= 0 && next < c.clip.bars;
    if (!can) {
      window.clearTimeout(d.edgeTimer);
      d.edgeTimer = 0;
      d.edgeSide = 0;
      if (side === 0) d.edgeTurns = 0;
      return;
    }
    if (side === d.edgeSide && d.edgeTimer) return;
    window.clearTimeout(d.edgeTimer);
    d.edgeSide = side;
    d.edgeTimer = window.setTimeout(
      () => {
        d.edgeTimer = 0;
        d.edgeSide = 0;
        if (drag.current !== d) return;
        const cc = cur.current;
        const to = cc.page + side;
        if (to < 0 || to >= cc.clip.bars) return;
        d.edgeTurns++;
        setStepPage(cc.trackId, to);
      },
      d.edgeTurns ? EDGE_REPEAT_MS : EDGE_TURN_MS,
    );
  };

  // The page turned under a drag: the same pointer now points into the new bar.
  useLayoutEffect(() => {
    const d = drag.current;
    if (d?.kind !== 'press' || !d.moved) return;
    updateMove(d);
    updateEdge(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const updateBox = (d: Extract<Drag, { kind: 'box' }>, x: number, y: number): void => {
    const c = cur.current;
    const el = gridRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(r.left, Math.min(d.x0, x));
    const right = Math.min(r.right, Math.max(d.x0, x));
    const top = Math.max(r.top, Math.min(d.y0, y));
    const bottom = Math.min(r.bottom, Math.max(d.y0, y));
    setBox({ left: left - r.left, top: top - r.top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) });
    const t0 = rawTickAt(left);
    const t1 = rawTickAt(right);
    const r0 = rowAt(top);
    const r1 = rowAt(bottom);
    const pitches = new Set(c.rows.slice(r0, r1 + 1).map((row) => row.pitch));
    setSel([...d.base, ...notesInBox(c.clip.notes, t0, t1, pitches)]);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const c = cur.current;
    if (d.kind === 'touch') {
      const intent = touchIntent(e.clientX - d.x0, e.clientY - d.y0);
      if (intent === 'pending') return;
      window.clearTimeout(d.timer);
      drag.current = null;
      if (intent === 'scroll') return; // The browser scrolls the roll.
      // A sideways start: edit at once, from where the finger landed.
      touchOwned.current = true;
      capture(d.pointerId);
      begin(d.pointerId, d.target, d.x0, d.y0, NO_MODS, true);
      if (!drag.current) {
        touchOwned.current = false;
        return;
      }
      onPointerMove(e);
      return;
    }
    if (d.kind === 'draw') {
      const { cell, frac } = cellAt(e.clientX, true);
      const end = e.altKey ? pageStartTick(c.page) + (cell + frac) * c.spec.ticks : pageStartTick(c.page) + (Math.max(cell, d.cell) + 1) * c.spec.ticks;
      const dur = Math.round(Math.min(c.clipTicks - d.tick, Math.max(e.altKey ? MIN_TICKS : c.spec.ticks, end - d.tick)));
      if (dur === d.duration) return;
      d.duration = dur;
      setPreview([...c.clip.notes, { id: DRAW_ID, tick: d.tick, pitch: d.pitch, velocity: cmd.DEFAULT_STEP_VELOCITY, duration: dur }]);
      return;
    }
    if (d.kind === 'resize') {
      const anchor = d.start.get(d.anchorId);
      if (!anchor) return;
      const { cell, frac } = cellAt(e.clientX, true);
      const within = e.altKey ? cell + frac : e.shiftKey ? cell + Math.round(frac * 4) / 4 : cell + 1;
      const end = pageStartTick(c.page) + within * c.spec.ticks;
      const dur = Math.round(Math.min(c.clipTicks - anchor.tick, Math.max(MIN_TICKS, end - anchor.tick)));
      const delta = dur - anchor.duration;
      if (delta === d.delta) return;
      d.delta = delta;
      for (const id of d.ids) {
        const s = d.start.get(id);
        if (!s) continue;
        const r = cmd.setNoteDuration(session.store, c.trackId, c.slot, id, Math.max(MIN_TICKS, Math.min(c.clipTicks - s.tick, s.duration + delta)), d.gesture);
        if (r.refused) {
          session.accepted(r);
          drag.current = null;
          return;
        }
      }
      return;
    }
    if (d.kind === 'press') {
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      d.alt = e.altKey;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_PX) return;
      d.moved = true;
      updateMove(d);
      updateEdge(d);
      return;
    }
    if (d.kind === 'box') {
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_PX) return;
      d.moved = true;
      updateBox(d, e.clientX, e.clientY);
    }
  };

  /* ---------- pointer: the end ---------- */

  /** A finger tap: add a note on an empty cell, remove a note, or hear a note name. */
  const tap = (t: Target): void => {
    const c = cur.current;
    if (t.on === 'label') {
      auditionBlip(c.trackId, t.pitch, 0.8);
      return;
    }
    if (t.on === 'note') {
      deleteIds([t.note.id]);
      return;
    }
    const pitch = c.rows[t.row]?.pitch;
    if (pitch === undefined) return;
    const tick = pageStartTick(c.page) + t.cell * c.spec.ticks;
    const r = cmd.addNote(session.store, c.trackId, c.slot, { tick, pitch, velocity: cmd.DEFAULT_STEP_VELOCITY, duration: Math.min(c.spec.ticks, c.clipTicks - tick) });
    if (!session.accepted(r) || !r.noteId) return;
    setSel([r.noteId]);
    setCursor({ tick: t.cell * c.spec.ticks, pitch });
    auditionBlip(c.trackId, pitch, cmd.DEFAULT_STEP_VELOCITY);
    setAnnounce(`${nameOf(pitch)}, ${cellWords(t.cell, c.spec)}: note added`);
  };

  const finish = (e: PointerEvent<HTMLDivElement>, ok: boolean): void => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    touchOwned.current = false;
    const c = cur.current;
    switch (d.kind) {
      case 'touch':
        window.clearTimeout(d.timer);
        if (ok && isTap(e.clientX - d.x0, e.clientY - d.y0, performance.now() - d.t0)) tap(d.target);
        break;
      case 'key':
        d.sound.release();
        break;
      case 'draw': {
        d.sound.release();
        setPreview(null);
        if (!ok) {
          setSel([]);
          break;
        }
        const r = cmd.addNote(session.store, c.trackId, c.slot, { tick: d.tick, pitch: d.pitch, velocity: cmd.DEFAULT_STEP_VELOCITY, duration: d.duration });
        if (!session.accepted(r) || !r.noteId) {
          setSel([]);
          break;
        }
        setSel([r.noteId]);
        lastClick.current = { noteId: r.noteId, at: performance.now(), x: e.clientX, y: e.clientY, created: true };
        setAnnounce(`${nameOf(d.pitch)}, ${cellWords(d.cell, c.spec)}: note added, ${stepsLabel(d.duration)}`);
        break;
      }
      case 'press':
        window.clearTimeout(d.edgeTimer);
        d.sound?.release();
        if (!d.moved) {
          if (d.toggleOff) setSel(getSel().filter((id) => id !== d.noteId));
          else if (d.collapse) setSel([d.noteId]);
          // A plain click (not Shift or Ctrl) can be the first half of a double-click.
          lastClick.current = d.toggleOff || d.mod ? null : { noteId: d.noteId, at: performance.now(), x: e.clientX, y: e.clientY, created: false };
          break;
        }
        setPreview(null);
        if (ok) commitMove(d.ids, d.plan);
        lastClick.current = null;
        {
          const moved = selectedNotes(session.store.getState().tracks.find((t) => t.id === c.trackId)?.clips[c.slot]?.notes ?? [], new Set([d.noteId]));
          if (moved[0]) cursorFor(moved[0]);
        }
        break;
      case 'box':
        setBox(null);
        break;
      case 'resize':
        break;
    }
    session.store.endGesture();
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => finish(e, true);
  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => finish(e, false);
  // Only the roll's own capture counts: a finger's implicit capture handed over to the roll must not end the gesture.
  const onLostCapture = (e: PointerEvent<HTMLDivElement>) => {
    if (e.target !== gridRef.current) return;
    const d = drag.current;
    if (d && d.pointerId === e.pointerId && d.kind !== 'touch') finish(e, false);
  };

  // Leaving Steps mid-press (switching view, part or clip) must not leave an auditioned note hanging.
  useEffect(
    () => () => {
      const d = drag.current;
      drag.current = null;
      touchOwned.current = false;
      if (!d) return;
      if (d.kind === 'draw' || d.kind === 'key') d.sound.release();
      else if (d.kind === 'press') {
        window.clearTimeout(d.edgeTimer);
        d.sound?.release();
      } else if (d.kind === 'touch') window.clearTimeout(d.timer);
      session.store.endGesture();
    },
    [],
  );

  /* ---------- keyboard ---------- */

  // Reads this render's props (not the ref), so labels never lag an edit behind.
  const describe = (cell: number, pitch: number, onPage = page): string => {
    const notes = clip.notes;
    const tick = pageStartTick(onPage) + cell * g;
    const name = nameOf(pitch);
    const where = cellWords(cell, spec);
    const n = notesStartingAt(notes, tick, g, pitch)[0];
    if (n) return `${name}, ${where}: note${selSet.has(n.id) ? ' (selected)' : ''}, ${stepsLabel(n.duration)}, velocity ${percent(n.velocity)}`;
    if (noteCovering(notes, tick, pitch)) return `${name}, ${where}: held from an earlier step`;
    return `${name}, ${where}: empty`;
  };

  const moveCursor = (cell: number, rowIndex: number, onPage = page) => {
    const r = cur.current.rows;
    const ri = Math.min(r.length - 1, Math.max(0, rowIndex));
    const pitch = r[ri]?.pitch ?? cursorPitch;
    keyCursor.current = true;
    setCursor({ tick: cell * g, pitch });
    setAnnounce(`${onPage !== page ? `Bar ${onPage + 1}. ` : ''}${describe(cell, pitch, onPage)}`);
  };

  /** The note under the cursor: one starting in the cell, else one held through it. */
  const noteAtCursor = (): Note | undefined => {
    const notes = clip.notes;
    const tick = a + cursorCell * g;
    return notesStartingAt(notes, tick, g, cursorPitch)[0] ?? noteCovering(notes, tick, cursorPitch);
  };

  /** After a keyboard edit: show the bar the selection is in and put the cursor on it. */
  const followSelection = (ids: readonly Id[]) => {
    const c = cur.current;
    const notes = session.store.getState().tracks.find((t) => t.id === c.trackId)?.clips[c.slot]?.notes ?? [];
    const anchor = anchorNote(selectedNotes(notes, new Set(ids)));
    if (!anchor) return;
    const p = pageOfTick(anchor.tick);
    if (p !== c.page) setStepPage(c.trackId, p);
    keyCursor.current = true;
    setCursor({ tick: anchor.tick - pageStartTick(p), pitch: anchor.pitch });
    return anchor;
  };

  const moveSelection = (dTick: number): void => {
    const c = cur.current;
    const ids = getSel();
    const r = cmd.moveNotes(session.store, c.trackId, c.slot, ids, dTick, 0, burst(`move:${ids.join(',')}`));
    if (!session.accepted(r)) return;
    if (r.message) notify(r.message);
    const anchor = followSelection(ids);
    if (anchor) setAnnounce(`${plural(ids.length, 'note')} moved to bar ${pageOfTick(anchor.tick) + 1}, ${cellWords(Math.floor((anchor.tick % TICKS_PER_BAR) / g), spec)}`);
  };

  const transposeSelection = (dir: 1 | -1, octave: boolean): void => {
    const c = cur.current;
    const ids = getSel();
    const steps = dir * (octave ? (c.inKeyOnly ? stepsPerOctave(c.key.scale) : 12) : 1);
    const r = cmd.transposeNotes(session.store, c.trackId, c.slot, ids, steps, c.inKeyOnly ? { inScale: c.key } : {});
    if (!session.accepted(r)) return;
    if (r.message) notify(r.message);
    const anchor = followSelection(ids);
    const amount = octave ? 'an octave' : c.inKeyOnly ? 'a step' : 'a semitone';
    if (anchor) setAnnounce(`${plural(ids.length, 'note')} ${dir > 0 ? 'up' : 'down'} ${amount}: ${nameOf(anchor.pitch)}`);
  };

  const lengthenSelection = (ids: readonly Id[], dir: 1 | -1): void => {
    const c = cur.current;
    const gesture = burst(`len:${ids.join(',')}`);
    let last: Note | undefined;
    for (const id of ids) {
      const n = noteById(id);
      if (!n) continue;
      let dur: number;
      if (dir > 0) dur = (Math.floor(n.duration / g) + 1) * g;
      else dur = n.duration > g ? (Math.ceil(n.duration / g) - 1) * g : Math.max(MIN_TICKS, n.duration - MIN_TICKS);
      dur = Math.min(dur, c.clipTicks - n.tick);
      if (!session.accepted(cmd.setNoteDuration(session.store, c.trackId, c.slot, n.id, dur, gesture))) return;
      last = { ...n, duration: dur };
    }
    if (last) setAnnounce(ids.length > 1 ? `${plural(ids.length, 'note')}: length changed` : `${nameOf(last.pitch)}: ${stepsLabel(last.duration)}`);
  };

  const copySelection = (): Omit<Note, 'id'>[] | null => {
    const c = cur.current;
    const ids = getSel();
    if (ids.length === 0) {
      notify(`Select notes first: click one, Shift-drag a box, or press ${MOD_KEY}A for all.`, 'warn');
      return null;
    }
    const notes = cmd.copyNotes(session.store.getState(), c.trackId, c.slot, ids);
    noteClipboard.setState({ notes, source: c.clip.name });
    return notes;
  };

  const paste = (): void => {
    const c = cur.current;
    const board = noteClipboard.getState();
    if (!board || board.notes.length === 0) {
      notify(`Copy some notes first (select them, then ${MOD_KEY}C).`, 'warn');
      return;
    }
    const at = pageStartTick(c.page) + (keyCursor.current ? cursorCell * g : 0);
    const r = cmd.pasteNotes(session.store, c.trackId, c.slot, board.notes, at);
    if (!session.accepted(r)) return;
    setSel(r.ids);
    followSelection(r.ids);
    const extra = [r.replaced ? `Replaced ${plural(r.replaced, 'note')}.` : '', r.skipped ? `${plural(r.skipped, 'note')} did not fit.` : ''].filter(Boolean).join(' ');
    notify(`Pasted ${plural(r.added, 'note')} at bar ${pageOfTick(at) + 1}.${extra ? ` ${extra}` : ''}`, 'info', 'undo');
  };

  const duplicate = (): void => {
    const c = cur.current;
    const ids = getSel();
    if (ids.length === 0) {
      notify('Select notes first, then duplicate them.', 'warn');
      return;
    }
    const r = cmd.duplicateNotes(session.store, c.trackId, c.slot, ids);
    if (!session.accepted(r)) return;
    setSel(r.ids);
    followSelection(r.ids);
    const extra = [r.replaced ? `Replaced ${plural(r.replaced, 'note')}.` : '', r.skipped ? `${plural(r.skipped, 'note')} did not fit.` : ''].filter(Boolean).join(' ');
    notify(`Duplicated ${plural(r.added, 'note')}.${extra ? ` ${extra}` : ''}`, 'info', 'undo');
  };

  const onCursorKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const c = cur.current;
    const mod = e.ctrlKey || e.metaKey;
    const sel = getSel();
    if (mod) {
      if (e.altKey || e.shiftKey) return;
      switch (e.key.toLowerCase()) {
        case 'a': {
          const all = c.clip.notes.map((n) => n.id);
          setSel(all);
          setAnnounce(`Selected all ${plural(all.length, 'note')}`);
          break;
        }
        case 'c': {
          const notes = copySelection();
          if (notes) notify(`Copied ${plural(notes.length, 'note')}. Paste with ${MOD_KEY}V.`);
          break;
        }
        case 'x': {
          if (copySelection()) deleteIds(sel, 'Cut');
          break;
        }
        case 'v':
          paste();
          break;
        case 'd':
          duplicate();
          break;
        default:
          return;
      }
      e.preventDefault();
      return;
    }
    const cell = cursorCell;
    switch (e.key) {
      case 'Escape': {
        const d = drag.current;
        if (d && d.kind === 'press' && d.moved) {
          // Cancel the drag: the notes stay where they were.
          window.clearTimeout(d.edgeTimer);
          d.sound?.release();
          drag.current = null;
          setPreview(null);
          break;
        }
        if (sel.length === 0) return;
        setSel([]);
        setAnnounce('Selection cleared');
        break;
      }
      case 'Delete':
      case 'Backspace': {
        const n = sel.length ? null : noteAtCursor();
        if (sel.length) deleteIds(sel);
        else if (n) deleteIds([n.id]);
        else return;
        break;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        if (sel.length) {
          if (e.shiftKey) lengthenSelection(sel, dir);
          else moveSelection(dir * (e.altKey ? cmd.NUDGE_TICKS : g));
          break;
        }
        if (e.altKey) return;
        if (e.shiftKey) {
          const n = noteAtCursor();
          if (n) lengthenSelection([n.id], dir);
          break;
        }
        const next = cell + dir;
        if (next > spec.cells - 1 && page < c.clip.bars - 1) {
          setStepPage(c.trackId, page + 1);
          moveCursor(0, cursorRow, page + 1);
        } else if (next < 0 && page > 0) {
          setStepPage(c.trackId, page - 1);
          moveCursor(spec.cells - 1, cursorRow, page - 1);
        } else moveCursor(Math.min(spec.cells - 1, Math.max(0, next)), cursorRow);
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        if (sel.length) {
          if (e.altKey) return;
          transposeSelection(dir, e.shiftKey);
          break;
        }
        if (e.altKey) return;
        if (e.shiftKey) moveCursor(cell, nearestRow(c.rows, cursorPitch + dir * 12));
        else moveCursor(cell, cursorRow - dir);
        break;
      }
      case 'PageUp':
        moveCursor(cell, nearestRow(c.rows, cursorPitch + 12));
        break;
      case 'PageDown':
        moveCursor(cell, nearestRow(c.rows, cursorPitch - 12));
        break;
      case 'Home':
        moveCursor(0, cursorRow);
        break;
      case 'End':
        moveCursor(spec.cells - 1, cursorRow);
        break;
      case 'Enter':
      case ' ': {
        if (e.repeat) break;
        const n = noteAtCursor();
        if (n) {
          // A note: put it in the selection, or take it out.
          const next = sel.includes(n.id) ? sel.filter((id) => id !== n.id) : [...sel, n.id];
          setSel(next);
          setAnnounce(`${nameOf(n.pitch)} ${sel.includes(n.id) ? 'taken out of' : 'added to'} the selection (${plural(next.length, 'note')})`);
          break;
        }
        const tick = a + cell * g;
        const r = cmd.addNote(session.store, c.trackId, c.slot, { tick, pitch: cursorPitch, velocity: cmd.DEFAULT_STEP_VELOCITY, duration: Math.min(g, c.clipTicks - tick) });
        if (session.accepted(r)) {
          auditionBlip(c.trackId, cursorPitch, cmd.DEFAULT_STEP_VELOCITY);
          setAnnounce(`${nameOf(cursorPitch)}, ${cellWords(cell, spec)}: note added`);
        }
        break;
      }
      case '+':
      case '=':
      case '-':
      case '_': {
        const up = e.key === '+' || e.key === '=';
        if (sel.length) {
          const r = cmd.setNotesVelocity(session.store, c.trackId, c.slot, sel, { delta: up ? 0.1 : -0.1 }, burst(`vel:${sel.join(',')}`));
          if (session.accepted(r)) setAnnounce(`Velocity ${up ? 'up' : 'down'} for ${plural(sel.length, 'note')}`);
          break;
        }
        const n = noteAtCursor();
        if (!n) break;
        const v = clampVelocity(n.velocity + (up ? 0.1 : -0.1));
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
    if (document.activeElement === cursorRef.current && keyCursor.current) cursorRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [cursor, cursorRow]);

  /* ---------- velocity ---------- */

  const setVelocities = useCallback((ids: Id[], velocity: number, gesture: string) => {
    const c = cur.current;
    session.accepted(cmd.setNotesVelocity(session.store, c.trackId, c.slot, ids, velocity, gesture));
  }, []);

  const keyText = inKeyOnly ? keyLabel(root, scale) : 'All notes';
  const keyShort = inKeyOnly ? keyShortName(root, scale) : 'All';
  const selCount = selSet.size - (selSet.has(DRAW_ID) ? 1 : 0);
  const cols = cellIndices(spec.cells);

  return (
    <div className={styles.melodic} style={gridStyle(spec)}>
      <StepNumbers
        className={styles.gutter}
        grid={spec}
        label={
          <div className={styles.octNav}>
            <IconButton icon="chevronUp" label="Show higher notes (an octave up)" size="sm" variant="ghost" onClick={() => scrollOctave(1)} disabled={view.atTop} className={styles.octBtn} />
            <IconButton icon="chevronDown" label="Show lower notes (an octave down)" size="sm" variant="ghost" onClick={() => scrollOctave(-1)} disabled={view.atBottom} className={styles.octBtn} />
            <KeyChip
              text={keyText}
              short={keyShort}
              label={inKeyOnly ? `Rows in key: ${keyText}` : 'Rows: all 12 notes'}
              tip={inKeyOnly ? `Rows show the notes of ${keyText} (Musical Assist is on).` : 'Rows show all 12 notes (Musical Assist is off).'}
              detail="Switch Musical Assist or the key on the keyboard strip."
            />
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
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onLostCapture}
          onContextMenu={(e) => {
            if (drag.current || touchOwned.current) e.preventDefault();
          }}
          data-testid="pitch-roll"
          data-cells={spec.cells}
        >
          {rows.map((r, i) => (
            <RowBack key={r.pitch} row={r} index={i} />
          ))}
          {cols.map((s) => (
            <div
              key={s}
              ref={(el) => {
                colRefs.current[s] = el;
              }}
              className={styles.col}
              style={{ gridColumn: cellColumn(s, spec.perBeat), gridRow: '1 / -1' }}
              data-beat={s % spec.perBeat === 0 || undefined}
              data-ph-step={s}
              data-col={s}
            />
          ))}
          {views.map((v) => {
            const row = rowOf.get(v.pitch);
            return row === undefined ? null : <NoteBlock key={v.id} view={v} row={row} perBeat={spec.perBeat} name={nameOf(v.pitch)} selected={selSet.has(v.id)} />;
          })}
          {box && <div className={styles.box} style={{ left: box.left, top: box.top, width: box.width, height: box.height }} aria-hidden="true" />}
          <button
            ref={cursorRef}
            type="button"
            data-steps-entry=""
            className={styles.cursor}
            style={{ gridRow: cursorRow + 1, gridColumn: cellColumn(cursorCell, spec.perBeat) }}
            aria-label={`Note grid, bar ${page + 1}. ${describe(cursorCell, cursorPitch)}${selCount ? `. ${plural(selCount, 'note')} selected` : ''}`}
            aria-describedby="steps-roll-help"
            aria-keyshortcuts={`Delete ${MOD_ARIA}+A ${MOD_ARIA}+C ${MOD_ARIA}+X ${MOD_ARIA}+V ${MOD_ARIA}+D`}
            onKeyDown={onCursorKey}
            onFocus={() => setAnnounce('')}
          />
        </div>
      </div>
      <span id="steps-roll-help" className="visually-hidden">
        Arrow keys move the cursor; with notes selected they move the notes (Shift with Up or Down: an octave; Alt with Left or Right: a nudge). Enter adds a note, or selects the note
        there. Delete removes the selected notes. Shift with Left or Right changes length. Plus and minus change velocity. {MOD_KEY}A selects all, {MOD_KEY}C copies, {MOD_KEY}X cuts,{' '}
        {MOD_KEY}V pastes at the cursor, {MOD_KEY}D duplicates. Escape clears the selection. Page Up and Page Down jump an octave.
      </span>
      <span className="visually-hidden" aria-live="polite">
        {announce}
      </span>
      <VelocityLane
        className={`${styles.velocity} ${styles.gutter}`}
        grid={spec}
        voices={voices}
        hasSelection={selCount > 0}
        onSetNotes={setVelocities}
        title="Velocity"
        hint={selCount > 0 ? <span className={styles.selHint}>{plural(selCount, 'note')} selected</span> : 'Drag · per step'}
      />
    </div>
  );
}
