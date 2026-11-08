/**
 * Round 7 starts, with real Web Audio in Chromium (a Session of its own):
 * - Jump In in Simple lands on the Song screen playing the song, repeating
 *   the starter's main part (House: Groove), audible at once and still
 *   playing after that part's end;
 * - Make a beat from scratch in Simple: a Drums loop of 1 bar at the start of
 *   the song, playing on repeat, on the Song screen (nothing to undo);
 * - opening a project in Simple lands on the home, whatever view it was
 *   left in; Advanced keeps 2.4's starts (the Loops pads; Play › Steps).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MeterFrame } from '../../src/audio/contracts';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { rememberProjectView } from '../../src/app/projectViews';
import { Session, starterMainLoop } from '../../src/app/session';
import { getStarter } from '../../src/content/starters';
import { songBars } from '../../src/project/arrangement';
import { slotOfClip } from '../../src/project/clips';
import { deleteDb } from '../../src/persistence/db';
import type { Project } from '../../src/project/types';
import { setPadMode, setUiMode, setView, uiStore } from '../../src/state/uiStore';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const house = (): Project => getStarter('house')!.build();
const rt = () => runtimeStore.getState();

let live: Session[] = [];
function session(p: Project = house()): Session {
  const s = new Session(p);
  live.push(s);
  return s;
}

beforeEach(async () => {
  await deleteDb();
  setUiMode('simple');
  patchRuntime({ muteAll: false, stalled: null, playing: false, mode: 'live', replayId: null, songCursor: 0, songLoop: null, audio: 'off', audioMessage: null });
});

afterEach(async () => {
  for (const s of live) s.dispose();
  live = [];
  setUiMode('simple');
  patchRuntime({ muteAll: false, stalled: null, playing: false, songLoop: null });
  await deleteDb();
});

async function peakOver(s: Session, ms: number): Promise<number> {
  const frame: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
  let peak = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    s.readMeters(frame);
    peak = Math.max(peak, frame.masterPeakL, frame.masterPeakR);
    await sleep(25);
  }
  return peak;
}

describe('starterMainLoop', () => {
  it('is House’s Groove section; a song with no sections repeats as a whole; an empty song has none', () => {
    const p = house();
    const groove = p.arrangement.sections.filter((x) => x.name === 'Groove').sort((a, b) => a.start - b.start)[0];
    expect(starterMainLoop(p, 1)).toEqual({ fromBar: groove.start, toBar: groove.start + groove.bars });
    const bare = { ...p, arrangement: { ...p.arrangement, sections: [] } };
    expect(starterMainLoop(bare, 1)).toEqual({ fromBar: 0, toBar: songBars(bare) });
    const empty = { ...p, arrangement: { ...p.arrangement, sections: [], regions: [] } };
    expect(starterMainLoop(empty, 1)).toBeNull();
  });
});

describe('Jump In (Simple)', () => {
  it('lands on the Song screen playing the song, repeating Groove, audible at once and still playing past its end', async () => {
    setView('mix');
    const s = session();
    await s.jumpIn();
    expect(uiStore.getState().view).toBe('arrange');
    expect(rt().playing).toBe(true);
    expect(rt().mode).toBe('song');
    const loop = starterMainLoop(s.store.getState(), 1)!;
    expect(rt().songLoop).toEqual(loop);
    expect(rt().songCursor).toBe(loop.fromBar);
    expect(await peakOver(s, 1000)).toBeGreaterThan(0.02);
    // Still the song, still in the loop (it repeats rather than running on to the end).
    expect(rt().playing).toBe(true);
    expect(rt().mode).toBe('song');
    expect(rt().songLooping).toBe(true);
  });
});

describe('Make a beat from scratch (Simple)', () => {
  it('a 1-bar Drums loop at the start of the song, playing on repeat, on the Song screen', async () => {
    setView('play');
    const s = session();
    const beat = await s.beatFromScratch();
    expect(beat).not.toBeNull();
    const p = s.store.getState();
    const drums = p.tracks.find((t) => t.instrument.kind === 'drums')!;
    expect(beat!.trackId).toBe(drums.id);
    const region = p.arrangement.regions.find((r) => r.id === beat!.regionId)!;
    expect(region).toMatchObject({ trackId: drums.id, start: 0, bars: 1 });
    expect(slotOfClip(drums, region.clipId)).toBe(beat!.slot);
    expect(songBars(p)).toBe(1);
    expect(uiStore.getState().view).toBe('arrange');
    expect(uiStore.getState().selectedTrackId).toBe(drums.id);
    expect(rt().playing).toBe(true);
    expect(rt().mode).toBe('song');
    expect(rt().songLoop).toEqual({ fromBar: 0, toBar: 1 });
    // The empty beat is where the project starts: Undo has nothing to take away.
    expect(s.store.info.getState().canUndo).toBe(false);
  });
});

describe('Opening a project', () => {
  it('lands on the Song screen in Simple, whatever view it was left in; Advanced goes back to that view', async () => {
    const a = session();
    await a.newFromStarter('house');
    await a.autosaver?.flush();
    const id = a.store.getState().id;
    await a.newFromStarter('techno');
    await a.autosaver?.flush();
    const other = a.store.getState().id;
    rememberProjectView(id, 'mix');
    setView('shape');
    await a.openProject(id);
    expect(uiStore.getState().view).toBe('arrange');
    setUiMode('advanced');
    rememberProjectView(other, 'mix');
    setView('shape');
    await a.openProject(other);
    expect(uiStore.getState().view).toBe('mix');
  });
});

describe('Advanced keeps 2.4’s starts', () => {
  it('Jump In plays the Groove scene on the Loops pads', async () => {
    setUiMode('advanced');
    setView('arrange');
    setPadMode('steps');
    const s = session();
    await s.jumpIn();
    expect(uiStore.getState().view).toBe('play');
    expect(uiStore.getState().padMode).toBe('loops');
    expect(rt().playing).toBe(true);
    expect(rt().mode).toBe('live');
  });

  it('Make a beat opens Play › Steps on a pad loop', async () => {
    setUiMode('advanced');
    const s = session();
    const beat = await s.beatFromScratch();
    expect(beat?.regionId).toBeUndefined();
    expect(uiStore.getState().view).toBe('play');
    expect(uiStore.getState().padMode).toBe('steps');
    expect(s.store.getState().arrangement.regions.length).toBe(0);
  });
});
