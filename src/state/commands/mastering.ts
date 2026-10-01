/**
 * Mastering commands: the master-bus chain (schema v2, Project.mastering).
 *
 * Every edit is labelled "mastering:…". A performance take only lets through
 * the edits it can record, and its replay plays with the project's current
 * mastering, so the take lock refuses these (the result carries `refused`).
 *
 * - setMasteringEnabled: the On/Off switch (one undo step).
 * - setMasteringParam: one control, clamped through MASTERING_PARAMS; a drag
 *   passes a gesture id so it is one undo step. Moving a control away from the
 *   chosen preset's value forgets the preset (the settings are now custom).
 * - applyMasteringPreset: every control at once, as one undo step; it also
 *   switches mastering on, so the choice is heard.
 * - matchLoudnessTarget: moves Loudness by the difference between a target
 *   and a measured loudness, within 0–15 dB, and says what it did.
 */
import { masteringPreset } from '../../content/mastering';
import { MASTERING_PARAMS, clampParam, readParam, specById } from '../../project/params';
import type { Mastering, ParamValues } from '../../project/types';
import type { ProjectStore } from '../projectStore';
import { isFiniteNumber, refuse, run, type CommandResult } from './common';

export const MASTERING_LABEL_PREFIX = 'mastering:';

/** Shown instead of the generic take message when the take lock refuses a mastering edit. */
export const MASTERING_LOCKED_MESSAGE =
  'Mastering cannot change while a performance records: its replay plays with the mastering you have then. Stop recording to change it.';

const LOUDNESS = specById(MASTERING_PARAMS, 'loudness')!;
const SAME = 1e-9;

/** True when the settings differ from the named preset's (an unknown preset always differs). */
export function masteringDiverges(params: ParamValues, presetId: string | undefined): boolean {
  if (presetId === undefined) return true;
  const preset = masteringPreset(presetId);
  if (!preset) return true;
  return MASTERING_PARAMS.some((s) => Math.abs(readParam(MASTERING_PARAMS, params, s.id) - readParam(MASTERING_PARAMS, preset.params, s.id)) > SAME);
}

export function setMasteringEnabled(store: ProjectStore, enabled: boolean): CommandResult {
  const on = !!enabled;
  return run(store, on ? 'mastering:Turn mastering on' : 'mastering:Turn mastering off', (d) => {
    d.mastering.enabled = on;
  });
}

/** Set one mastering control (clamped). Edits with the same gesture id form one undo step. */
export function setMasteringParam(store: ProjectStore, param: string, value: number, gesture?: string): CommandResult {
  const spec = specById(MASTERING_PARAMS, param);
  if (!spec) return refuse('invalid', 'Mastering has no such control.');
  if (!isFiniteNumber(value)) return refuse('invalid', 'The value must be a number.');
  const v = clampParam(spec, value);
  return run(
    store,
    `mastering:Change ${spec.label}`,
    (d) => {
      d.mastering.params[param] = v;
      if (d.mastering.presetId !== undefined && masteringDiverges(d.mastering.params, d.mastering.presetId)) delete d.mastering.presetId;
    },
    gesture,
  );
}

/** The complete, clamped settings a preset gives (controls it leaves out are neutral). */
export function presetSettings(presetId: string): ParamValues | null {
  const preset = masteringPreset(presetId);
  if (!preset) return null;
  const out: ParamValues = {};
  for (const s of MASTERING_PARAMS) out[s.id] = readParam(MASTERING_PARAMS, preset.params, s.id);
  return out;
}

/** Use a preset: every control, remembered as the preset, mastering on. One undo step. */
export function applyMasteringPreset(store: ProjectStore, presetId: string): CommandResult {
  const preset = masteringPreset(presetId);
  const values = presetSettings(presetId);
  if (!preset || !values) return refuse('invalid', 'Unknown mastering preset.');
  return run(store, `mastering:Use ${preset.name} mastering`, (d) => {
    const m: Mastering = d.mastering;
    for (const [id, v] of Object.entries(values)) if (m.params[id] !== v) m.params[id] = v;
    m.presetId = preset.id;
    m.enabled = true;
  });
}

export interface LoudnessMatch extends CommandResult {
  /** Loudness control before and after, in dB. */
  before: number;
  after: number;
  /** The change the measurement asked for (target − measured), in dB. */
  requested: number;
  /** Set when the control's range stopped the full change. */
  limit: 'max' | 'min' | null;
}

/**
 * Match a loudness target (LUFS) from a measured loudness (LUFS): move the
 * Loudness control by the difference, within its 0–15 dB range. Approximate,
 * because the output limiter holds peaks at −1 dBFS: pushing into it adds
 * less loudness than the dB figure. One undo step.
 */
export function matchLoudnessTarget(store: ProjectStore, targetLufs: number, measuredLufs: number): LoudnessMatch {
  const m = store.getState().mastering;
  const before = readParam(MASTERING_PARAMS, m.params, 'loudness');
  const none = (r: CommandResult, requested = 0): LoudnessMatch => ({ ...r, before, after: before, requested, limit: null });
  if (!isFiniteNumber(targetLufs)) return none(refuse('invalid', 'Choose a loudness target first.'));
  if (!isFiniteNumber(measuredLufs)) return none(refuse('unavailable', 'Nothing measured yet. Play your song for a few seconds, then match.'));
  if (!m.enabled) return none(refuse('unavailable', 'Mastering is off. Turn it on to match a loudness target.'));
  const requested = targetLufs - measuredLufs;
  const wanted = before + requested;
  const after = Math.round(clampParam(LOUDNESS, wanted) * 10) / 10;
  const limit = wanted > LOUDNESS.max + SAME ? 'max' : wanted < LOUDNESS.min - SAME ? 'min' : null;
  if (Math.abs(after - before) < 0.05) return { changed: false, before, after: before, requested, limit };
  const r = run(store, 'mastering:Match loudness target', (d) => {
    d.mastering.params.loudness = after;
    if (d.mastering.presetId !== undefined && masteringDiverges(d.mastering.params, d.mastering.presetId)) delete d.mastering.presetId;
  });
  return r.changed ? { ...r, before, after, requested, limit } : { ...r, before, after: before, requested, limit };
}

