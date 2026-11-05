/**
 * Optional Tips.
 *
 * - `TipsProvider` publishes the remembered "Tips" setting (owned by the app's
 *   UI store) to every control; `useTips()` reads or toggles it.
 * - `Tooltip` explains a control in plain language first and technical detail
 *   second. It appears after ~350 ms of hover and immediately on keyboard
 *   focus, never intercepts the pointer (pointer-events: none), hides the
 *   moment anything is pressed so it never gets in the way of playing,
 *   closes on Escape wherever focus is, and is kept inside the viewport.
 * - Keyboard focus means the user moved it with a navigation key (Tab, the
 *   arrow keys, Home/End, Page Up/Down) just before: focus the app moves by
 *   itself (after Delete, a dialog closing, a drop) opens nothing, so a tip
 *   never lands on a button the user did not go to.
 * - Hover means the pointer moved over the control: a control that comes to
 *   lie under a resting pointer (after a drop, or when a dialog, menu or the
 *   guide closes, or a hint appears) shows nothing until the pointer moves.
 * - An optional `hint` says how to operate the control (gestures, shortcuts);
 *   it comes last and, like the explanations, follows the Tips setting.
 * - When Tips are off, a tooltip still shows a control's `name` if it has one
 *   (icon-only buttons need their name), but no explanations.
 * - The trigger is linked with aria-describedby to a hidden description, so
 *   screen readers get the same text whether or not the bubble is visible.
 */
import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './Tooltip.module.css';

/* ------------------------------------------------------------------ */
/* Tips setting                                                        */
/* ------------------------------------------------------------------ */

export interface TipsContextValue {
  enabled: boolean;
  setEnabled(enabled: boolean): void;
}

const TipsContext = createContext<TipsContextValue>({ enabled: true, setEnabled: () => {} });

export interface TipsProviderProps {
  enabled: boolean;
  /** Called by `useTips().setEnabled` (e.g. from a Tips switch). */
  onEnabledChange?(enabled: boolean): void;
  children?: ReactNode;
}

export function TipsProvider({ enabled, onEnabledChange, children }: TipsProviderProps) {
  const setEnabled = useCallback((v: boolean) => onEnabledChange?.(v), [onEnabledChange]);
  const value = useMemo(() => ({ enabled, setEnabled }), [enabled, setEnabled]);
  return <TipsContext.Provider value={value}>{children}</TipsContext.Provider>;
}

export function useTips(): TipsContextValue {
  return useContext(TipsContext);
}

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */

export const TOOLTIP_DELAY_MS = 350;
const MARGIN = 8;
const GAP = 8;

/** Keys that move keyboard focus (sequentially, or within a composite widget). */
const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
/** Focus counts as the user's own move for this long after a navigation key. */
const NAV_FOCUS_MS = 400;

/** The last key pressed anywhere, watched once for every tooltip. */
const lastKey = { key: '', at: -Infinity };
let watchingKeys = false;
function watchKeys(): void {
  if (watchingKeys || typeof window === 'undefined') return;
  watchingKeys = true;
  window.addEventListener(
    'keydown',
    (e) => {
      lastKey.key = e.key;
      lastKey.at = performance.now();
    },
    { capture: true, passive: true },
  );
}

/** True when focus just moved because the user pressed a navigation key. */
function focusFromNavigation(): boolean {
  return NAV_KEYS.has(lastKey.key) && performance.now() - lastKey.at < NAV_FOCUS_MS;
}

export interface TooltipProps {
  /** Short name of the control, shown first (and even when Tips are off). */
  name?: string;
  /** Plain-language explanation of the audible result. */
  tip?: ReactNode;
  /** Technical detail, shown second in smaller type. */
  detail?: ReactNode;
  /** How to operate the control, shown last in smaller type. */
  hint?: ReactNode;
  /** Preferred side; flips when there is no room. */
  placement?: 'top' | 'bottom';
  disabled?: boolean;
  /** The trigger. It must accept `aria-describedby` and render a DOM element. */
  children: ReactElement;
}

interface Pos {
  left: number;
  top: number;
  side: 'top' | 'bottom';
}

