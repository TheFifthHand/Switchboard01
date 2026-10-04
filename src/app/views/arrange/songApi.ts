/**
 * The song commands and playback calls the Song view uses, in one place: the
 * spine's commands (state/commands/arrangement.ts), the engine's calls on the
 * session, the runtime's song fields and app/songPlayback.ts, with the
 * signatures of the shared song contract (round-5 SONG_SPEC).
 */
import * as cmd from '../../../state/commands';
import { useStore } from '../../../state/store';
import { session } from '../../instance';
import { runtimeStore, type RuntimeState } from '../../runtime';
import * as playback from '../../songPlayback';

export type { Edge, RegionClipboard, RegionDraft, ShapeKind, SongEditResult } from '../../../state/commands';

/** The song commands (each one undo step). */
export const songCmd = cmd;

/* ------------------------------------------------------------------ */
/* Playback                                                            */
/* ------------------------------------------------------------------ */

/** A looped stretch of the song: bars [fromBar, toBar) (runtime only, never saved). */
export interface SongLoop {
  fromBar: number;
  toBar: number;
}

export interface SongSession {
  /** From `fromBar` ?? the cursor (the loop's start when a loop is set and the cursor is outside it); restarts there if the song already plays. */
  playSong(opts?: { fromBar?: number }): Promise<void>;
  /** Song playing or paused: continue from that bar (paused stays paused there); stopped: sets the cursor. */
  seekSong(bar: number): void;
  /** Stopped: where Play starts. */
  setSongCursor(bar: number): void;
  setSongLoop(loop: SongLoop | null): boolean;
  /** Pause if playing; else play the song (the pads when the song is empty). */
  togglePlay(opts?: { song?: boolean }): Promise<void>;
}

export const songSession = session as unknown as SongSession;

/** The runtime's song fields. */
export interface SongRuntime {
  songCursor: number;
  songLoop: SongLoop | null;
  songLooping: boolean;
}

type FullRuntime = Omit<RuntimeState, 'songLoop'> & SongRuntime;

/** Read the runtime with its song fields typed as the contract has them. */
export function useSongRuntime<S>(selector: (s: FullRuntime) => S, equality?: (a: S, b: S) => boolean): S {
  return useStore(runtimeStore, selector as unknown as (s: RuntimeState) => S, equality);
}

export function songRuntime(): FullRuntime {
  return runtimeStore.getState() as unknown as FullRuntime;
}

interface SongPlayback {
  /** Fractional bar under the playhead right now (song playing or paused), else null; cheap, for rAF. */
  songPlayheadBar(): number | null;
  /** Song mode playing or paused. */
  useSongPlaying(): boolean;
}

const pb = playback as unknown as SongPlayback;
export const songPlayheadBar = (): number | null => pb.songPlayheadBar();
export const useSongPlaying = (): boolean => pb.useSongPlaying();
