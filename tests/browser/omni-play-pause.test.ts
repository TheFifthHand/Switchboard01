/**
 * Pause and Resume with the real engine and transport in Chromium: Pause
 * holds the bar and beat and every playing clip's phase, releases every
 * voice and held note, and Play continues from exactly there, in time, with
 * no backlog; Stop returns to bar 1 with the pads armed. Song mode resumes in
 * its block. Pause is unavailable while a performance records (and says why);
 * during Record Notes it ends the pass (one undo step). The transport shows
 * the state in words, and Space / Shift+Space play-pause and stop.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/ui/theme.css';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { PAUSE_UNAVAILABLE_MESSAGE, Session } from '../../src/app/session';
import { session as appSession } from '../../src/app/instance';
import { TransportBar } from '../../src/app/views/TransportBar';
import { App } from '../../src/app/App';
import { setGuideDone, setPadMode, setView } from '../../src/state/uiStore';
import { getStarter } from '../../src/content/starters';
import { deleteDb } from '../../src/persistence/db';
import type { Project } from '../../src/project/types';
import { selectSlot, selectTrack } from '../../src/state/uiStore';
import { TipsProvider } from '../../src/ui/components';
import { cleanup, fire, key, mount } from './ui-harness';

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
  // The view is remembered in localStorage, which test files share: start on the Loops pads.
  setView('play');
  setPadMode('loops');
  patchRuntime({ muteAll: false, stalled: null, playing: false, paused: false, mode: 'live', replayId: null, songCursor: 0, recording: 'off', recordTarget: null, notice: null });
});

afterEach(async () => {
  cleanup();
  for (const s of live) s.dispose();
  live = [];
  patchRuntime({ playing: false, paused: false, recording: 'off', recordTarget: null, mode: 'live' });
  await deleteDb();
});

async function until(fn: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

/** The launcher state of every part: slot and loop start (its phase). */
function launcher(s: Session) {
  return s.sequencer!.getLauncherSnapshot().filter((e) => e.playing);
}

