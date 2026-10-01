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
 *   SCENES  [Intro +] [Groove +] [Lift +] [Break +]    ← drag in: insert, or drop on a block to layer
 *
 * The lane is one Tab stop; arrow keys move between blocks (roving focus),
 * ↓ enters a block's part cells. Pointer gestures live in LaneGestures, which
 * writes positions straight to the DOM; this component re-renders only when
 * what is shown changes kind (selection, a drag starting or ending, menus).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, Icon, Tooltip, useElementSize, useRafLoop } from '../../../ui/components';
import { sameMaterial } from '../../../project/arrangement';
import type { Id } from '../../../project/types';
import { DEFAULT_BLOCK_REPEATS, addBlock as addBlockCmd, joinProblem } from '../../../state/commands';
import { session, useProject, useUi } from '../../instance';
import { notify } from '../../runtime';
import { anchorFromContextEvent, anchorFromElement, isEchoOfKeyboardMenu, isMenuKey, noteKeyboardMenu, MOD_KEY, type MenuAnchor } from '../ClipMenu';
import { BlockMenu, PartPicker, partsText, type BlockMenuActions, type SceneSummary } from './BlockMenu';
import { END_ROOM, LaneGestures, type DragUi, type LaneHost } from './laneGestures';
import { LaneIcon } from './laneIcons';
import * as act from './songActions';
import { BlockFace, SongBlock, type BlockHandlers } from './SongBlock';
import { EMPTY_SELECTION, menuTargets, nudgeGap, pasteGap, pruneSelection, selectAll, selectByClick, selectByKey, type LaneSelection } from './songDrag';
import { barToX, blockWidth, layoutSong, rulerMarks, xToBar, type SongLayout } from './songLayout';
import { barsText, cellToggle, layerPreview, type BlockView } from './songModel';
import { getSongPlan, songTimelineBar, startSong } from './songPlan';
import styles from './SongPanel.module.css';

/** pendingFocus value meaning "the song is now empty: focus Add all scenes". */
const EMPTY_FOCUS = '\u0000empty';
/** After the user scrolls the lane, the playhead stops pulling the view for this long. */
const FOLLOW_PAUSE_MS = 4000;

export interface SongLaneProps {
  views: readonly BlockView[];
  scenes: SceneSummary[];
  /** Block playing now (song mode), by id. */
  currentId: Id | null;
  /** The song plays or is paused: draw the playhead. */
  songActive: boolean;
  /** The song plays (the playhead keeps itself in view). */
  songPlaying: boolean;
  editClips(row: number): void;
}

const cellSelector = (blockId: Id, trackId: Id) => `#song-block-${CSS.escape(blockId)} [data-cell][data-track="${CSS.escape(trackId)}"]`;

