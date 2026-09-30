/**
 * Synth preset data and sound assignment.
 *
 * A preset stores: instrument params, optional macro-mapping overrides
 * (relative to the track's module slots), optional module param defaults
 * (e.g. the LFO rate that Motion uses) and suggested macro positions.
 * Applying a preset writes all of that into the project so the saved project
 * is self-contained — it never needs the preset table to sound the same.
 *
 * SKELETON: parameter values are filled in by the content milestone.
 */
import type { Id, MacroId, MacroTarget, MacroValues, ParamValues, Project } from '../project/types';

export type TrackSlot = 'inst' | 'drive' | 'filter' | 'lfo' | 'ch';

export interface PresetMacroTarget extends Omit<MacroTarget, 'module'> {
  slot: TrackSlot;
}

export interface PresetData {
  params: ParamValues;
  macroMap?: Partial<Record<MacroId, PresetMacroTarget[]>>;
  modules?: Partial<Record<Exclude<TrackSlot, 'inst'>, ParamValues>>;
  macros?: Partial<MacroValues>;
}

/** Keyed by preset id from src/content/catalog.ts SYNTH_PRESETS. */
export const PRESETS: Record<string, PresetData> = {};

/**
 * Assign a synth preset to a track (bass or poly). Changes the instrument kind
 * if needed. Mutates `project` (use inside an immer recipe).
 */
export function applyPresetToProject(project: Project, trackId: Id, presetId: string): void {
  void project;
  void trackId;
  void presetId;
  throw new Error('applyPresetToProject: not implemented yet');
}

/** Assign a drum kit to a track. Mutates `project`. */
export function applyKitToProject(project: Project, trackId: Id, kitId: string): void {
  void project;
  void trackId;
  void kitId;
  throw new Error('applyKitToProject: not implemented yet');
}

/** Turn a track into a sampler playing `sampleId` (imported or built-in). Mutates `project`. */
export function applySamplerToProject(project: Project, trackId: Id, sampleId: string | null): void {
  void project;
  void trackId;
  void sampleId;
  throw new Error('applySamplerToProject: not implemented yet');
}