export function Tooltip({ name, tip, detail, hint, placement = 'top', disabled, children }: TooltipProps) {
  const { enabled } = useTips();
  const showTip = enabled && (tip !== undefined || detail !== undefined || hint !== undefined);
  const hasContent = !disabled && (Boolean(name) || showTip);

  const descId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  // After a press, stay hidden until the pointer leaves the control.
  const suppressed = useRef(false);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);

  const clearTimer = () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
    setPos(null);
  }, []);

  useEffect(() => {
    watchKeys();
    return () => clearTimer();
  }, []);
  useEffect(() => {
    if (!hasContent) hide();
  }, [hasContent, hide]);

  // Hide on window blur, scroll or resize (the anchor may have moved), and on
  // Escape wherever focus is — a hover tooltip must be dismissible without
  // moving the pointer. Escape keeps doing its own job (the key is not consumed).
  useEffect(() => {
    if (!open) return;
    const onAway = () => hide();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      suppressed.current = true;
      hide();
    };
    window.addEventListener('blur', onAway);
    window.addEventListener('resize', onAway);
    window.addEventListener('scroll', onAway, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('blur', onAway);
      window.removeEventListener('resize', onAway);
      window.removeEventListener('scroll', onAway, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, hide]);

  const trigger = (): Element | null => anchorRef.current?.firstElementChild ?? null;

  useLayoutEffect(() => {
    if (!open) return;
    const el = trigger();
    const bubble = bubbleRef.current;
    if (!el || !bubble) return;
    const r = el.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let side = placement;
    if (side === 'top' && r.top - GAP - bh < MARGIN) side = 'bottom';
    else if (side === 'bottom' && r.bottom + GAP + bh > vh - MARGIN && r.top - GAP - bh >= MARGIN) side = 'top';
    let top = side === 'top' ? r.top - GAP - bh : r.bottom + GAP;
    top = Math.max(MARGIN, Math.min(vh - MARGIN - bh, top));
    let left = r.left + r.width / 2 - bw / 2;
    left = Math.max(MARGIN, Math.min(vw - MARGIN - bw, left));
    setPos({ left: Math.round(left), top: Math.round(top), side });
  }, [open, placement, name, tip, detail, hint]);

  if (!isValidElement(children)) return children;
  if (!hasContent) return children;

  // The hover delay starts when the pointer moves over the control, never just because something
  // appeared under a pointer at rest (the browser then sends pointerover, but no pointermove).
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || e.buttons !== 0 || suppressed.current || open || timer.current !== undefined) return;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setOpen(true);
    }, TOOLTIP_DELAY_MS);
  };
  const onPointerOut = (e: PointerEvent) => {
    const to = e.relatedTarget as Node | null;
    if (to && anchorRef.current?.contains(to)) return;
    suppressed.current = false;
    hide();
  };
  const onPointerDown = () => {
    suppressed.current = true;
    hide();
  };
  const onFocus = (e: FocusEvent) => {
    const t = e.target as Element;
    let keyboard = false;
    try {
      keyboard = t.matches(':focus-visible');
    } catch {
      keyboard = false;
    }
    // Only focus the user moved with the keyboard: not focus the app moved after another key.
    if (keyboard && !suppressed.current && focusFromNavigation()) {
      clearTimer();
      setOpen(true);
    }
  };
  const onBlur = (e: FocusEvent) => {
    const to = e.relatedTarget as Node | null;
    if (to && anchorRef.current?.contains(to)) return;
    // Leaving the control ends a press/Escape suppression, so a keyboard user
    // who comes back gets the tip again.
    suppressed.current = false;
    hide();
  };

  const childProps = children.props as { 'aria-describedby'?: string };
  const describedBy = [childProps['aria-describedby'], descId].filter(Boolean).join(' ');
  const trig = cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, { 'aria-describedby': describedBy });

  const descText = [name, showTip ? tip : null, showTip ? detail : null, showTip ? hint : null].filter((x) => x !== undefined && x !== null && x !== '');

  return (
    <span
      ref={anchorRef}
      className={styles.anchor}
      onPointerMove={onPointerMove}
      onPointerOut={onPointerOut}
      onPointerDown={onPointerDown}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {trig}
      <span id={descId} hidden>
        {descText.map((t, i) => (
          <span key={i}>
            {i > 0 ? ' ' : ''}
            {t}
            {typeof t === 'string' && !/[.!?:]$/.test(t) ? '.' : ''}
          </span>
        ))}
      </span>
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            className={styles.bubble}
            data-side={pos?.side ?? placement}
            data-ready={pos ? 'true' : 'false'}
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
            aria-hidden="true"
          >
            {name && <div className={styles.name}>{name}</div>}
            {showTip && tip !== undefined && <div className={styles.tip}>{tip}</div>}
            {showTip && detail !== undefined && <div className={styles.detail}>{detail}</div>}
            {showTip && hint !== undefined && <div className={styles.detail}>{hint}</div>}
          </div>,
          document.body,
        )}
    </span>
  );
}
