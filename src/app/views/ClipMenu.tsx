/**
 * Clip pad menu for the Loops grid, plus the small popover primitives the
 * part, scene, arpeggiator and recording-option popovers share.
 *
 * Popover: a portalled surface positioned next to its trigger (or at the
 * pointer for a right-click), kept inside the viewport, closed by Escape, an
 * outside press or a window resize, and giving focus back to where it came
 * from. Below the trigger (or above it) when it fits there, else beside it,
 * so it never covers the key that opened it. A press on that key (the open
 * popup's trigger, or the `ignore` element) is not an outside press: the
 * key's own click closes it again. A menu closed by an outside press takes
 * that press: nothing under the pointer starts (a pad, Stop, a knob) and its
 * click is swallowed (once; keys are never affected), except on another
 * menu's trigger, which opens its own menu at once. While any popover is
 * open, body carries data-popover-open (counted, so nested or overlapping
 * popovers keep it until the last one closes): the toasts (at the top, under
 * the transport) stack below the menu. For a moment after it opens, a click that
 * comes without the pointer moving (the second half of a double-click on the
 * trigger) does nothing. Rows light up under the pointer only once it moves
 * over the menu (keyboard focus always shows); then the row under the
 * pointer takes the focus, so one row is lit at a time. As role="menu" it
 * moves focus with the arrow keys (Left/Right move within a row of keys such
 * as the clip length), Home/End jump, Tab closes; Ctrl/⌘+Z, Ctrl+Shift+Z and
 * Ctrl+Y close it and reach the app's Undo / Redo. As role="dialog" (a
 * settings panel) it is not modal: keys other than Escape pass through, so
 * the computer keyboard still plays notes.
 *
 * Clip actions (rename, length, double, repeat, duplicate, copy/paste,
 * clear, delete, new clip) are all undoable project commands; destructive
 * ones show a toast with Undo, a new clip's toast offers Edit steps. The same
 * actions back the pad keyboard shortcuts (Delete, Ctrl+C, Ctrl+V, F2)
 * handled by the grid. While a performance take records, the editing rows
 * are unavailable and say why (Copy and Edit steps stay).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, Icon, Tooltip, useToasts, type IconName, type ToastApi } from '../../ui/components';
import { CLIP_BAR_CHOICES, MAX_CLIP_BARS, type ClipBars, type Id } from '../../project/types';
import * as cmd from '../../state/commands';
import { selectSlot, selectTrack, setClipboard, setPadMode, uiStore } from '../../state/uiStore';
import { shallowEqual, useStore } from '../../state/store';
import { session, useProject, useUi } from '../instance';
import { notify } from '../runtime';
import { barsLabel } from '../labels';
import styles from './ClipMenu.module.css';

/* ------------------------------------------------------------------ */
/* Popover primitives                                                  */
/* ------------------------------------------------------------------ */

/** Where a popover opens: a trigger's rectangle, or a point (zero size). */
export interface MenuAnchor {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function anchorFromElement(el: Element | null | undefined): MenuAnchor {
  if (!el) return { left: 16, top: 16, width: 0, height: 0 };
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export function anchorFromPoint(x: number, y: number): MenuAnchor {
  return { left: x, top: y, width: 0, height: 0 };
}

/**
 * Anchor for a contextmenu event: the pointer position for a mouse or touch
 * press, the element itself when the menu key (or Shift+F10) raised it.
 */
export function anchorFromContextEvent(e: { clientX: number; clientY: number }, el: Element | null): MenuAnchor {
  if (!el) return anchorFromPoint(e.clientX, e.clientY);
  const r = el.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  return inside && (e.clientX !== 0 || e.clientY !== 0) ? anchorFromPoint(e.clientX, e.clientY) : anchorFromElement(el);
}

/** Keys that open a context menu from the keyboard. */
export function isMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}

let lastKeyboardMenu: { at: number; el: Element | null } = { at: -Infinity, el: null };
/** Mark that a keyboard shortcut just opened a menu for `el` (the browser may follow with its own contextmenu event). */
export function noteKeyboardMenu(el: Element | null): void {
  lastKeyboardMenu = { at: performance.now(), el };
}
/** True when a contextmenu event on `target` merely repeats a menu the keyboard handler already opened. */
export function isEchoOfKeyboardMenu(target: EventTarget | null): boolean {
  const { at, el } = lastKeyboardMenu;
  if (!el || !(target instanceof Node) || performance.now() - at > 400) return false;
  return el === target || el.contains(target) || target.contains(el);
}

export interface PopoverProps {
  anchor: MenuAnchor;
  /** Accessible name. */
  label: string;
  role?: 'menu' | 'dialog';
  /** Preferred side of the anchor; flips when there is no room. */
  placement?: 'below' | 'above';
  /** Horizontal alignment with the anchor. */
  align?: 'start' | 'end';
  onClose(): void;
  /** Focus goes here when the popover closes with focus inside it (default: what was focused when it opened). */
  returnFocus?: HTMLElement | null;
  /** Presses inside this element (the trigger, or a whole strip) do not close the popover. */
  ignore?: Element | null;
  className?: string;
  id?: string;
  children: ReactNode;
}

const EDGE = 8;
const GAP = 4;
/**
 * After opening, pointer clicks that come without the pointer moving are
 * ignored for this long: the second click of a double-click on the trigger
 * must never choose a menu item.
 */
export const MENU_CLICK_GUARD_MS = 300;
/** Pointer travel (px) after opening that makes a click deliberate. */
const MOVED_PX = 3;

/** Where the pointer was last seen (its press or move), so a menu knows where it opened from. */
let lastPointer: { x: number; y: number } | null = null;
if (typeof document !== 'undefined') {
  const note = (e: PointerEvent) => {
    lastPointer = { x: e.clientX, y: e.clientY };
  };
  document.addEventListener('pointerdown', note, { capture: true, passive: true });
  document.addEventListener('pointermove', note, { capture: true, passive: true });
}

/** Undo / Redo keys (Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, Ctrl/⌘+Y). */
export function isHistoryKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  const k = e.key.toLowerCase();
  return k === 'z' || k === 'y';
}

