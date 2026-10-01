/**
 * The song layout that is actually playing.
 *
 * The sequencer holds the song on its timeline in absolute ticks and lays
 * the rest of it out again whenever the song is edited while it plays or is
 * paused (see Sequencer.replanSong), so playback always follows the lane.
 * This store mirrors that plan for the Arrange view and the transport: it is
 * refreshed after every start, stop, pause, resume, block change and edit,
 * and is null whenever the song is not playing or paused.
 */
import { createStore, useStore } from '../../../state/store';
import { songBlocks, type SongBlockPlan } from '../../../time/sequencer';
import { TICKS_PER_BAR, type Id, type Project } from '../../../project/types';
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

/** Play the song from block `index`, or from a bar of the song (restarts it when it is already playing). */
export async function startSong(index: number, opts: { fromBar?: number } = {}): Promise<void> {
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

let lane: { project: Project; starts: Map<Id, number>; total: number } | null = null;

/** Start bar of every block on the lane (current order), cached per project. */
function laneOf(p: Project): { starts: Map<Id, number>; total: number } {
  if (lane?.project !== p) {
    const blocks = songBlocks(p);
    lane = { project: p, starts: new Map(blocks.map((b) => [b.blockId, b.startTick / TICKS_PER_BAR])), total: (blocks.at(-1)?.endTick ?? 0) / TICKS_PER_BAR };
  }
  return lane;
}

/**
 * Where transport tick `tick` is on the song timeline as the lane draws it:
 * bars from the song start (fractional), in the current block order. That is
 * the lane start of the block playing at `tick` plus how far into it the
 * playhead is, so blocks moved or resized before it are accounted for. A
 * block deleted while it plays sits just before the block that follows it.
 * Null when the song is not playing or paused.
 */
export function songTimelineBar(tick: number): number | null {
  const plan = planStore.getState();
  if (!plan || !Number.isFinite(tick)) return null;
  if (!plan.length) return 0;
  const { starts, total } = laneOf(session.store.getState());
  let i = plan.findIndex((b) => tick < b.endTick);
  if (i < 0) i = plan.length - 1;
  const b = plan[i];
  const start = starts.get(b.blockId);
  if (start !== undefined) return start + (tick - b.startTick) / TICKS_PER_BAR;
  const left = (b.endTick - tick) / TICKS_PER_BAR;
  for (let j = i + 1; j < plan.length; j++) {
    const next = starts.get(plan[j].blockId);
    if (next !== undefined) return Math.max(0, next - left);
  }
  return Math.max(0, total - left);
}

/** Identity of a layout: blocks, scene lengths and repeats in order. */
export function planSignature(plan: readonly SongBlockPlan[]): string {
  return plan.map((b) => `${b.blockId}:${b.row}:${b.bars}:${b.repeats}`).join('|');
}

export function projectSongSignature(p: Project): string {
  return planSignature(songBlocks(p));
}
