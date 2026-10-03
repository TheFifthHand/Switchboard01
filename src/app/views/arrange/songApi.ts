/**
 * The song commands and playback calls the Song view uses, with the
 * signatures of the shared song contract (round-5 SONG_SPEC: spine commands
 * in state/commands/arrangement.ts, engine calls on the session, the
 * runtime's song fields and app/songPlayback.ts). One place for them, so the
 * view's code reads the same as the contract.
 */
import type { Edge } from '../../../project/arrangement';
import type { Id, Project, SongMoveKind } from '../../../project/types';
import * as cmd from '../../../state/commands';
import type { CommandResult } from '../../../state/commands';
import type { ProjectStore } from '../../../state/projectStore';
import { useStore } from '../../../state/store';
import { session } from '../../instance';
import { runtimeStore, type RuntimeState } from '../../runtime';
import * as playback from '../../songPlayback';

export type { Edge };

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

export interface RegionDraft {
  trackId: Id;
  clipId: Id;
  start: number;
  bars: number;
  offset?: number;
}
export interface SongEditResult extends CommandResult {
  ids?: Id[];
  trimmed?: number;
  removed?: number;
}
export interface RegionClipboard {
  items: { trackId: Id; clipId: Id; at: number; bars: number; offset: number }[];
}
export type ShapeKind = 'build' | 'strip' | 'breakdown';

export interface SongCommands {
  addRegions(store: ProjectStore, drafts: readonly RegionDraft[], opts?: { display?: string }): SongEditResult;
  addClipToSong(store: ProjectStore, trackId: Id, clipId: Id, start: number, bars?: number): SongEditResult;
  addSceneToSong(store: ProjectStore, row: number, start: number, opts?: { bars?: number; section?: boolean }): SongEditResult & { sectionId?: Id };
  moveRegions(store: ProjectStore, ids: readonly Id[], delta: number, opts?: { copy?: boolean; gesture?: string }): SongEditResult;
  resizeRegions(store: ProjectStore, ids: readonly Id[], edge: Edge, delta: number, gesture?: string): SongEditResult;
  splitRegions(store: ProjectStore, ids: readonly Id[], atBar: number): SongEditResult;
  removeRegions(store: ProjectStore, ids: readonly Id[], opts?: { cut?: boolean }): SongEditResult;
  duplicateRegions(store: ProjectStore, ids: readonly Id[]): SongEditResult;
  copyRegions(p: Project, ids: readonly Id[]): RegionClipboard | null;
  pasteRegions(store: ProjectStore, clip: RegionClipboard, atBar: number): SongEditResult;
  setRegionClip(store: ProjectStore, id: Id, clipId: Id): SongEditResult;
  fillSongFromScenes(store: ProjectStore): SongEditResult;
  insertBars(store: ProjectStore, at: number, bars: number): SongEditResult;
  removeBars(store: ProjectStore, from: number, to: number): SongEditResult;
  addSection(store: ProjectStore, start: number, bars: number, name?: string): SongEditResult & { sectionId?: Id };
  renameSection(store: ProjectStore, id: Id, name: string): CommandResult;
  resizeSection(store: ProjectStore, id: Id, edge: Edge, delta: number, gesture?: string): CommandResult;
  moveSection(store: ProjectStore, id: Id, delta: number, opts?: { copy?: boolean; gesture?: string }): SongEditResult & { sectionId?: Id };
  duplicateSection(store: ProjectStore, id: Id): SongEditResult & { sectionId?: Id };
  removeSection(store: ProjectStore, id: Id, opts?: { withMusic?: boolean }): SongEditResult;
  toggleSectionMove(store: ProjectStore, id: Id, kind: SongMoveKind, parts?: readonly Id[]): CommandResult & { on?: boolean };
  shapeSection(store: ProjectStore, id: Id, kind: ShapeKind): SongEditResult;
  shapeProblem(p: Project, id: Id, kind: ShapeKind): string | null;
  songFromTake(store: ProjectStore, takeId: Id, opts?: { at?: number }): SongEditResult;
}

export const songCmd = cmd as unknown as SongCommands;

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