/**
 * Where a popover of size w x h goes next to `anchor` inside a vw x vh
 * window: below (or above, as preferred) when it fits there whole; else
 * beside the anchor (right, or left for end-aligned menus, whichever fits),
 * top-aligned with it, so it never covers its trigger; failing that (a window
 * too small for both), clamped into view.
 */
export function placePopover(
  anchor: MenuAnchor,
  size: { w: number; h: number },
  view: { vw: number; vh: number },
  opts: { placement?: 'below' | 'above'; align?: 'start' | 'end' } = {},
): { left: number; top: number; side: 'below' | 'above' | 'right' | 'left' | 'over' } {
  const { w, h } = size;
  const { vw, vh } = view;
  const placement = opts.placement ?? 'below';
  const align = opts.align ?? 'start';
  const below = anchor.top + anchor.height + GAP;
  const above = anchor.top - GAP - h;
  const fitsBelow = below + h <= vh - EDGE;
  const fitsAbove = above >= EDGE;
  const clampX = (x: number) => clamp(x, EDGE, Math.max(EDGE, vw - EDGE - w));
  const clampY = (y: number) => clamp(y, EDGE, Math.max(EDGE, vh - EDGE - h));
  const vertical = (side: 'below' | 'above') => ({ left: clampX(align === 'end' ? anchor.left + anchor.width - w : anchor.left), top: side === 'below' ? below : above, side });
  if (placement === 'above' ? fitsAbove : fitsBelow) return vertical(placement);
  if (placement === 'above' ? fitsBelow : fitsAbove) return vertical(placement === 'above' ? 'below' : 'above');
  // Neither: beside the trigger, top-aligned with it.
  const right = anchor.left + anchor.width + GAP;
  const left = anchor.left - GAP - w;
  const fitsRight = right + w <= vw - EDGE;
  const fitsLeft = left >= EDGE;
  const top = clampY(anchor.top);
  if (align === 'end' ? fitsLeft : fitsRight) return { left: align === 'end' ? left : right, top, side: align === 'end' ? 'left' : 'right' };
  if (align === 'end' ? fitsRight : fitsLeft) return { left: align === 'end' ? right : left, top, side: align === 'end' ? 'right' : 'left' };
  // No room anywhere: inside the window, where it was meant to go.
  return { left: clampX(align === 'end' ? anchor.left + anchor.width - w : anchor.left), top: clampY(placement === 'above' ? above : below), side: 'over' };
}

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** How many popovers are open now: body[data-popover-open] stays while any is. */
let openPopovers = 0;
function popoverOpened(): () => void {
  openPopovers += 1;
  document.body.dataset.popoverOpen = '';
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    openPopovers = Math.max(0, openPopovers - 1);
    if (openPopovers === 0) delete document.body.dataset.popoverOpen;
  };
}

/** A click that follows a swallowed press is swallowed this long after the pointer comes up (a touch's click comes a little later). */
const SWALLOW_AFTER_UP_MS = 400;
/** And never later than this after the press (a press whose release never comes). */
const SWALLOW_MAX_MS = 3000;

/**
 * An outside press that closes a menu does nothing else: nothing below sees
 * the press (a pad would start on its release, a knob would grab), and the
 * click it makes is swallowed once, in the capture phase, before anything
 * can act on it. Only pointer clicks: a key's click (detail 0) always counts.
 * Right and middle presses pass (a right-click elsewhere opens its own menu).
 */
function consumePress(e: PointerEvent): void {
  if (e.button !== 0 || !e.isPrimary) return;
  e.stopPropagation();
  const id = e.pointerId;
  let afterUp = 0;
  const done = () => {
    window.clearTimeout(afterUp);
    window.clearTimeout(cap);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    window.removeEventListener('pointerdown', onNextDown, true);
  };
  const onClick = (ev: globalThis.MouseEvent) => {
    if (ev.detail === 0) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    done();
  };
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    window.clearTimeout(afterUp);
    afterUp = window.setTimeout(done, SWALLOW_AFTER_UP_MS);
  };
  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId === id) done();
  };
  // A new press starts something new: the old one's click is not coming.
  const onNextDown = (ev: PointerEvent) => {
    if (ev !== e) done();
  };
  const cap = window.setTimeout(done, SWALLOW_MAX_MS);
  window.addEventListener('click', onClick, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('pointerdown', onNextDown, true);
}

