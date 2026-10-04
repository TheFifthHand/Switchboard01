/**
 * Variable scene count (PLAY-10, capability-08) while music plays: inserting,
 * copying and deleting scene rows (and undoing or redoing that) keeps every
 * part on the clip it plays and on the clip selected for editing; a clip
 * deleted with its row stops its part (nothing else plays in its place). The
 * song keeps playing its scenes. Scene launches stay within the project's rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { getStarter } from '../../src/content/starters';
import { createClip, createProject } from '../../src/project/factory';
import type { Id, Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { defaultUiState, selectSlot, uiStore } from '../../src/state/uiStore';

const BAR = 384;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rt = () => runtimeStore.getState();

async function until(fn: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** 4 scenes at 200 BPM; t1 has a 1-bar clip in every row, pitch = 40 + row, one note per beat. */
function project(): Project {
  const p = createProject({ bpm: 200, now: 0 });
  p.seed = 2;
  for (const t of p.tracks) {
    t.clips = t.clips.map(() => null);
    t.macros.space = 0;
    t.macros.echo = 0;
  }
  const t1 = p.tracks[0];
  for (let row = 0; row < 4; row++) t1.clips[row] = createClip(`r${row}`, 1, [0, 96, 192, 288].map((tick) => ({ tick, pitch: row, velocity: 0.8, duration: 24 })));
  // No song: deleting a scene the song plays takes its loops with it.
  p.arrangement = { ...p.arrangement, regions: [], sections: [] };
  return p;
}

let live: Session[] = [];
beforeEach(() => {
  uiStore.setState({ ...defaultUiState() });
  patchRuntime({ playing: false, paused: false, mode: 'live', stalled: null, songCursor: 0, tracks: {} });
});
afterEach(() => {
  for (const s of live) s.dispose();
  live = [];
  patchRuntime({ playing: false, paused: false, mode: 'live', stalled: null, tracks: {} });
});

