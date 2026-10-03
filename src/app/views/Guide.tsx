/**
 * Quick guide: an optional, skippable three-step coach mark that points at
 * (1) Play / Pause in the transport, (2) the pads with their Mute and Solo
 * keys and (3) Change instrument with the big sound knobs.
 *
 * - Non-modal: a teal ring marks the control (it ignores the pointer) and only
 *   the small callout takes pointer events, so playing never stops for it.
 * - The callout sits beside its control and slides along it to the spot that
 *   covers the fewest other controls, and it never covers the transport; step
 *   1 uses a slim strip that fits in the band under the transport, so part
 *   headers and pad tabs stay usable.
 * - "Next" / "Skip guide", step dots with "1 of 3" in text, and Escape skips.
 * - Finishing or skipping is remembered (uiStore guideDone); the Library can
 *   replay it.
 * - Anchors are found by role/name (the Space-key Play button, #pad-surface,
 *   the "<part> macros" group, joined by the Change instrument button above it
 *   when that is on screen). A control scrolled off screen (200 % zoom) is
 *   scrolled into view when its step starts. If one is not on screen (another
 *   view), the callout says where it lives and offers to show the Play view.
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
  armed: boolean;
  padMode: PadMode;
  partName: string;
}

interface StepDef {
  id: 'play' | 'pads' | 'sound';
  title: string;
  body(ctx: StepContext): string;
  find(): HTMLElement | null;
  /** A second control the step also points at (ring and placement cover both), when it is on screen. */
  extend?(): HTMLElement | null;
  /** Where the control is when it is not on screen although the Play view is showing. */
  missingHint: string;
  /** Preferred sides, in order. */
  sides: GuideSide[];
  align: GuideAlign;
  /** 'strip' = one slim row (for a control in a crowded bar), 'card' = a small panel. */
  layout: 'card' | 'strip';
}

/** Callout ↔ control distance (leaves room for the arrow). */
const GAP = 14;
/** Minimum distance from the viewport edge. */
const MARGIN = 12;
/** Ring padding around the control. */
const RING_PAD = 5;
/** Controls the callout should rather not cover. */
const INTERACTIVE = 'button, [role="slider"], [role="tab"], [role="radio"], [role="switch"], input, select, textarea, a[href]';
/** Headings and what a view asks to keep clear (data-hint-avoid: readings, a mode's caption): covered as reluctantly as controls. */
const KEY_TEXT = 'h2, h3, h4, [role="heading"], [data-hint-avoid]';
/** Passing layers above the callout (toasts, tooltips): never a reason to move. */
const PASSING = '[inert], body > [aria-live], [role="tooltip"]';
/**
 * Regions the callout should stay off, weighted per covered pixel: the
 * transport must stay reachable at all times, and the keyboard strip is played.
 */
const ZONES: readonly { selector: string; weight: number }[] = [
  { selector: 'header[aria-label="Transport"]', weight: 40 },
  { selector: 'main ~ footer', weight: 3 },
  // A banner under the transport (a stall, a project open in another tab) says something that must be read.
  { selector: '[data-banners]', weight: 10 },
];

const PAD_TEXT: Record<PadMode, string> = {
  loops: 'Each column is a part. Tap a pad to switch that part to another loop; it joins on the next bar. Mute at the top of a column silences that part, Solo plays it on its own.',
  drums: 'Tap a pad to play that drum sound. The tabs above switch between Loops, Drums, Notes and Steps; Loops has Mute and Solo for every part.',
  notes: "Tap a pad to play a note of the selected part, in the project's key. The tabs above switch modes; Loops has Mute and Solo for every part.",
  steps: 'Click a numbered step to add or remove a note in the selected clip. The tabs above switch modes; Loops has Mute and Solo for every part.',
};

/** The selected part's Change instrument button in the Play view's part panel. */
function findChangeInstrument(): HTMLElement | null {
  const panel = document.querySelector('section[aria-labelledby="part-title"]') ?? document;
  return panel.querySelector<HTMLElement>('button[aria-label^="Change instrument"]');
}

function findPlayButton(): HTMLElement | null {
  const transport = document.querySelector('header[aria-label="Transport"]') ?? document;
  const bySpace = transport.querySelector<HTMLElement>('button[aria-keyshortcuts="Space"]');
  if (bySpace) return bySpace;
  for (const b of document.querySelectorAll<HTMLButtonElement>('button')) {
    const name = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    if (name === 'Play' || name === 'Pause') return b;
  }
  return null;
}

