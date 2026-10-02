/**
 * The song lane: a magnetic, part-aware timeline of scene blocks.
 *
 *   Parts │ 1    5    9         17        25 …           ← ruler (click: play from that bar)
 *         │┌────────┬──────────────────┬─────────┐
 *         ││Intro ▶⋯│Groove         ▶⋯ │Lift   ▶⋯│      ← block headers
 *   Drums ││▌Kick   │▌Four on the floor│▌Kick    │      ← one cell per part
 *   Bass  ││        │▌Rolling          │ Off     │
 *    …    │└────────┴──────────────────┴─────────╢      ← right edge: drag for passes
 *         │            [⊐⊏ Join]                       ← seam of two equal blocks
 *   SCENES  [Intro +] [Groove +] [Lift +] [Break +]  hints  [Follow] [− +] [Fit song]
 *
 * The lane is one Tab stop; arrow keys move between blocks (roving focus),
 * ↓ enters a block's part cells. Pointer gestures live in LaneGestures, which
 * writes positions straight to the DOM; this component re-renders only when
 * what is shown changes kind (selection, a drag starting or ending, menus).
 * It also renders the song header's Loop button (into the slot the panel
 * gives it), which names the blocks it acts on.
 *
 * The scale (pixels per bar) is chosen when the lane opens (the largest zoom
 * step at which the song fits) and then stays put while the song is edited:
 * a longer song scrolls instead of shrinking under the pointer. It changes
 * only when the window is resized, with Fit song, the zoom buttons or
 * Ctrl+wheel over the lane, and then glides (keeping the bar under the
 * pointer, or the middle of the view, where it was). Fit song never makes a
 * song that is cut off bigger: when it cannot show the whole song it shows as
 * much as the smallest step allows, and says so.
 *
 * Undo and Redo keep the lane's keyboard focus and selection: undoing a lane
 * edit brings back the selection (and the focused block) it had before, redo
 * the one after; a focused block that goes away hands focus to its nearest
 * neighbour.
 */
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, Icon, IconButton, TOOLTIP_DELAY_MS, Tooltip, useElementSize, useRafLoop, useTips } from '../../../ui/components';
import { sameMaterial } from '../../../project/arrangement';
import type { Id, Project } from '../../../project/types';
import { DEFAULT_BLOCK_REPEATS, joinProblem, type ShapeKind } from '../../../state/commands';
import { session, useProject, useUi } from '../../instance';
import { notify, useRuntime } from '../../runtime';
import { anchorFromContextEvent, anchorFromElement, isEchoOfKeyboardMenu, isMenuKey, noteKeyboardMenu, MOD_KEY, type MenuAnchor } from '../ClipMenu';
import { BlockMenu, PartPicker, partsText, type BlockMenuActions, type SceneSummary } from './BlockMenu';
import { LaneGestures, type DragUi, type LaneHost } from './laneGestures';
import { LaneIcon } from './laneIcons';
import { loopButtonPress, loopButtonTarget, loopButtonText, loopRange, loopSpan, loopStatus, loopTarget, loopTargetName, type LoopSpan } from './laneLoop';
import { FOLLOW_SCROLL_MS, PLAYHEAD_GLIDE_MS, ZOOM_MS, easeOut, prefersReducedMotion } from './laneMotion';
import { LaneRuler } from './LaneRuler';
import { readFollow, writeFollow } from './laneSettings';
import * as act from './songActions';
import { BlockFace, SongBlock, type BlockHandlers } from './SongBlock';
import { EMPTY_SELECTION, menuTargets, nudgeGap, pasteGap, pruneSelection, selectAll, selectByClick, selectByKey, type LaneSelection, type LaneSelectionState } from './songDrag';
import { COMPACT_HEADER_BELOW, anchorAt, anchorX, barToX, blockWidth, fitSong, followScroll, layoutSong, scrollToShow, zoomStep, type LaneAnchor, type SongLayout } from './songLayout';
import { barsText, cellTip, cellToggle, layerPreview, layerText, liveLengthText, resizeText, timesText, type BlockView, type LayerPreview } from './songModel';
import { getSongPlan, songTimelineBar, startSong } from './songPlan';
import styles from './SongPanel.module.css';

/** pendingFocus value meaning "the song is now empty: focus Add all scenes". */
const EMPTY_FOCUS = '\u0000empty';
/** After the user scrolls the lane, edits the song or acts on it from the keyboard, the playhead stops pulling the view for this long. */
export const FOLLOW_PAUSE_MS = 8000;
/** The playhead never turns the lane's page while the pointer moves over the lane, nor until it has rested this long (ms). */
export const FOLLOW_POINTER_REST_MS = 2000;
/** Nor while the lane has keyboard focus and a key was pressed there this recently (ms). */
export const FOLLOW_KEY_REST_MS = 2000;
/** After an edit (or a new layout), a jump of the playhead's place this soon (ms) is the edit's re-plan: it glides. */
const PLAYHEAD_REPLAN_WINDOW_MS = 500;
/** Clicks on the same part cell this close together are one undo step. */
export const CELL_GESTURE_MS = 500;
/** + and − presses on the same blocks this close together (ms) are one undo step. */
export const LENGTH_GESTURE_MS = 1000;
/** Ctrl+wheel travel (deltaY units) for one zoom step. */
const WHEEL_STEP = 60;
/** A finger this close (px) to a block's left edge is on the seam: it takes the left neighbour's right edge. */
const SEAM_SLOP_PX = 12;

export interface SongLaneProps {
  views: readonly BlockView[];
  scenes: SceneSummary[];
  /** Block playing now (song mode), by id. */
  currentId: Id | null;
  /** The block playing now was removed: the block that takes over at the next bar. */
  nextId?: Id | null;
  /** The song plays or is paused: draw the playhead. */
  songActive: boolean;
  /** The song plays (the playhead keeps itself in view). */
  songPlaying: boolean;
  editClips(row: number): void;
  /** Where the song header's Loop button goes (the lane renders it: it knows what the button acts on). */
  loopSlot?: HTMLElement | null;
}

/** What the lane last showed selected and focused: restored by Undo (before an edit) and Redo (after it). */
interface LaneSnap {
  sel: LaneSelectionState;
  focus: Id | null;
}

/** Blocks whose seam with the next block shows Join (same material, and together within the pass limit). */
function selectJoins(p: Project): Id[] {
  const out: Id[] = [];
  const list = p.arrangement.blocks;
  for (let i = 0; i + 1 < list.length; i++) if (sameMaterial(list[i], list[i + 1]) && joinProblem(p, list[i].id) === null) out.push(list[i].id);
  return out;
}

