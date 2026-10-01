/**
 * The song layout that is actually playing.
 *
 * The sequencer holds the song on its timeline in absolute ticks and lays
 * the rest of it out again whenever the song is edited while it plays or is
 * paused (see Sequencer.replanSong), so playback always follows the lane.
 * This store mirrors that plan for the Arrange view and the transport: it is
 * refreshed after every start, stop, pause, resume, block change, edit and
 * song loop change, and is null whenever the song is not playing or paused.
 * While the song loops, the plan repeats the loop's blocks (same ids) and
 * is laid out a little ahead as it plays; the playhead (`songTimelineBar`)
 * reads the sequencer's plan directly so it is never behind.
 */
import { createStore, useStore } from '../../../state/store';
import { songBlocks, songLaneTick, type SongBlockPlan } from '../../../time/sequencer';
import { TICKS_PER_BAR, type Project } from '../../../project/types';
import { session } from '../../instance';
import { runtimeStore } from '../../runtime';

const planStore = createStore<readonly SongBlockPlan[] | null>(null);

function planKey(plan: readonly SongBlockPlan[] | null): string {
  if (!plan) return '';
  return plan.map((b) => `${b.index}:${b.blockId}:${b.startTick}-${b.endTick}:${b.row}:${b.bars}x${b.repeats}:${JSON.stringify(b.parts)}`).join('|');
}

let currentKey = '';

function setPlan(plan: readonly SongBlockPlan[] | null): void {
  const key = planKey(plan);
  if (key === currentKey && (plan === null) === (planStore.getState() === null)) return;
  currentKey = key;
  planStore.setState(plan);
}

function refresh(): void {
  const rt = runtimeStore.getState();
  if (rt.mode !== 'song' || !(rt.playing || rt.paused)) {
    setPlan(null);
    return;
  }
  const seq = session.sequencer;
  const live = seq && seq.mode.kind === 'song' ? seq.songPlan() : null;
  if (live) setPlan(live);
  // Only the runtime says the song plays (no transport yet): the layout as it was when that began.
  else if (!planStore.getState()) setPlan(songBlocks(session.store.getState()));
}

// The session handles each change first (it subscribed when it was created), so the sequencer's plan is current here.
runtimeStore.subscribe(refresh);
session.store.subscribe(refresh);

/**
 * Play the song from block `index`, or from a bar of the song (restarts it
 * when it is already playing). Neither given (Play song): from the song
 * loop's first block when a loop is set, else from the first block.
 */
export async function startSong(index?: number, opts: { fromBar?: number } = {}): Promise<void> {
  await session.playSong(index, opts);
  // A restart while the song plays may leave the runtime as it was: take the plan the transport just laid out.
  refresh();
}

/** The song as it plays (absolute ticks, history first), or null when the song is not playing or paused. */
export function useSongPlan(): readonly SongBlockPlan[] | null {
  return useStore(planStore, (s) => s);
}

export function getSongPlan(): readonly SongBlockPlan[] | null {
  return planStore.getState();
}

let lane: { project: Project; blocks: SongBlockPlan[] } | null = null;

/** The blocks on the lane (current order), cached per project. */
function laneOf(p: Project): SongBlockPlan[] {
  if (lane?.project !== p) lane = { project: p, blocks: songBlocks(p) };
  return lane.blocks;
}

/**
 * Where transport tick `tick` is on the song timeline as the lane draws it:
 * bars from the song start (fractional), in the current block order. That is
 * the lane start of the block playing at `tick` plus how far into it the
 * playhead is, so blocks moved or resized before it are accounted for; it
 * never runs past that block's end on the lane. A block deleted while it
 * plays sounds on to the next bar line while the playhead waits where the
 * block that takes over starts (see `songLaneTick`). While the song loops,
 * the playhead goes back to the loop's first block each time it starts
 * again. Null when the song is not playing or paused.
 */
export function songTimelineBar(tick: number): number | null {
  const plan = planStore.getState();
  if (!plan || !Number.isFinite(tick)) return null;
  const lane = laneOf(session.store.getState());
  // The plan as it plays now: a looping song lays out its next passes as it goes.
  const live = session.sequencer?.mode.kind === 'song' ? session.sequencer.songLaneTickAt(lane, tick) : null;
  return (live ?? songLaneTick(plan, lane, tick)) / TICKS_PER_BAR;
}

/** Identity of a layout: blocks, scene lengths and repeats in order. */
export function planSignature(plan: readonly SongBlockPlan[]): string {
  return plan.map((b) => `${b.blockId}:${b.row}:${b.bars}:${b.repeats}`).join('|');
}

export function projectSongSignature(p: Project): string {
  return planSignature(songBlocks(p));
}
