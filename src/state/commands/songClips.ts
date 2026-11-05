/**
 * Loops that live in the song (schema v5 song clips, see project/clips.ts).
 *
 * ROUND-6 SCAFFOLD: signatures only, implemented by the song-clips model slice.
 * Contract: /tmp/claude-0/r6/briefs/SONG_CLIPS.md.
 */
import type { ClipBars, Id, Note, Project } from '../../project/types';
import type { ProjectStore } from '../projectStore';
import type { CommandResult } from './common';

/** A loop to put in the song: a library loop, a new empty loop or a recorded take's piece. */
export interface NewLoop {
  name?: string;
  bars: ClipBars;
  notes?: Omit<Note, 'id'>[];
}

/** A take recorded in the Song view: notes timed from the start bar (ticks), over `bars` bars. */
export interface SongTake {
  trackId: Id;
  startBar: number;
  bars: number;
  notes: Omit<Note, 'id'>[];
}

const todo = (): never => {
  throw new Error('songClips: not implemented yet');
};

/** A new song clip and a region of its length at `atBar` (placed like any region: it wins). */
export function addLoopToSong(
  _store: ProjectStore,
  _trackId: Id,
  _atBar: number,
  _loop: NewLoop,
  _opts?: { display?: string },
): CommandResult & { clipId?: Id; slot?: number; regionId?: Id } {
  return todo();
}

/** Copy the region's loop into a new song clip that only this region plays. */
export function makeLoopUnique(_store: ProjectStore, _regionId: Id): CommandResult & { clipId?: Id; slot?: number } {
  return todo();
}

/** A copy of a song clip on the part's first free pad (or `row`). */
export function copyLoopToPad(_store: ProjectStore, _trackId: Id, _slot: number, _row?: number): CommandResult & { slot?: number } {
  return todo();
}

/** A finished Song-view take → song clips + regions in one undo step "Record <Part>". */
export function recordTakeIntoSong(_store: ProjectStore, _take: SongTake): CommandResult & { regionIds?: Id[] } {
  return todo();
}

/** How many regions play this clip. */
export function loopUse(_p: Project, _trackId: Id, _clipId: Id): number {
  return todo();
}
