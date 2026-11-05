/**
 * Song clips (schema v5) with the real session, transport and engine in
 * Chromium:
 *  - an export of the song plays a region of a song clip exactly where it is,
 *    like a pad clip's;
 *  - the song playing plays a song clip's notes, and an edit to its notes
 *    while it plays is heard from then on;
 *  - Record in the Song view (toggleRecordNotes({ song: true })) plays the
 *    song from its cursor and on past its end, grows runtime songRecording
 *    bar by bar on the audio clock, and hands the notes played (ticks from
 *    the start bar, held notes ended at the stop) to recordTakeIntoSong when
 *    it stops; recording while the song plays starts at the next bar line.
 *
 * recordTakeIntoSong belongs to the song-clips commands; here it is replaced
 * by a stand-in that keeps the take it is given (and refuses an empty one as
 * the contract says), so the session's side is checked on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { songSlot } from '../../src/project/clips';
import { createClip, createProject } from '../../src/project/factory';
import type { Clip, ClipBars, Id, Project } from '../../src/project/types';
import { bandEnergy, rms } from '../../src/render/analysis';
import { RENDER_START_OFFSET, renderOffline } from '../../src/render/offline';
import { deleteDb } from '../../src/persistence/db';
import type { SongTake } from '../../src/state/commands/songClips';
import { defaultUiState, selectTrack, uiStore } from '../../src/state/uiStore';
import { outputDelaySeconds } from '../../src/time/transport';

const takes: SongTake[] = [];
vi.mock('../../src/state/commands/songClips', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/state/commands/songClips')>();
  return {
    ...real,
    recordTakeIntoSong: (_store: unknown, take: SongTake) => {
      takes.push(structuredClone(take));
      return take.notes.length ? { changed: true } : { changed: false, reason: 'empty', message: 'Nothing was played, so nothing was recorded.' };
    },
  };
});

const SR = 48000;
const BAR = 384;
const rt = () => runtimeStore.getState();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, what: string, ms = 10000): Promise<void> {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function clip(name: string, bars: ClipBars, notes: [tick: number, pitch: number, duration: number][]): Clip {
  return createClip(name, bars, notes.map(([tick, pitch, duration]) => ({ tick, pitch, duration, velocity: 0.9 })));
}

const track = (p: Project, id: Id) => p.tracks.find((t) => t.id === id)!;

function emptyProject(bpm: number): Project {
  const p = createProject({ bpm, now: 0 });
  p.seed = 1234;
  for (const t of p.tracks) {
    t.clips = t.clips.map(() => null);
    t.macros.space = 0;
    t.macros.echo = 0;
  }
  p.arrangement = { regions: [], sections: [], tailSeconds: 0 };
  return p;
}

/** Every note the engine is given and does not cancel: [trackId, transport tick, pitch]. */
function tapNotes(s: Session): { trackId: Id; tick: number; pitch: number; cancelled: boolean }[] {
  const all: { trackId: Id; tick: number; pitch: number; cancelled: boolean }[] = [];
  const engine = s.engine!;
  const schedule = engine.scheduleNote.bind(engine);
  engine.scheduleNote = (trackId, note) => {
    const entry = { trackId, tick: Math.round(s.sequencer!.tickAt(note.time)), pitch: note.pitch, cancelled: false };
    all.push(entry);
    const h = schedule(trackId, note);
    if (h) {
      const cancel = h.cancel.bind(h);
      Object.defineProperty(h, 'cancel', {
        value: () => {
          entry.cancelled = true;
          cancel();
        },
      });
    }
    return h;
  };
  return all;
}

const heard = (all: ReturnType<typeof tapNotes>, trackId: Id) => all.filter((n) => !n.cancelled && n.trackId === trackId).map((n) => [n.tick, n.pitch]);

let live: Session[] = [];
async function started(p: Project): Promise<Session> {
  const s = new Session(p);
  live.push(s);
  expect(await s.startAudio()).toBe(true);
  return s;
}

/** Hold key `pitch` on `trackId` from when the player hears tick `from` to tick `to` (latency included). */
async function holdFromTo(s: Session, trackId: Id, pitch: number, from: number, to: number): Promise<void> {
  const ctx = s.ctx!;
  const at = (tick: number) => s.sequencer!.timeAt(tick) + outputDelaySeconds(ctx, s.engine as never);
  await until(() => ctx.currentTime >= at(from), `tick ${from}`);
  s.noteOn(trackId, pitch, 0.9, 'computer');
  await until(() => ctx.currentTime >= at(to), `tick ${to}`);
  s.noteOff(trackId, pitch, 'computer');
}

