/**
 * Longer clips (capability-07): 1 to 8 bars, Double up to 8, Repeat to a
 * length so a longer loop keeps playing (PLAY-22), and replacing a clip's
 * notes in one named step (Variation's "Back to original", PLAY-16).
 */
import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/project/factory';
import { MAX_CLIP_BARS, type Note } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';
import { createClip, duplicateClipContent, isClipBars, repeatClipToBars, setClipBars, setClipNotes } from '../../src/state/commands/clips';
import { starterGainStaging } from '../../src/content/starters/dsl';

const n = (tick: number, pitch = 60): Omit<Note, 'id'> => ({ tick, pitch, velocity: 0.8, duration: 24 });

function withClip(bars: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, ticks: number[]) {
  const store = new ProjectStore(createProject({ now: 0 }));
  createClip(store, 't4', 0, bars, 'Line');
  store.apply('notes:Write', (d) => {
    d.tracks[3].clips[0]!.notes = ticks.map((t, i) => ({ id: `n${i}`, ...n(t) }));
  });
  return store;
}
const ticksOf = (store: ProjectStore) => store.getState().tracks[3].clips[0]!.notes.map((x) => x.tick).sort((a, b) => a - b);

describe('clips of 1 to 8 bars', () => {
  it('can be made and set to any length from 1 to 8 bars; 9 is refused with a plain reason', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].every(isClipBars)).toBe(true);
    expect([0, 9, 2.5].some(isClipBars)).toBe(false);
    const store = new ProjectStore(createProject({ now: 0 }));
    expect(createClip(store, 't1', 0, 8).changed).toBe(true);
    expect(createClip(store, 't1', 1, 9 as never)).toMatchObject({ changed: false, message: 'Clips are 1 to 8 bars.' });
    expect(setClipBars(store, 't1', 0, 6).changed).toBe(true);
    expect(setClipBars(store, 't1', 0, 9 as never)).toMatchObject({ changed: false, message: 'Clips are 1 to 8 bars.' });
    // A slot the part does not have is refused.
    expect(createClip(store, 't1', 5, 1).changed).toBe(false);
  });

  it('Double repeats a clip up to 8 bars', () => {
    const store = withClip(4, [0, 400]);
    duplicateClipContent(store, 't4', 0);
    expect(store.getState().tracks[3].clips[0]!.bars).toBe(8);
    expect(ticksOf(store)).toEqual([0, 400, 1536, 1936]);
    expect(duplicateClipContent(store, 't4', 0)).toMatchObject({ changed: false, reason: 'limit', message: `Clips can be at most ${MAX_CLIP_BARS} bars long.` });
  });
});

describe('repeat a clip to a length (PLAY-22)', () => {
  it('repeats the bars in turn (3 bars to 8: 1 2 3 1 2 3 1 2), in one undo step', () => {
    const store = withClip(3, [0, 384 + 96, 768 + 300]);
    const before = store.getState();
    expect(repeatClipToBars(store, 't4', 0, 8).changed).toBe(true);
    const c = store.getState().tracks[3].clips[0]!;
    expect(c.bars).toBe(8);
    expect(ticksOf(store)).toEqual([0, 480, 1068, 1152, 1632, 2220, 2304, 2784]);
    expect(new Set(c.notes.map((x) => x.id)).size).toBe(c.notes.length);
    expect(store.undoLabel()).toBe('Repeat clip to 8 bars');
    const r = validateProject(JSON.parse(JSON.stringify(store.getState())));
    expect(r.ok && r.warnings).toEqual([]);
    store.undo();
    expect(store.getState().tracks).toEqual(before.tracks);
  });

  it('leaves the same length alone and refuses a shorter one', () => {
    const store = withClip(4, [0]);
    expect(repeatClipToBars(store, 't4', 0, 4)).toEqual({ changed: false });
    expect(repeatClipToBars(store, 't4', 0, 2)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(repeatClipToBars(store, 't4', 1, 8)).toMatchObject({ changed: false, reason: 'not-found' });
  });
});

describe('replace a clip’s notes in one named step (PLAY-16)', () => {
  it('puts the original notes back as "Back to original" and can clear the Variation information', () => {
    const store = withClip(2, [0, 96, 192]);
    const original = store.getState().tracks[3].clips[0]!.notes;
    store.apply('notes:Vary', (d) => {
      const c = d.tracks[3].clips[0]!;
      c.notes = [{ id: 'x', ...n(48, 63) }];
      c.variation = { seed: 7, generation: 3 };
    });
    const r = setClipNotes(store, 't4', 0, original, 'Back to original', { variation: null });
    expect(r.changed).toBe(true);
    expect(store.undoLabel()).toBe('Back to original');
    const c = store.getState().tracks[3].clips[0]!;
    expect(c.notes).toEqual(original);
    expect(c.variation).toBeUndefined();
    store.undo();
    expect(store.getState().tracks[3].clips[0]!.variation).toEqual({ seed: 7, generation: 3 });
  });

  it('leaves out notes outside the clip or the part’s range, and refuses a missing clip or name', () => {
    const store = withClip(1, [0]);
    setClipNotes(store, 't4', 0, [{ id: 'a', ...n(0) }, { id: 'b', ...n(400) }, { id: 'c', ...n(10, 300) }] as Note[], 'Edit notes');
    expect(ticksOf(store)).toEqual([0]);
    expect(setClipNotes(store, 't4', 2, [], 'Edit')).toMatchObject({ changed: false, reason: 'not-found' });
    expect(setClipNotes(store, 't4', 0, [], '  ')).toMatchObject({ changed: false, reason: 'invalid' });
  });
});

describe('starter gain staging (MIX-12)', () => {
  it('puts the overall level on the faders, the master at 0 dB, and only what a fader cannot take on the master', () => {
    expect(starterGainStaging(5, [-3, -20.5, -2])).toEqual({ channelLiftDb: 5, masterDb: 0 });
    expect(starterGainStaging(-3, [-3, -10])).toEqual({ channelLiftDb: -3, masterDb: 0 });
    // The loudest fader (-2 dB) can rise 8 dB to +6: the other 2 dB stay on the master.
    expect(starterGainStaging(10, [-2, -8])).toEqual({ channelLiftDb: 8, masterDb: 2 });
  });
});
