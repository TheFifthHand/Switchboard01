/**
 * Loops mode: eight part columns x one clip row per scene (1 to 8; the rows
 * scroll under sticky part headers when they do not fit, and "Add scene"
 * under the last row adds one). A pad starts or stops a clip for its part
 * (at the next bar); the side buttons launch a whole row as a scene. State is
 * shown with light AND text: Ready, Next bar (with a beat countdown), Playing,
 * Stopping, Paused, Rec; an empty pad is a quiet "+" (Add clip). A clip pad
 * shows a small picture of its notes; the playing pad (and the playing scene)
 * shows how far it is through its loop, drawn by one animation-frame loop
 * that reads the audio clock (no React state per frame).
 *
 * Each column header has the part's name and sound, a play/stop key for the
 * part, labelled Mute and Solo toggles and a level meter; a muted part's
 * column dims and says Muted, and with any solo on the others say Not soloed
 * (a soloed part keeps its meter and shows a Solo tag). M mutes the selected
 * part; Solo has no key (S plays a note).
 *
 * Keyboard: the pads (with the scene buttons) are one Tab stop, the part
 * headers another (roving tabindex); arrow keys move inside, Home / End go to
 * the row's ends and Ctrl+Home / Ctrl+End to the grid's corners.
 *
 * One selected clip: every control acts on the ringed pad (selection.ts).
 * While a performance take records, the grid shows it is locked: a lifted pad
 * says Locked, the pad actions become one coral line, and editing keys say
 * why; pad taps and scene launches keep working (the take records them).
 *
 * Moving things: drag a clip pad onto another pad to move it (onto a clip:
 * the two swap); hold Ctrl or Alt while dropping to copy (onto a clip: it is
 * replaced). A press that moves less than 6 px is a tap and launches. The
 * pad lifts and follows the pointer, its own place stays as a faint
 * placeholder, and the pad under it says what a drop does (Swap, Replace,
 * Can't go here); on release the pad settles into place (a swapped clip
 * glides into the other one's place). Esc, a release away from the pads, a
 * lost pointer or a window switch put it back. Drum and melodic parts do not
 * swap clips (the drop is refused and says why). Keyboard: the pad's Move…
 * action, then arrow keys, Enter (Ctrl+Enter copies), Esc. Scene rows reorder
 * by dragging the scene button (the row lifts and the others slide apart to
 * open its slot), or Alt+Up / Alt+Down on it; the clips of every part move
 * with them. See GridGestures for the pointer rules.
 *
 * The selected pad's actions are in the bar under the grid (Edit steps ·
 * Duplicate · Move… · Rename · Delete); right-click, the menu key, Shift+F10
 * or "." open them as a menu at the pad without playing it (the pad's tooltip
 * and description say so), and the '⋯' key in the selected pad's top-right
 * corner too. On a focused pad: Delete removes the clip (with Undo), Ctrl+C /
 * Ctrl+V copy and paste clips, F2 renames.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Button, ClipSketch, DRUM_KEYS, Icon, IconButton, Meter, NOTE_KEYS, OCTAVE_KEYS, Pad, Tooltip, useRafLoop, type PadState } from '../../ui/components';
import { TAP_SLOP_PX } from '../../ui/components/Pad';
import { MOTION, boxOf, flip, offsetBox, prefersReducedMotion, scaledBox, stopMotion, type Box } from '../../ui/motion';
import { BEATS_PER_BAR, MAX_SCENES, TICKS_PER_BAR, TICKS_PER_BEAT, type Clip, type Id, type Project, type Scene } from '../../project/types';
import { clipDropProblem, insertScene } from '../../state/commands';
import { selectSlot, selectTrack, slotFor, uiStore } from '../../state/uiStore';
import type { ClipPhase } from '../../time/contracts';
import { session, useProject, useUi } from '../instance';
import { notify, useRuntime, type TrackRuntime } from '../runtime';
import { barsLabel, soundName } from '../labels';
import '../selection';
import {
  ClipMenu,
  LOCKED_TEXT,
  MOD_KEY,
  MoreIcon,
  anchorFromContextEvent,
  anchorFromElement,
  clipActions,
  isEchoOfKeyboardMenu,
  isEditLocked,
  isMenuKey,
  noteKeyboardMenu,
  useEditLocked,
  type MenuAnchor,
} from './ClipMenu';
import { useRovingPads } from './DrumPads';
import { TrackMenu } from './TrackMenu';
import { SceneMenu } from './SceneMenu';
import { SoundBrowser } from './SoundBrowser';
import styles from './LoopsGrid.module.css';

interface ColumnSummary {
  id: Id;
  name: string;
  sound: string;
  mute: boolean;
  solo: boolean;
  drums: boolean;
  clips: readonly (Clip | null)[];
}

function summarize(p: Project): ColumnSummary[] {
  return p.tracks.map((t) => ({ id: t.id, name: t.name, sound: soundName(p, t.instrument), mute: t.mute, solo: t.solo, drums: t.instrument.kind === 'drums', clips: t.clips }));
}

function sameColumns(a: ColumnSummary[], b: ColumnSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.name !== y.name || x.sound !== y.sound || x.mute !== y.mute || x.solo !== y.solo || x.drums !== y.drums || x.clips !== y.clips) return false;
  }
  return true;
}

type Transport = 'playing' | 'paused' | 'stopped';

function padState(clip: Clip | null, slot: number, rt: TrackRuntime | undefined, transport: Transport, recording: boolean): { state: PadState; caption?: string; paused?: boolean } {
  if (!clip) return { state: 'empty' };
  if (recording) return { state: 'recording' };
  const playingSlot = rt?.playingSlot ?? null;
  const queued = rt?.queued ?? null;
  if (transport === 'stopped') return playingSlot === slot ? { state: 'queued', caption: 'Starts on Play' } : { state: 'ready' };
  if (playingSlot === slot) {
    if (queued && queued.slot !== slot) return { state: 'stopping', caption: queued.slot === null ? 'Stops next bar' : 'Ends next bar' };
    if (transport === 'paused') return { state: 'queued', caption: 'Paused', paused: true };
    return { state: 'playing' };
  }
  if (queued && queued.slot === slot) return { state: 'queued' };
  return { state: 'ready' };
}

/** A clip pad's live look (state word and light), for the pad itself and for its lifted copy while it is dragged. */
function usePadLook(trackId: Id, slot: number, clip: Clip | null) {
  const rt = useRuntime((s) => s.tracks[trackId]);
  const transport = useRuntime((s): Transport => (s.playing ? 'playing' : s.paused ? 'paused' : 'stopped'));
  const recording = useRuntime((s) => s.recording === 'notes' && s.recordTarget?.trackId === trackId && s.recordTarget.slot === slot);
  return padState(clip, slot, rt, transport, recording);
}

/** What a clip pad does when tapped, and how to reach its actions without playing it (its tooltip and description). */
const PAD_TIP = 'Tap to start this clip, in time with the others; tap it again to stop it.';
const EMPTY_PAD_TIP = 'Tap to add a clip here: a new one, or paste a copied clip.';
const PAD_ACTIONS_HINT = 'Right-click or Shift+F10 for actions without playing it (on a focused pad the . key works too). Drag it onto another pad to move it.';
/** Keys on a focused pad (see onGridKey). */
const PAD_SHORTCUTS = 'Shift+F10 ContextMenu . F2';
const CLIP_PAD_SHORTCUTS = `${PAD_SHORTCUTS} Delete`;

/** "." opens a focused pad's actions, unless that physical key plays notes or drum pads on this keyboard layout. */
const PLAYED_KEY_CODES: ReadonlySet<string> = new Set([...NOTE_KEYS, ...DRUM_KEYS, OCTAVE_KEYS.down, OCTAVE_KEYS.up].map((k) => k.code));
function isActionsKey(e: KeyboardEvent<HTMLElement>): boolean {
  if (isMenuKey(e)) return true;
  return e.key === '.' && !e.ctrlKey && !e.metaKey && !e.altKey && !PLAYED_KEY_CODES.has(e.code);
}

const STATE_SPOKEN: Record<PadState, string> = { empty: 'Empty', ready: 'Ready', queued: 'Starts next bar', playing: 'Playing', recording: 'Recording', stopping: 'Stopping' };

/* ------------------------------------------------------------------ */
/* Loop progress and the beat countdown (display only)                  */
/* ------------------------------------------------------------------ */

/**
 * Beats until each part's queued change lands, for the "Next bar · 3" of a
 * queued pad. Written by the grid's frame loop only when the whole number
 * changes (once a beat), so a queued pad renders once a beat, never per frame.
 */
class Countdown {
  private beats = new Map<Id, number>();
  private listeners = new Map<Id, Set<() => void>>();
  get = (trackId: Id): number | null => this.beats.get(trackId) ?? null;
  set(trackId: Id, n: number | null): void {
    if ((this.beats.get(trackId) ?? null) === n) return;
    if (n === null) this.beats.delete(trackId);
    else this.beats.set(trackId, n);
    for (const fn of this.listeners.get(trackId) ?? []) fn();
  }
  subscribe(trackId: Id, fn: () => void): () => void {
    let set = this.listeners.get(trackId);
    if (!set) this.listeners.set(trackId, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }
  clear(): void {
    for (const id of [...this.beats.keys()]) this.set(id, null);
  }
}
const countdown = new Countdown();
const noSubscribe = () => () => {};

/** The caption of a queued pad: "Next bar · 3" (beats to go) while the change is within the bar. */
function queuedCaption(beats: number | null): string | undefined {
  return beats !== null && beats <= BEATS_PER_BAR ? `Next bar · ${beats}` : undefined;
}

/**
 * Paints loop progress: `--loop-progress` (0..1) on the pad of each part's
 * sounding clip and on the lit scene button, and the beat countdown of
 * queued parts. Reads the audible position from the transport (the audio
 * clock); writes the DOM directly and only when a value changes. With
 * reduced motion it moves once a beat.
 */
class ProgressPainter {
  private pads = new Map<Id, { el: HTMLElement; value: number }>();
  private scenes = new Map<HTMLElement, number>();
  private phase: ClipPhase = { slot: 0, startTick: 0, lengthTicks: 0 };
  private rows = new Map<number, { start: number; len: number }>();

  paint(grid: HTMLElement | null, trackIds: readonly Id[]): void {
    const tr = session.transport;
    if (!grid || !tr) return this.clear();
    const tick = tr.audibleTick();
    const step = prefersReducedMotion() ? TICKS_PER_BEAT : 0;
    const at = (start: number, len: number) => {
      let pos = (((tick - start) % len) + len) % len;
      if (step) pos = Math.floor(pos / step) * step;
      return pos / len;
    };
    this.rows.clear();
    for (const id of trackIds) {
      const ph = tr.clipPhase(id, this.phase);
      const el = ph && ph.lengthTicks > 0 ? document.getElementById(padId(id, ph.slot)) : null;
      const old = this.pads.get(id);
      if (old && old.el !== el) {
        old.el.style.removeProperty('--loop-progress');
        this.pads.delete(id);
      }
      if (ph && el) {
        const value = at(ph.startTick, ph.lengthTicks);
        const cur = this.pads.get(id);
        if (!cur || Math.abs(cur.value - value) > 0.0005) {
          el.style.setProperty('--loop-progress', value.toFixed(4));
          this.pads.set(id, { el, value });
        }
        // The row's longest playing clip times the scene.
        const row = this.rows.get(ph.slot);
        if (!row || ph.lengthTicks > row.len) this.rows.set(ph.slot, { start: ph.startTick, len: ph.lengthTicks });
      }
      const q = tr.queuedAt(id);
      countdown.set(id, q === null ? null : Math.max(1, Math.ceil((q - tick) / TICKS_PER_BEAT)));
    }
    // The playing scene's button (lit: every part of its row plays it).
    for (const btn of grid.querySelectorAll<HTMLElement>('button[data-scene]')) {
      const row = btn.dataset.lit !== undefined ? this.rows.get(Number(btn.dataset.row)) : undefined;
      const old = this.scenes.get(btn);
      if (!row) {
        if (old !== undefined) {
          btn.style.removeProperty('--loop-progress');
          this.scenes.delete(btn);
        }
        continue;
      }
      const value = at(row.start, row.len);
      if (old === undefined || Math.abs(old - value) > 0.0005) {
        btn.style.setProperty('--loop-progress', value.toFixed(4));
        this.scenes.set(btn, value);
      }
    }
  }

