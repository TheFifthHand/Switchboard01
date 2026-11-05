/**
 * The built-in loop library: types, the style list and realization (pure,
 * architecture layer 1).
 *
 * Loops are original musical text, never audio. Pitched loops are written in
 * scale degrees (key-relative), so `realizeLoop` places them in the project's
 * own key and scale and in the register of the part they are dropped on.
 * Drum loops name kit voices; dropped on a kit with a different layout (a
 * standard kit, Hand Percussion or Afro Latin) each voice moves to the pad
 * that plays the same job there (a conga line on a standard kit plays toms).
 *
 * Writing pitched loops
 * ---------------------
 * Lines (`kind: 'line'`) use the starter DSL's token rules (see dsl.ts `seq`):
 * one token per `unit` sixteenths, '.' rest, '-' tie, '|' ignored, suffixes
 * '!' accent, '?' soft, '~' slide. A note is a scale degree 1..7, then "'"
 * per octave up or ',' per octave down: "1" tonic, "5," the fifth below it,
 * "3'" the third above the next tonic. '+' stacks degrees: "1+5".
 *
 * Chord loops (`kind: 'chords'`) give a progression of degrees, one per
 * `per` (bar by default; '-' holds the previous chord), "^7" for a seventh
 * chord ("6^7"), and a rhythm grid with drum-grid characters (tiled; '-'
 * lengthens a hit). Or an `arp` grid: one character per 16th, a digit picks
 * that chord tone counted from the bottom (past the top it continues an
 * octave up), '.' rests and '-' ties.
 *
 * Degrees count in the seven-note scale behind the key (pentatonic and blues
 * keys borrow major or minor, as chords.ts does); a note the key does not
 * have moves to its nearest note. A triad whose fifth is not perfect (the
 * diminished chord on degree 7 in major, 2 in minor, 5 in Phrygian) drops
 * the fifth, so any progression stays consonant in every key.
 */
import { kitInfo } from '../catalog';
import { AFRO, DRUM, HAND, clip, gridNotes, type NoteData } from '../starters/dsl';
import { diatonicChord, harmonicParent, voiceLeadProgression } from '../../music/chords';
import { SCALES, isInScale, pitchClass, snapToScale } from '../../music/scales';
import { STEPS_PER_BAR, TICKS_PER_STEP, type ClipBars, type InstrumentKind, type ScaleId, type TrackRole } from '../../project/types';

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/** The parts a loop is written for (every track role except the sampler). */
export type LoopRole = Exclude<TrackRole, 'sampler'>;
export const LOOP_ROLES: readonly LoopRole[] = ['drums', 'percussion', 'bass', 'chords', 'lead', 'pad', 'texture'];

/** Plain names for the library's part filter. */
export const LOOP_ROLE_NAMES: Record<LoopRole, string> = {
  drums: 'Beats',
  percussion: 'Percussion',
  bass: 'Bass',
  chords: 'Chords',
  lead: 'Melody',
  pad: 'Pads',
  texture: 'Textures',
};

export type LoopGenre =
  | 'house'
  | 'techno'
  | 'trap'
  | 'lofi'
  | 'boom-bap'
  | 'pop'
  | 'afrobeats'
  | 'dnb'
  | 'garage'
  | 'breakbeat'
  | 'synthwave'
  | 'ambient'
  | 'funk'
  | 'rock'
  | 'reggaeton';

/** Styles in display order, with the name people see. */
export const GENRES: readonly { id: LoopGenre; name: string }[] = [
  { id: 'boom-bap', name: 'Boom Bap' },
  { id: 'trap', name: 'Trap' },
  { id: 'lofi', name: 'Lo-fi' },
  { id: 'pop', name: 'Pop' },
  { id: 'afrobeats', name: 'Afrobeats' },
  { id: 'house', name: 'House' },
  { id: 'techno', name: 'Techno' },
  { id: 'garage', name: 'Garage' },
  { id: 'dnb', name: 'Drum & Bass' },
  { id: 'breakbeat', name: 'Breakbeat' },
  { id: 'synthwave', name: 'Synthwave' },
  { id: 'funk', name: 'Funk' },
  { id: 'rock', name: 'Rock' },
  { id: 'reggaeton', name: 'Reggaeton' },
  { id: 'ambient', name: 'Ambient' },
];

