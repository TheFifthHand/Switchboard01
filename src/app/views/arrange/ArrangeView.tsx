/**
 * Arrange: turn scenes into a song, and keep live performances.
 *
 *   [ SONG — scene blocks in play order, repeats, playhead, palette      ]
 *   [ PERFORMANCES — recorded takes: replay, export, rename, edit events ]
 *
 * Everything edits the real project through undoable commands; playback
 * goes through the session (song mode, performance replay), so what the view
 * shows is what the transport plays.
 *
 * The song's part rows grow with the free height (ROW_MIN_PX to ROW_MAX_PX, songLayout):
 * what the view has left after the song panel's fixed parts and the room the
 * Performances panel needs (its one-line bar when there are no takes) is
 * shared out among the rows; once they are as tall as they get, the rest goes
 * to the lane below its blocks (fitLaneHeight), so a tall window has no empty
 * band under the song. Measured only when a size changes (a resize observer),
 * never while a pointer moves.
 */
import { useLayoutEffect, useRef } from 'react';
import { PERF_ROOM_PX, fitLaneHeight } from './songLayout';
import { PerformancesPanel } from './PerformancesPanel';
import { SongPanel } from './SongPanel';
import styles from './ArrangeView.module.css';

export function ArrangeView() {
  const viewRef = useRef<HTMLDivElement>(null);

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
      let row = 0;
      let more = 0;
      if (song && perf && names.length && !narrow.matches) {
        const cs = getComputedStyle(view);
        const chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.rowGap || '0');
        const fixed = song.offsetHeight - names.length * names[0].offsetHeight - extra;
        const collapsed = perf.hasAttribute('data-collapsed');
        const perfRoom = collapsed ? perf.offsetHeight : PERF_ROOM_PX;
        const fill = fitLaneHeight(view.clientHeight - chrome - perfRoom - fixed, names.length);
        row = fill.row;
        // With takes listed, the Performances panel takes what the rows leave; without, the lane does.
        more = collapsed ? fill.extra : 0;
      }
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
    // A new row height resizes the panels the observer watches: apply it in the next frame, never inside
    // the observer's own callback (that would be a resize loop).
    let raf = 0;
    const soon = () => {
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        fit();
      });
    };
    const ro = new ResizeObserver(soon);
    ro.observe(view);
    // The panels change size when the header wraps or the Performances bar opens.
    for (const el of view.children) ro.observe(el);
    narrow.addEventListener('change', soon);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      narrow.removeEventListener('change', soon);
    };
  }, []);

  return (
    <div ref={viewRef} className={styles.view}>
      <SongPanel />
      <PerformancesPanel />
    </div>
  );
}
