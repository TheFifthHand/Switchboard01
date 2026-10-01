/**
 * Add effect: a menu of every insertable effect, grouped by what it is for
 * (Tone · Dynamics · Space · Movement · Colour · Stereo), each with one line
 * saying what it does. Choosing one inserts it at the end of the part's
 * chain, just before its channel (one undo step, with a notice saying so).
 *
 * The menu floats above everything (portal, fixed position kept inside the
 * window), so a narrow column never clips it.
 * Keyboard: ArrowDown opens it from the button; Up/Down move through the
 * items, Left/Right jump between groups, Home/End, Enter adds, Escape closes
 * and returns to the button, Tab closes and moves on from the button.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, type ButtonSize } from '../../../ui/components';
import { MODULE_DEFS } from '../../../project/modules';
import type { Id, ModuleType } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { session } from '../../instance';
import { notify } from '../../runtime';
import { effectSummary, menuGroups } from './effectCatalog';
import styles from './AddEffectMenu.module.css';

const MARGIN = 8;
const GAP = 6;
const MENU_MAX_W = 660;

export interface AddEffectMenuProps {
  trackId: Id;
  disabled?: boolean;
  /** Why the button is disabled (its tip). */
  disabledReason?: string;
  size?: ButtonSize;
  className?: string;
  /** Id for the button (focus can be sent back to it). */
  id?: string;
  /** Called with the new module after an effect was added. */
  onAdded?(moduleId: Id, type: ModuleType): void;
}

interface Pos {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

const GROUPS = menuGroups();

export function AddEffectMenu(props: AddEffectMenuProps) {
  const { trackId, disabled = false, disabledReason, size = 'sm', className, id, onAdded } = props;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const items = () => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];

  // Place the menu under (or above) the button, inside the window.
  useLayoutEffect(() => {
    if (!open) return;
    const b = buttonRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!b || !menu) return;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const width = Math.min(MENU_MAX_W, vw - 2 * MARGIN);
    const natural = menu.scrollHeight;
    const below = vh - b.bottom - GAP - MARGIN;
    const above = b.top - GAP - MARGIN;
    const up = natural > below && above > below;
    const maxHeight = Math.max(160, up ? above : below);
    const height = Math.min(natural, maxHeight);
    const left = Math.max(MARGIN, Math.min(vw - MARGIN - width, b.right - width));
    const top = up ? b.top - GAP - height : b.bottom + GAP;
    setPos({ left: Math.round(left), top: Math.round(top), width: Math.round(width), maxHeight: Math.round(maxHeight) });
  }, [open]);

  useEffect(() => {
    if (!open || !pos) return;
    items()[0]?.focus({ preventScroll: true });
    // Only first placement focuses; later re-placements keep the focused item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pos === null]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    // The button may move (the page scrolls, the window resizes): close rather than float away from it.
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  // Disabled while open (a take starts, the chain fills up): close.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) setPos(null);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const add = (type: ModuleType) => {
    close(true);
    const r = cmd.insertEffect(session.store, trackId, type);
    if (!session.accepted(r) || !r.moduleId) return;
    notify(`Added ${MODULE_DEFS[type].label}. It comes last in this part’s effects, just before its channel.`, 'info', 'undo');
    onAdded?.(r.moduleId, type);
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const groupOf = (el: Element | undefined) => el?.closest('[role="group"]') ?? null;
    let next = -1;
    switch (e.key) {
      case 'ArrowDown':
        next = (i + 1) % list.length;
        break;
      case 'ArrowUp':
        next = (i - 1 + list.length) % list.length;
        break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        const groups = [...(menuRef.current?.querySelectorAll('[role="group"]') ?? [])];
        const g = groups.indexOf(groupOf(list[i]) as Element);
        const target = groups[(g + (e.key === 'ArrowRight' ? 1 : -1) + groups.length) % groups.length];
        next = list.findIndex((el) => groupOf(el) === target);
        break;
      }
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = list.length - 1;
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case 'Tab':
        // Focus goes back to the button first, so Tab continues from there (the menu is a portal).
        close(true);
        return;
      default:
        return;
    }
    e.preventDefault();
    list[next]?.focus();
  };

  const style: CSSProperties = pos ? { left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight } : { left: -9999, top: 0, width: Math.min(MENU_MAX_W, window.innerWidth - 2 * MARGIN), visibility: 'hidden' };

  return (
    <>
      <Button
        ref={buttonRef}
        id={id}
        size={size}
        className={className}
        icon="plus"
        iconRight="chevronDown"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        tip={disabled ? disabledReason : 'Add an effect at the end of this part’s chain, just before its channel.'}
        detail={disabled ? undefined : 'Effects are grouped by what they do. Undo takes a new effect out again.'}
      >
        Add effect
      </Button>
      {open &&
        createPortal(
          <div ref={menuRef} id={menuId} className={styles.menu} role="menu" aria-label="Add effect" style={style} onKeyDown={onMenuKey}>
            {GROUPS.map((g) => (
              <MenuGroup key={g.id} label={g.label} types={g.types} onPick={add} />
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

function MenuGroup(props: { label: string; types: readonly ModuleType[]; onPick(type: ModuleType): void }) {
  const { label, types, onPick } = props;
  const headId = useId();
  return (
    <div className={styles.group} role="group" aria-labelledby={headId}>
      {/* Names the group (aria-labelledby); hidden itself so it is not read twice. */}
      <div id={headId} className={styles.groupTitle} aria-hidden="true">
        {label}
      </div>
      {types.map((type) => (
        <MenuItem key={type} type={type} onPick={onPick} />
      ))}
    </div>
  );
}

function MenuItem(props: { type: ModuleType; onPick(type: ModuleType): void }) {
  const { type, onPick } = props;
  const descId = useId();
  const name = MODULE_DEFS[type].label;
  return (
    <button type="button" role="menuitem" tabIndex={-1} className={styles.item} aria-label={name} aria-describedby={descId} data-effect={type} onClick={() => onPick(type)}>
      <span className={styles.itemLabel}>{name}</span>
      <span id={descId} className={styles.itemDesc}>
        {effectSummary(type)}
      </span>
    </button>
  );
}
