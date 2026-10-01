/**
 * src/ui/motion.ts, the shared FLIP / settle helper (the Loops pads and scene
 * rows use it; it is meant for the song lane too), in real Chromium:
 * - flip() draws an element at its old box and glides it to where layout has
 *   it, with transform only, ending exactly in place;
 * - a new move replaces an unfinished one; stopMotion() ends it at once;
 * - with reduce motion nothing animates (null, the element is simply there);
 * - the spring easing overshoots a little and comes to rest at 1.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cdp } from 'vitest/browser';
import { MOTION, boxOf, flip, invertTransform, isMoving, offsetBox, prefersReducedMotion, scaledBox, settled, springEasing, stopMotion } from '../../src/ui/motion';

const els: HTMLElement[] = [];
function box(left: number, top: number): HTMLElement {
  const el = document.createElement('div');
  Object.assign(el.style, { position: 'fixed', left: `${left}px`, top: `${top}px`, width: '100px', height: '60px', background: '#ccc' });
  document.body.appendChild(el);
  els.push(el);
  return el;
}

afterEach(async () => {
  for (const el of els.splice(0)) el.remove();
  await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
});

describe('motion helpers', () => {
  it('flip draws the element at its old box and glides it into place with transform only', async () => {
    const el = box(300, 200);
    const first = { left: 100, top: 120, width: 104, height: 62.4 };
    const anim = flip(el, first, { duration: 200 })!;
    expect(anim).not.toBeNull();
    // At the start it is drawn where it was (and as large).
    anim.pause();
    anim.currentTime = 0;
    const r0 = el.getBoundingClientRect();
    expect(Math.abs(r0.left - first.left)).toBeLessThan(0.6);
    expect(Math.abs(r0.top - first.top)).toBeLessThan(0.6);
    expect(Math.abs(r0.width - first.width)).toBeLessThan(0.6);
    // Only transform is animated.
    const props = (anim.effect as KeyframeEffect).getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p)));
    expect(new Set(props)).toEqual(new Set(['transform']));
    expect(isMoving(el)).toBe(true);
    anim.play();
    await settled([anim]);
    expect(isMoving(el)).toBe(false);
    const r1 = el.getBoundingClientRect();
    expect(r1.left).toBe(300);
    expect(r1.top).toBe(200);
  });

  it('a new move replaces an unfinished one; stopMotion ends it at once; tiny moves are skipped', () => {
    const el = box(300, 200);
    const a = flip(el, offsetBox(boxOf(el), -200, 0))!;
    const b = flip(el, offsetBox(boxOf(el), 0, -100))!;
    expect(a.playState).toBe('idle');
    expect(b.playState).toBe('running');
    stopMotion(el);
    expect(b.playState).toBe('idle');
    expect(el.getBoundingClientRect().left).toBe(300);
    expect(flip(el, offsetBox(boxOf(el), 0.2, 0))).toBeNull();
  });

  it('with reduce motion nothing animates', async () => {
    await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    expect(prefersReducedMotion()).toBe(true);
    const el = box(300, 200);
    expect(flip(el, offsetBox(boxOf(el), -150, -40))).toBeNull();
    expect(el.getAnimations()).toHaveLength(0);
  });

  it('boxes and the spring are what they say', () => {
    const s = scaledBox({ left: 0, top: 0, width: 100, height: 50 }, 1.1, 0, 0);
    expect([s.left, s.top]).toEqual([0, 0]);
    expect(s.width).toBeCloseTo(110, 6);
    expect(s.height).toBeCloseTo(55, 6);
    expect(scaledBox({ left: 0, top: 0, width: 100, height: 50 }, 2)).toEqual({ left: -50, top: -25, width: 200, height: 100 });
    expect(invertTransform({ left: 10, top: 20, width: 100, height: 50 }, { left: 10, top: 20, width: 100, height: 50 })).toBe('translate3d(0px, 0px, 0)');
    const spring = springEasing();
    expect(spring).toMatch(/^linear\(/);
    const pts = spring.slice(7, -1).split(',').map(Number);
    expect(pts[0]).toBe(0);
    expect(pts.at(-1)).toBe(1);
    const peak = Math.max(...pts);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.08);
    expect(MOTION.settleMs).toBeGreaterThanOrEqual(180);
    expect(MOTION.settleMs).toBeLessThanOrEqual(220);
  });
});
