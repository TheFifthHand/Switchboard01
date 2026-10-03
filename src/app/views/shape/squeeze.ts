/**
 * Squeeze: the Simple Compressor card's one knob. One amount that lowers the
 * threshold and raises the ratio together (the same idea as the mastering
 * Glue: "threshold and ratio rise together"), with automatic make-up gain, so
 * turning it up holds the loud moments down harder without simply making the
 * part quieter. Up to the compressor's default (50 %) it goes from no
 * compression to the default; past it the threshold and ratio go on to
 * −28 dB and 5:1 and the attack quickens (10 ms to 0.5 ms), so the front of
 * each hit is held down too. All of them are written in one gesture (one
 * undo step).
 *
 * The compressor has no look-ahead, so the first moments of a hit pass at the
 * made-up level: Makeup gives back the reduction at a typical part's body
 * level (−18 dBFS) and never more than SQUEEZE_MAX_MAKEUP_DB, so full Squeeze
 * keeps every starter part well clear of the output ceiling (measured: the
 * loudest, House's drums, peaks at −4.9 dBFS, from −7.0 without it). A part
 * driven hard into it comes out a little quieter instead.
 *
 * Pure (no React, no audio).
 */
import { COMPRESSOR_PARAMS, clampParam, specById, type ParamSpec } from '../../../project/params';
import type { ParamValues } from '../../../project/types';

/** Threshold at the compressor's default (50 %) and at full Squeeze (0 dB at none). */
const THRESHOLD_DEFAULT_DB = -18;
export const SQUEEZE_MAX_THRESHOLD_DB = -28;
/** Ratio at the default and at full Squeeze (1:1 at none). */
const RATIO_DEFAULT = 4;
export const SQUEEZE_MAX_RATIO = 5;
/**
 * Make-up gain gives back the static gain reduction the curve applies at this
 * level (dBFS, the waveform peaks of a typical part's body)…
 */
export const SQUEEZE_MAKEUP_REF_DB = -18;
/** …but never more than this, so the hits that pass before the attack stay clear of the ceiling. */
export const SQUEEZE_MAX_MAKEUP_DB = 8;
/**
 * Squeeze at the compressor's own defaults: half way puts it exactly there
 * (threshold −18 dB, 4:1, no makeup, 10 ms attack), so an added Compressor
 * shows 50 %.
 */
export const SQUEEZE_DEFAULT = 0.5;
/** Attack at and below SQUEEZE_DEFAULT, and at full Squeeze (ms). */
const ATTACK_SLOW_MS = 10;
const ATTACK_FAST_MS = 0.5;

export const SQUEEZE_SPEC: ParamSpec = {
  id: 'squeeze',
  label: 'Squeeze',
  min: 0,
  max: 1,
  default: SQUEEZE_DEFAULT,
  unit: '%',
  curve: 'lin',
  tip: 'How hard loud moments are held down: more squeeze makes the part tighter and more even. The level comes back up most of the way.',
  detail:
    'One amount for several settings: it lowers Threshold (0 to −28 dB), raises the ratio (1:1 to 5:1), turns the level back up with Makeup (at most 8 dB, so the loudest hits stay clear of the ceiling) and, past the middle, quickens Attack (10 to 0.5 ms). 50 % is the compressor’s own default. Every setting shows them separately.',
};

const spec = (id: string) => specById(COMPRESSOR_PARAMS, id)!;

/** The compressor settings for a Squeeze amount (0..1). */
export function squeezeParams(amount: number): { threshold: number; ratio: number; makeup: number; attack: number } {
  const s = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0));
  // 0 → 50 %: none to the compressor's defaults; 50 % → 100 %: on to the full Squeeze.
  const low = Math.min(1, s / SQUEEZE_DEFAULT);
  const high = s <= SQUEEZE_DEFAULT ? 0 : (s - SQUEEZE_DEFAULT) / (1 - SQUEEZE_DEFAULT);
  const threshold = THRESHOLD_DEFAULT_DB * low + (SQUEEZE_MAX_THRESHOLD_DB - THRESHOLD_DEFAULT_DB) * high + 0; // + 0: never −0
  const ratio = 1 + (RATIO_DEFAULT - 1) * low + (SQUEEZE_MAX_RATIO - RATIO_DEFAULT) * high;
  const over = SQUEEZE_MAKEUP_REF_DB - threshold;
  const makeup = Math.min(SQUEEZE_MAX_MAKEUP_DB, over > 0 ? over * (1 - 1 / ratio) : 0);
  const attack = ATTACK_SLOW_MS * Math.pow(ATTACK_FAST_MS / ATTACK_SLOW_MS, high);
  return {
    threshold: clampParam(spec('threshold'), Math.round(threshold * 100) / 100),
    ratio: clampParam(spec('ratio'), Math.round(ratio * 1000) / 1000),
    makeup: clampParam(spec('makeup'), Math.round(makeup * 10) / 10),
    attack: clampParam(spec('attack'), Math.round(attack * 100) / 100),
  };
}

/** The Squeeze amount a compressor's settings show (read from its threshold). */
export function squeezeOf(params: ParamValues | undefined): number {
  const t = params?.threshold ?? spec('threshold').default;
  const s = t >= THRESHOLD_DEFAULT_DB ? (t / THRESHOLD_DEFAULT_DB) * SQUEEZE_DEFAULT : SQUEEZE_DEFAULT + ((t - THRESHOLD_DEFAULT_DB) / (SQUEEZE_MAX_THRESHOLD_DB - THRESHOLD_DEFAULT_DB)) * (1 - SQUEEZE_DEFAULT);
  return Math.min(1, Math.max(0, s));
}
