/**
 * Bass loops, written in scale degrees (model.ts explains the notation):
 * "1" is the key's tonic in the bass register, "5," the fifth below it,
 * "~" glides into the next note on a mono bass. Original lines.
 */
import type { LibraryLoop, LoopBars, LoopFeel, LoopGenre } from './model';

interface LineOpts {
  unit?: number;
  gate?: number;
  vel?: number;
  suits?: 'major' | 'minor';
}

function bass(id: string, name: string, genres: LoopGenre[], bars: LoopBars, feel: LoopFeel, sound: string, line: string, opts: LineOpts = {}): LibraryLoop {
  const { suits, ...rest } = opts;
  return { id: `loop-bass-${id}`, name, role: 'bass', genres, bars, feel, sound, ...(suits ? { suits } : {}), part: { kind: 'line', line, ...rest } };
}

export const BASS_LOOPS: readonly LibraryLoop[] = [
  bass('root-pulse', 'Root Pulse', ['house', 'techno'], 1, 'driving', 'bass-round-sub', '. 1 . 1 . 1 . 1', { unit: 2, gate: 0.7 }),
  bass(
    'bouncy',
    'Bouncy Bass',
    ['house', 'garage'],
    2,
    'bouncy',
    'bass-rubber-pluck',
    `. . 1 - . 1'? . . . . 1 - . . 3 4 |
     . . 4 - . 1'? . . . . 4 - . 6 5 .`,
  ),
  bass('rolling-eighths', 'Rolling Eighths', ['synthwave', 'rock'], 2, 'driving', 'bass-velvet-saw', '1 1 1 1 1 1 1 1 | 6, 6, 6, 6, 4, 4, 5, 5,', { unit: 2, gate: 0.8 }),
  bass('sub-hold', 'Sub Hold', ['ambient', 'dnb', 'lofi'], 4, 'chill', 'bass-pure-sub', '1 6, 4, 5,', { unit: 16, gate: 0.95, vel: 0.7 }),
  bass('acid-wiggle', 'Acid Wiggle', ['techno', 'breakbeat'], 1, 'dark', 'bass-acid-line', "1 1' 1 . 3 1 1'~ 7 1 . 1 5! 1 5 1 .", { gate: 0.6 }),
  bass(
    '808-slide',
    '808 Slide',
    ['trap'],
    2,
    'dark',
    'bass-808-boom',
    `1 - - - - - . 1 . . 1~ 3 - - - - |
     6, - - - - - . 6, . . 5,~ 4, - - . .`,
    { suits: 'minor' },
  ),
  bass(
    '808-drop',
    '808 Drop',
    ['trap'],
    2,
    'dark',
    'bass-808-boom',
    `1 - - - - - - - - - 1 - - . . . |
     . . . . . . 5~ 1 - - - 6, - - - -`,
  ),
  bass(
    'boom-walk',
    'Boom Walk',
    ['boom-bap', 'lofi'],
    2,
    'chill',
    'bass-finger',
    `1 - - . . . . 1 . . 3 - . . 4 . |
     5 - - . . . . 5 . . 4 - . 3 . .`,
  ),
  bass(
    'lazy-thumb',
    'Lazy Thumb',
    ['lofi', 'boom-bap'],
    4,
    'chill',
    'bass-dub-pressure',
    `1 - - - - - . . . . 5, - 1 - . . |
     6, - - - - - . . . . 3 - 6, - . . |
     4, - - - - - . . . . 1 - 4, - . . |
     5, - - - - - . . . . 2 - 5, - 7, -`,
  ),
  bass('finger-funk', 'Finger Funk', ['funk', 'pop'], 1, 'bouncy', 'bass-finger', "1 . 5? 1 . 5,? 1 . 3 . 4 . 5 3 1 5,", { gate: 0.6 }),
  bass(
    'slap-pop',
    'Slap Pop',
    ['funk', 'pop'],
    2,
    'bright',
    'bass-fm-slap',
    `1! . 1' . . 1 . 5 1! . 1' . 6 . 5 . |
     4! . 1' . . 4 . 6 5! . 1' . 3 . 2 .`,
    { gate: 0.55, suits: 'major' },
  ),
  bass('pop-eighths', 'Pop Eighths', ['pop', 'rock'], 4, 'bright', 'bass-finger', '1 1 1 1 1 1 1 1 | 5, 5, 5, 5, 5, 5, 5, 5, | 6, 6, 6, 6, 6, 6, 6, 6, | 4, 4, 4, 4, 4, 4, 5, 5,', {
    unit: 2,
    gate: 0.75,
    suits: 'major',
  }),
  bass(
    'log-pulse',
    'Log Pulse',
    ['afrobeats'],
    2,
    'bouncy',
    'bass-log-drum',
    `1 . . 1 . . 5, . . . 1 . 3 . . . |
     4, . . 4, . . 1 . . . 4, . 5, . 6, .`,
  ),
  bass(
    'island-sway',
    'Island Sway',
    ['reggaeton', 'afrobeats'],
    2,
    'bouncy',
    'bass-round-sub',
    `1 - - 1 - - 1 - 1 - - 1 - - 3 - |
     6, - - 6, - - 6, - 4, - - 4, - - 5, -`,
  ),
  bass('reese-roll', 'Reese Roll', ['dnb'], 4, 'dark', 'bass-reese', '1 - - - - - - - - - 3 - - - - - | 6, - - - - - - - - - - - 5, - - - | 4, - - - - - - - - - 6, - - - - - | 5, - - - - - - - 1 - - - - - - -', {
    gate: 0.95,
  }),
  bass(
    'two-step-wobble',
    'Two-Step Wobble',
    ['garage', 'house'],
    2,
    'bouncy',
    'bass-organ-short',
    `1 . . 1 . . . 1' . . 1 . . 5 . . |
     4 . . 4 . . . 1' . . 4 . 5 . 6 .`,
  ),
  bass('break-stomp', 'Break Stomp', ['breakbeat', 'rock'], 2, 'driving', 'bass-growl', `1 . 1 . . . 1 . 3 . . 1 . . 5, . | 6, . 6, . . . 6, . 4, . . 5, . . 5, .`, { gate: 0.8 }),
  bass('octave-jump', 'Octave Jump', ['house', 'funk', 'synthwave'], 1, 'bright', 'bass-velvet-saw', "1 1' 1 1' 1 1' 1 1'", { unit: 2, gate: 0.6 }),
  bass('deep-glide', 'Deep Glide', ['techno', 'ambient'], 2, 'dark', 'bass-deep-pulse', `1 - - . . . 1~ 2 - . . . 1 - . . | 1 - - . . . 1~ 7, - . . . 6, - . .`, { suits: 'minor' }),
  bass('night-drive', 'Night Drive', ['synthwave'], 4, 'driving', 'bass-velvet-saw', '1 1 1 1 1 1 1 1 | 6, 6, 6, 6, 6, 6, 6, 6, | 3 3 3 3 3 3 3 3 | 7, 7, 7, 7, 5, 5, 5, 5,', {
    unit: 2,
    gate: 0.7,
    suits: 'minor',
  }),
  bass(
    'sunny-bounce',
    'Sunny Bounce',
    ['afrobeats', 'pop'],
    2,
    'bright',
    'bass-finger',
    `1 . . . . . 1 . . 3 . . 5 . . . |
     4, . . . . . 4, . . 6, . . 1 . 5, .`,
    { suits: 'major' },
  ),
  bass('rock-root', 'Rock Root', ['rock'], 2, 'driving', 'bass-finger', '1 1 1 1 1 1 1 1 | 4, 4, 4, 4, 5, 5, 5, 5,', { unit: 2, gate: 0.85 }),
];
