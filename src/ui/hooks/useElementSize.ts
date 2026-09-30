/**
 * The content-box size of an element, kept current with a ResizeObserver.
 * Updates only when the rounded size actually changes.
 */
import { useEffect, useState, type RefObject } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

export function useElementSize<T extends Element>(ref: RefObject<T | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (width: number, height: number) => {
      const w = Math.round(width);
      const h = Math.round(height);
      setSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };
    // First measurement in the same box the observer reports (content box):
    // client size minus padding for HTML elements, the layout box for others.
    if (el instanceof HTMLElement) {
      const cs = getComputedStyle(el);
      const px = (v: string) => Number.parseFloat(v) || 0;
      update(
        Math.max(0, el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight)),
        Math.max(0, el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom)),
      );
    } else {
      const r = el.getBoundingClientRect();
      update(r.width, r.height);
    }
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
