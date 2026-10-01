/**
 * "Try this" hints: after Jump In, a small chip suggests one next action at a
 * time (tap a pad, Mute, drag a clip, Tone, Change instrument, mastering,
 * record) and moves on when the person does it, detected from the real state
 * (tracker.ts).
 *
 * - Never blocks anything: it is not a dialog, takes no focus, and sits in a
 *   free spot of the workspace (placement.ts), never over the transport, the
 *   pads or the keyboard. It moves only when something would end up under it.
 * - Shown only while Tips are on; "Hide hints" closes it (remembered), and
 *   the Project library's "Show hints again" starts it over.
 * - Screen readers hear each new suggestion through a polite status message.
 * - A step that needs another view offers a button that goes there.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Icon, IconButton } from '../../../ui/components';
import { setPadMode, setView } from '../../../state/uiStore';
import { shallowEqual, useStore } from '../../../state/store';
import { session, useProject, useUi } from '../../instance';
import { notify, runtimeStore, useRuntime } from '../../runtime';
import { finishHints, hideHints, hintsRunning, hintsStore, markHintDone, type HintId } from './hintsState';
import { HINT_STEPS, HINTS_FINISHED_TEXT, bassPart, currentHint, drumsPart, type HintContext } from './steps';
import { findSpot, readObstacles, spotCost, workArea, type Spot } from './placement';
import { watchHints } from './tracker';
import styles from './Hints.module.css';

/**
 * Layouts tried in turn until one finds a free spot: one row (the suggestion
 * wrapping in its column when narrower), compact (without the second
 * sentence), and stacked (buttons beside the label, the suggestion below).
 */
interface Layout {
  maxW: number;
  compact: boolean;
  stack: boolean;
}
const LAYOUTS: readonly Layout[] = [
  { maxW: 700, compact: false, stack: false },
  { maxW: 700, compact: true, stack: false },
  { maxW: 560, compact: false, stack: false },
  { maxW: 560, compact: true, stack: false },
  { maxW: 440, compact: false, stack: true },
  { maxW: 440, compact: true, stack: true },
  { maxW: 340, compact: true, stack: true },
];

function applyLayout(el: HTMLElement, layout: Layout, maxW: number): void {
  el.style.maxWidth = `${maxW}px`;
  el.toggleAttribute('data-compact', layout.compact);
  el.toggleAttribute('data-stack', layout.stack);
}
/** How long "Done" shows after a step is done. */
const DONE_MS = 1800;
/** How often the chip checks that nothing has moved under it. */
const CHECK_MS = 600;

export interface HintsProps {
  /** False while something else has the stage (the Welcome card, the quick guide). */
  active: boolean;
}

export function Hints({ active }: HintsProps) {
  const hints = useStore(hintsStore, (s) => s);
  const tips = useUi((s) => s.tipsEnabled);
  const running = hintsRunning(hints);

  // Progress is tracked whenever hints are on, even while the guide or a dialog is showing.
  useEffect(() => {
    if (!running) return;
    return watchHints({ project: session.store, history: session.store.info, runtime: runtimeStore }, (id) => markHintDone(id));
  }, [running]);

  if (!active || !tips || !running) return null;
  return <HintChip done={hints.done} />;
}

