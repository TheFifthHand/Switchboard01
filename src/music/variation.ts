/**
 * Variation: bounded, deterministic musical pattern generation (not AI).
 *
 * `varyClip` returns a new note list derived from a clip with a seeded RNG,
 * so the same clip + seed + options always gives the same music (the store
 * keeps the seed in `clip.variation`, so saved projects and exports
 * reproduce it). Rules:
 *
 * - Bounded: at default intensity at most ~35% of the clip's notes change
 *   (changed + added + removed <= floor(0.7 * intensity * notes), at least 1,
 *   or 2 for clips of three or more notes, and never more than
 *   VARIATION_MAX_CHANGES).
 * - Never empties a clip; every note starts inside the clip; notes that are
 *   created or edited also end inside it, keep velocities in 0.05..1 and
 *   pitches in range. Notes Variation does not touch are returned as they
 *   were, with their ids; new notes get fresh ids.
 * - Stable when pressed again and again. Each press varies the clip as it is
 *   now, so every rule is written to settle rather than compound: registers
 *   are measured from notes Variation never moves (each bar's first note,
 *   the bass of each bar's first chord), ghost notes, echoes and approach
 *   tones are capped per bar and can be thinned again, accents move the
 *   existing dynamics between notes instead of scaling them, and new notes
 *   take their level from notes that do not change.
 * - Drums keep their anchors (kick on beats 1 and 3, snare/clap on 2 and 4,
 *   and every quarter kick of a four-on-the-floor bar) and vary hats,
 *   shakers and percussion, with an occasional choked open hat, ghost snare,
 *   one kick nudge and a short fill at the end of the clip.
 * - Melodic lines keep the first note of every bar (its harmony root: start,
 *   pitch and level; a bass root also keeps its length apart from at most a
 *   16th given to an approach tone) and vary rhythm, octave, passing and
 *   neighbour tones (in scale), phrasing, rests and accents. Basses never
 *   rise more than an octave above their own note. Sampler parts keep every
 *   pitch (a recording's pitch is also its speed and its own harmony) and
 *   their bar-first hits untouched, so they vary rhythm, repeats, lengths
 *   and accents only.
 * - Chord parts keep their harmony: every chord keeps its pitch classes and
 *   each bar's first chord keeps its timing and bass note; only voicing,
 *   inversion, stab rhythm, length or accents change.
 */
import { uid } from '../project/factory';
import { Rng, subSeed } from '../project/rng';
import {
  TICKS_PER_BAR,
  TICKS_PER_BEAT,
  TICKS_PER_STEP,
  type Clip,
  type InstrumentKind,
  type Note,
  type ScaleId,
  type TrackRole,
} from '../project/types';
import { chordVoicings, pitchClassSet, voiceChord, voiceLeadingDistance } from './chords';
import { snapToScale, transposeInScale } from './scales';

export interface VariationOptions {
  seed: number;
  role: TrackRole;
  kind: InstrumentKind;
  /** Project root pitch class 0..11. */
  root: number;
  scale: ScaleId;
  /** 0..1, default 0.5. Scales how many notes may change. */
  intensity?: number;
}

/** Fraction of notes that may change at intensity 1 (half of it at the default 0.5). */
export const VARIATION_CHANGE_RATIO_AT_FULL = 0.7;
export const VARIATION_DEFAULT_INTENSITY = 0.5;
export const VARIATION_MIN_VELOCITY = 0.05;
/** However large the clip, one Variation changes at most this many notes (it stays a variation, and stays fast). */
export const VARIATION_MAX_CHANGES = 64;

const STEP = TICKS_PER_STEP;
const BEAT = TICKS_PER_BEAT;
const BAR = TICKS_PER_BAR;
/** Recorded notes may sit slightly off the grid; positions within this many ticks count as "on" a grid point. */
const TOL = 6;
const MIN_DUR = 6;
/** Notes starting within this many ticks of each other form one chord. */
const CHORD_WINDOW = 6;
/** Two velocities closer than this sound the same; an accent needs more contrast. */
const MIN_ACCENT = 0.06;
/** A drum hit softer than this fraction of its lane's loudest hit counts as a ghost (or an echo). */
const GHOST_RATIO = 0.55;

/* Per-bar ceilings that keep repeated Variations from piling notes up. */
const MAX_HAT_HITS_PER_BAR = 12;
const MAX_HAT_GHOSTS_PER_BAR = 4;
const MAX_SNARE_GHOSTS_PER_BAR = 3;
/** Percussion echoes stop once a lane plays this often in a bar. */
const MAX_PERC_HITS_PER_BAR = 4;
/** Thinning never takes a percussion lane below this many hits in a bar. */
const MIN_PERC_HITS_PER_BAR = 2;
/** Approach tones and repeats are not added to a bar of a melodic line that already has this many notes ... */
const MAX_LINE_NOTES_PER_BAR = 8;
/** ... or this many ornaments (soft, short, off-beat notes such as approach tones and repeats). */
const MAX_ORNAMENTS_PER_BAR = 2;
/** An ornament is softer than this fraction of the bar-first notes' level (and no longer than a 16th). */
const ORNAMENT_LEVEL = 0.78;
/** Stab echoes stop once a bar has this many chord hits; drops keep at least MIN_STABS_PER_BAR. */
const MAX_STABS_PER_BAR = 6;
const MIN_STABS_PER_BAR = 2;

/* Registers Variation may move notes into (MIDI). */
const MELODIC_FLOOR = 24;
const MELODIC_CEILING = 108;

/**
 * Most notes (changed + added + removed) one Variation may touch. A clip of
 * three or more notes may always make one two-note gesture (an approach tone
 * that shortens the held note before it), so sparse parts such as held roots
 * still get a variation.
 */
export function variationBudget(noteCount: number, intensity = VARIATION_DEFAULT_INTENSITY): number {
  if (noteCount <= 0) return 0;
  const i = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : VARIATION_DEFAULT_INTENSITY;
  const floor = i > 0 && noteCount >= 3 ? 2 : 1;
  return Math.min(VARIATION_MAX_CHANGES, Math.max(floor, Math.floor(noteCount * VARIATION_CHANGE_RATIO_AT_FULL * i + 1e-9)));
}

