/**
 * Catalogue of built-in sound identities. Ids are part of the saved-project
 * format: never rename an id, only add new ones.
 *
 * - Drum kit synthesis recipes live in src/audio/instruments/kits.ts.
 * - Synth preset parameter values live in src/content/presets.ts.
 * - Built-in sample generators live in src/audio/instruments/builtinSamples.ts.
 */
import type { InstrumentKind, TrackRole } from '../project/types';

export interface KitInfo {
  id: string;
  name: string;
  description: string;
}

export const KITS: readonly KitInfo[] = [
  { id: 'round-machine', name: 'Round Machine', description: 'Warm analog-style kit: deep round kick, noisy snare, silky hats.' },
  { id: 'tight-circuit', name: 'Tight Circuit', description: 'Short, punchy machine kit for house and techno.' },
  { id: 'dust-tape', name: 'Dust Tape', description: 'Soft, saturated, slightly lo-fi kit for downtempo and breaks.' },
  { id: 'bright-steel', name: 'Bright Steel', description: 'Crisp, snappy kit with bright metals for garage and drum & bass.' },
  { id: 'hand-percussion', name: 'Hand Percussion', description: 'Congas, bongos, shakers, woodblocks and bells for the percussion part.' },
];

/**
 * Standard 16-voice layout. Pad index 0 is the bottom-left pad of the 4×4
 * Drums grid. Every kit fills every slot with a sound of the stated role (the
 * hand-percussion kit substitutes percussion for kit pieces but keeps the
 * choke pair on slots 4/5).
 */
export const DRUM_SLOTS = [
  { slot: 0, role: 'kick', name: 'Kick' },
  { slot: 1, role: 'kick2', name: 'Kick 2' },
  { slot: 2, role: 'snare', name: 'Snare' },
  { slot: 3, role: 'clap', name: 'Clap' },
  { slot: 4, role: 'closedHat', name: 'Closed Hat' },
  { slot: 5, role: 'openHat', name: 'Open Hat' },
  { slot: 6, role: 'pedalHat', name: 'Shaker' },
  { slot: 7, role: 'rim', name: 'Rim' },
  { slot: 8, role: 'lowTom', name: 'Low Tom' },
  { slot: 9, role: 'midTom', name: 'Mid Tom' },
  { slot: 10, role: 'highTom', name: 'High Tom' },
  { slot: 11, role: 'bell', name: 'Cowbell' },
  { slot: 12, role: 'crash', name: 'Crash' },
  { slot: 13, role: 'ride', name: 'Ride' },
  { slot: 14, role: 'perc', name: 'Perc' },
  { slot: 15, role: 'fx', name: 'Snap FX' },
] as const;

/** Voices in the same choke group cut each other off (closed/pedal hat choke the open hat). */
export const CHOKE_GROUPS: readonly (readonly number[])[] = [[4, 5, 6]];

export interface PresetInfo {
  id: string;
  name: string;
  kind: Extract<InstrumentKind, 'bass' | 'poly'>;
  /** Roles this preset is suggested for in the preset browser. */
  roles: readonly TrackRole[];
  description: string;
}

export const SYNTH_PRESETS: readonly PresetInfo[] = [
  // Mono bass
  { id: 'bass-round-sub', name: 'Round Sub', kind: 'bass', roles: ['bass'], description: 'Soft, deep sine-and-sub bass that sits under everything.' },
  { id: 'bass-rubber-pluck', name: 'Rubber Pluck', kind: 'bass', roles: ['bass'], description: 'Bouncy square bass with a short filter pluck.' },
  { id: 'bass-acid-line', name: 'Acid Line', kind: 'bass', roles: ['bass', 'lead'], description: 'Resonant, squelchy saw line with glide.' },
  { id: 'bass-velvet-saw', name: 'Velvet Saw', kind: 'bass', roles: ['bass'], description: 'Rounded, filtered saw bass for driving eighth notes.' },
  { id: 'bass-organ-short', name: 'Short Organ', kind: 'bass', roles: ['bass'], description: 'Tight, hollow organ-style bass for shuffled grooves.' },
  { id: 'bass-dub-pressure', name: 'Dub Pressure', kind: 'bass', roles: ['bass'], description: 'Long, weighty sub with a touch of growl.' },
  // Poly: chords
  { id: 'poly-glass-keys', name: 'Glass Keys', kind: 'poly', roles: ['chords', 'lead'], description: 'Bell-like electric-piano keys.' },
  { id: 'poly-lumen-chords', name: 'Lumen Chords', kind: 'poly', roles: ['chords', 'pad'], description: 'Luminous detuned saw chords.' },
  { id: 'poly-house-stab', name: 'House Stab', kind: 'poly', roles: ['chords'], description: 'Punchy organ-like stab for off-beat chords.' },
  { id: 'poly-short-pluck', name: 'Short Pluck', kind: 'poly', roles: ['chords', 'lead'], description: 'Tight, bright pluck for short chord hits.' },
  // Poly: leads
  { id: 'poly-neon-lead', name: 'Neon Lead', kind: 'poly', roles: ['lead'], description: 'Bright saw-and-square lead with presence.' },
  { id: 'poly-soft-whistle', name: 'Soft Whistle', kind: 'poly', roles: ['lead'], description: 'Gentle, breathy sine lead.' },
  { id: 'poly-mallet-bell', name: 'Mallet Bell', kind: 'poly', roles: ['lead', 'chords'], description: 'Wooden mallet with a bell overtone, great for arpeggios.' },
  // Poly: pads
  { id: 'poly-halo-pad', name: 'Halo Pad', kind: 'poly', roles: ['pad'], description: 'Slow, wide, glowing saw pad.' },
  { id: 'poly-warm-drift', name: 'Warm Drift', kind: 'poly', roles: ['pad', 'chords'], description: 'Soft triangle pad that breathes in slowly.' },
  // Poly: textures
  { id: 'poly-air-grain', name: 'Air Grain', kind: 'poly', roles: ['texture'], description: 'Filtered noise and tone — wind and air.' },
  { id: 'poly-night-choir', name: 'Night Choir', kind: 'poly', roles: ['texture', 'pad'], description: 'Hollow, vocal-like drones.' },
  { id: 'poly-tape-shimmer', name: 'Tape Shimmer', kind: 'poly', roles: ['texture', 'pad'], description: 'High, sparkling layer with slow swell.' },
];

export interface BuiltinSampleInfo {
  id: string;
  name: string;
  description: string;
}

/** Built-in samples are generated on the device by original DSP code; nothing is downloaded. */
export const BUILTIN_SAMPLES: readonly BuiltinSampleInfo[] = [
  { id: 'builtin:glass-chord', name: 'Glass Chord', description: 'A bright minor-seventh chord hit.' },
  { id: 'builtin:tape-swell', name: 'Tape Swell', description: 'A reversed, wobbly swell that rises into the downbeat.' },
  { id: 'builtin:bell-hit', name: 'Bell Hit', description: 'A struck metal bell with a long tail.' },
  { id: 'builtin:noise-riser', name: 'Noise Riser', description: 'A one-bar filtered noise sweep for transitions.' },
  { id: 'builtin:vocal-oh', name: 'Vocal "Oh"', description: 'A synthetic formant "oh" chop.' },
];

export function kitInfo(id: string): KitInfo | undefined {
  return KITS.find((k) => k.id === id);
}
export function presetInfo(id: string): PresetInfo | undefined {
  return SYNTH_PRESETS.find((p) => p.id === id);
}
export function builtinSampleInfo(id: string): BuiltinSampleInfo | undefined {
  return BUILTIN_SAMPLES.find((s) => s.id === id);
}