const reset = () =>
  patchRuntime({ muteAll: false, stalled: null, playing: false, paused: false, mode: 'live', replayId: null, songCursor: 0, songLoop: null, songLooping: false, notice: null, recording: 'off', recordTarget: null, countingIn: false, held: {}, tracks: {}, recordStartsAtTick: null, recordTargetAudible: true, songRecording: null });

beforeEach(async () => {
  await deleteDb();
  uiStore.setState({ ...defaultUiState() });
  reset();
  takes.length = 0;
});

afterEach(async () => {
  for (const s of live) s.dispose();
  live = [];
  reset();
  await deleteDb();
});

describe('a song clip in the song', () => {
  it('the export plays it where its region is, like a pad clip', async () => {
    const p = emptyProject(120);
    // Bar 1: a pad clip holds a low A (110 Hz). Bars 3–4: a song clip holds a high A (880 Hz) each bar. Bar 2: nothing.
    track(p, 't4').clips[0] = clip('pad', 1, [[0, 45, 288]]);
    const song = clip('song', 1, [[0, 69, 288]]);
    track(p, 't4').songClips = [song];
    p.arrangement = {
      tailSeconds: 0.5,
      sections: [],
      regions: [
        { id: 'a', trackId: 't4', clipId: track(p, 't4').clips[0]!.id, start: 0, bars: 1, offset: 0 },
        { id: 'b', trackId: 't4', clipId: song.id, start: 2, bars: 2, offset: 0 },
      ],
    };
    const bank = new SampleBank(SR);
    const buf = await renderOffline({ project: p, source: { kind: 'song' }, sampleRate: SR, tailSeconds: 0.5, createEngine: (ctx) => AudioEngine.create(ctx, { samples: bank, seed: p.seed, meters: false }) });
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    const mono = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) mono[i] = 0.5 * (L[i] + R[i]);
    const win = (bar: number, from: number, to: number) => mono.subarray(Math.round((RENDER_START_OFFSET + bar * 2 + from) * SR), Math.round((RENDER_START_OFFSET + bar * 2 + to) * SR));
    const high = (x: Float32Array) => bandEnergy(x, SR, 800, 960);
    const [b1, b2, b3, b4] = [win(0, 0.2, 1.4), win(1, 0.8, 1.9), win(2, 0.2, 1.4), win(3, 0.2, 1.4)];
    expect(rms(b1)).toBeGreaterThan(0.005);
    expect(rms(b2)).toBeLessThan(rms(b1) * 0.01);
    expect(rms(b3)).toBeGreaterThan(0.005);
    expect(high(b3)).toBeGreaterThan(high(b1) * 4);
    expect(high(b4)).toBeGreaterThan(high(b1) * 4);
    // The whole song is 4 bars (8 s) plus the tail.
    expect(buf.duration).toBeGreaterThan(8);
  });

  it('the song plays its notes on its song slot; an edit to them while it plays is heard from then on', async () => {
    const p = emptyProject(240);
    const song = clip('song', 1, [[0, 60, 48], [192, 62, 48]]);
    track(p, 't1').songClips = [song];
    p.arrangement.regions = [{ id: 'r', trackId: 't1', clipId: song.id, start: 0, bars: 8, offset: 0 }];
    const s = await started(p);
    const all = tapNotes(s);
    await s.playSong();
    await until(() => (rt().tracks.t1?.playingSlot ?? null) === songSlot(0), 'the song clip playing');
    await until(() => s.transport!.getPosition().tick > 2 * BAR + 40, 'bar 3');
    const editTick = s.transport!.getPosition().tick;
    s.store.apply('notes:Test', (d) => void (track(d, 't1').songClips![0].notes[1].pitch = 67));
    await until(() => s.transport!.getPosition().tick > 5 * BAR, 'bar 6');
    s.stop();
    const notes = heard(all, 't1');
    expect(notes.filter(([t]) => t < 2 * BAR)).toEqual([[0, 60], [192, 62], [BAR, 60], [BAR + 192, 62]]);
    // A bar after the edit, only the new note plays.
    const after = notes.filter(([t]) => t >= Math.ceil(editTick / BAR) * BAR + BAR && t < 5 * BAR);
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter(([, pitch]) => pitch === 62)).toEqual([]);
    expect(after.filter(([, pitch]) => pitch === 67).length).toBeGreaterThan(0);
  });
});

