/**
 * Clip pad menu for the Loops grid, plus the small popover primitives the
 * part, scene, arpeggiator and recording-option popovers share.
 *
 * Popover: a portalled surface positioned next to its trigger (or at the
 * pointer for a right-click), kept inside the viewport, closed by Escape, an
 * outside press or a window resize, and giving focus back to where it came
 * from. As role="menu" it moves focus with the arrow keys (Left/Right move
 * within a row of keys such as the clip length), Home/End jump, Tab closes.
 * As role="dialog" (a settings panel) it is not modal: keys other than
 * Escape pass through, so the computer keyboard still plays notes.
 *
 * Clip actions (rename, length, duplicate, copy/paste, clear, delete, new
 * clip) are all undoable project commands; destructive ones show a toast with
 * Undo. The same actions back the pad keyboard shortcuts (Delete, Ctrl+C,
 * Ctrl+V, F2) handled by the grid.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, Icon, type IconName } from '../../ui/components';
import { SCENE_ROWS, type ClipBars, type Id } from '../../project/types';
import * as cmd from '../../state/commands';
import { selectSlot, selectTrack, setClipboard, setPadMode, uiStore } from '../../state/uiStore';
import { shallowEqual } from '../../state/store';
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

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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

  // Position next to the anchor, inside the viewport; follow size changes (e.g. switching to a rename field).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const below = anchor.top + anchor.height + GAP;
      const above = anchor.top - GAP - h;
      let top: number;
      if (placement === 'above') top = above >= EDGE ? above : below;
      else top = below + h <= vh - EDGE ? below : above >= EDGE ? above : below;
      top = clamp(top, EDGE, Math.max(EDGE, vh - EDGE - h));
      let left = align === 'end' ? anchor.left + anchor.width - w : anchor.left;
      left = clamp(left, EDGE, Math.max(EDGE, vw - EDGE - w));
      setPos((p) => (p && p.left === Math.round(left) && p.top === Math.round(top) ? p : { left: Math.round(left), top: Math.round(top) }));
    };
    place();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [anchor.left, anchor.top, anchor.width, anchor.height, placement, align]);

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

  // Outside presses and window changes close it.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || (ignore && ignore.contains(t))) return;
      focusInside.current = false;
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
  /** Right-aligned hint: a shortcut or the current value. */
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

/** A menu row. Disabled rows stay focusable (so they can be discovered) but do nothing. */
export function MenuItem({ icon, children, hint, onSelect, disabled, disabledReason, tone, role = 'menuitem', checked, keyShortcut }: MenuItemProps) {
  const shownHint = disabled && disabledReason ? disabledReason : hint;
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
      {shownHint && <span className={styles.itemHint}>{shownHint}</span>}
    </button>
  );
}

