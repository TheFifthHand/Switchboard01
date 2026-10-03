/**
 * Song playback follows the lane, in real Chromium:
 *  - an export (offline render with the real engine) of a song with a part
 *    switched off in one block and another scene's part layered into
 *    another has the expected energy in each block;
 *  - with the real session and transport, a song edited while it plays (a
 *    later block moved, the playing block lengthened) sends its block and
 *    launch events at the new ticks and ends at the new end; Resume after a
 *    stall finds the playing block by id after it was moved;
 *  - the transport readout shows the bar of the song timeline as the lane
 *    draws it, also after a block was moved in front of the playing one.
 */
import '../../src/ui/theme.css';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { session as appSession } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { TransportBar } from '../../src/app/views/TransportBar';
import { songTimelineBar } from '../../src/app/songPlayback';
import { createClip, createProject } from '../../src/project/factory';
import type { Clip, ClipBars, Id, Project } from '../../src/project/types';
import { bandEnergy, rms } from '../../src/render/analysis';
import { RENDER_START_OFFSET, computeRenderPlan, renderOffline } from '../../src/render/offline';
import * as cmd from '../../src/state/commands';
import { deleteDb } from '../../src/persistence/db';
import type { SeqEvent } from '../../src/time/contracts';
import { TipsProvider } from '../../src/ui/components';
import { cleanup, mount, wait } from './ui-harness';

const SR = 48000;
const BAR = 384;
const rt = () => runtimeStore.getState();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

function clip(name: string, bars: ClipBars, notes: [tick: number, pitch: number, duration: number][]): Clip {
  return createClip(name, bars, notes.map(([tick, pitch, duration]) => ({ tick, pitch, duration, velocity: 0.9 })));
}

/** No clips anywhere, no reverb or delay sends, fixed seed. */
function emptyProject(bpm: number): Project {
  const p = createProject({ bpm, now: 0 });
  p.seed = 1234;
  for (const t of p.tracks) {
    t.clips = t.clips.map(() => null);
    t.macros.space = 0;
    t.macros.echo = 0;
  }
  return p;
}

const track = (p: Project, id: Id) => p.tracks.find((t) => t.id === id)!;

let live: Session[] = [];

beforeEach(async () => {
  await deleteDb();
  patchRuntime({ muteAll: false, stalled: null, playing: false, paused: false, mode: 'live', replayId: null, songBlock: null, songBlockId: null });
});

afterEach(async () => {
  cleanup();
  for (const s of live) s.dispose();
  live = [];
  if (appSession.playing || appSession.paused) act(() => appSession.stop());
  patchRuntime({ playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null, stalled: null });
  await deleteDb();
});

describe('export of a song with part changes', () => {
  it('a part switched off in a block is silent there; a layered part sounds there; block by block', async () => {
    const p = emptyProject(120);
    // Chords hold a low A (110 Hz) in row 0; the lead holds a high A (880 Hz) in row 1. Notes end after 3/4 bar.
    track(p, 't4').clips[0] = clip('low', 1, [[0, 45, 288]]);
    track(p, 't5').clips[1] = clip('high', 1, [[0, 81, 288]]);
    const [s0, s1] = p.scenes;
    p.arrangement = {
      tailSeconds: 0.5,
      blocks: [
        { id: 'a', sceneId: s0.id, repeats: 1 },
        { id: 'off', sceneId: s0.id, repeats: 1, parts: { t4: null } },
        { id: 'layer', sceneId: s0.id, repeats: 1, parts: { t4: null, t5: s1.id } },
        { id: 'both', sceneId: s0.id, repeats: 1, parts: { t5: s1.id } },
      ],
    };
    expect(computeRenderPlan(p, { kind: 'song' }).musicSeconds).toBeCloseTo(8, 9);
    const bank = new SampleBank(SR);
    const buf = await renderOffline({ project: p, source: { kind: 'song' }, sampleRate: SR, tailSeconds: 0.5, createEngine: (ctx) => AudioEngine.create(ctx, { samples: bank, seed: p.seed, meters: false }) });
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    const mono = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) mono[i] = 0.5 * (L[i] + R[i]);
    // Each block is 2 s; measure while its notes hold (0.2–1.4 s in) and, for the silent one, after the release (0.8–1.9 s).
    const win = (block: number, from: number, to: number) => mono.subarray(Math.round((RENDER_START_OFFSET + block * 2 + from) * SR), Math.round((RENDER_START_OFFSET + block * 2 + to) * SR));
    const low = (x: Float32Array) => bandEnergy(x, SR, 90, 135);
    const high = (x: Float32Array) => bandEnergy(x, SR, 800, 960);
    const a = win(0, 0.2, 1.4);
    const off = win(1, 0.8, 1.9);
    const layer = win(2, 0.2, 1.4);
    const both = win(3, 0.2, 1.4);

    expect(rms(a)).toBeGreaterThan(0.005);
    expect(rms(off)).toBeLessThan(rms(a) * 0.01);
    expect(rms(layer)).toBeGreaterThan(0.005);
    // The layer block has the lead and not the chords; the last block has both.
    expect(low(layer)).toBeLessThan(low(a) * 0.01);
    expect(high(layer)).toBeGreaterThan(high(a) * 4);
    expect(low(both)).toBeGreaterThan(low(a) * 0.5);
    expect(high(both)).toBeGreaterThan(high(layer) * 0.5);
  });
});