function sameIds(a: readonly Id[], b: readonly Id[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Block names in song order, the same array while they are unchanged. */
function useNames(views: readonly BlockView[]): readonly string[] {
  const last = useRef<readonly string[]>([]);
  return useMemo(() => {
    const next = views.map((v) => v.name);
    if (next.length === last.current.length && next.every((n, i) => n === last.current[i])) return last.current;
    last.current = next;
    return next;
  }, [views]);
}

const cellSelector = (blockId: Id, trackId: Id) => `#song-block-${CSS.escape(blockId)} [data-cell][data-track="${CSS.escape(trackId)}"]`;
const translate = (x: number) => `translate3d(${x.toFixed(1)}px, 0, 0)`;

function samePreview(a: LayerPreview | null, b: LayerPreview | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.sceneName !== b.sceneName || a.mode !== b.mode || a.same !== b.same || a.replaceCount !== b.replaceCount || a.changes.size !== b.changes.size) return false;
  for (const [k, v] of a.changes) if (b.changes.get(k) !== v) return false;
  return true;
}

export function SongLane({ views, scenes, currentId, nextId = null, songActive, songPlaying, editClips, loopSlot = null }: SongLaneProps) {
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const locked = useRuntime((s) => s.recording === 'performance');
  const songLoop = useRuntime((s) => s.songLoop);
  const tips = useTips();
  const helpId = useId();
  const order = useMemo(() => views.map((v) => v.id), [views]);
  const names = useNames(views);
  // The looped blocks in the current order (a loop whose blocks are gone is no loop).
  const loop = useMemo(() => loopSpan(order, songLoop), [order, songLoop]);

  /* ---- geometry ---- */
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollerRef);
  const measured = size.width > 0;
  // The free room after the last block (drops at the end, the last block's edge) is part of the fit (layout.room).
  const avail = size.width;
  const inputs = useMemo(() => views.map((v) => ({ id: v.id, bars: v.passBars, repeats: v.repeats })), [views]);
  // The scale the lane opens (and refits on a window resize) at: the largest step at which the song fits, else a readable one that scrolls.
  const fit = useMemo(() => layoutSong(inputs, avail).pxPerBar, [inputs, avail]);
  // What Fit song does: the whole song if any step shows it, else as much as the smallest step shows.
  const fitted = useMemo(() => fitSong(inputs, avail), [inputs, avail]);
  // The scale in use: fixed once the lane has opened (edits never rescale it), else the one that fits.
  const [scale, setScale] = useState<number | null>(null);
  const ppb = scale ?? fit;
  const layout: SongLayout = useMemo(() => layoutSong(inputs, avail, { pxPerBar: ppb }), [inputs, avail, ppb]);
  const total = layout.contentWidth + layout.room;

  /* ---- state ---- */
  // `byUser`: the user made this selection (a click or the keyboard); one an action left behind (a drop, a paste) is not what the Loop button loops.
  const [selectionState, setSelectionState] = useState<LaneSelectionState>({ ...EMPTY_SELECTION, byUser: false });
  const setSelection = useCallback((sel: LaneSelection, byUser = false) => setSelectionState({ ids: sel.ids, anchor: sel.anchor, byUser }), []);
  const selection = useMemo(() => pruneSelection(selectionState, order), [selectionState, order]);
  const userSelected = selectionState.byUser ? selection.ids : EMPTY_SELECTION.ids;
  const [activeId, setActiveId] = useState<Id | null>(null);
  const tabId = activeId && order.includes(activeId) ? activeId : (order[0] ?? null);
  const [dragUi, setDragUi] = useState<DragUi | null>(null);
  const [menu, setMenu] = useState<{ blockId: Id; anchor: MenuAnchor; returnFocus: HTMLElement | null } | null>(null);
  const [picker, setPicker] = useState<{ blockId: Id; trackId: Id; anchor: MenuAnchor; returnFocus: HTMLElement | null } | null>(null);
  const [renaming, setRenaming] = useState<Id | null>(null);
  const [status, setStatus] = useState({ text: '', n: 0 });
  const announce = useCallback((text: string | null | undefined) => {
    if (text) setStatus((s) => ({ text, n: s.n + 1 }));
  }, []);
  const [follow, setFollowState] = useState(readFollow);
  const [lockPulse, setLockPulse] = useState(0);

  // Latest values for callbacks that must stay stable (memoised blocks, the gesture controller, the frame loop).
  const busy = !!(menu || picker || renaming);
  const liveNow = { views, order, names, layout, selection, userSelected, byUser: selectionState.byUser, scenes, activeId: tabId, viewport: size.width, total, follow, songPlaying, advanced, loop, currentId, busy };
  const live = useRef(liveNow);
  live.current = liveNow;

  /* ---- focus ---- */
  const pendingFocus = useRef<string | null>(null);
  const addAllRef = useRef<HTMLButtonElement>(null);
  const focusBlock = useCallback((id: Id | null | undefined) => {
    if (!id) return;
    setActiveId(id);
    pendingFocus.current = id;
  }, []);
  // Hiding a carried block can drop focus to the page: that still counts as "focus was in the lane".
  const laneHasFocus = () => !!laneRef.current?.contains(document.activeElement) || document.activeElement === document.body;
  /**
   * After a drop, keyboard focus goes back to the landed block once the drop's
   * frame is drawn: focusing in the drop's own frame would force the whole
   * page's style and layout before the browser does them anyway.
   */
  const focusRaf = useRef(0);
  const focusAfterFrame = (id: Id) => {
    cancelAnimationFrame(focusRaf.current);
    focusRaf.current = requestAnimationFrame(() => {
      focusRaf.current = requestAnimationFrame(() => {
        focusRaf.current = 0;
        const el = blockEls.current.get(id);
        if (!el || !el.isConnected || document.activeElement === el || !laneHasFocus()) return;
        setActiveId(id);
        el.focus({ preventScroll: true });
        revealBlock(id);
      });
    });
  };
  useEffect(() => () => cancelAnimationFrame(focusRaf.current), []);

  /* ---- following the playhead ---- */
  const followPausedUntil = useRef(0);
  const pauseFollow = useCallback(() => {
    followPausedUntil.current = performance.now() + FOLLOW_PAUSE_MS;
    followAnim.current = null;
  }, []);
  /** The pointer over the lane, and when it last moved there: the page never turns under it. */
  const pointerOver = useRef({ inside: false, at: 0 });
  /** When a key was last pressed in the lane (Space and Shift+Space, the transport's keys, do not count). */
  const keyAt = useRef(0);
  const followAnim = useRef<{ from: number; to: number; t0: number } | null>(null);
  /** The scroll position this lane last set itself (its scroll event is not the user's). */
  const ownScroll = useRef<number | null>(null);

  /* ---- block elements and the gesture controller ---- */
  const blockEls = useRef(new Map<Id, HTMLElement>());
  const cloneRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const ghostHintRef = useRef<HTMLSpanElement>(null);

  const gestures = useRef<LaneGestures | null>(null);
  if (!gestures.current) {
    const host: LaneHost = {
      scroller: () => scrollerRef.current,
      content: () => contentRef.current,
      track: () => trackRef.current,
      blockEl: (id) => blockEls.current.get(id),
      cloneEl: () => cloneRef.current,
      slotEl: () => slotRef.current,
      bubbleEl: () => bubbleRef.current,
      ghostEl: () => ghostRef.current,
      labelEl: () => labelRef.current,
      badgeEl: () => badgeRef.current,
      ghostHintEl: () => ghostHintRef.current,
      contains: (node) => !!laneRef.current?.contains(node) || !!paletteRef.current?.contains(node),
      layout: () => live.current.layout,
      viewport: () => live.current.viewport,
      order: () => live.current.views.map((v) => ({ id: v.id, layerable: !v.missing, name: v.name })),
      selection: () => live.current.selection,
      locked: () => act.songLocked(),
      sceneWidth: (sceneId) => {
        const s = live.current.scenes.find((x) => x.id === sceneId);
        return blockWidth((s?.bars ?? 1) * DEFAULT_BLOCK_REPEATS, live.current.layout.pxPerBar);
      },
      sceneName: (sceneId) => live.current.scenes.find((x) => x.id === sceneId)?.name ?? 'scene',
      layerText: (blockId, sceneId, mode) => {
        const p = session.store.getState();
        const b = p.arrangement.blocks.find((x) => x.id === blockId);
        const v = live.current.views.find((x) => x.id === blockId);
        return b ? layerText(layerPreview(p, b, sceneId, mode), v?.name ?? 'this block') : { title: 'Drop on the song to add it', hint: null };
      },
      setDragUi: (ui) => {
        setDragUi(ui);
        if (ui) {
          setMenu(null);
          setPicker(null);
          hideCellTip();
        }
      },
      selectOnly: (id) => {
        setSelection({ ids: [id], anchor: id });
        setActiveId(id);
      },
      refuseLocked: () => refuseLocked(),
      commitMove: (ids, gap, copy) => {
        const focus = laneHasFocus();
        if (copy) {
          const r = act.duplicateBlocks(ids, gap);
          if (!r) return null;
          setSelection({ ids: r.ids, anchor: r.ids[0] });
          setActiveId(r.ids[0]);
          if (focus) focusAfterFrame(r.ids[0]);
          announce(r.text);
          return r.ids;
        }
        const text = act.moveBlocks(ids, gap);
        if (!text) return null;
        const moved = session.store.getState().arrangement.blocks.filter((b) => ids.includes(b.id)).map((b) => b.id);
        setSelection({ ids: moved, anchor: moved[0] });
        if (focus) focusAfterFrame(live.current.activeId && moved.includes(live.current.activeId) ? live.current.activeId : moved[0]);
        announce(text);
        return moved;
      },
      commitInsert: (sceneId, gap) => {
        const r = act.addScene(sceneId, gap);
        if (!r) return null;
        setSelection({ ids: [r.id], anchor: r.id });
        setActiveId(r.id);
        announce(r.text);
        return r.id;
      },
      commitLayer: (blockId, sceneId, mode) => {
        announce(act.layerScene(blockId, sceneId, mode));
      },
      commitRepeats: (id, repeats) => {
        announce(act.setRepeats([id], () => repeats, act.newGesture('edge')));
      },
      resizeLabel: (id, repeats) => {
        const v = live.current.views.find((x) => x.id === id);
        return resizeText(v?.passBars ?? 1, repeats, live.current.advanced);
      },
      lengthLabel: (id, repeats) => {
        const v = live.current.views.find((x) => x.id === id);
        return liveLengthText(v?.passBars ?? 1, repeats, live.current.advanced);
      },
      holdMenu: (id, target) => {
        const cell = target?.closest<HTMLElement>('[data-cell]');
        const el = blockEls.current.get(id);
        if (cell?.dataset.track && el?.contains(cell)) {
          openPicker(id, cell.dataset.track, anchorFromElement(cell), cell);
          return;
        }
        openMenu(id, anchorFromElement(el?.querySelector<HTMLElement>('[aria-haspopup="menu"]') ?? el ?? null));
      },
    };
    gestures.current = new LaneGestures(host);
  }
  const g = gestures.current;

  /* ---- the take lock: refused quietly, said once on the lane ---- */
  const refuseLocked = useCallback(() => {
    setLockPulse((n) => n + 1);
    announce(act.LOCKED_TEXT);
  }, [announce]);
  useEffect(() => act.onSongLocked(refuseLocked), [refuseLocked]);

  /* ---- scale: chosen when the lane opens, kept while editing ---- */
  const pendingZoom = useRef<{ from: Map<Id, { x: number; w: number }>; anchor: LaneAnchor | null; screenX: number; scroll: number; fit: boolean } | null>(null);
  const zoomTimer = useRef(0);
  /**
   * Change the scale, keeping what is `screenX` px into the view (default: its
   * middle) where it is on screen. A zoom keeps that spot exactly (the lane gets
   * room to scroll for it); a fit (`fit`) stays within the song, so a song that
   * fits shows from its start.
   */
  const zoomTo = useCallback(
    (next: number, screenX: number | null = null, fit = false) => {
      const L = live.current.layout;
      if (!L.blocks.length) return;
      if (next === L.pxPerBar) {
        setScale(next);
        return;
      }
      const sx = screenX ?? live.current.viewport / 2;
      const scroll = g.scroll;
      pendingZoom.current = { from: g.positions(), anchor: anchorAt(L, scroll + sx), screenX: sx, scroll, fit };
      pauseFollow();
      setScale(next);
    },
    [g, pauseFollow],
  );

  // Lock the scale once the lane has measured a song; a new song (another project, or an empty lane filled again) fits afresh.
  const prevOrder = useRef(order);
  useLayoutEffect(() => {
    const before = prevOrder.current;
    prevOrder.current = order;
    if (!order.length) {
      if (scale !== null) setScale(null);
      return;
    }
    if (scale !== null && before.length && !order.some((id) => before.includes(id))) {
      setScale(null);
      return;
    }
    if (scale === null && measured) setScale(fit);
  }, [order, scale, measured, fit]);

  // A window resize fits the song again (gliding there, the bar at the left edge staying put).
  const prevAvail = useRef(avail);
  useLayoutEffect(() => {
    const before = prevAvail.current;
    prevAvail.current = avail;
    if (!before || before === avail || scale === null || g.dragging) return;
    if (fit !== scale) zoomTo(fit, 0, true);
  }, [avail, fit, scale, zoomTo, g]);

  // Place blocks after every render (or keep the live preview of a gesture), finish a zoom, then restore focus if an edit moved it.
  useLayoutEffect(() => {
    const z = pendingZoom.current;
    pendingZoom.current = null;
    const ax = z?.anchor ? anchorX(layout, z.anchor) : null;
    const left = !z || ax === null ? 0 : z.fit ? scrollToShow(ax, z.screenX, size.width, total) : Math.max(0, ax - z.screenX);
    g.sync(!z, z ? left + size.width : 0);
    const scroller = scrollerRef.current;
    if (z && scroller) {
      ownScroll.current = left;
      scroller.scrollLeft = left;
      g.onScroll(left);
      g.animateZoom(new Map([...z.from].map(([id, r]) => [id, { x: r.x - z.scroll + left, w: r.w }])));
      const lane = laneRef.current;
      if (lane && !prefersReducedMotion()) {
        lane.dataset.zooming = '';
        window.clearTimeout(zoomTimer.current);
        zoomTimer.current = window.setTimeout(() => delete lane.dataset.zooming, ZOOM_MS);
      }
    }
    const id = pendingFocus.current;
    if (id === EMPTY_FOCUS) {
      pendingFocus.current = null;
      addAllRef.current?.focus({ preventScroll: true });
    } else if (id) {
      const el = blockEls.current.get(id);
      if (el || measured) {
        pendingFocus.current = null;
        // The lane brings the block into view from where it will be (not where a slide shows it now).
        // Focusing forces style and layout: not when the block has focus already.
        if (el && document.activeElement !== el) el.focus({ preventScroll: true });
        revealBlock(id);
      }
    }
  });
  /** Scroll the lane (at once) so block `id` is in view at its place in the layout. */
  function revealBlock(id: Id) {
    const scroller = scrollerRef.current;
    const lb = live.current.layout.blocks.find((b) => b.id === id);
    if (!scroller || !lb) return;
    const view = live.current.viewport;
    const left = g.scroll;
    let to: number | null = null;
    if (lb.x < left) to = Math.max(0, lb.x - 24);
    else if (lb.x + lb.width > left + view) to = lb.width + 48 > view ? lb.x - 24 : lb.x + lb.width + 24 - view;
    if (to === null) return;
    to = Math.max(0, Math.min(Math.max(0, live.current.total - view), to));
    if (Math.abs(to - left) < 1) return;
    followAnim.current = null;
    ownScroll.current = to;
    scroller.scrollLeft = to;
    g.onScroll(to);
    pauseFollow();
  }
  // Someone else changed the song mid-gesture (undo, another view): drop the gesture, commit nothing.
  // Any edit also pauses following the playhead for a while.
  const firstViews = useRef(true);
  useEffect(() => {
    g.externalChange();
    if (firstViews.current) firstViews.current = false;
    else pauseFollow();
  }, [views, g, pauseFollow]);
  useEffect(
    () => () => {
      g.dispose();
      window.clearTimeout(zoomTimer.current);
    },
    [g],
  );

  /* ---- Undo and Redo keep the lane's focus and selection ---- */
  /** Per undo step: what was selected and focused before it (and, once undone, after it). */
  const steps = useRef(new Map<number, { before: LaneSnap; after: LaneSnap | null }>());
  /** After an Undo or Redo: the selection the step had (when known); keyboard focus that was in the lane stays there. */
  const restoreAfterHistory = (snap: LaneSnap | null) => {
    const now = session.store.getState().arrangement.blocks.map((b) => b.id);
    if (snap) setSelectionState({ ...pruneSelection(snap.sel, now), byUser: snap.sel.byUser });
    const lane = laneRef.current;
    if (!lane || !lane.contains(document.activeElement)) return;
    if (!now.length) {
      pendingFocus.current = EMPTY_FOCUS;
      return;
    }
    const was = live.current.activeId;
    const before = live.current.order;
    let target: Id | null = snap?.focus && now.includes(snap.focus) ? snap.focus : was && now.includes(was) ? was : null;
    if (!target) {
      // The nearest block that is still there.
      const i = was ? before.indexOf(was) : -1;
      for (let d = 1; !target && i >= 0 && d <= before.length; d++) target = [before[i + d], before[i - d]].find((x) => x !== undefined && now.includes(x)) ?? null;
      target ??= now[Math.min(Math.max(0, i), now.length - 1)];
    }
    // Focus on a part cell of the block to focus stays where it is.
    if (target === was && blockEls.current.get(was)?.contains(document.activeElement)) return;
    setActiveId(target);
    pendingFocus.current = target;
  };
  useEffect(() => {
    const info = session.store.info;
    let last = info.getState();
    let newest = last.undoId ?? 0;
    // The focused block counts only when keyboard focus is in the lane (or in a menu it opened): the lane's
    // tab stop alone is not the user's place.
    const snapNow = (): LaneSnap => {
      const inLane = !!laneRef.current?.contains(document.activeElement) || live.current.busy;
      return { sel: { ids: live.current.selection.ids, anchor: live.current.selection.anchor, byUser: live.current.byUser }, focus: inLane ? live.current.activeId : null };
    };
    return info.subscribe((now) => {
      const prev = last;
      last = now;
      const undone = prev.undoId !== null && now.redoId === prev.undoId ? prev.undoId : null;
      const redone = prev.redoId !== null && now.undoId === prev.redoId ? prev.redoId : null;
      if (undone === null && redone === null) {
        // A new step (ids only grow): remember what the lane showed before it.
        if (now.undoId !== null && now.undoId > newest) {
          newest = now.undoId;
          steps.current.set(now.undoId, { before: snapNow(), after: null });
          if (steps.current.size > 300) steps.current.delete(steps.current.keys().next().value!);
        }
        return;
      }
      const rec = steps.current.get((undone ?? redone)!);
      if (undone !== null) {
        if (rec) rec.after = snapNow();
        restoreAfterHistory(rec?.before ?? null);
      } else restoreAfterHistory(rec?.after ?? null);
    });
    // restoreAfterHistory reads refs and state setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A finger lets the browser scroll the lane (blocks and cards allow panning) until a hold lifts
  // something or it takes an edge: from then on its moves must not pan (only a non-passive touchmove
  // listener can stop that once the touch has started).
  useEffect(() => {
    const els = [laneRef.current, paletteRef.current].filter((x): x is HTMLDivElement => !!x);
    const onTouchMove = (e: TouchEvent) => {
      if (g.ownsTouch && e.cancelable) e.preventDefault();
    };
    for (const el of els) el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      for (const el of els) el.removeEventListener('touchmove', onTouchMove);
    };
  }, [g]);

  /* ---- actions ---- */
  const viewOf = (id: Id | undefined) => (id ? live.current.views.find((v) => v.id === id) : undefined);

  const removeAndFocus = useCallback(
    (ids: Id[]) => {
      const list = live.current.order;
      const gone = new Set(ids);
      const lastIdx = Math.max(...ids.map((id) => list.indexOf(id)));
      const firstIdx = Math.min(...ids.map((id) => list.indexOf(id)));
      const neighbour = list.slice(lastIdx + 1).find((id) => !gone.has(id)) ?? [...list.slice(0, firstIdx)].reverse().find((id) => !gone.has(id));
      const text = act.removeBlocks(ids);
      if (!text) return;
      announce(text);
      setSelection(neighbour ? { ids: [neighbour], anchor: neighbour } : EMPTY_SELECTION);
      if (neighbour) focusBlock(neighbour);
      else pendingFocus.current = EMPTY_FOCUS;
    },
    [announce, focusBlock],
  );

  const moveBy = useCallback(
    (ids: Id[], dir: -1 | 1) => {
      const gap = nudgeGap(live.current.order, ids, dir);
      if (gap === null) return;
      const text = act.moveBlocks(ids, gap);
      if (!text) return;
      announce(text);
      const focus = live.current.activeId && ids.includes(live.current.activeId) ? live.current.activeId : ids[0];
      setSelection({ ids, anchor: ids[0] });
      focusBlock(focus);
    },
    [announce, focusBlock],
  );

  const duplicate = useCallback(
    (ids: Id[]) => {
      const r = act.duplicateBlocks(ids);
      if (!r) return;
      announce(r.text);
      setSelection({ ids: r.ids, anchor: r.ids[0] });
      focusBlock(r.ids[0]);
    },
    [announce, focusBlock],
  );

  /**
   * A Cut leaves focus on the block after the gap it made: while nothing else
   * changed (the song, the selection, the focused block), Paste puts the
   * blocks back in that gap.
   */
  const cutFocus = useRef<Id | null>(null);
  const paste = useCallback(
    (focus: Id | null) => {
      const { order: list, selection: sel, activeId } = live.current;
      const back = act.cutOrigin();
      const gap = back !== null && !sel.ids.length && activeId === cutFocus.current ? back : pasteGap(list, sel, focus);
      const r = act.pasteBlocks(gap);
      if (!r) return;
      announce(r.text);
      setSelection({ ids: r.ids, anchor: r.ids[0] });
      focusBlock(r.ids[0]);
    },
    [announce, focusBlock, setSelection],
  );

  // Quick + / − presses on the same blocks are one undo step (one that ends where it started leaves none).
  const lengthGesture = useRef<{ key: string; id: string; at: number } | null>(null);
  const lengthen = useCallback(
    (ids: Id[], delta: 1 | -1) => {
      const now = performance.now();
      const key = ids.join('\u0000');
      const prev = lengthGesture.current;
      const gesture = prev && prev.key === key && now - prev.at < LENGTH_GESTURE_MS ? prev.id : act.newGesture('repeats');
      lengthGesture.current = { key, id: gesture, at: now };
      announce(act.setRepeats(ids, (r) => r + delta, gesture, true));
    },
    [announce],
  );

  /* ---- loop (playback state: the session repeats the looped blocks) ---- */
  const applyLoop = useCallback(
    (span: LoopSpan | null) => {
      const range = span ? loopRange(live.current.order, span) : null;
      session.setSongLoop(range);
      announce(loopStatus(live.current.names, range ? span : null));
    },
    [announce],
  );
  /** The Loop button: on for what it names (the user's selection, else the playing block, else the first); on that already: off; elsewhere: the loop moves there. */
  const pressLoop = useCallback(() => {
    const { loop: now, order: list, userSelected: sel, currentId: playing } = live.current;
    applyLoop(loopButtonPress(now, loopButtonTarget(list, sel, playing, now)));
  }, [applyLoop]);

  const openMenu = useCallback((id: Id, anchor: MenuAnchor) => {
    setActiveId(id);
    setPicker(null);
    setMenu((m) => (m && m.blockId === id ? null : { blockId: id, anchor, returnFocus: blockEls.current.get(id) ?? null }));
  }, []);

  const openPicker = useCallback((id: Id, trackId: Id, anchor: MenuAnchor, returnFocus: HTMLElement | null) => {
    setActiveId(id);
    setMenu(null);
    // Its trigger pressed again closes it.
    setPicker((p) => (p && p.blockId === id && p.trackId === trackId ? null : { blockId: id, trackId, anchor, returnFocus }));
  }, []);

  const setPart = useCallback(
    (id: Id, trackId: Id, choice: Id | null | undefined, gesture?: string) => {
      announce(act.setPart(id, trackId, choice, gesture));
    },
    [announce],
  );

  // Quick clicks on the same cell (off, on, off…) are one undo step.
  const cellGesture = useRef<{ key: string; id: string; at: number } | null>(null);
  const togglePart = useCallback(
    (id: Id, trackId: Id, trigger?: HTMLElement | null) => {
      const v = viewOf(id);
      const c = v?.cells.find((x) => x.trackId === trackId);
      if (!v || !c) return;
      const t = cellToggle(c);
      if (t === 'picker') {
        const el = trigger ?? document.querySelector<HTMLElement>(cellSelector(id, trackId));
        openPicker(id, trackId, anchorFromElement(el ?? blockEls.current.get(id)), el ?? blockEls.current.get(id) ?? null);
        return;
      }
      const now = performance.now();
      const key = `${id}\u0000${trackId}`;
      const prev = cellGesture.current;
      const gesture = prev && prev.key === key && now - prev.at < CELL_GESTURE_MS ? prev.id : act.newGesture('cell');
      cellGesture.current = { key, id: gesture, at: now };
      setPart(id, trackId, t.choice, gesture);
    },
    // viewOf reads live refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openPicker, setPart],
  );

  const menuActions: BlockMenuActions = useMemo(
    () => ({
      play: (id) => {
        const i = live.current.order.indexOf(id);
        if (i >= 0) void startSong(i);
      },
      editClips: (id) => {
        const v = viewOf(id);
        if (v && v.row >= 0) editClips(v.row);
      },
      rename: (id) => {
        if (act.songLocked()) refuseLocked();
        else setRenaming(id);
      },
      togglePart: (id, trackId) => togglePart(id, trackId, blockEls.current.get(id)),
      resetParts: (id) => announce(act.resetParts(id)),
      changeScene: (id, sceneId) => announce(act.changeScene(id, sceneId)),
      layerScene: (id, sceneId, mode) => announce(act.layerScene(id, sceneId, mode)),
      lengthen,
      splitHalf: (id) => {
        const v = viewOf(id);
        if (!v) return;
        const r = act.splitBlock(id, Math.floor(v.repeats / 2));
        if (r) {
          announce(r.text);
          focusBlock(id);
        }
      },
      join: (id) => {
        announce(act.joinWithNext(id));
        focusBlock(id);
      },
      duplicate,
      copy: (ids) => announce(act.copyBlocks(ids)),
      cut: (ids) => {
        const list = live.current.order;
        const neighbour = list.slice(list.indexOf(ids[ids.length - 1]) + 1).find((x) => !ids.includes(x)) ?? list.find((x) => !ids.includes(x));
        const text = act.cutBlocks(ids);
        if (!text) return;
        announce(text);
        setSelection(EMPTY_SELECTION);
        cutFocus.current = neighbour ?? null;
        if (neighbour) focusBlock(neighbour);
        else pendingFocus.current = EMPTY_FOCUS;
      },
      paste: () => paste(live.current.activeId),
      move: moveBy,
      remove: removeAndFocus,
      loop: (ids) => applyLoop(loopTarget(live.current.order, ids, null)),
      stopLoop: () => applyLoop(null),
      shape: (id, kind: ShapeKind) => {
        // (A looped block a helper splits stays looped as a whole: the session extends the loop.)
        const r = act.shapeBlock(id, kind);
        if (!r) return;
        announce(r.text);
        // The blocks it made, selected: what changed is in their part cells.
        setSelection({ ids: r.ids, anchor: r.ids[0] });
        focusBlock(id);
      },
    }),
    // viewOf reads live refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [announce, applyLoop, duplicate, editClips, focusBlock, lengthen, moveBy, paste, refuseLocked, removeAndFocus, setSelection, togglePart],
  );

  /* ---- keyboard ---- */
  const onBlockKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>, id: Id) => {
      const mod = e.ctrlKey || e.metaKey;
      // Keys for the block itself; from a part cell only the Ctrl/Cmd shortcuts (copy, paste, duplicate…) count.
      const fromCell = e.target !== e.currentTarget && !!(e.target as Element).closest('[data-cell]');
      if (e.target !== e.currentTarget && !(fromCell && mod && !e.altKey)) return;
      const { order: list, selection: sel } = live.current;
      const key = e.key;
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (isMenuKey(e) || ((key === 'Enter' || key === '.') && !mod && !e.altKey)) {
        handled();
        const trigger = e.currentTarget.querySelector<HTMLElement>('[aria-haspopup="menu"]');
        noteKeyboardMenu(e.currentTarget);
        openMenu(id, anchorFromElement(trigger ?? e.currentTarget));
        return;
      }
      if (key === 'F2' && !mod) {
        handled();
        if (viewOf(id)?.missing) return;
        if (act.songLocked()) refuseLocked();
        else setRenaming(id);
        return;
      }
      if (e.altKey && !mod && (key === 'ArrowLeft' || key === 'ArrowRight')) {
        handled();
        moveBy(menuTargets(sel, list, id), key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (!mod && !e.altKey && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End')) {
        handled();
        const move = key === 'ArrowLeft' ? 'prev' : key === 'ArrowRight' ? 'next' : key === 'Home' ? 'first' : 'last';
        const r = selectByKey(sel, list, id, move, e.shiftKey);
        setSelection(r.selection, true);
        focusBlock(r.focus);
        return;
      }
      if (key === 'ArrowDown' && !mod && !e.altKey) {
        handled();
        const first = viewOf(id)?.cells[0];
        if (first) document.querySelector<HTMLElement>(cellSelector(id, first.trackId))?.focus();
        return;
      }
      if (mod && !e.altKey) {
        const k = key.toLowerCase();
        if (k === 'a') {
          handled();
          setSelection(selectAll(list), true);
          announce(`All ${list.length} blocks selected.`);
          return;
        }
        if (k === 'd' || k === 'c' || k === 'x') {
          handled();
          const ids = menuTargets(sel, list, id);
          if (k === 'd') duplicate(ids);
          else if (k === 'c') announce(act.copyBlocks(ids));
          else menuActions.cut(ids);
          return;
        }
        if (k === 'v') {
          handled();
          paste(id);
          return;
        }
        return;
      }
      if ((key === 'Delete' || key === 'Backspace') && !e.altKey) {
        handled();
        removeAndFocus(menuTargets(sel, list, id));
        return;
      }
      if ((key === '+' || key === '=' || key === '-' || key === '_') && !e.altKey) {
        handled();
        lengthen(menuTargets(sel, list, id), key === '+' || key === '=' ? 1 : -1);
        return;
      }
      if (key === 'Escape' && sel.ids.length) {
        handled();
        setSelection(EMPTY_SELECTION, true);
        announce('Selection cleared.');
      }
    },
    // viewOf reads live refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [announce, duplicate, focusBlock, lengthen, menuActions, moveBy, openMenu, paste, refuseLocked, removeAndFocus, setSelection],
  );

  const onCellKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, id: Id, trackId: Id) => {
      const { order: list, views: vs } = live.current;
      const v = vs.find((x) => x.id === id);
      if (!v) return;
      const row = v.cells.findIndex((c) => c.trackId === trackId);
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isMenuKey(e) || e.key === '.') {
        handled();
        noteKeyboardMenu(e.currentTarget);
        openPicker(id, trackId, anchorFromElement(e.currentTarget), e.currentTarget);
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        handled();
        const next = row + (e.key === 'ArrowUp' ? -1 : 1);
        if (next < 0) blockEls.current.get(id)?.focus();
        else if (next < v.cells.length) document.querySelector<HTMLElement>(cellSelector(id, v.cells[next].trackId))?.focus();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        handled();
        const i = list.indexOf(id) + (e.key === 'ArrowLeft' ? -1 : 1);
        const other = list[i];
        if (!other) return;
        setActiveId(other);
        setSelection({ ids: [other], anchor: other }, true);
        const cell = document.querySelector<HTMLElement>(cellSelector(other, trackId));
        (cell ?? blockEls.current.get(other))?.focus();
        return;
      }
      if (e.key === 'Escape') {
        handled();
        blockEls.current.get(id)?.focus();
      }
    },
    [openPicker],
  );

  /* ---- pointer ---- */
  const onBlockClick = useCallback(
    (e: ReactMouseEvent<HTMLElement>, id: Id) => {
      if (g.consumeClick()) {
        e.preventDefault();
        return;
      }
      const t = e.target as Element;
      if (t.closest('button, input')) return;
      const { order: list, selection: sel } = live.current;
      setSelection(selectByClick(sel, list, id, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey }), true);
      setActiveId(id);
    },
    [g, setSelection],
  );

  const onCellClick = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>, id: Id, trackId: Id) => {
      e.stopPropagation();
      if (g.consumeClick()) {
        e.preventDefault();
        return;
      }
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        // A modified click selects blocks, as on the header.
        e.preventDefault();
        const { order: list, selection: sel } = live.current;
        setSelection(selectByClick(sel, list, id, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey }), true);
        setActiveId(id);
        return;
      }
      hideCellTip();
      togglePart(id, trackId, e.currentTarget);
    },
    // hideCellTip only touches refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [g, setSelection, togglePart],
  );

  const handlers: BlockHandlers = useMemo(
    () => ({
      register: (id, el) => {
        if (el) blockEls.current.set(id, el);
        else if (blockEls.current.get(id)?.isConnected === false) blockEls.current.delete(id);
      },
      onPointerDown: (e, id) => {
        hideCellTip();
        const el = blockEls.current.get(id);
        if (!el) return;
        // A finger or pen on the seam takes the right edge of the block on its left (that handle
        // reaches over this block, which is drawn above it), as a pointer that hovers it first would.
        if (e.pointerType !== 'mouse' && !(e.target as Element).closest(`.${styles.bhead}`)) {
          const prev = live.current.order[live.current.order.indexOf(id) - 1];
          const edge = prev ? blockEls.current.get(prev)?.querySelector<HTMLElement>('[data-edge]') : null;
          if (edge && e.clientX - el.getBoundingClientRect().left < SEAM_SLOP_PX) {
            g.pressEdge(e.nativeEvent, prev, edge);
            return;
          }
        }
        g.pressBlock(e.nativeEvent, id, el);
      },
      onEdgePointerDown: (e, id) => g.pressEdge(e.nativeEvent, id, e.currentTarget),
      onClick: onBlockClick,
      onKeyDown: onBlockKeyDown,
      onContextMenu: (e, id) => {
        e.preventDefault();
        if (isEchoOfKeyboardMenu(e.target)) return;
        const cell = (e.target as Element).closest<HTMLElement>('[data-cell]');
        if (cell?.dataset.track) {
          openPicker(id, cell.dataset.track, anchorFromContextEvent(e, cell), cell);
          return;
        }
        openMenu(id, anchorFromContextEvent(e, blockEls.current.get(id) ?? null));
      },
      onFocus: (id) => setActiveId(id),
      onCellClick,
      onCellKeyDown,
      onPicker: (trigger, id, trackId) => openPicker(id, trackId, anchorFromElement(trigger), document.querySelector<HTMLElement>(cellSelector(id, trackId))),
      onPlay: (id) => {
        const i = live.current.order.indexOf(id);
        if (i >= 0) void startSong(i);
      },
      onMenu: (trigger, id) => openMenu(id, anchorFromElement(trigger)),
      onSplit: (id, afterPass) => {
        const r = act.splitBlock(id, afterPass);
        if (r) announce(r.text);
      },
      onRename: (id, label) => {
        setRenaming(null);
        if (label !== null) announce(act.renameBlock(id, label));
        focusBlock(id);
      },
      onStartRename: (id) => {
        if (act.songLocked()) refuseLocked();
        else setRenaming(id);
      },
    }),
    // hideCellTip only touches refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [announce, focusBlock, g, onBlockClick, onBlockKeyDown, onCellClick, onCellKeyDown, openMenu, openPicker, refuseLocked],
  );

  // Clicking empty lane clears the selection.
  const onLanePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = e.target as Element;
    if (t === trackRef.current || t === contentRef.current || t === scrollerRef.current) {
      if (live.current.selection.ids.length) setSelection(EMPTY_SELECTION, true);
    }
  };

  /* ---- what a click on a part cell does (one shared hover bubble) ---- */
  const [cellTipState, setCellTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const tipCell = useRef<HTMLElement | null>(null);
  const tipTimer = useRef(0);
  function hideCellTip() {
    window.clearTimeout(tipTimer.current);
    tipTimer.current = 0;
    tipCell.current = null;
    setCellTip((s) => (s ? null : s));
  }
  const onTrackPointerOver = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' || g.dragging || e.buttons) return;
    const cell = (e.target as Element).closest<HTMLElement>('[data-cell]');
    if (!cell) return;
    if (cell === tipCell.current) return;
    hideCellTip();
    if (!tips.enabled || locked) return;
    tipCell.current = cell;
    tipTimer.current = window.setTimeout(() => {
      tipTimer.current = 0;
      const v = viewOf(cell.closest<HTMLElement>('[data-block-id]')?.dataset.blockId);
      const c = v?.cells.find((x) => x.trackId === cell.dataset.track);
      if (!v || !c || !cell.isConnected || g.dragging || tipCell.current !== cell) return;
      const r = cell.getBoundingClientRect();
      // A compact block (an overview step) hides clip names: its cells' tips say what they play.
      const compact = (blockEls.current.get(v.id)?.offsetWidth ?? 999) < COMPACT_HEADER_BELOW;
      setCellTip({ text: cellTip(v, c, compact), x: r.left + r.width / 2, y: r.top });
    }, TOOLTIP_DELAY_MS);
  };
  const onTrackPointerOut = (e: ReactPointerEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to && tipCell.current?.contains(to)) return;
    if (tipCell.current) hideCellTip();
  };
  useEffect(() => () => window.clearTimeout(tipTimer.current), []);

  /* ---- scrolling, playhead ---- */
  const [edges, setEdges] = useState({ left: false, right: false });
  // From what is tracked (no layout read); not while something is carried (the preview widens the lane).
  const updateEdges = useCallback(() => {
    if (g.dragging) return;
    const { viewport, total: width } = live.current;
    const left = g.scroll > 2;
    const right = g.scroll + viewport < width - 2;
    setEdges((x) => (x.left === left && x.right === right ? x : { left, right }));
  }, [g]);
  useEffect(updateEdges, [layout, size.width, dragUi, updateEdges]);
  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    // The echo of a drag's own auto-scroll: already applied, and reading the position now would force a layout.
    if (g.scrolling) {
      pauseFollow();
      return;
    }
    const left = el.scrollLeft;
    const own = ownScroll.current !== null && Math.abs(left - ownScroll.current) <= 1.5;
    ownScroll.current = null;
    if (!own) pauseFollow();
    if (cellTipState || tipCell.current) hideCellTip();
    g.onScroll(left);
    updateEdges();
  };
  /** Scroll the lane to `to` (smoothly unless motion is reduced), as the lane's own scroll: it does not pause following. */
  const glideRaf = useRef(0);
  const glideScroll = useCallback(
    (to: number) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      if (prefersReducedMotion()) {
        followAnim.current = null;
        ownScroll.current = to;
        scroller.scrollLeft = to;
        return;
      }
      followAnim.current = { from: g.scroll, to, t0: performance.now() };
      if (glideRaf.current) return;
      const step = (now: number) => {
        glideRaf.current = 0;
        const fa = followAnim.current;
        const el = scrollerRef.current;
        if (!fa || !el) return;
        if (g.dragging) {
          followAnim.current = null;
          return;
        }
        const k = Math.min(1, Math.max(0, (now - fa.t0) / FOLLOW_SCROLL_MS));
        const v = fa.from + (fa.to - fa.from) * easeOut(k);
        ownScroll.current = v;
        el.scrollLeft = v;
        if (k >= 1) {
          followAnim.current = null;
          return;
        }
        glideRaf.current = requestAnimationFrame(step);
      };
      glideRaf.current = requestAnimationFrame(step);
    },
    [g],
  );
  useEffect(() => () => cancelAnimationFrame(glideRaf.current), []);

  // Ctrl (or ⌘) + wheel over the lane zooms around the pointer; a plain wheel only ever scrolls.
  const wheelAcc = useRef(0);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      // Never the page zoom over the lane; no lane zoom while something is carried.
      e.preventDefault();
      if (g.dragging) return;
      wheelAcc.current += e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
      if (Math.abs(wheelAcc.current) < WHEEL_STEP) return;
      const dir = wheelAcc.current < 0 ? 1 : -1;
      wheelAcc.current = 0;
      const next = zoomStep(live.current.layout.pxPerBar, dir);
      if (next === null) return;
      zoomTo(next, e.clientX - el.getBoundingClientRect().left);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [g, zoomTo]);

  const playheadRef = useRef<HTMLDivElement>(null);
  type Head = { layout: SongLayout | null; layoutAt: number; target: number | null; shown: number | null; glide: { off: number; t0: number } | null };
  const head = useRef<Head>({ layout: null, layoutAt: 0, target: null, shown: null, glide: null });
  /** When the project last changed (an edit, undo or redo): playback re-plans in that task, before the lane re-renders. */
  const editAt = useRef(-Infinity);
  useEffect(
    () =>
      session.store.subscribe(() => {
        editAt.current = performance.now();
      }),
    [],
  );
  // A song that starts again starts its playhead where it plays (only edits make it glide).
  useEffect(() => {
    if (!songActive) head.current = { layout: null, layoutAt: 0, target: null, shown: null, glide: null };
  }, [songActive]);
  useRafLoop((_dt, now) => {
    const scroller = scrollerRef.current;
    const el = playheadRef.current;
    const t = session.transport;
    if (!el || !t || !getSongPlan()) return;
    const bar = songTimelineBar(t.getPosition().tick);
    const st = head.current;
    if (bar === null) {
      el.style.opacity = '0';
      st.shown = null;
      return;
    }
    const L = live.current.layout;
    const target = barToX(L, bar);
    // Blocks before the playhead moved: it glides to its new place instead of jumping. Playback re-plans in the
    // edit's own task, so the playhead's bar can change a frame before the lane draws the new layout (or after
    // it): any jump of its place soon after an edit or a new layout glides (a jump without one, a seek, does not).
    if (st.layout && st.layout !== L) st.layoutAt = now;
    st.layout = L;
    const jumped = st.target !== null && Math.abs(target - st.target) > 2;
    st.target = target;
    const edited = now - st.layoutAt < PLAYHEAD_REPLAN_WINDOW_MS || performance.now() - editAt.current < PLAYHEAD_REPLAN_WINDOW_MS;
    if (jumped && edited && st.shown !== null && Math.abs(st.shown - target) > 2 && !prefersReducedMotion()) st.glide = { off: st.shown - target, t0: now };
    let x = target;
    if (st.glide) {
      const k = (now - st.glide.t0) / PLAYHEAD_GLIDE_MS;
      if (k >= 1) st.glide = null;
      else x = target + st.glide.off * (1 - easeOut(k));
    }
    st.shown = x;
    el.style.opacity = '1';
    el.style.transform = translate(x);
    // Keep the playhead in view while the song plays, unless following is off, something is carried, a menu is open, the
    // pointer moves over the lane (or rested there only a moment ago), or the user scrolled, edited or used the keys lately.
    if (!live.current.follow || !live.current.songPlaying || !scroller || g.dragging || followAnim.current || live.current.busy || now < followPausedUntil.current) return;
    const over = pointerOver.current;
    if (over.inside && performance.now() - over.at < FOLLOW_POINTER_REST_MS) return;
    if (performance.now() - keyAt.current < FOLLOW_KEY_REST_MS && laneRef.current?.contains(document.activeElement)) return;
    const to = followScroll(target, g.scroll, live.current.viewport, live.current.total);
    if (to !== null) glideScroll(to);
  }, songActive);

  const setFollow = (on: boolean) => {
    setFollowState(on);
    writeFollow(on);
    // Turned on: catch up with the playhead now.
    if (on) followPausedUntil.current = 0;
    else followAnim.current = null;
    announce(on ? 'The lane follows the playhead while the song plays.' : 'The lane stays where you put it while the song plays.');
  };

  /* ---- ruler ---- */
  const playFromBar = useCallback(
    (bar: number) => {
      const b = live.current.layout.blocks.find((x) => x.totalBars > 0 && bar >= x.startBar && bar < x.startBar + x.totalBars);
      if (!b) return;
      void startSong(b.index, { fromBar: bar });
      followPausedUntil.current = 0;
      announce(`Playing the song from bar ${bar + 1}.`);
    },
    [announce],
  );

  /* ---- palette ---- */
  const addAtEnd = useCallback(
    (s: SceneSummary) => {
      const r = act.addScene(s.id);
      if (!r) return;
      setSelection({ ids: [r.id], anchor: r.id });
      setActiveId(r.id);
      pendingReveal.current = r.id;
      announce(r.text);
    },
    [announce],
  );
  const pressCard = useCallback((e: ReactPointerEvent<HTMLElement>, sceneId: Id) => g.pressCard(e.nativeEvent, sceneId, e.currentTarget), [g]);
  const joinBlock = useCallback(
    (id: Id) => {
      announce(act.joinWithNext(id));
      focusBlock(id);
    },
    [announce, focusBlock],
  );
  const addAll = () => {
    let first: Id | null = null;
    const gesture = act.newGesture('add-all');
    for (const s of scenes) {
      const r = act.addScene(s.id, undefined, gesture);
      if (!r) break;
      first ??= r.id;
    }
    session.store.endGesture();
    if (!first) return;
    notify(`Added ${scenes.map((s) => s.name).join(', ')} in order. Drag blocks, their edges or their parts to shape the song.`, 'info', 'undo');
    focusBlock(first);
  };
  // A block added at the end of a song that scrolls is brought into view (focus stays on the + button).
  const pendingReveal = useRef<Id | null>(null);
  useLayoutEffect(() => {
    const id = pendingReveal.current;
    const scroller = scrollerRef.current;
    if (!id || !scroller || !measured) return;
    pendingReveal.current = null;
    const lb = layout.blocks.find((b) => b.id === id);
    if (!lb) return;
    if (lb.x < g.scroll || lb.x + lb.width > g.scroll + size.width) glideScroll(scrollToShow(lb.x + lb.width + 24, size.width, size.width, total));
  });

  /* ---- render ---- */
  const empty = views.length === 0;
  const moving = dragUi?.kind === 'move' ? dragUi : null;
  const card = dragUi?.kind === 'card' ? dragUi : null;
  const layerTarget = card?.layerInto ?? null;
  const layerInfo = useProject((p) => {
    if (!card || !layerTarget) return null;
    const b = p.arrangement.blocks.find((x) => x.id === layerTarget);
    return b ? layerPreview(p, b, card.sceneId, card.replace ? 'replace' : 'fill') : null;
  }, samePreview);
  const menuBlock = menu ? views.find((v) => v.id === menu.blockId) : undefined;
  const pickerBlock = picker ? views.find((v) => v.id === picker.blockId) : undefined;
  const hiddenIds = moving && !moving.copy ? new Set(moving.ids) : null;

  // Seams where the two neighbours could be joined into one block.
  const joins = useProject(selectJoins, sameIds);

  const zoomIn = zoomStep(ppb, 1);
  const zoomOut = zoomStep(ppb, -1);
  const fitTarget = fitted.pxPerBar;
  const fitSongNow = () => {
    zoomTo(fitTarget, 0, true);
    if (!fitted.fits) {
      const text = 'The song is too long to show whole: the lane shows as much as it can. Scroll it to see the rest.';
      notify(text);
      announce(text);
    }
  };
  const fitTip =
    ppb === fitTarget
      ? fitted.fits
        ? 'The whole song is in view at the size that fits the lane.'
        : 'The song is as small as it goes and still longer than the lane: scroll to see the rest.'
      : fitted.fits
        ? 'Show the whole song at the size that fits the lane.'
        : 'Show as much of the song as fits (it is too long to show whole); scroll for the rest.';
  // The Loop button (in the song header): what it acts on, by name.
  const loopTargetSpan = loopButtonTarget(order, userSelected, currentId, loop);
  const loopText = loopButtonText(names, loop, loopTargetSpan);
  const zoomAnchor = (): number | null => {
    // The playhead when it is in view, else the middle of the view.
    const x = head.current.shown;
    if (songActive && x !== null && x >= g.scroll && x <= g.scroll + size.width) return x - g.scroll;
    return null;
  };

  return (
    <>
      <div
        ref={laneRef}
        className={styles.lane}
        data-testid="song-lane"
        data-carry={dragUi?.kind}
        data-copy={moving?.copy || undefined}
        data-outside={(moving?.outside ?? card?.outside) || undefined}
        data-advanced={advanced || undefined}
        data-locked={locked || undefined}
        style={{ ['--rows' as string]: views[0]?.cells.length || 8 }}
        onPointerMove={(e) => {
          // A finger never rests over the lane: only a mouse or pen holds the page still.
          if (e.pointerType !== 'touch') pointerOver.current = { inside: true, at: performance.now() };
        }}
        onPointerLeave={() => {
          pointerOver.current.inside = false;
        }}
        onKeyDownCapture={(e) => {
          // Space plays or pauses (the transport): the lane must then follow at once, not wait.
          if (e.key !== ' ' && e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') keyAt.current = performance.now();
        }}
      >
        <div className={styles.names} aria-hidden="true">
          <div className={styles.namesHead}>Parts</div>
          {(views[0]?.cells ?? []).length
            ? views[0].cells.map((c) => (
                <div key={c.trackId} className={styles.nameRow} title={c.partName} data-name-row="">
                  {c.partName}
                </div>
              ))
            : null}
        </div>
        <div
          ref={scrollerRef}
          className={styles.scroller}
          onScroll={onScroll}
          onPointerDown={onLanePointerDown}
          data-fade-left={edges.left || undefined}
          data-fade-right={edges.right || undefined}
        >
          <div ref={contentRef} className={styles.content}>
            {!empty && (
              <LaneRuler layout={layout} names={names} loop={loop} contentRef={contentRef} scrollerRef={scrollerRef} contentWidth={total} onPlayFromBar={playFromBar} onLoop={applyLoop} />
            )}
            <div
              ref={trackRef}
              className={styles.track}
              role={empty ? undefined : 'list'}
              aria-label={empty ? undefined : `Song: ${views.length} block${views.length === 1 ? '' : 's'} in play order`}
              onPointerOver={onTrackPointerOver}
              onPointerOut={onTrackPointerOut}
            >
              {empty ? (
                <div className={styles.empty} data-drop={(card && !card.outside) || undefined}>
                  <Icon name="plus" size={20} />
                  <div className={styles.emptyText}>
                    <strong>Your song is empty.</strong>
                    <span>Add scenes in the order they should play: press + on a scene below, or drag it here.</span>
                  </div>
                  <Button ref={addAllRef} size="sm" icon="plus" onClick={addAll} tip={`Adds every scene once, in row order, each playing ${timesText(DEFAULT_BLOCK_REPEATS)}.`}>
                    Add all {scenes.length} scenes
                  </Button>
                </div>
              ) : !measured ? null : (
                views.map((v) => (
                  <SongBlock
                    key={v.id}
                    block={v}
                    count={views.length}
                    current={v.id === currentId}
                    next={v.id === nextId}
                    selected={selection.ids.includes(v.id)}
                    tabbable={v.id === tabId}
                    hidden={!!hiddenIds?.has(v.id)}
                    resizing={dragUi?.kind === 'resize' && dragUi.id === v.id}
                    advanced={advanced}
                    renaming={renaming === v.id}
                    menuOpen={menu?.blockId === v.id}
                    pickerTrack={picker?.blockId === v.id ? picker.trackId : null}
                    layer={layerTarget === v.id ? layerInfo : null}
                    helpId={helpId}
                    h={handlers}
                  />
                ))
              )}
              <div ref={slotRef} className={styles.slot} aria-hidden="true" data-testid="lane-slot">
                {card && (
                  <span className={styles.slotText}>
                    <Icon name="plus" size={12} /> {scenes.find((s) => s.id === card.sceneId)?.name}
                  </span>
                )}
              </div>
              <div ref={bubbleRef} className={`${styles.bubble} mono`} aria-hidden="true" data-testid="lane-bubble" />
            </div>
            {!empty && <LaneSeams joins={joins} layout={layout} names={names} onJoin={joinBlock} />}
            {!empty && <div ref={playheadRef} className={styles.playhead} aria-hidden="true" data-on={songActive || undefined} data-testid="playhead" />}
          </div>
        </div>
        {/* The lifted copy of carried blocks floats over the lane (outside the scroller): while the lane
            scrolls under a still pointer, it does not move at all. */}
        <div className={styles.carry} aria-hidden="true">
          {moving && (
            <div ref={cloneRef} className={styles.clone} data-testid="lane-clone" data-copy={moving.copy || undefined} data-outside={moving.outside || undefined} data-held={moving.held || undefined}>
              {moving.ids.map((id, i) => {
                const v = views.find((x) => x.id === id);
                const lb = layout.blocks.find((b) => b.id === id);
                if (!v || !lb) return null;
                const left = moving.ids.slice(0, i).reduce((s, x) => s + (layout.blocks.find((b) => b.id === x)?.width ?? 0), 0);
                return (
                  <div key={id} className={styles.cloneItem} style={{ left }}>
                    <BlockFace block={v} width={lb.width} advanced={advanced} copy={moving.copy} />
                  </div>
                );
              })}
              <span ref={badgeRef} className={styles.badge} data-copy={moving.copy || undefined} data-testid="lane-badge">
                <Icon name={moving.copy ? 'copy' : 'drag'} size={11} />
                <span ref={labelRef} />
              </span>
            </div>
          )}
        </div>
        {locked && (
          <div className={styles.lockLine} data-testid="lane-lock">
            <span key={lockPulse} className={styles.lockText} data-pulse={lockPulse > 0 || undefined}>
              <Icon name="lock" size={12} /> {act.LOCKED_TEXT}
            </span>
          </div>
        )}
      </div>

      <div ref={paletteRef} className={styles.palette}>
        <span className={styles.paletteLabel}>SCENES</span>
        <SceneCards scenes={scenes} lifted={card?.sceneId ?? null} onPress={pressCard} onAdd={addAtEnd} />
        <p id={helpId} className={styles.hint}>
          <span className={styles.hintPointer}>
            Drag to move ({MOD_KEY.replace('+', '')} copies) · drag a right edge to play it more times · click a part to switch it · drag bar numbers to loop · Enter: all actions
          </span>
          <span className={styles.hintTouch}>Hold a block to pick it up, then drag · swipe to scroll · drag a right edge to play it more times · tap a part to switch it · drag bar numbers to loop</span>
        </p>
        <div className={styles.laneTools} role="group" aria-label="Song lane view">
          <Button
            size="sm"
            variant="ghost"
            pressed={follow}
            onClick={() => setFollow(!follow)}
            aria-label="Follow playhead"
            tip={follow ? 'While the song plays, the lane scrolls to keep the playhead in view.' : 'The lane stays where you put it while the song plays.'}
            detail="It waits a few seconds after you scroll or edit. Remembered in this browser."
          >
            Follow
          </Button>
          <IconButton size="sm" icon="minus" label="Zoom out" tip="Smaller blocks: more of the song in view." disabled={empty || zoomOut === null} onClick={() => zoomOut !== null && zoomTo(zoomOut, zoomAnchor())} />
          <IconButton size="sm" icon="plus" label="Zoom in" tip="Bigger blocks. Ctrl+wheel over the lane zooms too." disabled={empty || zoomIn === null} onClick={() => zoomIn !== null && zoomTo(zoomIn, zoomAnchor())} />
          <Button size="sm" variant="ghost" disabled={empty || ppb === fitTarget} onClick={fitSongNow} tip={fitTip}>
            Fit song
          </Button>
        </div>
      </div>

      {loopSlot &&
        createPortal(
          <Button
            className={styles.loopButton}
            pressed={!!loop}
            tone="teal"
            onClick={pressLoop}
            disabled={empty}
            aria-label={loopText.label}
            data-testid="loop-toggle"
            tip={loopText.tip}
            detail="Or drag across the bar numbers above the blocks; drag the ends of the Loop band to change it. Select blocks (click, Shift+click) to loop them instead."
          >
            <LaneIcon name="loop" size={16} />
            Loop
            {loopTargetSpan && <span className={styles.loopWhat}>{loopTargetName(names, loopTargetSpan)}</span>}
          </Button>,
          loopSlot,
        )}

      <div className="visually-hidden" role="status" aria-live="polite" data-testid="lane-status">
        <span key={status.n}>{status.text}</span>
      </div>
      <span id={`${helpId}-off`} hidden>
        Click switches this part off in this block.
      </span>
      <span id={`${helpId}-on`} hidden>
        Click switches this part back on in this block.
      </span>
      <span id={`${helpId}-pick`} hidden>
        Click chooses what this part plays in this block.
      </span>

      {cellTipState &&
        createPortal(
          <div
            className={styles.cellTip}
            role="presentation"
            aria-hidden="true"
            data-testid="cell-tip"
            style={{ left: Math.round(Math.max(140, Math.min(window.innerWidth - 140, cellTipState.x))), top: Math.round(cellTipState.y) }}
          >
            {cellTipState.text}
          </div>,
          document.body,
        )}

      {card &&
        createPortal(
          <div ref={ghostRef} className={styles.ghost} aria-hidden="true" data-testid="lane-ghost" data-drop={!card.outside || undefined} data-layer={!!layerTarget || undefined} data-replace={card.replace || undefined} data-held={card.held || undefined}>
            <span className={styles.ghostName}>
              {layerTarget ? <LaneIcon name="layers" size={12} /> : <Icon name="plus" size={12} />} {scenes.find((s) => s.id === card.sceneId)?.name}
            </span>
            <span ref={labelRef} className={styles.ghostMeta} />
            <span ref={ghostHintRef} className={styles.ghostHint} />
          </div>,
          document.body,
        )}

      {menu && menuBlock && (
        <BlockMenu
          key={menu.blockId}
          block={menuBlock}
          count={views.length}
          targets={menuTargets(selection, order, menuBlock.id)}
          canPaste={act.hasBlockClipboard()}
          scenes={scenes}
          anchor={menu.anchor}
          returnFocus={menu.returnFocus}
          onClose={() => setMenu(null)}
          actions={menuActions}
        />
      )}
      {picker && pickerBlock && (
        <PartPicker
          block={pickerBlock}
          trackId={picker.trackId}
          anchor={picker.anchor}
          returnFocus={picker.returnFocus}
          onClose={() => setPicker(null)}
          onChoose={(choice) => setPart(pickerBlock.id, picker.trackId, choice)}
        />
      )}
    </>
  );
}

