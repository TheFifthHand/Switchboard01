/**
 * Scales, note names and Musical Assist helpers (pure, architecture layer 1).
 *
 * Conventions: MIDI note numbers, C4 = 60 (so A4 = 69 = 440 Hz), pitch
 * classes 0..11 with 0 = C. Display names use sharps.
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

export const MIDI_MIN = 0;
export const MIDI_MAX = 127;

/** Pitch class 0..11 of any integer (negative-safe). */
export function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

/** 'A#3' for 58. C4 = 60, so octave = floor(midi / 12) - 1. */
export function noteName(midi: number): string {
  const m = Math.round(midi);
  return `${ROOT_NAMES[pitchClass(m)]}${Math.floor(m / 12) - 1}`;
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

/** 'A minor', 'D Dorian', 'E minor pentatonic'. The chromatic scale has no key: 'Chromatic'. */
export function keyLabel(root: number, scale: ScaleId): string {
  if (scale === 'chromatic') return 'Chromatic';
  return `${ROOT_NAMES[pitchClass(root)]} ${KEY_WORDS[scale]}`;
}
