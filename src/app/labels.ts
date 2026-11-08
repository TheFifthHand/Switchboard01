/** Display helpers shared by views. */
import { builtinSampleInfo, kitInfo, presetInfo } from '../content/catalog';
import type { Instrument, Project, Track, TrackRole } from '../project/types';

/* ------------------------------------------------------------------ */
/* What an instrument is called                                        */
/* ------------------------------------------------------------------ */

/** What a beginner calls each kind of instrument: the words of Simple's "+ Add instrument" picker. */
export const INSTRUMENT_WORDS: Readonly<Record<TrackRole, string>> = {
  drums: 'Drums',
  percussion: 'Percussion',
  bass: 'Bass',
  chords: 'Keys & chords',
  lead: 'Melody',
  pad: 'Pad',
  texture: 'Texture',
  sampler: 'Recording',
};

/** 2.4's default names for instruments whose Simple word differs ("Lead" is "Melody" in the picker). */
const OLD_DEFAULT_NAMES: Partial<Record<TrackRole, string>> = { chords: 'Chords', lead: 'Lead', sampler: 'Sampler' };

/**
 * The name Simple shows for an instrument (pure): the picker's word while it
 * still has 2.4's default name and was never renamed ("Lead" → "Melody",
 * "Chords" → "Keys & chords", "Sampler" → "Recording"), else its own name.
 * A part the person renamed shows that name as typed, even "Lead". Display
 * only: the project keeps its names, and Advanced shows them (trackNameIn).
 */
export function simpleTrackName(t: Pick<Track, 'name' | 'role' | 'renamed'>): string {
  return !t.renamed && OLD_DEFAULT_NAMES[t.role] === t.name ? INSTRUMENT_WORDS[t.role] : t.name;
}

/** An instrument's name as the given interface mode shows it: Simple's word, or (Advanced) the stored name. */
export function trackNameIn(t: Pick<Track, 'name' | 'role' | 'renamed'>, mode: 'simple' | 'advanced'): string {
  return mode === 'advanced' ? t.name : simpleTrackName(t);
}

export function soundName(project: Project, inst: Instrument): string {
  switch (inst.kind) {
    case 'drums':
      return kitInfo(inst.kitId)?.name ?? 'Drum kit';
    case 'bass':
    case 'poly':
      return presetInfo(inst.presetId)?.name ?? 'Synth';
    case 'sampler':
      if (!inst.sampleId) return 'No recording';
      return builtinSampleInfo(inst.sampleId)?.name ?? project.samples.find((s) => s.id === inst.sampleId)?.name ?? 'Recording';
  }
}

/* ------------------------------------------------------------------ */
/* Drum sounds in plain words                                          */
/* ------------------------------------------------------------------ */

/**
 * Simple's words for the kit sounds a beginner would not know by name
 * (drummer's shorthand: "Hat", "Tom", "Rim", "Crash"). A sound not listed
 * keeps its kit's name: Kick, Snare, Clap, Shaker, Cowbell, Conga, Tambourine…
 * read as they are, and the names of world instruments (Djembe, Cabasa) are
 * what those instruments are called. Advanced keeps every kit's own names.
 */
export const SIMPLE_DRUM_WORDS: Readonly<Record<string, string>> = {
  'Closed Hat': 'Closed hi-hat',
  'Open Hat': 'Open hi-hat',
  'Pedal Hat': 'Pedal hi-hat',
  Rim: 'Rim click',
  'Side Stick': 'Rim click',
  'Cross Stick': 'Rim click',
  Rimshot: 'Rim shot',
  'Low Tom': 'Low drum',
  'Mid Tom': 'Middle drum',
  'High Tom': 'High drum',
  Crash: 'Crash cymbal',
  'Noise Crash': 'Noise cymbal',
  Ride: 'Ride cymbal',
  'Ping Ride': 'Ping cymbal',
  Splash: 'Splash cymbal',
  '808': 'Deep kick',
  Perc: 'Extra hit',
  'Bongo Lo': 'Low bongo',
  'Bongo Hi': 'High bongo',
  'Agogo Lo': 'Low agogo bell',
  'Agogo Hi': 'High agogo bell',
  Agogo: 'Agogo bell',
  'Timbale Lo': 'Low timbale',
  'Timbale Hi': 'High timbale',
};

/** A kit sound's name in Simple's words ("Low Tom" → "Low drum"); other names as they are. */
export function simpleDrumName(name: string): string {
  return SIMPLE_DRUM_WORDS[name] ?? name;
}

/** A kit's sound names as `mode` shows them (Simple: plain words; Advanced: the kit's own names). */
export function drumNamesIn(names: readonly string[], mode: 'simple' | 'advanced'): string[] {
  return mode === 'advanced' ? [...names] : names.map(simpleDrumName);
}

export const INSTRUMENT_LABEL: Record<Instrument['kind'], string> = {
  drums: 'Drum kit',
  bass: 'Bass synth',
  poly: 'Synth',
  sampler: 'Sampler',
};

/** Short role glyphs for column headers. */
export const ROLE_SHORT: Record<TrackRole, string> = {
  drums: 'DRM',
  percussion: 'PRC',
  bass: 'BAS',
  chords: 'CHD',
  lead: 'LED',
  pad: 'PAD',
  texture: 'TEX',
  sampler: 'SMP',
};

export function barsLabel(bars: number): string {
  return bars === 1 ? '1 bar' : `${bars} bars`;
}
