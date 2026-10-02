/**
 * The song loop across edits that split its last block and across undo and
 * redo:
 *  - Split, Build up, Strip down, Breakdown on the loop's last block (and
 *    undoing a join, or redoing any of them): the new blocks of its scene
 *    right after it stay in the loop, so the whole block keeps looping. A
 *    block of the same scene pasted or duplicated after an unchanged last
 *    block stays outside.
 *  - An edit that shrank or cleared the loop (an end block deleted): Undo
 *    brings the loop back with its blocks, Redo shrinks it again, unless the
 *    loop was changed by hand in between.
 *  - While the song plays: a helper on a looped block that plays its second
 *    pass continues in the block the lane shows and loops the whole build.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';
import { SongLoopHistory, songLoopAfterEdit, songLoopBlockIds } from '../../src/time/songLoop';
import { makeClip, setClip } from './sequencer-fixtures';
import { BEAT, Rig, fixture } from './song-live-rig';

/** The fixture with b1 (row 1: drums, percussion every beat, chords) playing 4 passes, [768, 3840). */
function fourPasses(): Project {
  let p = fixture();
  p = setClip(p, 't2', 1, makeClip(2, Array.from({ length: 8 }, (_, i) => [i * BEAT, 90, 24] as [number, number, number]), 'perc'));
  p.arrangement.blocks[1].repeats = 4;
  return p;
}

/** A store and the loop following its changes as the session does. */
class LoopRig {
  readonly store: ProjectStore;
  readonly history = new SongLoopHistory();
  loop: { fromBlockId: string; toBlockId: string } | null;

  constructor(p: Project, from: string, to = from) {
    this.store = new ProjectStore(p);
    this.loop = { fromBlockId: from, toBlockId: to };
    this.store.subscribe((next, prev) => {
      this.loop = this.history.follow(this.loop, prev, next, this.store.lastChange());
    });
  }

  get ids(): string[] {
    return songLoopBlockIds(this.store.getState(), this.loop);
  }
}

describe('the loop keeps a block a helper split (F3)', () => {
  for (const kind of ['build', 'strip'] as const) {
    it(`${kind === 'build' ? 'Build up' : 'Strip down'} on a one-block loop: the loop covers every block made; Undo → the block; Redo → every block again`, () => {
      const r = new LoopRig(fourPasses(), 'b1');
      const made = cmd.shapeBlock(r.store, 'b1', kind).blockIds!;
      expect(made.length).toBe(3);
      expect(r.ids).toEqual(made);
      r.store.undo();
      expect(r.ids).toEqual(['b1']);
      r.store.redo();
      expect(r.ids).toEqual(made);
      // Again: undo and redo keep working.
      r.store.undo();
      r.store.redo();
      expect(r.ids).toEqual(made);
    });
  }

  it('songLoopAfterEdit alone: redoing a build on a one-block loop keeps every block in the loop', () => {
    const s = new ProjectStore(fourPasses());
    const loop = { fromBlockId: 'b1', toBlockId: 'b1' };
    const before = s.getState();
    const made = cmd.shapeBlock(s, 'b1', 'build').blockIds!;
    const built = s.getState();
    expect(songLoopBlockIds(built, songLoopAfterEdit(loop, before, built))).toEqual(made);
    s.undo();
    const undone = s.getState();
    const back = songLoopAfterEdit({ fromBlockId: 'b1', toBlockId: made[2] }, built, undone);
    expect(back).toEqual(loop);
    s.redo();
    expect(songLoopBlockIds(s.getState(), songLoopAfterEdit(back, undone, s.getState()))).toEqual(made);
  });

  it('the loop’s last block of a longer loop: the blocks made join it; its first block stays first', () => {
    const r = new LoopRig(fourPasses(), 'b0', 'b1');
    const made = cmd.shapeBlock(r.store, 'b1', 'build').blockIds!;
    expect(r.ids).toEqual(['b0', ...made]);
    expect(r.loop!.fromBlockId).toBe('b0');
  });

  it('Breakdown keeps the loop as it is (one block, same id)', () => {
    const r = new LoopRig(fourPasses(), 'b1');
    const loop = r.loop;
    expect(cmd.shapeBlock(r.store, 'b1', 'breakdown').changed).toBe(true);
    expect(r.loop).toBe(loop);
  });

  it('Split, then Undo, then Redo: both halves in the loop each time it is split', () => {
    const r = new LoopRig(fixture(), 'b1');
    cmd.splitBlock(r.store, 'b1', 1);
    const half = r.store.getState().arrangement.blocks[2].id;
    expect(r.ids).toEqual(['b1', half]);
    r.store.undo();
    expect(r.ids).toEqual(['b1']);
    r.store.redo();
    expect(r.ids).toEqual(['b1', half]);
  });

  it('undoing a join of the loop’s last block with the block after it: both blocks stay in the loop', () => {
    const p = fixture();
    p.arrangement.blocks.splice(2, 0, { id: 'b1b', sceneId: p.scenes[1].id, repeats: 1 });
    const r = new LoopRig(p, 'b1');
    cmd.joinWithNext(r.store, 'b1');
    expect(r.ids).toEqual(['b1']);
    r.store.undo();
    expect(r.ids).toEqual(['b1', 'b1b']);
  });

  it('a block of the same scene pasted or duplicated right after the (unchanged) last block stays outside', () => {
    const p = fixture();
    const loop = { fromBlockId: 'b1', toBlockId: 'b1' };
    const s = new ProjectStore(p);
    cmd.insertBlocks(s, [{ sceneId: p.arrangement.blocks[1].sceneId, repeats: 2 }], 2);
    expect(songLoopAfterEdit(loop, p, s.getState())).toBe(loop);
    const d = new ProjectStore(p);
    cmd.duplicateBlocks(d, ['b1']);
    expect(d.getState().arrangement.blocks.length).toBe(5);
    expect(songLoopAfterEdit(loop, p, d.getState())).toBe(loop);
  });
});

