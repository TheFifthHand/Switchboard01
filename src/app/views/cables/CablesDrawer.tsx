/**
 * Cables drawer for the Play view: a slim bar that opens the cable panel of
 * the selected part. Closed by default (uiStore `cablesOpen`), so the first
 * minute needs no patching; opening it never changes the sound.
 *
 * Open, it has a splitter on its top edge like the Shape view's cable dock
 * (drag it, or arrow keys / Home / End on it): its height is kept for the
 * session, and it never grows past what leaves the Loops pads two whole rows
 * (measured: the grid's head row and two rows at their smallest). A patch wider than the drawer scrolls sideways with
 * edge shadows and arrow keys (CablePanel), so Master Out stays reachable. On a short window that leaves the patch
 * little room: "Open in Shape" shows the same cables in Shape, where the panel can take the whole height.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { Button, Icon, IconButton } from '../../../ui/components';
import { describePathProblem } from '../../../project/graph';
import type { Project } from '../../../project/types';
import { setCablesOpen, setView } from '../../../state/uiStore';
import { useProject, useUi } from '../../instance';
import { CablePanelFrame } from './CablePanel';
import { partCableCount } from './model';
import styles from './CablesDrawer.module.css';

/** Height of the open drawer (panel included) at first. */
export const CABLES_DRAWER_HEIGHT = 300;
/** The smallest open drawer (its toolbar and a strip of the patch). */
export const CABLES_DRAWER_MIN = 120;
/** A pad row's smallest height in the Loops grid, and the gap between rows. */
const PAD_MIN_PX = 64;
const PAD_GAP_PX = 6;
/** Room the drawer leaves the pads when they cannot be measured (another pad mode). */
export const DRAWER_LEAVES_PX = 450;
const SPLITTER = 10;

/** The height the user dragged the drawer to (kept while the app is open). */
let chosenHeight: number | null = null;

const selectTrackIds = (p: Project) => p.tracks.map((t) => t.id).join('\u0000');

/**
 * The tallest the drawer may be: what leaves the pads above it two whole
 * rows. Measured in the Play view the drawer sits in (its grid): the pad
 * surface's own head and actions, the Loops grid's head row, and two pad
 * rows at their smallest; followed as the window changes. 0 until measured.
 */
function useDrawerMax(ref: RefObject<HTMLElement | null>, open: boolean): number {
  const [max, setMax] = useState(0);
  useEffect(() => {
    const drawer = ref.current;
    const slot = drawer?.parentElement ?? null;
    const view = slot?.parentElement ?? null;
    if (!drawer || !slot || !view || !open) return;
    const read = () => {
      const v = view.getBoundingClientRect();
      const cs = getComputedStyle(view);
      const inner = v.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - (parseFloat(cs.rowGap) || 0);
      const surface = view.querySelector<HTMLElement>('section[aria-label="Pads"]');
      const grid = surface?.querySelector<HTMLElement>('[aria-label^="Clip pads"]') ?? null;
      const pad = grid?.querySelector<HTMLElement>('[id^="pad-"][id$="-0"]') ?? null;
      let leaves = DRAWER_LEAVES_PX;
      if (surface && grid && pad) {
        const s = surface.getBoundingClientRect();
        const g = grid.getBoundingClientRect();
        const head = pad.getBoundingClientRect().top - g.top + grid.scrollTop;
        leaves = g.top - s.top + head + 2 * PAD_MIN_PX + PAD_GAP_PX + (s.bottom - g.bottom) + 2;
      }
      setMax(Math.max(CABLES_DRAWER_MIN, Math.floor(inner - leaves)));
    };
    read();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null;
    ro?.observe(view);
    window.addEventListener('resize', read);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', read);
    };
  }, [ref, open]);
  return max;
}

export function CablesDrawer() {
  const open = useUi((s) => s.cablesOpen);
  const selected = useUi((s) => s.selectedTrackId);
  const ids = useProject(selectTrackIds).split('\u0000');
  const trackId = ids.includes(selected) ? selected : (ids[0] ?? selected);
  const name = useProject(useCallback((p: Project) => p.tracks.find((t) => t.id === trackId)?.name ?? '', [trackId]));
  const cables = useProject(useCallback((p: Project) => partCableCount(p.patch, trackId), [trackId]));
  const silent = useProject(useCallback((p: Project) => describePathProblem(p.patch, trackId) !== null, [trackId]));
  const rootRef = useRef<HTMLElement>(null);
  const measured = useDrawerMax(rootRef, open);
  const [userHeight, setUserHeight] = useState<number | null>(chosenHeight);
  const drag = useRef<{ pointerId: number; startY: number; startH: number } | null>(null);

  // The pads keep two rows: the drawer is never taller than what leaves them that (and never under its minimum).
  const max = measured > 0 ? measured : CABLES_DRAWER_HEIGHT;
  const height = Math.round(Math.min(max, Math.max(CABLES_DRAWER_MIN, userHeight ?? CABLES_DRAWER_HEIGHT)));
  const setClamped = (h: number) => {
    const v = Math.min(max, Math.max(CABLES_DRAWER_MIN, Math.round(h)));
    chosenHeight = v;
    setUserHeight(v);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    drag.current = { pointerId: e.pointerId, startY: e.clientY, startH: height };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    setClamped(d.startH + (d.startY - e.clientY));
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === e.pointerId) drag.current = null;
  };
  const onSplitKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    switch (e.key) {
      case 'ArrowUp':
        setClamped(height + step);
        break;
      case 'ArrowDown':
        setClamped(height - step);
        break;
      case 'Home':
        setClamped(CABLES_DRAWER_MIN);
        break;
      case 'End':
        setClamped(max);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  if (open) {
    return (
      <section ref={rootRef} className={styles.drawer} data-open="true" aria-label="Cables drawer" style={{ height }}>
        <div
          className={styles.splitter}
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label="Resize cable drawer"
          aria-valuemin={CABLES_DRAWER_MIN}
          aria-valuemax={max}
          aria-valuenow={height}
          aria-valuetext={`Cable drawer ${height} pixels tall`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onKeyDown={onSplitKey}
        >
          <span className={styles.grip} aria-hidden="true" />
        </div>
        <CablePanelFrame
          trackId={trackId}
          height={height - SPLITTER}
          headerStart={
            <>
              <IconButton icon="chevronDown" size="sm" label="Hide cables" aria-expanded="true" onClick={() => setCablesOpen(false)} tip="Close the cable drawer. Your cables stay as they are." />
              <Button
                id="cables-drawer-open-in-shape"
                size="sm"
                variant="ghost"
                icon="sliders"
                onClick={() => setView('shape')}
                tip={`Show ${name ? `${name}’s` : 'this part’s'} cables in Shape, where the cable panel can take the whole height.`}
                detail="The pads stay as they are; Back to Play returns here."
              >
                Open in Shape
              </Button>
            </>
          }
        />
      </section>
    );
  }

  return (
    <section ref={rootRef} className={styles.drawer} aria-label="Cables drawer">
      <button type="button" className={styles.bar} aria-expanded="false" onClick={() => setCablesOpen(true)}>
        <Icon name="cable" size={16} className={styles.icon} />
        <span className={styles.label}>Cables</span>
        <span className={styles.part}>{name}</span>
        <span className={styles.count}>
          {cables} {cables === 1 ? 'cable' : 'cables'}
        </span>
        {silent && (
          <span className={styles.warn}>
            <Icon name="warning" size={14} />
            No path to the output
          </span>
        )}
        <span className={styles.hint}>Show the patch</span>
        <Icon name="chevronUp" size={16} className={styles.chevron} />
      </button>
    </section>
  );
}