function HintChip({ done }: { done: readonly HintId[] }) {
  const view = useUi((s) => s.view);
  const padMode = useUi((s) => s.padMode);
  const uiMode = useUi((s) => s.uiMode);
  const parts = useProject(
    (p) => {
      const drums = drumsPart(p);
      return { bassName: bassPart(p)?.name ?? null, drumsName: drums?.name ?? null, drumsMuted: drums?.mute ?? false };
    },
    shallowEqual,
  );
  const recording = useRuntime((s) => s.recording === 'performance');
  const ctx: HintContext = { view, padMode, recording, ...parts };

  const current = currentHint(done, ctx);
  const steps = useMemo(() => HINT_STEPS.filter((s) => !s.available || s.available(ctx)), [ctx.bassName, ctx.drumsName]); // eslint-disable-line react-hooks/exhaustive-deps
  const step = current?.step ?? null;
  const text = step ? step.text(ctx) : HINTS_FINISHED_TEXT;
  const more = step?.more?.(ctx) ?? null;
  const here = step ? step.here(ctx) : true;
  const go = step && !here ? (step.go ?? null) : null;
  const position = step ? steps.findIndex((s) => s.id === step.id) + 1 : steps.length;

  // "Done" for a moment when the previous suggestion was done (not passed over with Next hint).
  const [justDone, setJustDone] = useState(false);
  const shown = useRef<HintId | null>(step?.id ?? null);
  const passedOver = useRef<HintId | null>(null);
  // Starts empty and is filled after mounting, so screen readers announce the first suggestion too.
  const [announce, setAnnounce] = useState('');
  // Its own timer: a text change meanwhile (another view, Mute pressed) must not keep "Done" up.
  const doneTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(doneTimer.current), []);
  useEffect(() => {
    const prev = shown.current;
    shown.current = step?.id ?? null;
    if (prev === (step?.id ?? null)) {
      setAnnounce(step ? `Try this: ${text}` : text);
      return;
    }
    const completed = prev !== null && done.includes(prev) && passedOver.current !== prev;
    passedOver.current = null;
    setAnnounce(completed ? (step ? `Done. Next, try this: ${text}` : `Done. ${text}`) : step ? `Try this: ${text}` : text);
    window.clearTimeout(doneTimer.current);
    setJustDone(completed);
    if (completed) doneTimer.current = window.setTimeout(() => setJustDone(false), DONE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id, text]);

  const chipRef = useRef<HTMLElement>(null);
  /** Where the chip is, and what it covered there counting controls only (for the quick check). */
  const spot = useRef<(Spot & { vw: number; vh: number; controls: number }) | null>(null);
  const [ready, setReady] = useState(false);

  /**
   * Find the best spot and move there. Size and layout are set on the element
   * directly (React does not manage them), so measuring each layout needs no
   * re-render.
   */
  const place = () => {
    const el = chipRef.current;
    if (!el) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const area = workArea(vw, vh);
    const obstacles = readObstacles(el, vw, vh);
    let best: (Spot & { maxW: number; layout: Layout }) | null = null;
    for (const layout of LAYOUTS) {
      const maxW = Math.min(layout.maxW, area.right - area.left);
      applyLayout(el, layout, maxW);
      const s = findSpot({ w: el.offsetWidth, h: el.offsetHeight }, area, obstacles);
      if (!best || s.cost < best.cost) best = { ...s, maxW, layout };
      if (s.cost <= 0.5) break;
    }
    if (!best) return;
    applyLayout(el, best.layout, best.maxW);
    el.style.left = `${best.x}px`;
    el.style.top = `${best.y}px`;
    const controls = spotCost(best.x, best.y, { w: el.offsetWidth, h: el.offsetHeight }, readObstacles(el, vw, vh, { text: false }));
    spot.current = { ...best, vw, vh, controls };
    setReady(true);
  };

  // Stay out of the way: move only when the window changes or something now sits under the chip.
  const checkRef = useRef<() => void>(() => {});
  // Place before paint whenever what it says or the screen behind it changes; check again once a
  // newly shown view has finished laying itself out (some views measure themselves after the first paint).
  useLayoutEffect(() => {
    place();
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => checkRef.current());
    });
    const timer = window.setTimeout(() => checkRef.current(), 250);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [text, more, go?.label, step?.id, view, padMode, uiMode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      const el = chipRef.current;
      const s = spot.current;
      if (!el || !s) return place();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      if (vw !== s.vw || vh !== s.vh) return place();
      // Cheap: controls only (a few milliseconds less than reading every line of text on the page).
      const cost = spotCost(s.x, s.y, { w: el.offsetWidth, h: el.offsetHeight }, readObstacles(el, vw, vh, { text: false }));
      if (cost > s.controls + 0.5) place();
    };
    checkRef.current = check;
    const soon = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    window.addEventListener('resize', soon);
    window.addEventListener('scroll', soon, { capture: true, passive: true });
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') soon();
    }, CHECK_MS);
    return () => {
      window.removeEventListener('resize', soon);
      window.removeEventListener('scroll', soon, { capture: true });
      window.clearInterval(timer);
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const next = () => {
    if (!step) return;
    passedOver.current = step.id;
    markHintDone(step.id);
  };
  const hide = () => {
    hideHints();
    notify('Hints are off. To see them again, open Projects (the folder button at the top right, or More → Projects…) and press “Show hints again”.');
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
        aria-label={step ? `Try this, hint ${position} of ${steps.length}` : 'Hints'}
        data-hint={step?.id ?? 'finished'}
        data-ready={ready || undefined}
        data-done={justDone || undefined}
      >
        <span className={styles.label} aria-hidden="true">
          {justDone ? (
            <span className={styles.doneBadge}>
              <Icon name="check" size={12} /> Done
            </span>
          ) : (
            <span className={styles.kicker}>{step ? 'Try this' : 'All done'}</span>
          )}
          {step && <span className={`${styles.count} mono`}>{`${position}/${steps.length}`}</span>}
        </span>
        <p className={styles.text}>
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
              <Button size="sm" variant="ghost" iconRight="chevronRight" onClick={next} tip="Pass over this suggestion and show the next one.">
                Next hint
              </Button>
              <IconButton icon="close" label="Hide hints" size="sm" variant="ghost" onClick={hide} tip="Close the hints. Show them again from your projects (Show hints again)." />
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
