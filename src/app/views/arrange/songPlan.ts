/**
 * The song layout that is actually playing.
 *
 * The sequencer lays out the arrangement once, when the song starts; later
 * edits to the blocks (or to clip lengths) apply the next time the song
 * starts. The Arrange view therefore draws the playhead and the current
 * block from the plan captured at the start, matched to the lane by stable
 * block id, and says so when the lane no longer matches what plays.
 */
import { createStore, useStore } from '../../../state/store';
import { songBlocks, type SongBlockPlan } from '../../../time/sequencer';
import type { Project } from '../../../project/types';
import { session } from '../../instance';
import { runtimeStore } from '../../runtime';

const planStore = createStore<readonly SongBlockPlan[] | null>(null);

const songModeOn = (s: { playing: boolean; mode: string }) => s.playing && s.mode === 'song';

// Capture the plan whenever song playback starts (from any caller); forget it when it ends.
runtimeStore.subscribe((s, prev) => {
  const on = songModeOn(s);
  const was = songModeOn(prev);
  if (on && !was) planStore.setState(songBlocks(session.store.getState()));
  else if (!on && was) planStore.setState(null);
});

/** Play the song from block `index` (restarts it when it is already playing). */
export function startSong(index: number): void {
  const p = session.store.getState();
  if (p.arrangement.blocks.length === 0) {
    void session.playSong(index);
    return;
  }
  // playSong restarts the transport, so the plan is rebuilt from the current blocks.
  planStore.setState(songBlocks(p));
  void session.playSong(index);
}

export function useSongPlan(): readonly SongBlockPlan[] | null {
  return useStore(planStore, (s) => s);
}

export function getSongPlan(): readonly SongBlockPlan[] | null {
  return planStore.getState();
}

/** Identity of a layout: blocks, scene lengths and repeats in order. */
export function planSignature(plan: readonly SongBlockPlan[]): string {
  return plan.map((b) => `${b.blockId}:${b.row}:${b.bars}:${b.repeats}`).join('|');
}

export function projectSongSignature(p: Project): string {
  return planSignature(songBlocks(p));
}
