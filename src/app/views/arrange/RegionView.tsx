/**
 * One region on a part's row: a rounded rectangle in the part's colour with
 * the clip's name at the top, a picture of its notes repeated for each pass,
 * thin notches where the clip starts again, and a darker band at its left
 * edge when it begins in the middle of its clip.
 *
 * Placed and sized by CSS from the timeline's scale (`--ppb` on the
 * timeline, `--s` and `--b` here), so a zoom re-renders nothing; the face
 * draws again only when the region or its clip changes. Selected (teal
 * outline) is read from the selection store, so selecting one region
 * re-renders only that one. The region under the playhead while the song
 * plays gets `data-playing` from the playhead's frame loop (a subtle amber
 * edge), never through React.
 *
 * Pointer and key handling is the timeline's (event delegation); a region is
 * a focusable button in the lane's single Tab stop.
 */
import { memo, useMemo, type CSSProperties } from 'react';
import { ClipSketch } from '../../../ui/components';
import { TICKS_PER_BAR, type Clip, type SongRegion } from '../../../project/types';
import { useStore } from '../../../state/store';
import { selectionStore, useSelected } from './laneStore';
import { notches, regionLabel } from './songModel';
import styles from './SongView.module.css';

export interface RegionFaceProps {
  region: SongRegion;
  /** The clip it plays (null while it is gone, until the song is tidied). */
  clip: Clip | null;
  partName: string;
  kind: 'notes' | 'drums';
  /** Picked up by the pointer (drawn raised). */
  lifted?: boolean;
  /** Slide by this many bars from `region.start` (eased, transform only). */
  slide?: number;
  className?: string;
}

/** A region as a drag preview draws it, over the rows (decorative: the rows keep the real regions). */
export function RegionFace({ region, clip, kind, lifted, slide, className }: Omit<RegionFaceProps, 'partName'>) {
  const clipBars = clip?.bars ?? 1;
  const name = clip?.name || 'Loop';
  const marks = useMemo(() => notches(region, clipBars), [region, clipBars]);
  const style = {
    '--s': region.start - (slide ?? 0),
    '--b': region.bars,
    '--cb': clipBars,
    '--o': region.offset,
    ...(slide ? { '--d': slide } : {}),
  } as CSSProperties;
  return (
    <div
      className={[styles.region, className].filter(Boolean).join(' ')}
      style={style}
      data-offset={region.offset > 0 || undefined}
      data-notches={marks.length || undefined}
      data-ghost=""
      data-lifted={lifted || undefined}
      data-slide={slide !== undefined || undefined}
      aria-hidden="true"
    >
      <span className={styles.regionName}>{name}</span>
      {clip && (
        <span className={styles.regionSketch}>
          <ClipSketch notes={clip.notes} lengthTicks={clipBars * TICKS_PER_BAR} kind={kind} span={region.bars * TICKS_PER_BAR} offset={region.offset * TICKS_PER_BAR} />
        </span>
      )}
    </div>
  );
}

/** A region on its row: a focusable button (selected: teal outline). */
export const RegionView = memo(function RegionView({ region, clip, partName, kind }: Omit<RegionFaceProps, 'lifted' | 'slide' | 'className'>) {
  const selected = useSelected(region.id);
  const tabbable = useStore(selectionStore, (s) => s.focus === region.id);
  const clipBars = clip?.bars ?? 1;
  const name = clip?.name || 'Loop';
  const marks = useMemo(() => notches(region, clipBars), [region, clipBars]);
  const style = { '--s': region.start, '--b': region.bars, '--cb': clipBars, '--o': region.offset } as CSSProperties;
  return (
    <div
      className={styles.region}
      style={style}
      role="button"
      tabIndex={tabbable ? 0 : -1}
      aria-label={regionLabel(name, partName, region, clipBars)}
      aria-pressed={selected}
      aria-keyshortcuts="Shift+F10"
      data-region-id={region.id}
      data-track={region.trackId}
      data-start={region.start}
      data-bars={region.bars}
      data-selected={selected || undefined}
      data-offset={region.offset > 0 || undefined}
      data-notches={marks.length || undefined}
    >
      <span className={styles.regionName} aria-hidden="true">
        {name}
      </span>
      {clip && (
        <span className={styles.regionSketch} aria-hidden="true">
          <ClipSketch notes={clip.notes} lengthTicks={clipBars * TICKS_PER_BAR} kind={kind} span={region.bars * TICKS_PER_BAR} offset={region.offset * TICKS_PER_BAR} />
        </span>
      )}
      <span className={styles.grip} data-edge="start" aria-hidden="true" />
      <span className={styles.grip} data-edge="end" aria-hidden="true" />
    </div>
  );
});