/** A row of small keys inside a menu (e.g. clip length 1-4); Left/Right move along it. */
export function MenuKeyRow<T extends string | number>(props: {
  label: string;
  unit?: string;
  row: string;
  options: readonly { value: T; label: string; ariaLabel: string }[];
  value?: T | null;
  onSelect(value: T): void;
  disabled?: boolean;
}) {
  const { label, unit, row, options, value, onSelect, disabled } = props;
  const labelId = useId();
  return (
    <div className={styles.keyRow} role="group" aria-labelledby={labelId}>
      <span id={labelId} className={styles.keyRowLabel}>
        {label}
      </span>
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
/* Clip actions (menu items and pad shortcuts)                          */
/* ------------------------------------------------------------------ */

function trackAndClip(trackId: Id, slot: number) {
  const p = session.store.getState();
  const track = p.tracks.find((t) => t.id === trackId);
  return { p, track, clip: track?.clips[slot] ?? null, scene: p.scenes[slot]?.name ?? `Row ${slot + 1}` };
}

/** Next empty slot after `slot` on the same part (wrapping), or null. */
export function nextEmptySlot(clips: readonly unknown[], slot: number): number | null {
  for (let k = 1; k < SCENE_ROWS; k++) {
    const s = (slot + k) % SCENE_ROWS;
    if (!clips[s]) return s;
  }
  return null;
}

export const clipActions = {
  create(trackId: Id, slot: number, bars: ClipBars): boolean {
    const r = cmd.createClip(session.store, trackId, slot, bars);
    if (!session.accepted(r)) return false;
    selectTrack(trackId);
    selectSlot(trackId, slot);
    const { track, clip } = trackAndClip(trackId, slot);
    notify(`New ${barsLabel(bars)} clip "${clip?.name ?? ''}" on ${track?.name ?? 'this part'}. Add notes in Steps or with Record Notes.`, 'info', 'undo');
    return true;
  },

  rename(trackId: Id, slot: number, name: string): boolean {
    return session.accepted(cmd.renameClip(session.store, trackId, slot, name));
  },

  setBars(trackId: Id, slot: number, bars: ClipBars): boolean {
    const before = trackAndClip(trackId, slot).clip?.notes.length ?? 0;
    if (!session.accepted(cmd.setClipBars(session.store, trackId, slot, bars))) return false;
    const after = trackAndClip(trackId, slot).clip?.notes.length ?? 0;
    if (after < before) notify(`Clip shortened to ${barsLabel(bars)}: ${before - after} note${before - after === 1 ? '' : 's'} past the end removed.`, 'info', 'undo');
    return true;
  },

  duplicate(trackId: Id, slot: number): boolean {
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
    if (!session.accepted(cmd.clearClip(session.store, trackId, slot))) return false;
    notify(`Cleared the notes of "${clip.name}". The empty clip stays in its slot.`, 'info', 'undo');
    return true;
  },

  remove(trackId: Id, slot: number): boolean {
    const { track, clip } = trackAndClip(trackId, slot);
    if (!clip) return false;
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

const LENGTH_OPTIONS = ([1, 2, 3, 4] as const).map((b) => ({ value: b as ClipBars, label: String(b), ariaLabel: `Length ${barsLabel(b)}` }));
const NEW_OPTIONS = ([1, 2, 4] as const).map((b) => ({ value: b as ClipBars, label: barsLabel(b), ariaLabel: `New clip, ${barsLabel(b)}` }));

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
      return {
        trackName: t?.name ?? '',
        scene: p.scenes[slot]?.name ?? `Row ${slot + 1}`,
        clipName: clip?.name ?? null,
        bars: clip?.bars ?? null,
        notes: clip?.notes.length ?? 0,
        duplicateTo: t && clip ? nextEmptySlot(t.clips, slot) : null,
        duplicateScene: t && clip ? (p.scenes[nextEmptySlot(t.clips, slot) ?? -1]?.name ?? null) : null,
      };
    },
    shallowEqual,
  );
  const clipboardName = useUi((s) => s.clipboard?.name ?? null);
  const [renaming, setRenaming] = useState(!!startInRename && info.clipName !== null);

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
        <MenuHeader eyebrow={`${info.trackName} · ${info.scene}`} title="Empty slot" />
        <MenuKeyRow label="New clip" row="new" options={NEW_OPTIONS} onSelect={(b) => act(() => clipActions.create(trackId, slot, b))} />
        <MenuSeparator />
        <MenuItem
          icon="paste"
          hint={`${MOD_KEY}V`}
          keyShortcut={`${MOD_ARIA}+V`}
          disabled={!clipboardName}
          disabledReason="Copy a clip first"
          onSelect={() => act(() => clipActions.paste(trackId, slot))}
        >
          {clipboardName ? `Paste “${clipboardName}”` : 'Paste'}
        </MenuItem>
      </Popover>
    );
  }

  return (
    <Popover anchor={anchor} label={`Clip ${info.clipName}: ${info.trackName}, ${info.scene}`} onClose={onClose} returnFocus={returnFocus} ignore={ignore}>
      <MenuHeader eyebrow={`${info.trackName} · ${info.scene}`} title={info.clipName}>
        <div className={styles.meta}>
          {barsLabel(info.bars ?? 1)} · {info.notes === 0 ? 'no notes yet' : `${info.notes} note${info.notes === 1 ? '' : 's'}`}
        </div>
      </MenuHeader>
      <MenuItem icon="chevronRight" hint="Steps view" onSelect={() => act(() => clipActions.editSteps(trackId, slot))}>
        Edit steps
      </MenuItem>
      <MenuItem hint="F2" keyShortcut="F2" onSelect={() => setRenaming(true)}>
        Rename…
      </MenuItem>
      <MenuKeyRow label="Length" unit="bars" row="length" options={LENGTH_OPTIONS} value={info.bars} onSelect={(b) => act(() => clipActions.setBars(trackId, slot, b))} />
      <MenuSeparator />
      {onMove && (
        <MenuItem
          icon="drag"
          hint="or drag the pad"
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
        disabled={info.duplicateTo === null}
        disabledReason="No empty slot"
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
        disabled={!clipboardName}
        disabledReason="Copy a clip first"
        onSelect={() => act(() => clipActions.paste(trackId, slot))}
      >
        {clipboardName ? `Paste “${clipboardName}” here` : 'Paste here'}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon="close" disabled={info.notes === 0} disabledReason="Already empty" onSelect={() => act(() => clipActions.clear(trackId, slot))}>
        Clear notes
      </MenuItem>
      <MenuItem icon="trash" tone="danger" hint="Del" keyShortcut="Delete" onSelect={() => act(() => clipActions.remove(trackId, slot))}>
        Delete clip
      </MenuItem>
    </Popover>
  );
}
