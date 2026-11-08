/**
 * Chord and pad loops: progressions of scale degrees ("6^7" is the seventh
 * chord on degree 6) with a hit rhythm or an arpeggio (model.ts explains the
 * notation). Voicings are chosen in the part's register when the loop is
 * placed, voice-led from chord to chord. Original progressions and rhythms.
 */
import type { LibraryLoop, LoopBars, LoopFeel, LoopGenre, LoopPart } from './model';

type ChordOpts = Omit<Extract<LoopPart, { kind: 'chords' }>, 'kind' | 'prog'> & { suits?: 'major' | 'minor' };

function harmony(
  role: 'chords' | 'pad',
  id: string,
  name: string,
  genres: LoopGenre[],
  bars: LoopBars,
  feel: LoopFeel,
  sound: string,
  prog: string,
  opts: ChordOpts,
): LibraryLoop {
  const { suits, ...part } = opts;
  return { id: `loop-${role}-${id}`, name, role, genres, bars, feel, sound, ...(suits ? { suits } : {}), part: { kind: 'chords', prog, ...part } };
}

const chords = (...a: Parameters<typeof harmony> extends [unknown, ...infer R] ? R : never) => harmony('chords', ...a);
const pad = (...a: Parameters<typeof harmony> extends [unknown, ...infer R] ? R : never) => harmony('pad', ...a);

/** Held for the whole bar. */
const HOLD = 'x---------------';

export const CHORD_LOOPS: readonly LibraryLoop[] = [
  chords('offbeat-stabs', 'Off-Beat Stabs', ['house', 'garage'], 2, 'bouncy', 'poly-house-stab', '1^7 4^7', { rhythm: '...x..x-..X..x..|..x...x-...x.x..', gate: 0.8 }),
  chords('four-chord-pop', 'Four Chord Pop', ['pop', 'rock'], 4, 'bright', 'poly-glass-keys', '1 5 6 4', { rhythm: 'x-------x---x---', suits: 'major' }),
  chords('dusty-sevenths', 'Dusty Sevenths', ['lofi', 'boom-bap'], 4, 'chill', 'poly-dusty-keys', '2^7 5^7 1^7 1^7', { rhythm: 'x-----------..x-', vel: 0.75, suits: 'major' }),
  chords('soul-keys', 'Soul Keys', ['boom-bap', 'funk'], 4, 'chill', 'poly-tine-piano', '1^7 4^7', { per: 'two', rhythm: 'x-----..x-----..|..x-----..x---..', vel: 0.8 }),
  chords('minor-drift', 'Minor Drift', ['lofi', 'trap'], 4, 'dark', 'poly-felt-piano', '1^7 6^7 4^7 5', { rhythm: HOLD, vel: 0.65, suits: 'minor' }),
  chords('night-chords', 'Night Chords', ['trap', 'synthwave'], 4, 'dark', 'poly-lumen-chords', '1 6 3 7', { rhythm: 'x-------x-------', vel: 0.7, suits: 'minor' }),
  chords('bright-skank', 'Bright Skank', ['afrobeats', 'pop'], 4, 'bright', 'poly-soft-pluck', '1 4 6 5', { rhythm: '..x..x.x..x..x..', gate: 0.6 }),
  chords('island-chops', 'Island Chops', ['reggaeton'], 4, 'bouncy', 'poly-short-pluck', '1 6 4 5', { rhythm: '...x..x....x..x.', gate: 0.7 }),
  chords('piano-ballad', 'Piano Ballad', ['pop', 'ambient'], 4, 'chill', 'poly-bright-piano', '1 6 4 5', { rhythm: 'x-------x-------', vel: 0.7 }),
  chords('rave-stabs', 'Rave Stabs', ['breakbeat', 'techno'], 1, 'driving', 'poly-house-stab', '1', { rhythm: 'x..x..x...x..x..', gate: 0.7 }),
  chords('synth-arp', 'Synth Arp', ['synthwave', 'pop'], 4, 'driving', 'poly-short-pluck', '1 6 4 5', { arp: '0121012101210121' }),
  chords('house-piano', 'House Piano', ['house'], 2, 'bright', 'poly-bright-piano', '1 4', { rhythm: 'x..x..x...x..x..|x..x..x...x..x.x', gate: 0.75 }),
  chords('garage-organ', 'Garage Organ', ['garage', 'house'], 2, 'bouncy', 'poly-click-organ', '1^7 4^7', { rhythm: 'x..x..x.....x...', gate: 0.6 }),
  chords('funk-chops', 'Funk Chops', ['funk', 'breakbeat'], 1, 'bouncy', 'poly-funky-clav', '1^7', { rhythm: '.x.x..x..x.x..x.', gate: 0.5 }),
  chords('rock-drive', 'Rock Drive', ['rock'], 4, 'driving', 'poly-synth-brass', '1 4 6 4', { rhythm: 'x.x.x.x.x.x.x.x.', gate: 0.85 }),
  chords('slow-swell', 'Slow Swell', ['ambient', 'lofi'], 4, 'chill', 'poly-warm-drift', '1 4', { per: 'two', rhythm: HOLD, vel: 0.6 }),
  chords('bouncy-pluck', 'Bouncy Pluck', ['pop', 'house'], 4, 'bouncy', 'poly-soft-pluck', '1 5 6 4', { arp: '0.1.2.1.0.1.2.1.' }),
  chords('dark-pulse', 'Dark Pulse', ['techno', 'dnb'], 2, 'dark', 'poly-lumen-chords', '1 6', { rhythm: 'xoxoxoxoxoxoxoxo', gate: 0.5, vel: 0.8, suits: 'minor' }),
  chords('jazz-rain', 'Jazz Rain', ['lofi', 'boom-bap'], 4, 'chill', 'poly-dusty-keys', '4^7 3^7 2^7 1^7', { rhythm: 'x-------...x----', vel: 0.7, suits: 'minor' }),
  chords('gospel-lift', 'Gospel Lift', ['pop', 'funk'], 4, 'bright', 'poly-drawbar-organ', '4 5 3 6', { rhythm: 'x-----x-----x---', vel: 0.75, suits: 'major' }),
  chords('liquid-keys', 'Liquid Keys', ['dnb', 'garage'], 4, 'chill', 'poly-tine-piano', '1^7 6^7', { per: 'two', rhythm: 'x-------..x-----', vel: 0.75 }),
  chords('sunny-arp', 'Sunny Arp', ['afrobeats', 'pop'], 4, 'bright', 'poly-kalimba', '1 4 5 4', { arp: '0.1.2.10.2.1.2.1' }),
];

