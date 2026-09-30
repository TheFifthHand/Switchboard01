/** Project-wide edits: name, tempo, swing, key, Musical Assist, master volume, settings. */
import { BPM_SPEC, MASTER_VOLUME_SPEC, SWING_SPEC } from '../../project/params';
import type { ProjectSettings, ScaleId } from '../../project/types';
import { QUANTIZE_GRIDS, SCALE_IDS } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { clamp, cleanName, isFiniteNumber, refuse, run, type CommandResult } from './common';

export function renameProject(store: ProjectStore, name: string): CommandResult {
  const n = cleanName(name, 80);
  if (!n) return refuse('invalid', 'A project needs a name.');
  return run(store, 'project:Rename project', (d) => {
    d.name = n;
  });
}

/** Tempo in BPM, clamped to 40–220. */
export function setBpm(store: ProjectStore, bpm: number, gesture?: string): CommandResult {
  if (!isFiniteNumber(bpm)) return refuse('invalid', 'Tempo must be a number.');
  const v = Math.round(clamp(bpm, BPM_SPEC.min, BPM_SPEC.max) * 100) / 100;
  return run(store, 'project:Change tempo', (d) => {
    d.bpm = v;
  }, gesture);
}

/** Swing 0 (straight) .. 1 (triplet shuffle). */
export function setSwing(store: ProjectStore, swing: number, gesture?: string): CommandResult {
  if (!isFiniteNumber(swing)) return refuse('invalid', 'Swing must be a number.');
  const v = clamp(swing, SWING_SPEC.min, SWING_SPEC.max);
  return run(store, 'project:Change swing', (d) => {
    d.swing = v;
  }, gesture);
}

/** Key root as a pitch class (any integer, wrapped to 0..11) and scale. */
export function setKey(store: ProjectStore, root: number, scale: ScaleId): CommandResult {
  if (!isFiniteNumber(root) || !SCALE_IDS.includes(scale)) return refuse('invalid', 'Unknown key or scale.');
  const r = ((Math.round(root) % 12) + 12) % 12;
  return run(store, 'project:Change key', (d) => {
    d.root = r;
    d.scale = scale;
  });
}

export function setAssist(store: ProjectStore, on: boolean): CommandResult {
  return run(store, on ? 'project:Turn on Musical Assist' : 'project:Turn off Musical Assist', (d) => {
    d.assist = !!on;
  });
}

export function setMasterVolume(store: ProjectStore, db: number, gesture?: string): CommandResult {
  if (!isFiniteNumber(db)) return refuse('invalid', 'Volume must be a number.');
  const v = clamp(db, MASTER_VOLUME_SPEC.min, MASTER_VOLUME_SPEC.max);
  return run(store, 'project:Change master volume', (d) => {
    d.masterVolumeDb = v;
  }, gesture);
}

export function setSettings(store: ProjectStore, partial: Partial<ProjectSettings>): CommandResult {
  const next: Partial<ProjectSettings> = {};
  if (partial.metronome !== undefined) next.metronome = !!partial.metronome;
  if (partial.countIn !== undefined) next.countIn = !!partial.countIn;
  if (partial.recordQuantize !== undefined) {
    if (!QUANTIZE_GRIDS.includes(partial.recordQuantize)) return refuse('invalid', 'Unknown quantize setting.');
    next.recordQuantize = partial.recordQuantize;
  }
  return run(store, 'project:Change settings', (d) => {
    Object.assign(d.settings, next);
  });
}
