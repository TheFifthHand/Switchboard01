/**
 * Session hooks of the core slice, with real Web Audio:
 * - brace(): scheduling a second ahead before heavy main-thread work; a view
 *   or mode switch braces by itself (perf-01);
 * - readMetersShared(): one engine read per animation frame for every view (perf-03);
 * - versions before bulk edits (capability-06): autosaver.snapshotBefore with
 *   the state before the edit, at most once per kind of edit every 2 minutes;
 * - the project a starter replaced, in runtime.starterReplaced;
 * - chord pads (NoteSource 'chord') skip Musical Assist but are recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { getStarter } from '../../src/content/starters';
import type { Project } from '../../src/project/types';
import type { Autosaver } from '../../src/persistence/autosave';
import { deleteDb } from '../../src/persistence/db';
import * as cmd from '../../src/state/commands';
import { defaultUiState, setPadMode, setUiMode, setView, uiStore } from '../../src/state/uiStore';
import { BRACE_AHEAD, DEFAULT_LOOKAHEAD } from '../../src/time/transport';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rt = () => runtimeStore.getState();
const house = (): Project => getStarter('house')!.build();

let live: Session[] = [];
beforeEach(async () => {
  await deleteDb();
  uiStore.setState({ ...defaultUiState() });
  patchRuntime({ playing: false, paused: false, mode: 'live', stalled: null, notice: null, starterReplaced: null });
});
afterEach(async () => {
  for (const s of live) s.dispose();
  live = [];
  patchRuntime({ playing: false, paused: false, mode: 'live', stalled: null, notice: null });
  await deleteDb();
});

function session(p: Project = house()): Session {
  const s = new Session(p);
  live.push(s);
  return s;
}

describe('brace (perf-01)', () => {
  it('audio start braces; brace() and a view, pad-mode, Simple/Advanced or cables switch brace the transport at once', async () => {
    const s = session();
    expect(await s.startAudio()).toBe(true);
    await s.launchScene(1);
    // Audio start braces for its first seconds: a second is scheduled ahead.
    expect(s.transport!.getStats().ahead).toBe(BRACE_AHEAD);
    const brace = vi.spyOn(s.transport!, 'brace');
    setView('mix');
    setPadMode('steps');
    setUiMode('advanced');
    uiStore.setState((u) => ({ ...u, cablesOpen: !u.cablesOpen }));
    // Not for other UI changes.
    uiStore.setState((u) => ({ ...u, keyboardOctave: u.keyboardOctave + 1 }));
    s.brace();
    expect(brace).toHaveBeenCalledTimes(5);
    expect(brace).toHaveBeenLastCalledWith(BRACE_AHEAD, 3000);
    // Whatever is braced, the plain look-ahead is the floor.
    expect(s.transport!.getStats().ahead).toBeGreaterThanOrEqual(DEFAULT_LOOKAHEAD);
    s.stop();
  });
});

describe('readMetersShared (perf-03)', () => {
  it('one frame object for every reader in an animation frame, read again in the next; null before audio starts', async () => {
    const s = session();
    expect(s.readMetersShared()).toBeNull();
    expect(await s.startAudio()).toBe(true);
    const reads = vi.spyOn(s.engine!, 'readMeters');
    await new Promise((r) => requestAnimationFrame(r));
    const a = s.readMetersShared();
    const b = s.readMetersShared();
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(reads).toHaveBeenCalledTimes(1);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    s.readMetersShared();
    expect(reads).toHaveBeenCalledTimes(2);
    // A long frame is still one frame: readers late in it share the read.
    const inFrame = await new Promise<boolean>((resolve) =>
      requestAnimationFrame(() => {
        const first = s.readMetersShared();
        const until = performance.now() + 20;
        while (performance.now() < until) {
          /* a busy view */
        }
        resolve(s.readMetersShared() === first);
      }),
    );
    expect(inFrame).toBe(true);
    expect(reads).toHaveBeenCalledTimes(3);
  });
});

describe('versions before bulk edits (capability-06)', () => {
  function fakeAutosaver(s: Session) {
    const snapshotBefore = vi.fn(async (_p: Project, _reason: string) => {});
    const real = s.autosaver;
    s.autosaver = { ...(real ?? {}), snapshotBefore, flush: async () => {}, markSaved: () => {}, dispose: async () => {} } as unknown as Autosaver;
    return snapshotBefore;
  }

  it('keeps the state before a Variation, Delete clip or Delete scene, once per kind every 2 minutes; not for small edits, undo or redo', () => {
    const s = session();
    const snap = fakeAutosaver(s);
    const before = s.store.getState();
    expect(s.accepted(cmd.applyVariation(s.store, 't4', 1, 7))).toBe(true);
    expect(snap).toHaveBeenCalledTimes(1);
    expect(snap.mock.calls[0][0]).toBe(before);
    expect(snap.mock.calls[0][1]).toMatch(/^Variation/);
    // The same kind again within 2 minutes: none.
    expect(s.accepted(cmd.applyVariation(s.store, 't4', 1, 8))).toBe(true);
    expect(snap).toHaveBeenCalledTimes(1);
    // A small edit, an undo, a redo: none.
    s.setBpm(121);
    s.undo();
    s.redo();
    expect(snap).toHaveBeenCalledTimes(1);
    const beforeDelete = s.store.getState();
    expect(s.accepted(cmd.deleteClip(s.store, 't3', 1))).toBe(true);
    expect(snap).toHaveBeenCalledTimes(2);
    expect(snap.mock.calls[1]).toEqual([beforeDelete, 'Delete clip']);
  });
});

describe('runtime.starterReplaced', () => {
  it('names the project a new starter took the place of on screen', async () => {
    const s = session();
    await s.boot();
    // The first starter replaces the preview (nothing stored): none.
    await s.newFromStarter('house');
    expect(rt().starterReplaced ?? null).toBeNull();
    const first = s.store.getState();
    await s.newFromStarter('techno');
    expect(rt().starterReplaced).toEqual({ id: first.id, name: first.name });
  });
});

describe("chord pads (NoteSource 'chord')", () => {
  it('play the chord as given (no Musical Assist), and a take records them', async () => {
    const s = session();
    expect(await s.startAudio()).toBe(true);
    const p = s.store.getState();
    expect(p.assist).toBe(true);
    const on = vi.spyOn(s.engine!, 'liveNoteOn');
    // A note outside the scale: kept as it is from a chord pad, snapped from the keyboard.
    const outside = Array.from({ length: 12 }, (_, i) => 60 + i).find((m) => cmd && !inScale(m, p.root, p.scale))!;
    s.noteOn('t4', outside, 0.8, 'chord');
    expect(on.mock.calls.at(-1)![1]).toBe(outside);
    s.noteOff('t4', outside, 'chord');
    s.noteOn('t4', outside, 0.8, 'keyboard');
    expect(on.mock.calls.at(-1)![1]).not.toBe(outside);
    s.noteOff('t4', outside, 'keyboard');
    // Recorded into a performance take like keys.
    await s.togglePerformance();
    s.noteOn('t4', outside, 0.8, 'chord');
    await sleep(100);
    s.noteOff('t4', outside, 'chord');
    await sleep(500);
    await s.togglePerformance();
    const take = s.store.getState().performances.at(-1)!;
    expect(take.events.some((e) => e.type === 'noteOn' && e.pitch === outside)).toBe(true);
    s.stop();
  });
});

function inScale(m: number, root: number, scale: string): boolean {
  const steps: Record<string, number[]> = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
  };
  return (steps[scale] ?? steps.major).includes((((m - root) % 12) + 12) % 12);
}
