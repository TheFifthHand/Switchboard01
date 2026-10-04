/**
 * "Try this" hints: for the first project, a small chip suggests one next
 * action at a time (tap a pad, Mute, drag a clip, Tone, Change instrument,
 * mastering, record) and moves on when the person does it, detected from the
 * real state (steps.ts, tracker.ts). Once the Song view opens, the song track
 * comes first (drag a loop in, stretch it, move it, click the ruler, play the
 * song, export).
 *
 * - Never blocks anything: it is not a dialog, takes no focus, and sits in a
 *   free spot of the workspace (placement.ts), never over the transport, the
 *   pads, the keyboard, a control, a heading, a status line or a readout. A
 *   view can give it a home ([data-hint-home]) and mark what it must keep
 *   clear of ([data-hint-avoid]).
 * - Costs nothing where it matters: it is placed, and checks that nothing
 *   moved under it, after the frame that shows a new view has painted (rAF,
 *   then idle time), never while a pointer is pressed (a drag) or a modal
 *   dialog is open (it checks again on release), with a coarse-then-fine
 *   search and the sizes of its layouts cached.
 * - It moves only when something would end up under it, and for a moment
 *   after it appears or moves it ignores pointer clicks (a double-click
 *   meant for what was there before never hides it).
 * - A step that belongs to another view collapses to one line ("Next, in
 *   Play: …") with a button that goes there.
 * - Shown only while Tips are on; "Hide hints" closes it (remembered), and
 *   Help's "Show hints again" starts it over.
 * - Screen readers hear each new suggestion through a polite status message.
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Button, Icon, IconButton } from '../../../ui/components';
import { setPadMode, setView, uiStore, type View } from '../../../state/uiStore';
import { shallowEqual, useStore, type ReadableStore } from '../../../state/store';
import { session, useProject, useUi } from '../../instance';
import { notify, runtimeStore, useRuntime } from '../../runtime';
import { finishHints, hideHints, hintsRunning, hintsStore, markHintDone, startSongHints, type HintId } from './hintsState';
import { HINT_STEPS, bassHasClips, bassPart, currentHint, drumsPart, hintWhere, hintsFinishedText, projectHasClips, type HintContext } from './steps';
import { findSpotFast, hardened, placeOk, readObstacles, spotCost, workArea, type Box, type Spot } from './placement';
import { browserOpenStore } from '../arrange/laneStore';
import { watchHints } from './tracker';
import styles from './Hints.module.css';

/**
 * Layouts tried in turn until one finds a free spot: one row (the suggestion
 * wrapping in its column when narrower), compact (without the second
 * sentence), stacked (buttons beside the label, the suggestion below), and
 * last a narrow column (label, suggestion and buttons one under another) for
 * a crowded view whose only free room is a narrow strip (Song at
 * 1366 x 768: beside the song's last loop).
 */
interface Layout {
  maxW: number;
  compact: boolean;
  stack: boolean;
  column?: boolean;
  /** "Next hint" as its arrow alone (its name stays "Next hint"). */
  minimal?: boolean;
  /**
   * A step done in another view, in the narrowest one-line spot: "Next, in
   * Song:" and its button, the step's words for screen readers only (they
   * show once that view is open).
   */
  terse?: boolean;
}
const LAYOUTS: readonly Layout[] = [
  { maxW: 700, compact: false, stack: false },
  { maxW: 700, compact: true, stack: false },
  { maxW: 560, compact: false, stack: false },
  { maxW: 560, compact: true, stack: false },
  { maxW: 560, compact: true, stack: false, minimal: true },
  { maxW: 560, compact: true, stack: false, minimal: true, terse: true },
  { maxW: 440, compact: false, stack: true },
  { maxW: 440, compact: true, stack: true },
  { maxW: 340, compact: true, stack: true },
  { maxW: 260, compact: true, stack: false, column: true },
  { maxW: 210, compact: true, stack: false, column: true },
];

