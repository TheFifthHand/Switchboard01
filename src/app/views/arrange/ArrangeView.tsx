/**
 * Arrange: turn scenes into a song, and keep live performances.
 *
 *   [ SONG — scene blocks in play order, repeats, playhead, palette      ]
 *   [ PERFORMANCES — recorded takes: replay, export, make song blocks    ]
 *
 * Everything edits the real project through undoable commands; playback
 * goes through the session (song mode, performance replay), so what the view
 * shows is what the transport plays.
 *
 * Height is shared out so the song stays comfortable to read and grab: the
 * song's part rows grow with the free height (ROW_MIN_PX to ROW_MAX_PX,
 * songLayout); the Performances panel is one line unless it is open. Until
 * the user opens or folds it (remembered), it opens by itself only where the
 * rows are already as tall as they get with it open (a tall window), so spare
 * height shows the takes (or how to record one) instead of an empty band;
 * what the rows cannot use otherwise goes to the lane below its blocks
 * (fitLaneHeight). Measured in a layout effect when the view mounts (before
 * the first paint) and again only when a size changes (a resize observer),
 * never while a pointer moves.
 *
 * A take's events open in a tall drawer beside the take list; meanwhile the
 * song folds to its header row (the lane keeps its state, hidden).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Id } from '../../../project/types';
import { useProject } from '../../instance';
import { PERF_BAR_PX, PERF_ROOM_PX, ROW_MAX_PX, fitLaneHeight } from './songLayout';
import { readTakesOpen, writeTakesOpen } from './laneSettings';
import { PerformancesPanel } from './PerformancesPanel';
import { SongPanel } from './SongPanel';
import styles from './ArrangeView.module.css';

export function ArrangeView() {
  const viewRef = useRef<HTMLDivElement>(null);
  // The take whose events are open in the drawer (the song folds meanwhile).
  const [openTake, setOpenTake] = useState<Id | null>(null);
  // Performances open or folded: the user's choice, else open only on a tall window. A choice made while
  // there are takes is remembered (this browser); with none it lasts until a take is made (a look at how to
  // record one is not a reason to keep the song smaller).
  const hasTakes = useProject((p) => p.performances.length > 0);
  const [takesPref, setTakesPref] = useState<boolean | null>(readTakesOpen);
  const [howOpen, setHowOpen] = useState<boolean | null>(null);
  const [takesAuto, setTakesAuto] = useState(false);
  const choice = hasTakes ? takesPref : howOpen;
  const takesOpen = choice ?? takesAuto;
  const prefRef = useRef(choice);
  prefRef.current = choice;
  useEffect(() => {
    if (!hasTakes) setHowOpen(null);
  }, [hasTakes]);
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!hasTakes) {
        setHowOpen(open);
        return;
      }
      setTakesPref(open);
      writeTakesOpen(open);
    },
    [hasTakes],
  );

  const fitRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // Narrow (or zoomed) windows scroll the page: rows keep the size the stylesheet gives them.
    const narrow = window.matchMedia('(max-width: 1023px)');
    let last = '';
    // The room given to the lane below its blocks (px), part of the song panel's height as measured.
    let extra = 0;
    const fit = () => {
      const song = view.querySelector<HTMLElement>('section[aria-labelledby="song-title"]');
      const perf = view.querySelector<HTMLElement>('[data-testid="performances"]');
      const names = view.querySelectorAll<HTMLElement>('[data-name-row]');
      // The song folded (a take's events open): nothing to share out now.
      if (!song || song.hasAttribute('data-folded')) return;
      let row = 0;
      let more = 0;
      let auto = false;
      if (perf && names.length && !narrow.matches) {
        const cs = getComputedStyle(view);
        const chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.rowGap || '0');
        const fixed = song.offsetHeight - names.length * names[0].offsetHeight - extra;
        const free = view.clientHeight - chrome - fixed;
        // Open by itself only where the rows stay as tall as they get with the panel open.
        auto = free - PERF_ROOM_PX >= names.length * ROW_MAX_PX;
        const open = prefRef.current ?? auto;
        const perfRoom = open ? PERF_ROOM_PX : perf.hasAttribute('data-collapsed') ? perf.offsetHeight : PERF_BAR_PX;
        const fill = fitLaneHeight(free - perfRoom, names.length);
        row = fill.row;
        // With the panel open it takes what the rows leave; folded, the lane does.
        more = open ? 0 : fill.extra;
      }
      setTakesAuto(auto);
      const value = row ? `${row}px/${more}px` : '';
      if (value === last) return;
      last = value;
      extra = more;
      if (row) {
        view.style.setProperty('--lane-row-h', `${row}px`);
        view.style.setProperty('--lane-extra', `${more}px`);
      } else {
        view.style.removeProperty('--lane-row-h');
        view.style.removeProperty('--lane-extra');
      }
    };
    fit();
    fitRef.current = fit;
    // A new row height resizes the panels the observer watches: apply it in the next frame, never inside
    // the observer's own callback (that would be a resize loop). Sizes this view set itself are skipped.
    let raf = 0;
    const seen = new WeakMap<Element, string>();
    const soon = () => {
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        fit();
      });
    };
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const key = `${Math.round(e.contentRect.width)}x${Math.round(e.contentRect.height)}`;
        if (seen.get(e.target) !== key) {
          // The first report of each element is the size it already had when fit() measured it.
          if (seen.has(e.target)) changed = true;
          seen.set(e.target, key);
        }
      }
      if (changed) soon();
    });
    ro.observe(view);
    // The panels change size when the header wraps or the Performances panel opens or folds.
    for (const el of view.children) ro.observe(el);
    narrow.addEventListener('change', soon);
    return () => {
      fitRef.current = null;
      ro.disconnect();
      cancelAnimationFrame(raf);
      narrow.removeEventListener('change', soon);
    };
  }, []);

  // Opening or folding the panel (or a take's events) changes the room: share it out again before the next paint.
  const firstRef = useRef(true);
  useLayoutEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    fitRef.current?.();
  }, [takesOpen, openTake, hasTakes]);

  return (
    <div ref={viewRef} className={styles.view} data-take-open={openTake ? '' : undefined}>
      <SongPanel folded={!!openTake} onUnfold={() => setOpenTake(null)} />
      <PerformancesPanel open={takesOpen} onOpenChange={onOpenChange} openTake={openTake} onOpenTake={setOpenTake} />
    </div>
  );
}
