/**
 * The Channel drawer under the mixer (open or closed): it edits the selected
 * part's insert effects in place. Viewing state only, kept for this visit of
 * the app (never saved, never in the project).
 */
import { createStore, useStore } from '../../../state/store';
import { selectModule, selectTrack } from '../../../state/uiStore';
import type { Id } from '../../../project/types';

const drawer = createStore<{ open: boolean; seq: number }>({ open: false, seq: 0 });

/** Open the drawer on a part (and select one of its effects there). */
export function openChannelDrawer(trackId: Id, moduleId: Id | null = null): void {
  selectTrack(trackId);
  if (moduleId) selectModule(moduleId);
  // `seq` changes on every request, so asking again brings the drawer into view again.
  drawer.setState((s) => ({ open: true, seq: s.seq + 1 }));
}

export function closeChannelDrawer(): void {
  drawer.setState((s) => (s.open ? { ...s, open: false } : s));
}

export function toggleChannelDrawer(trackId: Id): void {
  if (drawer.getState().open) closeChannelDrawer();
  else openChannelDrawer(trackId);
}

export function useChannelDrawer(): { open: boolean; seq: number } {
  return useStore(drawer, (s) => s);
}

export function channelDrawerOpen(): boolean {
  return drawer.getState().open;
}
