/**
 * Real input for the round-4 UI kit tests: trusted mouse, keyboard and touch events sent through
 * the Chrome DevTools Protocol, so the browser's own handling (focus, :focus-visible, touch-action
 * panning, implicit pointer capture) is in play. Points are in this frame's coordinates.
 */
import { act } from 'react';
import { cdp } from 'vitest/browser';

export type Pt = { x: number; y: number };

type Method = 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.dispatchTouchEvent' | 'Emulation.setTouchEmulationEnabled' | 'Emulation.setEmulatedMedia' | 'Emulation.setCPUThrottlingRate';

/** Page coordinates of a point in this frame (the test frame may sit anywhere in the runner's page). */
export function toPage(p: Pt): Pt {
  const fe = window.frameElement as HTMLElement | null;
  if (!fe) return p;
  const r = fe.getBoundingClientRect();
  const k = fe.offsetWidth ? r.width / fe.offsetWidth : 1;
  return { x: r.left + p.x * k, y: r.top + p.y * k };
}

export async function send(method: Method, params: Record<string, unknown>): Promise<void> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await (cdp().send as (m: Method, p: Record<string, unknown>) => Promise<unknown>)(method, params);
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
}

/** Let React and the browser catch up (two frames). */
export async function settleFrames(n = 2): Promise<void> {
  await act(async () => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
  });
}

export async function mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', p: Pt, o: { buttons?: number; modifiers?: number; clickCount?: number } = {}): Promise<void> {
  const q = toPage(p);
  await send('Input.dispatchMouseEvent', {
    type,
    x: q.x,
    y: q.y,
    button: type === 'mouseMoved' && !o.buttons ? 'none' : 'left',
    buttons: o.buttons ?? (type === 'mousePressed' ? 1 : 0),
    clickCount: type === 'mouseMoved' ? 0 : (o.clickCount ?? 1),
    modifiers: o.modifiers ?? 0,
  });
}

export async function click(p: Pt): Promise<void> {
  await mouse('mouseMoved', p);
  await mouse('mousePressed', p);
  await mouse('mouseReleased', p);
  await settleFrames();
}

/** A mouse drag from `a` to `b` in `steps` moves, a frame apart. */
export async function drag(a: Pt, b: Pt, steps = 8): Promise<void> {
  await mouse('mouseMoved', a);
  await mouse('mousePressed', a);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }, { buttons: 1 });
    await new Promise((r) => requestAnimationFrame(r));
  }
  await mouse('mouseReleased', b);
  await settleFrames();
}

export async function touch(type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: Pt[]): Promise<void> {
  await send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ ...toPage(p), id: i + 1 })) });
}

/** A finger from `a` to `b` in `steps` moves (a frame apart), resting `holdMs` first. */
export async function finger(a: Pt, b: Pt, opts: { steps?: number; holdMs?: number } = {}): Promise<void> {
  const steps = opts.steps ?? 10;
  await touch('touchStart', [a]);
  await new Promise((r) => requestAnimationFrame(r));
  if (opts.holdMs) await new Promise((r) => setTimeout(r, opts.holdMs));
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [{ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }]);
    await new Promise((r) => requestAnimationFrame(r));
  }
  await touch('touchEnd', []);
  await settleFrames();
}

export const centre = (el: Element, fx = 0.5, fy = 0.5): Pt => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width * fx, y: r.top + r.height * fy };
};

/** Reduced motion on or off for this page. */
export async function reducedMotion(on: boolean): Promise<void> {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }] });
}

/** WCAG contrast of two CSS colours (rgb()/hex as the browser computes them). */
export function contrast(a: string, b: string): number {
  const rgb = (c: string): [number, number, number] => {
    const el = document.createElement('span');
    el.style.color = c;
    document.body.append(el);
    const m = getComputedStyle(el).color.match(/[\d.]+/g)!.map(Number);
    el.remove();
    return [m[0], m[1], m[2]];
  };
  const lum = ([r, g, b2]: [number, number, number]) => {
    const ch = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b2);
  };
  const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
