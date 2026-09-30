/**
 * Quick guide: an optional, skippable three-step coach mark that points at
 * (1) Play/Stop in the transport, (2) the pads and (3) the sound controls.
 *
 * - Non-modal: a teal ring marks the control (it ignores the pointer) and only
 *   the small callout takes pointer events, so playing never stops for it.
 *   The callout is placed beside the control, not over the pads.
 * - "Next" / "Skip guide", step dots with "1 of 3" in text, and Escape skips.
 * - Finishing or skipping is remembered (uiStore guideDone); the Library can
 *   replay it.
 * - Anchors are found by role/name (the Space-key Play button, #pad-surface,
 *   the "<part> macros" group). If one is not on screen (another view), the
 *   callout says where it lives and offers to show the Play view.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button, isTypingTarget } from '../../ui/components';
import { setGuideDone, setView, type PadMode } from '../../state/uiStore';
import { useProject, useUi } from '../instance';
import { useRuntime } from '../runtime';
import styles from './Guide.module.css';

export type GuideSide = 'top' | 'bottom' | 'left' | 'right' | 'over';
export type GuideAlign = 'start' | 'center' | 'end';

export interface GuideRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface GuidePlacement {
  x: number;
  y: number;
  /** Side of the anchor the callout sits on ('over' = inside it, no arrow). */
  side: GuideSide;
  /** Arrow offset along the callout edge that faces the anchor (px), or null. */
  arrow: number | null;
}

interface StepContext {
  playing: boolean;
  padMode: PadMode;
  partName: string;
}

interface StepDef {
  id: 'play' | 'pads' | 'sound';
  title: string;
  body(ctx: StepContext): string;
  find(): HTMLElement | null;
  /** Preferred sides, in order; the first that fits the viewport wins. */
  sides: GuideSide[];
  align: GuideAlign;
}

/** Callout ↔ control distance (leaves room for the arrow). */
const GAP = 14;
/** Minimum distance from the viewport edge. */
const MARGIN = 12;
/** Arrow never closer than this to a callout corner. */
const ARROW_INSET = 22;
/** Ring padding around the control. */
const RING_PAD = 5;

const PAD_TEXT: Record<PadMode, string> = {
  loops: 'Each column is a part, each row a variation. Lit pads are playing — tap another and it joins on the next bar. The buttons on the right launch a whole row.',
  drums: 'Tap a pad to play that drum sound. The tabs above switch the pads between loops, drums, notes and steps.',
  notes: "Tap a pad to play a note of the selected part, laid out in the project's key. The tabs above switch between loops, drums, notes and steps.",
  steps: 'Click a numbered step to add or remove a note in the selected clip. The tabs above switch between loops, drums, notes and steps.',
};

function findPlayButton(): HTMLElement | null {
  const transport = document.querySelector('header[aria-label="Transport"]') ?? document;
  const bySpace = transport.querySelector<HTMLElement>('button[aria-keyshortcuts="Space"]');
  if (bySpace) return bySpace;
  for (const b of document.querySelectorAll<HTMLButtonElement>('button')) {
    const name = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    if (name === 'Play' || name === 'Stop') return b;
  }
  return null;
}

