/**
 * Where a part's loops live (pure: no DOM, no audio).
 *
 * A part has two kinds of clip: pad clips (`track.clips[row]`, one per scene
 * row, played from the pads and the song) and song clips (`track.songClips`,
 * played only by the song). Every API keyed by `(trackId, slot)` addresses
 * both: slots 0..MAX_SCENES-1 are pad rows, slots from SONG_SLOT_BASE on are
 * song clips. Clip ids are unique across both lists.
 */
import { SONG_SLOT_BASE, type Clip, type Id, type Track } from './types';

type ClipHolder = Pick<Track, 'clips' | 'songClips'>;

/** True for a slot number that addresses a song clip. */
export function isSongSlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= SONG_SLOT_BASE;
}

/** The slot number of song clip `index`. */
export function songSlot(index: number): number {
  return SONG_SLOT_BASE + index;
}

/** The clip at a pad row or song slot, or null (empty pad, missing slot). */
export function clipAtSlot(track: ClipHolder, slot: number): Clip | null {
  if (!Number.isInteger(slot) || slot < 0) return null;
  if (isSongSlot(slot)) return track.songClips?.[slot - SONG_SLOT_BASE] ?? null;
  return track.clips[slot] ?? null;
}

/** True for a pad row of this part (empty or not) or an existing song clip. */
export function isClipSlot(track: ClipHolder, slot: number): boolean {
  if (!Number.isInteger(slot) || slot < 0) return false;
  if (isSongSlot(slot)) return clipAtSlot(track, slot) !== null;
  return slot < track.clips.length;
}

/** The slot of the clip with this id (pad row or song slot), or -1. */
export function slotOfClip(track: ClipHolder, clipId: Id): number {
  const row = track.clips.findIndex((c) => c?.id === clipId);
  if (row >= 0) return row;
  const i = track.songClips?.findIndex((c) => c.id === clipId) ?? -1;
  return i >= 0 ? songSlot(i) : -1;
}

/** The clip with this id on this part, pad or song, or null. */
export function clipById(track: ClipHolder, clipId: Id): Clip | null {
  return clipAtSlot(track, slotOfClip(track, clipId));
}

/** Every clip of the part with its slot: pads first (by row), then song clips. */
export function trackClips(track: ClipHolder): { slot: number; clip: Clip; inSong: boolean }[] {
  const out: { slot: number; clip: Clip; inSong: boolean }[] = [];
  track.clips.forEach((clip, slot) => {
    if (clip) out.push({ slot, clip, inSong: false });
  });
  (track.songClips ?? []).forEach((clip, i) => out.push({ slot: songSlot(i), clip, inSong: true }));
  return out;
}
