/**
 * Notices and toasts for errors and undoable actions.
 *
 * - `Notice`: an inline banner (e.g. "This part has no path to the output"
 *   with a Restore Connection action, or an autosave error with Retry).
 * - `ToastProvider` + `useToasts()`: transient messages stacked at the top
 *   centre of the screen, e.g. "Variation applied" [Undo]. Toasts pause while
 *   hovered or focused; errors stay until dismissed unless given a duration
 *   (any caller may pass one, e.g. 3000 ms for "Undid: …").
 * - Placement contract (Toast.module.css): the stack sits at the top centre,
 *   just under the transport (`--transport-h`, written by the TransportBar on
 *   `document.documentElement`: toasts render into body, outside the app
 *   tree), where every view keeps headers rather than anything played or
 *   chosen; while a menu is open (`body[data-popover-open]`, set by Popover)
 *   it goes below the menu; while a modal dialog is open
 *   (`body[data-modal-open]`, set by Dialog) its action keys are hidden.
 *   When a control (a tab, key, pad, field…) sits under the centred stack,
 *   the stack slides into the widest clear stretch of its band near the
 *   centre (narrowing to fit, never below 300 px), so it never covers what
 *   is about to be pressed; it is placed each time the stack changes and
 *   again after a scroll or resize.
 *
 * Tone is shown by an icon and wording, not colour alone: coral marks
 * warnings and errors (attention); info/success are neutral.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import styles from './Toast.module.css';

export type NoticeTone = 'info' | 'success' | 'warning' | 'error';

export interface NoticeAction {
  label: string;
  onAction(): void;
}

const TONE_ICON: Record<NoticeTone, IconName> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  error: 'warning',
};

/* ------------------------------------------------------------------ */
/* Notice (inline)                                                     */
/* ------------------------------------------------------------------ */

export interface NoticeProps {
  tone?: NoticeTone;
  title?: string;
  children?: ReactNode;
  action?: NoticeAction;
  onDismiss?(): void;
  dismissLabel?: string;
  className?: string;
}

