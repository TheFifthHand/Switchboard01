/**
 * Play: the default surface — pad matrix (four modes), the selected part's
 * sound controls and the keyboard. Switching pad modes never touches
 * playback or the project.
 */
import type { ReactNode } from 'react';
import { SegmentedControl } from '../../ui/components';
import { setPadMode, type PadMode } from '../../state/uiStore';
import { useUi } from '../instance';
import { LoopsGrid } from './LoopsGrid';
import { PartPanel } from './PartPanel';
import styles from './PlayView.module.css';

export interface PadModeDef {
  value: PadMode;
  label: string;
  render: () => ReactNode;
}

export const PAD_MODES: PadModeDef[] = [{ value: 'loops', label: 'Loops', render: () => <LoopsGrid /> }];

export function PlayView() {
  const padMode = useUi((s) => s.padMode);
  const mode = PAD_MODES.find((m) => m.value === padMode) ?? PAD_MODES[0];
  return (
    <div className={styles.view}>
      <section className={styles.surface} aria-label="Pads">
        <div className={styles.surfaceHead}>
          <SegmentedControl<PadMode>
            label="Pad mode"
            kind="tabs"
            options={PAD_MODES.map((m) => ({ value: m.value, label: m.label }))}
            value={mode.value}
            onChange={(v) => setPadMode(v)}
            controls="pad-surface"
            size="sm"
          />
        </div>
        <div id="pad-surface" className={styles.surfaceBody} role="tabpanel" aria-label={`${mode.label} pads`}>
          {mode.render()}
        </div>
      </section>
      <aside className={styles.side}>
        <PartPanel />
      </aside>
    </div>
  );
}