/** Four one-bar scenes at 220 BPM; each row's clip on t1 has one note on the bar. Song: b0 b1 b2 b3, one pass each. */
function quickSong(bpm = 220): Project {
  const p = emptyProject(bpm);
  for (let row = 0; row < 4; row++) track(p, 't1').clips[row] = clip(`r${row}`, 1, [[0, 36 + row, 48]]);
  p.arrangement = { tailSeconds: 1, blocks: p.scenes.map((s, i) => ({ id: `b${i}`, sceneId: s.id, repeats: 1 })) };
  return p;
}

function newSession(p: Project): Session {
  const s = new Session(p);
  live.push(s);
  return s;
}

function record(s: Session): SeqEvent[] {
  const got: SeqEvent[] = [];
  s.transport!.on('block', (e) => got.push(e));
  s.transport!.on('launch', (e) => got.push(e));
  s.transport!.on('end', (e) => got.push(e));
  return got;
}

describe('a song edited while it plays (real session and transport)', () => {
  it('a later block moved and the playing block lengthened: block and launch events arrive at the new ticks, the song ends at the new end', async () => {
    const s = newSession(quickSong());
    expect(await s.startAudio()).toBe(true);
    const got = record(s);
    await s.playSong(0);
    await until(() => got.some((e) => e.kind === 'block'), 'the first block');
    // While b0 plays: b3 moves in front of b1, and b0 plays twice.
    cmd.moveBlocks(s.store, ['b3'], 1);
    cmd.setBlockRepeats(s.store, 'b0', 2);
    expect(rt().songBlock).toBe(0);
    await until(() => got.some((e) => e.kind === 'end'), 'the end', 12000);
    const blocks = got.filter((e): e is Extract<SeqEvent, { kind: 'block' }> => e.kind === 'block');
    expect(blocks.map((b) => [b.tick, b.blockIndex, b.blockId])).toEqual([[0, 0, 'b0'], [768, 1, 'b3'], [1152, 2, 'b1'], [1536, 3, 'b2']]);
    const launches = got.filter((e): e is Extract<SeqEvent, { kind: 'launch' }> => e.kind === 'launch' && e.trackId === 't1');
    expect(launches.map((l) => [l.tick, l.slot])).toEqual([[0, 0], [768, 3], [1152, 1], [1536, 2]]);
    expect(got.filter((e) => e.kind === 'end').map((e) => e.tick)).toEqual([1920]);
    // Every event was delivered when its audio time came, in order.
    for (let i = 1; i < got.length; i++) expect(got[i].time).toBeGreaterThanOrEqual(got[i - 1].time);
    await until(() => !rt().playing, 'the stop at the end');
  });

  it('moving blocks in front of the playing one keeps the runtime on that block, at its new index; Resume after a stall finds it by id', async () => {
    const s = newSession(quickSong(60));
    await s.playSong(1);
    await until(() => rt().songBlockId === 'b1' && s.transport!.getPosition().tick > BAR, 'block b1');
    cmd.moveBlocks(s.store, ['b3', 'b2'], 0);
    // Lane: b2 b3 b0 b1 — the playing block is now the fourth.
    expect(rt().songBlock).toBe(3);
    expect(rt().songBlockId).toBe('b1');
    // Undo and Redo are edits like any other.
    s.store.undo();
    expect(rt().songBlock).toBe(1);
    expect(s.sequencer!.songPlan()!.map((b) => b.blockId)).toEqual(['b0', 'b1', 'b2', 'b3']);
    s.store.redo();
    expect(rt().songBlock).toBe(3);
    expect(s.sequencer!.songPlan()!.map((b) => b.blockId)).toEqual(['b2', 'b3', 'b0', 'b1']);
    s.transport!.simulateStall(700);
    await until(() => rt().stalled !== null, 'the stall');
    await s.resumeAfterStall();
    expect(rt()).toMatchObject({ playing: true, mode: 'song', songBlock: 3, songBlockId: 'b1' });
    // It starts again at b1's place on the lane (bar 4).
    expect(s.transport!.getPosition().tick).toBe(3 * BAR);
  });

  it('plays from a bar of the lane: the block containing it starts there, in phase', async () => {
    const p = quickSong(120);
    // b1 plays a 2-bar clip twice, from tick 384: lane bar index 2 (shown as bar 3) is the clip's second bar.
    track(p, 't1').clips[1] = clip('two', 2, [[0, 50, 48], [BAR, 51, 48]]);
    p.arrangement.blocks[1].repeats = 2;
    const s = newSession(p);
    expect(await s.startAudio()).toBe(true);
    const notes: { tick: number; pitch: number }[] = [];
    const got = record(s);
    const engine = s.engine!;
    const schedule = engine.scheduleNote.bind(engine);
    engine.scheduleNote = (trackId, n) => {
      notes.push({ tick: s.sequencer!.tickAt(n.time), pitch: n.pitch });
      return schedule(trackId, n);
    };
    await s.playSong(0, { fromBar: 2 });
    expect(rt()).toMatchObject({ songBlock: 1, songBlockId: 'b1' });
    await until(() => got.some((e) => e.kind === 'block'), 'the block');
    await sleep(300);
    s.stop();
    const first = got.find((e): e is Extract<SeqEvent, { kind: 'block' }> => e.kind === 'block')!;
    expect([first.tick, first.blockId]).toEqual([2 * BAR, 'b1']);
    // The clip is in phase with b1's start: it plays its second note first.
    expect(Math.round(notes[0].tick)).toBe(2 * BAR);
    expect(notes[0].pitch).toBe(51);
  });
});