export type LoopFeel = 'chill' | 'driving' | 'bouncy' | 'dark' | 'bright';
export const FEELS: readonly LoopFeel[] = ['chill', 'driving', 'bouncy', 'dark', 'bright'];

/** Library loops are 1, 2, 4 or 8 bars. */
export type LoopBars = Extract<ClipBars, 1 | 2 | 4 | 8>;

/** Which kit layout a drum grid's voice names belong to. */
export type DrumLayout = 'kit' | 'hand' | 'afro';

export type LoopPart =
  | {
      kind: 'drums';
      layout: DrumLayout;
      /** One grid per voice of the layout (dsl.ts DRUM, HAND or AFRO names), tiled to the loop length. */
      grid: Readonly<Record<string, string>>;
      /** Optional 32nd-note grids (32 characters per bar) layered on top: hi-hat rolls. */
      fine?: Readonly<Record<string, string>>;
    }
  | {
      kind: 'line';
      line: string;
      /** Sixteenths per token (default 1). */
      unit?: number;
      /** Fraction of each written length that sounds (default 0.9). */
      gate?: number;
      /** Velocity of a plain note (default 0.8). */
      vel?: number;
    }
  | {
      kind: 'chords';
      /** Degrees, one per `per`; "^7" makes a seventh chord; '-' holds the previous chord. */
      prog: string;
      per?: 'bar' | 'half' | 'two';
      /** Hit rhythm (drum-grid characters); ignored when `arp` is given. */
      rhythm?: string;
      /** Arpeggio grid: chord-tone digits per 16th. */
      arp?: string;
      /** Fraction of each hit that sounds (default 0.92). */
      gate?: number;
      /** Velocity scale for the rhythm's hits (default 1). */
      vel?: number;
    };

export interface LibraryLoop {
  /** Stable kebab-case id (saved with what the user makes from it). */
  readonly id: string;
  /** Short, plain name: "Steady Four", "Bouncy Bass". */
  readonly name: string;
  readonly role: LoopRole;
  readonly genres: readonly LoopGenre[];
  readonly bars: LoopBars;
  readonly feel: LoopFeel;
  /** The catalogue sound it was written for (kit, preset or recording id). */
  readonly sound: string;
  /** Pitched loops written with major or minor in mind (they work in both). */
  readonly suits?: 'major' | 'minor';
  readonly part: LoopPart;
}

/* ------------------------------------------------------------------ */
/* Realization                                                         */
/* ------------------------------------------------------------------ */

export interface RealizeTarget {
  /** Project key. */
  root: number;
  scale: ScaleId;
  /** Instrument kind of the part that will play the loop. */
  kind: InstrumentKind;
  /** The drum part's kit, so drum voices move to the matching pads. */
  kitId?: string;
  /** The part's role, for the register of pitched loops (defaults to the loop's role). */
  role?: TrackRole;
}

export interface RealizedLoop {
  name: string;
  bars: LoopBars;
  notes: NoteData[];
}

/** Can this loop play on a part of this instrument kind? Drum loops need a kit; pitched loops a synth or sampler. */
export function loopFitsKind(loop: LibraryLoop, kind: InstrumentKind): boolean {
  return loop.part.kind === 'drums' ? kind === 'drums' : kind !== 'drums';
}

/** The kit layout a kit id uses. */
export function kitLayout(kitId: string | undefined): DrumLayout | null {
  if (!kitId) return null;
  const info = kitInfo(kitId);
  if (!info) return null;
  if (info.family === 'kit') return 'kit';
  return kitId === 'afro-latin' ? 'afro' : 'hand';
}

