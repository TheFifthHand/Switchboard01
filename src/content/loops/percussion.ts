/**
 * Percussion loops for the percussion part: hand drums, shakers and bells,
 * written for the Hand Percussion layout (dsl.ts HAND) or the Afro Latin
 * layout (dsl.ts AFRO). On another kit each voice moves to the pad that
 * plays the same job (model.ts mapDrumGrid). Original patterns.
 */
import type { LibraryLoop, LoopBars, LoopFeel, LoopGenre } from './model';

function hand(id: string, name: string, genres: LoopGenre[], bars: LoopBars, feel: LoopFeel, grid: Record<string, string>): LibraryLoop {
  return { id: `loop-perc-${id}`, name, role: 'percussion', genres, bars, feel, sound: 'hand-percussion', part: { kind: 'drums', layout: 'hand', grid } };
}

function afro(id: string, name: string, genres: LoopGenre[], bars: LoopBars, feel: LoopFeel, grid: Record<string, string>): LibraryLoop {
  return { id: `loop-perc-${id}`, name, role: 'percussion', genres, bars, feel, sound: 'afro-latin', part: { kind: 'drums', layout: 'afro', grid } };
}

export const PERCUSSION_LOOPS: readonly LibraryLoop[] = [
  hand('steady-shaker', 'Steady Shaker', ['house', 'pop', 'afrobeats'], 1, 'driving', { shaker: '6363636363636363' }),
  hand('soft-shaker', 'Soft Shaker', ['lofi', 'ambient', 'boom-bap'], 1, 'chill', { shaker: '4.2.4.2.4.2.4.2.', snap: '....3.......3...' }),
  hand('conga-groove', 'Conga Groove', ['house', 'garage'], 2, 'bouncy', {
    shaker: '4263426342634263',
    highConga: '...x.......x....|...x......x.....',
    lowConga: '......xo......x.|......x......x..',
  }),
  hand('bongo-chatter', 'Bongo Chatter', ['house', 'funk'], 2, 'bright', {
    bongoHi: 'x.o.x.ox.o..x.o.|x.o.x.ox..o.x.xo',
    bongoLo: '...x.....x.....x|...x.....x......',
  }),
  hand('tambourine-lift', 'Tambourine Lift', ['pop', 'rock', 'funk'], 1, 'bright', { tambourine: '....x.......x...', shaker: 'x5x5x5x5x5x5x5x5' }),
  hand('clave-son', 'Clave Two-Three', ['reggaeton', 'afrobeats', 'house'], 2, 'bouncy', { clave: '....x.x.........|x..x...x........', shaker: '4.4.4.4.4.4.4.4.' }),
  hand('cowbell-push', 'Cowbell Push', ['funk', 'house', 'breakbeat'], 1, 'driving', { cowbell: 'x.x.x.xxx.x.x.x.', woodblock: '...o.......o....' }),
  hand('cajon-pocket', 'Cajon Pocket', ['pop', 'lofi', 'boom-bap'], 2, 'chill', {
    cajon: 'X......x..X.....|X.........X..x..',
    snap: '....x.......x...',
    shaker: '3.3.3.3.3.3.3.3.',
  }),
  hand('agogo-bells', 'Agogo Bells', ['afrobeats', 'reggaeton'], 2, 'bright', {
    agogoHi: 'x..x..x...x.x...|x..x..x...x.....',
    agogoLo: '.......x.......x|.......x....x...',
  }),
  hand('guiro-scrape', 'Guiro Scrape', ['reggaeton', 'funk'], 2, 'bouncy', { guiro: 'x.......x.......|x.......x...x...', clave: '...x..x....x..x.' }),
  hand('triangle-sparkle', 'Triangle Sparkle', ['ambient', 'pop', 'synthwave'], 2, 'bright', { triangle: '..x...x...x...x.|..x...x...x.x.x.', cabasa: 'x3x3x3x3x3x3x3x3' }),
  hand('night-hands', 'Night Hands', ['techno', 'dnb'], 2, 'dark', {
    lowConga: 'x.....x...x.....|x.....x.....x...',
    bongoLo: '...o.......o..o.',
    cabasa: '..x...x...x...x.',
  }),
  hand('trap-snaps', 'Snaps & Shaker', ['trap', 'pop'], 2, 'dark', { snap: '........X.......', shaker: 'x.x.x.x.x.x.xxxx|x.x.x.x.x.x.x.x.' }),
  afro('djembe-talk', 'Djembe Talk', ['afrobeats', 'house'], 2, 'bouncy', {
    djembeBass: 'X.........x.....|X.....x...x.....',
    djembeTone: '...x..x....x....|...x..x.......x.',
    djembeSlap: '.......X.......X|.......X..X.....',
    shekere: '4.4.4.4.4.4.4.4.',
  }),
  afro('market-day', 'Market Day', ['afrobeats', 'pop'], 2, 'bright', {
    agogo: 'x.x..x.x..x.x...|x.x..x.x..x..x..',
    shekere: '5353535353535353',
    talkingDrum: '..........x..x..|..........x.....',
  }),
  afro('surdo-march', 'Surdo March', ['afrobeats', 'reggaeton', 'techno'], 2, 'driving', {
    surdo: '....X.......X...|....X.......X.x.',
    timbaleHi: '..x...x...x...x.',
    timbaleLo: '.x.....x.x.....x|.x.....x....x..x',
    ganza: 'x5x5x5x5x5x5x5x5',
  }),
  afro('shekere-sway', 'Shekere Sway', ['afrobeats', 'lofi', 'ambient'], 1, 'chill', { shekere: 'x..4x..4x..4x..4', claves: '...x..x.....x...' }),
  afro('udu-drops', 'Udu Drops', ['ambient', 'lofi', 'dnb'], 2, 'dark', { udu: 'x.......x.....x.|x.........x.....', caxixi: '..3...3...3...3.', bell: '................|............o...' }),
];
