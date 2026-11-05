/**
 * Melody and texture loops, written in scale degrees (model.ts explains the
 * notation). Melodies sit around the octave above middle C; textures are
 * long, sparse notes for atmosphere. Original lines.
 */
import type { LibraryLoop, LoopBars, LoopFeel, LoopGenre } from './model';

interface LineOpts {
  unit?: number;
  gate?: number;
  vel?: number;
  suits?: 'major' | 'minor';
}

function melodic(role: 'lead' | 'texture', id: string, name: string, genres: LoopGenre[], bars: LoopBars, feel: LoopFeel, sound: string, line: string, opts: LineOpts = {}): LibraryLoop {
  const { suits, ...rest } = opts;
  return { id: `loop-${role}-${id}`, name, role, genres, bars, feel, sound, ...(suits ? { suits } : {}), part: { kind: 'line', line, ...rest } };
}

const lead = (id: string, name: string, genres: LoopGenre[], bars: LoopBars, feel: LoopFeel, sound: string, line: string, opts?: LineOpts) =>
  melodic('lead', id, name, genres, bars, feel, sound, line, opts);
const texture = (id: string, name: string, genres: LoopGenre[], bars: LoopBars, feel: LoopFeel, sound: string, line: string, opts?: LineOpts) =>
  melodic('texture', id, name, genres, bars, feel, sound, line, opts);