describe('Undo brings back a loop an edit shrank or cleared', () => {
  it('the loop’s last block deleted: shrinks; Undo → the old loop; Redo → shrinks again', () => {
    const r = new LoopRig(fixture(), 'b1', 'b2');
    cmd.removeBlocks(r.store, ['b2']);
    expect(r.ids).toEqual(['b1']);
    r.store.undo();
    expect(r.loop).toEqual({ fromBlockId: 'b1', toBlockId: 'b2' });
    r.store.redo();
    expect(r.loop).toEqual({ fromBlockId: 'b1', toBlockId: 'b1' });
    r.store.undo();
    expect(r.ids).toEqual(['b1', 'b2']);
  });

  it('every block of the loop deleted: cleared; Undo → the old loop (either way round as it was given)', () => {
    const r = new LoopRig(fixture(), 'b2', 'b1');
    cmd.removeBlocks(r.store, ['b1', 'b2']);
    expect(r.loop).toBeNull();
    r.store.undo();
    expect(r.loop).toEqual({ fromBlockId: 'b2', toBlockId: 'b1' });
  });

  it('undoing the newer of two shrinking edits, then the older: each brings back what it took', () => {
    const r = new LoopRig(fixture(), 'b0', 'b3');
    cmd.removeBlocks(r.store, ['b3']);
    cmd.removeBlocks(r.store, ['b0']);
    expect(r.ids).toEqual(['b1', 'b2']);
    r.store.undo();
    expect(r.loop).toEqual({ fromBlockId: 'b0', toBlockId: 'b2' });
    r.store.undo();
    expect(r.loop).toEqual({ fromBlockId: 'b0', toBlockId: 'b3' });
  });

  it('the loop changed by hand after the edit: Undo leaves the new loop alone', () => {
    const r = new LoopRig(fixture(), 'b1', 'b2');
    cmd.removeBlocks(r.store, ['b2']);
    r.loop = { fromBlockId: 'b0', toBlockId: 'b0' };
    r.store.undo();
    expect(r.loop).toEqual({ fromBlockId: 'b0', toBlockId: 'b0' });
  });

  it('an edit that did not change the loop: Undo follows the usual rules (a deletion undone does not widen it)', () => {
    const r = new LoopRig(fixture(), 'b1', 'b2');
    cmd.renameBlock(r.store, 'b3', 'Outro');
    const loop = r.loop;
    r.store.undo();
    expect(r.loop).toBe(loop);
  });

  it('a block the loop ends on, added by an earlier edit: Undo of that edit shrinks the loop, Redo brings it back', () => {
    const p = fixture();
    const s = new ProjectStore(p);
    const h = new SongLoopHistory();
    let loop: { fromBlockId: string; toBlockId: string } | null = null;
    s.subscribe((n, prev) => (loop = h.follow(loop, prev, n, s.lastChange())));
    const id = cmd.insertBlocks(s, [{ sceneId: p.scenes[2].id, repeats: 1 }], 4).blockIds![0];
    // The loop set by hand afterwards, ending on the new block.
    loop = { fromBlockId: 'b2', toBlockId: id };
    s.undo();
    expect(loop).toEqual({ fromBlockId: 'b2', toBlockId: 'b3' });
    s.redo();
    expect(loop).toEqual({ fromBlockId: 'b2', toBlockId: id });
    s.undo();
    expect(loop).toEqual({ fromBlockId: 'b2', toBlockId: 'b3' });
  });

  it('another project clears what it remembers', () => {
    const h = new SongLoopHistory();
    const s = new ProjectStore(fixture());
    let loop: { fromBlockId: string; toBlockId: string } | null = { fromBlockId: 'b1', toBlockId: 'b2' };
    s.subscribe((n, p) => (loop = h.follow(loop, p, n, s.lastChange())));
    cmd.removeBlocks(s, ['b2']);
    h.clear();
    s.undo();
    expect(loop).toEqual({ fromBlockId: 'b1', toBlockId: 'b1' });
  });
});

