/**
 * The ruler over the rows: bar numbers (1-based, as people count) at a
 * readable spacing, a line on every bar where they are far enough apart, and
 * the loop range as a band (teal when looping is on, dimmed while off) with a
 * grip at each end. Pointer gestures on it are the timeline's
 * (laneController): a click moves the playhead, a drag sets the loop range.
 * The playhead's head (moved by the timeline's frame loop) sits in it.
 */
import { memo, type CSSProperties, type Ref } from 'react';
import { LaneIcon } from './laneIcons';
import type { BarRange } from './laneGestures';
import { rangeWords } from './laneLoop';
import { rulerMarks } from './songLayout';
import styles from './SongView.module.css';

export interface TimelineRulerProps {
  pxPerBar: number;
  bars: number;
  range: BarRange | null;
  looping: boolean;
  /** A ruler drag in progress (its range is drawn instead). */
  dragging: boolean;
  headRef: Ref<HTMLDivElement>;
}

const Numbers = memo(function Numbers({ pxPerBar, bars }: { pxPerBar: number; bars: number }) {
  return (
    <>
      {rulerMarks(pxPerBar, 0, bars)
        .filter((m) => m.label)
        .map((m) => (
          <span key={m.bar} className={styles.rulerNum} style={{ '--s': m.bar } as CSSProperties}>
            {m.bar + 1}
          </span>
        ))}
    </>
  );
});

export function TimelineRuler({ pxPerBar, bars, range, looping, dragging, headRef }: TimelineRulerProps) {
  return (
    <div className={styles.ruler} data-ruler="" aria-hidden="true">
      <Numbers pxPerBar={pxPerBar} bars={bars} />
      {range && (
        <div
          className={styles.rangeBand}
          data-range-band=""
          data-on={looping || dragging || undefined}
          data-dragging={dragging || undefined}
          style={{ '--s': range.fromBar, '--b': range.toBar - range.fromBar } as CSSProperties}
          title={`${looping ? 'Looping' : 'Loop range (off)'}: ${rangeWords(range)}. Click to switch the loop ${looping ? 'off' : 'on'}; drag its ends to change it.`}
        >
          <span className={styles.rangeLabel}>
            <LaneIcon name="loop" size={11} />
            <span>{rangeWords(range)}</span>
          </span>
          <span className={styles.rangeEdge} data-range-edge="start" />
          <span className={styles.rangeEdge} data-range-edge="end" />
        </div>
      )}
      <div ref={headRef} className={styles.playheadHead} />
    </div>
  );
}