/** A reproducible seed for the n-th Variation of a clip (store it in clip.variation.seed). */
export function variationSeed(projectSeed: number, clipId: string, generation: number): number {
  return subSeed(projectSeed >>> 0, `variation:${clipId}:${generation}`);
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const barOf = (tick: number) => Math.floor(tick / BAR);
const posInBar = (tick: number) => tick - barOf(tick) * BAR;
const near = (a: number, b: number, tol = TOL) => Math.abs(a - b) <= tol;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const clampVel = (v: number) => Math.min(1, Math.max(VARIATION_MIN_VELOCITY, round3(v)));
const endOf = (n: Note) => n.tick + n.duration;
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const maxOf = (xs: readonly number[]) => xs.reduce((m, x) => Math.max(m, x), 0);
const minOf = (xs: readonly number[]) => xs.reduce((m, x) => Math.min(m, x), Infinity);

function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** On an in-between 16th (the "e" or "a" of a beat) rather than on the 8th-note grid. */
const onOdd16th = (n: Note) => near(posInBar(n.tick) % (2 * STEP), STEP);

function compareNotes(a: Note, b: Note): number {
  return a.tick - b.tick || a.pitch - b.pitch || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function sorted(notes: readonly Note[]): Note[] {
  return [...notes].sort(compareNotes);
}

function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Swapping these two velocities would make an in-between 16th louder while
 * the 8th-note hit beside it gets quieter (ghost notes must stay ghosts).
 */
function buriesTheGrid(a: Note, b: Note): boolean {
  const [loud, soft] = a.velocity >= b.velocity ? [a, b] : [b, a];
  return onOdd16th(soft) && !onOdd16th(loud);
}

/**
 * Working copy of the clip that counts what has changed. Each original note
 * is edited at most once, which keeps the change count honest and bounded.
 */
class Draft {
  readonly notes: Note[];
  private readonly originals: Set<string>;
  private readonly touched = new Set<string>();
  private added = 0;

  constructor(
    src: readonly Note[],
    readonly budget: number,
    private readonly clipTicks: number,
  ) {
    this.notes = sorted(src).map((n) => ({ ...n }));
    this.originals = new Set(src.map((n) => n.id));
  }

  /** Edited and new notes end inside the clip and keep a usable velocity. */
  private fit(n: Note): void {
    n.velocity = Math.min(1, Math.max(VARIATION_MIN_VELOCITY, n.velocity));
    n.duration = Math.max(1, Math.min(n.duration, this.clipTicks - n.tick));
  }

  get used(): number {
    return this.touched.size + this.added;
  }

  get remaining(): number {
    return this.budget - this.used;
  }

  /** An original note that no rule has edited yet. */
  fresh(n: Note): boolean {
    return this.originals.has(n.id) && !this.touched.has(n.id);
  }

  canAfford(edits: readonly Note[], adds = 0): boolean {
    let c = adds;
    const seen = new Set<string>();
    for (const n of edits) {
      if (this.originals.has(n.id) && !this.touched.has(n.id) && !seen.has(n.id)) c++;
      seen.add(n.id);
    }
    return c <= this.remaining;
  }

  update(n: Note, patch: Partial<Omit<Note, 'id'>>): void {
    Object.assign(n, patch);
    this.fit(n);
    if (this.originals.has(n.id)) this.touched.add(n.id);
  }

  remove(n: Note): void {
    const i = this.notes.indexOf(n);
    if (i < 0) return;
    this.notes.splice(i, 1);
    if (this.originals.has(n.id)) this.touched.add(n.id);
    else this.added--;
  }

  add(n: Omit<Note, 'id'>): Note {
    const note: Note = { ...n, id: uid('n') };
    this.fit(note);
    this.notes.push(note);
    this.added++;
    return note;
  }

  /** Exchange two notes' velocities (an accent moves; the part's dynamics stay the same). */
  swapVelocities(a: Note, b: Note): boolean {
    if (a === b || Math.abs(a.velocity - b.velocity) < MIN_ACCENT || !this.canAfford([a, b])) return false;
    const va = a.velocity;
    this.update(a, { velocity: b.velocity });
    this.update(b, { velocity: va });
    return true;
  }

  result(): Note[] {
    return sorted(this.notes);
  }
}

interface Op {
  weight: number;
  run: () => boolean;
  /** Remove the op from the pool after its first success. */
  once?: boolean;
}

/** Run weighted random operations until `target` changes are used (never beyond the budget). */
function runOps(rng: Rng, draft: Draft, ops: readonly Op[], target: number): void {
  const pool = ops.filter((o) => o.weight > 0).map((o) => ({ ...o, fails: 0 }));
  let guard = 0;
  while (draft.used < target && draft.remaining > 0 && pool.length > 0 && guard++ < 400) {
    const total = pool.reduce((s, o) => s + o.weight, 0);
    let r = rng.float() * total;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) {
      r -= pool[idx].weight;
      if (r < 0) break;
    }
    const op = pool[idx];
    if (op.run()) {
      if (op.once) pool.splice(idx, 1);
    } else if (++op.fails >= 4) {
      pool.splice(idx, 1);
    }
  }
  // Variation should always do something audible when anything is possible.
  if (draft.used === 0) {
    for (const op of ops) {
      if (op.weight <= 0) continue;
      for (let k = 0; k < 4 && draft.used === 0; k++) op.run();
      if (draft.used > 0) break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Drums                                                               */
/* ------------------------------------------------------------------ */

const KICK = 0;
const KICK2 = 1;
const SNARE = 2;
const CLAP = 3;
const CLOSED_HAT = 4;
const OPEN_HAT = 5;
const PEDAL_HAT = 6;
const RIM = 7;
const LOW_TOM = 8;
const MID_TOM = 9;
const HIGH_TOM = 10;
const CRASH = 12;
const RIDE = 13;

const isKick = (p: number) => p === KICK || p === KICK2;
const isBackbeat = (p: number) => p === SNARE || p === CLAP;
const isToms = (p: number) => p === LOW_TOM || p === MID_TOM || p === HIGH_TOM;
/** Closed hat and slot 6 (a pedal hat in Tight Circuit, a shaker in other kits): kept off the open-hat steps either way. */
const isChoker = (p: number) => p === CLOSED_HAT || p === PEDAL_HAT;
const HAT_LANES = [CLOSED_HAT, PEDAL_HAT, RIDE];
/** Percussion lanes that may be shifted, echoed or thinned (kicks, anchors and crash are handled separately). */
const PERC_LANES = [RIM, LOW_TOM, MID_TOM, HIGH_TOM, 11, 14, 15];

/** Original last-beat fills: [tick offset in the bar, drum slot, velocity]. */
const FILLS: readonly (readonly [number, number, number])[][] = [
  [
    [312, SNARE, 0.42],
    [336, SNARE, 0.58],
    [360, SNARE, 0.8],
  ],
  [
    [288, HIGH_TOM, 0.72],
    [312, HIGH_TOM, 0.56],
    [336, MID_TOM, 0.7],
    [360, LOW_TOM, 0.86],
  ],
  [
    [312, SNARE, 0.5],
    [336, MID_TOM, 0.68],
    [360, LOW_TOM, 0.84],
  ],
  [
    [336, SNARE, 0.5],
    [348, SNARE, 0.34],
    [360, SNARE, 0.9],
  ],
  [
    [288, LOW_TOM, 0.7],
    [336, MID_TOM, 0.64],
    [360, HIGH_TOM, 0.82],
  ],
  [
    [312, HIGH_TOM, 0.62],
    [324, HIGH_TOM, 0.44],
    [348, MID_TOM, 0.66],
    [360, LOW_TOM, 0.88],
  ],
];

function varyDrums(draft: Draft, rng: Rng, clipTicks: number, role: TrackRole, intensity: number, target: number): void {
  const bars = clipTicks / BAR;
  const lane = (p: number) => draft.notes.filter((n) => n.pitch === p);
  const laneInBar = (p: number, bar: number) => draft.notes.filter((n) => n.pitch === p && barOf(n.tick) === bar);
  /** One pass over the notes: each lane's loudest hit and its hits per bar (keeps dense clips fast). */
  const laneStats = () => {
    const top = new Map<number, number>();
    const perBar = new Map<string, Note[]>();
    for (const n of draft.notes) {
      top.set(n.pitch, Math.max(top.get(n.pitch) ?? 0, n.velocity));
      const k = `${n.pitch}:${barOf(n.tick)}`;
      const list = perBar.get(k);
      if (list) list.push(n);
      else perBar.set(k, [n]);
    }
    return {
      /** A hit well below its lane's loudest (a ghost note or an echo). */
      isGhost: (n: Note) => n.velocity < GHOST_RATIO * (top.get(n.pitch) ?? 0),
      inBar: (n: Note) => perBar.get(`${n.pitch}:${barOf(n.tick)}`) ?? [],
    };
  };
  const occupied = (p: number, tick: number, tol: number, except?: Note) =>
    draft.notes.some((n) => n !== except && n.pitch === p && Math.abs(n.tick - tick) < tol);
  const fwd = (from: number, to: number) => (((to - from) % clipTicks) + clipTicks) % clipTicks;
  /** The last beat of the clip belongs to fills: shifts and echoes never move hits into or out of it. */
  const fillStart = (bars - 1) * BAR + 3 * BEAT;
  const inFillZone = (tick: number) => tick >= fillStart;

  // Anchors never change: kick on 1 and 3, snare/clap on 2 and 4, and the quarter kicks of four-on-the-floor bars.
  const protectedIds = new Set<string>();
  for (const n of draft.notes) {
    const pos = posInBar(n.tick);
    if (isKick(n.pitch) && (near(pos, 0) || near(pos, 2 * BEAT))) protectedIds.add(n.id);
    if (isBackbeat(n.pitch) && (near(pos, BEAT) || near(pos, 3 * BEAT))) protectedIds.add(n.id);
  }
  for (let b = 0; b < bars; b++) {
    const quarterKicks = [0, 1, 2, 3].map((q) => draft.notes.find((n) => isKick(n.pitch) && near(n.tick, b * BAR + q * BEAT)));
    if (quarterKicks.every(Boolean)) for (const k of quarterKicks) protectedIds.add((k as Note).id);
  }
  const free = (n: Note) => draft.fresh(n) && !protectedIds.has(n.id) && n.pitch !== CRASH;

  /** The first choke-group hat after each open hat (within an 8th) keeps that open hat short: never drop those. */
  const openHatChokers = (): Set<Note> => {
    const out = new Set<Note>();
    const chokers = draft.notes.filter((m) => isChoker(m.pitch));
    for (const o of lane(OPEN_HAT)) {
      let best: Note | null = null;
      let bestD = Infinity;
      for (const m of chokers) {
        const d = fwd(o.tick, m.tick);
        if (d > 0 && d <= 2 * STEP && d < bestD) {
          best = m;
          bestD = d;
        }
      }
      if (best) out.add(best);
    }
    return out;
  };

  const hatGhostAdd = (): boolean => {
    const lanes = HAT_LANES.filter((p) => lane(p).length >= 2);
    if (!lanes.length || !draft.canAfford([], 1)) return false;
    const p = rng.pick(lanes);
    const notes = lane(p);
    // Ghost level follows the lane's loudest hit, which ghosts, drops and accent swaps never raise.
    const top = maxOf(notes.map((n) => n.velocity));
    const opens = lane(OPEN_HAT);
    // Grid occupancy of this lane: `taken` = a hit within 12 ticks, `hit` = within 8 ticks.
    const slots = Math.ceil(clipTicks / STEP);
    const taken = new Uint8Array(slots + 2);
    const hit = new Uint8Array(slots + 2);
    const hitsPerBar = new Array<number>(bars).fill(0);
    const ghostsPerBar = new Array<number>(bars).fill(0);
    for (const n of notes) {
      const g = Math.round(n.tick / STEP);
      const d = Math.abs(n.tick - g * STEP);
      if (g >= 0 && g <= slots) {
        if (d < 12) taken[g] = 1;
        if (d < 8) hit[g] = 1;
      }
      const b = barOf(n.tick);
      hitsPerBar[b]++;
      if (n.velocity < GHOST_RATIO * top) ghostsPerBar[b]++;
    }
    const cands: number[] = [];
    for (let g = 0; g < slots; g++) {
      const t = g * STEP;
      const b = barOf(t);
      if (taken[g] || hitsPerBar[b] >= MAX_HAT_HITS_PER_BAR || ghostsPerBar[b] >= MAX_HAT_GHOSTS_PER_BAR) continue;
      if (!(g > 0 && hit[g - 1]) && !hit[g + 1]) continue;
      // A closed/pedal hat just after an open hat would cut it short.
      if (isChoker(p) && opens.some((o) => fwd(o.tick, t) <= 2 * STEP)) continue;
      cands.push(t);
    }
    const offGrid = cands.filter((t) => t % (2 * STEP) === STEP);
    const pool = offGrid.length ? offGrid : cands;
    if (!pool.length) return false;
    draft.add({ tick: rng.pick(pool), pitch: p, velocity: clampVel(top * rng.range(0.35, 0.5)), duration: STEP / 2 });
    return true;
  };

  /** Drop a ghost, or an in-between 16th of a 16th run; the 8th-note spine of a hat part stays. */
  const hatGhostDrop = (): boolean => {
    const cands: Note[] = [];
    const keepers = openHatChokers();
    for (const p of HAT_LANES) {
      const notes = lane(p);
      if (notes.length <= 2) continue;
      const top = maxOf(notes.map((n) => n.velocity));
      for (const n of notes) {
        if (!free(n) || keepers.has(n) || near(posInBar(n.tick) % BEAT, 0)) continue;
        const ghost = n.velocity < GHOST_RATIO * top;
        const inRun = onOdd16th(n) && notes.some((m) => m !== n && (near(m.tick, n.tick - STEP) || near(m.tick, n.tick + STEP)));
        if (ghost || inRun) cands.push(n);
      }
    }
    if (!cands.length) return false;
    // Prefer the softest ones.
    cands.sort((a, b) => a.velocity - b.velocity || compareNotes(a, b));
    const n = cands[rng.int(0, Math.max(0, Math.ceil(cands.length / 2) - 1))];
    if (!draft.canAfford([n])) return false;
    draft.remove(n);
    return true;
  };

  /**
   * Accents: move a louder velocity to another hat in the same bar (the
   * lane's dynamics are kept, only where they fall changes). A lane played
   * at one level gets a single lifted off-beat, after which accents move.
   */
  const hatAccent = (): boolean => {
    for (const p of shuffled(rng, HAT_LANES)) {
      const notes = lane(p).filter(free);
      if (notes.length < 2) continue;
      const vs = notes.map((n) => n.velocity);
      if (maxOf(vs) - minOf(vs) < MIN_ACCENT) {
        const offbeats = notes.filter((n) => near(posInBar(n.tick) % BEAT, 2 * STEP));
        const n = rng.pick(offbeats.length ? offbeats : notes);
        if (!draft.canAfford([n])) return false;
        const v = n.velocity >= 0.88 ? n.velocity * 0.8 : n.velocity * rng.range(1.15, 1.3) + 0.03;
        draft.update(n, { velocity: clampVel(v) });
        return true;
      }
      const a = rng.pick(notes);
      const partners = notes.filter((b) => b !== a && barOf(b.tick) === barOf(a.tick) && Math.abs(b.velocity - a.velocity) >= MIN_ACCENT && !buriesTheGrid(a, b));
      if (partners.length) return draft.swapVelocities(a, rng.pick(partners));
    }
    return false;
  };

  const openHat = (): boolean => {
    const closed = lane(CLOSED_HAT);
    const opens = lane(OPEN_HAT);
    if (closed.length < 2 || opens.length >= bars) return false;
    const chokers = draft.notes.filter((m) => isChoker(m.pitch));
    const cands = closed.filter(
      (n) =>
        free(n) &&
        near(posInBar(n.tick) % BEAT, 2 * STEP) &&
        !opens.some((o) => Math.abs(o.tick - n.tick) < BEAT) &&
        // A hat hit at the same moment would choke the open hat before it is heard.
        !chokers.some((m) => m !== n && Math.abs(m.tick - n.tick) <= TOL),
    );
    if (!cands.length) return false;
    const n = rng.pick(cands);
    const hasChoker = chokers.some((m) => m !== n && fwd(n.tick, m.tick) > 0 && fwd(n.tick, m.tick) <= 2 * STEP);
    if (!draft.canAfford([n], hasChoker ? 0 : 1)) return false;
    const closedTop = maxOf(closed.map((c) => c.velocity));
    draft.update(n, { pitch: OPEN_HAT, velocity: clampVel(Math.max(n.velocity, closedTop * 0.85) * rng.range(0.92, 1.05)), duration: 2 * STEP });
    if (!hasChoker) {
      const t = (n.tick + 2 * STEP) % clipTicks;
      draft.add({ tick: t, pitch: CLOSED_HAT, velocity: clampVel(closedTop * rng.range(0.6, 0.75)), duration: STEP / 2 });
    }
    return true;
  };

  const percCandidates = () => draft.notes.filter((n) => free(n) && (PERC_LANES.includes(n.pitch) || isBackbeat(n.pitch)));

  const percShift = (): boolean => {
    const cands = percCandidates();
    if (!cands.length) return false;
    const n = rng.pick(cands);
    if (!draft.canAfford([n])) return false;
    for (const d of shuffled(rng, [STEP, -STEP])) {
      const t = n.tick + d;
      if (t < 0 || t >= clipTicks || barOf(t) !== barOf(n.tick) || inFillZone(t) !== inFillZone(n.tick) || occupied(n.pitch, t, 12, n)) continue;
      draft.update(n, { tick: t });
      return true;
    }
    return false;
  };

  /** A softer repeat of a main percussion hit a 16th or an 8th later (echoes are never echoed again). */
  const percEcho = (): boolean => {
    if (!draft.canAfford([], 1)) return false;
    const stats = laneStats();
    const cands = draft.notes.filter((n) => PERC_LANES.includes(n.pitch) && !stats.isGhost(n) && stats.inBar(n).length < MAX_PERC_HITS_PER_BAR);
    if (!cands.length) return false;
    const n = rng.pick(cands);
    for (const off of shuffled(rng, [STEP, 2 * STEP])) {
      const t = n.tick + off;
      if (t >= clipTicks || barOf(t) !== barOf(n.tick) || inFillZone(t) !== inFillZone(n.tick) || occupied(n.pitch, t, 12)) continue;
      draft.add({ tick: t, pitch: n.pitch, velocity: clampVel(n.velocity * rng.range(0.4, 0.52)), duration: Math.max(MIN_DUR, Math.min(n.duration, clipTicks - t)) });
      return true;
    }
    return false;
  };

  /** Thin percussion: ghosts and echoes, or the softer hits of a lane that plays at least three times in the bar. */
  const percDrop = (): boolean => {
    const stats = laneStats();
    const cands = percCandidates().filter((n) => {
      if (stats.isGhost(n)) return true;
      const same = stats.inBar(n);
      return same.length > MIN_PERC_HITS_PER_BAR && n.velocity <= median(same.map((m) => m.velocity)) + 1e-6;
    });
    if (!cands.length) return false;
    const n = rng.pick(cands);
    if (!draft.canAfford([n])) return false;
    draft.remove(n);
    return true;
  };

  const ghostSnare = (): boolean => {
    const backbeats = draft.notes.filter((n) => protectedIds.has(n.id) && isBackbeat(n.pitch));
    if (!backbeats.length || !draft.canAfford([], 1)) return false;
    const ghostLane = lane(SNARE).length ? SNARE : lane(RIM).length ? RIM : SNARE;
    const loudest = maxOf(backbeats.map((b) => b.velocity));
    const ghostsIn = (bar: number) => laneInBar(ghostLane, bar).filter((n) => !protectedIds.has(n.id) && n.velocity < GHOST_RATIO * loudest).length;
    const cands: { t: number; v: number }[] = [];
    for (const b of backbeats) {
      if (ghostsIn(barOf(b.tick)) >= MAX_SNARE_GHOSTS_PER_BAR) continue;
      for (const off of [-STEP, STEP, 3 * STEP]) {
        const t = b.tick + off;
        if (t < 0 || t >= clipTicks || barOf(t) !== barOf(b.tick)) continue;
        if (occupied(ghostLane, t, 12) || draft.notes.some((n) => isKick(n.pitch) && near(n.tick, t))) continue;
        cands.push({ t, v: b.velocity });
      }
    }
    if (!cands.length) return false;
    const c = rng.pick(cands);
    // Backbeats never change, so ghost levels stay the same however often Variation runs.
    draft.add({ tick: c.t, pitch: ghostLane, velocity: clampVel(c.v * rng.range(0.22, 0.38)), duration: STEP / 2 });
    return true;
  };

  /** At most one kick edit per Variation: nudge a free kick by a 16th, or add a pickup kick. */
  const kickOp = (): boolean => {
    const kicks = draft.notes.filter((n) => isKick(n.pitch));
    if (!kicks.length) return false;
    const movable = kicks.filter(free);
    if (movable.length) {
      const n = rng.pick(movable);
      if (!draft.canAfford([n])) return false;
      for (const d of shuffled(rng, [STEP, -STEP])) {
        const t = n.tick + d;
        const pos = posInBar(t);
        if (t < 0 || t >= clipTicks || barOf(t) !== barOf(n.tick)) continue;
        if (draft.notes.some((m) => m !== n && isKick(m.pitch) && Math.abs(m.tick - t) < 2 * STEP)) continue;
        if (near(pos, BEAT) || near(pos, 3 * BEAT)) continue;
        draft.update(n, { tick: t });
        return true;
      }
      return false;
    }
    if (!draft.canAfford([], 1)) return false;
    const kickVel = mean(kicks.map((k) => k.velocity));
    const bar = rng.int(0, bars - 1);
    for (const pos of shuffled(rng, [BEAT + 3 * STEP, 2 * BEAT + 3 * STEP, 3 * BEAT + 3 * STEP])) {
      const t = bar * BAR + pos;
      if (t >= clipTicks) continue;
      if (kicks.some((k) => Math.abs(k.tick - t) < 2 * STEP)) continue;
      if (draft.notes.some((m) => isBackbeat(m.pitch) && near(m.tick, t))) continue;
      draft.add({ tick: t, pitch: kicks[0].pitch, velocity: clampVel(kickVel * rng.range(0.55, 0.75)), duration: STEP });
      return true;
    }
    return false;
  };

  const fill = (): boolean => {
    if (draft.notes.some((n) => inFillZone(n.tick) && isToms(n.pitch))) return false;
    if (draft.notes.filter((n) => inFillZone(n.tick) && n.pitch === SNARE).length > 1) return false;
    // A percussion part fills on its own drums (the tom slots hold congas/bongos there), never with a snare.
    const templates = role === 'percussion' ? FILLS.filter((f) => f.every(([, p]) => isToms(p))) : FILLS;
    const template = rng.pick(templates);
    const base = (bars - 1) * BAR;
    const hits = template.filter(([off, p]) => !occupied(p, base + off, TOL));
    if (hits.length < 2 || !draft.canAfford([], hits.length)) return false;
    for (const [off, p, v] of hits) {
      draft.add({ tick: base + off, pitch: p, velocity: clampVel(v + rng.range(-0.05, 0.05)), duration: STEP });
    }
    return true;
  };

  // A fill is a bigger gesture: decide it first so it has room, less often in 1-bar loops.
  const fillChance = (0.2 + 0.5 * intensity) * (bars === 1 ? 0.4 : 1);
  if (draft.remaining >= 4 && draft.notes.length >= 8 && rng.chance(fillChance)) fill();

  const ops: Op[] = [
    { weight: 3, run: hatGhostAdd },
    { weight: 2, run: hatGhostDrop },
    { weight: 3, run: hatAccent },
    { weight: 1.5, run: openHat, once: true },
    { weight: 2, run: percShift },
    { weight: 1.5, run: percEcho },
    { weight: 1, run: percDrop },
    { weight: role === 'percussion' ? 0 : 1.5, run: ghostSnare },
    { weight: role === 'percussion' ? 0 : 1, run: kickOp, once: true },
  ];
  runOps(rng, draft, ops, target);
}

/* ------------------------------------------------------------------ */
/* Melodic lines                                                       */
/* ------------------------------------------------------------------ */

interface MelodicContext {
  root: number;
  scale: ScaleId;
  role: TrackRole;
  kind: InstrumentKind;
  clipTicks: number;
}

/** The first note of each bar (earliest; lowest when several start together). */
function barRoots(notes: readonly Note[]): Map<number, Note> {
  const out = new Map<number, Note>();
  for (const n of sorted(notes)) {
    const b = barOf(n.tick);
    if (!out.has(b)) out.set(b, n);
  }
  return out;
}

function varyMelodic(draft: Draft, rng: Rng, c: MelodicContext, target: number): void {
  const { root, scale, clipTicks } = c;
  const bars = clipTicks / BAR;
  const isBass = c.kind === 'bass' || c.role === 'bass';
  // A sampler's pitch is also its playback speed and the recording's own harmony: keep every pitch.
  const keepPitches = c.kind === 'sampler';
  const roots = barRoots(draft.notes);
  const anchors = [...roots.values()];
  const anchorIds = new Set(anchors.map((n) => n.id));
  const anchorTick = new Map([...roots.entries()].map(([b, n]) => [b, n.tick]));
  const pitches = draft.notes.map((n) => n.pitch);
  const lo = minOf(pitches);
  const hi = maxOf(pitches);
  const mid = (lo + hi) / 2;
  // The register moves may use is measured from each bar's first note. Variation never changes those, so
  // pressing it again and again cannot walk a line up or down (a bass stays within an octave and a fifth).
  const aLo = minOf(anchors.map((n) => n.pitch));
  const aHi = maxOf(anchors.map((n) => n.pitch));
  const regLo = isBass ? aLo - 2 : Math.max(MELODIC_FLOOR, aLo - 12);
  const regHi = isBass ? Math.max(aHi + 12, aLo + 19) : Math.min(MELODIC_CEILING, aHi + 12);
  /** Level for new notes, from notes that never change. */
  const refVel = median(anchors.map((n) => n.velocity));
  /** Notes that just received an approach tone stay put, so the approach still resolves. */
  const locked = new Set<string>();
  const free = (n: Note) => draft.fresh(n) && !anchorIds.has(n.id) && !locked.has(n.id);
  /** A new note at `t` must not start before its bar's harmony root. */
  const respectsRoot = (t: number) => {
    const a = anchorTick.get(barOf(t));
    return a === undefined || t > a + 1e-9;
  };
  const others = (n: Note) => draft.notes.filter((m) => m !== n);
  const notesInBar = (bar: number) => draft.notes.filter((n) => barOf(n.tick) === bar).length;
  /**
   * Soft, short and off the beat: what approach tones and repeats look like.
   * Ornaments are only ever added (a few per bar) or removed again as rests:
   * they are not moved, re-accented or embellished themselves, so they stay
   * recognisable and a line cannot fill up with ornaments of ornaments.
   */
  const ornament = (n: Note) => n.velocity < ORNAMENT_LEVEL * refVel && n.duration <= STEP && !near(posInBar(n.tick) % BEAT, 0);
  const ornamentsInBar = (bar: number) => draft.notes.filter((n) => barOf(n.tick) === bar && ornament(n)).length;
  /** A note the rhythm, octave, length and accent rules may change. */
  const main = (n: Note) => free(n) && !ornament(n);
  /** An ornament leads into this note a 16th before it: moving the note in time or octave would leave it unresolved. */
  const approached = (n: Note) => draft.notes.some((m) => m !== n && ornament(m) && near(m.tick + STEP, n.tick, 1));
  /** Room for a new ornament at `t`. */
  const roomFor = (t: number) => notesInBar(barOf(t)) < MAX_LINE_NOTES_PER_BAR && ornamentsInBar(barOf(t)) < MAX_ORNAMENTS_PER_BAR;

  const displace = (): boolean => {
    const s = sorted(draft.notes);
    const cands = s.filter((n, i) => main(n) && !approached(n) && !(i > 0 && n.tick - s[i - 1].tick < 1) && !(i + 1 < s.length && s[i + 1].tick - n.tick < 1));
    if (!cands.length) return false;
    const n = rng.pick(cands);
    if (!draft.canAfford([n])) return false;
    for (const d of shuffled(rng, [STEP, -STEP])) {
      const t = n.tick + d;
      if (t < 0 || t >= clipTicks || barOf(t) !== barOf(n.tick) || !respectsRoot(t)) continue;
      const rest = others(n);
      if (rest.some((m) => Math.abs(m.tick - t) < 12)) continue;
      // Moving earlier must not overlap the note before (that would turn into an unintended slide).
      if (rest.some((m) => m.tick < t && endOf(m) > t + 1e-9)) continue;
      const next = rest.filter((m) => m.tick > t).sort(compareNotes)[0];
      const dur = Math.min(n.duration, (next ? next.tick : clipTicks) - t, clipTicks - t);
      if (dur < MIN_DUR) continue;
      draft.update(n, { tick: t, duration: dur });
      return true;
    }
    return false;
  };

  const octave = (): boolean => {
    const cands = draft.notes.filter((n) => main(n) && !approached(n));
    if (!cands.length) return false;
    const n = rng.pick(cands);
    if (!draft.canAfford([n])) return false;
    const up = n.pitch + 12;
    const down = n.pitch - 12;
    // Basses: up by at most an octave inside the register, down only as far as the line already goes.
    const upOk = isBass ? up <= regHi : up <= Math.min(hi + 12, regHi);
    const downOk = isBass ? down >= lo : down >= Math.max(lo - 12, regLo);
    let choice: number | null = null;
    if (isBass) choice = upOk && (!downOk || rng.chance(0.65)) ? up : downOk ? down : null;
    else {
      const preferDown = n.pitch >= mid;
      const first = preferDown ? down : up;
      const firstOk = preferDown ? downOk : upOk;
      const second = preferDown ? up : down;
      const secondOk = preferDown ? upOk : downOk;
      choice = firstOk && (!secondOk || rng.chance(0.75)) ? first : secondOk ? second : null;
    }
    if (choice === null) return false;
    const p = choice;
    if (draft.notes.some((m) => m !== n && m.pitch === p && Math.abs(m.tick - n.tick) < 1)) return false;
    draft.update(n, { pitch: p });
    return true;
  };

  const passing = (): boolean => {
    const s = sorted(draft.notes);
    if (s.length < 1) return false;
    const pairs: [Note, Note, number][] = [];
    for (let i = 0; i + 1 < s.length; i++) {
      if (s[i + 1].tick - s[i].tick >= 2 * STEP) pairs.push([s[i], s[i + 1], s[i + 1].tick - STEP]);
    }
    // Around the loop point: last note -> first note of the next pass.
    const first = s[0];
    const last = s[s.length - 1];
    const wrapT = first.tick - STEP < 0 ? first.tick - STEP + clipTicks : first.tick - STEP;
    if (clipTicks - last.tick + first.tick >= 2 * STEP && wrapT > last.tick) pairs.push([last, first, wrapT]);
    if (!pairs.length) return false;
    for (const [a, b, t] of shuffled(rng, pairs).slice(0, 4)) {
      if (t < 0 || t >= clipTicks || !respectsRoot(t) || ornament(b) || !roomFor(t)) continue;
      if (draft.notes.some((m) => Math.abs(m.tick - t) < 12)) continue;
      // The new note must not sound under an earlier note; shorten the note before it when allowed
      // (a bar's first note may give up at most its last 16th: its start, pitch and level stay).
      const sounding = draft.notes.filter((m) => m.tick < t && endOf(m) > t + 1e-9);
      if (sounding.some((m) => m !== a || !draft.fresh(m) || locked.has(m.id) || t - m.tick < 12 || (anchorIds.has(m.id) && endOf(m) - t > STEP))) continue;
      const trim = sounding.length ? [a] : [];
      if (!draft.canAfford(trim, 1)) continue;
      // Approach from the side the line comes from; a step or unison comes in from the other side (a neighbour tone).
      let dir: number;
      const diff = a.pitch - b.pitch;
      if (diff === 0) dir = rng.chance(0.5) ? 1 : -1;
      else if (Math.abs(diff) <= 2) dir = -Math.sign(diff);
      else dir = Math.sign(diff);
      let p = -1;
      for (const d of [dir, -dir]) {
        const q = snapToScale(transposeInScale(b.pitch, d, root, scale), root, scale);
        if (q !== b.pitch && q >= regLo && q <= regHi) {
          p = q;
          break;
        }
      }
      if (p < 0) continue;
      if (trim.length) draft.update(a, { duration: t - a.tick });
      const nextStart = b.tick > t ? b.tick : clipTicks;
      draft.add({ tick: t, pitch: p, velocity: clampVel(refVel * rng.range(0.6, 0.74)), duration: Math.max(MIN_DUR, Math.min(STEP - 4, nextStart - t)) });
      locked.add(b.id);
      return true;
    }
    return false;
  };

  /** Sampler chops: the same sound again a 16th or an 8th later (a stutter), never at a new pitch. */
  const repeat = (): boolean => {
    if (!draft.canAfford([], 1)) return false;
    // Repeats come from main notes only (a repeat is never repeated again), one per note.
    const sources = draft.notes.filter((n) => !ornament(n) && roomFor(n.tick));
    if (!sources.length) return false;
    const n = rng.pick(sources);
    const following = draft.notes.filter((m) => m.tick > n.tick + 1e-9).sort(compareNotes)[0];
    for (const off of shuffled(rng, [STEP, 2 * STEP])) {
      const t = n.tick + off;
      // Repeats land off the beat and stay short, so they remain recognisable ornaments.
      if (t >= clipTicks || barOf(t) !== barOf(n.tick) || endOf(n) > t + 1e-9 || near(posInBar(t) % BEAT, 0)) continue;
      // Room for the repeat and a breath after it before the next note.
      if (following && following.tick < t + STEP) continue;
      if (draft.notes.some((m) => m.tick < t && endOf(m) > t + 1e-9)) continue;
      const dur = Math.min(n.duration, STEP, (following ? following.tick : clipTicks) - t);
      if (dur < MIN_DUR) continue;
      draft.add({ tick: t, pitch: n.pitch, velocity: clampVel(refVel * rng.range(0.55, 0.72)), duration: dur });
      return true;
    }
    return false;
  };

  /**
   * Phrasing: legato (held on toward the next note, at most twice as long)
   * or staccato. In melodies and textures a bar's first note may be phrased
   * too (its start, pitch and level stay), so sparse melodies still vary.
   * Bass roots keep their length, and so do a sampler's (a riser or swell is
   * timed by its length to peak on the downbeat).
   */
  const length = (): boolean => {
    const phraseAnchors = !isBass && !keepPitches;
    const cands = draft.notes.filter((n) => main(n) || (phraseAnchors && anchorIds.has(n.id) && draft.fresh(n) && !locked.has(n.id)));
    if (!cands.length) return false;
    const n = rng.pick(cands);
    if (!draft.canAfford([n])) return false;
    const next = others(n)
      .filter((m) => m.tick > n.tick + 1e-9)
      .sort(compareNotes)[0];
    const room = Math.min(next ? next.tick : clipTicks, clipTicks, n.tick + Math.max(2 * n.duration, BEAT)) - n.tick;
    const canLegato = room - n.duration >= 12;
    const canStaccato = n.duration >= 36;
    if (!canLegato && !canStaccato) return false;
    const legato = canLegato && (!canStaccato || rng.chance(0.5));
    // Staccato stays longer than a 16th, so a main note never turns into an ornament.
    const d = legato ? room : Math.max(STEP + 4, Math.round((n.duration * rng.range(0.35, 0.55)) / 3) * 3);
    if (d === n.duration) return false;
    draft.update(n, { duration: d });
    return true;
  };

  /** A rest: drop an ornament (often an earlier approach tone or repeat), never a bar's first note. */
  const rest = (): boolean => {
    const cands = draft.notes.filter((n) => free(n) && ornament(n) && notesInBar(barOf(n.tick)) > 2);
    if (!cands.length) return false;
    cands.sort((a, b) => a.velocity - b.velocity || compareNotes(a, b));
    const n = cands[rng.int(0, Math.max(0, Math.ceil(cands.length / 2) - 1))];
    if (!draft.canAfford([n])) return false;
    draft.remove(n);
    return true;
  };

  /**
   * Accents: move a louder velocity to another note of the bar (the line's
   * dynamics are kept). Without contrast to move, nudge the note toward a
   * level set by the bar-first notes, which never change.
   */
  const accent = (): boolean => {
    const cands = draft.notes.filter(main);
    if (!cands.length) return false;
    const a = rng.pick(cands);
    const partners = cands.filter((b) => b !== a && barOf(b.tick) === barOf(a.tick) && Math.abs(b.velocity - a.velocity) >= MIN_ACCENT && !buriesTheGrid(a, b));
    if (partners.length) return draft.swapVelocities(a, rng.pick(partners));
    if (!draft.canAfford([a])) return false;
    const pos = posInBar(a.tick) % BEAT;
    const goal = near(pos, 0) ? refVel * 1.15 + 0.03 : onOdd16th(a) ? refVel * 0.84 : refVel * (rng.chance(0.5) ? 0.9 : 1.1);
    const nv = clampVel(a.velocity + (Math.min(1, goal) - a.velocity) * rng.range(0.5, 0.9));
    if (Math.abs(nv - a.velocity) < 0.05) return false;
    draft.update(a, { velocity: nv });
    return true;
  };

  // Rests balance approach tones and repeats, so a line settles at a musical density instead of filling up.
  const restWeight = draft.notes.length / bars >= 3 ? 1 : 0;
  const ops: Op[] = keepPitches
    ? [
        { weight: 2, run: displace },
        { weight: 2, run: repeat },
        { weight: 1.5, run: length },
        { weight: restWeight, run: rest },
        { weight: 1, run: accent },
      ]
    : [
        { weight: 2, run: displace },
        { weight: isBass ? 2 : c.role === 'texture' ? 1 : 1.5, run: octave },
        { weight: 2.5, run: passing },
        { weight: 1.5, run: length },
        { weight: restWeight, run: rest },
        { weight: 1, run: accent },
      ];
  runOps(rng, draft, ops, target);
}

/* ------------------------------------------------------------------ */
/* Chord parts                                                         */
/* ------------------------------------------------------------------ */

interface Group {
  notes: Note[];
  tick: number;
  end: number;
}

/**
 * A rolled or strummed chord: onsets one after another (at most an 8th
 * apart, all within a beat), every note still ringing when the next starts
 * and all ending together. Arpeggios of short notes and overlapping chord
 * changes are not rolls.
 */
function continuesRoll(g: Group, n: Note): boolean {
  const last = g.notes[g.notes.length - 1];
  return (
    n.tick - last.tick <= 2 * STEP &&
    n.tick - g.tick < BEAT &&
    new Set(g.notes.map((m) => m.tick)).size === g.notes.length &&
    g.notes.every((m) => endOf(m) >= n.tick + STEP && Math.abs(endOf(m) - endOf(n)) <= STEP)
  );
}

/** Chords of a part: notes that start together, and rolled chords. */
function groupsOf(notes: readonly Note[]): Group[] {
  const out: Group[] = [];
  for (const n of sorted(notes)) {
    const g = out[out.length - 1];
    if (g && (n.tick - g.tick <= CHORD_WINDOW || continuesRoll(g, n))) {
      g.notes.push(n);
      g.end = Math.max(g.end, endOf(n));
    } else {
      out.push({ notes: [n], tick: n.tick, end: endOf(n) });
    }
  }
  return out;
}

function varyChords(draft: Draft, rng: Rng, c: MelodicContext, target: number): void {
  const { clipTicks } = c;
  const isPad = c.role === 'pad';

  // The first chord of every bar keeps its timing, length, level and bass note (the notes above the bass may be revoiced).
  const anchorIds = new Set<string>();
  const anchorTick = new Map<number, number>();
  const basses: number[] = [];
  const tops: number[] = [];
  const anchorLevels: number[] = [];
  for (const g of groupsOf(draft.notes)) {
    const b = barOf(g.tick);
    if (anchorTick.has(b)) continue;
    anchorTick.set(b, g.tick);
    for (const n of g.notes) anchorIds.add(n.id);
    basses.push(minOf(g.notes.map((n) => n.pitch)));
    tops.push(maxOf(g.notes.map((n) => n.pitch)));
    anchorLevels.push(mean(g.notes.map((n) => n.velocity)));
  }
  // The register is measured from those bass notes, so repeated Variations cannot walk the part up or down.
  // An authored voicing that already reaches higher keeps its room (the top can only come down from there).
  const winLo = Math.max(0, minOf(basses) - 5);
  const winHi = Math.min(127, Math.max(maxOf(basses) + 21, maxOf(tops)));
  const winMid = (winLo + winHi) / 2;
  const partLevel = median(anchorLevels);

  const groups = () => groupsOf(draft.notes);
  const isAnchor = (g: Group) => g.notes.some((n) => anchorIds.has(n.id));
  const allFresh = (g: Group) => g.notes.every((n) => draft.fresh(n));
  const isStab = (g: Group) => g.end - g.tick <= BEAT;
  const level = (g: Group) => mean(g.notes.map((n) => n.velocity));
  const centreOf = (ps: readonly number[]) => mean(ps);
  const groupsInBar = (all: readonly Group[], bar: number) => all.filter((g) => barOf(g.tick) === bar).length;

  /**
   * Give a chord a new set of pitches (same pitch classes). A block chord
   * moves as few notes as possible; a roll keeps its low-to-high order.
   */
  const repitch = (g: Group, pitches: readonly number[]): boolean => {
    const target = [...pitches].sort((a, b) => a - b);
    let moves: [Note, number][];
    if (g.notes.every((n) => n.tick - g.tick <= CHORD_WINDOW)) {
      const remaining = [...target];
      const movers: Note[] = [];
      for (const n of [...g.notes].sort((a, b) => a.pitch - b.pitch)) {
        const i = remaining.indexOf(n.pitch);
        if (i >= 0) remaining.splice(i, 1);
        else movers.push(n);
      }
      moves = movers.map((n, i): [Note, number] => [n, remaining[i]]);
    } else {
      const byPitch = [...g.notes].sort((a, b) => a.pitch - b.pitch || a.tick - b.tick);
      moves = byPitch.map((n, i): [Note, number] => [n, target[i]]).filter(([n, p]) => n.pitch !== p);
    }
    if (!moves.length || moves.some(([n]) => !draft.fresh(n)) || !draft.canAfford(moves.map(([n]) => n))) return false;
    for (const [n, p] of moves) draft.update(n, { pitch: p });
    return true;
  };

  const invert = (): boolean => {
    const gs = groups();
    if (!gs.length) return false;
    const g = rng.pick(gs);
    const ps = g.notes.map((n) => n.pitch).sort((a, b) => a - b);
    const has = (p: number) => ps.includes(p);
    if (isAnchor(g)) {
      // Keep the bar's bass note: open or close the voicing by moving one note above it by an octave.
      const options: number[][] = [];
      for (let i = 1; i < ps.length; i++) {
        for (const p of [ps[i] + 12, ps[i] - 12]) if (p > ps[0] && p >= winLo && p <= winHi && !has(p)) options.push(ps.map((q, j) => (j === i ? p : q)));
      }
      return options.length > 0 && repitch(g, rng.pick(options));
    }
    if (ps.length === 1) {
      // A single chord tone (an arpeggio note): the same note an octave away, usually toward the middle of the register.
      const toward = ps[0] < winMid ? ps[0] + 12 : ps[0] - 12;
      const away = ps[0] < winMid ? ps[0] - 12 : ps[0] + 12;
      const ok = [toward, away].filter((q) => q >= winLo && q <= winHi);
      if (!ok.length) return false;
      return repitch(g, [ok.length === 2 && rng.chance(0.3) ? ok[1] : ok[0]]);
    }
    const lowest = ps[0];
    const highest = ps[ps.length - 1];
    const up = lowest + 12 <= winHi && !has(lowest + 12) ? [...ps.slice(1), lowest + 12] : null;
    const down = highest - 12 >= winLo && !has(highest - 12) ? [highest - 12, ...ps.slice(0, -1)] : null;
    if (!up && !down) return false;
    // Inversions lean toward the middle of the register.
    const preferUp = centreOf(ps) < winMid;
    const choice = up && down ? (rng.chance(preferUp ? 0.7 : 0.3) ? up : down) : ((up ?? down) as number[]);
    return repitch(g, choice);
  };

  const revoice = (): boolean => {
    const all = groups();
    const cands = all.filter((g) => g.notes.length >= 3 && allFresh(g) && pitchClassSet(g.notes.map((n) => n.pitch)).length === g.notes.length);
    if (!cands.length) return false;
    const g = rng.pick(cands);
    const idx = all.indexOf(g);
    const prev = all[(idx - 1 + all.length) % all.length];
    const current = g.notes.map((n) => n.pitch).sort((a, b) => a - b);
    let options: number[][];
    if (isAnchor(g)) {
      // Same bass, the notes above it in another inversion or spread.
      const bass = current[0];
      const upper = current.slice(1);
      options = chordVoicings(upper, bass + 1, winHi)
        .filter((v) => v.length === upper.length)
        .map((v) => [bass, ...v]);
    } else {
      options = chordVoicings(current, winLo, winHi).filter((v) => v.length === current.length);
    }
    options = options.filter((v) => v.join() !== current.join());
    if (!options.length) return false;
    let best: number[];
    if (prev && prev !== g && prev.notes.length >= 2) {
      const prevPitches = prev.notes.map((n) => n.pitch);
      best = options.reduce((b, v) => (voiceLeadingDistance(prevPitches, v) < voiceLeadingDistance(prevPitches, b) ? v : b));
    } else if (!isAnchor(g)) {
      // No neighbour to lead from: the voicing nearest the middle of the register, if it is a new one.
      const centred = voiceChord(current, winLo, winHi).join();
      best = options.find((v) => v.join() === centred) ?? rng.pick(options);
    } else {
      best = rng.pick(options);
    }
    return repitch(g, best);
  };

  const stabShift = (): boolean => {
    const all = groups();
    const cands = all.filter((g) => !isAnchor(g) && allFresh(g) && isStab(g));
    if (!cands.length) return false;
    const g = rng.pick(cands);
    if (!draft.canAfford(g.notes)) return false;
    for (const d of shuffled(rng, [STEP, -STEP])) {
      const t = g.tick + d;
      const b = barOf(t);
      if (t < 0 || t >= clipTicks || b !== barOf(g.tick) || t <= (anchorTick.get(b) ?? -1)) continue;
      const rest = all.filter((o) => o !== g);
      if (rest.some((o) => Math.abs(o.tick - t) < STEP)) continue;
      if (rest.some((o) => o.tick < t && o.end > t + 1e-9)) continue;
      const nextT = Math.min(clipTicks, ...rest.filter((o) => o.tick > t).map((o) => o.tick));
      const moved = g.notes.map((n) => ({ n, tick: n.tick + d, dur: Math.min(n.duration, nextT - (n.tick + d)) }));
      if (moved.some((m) => m.tick < 0 || m.tick >= clipTicks || m.dur < MIN_DUR)) continue;
      for (const m of moved) draft.update(m.n, { tick: m.tick, duration: m.dur });
      return true;
    }
    return false;
  };

  /** A softer repeat of a main stab (echoes are never echoed again, and a bar never gets crowded). */
  const stabEcho = (): boolean => {
    const all = groups();
    const cands = all.filter((g) => g.end - g.tick <= 3 * STEP && level(g) >= 0.75 * partLevel && groupsInBar(all, barOf(g.tick)) < MAX_STABS_PER_BAR);
    if (!cands.length) return false;
    const g = rng.pick(cands);
    if (!draft.canAfford([], g.notes.length)) return false;
    for (const off of shuffled(rng, [2 * STEP, 3 * STEP])) {
      const t = g.tick + off;
      if (t >= clipTicks || barOf(t) !== barOf(g.tick) || g.end > t + 1e-9) continue;
      const rest = all.filter((o) => o !== g);
      if (rest.some((o) => Math.abs(o.tick - t) < STEP)) continue;
      if (rest.some((o) => o.tick < t && o.end > t + 1e-9)) continue;
      const nextT = Math.min(clipTicks, ...rest.filter((o) => o.tick > t).map((o) => o.tick));
      const factor = rng.range(0.55, 0.7);
      const copies = g.notes.map((n) => ({ tick: t + (n.tick - g.tick), pitch: n.pitch, velocity: clampVel(n.velocity * factor), duration: Math.min(n.duration, nextT - t - (n.tick - g.tick)) }));
      if (copies.some((x) => x.duration < MIN_DUR || x.tick >= clipTicks)) continue;
      for (const x of copies) draft.add(x);
      return true;
    }
    return false;
  };

  const stabDrop = (): boolean => {
    const all = groups();
    // Only real stabs (two or more notes): single notes are arpeggio or roll tones, which would erode.
    const cands = all.filter((g) => g.notes.length >= 2 && !isAnchor(g) && allFresh(g) && isStab(g) && groupsInBar(all, barOf(g.tick)) > MIN_STABS_PER_BAR);
    if (!cands.length) return false;
    const g = rng.pick(cands);
    if (!draft.canAfford(g.notes)) return false;
    for (const n of g.notes) draft.remove(n);
    return true;
  };

  const chordLength = (): boolean => {
    const all = groups();
    const cands = all.filter((g) => !isAnchor(g) && allFresh(g));
    if (!cands.length) return false;
    const g = rng.pick(cands);
    if (!draft.canAfford(g.notes)) return false;
    const nextT = Math.min(clipTicks, ...all.filter((o) => o.tick > g.tick).map((o) => o.tick));
    const len = g.end - g.tick;
    const room = nextT - g.tick;
    let newLen: number;
    if (isStab(g)) {
      const shorter = len >= 2 * STEP ? Math.max(12, Math.round(len / 2)) : null;
      const longer = room > len + 12 ? Math.min(room, len * 2) : null;
      if (shorter === null && longer === null) return false;
      newLen = shorter !== null && (longer === null || rng.chance(0.5)) ? shorter : (longer as number);
    } else {
      const shorter = len >= 2 * BEAT ? Math.round((len * 0.75) / STEP) * STEP : null;
      const longer = room > len + STEP ? room : null;
      if (shorter === null && longer === null) return false;
      newLen = longer !== null && (shorter === null || rng.chance(0.5)) ? longer : (shorter as number);
    }
    const factor = newLen / len;
    let changed = false;
    for (const n of g.notes) {
      const d = Math.max(MIN_DUR, Math.min(Math.round(n.duration * factor), nextT - n.tick, clipTicks - n.tick));
      if (d !== n.duration) {
        draft.update(n, { duration: d });
        changed = true;
      }
    }
    return changed;
  };

  /**
   * Accents: exchange the levels of two stabs in a bar. Without contrast to
   * move, nudge a stab toward a level set by the bar-first chords, which
   * never change.
   */
  const chordAccent = (): boolean => {
    const cands = groups().filter((g) => !isAnchor(g) && allFresh(g));
    if (!cands.length) return false;
    const a = rng.pick(cands);
    const la = level(a);
    const partners = cands.filter((b) => b !== a && barOf(b.tick) === barOf(a.tick) && Math.abs(level(b) - la) >= MIN_ACCENT);
    if (partners.length) {
      const b = rng.pick(partners);
      const lb = level(b);
      if (!draft.canAfford([...a.notes, ...b.notes])) return false;
      for (const n of a.notes) draft.update(n, { velocity: clampVel(n.velocity + lb - la) });
      for (const n of b.notes) draft.update(n, { velocity: clampVel(n.velocity + la - lb) });
      return true;
    }
    if (!draft.canAfford(a.notes)) return false;
    const goal = Math.min(1, partLevel * (rng.chance(0.5) ? 1.15 : 0.8));
    const delta = (goal - la) * rng.range(0.5, 0.9);
    if (Math.abs(delta) < 0.03) return false;
    for (const n of a.notes) draft.update(n, { velocity: clampVel(n.velocity + delta) });
    return true;
  };

  runOps(
    rng,
    draft,
    [
      { weight: isPad ? 3 : 2.5, run: invert },
      { weight: isPad ? 3 : 2, run: revoice },
      { weight: isPad ? 0.5 : 2, run: stabShift },
      { weight: isPad ? 0.5 : 2, run: stabEcho },
      { weight: isPad ? 0 : 1, run: stabDrop },
      { weight: 1.5, run: chordLength },
      { weight: 1, run: chordAccent },
    ],
    target,
  );
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * A varied copy of the clip's notes (the clip itself is not modified).
 * Deterministic: identical clip + options produce identical music; only the
 * ids of newly created notes differ between calls.
 */
export function varyClip(clip: Clip, opts: VariationOptions): Note[] {
  const clipTicks = clip.bars * TICKS_PER_BAR;
  if (clip.notes.length === 0) return [];
  const intensity = Number.isFinite(opts.intensity) ? Math.min(1, Math.max(0, opts.intensity as number)) : VARIATION_DEFAULT_INTENSITY;
  const rng = new Rng(subSeed(opts.seed >>> 0, `vary:${opts.kind}:${opts.role}`));
  const budget = variationBudget(clip.notes.length, intensity);
  const draft = new Draft(clip.notes, budget, clipTicks);
  // Use most of the budget, but not always all of it, so repeated presses feel different in size too.
  const target = Math.max(1, Math.min(budget, Math.round(budget * rng.range(0.65, 1))));

  const ctx: MelodicContext = { root: opts.root, scale: opts.scale, role: opts.role, kind: opts.kind, clipTicks };
  if (opts.kind === 'drums') varyDrums(draft, rng, clipTicks, opts.role, intensity, target);
  // A sampler keeps its pitches whatever the part's role, so it always takes the (pitch-keeping) line rules.
  else if (opts.kind !== 'sampler' && (opts.role === 'chords' || opts.role === 'pad')) varyChords(draft, rng, ctx, target);
  else varyMelodic(draft, rng, ctx, target);

  const out = draft.result();
  // Never empty a clip (no rule removes the last note, but guard the invariant regardless).
  return out.length > 0 ? out : clip.notes.map((n) => ({ ...n }));
}

export interface NoteDiff {
  /** Notes kept (same id) whose tick, pitch, velocity or length changed. */
  changed: number;
  added: number;
  removed: number;
  total: number;
}

/** Compare two note lists by id. */
export function diffNotes(before: readonly Note[], after: readonly Note[]): NoteDiff {
  const prev = new Map(before.map((n) => [n.id, n]));
  const nextIds = new Set(after.map((n) => n.id));
  let changed = 0;
  let added = 0;
  for (const n of after) {
    const o = prev.get(n.id);
    if (!o) added++;
    else if (o.tick !== n.tick || o.pitch !== n.pitch || o.velocity !== n.velocity || o.duration !== n.duration) changed++;
  }
  let removed = 0;
  for (const n of before) if (!nextIds.has(n.id)) removed++;
  return { changed, added, removed, total: changed + added + removed };
}

/** Short feedback for the UI: "5 notes changed", "3 notes changed, 2 added, 1 removed", "No change". */
export function describeVariation(before: readonly Note[], after: readonly Note[]): string {
  if (before.length === 0 && after.length === 0) return 'Nothing to vary: the clip is empty';
  const d = diffNotes(before, after);
  if (d.total === 0) return 'No change';
  const parts: [number, string][] = (
    [
      [d.changed, 'changed'],
      [d.added, 'added'],
      [d.removed, 'removed'],
    ] as [number, string][]
  ).filter(([count]) => count > 0);
  return parts.map(([count, verb], i) => (i === 0 ? `${count} note${count === 1 ? '' : 's'} ${verb}` : `${count} ${verb}`)).join(', ');
}
