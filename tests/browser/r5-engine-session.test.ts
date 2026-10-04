/**
 * The song (v4: regions on an absolute timeline) with the real session,
 * transport and engine in Chromium:
 *  - an export of a song with gaps and a region starting into its clip has
 *    the music bar by bar where the regions are, and silence where none is;
 *  - the session's song API: Play from the cursor (or the loop), Stop back to
 *    where playback started, seek while playing, paused or stopped, the
 *    Song view's Play/Space (togglePlay with `song`), the loop and runtime
 *    `songLooping`;
 *  - edits while the song plays are laid out in the edit's own task; launch
 *    events and the end follow them; an edit undone at once changes nothing;
 *    a clip deleted (its regions with it) and brought back by Undo plays on
 *    in phase;
 *  - Resume after a stall continues from the bar where the music stopped;
 *  - the transport readout shows the song's bar and beat, and the view tab
 *    is called Song.
 */
import '../../src/ui/theme.css';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { session as appSession } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { songPlayheadBar } from '../../src/app/songPlayback';
import { TransportBar } from '../../src/app/views/TransportBar';
import { moveRegions, resizeRegions, swapRegionClip } from '../../src/project/arrangement';
import { createClip, createProject } from '../../src/project/factory';
import type { Clip, ClipBars, Id, Project, SongRegion } from '../../src/project/types';
import { bandEnergy, rms } from '../../src/render/analysis';
import { RENDER_START_OFFSET, computeRenderPlan, renderOffline } from '../../src/render/offline';
import { deleteDb } from '../../src/persistence/db';
import { setView } from '../../src/state/uiStore';
import type { SeqEvent } from '../../src/time/contracts';
import { TipsProvider } from '../../src/ui/components';
import { cleanup, mount, wait } from './ui-harness';

const SR = 48000;
const BAR = 384;
const BEAT = 96;
const rt = () => runtimeStore.getState();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const newId = () => `n${++n}`;

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

/** A region of part `trackId` playing its clip in `slot` over bars [start, start + bars), `offset` bars in. */
function region(p: Project, id: Id, trackId: Id, slot: number, start: number, bars: number, offset = 0): SongRegion {
  return { id, trackId, clipId: track(p, trackId).clips[slot]!.id, start, bars, offset };
}

/** No clips anywhere, no reverb or delay sends, fixed seed, an empty song. */
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

/** Four one-bar clips on t1 (a note on the bar, pitch 36 + row); regions r0..r3 play them in order over bars 1–4. */
function quickSong(bpm = 220): Project {
  const p = emptyProject(bpm);
  for (let row = 0; row < 4; row++) track(p, 't1').clips[row] = clip(`r${row}`, 1, [[0, 36 + row, 48]]);
  p.arrangement.regions = [0, 1, 2, 3].map((row) => region(p, `r${row}`, 't1', row, row, 1));
  return p;
}

/** t4 plays a one-bar clip with a note on every beat over bars 1–8, a section "Verse" over them. */
function beatSong(bpm = 120): Project {
  const p = emptyProject(bpm);
  track(p, 't4').clips[0] = clip('beats', 1, [0, 1, 2, 3].map((b) => [b * BEAT, 60 + b, 48]));
  p.arrangement.regions = [region(p, 'beats', 't4', 0, 0, 8)];
  // The section keeps the song 8 bars long while its only loop is gone.
  p.arrangement.sections = [{ id: 'v', name: 'Verse', start: 0, bars: 8 }];
  return p;
}

const reset = () =>
  patchRuntime({ muteAll: false, stalled: null, playing: false, paused: false, mode: 'live', replayId: null, songCursor: 0, songLoop: null, songLooping: false, notice: null, recording: 'off' });

let live: Session[] = [];
async function started(p: Project): Promise<Session> {
  const s = new Session(p);
  live.push(s);
  expect(await s.startAudio()).toBe(true);
  return s;
}

/** Launch and end events of a session's transport, as delivered (when their audio time comes). */
function record(s: Session): SeqEvent[] {
  const got: SeqEvent[] = [];
  s.transport!.on('launch', (e) => got.push(e));
  s.transport!.on('end', (e) => got.push(e));
  return got;
}

