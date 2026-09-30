/**
 * Arpeggiator (pure: no DOM, no Web Audio).
 *
 * Held notes arrive in the order they were played and are already snapped to
 * the scale by the caller. The arp turns them into a repeating pattern
 * (up / down / up-down / as played, over 1-3 octaves) that is stepped on a
 * rhythmic grid by the sequencer.
 */
import type { ArpDivision, ArpSettings } from '../project/types';

/** Grid length of each division in ticks (PPQ 96). */
export const ARP_DIVISION_TICKS: Readonly<Record<ArpDivision, number>> = {
  '1/4': 96,
  '1/8': 48,
  '1/8T': 32,
  '1/16': 24,
  '1/16T': 16,
  '1/32': 12,
};

export const ARP_DIVISIONS: readonly ArpDivision[] = ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'];

const MIN_GATE = 0.1;
const MAX_PITCH = 127;

export function arpDivisionTicks(division: ArpDivision): number {
  return ARP_DIVISION_TICKS[division] ?? ARP_DIVISION_TICKS['1/16'];
}

/** Sounding length of each arp note in ticks (gate x division). */
export function arpGateTicks(settings: Pick<ArpSettings, 'division' | 'gate'>): number {
  const gate = Number.isFinite(settings.gate) ? Math.min(1, Math.max(MIN_GATE, settings.gate)) : 0.6;
  return arpDivisionTicks(settings.division) * gate;
}

function clampOctaves(o: number): number {
  return Number.isFinite(o) ? Math.min(3, Math.max(1, Math.round(o))) : 1;
}

/** Valid, de-duplicated pitches in the order they were first played. */
function cleanHeld(held: readonly number[]): number[] {
  const out: number[] = [];
  for (const p of held) {
    if (!Number.isFinite(p)) continue;
    const n = Math.round(p);
    if (n < 0 || n > MAX_PITCH || out.includes(n)) continue;
    out.push(n);
  }
  return out;
}

/**
 * One full cycle of the pattern.
 * - up: low to high across the octave range
 * - down: high to low
 * - updown: up then back down without repeating the top and bottom notes
 * - played: the order the keys were pressed, repeated per octave
 */
export function arpPattern(held: readonly number[], settings: Pick<ArpSettings, 'mode' | 'octaves'>): number[] {
  const notes = cleanHeld(held);
  if (!notes.length) return [];
  const octaves = clampOctaves(settings.octaves);
  const ordered = settings.mode === 'played' ? notes : [...notes].sort((a, b) => a - b);
  const span: number[] = [];
  for (let o = 0; o < octaves; o++) {
    for (const n of ordered) {
      const p = n + 12 * o;
      if (p <= MAX_PITCH) span.push(p);
    }
  }
  switch (settings.mode) {
    case 'down':
      return span.reverse();
    case 'updown': {
      if (span.length < 3) return span;
      const back = span.slice(1, -1).reverse();
      return [...span, ...back];
    }
    case 'up':
    case 'played':
    default:
      return span;
  }
}

/** The pitch played on arp step `step` (0 = first step after the press), or null with nothing held. */
export function arpNoteAt(held: readonly number[], settings: Pick<ArpSettings, 'mode' | 'octaves'>, step: number): number | null {
  const pattern = arpPattern(held, settings);
  if (!pattern.length) return null;
  const n = pattern.length;
  const i = ((Math.floor(step) % n) + n) % n;
  return pattern[i];
}

export interface ArpStep {
  tick: number;
  step: number;
  pitch: number;
  durationTicks: number;
}

/**
 * Arp notes on the division grid in [fromTick, toTick) for a fixed held set.
 * `originTick` is the grid tick of step 0 (the first step after the press).
 */
export function arpSteps(
  held: readonly number[],
  settings: Pick<ArpSettings, 'mode' | 'octaves' | 'division' | 'gate'>,
  originTick: number,
  fromTick: number,
  toTick: number,
): ArpStep[] {
  const pattern = arpPattern(held, settings);
  if (!pattern.length) return [];
  const div = arpDivisionTicks(settings.division);
  const dur = arpGateTicks(settings);
  const out: ArpStep[] = [];
  let g = Math.ceil(Math.max(fromTick, originTick) / div) * div + 0;
  if (g < fromTick || g < originTick) g += div;
  for (; g < toTick; g += div) {
    const step = Math.round((g - originTick) / div);
    out.push({ tick: g, step, pitch: pattern[step % pattern.length], durationTicks: dur });
  }
  return out;
}

/** First grid tick at or after `tick` for a division (where a new press starts). */
export function arpGridAtOrAfter(tick: number, division: ArpDivision): number {
  const div = arpDivisionTicks(division);
  // A press a hair after a grid line (clock rounding) still starts on that line.
  return Math.ceil(tick / div - 1e-6) * div + 0;
}

/* ------------------------------------------------------------------ */
/* Latch                                                               */
/* ------------------------------------------------------------------ */

export interface LatchState {
  /** Keys physically held now, in the order they were pressed. */
  held: readonly number[];
  /** Notes kept by latch: every key pressed since the last full release. */
  latched: readonly number[];
}

export const EMPTY_LATCH: LatchState = Object.freeze({ held: Object.freeze([]) as readonly number[], latched: Object.freeze([]) as readonly number[] });

/**
 * Update latch state with the keys held now. The latched set persists after
 * all keys are released; the first press after a full release starts a new
 * set, and keys added while any key is still down join the current set.
 */
export function updateLatch(state: LatchState, held: readonly number[]): LatchState {
  const now = cleanHeld(held);
  if (!now.length) return { held: [], latched: state.latched };
  if (!state.held.length) return { held: now, latched: now };
  const latched = [...state.latched];
  for (const p of now) if (!latched.includes(p)) latched.push(p);
  return { held: now, latched };
}

/** The notes the arp plays: the latched set with latch on, the held keys otherwise. */
export function arpInput(state: LatchState, latch: boolean): readonly number[] {
  return latch ? state.latched : state.held;
}
