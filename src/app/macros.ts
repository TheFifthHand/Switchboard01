/**
 * Knob specs for the six performance macros (values are 0..1).
 *
 * What a macro moves depends on the part's sound and on the user's mappings,
 * so the specs name no targets: views describe the live mappings instead
 * (describeMacro). Only Pump keeps a detail, since it says what Pump is.
 *
 * `macroSpecFor` gives a part's big knob its own home: double-click (and
 * Delete) return it to the position the part's sound or starter was designed
 * with (Track.macroHome, see macroHomeFor), not to the plain default.
 */
import { formatParam, type ParamSpec } from '../project/params';
import type { MacroId, Track } from '../project/types';
import { defaultMacros } from '../project/factory';
import { macroHomeFor } from '../state/commands';

const d = defaultMacros();

/** One short line under each macro knob: what turning it does. The same words in every view. */
export const MACRO_CAPTION: Record<MacroId, string> = {
  tone: 'Dark ↔ bright',
  space: 'Room around it',
  echo: 'Echoes in time',
  motion: 'Moves in time',
  drive: 'Warmth to grit',
  pump: 'Ducks in time',
};

export const MACRO_SPECS: Record<MacroId, ParamSpec> = {
  tone: { id: 'tone', label: 'Tone', min: 0, max: 1, default: d.tone, unit: '%', curve: 'lin', tip: 'Makes this part darker (left) or brighter (right). The middle is the sound as designed.' },
  space: { id: 'space', label: 'Space', min: 0, max: 1, default: d.space, unit: '%', curve: 'lin', tip: 'Space adds a room around this sound.' },
  echo: { id: 'echo', label: 'Echo', min: 0, max: 1, default: d.echo, unit: '%', curve: 'lin', tip: 'Adds echoes that repeat in time with the beat.' },
  motion: { id: 'motion', label: 'Motion', min: 0, max: 1, default: d.motion, unit: '%', curve: 'lin', tip: 'Makes the sound move and breathe in time with the music.' },
  drive: { id: 'drive', label: 'Drive', min: 0, max: 1, default: d.drive, unit: '%', curve: 'lin', tip: 'Warms the sound up, then adds grit and distortion.' },
  pump: { id: 'pump', label: 'Pump', min: 0, max: 1, default: d.pump, unit: '%', curve: 'lin', tip: 'Makes the part duck and swell with the beat.', detail: 'Pump is a tempo-synchronized ducking envelope on the channel volume. It follows the beat grid; it does not listen to the drums (no audio sidechain).' },
};

/** The plain default of a big knob (what Alt+double-click returns it to). */
export function macroPlainDefault(macro: MacroId): number {
  return d[macro];
}

/** "Double-click returns it to this sound’s 28%; Alt+double-click to the plain default, 15%." (empty when they agree). */
export function macroHomeNote(macro: MacroId, home: number): string {
  const spec = MACRO_SPECS[macro];
  if (home === spec.default) return '';
  return `Double-click returns it to this sound’s ${formatParam(spec, home)}; Alt+double-click to the plain default, ${formatParam(spec, spec.default)}.`;
}

/**
 * A part's big-knob spec: the shared spec with `default` set to where this
 * part's sound or starter put the knob (macroHomeFor), so double-click,
 * Delete and the knob's tip all return to the sound's own design.
 */
export function macroSpecFor(track: Pick<Track, 'macroHome'> | null | undefined, macro: MacroId): ParamSpec {
  const spec = MACRO_SPECS[macro];
  const home = track ? macroHomeFor(track, macro) : spec.default;
  return home === spec.default ? spec : { ...spec, default: home };
}
