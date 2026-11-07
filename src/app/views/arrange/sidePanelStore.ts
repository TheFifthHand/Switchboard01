/**
 * What the Song screen's right-hand side shows (round 7): the LOOPS library,
 * or the Sound panel of one instrument (opened by clicking its name). A tiny
 * shared store, so the row headers, the editor and the shell can open the
 * Sound panel without knowing where it is drawn.
 */
import type { Id } from '../../../project/types';
import { createStore } from '../../../state/store';

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
