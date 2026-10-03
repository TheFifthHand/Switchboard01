/**
 * What a Simple effect card's knobs are (pure, over the project):
 *
 * - Its main knob is always the effect's first main setting (or its virtual
 *   knob, the Compressor's Squeeze). When a big knob (macro) sets that
 *   setting, the card shows that big knob instead: the Drive card carries the
 *   Drive big knob, the Filter card the Tone or Motion big knob. Turning the
 *   card's knob therefore always changes the sound: a later setting (Fizz,
 *   Resonance) can be inert while the main amount is at zero or wide open.
 * - A Filter card also offers Resonance while the filter's cutoff is inside
 *   the audible band (a low-pass below about 12 kHz, a high-pass above
 *   60 Hz, any band-pass): only then does Resonance ring where the filter cuts.
 *   Otherwise it says why not (set by a big knob, or when it will appear).
 */
import { MODULE_PARAMS, readParam } from '../../../project/params';
import type { MacroControl } from '../../../project/resolve';
import type { Id, ModuleType, Project } from '../../../project/types';
import { VIRTUAL_KNOBS, mainKnobCandidates } from './effectCatalog';
import { controllerName, derived } from './paramState';

/** A low-pass filter's Resonance is offered below this cutoff (Hz). */
export const RESONANCE_BELOW_HZ = 12000;
/** A high-pass filter's Resonance is offered above this cutoff (Hz). */
export const RESONANCE_ABOVE_HZ = 60;

export interface MainKnob {
  /** The setting the card's knob is about (a stored parameter, or a virtual knob's id such as 'squeeze'). */
  param: string;
  /** The big knob that sets it: the card shows that big knob. Null when the card's own knob sets it. */
  macro: MacroControl | null;
  /** That big knob's name ("Drive", "Bass Tone"), or null. */
  by: string | null;
  /** A second setting the card offers now (Resonance on a filter whose cutoff is in range), or null. */
  extra: string | null;
  /** Why a Filter card offers no Resonance now ("Resonance is set by the Motion big knob."), or null. */
  extraNote: string | null;
}

export const sameMainKnob = (a: MainKnob | null, b: MainKnob | null): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.param === b.param &&
    a.by === b.by &&
    a.extra === b.extra &&
    a.extraNote === b.extraNote &&
    a.macro?.trackId === b.macro?.trackId &&
    a.macro?.macro === b.macro?.macro);

/** Whether a filter's Resonance rings where it cuts now (its effective cutoff inside the audible band). */
export function resonanceInRange(values: Record<string, number> | undefined): boolean {
  const mode = readParam(MODULE_PARAMS.filter, values, 'mode');
  const cutoff = readParam(MODULE_PARAMS.filter, values, 'cutoff');
  if (mode === 0) return cutoff < RESONANCE_BELOW_HZ;
  if (mode === 1) return cutoff > RESONANCE_ABOVE_HZ;
  return true;
}

export function chooseMainKnob(p: Project, moduleIdStr: Id, type: ModuleType, ownerTrackId: Id): MainKnob {
  const d = derived(p);
  const virtual = VIRTUAL_KNOBS[type];
  // A virtual knob writes several settings; the first of them decides whether a big knob owns it.
  const first = virtual ? (mainKnobCandidates(type).find((s) => s.id === 'threshold') ?? mainKnobCandidates(type)[0]) : mainKnobCandidates(type)[0];
  const param = virtual ? virtual.id : (first?.id ?? '');
  const macro = first ? (d.controlled.get(`${moduleIdStr}.${first.id}`) ?? null) : null;
  const by = macro && first ? controllerName(p, moduleIdStr, first.id, ownerTrackId) : null;
  let extra: string | null = null;
  let extraNote: string | null = null;
  if (type === 'filter') {
    const values = d.resolved.get(moduleIdStr);
    const resBy = d.controlled.has(`${moduleIdStr}.resonance`) ? controllerName(p, moduleIdStr, 'resonance', ownerTrackId) : null;
    if (resBy) extraNote = `Resonance is set by the ${resBy} big knob.`;
    else if (resonanceInRange(values)) extra = 'resonance';
    else if (readParam(MODULE_PARAMS.filter, values, 'mode') === 1) extraNote = `Resonance appears once the filter cuts above ${RESONANCE_ABOVE_HZ} Hz.`;
    else extraNote = `Resonance appears once the filter closes below ${RESONANCE_BELOW_HZ / 1000} kHz.`;
  }
  return { param: macro ? (first?.id ?? param) : param, macro, by, extra, extraNote };
}
