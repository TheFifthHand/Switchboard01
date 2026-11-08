/**
 * Motion helpers: FLIP moves and settles with the Web Animations API.
 *
 * Shared by gestures that move things on screen (the Loops pads and scene
 * rows today; meant for the song lane too). The rules they keep, from
 * docs/OMNI_UX.md:
 * - Only `transform` (and, where a caller asks, `opacity`) animates, so the
 *   compositor can run it while the main thread is busy.
 * - With *reduce motion* (`prefers-reduced-motion: reduce`) nothing animates:
 *   every helper returns null at once and things are simply where they belong.
 * - No layout reads unless the caller leaves a box out: a gesture that cached
 *   its geometry when it started passes the boxes it already knows.
 *
 * FLIP, for an element whose place in the layout just changed (or that should
 * look as if it came from somewhere): **F**irst — where it was (a Box, in
 * viewport pixels); **L**ast — where layout puts it now; **I**nvert — a
 * transform that draws it at First again; **P**lay — animate that transform
 * away. The element really is at Last the whole time (clicks, focus and
 * hit-testing are right at once); only its picture travels.
 *
 * ```ts
 * const first = boxOf(el);           // before the change
 * commitTheChange();                 // React re-renders (flushSync) …
 * flip(el, first, { easing: MOTION.spring });
 * ```
 *
 * Elements are assumed to use the default `transform-origin` (their centre).
 */

/** A rectangle in viewport (client) pixels. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A light, critically-tuned spring as a `linear()` easing: it overshoots by a
 * few per cent and comes to rest by the end of the duration. `damping` is the
 * damping ratio (1 = no overshoot); browsers without `linear()` get a
 * cubic-bezier with a similar small overshoot.
 */
export function springEasing(damping = 0.72, samples = 28): string {
  const fallback = 'cubic-bezier(0.3, 1.28, 0.5, 1)';
  try {
    if (typeof CSS === 'undefined' || !CSS.supports('transition-timing-function', 'linear(0, 0.5, 1)')) return fallback;
  } catch {
    return fallback;
  }
  const z = Math.min(0.99, Math.max(0.3, damping));
  // Rest (within about 1 %) at t = 1: e^(-z w) = 0.01.
  const w = 4.6 / z;
  const wd = w * Math.sqrt(1 - z * z);
  const pts: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const x = i === samples ? 1 : 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
    pts.push(String(Math.round(x * 10000) / 10000));
  }
  return `linear(${pts.join(', ')})`;
}

export const MOTION = {
  /** A dropped thing springing into place (180–220 ms reads as one quick, physical move). */
  settleMs: 200,
  /** Neighbours sliding aside to make room, or sliding back. */
  slideMs: 170,
  /** Ease-out for slides: quick start, soft landing. */
  ease: 'cubic-bezier(0.2, 0.8, 0.25, 1)',
  /** The settle: a small overshoot, then rest. */
  spring: springEasing(),
} as const;

const REDUCE = '(prefers-reduced-motion: reduce)';

/** The person asked for less motion (operating-system setting). */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCE).matches;
  } catch {
    return false;
  }
}

/** The element's box now (one layout read). */
export function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** `box` moved by (dx, dy). */
export function offsetBox(box: Box, dx: number, dy: number): Box {
  return { left: box.left + dx, top: box.top + dy, width: box.width, height: box.height };
}

/** The box of `box` drawn at `scale` around the point (ox, oy) given relative to its top-left corner. */
export function scaledBox(box: Box, scale: number, ox = box.width / 2, oy = box.height / 2): Box {
  return { left: box.left + ox * (1 - scale), top: box.top + oy * (1 - scale), width: box.width * scale, height: box.height * scale };
}

/** The transform that draws an element laid out at `last` as if it were at `first` (centre origin). */
export function invertTransform(first: Box, last: Box): string {
  const dx = first.left + first.width / 2 - (last.left + last.width / 2);
  const dy = first.top + first.height / 2 - (last.top + last.height / 2);
  const sx = last.width > 0 ? first.width / last.width : 1;
  const sy = last.height > 0 ? first.height / last.height : 1;
  const scale = Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001 ? '' : ` scale(${round(sx)}, ${round(sy)})`;
  return `translate3d(${round(dx)}px, ${round(dy)}px, 0)${scale}`;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export interface FlipOptions {
  /** Milliseconds (default MOTION.settleMs). */
  duration?: number;
  /** Default MOTION.spring. */
  easing?: string;
  /** Where layout puts the element now; read from the element when left out. */
  last?: Box;
  /** Raise the element above its neighbours while it travels (restored after). */
  zIndex?: number;
  /** Start from this opacity (ends at the element's own). */
  fromOpacity?: number;
  /** Moves shorter than this (px, and scale changes under 0.5 %) are not animated. */
  minDistance?: number;
  /** Delay before it starts (ms). */
  delay?: number;
}

/** Animations started here, per element, so a new move replaces an unfinished one. */
const running = new WeakMap<Element, Animation>();

/**
 * Play a FLIP: draw `el` at `first`, then glide it to where layout has it.
 * Returns the animation (null with reduced motion, when there is nothing to
 * move, or when the Web Animations API is missing).
 */
export function flip(el: HTMLElement, first: Box, opts: FlipOptions = {}): Animation | null {
  stopMotion(el);
  if (prefersReducedMotion() || typeof el.animate !== 'function') return null;
  const last = opts.last ?? boxOf(el);
  const dx = first.left + first.width / 2 - (last.left + last.width / 2);
  const dy = first.top + first.height / 2 - (last.top + last.height / 2);
  const ds = Math.max(Math.abs(first.width - last.width) / Math.max(1, last.width), Math.abs(first.height - last.height) / Math.max(1, last.height));
  if (Math.hypot(dx, dy) < (opts.minDistance ?? 0.5) && ds < 0.005 && opts.fromOpacity === undefined) return null;
  // One keyframe at offset 0: the animation ends on the element's own transform and opacity.
  const from: Keyframe = { transform: invertTransform(first, last), offset: 0 };
  if (opts.fromOpacity !== undefined) from.opacity = opts.fromOpacity;
  return play(el, [from], opts);
}

function play(el: HTMLElement, frames: Keyframe[], opts: FlipOptions): Animation {
  const z = opts.zIndex;
  const prevZ = el.style.zIndex;
  if (z !== undefined) el.style.zIndex = String(z);
  const anim = el.animate(frames, { duration: opts.duration ?? MOTION.settleMs, easing: opts.easing ?? MOTION.spring, delay: opts.delay ?? 0, fill: 'backwards' });
  running.set(el, anim);
  const done = () => {
    if (running.get(el) === anim) running.delete(el);
    if (z !== undefined && el.style.zIndex === String(z)) el.style.zIndex = prevZ;
  };
  anim.addEventListener('finish', done);
  anim.addEventListener('cancel', done);
  return anim;
}

/** Stop a move started here on `el` (it jumps to where layout has it). */
export function stopMotion(el: Element): void {
  const a = running.get(el);
  if (!a) return;
  running.delete(el);
  a.cancel();
}

/** `el` is still travelling (an animation started here has not finished). */
export function isMoving(el: Element): boolean {
  const a = running.get(el);
  return !!a && (a.playState === 'running' || a.playState === 'paused');
}

/** Resolves when every animation has finished or was cancelled (nulls are skipped). */
export function settled(anims: readonly (Animation | null | undefined)[]): Promise<void> {
  return Promise.all(anims.filter((a): a is Animation => !!a).map((a) => a.finished.then(noop, noop))).then(noop);
}

function noop(): void {}
