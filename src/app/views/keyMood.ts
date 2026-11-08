/**
 * The project's key in everyday words for Simple: the root and a mood
 * ("Key: G · jazzy minor"), with the scale's proper name kept for a tooltip
 * ("G Dorian"). Pure: no DOM, no audio.
 */
import { keyLabel, keyRootName } from '../../music/scales';
import type { ScaleId } from '../../project/types';

/** What each scale sounds like, in a word or two a beginner knows. */
export const SCALE_MOOD: Record<ScaleId, string> = {
  major: 'bright major',
  minor: 'moody minor',
  dorian: 'jazzy minor',
  phrygian: 'dark minor',
  lydian: 'dreamy major',
  mixolydian: 'bluesy major',
  harmonicMinor: 'dramatic minor',
  majorPentatonic: 'sunny, simple',
  minorPentatonic: 'soulful, simple',
  blues: 'bluesy',
  chromatic: 'every note',
};

/**
 * The mood alone, one plain word (no "major", "minor" or scale names): Simple's Mood choices and the
 * Song screen's editor. The scale's proper name stays in tooltips and in Advanced.
 */
export const MOOD_WORD: Record<ScaleId, string> = {
  major: 'bright',
  minor: 'moody',
  dorian: 'jazzy',
  phrygian: 'dark',
  lydian: 'dreamy',
  mixolydian: 'easy-going',
  harmonicMinor: 'dramatic',
  majorPentatonic: 'sunny',
  minorPentatonic: 'soulful',
  blues: 'bluesy',
  chromatic: 'every note',
};

/** "G · jazzy minor" (the root as the key spells it, then the mood); "Every note" for chromatic. */
export function keyMood(root: number, scale: ScaleId): string {
  if (scale === 'chromatic') return 'Every note';
  return `${keyRootName(root, scale)} · ${SCALE_MOOD[scale]}`;
}

/** The readout and its tooltip: { text: "Key: G · jazzy minor", name: "G Dorian" }. */
export function keyReadout(root: number, scale: ScaleId): { text: string; name: string } {
  return { text: `Key: ${keyMood(root, scale)}`, name: keyLabel(root, scale) };
}

/** What a starter feels like and how fast, for its card: "warm, bouncy · 124 BPM". */
export function starterFeel(feel: string, bpm: number): string {
  return `${feel} · ${Math.round(bpm)} BPM`;
}
