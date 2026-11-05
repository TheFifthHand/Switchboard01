/**
 * Notices and toasts for errors and undoable actions.
 *
 * - `Notice`: an inline banner (e.g. "This part has no path to the output"
 *   with a Restore Connection action, or an autosave error with Retry).
 * - `ToastProvider` + `useToasts()`: transient messages stacked at the top
 *   centre of the screen, e.g. "Variation applied" [Undo]. Toasts pause while
 *   hovered or focused; errors stay until dismissed unless given a duration
 *   (any caller may pass one, e.g. 3000 ms for "Undid: …").
 * - Placement contract (Toast.module.css): one place in every view, the
 *   bottom centre, on the keyboard strip's upper half (the element marked
 *   `[data-toast-floor]`; with none on screen, just above the window's bottom
 *   edge). Not above the strip: there every view keeps working controls (the
 *   pads' action bar, the step and velocity lanes, the last pads). Not at the
 *   top: there are the headers, tabs, the song's ruler and sections and the
 *   editing fields. On the strip the keys still play (their lower half, and
 *   the computer keys), and folded it is a line of words.
 *   While a menu is open (`body[data-popover-open]`, set by Popover) the
 *   stack goes below the menu; while a modal dialog is open
 *   (`body[data-modal-open]`, set by Dialog) its action keys are hidden.
 *   Guidance on screen (the quick guide's card, the "Try this" chip: shown
 *   elements marked `[data-toast-below][data-ready]`) is never covered: the
 *   stack goes just above it. It is placed each time the stack changes, after
 *   a resize, and again when the guidance or the keyboard strip moves.
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

  // The stack's place: on the keyboard strip, clear of guidance (see placeStack).
  const viewportRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    if (!toasts.length) {
      resetPlacement(el);
      return;
    }
    placeStack(el);
    let frame = 0;
    const later = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        placeStack(el);
      });
    };
    window.addEventListener('resize', later);
    // The guide or the hint chip may appear, move or go while toasts show, and the keyboard may fold or open: place again when they do.
    let last = placeKey();
    const watch = window.setInterval(() => {
      const key = placeKey();
      if (key === last) return;
      last = key;
      later();
    }, 400);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(watch);
      window.removeEventListener('resize', later);
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

function resetPlacement(el: HTMLElement): void {
  el.style.removeProperty('bottom');
}

/** Guidance the stack never covers: it goes above (the quick guide's card, the hint chip, once shown). */
const STACK_CLEAR = '[data-toast-below][data-ready]';
/** What the stack sits on: the keyboard strip (its upper half). */
const FLOOR = '[data-toast-floor]';
const GAP_PX = 8;

/** The boxes of the guidance on screen (see STACK_CLEAR). */
function guidanceBoxes(): DOMRect[] {
  const out: DOMRect[] = [];
  for (const g of document.querySelectorAll(STACK_CLEAR)) {
    const r = g.getBoundingClientRect();
    if (r.width > 2 && r.height > 2) out.push(r);
  }
  return out;
}

/** How far into the keyboard strip the stack's bottom edge reaches (px): a one-line toast covers the strip's upper half. */
const INTO_FLOOR_PX = 52;

/** The y the stack's bottom edge rests on: on the keyboard strip's upper half, or just above the window's bottom edge. */
function floorY(): number {
  const vh = document.documentElement.clientHeight;
  let y = vh - 12;
  for (const f of document.querySelectorAll(FLOOR)) {
    const r = f.getBoundingClientRect();
    // Only a strip along the lower part of the window counts.
    if (r.width > 2 && r.height > 2 && r.top > vh * 0.4) y = Math.min(y, r.top + Math.min(INTO_FLOOR_PX, r.height - 4));
  }
  return y;
}

/**
 * Where the stack's bottom edge must be so that it covers none of `boxes`
 * in its band (`left`..`right`, `height` tall, ending at `bottom`): above
 * each one it would overlap, in turn (lowest first). Pure geometry.
 */
export function bottomAboveGuidance(bottom: number, left: number, right: number, height: number, boxes: readonly { left: number; right: number; top: number; bottom: number }[]): number {
  let b = bottom;
  const sorted = [...boxes].sort((x, y) => y.bottom - x.bottom);
  for (const g of sorted) {
    if (g.left < right && g.right > left && g.top < b && g.bottom > b - height) b = g.top - GAP_PX;
  }
  return b;
}

/** A key for the guidance's and the floor's place now: placement runs again when it changes. */
function placeKey(): string {
  return `${Math.round(floorY())}|${guidanceBoxes()
    .map((r) => `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`)
    .join('|')}`;
}

/** Bottom centre, on the keyboard strip; above the guide or the hint chip if it would cover one. */
function placeStack(el: HTMLElement): void {
  const vh = document.documentElement.clientHeight;
  const floor = floorY();
  el.style.bottom = `${Math.round(vh - floor)}px`;
  const box = el.getBoundingClientRect();
  if (box.height === 0) return;
  const b = bottomAboveGuidance(floor, box.left, box.right, box.height, guidanceBoxes());
  if (b !== floor) el.style.bottom = `${Math.round(vh - Math.max(box.height + GAP_PX, b))}px`;
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
