/**
 * The song's timeline: the ruler (bar numbers, loop band), the sections
 * strip, and one row per part with its regions, like GarageBand's Tracks
 * area.
 *
 *          │ 1    5    9    13   17   21 …      ← ruler: click = playhead, drag = loop
 *          │ [Intro    ][Drop               ]   ← sections
 *  1 Drums │ [Four Floor ¦   ¦   ][Fill]        ← regions (notches where the clip repeats)
 *  2 Bass  │      [Bounce  ¦       ]
 *
 * One scroller holds it all: the ruler and sections stick to the top, the
 * part headers to the left. Regions are placed by CSS from the scale
 * (`--ppb`), so zooming re-renders the ruler only. Pointer gestures are the
 * LaneController's; the keys (laneKeys) act on the selection; the menus and
 * the loop picker open here.
 *
 * The playhead is one line through the ruler, the sections and the rows:
 * amber while the song plays (or is paused), neutral when stopped, where
 * Play will start (the song cursor). A frame loop moves it from
 * songPlayheadBar() (never React state per frame), marks the regions under
 * it, and, with Follow on, turns the page when it reaches the right edge
 * (not while a drag runs or for a moment after the person scrolled).
 *
 * Wheel and trackpad scroll the timeline sideways (Shift+wheel too);
 * Ctrl+wheel zooms around the pointer. The zoom is remembered per project.
 */
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type Ref } from 'react';
import { Button, useElementSize, useRafLoop } from '../../../ui/components';
import { regionEnd, songBars as projectSongBars } from '../../../project/arrangement';
import type { Id, Project } from '../../../project/types';
import { selectSlot, selectTrack, setPadMode, setView } from '../../../state/uiStore';
import { useStore } from '../../../state/store';
import { session, useProject } from '../../instance';
import { anchorFromContextEvent, anchorFromElement, isEchoOfKeyboardMenu, noteKeyboardMenu, useToastsIfAny, type MenuAnchor } from '../ClipMenu';
import { isMac } from '../hints/shortcuts';
import { DragOverlay } from './DragOverlay';
import { LaneController, type Carry, type LaneHost } from './laneController';
import { laneKey } from './laneKeys';
import { sameRange } from './laneLoop';
import { neighbour, pruneSelection, selectAll } from './laneSelection';
import { dragStore, hoverStore, ppbStore, rangeStore, selectionStore, setSelection, useDragView, usePxPerBar, useRange } from './laneStore';
import { readZoom, writeZoom } from './laneSettings';
import { PartRow, partKeysNav } from './PartRow';
import { SectionStrip } from './SectionStrip';
import { songPlayheadBar, songRuntime, songSession, useSongPlaying, useSongRuntime } from './songApi';
import * as act from './songActions';
import { LoopPicker, RegionMenu, SectionMenu, type MenuHost } from './SongMenus';
import { HEADER_W, HEADER_W_NARROW, RULER_H, SECTIONS_H, barAt, fitZoom, followScroll, gridStep, rowHeight, snapBar, timelineBars, xToBar, zoomScroll, zoomStep } from './songLayout';
import { rowViews, sameRows } from './songModel';
import { TimelineRuler } from './TimelineRuler';
import styles from './SongView.module.css';

/** After the person scrolls the timeline, the playhead does not turn its page for this long (ms). */
export const FOLLOW_REST_MS = 2500;
/** Ctrl+wheel travel (deltaY units) for one zoom step. */
const WHEEL_ZOOM_STEP = 60;

export interface TimelineHandle {
  zoom(dir: 1 | -1): void;
  fit(): void;
  /** A card or chip of the loop browser picked up. */
  carry(e: ReactPointerEvent<HTMLElement>, item: Carry): void;
  /** Where Paste and the browser's Enter put things: the playhead while the song plays, else the song cursor. */
  playheadBar(): number;
  /** Set the loop range to these bars and loop them. */
  loopBars(fromBar: number, toBar: number): void;
}