export const LEAD_LOOPS: readonly LibraryLoop[] = [
  lead(
    'bell-hook',
    'Bell Hook',
    ['house', 'pop'],
    2,
    'bright',
    'poly-mallet-bell',
    `3! . . 1 . . 2 . . 3 . . 5 - 3 . |
     4! . . 2 . . 3 . . 1 . . 7, - - -`,
  ),
  lead(
    'trap-bells',
    'Trap Bells',
    ['trap'],
    2,
    'dark',
    'poly-glockenspiel',
    `1' . 5 . 3 . 5 . 1' . 5 . 6 . 5 . |
     1' . 5 . 3 . 5 . 2' . 1' . 7 . 5 .`,
    { gate: 0.7, vel: 0.7, suits: 'minor' },
  ),
  lead(
    'lazy-flute',
    'Lazy Flute',
    ['lofi', 'boom-bap'],
    4,
    'chill',
    'poly-wooden-flute',
    `5 - - - 3 - 2 - 1 - - - . . . . |
     . . . . 3 - 5 - 6 - 5 - 3 - - - |
     2 - - - 1 - 6, - 1 - - - . . . . |
     . . . . . . . . . . 3 - 2 - 1 -`,
    { gate: 0.95, vel: 0.7 },
  ),
  lead('pop-hook', 'Pop Hook', ['pop'], 2, 'bright', 'poly-soft-whistle', `5 . 5 . 6 5 . 3 . . . . 2 3 . 1 | 5 . 5 . 6 5 . 1' . . 7 . 6 - 5 .`, { suits: 'major' }),
  lead('neon-run', 'Neon Run', ['synthwave'], 4, 'driving', 'poly-neon-lead', '1 2 3 5 | 6 5 3 2 | 3 - 2 1 | 7, - - -', { unit: 4, gate: 0.95 }),
  lead(
    'acid-riff',
    'Acid Riff',
    ['techno', 'breakbeat'],
    1,
    'dark',
    'bass-acid-line',
    "1 1' . 1 3 . 1' 1 . 4 . 3 1' . 5 .",
    { gate: 0.5 },
  ),
  lead('kalimba-dance', 'Kalimba Dance', ['afrobeats', 'pop'], 2, 'bright', 'poly-kalimba', `1' . 5 . 6 . 5 3 . 5 . 1' . . 6 . | 5 . 3 . 2 . 3 5 . 3 . 2 . . 1 .`, { gate: 0.8 }),
  lead('steel-sun', 'Steel Sun', ['afrobeats', 'reggaeton'], 2, 'bright', 'poly-steel-drum', `3 . 3 . 5 . . 3 . 2 . 1 . . . . | 3 . 3 . 5 . . 6 . 5 . 3 . . . .`, { gate: 0.7 }),
  lead('soft-answer', 'Soft Answer', ['lofi', 'ambient'], 4, 'chill', 'poly-felt-piano', '. 3 5 1\' | 7 - 5 - | . 3 5 6 | 5 - - -', { unit: 4, gate: 0.9, vel: 0.65 }),
  lead('call-and-reply', 'Call and Reply', ['house', 'garage'], 2, 'bouncy', 'poly-short-pluck', `1' . . 1' . . 7 . 5 . . . . . . . | . . . . . . . . 3 . 4 . 5 . 3 .`),
  lead('chip-tune', 'Chip Tune', ['synthwave', 'pop'], 1, 'bright', 'poly-chip-lead', '1 3 5 1\' 5 3 1 3 5 1\' 3\' 1\' 5 3 5 1\'', { gate: 0.55, vel: 0.7 }),
  lead('brass-shout', 'Brass Shout', ['funk', 'pop'], 2, 'bright', 'poly-brass-stab', `. . 5! . . 5 . 6 - . 5 . 3 . . . | . . 5! . . 5 . 1' - . 7 . 5 . . .`, { gate: 0.6 }),
  lead('dnb-whistle', 'High Whistle', ['dnb', 'ambient'], 4, 'chill', 'poly-soft-whistle', "5' - - - 3' - - - | 2' - - - 1' - 2' - | 3' - - - 5 - - - | 6 - - - - - - -", { unit: 2, gate: 0.95, vel: 0.65 }),
  lead('reed-tale', 'Reed Tale', ['lofi', 'boom-bap', 'ambient'], 4, 'chill', 'poly-soft-reed', '3 - 2 1 | 6, - - - | 1 - 2 3 | 5 - - -', { unit: 4, gate: 0.92, vel: 0.7 }),
  lead('garage-chop', 'Vocal Style Chop', ['garage', 'house'], 1, 'bouncy', 'poly-choir-ooh', '. . 5 . . 5 . . 3 . . . 2 . 1 .', { gate: 0.6 }),
  lead('rock-riff', 'Rock Riff', ['rock'], 2, 'driving', 'poly-saw-scream', `1 . 1 3 . 1 4 . 1 . 1 3 . 4 5 . | 1 . 1 3 . 1 4 . 6 . 5 . 4 . 3 .`, { gate: 0.7, suits: 'minor' }),
  lead('marimba-skip', 'Marimba Skip', ['reggaeton', 'afrobeats'], 1, 'bouncy', 'poly-marimba', '1\' . 5 . . 5 . 3 . . 5 . 6 . 5 .'),
  lead('music-box', 'Music Box', ['ambient', 'trap', 'lofi'], 4, 'chill', 'poly-music-box', '5 3 1 3 | 6 4 1 4 | 5 3 1 3 | 2 7, 5, 7,', { unit: 4, gate: 0.85, vel: 0.65 }),
  lead('harp-cascade', 'Harp Cascade', ['ambient', 'pop'], 1, 'bright', 'poly-harp', "1' 5 3 1 5 3 1 3 1 3 5 1' 3' 1' 5 3", { gate: 0.9, vel: 0.65 }),
  lead('trance-climb', 'Supersaw Climb', ['house', 'breakbeat'], 2, 'driving', 'poly-supersaw-lead', `1 . 1 . 3 . 1 . 5 . 3 . 1' . 5 . | 4 . 4 . 6 . 4 . 1' . 6 . 5 . 3 .`, { gate: 0.75 }),
];

