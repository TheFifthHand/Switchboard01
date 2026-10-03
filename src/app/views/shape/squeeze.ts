/**
 * Squeeze: the Simple Compressor card's one knob. One amount that lowers the
 * threshold and raises the ratio together (the same idea as the mastering
 * Glue: "threshold and ratio rise together"), with automatic make-up gain, so
 * turning it up holds the loud moments down harder without simply making the
 * part quieter. Past the compressor's default (50 %) the attack also
 * quickens (10 ms to 2 ms), so more of each hit's front is held down. All of
 * them are written in one gesture (one undo step). Without look-ahead, the
 * first moments of a hit still pass at the made-up level; the output limiter
 * catches them.
 *
 * Pure (no React, no audio).
 */
import { COMPRESSOR_PARAMS, clampParam, specById, type ParamSpec } from '../../../project/params';
import type { ParamValues } from '../../../project/types';

/** Threshold at full Squeeze (0 dB at none). */
export const SQUEEZE_MAX_THRESHOLD_DB = -36;
/** Ratio at full Squeeze (1:1 at none). */
export const SQUEEZE_MAX_RATIO = 7;
/**
 * Make-up gain gives back the static gain reduction the curve applies at this
 * level (dBFS, the waveform peaks of a typical part's body), so the part's
 * level stays about where it was while its loud moments are held down.
 */
export const SQUEEZE_MAKEUP_REF_DB = -18;
/**
 * Squeeze at the compressor's own defaults: half way puts it exactly there
 * (threshold −18 dB, 4:1, no makeup, 10 ms attack), so an added Compressor
 * shows 50 %.
 */
export const SQUEEZE_DEFAULT = 0.5;
/** Attack at and below SQUEEZE_DEFAULT, and at full Squeeze (ms). */
const ATTACK_SLOW_MS = 10;
const ATTACK_FAST_MS = 2;

export const SQUEEZE_SPEC: ParamSpec = {
  id: 'squeeze',
  label: 'Squeeze',
  min: 0,
  max: 1,
  default: SQUEEZE_DEFAULT,
  unit: '%',
  curve: 'lin',
  tip: 'How hard loud moments are held down: more squeeze makes the part tighter and more even. Its level stays about the same.',
  detail: 'One amount for several settings: it lowers Threshold (0 to −36 dB), raises the ratio (1:1 to 7:1), sets Makeup to give back what it takes and, past the middle, quickens Attack (10 to 2 ms). 50 % is the compressor’s own default. Every setting shows them separately.',
};

const spec = (id: string) => specById(COMPRESSOR_PARAMS, id)!;

/** The compressor settings for a Squeeze amount (0..1). */
export function squeezeParams(amount: number): { threshold: number; ratio: number; makeup: number; attack: number } {
  const s = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0));
  const threshold = SQUEEZE_MAX_THRESHOLD_DB * s + 0; // + 0: never −0
  const ratio = 1 + (SQUEEZE_MAX_RATIO - 1) * s;
  const over = SQUEEZE_MAKEUP_REF_DB - threshold;
  const makeup = over > 0 ? over * (1 - 1 / ratio) : 0;
  const fast = s <= SQUEEZE_DEFAULT ? 0 : (s - SQUEEZE_DEFAULT) / (1 - SQUEEZE_DEFAULT);
  const attack = ATTACK_SLOW_MS * Math.pow(ATTACK_FAST_MS / ATTACK_SLOW_MS, fast);
  return {
    threshold: clampParam(spec('threshold'), threshold),
    ratio: clampParam(spec('ratio'), ratio),
    makeup: clampParam(spec('makeup'), Math.round(makeup * 10) / 10),
    attack: clampParam(spec('attack'), Math.round(attack * 100) / 100),
  };
}

/** The Squeeze amount a compressor's settings show (read from its threshold). */
export function squeezeOf(params: ParamValues | undefined): number {
  const t = params?.threshold ?? spec('threshold').default;
  return Math.min(1, Math.max(0, t / SQUEEZE_MAX_THRESHOLD_DB));
}
