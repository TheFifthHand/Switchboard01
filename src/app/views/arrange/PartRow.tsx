/**
 * A part's row in the song: a sticky header at the left (number, name,
 * instrument, Mute and Solo) and the lane its regions sit on.
 *
 * The row re-renders only when its own regions or clips change (immer keeps
 * the objects of what an edit did not touch), and each region only when it
 * or its clip changes. The headers' Mute and Solo keys call the same session
 * commands as Play and Mix, so all three stay in step (Undo covers them).
 */
import { memo, useCallback, type CSSProperties, type KeyboardEvent } from 'react';
import { Icon, Tooltip } from '../../../ui/components';
import type { Clip, Id, Project, SongRegion } from '../../../project/types';
import { session, useProject } from '../../instance';
import { RegionView } from './RegionView';
import { partStatus, type RowView } from './songModel';
import styles from './SongView.module.css';

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a === b || (a.length === b.length && a.every((x, i) => x === b[i]));
}

const EMPTY: readonly SongRegion[] = [];

/** A part's regions (the same array while none of them changed). */
function useRowRegions(trackId: Id): readonly SongRegion[] {
  const select = useCallback((p: Project) => {
    const out = p.arrangement.regions.filter((r) => r.trackId === trackId);
    return out.length ? out : EMPTY;
  }, [trackId]);
  return useProject(select, sameList);
}

const NO_CLIPS: readonly (Clip | null)[] = [];

function useRowClips(trackId: Id): readonly (Clip | null)[] {
  const select = useCallback((p: Project) => p.tracks.find((t) => t.id === trackId)?.clips ?? NO_CLIPS, [trackId]);
  return useProject(select);
}

function useRowKind(trackId: Id): 'notes' | 'drums' {
  const select = useCallback((p: Project) => (p.tracks.find((t) => t.id === trackId)?.instrument.kind === 'drums' ? 'drums' : 'notes'), [trackId]);
  return useProject(select);
}

/**
 * The header: the part's number, name and instrument (or Muted / Solo / Not
 * soloed in words while that is so), and its Mute and Solo keys (icons, named
 * for screen readers and in their tooltips). The keys of every header are one
 * Tab stop; arrow keys move between them (partKeysNav).
 */
function PartHeader({ row, anySolo, tab, onFocusKey }: { row: RowView; anySolo: boolean; tab: 0 | 1 | null; onFocusKey(row: number, col: 0 | 1): void }) {
  const status = partStatus(row, anySolo);
  return (
    <div className={styles.partHead} data-status={status === 'Muted' ? 'muted' : status === 'Solo' ? 'solo' : status ? 'quiet' : undefined}>
      <span className={styles.partNum} aria-hidden="true">
        {row.number}
      </span>
      <span className={styles.partText}>
        <span className={styles.partName} title={row.name}>
          {row.name}
        </span>
        <span className={styles.partSound} title={row.sound}>
          {status ?? row.sound}
        </span>
      </span>
      <span className={styles.partKeys}>
        <Tooltip name={row.mute ? `Unmute ${row.name}` : `Mute ${row.name}`} tip={row.mute ? `Hear ${row.name} again.` : `Silence ${row.name} in the song (it keeps its place).`}>
          <button
            type="button"
            className={styles.partKey}
            data-kind="mute"
            data-row={row.index}
            data-col={0}
            tabIndex={tab === 0 ? 0 : -1}
            aria-pressed={row.mute}
            aria-label={`Mute ${row.name}`}
            onFocus={() => onFocusKey(row.index, 0)}
            onClick={() => session.setMute(row.id, !row.mute)}
          >
            <Icon name="speaker" size={14} />
          </button>
        </Tooltip>
        <Tooltip name={row.solo ? `Stop soloing ${row.name}` : `Solo ${row.name}`} tip={row.solo ? `Hear every part again.` : `Hear only ${row.name} (and any other soloed part).`}>
          <button
            type="button"
            className={styles.partKey}
            data-kind="solo"
            data-row={row.index}
            data-col={1}
            tabIndex={tab === 1 ? 0 : -1}
            aria-pressed={row.solo}
            aria-label={`Solo ${row.name}`}
            onFocus={() => onFocusKey(row.index, 1)}
            onClick={() => session.setSolo(row.id, !row.solo)}
          >
            <Icon name="headphones" size={14} />
          </button>
        </Tooltip>
      </span>
    </div>
  );
}

export interface PartRowProps {
  row: RowView;
  anySolo: boolean;
  /** Which of this header's keys holds the column's Tab stop (null: another row's). */
  tab: 0 | 1 | null;
  onFocusKey(row: number, col: 0 | 1): void;
}

export const PartRow = memo(function PartRow({ row, anySolo, tab, onFocusKey }: PartRowProps) {
  const regions = useRowRegions(row.id);
  const clips = useRowClips(row.id);
  const kind = useRowKind(row.id);
  const status = partStatus(row, anySolo);
  return (
    <div
      className={styles.row}
      style={{ '--h': row.hue } as CSSProperties}
      data-lane-row={row.id}
      data-row-index={row.index}
      data-quiet={status === 'Muted' || status === 'Not soloed' || undefined}
    >
      <PartHeader row={row} anySolo={anySolo} tab={tab} onFocusKey={onFocusKey} />
      <div className={styles.lane} data-lane={row.id} role="group" aria-label={`${row.name}${status ? ` (${status.toLowerCase()})` : ''}: ${regions.length === 1 ? '1 loop' : `${regions.length} loops`}`}>
        {regions.map((r) => (
          <RegionView key={r.id} region={r} clip={clips.find((c) => c?.id === r.clipId) ?? null} partName={row.name} kind={kind} />
        ))}
      </div>
    </div>
  );
});

/** Arrow keys between the headers' Mute and Solo keys (↑ ↓ rows, ← → keys); returns true when it moved. */
export function partKeysNav(e: KeyboardEvent<HTMLElement>, rows: number, move: (row: number, col: 0 | 1) => void): boolean {
  const t = e.target as HTMLElement;
  const row = Number(t.dataset.row);
  const col = Number(t.dataset.col) as 0 | 1;
  if (!t.closest('[data-col]') || !Number.isFinite(row) || e.altKey || e.ctrlKey || e.metaKey) return false;
  let next: [number, 0 | 1] | null = null;
  if (e.key === 'ArrowDown') next = [Math.min(rows - 1, row + 1), col];
  else if (e.key === 'ArrowUp') next = [Math.max(0, row - 1), col];
  else if (e.key === 'ArrowRight') next = [row, 1];
  else if (e.key === 'ArrowLeft') next = [row, 0];
  if (!next) return false;
  e.preventDefault();
  e.stopPropagation();
  move(next[0], next[1]);
  return true;
}
