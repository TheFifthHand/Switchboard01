/**
 * What the Song screen's right-hand side shows (round 7): the LOOPS library,
 * or the Sound panel of one instrument (opened by clicking its name). A tiny
 * shared store, so the row headers, the editor and the shell can open the
 * Sound panel without knowing where it is drawn. The panel follows the
 * editor: a loop of another instrument opened below shows that instrument.
 */
import type { Id } from '../../../project/types';
import { createStore } from '../../../state/store';
import { selectTrack, uiStore } from '../../../state/uiStore';
import { editorStore } from './editorStore';

export type SidePanel = { kind: 'loops' } | { kind: 'sound'; trackId: Id };

export const sidePanelStore = createStore<SidePanel>({ kind: 'loops' });

/** Show this instrument's Sound panel on the right. */
export function openSound(trackId: Id): void {
  sidePanelStore.setState({ kind: 'sound', trackId });
}

/** Back to the LOOPS library. */
export function closeSound(): void {
  sidePanelStore.setState({ kind: 'loops' });
}

// The Sound panel never shows one instrument while the editor below shows another: opening a loop of another
// instrument moves the panel to that instrument. In Simple the instrument is selected too (⋯ › Every setting
// names the instrument being edited, not the one added last).
editorStore.subscribe((e, prev) => {
  if (!e || e.trackId === prev?.trackId) return;
  const s = sidePanelStore.getState();
  if (s.kind === 'sound' && s.trackId !== e.trackId) openSound(e.trackId);
  if (uiStore.getState().uiMode === 'simple' && uiStore.getState().selectedTrackId !== e.trackId) selectTrack(e.trackId);
});
