/**
 * Play: the default surface — pad matrix (four modes), the selected part's
 * sound controls and the keyboard. Switching pad modes (or Simple / Advanced)
 * never touches playback or the project. The cables drawer is in Advanced.
 *
 * Importing selection.ts here registers the one-selected-clip rule for the
 * whole app (the app loads this view eagerly): a selected part always has the
 * slot its controls act on.
 */
import type { ReactNode } from 'react';
import '../selection';
import { SegmentedControl } from '../../ui/components';
import { setPadMode, type PadMode } from '../../state/uiStore';
import { useUi } from '../instance';
import { LoopsGrid } from './LoopsGrid';
import { DrumPads } from './DrumPads';
import { NotesPads } from './NotesPads';
import { PartPanel } from './PartPanel';
import { StepEditor } from './StepEditor';
import { CablesDrawer } from './cables';
import styles from './PlayView.module.css';

export interface PadModeDef {
  value: PadMode;
  label: string;
  render: () => ReactNode;
}

export const PAD_MODES: PadModeDef[] = [
  { value: 'loops', label: 'Loops', render: () => <LoopsGrid /> },
  { value: 'drums', label: 'Drums', render: () => <DrumPads /> },
  { value: 'notes', label: 'Notes', render: () => <NotesPads /> },
  { value: 'steps', label: 'Steps', render: () => <StepEditor /> },
];

export function PlayView() {
  const padMode = useUi((s) => s.padMode);
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const mode = PAD_MODES.find((m) => m.value === padMode) ?? PAD_MODES[0];
  return (
    <div className={styles.view} data-mode={advanced ? 'advanced' : 'simple'}>
      <section className={styles.surface} aria-label="Pads">
        <div className={styles.surfaceHead}>
          <SegmentedControl<PadMode>
            label="Pad mode"
            kind="tabs"
            options={PAD_MODES.map((m) => ({ value: m.value, label: m.label }))}
            value={mode.value}
            onChange={(v) => setPadMode(v)}
            controls="pad-surface"
            size="md"
          />
        </div>
        <div id="pad-surface" className={styles.surfaceBody} role="tabpanel" aria-label={`${mode.label} pads`}>
          {mode.render()}
        </div>
      </section>
      <aside className={styles.side}>
        <PartPanel />
      </aside>
      {/* The cable panel (Advanced): collapsed to a one-line bar until opened. */}
      {advanced && (
        <div className={styles.cables}>
          <CablesDrawer />
        </div>
      )}
    </div>
  );
}
