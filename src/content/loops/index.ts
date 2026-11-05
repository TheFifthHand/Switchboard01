/**
 * The built-in loop library (pure data and lookup, architecture layer 1):
 * beats (src/content/beats.ts), percussion, bass, chords, melodies, pads
 * and textures. Place a loop in a project with `realizeLoop` (model.ts).
 */
import { BEATS, beatLoop } from '../beats';
import { ALL_SOUNDS } from '../catalog';
import { BASS_LOOPS } from './bass';
import { CHORD_LOOPS, PAD_LOOPS } from './harmony';
import { LEAD_LOOPS, TEXTURE_LOOPS } from './melody';
import { GENRES, LOOP_ROLE_NAMES, type LibraryLoop, type LoopBars, type LoopFeel, type LoopGenre, type LoopRole } from './model';
import { PERCUSSION_LOOPS } from './percussion';
import type { TrackRole } from '../../project/types';

export * from './model';

/** Every library loop, grouped by part in LOOP_ROLES order. */
export const LIBRARY_LOOPS: readonly LibraryLoop[] = [
  ...BEATS.map(beatLoop),
  ...PERCUSSION_LOOPS,
  ...BASS_LOOPS,
  ...CHORD_LOOPS,
  ...LEAD_LOOPS,
  ...PAD_LOOPS,
  ...TEXTURE_LOOPS,
];

const byId = new Map(LIBRARY_LOOPS.map((l) => [l.id, l]));

/** A loop by id. */
export function getLoop(id: string): LibraryLoop | undefined {
  return byId.get(id);
}

/** The loops written for a part. The sampler has none of its own (its recordings vary too much). */
export function loopsFor(role: TrackRole): readonly LibraryLoop[] {
  return LIBRARY_LOOPS.filter((l) => l.role === role);
}

/** Styles that have at least one loop for this part (all styles without a part). */
export function genresFor(role?: LoopRole): readonly { id: LoopGenre; name: string }[] {
  if (!role) return GENRES;
  const used = new Set(loopsFor(role).flatMap((l) => l.genres));
  return GENRES.filter((g) => used.has(g.id));
}

export interface LoopFilters {
  role?: LoopRole;
  genre?: LoopGenre;
  feel?: LoopFeel;
  bars?: LoopBars;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const soundName = new Map(ALL_SOUNDS.map((s) => [s.id, s.name]));

/** Each style as one search word ('Drum & Bass' is "dnb", so "bass" alone finds bass loops, not drum and bass beats). */
const styleWord = (id: LoopGenre) => id.replace(/-/g, '');
const STYLE_TEXT = Object.fromEntries(
  GENRES.map((g) => [g.id, normalize(g.name).includes(' ') ? styleWord(g.id) : `${styleWord(g.id)} ${normalize(g.name)}`]),
) as Record<LoopGenre, string>;
/** Multi-word style names in a query ("drum and bass", "lo fi", "boom bap") read as their one-word form. */
function styleWords(query: string): string {
  let q = ` ${query} `;
  for (const g of GENRES) q = q.replace(` ${normalize(g.name)} `, ` ${styleWord(g.id)} `);
  return q.trim();
}

/** Extra words people type for a part. */
const ROLE_WORDS: Record<LoopRole, string> = {
  drums: 'beats beat drums drum kit groove',
  percussion: 'percussion perc hand drums shaker congas',
  bass: 'bass bassline low',
  chords: 'chords keys piano harmony',
  lead: 'melody lead hook riff tune',
  pad: 'pads pad strings atmosphere',
  texture: 'textures texture fx atmosphere ambience',
};

/**
 * Relevance of a loop for a search (0 = no match). Every word must start a
 * word of the loop's name, a style, its feel, its part or its sound; name
 * matches rank highest.
 */
export function loopMatchScore(loop: LibraryLoop, text: string): number {
  const words = styleWords(normalize(text)).split(' ').filter(Boolean);
  if (words.length === 0) return 1;
  const name = ` ${normalize(loop.name)}`;
  const styles = ` ${loop.genres.map((g) => STYLE_TEXT[g]).join(' ')}`;
  const part = ` ${normalize(`${LOOP_ROLE_NAMES[loop.role]} ${ROLE_WORDS[loop.role]}`)}`;
  const other = ` ${normalize(`${loop.feel} ${soundName.get(loop.sound) ?? ''} ${loop.bars} bars`)}`;
  let score = 0;
  for (const w of words) {
    const at = ` ${w}`;
    if (name.includes(at)) score += 8;
    else if (styles.includes(at)) score += 5;
    else if (part.includes(at)) score += 4;
    else if (other.includes(at)) score += 2;
    else return 0;
  }
  return score;
}

/** Loops matching a text search and filters, best match first (library order among equals). */
export function searchLoops(text: string, filters: LoopFilters = {}): LibraryLoop[] {
  const hits: { loop: LibraryLoop; score: number; i: number }[] = [];
  LIBRARY_LOOPS.forEach((loop, i) => {
    if (filters.role && loop.role !== filters.role) return;
    if (filters.genre && !loop.genres.includes(filters.genre)) return;
    if (filters.feel && loop.feel !== filters.feel) return;
    if (filters.bars && loop.bars !== filters.bars) return;
    const score = loopMatchScore(loop, text);
    if (score > 0) hits.push({ loop, score, i });
  });
  return hits.sort((a, b) => b.score - a.score || a.i - b.i).map((h) => h.loop);
}

