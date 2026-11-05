/**
 * The piano roll's vertical zoom: − and + make every pitch row shorter or
 * taller (22, 28 or 36 px), so more notes fit in view or each row is an
 * easier target. Shared by Steps and the Song view's editor.
 */
import { IconButton } from '../../../ui/components';
import { ROLL_ROW_HEIGHTS, useRollRowHeight, zoomRollRows } from './shared';
import styles from './StepHeader.module.css';

export function RowZoom() {
  const h = useRollRowHeight();
  const i = ROLL_ROW_HEIGHTS.indexOf(h);
  return (
    <div className={styles.rowZoom} role="group" aria-label="Row height">
      <span className={styles.rowZoomLabel} aria-hidden="true">
        Rows
      </span>
      <IconButton icon="minus" label="Shorter rows: more notes in view" size="sm" variant="ghost" onClick={() => zoomRollRows(-1)} disabled={i <= 0} />
      <IconButton icon="plus" label="Taller rows: bigger targets" size="sm" variant="ghost" onClick={() => zoomRollRows(1)} disabled={i >= ROLL_ROW_HEIGHTS.length - 1} />
    </div>
  );
}
