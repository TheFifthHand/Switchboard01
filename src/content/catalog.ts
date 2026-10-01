/**
 * Catalogue of built-in sound identities. Ids are part of the saved-project
 * format: never rename an id, only add new ones.
 *
 * - Drum kit synthesis recipes live in src/audio/instruments/kits.ts.
 * - Synth preset parameter values live in src/content/presets.ts.
 * - Built-in sample generators live in src/audio/instruments/builtinSamples.ts.
 *
 * Every sound belongs to one browser category (SOUND_CATEGORIES) and carries
 * a one-line description and a few search tags (plain words a musician
 * might type: "piano", "808", "strings", "riser"...).
 */
import type { InstrumentKind, TrackRole } from '../project/types';

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

export type SoundCategory = 'drums' | 'bass' | 'keys' | 'pads' | 'leads' | 'plucks' | 'textures' | 'recordings';

export interface SoundCategoryInfo {
  id: SoundCategory;
  name: string;
  /** One line under the category heading. */
  blurb: string;
}

/** The sound browser's categories, in display order. */
export const SOUND_CATEGORIES: readonly SoundCategoryInfo[] = [
  { id: 'drums', name: 'Drums & Percussion', blurb: 'Drum kits and percussion sets: sixteen sounds on the pads.' },
  { id: 'bass', name: 'Bass', blurb: 'Low lines: subs, 808s, plucks, acid, reese and FM basses.' },
  { id: 'keys', name: 'Keys', blurb: 'Electric pianos, organs, clavinet and harpsichord.' },
  { id: 'pads', name: 'Pads & Strings', blurb: 'Long, soft chords: pads, string ensembles and choirs.' },
  { id: 'leads', name: 'Leads', blurb: 'Melodies that sing on top: synth leads, brass and winds.' },
  { id: 'plucks', name: 'Plucks & Bells', blurb: 'Short, struck and plucked notes: bells, mallets, kalimba, harp.' },
  { id: 'textures', name: 'Textures & FX', blurb: 'Atmospheres, drones, risers, zaps and noise sweeps.' },
  { id: 'recordings', name: 'Recordings', blurb: 'Built-in recordings and your own WAV or MP3 files, played by the sampler.' },
];

/* ------------------------------------------------------------------ */
/* Drum kits                                                           */
/* ------------------------------------------------------------------ */

export interface KitInfo {
  id: string;
  name: string;
  description: string;
  /**
   * Kit Level (dB) that matches this kit to the synth presets. The
   * synthesized kits are peak-normalised, so at 0 dB a typical beat plays
   * 10-13 dB hotter than a synth part; a part switched to this kit starts
   * here, and double-clicking the kit's Level knob returns here.
   */
  level: number;
  /**
   * 'kit': the standard drum-kit layout (kick, snare, hats, toms, cymbals on
   * their usual pads). 'percussion': hand drums and small percussion.
   */
  family: 'kit' | 'percussion';
  tags: readonly string[];
}