function applyLayout(el: HTMLElement, layout: Layout, maxW: number): void {
  el.style.maxWidth = `${maxW}px`;
  el.toggleAttribute('data-compact', layout.compact);
  el.toggleAttribute('data-stack', layout.stack);
  el.toggleAttribute('data-column', !!layout.column);
  el.toggleAttribute('data-minimal', !!layout.minimal);
  el.toggleAttribute('data-terse', !!layout.terse);
}
/** How long "Done" shows after a step is done. */
const DONE_MS = 1800;
/** How often the chip checks that nothing has moved under it. */
const CHECK_MS = 600;
/** Placement waits for idle time after the paint, but never longer than this (ms). */
const IDLE_TIMEOUT_MS = 300;
/** After placing, the chip looks again this much later (ms): a view may lay itself out again after its first paint. */
const RECHECK_MS = 200;
/** With no room for the chip, it looks again this much later (ms). */
const NO_ROOM_RETRY_MS = 1500;
/** A spot costing this little counts as free. */
const FREE = 0.5;
/** How much taller than its home's row the chip may be there (px): one line of words, never two. */
const HOME_SLACK_PX = 8;
/**
 * After the chip appears, moves or changes size, pointer clicks on it are
 * ignored for this long: the second click of a double-click meant for what
 * was there before (Skip guide, Next hint) must not land on Hide hints.
 * Keyboard presses always work.
 */
export const HINT_CLICK_GUARD_MS = 450;
/** ... and for this many painted frames at least (a busy machine paints late: a click cannot be aimed at what was not painted yet). */
const CLICK_GUARD_FRAMES = 3;

/** True when the transport shows its Export key at this width (otherwise Export is in its ⋯ menu). */
function exportOnStrip(): boolean {
  const bar = document.querySelector('header[aria-label="Transport"]');
  if (!bar) return true;
  return [...bar.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Export' && b.getBoundingClientRect().width > 1);
}

/** A modal dialog is open: the chip is behind it, so it neither places nor checks. */
const modalOpen = () => document.body.hasAttribute('data-modal-open') || !!document.querySelector('[aria-modal="true"]');

/** The open view as a store of its own (the song steps are about the Song view). */
const viewStore: ReadableStore<View> = {
  getState: () => uiStore.getState().view,
  subscribe: (l) =>
    uiStore.subscribe((s, prev) => {
      if (s.view !== prev.view) l(s.view, prev.view);
    }),
};

/** Run `fn` once the browser is idle after the next paint (rAF, then idle time; a short timeout where idle never comes). */
function afterPaint(fn: () => void): () => void {
  let idle = 0;
  let timer = 0;
  const raf = requestAnimationFrame(() => {
    if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS });
    else timer = window.setTimeout(fn, 0);
  });
  return () => {
    cancelAnimationFrame(raf);
    if (idle && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
    if (timer) window.clearTimeout(timer);
  };
}

export interface HintsProps {
  /** False while something else has the stage (the Welcome card, the quick guide). */
  active: boolean;
  /**
   * The view on screen. The shell renders a new view just after its tab
   * changes (a deferred render): the chip finds its spot once that view is
   * there. Default: the view chosen (uiStore).
   */
  shownView?: View;
}

export function Hints({ active, shownView }: HintsProps) {
  const hints = useStore(hintsStore, (s) => s);
  const tips = useUi((s) => s.tipsEnabled);
  const view = useUi((s) => s.view);
  const running = hintsRunning(hints);

  // Progress is tracked whenever hints are on, even while the guide or a dialog is showing.
  useEffect(() => {
    if (!running) return;
    return watchHints({ project: session.store, history: session.store.info, runtime: runtimeStore, view: viewStore, exports: session.exportsFinished, lastChange: () => session.store.lastChange() }, (id) => markHintDone(id));
  }, [running]);

  // The Song view opened while the hints run: the song track becomes current (once; again after "Show hints again").
  useEffect(() => {
    if (running && view === 'arrange' && !hints.song) startSongHints();
  }, [running, view, hints.song]);

  if (!active || !tips || !running) return null;
  return <HintChip done={hints.done} song={!!hints.song} shownView={shownView} />;
}

