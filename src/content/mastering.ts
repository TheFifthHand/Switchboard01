/**
 * Mastering presets: starting points for the master-bus chain
 * (MASTERING_PARAMS). Each sets every parameter; "clean" is neutral.
 *
 * Every preset is rendered and measured in tests/browser/omni-mastering-*:
 * each one does what its sentence says (spectral tilt, side energy, crest
 * factor, loudness), and none exceeds the −1 dBFS output ceiling.
 */
import { neutralMasteringParams } from '../project/params';
import type { ParamValues } from '../project/types';

export interface MasteringPreset {
  id: string;
  name: string;
  /** One plain sentence about what it does to the sound. */
  description: string;
  params: ParamValues;
}

function preset(id: string, name: string, description: string, changes: ParamValues): MasteringPreset {
  return { id, name, description, params: { ...neutralMasteringParams(), ...changes } };
}

export const MASTERING_PRESETS: readonly MasteringPreset[] = [
  preset('clean', 'Clean', 'No processing: the mix exactly as you made it.', {}),
  preset('gentle', 'Gentle', 'A light touch of glue and air, a little louder, with the dynamics left almost untouched.', {
    lowCut: 22,
    air: 1,
    glue: 0.3,
    punch: 0.7,
    loudness: 2,
  }),
  preset('warm', 'Warm', 'Rounder lows, softer highs and analogue-style warmth for a cosy, full sound.', {
    lowCut: 20,
    lowGain: 2,
    lowFreq: 120,
    highGain: -2.5,
    highFreq: 5000,
    saturation: 0.45,
    glue: 0.25,
    punch: 0.5,
    loudness: 2,
  }),
  preset('punchy', 'Punchy', 'Tighter, harder-hitting drums and bass: the glue lets each hit through and the low mids are cleaned up.', {
    lowCut: 25,
    lowGain: 1.5,
    lowFreq: 80,
    midGain: -1.5,
    midFreq: 400,
    highGain: 1,
    highFreq: 5000,
    glue: 0.55,
    punch: 0.9,
    loudness: 4,
  }),
  preset('bright', 'Bright', 'More sparkle and air on top for a crisp, open mix.', {
    lowCut: 20,
    midGain: -0.5,
    highGain: 3,
    highFreq: 5000,
    air: 3,
    loudness: 1,
  }),
  preset('wide', 'Wide', 'A broader stereo image with the bass kept solid in the centre.', {
    lowCut: 20,
    width: 1.45,
    monoBass: 120,
    air: 1,
    loudness: 1,
  }),
  // How loud it ends up depends on the mix going in, so the name and sentence promise no number.
  preset('loud', 'Loud', 'The loudest preset: firm glue, a touch of warmth and a hard push into the limiter; how loud it gets depends on your mix.', {
    lowCut: 30,
    lowGain: 1,
    highGain: 1,
    glue: 0.65,
    punch: 0.45,
    saturation: 0.3,
    width: 1.1,
    monoBass: 100,
    loudness: 8,
  }),
  preset('lofi', 'Lo-fi', 'A narrow, band-limited, saturated sound like an old radio or a worn cassette.', {
    lowCut: 120,
    lowGain: -4,
    lowFreq: 200,
    midGain: 4,
    midFreq: 1200,
    highGain: -6,
    highFreq: 2500,
    saturation: 0.55,
    glue: 0.4,
    punch: 0.5,
    width: 0.4,
    loudness: 2,
  }),
];

export function masteringPreset(id: string): MasteringPreset | undefined {
  return MASTERING_PRESETS.find((p) => p.id === id);
}