/**
 * Every note the engine is given and does not cancel, with its transport tick: what is heard. Notes
 * scheduled ahead (up to a second while the transport is braced) and cancelled by an edit or a pause
 * before they start never sound, so they are left out.
 */
function tapNotes(s: Session): { trackId: Id; tick: number; pitch: number }[] {
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
  return new Proxy([] as { trackId: Id; tick: number; pitch: number }[], {
    get: (_t, k) => {
      const heard = all.filter((x) => !x.cancelled).map(({ trackId, tick, pitch }) => ({ trackId, tick, pitch }));
      if (k === 'length') return heard.length;
      const v = (heard as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? v.bind(heard) : v;
    },
    set: (_t, k, v) => {
      // `notes.length = 0`: forget what was heard so far.
      if (k === 'length' && v === 0) all.length = 0;
      return true;
    },
  });
}

const tick = (s: Session) => s.transport!.getPosition().tick;
/** The song bar playback started at (its first pass), read right after a start. */
const startBar = (s: Session) => s.sequencer!.songPasses()![0].from / BAR;
const songBar = (s: Session) => s.sequencer!.songBarAt(s.transport!.audibleTick());
const launchesOf = (got: SeqEvent[], trackId: Id) => got.filter((e): e is Extract<SeqEvent, { kind: 'launch' }> => e.kind === 'launch' && e.trackId === trackId).map((l) => [l.tick, l.slot]);

beforeEach(async () => {
  await deleteDb();
  reset();
});

afterEach(async () => {
  cleanup();
  for (const s of live) {
    s.setSongLoop(null);
    s.dispose();
  }
  live = [];
  if (appSession.playing || appSession.paused) act(() => appSession.stop());
  appSession.setSongLoop(null);
  reset();
  await deleteDb();
});

describe('an export of a song with gaps and a region that starts into its clip', () => {
  it('has the music bar by bar where the regions are, silence where none is', async () => {
    const p = emptyProject(120);
    // Chords hold a low A (110 Hz) on bar 1 and a high A (880 Hz) on bar 2 of one 2-bar clip; notes end after 3/4 bar.
    track(p, 't4').clips[0] = clip('two', 2, [[0, 45, 288], [BAR, 69, 288]]);
    // Bar 1 plays the clip from its start, bar 2 nothing, bars 3–4 from its second bar (offset 1): high, then low.
    p.arrangement = { tailSeconds: 0.5, sections: [], regions: [region(p, 'a', 't4', 0, 0, 1), region(p, 'b', 't4', 0, 2, 2, 1)] };
    expect(computeRenderPlan(p, { kind: 'song' }).musicSeconds).toBeCloseTo(8, 9);
    const bank = new SampleBank(SR);
    const buf = await renderOffline({ project: p, source: { kind: 'song' }, sampleRate: SR, tailSeconds: 0.5, createEngine: (ctx) => AudioEngine.create(ctx, { samples: bank, seed: p.seed, meters: false }) });
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    const mono = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) mono[i] = 0.5 * (L[i] + R[i]);
    // Each bar is 2 s; measure while its notes hold (0.2–1.4 s in) and, for the silent one, after the release (0.8–1.9 s).
    const win = (bar: number, from: number, to: number) => mono.subarray(Math.round((RENDER_START_OFFSET + bar * 2 + from) * SR), Math.round((RENDER_START_OFFSET + bar * 2 + to) * SR));
    const low = (x: Float32Array) => bandEnergy(x, SR, 90, 135);
    const high = (x: Float32Array) => bandEnergy(x, SR, 800, 960);
    const [b1, b2, b3, b4] = [win(0, 0.2, 1.4), win(1, 0.8, 1.9), win(2, 0.2, 1.4), win(3, 0.2, 1.4)];
    expect(rms(b1)).toBeGreaterThan(0.005);
    expect(rms(b2)).toBeLessThan(rms(b1) * 0.01);
    // Bar 3 starts one bar into the clip: the high note; bar 4 wraps to the clip's start: the low one.
    expect(high(b3)).toBeGreaterThan(high(b1) * 4);
    expect(low(b3)).toBeLessThan(low(b1) * 0.1);
    expect(low(b4)).toBeGreaterThan(low(b1) * 0.5);
    expect(high(b4)).toBeLessThan(high(b3) * 0.1);
  });
});

