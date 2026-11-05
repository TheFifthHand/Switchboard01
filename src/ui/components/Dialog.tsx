/**
 * Dialog — an accessible modal: role=dialog, aria-modal, labelled by its
 * title (and described by `description`), focus moves in on open, Tab is
 * trapped inside, Escape closes, and focus returns to where it was.
 *
 * The backdrop is a light veil so the instrument stays visible; clicking it
 * closes the dialog unless `dismissible` is false (e.g. during an export).
 *
 * The header and footer are plain groups, not banner/contentinfo landmarks
 * (the page has those already). While any dialog is open, body carries
 * `data-modal-open` (toasts hide their action keys then).
 */
import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './Button';
import styles from './Dialog.module.css';

export interface DialogProps {
  open: boolean;
  onClose(): void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Footer buttons. */
  actions?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Element to focus first (default: first focusable in the body, then the close button). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** When false, Escape and backdrop clicks do not close (the close button is hidden too). */
  dismissible?: boolean;
  closeLabel?: string;
  className?: string;
}

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.tabIndex >= 0 && !el.hasAttribute('hidden') && el.getClientRects().length > 0);
}

/** Open dialogs, innermost last: only the top one traps focus and handles Escape. */
const stack: HTMLElement[] = [];

/** body[data-modal-open] while at least one dialog is open. */
function markModalOpen(): void {
  if (typeof document === 'undefined') return;
  document.body.toggleAttribute('data-modal-open', stack.length > 0);
}

export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return createPortal(<DialogFrame {...props} />, document.body);
}

function DialogFrame({ onClose, title, description, children, actions, size = 'md', initialFocusRef, dismissible = true, closeLabel = 'Close', className }: DialogProps) {
  const titleId = useId();
  const descId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });

  // Focus in on open, restore on close.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    stack.push(dialog);
    markModalOpen();
    const target = initialFocusRef?.current ?? (bodyRef.current ? focusables(bodyRef.current)[0] : undefined) ?? focusables(dialog)[0] ?? dialog;
    target.focus({ preventScroll: true });
    return () => {
      const i = stack.indexOf(dialog);
      if (i >= 0) stack.splice(i, 1);
      markModalOpen();
      if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    };
    // Runs once per opening: the initial focus target is read at open time only.
  }, []);

  // Keep focus inside while this is the top dialog.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const dialog = ref.current;
      if (!dialog || stack[stack.length - 1] !== dialog) return;
      const t = e.target as Node | null;
      if (t && !dialog.contains(t)) (focusables(dialog)[0] ?? dialog).focus({ preventScroll: true });
    };
    document.addEventListener('focusin', onFocusIn);
    // Escape still closes when focus has left the dialog (e.g. the focused element was removed).
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      const dialog = ref.current;
      if (e.key !== 'Escape' || e.defaultPrevented || !dialog || stack[stack.length - 1] !== dialog) return;
      if (dialog.contains(document.activeElement)) return;
      if (dismissibleRef.current) {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onDocKey);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onDocKey);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dialog = ref.current;
    if (!dialog || stack[stack.length - 1] !== dialog) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (dismissible) {
        e.preventDefault();
        onCloseRef.current();
      }
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables(dialog);
    if (items.length === 0) {
      e.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className={styles.backdrop}
      onPointerDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={[styles.dialog, className].filter(Boolean).join(' ')}
        data-size={size}
        onKeyDown={onKeyDown}
      >
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          {dismissible && <IconButton icon="close" label={closeLabel} size="sm" onClick={() => onCloseRef.current()} className={styles.close} />}
        </div>
        {description && (
          <p id={descId} className={styles.description}>
            {description}
          </p>
        )}
        <div ref={bodyRef} className={styles.body}>
          {children}
        </div>
        {actions && <div className={styles.footer}>{actions}</div>}
      </div>
    </div>
  );
}
