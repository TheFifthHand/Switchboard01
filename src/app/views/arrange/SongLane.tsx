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
 *
 * The scale (pixels per bar) is chosen when the lane opens (the largest zoom
 * step at which the song fits) and then stays put while the song is edited:
 * a longer song scrolls instead of shrinking under the pointer. It changes
 * only when the window is resized, with Fit song, the zoom buttons or
 * Ctrl+wheel over the lane, and then glides (keeping the bar under the
 * pointer, or the middle of the view, where it was).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, Icon, IconButton, TOOLTIP_DELAY_MS, Tooltip, useElementSize, useRafLoop, useTips } from '../../../ui/components';
import { sameMaterial } from '../../../project/arrangement';
import type { Id } from '../../../project/types';
import { DEFAULT_BLOCK_REPEATS, joinProblem } from '../../../state/commands';
import { session, useProject, useUi } from '../../instance';
import { notify, useRuntime } from '../../runtime';
import { anchorFromContextEvent, anchorFromElement, isEchoOfKeyboardMenu, isMenuKey, noteKeyboardMenu, MOD_KEY, type MenuAnchor } from '../ClipMenu';
import { BlockMenu, PartPicker, partsText, type BlockMenuActions, type SceneSummary } from './BlockMenu';
import { END_ROOM, LaneGestures, type DragUi, type LaneHost } from './laneGestures';
import { LaneIcon } from './laneIcons';
import { FOLLOW_SCROLL_MS, PLAYHEAD_GLIDE_MS, ZOOM_MS, easeOut, prefersReducedMotion } from './laneMotion';
import { readFollow, writeFollow } from './laneSettings';
import * as act from './songActions';
import { BlockFace, SongBlock, type BlockHandlers } from './SongBlock';
import { EMPTY_SELECTION, menuTargets, nudgeGap, pasteGap, pruneSelection, selectAll, selectByClick, selectByKey, type LaneSelection } from './songDrag';
import { anchorAt, anchorX, barToX, blockWidth, followScroll, layoutSong, rulerMarks, scrollToShow, xToBar, zoomStep, type LaneAnchor, type SongLayout } from './songLayout';
import { barsText, cellTip, cellToggle, layerPreview, layerText, resizeText, type BlockView, type LayerPreview } from './songModel';
import { getSongPlan, songTimelineBar, startSong } from './songPlan';
import styles from './SongPanel.module.css';

/** pendingFocus value meaning "the song is now empty: focus Add all scenes". */
const EMPTY_FOCUS = '\u0000empty';
/** After the user scrolls the lane or edits the song, the playhead stops pulling the view for this long. */
export const FOLLOW_PAUSE_MS = 8000;
/** Clicks on the same part cell this close together are one undo step. */
export const CELL_GESTURE_MS = 500;
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

