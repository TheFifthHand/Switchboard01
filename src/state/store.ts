/**
 * A tiny observable store plus a React binding.
 *
 * `createStore` is framework-free. `useStore` subscribes a component to a
 * selected slice via React's useSyncExternalStore, re-rendering only when the
 * selected value changes (by `equality`). This file is the only React import
 * in src/state.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

export type Listener<T> = (state: T, prev: T) => void;

export interface ReadableStore<T> {
  getState(): T;
  /** Returns an unsubscribe function. */
  subscribe(listener: Listener<T>): () => void;
}

export interface Store<T> extends ReadableStore<T> {
  /** Replace the state (or derive it from the previous one). Identical states notify nobody. */
  setState(next: T | ((prev: T) => T)): void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener<T>>();
  return {
    getState: () => state,
    setState(next) {
      const value = typeof next === 'function' ? (next as (prev: T) => T)(state) : next;
      if (Object.is(value, state)) return;
      const prev = state;
      state = value;
      // Copy so listeners may unsubscribe (or subscribe) while being notified.
      for (const l of [...listeners]) l(state, prev);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Shallow equality for objects/arrays of primitives or stable references. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * Subscribe a component to `selector(store.getState())`. The previous
 * selection is reused while `equality` says it is unchanged, so selectors may
 * build new objects/arrays when paired with `shallowEqual`.
 */
export function useStore<T, S>(store: ReadableStore<T>, selector: (state: T) => S, equality: (a: S, b: S) => boolean = Object.is): S {
  // Last committed selection, shared across selector identities so an inline
  // selector does not force a new value on every render.
  const committed = useRef<{ has: boolean; value: S }>({ has: false, value: undefined as S });

  const subscribe = useCallback((onChange: () => void) => store.subscribe(() => onChange()), [store]);

  const getSelection = useMemo(() => {
    let memoState: T;
    let memoSelection: S;
    let hasMemo = false;
    return () => {
      const state = store.getState();
      if (hasMemo && Object.is(memoState, state)) return memoSelection;
      const next = selector(state);
      const prev = hasMemo ? memoSelection : committed.current.has ? committed.current.value : undefined;
      hasMemo = true;
      memoState = state;
      memoSelection = prev !== undefined && equality(prev as S, next) ? (prev as S) : next;
      return memoSelection;
    };
  }, [store, selector, equality]);

  const value = useSyncExternalStore(subscribe, getSelection, getSelection);
  useEffect(() => {
    committed.current = { has: true, value };
  }, [value]);
  return value;
}