describe('playing the song (session API)', () => {
  it('Play starts at the cursor; Stop puts the cursor back where playback started, so Play plays the same part again', async () => {
    const s = await started(quickSong(220));
    s.setSongCursor(2);
    expect(rt().songCursor).toBe(2);
    await s.playSong();
    expect(rt()).toMatchObject({ playing: true, mode: 'song', songCursor: 2 });
    expect(startBar(s)).toBe(2);
    expect(songBar(s)).toBeGreaterThanOrEqual(2);
    expect(songBar(s)).toBeLessThan(2.5);
    await until(() => tick(s) > 3 * BAR + 40, 'bar 4');
    expect(songBar(s)).toBeGreaterThan(3);
    s.stop();
    expect(rt()).toMatchObject({ playing: false, mode: 'live', songCursor: 2 });
    await s.playSong();
    expect(startBar(s)).toBe(2);
    // Whole bars from 0, inside the song's range.
    s.stop();
    s.setSongCursor(-3);
    expect(rt().songCursor).toBe(0);
    s.setSongCursor(2.7);
    expect(rt().songCursor).toBe(2);
  });

  it('the song ends by itself and Stop puts the cursor back; from past the end Play plays from the top; an empty song says so', async () => {
    const s = await started(quickSong(220));
    const got = record(s);
    await s.playSong({ fromBar: 3 });
    await until(() => got.some((e) => e.kind === 'end'), 'the end');
    await until(() => !rt().playing, 'the stop at the end');
    expect(got.filter((e) => e.kind === 'end').map((e) => e.tick)).toEqual([4 * BAR]);
    expect(rt().songCursor).toBe(3);
    s.setSongCursor(6);
    await s.playSong();
    expect(startBar(s)).toBe(0);
    expect(rt().songCursor).toBe(0);
    s.stop();
    const e = await started(emptyProject(120));
    await e.playSong();
    expect(rt().playing).toBe(false);
    expect(rt().notice?.text).toBe('The song is empty. Drag a scene or a loop onto its rows first.');
  });

  it('seek: playing, it continues from that bar at once; paused, it stays paused there and Play goes on from it; stopped, it sets the cursor', async () => {
    const s = await started(quickSong(60));
    const notes = tapNotes(s);
    await s.playSong({ fromBar: 0 });
    await until(() => tick(s) > 40, 'bar 1');
    s.seekSong(2);
    expect(rt()).toMatchObject({ playing: true, mode: 'song', songCursor: 2 });
    expect(startBar(s)).toBe(2);
    await until(() => tick(s) > 2 * BAR + 40, 'bar 3');
    s.pause();
    expect(rt()).toMatchObject({ paused: true, mode: 'song' });
    s.seekSong(1);
    expect(rt()).toMatchObject({ playing: false, paused: true, mode: 'song', songCursor: 1 });
    expect(songBar(s)).toBe(1);
    notes.length = 0;
    await s.play();
    expect(rt()).toMatchObject({ playing: true, paused: false, mode: 'song' });
    await until(() => tick(s) > BAR + 40, 'bar 2 again');
    expect(notes.find((x) => x.trackId === 't1')).toEqual({ trackId: 't1', tick: BAR, pitch: 37 });
    s.stop();
    // Stop comes back to the bar sought last.
    expect(rt().songCursor).toBe(1);
    s.seekSong(3);
    expect(rt()).toMatchObject({ playing: false, songCursor: 3 });
  });

  it('with a loop set, Play starts at the loop when the cursor lies outside it, else at the cursor; looping is true inside it', async () => {
    const s = await started(quickSong(240));
    expect(s.setSongLoop({ fromBar: 3, toBar: 3 })).toBe(false);
    expect(rt().songLoop).toBeNull();
    expect(s.setSongLoop({ fromBar: 1, toBar: 3 })).toBe(true);
    expect(rt().songLoop).toEqual({ fromBar: 1, toBar: 3 });
    await s.playSong();
    expect(startBar(s)).toBe(1);
    expect(rt().songLooping).toBe(true);
    // Three bars later it is still inside the loop (bars 2–3), on its second pass.
    await until(() => tick(s) > 4 * BAR, 'the second pass');
    expect(songBar(s)).toBeGreaterThanOrEqual(1);
    expect(songBar(s)).toBeLessThan(3);
    expect(rt().songLooping).toBe(true);
    s.stop();
    expect(rt()).toMatchObject({ songCursor: 1, songLooping: false });
    s.setSongCursor(2);
    await s.playSong();
    expect(startBar(s)).toBe(2);
  });

  it('togglePlay in the Song view: Pause, then Play goes on where it paused; with an empty song it plays the pads', async () => {
    const s = await started(quickSong(120));
    await s.togglePlay({ song: true });
    expect(rt()).toMatchObject({ playing: true, mode: 'song' });
    await until(() => tick(s) > BAR + 100, 'bar 2');
    await s.togglePlay({ song: true });
    expect(rt()).toMatchObject({ playing: false, paused: true, mode: 'song' });
    const at = tick(s);
    // From the Play view too (togglePlay without song): the song continues.
    await s.togglePlay();
    expect(rt()).toMatchObject({ playing: true, paused: false, mode: 'song' });
    expect(Math.abs(tick(s) - at)).toBeLessThan(BEAT);
    s.stop();
    const empty = await started(emptyProject(120));
    patchRuntime({ notice: null });
    await empty.togglePlay({ song: true });
    expect(rt()).toMatchObject({ playing: true, mode: 'live' });
    expect(rt().notice).toBeNull();
  });
});