export function Popover({ anchor, label, role = 'menu', placement = 'below', align = 'start', onClose, returnFocus, ignore, className, id, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const focusInside = useRef(false);
  const restoreTo = useRef<HTMLElement | null>(null);
  /** Set while unmounting, so giving focus back does not count as "focus left the popover". */
  const unmounting = useRef(false);
  const roleRef = useRef(role);
  roleRef.current = role;

  // Toasts step aside (to the top) while any popover is open.
  useLayoutEffect(() => popoverOpened(), []);

  // Position next to the anchor, inside the viewport; follow size changes (e.g. switching to a rename field).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const p = placePopover(anchor, { w: el.offsetWidth, h: el.offsetHeight }, { vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight }, { placement, align });
      const left = Math.round(p.left);
      const top = Math.round(p.top);
      el.dataset.side = p.side;
      setPos((q) => (q && q.left === left && q.top === top ? q : { left, top }));
    };
    place();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [anchor.left, anchor.top, anchor.width, anchor.height, placement, align]);

  // A click right after opening, with the pointer where it was (a double-click on the trigger), chooses nothing.
  const opened = useRef<{ at: number; x: number | null; y: number | null; moved: boolean }>({ at: 0, x: null, y: null, moved: false });
  useLayoutEffect(() => {
    opened.current = { at: performance.now(), x: lastPointer?.x ?? null, y: lastPointer?.y ?? null, moved: false };
    const onMove = (e: PointerEvent) => {
      const o = opened.current;
      if (o.moved) return;
      if (o.x === null || o.y === null) {
        o.x = e.clientX;
        o.y = e.clientY;
      } else if (Math.hypot(e.clientX - o.x, e.clientY - o.y) >= MOVED_PX) o.moved = true;
    };
    document.addEventListener('pointermove', onMove, true);
    return () => document.removeEventListener('pointermove', onMove, true);
  }, []);
  const guardClick = (e: MouseEvent<HTMLDivElement>) => {
    const o = opened.current;
    // Keyboard presses (detail 0) always count; so does a click after the pointer moved or the moment passed.
    if (e.detail === 0 || o.moved || performance.now() - o.at >= MENU_CLICK_GUARD_MS) return;
    e.preventDefault();
    e.stopPropagation();
  };

  // Focus in on open (unless a child already took it), and back out on close.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    unmounting.current = false;
    restoreTo.current = returnFocus ?? restoreTo.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (!el.contains(document.activeElement)) {
      const target = el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>(`${ITEM_SELECTOR}, input, button:not([disabled]), [tabindex="0"]`) ?? el;
      target.focus({ preventScroll: true });
    }
    focusInside.current = true;
    return () => {
      unmounting.current = true;
      const active = document.activeElement;
      if (focusInside.current || !active || active === document.body) {
        const r = restoreTo.current;
        if (r && r.isConnected) r.focus({ preventScroll: true });
      }
    };
    // Runs once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Outside presses and window changes close it. A press on the open popup's own trigger is not outside:
  // the trigger's click closes it (pressing it again toggles), instead of closing here and reopening there.
  // A menu closed this way takes the press (see consumePress); a non-modal panel lets it through.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || (ignore && ignore.contains(t))) return;
      if (t instanceof Element && t.closest('[aria-haspopup][aria-expanded="true"]')) return;
      focusInside.current = false;
      // A press on another menu's trigger is not swallowed: this menu closes and that one opens, on the first click.
      if (roleRef.current === 'menu' && !(t instanceof Element && t.closest('[aria-haspopup]'))) consumePress(e);
      onCloseRef.current();
    };
    const onResize = () => onCloseRef.current();
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onResize);
    };
  }, [ignore]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    // A panel (arpeggiator, recording options, rename) is not modal: other keys keep
    // working, so computer-key notes, Space and Ctrl+Z still reach the instrument.
    if (role !== 'menu') return;
    // Undo / Redo work with a menu open: the menu (about what is there now) closes and the key goes on to the app.
    if (isHistoryKey(e)) {
      onCloseRef.current();
      return;
    }
    // Ctrl/⌘+A in a menu selects nothing (and never the page's text).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    const items = Array.from(el.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
    if (items.length === 0) return;
    const current = document.activeElement as HTMLElement | null;
    const i = current ? items.indexOf(current) : -1;
    let next: HTMLElement | undefined;
    switch (e.key) {
      case 'ArrowDown':
        next = items[(i + 1 + items.length) % items.length];
        if (current?.dataset.row) {
          // Leave a row of keys downwards: skip the rest of the row.
          let j = i + 1;
          while (j < items.length && items[j].dataset.row === current.dataset.row) j++;
          next = items[j % items.length];
        }
        break;
      case 'ArrowUp': {
        let j = i - 1;
        if (current?.dataset.row) while (j >= 0 && items[j].dataset.row === current.dataset.row) j--;
        if (j < 0) j = items.length - 1;
        // Enter a row from below at its first key.
        const row = items[j].dataset.row;
        if (row) while (j > 0 && items[j - 1].dataset.row === row) j--;
        next = items[j];
        break;
      }
      case 'ArrowRight':
      case 'ArrowLeft': {
        const row = current?.dataset.row;
        if (!row) return;
        const d = e.key === 'ArrowRight' ? 1 : -1;
        const cand = items[i + d];
        if (cand && cand.dataset.row === row) next = cand;
        else {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        break;
      }
      case 'Home':
        next = items[0];
        break;
      case 'End':
        next = items[items.length - 1];
        break;
      default:
        e.stopPropagation();
        return;
    }
    // Entering a row of keys from above or below lands on its checked key.
    if (next && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && next.dataset.row) {
      const row = next.dataset.row;
      next = items.find((x) => x.dataset.row === row && x.getAttribute('aria-checked') === 'true') ?? next;
    }
    e.preventDefault();
    e.stopPropagation();
    next?.focus({ preventScroll: true });
  };

  return createPortal(
    <div
      ref={ref}
      id={id}
      role={role}
      aria-label={label}
      tabIndex={-1}
      className={[styles.popover, className].filter(Boolean).join(' ')}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0, opacity: 0 }}
      onKeyDown={onKeyDown}
      onClickCapture={guardClick}
      onPointerMove={(e) => {
        // Rows light up under the pointer only once it moves over the menu (not under a pointer resting where the menu opened).
        const el = ref.current;
        if (!el) return;
        if (!('pointer' in el.dataset)) el.dataset.pointer = '';
        // In a menu the row under a moving pointer also takes the focus, so one row is lit, never two
        // (the keyboard then goes on from there).
        if (role !== 'menu' || e.pointerType === 'touch') return;
        const item = e.target instanceof Element ? e.target.closest<HTMLElement>(ITEM_SELECTOR) : null;
        if (item && el.contains(item) && document.activeElement !== item) item.focus({ preventScroll: true });
      }}
      onFocus={() => {
        focusInside.current = true;
      }}
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        if (unmounting.current || (to && ref.current?.contains(to))) return;
        focusInside.current = false;
        // A non-modal panel closes when keyboard focus moves on to the rest of the page.
        if (role === 'dialog' && to && !(ignore && ignore.contains(to))) onCloseRef.current();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Title block at the top of a menu. */