export const GUIDE_STEPS: readonly StepDef[] = [
  {
    id: 'play',
    title: 'Play and pause',
    body: ({ playing, armed }) =>
      playing
        ? 'The groove is playing. Pause it here or with the Space bar; Stop (Shift+Space) goes back to bar 1.'
        : armed
          ? 'Resume the groove here or with the Space bar.'
          : 'Starts and pauses playback (Space bar too). Tap a pad to begin.',
    find: findPlayButton,
    missingHint: 'Play sits in the strip along the top of the screen.',
    sides: ['bottom', 'top', 'right', 'left'],
    align: 'start',
    layout: 'strip',
  },
  {
    id: 'pads',
    title: 'Pads, Mute and Solo',
    body: ({ padMode }) => PAD_TEXT[padMode] ?? PAD_TEXT.loops,
    find: () => document.getElementById('pad-surface'),
    missingHint: 'The pads fill the middle of the Play view.',
    sides: ['right', 'left', 'bottom', 'top', 'over'],
    align: 'end',
    layout: 'card',
  },
  {
    id: 'sound',
    title: 'Change the sound',
    body: ({ partName }) =>
      `Change instrument picks a new sound for ${partName ? `${partName}, the selected part` : 'the selected part'}. The big knobs shape it: Tone for brighter or darker, Space for more room.`,
    find: () => document.querySelector<HTMLElement>('[role="group"][aria-label$=" macros"]'),
    extend: findChangeInstrument,
    missingHint: 'Select a part (tap its name above the pads) to show Change instrument and its knobs.',
    sides: ['bottom', 'left', 'top', 'right', 'over'],
    align: 'start',
    layout: 'card',
  },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export interface PlaceOptions {
  /** How much a callout at this rect would get in the way (e.g. area of controls it covers); lower is better. */
  cost?: (r: { left: number; top: number; right: number; bottom: number }) => number;
  /** Closest the arrow may sit to a callout corner (px). */
  arrowInset?: number;
}

/**
 * Where the callout goes for an anchor rect. Each preferred side where the
 * callout fits is tried; along that side the callout may slide as long as its
 * arrow still points at the anchor. The spot with the lowest `cost` wins (ties
 * go to the earlier side, then to the requested alignment). 'over' (inside the
 * anchor, near its bottom) is the fallback when no side fits.
 */
export function placeCallout(
  a: GuideRect,
  size: { w: number; h: number },
  sides: readonly GuideSide[],
  align: GuideAlign,
  viewport: { w: number; h: number },
  opts: PlaceOptions = {},
): GuidePlacement {
  const inset = opts.arrowInset ?? 22;
  const cost = opts.cost;
  const minX = MARGIN;
  const maxX = viewport.w - MARGIN - size.w;
  const minY = MARGIN;
  const maxY = viewport.h - MARGIN - size.h;
  const alignedX = clamp(align === 'start' ? a.left - 10 : align === 'end' ? a.right + 10 - size.w : a.left + (a.width - size.w) / 2, minX, maxX);
  const alignedY = clamp(align === 'start' ? a.top : align === 'end' ? a.bottom - size.h : a.top + (a.height - size.h) / 2, minY, maxY);

  let best: (GuidePlacement & { score: number; dist: number }) | null = null;
  const consider = (p: GuidePlacement, dist: number) => {
    const score = cost ? cost({ left: p.x, top: p.y, right: p.x + size.w, bottom: p.y + size.h }) : 0;
    // Strictly better only: earlier sides and the requested alignment win ties.
    if (!best || score < best.score - 1 || (Math.abs(score - best.score) <= 1 && dist < best.dist && p.side === best.side)) best = { ...p, score, dist };
  };

  for (const side of sides) {
    if (side === 'over') break;
    if (side === 'bottom' || side === 'top') {
      const y = side === 'bottom' ? a.bottom + GAP : a.top - GAP - size.h;
      if (y < minY || y > maxY) continue;
      const arrowFor = (x: number) => clamp(a.left + a.width / 2 - x, inset, size.w - inset);
      // Slide range: the arrow must stay over the anchor.
      const lo = Math.max(minX, a.left + 6 - (size.w - inset));
      const hi = Math.min(maxX, a.right - 6 - inset);
      const xs = new Set<number>([alignedX]);
      if (cost && lo <= hi) for (let x = lo; x <= hi; x += 8) xs.add(Math.round(x));
      if (cost && lo <= hi) xs.add(Math.round(hi));
      for (const x of xs) if (x >= minX - 0.5 && x <= Math.max(minX, maxX) + 0.5) consider({ x, y, side, arrow: arrowFor(x) }, Math.abs(x - alignedX));
    } else {
      const x = side === 'right' ? a.right + GAP : a.left - GAP - size.w;
      if (x < minX || x > maxX) continue;
      const arrowFor = (y: number) => clamp(a.top + a.height / 2 - y, inset, size.h - inset);
      const lo = Math.max(minY, a.top + 6 - (size.h - inset));
      const hi = Math.min(maxY, a.bottom - 6 - inset);
      const ys = new Set<number>([alignedY]);
      if (cost && lo <= hi) for (let y = lo; y <= hi; y += 8) ys.add(Math.round(y));
      if (cost && lo <= hi) ys.add(Math.round(hi));
      for (const y of ys) if (y >= minY - 0.5 && y <= Math.max(minY, maxY) + 0.5) consider({ x, y, side, arrow: arrowFor(y) }, Math.abs(y - alignedY));
    }
    // Without a cost function the first side that fits is taken.
    if (best && !cost) break;
  }
  if (best) {
    const { x, y, side, arrow } = best as GuidePlacement;
    return { x, y, side, arrow };
  }
  return { x: clamp(a.left + (a.width - size.w) / 2, minX, maxX), y: clamp(a.bottom - size.h - 16, minY, maxY), side: 'over', arrow: null };
}

/** The anchor's rect while any of it is inside the viewport (null when hidden or scrolled away). */
function visibleRect(el: HTMLElement | null, vw: number, vh: number): DOMRect | null {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh ? r : null;
}

/** True when less than half of the anchor (or of the viewport, for a bigger anchor) is on screen. */
function mostlyOffScreen(el: HTMLElement, vw: number, vh: number): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const w = Math.min(r.right, vw) - Math.max(r.left, 0);
  const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
  if (w <= 0 || h <= 0) return true;
  return w * h < 0.5 * Math.min(r.width * r.height, vw * vh);
}

