/**
 * Two gestures the Shape view adds to its knobs, without wrapping them (a
 * wrapper element would break the knob rows' shared label alignment):
 *
 * - Alt+double-click: back to the plain registry default (a plain
 *   double-click returns to the sound's own design, the knob's `default`).
 * - A menu: right-click, a long press with a finger (TOUCH_MENU_MS without
 *   moving), or Shift+F10 / the menu key on the focused knob.
 *
 * Native listeners on the knob's slider element (found by its id): they run
 * at the target, before React's root listener, so an Alt+double-click is
 * kept from the knob's own reset.
 */
import { useEffect, useRef } from 'react';
import { TOUCH_SLOP_PX } from '../../../ui/components';
import { anchorFromContextEvent, anchorFromElement, anchorFromPoint, isEchoOfKeyboardMenu, isMenuKey, noteKeyboardMenu, type MenuAnchor } from '../ClipMenu';

/** A finger resting this long on a knob opens its menu (well after the knob's own 250 ms hold-to-turn). */
export const TOUCH_MENU_MS = 650;

export interface KnobExtras {
  /** Alt+double-click: set the plain default (undefined: Alt+double-click acts like a double-click). */
  onAltReset?(): void;
  /** Open the knob's menu at `anchor` (undefined: no menu). */
  onMenu?(anchor: MenuAnchor): void;
}

export function useKnobExtras(sliderId: string, extras: KnobExtras): void {
  const latest = useRef(extras);
  useEffect(() => {
    latest.current = extras;
  });
  useEffect(() => {
    const el = document.getElementById(sliderId);
    if (!el) return;
    let press: { id: number; x: number; y: number; timer: number } | null = null;
    let suppressMenuUntil = 0;
    const endPress = () => {
      if (press) window.clearTimeout(press.timer);
      press = null;
    };
    const onDblClick = (e: MouseEvent) => {
      const reset = latest.current.onAltReset;
      if (!e.altKey || !reset) return;
      e.stopPropagation();
      e.preventDefault();
      reset();
    };
    const onContextMenu = (e: MouseEvent) => {
      const open = latest.current.onMenu;
      if (!open) return;
      e.preventDefault();
      if (isEchoOfKeyboardMenu(e.target) || performance.now() < suppressMenuUntil) return;
      open(anchorFromContextEvent(e, el));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const open = latest.current.onMenu;
      if (!open || !isMenuKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      noteKeyboardMenu(el);
      open(anchorFromElement(el));
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !latest.current.onMenu || press) return;
      const id = e.pointerId;
      const x = e.clientX;
      const y = e.clientY;
      const timer = window.setTimeout(() => {
        if (!press || press.id !== id) return;
        press = null;
        // The knob may have taken the finger (hold to turn): let it go, so the menu is all this press does.
        try {
          if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
        } catch {
          /* already released */
        }
        suppressMenuUntil = performance.now() + 1500;
        latest.current.onMenu?.(anchorFromPoint(x, y));
      }, TOUCH_MENU_MS);
      press = { id, x, y, timer };
    };
    const onPointerMove = (e: PointerEvent) => {
      if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) >= TOUCH_SLOP_PX) endPress();
    };
    const onPointerEnd = (e: PointerEvent) => {
      if (press && e.pointerId === press.id) endPress();
    };
    el.addEventListener('dblclick', onDblClick);
    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerEnd);
    el.addEventListener('pointercancel', onPointerEnd);
    return () => {
      endPress();
      el.removeEventListener('dblclick', onDblClick);
      el.removeEventListener('contextmenu', onContextMenu);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerEnd);
      el.removeEventListener('pointercancel', onPointerEnd);
    };
  }, [sliderId]);
}
