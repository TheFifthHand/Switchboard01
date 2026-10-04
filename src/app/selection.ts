/**
 * One selected clip per part (PLAY-01).
 *
 * The pad ring, the pad action bar, the part's ▶, Variation, Steps and Record
 * Notes all act on the part's chosen slot (uiStore `selectedSlot`, read with
 * `slotFor`). A part that has no chosen slot yet gets one the moment it is
 * selected, or when a project opens with it selected: the clip it plays, else
 * its first clip, else the first slot. Opening another project forgets the
 * slots chosen in the last one. So the ring always shows what the other
 * controls will act on, and none of them needs a fallback of its own.
 *
 * Registered on first import (PlayView imports it, and the app loads PlayView
 * eagerly, so it runs in every view). Pure reads (`defaultSlot`, `targetSlot`)
 * are exported for controls of parts that are not selected (a column's ▶).
 */
import type { Id, Project } from '../project/types';
import { ensureSelectedSlot, uiStore, type UiState } from '../state/uiStore';
import { session } from './instance';
import { runtimeStore, type RuntimeState } from './runtime';

/** The slot a part's controls act on when none is chosen: the clip it plays, else its first clip, else 0. */
export function defaultSlot(p: Project, trackId: Id, playing: number | null | undefined): number {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return 0;
  if (playing != null && t.clips[playing]) return playing;
  const first = t.clips.findIndex((c) => !!c);
  return first < 0 ? 0 : first;
}

/** The slot a part's controls act on: its chosen slot, else the one it would be given (see defaultSlot). */
export function targetSlot(ui: Pick<UiState, 'selectedSlot'>, p: Project, rt: Pick<RuntimeState, 'tracks'>, trackId: Id): number {
  return ui.selectedSlot[trackId] ?? defaultSlot(p, trackId, rt.tracks[trackId]?.playingSlot ?? null);
}

/** Give `trackId` its slot if it has none chosen yet (a choice already made stays). */
export function ensureSlotFor(trackId: Id): void {
  if (uiStore.getState().selectedSlot[trackId] !== undefined) return;
  const p = session.store.getState();
  if (!p.tracks.some((t) => t.id === trackId)) return;
  ensureSelectedSlot(trackId, defaultSlot(p, trackId, runtimeStore.getState().tracks[trackId]?.playingSlot ?? null));
}

let unregister: (() => void) | null = null;

/** Watch the selected part and the open project (idempotent; returns the way to stop, for tests). */
export function registerSelection(): () => void {
  if (unregister) return unregister;
  const ensureSelected = () => ensureSlotFor(uiStore.getState().selectedTrackId);
  // Any UI change: the selected part (a new one, or one whose choice was cleared) gets its slot.
  const offUi = uiStore.subscribe((s) => {
    if (s.selectedSlot[s.selectedTrackId] === undefined) ensureSelected();
  });
  // Another project (open, import, a starter): the slots chosen in the last one mean nothing here, so they go,
  // and the selected part gets its slot in this one.
  let projectId = session.store.getState().id;
  const offProject = session.store.subscribe((p) => {
    if (p.id === projectId) return;
    projectId = p.id;
    uiStore.setState((s) => (Object.keys(s.selectedSlot).length ? { ...s, selectedSlot: {} } : s));
    ensureSelected();
  });
  ensureSelected();
  unregister = () => {
    offUi();
    offProject();
    unregister = null;
  };
  return unregister;
}

registerSelection();