  clear(): void {
    for (const { el } of this.pads.values()) el.style.removeProperty('--loop-progress');
    for (const el of this.scenes.keys()) el.style.removeProperty('--loop-progress');
    this.pads.clear();
    this.scenes.clear();
    countdown.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Moving clips: what a drop does                                      */
/* ------------------------------------------------------------------ */

interface PadRef {
  trackId: Id;
  slot: number;
}

/** A clip being moved with the keyboard (Move…): the focused pad is the target. */
interface MoveState {
  from: PadRef;
  clipName: string;
  over: PadRef | null;
}

const padId = (trackId: Id, slot: number) => `pad-${trackId}-${slot}`;
const cellOf = (at: PadRef) => document.getElementById(padId(at.trackId, at.slot))?.closest<HTMLElement>('[data-pad-cell]') ?? null;
const keyOf = (trackId: Id, slot: number) => `${trackId}:${slot}`;

/** Focus an element at the start of the next frame (focusing at once would force a second layout inside the drop's frame). */
function focusSoon(id: string | null, selector?: string): void {
  requestAnimationFrame(() => {
    const el = id ? document.getElementById(id) : selector ? document.querySelector<HTMLElement>(selector) : null;
    el?.focus({ preventScroll: true });
  });
}
const copyHeld = (e: { ctrlKey: boolean; altKey: boolean; metaKey: boolean }) => e.ctrlKey || e.altKey || e.metaKey;

function clipAt(p: Project, at: PadRef): Clip | null {
  return p.tracks.find((t) => t.id === at.trackId)?.clips[at.slot] ?? null;
}

/**
 * What dropping the carried clip on a pad does: `land` (an empty pad), `swap`
 * (a clip, moving), `replace` (a clip, copying), `no` (refused: drum and
 * melodic parts), `home` (its own pad: nothing).
 */
type DropKind = 'land' | 'swap' | 'replace' | 'no' | 'home';

function dropKind(p: Project, from: PadRef, to: PadRef, copy: boolean): DropKind {
  if (to.trackId === from.trackId && to.slot === from.slot) return 'home';
  if (from.trackId !== to.trackId && clipDropProblem(p, from.trackId, to.trackId)) return 'no';
  if (clipAt(p, to)) return copy ? 'replace' : 'swap';
  return 'land';
}

/** The words on the pad under a carried clip (the pad's light and outline say the same in colour). */
const DROP_CHIP: Partial<Record<DropKind, string>> = { swap: 'Swap', replace: 'Replace', no: 'Can’t go here' };

/** Why a clip cannot go to a part of the other kind, short enough for the lifted pad's label (the notice on drop says it in full). */
function refusalShort(p: Project, fromTrackId: Id): string {
  return p.tracks.find((t) => t.id === fromTrackId)?.instrument.kind === 'drums' ? 'Drum clips go to drum parts' : 'Melodic clips go to melodic parts';
}

/**
 * The small label on the lifted pad: Move or Copy (its icon turns to ⇄ over a
 * clip it would swap with), why not, or that letting go here cancels. What
 * happens to the pad underneath is said on that pad (DROP_CHIP).
 */
function liftLabel(kind: DropKind | null, copy: boolean, refusal: string): string {
  if (kind === null) return 'Release to cancel';
  if (kind === 'no') return refusal;
  return copy ? 'Copy' : 'Move';
}

/** The lifted pad is drawn this much larger than the pad. */
const LIFT_SCALE = 1.04;
/** How far (px) a clip that would be swapped leans toward the carried clip's own pad. */
const SWAP_LEAN_PX = 12;
/** Room (px) the lifted pad's label needs above it; nearer the window's top it goes below the pad. */
const LABEL_ROOM_PX = 32;
/** A carried scene row picks another slot only once it is this much (px) nearer to it. */
const ROW_HYSTERESIS_PX = 10;
/** How far above or below the pads (px) a scene row still lands; further away a release cancels. */
const ROW_DROP_MARGIN = 40;

/** The new order of `n` rows after moving row `from` to `to` (old indices, in their new places). */
function rowOrder(n: number, from: number, to: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  const [r] = order.splice(from, 1);
  order.splice(to, 0, r);
  return order;
}

/* ------------------------------------------------------------------ */
/* Pointer gestures: carrying a clip pad or a scene row                */
/* ------------------------------------------------------------------ */

/** What the drag layer draws while something is carried (rendered once when a drag starts). */
type DragUi =
  | { kind: 'pad'; from: PadRef; clipName: string; width: number; height: number; grabX: number; grabY: number }
  | {
      kind: 'row';
      row: number;
      width: number;
      height: number;
      pads: { left: number; width: number; name: string | null; bars: string | null }[];
      scene: { left: number; width: number; name: string; count: number };
    };

interface GridHost {
  grid(): HTMLElement | null;
  /** The lifted copy (pad or row) and the text of its label. */
  liftEl(): HTMLElement | null;
  labelEl(): HTMLElement | null;
  /** The word for the pad under the carried clip ("Swap", "Replace", "Can't go here"), drawn above the lifted pad. */
  chipEl(): HTMLElement | null;
  /** A keyboard move (Move…) is in progress: pointers do not start drags. */
  keyMoveActive(): boolean;
  closeMenu(): void;
}

interface CellGeo {
  el: HTMLElement;
  trackId: Id;
  slot: number;
  box: Box;
}

interface RowGeo {
  /** The row's pad cells, then its scene cell. */
  els: HTMLElement[];
  boxes: Box[];
  top: number;
  height: number;
}

interface Base {
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
}

interface PadPress extends Base {
  kind: 'padPress';
  from: PadRef;
}

interface RowPress extends Base {
  kind: 'rowPress';
  row: number;
}

interface PadDrag extends Base {
  kind: 'pad';
  from: PadRef;
  clipId: Id;
  cells: CellGeo[];
  source: CellGeo;
  /** Half the gap between pads: the pads' hit areas meet in the middle of it. */
  half: number;
  /** Pointer position inside the pad when it was picked up. */
  grabX: number;
  grabY: number;
  copy: boolean;
  refusal: string;
  /** A performance take records: the clip cannot move (the lift says Locked, no pad is a target). */
  locked: boolean;
  /** The window's width (for which side of the lifted pad its label sits) and the label's current place. */
  viewW: number;
  side: string;
  target: CellGeo | null;
  /** What a drop on `target` does. */
  drop: DropKind | null;
  lean: { x: number; y: number } | null;
}

interface RowDrag extends Base {
  kind: 'row';
  row: number;
  rows: RowGeo[];
  /** Left edge of the row (its first pad). */
  left: number;
  grabY: number;
  /** Where it would land (null: away from the pads, a release cancels). */
  slot: number | null;
  /** Each row's current preview offset (px). */
  offsets: number[];
  scenes: readonly Scene[];
  /** A performance take records: rows cannot move (the lift says Locked, nothing slides). */
  locked: boolean;
}

/** After Esc or an outside change: the press stays ours until the pointer comes up, so its click does nothing. */
interface Ended extends Base {
  kind: 'ended';
}

type Gesture = PadPress | RowPress | PadDrag | RowDrag | Ended;
type Listener = [EventTarget, string, EventListener, AddEventListenerOptions | boolean];

/**
 * Pointer gestures of the Loops grid: carrying a clip pad to another pad, and
 * a scene row to another row. Modelled on the song lane's gestures:
 * - What moves is written straight to the DOM (the lifted copy's `translate`,
 *   the pads' drop attributes, the rows' preview transforms). React renders
 *   only when a drag starts and when it ends (the drag layer), never per move.
 * - Geometry is read once when a drag starts (and again after a scroll or a
 *   resize); pointer moves never read layout.
 * - Every gesture ends through `finish`, which removes every listener it added
 *   and releases pointer capture: on drop, Escape, a release away from the
 *   pads, pointercancel, lost capture of the grid (not a child's: on touch the
 *   pressed pad holds an implicit capture that is handed over), window blur, a
 *   hidden tab, the dragged clip changing underneath, or the grid unmounting.
 * - While something is carried, other pointers and keys (except Ctrl / Alt /
 *   ⌘, which switch copy on and off) are ignored.
 * - Drops settle with a FLIP (src/ui/motion.ts): the real pads are where the
 *   edit put them and only their picture glides there; with reduce motion
 *   they are simply there.
 */
class GridGestures {
  private g: Gesture | null = null;
  private listeners: Listener[] = [];
  private suppressClick = false;
  private unwatch: (() => void) | null = null;
  private ui: DragUi | null = null;
  private uiListeners = new Set<() => void>();

  constructor(private host: GridHost) {}

  /* The drag layer's state (useSyncExternalStore). */
  subscribe = (fn: () => void): (() => void) => {
    this.uiListeners.add(fn);
    return () => this.uiListeners.delete(fn);
  };
  getUi = (): DragUi | null => this.ui;

  /** Show or remove the lifted copy. Rendered at once (flushSync) so it appears in the same frame as the drag. */
  private setUi(ui: DragUi | null, sync = true): void {
    if (this.ui === ui) return;
    this.ui = ui;
    const notify = () => {
      for (const fn of this.uiListeners) fn();
    };
    if (sync) flushSync(notify);
    else notify();
  }

  /** Something is being carried (not just pressed). */
  get dragging(): boolean {
    return this.g?.kind === 'pad' || this.g?.kind === 'row';
  }

  /** The click that follows a scene-row drag (or a cancelled one) is not a click. */
  consumeClick = (): boolean => this.suppressClick;

  /* ---------------------------------------------------------------- */
  /* Starting                                                         */
  /* ---------------------------------------------------------------- */

  /** Pointer down on a clip pad: a tap (the pad launches itself), or a drag once it travels TAP_SLOP_PX. */
  pressPad(e: PointerEvent, from: PadRef): void {
    if (!this.canStart(e)) return;
    if (!clipAt(session.store.getState(), from)) return;
    this.begin({ kind: 'padPress', pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, from });
  }

  /** Pointer down on a scene button: a click (launch), or a row drag once it travels. */
  pressRow(e: PointerEvent, row: number): void {
    if (!this.canStart(e)) return;
    this.begin({ kind: 'rowPress', pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, row });
  }

  private canStart(e: PointerEvent): boolean {
    if (e.button !== 0 || !e.isPrimary || this.host.keyMoveActive()) return false;
    if (this.g) {
      // Another pointer while one is pressed or carrying: ignored.
      if (e.pointerId !== this.g.pointerId) return false;
      // The same pointer pressing again: its release never reached us. Put things back first.
      this.cancel(false);
    }
    this.suppressClick = false;
    return true;
  }

  private begin(g: PadPress | RowPress): void {
    this.g = g;
    const capture = { capture: true };
    this.listen(window, 'pointermove', this.onMove as EventListener, capture);
    this.listen(window, 'pointerup', this.onUp as EventListener, capture);
    this.listen(window, 'pointercancel', this.onCancel as EventListener, capture);
    this.listen(window, 'pointerdown', this.onOtherDown as EventListener, capture);
    this.listen(window, 'keydown', this.onKey as EventListener, capture);
    this.listen(window, 'keyup', this.onKey as EventListener, capture);
    this.listen(window, 'contextmenu', this.onContextMenu, capture);
    this.listen(window, 'blur', this.onAbort, false);
    this.listen(document, 'visibilitychange', this.onVisibility, false);
    this.listen(window, 'scroll', this.onScroll, { capture: true, passive: true });
    this.listen(window, 'resize', this.onScroll, false);
    const grid = this.host.grid();
    if (grid) this.listen(grid, 'lostpointercapture', this.onLostCapture as EventListener, false);
  }

  private listen(target: EventTarget, type: string, fn: EventListener, opts: AddEventListenerOptions | boolean): void {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }

  /** Keep this pointer's events while it carries something, even outside the window (the pressed pad's own capture moves to the grid). */
  private capture(pointerId: number): void {
    try {
      this.host.grid()?.setPointerCapture(pointerId);
    } catch {
      /* not an active pointer (a synthetic event) */
    }
  }

  private readCells(grid: HTMLElement): { cells: CellGeo[]; half: number } {
    const els = [...grid.querySelectorAll<HTMLElement>('[data-pad-cell]')];
    // A pad still settling from the last drop is measured where it belongs.
    for (const el of els) stopMotion(el);
    const cells = els.map((el) => ({ el, trackId: el.dataset.track!, slot: Number(el.dataset.slot), box: boxOf(el) }));
    let half = 4;
    const a = cells[0];
    const b = a && cells.find((c) => c.slot === a.slot && c.box.left > a.box.left);
    if (a && b) half = Math.max(0, (b.box.left - (a.box.left + a.box.width)) / 2);
    return { cells, half };
  }

  private readRows(grid: HTMLElement, offsets: readonly number[] = []): RowGeo[] {
    const rows: RowGeo[] = [];
    const count = grid.querySelectorAll('[data-scene-row]').length;
    for (let r = 0; r < count; r++) {
      const els = [...grid.querySelectorAll<HTMLElement>(`[data-pad-cell][data-slot="${r}"], [data-scene-row="${r}"]`)];
      for (const el of els) stopMotion(el);
      // Rows being previewed are measured where they belong (their offset taken off).
      const boxes = els.map((el) => offsetBox(boxOf(el), 0, -(offsets[r] ?? 0)));
      const top = Math.min(...boxes.map((b) => b.top));
      const bottom = Math.max(...boxes.map((b) => b.top + b.height));
      rows.push({ els, boxes, top, height: bottom - top });
    }
    return rows;
  }

  private startPad(p: PadPress): void {
    const grid = this.host.grid();
    const project = session.store.getState();
    const clip = clipAt(project, p.from);
    if (!grid || !clip) return this.finish();
    const { cells, half } = this.readCells(grid);
    const source = cells.find((c) => c.trackId === p.from.trackId && c.slot === p.from.slot);
    if (!source) return this.finish();
    const g: PadDrag = {
      ...p,
      kind: 'pad',
      clipId: clip.id,
      cells,
      source,
      half,
      grabX: p.startX - source.box.left,
      grabY: p.startY - source.box.top,
      copy: false,
      refusal: refusalShort(project, p.from.trackId),
      locked: isEditLocked(),
      viewW: document.documentElement.clientWidth,
      side: '',
      target: null,
      drop: null,
      lean: null,
    };
    this.g = g;
    this.host.closeMenu();
    this.capture(g.pointerId);
    // The pads are marked once: the clip's own pad becomes a placeholder, the others say whether it can go there
    // (while a take records, none: the lifted pad says Locked).
    for (const c of cells) {
      if (g.locked) {
        if (c === source) c.el.dataset.drop = 'source';
        continue;
      }
      c.el.dataset.drop = c === source ? 'source' : c.trackId !== p.from.trackId && clipDropProblem(project, p.from.trackId, c.trackId) ? 'no' : 'ok';
    }
    grid.dataset.dragging = 'pad';
    if (g.locked) grid.dataset.refused = '';
    this.watch();
    this.setUi({ kind: 'pad', from: p.from, clipName: clip.name, width: source.box.width, height: source.box.height, grabX: g.grabX, grabY: g.grabY });
    this.updatePad(g, true);
  }

  private startRow(p: RowPress): void {
    const grid = this.host.grid();
    const project = session.store.getState();
    if (!grid || !project.scenes[p.row]) return this.finish();
    const rows = this.readRows(grid);
    const home = rows[p.row];
    if (!home?.els.length) return this.finish();
    const left = Math.min(...home.boxes.map((b) => b.left));
    const right = Math.max(...home.boxes.map((b) => b.left + b.width));
    const g: RowDrag = { ...p, kind: 'row', rows, left, grabY: p.startY - home.top, slot: p.row, offsets: rows.map(() => 0), scenes: project.scenes, locked: isEditLocked() };
    this.g = g;
    this.host.closeMenu();
    this.capture(g.pointerId);
    for (const el of home.els) el.dataset.rowDrag = 'source';
    grid.dataset.dragging = 'row';
    if (g.locked) grid.dataset.refused = '';
    this.watch();
    const sceneBox = home.boxes[home.boxes.length - 1];
    const count = project.tracks.filter((t) => !!t.clips[p.row]).length;
    this.setUi({
      kind: 'row',
      row: p.row,
      width: right - left,
      height: home.height,
      pads: project.tracks.map((t, i) => {
        const c = t.clips[p.row];
        const b = home.boxes[i] ?? home.boxes[0];
        return { left: b.left - left, width: b.width, name: c?.name ?? null, bars: c ? barsLabel(c.bars) : null };
      }),
      scene: { left: sceneBox.left - left, width: sceneBox.width, name: project.scenes[p.row].name, count },
    });
    this.updateRow(g, true);
  }

  /** The project changed under a drag (undo from elsewhere, a take, another view): if what is carried changed, put it back. */
  private watch(): void {
    this.unwatch?.();
    this.unwatch = session.store.subscribe(() => {
      const g = this.g;
      const p = session.store.getState();
      if (g?.kind === 'pad') {
        if (clipAt(p, g.from)?.id !== g.clipId) this.cancel(true);
        else this.updatePad(g, true);
      } else if (g?.kind === 'row' && p.scenes !== g.scenes) {
        this.cancel(true);
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                           */
  /* ---------------------------------------------------------------- */

  private onMove = (ev: PointerEvent): void => {
    const g = this.g;
    if (!g || ev.pointerId !== g.pointerId) return;
    g.x = ev.clientX;
    g.y = ev.clientY;
    if (g.kind === 'ended') return;
    if (g.kind === 'padPress' || g.kind === 'rowPress') {
      if (Math.hypot(g.x - g.startX, g.y - g.startY) < TAP_SLOP_PX) return;
      ev.preventDefault();
      if (g.kind === 'padPress') {
        this.startPad(g);
        const d = this.g as Gesture | null;
        if (d?.kind === 'pad' && copyHeld(ev)) this.setCopy(d, true);
      } else this.startRow(g);
      return;
    }
    ev.preventDefault();
    if (g.kind === 'pad') {
      if (copyHeld(ev) !== g.copy) this.setCopy(g, copyHeld(ev));
      else this.updatePad(g);
    } else this.updateRow(g);
  };

  private onUp = (ev: PointerEvent): void => {
    const g = this.g;
    if (!g || ev.pointerId !== g.pointerId) return;
    g.x = ev.clientX;
    g.y = ev.clientY;
    if (g.kind === 'pad') {
      if (copyHeld(ev) !== g.copy) this.setCopy(g, copyHeld(ev));
      else this.updatePad(g);
      this.dropPad(g);
    } else if (g.kind === 'row') {
      this.updateRow(g);
      this.dropRow(g);
    } else {
      // A press that never travelled is a tap or a click (the pad and the scene button do the rest).
      if (g.kind === 'ended') this.blockClick();
      this.finish();
    }
  };

  private onCancel = (ev: PointerEvent): void => {
    if (this.g && ev.pointerId === this.g.pointerId) this.cancel(false);
  };

  /** Only the grid's own capture counts: the lostpointercapture of a pad (handing its capture to the grid) bubbles here too. */
  private onLostCapture = (ev: PointerEvent): void => {
    if (ev.target !== ev.currentTarget || !this.g || ev.pointerId !== this.g.pointerId) return;
    if (this.dragging) this.cancel(false);
  };

  /** Another finger or pen while something is carried: nothing under it reacts. */
  private onOtherDown = (ev: PointerEvent): void => {
    if (!this.dragging || ev.pointerId === this.g!.pointerId) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };

  private onContextMenu = (ev: Event): void => {
    if (!this.dragging) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };

  private onAbort = (): void => {
    if (this.g) this.cancel(false);
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.onAbort();
  };

  /** The page or a panel scrolled, or the window resized: measure again (the lifted copy stays under the pointer). */
  private onScroll = (): void => {
    const g = this.g;
    const grid = this.host.grid();
    if (!grid || !g) return;
    if (g.kind === 'pad') {
      g.viewW = document.documentElement.clientWidth;
      const { cells, half } = this.readCells(grid);
      const byKey = new Map(cells.map((c) => [keyOf(c.trackId, c.slot), c]));
      // Same elements, new boxes (the drag keeps its references).
      for (const c of g.cells) c.box = byKey.get(keyOf(c.trackId, c.slot))?.box ?? c.box;
      g.half = half;
      this.updatePad(g, true);
    } else if (g.kind === 'row') {
      const rows = this.readRows(grid, g.offsets);
      g.rows.forEach((r, i) => Object.assign(r, { boxes: rows[i].boxes, top: rows[i].top, height: rows[i].height }));
      g.left = Math.min(...g.rows[g.row].boxes.map((b) => b.left));
      this.updateRow(g, true);
    }
  };

  private onKey = (ev: globalThis.KeyboardEvent): void => {
    const g = this.g;
    if (!g || (g.kind !== 'pad' && g.kind !== 'row')) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (ev.type === 'keydown') this.cancel(true);
      return;
    }
    if (g.kind === 'pad' && (ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Meta')) {
      // Copy follows the modifier while it is held, also without moving the pointer.
      const copy = ev.type === 'keydown' ? true : copyHeld(ev);
      if (copy !== g.copy) this.setCopy(g, copy);
      if (ev.key === 'Alt') ev.preventDefault();
      return;
    }
    // Other keys do nothing while something is carried (no stray note or shortcut).
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };

  /* ---------------------------------------------------------------- */
  /* Live preview                                                     */
  /* ---------------------------------------------------------------- */

  private hit(g: PadDrag): CellGeo | null {
    const { x, y, half } = g;
    for (const c of g.cells) {
      const b = c.box;
      if (x >= b.left - half && x < b.left + b.width + half && y >= b.top - half && y < b.top + b.height + half) return c;
    }
    return null;
  }

  private setCopy(g: PadDrag, copy: boolean): void {
    if (g.locked) return;
    g.copy = copy;
    const grid = this.host.grid();
    const lift = this.host.liftEl();
    for (const el of [grid, lift]) {
      if (!el) continue;
      if (copy) el.dataset.copy = '';
      else delete el.dataset.copy;
    }
    this.updatePad(g, true);
  }

  /** Follow the pointer; when the pad under it (or what a drop there does) changes, say so on both pads. */
  private updatePad(g: PadDrag, force = false): void {
    const lift = this.host.liftEl();
    const left = g.x - g.grabX;
    const top = g.y - g.grabY;
    if (lift) {
      lift.style.translate = `${left}px ${top}px`;
      // The label keeps inside the window: on the right half it hangs from the pad's right edge, near the top it goes below.
      const side = `${left + g.source.box.width / 2 > g.viewW / 2 ? 'end' : 'start'} ${top < LABEL_ROOM_PX ? 'below' : 'above'}`;
      if (side !== g.side) {
        g.side = side;
        lift.dataset.side = side;
      }
    }
    if (g.locked) {
      // Locked: it follows the pointer and says so; no pad is a target.
      if (lift) lift.dataset.kind = 'no';
      const label = this.host.labelEl();
      if (label && label.textContent !== 'Locked') label.textContent = 'Locked';
      this.autoScroll(g);
      return;
    }
    const target = this.hit(g);
    this.autoScroll(g);
    // Copy and project changes come with `force`: otherwise only a new pad under the pointer changes anything.
    if (!force && target === g.target) return;
    const kind = target ? dropKind(session.store.getState(), g.from, { trackId: target.trackId, slot: target.slot }, g.copy) : null;
    this.clearTarget(g);
    g.target = target;
    g.drop = kind;
    const chip = this.host.chipEl();
    const word = target && kind ? DROP_CHIP[kind] : undefined;
    if (chip) {
      if (word && target && kind) {
        // On the target's lower edge, above the lifted pad (which covers the target itself).
        chip.textContent = word;
        chip.dataset.kind = kind;
        chip.style.translate = `${target.box.left + target.box.width / 2}px ${target.box.top + target.box.height}px`;
        chip.dataset.on = '';
      } else delete chip.dataset.on;
    }
    if (target && kind && kind !== 'home') {
      const el = target.el;
      el.dataset.over = '';
      el.dataset.target = kind;
      if (kind === 'swap' && !prefersReducedMotion()) {
        // The clip that would be swapped leans toward the carried clip's pad.
        const s = g.source.box;
        const t = target.box;
        const dx = s.left + s.width / 2 - (t.left + t.width / 2);
        const dy = s.top + s.height / 2 - (t.top + t.height / 2);
        const len = Math.hypot(dx, dy) || 1;
        g.lean = { x: (dx / len) * SWAP_LEAN_PX, y: (dy / len) * SWAP_LEAN_PX };
        el.style.setProperty('--lean-x', `${g.lean.x.toFixed(1)}px`);
        el.style.setProperty('--lean-y', `${g.lean.y.toFixed(1)}px`);
      }
    }
    const grid = this.host.grid();
    if (grid) {
      if (kind === 'no') grid.dataset.refused = '';
      else delete grid.dataset.refused;
    }
    if (lift) lift.dataset.kind = kind ?? 'none';
    const label = this.host.labelEl();
    const text = liftLabel(kind, g.copy, g.refusal);
    if (label && label.textContent !== text) label.textContent = text;
  }

  private clearTarget(g: PadDrag): void {
    const el = g.target?.el;
    g.lean = null;
    if (!el) return;
    delete el.dataset.over;
    delete el.dataset.target;
    el.style.removeProperty('--lean-x');
    el.style.removeProperty('--lean-y');
  }

  /** Follow the pointer up and down; when the slot changes, the other rows slide apart to open it. */
  private updateRow(g: RowDrag, force = false): void {
    const lift = this.host.liftEl();
    const top = g.y - g.grabY;
    if (lift) lift.style.translate = `${g.left}px ${top}px`;
    if (g.locked) {
      if (lift) lift.dataset.kind = 'no';
      const label = this.host.labelEl();
      if (label && label.textContent !== 'Locked') label.textContent = 'Locked';
      return;
    }
    this.autoScroll(g);
    const first = g.rows[0];
    const last = g.rows[g.rows.length - 1];
    let slot: number | null;
    if (g.y < first.top - ROW_DROP_MARGIN || g.y > last.top + last.height + ROW_DROP_MARGIN) slot = null;
    else {
      // The slot nearest the carried row's centre (rows are matched by height: the pointer may wander sideways).
      const centre = top + g.rows[g.row].height / 2;
      const dist = (i: number) => Math.abs(centre - (g.rows[i].top + g.rows[i].height / 2));
      let best = 0;
      for (let i = 1; i < g.rows.length; i++) if (dist(i) < dist(best)) best = i;
      if (g.slot !== null && best !== g.slot && dist(g.slot) - dist(best) < ROW_HYSTERESIS_PX) best = g.slot;
      slot = best;
    }
    if (force || slot !== g.slot) {
      g.slot = slot;
      this.previewRows(g);
    }
    if (lift) lift.dataset.kind = slot === null ? 'none' : 'move';
    const label = this.host.labelEl();
    const text = slot === null ? 'Release to cancel' : slot === g.row ? 'Back in place' : `Move to row ${slot + 1}`;
    if (label && label.textContent !== text) label.textContent = text;
  }

  /** Each row slides to where it would be after the drop; the carried row's faint placeholder is the open slot. */
  private previewRows(g: RowDrag): void {
    const order = rowOrder(g.rows.length, g.row, g.slot ?? g.row);
    order.forEach((r, pos) => {
      const dy = g.rows[pos].top - g.rows[r].top;
      if (dy === g.offsets[r]) return;
      g.offsets[r] = dy;
      for (const el of g.rows[r].els) el.style.transform = dy ? `translate3d(0, ${dy}px, 0)` : '';
    });
  }

  /* ---------------------------------------------------------------- */
  /* Drops                                                            */
  /* ---------------------------------------------------------------- */

  /** Near the grid's top or bottom edge, rows that do not fit scroll toward the pointer (the scroll re-measures the pads). */
  private autoScroll(g: PadDrag | RowDrag): void {
    const grid = this.host.grid();
    if (!grid || grid.scrollHeight <= grid.clientHeight + 1) return;
    const r = grid.getBoundingClientRect();
    const head = grid.querySelector<HTMLElement>('[data-grid-head]')?.getBoundingClientRect().bottom ?? r.top;
    const edge = 28;
    const dy = g.y < head + edge ? -12 : g.y > r.bottom - edge ? 12 : 0;
    if (dy) grid.scrollBy({ top: dy });
  }

  /** Where the lifted pad is drawn now (its scale grows around the point it was picked up by). */
  private liftBox(g: PadDrag): Box {
    return scaledBox({ left: g.x - g.grabX, top: g.y - g.grabY, width: g.source.box.width, height: g.source.box.height }, LIFT_SCALE, g.grabX, g.grabY);
  }

  private dropPad(g: PadDrag): void {
    const { target, drop: kind } = g;
    const lift = this.liftBox(g);
    const lean = target && kind === 'swap' && g.lean ? offsetBox(target.box, g.lean.x, g.lean.y) : null;
    const to = !g.locked && target && kind && kind !== 'home' ? { trackId: target.trackId, slot: target.slot } : null;
    this.endDrag(g, false);
    let ok = false;
    flushSync(() => {
      this.setUi(null, false);
      // A refused drop still asks: the notice says why (one rule, one message).
      if (to) ok = session.moveClip(g.from, to, g.copy);
    });
    if (ok && target) {
      // The carried clip springs from where it was let go into its pad; a swapped clip glides into the other place.
      flip(target.el, lift, { last: target.box, zIndex: 3 });
      if (lean) flip(g.source.el, lean, { last: g.source.box, easing: MOTION.ease, zIndex: 2 });
      focusSoon(padId(target.trackId, target.slot));
    } else {
      flip(g.source.el, lift, { last: g.source.box, zIndex: 3 });
    }
  }

  private dropRow(g: RowDrag): void {
    const from = g.row;
    const to = g.locked ? null : g.slot;
    const firsts = this.rowFirsts(g);
    this.endDrag(g, false);
    let ok = false;
    flushSync(() => {
      this.setUi(null, false);
      if (to !== null && to !== from) ok = session.moveScene(from, to);
    });
    this.settleRows(g, firsts, ok && to !== null ? rowOrder(g.rows.length, from, to) : null);
    this.blockClick();
    if (ok && to !== null) focusSoon(null, `[data-scene-row="${to}"] button[data-scene]`);
  }

  /** Where each row's elements are drawn now: the carried row at the lifted copy, the others at their preview. */
  private rowFirsts(g: RowDrag): Map<HTMLElement, Box> {
    const lifted = g.y - g.grabY - g.rows[g.row].top;
    const firsts = new Map<HTMLElement, Box>();
    g.rows.forEach((row, r) => row.els.forEach((el, i) => firsts.set(el, offsetBox(row.boxes[i], 0, r === g.row ? lifted : g.offsets[r]))));
    return firsts;
  }

  /** Rows glide from `firsts` to their places in `order` (null: back where they were). */
  private settleRows(g: RowDrag, firsts: Map<HTMLElement, Box>, order: number[] | null): void {
    const final = order ?? g.rows.map((_, i) => i);
    final.forEach((r, pos) => {
      const row = g.rows[r];
      const dy = g.rows[pos].top - row.top;
      row.els.forEach((el, i) => {
        const first = firsts.get(el);
        if (!first) return;
        const carried = r === g.row;
        flip(el, first, { last: offsetBox(row.boxes[i], 0, dy), easing: carried ? MOTION.spring : MOTION.ease, duration: carried ? MOTION.settleMs : MOTION.slideMs, zIndex: carried ? 3 : undefined });
      });
    });
  }

  /** Esc, a lost pointer, blur, an outside change: put everything back, commit nothing. */
  cancel(waitForUp: boolean): void {
    const g = this.g;
    if (!g) return;
    if (g.kind === 'pad') {
      const lift = this.liftBox(g);
      this.endDrag(g, waitForUp);
      this.setUi(null);
      flip(g.source.el, lift, { last: g.source.box, zIndex: 3 });
    } else if (g.kind === 'row') {
      const firsts = this.rowFirsts(g);
      this.endDrag(g, waitForUp);
      this.setUi(null);
      this.settleRows(g, firsts, null);
      this.blockClick();
    } else if (waitForUp) {
      this.g = { kind: 'ended', pointerId: g.pointerId, startX: g.startX, startY: g.startY, x: g.x, y: g.y };
    } else {
      this.finish();
    }
  }

  /**
   * Take every drag mark off the pads and rows at once and end the gesture,
   * or keep it until the pointer comes up (`waitForUp`). Nothing transitions
   * back: the settle animation takes over from here. (A row's slide
   * transition belongs to the dragging grid, so it goes in the same style
   * change as the row's offset; the swap lean is switched off for one frame.)
   */
  private endDrag(g: PadDrag | RowDrag, waitForUp: boolean): void {
    const grid = this.host.grid();
    if (grid) {
      delete grid.dataset.dragging;
      delete grid.dataset.copy;
      delete grid.dataset.refused;
    }
    if (g.kind === 'pad') {
      const leaning = g.lean ? g.target?.el.querySelector<HTMLElement>('button[data-state]') : null;
      if (leaning) {
        leaning.style.transition = 'none';
        requestAnimationFrame(() => {
          leaning.style.transition = '';
        });
      }
      this.clearTarget(g);
      for (const c of g.cells) delete c.el.dataset.drop;
    } else {
      for (const row of g.rows) {
        for (const el of row.els) {
          el.style.transform = '';
          delete el.dataset.rowDrag;
        }
      }
    }
    this.unwatch?.();
    this.unwatch = null;
    if (waitForUp) {
      this.releaseCapture(g.pointerId);
      this.g = { kind: 'ended', pointerId: g.pointerId, startX: g.startX, startY: g.startY, x: g.x, y: g.y };
    } else this.finish();
  }

  private blockClick(): void {
    this.suppressClick = true;
    window.setTimeout(() => {
      this.suppressClick = false;
    }, 0);
  }

  private releaseCapture(pointerId: number): void {
    const grid = this.host.grid();
    try {
      if (grid?.hasPointerCapture(pointerId)) grid.releasePointerCapture(pointerId);
    } catch {
      /* element already gone */
    }
  }

  /** End the gesture: every listener removed, capture released. */
  private finish(): void {
    const g = this.g;
    this.g = null;
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
    this.listeners = [];
    this.unwatch?.();
    this.unwatch = null;
    if (g) this.releaseCapture(g.pointerId);
  }

  /** The grid unmounts (view switch): drop any gesture at once, commit nothing. */
  dispose(): void {
    const g = this.g;
    if (g?.kind === 'pad' || g?.kind === 'row') this.endDrag(g, false);
    else this.finish();
    this.ui = null;
  }
}

/* ------------------------------------------------------------------ */
/* Moves by keyboard, with the same settle                              */
/* ------------------------------------------------------------------ */

/** Move or copy a clip (keyboard Move…, or a click while choosing): the clip glides from its pad to the new one. */
function moveClipWithMotion(from: PadRef, to: PadRef, copy: boolean, before?: () => void): boolean {
  const a = cellOf(from);
  const b = cellOf(to);
  const firstA = a ? boxOf(a) : null;
  const firstB = b ? boxOf(b) : null;
  const swap = !copy && !!clipAt(session.store.getState(), to);
  let ok = false;
  flushSync(() => {
    before?.();
    ok = session.moveClip(from, to, copy);
  });
  if (ok && a && b && firstA && firstB) {
    flip(b, firstA, { zIndex: 3 });
    if (swap) flip(a, firstB, { easing: MOTION.ease, zIndex: 2 });
  }
  return ok;
}

/** Move a scene row (Alt+Up / Alt+Down): the row springs into its new place and the other one glides out of the way. */
function moveSceneWithMotion(from: number, to: number): boolean {
  const rowEls = (r: number) => [...document.querySelectorAll<HTMLElement>(`[data-pad-cell][data-slot="${r}"], [data-scene-row="${r}"]`)];
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const els: [HTMLElement, boolean][] = [];
  for (let r = lo; r <= hi; r++) for (const el of rowEls(r)) els.push([el, r === from]);
  const firsts = new Map(els.map(([el]) => (stopMotion(el), [el, boxOf(el)] as const)));
  let ok = false;
  flushSync(() => {
    ok = session.moveScene(from, to);
  });
  if (ok) {
    for (const [el, carried] of els) {
      const first = firsts.get(el);
      if (first) flip(el, first, { easing: carried ? MOTION.spring : MOTION.ease, duration: carried ? MOTION.settleMs : MOTION.slideMs, zIndex: carried ? 3 : undefined });
    }
  }
  return ok;
}

/* ------------------------------------------------------------------ */
/* Menus                                                               */
/* ------------------------------------------------------------------ */

interface MenuBase {
  anchor: MenuAnchor;
  /** Focus returns here when the menu closes. */
  returnFocus: HTMLElement | null;
  /** The trigger: pressing it again toggles instead of counting as an outside press. */
  ignore?: Element | null;
  /** Open straight into the rename field. */
  rename?: boolean;
}
type MenuRequest = MenuBase & ({ kind: 'clip'; trackId: Id; slot: number } | { kind: 'track'; trackId: Id } | { kind: 'scene'; row: number });
type OpenMenu = (req: MenuRequest | null) => void;

function onContextMenuOpen(e: ReactMouseEvent<HTMLElement>, open: (anchor: MenuAnchor) => void) {
  e.preventDefault();
  if (isEchoOfKeyboardMenu(e.target)) return;
  open(anchorFromContextEvent(e, e.currentTarget));
}

/* ------------------------------------------------------------------ */
/* Pads                                                                */
/* ------------------------------------------------------------------ */

interface ClipPadProps {
  col: ColumnSummary;
  /** Column index (for the keyboard move's swap lean). */
  index: number;
  slot: number;
  sceneName: string;
  dimmed: boolean;
  onMenu: OpenMenu;
  menuOpen: boolean;
  /** A keyboard move in progress (pointer drags mark the pads directly, see GridGestures). */
  move: MoveState | null;
  /** Column index of the keyboard move's source. */
  moveCol: number;
  onPointerDownPad(e: ReactPointerEvent<HTMLElement>, from: PadRef): void;
  onDropHere(to: PadRef, copy: boolean): void;
}

const ClipPad = memo(function ClipPad(props: ClipPadProps) {
  const { col, index, slot, sceneName, dimmed, onMenu, menuOpen, move, moveCol, onPointerDownPad, onDropHere } = props;
  const trackId = col.id;
  const clip = col.clips[slot];
  const selected = useUi((s) => s.selectedTrackId === trackId && slotFor(s, trackId) === slot);
  const look = usePadLook(trackId, slot, clip);
  const { state, paused } = look;
  // A queued pad counts down the beats to its start (re-rendered once a beat, only while queued).
  const counting = state === 'queued' && !look.caption;
  const subscribeBeats = useCallback((fn: () => void) => (counting ? countdown.subscribe(trackId, fn) : noSubscribe()), [counting, trackId]);
  const beats = useSyncExternalStore(subscribeBeats, () => (counting ? countdown.get(trackId) : null));
  const caption = look.caption ?? (state === 'queued' ? queuedCaption(beats) : undefined);
  const id = padId(trackId, slot);
  const onPress = () => {
    if (move) {
      // Choosing where a clip goes (keyboard Move… then a click): drop it here.
      onDropHere({ trackId, slot }, false);
      return;
    }
    selectTrack(trackId);
    selectSlot(trackId, slot);
    if (clip) void session.pressClip(trackId, slot);
    else {
      // "+" (Add clip): the new-clip choices (length, or paste) open at the pad.
      const el = document.getElementById(id);
      onMenu({ kind: 'clip', trackId, slot, anchor: anchorFromElement(el), returnFocus: el });
    }
  };
  const open = (anchor: MenuAnchor, returnFocus: HTMLElement | null, ignore?: Element | null) => {
    selectTrack(trackId);
    selectSlot(trackId, slot);
    onMenu({ kind: 'clip', trackId, slot, anchor, returnFocus, ignore });
  };
  // Keyboard move: the source is a placeholder, the others say whether the clip can go there, the focused one what a drop does.
  let drop: 'source' | 'ok' | 'no' | undefined;
  let target: DropKind | undefined;
  let lean: CSSProperties | undefined;
  if (move) {
    const p = session.store.getState();
    const kind = dropKind(p, move.from, { trackId, slot }, false);
    drop = kind === 'home' ? 'source' : kind === 'no' ? 'no' : 'ok';
    if (move.over && move.over.trackId === trackId && move.over.slot === slot && kind !== 'home') {
      target = kind;
      if (kind === 'swap') {
        const dx = moveCol - index;
        const dy = move.from.slot - slot;
        const len = Math.hypot(dx, dy) || 1;
        lean = { '--lean-x': `${((dx / len) * SWAP_LEAN_PX).toFixed(1)}px`, '--lean-y': `${((dy / len) * SWAP_LEAN_PX).toFixed(1)}px` } as CSSProperties;
      }
    }
  }
  // The spoken state stays "Starts next bar" (a countdown read out every beat would be noise).
  const stateWord = look.caption ?? STATE_SPOKEN[state];
  const what = clip ? `clip ${clip.name}` : 'empty slot';
  const label = clip ? `${col.name}, ${sceneName}: ${clip.name}, ${barsLabel(clip.bars)}. ${stateWord}.${selected ? ' Selected.' : ''}` : `${col.name}, ${sceneName}: empty. Add clip.${selected ? ' Selected.' : ''}`;
  const moveSpoken =
    drop === 'source' ? 'Moving this clip.' : drop === 'no' ? 'It cannot go here.' : target === 'swap' ? 'Press Enter to swap the two clips.' : 'Press Enter to drop it here.';
  return (
    <div
      className={styles.cell}
      data-pad-cell=""
      data-track={trackId}
      data-slot={slot}
      data-drop={drop}
      data-over={target ? true : undefined}
      data-target={target}
      data-chip={target ? DROP_CHIP[target] : undefined}
      data-dim={dimmed || undefined}
      style={lean}
      onPointerDown={(e) => {
        // The pad itself, not its '⋯' key.
        if (clip && !(e.target as Element).closest('[data-no-drag]')) onPointerDownPad(e, { trackId, slot });
      }}
      onContextMenu={(e) => onContextMenuOpen(e, (a) => open(a, document.getElementById(id)))}
    >
      {/* Always wrapped (an empty pad has a tip too), so the pad never remounts and keeps focus when a clip lands on it. */}
      <Tooltip tip={clip ? PAD_TIP : EMPTY_PAD_TIP} hint={clip ? PAD_ACTIONS_HINT : undefined}>
        <Pad
          state={state}
          selected={selected}
          label={clip ? clip.name : 'Add clip'}
          sublabel={clip ? barsLabel(clip.bars) : undefined}
          caption={caption}
          captionIcon={paused ? 'pause' : undefined}
          activateOn="release"
          labelSize="lg"
          quietEmpty
          cornerKey={selected && !move}
          shortcuts={clip ? CLIP_PAD_SHORTCUTS : PAD_SHORTCUTS}
          sketch={clip ? <PadSketch clip={clip} drums={col.drums} /> : undefined}
          onPress={onPress}
          ariaLabel={move && drop ? `${label} ${moveSpoken}` : label}
          id={id}
        />
      </Tooltip>
      {selected && !move && (
        <Tooltip name={clip ? 'Clip options' : 'New clip or paste'} tip={clip ? 'Rename, length, duplicate, move, copy, paste, clear or delete this clip.' : 'Make a new clip here, or paste a copied one.'} detail={`Right-click any pad for the same menu (or Shift+F10, or . on a focused pad). Keys on a pad: Delete, ${MOD_KEY}C, ${MOD_KEY}V, F2.`}>
          <button
            type="button"
            className={styles.more}
            data-no-drag=""
            aria-label={`Options for ${what} (${col.name}, ${sceneName})`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => (menuOpen ? onMenu(null) : open(anchorFromElement(e.currentTarget), e.currentTarget, e.currentTarget))}
          >
            <MoreIcon />
          </button>
        </Tooltip>
      )}
    </div>
  );
});

/** A clip's notes in miniature, for its pad's empty middle (redrawn only when its notes or length change). */
function PadSketch({ clip, drums }: { clip: Clip; drums: boolean }) {
  return <ClipSketch notes={clip.notes} lengthTicks={clip.bars * TICKS_PER_BAR} kind={drums ? 'drums' : 'notes'} />;
}

/** Two arrows, for the lifted pad's label when a drop would swap. */
function SwapIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5.5 H12.5 M10 3 L12.5 5.5 L10 8" />
      <path d="M13 10.5 H3.5 M6 8 L3.5 10.5 L6 13" />
    </svg>
  );
}

/** A circle with a bar: the drop is refused. */
function RefusedIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" aria-hidden="true">
      <circle cx={8} cy={8} r={5.6} />
      <path d="M4.1 11.9 L11.9 4.1" />
    </svg>
  );
}

/** The lifted pad's label: one icon per meaning, chosen by the lift's data-kind / data-copy (written by GridGestures). */
function LiftLabel({ labelRef }: { labelRef: (el: HTMLSpanElement | null) => void }) {
  return (
    <span className={styles.liftLabel}>
      <span className={styles.liftIcon} data-for="move">
        <Icon name="drag" size={12} />
      </span>
      <span className={styles.liftIcon} data-for="copy">
        <Icon name="copy" size={12} />
      </span>
      <span className={styles.liftIcon} data-for="swap">
        <SwapIcon />
      </span>
      <span className={styles.liftIcon} data-for="no">
        <RefusedIcon />
      </span>
      <span className={styles.liftIcon} data-for="none">
        <Icon name="close" size={12} />
      </span>
      {/* Its words are written by the gesture (never re-rendered by React). */}
      <span ref={labelRef} className={styles.liftText} />
    </span>
  );
}

/** A real copy of the carried pad (live name, length and state light) that follows the pointer. */
function LiftedPad({ ui, liftRef, labelRef }: { ui: Extract<DragUi, { kind: 'pad' }>; liftRef: (el: HTMLDivElement | null) => void; labelRef: (el: HTMLSpanElement | null) => void }) {
  const clip = useProject((p) => clipAt(p, ui.from));
  const { state, caption, paused } = usePadLook(ui.from.trackId, ui.from.slot, clip);
  if (!clip) return null;
  return createPortal(
    <div
      ref={liftRef}
      className={styles.lift}
      data-testid="pad-lift"
      aria-hidden="true"
      inert
      style={{ width: ui.width, height: ui.height, transformOrigin: `${ui.grabX}px ${ui.grabY}px` }}
    >
      <Pad
        state={state}
        label={clip.name}
        sublabel={barsLabel(clip.bars)}
        caption={caption}
        captionIcon={paused ? 'pause' : undefined}
        labelSize="lg"
        activateOn="release"
        sketch={<PadSketch clip={clip} drums={session.store.getState().tracks.find((t) => t.id === ui.from.trackId)?.instrument.kind === 'drums'} />}
        onPress={() => {}}
      />
      <LiftLabel labelRef={labelRef} />
    </div>,
    document.body,
  );
}

/** The carried scene row: its scene label, lifted, and a faint copy of its pads. */
function LiftedRow({ ui, liftRef, labelRef }: { ui: Extract<DragUi, { kind: 'row' }>; liftRef: (el: HTMLDivElement | null) => void; labelRef: (el: HTMLSpanElement | null) => void }) {
  return createPortal(
    <div ref={liftRef} className={styles.rowLift} data-testid="row-lift" aria-hidden="true" inert style={{ width: ui.width, height: ui.height }}>
      {ui.pads.map((p, i) => (
        <div key={i} className={styles.rowLiftPad} data-empty={p.name === null || undefined} style={{ left: p.left, width: p.width }}>
          {p.name !== null && (
            <>
              <span className={styles.rowLiftName}>{p.name}</span>
              <span className={styles.rowLiftBars}>{p.bars}</span>
            </>
          )}
        </div>
      ))}
      <div className={styles.rowLiftScene} style={{ left: ui.scene.left, width: ui.scene.width }}>
        <span className={styles.sceneIcon}>
          <Icon name="play" size={12} />
        </span>
        <span className={styles.sceneName}>{ui.scene.name}</span>
        <span className={styles.sceneCount}>{scenePartsText(ui.scene.count)}</span>
        <LiftLabel labelRef={labelRef} />
      </div>
    </div>,
    document.body,
  );
}

/** Draws whatever is being carried (its own little store, so the grid does not re-render when a drag starts or ends). */
function DragLayer(props: { gestures: GridGestures; liftRef: (el: HTMLDivElement | null) => void; labelRef: (el: HTMLSpanElement | null) => void; chipRef: (el: HTMLDivElement | null) => void }) {
  const { gestures, liftRef, labelRef, chipRef } = props;
  const ui = useSyncExternalStore(gestures.subscribe, gestures.getUi);
  if (!ui) return null;
  if (ui.kind === 'row') return <LiftedRow ui={ui} liftRef={liftRef} labelRef={labelRef} />;
  return (
    <>
      <LiftedPad ui={ui} liftRef={liftRef} labelRef={labelRef} />
      {createPortal(<div ref={chipRef} className={styles.targetChip} data-testid="pad-target-word" aria-hidden="true" />, document.body)}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Column headers                                                      */
/* ------------------------------------------------------------------ */

/**
 * The part's play/stop key: ▶ starts its selected clip (the one its pad ring
 * marks, see selection.ts) at the next bar, ■ stops it at the next bar (or
 * cancels a queued start). Stopped, ■ takes an armed clip off the next Play.
 */
function PartPlayButton({ col, id }: { col: ColumnSummary; id: string }) {
  const transport = useRuntime((s): Transport => (s.playing ? 'playing' : s.paused ? 'paused' : 'stopped'));
  const rt = useRuntime((s) => s.tracks[col.id]);
  const chosen = useUi((s) => s.selectedSlot[col.id] as number | undefined);
  const playingSlot = rt?.playingSlot ?? null;
  const queued = rt?.queued ?? null;
  // The chosen clip; a part never selected yet: the one it would be given when selected (its first clip).
  const first = col.clips.findIndex((c) => !!c);
  const target = chosen ?? (first < 0 ? 0 : first);
  const clip = col.clips[target] ?? null;
  if (playingSlot !== null || (queued && queued.slot !== null)) {
    const stopping = playingSlot !== null && queued !== null && queued.slot === null;
    const queuedOnly = playingSlot === null;
    const label =
      transport === 'stopped'
        ? `Skip ${col.name} when Play starts`
        : queuedOnly
          ? `Cancel the start of ${col.name}`
          : stopping
            ? `${col.name} stops at the next bar`
            : `Stop ${col.name} at the next bar`;
    return (
      <IconButton
        id={id}
        icon="stop"
        label={label}
        tip={
          transport === 'stopped'
            ? 'Its lit clip will not start when you press Play.'
            : queuedOnly
              ? `${col.name} is waiting to start at the next bar. This cancels only that start.`
              : 'Stops only this part; the others carry on.'
        }
        size="sm"
        variant="secondary"
        disabled={stopping}
        onClick={() => session.stopTrack(col.id)}
        className={styles.partPlay}
      />
    );
  }
  return (
    <IconButton
      id={id}
      icon="play"
      label={clip ? `Play ${col.name}: ${clip.name}` : first < 0 ? `${col.name} has no clips` : `${col.name}: the selected pad is empty`}
      tip={
        clip
          ? `Starts ${clip.name} at the next bar (the clip selected on this part).`
          : first < 0
            ? 'Add a clip first: press an empty pad.'
            : `Select one of ${col.name}'s clips first: this plays the selected one.`
      }
      size="sm"
      variant="secondary"
      disabled={!clip}
      onClick={() => {
        if (!clip) return;
        selectTrack(col.id);
        selectSlot(col.id, target);
        void session.pressClip(col.id, target);
      }}
      className={styles.partPlay}
    />
  );
}

/** Header keys, in their order inside a column (each header key's id is `part-head-<column x 5 + this>`). */
const HEAD_KEYS = ['main', 'mute', 'solo', 'play', 'more'] as const;
const HEAD_ID = 'part-head-';
const headId = (column: number, key: (typeof HEAD_KEYS)[number]) => `${HEAD_ID}${column * HEAD_KEYS.length + HEAD_KEYS.indexOf(key)}`;

/** A header's full names in its native title, only while one of them is cut on screen (checked as the pointer arrives). */
function titleWhenCut(e: ReactPointerEvent<HTMLButtonElement>, full: string): void {
  const el = e.currentTarget;
  const cut = [...el.querySelectorAll<HTMLElement>('[data-cut-check]')].some((n) => n.scrollWidth > n.clientWidth + 0.5 || n.scrollHeight > n.clientHeight + 0.5);
  if (cut) el.title = full;
  else el.removeAttribute('title');
}

function TrackHeader(props: { col: ColumnSummary; index: number; anySolo: boolean; onMenu: OpenMenu; menuOpen: boolean }) {
  const { col, index, anySolo, onMenu, menuOpen } = props;
  const selected = useUi((s) => s.selectedTrackId === col.id);
  const headerRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLButtonElement>(null);
  const audible = !col.mute && (!anySolo || col.solo);
  const status = col.mute ? 'Muted' : anySolo && !col.solo ? 'Not soloed' : col.solo ? 'Solo' : null;
  // Muted and Not soloed take the meter's place; a soloed part is heard, so it keeps its meter (and a Solo tag).
  const silentWord = status === 'Muted' || status === 'Not soloed' ? status : null;
  const open = (anchor: MenuAnchor, returnFocus: HTMLElement | null, extra: Partial<MenuBase> = {}) => {
    selectTrack(col.id);
    onMenu({ kind: 'track', trackId: col.id, anchor, returnFocus, ...extra });
  };
  const onMainKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (isMenuKey(e)) {
      e.preventDefault();
      noteKeyboardMenu(e.currentTarget);
      open(anchorFromElement(headerRef.current), e.currentTarget);
    } else if (e.key === 'F2') {
      e.preventDefault();
      open(anchorFromElement(headerRef.current), e.currentTarget, { rename: true });
    }
  };
  return (
    <div
      ref={headerRef}
      className={`${styles.header} ${selected ? styles.headerSelected : ''}`}
      data-dim={!audible || undefined}
      data-muted={col.mute || undefined}
      onContextMenu={(e) => onContextMenuOpen(e, (a) => open(a, mainRef.current))}
    >
      <button
        ref={mainRef}
        id={headId(index, 'main')}
        type="button"
        className={styles.headerMain}
        onClick={() => selectTrack(col.id)}
        onKeyDown={onMainKey}
        onPointerEnter={(e) => titleWhenCut(e, `${col.name}: ${col.sound}`)}
        aria-pressed={selected}
        aria-label={`Select ${col.name} (${col.sound})${status ? `, ${status}` : ''}`}
        aria-keyshortcuts="F2 Shift+F10"
      >
        <span className={`${styles.trackNum} mono`}>{index + 1}</span>
        <span className={styles.trackName} data-cut-check="">
          {col.name}
        </span>
        {col.solo && <span className={styles.soloTag}>Solo</span>}
        <span className={styles.trackSound} data-cut-check="">
          {col.sound}
        </span>
      </button>
      <div className={styles.toggles}>
        <Tooltip tip={col.mute ? `Unmute ${col.name}.` : `Silence ${col.name} (it keeps playing in time).`} detail="M mutes the selected part.">
          <button
            id={headId(index, 'mute')}
            type="button"
            className={styles.toggle}
            data-kind="mute"
            aria-pressed={col.mute}
            aria-label={`Mute ${col.name}`}
            aria-keyshortcuts={selected ? 'M' : undefined}
            onClick={() => session.setMute(col.id, !col.mute)}
          >
            <Icon name="speaker" size={14} />
            <span>Mute</span>
          </button>
        </Tooltip>
        <Tooltip tip={col.solo ? `Stop soloing ${col.name}.` : `Hear only the soloed parts (${col.name} and any others you solo).`} detail="Solo has no key: S plays a note. M mutes the selected part.">
          <button
            id={headId(index, 'solo')}
            type="button"
            className={styles.toggle}
            data-kind="solo"
            aria-pressed={col.solo}
            aria-label={`Solo ${col.name}`}
            onClick={() => session.setSolo(col.id, !col.solo)}
          >
            <Icon name="headphones" size={14} />
            <span>Solo</span>
          </button>
        </Tooltip>
      </div>
      <div className={styles.headBottom}>
        <PartPlayButton col={col} id={headId(index, 'play')} />
        {silentWord ? (
          <span className={styles.status} data-status={silentWord === 'Muted' ? 'muted' : 'quiet'}>
            {silentWord}
          </span>
        ) : (
          <div className={styles.meter}>
            <Meter read={() => session.readMetersShared()?.tracks.find((t) => t.trackId === col.id)?.peak ?? 0} label={`${col.name} level`} orientation="horizontal" length="100%" thickness={6} segments={10} />
          </div>
        )}
        <Tooltip name="Part options" tip="Rename this part, change its instrument, or keep its pattern (no Variation)." detail="Right-click the header, or press F2 to rename.">
          <button
            id={headId(index, 'more')}
            type="button"
            className={styles.headerMore}
            aria-label={`Options for part ${col.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => (menuOpen ? onMenu(null) : open(anchorFromElement(e.currentTarget), e.currentTarget, { ignore: e.currentTarget }))}
          >
            <MoreIcon />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scenes                                                              */
/* ------------------------------------------------------------------ */

/** How many parts a scene row plays, in the words Arrange's scene cards use ("4 parts"). */
export function scenePartsText(n: number): string {
  return n === 0 ? 'no clips' : n === 1 ? '1 part' : `${n} parts`;
}

/** The scene button's tip: what "4 parts" means ("4 of 8 parts have a clip in this row …"). */
function scenePartsTip(n: number, of: number): string {
  if (n === 0) return `none of the ${of} parts has a clip in this row, so every part stops.`;
  return `${n} of ${of} parts ${n === 1 ? 'has a clip' : 'have clips'} in this row and start; the others stop.`;
}

function SceneButton(props: {
  row: number;
  rows: number;
  scene: Scene;
  columns: ColumnSummary[];
  onMenu: OpenMenu;
  menuOpen: boolean;
  onPointerDownScene(e: ReactPointerEvent<HTMLButtonElement>, row: number): void;
  consumeClick(): boolean;
}) {
  const { row, rows, scene, columns, onMenu, menuOpen, onPointerDownScene, consumeClick } = props;
  const btnRef = useRef<HTMLButtonElement>(null);
  const cellRef = useRef<HTMLDivElement>(null);
  const lit = useRuntime((s) => {
    if (!s.playing) return false;
    let any = false;
    for (const c of columns) {
      const has = !!c.clips[row];
      const rt = s.tracks[c.id];
      const on = rt?.playingSlot === row;
      if (has && !on) return false;
      if (!has && rt?.playingSlot != null) return false;
      if (on) any = true;
    }
    return any;
  });
  const count = columns.filter((c) => c.clips[row]).length;
  const open = (anchor: MenuAnchor, returnFocus: HTMLElement | null, extra: Partial<MenuBase> = {}) => onMenu({ kind: 'scene', row, anchor, returnFocus, ...extra });
  const focusPad = (column: number) => document.getElementById(padId(columns[Math.max(0, Math.min(columns.length - 1, column))].id, row))?.focus();
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (isMenuKey(e)) {
      e.preventDefault();
      noteKeyboardMenu(e.currentTarget);
      open(anchorFromElement(cellRef.current), e.currentTarget);
    } else if (e.key === 'F2') {
      e.preventDefault();
      open(anchorFromElement(cellRef.current), e.currentTarget, { rename: true });
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const to = row + (e.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= rows) return;
      if (moveSceneWithMotion(row, to)) document.querySelector<HTMLElement>(`[data-scene-row="${to}"] button[data-scene]`)?.focus();
    } else if (!e.altKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      // The scene buttons are the grid's last column: arrows move along it, Left goes back to the pads.
      e.preventDefault();
      const to = row + (e.key === 'ArrowUp' ? -1 : 1);
      if (to >= 0 && to < rows) document.querySelector<HTMLElement>(`[data-scene-row="${to}"] button[data-scene]`)?.focus();
    } else if (!e.altKey && !e.shiftKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      focusPad(columns.length - 1);
    } else if (!e.altKey && !e.shiftKey && e.key === 'Home') {
      e.preventDefault();
      focusPad(0);
    }
  };
  return (
    <div ref={cellRef} className={styles.sceneCell} data-scene-row={row} onContextMenu={(e) => onContextMenuOpen(e, (a) => open(a, btnRef.current))}>
      <Tooltip
        tip={`Play the ${scene.name} scene: ${scenePartsTip(count, columns.length)}`}
        detail="Scenes switch on the next bar. Drag the scene (or Alt+Up / Alt+Down) to reorder the rows; the clips move with it. Right-click, Shift+F10 or F2 for its menu: rename, insert, duplicate, delete."
      >
        <button
          ref={btnRef}
          id={`scene-btn-${row}`}
          type="button"
          data-scene=""
          data-row={row}
          data-lit={lit || undefined}
          className={`${styles.scene} ${lit ? styles.sceneLit : ''}`}
          onPointerDown={(e) => onPointerDownScene(e, row)}
          onClick={() => {
            if (consumeClick()) return;
            void session.launchScene(row);
          }}
          onKeyDown={onKey}
          aria-label={`Launch scene ${scene.name}${lit ? ' (playing)' : ''}`}
          aria-keyshortcuts="F2 Shift+F10 Alt+ArrowUp Alt+ArrowDown"
        >
          <span className={styles.sceneIcon} aria-hidden>
            <Icon name="play" size={12} />
          </span>
          <span className={styles.sceneName}>{scene.name}</span>
          <span className={styles.sceneCount}>{scenePartsText(count)}</span>
        </button>
      </Tooltip>
      <Tooltip name="Scene options" tip="Rename, move, insert, duplicate, capture, add to the song, export or delete this scene.">
        <button
          type="button"
          className={styles.sceneMore}
          aria-label={`Options for scene ${scene.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          // Not a Tab stop of its own: the scene button opens the same menu (Shift+F10, the menu key, F2).
          tabIndex={-1}
          onClick={(e) => (menuOpen ? onMenu(null) : open(anchorFromElement(e.currentTarget), e.currentTarget, { ignore: e.currentTarget }))}
        >
          <MoreIcon size={14} />
        </button>
      </Tooltip>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Selected pad actions                                                */
/* ------------------------------------------------------------------ */

function PadActions(props: {
  move: MoveState | null;
  gestures: GridGestures;
  onMove(from: PadRef): void;
  onCancelMove(): void;
  onRename(at: PadRef): void;
  onNewClip(at: PadRef, key: HTMLElement): void;
}) {
  const { move, gestures, onMove, onCancelMove, onRename, onNewClip } = props;
  const drag = useSyncExternalStore(gestures.subscribe, gestures.getUi);
  const locked = useEditLocked();
  const trackId = useUi((s) => s.selectedTrackId);
  const slot = useUi((s) => slotFor(s, s.selectedTrackId));
  const info = useProject(
    (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      const clip = t?.clips[slot] ?? null;
      return t ? { part: t.name, scene: p.scenes[slot]?.name ?? `Row ${slot + 1}`, name: clip?.name ?? null, bars: clip?.bars ?? 0, full: t.clips.every((c) => !!c) } : null;
    },
    (a, b) => a === b || (!!a && !!b && a.part === b.part && a.scene === b.scene && a.name === b.name && a.bars === b.bars && a.full === b.full),
  );
  // While a performance take records the clips are locked: one coral line instead of keys that would be refused.
  if (locked) {
    return (
      <div className={styles.actions} role="status" data-locked="" data-hint-avoid="">
        <p className={styles.lockLine}>
          <span className={styles.lockDot} aria-hidden="true" />
          {LOCKED_TEXT}. Pads and scenes still play; stop the take to edit clips.
        </p>
      </div>
    );
  }
  if (move || drag?.kind === 'pad') {
    return (
      <div className={styles.actions} role="region" aria-label="Moving a clip" data-moving="" data-hint-avoid="">
        <p className={styles.actionsText} aria-live="polite">
          <Icon name="drag" size={14} />
          {move
            ? `Moving “${move.clipName}”: arrow keys choose a pad, Enter moves it there (${MOD_KEY}Enter copies), Esc cancels.`
            : `Drop “${drag!.kind === 'pad' ? drag!.clipName : ''}” on a pad to move it; hold ${MOD_KEY.replace('+', '')} or Alt to copy. Esc cancels.`}
        </p>
        {move && (
          <Button size="sm" variant="secondary" icon="close" onClick={onCancelMove}>
            Cancel
          </Button>
        )}
      </div>
    );
  }
  if (!info) return null;
  const at = { trackId, slot };
  if (info.name === null) {
    return (
      <div className={styles.actions} role="region" aria-label="Selected pad" data-hint-avoid="">
        <p className={styles.actionsText}>
          <span className={styles.actionsWhat}>{`${info.part} · ${info.scene}`}</span> empty pad: tap it to add a clip.
        </p>
        <Button size="sm" variant="secondary" icon="plus" aria-haspopup="menu" onClick={(e) => onNewClip(at, e.currentTarget)} tip="Make a new clip here: choose its length (1 to 8 bars), or paste a copied clip.">
          New clip
        </Button>
      </div>
    );
  }
  return (
    <div className={styles.actions} role="group" aria-label={`Selected clip ${info.name}`} data-pad-actions="" data-hint-avoid="">
      <p className={styles.actionsText}>
        <span className={styles.actionsWhat}>{info.name}</span>
        <span className={styles.actionsWhere}>
          {info.part} · {info.scene} · {barsLabel(info.bars)}
        </span>
      </p>
      <div className={styles.actionKeys}>
        <Button size="sm" variant="secondary" data-edit-steps="" onClick={() => clipActions.editSteps(trackId, slot)} tip="Edit this clip’s steps or notes.">
          Edit steps
        </Button>
        <Button size="sm" variant="secondary" icon="duplicate" disabled={info.full} onClick={() => clipActions.duplicate(trackId, slot)} tip={info.full ? `${info.part} has no empty pad left.` : 'Copy this clip into the next empty pad of the part.'}>
          Duplicate
        </Button>
        <Button size="sm" variant="secondary" icon="drag" onClick={() => onMove(at)} tip="Move this clip to another pad with the arrow keys and Enter. You can also drag it.">
          Move…
        </Button>
        <Button size="sm" variant="secondary" icon="pencil" onClick={() => onRename(at)} tip="Rename this clip (F2 on the pad).">
          Rename
        </Button>
        <Button size="sm" variant="danger" icon="trash" onClick={() => clipActions.remove(trackId, slot)} tip="Delete this clip. Undo brings it back.">
          Delete
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Grid                                                                */
/* ------------------------------------------------------------------ */

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const countWords = (n: number, one: string, many: string) => `${NUMBER_WORDS[n] ?? String(n)} ${n === 1 ? one : many}`;

/** The pads and the scene buttons in the grid's roving Tab stop. */
const ROVING_SELECTOR = '[data-pad-cell] button[id^="pad-"], button[data-scene]';

/**
 * One Tab stop for the pads and the scene buttons (a roving tabindex): the
 * pad focused last while focus is inside, else the selected (ringed) pad.
 * Arrow keys, Home and End move focus (see onGridKey); the rest of the grid
 * is skipped with one Tab.
 */
function usePadRoving(gridRef: { current: HTMLElement | null }) {
  const homeOf = () => {
    const s = uiStore.getState();
    return padId(s.selectedTrackId, slotFor(s, s.selectedTrackId));
  };
  const current = useRef<string>(homeOf());
  const apply = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    let found = false;
    const els = grid.querySelectorAll<HTMLElement>(ROVING_SELECTOR);
    for (const el of els) {
      const on = el.id === current.current;
      el.tabIndex = on ? 0 : -1;
      found ||= on;
    }
    // The stop's pad went away (a scene deleted, another part): the first pad keeps the grid reachable.
    if (!found && els[0]) els[0].tabIndex = 0;
  }, [gridRef]);
  // After every render (rows come and go), and when the selection moves while focus is elsewhere.
  useLayoutEffect(() => apply());
  useEffect(
    () =>
      uiStore.subscribe(() => {
        if (gridRef.current?.contains(document.activeElement)) return;
        const home = homeOf();
        if (home === current.current) return;
        current.current = home;
        apply();
      }),
    [apply, gridRef],
  );
  return useCallback(
    (e: FocusEvent<HTMLElement>) => {
      const el = e.target as HTMLElement;
      if (!el.matches(ROVING_SELECTOR) || el.id === current.current) return;
      current.current = el.id;
      apply();
    },
    [apply],
  );
}

export function LoopsGrid() {
  const columns = useProject(summarize, sameColumns);
  const scenes = useProject((p) => p.scenes);
  const rows = scenes.length;
  const anySolo = columns.some((c) => c.solo);
  const locked = useEditLocked();
  const playing = useRuntime((s) => s.playing);
  const paused = useRuntime((s) => s.paused);
  const gridRef = useRef<HTMLDivElement>(null);
  const liftRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const chipRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<(MenuRequest & { seq: number }) | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const [soundFor, setSoundFor] = useState<Id | null>(null);
  const [move, setMove] = useState<MoveState | null>(null);
  const moveRef = useRef<MoveState | null>(null);
  moveRef.current = move;
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const seq = useRef(0);
  const openMenu = useCallback<OpenMenu>((req) => {
    seq.current += 1;
    setMenu(req ? { ...req, seq: seq.current } : null);
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const [gestures] = useState(
    () =>
      new GridGestures({
        grid: () => gridRef.current,
        liftEl: () => liftRef.current,
        labelEl: () => labelRef.current,
        chipEl: () => chipRef.current,
        keyMoveActive: () => !!moveRef.current,
        closeMenu: () => {
          if (menuRef.current) setMenu(null);
        },
      }),
  );
  useEffect(() => () => gestures.dispose(), [gestures]);
  const setLift = useCallback((el: HTMLDivElement | null) => {
    liftRef.current = el;
  }, []);
  const setLabel = useCallback((el: HTMLSpanElement | null) => {
    labelRef.current = el;
  }, []);
  const setChip = useCallback((el: HTMLDivElement | null) => {
    chipRef.current = el;
  }, []);

  // Loop progress and countdowns: one frame loop for the whole grid while playing; paused holds the last picture.
  const [painter] = useState(() => new ProgressPainter());
  const trackIds = columns.map((c) => c.id);
  const idsRef = useRef(trackIds);
  idsRef.current = trackIds;
  useRafLoop(() => painter.paint(gridRef.current, idsRef.current), playing);
  useEffect(() => {
    if (playing) return;
    if (paused) painter.paint(gridRef.current, idsRef.current);
    else painter.clear();
  }, [playing, paused, painter]);
  useEffect(() => () => painter.clear(), [painter]);

  // One Tab stop for the pads (with the scene buttons), one for the part headers.
  const onPadFocus = usePadRoving(gridRef);
  const selectedColumn = useUi((s) => Math.max(0, columns.findIndex((c) => c.id === s.selectedTrackId)));
  const { gridRef: headRef, onFocus: onHeadFocus } = useRovingPads(HEAD_ID, selectedColumn * HEAD_KEYS.length);

  const clipName = (at: PadRef) => clipAt(session.store.getState(), at)?.name ?? '';

  /** Drop the keyboard move's clip on `to`: move, or copy. One undo step; a refused drop says why. */
  const dropOn = useCallback((to: PadRef, copy: boolean) => {
    const src = moveRef.current?.from;
    if (!src) {
      setMove(null);
      return;
    }
    if (to.trackId === src.trackId && to.slot === src.slot) {
      setMove(null);
      document.getElementById(padId(to.trackId, to.slot))?.focus();
      return;
    }
    moveClipWithMotion(src, to, copy, () => setMove(null));
    document.getElementById(padId(to.trackId, to.slot))?.focus();
  }, []);

  const startKeyMove = useCallback((from: PadRef) => {
    setMenu(null);
    if (isEditLocked()) {
      notify('Locked while a performance records. Stop the take to move clips.', 'warn');
      return;
    }
    selectTrack(from.trackId);
    selectSlot(from.trackId, from.slot);
    setMove({ from, clipName: clipName(from), over: from });
    requestAnimationFrame(() => document.getElementById(padId(from.trackId, from.slot))?.focus());
  }, []);

  const cancelMove = useCallback(() => {
    const m = moveRef.current;
    setMove(null);
    if (m) document.getElementById(padId(m.from.trackId, m.from.slot))?.focus();
  }, []);

  const onPointerDownPad = useCallback((e: ReactPointerEvent<HTMLElement>, from: PadRef) => gestures.pressPad(e.nativeEvent, from), [gestures]);
  const onPointerDownScene = useCallback((e: ReactPointerEvent<HTMLButtonElement>, row: number) => gestures.pressRow(e.nativeEvent, row), [gestures]);

  // A keyboard move ends when the clip it moves goes away (undo, another part's edit), focus leaves the grid for good, or a take starts.
  useEffect(() => {
    if (!move) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t && (gridRef.current?.contains(t) || t.closest('[data-move-bar]'))) return;
      setMove(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [move]);
  useEffect(() => {
    if (move && (locked || !columns.find((c) => c.id === move.from.trackId)?.clips[move.from.slot])) setMove(null);
  }, [columns, move, locked]);

  /** Keys while choosing where a clip goes: Enter / Space drop it (Ctrl copies), Esc cancels. */
  const onGridKeyCapture = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (!moveRef.current) return;
      const el = e.target as HTMLElement;
      const at = /^pad-(.+)-(\d+)$/.exec(el.id);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelMove();
      } else if ((e.key === 'Enter' || e.key === ' ') && at) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) dropOn({ trackId: at[1], slot: Number(at[2]) }, e.ctrlKey || e.metaKey || e.altKey);
      }
    },
    [cancelMove, dropOn],
  );

  /** Pad keys: arrows, Home and End move focus (roving); menu key, F2, Delete, Ctrl+C / Ctrl+V act on the focused pad. */
  const onGridKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const el = e.target as HTMLElement;
      const m = /^pad-(.+)-(\d+)$/.exec(el.id);
      if (!m || !el.closest('[data-pad-cell]')) return;
      const trackId = m[1];
      const row = Number(m[2]);
      const mod = e.ctrlKey || e.metaKey;
      const moving = !!moveRef.current;
      const select = () => {
        selectTrack(trackId);
        selectSlot(trackId, row);
      };
      if (!moving && isActionsKey(e)) {
        e.preventDefault();
        if (e.repeat) return;
        noteKeyboardMenu(el);
        select();
        openMenu({ kind: 'clip', trackId, slot: row, anchor: anchorFromElement(el), returnFocus: el });
        return;
      }
      if (!moving && e.key === 'F2' && !mod) {
        e.preventDefault();
        select();
        const hasClip = !!session.store.getState().tracks.find((t) => t.id === trackId)?.clips[row];
        openMenu({ kind: 'clip', trackId, slot: row, anchor: anchorFromElement(el), returnFocus: el, rename: hasClip && !isEditLocked() });
        return;
      }
      if (!moving && (e.key === 'Delete' || e.key === 'Backspace') && !mod && !e.altKey) {
        e.preventDefault();
        select();
        clipActions.remove(trackId, row);
        return;
      }
      if (!moving && mod && !e.altKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        select();
        clipActions.copy(trackId, row);
        return;
      }
      if (!moving && mod && !e.altKey && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        clipActions.paste(trackId, row);
        return;
      }
      if (e.altKey || e.shiftKey) return;
      const ids = columnsRef.current.map((c) => c.id);
      const last = ids.length - 1;
      const lastRow = rowsRef.current - 1;
      const col = ids.indexOf(trackId);
      let c = col;
      let r = row;
      if (e.key === 'ArrowRight') {
        if (col === last && !moving) {
          // Past the last part: the row's scene button.
          e.preventDefault();
          document.querySelector<HTMLElement>(`[data-scene-row="${row}"] button[data-scene]`)?.focus();
          return;
        }
        c = Math.min(last, col + 1);
      } else if (e.key === 'ArrowLeft') c = Math.max(0, col - 1);
      else if (e.key === 'ArrowDown') r = Math.min(lastRow, row + 1);
      else if (e.key === 'ArrowUp') r = Math.max(0, row - 1);
      else if (e.key === 'Home') {
        c = 0;
        if (mod) r = 0;
      } else if (e.key === 'End') {
        c = last;
        if (mod) r = lastRow;
      } else return;
      e.preventDefault();
      const next = { trackId: ids[c], slot: r };
      if (moving) setMove((mv) => (mv ? { ...mv, over: next } : mv));
      document.getElementById(padId(next.trackId, next.slot))?.focus();
    },
    [openMenu],
  );

  /** Header keys: Left / Right go to the same key of the next part, Up / Down through a part's keys, Home / End to the first and last part. */
  const onHeadKey = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (!el.id.startsWith(HEAD_ID) || e.altKey || e.shiftKey) return;
    const n = Number(el.id.slice(HEAD_ID.length));
    if (!Number.isInteger(n)) return;
    const per = HEAD_KEYS.length;
    const parts = columnsRef.current.length;
    const col = Math.floor(n / per);
    const k = n % per;
    const usable = (i: number) => {
      const b = document.getElementById(`${HEAD_ID}${i}`) as HTMLButtonElement | null;
      return b && !b.disabled && b.offsetParent !== null ? b : null;
    };
    let to: HTMLElement | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      const c = e.key === 'Home' ? 0 : e.key === 'End' ? parts - 1 : Math.max(0, Math.min(parts - 1, col + (e.key === 'ArrowRight' ? 1 : -1)));
      to = usable(c * per + k) ?? usable(c * per);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const d = e.key === 'ArrowDown' ? 1 : -1;
      for (let j = k + d; j >= 0 && j < per && !to; j += d) to = usable(col * per + j);
    } else return;
    e.preventDefault();
    to?.focus();
  }, []);