export const PAD_LOOPS: readonly LibraryLoop[] = [
  pad('warm-bed', 'Warm Bed', ['house', 'pop', 'ambient'], 4, 'chill', 'poly-warm-drift', '1^7 6^7 4^7 5', { rhythm: HOLD, vel: 0.6 }),
  pad('long-glow', 'Long Glow', ['ambient', 'synthwave'], 8, 'chill', 'poly-halo-pad', '1 4 6 5', { per: 'two', rhythm: HOLD, vel: 0.6 }),
  pad('night-air', 'Night Air', ['trap', 'dnb'], 4, 'dark', 'poly-velvet-pad', '1 6', { per: 'two', rhythm: HOLD, vel: 0.65, suits: 'minor' }),
  pad('string-rise', 'String Rise', ['pop', 'trap'], 4, 'bright', 'poly-string-ensemble', '1 5 6 4', { rhythm: HOLD, vel: 0.6 }),
  pad('choir-hum', 'Choir Hum', ['ambient', 'trap', 'lofi'], 4, 'dark', 'poly-choir-ooh', '1 4', { per: 'two', rhythm: HOLD, vel: 0.6 }),
  pad('analog-sweep', 'Analog Sweep', ['synthwave'], 4, 'bright', 'poly-analog-pad', '1 6 3 7', { rhythm: HOLD, vel: 0.62, suits: 'minor' }),
  pad('glass-hold', 'Glass Hold', ['ambient', 'techno'], 2, 'chill', 'poly-glass-pad', '1^7', { per: 'two', rhythm: HOLD, vel: 0.6 }),
  pad('soft-strings', 'Soft Strings', ['lofi', 'boom-bap', 'pop'], 4, 'chill', 'poly-cinematic-strings', '6^7 4^7 1^7 5', { rhythm: HOLD, vel: 0.55 }),
  pad('pulse-pad', 'Pulse Pad', ['house', 'garage'], 2, 'bouncy', 'poly-halo-pad', '1^7 4^7', { rhythm: 'x---x---x---x---', vel: 0.55 }),
  pad('supersaw-lift', 'Supersaw Lift', ['house', 'pop', 'breakbeat'], 4, 'bright', 'poly-supersaw-pad', '6 4 1 5', { rhythm: HOLD, vel: 0.55 }),
  pad('deep-drone', 'Deep Drone', ['techno', 'ambient'], 4, 'dark', 'poly-velvet-pad', '1 - - -', { rhythm: HOLD, vel: 0.55 }),
  pad('breath-chords', 'Breath Chords', ['ambient', 'lofi'], 4, 'chill', 'poly-breath-pad', '4^7 1^7', { per: 'two', rhythm: HOLD, vel: 0.6 }),
  pad('sunrise', 'Sunrise', ['afrobeats', 'pop'], 4, 'bright', 'poly-warm-drift', '4 5 1 1', { rhythm: HOLD, vel: 0.6, suits: 'major' }),
  pad('dark-strings', 'Dark Strings', ['trap', 'dnb', 'techno'], 4, 'dark', 'poly-cinematic-strings', '1 6 4 6', { rhythm: HOLD, vel: 0.6, suits: 'minor' }),
  pad('gated-pad', 'Gated Pad', ['trap', 'synthwave', 'house'], 2, 'driving', 'poly-supersaw-pad', '1 6', { rhythm: 'x-.x-.x-x-.x-.x-', vel: 0.5, gate: 0.8 }),
  pad('dusty-organ', 'Dusty Organ', ['boom-bap', 'lofi', 'funk'], 4, 'chill', 'poly-drawbar-organ', '1^7 4^7', { per: 'two', rhythm: HOLD, vel: 0.55 }),
];