type Menu =
  | { kind: 'region'; id: Id; anchor: MenuAnchor; returnFocus: HTMLElement | null; bar: number | null }
  | { kind: 'section'; id: Id; anchor: MenuAnchor; returnFocus: HTMLElement | null }
  | { kind: 'picker'; trackId: Id; bar: number; anchor: MenuAnchor; returnFocus: HTMLElement | null };

const selectSongBars = (p: Project) => projectSongBars(p);
const selectHasRegions = (p: Project) => p.arrangement.regions.length > 0;
const selectSections = (p: Project) => p.arrangement.sections;
const selectProjectId = (p: Project) => p.id;
const selectHasScenes = (p: Project) => p.tracks.some((t) => t.clips.some((c) => c !== null));

/** The bar Play would start from, or the playhead while the song plays or is paused (whole bars). */
export function currentBar(): number {
  const live = songPlayheadBar();
  return live !== null ? Math.max(0, Math.floor(live + 1e-6)) : Math.max(0, Math.round(songRuntime().songCursor ?? 0));
}

export function SongTimeline({ follow, handleRef, onStatus }: { follow: boolean; handleRef: Ref<TimelineHandle>; onStatus(text: string): void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLDivElement>(null);
  const rows = useProject(rowViews, sameRows);
  const tracks = useMemo(() => rows.map((r) => r.id), [rows]);
  const anySolo = rows.some((r) => r.solo);
  const songBars = useProject(selectSongBars);
  const hasRegions = useProject(selectHasRegions);
  const hasScenes = useProject(selectHasScenes);
  const sections = useProject(selectSections);
  const projectId = useProject(selectProjectId);
  const ppb = usePxPerBar();
  const range = useRange();
  const looping = useSongRuntime((s) => !!s.songLoop);
  const cursor = useSongRuntime((s) => s.songCursor ?? 0);
  const songOn = useSongPlaying();
  const drag = useDragView();
  const size = useElementSize(scrollerRef);
  const headW = size.width && size.width < 980 ? HEADER_W_NARROW : HEADER_W;
  const viewW = Math.max(0, size.width - headW);
  const bars = timelineBars(songBars, viewW / Math.max(1, ppb));
  const rowH = rowHeight(size.height - RULER_H - SECTIONS_H - 14, rows.length);
  const toasts = useToastsIfAny();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<Id | null>(null);
  const [headTab, setHeadTab] = useState<{ row: number; col: 0 | 1 }>({ row: 0, col: 0 });

  // Live values for the controller and the frame loop (no re-render needed to read them).
  const live = useRef({ ppb, rowH, headW, tracks, follow, busy: false, userScrollAt: -Infinity, viewW, bars });
  live.current = { ...live.current, ppb, rowH, headW, tracks, follow, viewW, bars };

  /* ---------------------------------------------------------------- */
  /* Zoom                                                             */
  /* ---------------------------------------------------------------- */

  const pendingScroll = useRef<number | null>(null);
  const zoomTo = useCallback(
    (next: number, pointerX?: number) => {
      const sc = scrollerRef.current;
      const cur = ppbStore.getState();
      if (!sc || next === cur) return;
      const px = pointerX ?? Math.max(0, (sc.clientWidth - live.current.headW) / 2);
      pendingScroll.current = zoomScroll(sc.scrollLeft, px, cur, next);
      ppbStore.setState(next);
      writeZoom(session.store.getState().id, next);
    },
    [],
  );
  useLayoutEffect(() => {
    const sc = scrollerRef.current;
    if (sc && pendingScroll.current !== null) {
      sc.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
  }, [ppb]);

  // A project opens: its remembered zoom, else the scale that shows the whole song; nothing selected.
  const fittedFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!size.width || fittedFor.current === projectId) return;
    fittedFor.current = projectId;
    const remembered = readZoom(projectId);
    const p = session.store.getState();
    ppbStore.setState(remembered ?? fitZoom(projectSongBars(p), size.width - headW));
    if (scrollerRef.current) scrollerRef.current.scrollLeft = 0;
    setSelection({ ids: [], focus: p.arrangement.regions[0]?.id ?? null });
    rangeStore.setState(songRuntime().songLoop ?? null);
  }, [projectId, size.width, headW]);

  /* ---------------------------------------------------------------- */
  /* Selection follows the song                                       */
  /* ---------------------------------------------------------------- */

  useEffect(
    () =>
      session.store.subscribe((p, prev) => {
        if (p.arrangement.regions === prev.arrangement.regions) return;
        const ids = new Set(p.arrangement.regions.map((r) => r.id));
        const sel = selectionStore.getState();
        const next = pruneSelection(sel, ids, p.arrangement.regions[0]?.id ?? null);
        if (next !== sel) setSelection(next);
        else if (!sel.focus && p.arrangement.regions.length) setSelection({ ...sel, focus: p.arrangement.regions[0].id });
      }),
    [],
  );

  // The range on the ruler is the runtime's loop while looping is on (kept while it is off).
  const runtimeLoop = useSongRuntime((s) => s.songLoop);
  useEffect(() => {
    if (runtimeLoop && !sameRange(runtimeLoop, rangeStore.getState())) rangeStore.setState({ fromBar: runtimeLoop.fromBar, toBar: runtimeLoop.toBar });
  }, [runtimeLoop]);

  /* ---------------------------------------------------------------- */
  /* The controller                                                   */
  /* ---------------------------------------------------------------- */

  const seekOrCursor = useCallback((bar: number) => {
    const b = Math.max(0, Math.round(bar));
    if (songPlayheadBar() !== null) songSession.seekSong(b);
    else songSession.setSongCursor(b);
  }, []);

  const loopBars = useCallback((fromBar: number, toBar: number) => {
    const r = { fromBar, toBar };
    rangeStore.setState(r);
    songSession.setSongLoop(r);
  }, []);

  const controller = useMemo(() => {
    const host: LaneHost = {
      scroller: () => scrollerRef.current,
      origin: () => originRef.current,
      pxPerBar: () => live.current.ppb,
      rowH: () => live.current.rowH,
      headW: () => live.current.headW,
      tracks: () => live.current.tracks,
      project: () => session.store.getState(),
      rulerClick: (bar) => seekOrCursor(bar),
      rangeClick: () => {
        const r = rangeStore.getState();
        if (!r) return;
        songSession.setSongLoop(songRuntime().songLoop ? null : r);
      },
      rangeSet: (r) => loopBars(r.fromBar, r.toBar),
      sectionClick: (id, add) => {
        const p = session.store.getState();
        const s = p.arrangement.sections.find((x) => x.id === id);
        if (!s) return;
        const owned = p.arrangement.regions.filter((r) => r.start >= s.start && r.start < regionEnd(s)).map((r) => r.id);
        const sel = selectionStore.getState();
        const ids = add ? [...sel.ids, ...owned.filter((x) => !sel.ids.includes(x))] : owned;
        setSelection({ ids, focus: ids[0] ?? sel.focus });
      },
      busy: (on) => {
        live.current.busy = on;
        if (on) hoverStore.setState(null);
      },
    };
    return new LaneController(host);
  }, [seekOrCursor, loopBars]);
  useEffect(() => () => controller.dispose(), [controller]);

  /* ---------------------------------------------------------------- */
  /* Edit notes                                                       */
  /* ---------------------------------------------------------------- */

  const editNotes = useCallback(
    (id: Id) => {
      const p = session.store.getState();
      const r = p.arrangement.regions.find((x) => x.id === id);
      const t = r ? p.tracks.find((x) => x.id === r.trackId) : undefined;
      const slot = t && r ? t.clips.findIndex((c) => c?.id === r.clipId) : -1;
      if (!t || slot < 0) return;
      selectTrack(t.id);
      selectSlot(t.id, slot);
      setPadMode('steps');
      setView('play');
      const message = `Editing the notes of ${t.clips[slot]!.name} (${t.name}).`;
      if (toasts) toasts.show({ id: 'back-to-song', tone: 'info', message, action: { label: 'Back to Song', onAction: () => setView('arrange') }, duration: 20000 });
    },
    [toasts],
  );

  /* ---------------------------------------------------------------- */
  /* The handle (header keys, loop browser)                           */
  /* ---------------------------------------------------------------- */

  useImperativeHandle(
    handleRef,
    () => ({
      zoom: (dir) => {
        const next = zoomStep(ppbStore.getState(), dir);
        if (next !== null) zoomTo(next);
      },
      fit: () => {
        const sc = scrollerRef.current;
        if (!sc) return;
        const next = fitZoom(projectSongBars(session.store.getState()), sc.clientWidth - live.current.headW);
        pendingScroll.current = 0;
        if (next === ppbStore.getState()) sc.scrollLeft = 0;
        else ppbStore.setState(next);
        writeZoom(session.store.getState().id, next);
      },
      carry: (e, item) => controller.carry(e.nativeEvent, item, e.currentTarget),
      playheadBar: currentBar,
      loopBars,
    }),
    [controller, zoomTo, loopBars],
  );

  /* ---------------------------------------------------------------- */
  /* Playhead                                                          */
  /* ---------------------------------------------------------------- */

  const marked = useRef<{ bar: number; regions: unknown; ids: Set<Id> }>({ bar: -1, regions: null, ids: new Set() });
  const placeHead = useCallback((bar: number) => {
    const x = bar * live.current.ppb;
    const t = `translate3d(${x}px, 0, 0)`;
    if (lineRef.current) lineRef.current.style.transform = t;
    if (headRef.current) headRef.current.style.transform = t;
  }, []);
  const markPlaying = useCallback((bar: number | null) => {
    const sc = scrollerRef.current;
    const m = marked.current;
    const regions = session.store.getState().arrangement.regions;
    const whole = bar === null ? -1 : Math.floor(bar);
    if (whole === m.bar && regions === m.regions) return;
    m.bar = whole;
    m.regions = regions;
    const now = new Set(bar === null ? [] : regions.filter((r) => r.start <= bar && bar < regionEnd(r)).map((r) => r.id));
    for (const id of m.ids) if (!now.has(id)) sc?.querySelector(`[data-region-id="${id}"]`)?.removeAttribute('data-playing');
    for (const id of now) if (!m.ids.has(id)) sc?.querySelector(`[data-region-id="${id}"]`)?.setAttribute('data-playing', '');
    m.ids = now;
  }, []);
  useRafLoop(() => {
    const bar = songPlayheadBar();
    if (bar === null) return;
    placeHead(bar);
    markPlaying(bar);
    const sc = scrollerRef.current;
    const l = live.current;
    if (!sc || !l.follow || l.busy || controller.active || performance.now() - l.userScrollAt < FOLLOW_REST_MS) return;
    const to = followScroll(bar * l.ppb, sc.scrollLeft, sc.clientWidth - l.headW, l.bars * l.ppb);
    if (to !== null) {
      ignoreScroll.current = true;
      sc.scrollLeft = to;
    }
  }, songOn);
  // Stopped: the line stands where Play will start (and follows a zoom).
  useLayoutEffect(() => {
    if (songOn) {
      const bar = songPlayheadBar();
      if (bar !== null) placeHead(bar);
      return;
    }
    placeHead(cursor);
    markPlaying(null);
  }, [songOn, cursor, ppb, placeHead, markPlaying]);

  /* ---------------------------------------------------------------- */
  /* Scroll and wheel                                                 */
  /* ---------------------------------------------------------------- */

  const ignoreScroll = useRef(false);
  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    let zoomAcc = 0;
    const onScroll = () => {
      if (ignoreScroll.current) {
        ignoreScroll.current = false;
        return;
      }
      if (!controller.dragging) live.current.userScrollAt = performance.now();
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAcc += e.deltaY * (e.deltaMode === 1 ? 20 : 1);
        while (Math.abs(zoomAcc) >= WHEEL_ZOOM_STEP) {
          const dir = zoomAcc < 0 ? 1 : -1;
          zoomAcc -= Math.sign(zoomAcc) * WHEEL_ZOOM_STEP;
          const next = zoomStep(ppbStore.getState(), dir);
          const r = sc.getBoundingClientRect();
          if (next !== null) zoomTo(next, Math.max(0, e.clientX - r.left - live.current.headW));
        }
        return;
      }
      live.current.userScrollAt = performance.now();
      if (e.shiftKey || e.deltaX !== 0 || e.deltaY === 0) return;
      // A plain wheel scrolls sideways, unless the rows need it to scroll up or down.
      const canY = e.deltaY > 0 ? sc.scrollTop < sc.scrollHeight - sc.clientHeight - 1 : sc.scrollTop > 0;
      if (canY) return;
      e.preventDefault();
      sc.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 20 : 1);
    };
    sc.addEventListener('scroll', onScroll, { passive: true });
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      sc.removeEventListener('scroll', onScroll);
      sc.removeEventListener('wheel', onWheel);
    };
  }, [controller, zoomTo]);

  /* ---------------------------------------------------------------- */
  /* Pointer                                                          */
  /* ---------------------------------------------------------------- */

  const timelineX = (clientX: number) => clientX - (originRef.current?.getBoundingClientRect().left ?? 0);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const t = e.target as Element;
    if (t.closest('button, input, [data-hover-more]') && !t.closest('[data-region-id], [data-section-id]')) return;
    if (t.closest('[data-part-head]')) return;
    if (controller.press(e.nativeEvent)) {
      // Keep keyboard focus in the lane (on the pressed region), never on the scroller.
      const region = t.closest<HTMLElement>('[data-region-id]');
      if (region) region.focus({ preventScroll: true });
      else if (!t.closest('[data-section-id]')) e.preventDefault();
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.buttons || controller.active) return;
    const t = e.target as Element;
    if (t.closest('[data-hover-more]')) return;
    const region = t.closest<HTMLElement>('[data-region-id]');
    const lane = !region && t.closest<HTMLElement>('[data-lane]');
    hoverStore.setState(region?.dataset.regionId ?? null);
    const plus = plusRef.current;
    if (!plus) return;
    if (lane) {
      const row = live.current.tracks.indexOf(lane.dataset.lane!);
      const bar = barAt(timelineX(e.clientX), live.current.ppb);
      plus.style.setProperty('--row', String(row));
      plus.style.setProperty('--s', String(bar));
      plus.dataset.on = '';
    } else delete plus.dataset.on;
  };
  const onPointerLeave = () => {
    if (!controller.active) hoverStore.setState(null);
    if (plusRef.current) delete plusRef.current.dataset.on;
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const t = e.target as Element;
    const region = t.closest<HTMLElement>('[data-region-id]');
    if (region) {
      editNotes(region.dataset.regionId!);
      return;
    }
    const section = t.closest<HTMLElement>('[data-section-id]');
    if (section && !t.closest('[data-section-edge]')) {
      setRenaming(section.dataset.sectionId!);
      return;
    }
    const lane = t.closest<HTMLElement>('[data-lane]');
    if (lane) {
      const bar = barAt(timelineX(e.clientX), live.current.ppb);
      setMenu({ kind: 'picker', trackId: lane.dataset.lane!, bar, anchor: { left: e.clientX, top: e.clientY, width: 0, height: 0 }, returnFocus: null });
    }
  };

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    const t = e.target as Element;
    if (t.closest('input')) return;
    if (isEchoOfKeyboardMenu(e.target)) {
      e.preventDefault();
      return;
    }
    const region = t.closest<HTMLElement>('[data-region-id]');
    const section = t.closest<HTMLElement>('[data-section-id]');
    const lane = t.closest<HTMLElement>('[data-lane]');
    if (!region && !section && !lane && !t.closest('[data-ruler]')) return;
    e.preventDefault();
    if (region) {
      const id = region.dataset.regionId!;
      const sel = selectionStore.getState();
      if (!sel.ids.includes(id)) setSelection({ ids: [id], focus: id });
      const r = session.store.getState().arrangement.regions.find((x) => x.id === id);
      const bar = r ? Math.min(regionEnd(r) - 1, Math.max(r.start + 1, snapBar(timelineX(e.clientX), live.current.ppb))) : null;
      setMenu({ kind: 'region', id, anchor: anchorFromContextEvent(e, region), returnFocus: region, bar });
    } else if (section) {
      setMenu({ kind: 'section', id: section.dataset.sectionId!, anchor: anchorFromContextEvent(e, section), returnFocus: section });
    } else if (lane) {
      setMenu({ kind: 'picker', trackId: lane.dataset.lane!, bar: barAt(timelineX(e.clientX), live.current.ppb), anchor: { left: e.clientX, top: e.clientY, width: 0, height: 0 }, returnFocus: null });
    }
  };

  /* ---------------------------------------------------------------- */
  /* Keys                                                             */
  /* ---------------------------------------------------------------- */

  const focusRegion = (id: Id | null) => {
    if (!id) return;
    requestAnimationFrame(() => {
      const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
      if (!el) return;
      el.focus({ preventScroll: true });
      // Into view, clear of the part headers.
      const sc = scrollerRef.current!;
      const r = session.store.getState().arrangement.regions.find((x) => x.id === id);
      if (!r) return;
      const l = live.current;
      const x0 = r.start * l.ppb;
      const x1 = regionEnd(r) * l.ppb;
      const view = sc.clientWidth - l.headW;
      if (x0 < sc.scrollLeft) sc.scrollLeft = Math.max(0, x0 - 24);
      else if (x1 > sc.scrollLeft + view) sc.scrollLeft = Math.min(x0 - 24, x1 - view + 24);
    });
  };

  const onRowsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (partKeysNav(e, rows.length, (row, col) => {
      setHeadTab({ row, col });
      scrollerRef.current?.querySelector<HTMLElement>(`[data-part-head] [data-row="${row}"][data-col="${col}"]`)?.focus();
    }))
      return;
    const t = e.target as Element;
    if (!t.closest('[data-region-id]') && t !== e.currentTarget) return;
    const k = laneKey(e, isMac());
    if (!k) return;
    const p = session.store.getState();
    const sel = selectionStore.getState();
    const ids = sel.ids.length ? [...sel.ids] : sel.focus ? [sel.focus] : [];
    const at = currentBar();
    const say = (text: string) => onStatus(text);
    e.preventDefault();
    e.stopPropagation();
    switch (k.kind) {
      case 'focus': {
        const n = neighbour(p.arrangement.regions, live.current.tracks, sel.focus, k.dir, at);
        if (!n) return;
        setSelection({ ids: k.extend ? [...sel.ids.filter((x) => x !== n), n] : [n], focus: n });
        focusRegion(n);
        return;
      }
      case 'move': {
        const r = act.moveLoops(ids, k.bars);
        if (r?.changed) {
          const first = session.store.getState().arrangement.regions.find((x) => x.id === ids[0]);
          if (first) say(`${act.loopsWords(ids)} at bar ${first.start + 1}`);
          focusRegion(sel.focus);
        }
        return;
      }
      case 'length': {
        const r = act.resizeLoops(ids, 'end', k.bars);
        if (r?.changed) {
          const first = session.store.getState().arrangement.regions.find((x) => x.id === ids[0]);
          if (first) say(`${act.loopsWords(ids)} lasts ${first.bars} bars`);
        }
        return;
      }
      case 'delete': {
        if (!ids.length) return;
        const next = neighbour(p.arrangement.regions.filter((r) => !ids.includes(r.id) || r.id === sel.focus), live.current.tracks, sel.focus, 'next') ?? neighbour(p.arrangement.regions.filter((r) => !ids.includes(r.id) || r.id === sel.focus), live.current.tracks, sel.focus, 'prev');
        if (act.deleteLoops(ids)?.changed) {
          const keep = next && !ids.includes(next) ? next : (session.store.getState().arrangement.regions[0]?.id ?? null);
          setSelection({ ids: [], focus: keep });
          focusRegion(keep);
        }
        return;
      }
      case 'copy':
        act.copyLoops(ids);
        return;
      case 'cut':
        act.cutLoops(ids);
        return;
      case 'paste': {
        const r = act.pasteLoops(at);
        focusRegion(r?.ids?.[0] ?? null);
        return;
      }
      case 'duplicate': {
        const r = act.duplicateLoops(ids);
        focusRegion(r?.ids?.[0] ?? null);
        return;
      }
      case 'selectAll':
        setSelection(selectAll(p.arrangement.regions));
        return;
      case 'split':
        act.splitLoops(ids, at);
        return;
      case 'home':
        seekOrCursor(0);
        if (scrollerRef.current) scrollerRef.current.scrollLeft = 0;
        say('Playhead at bar 1');
        return;
      case 'menu': {
        const id = sel.focus ?? ids[0];
        const el = id ? scrollerRef.current?.querySelector<HTMLElement>(`[data-region-id="${id}"]`) : null;
        if (!id || !el) return;
        noteKeyboardMenu(el);
        if (!sel.ids.includes(id)) setSelection({ ids: [id], focus: id });
        setMenu({ kind: 'region', id, anchor: anchorFromElement(el), returnFocus: el, bar: null });
        return;
      }
      case 'escape':
        if (sel.ids.length) setSelection({ ids: [], focus: sel.focus });
        return;
    }
  };

  /* ---------------------------------------------------------------- */
  /* Menus                                                            */
  /* ---------------------------------------------------------------- */

  const menuHost: MenuHost = useMemo(
    () => ({
      playFrom: (bar) => void songSession.playSong({ fromBar: bar }),
      loopBars,
      playheadBar: currentBar,
      editNotes,
      renameSection: (id) => setRenaming(id),
    }),
    [loopBars, editNotes],
  );
  const p = session.store.getState();
  const menuRegion = menu?.kind === 'region' ? p.arrangement.regions.find((r) => r.id === menu.id) : undefined;
  const menuSection = menu?.kind === 'section' ? sections.find((s) => s.id === menu.id) : undefined;
  const menuTargets = menu?.kind === 'region' ? (selectionStore.getState().ids.includes(menu.id) ? selectionStore.getState().ids : [menu.id]) : [];

  const sectionsShown = drag?.kind === 'section' && drag.sections ? drag.sections : sections;
  const rangeShown = drag?.kind === 'range' && drag.range ? drag.range : range;
  const style = {
    '--ppb': ppb,
    '--row-h': `${rowH}px`,
    '--head-w': `${headW}px`,
    '--bars': bars,
    '--grid': gridStep(ppb),
    '--ruler-h': `${RULER_H}px`,
    '--sections-h': `${SECTIONS_H}px`,
    '--rows': rows.length,
  } as CSSProperties;

  return (
    <div ref={rootRef} className={styles.timeline} style={style} data-testid="song-timeline" data-playing={songOn || undefined}>
      <div
        ref={scrollerRef}
        className={styles.scroller}
        data-testid="lane-scroller"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <div className={styles.canvas}>
          <div className={styles.top}>
            <div className={styles.corner} aria-hidden="true" />
            <TimelineRuler pxPerBar={ppb} bars={bars} range={rangeShown} looping={looping} dragging={drag?.kind === 'range'} headRef={headRef} />
            <div className={styles.corner} data-under="" aria-hidden="true">
              <span className={styles.cornerLabel}>Sections</span>
            </div>
            <SectionStrip
              sections={sectionsShown}
              songBars={songBars}
              dragged={drag?.kind === 'section' ? (drag.section ?? null) : null}
              newSection={drag?.kind === 'drop' ? (drag.newSection ?? null) : null}
              renaming={renaming}
              onRenameDone={() => setRenaming(null)}
              onRename={(id) => setRenaming(id)}
              onMenu={(id, trigger) => {
                noteKeyboardMenu(trigger);
                setMenu({ kind: 'section', id, anchor: anchorFromElement(trigger), returnFocus: trigger });
              }}
            />
          </div>
          <div className={styles.rows} role="group" aria-label="The song: a row of loops for each part" aria-describedby="song-keys-help" onKeyDown={onRowsKeyDown} tabIndex={hasRegions ? -1 : 0}>
            <span id="song-keys-help" hidden>
              Arrow keys: ↑ ↓ the part above or below, Ctrl+← → the previous or next loop, ← → move the selected loops a bar, Alt+← → change their length. Delete removes, Ctrl+D duplicates, Ctrl+C and Ctrl+V copy and paste at the playhead, Shift+F10 opens a loop’s actions.
            </span>
            {rows.map((r) => (
              <PartRow key={r.id} row={r} anySolo={anySolo} tab={headTab.row === r.index ? headTab.col : headTab.row >= rows.length && r.index === 0 ? 0 : null} onFocusKey={(row, col) => setHeadTab({ row, col })} />
            ))}
          </div>
          <div ref={originRef} className={styles.origin}>
            <DragOverlay tracks={tracks} />
            <div ref={plusRef} className={styles.plus} aria-hidden="true">
              +
            </div>
            <HoverMore onOpen={(id, el) => setMenu({ kind: 'region', id, anchor: anchorFromElement(el), returnFocus: scrollerRef.current?.querySelector<HTMLElement>(`[data-region-id="${id}"]`) ?? null, bar: null })} />
          </div>
          <div ref={lineRef} className={styles.playhead} data-on={songOn || undefined} aria-hidden="true" />
        </div>
      </div>
      {!hasRegions && !drag && (
        <div className={styles.empty} data-testid="song-empty">
          <p className={styles.emptyText}>{hasScenes ? 'Drag a scene or a loop here — or' : 'Make some loops on the pads in Play, then drag them here.'}</p>
          {hasScenes && (
            <Button variant="primary" icon="sparkle" onClick={() => act.fillFromScenes()} data-testid="empty-make-song">
              Make a song from my scenes
            </Button>
          )}
        </div>
      )}
      {menu?.kind === 'region' && menuRegion && <RegionMenu region={menuRegion} targets={menuTargets} clickedBar={menu.bar} anchor={menu.anchor} returnFocus={menu.returnFocus} host={menuHost} onClose={() => setMenu(null)} />}
      {menu?.kind === 'section' && menuSection && <SectionMenu section={menuSection} anchor={menu.anchor} returnFocus={menu.returnFocus} host={menuHost} onClose={() => setMenu(null)} />}
      {menu?.kind === 'picker' && <LoopPicker trackId={menu.trackId} bar={menu.bar} anchor={menu.anchor} returnFocus={menu.returnFocus} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** The ⋯ on the region under the pointer (wide enough regions only): its actions. */
function HoverMore({ onOpen }: { onOpen(id: Id, el: HTMLElement): void }) {
  const id = useStore(hoverStore, (s) => s);
  const region = useProject((p) => (id ? (p.arrangement.regions.find((r) => r.id === id) ?? null) : null));
  const rowIndex = useProject((p) => (region ? p.tracks.findIndex((t) => t.id === region.trackId) : -1));
  const ppb = usePxPerBar();
  if (!region || rowIndex < 0 || region.bars * ppb < 56) return null;
  return (
    <button
      type="button"
      className={styles.hoverMore}
      data-hover-more=""
      tabIndex={-1}
      aria-label="Loop actions"
      style={{ '--row': rowIndex, '--e': regionEnd(region) } as CSSProperties}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => onOpen(region.id, e.currentTarget)}
    >
      ⋯
    </button>
  );
}

/** For tests: where a bar is on screen (client x of its line). */
export function barClientX(timeline: HTMLElement, bar: number): number {
  const origin = timeline.querySelector<HTMLElement>(`.${styles.origin}`);
  const ppb = ppbStore.getState();
  return (origin?.getBoundingClientRect().left ?? 0) + bar * ppb;
}

/** For tests and the header: the scale now. */
export function pxPerBarNow(): number {
  return ppbStore.getState();
}

/** The fractional bar at a client x on the timeline. */
export function barAtClientX(timeline: HTMLElement, clientX: number): number {
  const origin = timeline.querySelector<HTMLElement>(`.${styles.origin}`);
  return xToBar(clientX - (origin?.getBoundingClientRect().left ?? 0), ppbStore.getState());
}

/** Clear a drag view left behind (tests). */
export function resetLaneState(): void {
  dragStore.setState(null);
  hoverStore.setState(null);
  selectionStore.setState({ ids: [], focus: null });
  rangeStore.setState(null);
}