function viewportSize(): { w: number; h: number } {
  return { w: document.documentElement.clientWidth || window.innerWidth, h: document.documentElement.clientHeight || window.innerHeight };
}

/** Both rects together (the smallest rect holding them). */
function unionRect(a: DOMRect, b: DOMRect | null): DOMRect {
  if (!b) return a;
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  return new DOMRect(left, top, Math.max(a.right, b.right) - left, Math.max(a.bottom, b.bottom) - top);
}

/** Area of on-screen controls and headings (outside the guide and the anchors) a rect would cover, plus weighted no-go zones. */
function coverCost(anchors: readonly HTMLElement[], guide: HTMLElement | null): (r: { left: number; top: number; right: number; bottom: number }) => number {
  const rects: { r: DOMRect; weight: number }[] = [];
  const range = document.createRange();
  for (const el of document.querySelectorAll<HTMLElement>(`${INTERACTIVE}, ${KEY_TEXT}`)) {
    if (anchors.some((a) => a.contains(el)) || guide?.contains(el) || el.closest(PASSING) || el.closest('[data-hint-home]') || el.querySelector('[data-hint-home]')) continue;
    // A heading by its words (a wide heading box with a short title leaves the rest of its row free); a control whole.
    const words = !el.matches(INTERACTIVE) && el.matches(KEY_TEXT);
    if (words) range.selectNodeContents(el);
    const r = words ? range.getBoundingClientRect() : el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) rects.push({ r, weight: 1 });
  }
  range.detach();
  for (const z of ZONES) {
    const el = document.querySelector<HTMLElement>(z.selector);
    const r = el?.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) rects.push({ r, weight: z.weight });
  }
  return (c) => {
    let area = 0;
    for (const { r, weight } of rects) {
      const w = Math.min(c.right, r.right) - Math.max(c.left, r.left);
      const h = Math.min(c.bottom, r.bottom) - Math.max(c.top, r.top);
      if (w > 0 && h > 0) area += w * h * weight;
    }
    return area;
  };
}

/**
 * Where the callout waits while its control is not on screen: on the view's
 * hint home ([data-hint-home], e.g. Mix's header line) when that covers
 * nothing, else the spot below the top chrome (transport, banners) that
 * covers the fewest controls and headings, the first of equals nearest the
 * top (a 16 px grid).
 */
