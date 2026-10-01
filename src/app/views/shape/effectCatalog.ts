/**
 * What the Shape view says about each insert effect, in plain words:
 * the purpose groups of the Add effect menu, a short description per menu
 * item, the sentence an effect card shows, the candidates for the one main
 * knob the Simple view gives each effect, and how the Advanced rack lays out
 * its knobs.
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

export interface EffectKnob {
  /** Parameter id. */
  id: string;
  /** What turning it does, in one short sentence that names the knob. */
  says: string;
}

export interface EffectInfo {
  /** One short line for the Add effect menu. */
  summary: string;
  /** What the effect does, in one plain sentence (names no knob). */
  does: string;
  /**
   * Candidates for the Simple card's one knob, best first. The card shows the
   * first one no macro controls, so turning it always changes the sound.
   */
  knobs: readonly EffectKnob[];
}

/** Plain descriptions and the main-knob candidates of every insertable effect. */
export const EFFECT_INFO: Partial<Record<ModuleType, EffectInfo>> = {
  eq: {
    summary: 'More or less bass, middle and treble.',
    does: 'Shapes the tone.',
    knobs: [
      { id: 'lowGain', says: 'Lows adds or removes bass and weight.' },
      { id: 'midGain', says: 'Mids brings the body of the sound forward or back.' },
      { id: 'highGain', says: 'Highs adds or removes sparkle.' },
    ],
  },
  filter: {
    summary: 'Makes the sound darker or thinner.',
    does: 'Removes part of the sound.',
    knobs: [
      { id: 'cutoff', says: 'Turn Cutoff down for a darker, softer tone.' },
      { id: 'resonance', says: 'Resonance adds a ringing peak where the filter cuts.' },
      { id: 'bright', says: 'Brightness adds or removes sparkle at the top.' },
    ],
  },
  compressor: {
    summary: 'Evens out loud and quiet moments for more punch.',
    does: 'Holds loud moments down for a tighter, punchier sound.',
    knobs: [
      { id: 'ratio', says: 'Squeeze sets how hard.' },
      { id: 'threshold', says: 'Lower the Threshold to squeeze more of the sound.' },
      { id: 'mix', says: 'Mix blends the squeezed sound with the untouched one.' },
    ],
  },
  gate: {
    summary: 'Silences the quiet bits: tighter, cleaner tails.',
    does: 'Silences the quiet bits, which cleans up noise and cuts tails short.',
    knobs: [
      { id: 'threshold', says: 'Everything quieter than the Threshold is silenced.' },
      { id: 'range', says: 'Depth sets how quiet the silenced bits get.' },
    ],
  },
  reverb: {
    summary: 'A room or hall around the sound.',
    does: 'Puts the sound in a room.',
    knobs: [
      { id: 'mix', says: 'Mix sets how much of the room you hear.' },
      { id: 'decay', says: 'Size goes from a small room to a huge hall.' },
      { id: 'tone', says: 'Tone makes the room darker or brighter.' },
    ],
  },
  delay: {
    summary: 'Echoes in time with the beat (a delay).',
    does: 'Repeats the sound in time with the beat.',
    knobs: [
      { id: 'mix', says: 'Mix sets how loud the echoes are.' },
      { id: 'feedback', says: 'Feedback sets how many times the echo repeats.' },
      { id: 'tone', says: 'Tone makes the echoes darker or brighter.' },
    ],
  },
  chorus: {
    summary: 'A wide, shimmering double of the sound.',
    does: 'Adds a wide, shimmering double of the sound.',
    knobs: [
      { id: 'mix', says: 'Mix sets how much.' },
      { id: 'depth', says: 'Depth sets how strong the shimmer is.' },
      { id: 'rate', says: 'Rate sets how fast it moves.' },
    ],
  },
  phaser: {
    summary: 'A slow, swirling sweep.',
    does: 'Sweeps a swirl through the sound.',
    knobs: [
      { id: 'mix', says: 'Mix sets how strong it is.' },
      { id: 'depth', says: 'Depth sets how wide the sweep is.' },
      { id: 'rate', says: 'Rate sets how fast it sweeps.' },
    ],
  },
  flanger: {
    summary: 'A sweeping, jet-plane whoosh.',
    does: 'Adds a sweeping, jet-plane whoosh.',
    knobs: [
      { id: 'mix', says: 'Mix sets how strong it is.' },
      { id: 'depth', says: 'Depth sets how wide the sweep is.' },
      { id: 'rate', says: 'Rate sets how fast it sweeps.' },
    ],
  },
  autopan: {
    summary: 'Swings the sound left and right in time.',
    does: 'Swings the sound from side to side in time with the beat.',
    knobs: [
      { id: 'depth', says: 'Depth sets how far.' },
      { id: 'division', says: 'Rate sets how often, in beats.' },
    ],
  },
  drive: {
    summary: 'Warmth first, then crunch and distortion.',
    does: 'Warms the sound up, then adds crunch.',
    knobs: [
      { id: 'amount', says: 'Turn Drive up for more grit.' },
      { id: 'tone', says: 'Tone tames or keeps the fizz the crunch adds.' },
      { id: 'mix', says: 'Mix blends the crunch with the clean sound.' },
    ],
  },
  tape: {
    summary: 'Warm tape saturation with a gentle wobble.',
    does: 'Gives the warm, slightly wobbly sound of an old tape machine.',
    knobs: [
      { id: 'drive', says: 'Saturation sets how warm.' },
      { id: 'wobble', says: 'Wobble sets how much the pitch drifts.' },
      { id: 'mix', says: 'Mix blends the tape sound with the clean one.' },
    ],
  },
  crusher: {
    summary: 'Gritty, lo-fi digital crunch.',
    does: 'Makes the sound gritty and lo-fi, like an old sampler.',
    knobs: [
      { id: 'downsample', says: 'Turn Lo-fi Rate up for more crunch.' },
      { id: 'bits', says: 'Fewer Bits make it grittier.' },
      { id: 'mix', says: 'Mix blends the crunch with the clean sound.' },
    ],
  },
  widener: {
    summary: 'Makes the sound wider or narrower.',
    does: 'Spreads the sound wider across the speakers, keeping the bass centred.',
    knobs: [
      { id: 'width', says: 'Width sets how wide.' },
      { id: 'monoBass', says: 'Mono Bass keeps the lows in the centre, for solid bass.' },
    ],
  },
};

