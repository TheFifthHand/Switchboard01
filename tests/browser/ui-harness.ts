/**
 * Helpers for UI component tests in real Chromium: mount React trees into
 * the document and dispatch real DOM PointerEvents / KeyboardEvents.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLDivElement;
  root: Root;
  rerender(el: ReactElement): void;
  unmount(): void;
}

const mounted = new Set<Mounted>();

export function mount(el: ReactElement, opts: { width?: number } = {}): Mounted {
  const container = document.createElement('div');
  container.style.width = `${opts.width ?? 800}px`;
  container.style.padding = '20px';
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(el));
  const m: Mounted = {
    container,
    root,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      if (!mounted.has(m)) return;
      mounted.delete(m);
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted.add(m);
  return m;
}

/** Unmount everything mounted by a test (call in afterEach). */
export function cleanup(): void {
  for (const m of [...mounted]) m.unmount();
}

export function pointer(target: EventTarget, type: string, init: PointerEventInit = {}): PointerEvent {
  const ev = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: type === 'pointermove' ? -1 : 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    ...init,
  });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

export function key(target: EventTarget, type: 'keydown' | 'keyup', init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, ...init });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

export function fire(target: EventTarget, ev: Event): Event {
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await nextFrame();
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Flush a frame inside act() so rAF-driven state updates are applied. */
export async function actFrame(): Promise<void> {
  await act(async () => {
    await nextFrame();
  });
}

/** Centre point of an element, optionally at a vertical fraction of its height. */
export function pointIn(el: Element, yFraction = 0.5, xFraction = 0.5): { clientX: number; clientY: number } {
  const r = el.getBoundingClientRect();
  return { clientX: r.left + r.width * xFraction, clientY: r.top + r.height * yFraction };
}
