/**
 * Play: the default surface — pad matrix (four modes), the selected part's
 * sound controls and the keyboard. Switching pad modes (or Simple / Advanced)
 * never touches playback or the project. The cables drawer is in Advanced.
 *
 * The Drums and Notes tabs go straight to their pads: opening Drums while the
 * selected part is not a drum kit selects a drum part (the one the Notes tab
 * last moved away from, else the first), and Notes does the same for a
 * melodic part. Only a project without such a part shows the chooser (it says
 * why). Steps edits any part, so it keeps the selection.
 *
 * Importing selection.ts here registers the one-selected-clip rule for the
 * whole app (the app loads this view eagerly): a selected part always has the
 * slot its controls act on.
 */
import type { ReactNode } from 'react';
import '../selection';
import { SegmentedControl } from '../../ui/components';
import type { Id, Track } from '../../project/types';
import { selectTrack, setPadMode, uiStore, type PadMode } from '../../state/uiStore';
import { session, useUi } from '../instance';
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

/** The part the Drums or Notes tab last moved away from, so the other tab comes back to it (Chords → Drums → Notes plays Chords again). */
const leftBy: Partial<Record<'drums' | 'notes', Id>> = {};

/** Open a pad tab; Drums and Notes first select a part their pads can play (see the file comment). */
function openPadMode(mode: PadMode): void {
  if (mode === 'drums' || mode === 'notes') {
    const p = session.store.getState();
    const suits = (t: Track) => (t.instrument.kind === 'drums') === (mode === 'drums');
    const current = p.tracks.find((t) => t.id === uiStore.getState().selectedTrackId);
    if (!current || !suits(current)) {
      const other = mode === 'drums' ? 'notes' : 'drums';
      const part = p.tracks.find((t) => t.id === leftBy[other] && suits(t)) ?? p.tracks.find(suits);
      if (part) {
        if (current) leftBy[mode] = current.id;
        selectTrack(part.id);
      }
    }
  }
  setPadMode(mode);
}

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
            onChange={openPadMode}
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