describe('while the song loops', () => {
  it('Build up on a looped block playing its second pass: continues where the lane has the playhead and loops the whole build', () => {
    const r = new Rig(fourPasses()).setLoop('b1').playSong();
    r.to(2000);
    let ids: string[] = [];
    r.edit((s) => {
      ids = cmd.shapeBlock(s, 'b1', 'build').blockIds!;
    });
    expect(songLoopBlockIds(r.project, r.loop)).toEqual(ids);
    r.to(2000 + 3072 + 800);
    // Percussion plays on through the edit (the block under the playhead has it); drums come back with the
    // full block at 2304; after it the loop starts again at b1.
    expect(r.notes('t2').filter(([t]) => t > 2000 && t < 2304).map(([t]) => t)).toEqual([2016, 2112, 2208]);
    expect(r.blocks().map(([t, , id]) => [t, id]).slice(0, 4)).toEqual([[768, 'b1'], [2304, ids[2]], [3840, 'b1'], [4608, ids[1]]]);
    // b1 is chords only now: no drums in its next pass.
    expect(r.notes('t1').filter(([t]) => t >= 3840 && t < 4608)).toEqual([]);
  });

  it('Undo of a deletion that shrank the loop while it plays: the loop is whole again, playback goes on into it (no jump)', () => {
    const r = new Rig().setLoop('b1', 'b2').playSong().to(1000);
    r.edit((s) => cmd.removeBlocks(s, ['b2']));
    expect(r.loop).toEqual({ fromBlockId: 'b1', toBlockId: 'b1' });
    r.to(1500);
    r.edit((s) => s.undo());
    expect(r.loop).toEqual({ fromBlockId: 'b1', toBlockId: 'b2' });
    r.to(2304 + 768 + 1536 + 100);
    // b1 plays on to its end, then b2, then the loop again from b1.
    expect(r.blocks().map(([t, , id]) => [t, id])).toEqual([[768, 'b1'], [2304, 'b2'], [3072, 'b1'], [4608, 'b2']]);
  });
});