function placeAside(size: { w: number; h: number }, vw: number, vh: number, cost: (r: { left: number; top: number; right: number; bottom: number }) => number): GuidePlacement {
  let top = MARGIN;
  for (const sel of ['header[aria-label="Transport"]', '[data-banners]']) {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    if (r && r.height > 0 && r.bottom > 0) top = Math.max(top, r.bottom + GAP);
  }
  const maxX = Math.max(MARGIN, vw - MARGIN - size.w);
  const maxY = Math.max(top, vh - MARGIN - size.h);
  const at = (x: number, y: number): GuidePlacement => ({ x: Math.round(x), y: Math.round(y), side: 'over', arrow: null });
  const costAt = (x: number, y: number) => cost({ left: x, top: y, right: x + size.w, bottom: y + size.h });
  const home = [...document.querySelectorAll<HTMLElement>('main [data-hint-home]')].map((el) => el.getBoundingClientRect()).find((r) => r.width > 1 && r.bottom > top && r.top < vh);
  if (home) {
    const x = clamp(home.left, MARGIN, maxX);
    const y = clamp((home.top + home.bottom - size.h) / 2, top, maxY);
    if (costAt(x, y) < 1) return at(x, y);
  }
  let best: { x: number; y: number; c: number } | null = null;
  for (let y = top; ; y += 16) {
    const yy = Math.min(y, maxY);
    for (let x = MARGIN; ; x += 16) {
      const xx = Math.min(x, maxX);
      const c = costAt(xx, yy);
      if (c < 1) return at(xx, yy);
      if (!best || c < best.c) best = { x: xx, y: yy, c };
      if (xx >= maxX) break;
    }
    if (yy >= maxY) break;
  }
  return at(best!.x, best!.y);
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
  /** Give keyboard focus to Next once the callout is on screen (after Jump In). */
  focusNext?: boolean;
}

export function Guide(props: GuideProps) {
  if (!props.open) return null;
  return <GuideCoach onClose={props.onClose} focusNext={props.focusNext} />;
}