export const KITS: readonly KitInfo[] = [
  { id: 'round-machine', name: 'Round Machine', description: 'Warm analog-style kit: deep round kick, noisy snare, silky hats.', level: -11, family: 'kit', tags: ['analog', 'warm', 'house', 'pop'] },
  { id: 'tight-circuit', name: 'Tight Circuit', description: 'Short, punchy machine kit for house and techno.', level: -11, family: 'kit', tags: ['techno', 'house', 'punchy', 'machine'] },
  { id: 'dust-tape', name: 'Dust Tape', description: 'Soft, saturated, slightly lo-fi kit for downtempo and breaks.', level: -11, family: 'kit', tags: ['lofi', 'tape', 'downtempo', 'hip hop'] },
  { id: 'bright-steel', name: 'Bright Steel', description: 'Crisp, snappy kit with bright metals for garage and drum & bass.', level: -11, family: 'kit', tags: ['garage', 'dnb', 'jungle', 'crisp', 'bright'] },
  // Sparser, quieter hits: less trim for the same loudness.
  { id: 'hand-percussion', name: 'Hand Percussion', description: 'Congas, bongos, shakers, woodblocks and bells for the percussion part.', level: -4.5, family: 'percussion', tags: ['congas', 'bongos', 'shaker', 'latin', 'world'] },
  { id: 'boom-808', name: '808 Machine', description: 'Classic drum-machine kit: long booming kick, snappy snare, sizzling hats and cowbell.', level: -12, family: 'kit', tags: ['808', 'hip hop', 'electro', 'classic', 'machine'] },
  { id: 'punch-909', name: '909 Punch', description: 'Hard-hitting machine kit: clicky punchy kick, noisy snare and bright cymbals.', level: -11, family: 'kit', tags: ['909', 'house', 'techno', 'classic', 'machine'] },
  { id: 'trap-night', name: 'Trap Night', description: 'Trap kit: hard kick, long distorted 808 on Kick 2, crisp snare and tight hats for rolls.', level: -9.6, family: 'kit', tags: ['trap', '808', 'hip hop', 'drill', 'rolls'] },
  { id: 'lofi-crate', name: 'Lo-fi Crate', description: 'Crunchy, dusty, heavily crushed kit that sounds sampled from an old record.', level: -8.6, family: 'kit', tags: ['lofi', 'hip hop', 'dusty', 'crushed', 'chill'] },
  { id: 'studio-acoustic', name: 'Studio Acoustic', description: 'Natural-sounding drum set: woody kick, ringing snare, real-feel hats, toms and cymbals.', level: -8.4, family: 'kit', tags: ['acoustic', 'live', 'rock', 'pop', 'natural', 'real'] },
  { id: 'electro-wire', name: 'Electro Wire', description: 'Zappy electro kit: synthetic kick, laser toms, metallic hats and blips.', level: -10.6, family: 'kit', tags: ['electro', 'synthetic', 'zaps', 'retro', 'machine'] },
  { id: 'iron-forge', name: 'Iron Forge', description: 'Industrial kit: distorted kick, clanging metal snare, harsh hats and anvil hits.', level: -12, family: 'kit', tags: ['industrial', 'distorted', 'metal', 'techno', 'dark'] },
  { id: 'minimal-click', name: 'Minimal Click', description: 'Tiny, dry, clicky sounds for minimal techno and microhouse.', level: -8, family: 'kit', tags: ['minimal', 'clicks', 'micro', 'techno', 'dry'] },
  { id: 'break-crate', name: 'Breakbeat Crate', description: 'Punchy, compressed funk-break drums with a cracking snare and roomy cymbals.', level: -9.1, family: 'kit', tags: ['breaks', 'breakbeat', 'funk', 'jungle', 'hip hop'] },
  { id: 'afro-latin', name: 'Afro Latin', description: 'Djembe, talking drum, surdo, timbales, shekere, agogo and claves.', level: -8, family: 'percussion', tags: ['afro', 'latin', 'world', 'djembe', 'samba', 'percussion'] },
];

/**
 * Standard 16-voice layout. Pad index 0 is the bottom-left pad of the 4×4
 * Drums grid. Every standard kit fills every slot with a sound of the stated
 * role (percussion kits substitute percussion for kit pieces). Which slots
 * choke each other is part of each kit's recipe (kits.ts chokeGroups).
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

/* ------------------------------------------------------------------ */
/* Synth presets                                                       */
/* ------------------------------------------------------------------ */

export type SynthCategory = Exclude<SoundCategory, 'drums' | 'recordings'>;

export interface PresetInfo {
  id: string;
  name: string;
  kind: Extract<InstrumentKind, 'bass' | 'poly'>;
  /** Browser category. */
  category: SynthCategory;
  /** Roles this preset suits (first = its main role). */
  roles: readonly TrackRole[];
  description: string;
  tags: readonly string[];
}

const preset = (
  id: string,
  name: string,
  kind: PresetInfo['kind'],
  category: SynthCategory,
  roles: readonly TrackRole[],
  description: string,
  tags: readonly string[],
): PresetInfo => ({ id, name, kind, category, roles, description, tags });