describe('Pause', () => {
  it('holds the position and every clip phase, releases every voice, and Play continues from there in time', async () => {
    const s = session();
    await s.play();
    await until(() => s.transport!.getPosition().tick > 500, 'playback to reach the second bar');
    const playing = launcher(s);
    expect(playing.length).toBeGreaterThan(2);

    s.pause();
    expect(rt()).toMatchObject({ playing: false, paused: true, mode: 'live' });
    expect(s.paused).toBe(true);
    const held = s.transport!.getPosition();
    expect(held).toMatchObject({ playing: false, paused: true });
    expect(held.tick).toBeGreaterThan(500);
    // Silent: nothing scheduled, nothing sounding, the ticker idle.
    expect(s.transport!.getStats()).toMatchObject({ pendingHandles: 0, soundingHandles: 0, tickerRunning: false });
    // The position holds while paused (the audio clock moves on).
    const ctxTime = s.ctx!.currentTime;
    await sleep(400);
    expect(s.ctx!.currentTime).toBeGreaterThan(ctxTime + 0.2);
    expect(s.transport!.getPosition().tick).toBe(held.tick);
    // Every part keeps its clip and loop start: the same phase on Play.
    expect(launcher(s)).toEqual(playing);

    await s.play();
    expect(rt()).toMatchObject({ playing: true, paused: false, mode: 'live' });
    expect(launcher(s)).toEqual(playing);
    // It continues from the held tick (not bar 1), and the clock moves on from there in time.
    const t0 = s.ctx!.currentTime;
    const p0 = s.transport!.getPosition().tick;
    expect(p0).toBeGreaterThanOrEqual(held.tick - 1e-6);
    expect(p0).toBeLessThan(held.tick + 40);
    await sleep(500);
    const ticksPerSecond = (s.store.getState().bpm * 96) / 60;
    const moved = s.transport!.getPosition().tick - held.tick;
    const expected = (s.ctx!.currentTime - t0 - 0.05) * ticksPerSecond;
    expect(Math.abs(moved - expected)).toBeLessThan(ticksPerSecond * 0.06);
    // No backlog: nothing was scheduled in the past.
    expect(s.transport!.getStats().pendingHandles).toBeGreaterThanOrEqual(0);
  });

  it('Stop from a pause returns to bar 1 with the clips that were playing armed', async () => {
    const s = session();
    await s.play();
    await until(() => s.transport!.getPosition().tick > 300, 'playback');
    const parts = launcher(s).map((e) => [e.trackId, e.playing!.slot]);
    s.pause();
    s.stop();
    expect(rt()).toMatchObject({ playing: false, paused: false });
    expect(s.transport!.getPosition()).toMatchObject({ tick: 0, bar: 0, beat: 0, playing: false, paused: false });
    expect(launcher(s).map((e) => [e.trackId, e.playing!.slot])).toEqual(parts);
    for (const [trackId, slot] of parts) expect(rt().tracks[trackId as string]?.playingSlot).toBe(slot);
    await s.play();
    expect(s.transport!.getPosition().tick).toBeLessThan(40);
  });

  it('releases held notes on pause', async () => {
    const s = session();
    await s.play();
    s.noteOn('t4', 60, 0.8, 'keyboard');
    expect(rt().held.t4).toHaveLength(1);
    s.pause();
    expect(rt().held.t4 ?? []).toHaveLength(0);
    expect(s.stats().held).toBe(0);
  });

  it('in song mode Play continues the song from the same bar and beat', async () => {
    const s = session();
    await s.playSong({ fromBar: 4 });
    await until(() => s.transport!.getPosition().tick > 4 * 384, 'the song');
    const start = s.sequencer!.getPosition(s.ctx!.currentTime).tick;
    await sleep(300);
    s.pause();
    const held = s.transport!.getPosition().tick;
    expect(held).toBeGreaterThan(start);
    const bar = s.sequencer!.songBarAt(held)!;
    expect(rt()).toMatchObject({ playing: false, paused: true, mode: 'song' });
    await s.play();
    expect(rt()).toMatchObject({ playing: true, paused: false, mode: 'song' });
    expect(s.sequencer!.mode.kind).toBe('song');
    expect(s.transport!.getPosition().tick).toBeGreaterThanOrEqual(held - 1e-6);
    expect(s.sequencer!.songBarAt(s.transport!.getPosition().tick)!).toBeGreaterThanOrEqual(bar - 1e-6);
  });

  it('is unavailable while a performance records, and says why; Stop ends the take', async () => {
    const s = session();
    await s.play();
    await s.togglePerformance();
    expect(rt().recording).toBe('performance');
    await s.togglePlay();
    expect(rt()).toMatchObject({ playing: true, paused: false, recording: 'performance' });
    expect(rt().notice?.text).toBe(PAUSE_UNAVAILABLE_MESSAGE);
    // Long enough to keep (takes under 0.5 s are dropped): wait on the audio clock, not wall time.
    const t0 = s.ctx!.currentTime;
    await until(() => s.ctx!.currentTime - t0 > 1, 'a second of audio');
    s.stop();
    expect(rt().recording).toBe('off');
    expect(s.store.getState().performances).toHaveLength(1);
  });

  it('during Record Notes, Pause ends the pass (one undo step) and pauses', async () => {
    const s = session();
    s.store.replace({ ...house(), settings: { ...house().settings, countIn: false } });
    // Record into the Chords part's playing clip.
    selectTrack('t4');
    await s.play();
    const playingSlot = rt().tracks.t4?.playingSlot;
    expect(playingSlot).not.toBeNull();
    selectSlot('t4', playingSlot!);
    const undoBefore = s.store.historySize().undo;
    await s.toggleRecordNotes();
    expect(rt().recording).toBe('notes');
    const target = rt().recordTarget!;
    await until(() => rt().tracks[target.trackId]?.playingSlot === target.slot, 'the recorded clip to play');
    for (const pitch of [91, 95]) {
      s.noteOn(target.trackId, pitch, 0.9, 'keyboard');
      await sleep(120);
      s.noteOff(target.trackId, pitch, 'keyboard');
    }
    s.pause();
    expect(rt()).toMatchObject({ recording: 'off', paused: true, playing: false });
    expect(s.recordingNotes).toBe(false);
    expect(s.store.historySize().undo, `${rt().notice?.text}`).toBe(undoBefore + 1);
    expect(s.store.undoLabel()).toBe('Record notes');
  });
});