  const rename = useCallback(
    (at: PadRef) => {
      const el = document.getElementById(padId(at.trackId, at.slot));
      openMenu({ kind: 'clip', trackId: at.trackId, slot: at.slot, anchor: anchorFromElement(el), returnFocus: el, rename: true });
    },
    [openMenu],
  );

  /** The pad actions' New clip: the new-clip choices (1 to 8 bars, or paste) open at that key. */
  const newClip = useCallback(
    (at: PadRef, keyEl: HTMLElement) => {
      openMenu({ kind: 'clip', trackId: at.trackId, slot: at.slot, anchor: anchorFromElement(keyEl), returnFocus: keyEl, ignore: keyEl });
    },
    [openMenu],
  );

  const addScene = () => {
    const r = insertScene(session.store);
    if (!session.accepted(r)) return;
    const name = session.store.getState().scenes[r.row ?? rows]?.name ?? 'A new scene';
    notify(`Added the empty scene ${name} under the others.`, 'info', 'undo');
    const at = r.row ?? rows;
    requestAnimationFrame(() => {
      const btn = document.querySelector<HTMLElement>(`[data-scene-row="${at}"] button[data-scene]`);
      btn?.scrollIntoView({ block: 'nearest' });
      btn?.focus({ preventScroll: true });
    });
  };

