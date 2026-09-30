/**
 * Chord helpers (pure, architecture layer 1): diatonic chords on scale
 * degrees, chord-symbol parsing for authoring ("Am7", "Fmaj7", "C/E"),
 * chord naming, inversions, voicings inside a register and voice leading.
 *
 * Octave numbers follow scales.ts (C4 = 60): a chord "at octave 3" has its
 * root in the octave starting at C3 = 48.
 */
import type { ScaleId } from '../project/types';
import { MIDI_MAX, MIDI_MIN, ROOT_NAMES, SCALES, pitchClass } from './scales';

/* ------------------------------------------------------------------ */
/* Chord qualities                                                     */
/* ------------------------------------------------------------------ */

export type ChordQuality =
  | 'maj'
  | 'min'
  | 'dim'
  | 'aug'
  | 'sus2'
  | 'sus4'
  | '5'
  | '6'
  | 'm6'
  | '7'
  | 'maj7'
  | 'm7'
  | 'mMaj7'
  | 'm7b5'
  | 'dim7'
  | '7sus4'
  | 'add9'
  | 'madd9'
  | '9'
  | 'maj9'
  | 'm9'
  | 'm11';

export interface ChordQualityDef {
  /** Semitones above the chord root (may exceed 12 for extensions). */
  intervals: readonly number[];
  /** Suffix used when writing the symbol ("" for major, "m7", ...). */
  suffix: string;
  /** Roman-numeral style: is the third minor/diminished (lower-case numeral)? */
  minorish: boolean;
  /** Roman-numeral suffix ("°", "+", "7", "ø7", ...). */
  roman: string;
}

export const CHORD_QUALITIES: Record<ChordQuality, ChordQualityDef> = {
  maj: { intervals: [0, 4, 7], suffix: '', minorish: false, roman: '' },
  min: { intervals: [0, 3, 7], suffix: 'm', minorish: true, roman: '' },
  dim: { intervals: [0, 3, 6], suffix: 'dim', minorish: true, roman: '°' },
  aug: { intervals: [0, 4, 8], suffix: 'aug', minorish: false, roman: '+' },
  sus2: { intervals: [0, 2, 7], suffix: 'sus2', minorish: false, roman: 'sus2' },
  sus4: { intervals: [0, 5, 7], suffix: 'sus4', minorish: false, roman: 'sus4' },
  '5': { intervals: [0, 7], suffix: '5', minorish: false, roman: '5' },
  '6': { intervals: [0, 4, 7, 9], suffix: '6', minorish: false, roman: '6' },
  m6: { intervals: [0, 3, 7, 9], suffix: 'm6', minorish: true, roman: '6' },
  '7': { intervals: [0, 4, 7, 10], suffix: '7', minorish: false, roman: '7' },
  maj7: { intervals: [0, 4, 7, 11], suffix: 'maj7', minorish: false, roman: 'maj7' },
  m7: { intervals: [0, 3, 7, 10], suffix: 'm7', minorish: true, roman: '7' },
  mMaj7: { intervals: [0, 3, 7, 11], suffix: 'mMaj7', minorish: true, roman: 'maj7' },
  m7b5: { intervals: [0, 3, 6, 10], suffix: 'm7b5', minorish: true, roman: 'ø7' },
  dim7: { intervals: [0, 3, 6, 9], suffix: 'dim7', minorish: true, roman: '°7' },
  '7sus4': { intervals: [0, 5, 7, 10], suffix: '7sus4', minorish: false, roman: '7sus4' },
  add9: { intervals: [0, 4, 7, 14], suffix: 'add9', minorish: false, roman: 'add9' },
  madd9: { intervals: [0, 3, 7, 14], suffix: 'madd9', minorish: true, roman: 'add9' },
  '9': { intervals: [0, 4, 7, 10, 14], suffix: '9', minorish: false, roman: '9' },
  maj9: { intervals: [0, 4, 7, 11, 14], suffix: 'maj9', minorish: false, roman: 'maj9' },
  m9: { intervals: [0, 3, 7, 10, 14], suffix: 'm9', minorish: true, roman: '9' },
  m11: { intervals: [0, 3, 7, 10, 14, 17], suffix: 'm11', minorish: true, roman: '11' },
};