/** A started session; notes it schedules and does not cancel are recorded (tick, pitch) per part. */
async function started(p: Project) {
  const s = new Session(p);
  live.push(s);
  expect(await s.startAudio()).toBe(true);
  const all: { tick: number; trackId: Id; pitch: number; cancelled: boolean }[] = [];
  const engine = s.engine!;
  const schedule = engine.scheduleNote.bind(engine);
  engine.scheduleNote = (trackId, n) => {
    const entry = { tick: Math.round(s.sequencer!.tickAt(n.time)), trackId, pitch: n.pitch, cancelled: false };
    all.push(entry);
    const h = schedule(trackId, n);
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
  const heard = (trackId: Id, from: number, to = Infinity) => all.filter((n) => !n.cancelled && n.trackId === trackId && n.tick > from && n.tick < to);
  return { s, heard };
}

const tick = (s: Session) => s.transport!.getPosition().tick;
const t1 = (s: Session) => s.store.getState().tracks[0];

describe('scene rows inserted, copied and deleted while the pads play', () => {
  it('insert above, undo, redo, copy, delete another row: the part plays on in the same clip, its pad and selection follow it', async () => {
    const { s, heard } = await started(project());
    await s.launchScene(2);
    selectSlot('t1', 2);
    await until(() => tick(s) > BAR + 40, 'bar 2');
    const playing = t1(s).clips[2]!.id;

    expect(s.accepted(cmd.insertScene(s.store, 0))).toBe(true);
    expect(t1(s).clips[3]!.id).toBe(playing);
    expect(rt().tracks.t1?.playingSlot).toBe(3);
    expect(s.sequencer!.getTrackState('t1').playing?.slot).toBe(3);
    expect(uiStore.getState().selectedSlot.t1).toBe(3);

    s.undo();
    expect(rt().tracks.t1?.playingSlot).toBe(2);
    expect(uiStore.getState().selectedSlot.t1).toBe(2);
    s.redo();
    expect(rt().tracks.t1?.playingSlot).toBe(3);
    expect(uiStore.getState().selectedSlot.t1).toBe(3);

    // A copy of the playing row goes below it: nothing moves.
    expect(s.accepted(cmd.duplicateScene(s.store, 3))).toBe(true);
    expect(rt().tracks.t1?.playingSlot).toBe(3);
    expect(s.store.getState().scenes).toHaveLength(6);
    // Deleting the (empty) inserted row moves everything up one.
    expect(s.accepted(cmd.deleteScene(s.store, 0))).toBe(true);
    expect(rt().tracks.t1?.playingSlot).toBe(2);
    expect(uiStore.getState().selectedSlot.t1).toBe(2);
    const editTick = tick(s);
    await until(() => tick(s) > editTick + 2 * BAR, 'two bars on');
    s.stop();
    // Only the playing clip's notes (pitch 2) were heard through every edit.
    expect(new Set(heard('t1', BAR).map((n) => n.pitch))).toEqual(new Set([2]));
  });

  it('deleting the row of the playing clip stops the part (the clip that moves into its pad does not start); the selection stays in range', async () => {
    const { s, heard } = await started(project());
    await s.launchScene(3);
    selectSlot('t1', 3);
    await until(() => tick(s) > BAR + 40, 'bar 2');
    expect(s.accepted(cmd.deleteScene(s.store, 3))).toBe(true);
    const editTick = tick(s);
    expect(s.store.getState().scenes).toHaveLength(3);
    expect(uiStore.getState().selectedSlot.t1).toBe(2);
    await until(() => tick(s) > editTick + 2 * BAR, 'two bars on');
    expect(rt().tracks.t1?.playingSlot ?? null).toBeNull();
    s.stop();
    // Nothing after the edit point (a moment after it, for what had already started).
    expect(heard('t1', editTick + 40)).toEqual([]);
  });

  it('a row deleted under another part’s playing clip: that part stops; a scene launch past the last row does nothing', async () => {
    const { s } = await started(project());
    await s.launchScene(1);
    await until(() => tick(s) > 40, 'bar 1');
    expect(s.accepted(cmd.deleteScene(s.store, 0))).toBe(true);
    expect(rt().tracks.t1?.playingSlot).toBe(0);
    await s.launchScene(7);
    expect(rt().tracks.t1?.queued ?? null).toBeNull();
    s.stop();
  });
});

describe('scene rows inserted while the song plays', () => {
  it('the song keeps playing the same clips: its loops name clips, not rows', async () => {
    const p = project();
    // Each row's clip over two bars, in row order.
    p.arrangement = { tailSeconds: 0, sections: [], regions: [0, 1, 2, 3].map((row) => ({ id: `r${row}`, trackId: 't1', clipId: p.tracks[0].clips[row]!.id, start: 2 * row, bars: 2, offset: 0 })) };
    const { s, heard } = await started(p);
    await s.playSong({ fromBar: 2 });
    await until(() => tick(s) > 2 * BAR + 40, 'row 1’s loop');
    expect(s.accepted(cmd.insertScene(s.store, 0))).toBe(true);
    const editTick = tick(s);
    await until(() => tick(s) > 4 * BAR + 40, 'row 2’s loop');
    s.undo();
    await until(() => tick(s) > 5 * BAR + 40, 'row 2’s loop, later');
    s.stop();
    // Row 1's clip (pitch 1) then row 2's (pitch 2), whatever the row indices became.
    const got = heard('t1', editTick + 40, 5 * BAR + 40);
    expect(got.filter((n) => n.tick < 4 * BAR).every((n) => n.pitch === 1)).toBe(true);
    expect(got.filter((n) => n.tick >= 4 * BAR).every((n) => n.pitch === 2)).toBe(true);
    expect(got.length).toBeGreaterThan(4);
  });
});

describe('chosen slots through scene edits, Undo and Redo (play review)', () => {
  it('insert, copy and delete a row, each undone and redone: every part is back on the slot it had (Groove stays Groove)', () => {
    // House: Intro, Groove, Lift, Break. No audio: the selections follow the project by themselves.
    const s = new Session(getStarter('house')!.build());
    live.push(s);
    const chosen = (): Record<Id, number | undefined> => Object.fromEntries(s.store.getState().tracks.map((t) => [t.id, uiStore.getState().selectedSlot[t.id]]));
    // t1–t4 on Groove (the row deleted below), t5 on Intro, t6 on Lift, t7 on Break; t8 has none chosen.
    for (const id of ['t1', 't2', 't3', 't4']) selectSlot(id, 1);
    selectSlot('t5', 0);
    selectSlot('t6', 2);
    selectSlot('t7', 3);
    const start = chosen();
    expect(start.t8).toBeUndefined();
    const sceneOf = (id: Id) => s.store.getState().scenes[uiStore.getState().selectedSlot[id]!]?.name;

    const steps: [string, () => boolean, Record<Id, number | undefined>][] = [
      // A row above all of them: each moves down one, on the same clip.
      ['insert', () => s.accepted(cmd.insertScene(s.store, 0)), { ...start, t1: 2, t2: 2, t3: 2, t4: 2, t5: 1, t6: 3, t7: 4 }],
      // A copy of Groove goes below it: Groove's parts stay, those below move down.
      ['copy', () => s.accepted(cmd.duplicateScene(s.store, 1)), { ...start, t6: 3, t7: 4 }],
      // Groove deleted: its parts go to the row now there (Lift), the others stay on their clips.
      ['delete', () => s.accepted(cmd.deleteScene(s.store, 1)), { ...start, t1: 1, t2: 1, t3: 1, t4: 1, t6: 1, t7: 2 }],
    ];
    for (const [what, edit, after] of steps) {
      expect(edit(), what).toBe(true);
      expect(chosen(), `${what}`).toEqual(after);
      s.undo();
      expect(chosen(), `${what}, undone`).toEqual(start);
      for (const id of ['t1', 't2', 't3', 't4']) expect(sceneOf(id), `${what}, undone: ${id}`).toBe('Groove');
      s.redo();
      expect(chosen(), `${what}, redone`).toEqual(after);
      s.undo();
      expect(chosen(), `${what}, undone again`).toEqual(start);
    }
    // A part given another slot after the step keeps it through the Undo (on its clip).
    expect(s.accepted(cmd.deleteScene(s.store, 1))).toBe(true);
    selectSlot('t1', 2);
    s.undo();
    expect(uiStore.getState().selectedSlot.t1).toBe(3);
    expect(uiStore.getState().selectedSlot.t2).toBe(1);
  });
});
