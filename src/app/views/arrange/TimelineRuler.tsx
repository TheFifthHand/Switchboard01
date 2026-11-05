/**
 * The ruler over the rows: bar numbers (1-based, as people count) at a
 * readable spacing, a line on every bar where they are far enough apart, and
 * the loop range as a band (teal when looping is on, dimmed while off) with a
 * grip at each end. Pointer gestures on it are the timeline's
 * (laneController): a click moves the playhead, a drag sets the loop range.
 * The playhead's head (moved by the timeline's frame loop) sits in it.
 *
 * A right-click on the ruler (or Shift+F10 in the song with no loop
 * selected, at the playhead) opens the time menu: insert 4 or 8 empty bars
 * at that bar line, and, while a loop range is marked, take those bars out
 * of the song. Each is one undo step.
 */
import { memo, type CSSProperties, type Ref } from 'react';
import { timelineBars } from '../../../project/arrangement';
import { MAX_SONG_BARS } from '../../../project/types';
import { useProject } from '../../instance';
import { LOCKED_REASON, MenuHeader, MenuItem, MenuSeparator, Popover, useEditLocked, type MenuAnchor } from '../ClipMenu';
import { LaneIcon } from './laneIcons';
import { INSERT_CHOICES, insertBarsAt, removeBarsRange } from './laneEdits';
import type { BarRange } from './laneGestures';
import { rangeWords } from './laneLoop';
import { rulerMarks } from './songLayout';
import { barsText, rangeText } from './songModel';
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
          // The "Try this" chip never covers it (a click on it switches the loop).
          data-hint-avoid=""
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

/**
 * The ruler's menu at bar line `bar` (0-based: "here" is just before bar
 * `bar + 1`): insert empty bars there, or remove the marked range's bars.
 */
export function TimeMenu({ bar, range, anchor, returnFocus, onClose }: { bar: number; range: BarRange | null; anchor: MenuAnchor; returnFocus: HTMLElement | null; onClose(): void }) {
  const locked = useEditLocked();
  const end = useProject(timelineBars);
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const insertProblem = (n: number): string | null => {
    if (locked) return LOCKED_REASON;
    if (bar >= end) return 'Nothing comes after here';
    if (end + n > MAX_SONG_BARS) return `No room: at most ${MAX_SONG_BARS} bars`;
    return null;
  };
  const removeProblem = !range ? null : locked ? LOCKED_REASON : range.fromBar >= end ? 'Nothing is there' : null;
  return (
    <Popover anchor={anchor} label={`Bars at bar ${bar + 1}`} onClose={onClose} returnFocus={returnFocus} className={styles.timeMenu}>
      <MenuHeader eyebrow="Ruler" title={`At bar ${bar + 1}`} />
      {INSERT_CHOICES.map((n) => {
        const problem = insertProblem(n);
        return (
          <MenuItem key={n} icon="plus" disabled={!!problem} disabledReason={problem ?? undefined} onSelect={run(() => insertBarsAt(bar, n))}>
            Insert {barsText(n)} here
          </MenuItem>
        );
      })}
      <MenuSeparator />
      {range ? (
        <MenuItem icon="trash" tone="danger" disabled={!!removeProblem} disabledReason={removeProblem ?? undefined} onSelect={run(() => removeBarsRange(range.fromBar, range.toBar))}>
          Remove {rangeText(range.fromBar, range.toBar).toLowerCase()}
        </MenuItem>
      ) : (
        <p className={styles.timeMenuNote}>To remove bars, drag along the ruler to mark them, then open this menu.</p>
      )}
    </Popover>
  );
}
