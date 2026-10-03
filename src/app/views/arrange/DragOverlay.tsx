/**
 * What a drag shows over the rows, and nothing else re-renders meanwhile.
 *
 * - The regions the drop would change are hidden where they are (a style
 *   rule by id, so their rows do not re-render) and drawn here as they would
 *   end up: cut short, started later, split, or gone.
 * - The dragged regions ride on top, raised, sliding into each new bar with a
 *   short ease (transform only), so they visibly click onto the bar lines.
 * - A badge by them says where they land ("Bar 9", "+ Copy · Bar 9", "8 bars
 *   · plays 4×", "starts at bar 5").
 * - Where an edge lands exactly on a neighbour's, a thin line flashes on both.
 * - A marquee draws its box; a part's loop from the browser lights its own
 *   row teal and marks the others "not here".
 */
import { useMemo, type CSSProperties } from 'react';
import type { Project, SongRegion } from '../../../project/types';
import { session } from '../../instance';
import { RegionFace } from './RegionView';
import { useDragView } from './laneStore';
import styles from './SongView.module.css';

function face(p: Project, r: SongRegion) {
  const t = p.tracks.find((x) => x.id === r.trackId);
  return { clip: t?.clips.find((c) => c?.id === r.clipId) ?? null, kind: t?.instrument.kind === 'drums' ? ('drums' as const) : ('notes' as const) };
}

/** CSS that hides the regions a drag redraws (by id; ids are plain tokens). */
function hideRule(ids: readonly string[]): string {
  if (!ids.length) return '';
  return `${ids.map((id) => `[data-region-id="${id.replace(/["\\]/g, '')}"]`).join(',')}{visibility:hidden}`;
}

export function DragOverlay({ tracks }: { tracks: readonly string[] }) {
  const view = useDragView();
  const p = session.store.getState();
  const pv = view?.preview;
  const movedIds = useMemo(() => new Set(pv?.moved.map((m) => m.id) ?? []), [pv]);
  if (!view) return null;
  const rowOf = (trackId: string) => tracks.indexOf(trackId);
  const slide = view.slide ?? 0;
  return (
    <>
      {pv && <style>{hideRule(pv.hidden)}</style>}
      {view.ownRow !== undefined &&
        tracks.map((t, i) => (
          <div key={`row-${t}`} className={styles.rowLight} data-own={t === view.ownRow || undefined} style={{ '--row': i } as CSSProperties}>
            {t !== view.ownRow && <span className={styles.rowLightText}>Not this part</span>}
          </div>
        ))}
      {pv?.shown
        .filter((r) => !movedIds.has(r.id))
        .map((r) => (
          <div key={r.id} className={styles.ghostRow} style={{ '--row': rowOf(r.trackId) } as CSSProperties}>
            <RegionFace region={r} {...face(p, r)} className={styles.carved} />
          </div>
        ))}
      {pv?.moved.map((r) => (
        <div key={`m-${r.id}`} className={styles.ghostRow} style={{ '--row': rowOf(r.trackId) } as CSSProperties}>
          <RegionFace region={r} {...face(p, r)} lifted slide={view.kind === 'move' || view.kind === 'section' ? slide : undefined} />
        </div>
      ))}
      {view.touches?.map((t) => (
        <span key={`${t.trackId}@${t.bar}`} className={styles.touch} style={{ '--row': rowOf(t.trackId), '--s': t.bar } as CSSProperties} />
      ))}
      {view.badge && !view.notAllowed && (
        <span
          className={styles.badge}
          data-align={view.badge.align}
          data-below={view.badge.row === 0 || undefined}
          data-copy={view.kind === 'move' && view.badge.text.startsWith('+') ? '' : undefined}
          style={{ '--row': view.badge.row, '--x': view.badge.x } as CSSProperties}
          role="status"
        >
          {view.badge.text}
        </span>
      )}
      {view.notAllowed && view.badge && (
        <span className={styles.badge} data-no="" data-align="start" data-below={view.badge.row === 0 || undefined} style={{ '--row': view.badge.row, '--x': view.badge.x } as CSSProperties}>
          Stays on its own part
        </span>
      )}
      {view.marquee && (
        <span
          className={styles.marquee}
          style={{
            left: Math.min(view.marquee.x0, view.marquee.x1),
            top: Math.min(view.marquee.y0, view.marquee.y1),
            width: Math.abs(view.marquee.x1 - view.marquee.x0),
            height: Math.abs(view.marquee.y1 - view.marquee.y0),
          }}
        />
      )}
    </>
  );
}
