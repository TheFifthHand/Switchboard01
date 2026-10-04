/**
 * The touch rule for drag controls (Knob, Fader): a finger swipe scrolls the page; it changes a
 * value only when it starts on the control's grip (the knob's dial, the fader's cap, with a hit
 * area of at least TOUCH_HIT_PX) or after resting still for TOUCH_HOLD_MS. Until then the control
 * allows panning (touch-action) and takes nothing; once a drag has begun it captures the pointer
 * and its non-passive touchmove listener stops the browser from panning.
 *
 * Mouse and pen are unchanged: a press anywhere on the control drags at once.
 */

/** A finger resting this long (moving less than TOUCH_SLOP_PX) starts a drag anywhere on the control. */
export const TOUCH_HOLD_MS = 250;
/** Movement before the hold that makes the touch a swipe (the page scrolls; the value stays). */
export const TOUCH_SLOP_PX = 8;
/** The smallest touch target around a grip (CSS px). */
export const TOUCH_HIT_PX = 44;

/** True when (x, y) falls on `grip`, its box grown to at least TOUCH_HIT_PX on each axis. */
export function onTouchGrip(grip: Element | null, x: number, y: number): boolean {
  if (!grip) return false;
  const r = grip.getBoundingClientRect();
  const halfW = Math.max(r.width, TOUCH_HIT_PX) / 2;
  const halfH = Math.max(r.height, TOUCH_HIT_PX) / 2;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  return Math.abs(x - cx) <= halfW && Math.abs(y - cy) <= halfH;
}

/** A finger that landed off the grip and may still become a drag by resting. */
export interface PendingTouch {
  pointerId: number;
  /** Where the finger landed (the slop is measured from here). */
  x: number;
  y: number;
  /** Where it is now (a drag that begins after the hold starts from here). */
  lastY: number;
  timer: number;
}