export function MenuHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <div className={styles.header} role="presentation">
      {eyebrow && <div className={styles.eyebrow}>{eyebrow}</div>}
      <div className={styles.title}>{title}</div>
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <div role="separator" className={styles.separator} />;
}

export interface MenuItemProps {
  icon?: IconName;
  children: ReactNode;
  /**
   * Right-aligned hint: a shortcut or the current value. With `keyShortcut`
   * it is the shortcut, drawn as key caps ("Ctrl+V" → [Ctrl] [V]); otherwise
   * words in the UI font.
   */
  hint?: string;
  onSelect(): void;
  disabled?: boolean;
  /** Why the item is unavailable (read out and shown as the hint). */
  disabledReason?: string;
  tone?: 'danger';
  role?: 'menuitem' | 'menuitemcheckbox';
  checked?: boolean;
  keyShortcut?: string;
}

/** A shortcut drawn as key caps: "Ctrl+Shift+Z" → [Ctrl] [Shift] [Z]; "⌘C" stays one cap. (aria-keyshortcuts says it to screen readers.) */
export function KeyCaps({ keys, className }: { keys: string; className?: string }) {
  const parts = keys.length > 1 ? keys.split('+').filter(Boolean) : [keys];
  return (
    <span className={[styles.caps, className].filter(Boolean).join(' ')} aria-hidden="true">
      {parts.map((k, i) => (
        <kbd key={i} className={styles.cap}>
          {k}
        </kbd>
      ))}
    </span>
  );
}

/** A menu row. Disabled rows stay focusable (so they can be discovered) but do nothing. */
export function MenuItem({ icon, children, hint, onSelect, disabled, disabledReason, tone, role = 'menuitem', checked, keyShortcut }: MenuItemProps) {
  const reason = disabled && disabledReason ? disabledReason : null;
  const shownHint = reason ?? hint;
  const caps = !reason && !!keyShortcut && !!hint;
  return (
    <button
      type="button"
      role={role}
      tabIndex={-1}
      className={styles.item}
      data-tone={tone}
      aria-disabled={disabled || undefined}
      aria-checked={role === 'menuitemcheckbox' ? !!checked : undefined}
      aria-keyshortcuts={keyShortcut}
      onClick={() => {
        if (!disabled) onSelect();
      }}
    >
      <span className={styles.itemIcon} aria-hidden="true">
        {icon && <Icon name={icon} size={14} />}
      </span>
      <span className={styles.itemText}>{children}</span>
      {caps ? <KeyCaps keys={hint!} className={styles.itemKeys} /> : shownHint && <span className={styles.itemHint}>{shownHint}</span>}
    </button>
  );
}