export function Notice({ tone = 'info', title, children, action, onDismiss, dismissLabel = 'Dismiss', className }: NoticeProps) {
  const urgent = tone === 'error' || tone === 'warning';
  return (
    <div className={[styles.notice, className].filter(Boolean).join(' ')} data-tone={tone} role={urgent ? 'alert' : 'status'}>
      <Icon name={TONE_ICON[tone]} size={16} className={styles.icon} />
      <div className={styles.content}>
        {title && <div className={styles.title}>{title}</div>}
        {children && <div className={styles.message}>{children}</div>}
      </div>
      {(action || onDismiss) && (
        // Grouped so that in a narrow panel they wrap below the message
        // together instead of squeezing it into a one-word column.
        <div className={styles.controls}>
          {action && (
            <button type="button" className={styles.action} onClick={action.onAction}>
              {action.label}
            </button>
          )}
          {onDismiss && (
            <button type="button" className={styles.dismiss} aria-label={dismissLabel} onClick={onDismiss}>
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

export interface ToastOptions {
  /** Reusing an id replaces that toast (e.g. repeated autosave errors). */
  id?: string;
  tone?: NoticeTone;
  title?: string;
  message: string;
  action?: NoticeAction;
  /** Milliseconds before it hides; null = until dismissed. Default: 5 s, 8 s with an action, sticky for errors. */
  duration?: number | null;
}

export interface ToastApi {
  show(toast: ToastOptions): string;
  dismiss(id: string): void;
  clear(): void;
}

interface ToastEntry extends ToastOptions {
  id: string;
  /** Bumped when a toast with the same id is shown again, to restart its timer. */
  version: number;
}

const ToastContext = createContext<ToastApi | null>(null);

let toastCounter = 0;

export interface ToastProviderProps {
  children?: ReactNode;
  /** Maximum toasts shown at once (oldest are dropped). */
  max?: number;
}

export function ToastProvider({ children, max = 4 }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const dismiss = useCallback((id: string) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const clear = useCallback(() => setToasts([]), []);
  const show = useCallback(
    (opts: ToastOptions) => {
      const id = opts.id ?? `toast-${++toastCounter}`;
      setToasts((list) => {
        const existing = list.find((t) => t.id === id);
        const entry: ToastEntry = { ...opts, id, version: (existing?.version ?? 0) + 1 };
        const next = existing ? list.map((t) => (t.id === id ? entry : t)) : [...list, entry];
        return next.slice(-max);
      });
      return id;
    },
    [max],
  );

  const api = useMemo<ToastApi>(() => ({ show, dismiss, clear }), [show, dismiss, clear]);

  // Keep the stack off the controls under its band (see placeClearOfControls).
  const viewportRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    if (!toasts.length) {
      resetPlacement(el);
      return;
    }
    placeClearOfControls(el);
    // A scroll or resize brings other controls under the band: place again, once a frame at most.
    let frame = 0;
    const later = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        placeClearOfControls(el);
      });
    };
    window.addEventListener('resize', later);
    window.addEventListener('scroll', later, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', later);
      window.removeEventListener('scroll', later, { capture: true });
    };
  }, [toasts]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div ref={viewportRef} className={styles.viewport} aria-live="polite" aria-relevant="additions text">
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

const CONTROL = 'button, a[href], input, select, textarea, [role="tab"], [role="button"], [role="slider"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="spinbutton"], [role="combobox"], [contenteditable="true"]';
/** Narrowest the stack becomes to clear a control (the card's text still wraps sensibly). */
const MIN_STACK_PX = 300;
const STEP_PX = 8;

function resetPlacement(el: HTMLElement): void {
  el.style.removeProperty('left');
  el.style.removeProperty('width');
  el.style.removeProperty('transform');
}

/** A control the person might be about to press (not a large region that happens to be focusable). */
function isControlAt(x: number, y: number, stack: HTMLElement, maxWidth: number): boolean {
  const hit = document.elementsFromPoint(x, y).find((e) => !stack.contains(e));
  const control = hit?.closest(CONTROL);
  return !!control && control.getBoundingClientRect().width <= maxWidth;
}

/**
 * Centred by default; when a control lies under that spot, slide the stack
 * into the widest clear stretch of its band nearest the centre, narrowing it
 * to fit (not below MIN_STACK_PX). With no such stretch it stays centred.
 */
function placeClearOfControls(el: HTMLElement): void {
  resetPlacement(el);
  const box = el.getBoundingClientRect();
  if (box.height === 0) return;
  const vw = document.documentElement.clientWidth;
  const ys = [box.top + 6, (box.top + box.bottom) / 2, box.bottom - 6];
  const maxControl = vw * 0.6;
  const blockedAt = (x: number) => ys.some((y) => isControlAt(x, y, el, maxControl));
  const covered = (from: number, to: number) => {
    for (let x = from; x <= to; x += STEP_PX) if (blockedAt(x)) return true;
    return blockedAt(to);
  };
  if (!covered(box.left, box.right)) return;
  // Clear stretches of the band (16 px from the window's edges, 8 px from controls).
  const runs: { start: number; end: number }[] = [];
  let start: number | null = null;
  for (let x = 16; x <= vw - 16; x += STEP_PX) {
    if (blockedAt(x)) {
      if (start !== null && x - 16 - start >= MIN_STACK_PX) runs.push({ start, end: x - 16 });
      start = null;
    } else if (start === null) start = x === 16 ? 16 : x + 8;
  }
  if (start !== null && vw - 16 - start >= MIN_STACK_PX) runs.push({ start, end: vw - 16 });
  if (!runs.length) return;
  const centre = vw / 2;
  const distance = (r: { start: number; end: number }) => (centre < r.start ? r.start - centre : centre > r.end ? centre - r.end : 0);
  runs.sort((a, b) => distance(a) - distance(b) || b.end - b.start - (a.end - a.start));
  const run = runs[0];
  const width = Math.min(box.width, run.end - run.start);
  const left = Math.min(Math.max(centre - width / 2, run.start), run.end - width);
  el.style.left = `${Math.round(left)}px`;
  el.style.width = `${Math.round(width)}px`;
  el.style.transform = 'none';
}

/** Toast API from the nearest ToastProvider. */
export function useToasts(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToasts() needs a <ToastProvider> above it.');
  return api;
}

function defaultDuration(t: ToastOptions): number | null {
  if (t.duration !== undefined) return t.duration;
  if (t.tone === 'error') return null;
  return t.action ? 8000 : 5000;
}

function ToastItem({ toast, onDismiss }: { toast: ToastEntry; onDismiss(): void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef<number | null>(defaultDuration(toast));
  const startedAt = useRef(0);
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    remaining.current = defaultDuration(toast);
  }, [toast]);

  useEffect(() => {
    if (paused || remaining.current === null) return;
    startedAt.current = performance.now();
    const timer = window.setTimeout(() => onDismissRef.current(), remaining.current);
    return () => {
      window.clearTimeout(timer);
      if (remaining.current !== null) remaining.current = Math.max(800, remaining.current - (performance.now() - startedAt.current));
    };
  }, [paused, toast.version]);

  return (
    <Toast
      {...toast}
      onDismiss={onDismiss}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    />
  );
}

export interface ToastProps extends ToastOptions {
  onDismiss(): void;
  onPointerEnter?(): void;
  onPointerLeave?(): void;
  onFocusCapture?(): void;
  onBlurCapture?(): void;
}

/** A single toast card (presentational; ToastProvider manages timing). */
export function Toast({ tone = 'info', title, message, action, onDismiss, onPointerEnter, onPointerLeave, onFocusCapture, onBlurCapture }: ToastProps) {
  return (
    <div
      className={styles.toast}
      data-tone={tone}
      role={tone === 'error' ? 'alert' : 'status'}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocusCapture}
      onBlur={onBlurCapture}
    >
      <Icon name={TONE_ICON[tone]} size={16} className={styles.icon} />
      <div className={styles.content}>
        {title && <div className={styles.title}>{title}</div>}
        <div className={styles.message}>{message}</div>
      </div>
      {action && (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            action.onAction();
            onDismiss();
          }}
        >
          {action.label}
        </button>
      )}
      <button type="button" className={styles.dismiss} aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
