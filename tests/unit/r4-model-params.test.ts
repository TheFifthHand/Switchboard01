/**
 * Parameter words and values: short times read every step (shape-22), the
 * Gate's Depth reads as the level change it makes, distinct names for
 * distinct things (shape-19, shape-20), plain send details (MIX-03), knobs
 * that say what turns them on (shape-17), and a master that resets to 0 dB
 * (MIX-12).
 */
import { describe, expect, it } from 'vitest';
import { MASTERING_PRESETS } from '../../src/content/mastering';
import {
  BASS_PARAMS,
  CHANNEL_PARAMS,
  COMPRESSOR_PARAMS,
  DELAY_PARAMS,
  DRIVE_PARAMS,
  EQ_PARAMS,
  GATE_PARAMS,
  MASTER_VOLUME_SPEC,
  POLY_PARAMS,
  SAMPLER_PARAMS,
  displayValue,
  formatParam,
  fromDisplayValue,
  fromNormalized,
  toNormalized,
  gateOpen,
  specById,
  type ParamSpec,
} from '../../src/project/params';

const spec = (specs: readonly ParamSpec[], id: string) => specById(specs, id)!;

describe('short times read every step (shape-22)', () => {
  it('one decimal below 10 ms, for times in seconds and in ms', () => {
    const attack = spec(BASS_PARAMS, 'attack');
    // Five arrow-key steps (1% of the knob's travel) up from 2 ms all read differently.
    const from = toNormalized(attack, 0.002);
    const steps = Array.from({ length: 5 }, (_, i) => formatParam(attack, fromNormalized(attack, from + i * 0.01)));
    expect(new Set(steps).size).toBe(5);
    expect(formatParam(attack, 0.0023)).toBe('2.3 ms');
    expect(formatParam(attack, 0.0123)).toBe('12 ms');
    expect(formatParam(attack, 0.3)).toBe('300 ms');
    expect(formatParam(spec(POLY_PARAMS, 'attack'), 1.2)).toBe('1.20 s');
    const gateAttack = spec(GATE_PARAMS, 'attack');
    expect(formatParam(gateAttack, 0.1)).toBe('0.1 ms');
    expect(formatParam(spec(COMPRESSOR_PARAMS, 'attack'), 0.1)).toBe('0.1 ms');
    expect(formatParam(spec(COMPRESSOR_PARAMS, 'attack'), 9.96)).toBe('10 ms');
    expect(formatParam(spec(SAMPLER_PARAMS, 'fadeIn'), 0)).toBe('0 ms');
    expect(formatParam(spec(SAMPLER_PARAMS, 'fadeIn'), 250)).toBe('250 ms');
  });
});

describe('Gate Depth reads as the change it makes (shape-20)', () => {
  it('stores 60 and shows -60.0 dB; typed values convert back', () => {
    const depth = spec(GATE_PARAMS, 'range');
    expect(depth.id).toBe('range');
    expect(formatParam(depth, 60)).toBe('-60.0 dB');
    expect(formatParam(depth, 0)).toBe('0.0 dB');
    expect(displayValue(depth, 60)).toBe(-60);
    expect(fromDisplayValue(depth, -45)).toBe(45);
    // Other dB controls are unchanged.
    expect(formatParam(spec(EQ_PARAMS, 'lowGain'), 3)).toBe('+3.0 dB');
    expect(fromDisplayValue(spec(EQ_PARAMS, 'lowGain'), -3)).toBe(-3);
  });
});

describe('names (shape-19, shape-20) and send details (MIX-03)', () => {
  it('Drive’s tone is Fizz and Echo’s width is Ping-pong; the stored ids stay', () => {
    expect(spec(DRIVE_PARAMS, 'tone').label).toBe('Fizz');
    expect(spec(DRIVE_PARAMS, 'tone').detail).toBeTruthy();
    expect(spec(DELAY_PARAMS, 'width').label).toBe('Ping-pong');
  });

  it('the send knobs say where the sound goes, in plain words', () => {
    const a = spec(CHANNEL_PARAMS, 'sendA');
    const b = spec(CHANNEL_PARAMS, 'sendB');
    expect(a.tip).toBe('How much of this part goes to the shared Reverb.');
    expect(b.tip).toBe('How much of this part goes to the shared Echo.');
    for (const s of [a, b]) expect(`${s.tip} ${s.detail}`).not.toMatch(/send [AB]|default patch|post-fader/i);
  });

  it('the master resets to 0 dB', () => {
    expect(MASTER_VOLUME_SPEC.default).toBe(0);
  });

  it('the Loud preset promises no number', () => {
    const loud = MASTERING_PRESETS.find((p) => p.id === 'loud')!;
    expect(loud.name).toBe('Loud');
    expect(loud.description).not.toMatch(/LUFS|-?\d+ ?dB|as loud as it gets/i);
  });
});

describe('knobs that need another control first (shape-17)', () => {
  const gated: [readonly ParamSpec[], string, string][] = [
    [POLY_PARAMS, 'unisonDetune', 'unison'],
    [POLY_PARAMS, 'pitchDecay', 'pitchEnv'],
    [BASS_PARAMS, 'pitchDecay', 'pitchEnv'],
    [POLY_PARAMS, 'vibratoRate', 'vibrato'],
    [POLY_PARAMS, 'noiseColor', 'noise'],
    [EQ_PARAMS, 'lowFreq', 'lowGain'],
    [EQ_PARAMS, 'midFreq', 'midGain'],
    [EQ_PARAMS, 'midQ', 'midGain'],
    [EQ_PARAMS, 'highFreq', 'highGain'],
    [DRIVE_PARAMS, 'character', 'amount'],
    [DRIVE_PARAMS, 'tone', 'amount'],
    [DRIVE_PARAMS, 'mix', 'amount'],
  ];

  it('say what turns them on, and are closed at the other control’s default', () => {
    for (const [specs, id, on] of gated) {
      const s = spec(specs, id);
      expect(s.gate?.param, id).toBe(on);
      expect(s.gate!.reason, id).toMatch(/^Does nothing (while|until) .+\.$/);
      expect(specById(specs, on), `${id} gate`).toBeDefined();
      expect(gateOpen(s, {}, specs), `${id} closed by default`).toBe(false);
    }
  });

  it('open once the other control is raised', () => {
    const detune = spec(POLY_PARAMS, 'unisonDetune');
    expect(gateOpen(detune, { unison: 1 })).toBe(false);
    expect(gateOpen(detune, { unison: 4 })).toBe(true);
    const sweep = spec(POLY_PARAMS, 'pitchDecay');
    expect(gateOpen(sweep, { pitchEnv: -12 })).toBe(true);
    expect(gateOpen(sweep, { pitchEnv: 0 })).toBe(false);
    const width = spec(EQ_PARAMS, 'midQ');
    expect(gateOpen(width, { midGain: -3 })).toBe(true);
    expect(gateOpen(spec(DRIVE_PARAMS, 'tone'), { amount: 0.4 })).toBe(true);
    // Ungated controls are always open; the bass's Unison Detune is its own on switch.
    expect(gateOpen(spec(POLY_PARAMS, 'cutoff'), {})).toBe(true);
    expect(spec(BASS_PARAMS, 'unisonDetune').gate).toBeUndefined();
  });
});
