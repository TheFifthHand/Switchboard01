/**
 * Scales, note names and Musical Assist helpers (pure, architecture layer 1).
 *
 * Conventions: MIDI note numbers, C4 = 60 (so A4 = 69 = 440 Hz), pitch
 * classes 0..11 with 0 = C. Display names use sharps unless a key is given:
 * then they are spelled the way that key writes them (see keyNoteNames), so
 * G Dorian reads B♭ and E♭ major reads A♭, while A minor keeps G#.
 */
import type { ScaleId } from '../project/types';

export interface ScaleDef {
  name: string;
  /** Semitones above the root, ascending, starting with 0. */
  intervals: number[];
}

export const SCALES: Record<ScaleId, ScaleDef> = {
  major: { name: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  minor: { name: 'Minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { name: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { name: 'Phrygian', intervals: [0, 1, 3, 5, 7, 8, 10] },
  lydian: { name: 'Lydian', intervals: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian: { name: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  harmonicMinor: { name: 'Harmonic Minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
  majorPentatonic: { name: 'Major Pentatonic', intervals: [0, 2, 4, 7, 9] },
  minorPentatonic: { name: 'Minor Pentatonic', intervals: [0, 3, 5, 7, 10] },
  blues: { name: 'Blues', intervals: [0, 3, 5, 6, 7, 10] },
  chromatic: { name: 'Chromatic', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

/** Menu order for scale pickers: the friendliest choices first. */
export const SCALE_ORDER: readonly ScaleId[] = [
  'minor',
  'major',
  'minorPentatonic',
  'majorPentatonic',
  'dorian',
  'mixolydian',
  'phrygian',
  'lydian',
  'harmonicMinor',
  'blues',
  'chromatic',
];

export const ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
/** The same twelve pitch classes written with flats (keys such as F, B♭, E♭ and their modes use these). */
export const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'] as const;

/** A key: root pitch class (any integer, read modulo 12) and scale. */
export interface MusicalKey {
  root: number;
  scale: ScaleId;
}

export const MIDI_MIN = 0;
export const MIDI_MAX = 127;

/** Pitch class 0..11 of any integer (negative-safe). */
export function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

/**
 * 'A#3' for 58. C4 = 60, so octave = floor(midi / 12) - 1. Given a key, the
 * name is spelled the way that key writes it: 58 in G Dorian is 'B♭3'.
 */
export function noteName(midi: number, key?: MusicalKey): string {
  const m = Math.round(midi);
  const names = key ? keyNoteNames(key.root, key.scale) : ROOT_NAMES;
  return `${names[pitchClass(m)]}${Math.floor(m / 12) - 1}`;
}

/* ------------------------------------------------------------------ */
/* Spelling by key                                                     */
/* ------------------------------------------------------------------ */

/** Semitones from a scale's root up to the root of the major key that shares its notes (its key signature). */
const MAJOR_OFFSET: Record<ScaleId, number> = {
  major: 0,
  minor: 3,
  dorian: 10,
  phrygian: 8,
  lydian: 7,
  mixolydian: 5,
  harmonicMinor: 3,
  majorPentatonic: 0,
  minorPentatonic: 3,
  blues: 3,
  chromatic: 0,
};
/** Major keys written with flats: F, B♭, E♭, A♭, D♭ (G♭/F# is written F#, as the root picker writes it). */
const FLAT_MAJOR_ROOTS: ReadonlySet<number> = new Set([5, 10, 3, 8, 1]);
/** The seven-note scale that gives each degree its letter (pentatonic and blues borrow theirs). */
const LETTER_SCALE: Record<ScaleId, ScaleId | null> = {
  major: 'major',
  minor: 'minor',
  dorian: 'dorian',
  phrygian: 'phrygian',
  lydian: 'lydian',
  mixolydian: 'mixolydian',
  harmonicMinor: 'harmonicMinor',
  majorPentatonic: 'major',
  minorPentatonic: 'minor',
  blues: 'minor',
  chromatic: null,
};
const LETTERS = 'CDEFGAB';
/** Scales with a minor third: their leading tone (a semitone under the root) is written as a raised seventh, F# in G minor. */
const MINOR_THIRD: ReadonlySet<ScaleId> = new Set(['minor', 'dorian', 'phrygian', 'harmonicMinor', 'minorPentatonic', 'blues']);

/** The root pitch class of the major key that shares a key's notes (A minor -> C, G Dorian -> F). */
export function relativeMajorRoot(root: number, scale: ScaleId): number {
  return (pitchClass(root) + MAJOR_OFFSET[scale]) % 12;
}

/** True when the key is written with flats (its key signature has flats): F major, G Dorian, D minor, F Phrygian... */
export function keyUsesFlats(root: number, scale: ScaleId): boolean {
  return FLAT_MAJOR_ROOTS.has(relativeMajorRoot(root, scale));
}

const spellingCache = new Map<string, readonly string[]>();

/**
 * The twelve pitch-class names (index = pitch class) as a key writes them.
 * Flat keys use flats, the others sharps. Each scale note takes its own
 * letter where one of the two spellings allows it, so G harmonic minor reads
 * F# beside B♭ and D harmonic minor reads C#. Two notes outside the key are
 * written the way they work: in a key with a minor third the leading tone is
 * a raised seventh (F# in G minor and G Dorian, C# in D minor), and the
 * blues ♭5 is a flattened fifth (E♭ in A blues). Only C..B with one ♭ or #
 * are used (never E#, B#, C♭ or F♭), so octave numbers stay those of
 * noteName.
 */
export function keyNoteNames(root: number, scale: ScaleId): readonly string[] {
  const r = pitchClass(root);
  const cacheKey = `${r}:${scale}`;
  const hit = spellingCache.get(cacheKey);
  if (hit) return hit;
  const preferred: readonly string[] = keyUsesFlats(r, scale) ? FLAT_NAMES : ROOT_NAMES;
  const names = [...preferred];
  const letterScale = LETTER_SCALE[scale];
  if (letterScale) {
    const tonicLetter = LETTERS.indexOf(preferred[r][0]);
    SCALES[letterScale].intervals.forEach((iv, degree) => {
      const pc = (r + iv) % 12;
      const letter = LETTERS[(tonicLetter + degree) % 7];
      const fit = [ROOT_NAMES[pc], FLAT_NAMES[pc]].find((n) => n[0] === letter);
      if (fit) names[pc] = fit;
    });
    const spellAs = (pc: number, letter: string) => {
      if (isInScale(pc, r, letterScale)) return; // a degree already has its letter
      const fit = [ROOT_NAMES[pc], FLAT_NAMES[pc]].find((n) => n[0] === letter);
      if (fit) names[pc] = fit;
    };
    // The leading tone takes the letter under the root (F# under G); the blues ♭5 the fifth's letter (E♭ under E in A).
    if (MINOR_THIRD.has(scale)) spellAs((r + 11) % 12, LETTERS[(tonicLetter + 6) % 7]);
    if (scale === 'blues') spellAs((r + 6) % 12, LETTERS[(tonicLetter + 4) % 7]);
  }
  const frozen = Object.freeze(names);
  spellingCache.set(cacheKey, frozen);
  return frozen;
}

/** The key's root as the key writes it: 'B♭' for B♭ major, 'C#' for C# minor, 'D♭' for D♭ major. */
export function keyRootName(root: number, scale: ScaleId): string {
  return keyNoteNames(root, scale)[pitchClass(root)];
}

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Parse a note name such as 'A3', 'C#4', 'Db2', 'Bb-1' or 'e5' into a MIDI
 * note number (C4 = 60). Accepts # / b (and ♯ / ♭), up to two accidentals.
 * Throws a descriptive Error for malformed names or notes outside 0..127.
 */
export function parseNote(name: string): number {
  const m = /^\s*([A-Ga-g])([#b♯♭]{0,2})(-?\d+)\s*$/.exec(name);
  if (!m) throw new Error(`Cannot read the note name "${name}" (expected something like "A3", "C#4" or "Bb2").`);
  let pc = LETTER_PC[m[1].toUpperCase()];
  for (const ch of m[2]) pc += ch === '#' || ch === '♯' ? 1 : -1;
  const octave = Number(m[3]);
  const midi = (octave + 1) * 12 + pc;
  if (midi < MIDI_MIN || midi > MIDI_MAX) throw new Error(`The note "${name}" is outside the MIDI range (C-1 to G9).`);
  return midi;
}

/** Pitch classes of a key, ascending from the root (root first). */
export function scalePitchClasses(root: number, scale: ScaleId): number[] {
  const r = pitchClass(root);
  return SCALES[scale].intervals.map((i) => (r + i) % 12);
}

/** 12 booleans, index = pitch class (0 = C): true where the pitch class belongs to the key. */
export function scaleMask(root: number, scale: ScaleId): boolean[] {
  const mask = Array.from({ length: 12 }, () => false);
  for (const pc of scalePitchClasses(root, scale)) mask[pc] = true;
  return mask;
}

export function isInScale(midi: number, root: number, scale: ScaleId): boolean {
  const interval = (pitchClass(midi) - pitchClass(root) + 12) % 12;
  return SCALES[scale].intervals.includes(interval);
}

/**
 * Nearest in-scale note to `midi`. Ties resolve downward (a note exactly
 * between two scale notes goes to the lower one). The chromatic scale
 * returns the (rounded) input unchanged. The result stays within 0..127.
 */
export function snapToScale(midi: number, root: number, scale: ScaleId): number {
  const m = Math.min(MIDI_MAX, Math.max(MIDI_MIN, Math.round(midi)));
  if (scale === 'chromatic' || isInScale(m, root, scale)) return m;
  for (let d = 1; d < 12; d++) {
    if (m - d >= MIDI_MIN && isInScale(m - d, root, scale)) return m - d;
    if (m + d <= MIDI_MAX && isInScale(m + d, root, scale)) return m + d;
  }
  return m;
}

/** Index of `midi` within its key (0 = root), or -1 when it is not in the scale. */
export function scaleDegreeOf(midi: number, root: number, scale: ScaleId): number {
  const interval = (pitchClass(midi) - pitchClass(root) + 12) % 12;
  return SCALES[scale].intervals.indexOf(interval);
}

/**
 * Move `midi` by `steps` scale steps (positive = up). An out-of-scale input
 * is snapped first. Steps that would leave 0..127 stop at the last in-range
 * scale note.
 */
export function transposeInScale(midi: number, steps: number, root: number, scale: ScaleId): number {
  let cur = snapToScale(midi, root, scale);
  const dir = steps >= 0 ? 1 : -1;
  for (let s = 0; s < Math.abs(Math.trunc(steps)); s++) {
    let next = cur + dir;
    while (next >= MIDI_MIN && next <= MIDI_MAX && !isInScale(next, root, scale)) next += dir;
    if (next < MIDI_MIN || next > MIDI_MAX) break;
    cur = next;
  }
  return cur;
}

/**
 * `count` ascending in-scale notes starting at the first in-scale note
 * >= fromMidi (the Notes pad layout uses 16 of them, bottom-left first).
 * Returns fewer notes if the MIDI range ends first.
 */
export function scaleDegreesInRange(root: number, scale: ScaleId, fromMidi: number, count: number): number[] {
  const out: number[] = [];
  for (let m = Math.max(MIDI_MIN, Math.ceil(fromMidi)); m <= MIDI_MAX && out.length < count; m++) {
    if (isInScale(m, root, scale)) out.push(m);
  }
  return out;
}

/**
 * The highest note at or below `midi` on the key's root (G3 = 55 for a G key at or below C4 = 60;
 * C4 itself for a C key). Never below MIDI 0: then the root an octave up.
 */
export function rootAtOrBelow(root: number, midi: number): number {
  const m = Math.round(midi);
  const r = m - ((pitchClass(m) - pitchClass(root) + 12) % 12);
  return r < MIDI_MIN ? r + 12 : r;
}

/**
 * The keys of a scale keyboard: `count` ascending in-key notes from the root at or below
 * `fromMidi` (G Dorian from C4: G3 A3 B♭3 C4 D4 E4 F4 G4 …). Fewer when MIDI ends first.
 */
export function scaleKeyboardNotes(root: number, scale: ScaleId, fromMidi: number, count: number): number[] {
  return scaleDegreesInRange(root, scale, rootAtOrBelow(root, fromMidi), count);
}

/* Modes are proper names; the others read naturally in lower case ("A minor"). */
const KEY_WORDS: Record<ScaleId, string> = {
  major: 'major',
  minor: 'minor',
  dorian: 'Dorian',
  phrygian: 'Phrygian',
  lydian: 'Lydian',
  mixolydian: 'Mixolydian',
  harmonicMinor: 'harmonic minor',
  majorPentatonic: 'major pentatonic',
  minorPentatonic: 'minor pentatonic',
  blues: 'blues',
  chromatic: 'chromatic',
};

/** 'A minor', 'D Dorian', 'E minor pentatonic', 'B♭ major' (the root spelled as the key writes it). The chromatic scale has no key: 'Chromatic'. */
export function keyLabel(root: number, scale: ScaleId): string {
  if (scale === 'chromatic') return 'Chromatic';
  return `${keyRootName(root, scale)} ${KEY_WORDS[scale]}`;
}

const KEY_SHORT_WORDS: Record<ScaleId, string> = {
  major: 'maj',
  minor: 'min',
  dorian: 'Dor',
  phrygian: 'Phr',
  lydian: 'Lyd',
  mixolydian: 'Mix',
  harmonicMinor: 'harm min',
  majorPentatonic: 'maj pent',
  minorPentatonic: 'min pent',
  blues: 'blues',
  chromatic: '',
};

/**
 * A key in a few characters for tight spaces (the roll's key chip): 'G Dor',
 * 'A min', 'B♭ maj', 'E min pent'. At most 11 characters. Chromatic: 'Chrom'.
 * Pair it with keyLabel in a tooltip or accessible name.
 */
export function keyShortName(root: number, scale: ScaleId): string {
  if (scale === 'chromatic') return 'Chrom';
  return `${keyRootName(root, scale)} ${KEY_SHORT_WORDS[scale]}`;
}

/* ------------------------------------------------------------------ */
/* Moving music between keys                                           */
/* ------------------------------------------------------------------ */

/** Notes per octave of a scale: 7 for the church modes and harmonic minor, 5 for pentatonics, 12 for chromatic. */
export function stepsPerOctave(scale: ScaleId): number {
  return SCALES[scale].intervals.length;
}

/**
 * The shortest move from one root to another, in semitones: -5..+6 (a
 * tritone goes up). G to A is +2, G to F is -2, C to F# is +6.
 */
export function keyInterval(fromRoot: number, toRoot: number): number {
  const d = (pitchClass(toRoot) - pitchClass(fromRoot) + 12) % 12;
  return d > 6 ? d - 12 : d;
}

/**
 * Where a note of a song in key `from` goes when the song moves to key `to`.
 * Everything moves by the shortest root interval (keyInterval). When the
 * scale changes, each scale note keeps its degree, counted in the seven-note
 * scale behind each key (a pentatonic or blues key counts in its parent major
 * or minor scale): G Dorian's E becomes G minor's E♭, and C minor
 * pentatonic's E♭ and B♭ become C major's E and B. A note the new key does
 * not have (moving to a pentatonic key) lands on the nearest note it has.
 * Notes outside the old key (chromatic passing notes, the blues ♭5) and
 * anything to or from the chromatic scale only move by the interval. The
 * result may lie outside 0..127; callers fold it into their range.
 */
export function moveToKey(midi: number, from: MusicalKey, to: MusicalKey): number {
  const m = Math.round(midi);
  const d = keyInterval(from.root, to.root);
  const fromParent = LETTER_SCALE[from.scale];
  const toParent = LETTER_SCALE[to.scale];
  if (from.scale === to.scale || !fromParent || !toParent) return m + d;
  const rel = (pitchClass(m) - pitchClass(from.root) + 12) % 12;
  if (!SCALES[from.scale].intervals.includes(rel)) return m + d;
  const degree = SCALES[fromParent].intervals.indexOf(rel);
  if (degree < 0) return m + d;
  const moved = m - rel + d + SCALES[toParent].intervals[degree];
  if (isInScale(moved, to.root, to.scale)) return moved;
  // Snap by pitch class (a stand-in in the middle octave), so a note near the MIDI edges keeps its register.
  const stand = 60 + pitchClass(moved);
  return moved + snapToScale(stand, to.root, to.scale) - stand;
}
