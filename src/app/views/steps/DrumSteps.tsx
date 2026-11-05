/**
 * Drum steps. The overview is the whole kit for this bar (16 sounds x 16
 * steps), drawn and played like a drum machine's grid: a click on a cell
 * toggles that sound at that step and selects the sound; pressing a cell and
 * dragging along the row paints (or erases, when the first cell was on)
 * every step it crosses, as one undo step. It is one ARIA grid with one Tab
 * stop: arrow keys move (up/down also choose the sound), Enter toggles the
 * focused step, and on a sound's name plays it. Space stays Play / Pause
 * here (data-space-plays), as everywhere a pattern is edited. The large
 * numbered pads below edit the selected sound, with its velocity; they paint
 * the same way. A sound's menu (right-click its name, Shift+F10, or the ⋯ by
 * the selected sound) clears it, fills it on every beat, 8th or 16th, or
 * shifts it a step earlier or later.
 *
 * A short clip shows all its bars side by side (`span`, chosen by the editor
 * from the room it has); the columns then run on across the bars. In Simple
 * the grid shows the eight main kit sounds (and any sound the clip uses)
 * with "Show all 16"; Advanced always shows all 16. The voice ids never
 * change, only which rows are drawn.
 */
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { createStore, useStore } from '../../../state/store';
import { getKitVoiceNames } from '../../../audio/instruments/kits';
import { DRUM_VOICES, STEPS_PER_BAR, type Clip, type Id } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { drumVoiceFor, selectDrumVoice } from '../../../state/uiStore';
import { TOUCH_SLOP_PX, Tooltip, newGestureId } from '../../../ui/components';
import { session, useUi } from '../../instance';
import { notify } from '../../runtime';
import { LOCKED_REASON, MenuHeader, MenuItem, MenuSeparator, MoreIcon, Popover, anchorFromContextEvent, anchorFromElement, isEchoOfKeyboardMenu, isMenuKey, noteKeyboardMenu, useEditLocked, type MenuAnchor } from '../ClipMenu';
import { STEP_GRID, barsWords, cellColumn, cellIndices, clampVelocity, drumPageGrid, noteIdsAt, percent, spanSpec, velocityBucket } from './model';
import { auditionBlip, useKeyBurst } from './shared';
import { StepNumbers, VelocityLane, gridStyle } from './StepLanes';
import grid from './StepGrid.module.css';
import styles from './DrumSteps.module.css';

const VOICES = Array.from({ length: DRUM_VOICES }, (_, i) => i);

/**
 * The eight main kit sounds Simple shows (Kick, Snare, Clap, Closed Hat, Open
 * Hat, Rim, Low Tom, Crash): voice ids of every kit.
 */
export const CORE_VOICES: readonly number[] = [0, 2, 3, 4, 5, 7, 8, 12];