describe('Transport keys', () => {
  beforeEach(() => {
    appSession.store.replace(house(), { resetHistory: true });
  });

  function bar() {
    return mount(h(TipsProvider, { enabled: true, children: h(TransportBar, { onOpenLibrary: () => {}, onOpenExport: () => {} }) }), { width: 1366 });
  }
  const button = (root: ParentNode, name: string | RegExp) =>
    [...root.querySelectorAll<HTMLButtonElement>('button:not([role])')].find((b) => {
      const n = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
      return typeof name === 'string' ? n === name : name.test(n);
    })!;

  it('one Play / Pause key and a Stop key, with the state in words', () => {
    const m = bar();
    const word = () => m.container.querySelector('[role="status"]')!.textContent;
    const timer = () => m.container.querySelector('[role="timer"]')!.textContent;
    expect(button(m.container, 'Play').getAttribute('aria-keyshortcuts')).toBe('Space');
    expect(button(m.container, 'Stop').getAttribute('aria-keyshortcuts')).toBe('Shift+Space');
    expect(button(m.container, 'Stop').disabled).toBe(true);
    expect(word()).toBe('Stopped');
    expect(timer()).toBe('1.1');
    act(() => patchRuntime({ playing: true, mode: 'live' }));
    expect(button(m.container, 'Pause')).toBeTruthy();
    expect(button(m.container, 'Stop').disabled).toBe(false);
    expect(word()).toBe('Playing');
    act(() => patchRuntime({ mode: 'song' }));
    expect(word()).toBe('Song');
    act(() => patchRuntime({ mode: 'replay' }));
    expect(word()).toBe('Replay');
    act(() => patchRuntime({ playing: false, paused: true, mode: 'live' }));
    expect(button(m.container, 'Play')).toBeTruthy();
    expect(word()).toBe('Paused');
    // While a performance records, Pause says why it is unavailable.
    act(() => patchRuntime({ playing: true, paused: false, recording: 'performance' }));
    const pause = button(m.container, 'Pause');
    expect(pause.getAttribute('aria-disabled')).toBe('true');
    act(() => pause.focus());
    const tip = document.getElementById(pause.getAttribute('aria-describedby') ?? '')?.textContent ?? document.querySelector('[role="tooltip"]')?.textContent ?? '';
    expect(tip).toContain('not available while a performance records');
    fire(pause, new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(rt().notice?.text).toBe(PAUSE_UNAVAILABLE_MESSAGE);
  });
});

describe('Space and Shift+Space', () => {
  it('Space plays and pauses, Shift+Space stops; on a focused key Space presses that key instead', async () => {
    act(() => setGuideDone(true));
    const real = { togglePlay: appSession.togglePlay, stop: appSession.stop };
    const calls: string[] = [];
    appSession.togglePlay = async () => void calls.push('play/pause');
    appSession.stop = () => void calls.push('stop');
    try {
      const m = mount(h(App, { boot: { lastProject: null, warnings: [], storageError: null } }));
      const look = [...m.container.querySelectorAll('button')].find((b) => b.textContent === 'Just look around');
      if (look) fire(look, new MouseEvent('click', { bubbles: true }));
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      key(document.body, 'keydown', { key: ' ', code: 'Space' });
      key(document.body, 'keydown', { key: ' ', code: 'Space', shiftKey: true });
      expect(calls).toEqual(['play/pause', 'stop']);
      const mute = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Mute All')!;
      act(() => mute.focus());
      key(mute, 'keydown', { key: ' ', code: 'Space' });
      expect(calls).toEqual(['play/pause', 'stop']);
    } finally {
      appSession.togglePlay = real.togglePlay;
      appSession.stop = real.stop;
    }
  });
});
