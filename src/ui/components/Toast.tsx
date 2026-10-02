/**
 * Notices and toasts for errors and undoable actions.
 *
 * - `Notice`: an inline banner (e.g. "This part has no path to the output"
 *   with a Restore Connection action, or an autosave error with Retry).
 * - `ToastProvider` + `useToasts()`: transient messages stacked at the bottom
 *   of the screen, e.g. "Variation applied" [Undo]. Toasts pause while
 *   hovered or focused; errors stay until dismissed unless given a duration
 *   (any caller may pass one, e.g. 3000 ms for "Undid: …").
 * - Placement contract (Toast.module.css): the stack sits above the on-screen
 *   keyboard (`--keyboard-h`, set by the KeyboardStrip); while a menu is open
 *   (`body[data-popover-open]`, set by Popover) it moves to the top, under the
 *   transport (`--transport-h`), below the menu; while a modal dialog is open
 *   (`body[data-modal-open]`, set by Dialog) its action keys are hidden.
 *
 * Tone is shown by an icon and wording, not colour alone: coral marks
 * warnings and errors (attention); info/success are neutral.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className={styles.viewport} aria-live="polite" aria-relevant="additions text">
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
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
