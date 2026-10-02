/**
 * Text <-> value helpers for direct numeric entry on knobs and number fields,
 * plus gesture ids shared by every continuous control.
 *
 * Typed text is interpreted in the units the control displays, so what you
 * read is what you type: "2.5k" or "2.5 kHz" on a frequency, "-6" on a gain,
 * "40" on a percentage (40%), "220" or "220 ms" on a time shown in ms
 * ("0.8 s" or "800 ms" always work),
 * "L20" / "R35" / "C" on a pan control, and an option name on a stepped
 * control. A control shown as minus its stored number (`negate`, Gate Depth:
 * stored 60, shown "-60.0 dB") is typed as shown ("-40"); a plain "40" there
 * means the same 40 dB, since every value it can show is at or below zero.
 */
import { clampParam, type ParamSpec } from '../../project/params';

let gestureCounter = 0;

/** A new id for one continuous gesture (a drag, a keyboard burst, an entry). */
export function newGestureId(kind: string): string {
  gestureCounter += 1;
  return `${kind}-${gestureCounter.toString(36)}-${Date.now().toString(36)}`;
}

const NUM = /^([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*([a-zµ%×']*)$/i;

/**
 * Controls shown as minus their stored number (ParamSpec.negate). The same rule as displayValue /
 * fromDisplayValue in project/params: the shown number is minus the stored one.
 */
function negated(spec: ParamSpec): boolean {
  return (spec as ParamSpec & { negate?: boolean }).negate === true;
}

function toNumber(s: string): number {
  return Number(s.replace(',', '.'));
}

/**
 * Parse typed text for a parameter. Returns the clamped value, or null when
 * the text cannot be understood (the caller keeps the editor open).
 *
 * `current` is the value the control shows while the user types. Times are
 * displayed in ms below one second and in seconds above, so a plain number is
 * read in the unit currently on screen ("2" on a knob showing "5 ms" is 2 ms,
 * not 2 s) unless only the other unit fits the range ("500" on a knob showing
 * "1.20 s" is 500 ms).
 */
export function parseParamInput(spec: ParamSpec, raw: string, current?: number): number | null {
  const text = raw.trim();
  if (text === '') return null;

  if (spec.curve === 'enum' && spec.options) {
    const lower = text.toLowerCase();
    const exact = spec.options.findIndex((o) => o.toLowerCase() === lower);
    if (exact >= 0) return exact;
    const prefix = spec.options.findIndex((o) => o.toLowerCase().startsWith(lower));
    if (prefix >= 0) return prefix;
    // A number selects the option by its position, counting from 1.
    const n = Number(text);
    if (Number.isInteger(n) && n >= 1 && n <= spec.options.length) return n - 1;
    return null;
  }

  if (spec.curve === 'bool') {
    const lower = text.toLowerCase();
    if (['on', '1', 'yes', 'true'].includes(lower)) return 1;
    if (['off', '0', 'no', 'false'].includes(lower)) return 0;
    return null;
  }

  if (spec.id === 'pan' && spec.unit === '') {
    const m = /^([lrc])\s*(\d+(?:[.,]\d*)?)?$/i.exec(text);
    if (m) {
      const side = m[1].toLowerCase();
      if (side === 'c') return 0;
      const amount = m[2] === undefined ? 100 : toNumber(m[2]);
      return clampParam(spec, ((side === 'l' ? -1 : 1) * amount) / 100);
    }
    const n = NUM.exec(text);
    if (!n) return null;
    // Pan is shown as a percentage to each side; plain numbers follow suit.
    return clampParam(spec, toNumber(n[1]) / 100);
  }

  const m = NUM.exec(text);
  if (!m) return null;
  let v = toNumber(m[1]);
  if (!Number.isFinite(v)) return null;
  const suffix = m[2].toLowerCase();

  switch (spec.unit) {
    case 'Hz':
      if (suffix === 'k' || suffix === 'khz') v *= 1000;
      else if (suffix !== '' && suffix !== 'hz') return null;
      break;
    case 's':
      if (suffix === 'ms') v /= 1000;
      else if (suffix === 's' || suffix === 'sec') {
        /* seconds */
      } else if (suffix === '') {
        const fits = (x: number) => x >= spec.min && x <= spec.max;
        const shownInMs = current !== undefined && clampParam(spec, current) < 1;
        if (shownInMs) {
          // Prefer the unit on screen; fall back to seconds only when ms cannot fit.
          if (fits(v / 1000) || !fits(v)) v /= 1000;
        } else if (!fits(v) && fits(v / 1000)) {
          // Shown in seconds (or unknown): "220" beyond the range most likely means 220 ms.
          v /= 1000;
        }
      } else return null;
      break;
    case 'ms':
      if (suffix === 's' || suffix === 'sec') v *= 1000;
      else if (suffix !== '' && suffix !== 'ms') return null;
      break;
    case '%':
      if (suffix !== '' && suffix !== '%') return null;
      v /= 100;
      break;
    case 'dB':
      if (suffix !== '' && suffix !== 'db') return null;
      break;
    case 'st':
      if (suffix !== '' && suffix !== 'st' && suffix !== 'semi') return null;
      break;
    case 'ct':
      if (suffix !== '' && suffix !== 'ct' && suffix !== 'c' && suffix !== 'cents') return null;
      break;
    case 'x':
      if (suffix !== '' && suffix !== 'x' && suffix !== '×') return null;
      break;
    case 'bpm':
      if (suffix !== '' && suffix !== 'bpm') return null;
      break;
    case 'bits':
      if (suffix !== '' && suffix !== 'bit' && suffix !== 'bits' && suffix !== 'b') return null;
      break;
    default:
      if (suffix === 'k') v *= 1000;
      else if (suffix !== '') return null;
  }
  if (negated(spec)) {
    // Typed as shown: "-40" stores 40. A positive number cannot be shown (all values read at or
    // below zero), so it is read as the same amount: "40" stores 40 too.
    v = -v;
    if (v < spec.min && -v >= spec.min) v = -v;
  }
  return clampParam(spec, v);
}

/** The text an entry field starts with: the current value in display units, without the unit. */
export function paramEditText(spec: ParamSpec, value: number): string {
  const stored = clampParam(spec, value);
  if (spec.curve === 'enum' && spec.options) return spec.options[stored] ?? String(stored);
  if (spec.curve === 'bool') return stored ? 'On' : 'Off';
  // The number the control shows (minus the stored one on a `negate` control).
  const v = negated(spec) && stored !== 0 ? -stored : stored;
  const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)));
  switch (spec.unit) {
    case 'Hz':
      return v >= 1000 ? `${trim(v / 1000, 3)}k` : trim(v, 1);
    case 's':
      return v < 1 ? `${trim(v * 1000, 1)} ms` : trim(v, 3);
    case '%':
      return trim(v * 100, 1);
    case 'dB':
    case 'st':
    case 'ct':
    case 'x':
    case 'ms':
    case 'bpm':
    case 'bits':
      return trim(v, 2);
    default:
      if (spec.id === 'pan') return Math.abs(v) < 0.005 ? 'C' : `${v < 0 ? 'L' : 'R'}${trim(Math.abs(v) * 100, 1)}`;
      return trim(v, 3);
  }
}

/** Parse a plain number with an optional unit suffix (used by NumberField). */
export function parsePlainNumber(raw: string, unit?: string): number | null {
  const m = NUM.exec(raw.trim());
  if (!m) return null;
  const suffix = m[2].toLowerCase();
  if (suffix !== '' && (!unit || suffix !== unit.toLowerCase())) return null;
  const v = toNumber(m[1]);
  return Number.isFinite(v) ? v : null;
}