/** Menu line for an effect type (falls back to the module catalogue). */
export function effectSummary(type: ModuleType): string {
  return EFFECT_INFO[type]?.summary ?? MODULE_DEFS[type].description;
}

/**
 * Card sentence for an effect type: what it does, then what its card knob
 * does (the given parameter, or the first candidate). Falls back to the
 * module catalogue.
 */
export function effectSentence(type: ModuleType, paramId?: string): string {
  const info = EFFECT_INFO[type];
  if (!info) return MODULE_DEFS[type].description;
  const knob = paramId === undefined ? info.knobs[0] : info.knobs.find((k) => k.id === paramId);
  return knob ? `${info.does} ${knob.says}` : info.does;
}

/** The specs that may be an effect card's one knob, best first (the first parameter when none are listed). */
export function mainKnobCandidates(type: ModuleType): ParamSpec[] {
  const specs = MODULE_PARAMS[type];
  const listed = (EFFECT_INFO[type]?.knobs ?? []).map((k) => specById(specs, k.id)).filter((s): s is ParamSpec => !!s);
  return listed.length ? listed : specs.slice(0, 1);
}

/** The preferred main knob's spec for an effect type (its first candidate). */
export function mainParamSpec(type: ModuleType): ParamSpec | undefined {
  return mainKnobCandidates(type)[0];
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
