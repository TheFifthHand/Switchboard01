import { describe, expect, it } from 'vitest';
import { clipAtSlot, clipById, isClipSlot, isSongSlot, slotOfClip, songSlot, trackClips } from '../../src/project/clips';
import { MIGRATIONS, runMigrations } from '../../src/project/migrate';
import { regionClip } from '../../src/project/arrangement';
import type { Clip, Track } from '../../src/project/types';

const clip = (id: string): Clip => ({ id, name: id, bars: 1, notes: [] });
const track = { id: 't', clips: [clip('a'), null, clip('b'), null], songClips: [clip('s0'), clip('s1')] } as unknown as Track;

describe('song clips: slots', () => {
  it('pad rows and song slots both find their clip', () => {
    expect(clipAtSlot(track, 0)?.id).toBe('a');
    expect(clipAtSlot(track, 1)).toBeNull();
    expect(clipAtSlot(track, songSlot(1))?.id).toBe('s1');
    expect(clipAtSlot(track, songSlot(2))).toBeNull();
    expect(clipAtSlot(track, -1)).toBeNull();
    expect(isSongSlot(songSlot(0))).toBe(true);
    expect(isSongSlot(3)).toBe(false);
    expect(isClipSlot(track, 1)).toBe(true);
    expect(isClipSlot(track, 4)).toBe(false);
    expect(isClipSlot(track, songSlot(1))).toBe(true);
    expect(isClipSlot(track, songSlot(2))).toBe(false);
    expect(slotOfClip(track, 'b')).toBe(2);
    expect(slotOfClip(track, 's0')).toBe(songSlot(0));
    expect(slotOfClip(track, 'zz')).toBe(-1);
    expect(clipById(track, 's1')?.id).toBe('s1');
    expect(trackClips(track).map((c) => [c.clip.id, c.inSong])).toEqual([['a', false], ['b', false], ['s0', true], ['s1', true]]);
  });

  it('a song region finds a song clip', () => {
    const hit = regionClip({ tracks: [track] }, { trackId: 't', clipId: 's1' });
    expect(hit?.slot).toBe(songSlot(1));
    expect(hit?.clip.id).toBe('s1');
  });

  it('the step to version 5 changes nothing', () => {
    const data = { schema: 'switchboard01.project', version: 4, tracks: [], arrangement: { regions: [], sections: [], tailSeconds: 2 } };
    const r = runMigrations(structuredClone(data), MIGRATIONS, 5);
    expect(r.ok).toBe(true);
    if (r.ok) expect({ ...r.data, version: 4 }).toEqual(data);
  });
});