function GuideCoach({ onClose, focusNext }: { onClose(): void; focusNext?: boolean }) {
  const nextRef = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const [step, setStep] = useState(0);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [missing, setMissing] = useState(false);
  // Moves between steps glide; the very first placement does not fly in from the corner.
  const [settled, setSettled] = useState(false);
  const calloutRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const titleId = useId();
  const bodyId = useId();

  const playing = useRuntime((s) => s.playing);
  const armed = useRuntime((s) => Object.values(s.tracks).some((t) => t.playingSlot !== null));
  const padMode = useUi((s) => s.padMode);
  const view = useUi((s) => s.view);
  const trackId = useUi((s) => s.selectedTrackId);
  const partName = useProject((p) => p.tracks.find((t) => t.id === trackId)?.name ?? '');

  const def = GUIDE_STEPS[step];
  const body = def.body({ playing, armed, padMode, partName });
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

  /** Inputs of the last placement: the periodic check skips the (costlier) placement when nothing moved. */
  const lastInputs = useRef('');
  const measure = useCallback(
    (force = true) => {
      const el = calloutRef.current;
      if (!el) return;
      const { w: vw, h: vh } = viewportSize();
      const size = { w: el.offsetWidth, h: el.offsetHeight };
      const s = GUIDE_STEPS[step];
      // The guide is the Play view's tour: in another view its control counts as not on screen (Play / Pause too), and
      // the callout waits out of the way there, offering to show the Play view.
      const anchor = view === 'play' ? s.find() : null;
      const extra = anchor ? (s.extend?.() ?? null) : null;
      const own = visibleRect(anchor, vw, vh);
      const r = own ? unionRect(own, visibleRect(extra, vw, vh)) : null;
      // A banner appearing under the transport (a stall, a project open in another tab) brings keys the callout must not cover.
      const banners = Math.round(document.querySelector('[data-banners]')?.getBoundingClientRect().height ?? 0);
      // The view on screen (the shell's heading names it; a new view mounts a moment after its tab is chosen): where the
      // callout waits in another view depends on that view's layout.
      const shown = r ? '' : (document.querySelector('main h1')?.textContent ?? '');
      const inputs = [step, vw, vh, size.w, size.h, banners, shown, r ? [r.left, r.top, r.width, r.height].map(Math.round).join(',') : '-'].join('|');
      if (!force && inputs === lastInputs.current) return;
      lastInputs.current = inputs;
      let next: Layout;
      if (anchor && r) {
        const p = placeCallout(r, size, s.sides, s.align, { w: vw, h: vh }, { cost: coverCost(extra ? [anchor, extra] : [anchor], el), arrowInset: s.layout === 'strip' ? 16 : 22 });
        const left = Math.max(2, r.left - RING_PAD);
        const top = Math.max(2, r.top - RING_PAD);
        const ring = { left, top, width: Math.min(vw - 2, r.right + RING_PAD) - left, height: Math.min(vh - 2, r.bottom + RING_PAD) - top };
        next = { ...p, ring };
      } else {
        next = { ...placeAside(size, vw, vh, coverCost([], el)), ring: null };
      }
      setMissing(!r);
      setLayout((prev) => (sameLayout(prev, next) ? prev : next));
    },
    [step, view],
  );

  // Bring the control on screen when its step starts (the page scrolls at 200 % zoom or in small windows).
  useLayoutEffect(() => {
    const anchor = GUIDE_STEPS[step].find();
    const { w, h } = viewportSize();
    if (anchor && mostlyOffScreen(anchor, w, h)) anchor.scrollIntoView({ block: 'center', inline: 'center' });
  }, [step, view]);

  // Place before paint whenever the step, its text or the view changes.
  useLayoutEffect(() => {
    measure();
  }, [measure, body, view, padMode, missing]);

  // Keyboard focus to Next once the callout is placed (it is hidden until then, and hidden keys take no focus).
  useEffect(() => {
    if (!focusNext || !layout || focused.current) return;
    focused.current = true;
    const raf = requestAnimationFrame(() => nextRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, [focusNext, layout]);

  useEffect(() => {
    if (!layout || settled) return;
    const id = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(id);
  }, [layout, settled]);

  // Follow layout changes (window size, scrolling, banners, panels) without per-frame work at rest:
  // the periodic check only re-places the callout when the control, the window or the callout moved.
  useEffect(() => {
    let raf = 0;
    const onMove = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure(false);
      });
    };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, { capture: true, passive: true });
    const timer = window.setInterval(() => measure(false), 400);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, { capture: true });
      window.clearInterval(timer);
      cancelAnimationFrame(raf);
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
        data-layout={missing ? (view === 'play' ? 'card' : 'waiting') : def.layout}
        data-side={layout?.side ?? 'over'}
        data-ready={layout ? true : undefined}
        data-settled={settled || undefined}
        style={{ left: layout?.x ?? 0, top: layout?.y ?? 0 }}
      >
        {arrowStyle && <span className={styles.arrow} style={arrowStyle} aria-hidden="true" />}
        <span className={styles.kickerLabel}>Quick guide</span>
        <span className={`${styles.stepCount} mono`}>
          {step + 1} of {GUIDE_STEPS.length}
        </span>
        <ol className={styles.dots} aria-hidden="true">
          {GUIDE_STEPS.map((s, i) => (
            <li key={s.id} className={styles.dot} data-state={i < step ? 'done' : i === step ? 'current' : 'next'} />
          ))}
        </ol>
        <span className={styles.divider} aria-hidden="true" />
        <div id={titleId} className={styles.title}>
          {def.title}
        </div>
        <p id={bodyId} className={styles.body} aria-live="polite">
          {body}
        </p>
        {missing && (
          <div className={styles.missing}>
            {view === 'play' ? (
              <span>{def.missingHint}</span>
            ) : (
              <>
                <span>This is on the Play view.</span>
                <Button size="sm" variant="secondary" onClick={() => setView('play')}>
                  Show the Play view
                </Button>
              </>
            )}
          </div>
        )}
        <div className={styles.buttons}>
          {!last && (
            <Button size="sm" variant="ghost" onClick={finish} aria-keyshortcuts="Escape" className={styles.skip}>
              Skip guide
            </Button>
          )}
          {/* On the Play step ("Pause it here or with the Space bar") Space plays and pauses even with Next focused; Enter presses Next. */}
          <Button ref={nextRef} size="sm" variant="primary" iconRight={last ? 'check' : 'chevronRight'} onClick={next} data-guide-next="" data-space-plays={def.id === 'play' ? '' : undefined}>
            {last ? 'Done' : 'Next'}
          </Button>
        </div>
      </div>
    </>
  );
}