export function SongLane({ views, scenes, currentId, songActive, songPlaying, editClips }: SongLaneProps) {
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const helpId = useId();
  const order = useMemo(() => views.map((v) => v.id), [views]);

  /* ---- geometry ---- */
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollerRef);
  const measured = size.width > 0;
  // The room after the last block (for drops at the end) is part of the content: lay out in what is left.
  const layout: SongLayout = useMemo(() => layoutSong(views.map((v) => ({ id: v.id, bars: v.passBars, repeats: v.repeats })), Math.max(0, size.width - END_ROOM)), [views, size.width]);
  const marks = useMemo(() => rulerMarks(layout), [layout]);

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

  // Latest values for callbacks that must stay stable (memoised blocks, the gesture controller).
  const live = useRef({ views, order, layout, selection, scenes, activeId: tabId });
  live.current = { views, order, layout, selection, scenes, activeId: tabId };

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

  /* ---- block elements and the gesture controller ---- */
  const blockEls = useRef(new Map<Id, HTMLElement>());
  const cloneRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

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
      layout: () => live.current.layout,
      order: () => live.current.views.map((v) => ({ id: v.id, layerable: !v.missing, name: v.name })),
      selection: () => live.current.selection,
      locked: () => session.store.getLock(),
      sceneWidth: (sceneId) => {
        const s = live.current.scenes.find((x) => x.id === sceneId);
        return blockWidth((s?.bars ?? 1) * DEFAULT_BLOCK_REPEATS, live.current.layout.pxPerBar);
      },
      sceneName: (sceneId) => live.current.scenes.find((x) => x.id === sceneId)?.name ?? 'scene',
      setDragUi: (ui) => {
        setDragUi(ui);
        if (ui) {
          setMenu(null);
          setPicker(null);
        }
      },
      selectOnly: (id) => {
        setSelection({ ids: [id], anchor: id });
        setActiveId(id);
      },
      refuse: (message) => notify(message, 'warn'),
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
      commitLayer: (blockId, sceneId) => {
        announce(act.layerScene(blockId, sceneId));
      },
      commitRepeats: (id, repeats) => {
        announce(act.setRepeats([id], () => repeats, act.newGesture('edge')));
      },
      resizeLabel: (id, repeats) => {
        const v = live.current.views.find((x) => x.id === id);
        return `×${repeats} · ${barsText((v?.passBars ?? 1) * repeats)}`;
      },
    };
    gestures.current = new LaneGestures(host);
  }
  const g = gestures.current;

  // Place blocks after every render (or keep the live preview of a gesture), then restore focus if an edit moved it.
  useLayoutEffect(() => {
    g.sync();
    const id = pendingFocus.current;
    if (id === EMPTY_FOCUS) {
      pendingFocus.current = null;
      addAllRef.current?.focus({ preventScroll: true });
    } else if (id) {
      const el = blockEls.current.get(id);
      if (el || measured) {
        pendingFocus.current = null;
        el?.focus({ preventScroll: false });
      }
    }
  });
  // Someone else changed the song mid-gesture (undo, another view): drop the gesture, commit nothing.
  useEffect(() => g.externalChange(), [views, g]);
  useEffect(() => () => g.dispose(), [g]);

  /* ---- actions ---- */
  const viewOf = (id: Id) => live.current.views.find((v) => v.id === id);

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
    (id: Id, trackId: Id, choice: Id | null | undefined) => {
      announce(act.setPart(id, trackId, choice));
    },
    [announce],
  );

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
      setPart(id, trackId, t.choice);
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
      rename: (id) => setRenaming(id),
      togglePart: (id, trackId) => togglePart(id, trackId, blockEls.current.get(id)),
      resetParts: (id) => announce(act.resetParts(id)),
      changeScene: (id, sceneId) => announce(act.changeScene(id, sceneId)),
      layerScene: (id, sceneId) => announce(act.layerScene(id, sceneId)),
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
    [announce, duplicate, editClips, focusBlock, lengthen, moveBy, paste, removeAndFocus, togglePart],
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
        if (!viewOf(id)?.missing) setRenaming(id);
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
    [announce, duplicate, focusBlock, lengthen, menuActions, moveBy, openMenu, paste, removeAndFocus],
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
      togglePart(id, trackId, e.currentTarget);
    },
    [g, togglePart],
  );

  const handlers: BlockHandlers = useMemo(
    () => ({
      register: (id, el) => {
        if (el) blockEls.current.set(id, el);
        else if (blockEls.current.get(id)?.isConnected === false) blockEls.current.delete(id);
      },
      onPointerDown: (e, id) => {
        const el = blockEls.current.get(id);
        if (el) g.pressBlock(e.nativeEvent, id, el);
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
      onStartRename: (id) => setRenaming(id),
    }),
    [announce, focusBlock, g, onBlockClick, onBlockKeyDown, onCellClick, onCellKeyDown, openMenu, openPicker],
  );

  // Clicking empty lane clears the selection.
  const onLanePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = e.target as Element;
    if (t === trackRef.current || t === contentRef.current || t === scrollerRef.current) {
      if (live.current.selection.ids.length) setSelection(EMPTY_SELECTION);
    }
  };

  /* ---- scrolling, playhead ---- */
  const [edges, setEdges] = useState({ left: false, right: false });
  const lastUserScroll = useRef(-Infinity);
  const ownScroll = useRef<number | null>(null);
  const updateEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((x) => (x.left === left && x.right === right ? x : { left, right }));
  }, []);
  useEffect(updateEdges, [layout, size.width, updateEdges]);
  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    if (ownScroll.current === null || Math.abs(el.scrollLeft - ownScroll.current) > 1) lastUserScroll.current = performance.now();
    ownScroll.current = null;
    g.onScroll(el.scrollLeft);
    updateEdges();
  };

  const playheadRef = useRef<HTMLDivElement>(null);
  useRafLoop((_dt, now) => {
    const el = playheadRef.current;
    const t = session.transport;
    if (!el || !t || !getSongPlan()) return;
    const bar = songTimelineBar(t.getPosition().tick);
    if (bar === null) {
      el.style.opacity = '0';
      return;
    }
    const x = barToX(live.current.layout, bar);
    el.style.opacity = '1';
    el.style.transform = `translate3d(${x.toFixed(1)}px, 0, 0)`;
    // Keep the playhead in view while the song plays, unless the user is dragging or just scrolled away.
    const scroller = scrollerRef.current;
    if (!songPlaying || !scroller || g.dragging || now - lastUserScroll.current < FOLLOW_PAUSE_MS) return;
    if (scroller.scrollWidth <= scroller.clientWidth) return;
    if (x < scroller.scrollLeft + 8 || x > scroller.scrollLeft + scroller.clientWidth - 32) {
      const to = Math.max(0, x - 48);
      ownScroll.current = to;
      scroller.scrollLeft = to;
    }
  }, songActive);

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
    notify(`Added ${s.name} at the end of the song (block ${session.store.getState().arrangement.blocks.length}).`);
  };
  const addAll = () => {
    let first: Id | null = null;
    const gesture = act.newGesture('add-all');
    for (const s of scenes) {
      const r = cmdAdd(s.id, gesture);
      if (r) first ??= r;
    }
    if (!first) return;
    notify(`Added ${scenes.map((s) => s.name).join(', ')} in order. Drag blocks, their edges or their parts to shape the song.`);
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
    if (lb.x < scroller.scrollLeft || lb.x + lb.width > scroller.scrollLeft + scroller.clientWidth) {
      ownScroll.current = null;
      scroller.scrollTo({ left: Math.max(0, lb.x + lb.width + 24 - scroller.clientWidth), behavior: 'smooth' });
    }
  });

  /* ---- render ---- */
  const empty = views.length === 0;
  const moving = dragUi?.kind === 'move' ? dragUi : null;
  const card = dragUi?.kind === 'card' ? dragUi : null;
  const layerTarget = card?.layerInto ?? null;
  const layerInfo = useProject((p) => {
    if (!card || !layerTarget) return null;
    const b = p.arrangement.blocks.find((x) => x.id === layerTarget);
    return b ? layerPreview(p, b, card.sceneId) : null;
  }, (a, b) => a === b || (!!a && !!b && a.sceneName === b.sceneName && [...a.changes.keys()].join() === [...b.changes.keys()].join()));
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
            <div ref={trackRef} className={styles.track} role={empty ? undefined : 'list'} aria-label={empty ? undefined : `Song: ${views.length} block${views.length === 1 ? '' : 's'} in play order`}>
              {empty ? (
                <div className={styles.empty} data-drop={(card && !card.outside) || undefined}>
                  <Icon name="plus" size={20} />
                  <div className={styles.emptyText}>
                    <strong>Your song is empty.</strong>
                    <span>Add scenes in the order they should play: press + on a scene below, or drag it here.</span>
                  </div>
                  <Button ref={addAllRef} size="sm" icon="plus" onClick={addAll} tip={`Adds every scene once, in row order, with ${DEFAULT_BLOCK_REPEATS} repeats each.`}>
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
              {moving && (
                <div ref={cloneRef} className={styles.clone} aria-hidden="true" data-testid="lane-clone" data-copy={moving.copy || undefined} data-outside={moving.outside || undefined}>
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
                  <span className={styles.badge} data-copy={moving.copy || undefined}>
                    <Icon name={moving.copy ? 'copy' : 'drag'} size={11} />
                    <span ref={labelRef} />
                  </span>
                </div>
              )}
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
                        <LaneIcon name="join" size={11} />
                        Join
                      </button>
                    </Tooltip>
                  );
                })}
              </div>
            )}
            {!empty && <div ref={playheadRef} className={styles.playhead} aria-hidden="true" data-on={songActive || undefined} data-testid="playhead" />}
          </div>
        </div>
      </div>

      <div className={styles.palette}>
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
              <Tooltip name={`Add ${s.name}`} tip={`Add this scene at the end of the song (${DEFAULT_BLOCK_REPEATS} repeats). Or drag the card: between blocks inserts it, onto a block layers its parts in.`}>
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
      </div>

      <div className="visually-hidden" role="status" aria-live="polite" data-testid="lane-status">
        <span key={status.n}>{status.text}</span>
      </div>

      {card &&
        createPortal(
          <div ref={ghostRef} className={styles.ghost} aria-hidden="true" data-testid="lane-ghost" data-drop={!card.outside || undefined} data-layer={!!layerTarget || undefined}>
            <span className={styles.ghostName}>
              {layerTarget ? <LaneIcon name="layers" size={12} /> : <Icon name="plus" size={12} />} {scenes.find((s) => s.id === card.sceneId)?.name}
            </span>
            <span ref={labelRef} className={`${styles.ghostMeta}`} />
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

/** Add a block for a scene at the end with a shared gesture (one undo step for "Add all"). */
function cmdAdd(sceneId: Id, gesture: string): Id | null {
  const r = addBlockCmd(session.store, sceneId, undefined, undefined, gesture);
  return session.accepted(r) && r.blockId ? r.blockId : null;
}
