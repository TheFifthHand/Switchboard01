/**
 * Layout state of the Shape view that outlives a part switch or a mode
 * switch, but never the session and never the project:
 *
 * - The Advanced tab shown on short windows (below ADVANCED_TABS_BELOW_PX of
 *   height, from 1024 px of width, the three columns become tabs: Macros |
 *   Instrument | Effects).
 * - Each column's scroll position per part, so switching parts and back
 *   returns to the same place (a part never seen starts at the top).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { createStore } from '../../../state/store';
import type { Id } from '../../../project/types';

/** Window heights below this show Advanced Shape as tabs (one full-height column at a time). */
export const ADVANCED_TABS_BELOW_PX = 850;

export type ShapeColumn = 'macros' | 'instrument' | 'effects';
export const SHAPE_COLUMNS: readonly ShapeColumn[] = ['macros', 'instrument', 'effects'];
export const COLUMN_LABEL: Record<ShapeColumn, string> = { macros: 'Macros', instrument: 'Instrument', effects: 'Effects' };

/** The tab shown first: the instrument's every setting, which Simple shows least of. */
export const shapeLayout = createStore<{ tab: ShapeColumn }>({ tab: 'instrument' });

export function setAdvancedTab(tab: ShapeColumn): void {
  shapeLayout.setState((s) => (s.tab === tab ? s : { ...s, tab }));
}

export function useAdvancedTab(): ShapeColumn {
  return useSyncExternalStore(shapeLayout.subscribe, () => shapeLayout.getState().tab);
}

/** Whether a media query matches now, following changes (false where there is no window). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    [query],
  );
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  return useSyncExternalStore(subscribe, read, () => false);
}

/**
 * True while the window is shorter than ADVANCED_TABS_BELOW_PX (Advanced
 * Shape shows tabs). Below 1024 px of width (200 % zoom) the view is one
 * scrolling page with every panel at its natural height instead, so no tabs.
 */
export function useShortWindow(): boolean {
  return useMediaQuery(`(max-height: ${ADVANCED_TABS_BELOW_PX - 0.02}px) and (min-width: 1024px)`);
}

const scrolls = new Map<string, number>();
const key = (col: ShapeColumn, trackId: Id) => `${col}\u0000${trackId}`;

/** For tests: forget every remembered scroll position. */
export function forgetScrolls(): void {
  scrolls.clear();
}

/**
 * Keep a column's scroll position per part: `root` holds the column (its
 * scrolling body is found inside it with `bodySelector`). On a part switch
 * the position of the part left is kept and the new part's is restored.
 */
export function useColumnScroll(root: RefObject<HTMLElement | null>, col: ShapeColumn, trackId: Id, bodySelector = ':scope > section > div:last-child'): void {
  const shown = useRef<Id | null>(null);
  /** The scrolling body last seen and where it stood (written only when it must move: a write forces a layout). */
  const at = useRef<{ el: HTMLElement | null; top: number }>({ el: null, top: 0 });
  const body = () => root.current?.querySelector<HTMLElement>(bodySelector) ?? null;
  // Before the browser paints the new part: put its own scroll position back.
  useLayoutEffect(() => {
    const el = body();
    if (!el) return;
    shown.current = trackId;
    const want = scrolls.get(key(col, trackId)) ?? 0;
    // A body just mounted starts at the top.
    const now = at.current.el === el ? at.current.top : 0;
    if (want !== now) el.scrollTop = want;
    at.current = { el, top: want };
    const onScroll = () => {
      at.current = { el, top: el.scrollTop };
      if (shown.current === trackId) scrolls.set(key(col, trackId), el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
    // body() is found again for every part (the column may have re-rendered its body).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [col, trackId]);
  useEffect(
    () => () => {
      shown.current = null;
    },
    [],
  );
}
