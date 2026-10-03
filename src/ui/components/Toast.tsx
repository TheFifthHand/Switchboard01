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
 *   When a control (a tab, key, pad, field, song block…) sits under the
 *   centred stack, the stack moves to the nearest spot that covers none,
 *   narrowing to 440 or 360 px if it must (its real height at that width is
 *   measured), so it never covers what is about to be pressed; it is placed
 *   each time the stack changes and again after a scroll or resize.
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
    // A scroll or resize brings other controls under the band: place again on the next frame, or,
    // when placing proved costly (a crowded band), once the scrolling settles.
    let frame = 0;
    let timer = 0;
    let costly = false;
    const run = () => {
      frame = 0;
      const t0 = performance.now();
      placeClearOfControls(el);
      costly = performance.now() - t0 > 6;
    };
    const later = () => {
      if (costly) {
        window.clearTimeout(timer);
        timer = window.setTimeout(run, 100);
      } else if (!frame) frame = requestAnimationFrame(run);
    };
    window.addEventListener('resize', later);
    window.addEventListener('scroll', later, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
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

const CONTROL =
  'button, a[href], input, select, textarea, [role="tab"], [role="button"], [role="slider"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="option"], [role="spinbutton"], [role="combobox"], [contenteditable="true"], [data-block-id]';
/** Narrower widths the stack may take to clear a control (its default is min(520 px, window − 32 px)). */
const NARROWER_PX = [440, 360];
const COL_PX = 12;
const ROW_PX = 14;

function resetPlacement(el: HTMLElement): void {
  el.style.removeProperty('left');
  el.style.removeProperty('width');
  el.style.removeProperty('transform');
}

/**
 * Centred by default. When a control (a tab, key, pad, field, song block…)
 * lies under the stack as it would be drawn there, try spots further from the
 * centre, then narrower stacks (measuring the height each width really takes,
 * as text wraps), and take the first spot that covers no control. With none,
 * it stays centred. Controls are found by hit-testing a coarse grid of the
 * band once (the cards ignore the pointer while it is measured).
 */
function placeClearOfControls(el: HTMLElement): void {
  resetPlacement(el);
  const box = el.getBoundingClientRect();
  if (box.height === 0) return;
  const vw = document.documentElement.clientWidth;
  const sizes = [{ w: box.width, h: box.height }];
  for (const w of NARROWER_PX) {
    if (w >= box.width - 8) continue;
    el.style.width = `${w}px`;
    sizes.push({ w, h: el.getBoundingClientRect().height });
  }
  resetPlacement(el);
  const top = box.top;
  const cols = Math.floor(vw / COL_PX) + 1;
  const maxControl = vw * 0.6;
  // 0 = not looked at yet, 1 = clear, 2 = a control.
  const grid = new Map<number, number>();
  el.setAttribute('data-measuring', '');
  const blocked = (r: number, c: number): boolean => {
    const key = r * cols + c;
    let v = grid.get(key);
    if (v === undefined) {
      const hit = document.elementFromPoint(c * COL_PX, top + r * ROW_PX + 4);
      let control = hit && !el.contains(hit) ? hit.closest(CONTROL) : null;
      // A field's own frame (the box around its input) counts as the field.
      if (!control && hit && !el.contains(hit) && hit.getBoundingClientRect().width <= 240) control = hit.querySelector(CONTROL);
      v = control && control.getBoundingClientRect().width <= maxControl ? 2 : 1;
      grid.set(key, v);
    }
    return v === 2;
  };
  const clear = (left: number, w: number, h: number): boolean => {
    const rows = Math.ceil((h - 4) / ROW_PX);
    const c0 = Math.floor(left / COL_PX);
    const c1 = Math.min(cols - 1, Math.ceil((left + w) / COL_PX));
    for (let r = 0; r <= rows; r++) for (let c = c0; c <= c1; c++) if (blocked(r, c)) return false;
    return true;
  };
  try {
    const centre = vw / 2;
    if (clear(box.left, box.width, box.height)) return;
    for (const { w, h } of sizes) {
      const min = 16;
      const max = vw - 16 - w;
      if (max < min) continue;
      const mid = Math.min(Math.max(centre - w / 2, min), max);
      for (let d = 0; mid - d >= min || mid + d <= max; d += 16) {
        for (const left of d === 0 ? [mid] : [mid - d, mid + d]) {
          if (left < min || left > max) continue;
          if (clear(left, w, h)) {
            el.style.left = `${Math.round(left)}px`;
            el.style.width = `${Math.round(w)}px`;
            el.style.transform = 'none';
            return;
          }
        }
      }
    }
  } finally {
    el.removeAttribute('data-measuring');
  }
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
