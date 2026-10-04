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
 * amber while the song plays, neutral while it is paused or stopped (where
 * Play will start, the song cursor). A frame loop moves it from
 * songPlayheadBar() (never React state per frame), marks the regions under
 * it, and, with Follow on, turns the page when it reaches the right edge
 * (not while a drag runs or for a moment after the person scrolled). When
 * the song stops and the playhead goes back, the view goes back with it.
 *
 * Wheel and trackpad scroll the timeline sideways (Shift+wheel too);
 * Ctrl+wheel zooms around the pointer, − and + around the playhead (else the
 * selection, else the middle). The zoom is remembered per project; the
 * view, the selection and the scroll are kept while another view is open.
 *
 * The keys (laneKeys) act on the selection whenever the Song view is open
 * and nothing that takes keys of its own has focus (a field, a menu, a
 * dialog, the takes panel): after a marquee, a click on an empty spot, the
 * ruler or a section, or a Cut, as much as after a click on a loop.
 */
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type Ref } from 'react';
import { Button, useElementSize, useRafLoop } from '../../../ui/components';
import { regionEnd, songBars as projectSongBars, timelineBars as projectTimelineBars } from '../../../project/arrangement';
import type { Id, Project } from '../../../project/types';
import { selectSlot, selectTrack, setPadMode, setView } from '../../../state/uiStore';
import { useStore } from '../../../state/store';
import { session, useProject } from '../../instance';
import { notify, runtimeStore, useRuntime } from '../../runtime';
import { songPlayheadBar, useSongPlaying } from '../../songPlayback';
import { MoreIcon, anchorFromContextEvent, anchorFromElement, isEchoOfKeyboardMenu, noteKeyboardMenu, useToastsIfAny, type MenuAnchor } from '../ClipMenu';
import { rangeText } from './songModel';
import { isMac } from '../hints/shortcuts';
import { DragOverlay } from './DragOverlay';
import { LaneController, type Carry, type LaneHost } from './laneController';
import type { BarRange } from './laneGestures';
import { laneKey } from './laneKeys';
import { sameRange } from './laneLoop';
import { neighbour, pruneSelection, selectAll, selectNone } from './laneSelection';
import { dragStore, hoverStore, ppbStore, rangeStore, selectionStore, setSelection, usePxPerBar, useRange, type DragView } from './laneStore';
import { readZoom, writeZoom } from './laneSettings';
import { PartRow, partKeysNav } from './PartRow';
import { SectionStrip, type SectionStripProps } from './SectionStrip';
import * as act from './songActions';
import { LoopPicker, RegionMenu, SectionMenu, type MenuHost } from './SongMenus';
import { HEADER_W, HEADER_W_NARROW, RULER_H, SECTIONS_H, barAt, fitZoom, followScroll, gridStep, rowHeight, snapBar, timelineBars, zoomScroll, zoomStep } from './songLayout';
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
  | { kind: 'region'; id: Id; anchor: MenuAnchor; returnFocus: HTMLElement | null; bar: number | null; viaMore?: boolean }
  | { kind: 'section'; id: Id; anchor: MenuAnchor; returnFocus: HTMLElement | null }
  | { kind: 'picker'; trackId: Id; bar: number; anchor: MenuAnchor; returnFocus: HTMLElement | null };

const selectSongBars = (p: Project) => projectSongBars(p);
/** How far the timeline is in use: the loops and the section labels (a label past the music still shows). */
const selectExtent = (p: Project) => projectTimelineBars(p);
const selectHasRegions = (p: Project) => p.arrangement.regions.length > 0;
const selectSections = (p: Project) => p.arrangement.sections;
const selectProjectId = (p: Project) => p.id;
const selectHasScenes = (p: Project) => p.tracks.some((t) => t.clips.some((c) => c !== null));

/**
 * What the Song view keeps while another view is open (it unmounts): the
 * project it showed, where it was scrolled to, and a loop to put keyboard
 * focus back on (Back to Song after Edit notes).
 */