  const moveCol = move ? columns.findIndex((c) => c.id === move.from.trackId) : -1;

  return (
    <div className={styles.wrap}>
      <div
        className={styles.grid}
        ref={gridRef}
        onKeyDown={onGridKey}
        onKeyDownCapture={onGridKeyCapture}
        onFocus={onPadFocus}
        role="group"
        aria-label={`Clip pads: ${countWords(columns.length, 'part', 'parts')} by ${countWords(rows, 'scene', 'scenes')}`}
        data-moving={move ? 'keys' : undefined}
        data-locked={locked || undefined}
        style={{ '--rows': rows } as CSSProperties}
      >
        {/* The part headers and Stop all: one sticky row (the pad rows scroll under it). */}
        <div className={styles.head} ref={headRef} onKeyDown={onHeadKey} onFocus={onHeadFocus} data-grid-head="">
          {columns.map((c, i) => (
            <TrackHeader key={c.id} col={c} index={i} anySolo={anySolo} onMenu={openMenu} menuOpen={menu?.kind === 'track' && menu.trackId === c.id} />
          ))}
          <div className={styles.sceneHeader}>
            <span className={styles.sceneHeaderText}>Scenes</span>
            <Tooltip tip="Stop every part at the next bar (the transport keeps running).">
              <button type="button" className={styles.stopAll} onClick={() => session.stopAllClips()} aria-label="Stop all parts at the next bar">
                <Icon name="stop" size={12} />
                <span>Stop all</span>
              </button>
            </Tooltip>
          </div>
        </div>
        {scenes.map((scene, row) => (
          <div key={scene.id} className={styles.row}>
            {columns.map((c, i) => (
              <ClipPad
                key={c.id}
                col={c}
                index={i}
                slot={row}
                sceneName={scene.name}
                dimmed={c.mute || (anySolo && !c.solo)}
                onMenu={openMenu}
                menuOpen={menu?.kind === 'clip' && menu.trackId === c.id && menu.slot === row}
                move={move}
                moveCol={moveCol}
                onPointerDownPad={onPointerDownPad}
                onDropHere={dropOn}
              />
            ))}
            <SceneButton
              row={row}
              rows={rows}
              scene={scene}
              columns={columns}
              onMenu={openMenu}
              menuOpen={menu?.kind === 'scene' && menu.row === row}
              onPointerDownScene={onPointerDownScene}
              consumeClick={gestures.consumeClick}
            />
          </div>
        ))}
      </div>
      {/* Under the grid: the selected pad's actions, and under the scene column "Add scene" (until there are 8). */}
      <div className={styles.bottom} data-add={rows < MAX_SCENES || undefined}>
        <div data-move-bar="" className={styles.bottomBar}>
          <PadActions move={move} gestures={gestures} onMove={startKeyMove} onCancelMove={cancelMove} onRename={rename} onNewClip={newClip} />
        </div>
        {rows < MAX_SCENES && (
          <Tooltip tip={locked ? `${LOCKED_TEXT}.` : `Add an empty scene row under the others (up to ${MAX_SCENES}). The scene menu (⋯) can also insert, duplicate or capture one.`}>
            <button type="button" className={styles.addScene} disabled={locked} onClick={addScene}>
              <Icon name="plus" size={12} />
              <span>Add scene</span>
            </button>
          </Tooltip>
        )}
      </div>

      <DragLayer gestures={gestures} liftRef={setLift} labelRef={setLabel} chipRef={setChip} />
      {menu?.kind === 'clip' && (
        <ClipMenu
          key={menu.seq}
          trackId={menu.trackId}
          slot={menu.slot}
          anchor={menu.anchor}
          returnFocus={menu.returnFocus}
          ignore={menu.ignore}
          startInRename={menu.rename}
          onClose={closeMenu}
          onMove={() => startKeyMove({ trackId: menu.trackId, slot: menu.slot })}
        />
      )}
      {menu?.kind === 'track' && (
        <TrackMenu
          key={menu.seq}
          trackId={menu.trackId}
          anchor={menu.anchor}
          returnFocus={menu.returnFocus}
          ignore={menu.ignore}
          startInRename={menu.rename}
          onClose={closeMenu}
          onChangeSound={(id) => setSoundFor(id)}
        />
      )}
      {menu?.kind === 'scene' && <SceneMenu key={menu.seq} row={menu.row} anchor={menu.anchor} returnFocus={menu.returnFocus} ignore={menu.ignore} startInRename={menu.rename} onClose={closeMenu} />}
      <SoundBrowser open={soundFor !== null} trackId={soundFor ?? ''} onClose={() => setSoundFor(null)} />
    </div>
  );
}
