/** Review probe: Record Notes while the song plays marks the loop it writes into (data-recording), also a song loop. */
import { act } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { createClip } from '../../src/project/factory';
import { selectTrack } from '../../src/state/uiStore';
import type { Project } from '../../src/project/types';
import { openSong, project, region, regionEl, resetSong, settle, teardownSong } from './r5-song-helpers';

beforeEach(resetSong);
afterEach(async () => { await act(async () => session.stop()); await teardownSong(); });

async function recordInto(songClip: boolean): Promise<{ target: unknown; marked: boolean }> {
  await openSong(1366, 768, (p: Project) => {
    const b = p.tracks[2];
    let clipId = b.clips.find((c) => c)!.id;
    if (songClip) {
      const c = createClip('Song bass', 4, [{ tick: 0, pitch: 40, velocity: 0.8, duration: 48 }]);
      b.songClips = [c];
      clipId = c.id;
    }
    p.arrangement.regions = [region('B', b.id, clipId, 0, 16)];
    p.arrangement.sections = [];
  });
  const bass = project().tracks[2];
  act(() => selectTrack(bass.id));
  await act(async () => { await session.playSong({ fromBar: 0 }); });
  await settle(400);
  await act(async () => { await session.toggleRecordNotes(); });
  await settle(600);
  const target = runtimeStore.getState().recordTarget;
  const marked = regionEl('B').hasAttribute('data-recording');
  await act(async () => { await session.toggleRecordNotes(); });
  return { target, marked };
}

it('a pad clip loop is marked while Record Notes writes into it', async () => {
  const r = await recordInto(false);
  console.info('[review] pad', JSON.stringify(r));
  expect(r.marked).toBe(true);
}, 60_000);

it('a song loop is marked while Record Notes writes into it', async () => {
  const r = await recordInto(true);
  console.info('[review] song', JSON.stringify(r));
  expect(r.marked).toBe(true);
}, 60_000);
