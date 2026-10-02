/**
 * Record Notes timing in the running app (real Web Audio):
 * - PLAY-25: waiting for its clip to start, a note played up to an 8th
 *   before the downbeat is kept on the downbeat; an earlier one is not.
 *   runtime.recordStartsAtTick says where recording starts until it does.
 * - arrange-notes-recording-invisible: in the song, a block that does not
 *   play the clip being recorded into does not stop the recording: notes go
 *   into it where its loop would be, runtime.recordTargetAudible turns false
 *   and the transport says so once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { createClip, createProject } from '../../src/project/factory';
import type { Id, Project } from '../../src/project/types';
import { defaultUiState, selectSlot, selectTrack, uiStore } from '../../src/state/uiStore';
import { outputDelaySeconds } from '../../src/time/transport';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rt = () => runtimeStore.getState();

/** 120 BPM, Musical Assist off, no count-in, Record Notes unquantized. t4 (Chords) has a 1-bar clip in rows 0 and 2. */
function project(): Project {
  const p = createProject({ bpm: 120, now: 0 });
  p.seed = 3;
  p.assist = false;
  p.settings = { ...p.settings, countIn: false, recordQuantize: 'off' };
  for (const t of p.tracks) t.clips = t.clips.map(() => null);
  const t4 = p.tracks.find((t) => t.id === 't4')!;
  t4.clips[0] = createClip('Stabs', 1, [{ tick: 0, pitch: 48, velocity: 0.7, duration: 48 }]);
  t4.clips[2] = createClip('Other', 1, [{ tick: 0, pitch: 50, velocity: 0.7, duration: 48 }]);
  return p;
}

let live: Session[] = [];
async function started(p: Project): Promise<Session> {
  const s = new Session(p);
  live.push(s);
  expect(await s.startAudio()).toBe(true);
  return s;
}