describe('edits while the song plays (real session)', () => {
  it('a region moved and one lengthened: launches arrive at the new ticks, the song ends at the new end', async () => {
    const s = await started(quickSong(220));
    const got = record(s);
    await s.playSong({ fromBar: 0 });
    await until(() => got.length > 0, 'the first launch');
    // While bar 1 plays: r3 moves to bar 5, r0 grows over bar 2 (r1 gives way).
    s.store.apply('arrange:Move', (d) => void (d.arrangement.regions = moveRegions(d.arrangement.regions.length ? s.store.getState() : s.store.getState(), s.store.getState().arrangement.regions, ['r3'], 1, { newId }).regions));
    s.store.apply('arrange:Lengthen', (d) => void (d.arrangement.regions = resizeRegions(s.store.getState(), s.store.getState().arrangement.regions, ['r0'], 'end', 1, newId).regions));
    await until(() => got.some((e) => e.kind === 'end'), 'the end', 15000);
    expect(launchesOf(got, 't1')).toEqual([[0, 0], [768, 2], [1152, null], [1536, 3]]);
    expect(got.filter((e) => e.kind === 'end').map((e) => e.tick)).toEqual([1920]);
    // Every event was delivered when its audio time came, in order.
    for (let i = 1; i < got.length; i++) expect(got[i].time).toBeGreaterThanOrEqual(got[i - 1].time);
    await until(() => !rt().playing, 'the stop at the end');
  });

  it('each edit is laid out in its own task (what plays next is current at once, one replan per edit); undone at once, nothing changed', async () => {
    // 60 BPM: bar 1 lasts 4 s, so everything below happens inside it.
    const s = await started(quickSong(60));
    await s.playSong({ fromBar: 0 });
    await until(() => tick(s) > 20, 'bar 1');
    const t = s.transport!;
    const replan = t.replanSong.bind(t);
    let replans = 0;
    t.replanSong = () => {
      replans++;
      return replan();
    };
    const queued = () => s.sequencer!.getTrackState('t1').queued;
    expect(queued()).toEqual({ slot: 1, atTick: BAR });
    s.store.apply('arrange:Swap', (d) => void (d.arrangement.regions = swapRegionClip(s.store.getState().arrangement.regions, 'r1', track(s.store.getState(), 't1').clips[3]!.id)));
    expect(queued()).toEqual({ slot: 3, atTick: BAR });
    expect(replans).toBe(1);
    s.store.undo();
    expect(queued()).toEqual({ slot: 1, atTick: BAR });
    expect(replans).toBe(2);
    // An edit that changes nothing the song plays (a section's name) lays nothing out again.
    s.store.apply('arrange:Section', (d) => void (d.arrangement.sections = [{ id: 'x', name: 'Intro', start: 0, bars: 4 }]));
    s.store.apply('arrange:Rename', (d) => void (d.arrangement.sections[0].name = 'Verse'));
    expect(replans).toBe(2);
    expect(rt()).toMatchObject({ playing: true, mode: 'song' });
  });

  it('a clip deleted while it plays (its regions with it): silent at once; Undo brings it straight back, in phase', async () => {
    const s = await started(beatSong(120));
    const notes = tapNotes(s);
    await s.playSong({ fromBar: 0 });
    await until(() => tick(s) > BAR + 40, 'bar 2');
    const editTick = tick(s);
    const id = track(s.store.getState(), 't4').clips[0]!.id;
    s.store.apply('clip:Delete', (d) => {
      track(d, 't4').clips[0] = null;
      d.arrangement.regions = d.arrangement.regions.filter((r) => r.clipId !== id);
    });
    await until(() => rt().tracks.t4?.playingSlot === null, 'the part to stop');
    await until(() => tick(s) > editTick + BAR, 'a bar later');
    const undoTick = tick(s);
    s.store.undo();
    await until(() => tick(s) > 5 * BAR + 40, 'bar 6');
    s.stop();
    const t4 = notes.filter((x) => x.trackId === 't4').map((x) => x.tick);
    expect(t4.filter((x) => x > editTick + 30 && x < undoTick)).toEqual([]);
    const beatsIn = (from: number, to: number) => Array.from({ length: 64 }, (_, i) => i * BEAT).filter((x) => x >= from && x <= to);
    expect(t4.filter((x) => x > undoTick + 30 && x <= 5 * BAR)).toEqual(beatsIn(undoTick + 31, 5 * BAR));
  });

  it('while paused: an edit, then Play: the edited song plays from the pause point', async () => {
    const s = await started(quickSong(120));
    const got = record(s);
    await s.playSong({ fromBar: 0 });
    await until(() => tick(s) > 100 && got.length > 0, 'bar 1');
    s.pause();
    s.store.apply('arrange:Swap', (d) => void (d.arrangement.regions = swapRegionClip(s.store.getState().arrangement.regions, 'r1', track(s.store.getState(), 't1').clips[3]!.id)));
    await s.play();
    await until(() => tick(s) > BAR + 40, 'bar 2');
    expect(launchesOf(got, 't1')).toEqual([[0, 0], [BAR, 3]]);
  });
});