export const SYNTH_PRESETS: readonly PresetInfo[] = [
  /* ---------------- Bass ---------------- */
  preset('bass-round-sub', 'Round Sub', 'bass', 'bass', ['bass'], 'Soft, deep sine-and-sub bass that sits under everything.', ['sub', 'deep', 'sine', 'soft']),
  preset('bass-rubber-pluck', 'Rubber Pluck', 'bass', 'bass', ['bass'], 'Bouncy square bass with a short filter pluck.', ['pluck', 'square', 'bouncy', 'house']),
  preset('bass-acid-line', 'Acid Line', 'bass', 'bass', ['bass', 'lead'], 'Resonant, squelchy saw line with glide.', ['acid', '303', 'squelch', 'techno', 'resonant']),
  preset('bass-velvet-saw', 'Velvet Saw', 'bass', 'bass', ['bass'], 'Rounded, filtered saw bass for driving eighth notes.', ['saw', 'synthwave', 'driving', 'warm']),
  preset('bass-organ-short', 'Short Organ', 'bass', 'bass', ['bass'], 'Tight, hollow organ-style bass for shuffled grooves.', ['organ', 'garage', 'hollow', 'short']),
  preset('bass-dub-pressure', 'Dub Pressure', 'bass', 'bass', ['bass'], 'Long, weighty sub with a touch of growl.', ['dub', 'sub', 'weighty', 'reggae']),
  preset('bass-808-boom', '808 Boom', 'bass', 'bass', ['bass'], 'Long, deep 808-style boom that drops into pitch and slides between notes.', ['808', 'trap', 'hip hop', 'boom', 'sub', 'slide']),
  preset('bass-reese', 'Reese', 'bass', 'bass', ['bass'], 'Dark, thick detuned saws that slowly phase against each other.', ['reese', 'dnb', 'jungle', 'dubstep', 'detuned', 'dark']),
  preset('bass-fm-slap', 'FM Slap', 'bass', 'bass', ['bass'], 'Punchy FM bass with a bright slap on every note.', ['fm', 'slap', 'funk', 'synth pop', 'punchy']),
  preset('bass-finger', 'Finger Bass', 'bass', 'bass', ['bass'], 'Round, woody electric-bass-style pluck for live-feeling lines.', ['electric bass', 'finger', 'funk', 'live', 'woody']),
  preset('bass-pure-sub', 'Pure Sub', 'bass', 'bass', ['bass'], 'Clean sine sub, felt more than heard: pair it with a brighter part.', ['sub', 'sine', 'clean', 'deep', 'dubstep']),
  preset('bass-growl', 'Growl', 'bass', 'bass', ['bass'], 'Aggressive, gritty FM-and-saw bass with a vocal filter edge.', ['growl', 'fm', 'dubstep', 'aggressive', 'distorted']),
  preset('bass-zap', 'Zap Bass', 'bass', 'bass', ['bass'], 'Electro bass with a laser zap at the start of every note.', ['electro', 'zap', 'laser', 'square', 'retro']),
  preset('bass-deep-pulse', 'Deep Pulse', 'bass', 'bass', ['bass'], 'Soft, rounded minimal-techno bass with a gentle filter bloom and slide.', ['minimal', 'techno', 'deep', 'round', 'slide']),

  /* ---------------- Keys ---------------- */
  preset('poly-glass-keys', 'Glass Keys', 'poly', 'keys', ['chords', 'lead'], 'Bell-like electric-piano keys.', ['electric piano', 'bell', 'glassy', 'chords']),
  preset('poly-house-stab', 'House Stab', 'poly', 'keys', ['chords'], 'Punchy organ-like stab for off-beat chords.', ['organ', 'stab', 'house', 'chords']),
  preset('poly-tine-piano', 'Tine Piano', 'poly', 'keys', ['chords', 'lead'], 'Warm electric piano: mellow when played gently, a bell-like bark when hit hard.', ['electric piano', 'rhodes', 'soul', 'jazz', 'fm']),
  preset('poly-crystal-ep', 'Crystal EP', 'poly', 'keys', ['chords', 'lead'], 'Glassy 80s digital electric piano with a sparkling tine on top.', ['electric piano', '80s', 'dx', 'fm', 'ballad']),
  preset('poly-drawbar-organ', 'Drawbar Organ', 'poly', 'keys', ['chords'], 'Full, steady tonewheel-style organ with a gentle vibrato.', ['organ', 'gospel', 'jazz', 'drawbar', 'hammond']),
  preset('poly-click-organ', 'Click Organ', 'poly', 'keys', ['chords'], 'Percussive jazz organ with a key click and a bright harmonic ping.', ['organ', 'percussive', 'jazz', 'click']),
  preset('poly-funky-clav', 'Funky Clav', 'poly', 'keys', ['chords', 'lead'], 'Snappy, nasal clavinet-style keys for funky off-beat stabs.', ['clavinet', 'clav', 'funk', 'stab']),
  preset('poly-reed-piano', 'Reed Piano', 'poly', 'keys', ['chords'], 'Buzzy, warm reed-style electric piano that growls when played hard.', ['electric piano', 'wurlitzer', 'soul', 'warm']),
  preset('poly-harpsichord', 'Harpsichord', 'poly', 'keys', ['chords', 'lead'], 'Bright, plucked baroque keys with a crisp jangle.', ['harpsichord', 'baroque', 'plucked', 'classical']),
  preset('poly-felt-piano', 'Felt Piano', 'poly', 'keys', ['chords'], 'Soft, muted, intimate piano tone for lo-fi and ambient chords.', ['piano', 'felt', 'soft', 'lofi', 'ambient']),

  /* ---------------- Pads & strings ---------------- */
  preset('poly-lumen-chords', 'Lumen Chords', 'poly', 'pads', ['chords', 'pad'], 'Luminous detuned saw chords.', ['chords', 'saw', 'detuned', 'bright']),
  preset('poly-halo-pad', 'Halo Pad', 'poly', 'pads', ['pad'], 'Slow, wide, glowing saw pad.', ['pad', 'wide', 'slow', 'warm']),
  preset('poly-warm-drift', 'Warm Drift', 'poly', 'pads', ['pad', 'chords'], 'Soft triangle pad that breathes in slowly.', ['pad', 'soft', 'warm', 'ambient']),
  preset('poly-night-choir', 'Night Choir', 'poly', 'pads', ['texture', 'pad'], 'Hollow, vocal-like drones.', ['choir', 'vocal', 'drone', 'dark']),
  preset('poly-supersaw-pad', 'Supersaw Pad', 'poly', 'pads', ['pad', 'chords'], 'Huge, wide stack of detuned saws for trance and anthem chords.', ['supersaw', 'trance', 'huge', 'unison', 'edm']),
  preset('poly-string-ensemble', 'String Ensemble', 'poly', 'pads', ['pad', 'chords'], 'Lush vintage string-machine ensemble with a soft attack and gentle shimmer.', ['strings', 'ensemble', 'vintage', 'disco', 'lush']),
  preset('poly-cinematic-strings', 'Cinematic Strings', 'poly', 'pads', ['pad'], 'Slow, warm orchestral-style strings that swell in and sing.', ['strings', 'orchestral', 'cinematic', 'film', 'violin']),
  preset('poly-glass-pad', 'Glass Pad', 'poly', 'pads', ['pad'], 'Crystalline FM pad with a cool, glassy shimmer.', ['glass', 'fm', 'crystal', 'cold', 'ambient']),
  preset('poly-velvet-pad', 'Velvet Pad', 'poly', 'pads', ['pad'], 'Dark, soft and round: fills the low middle without glare.', ['dark', 'soft', 'warm', 'pad']),
  preset('poly-choir-ooh', 'Choir Ooh', 'poly', 'pads', ['pad'], 'Soft synthetic "ooh" voices with breath and vibrato.', ['choir', 'voices', 'ooh', 'vocal', 'breath']),
  preset('poly-analog-pad', 'Analog Drift Pad', 'poly', 'pads', ['pad', 'chords'], 'Classic polysynth pad where every note drifts a little, like old hardware.', ['analog', 'vintage', '80s', 'drift', 'pad']),
  preset('poly-breath-pad', 'Breath Pad', 'poly', 'pads', ['pad'], 'Airy pad: soft tones wrapped in bright, breathy air.', ['air', 'breath', 'airy', 'ambient', 'soft']),

  /* ---------------- Leads ---------------- */
  preset('poly-neon-lead', 'Neon Lead', 'poly', 'leads', ['lead'], 'Bright saw-and-square lead with presence.', ['saw', 'bright', 'synthwave', 'lead']),
  preset('poly-soft-whistle', 'Soft Whistle', 'poly', 'leads', ['lead'], 'Gentle, breathy sine lead.', ['whistle', 'sine', 'soft', 'breathy']),
  preset('poly-supersaw-lead', 'Supersaw Lead', 'poly', 'leads', ['lead'], 'Bright, soaring trance lead from a stack of detuned saws.', ['supersaw', 'trance', 'edm', 'unison', 'big']),
  preset('poly-chip-lead', 'Chip Lead', 'poly', 'leads', ['lead'], 'Pure, buzzy square-wave lead straight from an old game console.', ['chiptune', '8-bit', 'game', 'square', 'retro']),
  preset('poly-saw-scream', 'Saw Scream', 'poly', 'leads', ['lead'], 'Aggressive, resonant lead with a screaming filter edge.', ['aggressive', 'resonant', 'scream', 'rave', 'saw']),
  preset('poly-wooden-flute', 'Wooden Flute', 'poly', 'leads', ['lead'], 'Breathy, hollow flute-like lead with a gentle vibrato.', ['flute', 'wind', 'woodwind', 'breathy', 'pan pipe']),
  preset('poly-soft-reed', 'Soft Reed', 'poly', 'leads', ['lead'], 'Hollow, woody reed lead in the spirit of a clarinet.', ['clarinet', 'reed', 'woodwind', 'wind', 'hollow']),
  preset('poly-synth-brass', 'Synth Brass', 'poly', 'leads', ['lead', 'chords'], 'Bold 80s-style synth brass with a little scoop into every note.', ['brass', '80s', 'horns', 'bold', 'synthwave']),
  preset('poly-brass-stab', 'Brass Stab', 'poly', 'leads', ['chords', 'lead'], 'Short, punchy brass-section hits for stabs and fanfares.', ['brass', 'stab', 'horns', 'section', 'funk']),
  preset('poly-fm-lead', 'FM Lead', 'poly', 'leads', ['lead'], 'Hollow, singing FM lead with a reedy edge.', ['fm', 'hollow', 'singing', 'digital']),

  /* ---------------- Plucks & bells ---------------- */
  preset('poly-short-pluck', 'Short Pluck', 'poly', 'plucks', ['chords', 'lead'], 'Tight, bright pluck for short chord hits.', ['pluck', 'short', 'bright', 'house']),
  preset('poly-mallet-bell', 'Mallet Bell', 'poly', 'plucks', ['lead', 'chords'], 'Wooden mallet with a bell overtone, great for arpeggios.', ['mallet', 'bell', 'arpeggio', 'wooden']),
  preset('poly-kalimba', 'Kalimba', 'poly', 'plucks', ['lead', 'chords'], 'Warm thumb-piano pluck with a soft metallic tine.', ['kalimba', 'thumb piano', 'mbira', 'world', 'tine']),
  preset('poly-marimba', 'Marimba', 'poly', 'plucks', ['lead', 'chords'], 'Wooden marimba with a soft mallet knock and short, round notes.', ['marimba', 'mallet', 'wooden', 'xylophone', 'tropical']),
  preset('poly-vibraphone', 'Vibraphone', 'poly', 'plucks', ['chords', 'lead'], 'Soft, ringing vibraphone with a slow shimmer.', ['vibraphone', 'vibes', 'jazz', 'mallet', 'ringing']),
  preset('poly-tubular-bell', 'Tubular Bell', 'poly', 'plucks', ['lead'], 'Big, clanging church-style bell with a long, inharmonic ring.', ['bell', 'church', 'chime', 'tubular', 'fm']),
  preset('poly-glockenspiel', 'Glockenspiel', 'poly', 'plucks', ['lead'], 'Bright, high, sparkling glockenspiel for melodies that cut through.', ['glockenspiel', 'glock', 'bells', 'sparkle', 'celesta']),
  preset('poly-music-box', 'Music Box', 'poly', 'plucks', ['lead'], 'Delicate, tinkling music-box notes, a little imperfectly tuned.', ['music box', 'toy', 'lullaby', 'delicate', 'tinkle']),
  preset('poly-harp', 'Harp', 'poly', 'plucks', ['chords', 'lead'], 'Gentle plucked harp strings that ring out softly.', ['harp', 'plucked', 'strings', 'gentle', 'arpeggio']),
  preset('poly-steel-drum', 'Steel Drum', 'poly', 'plucks', ['lead'], 'Bright Caribbean steel-pan tone with a quick metallic attack.', ['steel drum', 'steelpan', 'caribbean', 'tropical', 'calypso']),
  preset('poly-koto-pluck', 'Koto Pluck', 'poly', 'plucks', ['lead'], 'Twangy plucked string with a tiny pitch snap, inspired by the koto.', ['koto', 'plucked', 'string', 'twang', 'world']),

  /* ---------------- Textures & FX ---------------- */
  preset('poly-air-grain', 'Air Grain', 'poly', 'textures', ['texture'], 'Filtered noise and tone — wind and air.', ['wind', 'air', 'noise', 'atmosphere']),
  preset('poly-tape-shimmer', 'Tape Shimmer', 'poly', 'textures', ['texture', 'pad'], 'High, sparkling layer with slow swell.', ['shimmer', 'sparkle', 'high', 'tape']),
  preset('poly-sweep-riser', 'Sweep Riser', 'poly', 'textures', ['texture'], 'A rising sweep of noise and tones for build-ups: hold a note for about four seconds.', ['riser', 'build up', 'sweep', 'uplifter', 'transition']),
  preset('poly-downlifter', 'Downlifter', 'poly', 'textures', ['texture'], 'A falling whoosh after a drop or at the end of a section.', ['downlifter', 'fall', 'whoosh', 'transition', 'sweep']),
  preset('poly-dark-drone', 'Dark Drone', 'poly', 'textures', ['texture', 'pad'], 'Deep, brooding drone that slowly churns underneath everything.', ['drone', 'dark', 'cinematic', 'horror', 'ambient']),
  preset('poly-ocean-wash', 'Ocean Wash', 'poly', 'textures', ['texture'], 'Dark, rolling noise like distant waves; Motion makes it surge.', ['ocean', 'waves', 'sea', 'noise', 'ambient']),
  preset('poly-laser-zap', 'Laser Zap', 'poly', 'textures', ['texture', 'lead'], 'Sci-fi laser shot: a fast pitch dive on every note.', ['laser', 'zap', 'sci-fi', 'fx', 'shot']),
  preset('poly-metal-clang', 'Metal Clang', 'poly', 'textures', ['texture'], 'Harsh, industrial metal hit: clanging and inharmonic.', ['metal', 'clang', 'industrial', 'hit', 'fm']),
  preset('poly-scifi-chirp', 'Sci-Fi Chirp', 'poly', 'textures', ['texture', 'lead'], 'Bubbly, chirping computer noises for intros and fills.', ['sci-fi', 'chirp', 'robot', 'computer', 'bubbles']),
  preset('poly-warped-tape', 'Warped Tape', 'poly', 'textures', ['texture', 'pad'], 'Wobbly, worn-out tape tones: detuned, hissy and nostalgic.', ['tape', 'wobble', 'lofi', 'vintage', 'nostalgic']),
];