/** A row of small keys inside a menu (e.g. clip length 1-8); Left/Right move along it. */
export function MenuKeyRow<T extends string | number>(props: {
  label: string;
  unit?: string;
  row: string;
  options: readonly { value: T; label: string; ariaLabel: string }[];
  value?: T | null;
  onSelect(value: T): void;
  disabled?: boolean;
  /** Why the keys do nothing now (their description). */
  disabledReason?: string;
  /** What the keys do, in a sentence (the row's description, also shown as a tooltip on its label). */
  tip?: string;
}) {
  const { label, unit, row, options, value, onSelect, disabled, disabledReason, tip } = props;
  const labelId = useId();
  const tipId = useId();
  const described = (disabled && disabledReason) || tip;
  // The tooltip wraps the whole row (the group): in a menu only items, groups and separators may carry ARIA, so its
  // description goes on the group, never on a wrapper of the keys. Each key carries the row's sentence itself (also
  // with Tips off).
  return (
    <Tooltip tip={described || undefined} disabled={!described}>
      <div className={styles.keyRow} role="group" aria-labelledby={labelId}>
        <span id={labelId} className={styles.keyRowLabel}>
          {label}
        </span>
        {described && (
          <span id={tipId} hidden>
            {described}
          </span>
        )}
        <span className={styles.keys}>
          {options.map((o) => (
            <button
              key={String(o.value)}
              type="button"
              role="menuitemradio"
              tabIndex={-1}
              data-row={row}
              aria-checked={value === o.value}
              aria-label={o.ariaLabel}
              aria-disabled={disabled || undefined}
              aria-describedby={described ? tipId : undefined}
              className={styles.key}
              data-on={value === o.value || undefined}
              onClick={() => {
                if (!disabled) onSelect(o.value);
              }}
            >
              {o.label}
            </button>
          ))}
        </span>
        {unit && (
          <span className={styles.keyRowUnit} aria-hidden="true">
            {unit}
          </span>
        )}
      </div>
    </Tooltip>
  );
}

/** Inline rename field used by the part, clip and scene menus. Enter saves, Escape cancels. */
export function RenameForm(props: { label: string; initial: string; maxLength: number; submitLabel?: string; onSubmit(name: string): boolean; onCancel(): void }) {
  const { label, initial, maxLength, submitLabel = 'Rename', onSubmit, onCancel } = props;
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.select();
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.replace(/\s+/g, ' ').trim();
    if (!v) {
      setError('Type a name, or press Escape to keep the old one.');
      inputRef.current?.focus();
      return;
    }
    if (v === initial) {
      onCancel();
      return;
    }
    if (!onSubmit(v)) inputRef.current?.focus();
  };
  return (
    <form className={styles.rename} onSubmit={submit}>
      <label className={styles.renameLabel} htmlFor={inputId}>
        {label}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        className={styles.renameInput}
        value={value}
        maxLength={maxLength}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => {
          setValue(e.currentTarget.value);
          if (error) setError(null);
        }}
      />
      {error && (
        <p id={errorId} className={styles.renameError} role="alert">
          {error}
        </p>
      )}
      <div className={styles.renameActions}>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" icon="check">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Three-dot glyph for "more options" buttons. */
export function MoreIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx={3.2} cy={8} r={1.4} fill="currentColor" />
      <circle cx={8} cy={8} r={1.4} fill="currentColor" />
      <circle cx={12.8} cy={8} r={1.4} fill="currentColor" />
    </svg>
  );
}

/** Platform label for the command key. */
export const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl+';
/** The same key for aria-keyshortcuts. */
export const MOD_ARIA = MOD_KEY === '⌘' ? 'Meta' : 'Control';

/* ------------------------------------------------------------------ */
/* The take lock                                                        */
/* ------------------------------------------------------------------ */

/** Said where an edit would be: clips, scenes and parts are locked while a performance take records. */
export const LOCKED_TEXT = 'Locked while a performance records';
/** The short reason a menu row shows (and reads out) while locked. */
export const LOCKED_REASON = 'Locked while recording';
/** The one-line notice for a key that would edit while locked. */
const LOCKED_NOTICE = 'Locked while a performance records. Stop the take to change clips and scenes.';

/** The project refuses edits now (a performance take records): views show it instead of offering what would be refused. */
export function isEditLocked(): boolean {
  return session.store.info.getState().lock !== null;
}
export function useEditLocked(): boolean {
  return useStore(session.store.info, (s) => s.lock !== null);
}