/** Accepted spellings (case-sensitive: "M7" is major seventh, "m7" minor seventh). */
const QUALITY_ALIASES: Record<string, ChordQuality> = {
  '': 'maj',
  M: 'maj',
  maj: 'maj',
  major: 'maj',
  m: 'min',
  min: 'min',
  minor: 'min',
  '-': 'min',
  dim: 'dim',
  '°': 'dim',
  o: 'dim',
  aug: 'aug',
  '+': 'aug',
  sus2: 'sus2',
  sus4: 'sus4',
  sus: 'sus4',
  '5': '5',
  '6': '6',
  maj6: '6',
  M6: '6',
  m6: 'm6',
  min6: 'm6',
  '-6': 'm6',
  '7': '7',
  dom7: '7',
  maj7: 'maj7',
  M7: 'maj7',
  ma7: 'maj7',
  'Δ': 'maj7',
  'Δ7': 'maj7',
  m7: 'm7',
  min7: 'm7',
  '-7': 'm7',
  mMaj7: 'mMaj7',
  mM7: 'mMaj7',
  'm(maj7)': 'mMaj7',
  minMaj7: 'mMaj7',
  m7b5: 'm7b5',
  'm7(b5)': 'm7b5',
  min7b5: 'm7b5',
  '-7b5': 'm7b5',
  'ø': 'm7b5',
  'ø7': 'm7b5',
  dim7: 'dim7',
  '°7': 'dim7',
  o7: 'dim7',
  '7sus4': '7sus4',
  '7sus': '7sus4',
  add9: 'add9',
  add2: 'add9',
  madd9: 'madd9',
  'm(add9)': 'madd9',
  '9': '9',
  maj9: 'maj9',
  M9: 'maj9',
  m9: 'm9',
  min9: 'm9',
  '-9': 'm9',
  m11: 'm11',
  min11: 'm11',
  '-11': 'm11',
};

export interface ChordSpec {
  /** Pitch class of the chord root, 0..11. */
  root: number;
  quality: ChordQuality;
  /** Pitch class of a different bass note (slash chord), if any. */
  bass?: number;
}

const LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function readPitchClass(text: string): number | null {
  const m = /^([A-Ga-g])([#b♯♭]?)$/.exec(text);
  if (!m) return null;
  let pc = LETTERS[m[1].toUpperCase()];
  if (m[2] === '#' || m[2] === '♯') pc += 1;
  if (m[2] === 'b' || m[2] === '♭') pc -= 1;
  return (pc + 12) % 12;
}

/** Parse a chord symbol into root / quality / slash bass. Throws on anything it cannot read. */
export function parseChordSymbol(symbol: string): ChordSpec {
  const s = symbol.trim();
  const m = /^([A-G][#b♯♭]?)([^/]*)(?:\/([A-Ga-g][#b♯♭]?))?$/.exec(s);
  if (!m) throw new Error(`Cannot read the chord "${symbol}" (expected something like "Am7", "Fmaj7", "G" or "C/E").`);
  const root = readPitchClass(m[1]);
  const quality = QUALITY_ALIASES[m[2]];
  if (root === null || quality === undefined) {
    throw new Error(`Unknown chord type "${m[2]}" in "${symbol}". Try forms like m, 7, maj7, m7, sus4, dim, add9 or m9.`);
  }
  const spec: ChordSpec = { root, quality };
  if (m[3] !== undefined) {
    const bass = readPitchClass(m[3]);
    if (bass === null) throw new Error(`Cannot read the bass note "${m[3]}" in "${symbol}".`);
    if (bass !== root) spec.bass = bass;
  }
  return spec;
}

/**
 * MIDI notes of a chord in root position with its root in `octave`
 * (C4 = 60). A slash bass goes below the root (the nearest lower note of that
 * pitch class).
 */
export function chordNotes(spec: ChordSpec, octave = 3): number[] {
  const rootMidi = (octave + 1) * 12 + pitchClass(spec.root);
  const notes = CHORD_QUALITIES[spec.quality].intervals.map((i) => rootMidi + i);
  if (spec.bass !== undefined && pitchClass(spec.bass) !== pitchClass(spec.root)) {
    const below = (pitchClass(spec.root) - pitchClass(spec.bass) + 12) % 12 || 12;
    notes.unshift(rootMidi - below);
  }
  if (notes.some((n) => n < MIDI_MIN || n > MIDI_MAX)) throw new Error(`The chord does not fit in the MIDI range at octave ${octave}.`);
  return notes;
}

/** 'Am7' at octave 3 -> [57, 60, 64, 67]. Throws on unknown symbols. */
export function parseChord(symbol: string, octave = 3): number[] {
  return chordNotes(parseChordSymbol(symbol), octave);
}

/** A whitespace-, comma- or bar-separated list of chord symbols: 'Am7 Fmaj7 | C G'. */
export function parseProgression(text: string, octave = 3): number[][] {
  return text
    .split(/[\s,|]+/)
    .filter((t) => t.length > 0)
    .map((t) => parseChord(t, octave));
}

/** Symbol for a chord spec using sharps: { root: 9, quality: 'm7' } -> 'Am7'. */
export function chordSymbol(spec: ChordSpec): string {
  const base = `${ROOT_NAMES[pitchClass(spec.root)]}${CHORD_QUALITIES[spec.quality].suffix}`;
  return spec.bass !== undefined && pitchClass(spec.bass) !== pitchClass(spec.root) ? `${base}/${ROOT_NAMES[pitchClass(spec.bass)]}` : base;
}

/** Sorted unique pitch classes of a set of notes. */
export function pitchClassSet(pitches: readonly number[]): number[] {
  return [...new Set(pitches.map(pitchClass))].sort((a, b) => a - b);
}

function samePcSet(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/* Qualities tried when naming a chord, most common readings first. */
const IDENTIFY_ORDER: readonly ChordQuality[] = [
  'maj', 'min', '7', 'maj7', 'm7', 'sus4', 'sus2', 'dim', 'm7b5', '9', 'm9', 'maj9', 'add9', 'madd9',
  '6', 'm6', 'dim7', 'aug', 'mMaj7', '7sus4', 'm11', '5',
];

/**
 * Name the chord formed by `pitches` (any voicing / inversion / doubling).
 * Prefers the reading whose root is the lowest note; otherwise returns a
 * slash chord. Returns null for pitch sets that are not a known chord.
 */
export function identifyChord(pitches: readonly number[]): ChordSpec | null {
  if (pitches.length === 0) return null;
  const pcs = pitchClassSet(pitches);
  const bassPc = pitchClass(Math.min(...pitches));
  const candidates: ChordSpec[] = [];
  for (const quality of IDENTIFY_ORDER) {
    for (const root of pcs) {
      const want = pitchClassSet(CHORD_QUALITIES[quality].intervals.map((i) => root + i));
      if (samePcSet(want, pcs)) candidates.push(root === bassPc ? { root, quality } : { root, quality, bass: bassPc });
    }
  }
  return candidates.find((c) => c.bass === undefined) ?? candidates[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Diatonic chords                                                     */
/* ------------------------------------------------------------------ */

/**
 * The seven-note scale used to build diatonic chords. Pentatonic and blues
 * scales borrow their parent scale (major / minor); chromatic has no
 * harmony of its own and uses major.
 */
export function harmonicParent(scale: ScaleId): ScaleId {
  switch (scale) {
    case 'majorPentatonic':
      return 'major';
    case 'minorPentatonic':
    case 'blues':
      return 'minor';
    case 'chromatic':
      return 'major';
    default:
      return scale;
  }
}

/** MIDI note of scale step `step` (0 = tonic in `octave`); steps beyond 0..6 continue into other octaves. */
function scaleStepMidi(root: number, scale: ScaleId, step: number, octave: number): number {
  const iv = SCALES[harmonicParent(scale)].intervals;
  const n = iv.length;
  const oct = Math.floor(step / n);
  const idx = step - oct * n;
  return (octave + 1) * 12 + pitchClass(root) + iv[idx] + 12 * oct;
}

/**
 * Diatonic chord on a scale degree, built by stacking scale thirds.
 * `degree` is 0-based (0 = I, 4 = V); values outside 0..6 continue into
 * neighbouring octaves. `size` 3 = triad, 4 = seventh, 5 = ninth. The tonic
 * of `octave` is (octave + 1) * 12 + root.
 */
export function diatonicChord(root: number, scale: ScaleId, degree: number, size: 3 | 4 | 5 = 3, octave = 3): number[] {
  const d = Math.trunc(degree);
  return Array.from({ length: size }, (_, i) => scaleStepMidi(root, scale, d + 2 * i, octave));
}

export function diatonicTriad(root: number, scale: ScaleId, degree: number, octave = 3): number[] {
  return diatonicChord(root, scale, degree, 3, octave);
}

export function diatonicSeventh(root: number, scale: ScaleId, degree: number, octave = 3): number[] {
  return diatonicChord(root, scale, degree, 4, octave);
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** Roman numeral of a diatonic chord: minor key degree 0 -> 'i', degree 4 as a seventh -> 'v7'. */
export function romanNumeral(root: number, scale: ScaleId, degree: number, size: 3 | 4 | 5 = 3): string {
  const d = ((Math.trunc(degree) % 7) + 7) % 7;
  const spec = identifyChord(diatonicChord(root, scale, d, size, 3));
  const numeral = ROMAN[d];
  if (!spec) return numeral;
  const q = CHORD_QUALITIES[spec.quality];
  return `${q.minorish ? numeral.toLowerCase() : numeral}${q.roman}`;
}

/* ------------------------------------------------------------------ */
/* Inversions, voicings, voice leading                                 */
/* ------------------------------------------------------------------ */

/**
 * Invert a chord: each positive step moves the lowest note up an octave,
 * each negative step moves the highest note down an octave. Result sorted.
 */
export function invertChord(pitches: readonly number[], inversion: number): number[] {
  const out = [...pitches].sort((a, b) => a - b);
  if (out.length < 2) return out;
  const k = Math.trunc(inversion);
  for (let i = 0; i < Math.abs(k); i++) {
    if (k > 0) out.push((out.shift() as number) + 12);
    else out.unshift((out.pop() as number) - 12);
  }
  return out;
}

function inRange(v: readonly number[], low: number, high: number): boolean {
  return v.every((p) => p >= low && p <= high);
}

function key(v: readonly number[]): string {
  return v.join(',');
}

/**
 * Every close-position voicing of the chord's pitch classes (each inversion,
 * at every octave) that lies entirely within [low, high]. Sorted by lowest
 * note. Close position = all notes within one octave above the bass.
 */
export function closeVoicings(pitches: readonly number[], low: number, high: number): number[][] {
  const pcs = pitchClassSet(pitches);
  const out: number[][] = [];
  const seen = new Set<string>();
  if (pcs.length === 0) return out;
  for (let b = 0; b < pcs.length; b++) {
    // Stack upward from the bass pitch class: bass, then the other pcs in rotation order.
    const rel = pcs.map((_, i) => pcs[(b + i) % pcs.length]);
    const shape: number[] = [rel[0]];
    for (let i = 1; i < rel.length; i++) {
      let n = rel[i];
      while (n <= shape[i - 1]) n += 12;
      shape.push(n);
    }
    for (let shift = -12; shift <= 132; shift += 12) {
      const v = shape.map((p) => p + shift);
      if (inRange(v, Math.max(low, MIDI_MIN), Math.min(high, MIDI_MAX)) && !seen.has(key(v))) {
        seen.add(key(v));
        out.push(v);
      }
    }
  }
  return out.sort((a, b) => a[0] - b[0] || key(a).localeCompare(key(b)));
}

/** Drop-2 voicing (second-highest note down an octave) of a close voicing with 4+ notes. */
export function dropTwo(voicing: readonly number[]): number[] {
  const v = [...voicing].sort((a, b) => a - b);
  if (v.length < 4) return v;
  v[v.length - 2] -= 12;
  return v.sort((a, b) => a - b);
}

/** Close voicings plus their drop-2 (open) versions, all within [low, high]. */
export function chordVoicings(pitches: readonly number[], low: number, high: number, opts: { open?: boolean } = {}): number[][] {
  const close = closeVoicings(pitches, low - 12, high + 12);
  const out: number[][] = [];
  const seen = new Set<string>();
  const add = (v: number[]) => {
    if (inRange(v, Math.max(low, MIDI_MIN), Math.min(high, MIDI_MAX)) && !seen.has(key(v))) {
      seen.add(key(v));
      out.push(v);
    }
  };
  for (const v of close) {
    add(v);
    if (opts.open !== false) add(dropTwo(v));
  }
  return out.sort((a, b) => a[0] - b[0] || key(a).localeCompare(key(b)));
}

/**
 * How far the voices move between two chords. Equal sizes: sum of distances
 * between sorted voices. Different sizes: each note's distance to the nearest
 * note of the other chord, summed both ways and halved.
 */
export function voiceLeadingDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  if (x.length === y.length) return x.reduce((s, v, i) => s + Math.abs(v - y[i]), 0);
  const near = (v: number, set: number[]) => Math.min(...set.map((w) => Math.abs(v - w)));
  return (x.reduce((s, v) => s + near(v, y), 0) + y.reduce((s, v) => s + near(v, x), 0)) / 2;
}

function centre(v: readonly number[]): number {
  return v.reduce((s, p) => s + p, 0) / v.length;
}

/**
 * A single close voicing of the chord inside [low, high], the one whose
 * centre is nearest the middle of the range. When no voicing fits (range
 * narrower than the chord), the root-position shape is moved by octaves to
 * be as close to the range as possible.
 */
export function voiceChord(pitches: readonly number[], low: number, high: number): number[] {
  const options = closeVoicings(pitches, low, high);
  const mid = (low + high) / 2;
  if (options.length > 0) {
    return options.reduce((best, v) => (Math.abs(centre(v) - mid) < Math.abs(centre(best) - mid) ? v : best));
  }
  const shape = closeVoicings(pitches, MIDI_MIN, MIDI_MAX)[0] ?? [...pitches].sort((a, b) => a - b);
  let best = shape;
  for (let shift = -120; shift <= 120; shift += 12) {
    const v = shape.map((p) => p + shift);
    if (v.some((p) => p < MIDI_MIN || p > MIDI_MAX)) continue;
    if (Math.abs(centre(v) - mid) < Math.abs(centre(best) - mid)) best = v;
  }
  return best;
}

/**
 * The voicing of `next` (same pitch classes, any inversion, close or drop-2)
 * inside [low, high] that moves least from `previous`. Ties prefer the
 * voicing whose centre stays nearest the previous chord's centre. With no
 * previous chord the result is voiceChord(next, low, high).
 */
export function voiceLead(previous: readonly number[] | null, next: readonly number[], low: number, high: number): number[] {
  if (!previous || previous.length === 0) return voiceChord(next, low, high);
  const options = chordVoicings(next, low, high);
  if (options.length === 0) return voiceChord(next, low, high);
  const c = centre(previous);
  let best = options[0];
  let bestCost = Infinity;
  for (const v of options) {
    const cost = voiceLeadingDistance(previous, v) + Math.abs(centre(v) - c) * 0.01;
    if (cost < bestCost - 1e-9) {
      best = v;
      bestCost = cost;
    }
  }
  return best;
}

/** Voice-lead a whole progression inside [low, high], starting from a centred first chord. */
export function voiceLeadProgression(chords: readonly (readonly number[])[], low: number, high: number): number[][] {
  const out: number[][] = [];
  for (const chord of chords) out.push(voiceLead(out.length ? out[out.length - 1] : null, chord, low, high));
  return out;
}