function HintChip({ done, song, shownView }: { done: readonly HintId[]; song: boolean; shownView?: View }) {
  const view = useUi((s) => s.view);
  /** The view on screen now (it follows the chosen one a moment later). */
  const onScreen = shownView ?? view;
  const padMode = useUi((s) => s.padMode);
  const uiMode = useUi((s) => s.uiMode);
  const parts = useProject(
    (p) => {
      const drums = drumsPart(p);
      return { bassName: bassPart(p)?.name ?? null, drumsName: drums?.name ?? null, drumsMuted: drums?.mute ?? false, hasClips: projectHasClips(p), bassHasClips: bassHasClips(p), hasRegions: p.arrangement.regions.length > 0 };
    },
    shallowEqual,
  );
  const recording = useRuntime((s) => s.recording === 'performance');
  const selectedTrack = useUi((s) => s.selectedTrackId);
  // Where Export is at this width, for the closing line and the export step (read from the strip, which follows the window).
  const [exportShown, setExportShown] = useState(true);
  const exportShownRef = useRef(exportShown);
  exportShownRef.current = exportShown;
  // The words follow the view on screen, as the placement does (the chosen view is a moment ahead during a switch).
  const browserOpen = useStore(browserOpenStore, (s) => s);
  const base: HintContext = { view: onScreen, padMode, recording, ...parts, exportAt: exportShown ? 'strip' : 'menu', browserOpen };
  // Whether the pads play matters to one step's words only (Play is Pause then): only that step listens, so Play / Pause
  // does not re-render the chip otherwise.
  const listens = currentHint(done, base, { song })?.step.id === 'song-play';
  const padsPlaying = useRuntime((s) => listens && s.playing && s.mode === 'live');
  const ctx: HintContext = { ...base, padsPlaying };

  const current = currentHint(done, ctx, { song });
  const step = current?.step ?? null;
  const here = step ? step.here(ctx) : true;
  const go = step && !here ? (step.go ?? null) : null;
  // A step done in another view (or pad tab): one line, "Next, in Play: …", with the button that goes there.
  const where = go ? hintWhere(go, ctx) : null;
  const songDone = song && HINT_STEPS.every((s) => s.track !== 'song' || done.includes(s.id));
  const text = step ? step.text(ctx) : hintsFinishedText(exportShown ? 'strip' : 'menu', songDone);
  const more = step && !go ? (step.more?.(ctx) ?? null) : null;
  const position = current?.position ?? 0;
  const total = current?.total ?? 0;
  const songTrack = step?.track === 'song';

  // "Done" for a moment when the previous suggestion was done (not passed over with Next hint).
  const [justDone, setJustDone] = useState(false);
  const shown = useRef<HintId | null>(step?.id ?? null);
  const passedOver = useRef<HintId | null>(null);
  // Starts empty and is filled after mounting, so screen readers announce the first suggestion too.
  const [announce, setAnnounce] = useState('');
  // Its own timer: a text change meanwhile (another view, Mute pressed) must not keep "Done" up.
  const doneTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(doneTimer.current), []);
  const spoken = where ? `${where} ${text}` : text;
  useEffect(() => {
    const prev = shown.current;
    shown.current = step?.id ?? null;
    if (prev === (step?.id ?? null)) {
      setAnnounce(step ? `Try this: ${spoken}` : spoken);
      return;
    }
    const completed = prev !== null && done.includes(prev) && passedOver.current !== prev;
    passedOver.current = null;
    setAnnounce(completed ? (step ? `Done. Next, try this: ${spoken}` : `Done. ${spoken}`) : step ? `Try this: ${spoken}` : spoken);
    window.clearTimeout(doneTimer.current);
    setJustDone(completed);
    if (completed) doneTimer.current = window.setTimeout(() => setJustDone(false), DONE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id, spoken]);

  const chipRef = useRef<HTMLElement>(null);
  /** Where the chip is (and its size), and what it covered there counting the quick check's obstacles only. */
  const spot = useRef<(Spot & { w: number; h: number; vw: number; vh: number; controls: number }) | null>(null);
  /** Pointer clicks on the chip before this time (performance.now()), or before this many more frames, are ignored (see HINT_CLICK_GUARD_MS). */
  const clickGuardUntil = useRef(0);
  const clickGuardFrames = useRef(0);
  const guardRaf = useRef(0);
  const armClickGuard = () => {
    clickGuardUntil.current = performance.now() + HINT_CLICK_GUARD_MS;
    clickGuardFrames.current = CLICK_GUARD_FRAMES;
    if (guardRaf.current) return;
    const tick = () => {
      clickGuardFrames.current -= 1;
      guardRaf.current = clickGuardFrames.current > 0 ? requestAnimationFrame(tick) : 0;
    };
    guardRaf.current = requestAnimationFrame(tick);
  };
  useEffect(() => () => cancelAnimationFrame(guardRaf.current), []);
  /** Measured size of each layout for the current words and window width (measuring forces a layout, so once is enough). */
  const sizes = useRef<{ key: string; map: Map<string, { w: number; h: number }> }>({ key: '', map: new Map() });
  /** A placement found a stale measure and asked for one more (only once in a row). */
  const restale = useRef(false);
  /** When the last placement found no spot that leaves every control free (the chip is hidden until one frees up). */
  const noRoomAt = useRef(-Infinity);
  /** A pointer is pressed (a drag may be under way): no placing or checking until it is released. */
  const pressed = useRef(false);
  const wordsKey = `${text}|${more ?? ''}|${go?.label ?? ''}|${where ?? ''}|${step ? 'step' : 'end'}`;

  /** The size of layout `i` for the current words (measured once per words and window width). */
  const sizeOf = (el: HTMLElement, i: number, maxW: number, vw: number): { w: number; h: number } => {
    const key = `${wordsKey}|${vw}`;
    if (sizes.current.key !== key) sizes.current = { key, map: new Map() };
    const id = `${i}|${Math.round(maxW)}`;
    const cached = sizes.current.map.get(id);
    if (cached) return cached;
    applyLayout(el, LAYOUTS[i], maxW);
    const s = { w: el.offsetWidth, h: el.offsetHeight };
    sizes.current.map.set(id, s);
    return s;
  };

  /**
   * Find the best spot and move there: the view's hint home when it is free,
   * else the free spot nearest the top. Size and layout are set on the
   * element directly (React does not manage them), so no re-render.
   */
  const place = () => {
    const el = chipRef.current;
    if (!el || pressed.current || modalOpen()) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const area = workArea(vw, vh);
    const obstacles = readObstacles(el, vw, vh);
    // Collapsed (a step done elsewhere): the one-line layouts only.
    const choices = LAYOUTS.map((l, i) => ({ l, i })).filter(({ l }) => (go ? l.compact : !l.terse));
    let best: (Spot & { maxW: number; i: number }) | null = null;
    // The view's home first: the chip sits on it (over the home's own words), as wide as it needs, when that covers
    // nothing else; a one-line home (a header row) takes a layout as low as its row only (a second line would hang
    // over what is below it).
    const home = homeBox(el, vw, vh, area);
    if (home) {
      for (const { l, i } of choices) {
        const maxW = Math.min(l.maxW, area.right - area.left);
        const size = sizeOf(el, i, maxW, vw);
        if (home.oneLine && size.h > home.box.bottom - home.box.top + HOME_SLACK_PX) continue;
        const wanted = home.align === 'end' ? home.box.right - size.w : home.align === 'center' ? (home.box.left + home.box.right - size.w) / 2 : home.box.left;
        const x = Math.round(Math.max(area.left, Math.min(wanted, area.right - size.w)));
        // Centred on the home's line, never above the work area.
        const y = Math.round(Math.max(area.top, Math.min((home.box.top + home.box.bottom - size.h) / 2, area.bottom - size.h)));
        const cost = spotCost(x, y, size, obstacles);
        if (cost <= FREE) {
          best = { x, y, cost, maxW, i };
          break;
        }
      }
    }
    if (!best) {
      // Controls, headings, status lines and the played surfaces outweigh any amount of text.
      const ranked = hardened(obstacles);
      for (const { l, i } of choices) {
        const maxW = Math.min(l.maxW, area.right - area.left);
        const s = findSpotFast(sizeOf(el, i, maxW, vw), area, ranked, { tolerance: FREE });
        if (!best || s.cost < best.cost) best = { ...s, maxW, i };
        if (s.cost <= FREE) break;
      }
    }
    if (!best) return;
    applyLayout(el, LAYOUTS[best.i], best.maxW);
    const used = sizeOf(el, best.i, best.maxW, vw);
    let w = el.offsetWidth;
    let h = el.offsetHeight;
    if (Math.abs(w - used.w) > 1 || Math.abs(h - used.h) > 1) {
      // A measured size went stale (the fonts finished loading, say): measure again from scratch, and look again.
      sizes.current = { key: '', map: new Map() };
      if (!restale.current) {
        restale.current = true;
        placeSoon();
      }
    } else restale.current = false;
    // Never past the work area's edges, whatever the measures said.
    const x = Math.round(Math.max(area.left, Math.min(best.x, area.right - w)));
    const y = Math.round(Math.max(area.top, Math.min(best.y, area.bottom - h)));
    // No spot without covering a control (a crowded view, a very small window): the chip waits off screen
    // (its words stay with screen readers) and looks again a little later.
    if (!placeOk(x, y, { w, h }, obstacles)) {
      el.removeAttribute('data-ready');
      spot.current = null;
      noRoomAt.current = performance.now();
      noteExportPlace();
      return;
    }
    noRoomAt.current = -Infinity;
    best = { ...best, x, y };
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    w = el.offsetWidth;
    h = el.offsetHeight;
    const prev = spot.current;
    // Appeared, moved or changed size: its buttons are somewhere new, so a click meant for what was there before is ignored.
    if (!prev || prev.x !== best.x || prev.y !== best.y || prev.w !== w || prev.h !== h || !el.hasAttribute('data-ready')) armClickGuard();
    const controls = spotCost(best.x, best.y, { w, h }, readObstacles(el, vw, vh, { text: false }));
    spot.current = { ...best, w, h, vw, vh, controls };
    el.setAttribute('data-ready', '');
    noteExportPlace();
  };
  /** Where Export is now (the closing line and the export step say so): read whenever the chip looks for its spot. */
  const noteExportPlace = () => {
    const strip = exportOnStrip();
    if (strip !== exportShownRef.current) setExportShown(strip);
  };
  const placeRef = useRef(place);
  placeRef.current = place;

  // Stay out of the way: move only when the window changes or something now sits under the chip.
  const checkRef = useRef<() => void>(() => {});
  /** A placement waiting for the paint (and idle time) to pass; cancelled by the next one. */
  const pendingPlace = useRef<(() => void) | null>(null);
  /** A second look a moment after placing: some views measure themselves after their first paint. */
  const recheck = useRef(0);
  const placeSoon = () => {
    pendingPlace.current?.();
    pendingPlace.current = afterPaint(() => {
      pendingPlace.current = null;
      placeRef.current();
      window.clearTimeout(recheck.current);
      recheck.current = window.setTimeout(() => checkRef.current(), RECHECK_MS);
    });
  };

  // The view or a mode changed: the chip leaves the old view's spot at once (nothing is measured
  // now) and finds its new spot after the new view has painted.
  const layoutKey = `${onScreen}|${padMode}|${uiMode}`;
  const lastLayoutKey = useRef(layoutKey);
  useEffect(() => {
    if (lastLayoutKey.current !== layoutKey) {
      lastLayoutKey.current = layoutKey;
      chipRef.current?.removeAttribute('data-ready');
      spot.current = null;
    }
    // New words (or a new view) change the chip's size and its buttons' places at once: a click meant for what was there is ignored.
    armClickGuard();
    placeSoon();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wordsKey, layoutKey]);
  useEffect(
    () => () => {
      pendingPlace.current?.();
      window.clearTimeout(recheck.current);
    },
    [],
  );

  useEffect(() => {
    /** A check waiting for idle time (never in the frame of a click, a view change or a drag). */
    let pending: (() => void) | null = null;
    const check = () => {
      pending = null;
      const el = chipRef.current;
      const s = spot.current;
      if (!el || pressed.current || modalOpen()) return;
      // Hidden for want of room: look again now and then, not on every check.
      if (!s) return performance.now() - noRoomAt.current < NO_ROOM_RETRY_MS ? undefined : placeRef.current();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      if (vw !== s.vw || vh !== s.vh) return placeRef.current();
      // Cheap: controls, headings, status lines and readouts only (no line-by-line text).
      const cost = spotCost(s.x, s.y, { w: el.offsetWidth, h: el.offsetHeight }, readObstacles(el, vw, vh, { text: false }));
      if (cost > s.controls + FREE) placeRef.current();
    };
    checkRef.current = check;
    const soon = () => {
      if (!pending) pending = afterPaint(check);
    };
    // A press may start a drag: hold still until it ends, then look again.
    const onDown = () => {
      pressed.current = true;
    };
    const onUp = () => {
      if (!pressed.current) return;
      pressed.current = false;
      soon();
    };
    // A move with no button down means the press is over (its release went elsewhere).
    const onMove = (e: PointerEvent) => {
      if (pressed.current && e.buttons === 0) onUp();
    };
    window.addEventListener('resize', soon);
    window.addEventListener('scroll', soon, { capture: true, passive: true });
    document.addEventListener('pointerdown', onDown, { capture: true, passive: true });
    window.addEventListener('pointerup', onUp, { capture: true, passive: true });
    window.addEventListener('pointercancel', onUp, { capture: true, passive: true });
    window.addEventListener('click', onUp, { capture: true, passive: true });
    window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    window.addEventListener('blur', onUp);
    // A view that mounts part of itself later (Mix's mastering panel after its first frame): look again once it is in.
    // Only new elements count: readings that change their words (Mix's loudness, several times a second) do not.
    const main = document.querySelector('main');
    const added = (records: MutationRecord[]) => records.some((r) => [...r.addedNodes].some((n) => n.nodeType === Node.ELEMENT_NODE));
    const mo = main && typeof MutationObserver !== 'undefined' ? new MutationObserver((records) => added(records) && soon()) : null;
    mo?.observe(main!, { childList: true, subtree: true });
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') soon();
    }, CHECK_MS);
    return () => {
      window.removeEventListener('resize', soon);
      window.removeEventListener('scroll', soon, { capture: true });
      document.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointerup', onUp, { capture: true });
      window.removeEventListener('pointercancel', onUp, { capture: true });
      window.removeEventListener('click', onUp, { capture: true });
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('blur', onUp);
      mo?.disconnect();
      window.clearInterval(timer);
      pending?.();
    };
  }, []);

  // Another part selected: its name (in the Shape heading, say) may now run under the chip. Check after it has laid out.
  useEffect(() => afterPaint(() => checkRef.current()), [selectedTrack]);

  /** Ignore pointer clicks right after the chip appeared or moved (keyboard presses have detail 0 and always count). */
  const guardClicks = (e: MouseEvent) => {
    // The click's own time (when the press happened, even if handled late on a busy machine).
    if (e.detail > 0 && (e.timeStamp < clickGuardUntil.current || clickGuardFrames.current > 0)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const next = () => {
    if (!step) return;
    passedOver.current = step.id;
    markHintDone(step.id);
  };
  const hide = () => {
    hideHints();
    notify('Hints are off. To see them again, open Help (the ? key, or Help… in the ⋯ menu) and press “Show hints again”.');
  };
  const goThere = () => {
    if (!go) return;
    setView(go.view);
    if (go.padMode) setPadMode(go.padMode);
  };

  return (
    <>
      <aside
        ref={chipRef}
        className={styles.chip}
        aria-label={step ? `Try this, ${songTrack ? 'song hint' : 'hint'} ${position} of ${total}` : 'Hints'}
        data-hint={step?.id ?? 'finished'}
        data-collapsed={go ? '' : undefined}
        data-done={justDone || undefined}
        onClickCapture={guardClicks}
      >
        <span className={styles.label} aria-hidden="true">
          {justDone ? (
            <span className={styles.doneBadge}>
              <Icon name="check" size={12} /> Done
            </span>
          ) : (
            <span className={styles.kicker}>{step ? 'Try this' : 'All done'}</span>
          )}
          {step && <span className={`${styles.count} mono`}>{`${position}/${total}`}</span>}
        </span>
        <p className={styles.text}>
          {where && <span className={styles.where}>{where} </span>}
          <span className={styles.main}>{text}</span>
          {more && <span className={styles.more}> {more}</span>}
        </p>
        <span className={styles.actions}>
          {go && (
            <Button size="sm" variant="secondary" onClick={goThere}>
              {go.label}
            </Button>
          )}
          {step ? (
            <>
              {!go && (
                <Button size="sm" variant="ghost" iconRight="chevronRight" onClick={next} tip="Pass over this suggestion and show the next one." className={styles.next}>
                  <span className={styles.nextWord}>Next hint</span>
                </Button>
              )}
              <IconButton icon="close" label="Hide hints" size="sm" variant="ghost" onClick={hide} tip="Close the hints. Help (the ? key) shows them again." />
            </>
          ) : (
            <Button size="sm" variant="primary" icon="check" onClick={() => finishHints()}>
              Close hints
            </Button>
          )}
        </span>
      </aside>
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-hints-status="">
        {announce}
      </div>
    </>
  );
}

/**
 * The current view's hint home ([data-hint-home] in the workspace, on
 * screen): where the chip goes first, over the home's own words (a panel's
 * subtitle, an empty strip), lined up with its start, centre or end
 * (data-hint-home="start" | "center" | "end"); `oneLine` when it is a row
 * the chip must keep to (data-hint-one-line). Null when the view has none.
 */
function homeBox(chip: Element, vw: number, vh: number, area: Box): { box: Box; align: 'start' | 'center' | 'end'; oneLine: boolean } | null {
  for (const el of document.querySelectorAll<HTMLElement>('main [data-hint-home]')) {
    if (chip.contains(el) || el.closest('[inert]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.bottom <= area.top || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
    const v = el.dataset.hintHome;
    const box: Box = { left: Math.max(area.left, r.left), top: Math.max(area.top, r.top), right: Math.min(area.right, r.right), bottom: Math.min(area.bottom, r.bottom) };
    return { box, align: v === 'end' || v === 'center' ? v : 'start', oneLine: el.hasAttribute('data-hint-one-line') };
  }
  return null;
}