describe('the transport readout in song mode', () => {
  it('shows the bar of the song timeline as the lane draws it, also after a block moved in front of the playing one', async () => {
    // 40 BPM: one beat is 1.5 s, so the readout holds still while it is read.
    const p = quickSong(40);
    appSession.store.replace(p, { resetHistory: true });
    const m = mount(h(TipsProvider, { enabled: true, children: h(TransportBar, { onOpenLibrary: () => {}, onOpenExport: () => {} }) }), { width: 1366 });
    const timer = () => m.container.querySelector('[role="timer"]')!.textContent;
    await act(async () => {
      await appSession.playSong(1);
    });
    await act(async () => {
      await wait(200);
    });
    // b1 starts at bar 2 of the lane.
    expect(timer()).toBe('2.1');
    expect(songTimelineBar(appSession.transport!.getPosition().tick)).toBeCloseTo(1, 1);
    act(() => void cmd.moveBlocks(appSession.store, ['b3'], 0));
    await act(async () => {
      await wait(150);
    });
    // Lane: b3 b0 b1 b2 — the playing block now starts at bar 3. The transport tick itself did not jump.
    expect(appSession.transport!.getPosition().bar).toBe(1);
    expect(timer()).toBe('3.1');
    expect(rt().songBlock).toBe(2);
    // Paused, it shows the same place.
    act(() => appSession.pause());
    expect(timer()).toBe('3.1');
  });
});