/** Join buttons on the seams of neighbours that play the same thing (re-rendered only when they or the layout change). */
const LaneSeams = memo(function LaneSeams({ joins, layout, names, onJoin }: { joins: readonly Id[]; layout: SongLayout; names: readonly string[]; onJoin(id: Id): void }) {
  return (
    <div className={styles.seams}>
      {joins.map((id) => {
        const lb = layout.blocks.find((b) => b.id === id);
        if (!lb) return null;
        const name = names[lb.index] ?? 'block';
        return (
          <Tooltip key={id} name="Join" tip={`Join block ${lb.index + 1} and block ${lb.index + 2} into one block: they play the same scene with the same parts.`}>
            <button type="button" tabIndex={-1} data-join={id} className={styles.join} style={{ left: lb.x + lb.width }} aria-label={`Join ${name} (block ${lb.index + 1}) with the next block`} onClick={() => onJoin(id)}>
              <span className={styles.joinChip}>
                <LaneIcon name="join" size={11} />
                Join
              </span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
});

/** The scene cards under the lane: drag one in (insert or layer), or + to add it at the end. */
const SceneCards = memo(function SceneCards(props: { scenes: SceneSummary[]; lifted: Id | null; onPress(e: ReactPointerEvent<HTMLElement>, sceneId: Id): void; onAdd(s: SceneSummary): void }) {
  const { scenes, lifted, onPress, onAdd } = props;
  return (
    <div className={styles.cards} role="list" aria-label="Scenes you can add to the song">
      {scenes.map((s) => (
        <div key={s.id} role="listitem" className={styles.card} data-lifted={lifted === s.id || undefined} onPointerDown={(e) => onPress(e, s.id)} aria-label={`Scene ${s.name}: ${barsText(s.bars)}, ${partsText(s.parts)}`}>
          <span className={styles.grip} aria-hidden="true">
            <Icon name="drag" size={12} />
          </span>
          <span className={styles.cardText}>
            <span className={styles.cardName}>{s.name}</span>
            <span className={`${styles.cardMeta} mono`}>
              {barsText(s.bars)} · {partsText(s.parts)}
            </span>
          </span>
          <Tooltip
            name={`Add ${s.name}`}
            tip={`Add this scene at the end of the song (it plays ${timesText(DEFAULT_BLOCK_REPEATS)}). Or drag the card (a finger: hold it first): between blocks inserts it, onto a block fills that block’s silent parts with its clips (hold Shift to replace the parts instead).`}
          >
            <button type="button" className={styles.cardAdd} aria-label={`Add ${s.name} to the end of the song`} onClick={() => onAdd(s)}>
              <Icon name="plus" size={14} />
            </button>
          </Tooltip>
        </div>
      ))}
    </div>
  );
});
