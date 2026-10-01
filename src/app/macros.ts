/**
 * Knob specs for the six performance macros (values are 0..1).
 *
 * What a macro moves depends on the part's sound and on the user's mappings,
 * so the specs name no targets: views describe the live mappings instead
 * (describeMacro). Only Pump keeps a detail, since it says what Pump is.
 */
import type { ParamSpec } from '../project/params';
import type { MacroId } from '../project/types';
import { defaultMacros } from '../project/factory';

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