const LAYOUT_SLOTS: Record<DrumLayout, Readonly<Record<string, number>>> = { kit: DRUM, hand: HAND, afro: AFRO };

/** Voice name to pad index for a layout (dsl.ts DRUM, HAND or AFRO). */
export function layoutSlots(layout: DrumLayout): Readonly<Record<string, number>> {
  return LAYOUT_SLOTS[layout];
}

/**
 * Where each voice goes on another layout: the pad that does the same job
 * (lowest drum, a shaker, a bright click, a metal bell...).
 */
const VOICE_MAP: Record<DrumLayout, Partial<Record<DrumLayout, Readonly<Record<string, string>>>>> = {
  kit: {
    hand: {
      kick: 'cajon', kick2: 'cajon', snare: 'highConga', clap: 'snap', hat: 'shaker', openHat: 'tambourine', shaker: 'cabasa', rim: 'clave',
      lowTom: 'lowConga', midTom: 'highConga', highTom: 'bongoHi', bell: 'cowbell', crash: 'triangle', ride: 'agogoHi', perc: 'woodblock', fx: 'guiro',
    },
    afro: {
      kick: 'djembeBass', kick2: 'surdo', snare: 'djembeSlap', clap: 'handClap', hat: 'shekere', openHat: 'ganza', shaker: 'caxixi', rim: 'claves',
      lowTom: 'talkingDrum', midTom: 'timbaleLo', highTom: 'timbaleHi', bell: 'agogo', crash: 'bell', ride: 'bell', perc: 'udu', fx: 'cuica',
    },
  },
  hand: {
    kit: {
      lowConga: 'lowTom', highConga: 'midTom', bongoLo: 'midTom', bongoHi: 'highTom', shaker: 'shaker', tambourine: 'openHat', cabasa: 'hat', clave: 'rim',
      woodblock: 'perc', agogoLo: 'bell', agogoHi: 'bell', cowbell: 'bell', triangle: 'ride', guiro: 'fx', cajon: 'kick', snap: 'clap',
    },
    afro: {
      lowConga: 'djembeTone', highConga: 'djembeSlap', bongoLo: 'timbaleLo', bongoHi: 'timbaleHi', shaker: 'shekere', tambourine: 'ganza', cabasa: 'caxixi', clave: 'claves',
      woodblock: 'udu', agogoLo: 'agogo', agogoHi: 'bell', cowbell: 'agogo', triangle: 'bell', guiro: 'cuica', cajon: 'djembeBass', snap: 'handClap',
    },
  },
  afro: {
    kit: {
      djembeBass: 'kick', djembeTone: 'lowTom', djembeSlap: 'snare', talkingDrum: 'midTom', shekere: 'shaker', caxixi: 'hat', ganza: 'openHat', claves: 'rim',
      surdo: 'kick2', timbaleLo: 'midTom', timbaleHi: 'highTom', agogo: 'bell', cuica: 'fx', bell: 'ride', udu: 'perc', handClap: 'clap',
    },
    hand: {
      djembeBass: 'cajon', djembeTone: 'lowConga', djembeSlap: 'highConga', talkingDrum: 'bongoLo', shekere: 'shaker', caxixi: 'cabasa', ganza: 'tambourine', claves: 'clave',
      surdo: 'cajon', timbaleLo: 'bongoLo', timbaleHi: 'bongoHi', agogo: 'agogoLo', cuica: 'guiro', bell: 'cowbell', udu: 'woodblock', handClap: 'snap',
    },
  },
};