async function until(fn: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Play key `pitch` on `trackId` so the player heard tick `tick` when pressing it (latency included), held ~60 ms. */
async function playAt(s: Session, trackId: Id, pitch: number, tick: number): Promise<void> {
  const ctx = s.ctx!;
  const when = s.sequencer!.timeAt(tick) + outputDelaySeconds(ctx, s.engine as never);
  await until(() => ctx.currentTime >= when, `tick ${tick}`);
  s.noteOn(trackId, pitch, 0.9, 'computer');
  await sleep(60);
  s.noteOff(trackId, pitch, 'computer');
}

/** Press key `pitch` when the player hears tick `from` and let go at tick `to` (latency included). */
async function holdFromTo(s: Session, trackId: Id, pitch: number, from: number, to: number): Promise<void> {
  const ctx = s.ctx!;
  const at = (tick: number) => s.sequencer!.timeAt(tick) + outputDelaySeconds(ctx, s.engine as never);
  await until(() => ctx.currentTime >= at(from), `tick ${from}`);
  s.noteOn(trackId, pitch, 0.9, 'computer');
  await until(() => ctx.currentTime >= at(to), `tick ${to}`);
  s.noteOff(trackId, pitch, 'computer');
}

const notesOf = (s: Session, slot: number) => [...(s.store.getState().tracks.find((t) => t.id === 't4')!.clips[slot]?.notes ?? [])].sort((a, b) => a.tick - b.tick);

beforeEach(() => {
  uiStore.setState({ ...defaultUiState() });
  patchRuntime({ muteAll: false, stalled: null, playing: false, paused: false, mode: 'live', replayId: null, songBlock: null, recording: 'off', recordTarget: null, countingIn: false, held: {}, notice: null, tracks: {}, recordStartsAtTick: null, recordTargetAudible: true });
});
afterEach(() => {
  for (const s of live) s.dispose();
  live = [];
  patchRuntime({ playing: false, recording: 'off', recordTarget: null, countingIn: false, held: {}, notice: null, tracks: {}, recordStartsAtTick: null, recordTargetAudible: true });
});

describe('Record Notes: the early window (PLAY-25)', () => {
  it('waiting for the next bar: a note an 8th early lands on the downbeat, one half a bar early is dropped; recordStartsAtTick counts down to it', async () => {
    const s = await started(project());
    selectTrack('t4');
    await s.launchScene(0);
    await until(() => s.transport!.getPosition().tick > 40, 'bar 1 under way');
    // Record into the empty pad in row 1: it starts at the next bar.
    selectSlot('t4', 1);
    await s.toggleRecordNotes();
    expect(rt().recording).toBe('notes');
    const R = rt().recordStartsAtTick!;
    expect(R).toBe(384);
    // Half a bar early: not recorded. An 8th (48 ticks) early, aimed 30 ticks before: on the downbeat.
    await playAt(s, 't4', 60, R - 192);
    await playAt(s, 't4', 62, R - 30);
    await playAt(s, 't4', 64, R + 96);
    await until(() => rt().recordStartsAtTick === null, 'the recording to start');
    await until(() => s.transport!.getPosition().tick > R + 200, 'after the downbeat');
    s.stopRecordNotes();
    s.stop();
    const got = notesOf(s, 1).map((n) => [Math.round(n.tick), n.pitch]);
    expect(got.map(([, p]) => p)).toEqual([62, 64]);
    expect(got[0][0]).toBe(0);
    expect(Math.abs(got[1][0] - 96)).toBeLessThanOrEqual(10);
  });
});

describe('Record Notes: a note caught early keeps the length it was played with (review minor 3)', () => {
  it('released before the downbeat: on the downbeat, as long as it was held; held across it: its whole length', async () => {
    const s = await started(project());
    selectTrack('t4');
    await s.launchScene(0);
    await until(() => s.transport!.getPosition().tick > 40, 'bar 1 under way');
    selectSlot('t4', 1);
    await s.toggleRecordNotes();
    const R = rt().recordStartsAtTick!;
    expect(R).toBe(384);
    // 40 ticks early, let go 8 ticks before the downbeat: 32 ticks long.
    await holdFromTo(s, 't4', 60, R - 40, R - 8);
    s.stop();
    const short = notesOf(s, 1);
    expect(short.map((n) => n.pitch)).toEqual([60]);
    expect(short[0].tick).toBe(0);
    expect(Math.abs(short[0].duration - 32)).toBeLessThanOrEqual(10);
    s.stopRecordNotes();

    // Again into another empty pad: 30 ticks early, held to a beat after the downbeat (126 ticks).
    await s.launchScene(0);
    await until(() => s.transport!.getPosition().tick > 40, 'bar 1 again');
    selectSlot('t4', 3);
    await s.toggleRecordNotes();
    const R2 = rt().recordStartsAtTick!;
    await holdFromTo(s, 't4', 62, R2 - 30, R2 + 96);
    await until(() => s.transport!.getPosition().tick > R2 + 150, 'after the note');
    s.stopRecordNotes();
    s.stop();
    const long = notesOf(s, 3);
    expect(long.map((n) => n.pitch)).toEqual([62]);
    expect(long[0].tick).toBe(0);
    expect(Math.abs(long[0].duration - 126)).toBeLessThanOrEqual(10);
  });
});

describe('Record Notes in the song: a block that does not play the clip (arrange-notes-recording-invisible)', () => {
  it('keeps recording into it where its loop would be, says so once, and recordTargetAudible follows the song', async () => {
    const p = project();
    // A plays row 0 (Stabs on t4), B plays row 2 (Other on t4) for 2 bars, then A again.
    p.arrangement = {
      tailSeconds: 0,
      blocks: [
        { id: 'A', sceneId: p.scenes[0].id, repeats: 1 },
        { id: 'B', sceneId: p.scenes[2].id, repeats: 2 },
        { id: 'A2', sceneId: p.scenes[0].id, repeats: 1 },
      ],
    };
    const s = await started(p);
    selectTrack('t4');
    selectSlot('t4', 0);
    await s.playSong(0);
    await until(() => s.transport!.getPosition().tick > 30, 'block A');
    await s.toggleRecordNotes();
    expect(rt()).toMatchObject({ recording: 'notes', recordTarget: { trackId: 't4', slot: 0 }, recordTargetAudible: true });
    // Block B (from tick 384) plays another clip on the part: recording goes on, silently.
    await until(() => rt().recordTargetAudible === false, 'block B', 6000);
    expect(rt().recording).toBe('notes');
    expect(rt().notice?.text).toBe('Recording into Chords · Stabs, which this block does not play.');
    // Played in B's second bar on its 2nd beat (song tick 864): Stabs (1 bar, looping from 0) would be at its tick 96.
    await playAt(s, 't4', 67, 864);
    // Back in A2 (from 1152) the clip sounds again.
    await until(() => rt().recordTargetAudible === true, 'block A2', 6000);
    s.stopRecordNotes();
    s.stop();
    const got = notesOf(s, 0).filter((n) => n.pitch === 67);
    expect(got).toHaveLength(1);
    expect(Math.abs(got[0].tick - 96)).toBeLessThanOrEqual(10);
    // The other clip was not touched.
    expect(notesOf(s, 2).map((n) => n.pitch)).toEqual([50]);
  });
});