/* ------------------------------------------------------------------ */
/* Built-in recordings                                                 */
/* ------------------------------------------------------------------ */

export interface BuiltinSampleInfo {
  id: string;
  name: string;
  description: string;
  tags: readonly string[];
}

/** Built-in samples are generated on the device by original DSP code; nothing is downloaded. */
export const BUILTIN_SAMPLES: readonly BuiltinSampleInfo[] = [
  { id: 'builtin:glass-chord', name: 'Glass Chord', description: 'A bright minor-seventh chord hit.', tags: ['chord', 'stab', 'hit'] },
  { id: 'builtin:tape-swell', name: 'Tape Swell', description: 'A reversed, wobbly swell that rises into the downbeat.', tags: ['reverse', 'swell', 'riser', 'tape'] },
  { id: 'builtin:bell-hit', name: 'Bell Hit', description: 'A struck metal bell with a long tail.', tags: ['bell', 'hit', 'metal'] },
  { id: 'builtin:noise-riser', name: 'Noise Riser', description: 'A one-bar filtered noise sweep for transitions.', tags: ['riser', 'noise', 'sweep', 'transition'] },
  { id: 'builtin:vocal-oh', name: 'Vocal "Oh"', description: 'A synthetic formant "oh" chop.', tags: ['vocal', 'voice', 'chop', 'oh'] },
];