describe('a stall in the song', () => {
  it('Resume continues from the bar where the music stopped; meanwhile the cursor is back where playback started', async () => {
    const s = await started(quickSong(60));
    await s.playSong({ fromBar: 1 });
    await until(() => tick(s) > 2 * BAR + 40, 'bar 3');
    s.transport!.simulateStall(700);
    await until(() => rt().stalled !== null, 'the stall');
    expect(rt()).toMatchObject({ playing: false, mode: 'live', songCursor: 1 });
    await s.resumeAfterStall();
    expect(rt()).toMatchObject({ playing: true, mode: 'song' });
    expect(startBar(s)).toBe(2);
  });
});

describe('the transport in song mode', () => {
  it('the readout shows the song’s bar and beat (also after a seek and across a loop seam); stopped in the Song view, the cursor', async () => {
    // 40 BPM: one beat is 1.5 s, so the readout holds still while it is read.
    appSession.store.replace(quickSong(40), { resetHistory: true });
    act(() => setView('arrange'));
    const m = mount(h(TipsProvider, { enabled: true, children: h(TransportBar, { onOpenLibrary: () => {}, onOpenExport: () => {} }) }), { width: 1366 });
    const timer = () => m.container.querySelector('[role="timer"]')!.textContent;
    act(() => appSession.setSongCursor(3));
    expect(timer()).toBe('4.1');
    await act(async () => {
      await appSession.playSong({ fromBar: 1 });
    });
    await act(async () => {
      await wait(200);
    });
    expect(timer()).toBe('2.1');
    expect(songPlayheadBar()).toBeGreaterThanOrEqual(1);
    expect(songPlayheadBar()).toBeLessThan(1.25);
    act(() => appSession.seekSong(3));
    await act(async () => {
      await wait(200);
    });
    expect(timer()).toBe('4.1');
    act(() => appSession.pause());
    expect(timer()).toBe('4.1');
    // The view tab is called Song.
    const tab = [...m.container.querySelectorAll('button')].find((b) => b.textContent === 'Song');
    expect(tab).toBeDefined();
    act(() => appSession.stop());
    // Stopped in the Song view: back at the bar sought last.
    expect(timer()).toBe('4.1');
    act(() => setView('play'));
  });
});