/** The app's toasts; null where no ToastProvider is mounted (a view rendered on its own). */
export function useToastsIfAny(): ToastApi | null {
  try {
    return useToasts();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Clip actions (menu items and pad shortcuts)                          */
/* ------------------------------------------------------------------ */

function trackAndClip(trackId: Id, slot: number) {
  const p = session.store.getState();
  const track = p.tracks.find((t) => t.id === trackId);
  return { p, track, clip: track?.clips[slot] ?? null, scene: p.scenes[slot]?.name ?? `Row ${slot + 1}` };
}

/** Next empty slot after `slot` on the same part (wrapping over its rows, one per scene), or null. */
export function nextEmptySlot(clips: readonly unknown[], slot: number): number | null {
  const rows = clips.length;
  for (let k = 1; k < rows; k++) {
    const s = (slot + k) % rows;
    if (!clips[s]) return s;
  }
  return null;
}

/** Refused at once (one line) while a take records, instead of the store's long refusal. */
function lockedNow(): boolean {
  if (!isEditLocked()) return false;
  notify(LOCKED_NOTICE, 'warn');
  return true;
}

/** Where the selected pad's "Edit steps" key is (the pad action bar under the grid). */
export const EDIT_STEPS_SELECTOR = '[data-pad-actions] [data-edit-steps]';

export const clipActions = {
  /**
   * A new empty clip. With the app's toasts, the toast offers "Edit steps"
   * (the view rendered alone falls back to the notice with Undo).
   */
  create(trackId: Id, slot: number, bars: ClipBars, toasts?: ToastApi | null): boolean {
    if (lockedNow()) return false;
    const r = cmd.createClip(session.store, trackId, slot, bars);
    if (!session.accepted(r)) return false;
    selectTrack(trackId);
    selectSlot(trackId, slot);
    const { track, clip } = trackAndClip(trackId, slot);
    const text = `New ${bars}-bar clip "${clip?.name ?? ''}" on ${track?.name ?? 'this part'}. Add notes in Steps or with Record Notes.`;
    if (toasts) toasts.show({ id: 'notice', tone: 'info', message: text, action: { label: 'Edit steps', onAction: () => clipActions.editSteps(trackId, slot) } });
    else notify(text, 'info', 'undo');
    return true;
  },

  rename(trackId: Id, slot: number, name: string): boolean {
    if (lockedNow()) return false;
    return session.accepted(cmd.renameClip(session.store, trackId, slot, name));
  },

  setBars(trackId: Id, slot: number, bars: ClipBars): boolean {
    if (lockedNow()) return false;
    const before = trackAndClip(trackId, slot).clip?.notes.length ?? 0;
    if (!session.accepted(cmd.setClipBars(session.store, trackId, slot, bars))) return false;
    const after = trackAndClip(trackId, slot).clip?.notes.length ?? 0;
    if (after < before) notify(`Clip shortened to ${barsLabel(bars)}: ${before - after} note${before - after === 1 ? '' : 's'} past the end removed.`, 'info', 'undo');
    return true;
  },

  /** Double the clip by repeating it (1 → 2, 2 → 4, 4 → 8 bars; longer ones fill up to 8). */
  double(trackId: Id, slot: number): boolean {
    if (lockedNow()) return false;
    const { clip } = trackAndClip(trackId, slot);
    if (!clip) return false;
    if (!session.accepted(cmd.duplicateClipContent(session.store, trackId, slot))) return false;
    const now = trackAndClip(trackId, slot).clip;
    notify(`Doubled "${clip.name}" to ${barsLabel(now?.bars ?? clip.bars)}: it plays its pattern twice.`, 'info', 'undo');
    return true;
  },

  /** Repeat the clip's bars until it is `bars` long (a 3-bar clip made 8 bars plays 1 2 3 1 2 3 1 2). */
  repeatTo(trackId: Id, slot: number, bars: ClipBars): boolean {
    if (lockedNow()) return false;
    const { clip } = trackAndClip(trackId, slot);
    if (!clip) return false;
    if (!session.accepted(cmd.repeatClipToBars(session.store, trackId, slot, bars))) return false;
    notify(`"${clip.name}" now repeats to fill ${barsLabel(bars)}.`, 'info', 'undo');
    return true;
  },

  duplicate(trackId: Id, slot: number): boolean {
    if (lockedNow()) return false;
    const { track, clip } = trackAndClip(trackId, slot);
    if (!track || !clip) return false;
    const to = nextEmptySlot(track.clips, slot);
    if (to === null) {
      notify(`${track.name} has no empty slot left. Delete or clear a clip first.`, 'warn');
      return false;
    }
    if (!session.accepted(cmd.duplicateClipToSlot(session.store, trackId, slot, to))) return false;
    selectSlot(trackId, to);
    notify(`Duplicated "${clip.name}" into ${trackAndClip(trackId, to).scene}.`, 'info', 'undo');
    return true;
  },

  copy(trackId: Id, slot: number): boolean {
    const { p, clip } = trackAndClip(trackId, slot);
    if (!clip) {
      notify('This slot is empty, so there is nothing to copy.', 'warn');
      return false;
    }
    setClipboard(cmd.copyClip(p, trackId, slot));
    notify(`Copied "${clip.name}". Paste it into any slot with ${MOD_KEY}V or the pad menu.`);
    return true;
  },

  paste(trackId: Id, slot: number): boolean {
    const clipboard = uiStore.getState().clipboard;
    if (!clipboard) {
      notify(`Copy a clip first (${MOD_KEY}C on a pad, or Copy in its menu).`, 'warn');
      return false;
    }
    if (lockedNow()) return false;
    const { track, clip: replaced, scene } = trackAndClip(trackId, slot);
    const r = cmd.pasteClip(session.store, trackId, slot, clipboard);
    if (!session.accepted(r)) return false;
    selectTrack(trackId);
    selectSlot(trackId, slot);
    const what = replaced ? `replacing "${replaced.name}"` : `into ${scene}`;
    notify(`Pasted "${clipboard.name}" on ${track?.name ?? 'this part'}, ${what}.${r.message ? ` ${r.message}` : ''}`, 'info', 'undo');
    return true;
  },

  clear(trackId: Id, slot: number): boolean {
    const { clip } = trackAndClip(trackId, slot);
    if (!clip || clip.notes.length === 0) return false;
    if (lockedNow()) return false;
    if (!session.accepted(cmd.clearClip(session.store, trackId, slot))) return false;
    notify(`Cleared the notes of "${clip.name}". The empty clip stays in its slot.`, 'info', 'undo');
    return true;
  },

  remove(trackId: Id, slot: number): boolean {
    const { track, clip } = trackAndClip(trackId, slot);
    if (!clip) return false;
    if (lockedNow()) return false;
    if (!session.accepted(cmd.deleteClip(session.store, trackId, slot))) return false;
    notify(`Deleted "${clip.name}" from ${track?.name ?? 'this part'}.`, 'info', 'undo');
    return true;
  },

  editSteps(trackId: Id, slot: number): void {
    selectTrack(trackId);
    selectSlot(trackId, slot);
    setPadMode('steps');
  },
};

/* ------------------------------------------------------------------ */
/* Clip menu                                                           */
/* ------------------------------------------------------------------ */

const LENGTH_OPTIONS = CLIP_BAR_CHOICES.map((b) => ({ value: b, label: String(b), ariaLabel: `Length ${barsLabel(b)}` }));
const NEW_OPTIONS = CLIP_BAR_CHOICES.map((b) => ({ value: b, label: String(b), ariaLabel: `New clip, ${barsLabel(b)}` }));
/** Length's tooltip: what changing it does to the notes. */
export const LENGTH_TIP = 'How many bars the clip loops over. Longer: the new bars start empty (Double or Repeat to 8 bars fill them with the pattern). Shorter: notes past the new end are removed; Undo brings them back.';
const LONGEST: ClipBars = MAX_CLIP_BARS as ClipBars;

export interface ClipMenuProps {
  trackId: Id;
  slot: number;
  anchor: MenuAnchor;
  returnFocus?: HTMLElement | null;
  ignore?: Element | null;
  /** Open straight into the rename field (F2). */
  startInRename?: boolean;
  onClose(): void;
  /** Start moving this clip with the keyboard (arrow keys, Enter); the menu closes first. */
  onMove?(): void;
}

export function ClipMenu({ trackId, slot, anchor, returnFocus, ignore, startInRename, onClose, onMove }: ClipMenuProps) {
  const info = useProject(
    (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      const clip = t?.clips[slot] ?? null;
      const to = t && clip ? nextEmptySlot(t.clips, slot) : null;
      return {
        trackName: t?.name ?? '',
        scene: p.scenes[slot]?.name ?? `Row ${slot + 1}`,
        clipName: clip?.name ?? null,
        bars: clip?.bars ?? null,
        notes: clip?.notes.length ?? 0,
        duplicateTo: to,
        duplicateScene: to === null ? null : (p.scenes[to]?.name ?? null),
      };
    },
    shallowEqual,
  );
  const clipboardName = useUi((s) => s.clipboard?.name ?? null);
  const locked = useEditLocked();
  const toasts = useToastsIfAny();
  const [renaming, setRenaming] = useState(!!startInRename && info.clipName !== null && !locked);

  const act = (fn: () => unknown) => {
    fn();
    onClose();
  };

  if (renaming && info.clipName !== null) {
    return (
      <Popover anchor={anchor} label={`Rename clip ${info.clipName}`} role="dialog" onClose={onClose} returnFocus={returnFocus} ignore={ignore}>
        <MenuHeader eyebrow={`${info.trackName} · ${info.scene}`} title="Rename clip" />
        <RenameForm
          label="Clip name"
          initial={info.clipName}
          maxLength={60}
          onSubmit={(name) => {
            if (!clipActions.rename(trackId, slot, name)) return false;
            onClose();
            return true;
          }}
          onCancel={onClose}
        />
      </Popover>
    );
  }

  if (info.clipName === null) {
    return (
      <Popover anchor={anchor} label={`Empty slot: ${info.trackName}, ${info.scene}`} onClose={onClose} returnFocus={returnFocus} ignore={ignore}>
        <MenuHeader eyebrow={`${info.trackName} · ${info.scene}`} title="Empty slot">
          {locked && <div className={styles.meta}>{LOCKED_TEXT}.</div>}
        </MenuHeader>
        <MenuKeyRow
          label="New clip"
          unit="bars"
          row="new"
          options={NEW_OPTIONS}
          disabled={locked}
          disabledReason={LOCKED_TEXT}
          tip="An empty clip of that many bars, ready for notes: Edit steps opens it."
          onSelect={(b) => {
            const made = clipActions.create(trackId, slot, b, toasts);
            onClose();
            // The next step is to fill it: focus goes to the pad actions' Edit steps (after the menu gives focus back).
            if (made) requestAnimationFrame(() => document.querySelector<HTMLElement>(EDIT_STEPS_SELECTOR)?.focus());
          }}
        />
        <MenuSeparator />
        <MenuItem
          icon="paste"
          hint={`${MOD_KEY}V`}
          keyShortcut={`${MOD_ARIA}+V`}
          disabled={!clipboardName || locked}
          disabledReason={locked ? LOCKED_REASON : 'Copy a clip first'}
          onSelect={() => act(() => clipActions.paste(trackId, slot))}
        >
          {clipboardName ? `Paste “${clipboardName}”` : 'Paste'}
        </MenuItem>
      </Popover>
    );
  }

  const bars = info.bars ?? 1;
  return (
    <Popover anchor={anchor} label={`Clip ${info.clipName}: ${info.trackName}, ${info.scene}`} onClose={onClose} returnFocus={returnFocus} ignore={ignore}>
      <MenuHeader eyebrow={`${info.trackName} · ${info.scene}`} title={info.clipName}>
        <div className={styles.meta}>
          {barsLabel(bars)} · {info.notes === 0 ? 'no notes yet' : `${info.notes} note${info.notes === 1 ? '' : 's'}`}
          {locked ? ` · ${LOCKED_TEXT}` : ''}
        </div>
      </MenuHeader>
      <MenuItem icon="chevronRight" hint="Steps view" onSelect={() => act(() => clipActions.editSteps(trackId, slot))}>
        Edit steps
      </MenuItem>
      <MenuItem icon="pencil" hint="F2" keyShortcut="F2" disabled={locked} disabledReason={LOCKED_REASON} onSelect={() => setRenaming(true)}>
        Rename…
      </MenuItem>
      <MenuKeyRow
        label="Length"
        unit="bars"
        row="length"
        options={LENGTH_OPTIONS}
        value={info.bars}
        disabled={locked}
        disabledReason={LOCKED_TEXT}
        tip={LENGTH_TIP}
        onSelect={(b) => act(() => clipActions.setBars(trackId, slot, b))}
      />
      <MenuItem
        disabled={bars >= LONGEST || locked}
        disabledReason={locked ? LOCKED_REASON : `Already ${LONGEST} bars`}
        hint={`to ${barsLabel(Math.min(LONGEST, bars * 2))}`}
        onSelect={() => act(() => clipActions.double(trackId, slot))}
      >
        Double (repeat)
      </MenuItem>
      <MenuItem
        disabled={bars >= LONGEST || locked}
        disabledReason={locked ? LOCKED_REASON : `Already ${LONGEST} bars`}
        hint="plays the pattern again"
        onSelect={() => act(() => clipActions.repeatTo(trackId, slot, LONGEST))}
      >
        Repeat to {LONGEST} bars
      </MenuItem>
      <MenuSeparator />
      {onMove && (
        <MenuItem
          icon="drag"
          hint="or drag the pad"
          disabled={locked}
          disabledReason={LOCKED_REASON}
          onSelect={() => {
            onClose();
            onMove();
          }}
        >
          Move…
        </MenuItem>
      )}
      <MenuItem
        icon="duplicate"
        disabled={info.duplicateTo === null || locked}
        disabledReason={locked ? LOCKED_REASON : 'No empty slot'}
        hint={info.duplicateScene ? `to ${info.duplicateScene}` : undefined}
        onSelect={() => act(() => clipActions.duplicate(trackId, slot))}
      >
        Duplicate
      </MenuItem>
      <MenuItem icon="copy" hint={`${MOD_KEY}C`} keyShortcut={`${MOD_ARIA}+C`} onSelect={() => act(() => clipActions.copy(trackId, slot))}>
        Copy
      </MenuItem>
      <MenuItem
        icon="paste"
        hint={`${MOD_KEY}V`}
        keyShortcut={`${MOD_ARIA}+V`}
        disabled={!clipboardName || locked}
        disabledReason={locked ? LOCKED_REASON : 'Copy a clip first'}
        onSelect={() => act(() => clipActions.paste(trackId, slot))}
      >
        {clipboardName ? `Paste “${clipboardName}” here` : 'Paste here'}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon="close" disabled={info.notes === 0 || locked} disabledReason={locked ? LOCKED_REASON : 'Already empty'} onSelect={() => act(() => clipActions.clear(trackId, slot))}>
        Clear notes
      </MenuItem>
      <MenuItem icon="trash" tone="danger" hint="Del" keyShortcut="Delete" disabled={locked} disabledReason={LOCKED_REASON} onSelect={() => act(() => clipActions.remove(trackId, slot))}>
        Delete clip
      </MenuItem>
    </Popover>
  );
}
