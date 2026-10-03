/**
 * shape-03: a knob's reset returns to the sound's own design.
 *
 * - Big knobs: double-click (and Delete) return to the position the part's
 *   starter / sound designed (Track.macroHome): Chords' Space 28 %, Pump 45 %;
 *   Alt+double-click goes to the plain default (Space 15 %, Pump 0 %).
 * - Sound knobs (ParamKnob): double-click returns to the preset's value (Bass
 *   Resonance 38 %, Attack 2.0 ms), Alt+double-click to the registry default.
 * - The tips say so ("this sound’s 28%").
 * Real drags, double-clicks and keys.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { selectTrack } from '../../src/state/uiStore';
import { clickEl, closeShape, described, dragKnob, keysOn, openShape, slider, track } from './r4-shape-helpers';
import { centre, settleFrames } from './r4-uikit-input';

const ALT = 1;

afterEach(closeShape);

describe('big knobs return to the sound’s own position', () => {
  beforeEach(async () => {
    await openShape({ w: 1366, hh: 768, mode: 'simple', trackId: 't4', tips: true });
  });

  it('Chords: Space dragged up, then double-clicked → 28 %; Pump → 45 %', async () => {
    const space = document.getElementById('shape-macro-space')!;
    expect(track('t4').macros.space).toBeCloseTo(0.28, 5);
    await dragKnob(space, 60);
    expect(track('t4').macros.space).toBeGreaterThan(0.4);
    await clickEl(space, { at: centre(space, 0.5, 0.3), clickCount: 2 });
    expect(track('t4').macros.space).toBeCloseTo(0.28, 5);

    const pump = document.getElementById('shape-macro-pump')!;
    await dragKnob(pump, -50);
    expect(track('t4').macros.pump).toBeLessThan(0.3);
    await clickEl(pump, { at: centre(pump, 0.5, 0.3), clickCount: 2 });
    expect(track('t4').macros.pump).toBeCloseTo(0.45, 5);

    // Delete does the same from the keyboard.
    await keysOn(pump, '{End}');
    await keysOn(pump, '{Delete}');
    expect(track('t4').macros.pump).toBeCloseTo(0.45, 5);
  });

  it('Alt+double-click goes to the plain default instead (Space 15 %, Pump 0 %)', async () => {
    const space = document.getElementById('shape-macro-space')!;
    await clickEl(space, { at: centre(space, 0.5, 0.3), clickCount: 2, modifiers: ALT });
    expect(track('t4').macros.space).toBeCloseTo(0.15, 5);
    const pump = document.getElementById('shape-macro-pump')!;
    await clickEl(pump, { at: centre(pump, 0.5, 0.3), clickCount: 2, modifiers: ALT });
    expect(track('t4').macros.pump).toBe(0);
  });

  it('the tip says where double-click goes: “this sound’s 28%”, and the plain default', async () => {
    const words = described(document.getElementById('shape-macro-space')!);
    expect(words).toContain('Double-click resets it to 28%');
    expect(words).toContain('Double-click returns it to this sound’s 28%; Alt+double-click to the plain default, 15%.');
  });
});

describe('sound knobs return to the preset’s own value', () => {
  beforeEach(async () => {
    await openShape({ w: 1366, hh: 768, mode: 'advanced', trackId: 't3', tips: true });
    // Short window: the Instrument column is a tab.
    await clickEl([...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.includes('Instrument')) ?? null);
  });

  it('Bass (Rubber Pluck): Resonance dragged, double-clicked → 38 % (the preset), Alt+double-click → 25 % (the plain default)', async () => {
    const col = document.getElementById('shape-col-instrument')!;
    const res = slider(col, 'Resonance');
    const inst = () => track('t3').instrument.params;
    expect(inst().resonance).toBeCloseTo(0.38, 5);
    await dragKnob(res, 40);
    expect(inst().resonance).toBeGreaterThan(0.45);
    await clickEl(res, { at: centre(res, 0.5, 0.3), clickCount: 2 });
    expect(inst().resonance).toBeCloseTo(0.38, 5);
    await clickEl(res, { at: centre(res, 0.5, 0.3), clickCount: 2, modifiers: ALT });
    expect(inst().resonance).toBeCloseTo(0.25, 5);

    // Attack: the preset's 2 ms, and the tip says so.
    const attack = slider(col, 'Attack');
    await keysOn(attack, '{End}');
    await keysOn(attack, '{Delete}');
    expect(inst().attack).toBeCloseTo(0.002, 6);
    expect(described(attack)).toContain('Double-click returns it to this sound’s 2.0 ms; Alt+double-click to the plain default, 3.0 ms.');
  });

  it('the Drums kit Level returns to the kit’s matched level; the plain default is 0 dB', async () => {
    act(() => selectTrack('t1'));
    await settleFrames(2);
    const col = document.getElementById('shape-col-instrument')!;
    const level = slider(col, 'Level');
    await keysOn(level, '{End}');
    await keysOn(level, '{Delete}');
    expect(track('t1').instrument.params.level).toBe(-11);
    expect(described(level)).toContain('Alt+double-click to the plain default, 0.0 dB');
  });
});
