/**
 * Shared set-up for the round-4 Steps tests: the whole app with the House
 * starter (through r4-play-helpers), Steps opened on a part's clip, and ways
 * to find cells, notes and lanes of the piano roll for real (CDP) input.
 */
import { act } from 'react';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { noteSelection } from '../../src/app/views/steps/shared';
import type { Id, Note } from '../../src/project/types';
import { selectSlot, selectTrack, setPadMode, setStepGrid, setStepPage, setStepsFollow, uiStore, type StepGrid } from '../../src/state/uiStore';
import { openApp, until } from './r4-play-helpers';
import { centre, settleFrames, type Pt } from './r4-uikit-input';

export const CHORDS = 't4';
export const BASS = 't3';

/** The app at `w` x `h` (House starter, optionally playing) with Steps open on `trackId`'s clip in `slot`. */
export async function openSteps(trackId: Id, slot: number, opts: { w?: number; h?: number; play?: boolean; grid?: StepGrid } = {}): Promise<void> {
  await openApp(opts.w ?? 1366, opts.h ?? 768, { play: opts.play });
  act(() => {
    setStepGrid(opts.grid ?? '1/16');
    setStepsFollow(false);
    noteSelection.setState({ key: '', ids: [] });
    selectTrack(trackId);
    selectSlot(trackId, slot);
    setStepPage(trackId, 0);
    setPadMode('steps');
  });
  await settleFrames(3);
  await until(() => !!document.querySelector('[data-steps-root]'), 'the Steps editor');
}

export const roll = () => document.querySelector<HTMLElement>('[data-testid="pitch-roll"]')!;
export const scroller = () => roll().parentElement as HTMLElement;
export const lane = () => document.querySelector<HTMLElement>('[data-testid="velocity-lane"]')!;
export const cursorEl = () => document.querySelector<HTMLButtonElement>('button[aria-label^="Note grid"]')!;
export const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-labelledby^="steps-bars-"] [role="tab"]')];
export const col = (cell: number) => roll().querySelector<HTMLElement>(`[data-col="${cell}"]`)!;
export const rowLabel = (pitch: number) => roll().querySelector<HTMLElement>(`[data-row-label="${pitch}"]`)!;
export const noteEl = (id: Id) => roll().querySelector<HTMLElement>(`[data-note-id="${id}"]`);
export const clipOf = (trackId: Id, slot: number) => session.store.getState().tracks.find((t) => t.id === trackId)!.clips[slot]!;
export const notesOf = (trackId: Id, slot: number): Note[] => clipOf(trackId, slot).notes;
export const selected = (): readonly Id[] => noteSelection.getState().ids;
export const notice = () => runtimeStore.getState().notice;
export const page = (trackId: Id) => uiStore.getState().stepPage[trackId] ?? 0;

/** Bring a pitch row into the roll's view (the roll scrolls; the page does not need to). */
export async function showRow(pitch: number): Promise<void> {
  const el = rowLabel(pitch);
  const sc = scroller();
  const r = el.getBoundingClientRect();
  const s = sc.getBoundingClientRect();
  if (r.top < s.top + 4 || r.bottom > s.bottom - 4) {
    sc.scrollTop += r.top - s.top - s.height / 2;
    await settleFrames(2);
  }
}

/** The middle of a cell of the shown page on a pitch row (the row must be in view). */
export function cellPt(cell: number, pitch: number, fx = 0.5): Pt {
  const c = col(cell).getBoundingClientRect();
  const r = rowLabel(pitch).getBoundingClientRect();
  return { x: c.left + c.width * fx, y: r.top + r.height / 2 };
}

/** The middle of a note's block (its first visible cell). */
export function notePt(id: Id): Pt {
  const el = noteEl(id);
  if (!el) throw new Error(`note ${id} is not on the shown page`);
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(r.width / 2, 10), y: r.top + r.height / 2 };
}

/** The middle of a velocity lane column at a height fraction (0 = bottom, 1 = top). */
export function lanePt(cell: number, level: number): Pt {
  const el = lane().querySelector<HTMLElement>(`[data-step="${cell}"]`)!;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.bottom - 3 - (r.height - 6) * level };
}

export { centre };