/* ------------------------------------------------------------------ */
/* Lookup and search                                                   */
/* ------------------------------------------------------------------ */

export function kitInfo(id: string): KitInfo | undefined {
  return KITS.find((k) => k.id === id);
}
export function presetInfo(id: string): PresetInfo | undefined {
  return SYNTH_PRESETS.find((p) => p.id === id);
}
export function builtinSampleInfo(id: string): BuiltinSampleInfo | undefined {
  return BUILTIN_SAMPLES.find((s) => s.id === id);
}
export function soundCategoryInfo(id: SoundCategory): SoundCategoryInfo {
  return SOUND_CATEGORIES.find((c) => c.id === id) as SoundCategoryInfo;
}

/** One entry of the built-in sound library (kits, presets, recordings). */
export interface CatalogSound {
  kind: InstrumentKind;
  id: string;
  name: string;
  description: string;
  category: SoundCategory;
  tags: readonly string[];
  roles: readonly TrackRole[];
}

/** Every built-in sound, in category order (drums, synths by category, recordings). */
export const ALL_SOUNDS: readonly CatalogSound[] = [
  ...KITS.map((k): CatalogSound => ({ kind: 'drums', id: k.id, name: k.name, description: k.description, category: 'drums', tags: [...k.tags, k.family === 'kit' ? 'drum kit' : 'percussion'], roles: k.family === 'kit' ? ['drums'] : ['percussion'] })),
  ...SOUND_CATEGORIES.flatMap((c) => SYNTH_PRESETS.filter((p) => p.category === c.id)).map((p): CatalogSound => ({ kind: p.kind, id: p.id, name: p.name, description: p.description, category: p.category, tags: p.tags, roles: p.roles })),
  ...BUILTIN_SAMPLES.map((s): CatalogSound => ({ kind: 'sampler', id: s.id, name: s.name, description: s.description, category: 'recordings', tags: s.tags, roles: ['sampler'] })),
];