const kept: { projectId: string | null; left: number; top: number; focus: Id | null } = { projectId: null, left: 0, top: 0, focus: null };

/** Elements that take the lane's keys for themselves while they have focus. */
const OWN_KEYS = 'input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [role="listbox"], [role="slider"], [role="spinbutton"], [role="combobox"], [role="tablist"], [data-own-keys]';

/** The bar Play would start from, or the playhead while the song plays or is paused (whole bars). */
export function currentBar(): number {
  const live = songPlayheadBar();
  return live !== null ? Math.max(0, Math.floor(live + 1e-6)) : Math.max(0, Math.round(runtimeStore.getState().songCursor));
}

export function SongTimeline({ follow, handleRef, onStatus }: { follow: boolean; handleRef: Ref<TimelineHandle>; onStatus(text: string): void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const rows = useProject(rowViews, sameRows);
  const tracks = useMemo(() => rows.map((r) => r.id), [rows]);
  const anySolo = rows.some((r) => r.solo);
  const songBars = useProject(selectSongBars);
  const extent = useProject(selectExtent);
  const hasRegions = useProject(selectHasRegions);
  const hasScenes = useProject(selectHasScenes);
  const sections = useProject(selectSections);
  const projectId = useProject(selectProjectId);
  const ppb = usePxPerBar();
  const range = useRange();
  const looping = useRuntime((s) => !!s.songLoop);
  const cursor = useRuntime((s) => s.songCursor);
  const songOn = useSongPlaying();
  // Amber only while the song really plays: paused, the line is neutral (the header says Paused).
  const songPlaying = useRuntime((s) => s.mode === 'song' && s.playing && !s.paused);
  const size = useElementSize(scrollerRef);
  const headW = size.width && size.width < 980 ? HEADER_W_NARROW : HEADER_W;
  const viewW = Math.max(0, size.width - headW);
  const bars = timelineBars(extent, viewW / Math.max(1, ppb));
  const rowH = rowHeight(size.height - RULER_H - SECTIONS_H - 14, rows.length);
  const toasts = useToastsIfAny();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<Id | null>(null);
  const [headTab, setHeadTab] = useState<{ row: number; col: 0 | 1 }>({ row: 0, col: 0 });

  // Live values for the controller and the frame loop (no re-render needed to read them).
  const live = useRef({ ppb, rowH, headW, tracks, follow, busy: false, userScrollAt: -Infinity, viewW, bars, songPlaying });
  live.current = { ...live.current, ppb, rowH, headW, tracks, follow, viewW, bars, songPlaying };
  const rowsRef = useRef<HTMLDivElement>(null);

  /* ---------------------------------------------------------------- */
  /* Zoom                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Where − and + zoom around (px from the timeline's visible left edge): the
   * playhead when it is in view, else the selected loops when they are, else
   * the middle of the view.
   */
  function zoomAnchor(sc: HTMLElement): number {
    const l = live.current;
    const view = Math.max(0, sc.clientWidth - l.headW);
    const inView = (x: number) => x >= 0 && x <= view;
    const head = (songPlayheadBar() ?? runtimeStore.getState().songCursor) * l.ppb - sc.scrollLeft;
    if (inView(head)) return head;
    const ids = selectionStore.getState().ids;
    const picked = session.store.getState().arrangement.regions.filter((r) => ids.includes(r.id));
    if (picked.length) {
      const a = Math.min(...picked.map((r) => r.start)) * l.ppb - sc.scrollLeft;
      const b = Math.max(...picked.map((r) => regionEnd(r))) * l.ppb - sc.scrollLeft;
      if (b > 0 && a < view) return Math.max(0, Math.min(view, (Math.max(0, a) + Math.min(view, b)) / 2));
    }
    return view / 2;
  }

  const pendingScroll = useRef<number | null>(null);
  const zoomTo = useCallback(
    (next: number, pointerX?: number) => {
      const sc = scrollerRef.current;
      const cur = ppbStore.getState();
      if (!sc || next === cur) return;
      const px = pointerX ?? zoomAnchor(sc);
      // Several steps before the view has drawn the first (a fast wheel): go on from where the last one left it.
      pendingScroll.current = zoomScroll(pendingScroll.current ?? sc.scrollLeft, px, cur, next);
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

  // A project opens: its remembered zoom, else the scale that shows the whole song; nothing selected. Back from
  // another view with the same project: as it was (zoom, scroll, selection), keyboard focus back on its loop.
  const fittedFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!size.width || fittedFor.current === projectId) return;
    fittedFor.current = projectId;
    const sc = scrollerRef.current;
    if (kept.projectId === projectId) {
      if (sc) {
        sc.scrollLeft = kept.left;
        sc.scrollTop = kept.top;
      }
      const back = kept.focus;
      kept.focus = null;
      if (back) focusRegion(back, false);
      return;
    }
    kept.projectId = projectId;
    kept.focus = null;
    const remembered = readZoom(projectId);
    const p = session.store.getState();
    ppbStore.setState(remembered ?? fitZoom(projectTimelineBars(p), size.width - headW));
    if (sc) sc.scrollLeft = 0;
    setSelection({ ids: [], focus: p.arrangement.regions[0]?.id ?? null });
    rangeStore.setState(runtimeStore.getState().songLoop ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, size.width, headW]);
  // Where the view was scrolled to, for coming back.
  useEffect(() => {
    const sc = scrollerRef.current;
    return () => {
      if (sc) {
        kept.left = sc.scrollLeft;
        kept.top = sc.scrollTop;
      }
    };
  }, []);

  /* ---------------------------------------------------------------- */
  /* Selection follows the song                                       */
  /* ---------------------------------------------------------------- */

  useEffect(
    () =>
      session.store.subscribe((p, prev) => {
        if (p.arrangement.regions === prev.arrangement.regions && p.arrangement.sections === prev.arrangement.sections) return;
        const ids = new Set(p.arrangement.regions.map((r) => r.id));
        const sel = selectionStore.getState();
        const next = pruneSelection(sel, ids, p.arrangement.regions[0]?.id ?? null, new Set(p.arrangement.sections.map((s) => s.id)));
        if (next !== sel) setSelection(next);
        else if (!sel.focus && p.arrangement.regions.length) setSelection({ ...sel, focus: p.arrangement.regions[0].id });
      }),
    [],
  );

  // Play started at the loop's start rather than at the playhead the person put outside it: show the loop and say
  // why, once for each loop range (with a way to switch the loop off).
  const toldLoop = useRef<string | null>(null);
  useEffect(
    () =>
      runtimeStore.subscribe((s, prev) => {
        const started = s.mode === 'song' && s.playing && !s.paused && !(prev.mode === 'song' && (prev.playing || prev.paused));
        if (!started || !s.songLoop) return;
        const loop = s.songLoop;
        const from = prev.songCursor;
        if (from >= loop.fromBar && from < loop.toBar) return;
        const key = `${loop.fromBar}|${loop.toBar}`;
        if (toldLoop.current === key) return;
        toldLoop.current = key;
        const sc = scrollerRef.current;
        const l = live.current;
        if (sc) {
          const x = loop.fromBar * l.ppb;
          if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - l.headW - 24) {
            ignoreScroll.current = true;
            sc.scrollLeft = Math.max(0, x - (sc.clientWidth - l.headW) * 0.05);
          }
        }
        const message = `Looping ${rangeText(loop.fromBar, loop.toBar).toLowerCase()}: Play starts at the loop.`;
        if (toasts) toasts.show({ id: 'song-loop-start', tone: 'info', message, action: { label: 'Loop off', onAction: () => session.setSongLoop(null) }, duration: 8000 });
        else notify(message);
      }),
    [toasts],
  );

  // The range on the ruler is the runtime's loop while looping is on (kept while it is off).
  const runtimeLoop = useRuntime((s) => s.songLoop);
  useEffect(() => {
    if (runtimeLoop && !sameRange(runtimeLoop, rangeStore.getState())) rangeStore.setState({ fromBar: runtimeLoop.fromBar, toBar: runtimeLoop.toBar });
  }, [runtimeLoop]);

  /* ---------------------------------------------------------------- */
  /* The controller                                                   */
  /* ---------------------------------------------------------------- */

  const seekOrCursor = useCallback((bar: number) => {
    const b = Math.max(0, Math.round(bar));
    if (songPlayheadBar() !== null) session.seekSong(b);
    else session.setSongCursor(b);
  }, []);

  const loopBars = useCallback((fromBar: number, toBar: number) => {
    const r = { fromBar, toBar };
    rangeStore.setState(r);
    session.setSongLoop(r);
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
        session.setSongLoop(runtimeStore.getState().songLoop ? null : r);
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
      // Back in Song, the loop is selected and has keyboard focus again.
      setSelection({ ids: [id], focus: id });
      kept.focus = id;
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
        const next = fitZoom(projectTimelineBars(session.store.getState()), sc.clientWidth - live.current.headW);
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

  const marked = useRef<{ key: string; regions: unknown; ids: Set<Id>; rec: Set<Id> }>({ key: '', regions: null, ids: new Set(), rec: new Set() });
  const placeHead = useCallback((bar: number) => {
    const x = bar * live.current.ppb;
    const t = `translate3d(${x}px, 0, 0)`;
    if (lineRef.current) lineRef.current.style.transform = t;
    if (headRef.current) headRef.current.style.transform = t;
  }, []);
  /**
   * Marks the regions under the playhead (data-playing: a subtle amber edge)
   * and, while Record Notes writes into one of them, that one (data-recording:
   * coral, with the word Rec). Only when the bar, the song or the target
   * changes; a few attribute writes, never a render.
   */
  const markPlaying = useCallback((bar: number | null) => {
    const sc = scrollerRef.current;
    const m = marked.current;
    const p = session.store.getState();
    const regions = p.arrangement.regions;
    const rt = runtimeStore.getState();
    const target = rt.recording === 'notes' ? rt.recordTarget : null;
    const recClip = target ? (p.tracks.find((t) => t.id === target.trackId)?.clips[target.slot]?.id ?? null) : null;
    const whole = bar === null ? -1 : Math.floor(bar);
    const key = `${whole}|${target?.trackId ?? ''}|${recClip ?? ''}`;
    if (key === m.key && regions === m.regions) return;
    m.key = key;
    m.regions = regions;
    const under = bar === null ? [] : regions.filter((r) => r.start <= bar && bar < regionEnd(r));
    const now = new Set(under.map((r) => r.id));
    const rec = new Set(under.filter((r) => target && r.trackId === target.trackId && r.clipId === recClip).map((r) => r.id));
    const el = (id: Id) => sc?.querySelector(`[data-region-id="${id}"]`);
    for (const id of m.ids) if (!now.has(id)) el(id)?.removeAttribute('data-playing');
    for (const id of now) if (!m.ids.has(id)) el(id)?.setAttribute('data-playing', '');
    for (const id of m.rec) if (!rec.has(id)) el(id)?.removeAttribute('data-recording');
    for (const id of rec) if (!m.rec.has(id)) el(id)?.setAttribute('data-recording', '');
    m.ids = now;
    m.rec = rec;
  }, []);
  useRafLoop(() => {
    const bar = songPlayheadBar();
    if (bar === null) return;
    placeHead(bar);
    // Paused: nothing is "under the playhead" in amber.
    markPlaying(live.current.songPlaying ? bar : null);
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
      if (!songPlaying) markPlaying(null);
      return;
    }
    placeHead(cursor);
    markPlaying(null);
  }, [songOn, songPlaying, cursor, ppb, placeHead, markPlaying]);
  // The song stopped and the playhead went back: the view goes back with it when it is out of sight.
  const wasOn = useRef(songOn);
  useEffect(() => {
    const was = wasOn.current;
    wasOn.current = songOn;
    if (!was || songOn) return;
    const sc = scrollerRef.current;
    if (!sc) return;
    const l = live.current;
    const x = cursor * l.ppb;
    const view = sc.clientWidth - l.headW;
    if (x < sc.scrollLeft || x > sc.scrollLeft + view - 12) {
      ignoreScroll.current = true;
      sc.scrollLeft = Math.max(0, x - view * 0.05);
    }
  }, [songOn, cursor]);

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
    sc.addEventListener('touchmove', controller.touchMove, { passive: false });
    return () => {
      sc.removeEventListener('scroll', onScroll);
      sc.removeEventListener('wheel', onWheel);
      sc.removeEventListener('touchmove', controller.touchMove);
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
      // Keyboard focus in the lane: on the pressed region, else on the rows as a whole (never left on a button
      // pressed earlier, never on the scroller); the keys then act on whatever the press selected.
      const region = t.closest<HTMLElement>('[data-region-id]');
      if (region) region.focus({ preventScroll: true });
      else if (!t.closest('[data-section-id]')) {
        e.preventDefault();
        focusRows();
      }
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
    // A press's events go to the scroller (it captures the pointer): what was double-clicked is what is under the pointer.
    const t = document.elementFromPoint(e.clientX, e.clientY) ?? (e.target as Element);
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

  /** Keyboard focus on a loop (and the view scrolled to show it, clear of the part headers). */
  function focusRegion(id: Id | null, scroll = true): void {
    if (!id) return;
    requestAnimationFrame(() => {
      const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
      if (!el) return;
      el.focus({ preventScroll: true });
      const sc = scrollerRef.current!;
      const r = session.store.getState().arrangement.regions.find((x) => x.id === id);
      if (!r || !scroll) return;
      const l = live.current;
      const x0 = r.start * l.ppb;
      const x1 = regionEnd(r) * l.ppb;
      const view = sc.clientWidth - l.headW;
      if (x0 < sc.scrollLeft) sc.scrollLeft = Math.max(0, x0 - 24);
      else if (x1 > sc.scrollLeft + view) sc.scrollLeft = Math.min(x0 - 24, x1 - view + 24);
    });
  }

  /** Keyboard focus somewhere neutral (the rows as a whole): after a delete nothing is selected, and nothing looks it. */
  const focusRows = () => rowsRef.current?.focus({ preventScroll: true });

  // The Song view's keys, wherever focus is in the view (or on nothing), see OWN_KEYS for where they are not.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing || controller.active) return;
    const root = rootRef.current;
    if (!root || root.closest('[hidden]')) return;
    const t = e.target instanceof Element ? e.target : null;
    const onNothing = !t || t === document.body || t === document.documentElement;
    if (!onNothing && t.closest(OWN_KEYS)) return;
    if (document.querySelector('[aria-modal="true"]') || document.body.hasAttribute('data-popover-open')) return;
    // Inside the song view (header, timeline, loop browser) or the transport; not the takes panel, the keyboard or the hint.
    const inView = onNothing || !!t.closest('section[aria-labelledby="song-title"], header[aria-label="Transport"]');
    if (!inView) return;
    const inLane = onNothing || root.contains(t);
    const k = laneKey(e, isMac());
    if (!k) return;
    // Enter and Home, ↑ ↓, the menu key and Esc belong to whatever button has focus outside the timeline.
    if (!inLane && (k.kind === 'home' || k.kind === 'focus' || k.kind === 'menu' || k.kind === 'escape')) return;
    // Copying text the person selected on the page is the browser's.
    if ((k.kind === 'copy' || k.kind === 'cut') && !window.getSelection()?.isCollapsed) return;
    const p = session.store.getState();
    const sel = selectionStore.getState();
    const ids = [...sel.ids];
    const at = currentBar();
    const say = (text: string) => onStatus(text);
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (k.kind) {
      case 'focus': {
        const n = neighbour(p.arrangement.regions, live.current.tracks, sel.focus, k.dir, at);
        take();
        if (!n) return;
        setSelection({ ids: k.extend ? [...sel.ids.filter((x) => x !== n), n] : [n], focus: n });
        focusRegion(n);
        return;
      }
      case 'move': {
        if (!ids.length) return;
        take();
        const r = act.moveLoops(ids, k.bars);
        if (r?.changed) {
          const first = session.store.getState().arrangement.regions.find((x) => x.id === ids[0]);
          if (first) say(`${act.loopsWords(ids)} at bar ${first.start + 1}`);
          if (inLane && t?.closest('[data-region-id]')) focusRegion(sel.focus);
        }
        return;
      }
      case 'length': {
        if (!ids.length) return;
        take();
        const r = act.resizeLoops(ids, 'end', k.bars);
        if (r?.changed) {
          const first = session.store.getState().arrangement.regions.find((x) => x.id === ids[0]);
          if (first) say(`${act.loopsWords(ids)} lasts ${first.bars} bars`);
        }
        return;
      }
      case 'delete': {
        const labels = sel.sections ?? [];
        if (!ids.length && !labels.length) return;
        take();
        if (act.deleteSelection(ids, labels)) {
          // Nothing selected; keyboard focus on the rows as a whole (never a loop that would look chosen).
          const left = session.store.getState().arrangement.regions;
          setSelection({ ids: [], focus: left.some((r) => r.id === sel.focus) ? sel.focus : (left[0]?.id ?? null) });
          if (inLane) focusRows();
        }
        return;
      }
      case 'copy':
        if (!ids.length) return;
        take();
        act.copyLoops(ids);
        return;
      case 'cut':
        if (!ids.length) return;
        take();
        if (act.cutLoops(ids)?.changed && inLane) focusRows();
        return;
      case 'paste': {
        take();
        const r = act.pasteLoops(at);
        if (inLane) focusRegion(r?.ids?.[0] ?? null);
        return;
      }
      case 'duplicate': {
        if (!ids.length) return;
        take();
        const r = act.duplicateLoops(ids);
        if (inLane) focusRegion(r?.ids?.[0] ?? null);
        return;
      }
      case 'selectAll':
        take();
        setSelection(selectAll(p.arrangement.regions, p.arrangement.sections));
        return;
      case 'split':
        if (!ids.length) return;
        take();
        act.splitLoops(ids, at);
        return;
      case 'home':
        take();
        seekOrCursor(0);
        if (scrollerRef.current) scrollerRef.current.scrollLeft = 0;
        say('Playhead at bar 1');
        return;
      case 'menu': {
        const id = sel.focus ?? ids[0];
        const el = id ? scrollerRef.current?.querySelector<HTMLElement>(`[data-region-id="${id}"]`) : null;
        if (!id || !el) return;
        take();
        noteKeyboardMenu(el);
        if (!sel.ids.includes(id)) setSelection({ ids: [id], focus: id });
        setMenu({ kind: 'region', id, anchor: anchorFromElement(el), returnFocus: el, bar: null });
        return;
      }
      case 'escape':
        if (!sel.ids.length && !sel.sections?.length) return;
        take();
        setSelection(selectNone(sel));
        return;
    }
  };
  // On the document: after what has focus handled its own keys (React's handlers, a section's arrows), before the
  // app's window-wide keys (which keep Ctrl+A from selecting the page's text when no view used it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // The part keys in the headers: arrows move between them.
  const onRowsKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    partKeysNav(e, rows.length, (row, col) => {
      setHeadTab({ row, col });
      scrollerRef.current?.querySelector<HTMLElement>(`[data-part-head] [data-row="${row}"][data-col="${col}"]`)?.focus();
    });
  };

  // A loop reached with Tab is the one the keys act on (as a click would make it).
  const onRowsFocus = (e: ReactFocusEvent<HTMLDivElement>) => {
    const el = (e.target as Element).closest<HTMLElement>('[data-region-id]');
    if (!el || !el.matches(':focus-visible')) return;
    const id = el.dataset.regionId!;
    const sel = selectionStore.getState();
    if (!sel.ids.includes(id)) setSelection({ ids: [id], focus: id });
  };

  /* ---------------------------------------------------------------- */
  /* Menus                                                            */
  /* ---------------------------------------------------------------- */

  const menuHost: MenuHost = useMemo(
    () => ({
      playFrom: (bar) => void session.playSong({ fromBar: bar }),
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

  const onFocusKey = useCallback((row: number, col: 0 | 1) => setHeadTab((t) => (t.row === row && t.col === col ? t : { row, col })), []);
  const onRenameDone = useCallback(() => setRenaming(null), []);
  const onRename = useCallback((id: Id) => setRenaming(id), []);
  const onSectionMenu = useCallback((id: Id, trigger: HTMLElement) => {
    noteKeyboardMenu(trigger);
    setMenu({ kind: 'section', id, anchor: anchorFromElement(trigger), returnFocus: trigger });
  }, []);
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
    <div ref={rootRef} className={styles.timeline} style={style} data-testid="song-timeline" data-playing={songPlaying || undefined}>
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
            <RulerLayer pxPerBar={ppb} bars={bars} range={range} looping={looping} headRef={headRef} />
            <div className={styles.corner} data-under="" aria-hidden="true">
              <span className={styles.cornerLabel}>Sections</span>
            </div>
            <SectionsLayer sections={sections} songBars={songBars} renaming={renaming} onRenameDone={onRenameDone} onRename={onRename} onMenu={onSectionMenu} />
          </div>
          <div ref={rowsRef} className={styles.rows} role="group" aria-label="The song: a row of loops for each part" aria-describedby="song-keys-help" onKeyDown={onRowsKeyDown} onFocus={onRowsFocus} tabIndex={hasRegions ? -1 : 0}>
            <span id="song-keys-help" hidden>
              Arrow keys: ↑ ↓ the part above or below, Ctrl+← → the previous or next loop, ← → move the selected loops a bar, Alt+← → change their length. Delete removes, Ctrl+D duplicates, Ctrl+C and Ctrl+V copy and paste at the playhead, Shift+F10 opens a loop’s actions.
            </span>
            {rows.map((r) => (
              <PartRow key={r.id} row={r} anySolo={anySolo} tab={headTab.row === r.index ? headTab.col : headTab.row >= rows.length && r.index === 0 ? 0 : null} onFocusKey={onFocusKey} />
            ))}
          </div>
          <div ref={originRef} className={styles.origin}>
            <DragOverlay tracks={tracks} />
            <div ref={plusRef} className={styles.plus} aria-hidden="true">
              +
            </div>
            <HoverMore
              buttonRef={moreRef}
              menuFor={menu?.kind === 'region' && menu.viaMore ? menu.id : null}
              onToggle={(id, el) =>
                setMenu((m) =>
                  m?.kind === 'region' && m.id === id && m.viaMore
                    ? null
                    : { kind: 'region', id, anchor: anchorFromElement(el), returnFocus: scrollerRef.current?.querySelector<HTMLElement>(`[data-region-id="${id}"]`) ?? null, bar: null, viaMore: true },
                )
              }
            />
          </div>
          <div ref={lineRef} className={styles.playhead} data-on={songPlaying || undefined} aria-hidden="true" />
        </div>
      </div>
      {!hasRegions && <EmptyNote hasScenes={hasScenes} />}
      {menu?.kind === 'region' && menuRegion && <RegionMenu region={menuRegion} targets={menuTargets} clickedBar={menu.bar} anchor={menu.anchor} returnFocus={menu.returnFocus} ignore={menu.viaMore ? moreRef.current : null} host={menuHost} onClose={() => setMenu(null)} />}
      {menu?.kind === 'section' && menuSection && <SectionMenu section={menuSection} anchor={menu.anchor} returnFocus={menu.returnFocus} host={menuHost} onClose={() => setMenu(null)} />}
      {menu?.kind === 'picker' && <LoopPicker trackId={menu.trackId} bar={menu.bar} anchor={menu.anchor} returnFocus={menu.returnFocus} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * The empty song (no loops, whatever section labels are left): one line and
 * one button. It steps aside while something is dragged in.
 */
function EmptyNote({ hasScenes }: { hasScenes: boolean }) {
  const dragging = useStore(dragStore, (d) => d !== null);
  if (dragging) return null;
  return (
    <div className={styles.empty} data-testid="song-empty">
      <p className={styles.emptyText}>{hasScenes ? 'The song is empty. Drag a scene or a loop here — or' : 'The song is empty. Make some loops on the pads in Play, then drag them here.'}</p>
      {hasScenes && (
        <Button variant="primary" icon="sparkle" onClick={() => act.fillFromScenes()} data-testid="empty-make-song">
          Make a song from my scenes
        </Button>
      )}
    </div>
  );
}

/** The ruler, with the loop range a ruler drag would set while one runs (only this re-renders meanwhile). */
function RulerLayer(props: { pxPerBar: number; bars: number; range: BarRange | null; looping: boolean; headRef: Ref<HTMLDivElement> }) {
  const dragRange = useStore(dragStore, (d) => (d?.kind === 'range' && d.range ? d.range : null), (a, b) => sameRange(a, b));
  return <TimelineRuler pxPerBar={props.pxPerBar} bars={props.bars} range={dragRange ?? props.range} looping={props.looping} dragging={dragRange !== null} headRef={props.headRef} />;
}

function sameNewSection(a: DragView['newSection'] | null, b: DragView['newSection'] | null): boolean {
  return a === b || (!!a && !!b && a.start === b.start && a.bars === b.bars && a.name === b.name);
}

/** The sections strip, with the sections a section drag would leave (and a scene drop's new section) while one runs. */
function SectionsLayer(props: Omit<SectionStripProps, 'dragged' | 'newSection'>) {
  const sectionDrag = useStore(dragStore, (d) => (d?.kind === 'section' ? d : null));
  const newSection = useStore(dragStore, (d) => (d?.kind === 'drop' ? (d.newSection ?? null) : null), sameNewSection);
  return (
    <SectionStrip
      {...props}
      sections={sectionDrag?.sections ?? props.sections}
      dragged={sectionDrag?.section ?? null}
      newSection={newSection}
    />
  );
}

/**
 * The ⋯ on the region under the pointer (wide enough regions only): its
 * actions. It stays on the region whose menu it opened while that menu is
 * open; a second click closes the menu.
 */
function HoverMore({ menuFor, onToggle, buttonRef }: { menuFor: Id | null; onToggle(id: Id, el: HTMLElement): void; buttonRef: Ref<HTMLButtonElement> }) {
  const hovered = useStore(hoverStore, (s) => s);
  const id = menuFor ?? hovered;
  const region = useProject((p) => (id ? (p.arrangement.regions.find((r) => r.id === id) ?? null) : null));
  const rowIndex = useProject((p) => (region ? p.tracks.findIndex((t) => t.id === region.trackId) : -1));
  const ppb = usePxPerBar();
  if (!region || rowIndex < 0 || region.bars * ppb < 56) return null;
  return (
    <button
      ref={buttonRef}
      type="button"
      className={styles.hoverMore}
      data-hover-more=""
      tabIndex={-1}
      aria-label={`Actions for this loop`}
      aria-haspopup="menu"
      aria-expanded={menuFor === region.id}
      style={{ '--row': rowIndex, '--e': regionEnd(region) } as CSSProperties}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => onToggle(region.id, e.currentTarget)}
    >
      <MoreIcon size={13} />
    </button>
  );
}




/** Clear a drag view left behind (tests). */
export function resetLaneState(): void {
  kept.projectId = null;
  kept.focus = null;
  kept.left = 0;
  kept.top = 0;
  dragStore.setState(null);
  hoverStore.setState(null);
  selectionStore.setState({ ids: [], focus: null });
  rangeStore.setState(null);
}
