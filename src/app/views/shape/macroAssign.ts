/**
 * Giving a big knob (macro) a new setting to move: the range a fresh
 * assignment sweeps, and the words the Macros column uses for a mapping.
 *
 * Pure (no React, no DOM): unit-tested in tests/unit/r4-shape-logic.test.ts.
 */
import { clampParam, formatParam, fromNormalized, toNormalized, type ParamSpec } from '../../../project/params';
import type { MacroTarget } from '../../../project/types';

/** How much of a control's travel a new assignment sweeps (normalised), when there is room. */
export const ASSIGN_SPAN = 0.5;
/** Below this much room in either direction, a new assignment waits for the big knob to pass its position instead. */
const MIN_SPAN = 0.05;

export interface AssignRange {
  min: number;
  max: number;
  curve: 'lin' | 'exp';
  /** Set when the setting sits at an end of its travel: it moves only over this part of the big knob's travel. */
  macroFrom?: number;
  macroTo?: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The range a new big-knob assignment sweeps for a control now at `value`
 * while the big knob sits at `macroValue`: half the control's travel, laid
 * out so that at the big knob's current position the control keeps its
 * current value (assigning never jumps the sound). It sweeps upwards from a
 * value in the lower half of the travel and downwards from the upper half,
 * whichever has room; a value at an end of its travel waits there until the
 * big knob passes its current position (macroFrom). Frequencies and times
 * (exponential controls) sweep evenly in pitch and time ('exp' curve).
 * An option control keeps its option until the big knob passes its position
 * (optionRange).
 */
export function assignRange(spec: ParamSpec, value: number, macroValue: number): AssignRange {
  const curve: AssignRange['curve'] = spec.curve === 'exp' && spec.min > 0 ? 'exp' : 'lin';
  const m = clamp01(macroValue);
  if (spec.curve === 'enum' || spec.curve === 'bool') return optionRange(spec, value, m);
  const n = clamp01(toNormalized(spec, value));
  const room = (a: number, b: number) => Math.min(ASSIGN_SPAN, a, b);
  // Up: n(m') = n - m·d + m'·d.   Down: n(m') = n + m·d - m'·d.
  const up = room(m > 0 ? n / m : Infinity, m < 1 ? (1 - n) / (1 - m) : Infinity);
  const down = room(m > 0 ? (1 - n) / m : Infinity, m < 1 ? n / (1 - m) : Infinity);
  const preferUp = n <= 0.5;
  let dir: 1 | -1 = preferUp ? 1 : -1;
  let d = preferUp ? up : down;
  const other = preferUp ? down : up;
  if (d < 0.15 && other > d) {
    dir = preferUp ? -1 : 1;
    d = other;
  }
  if (d < MIN_SPAN) {
    // No room around the value (it sits at an end of its travel, the big knob in between): it waits there
    // until the big knob passes its current position, then sweeps half the travel away from that end.
    const far = fromNormalized(spec, clamp01(n <= 0.5 ? n + ASSIGN_SPAN : n - ASSIGN_SPAN));
    const here = fromNormalized(spec, n);
    return m < 1 ? { min: here, max: far, curve, macroFrom: m, macroTo: 1 } : { min: far, max: here, curve };
  }
  const lo = dir === 1 ? n - m * d : n + m * d;
  const hi = dir === 1 ? n + (1 - m) * d : n - (1 - m) * d;
  return { min: fromNormalized(spec, clamp01(lo)), max: fromNormalized(spec, clamp01(hi)), curve };
}

/**
 * An option control (a mode, a wave, on or off) keeps its current option
 * until the big knob passes its current position, then steps towards the
 * option at the far end of its list as the big knob goes on up. With the big
 * knob at the top of its travel it is the other way round: the far option at
 * the bottom, the current one at the top.
 */
function optionRange(spec: ParamSpec, value: number, m: number): AssignRange {
  const here = clampParam(spec, value);
  const far = here - spec.min >= spec.max - here ? spec.min : spec.max;
  if (m >= 1) return { min: far, max: here, curve: 'lin' };
  return m > 0 ? { min: here, max: far, curve: 'lin', macroFrom: m, macroTo: 1 } : { min: here, max: far, curve: 'lin' };
}

/** A mapping's curve in words: 'gentle' (exponential: even steps in pitch or time) or 'even' (linear). */
export function curveWord(curve: MacroTarget['curve']): 'gentle' | 'even' {
  return curve === 'exp' ? 'gentle' : 'even';
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * One mapping in words, as the Macros column reads it:
 * "Filter Cutoff, curve: gentle, over Tone 0–50%, now 2.30 kHz".
 */
export function mappingWords(macroName: string, target: MacroTarget, now: string): { curve: string; over: string | null; now: string } {
  const from = target.macroFrom ?? 0;
  const to = target.macroTo ?? 1;
  const partial = from !== 0 || to !== 1;
  return {
    curve: `curve: ${curveWord(target.curve)}`,
    over: partial ? `over ${macroName} ${Math.round(from * 100)}–${pct(to)}` : null,
    now: `now ${now}`,
  };
}

/** "Filter Cutoff from 260 Hz to 20.0 kHz" (the range a mapping sweeps, in the control's units). */
export function rangeWords(spec: ParamSpec | undefined, target: MacroTarget): string {
  const f = (v: number) => (spec ? formatParam(spec, v) : String(Number(v.toFixed(3))));
  return `from ${f(target.min)} to ${f(target.max)}`;
}
