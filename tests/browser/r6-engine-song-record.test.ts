/**
 * Record in the Song view end to end (session + the song-clips commands): a
 * take longer than 8 bars becomes song clips and regions from its start bar
 * in one undo step, plays back in the song, and Undo removes all of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { clipById } from '../../src/project/clips';
import { createClip, createProject } from '../../src/project/factory';
import type { Id, Project } from '../../src/project/types';
import { deleteDb } from '../../src/persistence/db';
import { defaultUiState, selectTrack, uiStore } from '../../src/state/uiStore';
import { outputDelaySeconds } from '../../src/time/transport';

const BAR = 384;
const rt = () => runtimeStore.getState();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, what: string, ms = 15000): Promise<void> {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const track = (p: Project, id: Id) => p.tracks.find((t) => t.id === id)!;

let live: Session[] = [];
const reset = () =>
  patchRuntime({ muteAll: false, stalled: null, playing: false, paused: false, mode: 'live', replayId: null, songCursor: 0, songLoop: null, songLooping: false, notice: null, recording: 'off', recordTarget: null, countingIn: false, held: {}, tracks: {}, recordStartsAtTick: null, recordTargetAudible: true, songRecording: null });

beforeEach(async () => {
  await deleteDb();
  uiStore.setState({ ...defaultUiState() });
  reset();
});

afterEach(async () => {
  for (const s of live) s.dispose();
  live = [];
  reset();
  await deleteDb();
});

describe('Record in the Song view, with the song-clips commands', () => {
  it('a 9-bar take becomes two song clips and regions from the start bar in one undo step; Undo removes it', async () => {
    const p = createProject({ bpm: 480, now: 0 });
    p.seed = 1234;
    for (const t of p.tracks) t.clips = t.clips.map(() => null);
    p.assist = false;
    p.settings.countIn = false;
    p.settings.recordQuantize = '1/16';
    // Something already in the song on t4 where the take goes: the take wins there.
    track(p, 't4').clips[0] = createClip('old', 1, [{ tick: 0, pitch: 40, duration: 48, velocity: 0.8 }]);
    p.arrangement = { regions: [{ id: 'old', trackId: 't4', clipId: track(p, 't4').clips[0]!.id, start: 1, bars: 2, offset: 0 }], sections: [], tailSeconds: 0 };
    const s = new Session(p);
    live.push(s);
    expect(await s.startAudio()).toBe(true);
    selectTrack('t4');
    s.setSongCursor(1);
    const before = s.store.getState();
    await s.toggleRecordNotes({ song: true });
    const ctx = s.ctx!;
    const heardAt = (tick: number) => s.sequencer!.timeAt(tick) + outputDelaySeconds(ctx, s.engine as never);
    const press = async (pitch: number, tick: number) => {
      await until(() => ctx.currentTime >= heardAt(tick), `tick ${tick}`);
      s.noteOn('t4', pitch, 0.9, 'computer');
      await sleep(40);
      s.noteOff('t4', pitch, 'computer');
    };
    // Song bar 1 is transport bar 1 (first pass): a note in the take's first bar, one in its ninth.
    await press(60, BAR + 96);
    await press(62, BAR + 8 * BAR + 96);
    await until(() => (rt().songRecording?.bars ?? 0) >= 9, 'bar 9 of the take');
    s.stop();
    const after = s.store.getState();
    expect(s.store.undoLabel()).toMatch(/Record/);
    const regions = after.arrangement.regions.filter((r) => r.trackId === 't4');
    expect(regions.map((r) => [r.start, r.bars])).toEqual([[1, 8], [9, 1]]);
    const clips = regions.map((r) => clipById(track(after, 't4'), r.clipId)!);
    expect(track(after, 't4').songClips).toHaveLength(2);
    expect(clips.map((c) => c.notes.map((n) => [n.tick, n.pitch]))).toEqual([[[96, 60]], [[96, 62]]]);
    s.undo();
    expect(s.store.getState().arrangement).toEqual(before.arrangement);
    expect(track(s.store.getState(), 't4').songClips ?? []).toHaveLength(0);
  });
});
