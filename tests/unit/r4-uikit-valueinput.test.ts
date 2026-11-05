/**
 * Typed entry on controls shown as minus their stored number (ParamSpec.negate, Gate Depth: stored
 * 0..80, shown 0 to -80 dB): the entry starts with the number on screen, a typed "-40" stores 40,
 * and a plain "40" stores 40 too (no value of the control reads above zero, so a positive number
 * can only mean that amount). Other controls are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { paramEditText, parseParamInput } from '../../src/ui/components/valueInput';
import type { ParamSpec } from '../../src/project/params';

/** Gate Depth as the model's registry defines it (see ParamSpec.negate). */
const GATE_DEPTH = { id: 'range', label: 'Depth', min: 0, max: 80, default: 60, unit: 'dB', curve: 'lin', negate: true, tip: 'How far the closed gate turns things down.' } as ParamSpec;
const GAIN: ParamSpec = { id: 'gain', label: 'Gain', min: -24, max: 24, default: 0, unit: 'dB', curve: 'lin', tip: 'Level.' };

describe('typed entry on a negated control (Gate Depth)', () => {
  it('starts with the number on screen', () => {
    expect(paramEditText(GATE_DEPTH, 60)).toBe('-60');
    expect(paramEditText(GATE_DEPTH, 12.5)).toBe('-12.5');
    expect(paramEditText(GATE_DEPTH, 0)).toBe('0');
  });

  it('"-40" stores 40, "-40 dB" too', () => {
    expect(parseParamInput(GATE_DEPTH, '-40', 60)).toBe(40);
    expect(parseParamInput(GATE_DEPTH, '-40 dB', 60)).toBe(40);
  });

  it('a plain "40" stores 40: no value of this control reads above zero', () => {
    expect(parseParamInput(GATE_DEPTH, '40', 60)).toBe(40);
    expect(parseParamInput(GATE_DEPTH, '0', 60)).toBe(0);
  });

  it('clamps to the range as shown', () => {
    expect(parseParamInput(GATE_DEPTH, '-100', 60)).toBe(80);
    expect(parseParamInput(GATE_DEPTH, '100', 60)).toBe(80);
  });

  it('round-trips: what the entry starts with stores the same value', () => {
    for (const v of [0, 1, 12.5, 60, 80]) expect(parseParamInput(GATE_DEPTH, paramEditText(GATE_DEPTH, v), v)).toBe(v);
  });

  it('other dB controls keep reading the sign as typed', () => {
    expect(paramEditText(GAIN, -6)).toBe('-6');
    expect(parseParamInput(GAIN, '-6', 0)).toBe(-6);
    expect(parseParamInput(GAIN, '6', 0)).toBe(6);
  });
});