/** A grid written for one layout, with its voices renamed for another. */
export function mapDrumGrid(grid: Readonly<Record<string, string>>, from: DrumLayout, to: DrumLayout): Record<string, string> {
  if (from === to) return { ...grid };
  const map = VOICE_MAP[from][to]!;
  const out: Record<string, string> = {};
  for (const [voice, pattern] of Object.entries(grid)) {
    const target = map[voice];
    if (!target) throw new Error(`Loop library: no ${to} pad for the ${from} voice "${voice}".`);
    // Two voices may land on one pad: keep both hit lists (clip() merges equal hits, the louder wins).
    out[target] = out[target] === undefined ? pattern : mergeGrids(out[target], pattern);
  }
  return out;
}

/** Two grids of one pad as one: at each step the louder character. */
function mergeGrids(a: string, b: string): string {
  const ca = a.replace(/[\s|]/g, '');
  const cb = b.replace(/[\s|]/g, '');
  const len = lcmLen(ca.length, cb.length);
  const strength = (c: string) => (c === 'X' ? 10 : c === 'x' ? 8 : c === 'o' ? 4.2 : c >= '1' && c <= '9' ? Number(c) : c === '-' ? 0.5 : 0);
  let out = '';
  for (let i = 0; i < len; i++) {
    const x = ca[i % ca.length];
    const y = cb[i % cb.length];
    out += strength(y) > strength(x) ? y : x;
  }
  return out;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcmLen = (a: number, b: number) => (a * b) / gcd(a, b);

/** Register of pitched parts: [lowest, highest] and the centre a line is placed around (MIDI). */
const REGISTER: Record<TrackRole, { low: number; high: number; centre: number }> = {
  drums: { low: 0, high: 15, centre: 7 },
  percussion: { low: 0, high: 15, centre: 7 },
  bass: { low: 28, high: 55, centre: 40 },
  chords: { low: 50, high: 74, centre: 62 },
  lead: { low: 57, high: 88, centre: 72 },
  pad: { low: 48, high: 76, centre: 62 },
  texture: { low: 45, high: 91, centre: 70 },
  sampler: { low: 48, high: 76, centre: 62 },
};

/** Semitones above the tonic of a degree token's notes, before snapping to the key. */
function degreeSemis(token: string, parent: readonly number[]): number[] {
  return token.split('+').map((part) => {
    const m = /^([1-7])([',]*)$/.exec(part);
    if (!m) throw new Error(`Loop library: cannot read the degree "${part}".`);
    let oct = 0;
    for (const c of m[2]) oct += c === "'" ? 1 : -1;
    return parent[Number(m[1]) - 1] + 12 * oct;
  });
}

interface LineEvent {
  step: number;
  steps: number;
  semis: number[];
  velocity: number;
  slide: boolean;
}

/** Parse a degree line into events (steps in sixteenths). */
function parseLine(src: string, unit: number, vel: number, parent: readonly number[]): LineEvent[] {
  const tokens = src.split(/\s+/).filter((t) => t && t !== '|');
  const out: LineEvent[] = [];
  let current: LineEvent | null = null;
  tokens.forEach((tok, i) => {
    if (tok === '-') {
      if (current) current.steps += unit;
      return;
    }
    current = null;
    if (tok === '.') return;
    const m = /^([^!?~]+)([!?~]*)$/.exec(tok);
    if (!m) throw new Error(`Loop library: cannot read "${tok}".`);
    const velocity = m[2].includes('!') ? 1 : m[2].includes('?') ? 0.5 : vel;
    current = { step: i * unit, steps: unit, semis: degreeSemis(m[1], parent), velocity, slide: m[2].includes('~') };
    out.push(current);
  });
  return out;
}

/** Number of sixteenths a line or grid covers. */
export function lineSteps(src: string, unit = 1): number {
  return src.split(/\s+/).filter((t) => t && t !== '|').length * unit;
}

/** The tonic (MIDI) that places semitone offsets `semis` best inside a register (judged on the notes in key). */
function placeTonic(t: RealizeTarget, semis: readonly number[], reg: { low: number; high: number; centre: number }): number {
  let best = 0;
  let bestCost = Infinity;
  for (let tonic = pitchClass(t.root); tonic + Math.max(...semis) <= 127; tonic += 12) {
    if (tonic + Math.min(...semis) < 0) continue;
    const notes = semis.map((s) => inKey(tonic + s, t.root, t.scale));
    const lo = Math.min(...notes) - tonic;
    const hi = Math.max(...notes) - tonic;
    // Too low is worse than too high: a bass under E1 turns to mud.
    const cost = Math.max(0, reg.low - (tonic + lo)) * 100 + Math.max(0, tonic + hi - reg.high) * 10 + Math.abs(tonic + (lo + hi) / 2 - reg.centre);
    if (cost < bestCost) {
      bestCost = cost;
      best = tonic;
    }
  }
  return best;
}

/** A pitch in key: notes the key does not have move to the nearest one it has. */
function inKey(midi: number, root: number, scale: ScaleId): number {
  return isInScale(midi, root, scale) ? midi : snapToScale(midi, root, scale);
}

function realizeLine(part: Extract<LoopPart, { kind: 'line' }>, bars: number, t: RealizeTarget, role: TrackRole): NoteData[] {
  const unit = part.unit ?? 1;
  const gate = part.gate ?? 0.9;
  const parent = SCALES[harmonicParent(t.scale)].intervals;
  const events = parseLine(part.line, unit, part.vel ?? 0.8, parent);
  if (lineSteps(part.line, unit) !== bars * STEPS_PER_BAR) throw new Error(`Loop library: a line does not cover ${bars} bar(s).`);
  const tonic = placeTonic(t, events.flatMap((e) => e.semis), REGISTER[role]);
  const out: NoteData[] = [];
  for (const e of events) {
    const written = e.steps * TICKS_PER_STEP;
    // A slide holds through to overlap the next note, so a mono bass glides into it (as dsl.ts seq does).
    const duration = e.slide ? written + TICKS_PER_STEP / 3 : written * gate;
    const pitches = new Set(e.semis.map((s) => inKey(tonic + s, t.root, t.scale)));
    for (const pitch of pitches) out.push({ tick: e.step * TICKS_PER_STEP, pitch, velocity: e.velocity, duration });
  }
  return out;
}

/** One diatonic chord (pitch classes matter; the voicing is chosen later), consonant in any key. */
function keyChord(token: string, t: RealizeTarget): number[] {
  const m = /^([1-7])(\^7)?$/.exec(token);
  if (!m) throw new Error(`Loop library: cannot read the chord "${token}".`);
  const degree = Number(m[1]) - 1;
  const notes = diatonicChord(t.root, t.scale, degree, m[2] ? 4 : 3, 4);
  // Not a perfect fifth (diminished or augmented): leave the fifth out.
  const voiced = notes[2] - notes[0] === 7 ? notes : notes.filter((_, i) => i !== 2);
  const pcs = new Set<number>();
  const out: number[] = [];
  for (const n of voiced) {
    const p = inKey(n, t.root, t.scale);
    if (pcs.has(pitchClass(p))) continue;
    pcs.add(pitchClass(p));
    out.push(p);
  }
  return out;
}

const PER_STEPS = { half: 8, bar: 16, two: 32 } as const;

/** Parse a grid's hits (drum-grid characters): step, length in steps and velocity. */
function gridHits(pattern: string, totalSteps: number): { step: number; len: number; velocity: number }[] {
  // gridNotes on a one-voice layout reads the same characters the drum grids use.
  return gridNotes(totalSteps / STEPS_PER_BAR, { v: 0 }, { v: pattern }).map((n) => ({
    step: n.tick / TICKS_PER_STEP,
    len: n.duration / TICKS_PER_STEP,
    velocity: n.velocity,
  }));
}

function realizeChords(part: Extract<LoopPart, { kind: 'chords' }>, bars: number, t: RealizeTarget, role: TrackRole): NoteData[] {
  const per = PER_STEPS[part.per ?? 'bar'];
  const tokens = part.prog.split(/\s+/).filter((x) => x && x !== '|');
  if (tokens.length * per !== bars * STEPS_PER_BAR) throw new Error(`Loop library: progression "${part.prog}" does not cover ${bars} bar(s).`);
  const resolved: string[] = [];
  for (const tok of tokens) {
    if (tok === '-') {
      if (!resolved.length) throw new Error('Loop library: a progression cannot start with "-".');
      resolved.push(resolved[resolved.length - 1]);
    } else resolved.push(tok);
  }
  const reg = REGISTER[role];
  const chords = voiceLeadProgression(
    resolved.map((tok) => keyChord(tok, t)),
    reg.low,
    reg.high,
  );
  const total = bars * STEPS_PER_BAR;
  const gate = part.gate ?? 0.92;
  const out: NoteData[] = [];
  if (part.arp) {
    for (const h of gridHits(part.arp.replace(/[0-9]/g, 'x'), total)) {
      const chars = part.arp.replace(/[\s|]/g, '');
      const digit = Number(chars[h.step % chars.length]);
      const chord = chords[Math.floor(h.step / per)];
      let pitch = chord[digit % chord.length] + 12 * Math.floor(digit / chord.length);
      // Past the top of the register the arpeggio folds back an octave.
      while (pitch > reg.high) pitch -= 12;
      // Downbeats lean a little: the arpeggio keeps its pulse.
      const velocity = h.step % 4 === 0 ? 0.8 : 0.66;
      out.push({ tick: h.step * TICKS_PER_STEP, pitch: inKey(pitch, t.root, t.scale), velocity, duration: h.len * TICKS_PER_STEP * gate });
    }
    return out;
  }
  if (!part.rhythm) throw new Error('Loop library: a chord loop needs a rhythm or an arp.');
  for (const h of gridHits(part.rhythm, total)) {
    const chord = chords[Math.floor(h.step / per)];
    // A hit held past the chord change stops at the change.
    const changeAt = (Math.floor(h.step / per) + 1) * per;
    const len = Math.min(h.len, changeAt - h.step);
    for (const pitch of chord) out.push({ tick: h.step * TICKS_PER_STEP, pitch, velocity: Math.min(1, h.velocity * (part.vel ?? 1)), duration: len * TICKS_PER_STEP * gate });
  }
  return out;
}

function realizeDrums(part: Extract<LoopPart, { kind: 'drums' }>, bars: number, t: RealizeTarget): NoteData[] {
  const to = kitLayout(t.kitId) ?? part.layout;
  const slots = LAYOUT_SLOTS[to];
  const notes = gridNotes(bars, slots, mapDrumGrid(part.grid, part.layout, to));
  if (part.fine) notes.push(...gridNotes(bars, slots, mapDrumGrid(part.fine, part.layout, to), 2 * STEPS_PER_BAR));
  return notes;
}

/**
 * The notes of a loop for a part: pitched loops in the project's key and the
 * part's register, drum loops on the part's kit layout. Throws when the loop
 * cannot play on that kind of instrument (see loopFitsKind).
 */
export function realizeLoop(loop: LibraryLoop, target: RealizeTarget): RealizedLoop {
  if (!loopFitsKind(loop, target.kind)) {
    throw new Error(loop.part.kind === 'drums' ? `"${loop.name}" is a drum loop: it needs a drum or percussion part.` : `"${loop.name}" plays notes: it needs a synth or sampler part, not a drum kit.`);
  }
  const role = target.role ?? loop.role;
  const notes =
    loop.part.kind === 'drums'
      ? realizeDrums(loop.part, loop.bars, target)
      : loop.part.kind === 'line'
        ? realizeLine(loop.part, loop.bars, target, role)
        : realizeChords(loop.part, loop.bars, target, role);
  const def = clip(loop.name, loop.bars, notes);
  return { name: def.name, bars: loop.bars, notes: def.notes.map((n) => ({ ...n })) };
}
