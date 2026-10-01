/**
 * Motion of the song lane: durations and easings shared by the gesture
 * controller (Web Animations, so a slide never needs a forced layout) and the
 * lane (zoom, playhead). The easing curves exist twice, as the CSS string the
 * browser animates with and as a function, so a slide that is retargeted
 * mid-way starts exactly where the block is on screen.
 *
 * The slide and settle timings and the reduced-motion check come from
 * src/ui/motion.ts, so the lane and the Loops pads move alike.
 */
import { MOTION, prefersReducedMotion } from '../../../ui/motion';

export { prefersReducedMotion };

/** Blocks sliding aside while something is dragged, or into their new places after an edit. */
export const SLIDE_MS = MOTION.slideMs;
/** Blocks after an edge being dragged follow it quickly. */
export const RESIZE_SLIDE_MS = 90;
/** A dropped block springing into its slot (from where it was let go, at once). */
export const SETTLE_MS = MOTION.settleMs;
/** A change of scale (Fit song, zoom, a window resize). */
export const ZOOM_MS = 200;
/** The playhead gliding to its new place when blocks before it move. */
export const PLAYHEAD_GLIDE_MS = 150;
/** The lane turning a page to keep the playhead in view. */
export const FOLLOW_SCROLL_MS = 420;

export const EASE_SLIDE_CSS = MOTION.ease;
export const EASE_SPRING_CSS = 'cubic-bezier(0.3, 1.32, 0.5, 1)';

/**
 * A CSS cubic-bezier timing function as a function of time (0..1): solves
 * x(s) = t for the curve parameter s (Newton steps with a bisection
 * fallback), then returns y(s).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sy = (s: number) => ((ay * s + by) * s + cy) * s;
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 6; i++) {
      const err = sx(s) - t;
      if (Math.abs(err) < 1e-5) return sy(s);
      const d = dx(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = t;
    for (let i = 0; i < 30; i++) {
      const v = sx(s);
      if (Math.abs(v - t) < 1e-5) break;
      if (v < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return sy(s);
  };
}

export const easeSlide = cubicBezier(0.2, 0.8, 0.25, 1);
export const easeSpring = cubicBezier(0.3, 1.32, 0.5, 1);
/** Ease-out for scroll and playhead glides. */
export const easeOut = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