export const GUIDE_STEPS: readonly StepDef[] = [
  {
    id: 'play',
    title: 'Play and stop',
    body: ({ playing }) =>
      playing
        ? 'The groove is playing. Press Stop — or the Space bar — to pause it, and Play to start again.'
        : 'Press Play — or the Space bar — to start the lit clips. Press it again to stop.',
    find: findPlayButton,
    sides: ['bottom', 'top', 'right', 'left'],
    align: 'start',
  },
  {
    id: 'pads',
    title: 'The pads',
    body: ({ padMode }) => PAD_TEXT[padMode] ?? PAD_TEXT.loops,
    find: () => document.getElementById('pad-surface'),
    sides: ['right', 'left', 'bottom', 'top', 'over'],
    align: 'end',
  },
  {
    id: 'sound',
    title: 'Sound controls',
    body: ({ partName }) =>
      `These six knobs shape ${partName ? `${partName}, the selected part` : 'the selected part'}. Turn Tone for a brighter or darker sound and Space for more room around it. Tap another part's name or pads to shape that part.`,
    find: () => document.querySelector<HTMLElement>('[role="group"][aria-label$=" macros"]'),
    sides: ['bottom', 'left', 'top', 'right', 'over'],
    align: 'start',
  },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Where the callout goes for an anchor rect: the first preferred side where it
 * fits inside the viewport, aligned along that side, kept on screen; 'over'
 * (inside the anchor, near its bottom) when no side fits.
 */
export function placeCallout(a: GuideRect, size: { w: number; h: number }, sides: readonly GuideSide[], align: GuideAlign, viewport: { w: number; h: number }): GuidePlacement {
  const clampX = (x: number) => clamp(x, MARGIN, viewport.w - MARGIN - size.w);
  const clampY = (y: number) => clamp(y, MARGIN, viewport.h - MARGIN - size.h);
  const alongX = () => (align === 'start' ? a.left - 10 : align === 'end' ? a.right + 10 - size.w : a.left + (a.width - size.w) / 2);
  const alongY = () => (align === 'start' ? a.top : align === 'end' ? a.bottom - size.h : a.top + (a.height - size.h) / 2);
  for (const side of sides) {
    if (side === 'bottom' || side === 'top') {
      const y = side === 'bottom' ? a.bottom + GAP : a.top - GAP - size.h;
      if (y < MARGIN || y + size.h > viewport.h - MARGIN) continue;
      const x = clampX(alongX());
      return { x, y, side, arrow: clamp(a.left + a.width / 2 - x, ARROW_INSET, size.w - ARROW_INSET) };
    }
    if (side === 'right' || side === 'left') {
      const x = side === 'right' ? a.right + GAP : a.left - GAP - size.w;
      if (x < MARGIN || x + size.w > viewport.w - MARGIN) continue;
      const y = clampY(alongY());
      return { x, y, side, arrow: clamp(a.top + a.height / 2 - y, ARROW_INSET, size.h - ARROW_INSET) };
    }
    if (side === 'over') break;
  }
  return { x: clampX(a.left + (a.width - size.w) / 2), y: clampY(a.bottom - size.h - 16), side: 'over', arrow: null };
}

function visibleRect(el: HTMLElement | null): DOMRect | null {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

interface Layout extends GuidePlacement {
  ring: { left: number; top: number; width: number; height: number } | null;
}

function sameLayout(a: Layout | null, b: Layout): boolean {
  if (!a) return false;
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5;
  const ringSame = a.ring === b.ring || (!!a.ring && !!b.ring && near(a.ring.left, b.ring.left) && near(a.ring.top, b.ring.top) && near(a.ring.width, b.ring.width) && near(a.ring.height, b.ring.height));
  return near(a.x, b.x) && near(a.y, b.y) && a.side === b.side && a.arrow === b.arrow && ringSame;
}

export interface GuideProps {
  open: boolean;
  /** The guide ended (finished or skipped); completion is already remembered. */
  onClose(): void;
}

export function Guide(props: GuideProps) {
  if (!props.open) return null;
  return <GuideCoach onClose={props.onClose} />;
}

function GuideCoach({ onClose }: { onClose(): void }) {
  const [step, setStep] = useState(0);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [missing, setMissing] = useState(false);
  const calloutRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const titleId = useId();
  const bodyId = useId();

  const playing = useRuntime((s) => s.playing);
  const padMode = useUi((s) => s.padMode);
  const view = useUi((s) => s.view);
  const trackId = useUi((s) => s.selectedTrackId);
  const partName = useProject((p) => p.tracks.find((t) => t.id === trackId)?.name ?? '');

  const def = GUIDE_STEPS[step];
  const body = def.body({ playing, padMode, partName });
  const last = step === GUIDE_STEPS.length - 1;

  const finish = useCallback(() => {
    setGuideDone(true);
    onCloseRef.current();
  }, []);
  const next = () => {
    if (last) finish();
    else setStep((s) => Math.min(s + 1, GUIDE_STEPS.length - 1));
  };

  // All three controls live in the Play view.
  useEffect(() => {
    setView('play');
  }, []);

  const measure = useCallback(() => {
    const el = calloutRef.current;
    if (!el) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const size = { w: el.offsetWidth, h: el.offsetHeight };
    const r = visibleRect(GUIDE_STEPS[step].find());
    let next: Layout;
    if (r) {
      const p = placeCallout(r, size, GUIDE_STEPS[step].sides, GUIDE_STEPS[step].align, { w: vw, h: vh });
      const left = Math.max(2, r.left - RING_PAD);
      const top = Math.max(2, r.top - RING_PAD);
      const ring = { left, top, width: Math.min(vw - 2, r.right + RING_PAD) - left, height: Math.min(vh - 2, r.bottom + RING_PAD) - top };
      next = { ...p, ring };
    } else {
      next = { x: clamp((vw - size.w) / 2, MARGIN, vw - MARGIN - size.w), y: clamp(vh - size.h - 124, MARGIN, vh - MARGIN - size.h), side: 'over', arrow: null, ring: null };
    }
    setMissing(!r);
    setLayout((prev) => (sameLayout(prev, next) ? prev : next));
  }, [step]);

  // Place before paint whenever the step, its text or the view changes.
  useLayoutEffect(() => {
    measure();
  }, [measure, body, view, padMode, missing]);

  // Follow layout changes (window size, banners, panels) without per-frame work.
  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    const timer = window.setInterval(measure, 400);
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearInterval(timer);
    };
  }, [measure]);

  // Escape skips the guide unless something else used it (a menu, a text field, a dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.repeat || isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')) return;
      e.preventDefault();
      finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finish]);

  const arrowStyle =
    layout?.arrow == null ? undefined : layout.side === 'top' || layout.side === 'bottom' ? { left: layout.arrow } : { top: layout.arrow };

  return (
    <>
      {layout?.ring && !missing && (
        <div
          key={`ring-${step}`}
          className={styles.ring}
          style={{ left: layout.ring.left, top: layout.ring.top, width: layout.ring.width, height: layout.ring.height }}
          data-guide-ring={def.id}
          aria-hidden="true"
        />
      )}
      <div
        ref={calloutRef}
        className={styles.callout}
        role="dialog"
        aria-modal="false"
        aria-label={`Quick guide, step ${step + 1} of ${GUIDE_STEPS.length}: ${def.title}`}
        aria-describedby={bodyId}
        data-guide-step={def.id}
        data-side={layout?.side ?? 'over'}
        data-ready={layout ? true : undefined}
        style={{ left: layout?.x ?? 0, top: layout?.y ?? 0 }}
      >
        {arrowStyle && <span className={styles.arrow} style={arrowStyle} aria-hidden="true" />}
        <div className={styles.kicker}>
          <span className={styles.kickerLabel}>Quick guide</span>
          <span className={`${styles.stepCount} mono`}>
            {step + 1} of {GUIDE_STEPS.length}
          </span>
        </div>
        <div id={titleId} className={styles.title}>
          {def.title}
        </div>
        <p id={bodyId} className={styles.body} aria-live="polite">
          {body}
        </p>
        {missing && (
          <div className={styles.missing}>
            <span>This is on the Play view.</span>
            <Button size="sm" variant="secondary" onClick={() => setView('play')}>
              Show the Play view
            </Button>
          </div>
        )}
        <div className={styles.footer}>
          <ol className={styles.dots} aria-hidden="true">
            {GUIDE_STEPS.map((s, i) => (
              <li key={s.id} className={styles.dot} data-state={i < step ? 'done' : i === step ? 'current' : 'next'} />
            ))}
          </ol>
          {!last && (
            <Button size="sm" variant="ghost" onClick={finish} aria-keyshortcuts="Escape" className={styles.skip}>
              Skip guide
            </Button>
          )}
          <Button size="sm" variant="primary" iconRight={last ? 'check' : 'chevronRight'} onClick={next}>
            {last ? 'Done' : 'Next'}
          </Button>
        </div>
      </div>
    </>
  );
}
