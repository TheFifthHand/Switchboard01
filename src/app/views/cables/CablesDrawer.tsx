/**
 * Cables drawer for the Play view: a slim bar that opens the cable panel of
 * the selected part. Closed by default (uiStore `cablesOpen`), so the first
 * minute needs no patching; opening it never changes the sound.
 */
import { useCallback } from 'react';
import { Icon, IconButton } from '../../../ui/components';
import { describePathProblem } from '../../../project/graph';
import type { Project } from '../../../project/types';
import { setCablesOpen } from '../../../state/uiStore';
import { useProject, useUi } from '../../instance';
import { CablePanelFrame } from './CablePanel';
import { partCableCount } from './model';
import styles from './CablesDrawer.module.css';

/** Height of the open drawer (panel included). */
export const CABLES_DRAWER_HEIGHT = 300;

const selectTrackIds = (p: Project) => p.tracks.map((t) => t.id).join('\u0000');

export function CablesDrawer() {
  const open = useUi((s) => s.cablesOpen);
  const selected = useUi((s) => s.selectedTrackId);
  const ids = useProject(selectTrackIds).split('\u0000');
  const trackId = ids.includes(selected) ? selected : (ids[0] ?? selected);
  const name = useProject(useCallback((p: Project) => p.tracks.find((t) => t.id === trackId)?.name ?? '', [trackId]));
  const cables = useProject(useCallback((p: Project) => partCableCount(p.patch, trackId), [trackId]));
  const silent = useProject(useCallback((p: Project) => describePathProblem(p.patch, trackId) !== null, [trackId]));

  if (open) {
    return (
      <section className={styles.drawer} data-open="true" aria-label="Cables drawer" style={{ height: CABLES_DRAWER_HEIGHT }}>
        <CablePanelFrame
          trackId={trackId}
          height={CABLES_DRAWER_HEIGHT}
          headerStart={<IconButton icon="chevronDown" size="sm" label="Hide cables" aria-expanded="true" onClick={() => setCablesOpen(false)} tip="Close the cable drawer. Your cables stay as they are." />}
        />
      </section>
    );
  }

  return (
    <section className={styles.drawer} aria-label="Cables drawer">
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