const ALL_SOUNDS_KEY = 'switchboard01.stepsAllSounds';
function readAllSounds(): boolean {
  try {
    return globalThis.localStorage?.getItem(ALL_SOUNDS_KEY) === '1';
  } catch {
    return false;
  }
}
/** Simple: all 16 sounds shown (the person's choice, remembered on this device). */
const allSoundsStore = createStore<boolean>(readAllSounds());
export function setAllSounds(on: boolean): void {
  allSoundsStore.setState(on);
  try {
    globalThis.localStorage?.setItem(ALL_SOUNDS_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable: the choice lasts this session */
  }
}

export interface DrumStepsProps {
  trackId: Id;
  slot: number;
  /** The first bar shown. */
  page: number;
  clip: Clip;
  kitId: string;
  /** Bars shown side by side from `page` (default 1). */
  span?: number;
  /** The big pads of the selected sound under the grid (default on; the Song view's editor leaves them out). */
  pads?: boolean;
}

/** "step 5" on one bar; "bar 2, step 5" with bars side by side. */
function stepWords(s: number, span: number): string {
  return span > 1 ? `bar ${Math.floor(s / STEPS_PER_BAR) + 1}, step ${(s % STEPS_PER_BAR) + 1}` : `step ${s + 1}`;
}

const hitWords = (n: number) => (n === 0 ? 'no hits' : `${n} hit${n === 1 ? '' : 's'}`);

/* ------------------------------------------------------------------ */
/* Painting                                                            */
/* ------------------------------------------------------------------ */

interface Paint {
  pointerId: number;
  voice: number;
  /** The state the first cell took: every step entered gets it. */
  on: boolean;
  gesture: string;
  /** Steps of the page already painted in this drag. */
  done: Set<number>;
  last: number;
  /** Horizontal extent of each step's target on screen, read once when the drag starts. */
  cols: { left: number; right: number }[];
}

/** The step whose column holds x, or the nearest one. */
function stepAt(cols: Paint['cols'], x: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let s = 0; s < cols.length; s++) {
    const c = cols[s];
    if (x >= c.left && x <= c.right) return s;
    const d = Math.min(Math.abs(x - c.left), Math.abs(x - c.right));
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/**
 * Paint drags shared by the overview and the pad lane: the first press sets
 * the new state of the step under it (on when it was off, off when it was
 * on), and every step the pointer then enters along the row gets that state
 * (steps skipped by a fast drag included). One gesture id: one undo step.
 */
function usePaint(cur: { current: { trackId: Id; slot: number; page: number; span: number; clip: Clip } }) {
  const paint = useRef<Paint | null>(null);
  /** Paint the steps not painted yet in this drag; false when the edit was refused (the drag then stops, saying why once). */
  const apply = useCallback((p: Paint, steps: number[]): boolean => {
    const c = cur.current;
    const fresh = steps.filter((s) => !p.done.has(s));
    if (fresh.length === 0) return true;
    for (const s of fresh) p.done.add(s);
    const r = cmd.paintSteps(session.store, c.trackId, c.slot, p.voice, fresh.map((s) => c.page * STEPS_PER_BAR + s), p.on, p.gesture);
    session.accepted(r);
    return !r.refused && !(r.reason && !r.changed);
  }, [cur]);
  const start = useCallback(
    (pointerId: number, voice: number, step: number, cols: Paint['cols']) => {
      const c = cur.current;
      const was = drumPageGrid(c.clip.notes, c.page, DRUM_VOICES, c.span)[voice]?.[step] ?? -1;
      const on = was < 0;
      session.store.endGesture();
      const p: Paint = { pointerId, voice, on, gesture: newGestureId('steps-paint'), done: new Set(), last: step, cols };
      paint.current = p;
      if (!apply(p, [step])) {
        paint.current = null;
        return;
      }
      if (on) auditionBlip(c.trackId, voice, cmd.DEFAULT_STEP_VELOCITY);
    },
    [cur, apply],
  );
  const move = useCallback(
    (pointerId: number, x: number) => {
      const p = paint.current;
      if (!p || p.pointerId !== pointerId) return;
      const s = stepAt(p.cols, x);
      if (s === p.last) return;
      const from = Math.min(s, p.last);
      const to = Math.max(s, p.last);
      p.last = s;
      if (!apply(p, Array.from({ length: to - from + 1 }, (_, i) => from + i))) paint.current = null;
    },
    [apply],
  );
  const end = useCallback((pointerId?: number) => {
    const p = paint.current;
    if (!p || (pointerId !== undefined && p.pointerId !== pointerId)) return;
    paint.current = null;
    session.store.endGesture();
  }, []);
  return { paint, start, move, end };
}

/* ------------------------------------------------------------------ */
/* Sound menu                                                          */
/* ------------------------------------------------------------------ */

function SoundMenu(props: { trackId: Id; slot: number; voice: number; name: string; clip: Clip; anchor: MenuAnchor; returnFocus: HTMLElement | null; onClose(): void }) {
  const { trackId, slot, voice, name, clip, anchor, returnFocus, onClose } = props;
  const locked = useEditLocked();
  const hits = clip.notes.filter((n) => n.pitch === voice).length;
  const where = clip.bars > 1 ? ` (all ${clip.bars} bars)` : '';
  const none = hits === 0 ? 'No hits yet' : undefined;
  const act = (run: () => cmd.CommandResult, say: (r: cmd.CommandResult) => string) => {
    onClose();
    const r = run();
    if (session.accepted(r)) notify(say(r), 'info', 'undo');
  };
  const fill = (every: 1 | 2 | 4, word: string) =>
    act(
      () => cmd.fillSound(session.store, trackId, slot, voice, every),
      (r) => `Filled ${name} on every ${word}: ${hitWords((r as { added?: number }).added ?? 0)} added.`,
    );
  const shift = (dir: 1 | -1) =>
    act(
      () => cmd.shiftSound(session.store, trackId, slot, voice, dir),
      () => `Shifted ${name} one step ${dir > 0 ? 'later' : 'earlier'}.`,
    );
  return (
    <Popover anchor={anchor} label={`${name} actions`} onClose={onClose} returnFocus={returnFocus}>
      <MenuHeader eyebrow="Sound" title={name} />
      <MenuItem
        icon="trash"
        onSelect={() => act(() => cmd.clearNotesForPitch(session.store, trackId, slot, voice), (r) => `Cleared ${name}: ${hitWords((r as { removed?: number }).removed ?? 0)} removed.`)}
        disabled={locked || hits === 0}
        disabledReason={locked ? LOCKED_REASON : none}
        hint={hits ? `${hitWords(hits)}${where}` : undefined}
      >
        Clear this sound
      </MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={() => fill(4, 'beat')} disabled={locked} disabledReason={LOCKED_REASON}>
        Fill every beat
      </MenuItem>
      <MenuItem onSelect={() => fill(2, '8th')} disabled={locked} disabledReason={LOCKED_REASON}>
        Fill every 8th
      </MenuItem>
      <MenuItem onSelect={() => fill(1, '16th')} disabled={locked} disabledReason={LOCKED_REASON}>
        Fill every 16th
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon="chevronLeft" onSelect={() => shift(-1)} disabled={locked || hits === 0} disabledReason={locked ? LOCKED_REASON : none} hint="a step earlier">
        Shift left
      </MenuItem>
      <MenuItem icon="chevronRight" onSelect={() => shift(1)} disabled={locked || hits === 0} disabledReason={locked ? LOCKED_REASON : none} hint="a step later">
        Shift right
      </MenuItem>
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* Voice overview (the grid)                                           */
/* ------------------------------------------------------------------ */

/**
 * One kit sound: its name (row header) and this bar's 16 steps (cells). The focusable parts
 * are buttons inside the cells (a toggle per step, aria-pressed), so Enter on them reads as a
 * press on a control everywhere in the app. Space is the transport's (the grid has data-space-plays).
 */
const VoiceRow = memo(function VoiceRow(props: { voice: number; index: number; name: string; pattern: string; selected: boolean; page: number; span: number; focusCol: number | null; numbered: boolean }) {
  const { voice, index, name, pattern, selected, page, span, focusCol, numbered } = props;
  const hits = pattern.replace(/0/g, '').length;
  return (
    <div
      role="row"
      className={`${grid.cols} ${styles.voiceRow}`}
      data-selected={selected || undefined}
      data-voice={voice}
      aria-selected={selected}
      aria-rowindex={index + 1}
      aria-label={`${name}: ${hitWords(hits)} in ${barsWords(page, span)}${selected ? ', editing' : ''}`}
    >
      <div role="rowheader" className={styles.voiceHead}>
        <button
          type="button"
          className={styles.voiceName}
          data-voice={voice}
          data-col={0}
          tabIndex={focusCol === 0 ? 0 : -1}
          aria-label={`${name}, ${hitWords(hits)}${selected ? ', editing' : ''}`}
          aria-keyshortcuts="Shift+F10"
        >
          {/* The kit's pad number (Advanced); Simple shows a subset of the kit, where gaps in the numbers would only puzzle. */}
          {numbered && (
            <span className={`${styles.voiceNum} mono`} aria-hidden="true">
              {voice + 1}
            </span>
          )}
          <span className={styles.voiceText} aria-hidden="true">
            {name}
          </span>
        </button>
      </div>
      {cellIndices(pattern.length).map((s) => {
        const on = pattern[s] !== '0';
        return (
          <div key={s} role="gridcell" className={styles.cellWrap} style={{ gridColumn: cellColumn(s, 4) }}>
            <button
              type="button"
              className={styles.cell}
              data-col={s + 1}
              data-v={pattern[s]}
              data-beat={s % 4 === 0 || undefined}
              tabIndex={focusCol === s + 1 ? 0 : -1}
              aria-pressed={on}
              aria-label={`${name}, ${stepWords(s, span)}`}
            >
              <span className={styles.cellBox} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Step pads                                                           */
/* ------------------------------------------------------------------ */

const StepPad = memo(function StepPad(props: { step: number; span: number; velocity: number; voiceName: string; tabbable: boolean; onToggle(step: number): void; onFocusStep(step: number): void }) {
  const { step, span, velocity, voiceName, tabbable, onToggle, onFocusStep } = props;
  const inBar = step % STEPS_PER_BAR;
  const on = velocity >= 0;
  // Pointer presses paint (handled by the lane); clicks from Enter (detail 0) toggle here.
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (e.detail === 0) onToggle(step);
  };
  return (
    <button
      type="button"
      className={styles.step}
      style={{ gridColumn: cellColumn(step, 4), '--vel': String(on ? velocity : 0) } as CSSProperties}
      data-on={on || undefined}
      data-beat={step % 4 === 0 || undefined}
      data-step={step}
      data-ph-step={step}
      tabIndex={tabbable ? 0 : -1}
      data-steps-entry={tabbable ? '' : undefined}
      aria-pressed={on}
      aria-label={`Step ${inBar + 1}, ${span > 1 ? `bar ${Math.floor(step / STEPS_PER_BAR) + 1}, ` : ''}${voiceName}, ${on ? `on, velocity ${percent(velocity)}` : 'off'}`}
      onClick={onClick}
      onFocus={() => onFocusStep(step)}
    >
      <span className={styles.light} aria-hidden="true" />
      <span className={`${styles.stepNum} mono`}>{inBar + 1}</span>
      <span className={`${styles.stepVel} mono`} aria-hidden="true">
        {on ? Math.round(velocity * 100) : ''}
      </span>
    </button>
  );
});

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

export function DrumSteps({ trackId, slot, page, clip, kitId, span = 1, pads = true }: DrumStepsProps) {
  const voice = useUi((s) => drumVoiceFor(s, trackId));
  const names = useMemo(() => getKitVoiceNames(kitId), [kitId]);
  const spec = useMemo(() => spanSpec(STEP_GRID, span), [span]);
  const cells = spec.cells;
  const lastCol = cells;
  const hits = useMemo(() => drumPageGrid(clip.notes, page, DRUM_VOICES, span), [clip.notes, page, span]);
  const patterns = useMemo(() => hits.map((row) => row.map((v) => velocityBucket(v)).join('')), [hits]);
  const lane = hits[voice] ?? [];
  const voiceName = names[voice] ?? `Sound ${voice + 1}`;
  const nameOf = useCallback((v: number) => names[v] ?? `Sound ${v + 1}`, [names]);
  const [focusStep, setFocusStep] = useState(0);
  // The overview's one tab stop: a sound and a column (0 = its name).
  const [cell, setCell] = useState<{ voice: number; col: number }>({ voice, col: 0 });
  const [menu, setMenu] = useState<{ voice: number; anchor: MenuAnchor; returnFocus: HTMLElement | null } | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const burst = useKeyBurst();

  // Which sounds get a row: all 16 (Advanced, or Simple with Show all), else the main eight, every sound the clip
  // uses and the selected one. A row shown once for this clip stays while it is open (clearing a sound's last hit
  // does not pull its row away).
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const allSounds = useStore(allSoundsStore, (s) => s);
  const showAll = advanced || allSounds;
  const sticky = useRef<{ clipId: Id; voices: Set<number> }>({ clipId: '', voices: new Set() });
  if (sticky.current.clipId !== clip.id) sticky.current = { clipId: clip.id, voices: new Set() };
  const usedKey = useMemo(() => [...new Set(clip.notes.map((n) => Math.round(n.pitch)))].sort((x, y) => x - y).join(','), [clip.notes]);
  const visible = useMemo(() => {
    if (showAll) return VOICES;
    const keep = sticky.current.voices;
    for (const v of CORE_VOICES) keep.add(v);
    if (usedKey) for (const v of usedKey.split(',').map(Number)) if (v >= 0 && v < DRUM_VOICES) keep.add(v);
    keep.add(voice);
    return VOICES.filter((v) => keep.has(v));
  }, [showAll, usedKey, voice]);
  const hidden = DRUM_VOICES - visible.length;

  // Latest values for stable callbacks.
  const cur = useRef({ trackId, slot, page, span, voice, clip, cells, visible });
  cur.current = { trackId, slot, page, span, voice, clip, cells, visible };
  const painter = usePaint(cur);

  // While the overview does not have focus, its tab stop follows the selected sound.
  useLayoutEffect(() => {
    if (overviewRef.current?.contains(document.activeElement)) return;
    setCell((c) => (c.voice === voice ? c : { voice, col: 0 }));
  }, [voice]);

  const onPick = useCallback((v: number) => {
    const c = cur.current;
    selectDrumVoice(c.trackId, v);
    auditionBlip(c.trackId, v, cmd.DEFAULT_STEP_VELOCITY);
  }, []);

  const onToggle = useCallback((step: number) => {
    const c = cur.current;
    const r = cmd.toggleStep(session.store, c.trackId, c.slot, c.page * STEPS_PER_BAR + step, c.voice, cmd.DEFAULT_STEP_VELOCITY);
    if (session.accepted(r) && r.added) auditionBlip(c.trackId, c.voice, cmd.DEFAULT_STEP_VELOCITY);
  }, []);

  const toggleCell = useCallback((v: number, step: number) => {
    const c = cur.current;
    selectDrumVoice(c.trackId, v);
    const r = cmd.toggleStep(session.store, c.trackId, c.slot, c.page * STEPS_PER_BAR + step, v, cmd.DEFAULT_STEP_VELOCITY);
    if (session.accepted(r) && r.added) auditionBlip(c.trackId, v, cmd.DEFAULT_STEP_VELOCITY);
  }, []);

  const setVelocity = useCallback((step: number, velocity: number, gesture: string) => {
    const c = cur.current;
    for (const id of noteIdsAt(c.clip.notes, c.page, step, c.voice)) {
      if (!session.accepted(cmd.setNoteVelocity(session.store, c.trackId, c.slot, id, velocity, gesture))) return;
    }
  }, []);

  const openMenu = (v: number, anchor: MenuAnchor, returnFocus: HTMLElement | null) => {
    selectDrumVoice(trackId, v);
    setMenu({ voice: v, anchor, returnFocus });
  };

  /* ---------- pad lane ---------- */

  const focusPad = (step: number) => {
    setFocusStep(step);
    laneRef.current?.querySelector<HTMLButtonElement>(`[data-step="${step}"]`)?.focus();
  };

  const laneCols = (): Paint['cols'] => cellIndices(cur.current.cells).map((s) => laneRef.current?.querySelector(`[data-step="${s}"]`)?.getBoundingClientRect() ?? { left: 0, right: 0 });

  const onLanePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-step]');
    if (!el || !laneRef.current?.contains(el)) return;
    const step = Number(el.dataset.step);
    painter.end();
    setFocusStep(step);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    painter.start(e.pointerId, cur.current.voice, step, laneCols());
  };

  const onLaneKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-step]');
    if (!el || e.ctrlKey || e.metaKey || e.altKey) return;
    const step = Number(el.dataset.step);
    let delta = 0;
    switch (e.key) {
      case 'ArrowRight':
        focusPad(Math.min(cells - 1, step + 1));
        break;
      case 'ArrowLeft':
        focusPad(Math.max(0, step - 1));
        break;
      case 'Home':
        focusPad(0);
        break;
      case 'End':
        focusPad(cells - 1);
        break;
      case 'ArrowUp':
      case '+':
      case '=':
        delta = e.shiftKey && e.key === 'ArrowUp' ? 0.01 : 0.1;
        break;
      case 'ArrowDown':
      case '-':
      case '_':
        delta = e.shiftKey && e.key === 'ArrowDown' ? -0.01 : -0.1;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (delta !== 0) {
      const v = lane[step];
      if (v < 0) return;
      setVelocity(step, clampVelocity(v + delta), burst(`${voice}:${page}:${step}`));
    }
  };

  /* ---------- overview grid ---------- */

  const focusCell = (v: number, col: number) => {
    setCell({ voice: v, col });
    overviewRef.current?.querySelector<HTMLElement>(`[data-voice="${v}"] [data-col="${col}"]`)?.focus();
  };

  /** The row and column of an event target in the overview (a press on the row itself counts as its name). */
  const cellOf = (target: EventTarget | null): { voice: number; col: number } | null => {
    const t = target as HTMLElement | null;
    const row = t?.closest<HTMLElement>('[role="row"][data-voice]');
    if (!row || !overviewRef.current?.contains(row)) return null;
    const colEl = t?.closest<HTMLElement>('[data-col]');
    return { voice: Number(row.dataset.voice), col: colEl && row.contains(colEl) ? Number(colEl.dataset.col) : 0 };
  };

  const rowCols = (v: number): Paint['cols'] =>
    cellIndices(cur.current.cells).map((s) => overviewRef.current?.querySelector(`[data-voice="${v}"] [data-col="${s + 1}"]`)?.getBoundingClientRect() ?? { left: 0, right: 0 });

  // A finger waits until it shows a sideways drag (paint) or lifts (tap); moving up or down scrolls instead
  // (the browser then cancels the pointer). On a sound's name only a tap chooses and plays it. col 0 = the name.
  const touchWait = useRef<{ pointerId: number; voice: number; col: number; x: number; y: number } | null>(null);

  const onGridPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const at = cellOf(e.target);
    if (!at) return;
    setCell(at);
    painter.end();
    if (e.pointerType === 'touch') {
      touchWait.current = { pointerId: e.pointerId, voice: at.voice, col: at.col, x: e.clientX, y: e.clientY };
      return;
    }
    if (at.col === 0) {
      onPick(at.voice);
      return;
    }
    e.preventDefault();
    (e.target as HTMLElement).closest<HTMLElement>('[data-col]')?.focus({ preventScroll: true });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    selectDrumVoice(trackId, at.voice);
    painter.start(e.pointerId, at.voice, at.col - 1, rowCols(at.voice));
  };

  const onGridPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const w = touchWait.current;
    if (w && w.pointerId === e.pointerId) {
      const dx = Math.abs(e.clientX - w.x);
      const dy = Math.abs(e.clientY - w.y);
      if (dx < TOUCH_SLOP_PX && dy < TOUCH_SLOP_PX) return;
      touchWait.current = null;
      // A name is never painted from, and a mostly vertical move is a scroll: nothing happens.
      if (w.col === 0 || dy > dx) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
      selectDrumVoice(trackId, w.voice);
      painter.start(e.pointerId, w.voice, w.col - 1, rowCols(w.voice));
    }
    painter.move(e.pointerId, e.clientX);
  };

  const onGridPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const w = touchWait.current;
    if (w && w.pointerId === e.pointerId) {
      // A tap: toggle the cell, or choose and play the sound.
      touchWait.current = null;
      if (w.col === 0) onPick(w.voice);
      else toggleCell(w.voice, w.col - 1);
      return;
    }
    painter.end(e.pointerId);
  };

  const onGridPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    if (touchWait.current?.pointerId === e.pointerId) touchWait.current = null;
    painter.end(e.pointerId);
  };

  const onGridClick = (e: MouseEvent<HTMLDivElement>) => {
    const at = cellOf(e.target);
    if (!at) return;
    // Pointer presses act on pointerdown; a click with no press before it (Space, Enter, assistive tech) acts here.
    if (e.detail === 0 || (e.target as HTMLElement).getAttribute('role') === 'row') {
      if (at.col === 0) onPick(at.voice);
      else toggleCell(at.voice, at.col - 1);
    }
  };

  const onGridContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    const at = cellOf(e.target);
    if (!at) return;
    e.preventDefault();
    if (isEchoOfKeyboardMenu(e.target)) return;
    const nameEl = overviewRef.current?.querySelector<HTMLElement>(`[data-voice="${at.voice}"] [data-col="0"]`) ?? null;
    openMenu(at.voice, anchorFromContextEvent(e, nameEl), (e.target as HTMLElement).closest<HTMLElement>('[data-col]') ?? nameEl);
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = cellOf(e.target) ?? cell;
    if (isMenuKey(e)) {
      e.preventDefault();
      const el = overviewRef.current?.querySelector<HTMLElement>(`[data-voice="${at.voice}"] [data-col="${at.col}"]`) ?? null;
      noteKeyboardMenu(el);
      openMenu(at.voice, anchorFromElement(el), el);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let v = at.voice;
    let col = at.col;
    // Up and down go through the rows shown.
    const shownAt = visible.indexOf(v);
    switch (e.key) {
      case 'ArrowDown':
        v = visible[Math.min(visible.length - 1, shownAt + 1)] ?? v;
        break;
      case 'ArrowUp':
        v = visible[Math.max(0, shownAt - 1)] ?? v;
        break;
      case 'ArrowRight':
        col = Math.min(lastCol, col + 1);
        break;
      case 'ArrowLeft':
        col = Math.max(0, col - 1);
        break;
      case 'Home':
        col = 0;
        break;
      case 'End':
        col = lastCol;
        break;
      // Enter presses the focused button: its click (detail 0) toggles the step or plays the sound. Space is Play / Pause.
      default:
        return;
    }
    e.preventDefault();
    // Moving to another sound chooses it for the pads below.
    if (v !== at.voice) selectDrumVoice(trackId, v);
    focusCell(v, col);
  };

  const laneHits = lane.filter((v) => v >= 0).length;
  const velocities = useMemo(() => lane.map((v) => (v >= 0 ? v : null)), [lane]);
  const tabCell = cell;

  const where = barsWords(page, span);
  const soundsHead = advanced ? (
    <span className={styles.colHead}>Sounds</span>
  ) : (
    <Tooltip tip={showAll ? 'Show only the eight main sounds (and any sound this loop uses).' : `Show all ${DRUM_VOICES} sounds of the kit.`}>
      <button type="button" className={styles.allSounds} aria-pressed={showAll} onClick={() => setAllSounds(!showAll)}>
        {showAll ? 'Main sounds' : `Show all ${DRUM_VOICES}`}
      </button>
    </Tooltip>
  );

  return (
    <div className={styles.drums} data-pads={pads || undefined}>
      <StepNumbers grid={spec} label={soundsHead} />
      <div
        ref={overviewRef}
        className={styles.overview}
        style={{ ...gridStyle(spec), '--rows': String(visible.length) } as CSSProperties}
        role="grid"
        data-space-plays=""
        aria-label={`Kit sounds, ${where}: click a step to add or remove a hit, drag along a row to paint. Arrow keys move, Enter toggles, Shift+F10 opens a sound's actions.${hidden ? ` ${hidden} more sounds are hidden: Show all ${DRUM_VOICES} shows them.` : ''}`}
        aria-rowcount={visible.length}
        aria-colcount={lastCol + 1}
        onPointerDown={onGridPointerDown}
        onPointerMove={onGridPointerMove}
        onPointerUp={onGridPointerUp}
        onPointerCancel={onGridPointerCancel}
        // Only the grid's own capture ending ends a paint: a cell giving up its implicit (touch) capture to the grid bubbles here too.
        onLostPointerCapture={(e) => {
          if (e.target === e.currentTarget) painter.end(e.pointerId);
        }}
        onClick={onGridClick}
        onContextMenu={onGridContextMenu}
        onKeyDown={onGridKey}
      >
        {visible.map((v, i) => (
          <VoiceRow key={v} voice={v} index={i} name={nameOf(v)} pattern={patterns[v]} selected={v === voice} page={page} span={span} focusCol={tabCell.voice === v ? tabCell.col : null} numbered={advanced} />
        ))}
      </div>
      {pads && (
        <div
          ref={laneRef}
          className={`${grid.cols} ${styles.lane}`}
          style={gridStyle(spec)}
          role="group"
          data-space-plays=""
          aria-label={`${voiceName} steps, ${where}. Arrow keys move, Enter toggles, Up and Down change velocity.`}
          onKeyDown={onLaneKey}
          onPointerDown={onLanePointerDown}
          onPointerMove={(e) => painter.move(e.pointerId, e.clientX)}
          onPointerUp={(e) => painter.end(e.pointerId)}
          onPointerCancel={(e) => painter.end(e.pointerId)}
          onLostPointerCapture={(e) => {
            if (e.target === e.currentTarget) painter.end(e.pointerId);
          }}
        >
          <div className={styles.laneLabel}>
            <div className={styles.laneHead}>
              <span className={styles.laneName}>{voiceName}</span>
              <Tooltip name={`${voiceName} actions`} tip="Clear this sound, fill it on every beat, 8th or 16th, or shift it a step.">
                <button
                  ref={moreRef}
                  type="button"
                  className={styles.more}
                  aria-label={`${voiceName} actions`}
                  aria-haspopup="menu"
                  aria-expanded={menu !== null}
                  onClick={() => (menu ? setMenu(null) : openMenu(voice, anchorFromElement(moreRef.current), moreRef.current))}
                >
                  <MoreIcon size={16} />
                </button>
              </Tooltip>
            </div>
            <span className={styles.laneMeta}>{laneHits === 0 ? `No hits yet · ${where}` : `${hitWords(laneHits)} · ${where}`}</span>
          </div>
          {cellIndices(cells).map((s) => (
            <StepPad key={s} step={s} span={span} velocity={lane[s] ?? -1} voiceName={voiceName} tabbable={s === focusStep} onToggle={onToggle} onFocusStep={setFocusStep} />
          ))}
        </div>
      )}
      <VelocityLane className={styles.velocity} grid={spec} values={velocities} onSet={setVelocity} title={pads ? 'Velocity' : voiceName} hint={pads ? 'Drag a bar ↕' : 'Velocity · drag ↕'} />
      {menu && <SoundMenu trackId={trackId} slot={slot} voice={menu.voice} name={nameOf(menu.voice)} clip={clip} anchor={menu.anchor} returnFocus={menu.returnFocus} onClose={() => setMenu(null)} />}
    </div>
  );
}