/** The browser category of a sound, or undefined for an unknown id. */
export function categoryOfSound(kind: InstrumentKind, id: string | null): SoundCategory | undefined {
  if (kind === 'drums') return 'drums';
  if (kind === 'sampler') return 'recordings';
  return id ? presetInfo(id)?.category : undefined;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Words in category names that are also instruments (they search as instruments, not as the category). */
const CATEGORY_INSTRUMENT_WORDS = new Set(['strings', 'bells', 'percussion']);

/**
 * Relevance of a sound for a search query (0 = no match). Every word of the
 * query must start a word of the name, a tag or the description (so "pian"
 * finds pianos), or be a word naming the category ("keys", "pads"); name
 * matches rank highest.
 */
export function soundMatchScore(sound: Pick<CatalogSound, 'name' | 'description' | 'tags' | 'category'>, query: string): number {
  const q = normalize(query);
  const words = q.split(' ').filter(Boolean);
  if (words.length === 0) return 1;
  const name = ` ${normalize(sound.name)}`;
  const tags = sound.tags.map((t) => ` ${normalize(t)}`);
  // A category matches only by a whole word that names the category itself ("keys", "pads", "fx"),
  // not by the instrument words in its name: "strings" or "bells" should find strings and bells.
  const cat = normalize(soundCategoryInfo(sound.category).name)
    .split(' ')
    .filter((w) => !CATEGORY_INSTRUMENT_WORDS.has(w));
  const desc = ` ${normalize(sound.description)}`;
  let score = 0;
  // The whole phrase at the start of the name or a tag ("music box", "electric piano").
  if (name.startsWith(` ${q}`)) score += 6;
  if (tags.some((t) => t.startsWith(` ${q}`))) score += 4;
  for (const w of words) {
    const at = ` ${w}`;
    if (name.includes(at)) score += 8;
    else if (tags.some((t) => t.includes(at))) score += 5;
    else if (cat.includes(w)) score += 3;
    else if (desc.includes(at)) score += 2;
    else return 0;
  }
  return score;
}
