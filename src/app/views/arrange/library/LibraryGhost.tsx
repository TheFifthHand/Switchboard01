/**
 * What a carried library loop looks like over the rows: its face (name and
 * notes, raised) where it would land, or, over a part of the wrong kind,
 * what it needs at the pointer ("Needs a drum part"). Drawn in the
 * timeline's overlay layer, beside the drag overlay's own drawing, so it
 * scrolls and zooms with the rows.
 */
import { useStore } from '../../../../state/store';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import type { Clip } from '../../../../project/types';
import { RegionFace } from '../RegionView';
import laneStyles from '../SongView.module.css';
import { libraryGhostStore } from './libraryDrag';

export function LibraryGhost() {
  const g = useStore(libraryGhostStore, (s) => s);
  if (!g) return null;
  const origin = document.querySelector<HTMLElement>(`[data-testid="song-timeline"] .${laneStyles.origin}`);
  if (!origin) return null;
  if (g.kind === 'no') {
    return createPortal(
      <span className={laneStyles.notHere} style={{ '--px': g.x, '--py': g.y } as CSSProperties} role="status" data-testid="library-not-here">
        {g.text}
      </span>,
      origin,
    );
  }
  const clip = { id: 'library:drop', name: g.name, bars: g.bars, notes: g.notes.map((n, i) => ({ ...n, id: `n${i}` })) } as unknown as Clip;
  return createPortal(
    <div className={laneStyles.ghostRow} style={{ '--row': g.row, '--h': g.hue } as CSSProperties} data-testid="library-ghost">
      <RegionFace region={{ id: 'library:drop', trackId: g.trackId, clipId: clip.id, start: g.start, bars: g.bars, offset: 0 }} clip={clip} kind={g.drums ? 'drums' : 'notes'} lifted />
    </div>,
    origin,
  );
}