export function SongLane({ views, scenes, currentId, nextId = null, songActive, songPlaying, editClips }: SongLaneProps) {
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const locked = useRuntime((s) => s.recording === 'performance');
  const tips = useTips();
  const helpId = useId();
  const order = useMemo(() => views.map((v) => v.id), [views]);

  /* ---- geometry ---- */
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollerRef);
  const measured = size.width > 0;
  // The room after the last block (for drops at the end) is part of the content: lay out in what is left.
  const avail = Math.max(0, size.width - END_ROOM);
  const inputs = useMemo(() => views.map((v) => ({ id: v.id, bars: v.passBars, repeats: v.repeats })), [views]);
  const fit = useMemo(() => layoutSong(inputs, avail).pxPerBar, [inputs, avail]);
  // The scale in use: fixed once the lane has opened (edits never rescale it), else the one that fits.
  const [scale, setScale] = useState<number | null>(null);
  const ppb = scale ?? fit;
  const layout: SongLayout = useMemo(() => layoutSong(inputs, avail, { pxPerBar: ppb }), [inputs, avail, ppb]);
  const marks = useMemo(() => rulerMarks(layout), [layout]);
  const total = layout.contentWidth + END_ROOM;

  /* ---- state ---- */
  const [selectionState, setSelection] = useState<LaneSelection>(EMPTY_SELECTION);
  const selection = useMemo(() => pruneSelection(selectionState, order), [selectionState, order]);
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
  const live = useRef({ views, order, layout, selection, scenes, activeId: tabId, viewport: size.width, total, follow, songPlaying, advanced });
  live.current = { views, order, layout, selection, scenes, activeId: tabId, viewport: size.width, total, follow, songPlaying, advanced };

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

  /* ---- following the playhead ---- */
  const followPausedUntil = useRef(0);
  const pauseFollow = useCallback(() => {
    followPausedUntil.current = performance.now() + FOLLOW_PAUSE_MS;
    followAnim.current = null;
  }, []);
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
          if (focus) pendingFocus.current = r.ids[0];
          announce(r.text);
          return r.ids;
        }
        const text = act.moveBlocks(ids, gap);
        if (!text) return null;
        const moved = session.store.getState().arrangement.blocks.filter((b) => ids.includes(b.id)).map((b) => b.id);
        setSelection({ ids: moved, anchor: moved[0] });
        if (focus) pendingFocus.current = live.current.activeId && moved.includes(live.current.activeId) ? live.current.activeId : moved[0];
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
        el?.focus({ preventScroll: true });
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

  const paste = useCallback(
    (focus: Id | null) => {
      const r = act.pasteBlocks(pasteGap(live.current.order, live.current.selection, focus));
      if (!r) return;
      announce(r.text);
      setSelection({ ids: r.ids, anchor: r.ids[0] });
      focusBlock(r.ids[0]);
    },
    [announce, focusBlock],
  );

  const lengthen = useCallback(
    (ids: Id[], delta: 1 | -1) => {
      announce(act.setRepeats(ids, (r) => r + delta));
    },
    [announce],
  );

  const openMenu = useCallback((id: Id, anchor: MenuAnchor) => {
    setActiveId(id);
    setPicker(null);
    setMenu((m) => (m && m.blockId === id ? null : { blockId: id, anchor, returnFocus: blockEls.current.get(id) ?? null }));
  }, []);

  const openPicker = useCallback((id: Id, trackId: Id, anchor: MenuAnchor, returnFocus: HTMLElement | null) => {
    setActiveId(id);
    setMenu(null);
    setPicker({ blockId: id, trackId, anchor, returnFocus });
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
        if (neighbour) focusBlock(neighbour);
        else pendingFocus.current = EMPTY_FOCUS;
      },
      paste: () => paste(live.current.activeId),
      move: moveBy,
      remove: removeAndFocus,
    }),
    // viewOf reads live refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [announce, duplicate, editClips, focusBlock, lengthen, moveBy, paste, refuseLocked, removeAndFocus, togglePart],
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
        setSelection(r.selection);
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
          setSelection(selectAll(list));
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
        setSelection(EMPTY_SELECTION);
        announce('Selection cleared.');
      }
    },
    // viewOf reads live refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [announce, duplicate, focusBlock, lengthen, menuActions, moveBy, openMenu, paste, refuseLocked, removeAndFocus],
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
        setSelection({ ids: [other], anchor: other });
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
      setSelection(selectByClick(sel, list, id, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey }));
      setActiveId(id);
    },
    [g],
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
        setSelection(selectByClick(sel, list, id, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey }));
        setActiveId(id);
        return;
      }
      hideCellTip();
      togglePart(id, trackId, e.currentTarget);
    },
    // hideCellTip only touches refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [g, togglePart],
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
      if (live.current.selection.ids.length) setSelection(EMPTY_SELECTION);
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
      setCellTip({ text: cellTip(v, c), x: r.left + r.width / 2, y: r.top });
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
  const head = useRef<{ layout: SongLayout | null; shown: number | null; glide: { off: number; t0: number } | null }>({ layout: null, shown: null, glide: null });
  // A song that starts again starts its playhead where it plays (only edits make it glide).
  useEffect(() => {
    if (!songActive) head.current = { layout: null, shown: null, glide: null };
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
    // Blocks before the playhead moved: it glides to its new place instead of jumping.
    if (st.layout && st.layout !== L && st.shown !== null && Math.abs(st.shown - target) > 2 && !prefersReducedMotion()) st.glide = { off: st.shown - target, t0: now };
    st.layout = L;
    let x = target;
    if (st.glide) {
      const k = (now - st.glide.t0) / PLAYHEAD_GLIDE_MS;
      if (k >= 1) st.glide = null;
      else x = target + st.glide.off * (1 - easeOut(k));
    }
    st.shown = x;
    el.style.opacity = '1';
    el.style.transform = translate(x);
    // Keep the playhead in view while the song plays, unless following is off, something is carried or the user scrolled or edited lately.
    if (!live.current.follow || !live.current.songPlaying || !scroller || g.dragging || followAnim.current || now < followPausedUntil.current) return;
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
  const [rulerBar, setRulerBar] = useState<number | null>(null);
  const hoverRef = useRef<HTMLDivElement>(null);
  const rulerAt = (clientX: number) => {
    const c = contentRef.current;
    if (!c) return null;
    return xToBar(live.current.layout, clientX - c.getBoundingClientRect().left);
  };
  const showHover = (bar: number | null) => {
    const el = hoverRef.current;
    if (!el) return;
    if (bar === null) {
      delete el.dataset.on;
      return;
    }
    el.dataset.on = '';
    el.style.transform = `translate3d(${barToX(live.current.layout, bar).toFixed(1)}px, 0, 0)`;
    const label = el.firstElementChild;
    if (label) label.textContent = `Bar ${bar + 1}`;
  };
  const playFromBar = (bar: number) => {
    const b = live.current.layout.blocks.find((x) => x.totalBars > 0 && bar >= x.startBar && bar < x.startBar + x.totalBars);
    if (!b) return;
    void startSong(b.index, { fromBar: bar });
    followPausedUntil.current = 0;
    announce(`Playing the song from bar ${bar + 1}.`);
  };
  const totalBars = layout.totalBars;
  const rulerValue = rulerBar ?? 0;
  const rulerBlock = layout.blocks.find((b) => b.totalBars > 0 && rulerValue >= b.startBar && rulerValue < b.startBar + b.totalBars);
  const rulerText = rulerBlock ? `Bar ${rulerValue + 1}, in ${views[rulerBlock.index]?.name ?? 'a block'} (block ${rulerBlock.index + 1})` : `Bar ${rulerValue + 1}`;
  useEffect(() => {
    if (rulerBar !== null && rulerBar >= totalBars) setRulerBar(totalBars ? totalBars - 1 : null);
  }, [rulerBar, totalBars]);

  /* ---- palette ---- */
  const addAtEnd = (s: SceneSummary) => {
    const r = act.addScene(s.id);
    if (!r) return;
    setSelection({ ids: [r.id], anchor: r.id });
    setActiveId(r.id);
    pendingReveal.current = r.id;
    announce(r.text);
  };
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
  const joins = useProject(
    (p) => {
      const out: Id[] = [];
      const list = p.arrangement.blocks;
      for (let i = 0; i + 1 < list.length; i++) if (sameMaterial(list[i], list[i + 1]) && joinProblem(p, list[i].id) === null) out.push(list[i].id);
      return out;
    },
    (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
  );

  const zoomIn = zoomStep(ppb, 1);
  const zoomOut = zoomStep(ppb, -1);
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
        data-dragging={dragUi?.kind}
        data-copy={moving?.copy || undefined}
        data-outside={(moving?.outside ?? card?.outside) || undefined}
        data-advanced={advanced || undefined}
        data-locked={locked || undefined}
        style={{ ['--rows' as string]: views[0]?.cells.length || 8 }}
      >
        <div className={styles.names} aria-hidden="true">
          <div className={styles.namesHead}>Parts</div>
          {(views[0]?.cells ?? []).length
            ? views[0].cells.map((c) => (
                <div key={c.trackId} className={styles.nameRow} title={c.partName}>
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
              <div
                className={styles.ruler}
                role="slider"
                tabIndex={0}
                aria-label="Song position: arrow keys choose a bar, Enter plays the song from it"
                aria-valuemin={1}
                aria-valuemax={Math.max(1, totalBars)}
                aria-valuenow={rulerValue + 1}
                aria-valuetext={rulerText}
                data-testid="song-ruler"
                onPointerMove={(e) => showHover(rulerAt(e.clientX)?.bar ?? null)}
                onPointerLeave={() => showHover(rulerBar)}
                onClick={(e) => {
                  const hit = rulerAt(e.clientX);
                  if (!hit) return;
                  setRulerBar(hit.bar);
                  playFromBar(hit.bar);
                }}
                onFocus={() => showHover(rulerValue)}
                onBlur={() => showHover(null)}
                onKeyDown={(e) => {
                  if (e.ctrlKey || e.metaKey || e.altKey) return;
                  let next: number | null = null;
                  if (e.key === 'ArrowLeft') next = rulerValue - 1;
                  else if (e.key === 'ArrowRight') next = rulerValue + 1;
                  else if (e.key === 'PageUp') next = rulerValue - 4;
                  else if (e.key === 'PageDown') next = rulerValue + 4;
                  else if (e.key === 'Home') next = 0;
                  else if (e.key === 'End') next = totalBars - 1;
                  else if (e.key === 'Enter') {
                    e.preventDefault();
                    playFromBar(rulerValue);
                    return;
                  } else return;
                  e.preventDefault();
                  const v = Math.max(0, Math.min(totalBars - 1, next));
                  setRulerBar(v);
                  showHover(v);
                }}
              >
                {marks.map((m) => (
                  <span key={m.bar} className={styles.mark} data-label={m.label || undefined} data-start={m.blockStart || undefined} style={{ left: m.x }}>
                    {m.label && <span className={`${styles.markNum} mono`}>{m.bar + 1}</span>}
                  </span>
                ))}
                <span className={styles.endMark} style={{ left: layout.contentWidth - 1 }} />
                <div ref={hoverRef} className={styles.rulerHover} aria-hidden="true">
                  <span className={`${styles.rulerHoverLabel} mono`} />
                </div>
              </div>
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
                  <Button ref={addAllRef} size="sm" icon="plus" onClick={addAll} tip={`Adds every scene once, in row order, each playing ${DEFAULT_BLOCK_REPEATS} passes.`}>
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
            {!empty && (
              <div className={styles.seams}>
                {joins.map((id) => {
                  const lb = layout.blocks.find((b) => b.id === id);
                  const v = views.find((x) => x.id === id);
                  if (!lb || !v) return null;
                  return (
                    <Tooltip key={id} name="Join" tip={`Join block ${v.index + 1} and block ${v.index + 2} into one block: they play the same scene with the same parts.`}>
                      <button
                        type="button"
                        tabIndex={-1}
                        data-join={id}
                        className={styles.join}
                        style={{ left: lb.x + lb.width }}
                        aria-label={`Join ${v.name} (block ${v.index + 1}) with the next block`}
                        onClick={() => {
                          announce(act.joinWithNext(id));
                          focusBlock(id);
                        }}
                      >
                        <span className={styles.joinChip}>
                          <LaneIcon name="join" size={11} />
                          Join
                        </span>
                      </button>
                    </Tooltip>
                  );
                })}
              </div>
            )}
            {!empty && <div ref={playheadRef} className={styles.playhead} aria-hidden="true" data-on={songActive || undefined} data-testid="playhead" />}
          </div>
        </div>
        {/* The lifted copy of carried blocks floats over the lane (outside the scroller): while the lane
            scrolls under a still pointer, it does not move at all. */}
        <div className={styles.carry} aria-hidden="true">
          {moving && (
            <div ref={cloneRef} className={styles.clone} data-testid="lane-clone" data-copy={moving.copy || undefined} data-outside={moving.outside || undefined}>
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
        <div className={styles.cards} role="list" aria-label="Scenes you can add to the song">
          {scenes.map((s) => (
            <div
              key={s.id}
              role="listitem"
              className={styles.card}
              data-lifted={card?.sceneId === s.id || undefined}
              onPointerDown={(e) => g.pressCard(e.nativeEvent, s.id, e.currentTarget)}
              aria-label={`Scene ${s.name}: ${barsText(s.bars)}, ${partsText(s.parts)}`}
            >
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
                tip={`Add this scene at the end of the song (${DEFAULT_BLOCK_REPEATS} passes). Or drag the card: between blocks inserts it, onto a block fills that block’s silent parts with its clips (hold Shift to replace the parts instead).`}
              >
                <button type="button" className={styles.cardAdd} aria-label={`Add ${s.name} to the end of the song`} onClick={() => addAtEnd(s)}>
                  <Icon name="plus" size={14} />
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
        <p id={helpId} className={styles.hint}>
          Drag to move · {MOD_KEY.replace('+', '')}+drag copies · drag the right edge for passes · click a part to switch it · Enter for all actions
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
          <Button size="sm" variant="ghost" disabled={empty || ppb === fit} onClick={() => zoomTo(fit, 0, true)} tip={ppb === fit ? 'The song is at the size that fits the lane.' : 'Show the whole song at the size that fits the lane.'}>
            Fit song
          </Button>
        </div>
      </div>

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
          <div ref={ghostRef} className={styles.ghost} aria-hidden="true" data-testid="lane-ghost" data-drop={!card.outside || undefined} data-layer={!!layerTarget || undefined} data-replace={card.replace || undefined}>
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

