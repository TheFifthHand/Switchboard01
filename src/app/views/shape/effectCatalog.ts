/**
 * What the Shape view says about each insert effect, in plain words:
 * the purpose groups of the Add effect menu, a short description per menu
 * item, the one sentence an effect card shows, the one main knob the Simple
 * view gives each effect, and how the Advanced rack lays out its knobs.
 *
 * Pure data over the module catalogue (no React, no audio). Every insertable
 * effect type appears in exactly one group.
 */
import { INSERTABLE_EFFECTS, MODULE_DEFS } from '../../../project/modules';
import { MODULE_PARAMS, specById, type ParamSpec } from '../../../project/params';
import type { ModuleType } from '../../../project/types';

export interface EffectGroup {
  id: 'tone' | 'dynamics' | 'space' | 'movement' | 'colour' | 'stereo';
  label: string;
  types: readonly ModuleType[];
}

/** The Add effect menu, grouped by what the effect is for. */
export const EFFECT_GROUPS: readonly EffectGroup[] = [
  { id: 'tone', label: 'Tone', types: ['eq', 'filter'] },
  { id: 'dynamics', label: 'Dynamics', types: ['compressor', 'gate'] },
  { id: 'space', label: 'Space', types: ['reverb', 'delay'] },
  { id: 'movement', label: 'Movement', types: ['chorus', 'phaser', 'flanger', 'autopan'] },
  { id: 'colour', label: 'Colour', types: ['drive', 'tape', 'crusher'] },
  { id: 'stereo', label: 'Stereo', types: ['widener'] },
];

export interface EffectInfo {
  /** One short line for the Add effect menu. */
  summary: string;
  /** One plain sentence for the effect's card: what it does and what its main knob sets. */
  sentence: string;
  /** The parameter the Simple view shows as the effect's one knob. */
  main: string;
}

/** Plain descriptions and the main knob of every insertable effect. */
export const EFFECT_INFO: Partial<Record<ModuleType, EffectInfo>> = {
  eq: { summary: 'More or less bass, middle and treble.', sentence: 'Shapes the tone. Lows adds or removes bass and weight.', main: 'lowGain' },
  filter: { summary: 'Makes the sound darker or thinner.', sentence: 'Removes part of the sound. Turn Cutoff down for a darker, softer tone.', main: 'cutoff' },
  compressor: { summary: 'Evens out loud and quiet moments for more punch.', sentence: 'Holds loud moments down for a tighter, punchier sound. Squeeze sets how hard.', main: 'ratio' },
  gate: { summary: 'Silences the quiet bits: tighter, cleaner tails.', sentence: 'Silences everything quieter than the Threshold, which cleans up noise and cuts tails short.', main: 'threshold' },
  reverb: { summary: 'A room or hall around the sound.', sentence: 'Puts the sound in a room. Mix sets how much of the room you hear.', main: 'mix' },
  delay: { summary: 'Echoes in time with the beat.', sentence: 'Repeats the sound in time with the beat. Mix sets how loud the echoes are.', main: 'mix' },
  chorus: { summary: 'A wide, shimmering double of the sound.', sentence: 'Adds a wide, shimmering double of the sound. Mix sets how much.', main: 'mix' },
  phaser: { summary: 'A slow, swirling sweep.', sentence: 'Sweeps a swirl through the sound. Mix sets how strong it is.', main: 'mix' },
  flanger: { summary: 'A sweeping, jet-plane whoosh.', sentence: 'Adds a sweeping, jet-plane whoosh. Mix sets how strong it is.', main: 'mix' },
  autopan: { summary: 'Swings the sound left and right in time.', sentence: 'Swings the sound from side to side in time with the beat. Depth sets how far.', main: 'depth' },
  drive: { summary: 'Warmth first, then crunch and distortion.', sentence: 'Warms the sound up, then adds crunch. Turn Drive up for more grit.', main: 'amount' },
  tape: { summary: 'Warm tape saturation with a gentle wobble.', sentence: 'Gives the warm, slightly wobbly sound of an old tape machine. Saturation sets how warm.', main: 'drive' },
  crusher: { summary: 'Gritty, lo-fi digital crunch.', sentence: 'Makes the sound gritty and lo-fi, like an old sampler. Turn Lo-fi Rate up for more crunch.', main: 'downsample' },
  widener: { summary: 'Makes the sound wider or narrower.', sentence: 'Spreads the sound wider across the speakers, keeping the bass centred. Width sets how wide.', main: 'width' },
};

/** Menu line for an effect type (falls back to the module catalogue). */
export function effectSummary(type: ModuleType): string {
  return EFFECT_INFO[type]?.summary ?? MODULE_DEFS[type].description;
}

/** Card sentence for an effect type (falls back to the module catalogue). */
export function effectSentence(type: ModuleType): string {
  return EFFECT_INFO[type]?.sentence ?? MODULE_DEFS[type].description;
}

/** The main knob's spec for an effect type (the first parameter when none is chosen). */
export function mainParamSpec(type: ModuleType): ParamSpec | undefined {
  const specs = MODULE_PARAMS[type];
  const id = EFFECT_INFO[type]?.main;
  return (id ? specById(specs, id) : undefined) ?? specs[0];
}

/**
 * Knob rows for the Advanced rack, where a plain grid would scatter related
 * controls: the EQ reads as three bands. Types not listed use one flowing grid.
 */
export const RACK_ROWS: Partial<Record<ModuleType, readonly (readonly string[])[]>> = {
  eq: [
    ['lowCut', 'lowGain', 'lowFreq'],
    ['midGain', 'midFreq', 'midQ'],
    ['highGain', 'highFreq', 'highCut'],
  ],
  compressor: [
    ['threshold', 'ratio', 'makeup'],
    ['attack', 'release', 'mix'],
  ],
};

/** The rack's knob rows for a type: every parameter exactly once, in the type's rows or one row. */
export function rackRows(type: ModuleType): ParamSpec[][] {
  const specs = MODULE_PARAMS[type];
  const rows = RACK_ROWS[type];
  if (!rows) return [specs.slice()];
  const used = new Set<string>();
  const out = rows.map((r) =>
    r.flatMap((id) => {
      const s = specById(specs, id);
      if (!s || used.has(id)) return [];
      used.add(id);
      return [s];
    }),
  );
  const rest = specs.filter((s) => !used.has(s.id));
  if (rest.length) out.push(rest);
  return out.filter((r) => r.length > 0);
}

/** Every insertable effect that no group lists (should be none; such types go in a final "More" group). */
export function ungroupedEffects(): ModuleType[] {
  const grouped = new Set(EFFECT_GROUPS.flatMap((g) => g.types));
  return INSERTABLE_EFFECTS.filter((t) => !grouped.has(t));
}

/** The menu's groups, with any insertable type not listed above added under "More". */
export function menuGroups(): { id: string; label: string; types: readonly ModuleType[] }[] {
  const insertable = new Set(INSERTABLE_EFFECTS);
  const groups = EFFECT_GROUPS.map((g) => ({ ...g, types: g.types.filter((t) => insertable.has(t)) })).filter((g) => g.types.length > 0);
  const rest = ungroupedEffects();
  return rest.length ? [...groups, { id: 'more', label: 'More', types: rest }] : groups;
}
