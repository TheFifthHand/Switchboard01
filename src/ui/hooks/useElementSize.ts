/**
 * The content-box size of an element, kept current with a ResizeObserver.
 * Updates only when the rounded size actually changes.
 *
 * The first measurement is taken in a layout effect, before the browser
 * paints: the component's second render (with the real size) happens in the
 * same frame, so a view never shows a frame laid out for a zero size and the
 * work is not split over two frames.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

/** Content-box size now (client size minus padding for HTML elements, the layout box for others). */
function measure(el: Element): ElementSize {
  if (el instanceof HTMLElement) {
    const cs = getComputedStyle(el);
    const px = (v: string) => Number.parseFloat(v) || 0;
    return {
      width: Math.round(Math.max(0, el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight))),
      height: Math.round(Math.max(0, el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom))),
    };
  }
  const r = el.getBoundingClientRect();
  return { width: Math.round(r.width), height: Math.round(r.height) };
}

export function useElementSize<T extends Element>(ref: RefObject<T | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (width: number, height: number) => {
      const w = Math.round(width);
      const h = Math.round(height);
      setSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };
    const first = measure(el);
    update(first.width, first.height);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const box = entry.contentBoxSize?.[0];
      if (box) update(box.inlineSize, box.blockSize);
      else update(entry.contentRect.width, entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return size;
}
