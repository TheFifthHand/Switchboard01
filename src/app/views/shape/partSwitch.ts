/**
 * A part switch ends every knob drag in progress, before the views show the
 * new part. The Shape columns (and the Play part panel) are not remounted per
 * part, so a knob being dragged would otherwise write the rest of its drag to
 * the part switched to (a switch can come mid-drag: a keyboard shortcut, or a
 * recording import that selects its part when it finishes).
 *
 * The drag ends as if the browser had cancelled the pointer (the knob's own
 * pointercancel handling): its last value goes to the part it started on,
 * still in one undo step. Listens to the UI store directly, so this runs when
 * the selection changes, before React renders the new part.
 */
import { uiStore } from '../../../state/uiStore';

/** Pointers that are down now (a drag can only be one of them). */
const down = new Set<number>();
let installed = false;

/** End the drag of every knob that is being dragged (a cancelled pointer for each pointer that is down). */
export function endKnobDrags(): void {
  const sliders = document.querySelectorAll<HTMLElement>('[data-dragging] [role="slider"]');
  const pointers = [...down];
  for (const el of sliders) {
    for (const pointerId of pointers) {
      try {
        if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
      } catch {
        /* not this pointer */
      }
      el.dispatchEvent(new PointerEvent('pointercancel', { pointerId, bubbles: true }));
    }
  }
}

/** Install the listeners once (the Shape view calls this when its module loads). */
export function endKnobDragsOnPartSwitch(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('pointerdown', (e) => down.add(e.pointerId), true);
  const up = (e: PointerEvent) => down.delete(e.pointerId);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  let part = uiStore.getState().selectedTrackId;
  uiStore.subscribe(() => {
    const next = uiStore.getState().selectedTrackId;
    if (next === part) return;
    part = next;
    endKnobDrags();
  });
}
