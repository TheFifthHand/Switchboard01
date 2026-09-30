/** Knob specs for the six performance macros (values are 0..1). */
import type { ParamSpec } from '../project/params';
import type { MacroId } from '../project/types';
import { defaultMacros } from '../project/factory';

const d = defaultMacros();

export const MACRO_SPECS: Record<MacroId, ParamSpec> = {
  tone: { id: 'tone', label: 'Tone', min: 0, max: 1, default: d.tone, unit: '%', curve: 'lin', tip: 'Makes this part darker (left) or brighter (right). The middle is the sound as designed.', detail: 'Moves filter cutoff and brightness — see the list below or the Shape view.' },
  space: { id: 'space', label: 'Space', min: 0, max: 1, default: d.space, unit: '%', curve: 'lin', tip: 'Space adds a room around this sound.', detail: 'Sends the part to the shared Reverb (channel Send A).' },
  echo: { id: 'echo', label: 'Echo', min: 0, max: 1, default: d.echo, unit: '%', curve: 'lin', tip: 'Adds echoes that repeat in time with the beat.', detail: 'Sends the part to the shared tempo-synced Delay (channel Send B).' },
  motion: { id: 'motion', label: 'Motion', min: 0, max: 1, default: d.motion, unit: '%', curve: 'lin', tip: 'Makes the sound move and breathe in time with the music.', detail: "Fades in the part's tempo-synced LFO, which is cabled to the filter cutoff." },
  drive: { id: 'drive', label: 'Drive', min: 0, max: 1, default: d.drive, unit: '%', curve: 'lin', tip: 'Warms the sound up, then adds grit and distortion.', detail: "Raises the part's Drive module amount (level-compensated)." },
  pump: { id: 'pump', label: 'Pump', min: 0, max: 1, default: d.pump, unit: '%', curve: 'lin', tip: 'Makes the part duck and swell with the beat.', detail: 'A tempo-synchronized ducking envelope on the channel volume. It follows the beat grid; it does not listen to the drums (no audio sidechain).' },
};
