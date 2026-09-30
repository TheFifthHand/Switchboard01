/**
 * Performance snapshots (pure).
 *
 * A snapshot is the musical state a take needs to replay faithfully. Both
 * directions deep-clone, so a replay never aliases the stored performance and
 * later edits never leak into a recorded take.
 */
import { TICKS_PER_BAR, type LauncherSnapshotEntry, type PerformanceSnapshot, type Project } from '../project/types';

/** The project a performance replays with: the snapshot's musical state on top of `base`. */
export function projectFromSnapshot(base: Project, snap: PerformanceSnapshot): Project {
  const s = structuredClone(snap);
  return {
    ...base,
    bpm: s.bpm,
    swing: s.swing,
    root: s.root,
    scale: s.scale,
    assist: s.assist,
    masterVolumeDb: s.masterVolumeDb,
    tracks: s.tracks,
    scenes: s.scenes,
    patch: s.patch,
    seed: s.seed,
  };
}

/**
 * Capture the musical state for a take that starts at `startTick`.
 *
 * Launcher entries are normalised: every project track gets an entry, slots
 * that no longer hold a clip become stopped, and with `startTick` a clip that
 * started earlier gets the latest loop start at or before `startTick` (same
 * loop phase, bounded numbers).
 */
export function makeSnapshot(project: Project, launcher: readonly LauncherSnapshotEntry[], startTick?: number): PerformanceSnapshot {
  const entries: LauncherSnapshotEntry[] = project.tracks.map((track) => {
    const entry = launcher.find((e) => e.trackId === track.id);
    const playing = entry?.playing;
    if (!playing) return { trackId: track.id, playing: null };
    const clip = track.clips[playing.slot];
    if (!clip) return { trackId: track.id, playing: null };
    let s = playing.startTick;
    if (startTick !== undefined && Number.isFinite(startTick) && s <= startTick) {
      const len = clip.bars * TICKS_PER_BAR;
      s += Math.floor((startTick - s) / len) * len;
    }
    return { trackId: track.id, playing: { slot: playing.slot, startTick: s } };
  });
  return structuredClone({
    bpm: project.bpm,
    swing: project.swing,
    root: project.root,
    scale: project.scale,
    assist: project.assist,
    masterVolumeDb: project.masterVolumeDb,
    tracks: project.tracks,
    scenes: project.scenes,
    patch: project.patch,
    launcher: entries,
    seed: project.seed,
  });
}