describe('Record in the Song view (recording into the song)', () => {
  it('plays the song from its cursor and on past its end; songRecording grows; Stop hands the take over, held notes ended at the stop', async () => {
    const p = emptyProject(240);
    // A one-bar song on t1; t4 records.
    const song = clip('song', 1, [[0, 60, 48]]);
    track(p, 't1').songClips = [song];
    p.arrangement.regions = [{ id: 'r', trackId: 't1', clipId: song.id, start: 2, bars: 1, offset: 0 }];
    p.settings.countIn = false;
    p.settings.recordQuantize = 'off';
    // The keys played are the notes recorded (no Musical Assist snapping).
    p.assist = false;
    const s = await started(p);
    selectTrack('t4');
    s.setSongCursor(2);
    await s.toggleRecordNotes({ song: true });
    expect(rt()).toMatchObject({ playing: true, mode: 'song', recording: 'notes', songRecording: { trackId: 't4', startBar: 2, bars: 1 } });
    expect(s.sequencer!.songPasses()![0].from).toBe(2 * BAR);
    const start = 2 * BAR;
    await holdFromTo(s, 't4', 60, start + 96, start + 192);
    // Past the song's end (bar 3): it plays on.
    await holdFromTo(s, 't4', 64, start + BAR + 96, start + BAR + 288);
    await until(() => (rt().songRecording?.bars ?? 0) >= 3, 'the third bar');
    expect(rt().playing).toBe(true);
    // A key still held when recording stops.
    const ctx = s.ctx!;
    s.noteOn('t4', 67, 0.9, 'computer');
    await sleep(120);
    await s.toggleRecordNotes();
    s.noteOff('t4', 67, 'computer');
    expect(rt()).toMatchObject({ recording: 'off', songRecording: null });
    expect(takes).toHaveLength(1);
    const take = takes[0];
    expect(take).toMatchObject({ trackId: 't4', startBar: 2 });
    expect(take.bars).toBeGreaterThanOrEqual(3);
    expect(take.notes.map((n) => n.pitch)).toEqual([60, 64, 67]);
    const [a, b, c] = take.notes;
    // Within a 32nd of where they were played (the session takes the output delay off).
    expect(Math.abs(a.tick - 96)).toBeLessThan(12);
    expect(Math.abs(a.duration - 96)).toBeLessThan(12);
    expect(Math.abs(b.tick - (BAR + 96))).toBeLessThan(12);
    expect(Math.abs(b.duration - 192)).toBeLessThan(12);
    expect(c.tick).toBeGreaterThan(b.tick + b.duration);
    expect(c.duration).toBeGreaterThan(0);
    expect(c.tick + c.duration).toBeLessThanOrEqual(take.bars * BAR);
    expect(rt().notice?.text).toMatch(/^Recorded 3 notes on .* in the song, from bar 3/);
    // The song has its end back: it was past it, so it stops at the next bar line.
    await until(() => !rt().playing, 'the song to end', 4000);
    expect(ctx.state).toBe('running');
  });

  it('with the song playing it records from the next bar line; nothing played says so', async () => {
    const p = emptyProject(240);
    const song = clip('song', 1, [[0, 60, 48]]);
    track(p, 't1').songClips = [song];
    p.arrangement.regions = [{ id: 'r', trackId: 't1', clipId: song.id, start: 0, bars: 16, offset: 0 }];
    const s = await started(p);
    selectTrack('t2');
    await s.playSong();
    await until(() => s.transport!.getPosition().tick > BAR + 100, 'into bar 2');
    await s.toggleRecordNotes({ song: true });
    const startBar = rt().songRecording!.startBar;
    expect(startBar).toBeGreaterThanOrEqual(2);
    // The transport counts down to it.
    expect(rt().recordStartsAtTick).toBe(startBar * BAR);
    await s.toggleRecordNotes();
    expect(takes).toEqual([{ trackId: 't2', startBar, bars: 1, notes: [], quantize: 'off' }]);
    expect(rt().notice?.text).toBe('Nothing was played, so nothing was recorded.');
    // The song plays on (it has its end back).
    expect(rt()).toMatchObject({ playing: true, mode: 'song', recording: 'off', songRecording: null });
    s.stop();
  });

  it('with the count-in on, the song starts a bar early and counts in; Stop during it records nothing', async () => {
    const p = emptyProject(240);
    p.settings.countIn = true;
    const s = await started(p);
    selectTrack('t4');
    s.setSongCursor(5);
    await s.toggleRecordNotes({ song: true });
    expect(rt()).toMatchObject({ countingIn: true, recordStartsAtTick: 5 * BAR, songRecording: { startBar: 5, bars: 1 } });
    expect(s.transport!.getPosition().tick).toBeLessThan(5 * BAR);
    s.stop();
    expect(takes).toEqual([{ trackId: 't4', startBar: 5, bars: 1, notes: [], quantize: 'off' }]);
    expect(rt()).toMatchObject({ playing: false, songCursor: 5, songRecording: null });
  });
});