export const TEXTURE_LOOPS: readonly LibraryLoop[] = [
  texture('air-wash', 'Air Wash', ['ambient', 'house', 'lofi'], 4, 'chill', 'poly-air-grain', '5 - 3 1', { unit: 16, gate: 0.97, vel: 0.5 }),
  texture('high-shimmer', 'High Shimmer', ['synthwave', 'ambient', 'pop'], 4, 'bright', 'poly-tape-shimmer', "5' - 3' -", { unit: 16, gate: 0.97, vel: 0.45 }),
  texture('riser', 'Riser', ['house', 'techno', 'pop', 'trap'], 4, 'driving', 'poly-sweep-riser', '. . 1 -', { unit: 16, gate: 0.98, vel: 0.7 }),
  texture('downlift', 'Downlift', ['house', 'techno', 'dnb'], 2, 'dark', 'poly-downlifter', '1 .', { unit: 16, gate: 0.9, vel: 0.65 }),
  texture('dark-drone', 'Low Drone', ['techno', 'ambient', 'trap'], 4, 'dark', 'poly-dark-drone', '1, - - -', { unit: 16, gate: 0.98, vel: 0.6 }),
  texture('ocean', 'Ocean', ['ambient', 'lofi'], 4, 'chill', 'poly-ocean-wash', '1 - 5 -', { unit: 16, gate: 0.97, vel: 0.55 }),
  texture('tape-wobble', 'Tape Wobble', ['lofi', 'boom-bap'], 4, 'chill', 'poly-warped-tape', '3 - 5 -', { unit: 16, gate: 0.96, vel: 0.5 }),
  texture('choir-breath', 'Choir Breath', ['ambient', 'trap'], 4, 'dark', 'poly-night-choir', '1+5 - 6,+3 -', { unit: 16, gate: 0.97, vel: 0.5 }),
  texture('sparkles', 'Sparkles', ['pop', 'house', 'ambient'], 2, 'bright', 'poly-glockenspiel', `. . . . 5' . . . . . 3' . . . . . | . . . . . . 1'' . . . . . 2' . . .`, { gate: 0.6, vel: 0.4 }),
  texture('chirps', 'Chirps', ['techno', 'breakbeat', 'synthwave'], 2, 'bright', 'poly-scifi-chirp', `. . 5 . . . . . . . 1' . . . . . | . . . . 3 . . . . . . . . 5 . .`, { gate: 0.5, vel: 0.5 }),
  texture('zaps', 'Laser Zaps', ['dnb', 'breakbeat', 'trap'], 2, 'driving', 'poly-laser-zap', `. . . . . . . . . . . . 1' . . . | . . . . . . . . . . 5 . 1' . . .`, { gate: 0.5, vel: 0.55 }),
  texture('metal-hits', 'Metal Hits', ['techno'], 2, 'dark', 'poly-metal-clang', `1 . . . . . . . . . . . . . . . | . . . . . . . . 5, . . . . . . .`, { gate: 0.6, vel: 0.5 }),
  texture('bell-tolls', 'Bell Tolls', ['ambient', 'trap'], 4, 'dark', 'poly-tubular-bell', '1 - - - | . . 5, - | 1 - - - | . . . .', { unit: 4, gate: 0.9, vel: 0.5 }),
  texture('warm-hum', 'Warm Hum', ['lofi', 'pop', 'afrobeats'], 4, 'chill', 'poly-breath-pad', '1+5 - - -', { unit: 16, gate: 0.98, vel: 0.45 }),
  texture('glass-drops', 'Glass Drops', ['ambient', 'dnb'], 4, 'chill', 'poly-crystal-ep', "5' - . . | . . 3' - | 2' - . . | . . . .", { unit: 4, gate: 0.9, vel: 0.45 }),
  texture('koto-drift', 'String Drift', ['ambient', 'lofi'], 2, 'chill', 'poly-koto-pluck', `5 . . . . . . . 3 . . . . . . . | 2 . . . . . . . 1 . . . . . . .`, { gate: 0.8, vel: 0.5 }),
];
