/**
 * shape-17: a control that does nothing until another one is raised is
 * dimmed, and its tip starts with the reason; it un-dims once its gate opens.
 * Section gates say "Off: …" for Unison and Vibrato (and FM, Noise, Pitch
 * Sweep); an EQ band whose gain is 0 dB says "Set this band’s gain first".
 * Real keys.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { session } from '../../src/app/instance';
import * as cmd from '../../src/state/commands';
import { clickEl, closeShape, described, keysOn, openShape, slider } from './r4-shape-helpers';
import { settleFrames } from './r4-uikit-input';

afterEach(closeShape);

const tab = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.includes(name)) ?? null;
/** The knob's root (the dimmed element) for a slider. */
const knobOf = (s: HTMLElement) => s.closest<HTMLElement>('[data-size]')!;
const dimmed = (s: HTMLElement) => /gated/.test(knobOf(s).className) && getComputedStyle(knobOf(s)).transitionProperty.includes('opacity');
const section = (title: string) => document.querySelector<HTMLElement>(`#shape-col-instrument section[aria-label="${title}"]`)!;

describe('instrument: dimmed until their gate opens', () => {
  it('Chords: Unison Detune (Unison 1), Vibrato Speed (Vibrato 0): dimmed with the reason; raising the gate un-dims; section headers say Off', async () => {
    await openShape({ mode: 'advanced', trackId: 't4', tips: true });
    await clickEl(tab('Instrument'));
    const detune = slider(section('Unison'), 'Unison Detune');
    expect(dimmed(detune)).toBe(true);
    expect(described(detune)).toContain('Does nothing until Unison is above 1.');
    expect(section('Unison').querySelector('h3')!.textContent).toContain('Off: raise Unison above 1');
    await keysOn(slider(section('Unison'), 'Unison'), '{ArrowUp}');
    await settleFrames();
    expect(dimmed(slider(section('Unison'), 'Unison Detune'))).toBe(false);
    expect(section('Unison').querySelector('h3')!.textContent).not.toContain('Off');

    const speed = slider(section('Vibrato'), 'Vibrato Speed');
    expect(dimmed(speed)).toBe(true);
    expect(section('Vibrato').querySelector('h3')!.textContent).toContain('Off: turn up Vibrato');
    await keysOn(slider(section('Vibrato'), 'Vibrato'), '{PageUp}');
    expect(dimmed(slider(section('Vibrato'), 'Vibrato Speed'))).toBe(false);
    // A dimmed knob still turns (it is not disabled).
    expect(detune.getAttribute('aria-disabled')).toBeNull();
  });

  it('FM: Ratio and Decay are dimmed while FM Amount is 0, with the group’s reason', async () => {
    await openShape({ mode: 'advanced', trackId: 't4', tips: true });
    await clickEl(tab('Instrument'));
    const ratio = slider(section('FM'), 'FM Ratio');
    expect(dimmed(ratio)).toBe(true);
    expect(described(ratio)).toContain('Does nothing while FM Amount is at 0.');
    expect(dimmed(slider(section('FM'), 'FM Amount'))).toBe(false);
  });
});

describe('effects: Drive at 0 and EQ bands at 0 dB', () => {
  it('the Drive card’s Character, Fizz and Mix are dimmed while Drive is 0 (the big knob), and light up once it turns', async () => {
    await openShape({ mode: 'advanced', trackId: 't4', tips: true });
    await clickEl(tab('Effects'));
    const card = document.getElementById('rack-card-t4:drive')!;
    const fizz = slider(card, 'Fizz');
    expect(dimmed(fizz)).toBe(true);
    expect(described(fizz)).toContain('Does nothing while Drive is at 0.');
    await clickEl(tab('Macros'));
    await keysOn(document.getElementById('shape-macro-drive')!, '{PageUp}');
    await clickEl(tab('Effects'));
    expect(dimmed(slider(document.getElementById('rack-card-t4:drive')!, 'Fizz'))).toBe(false);
  });

  it('an added EQ: each band at 0 dB says “Set this band’s gain first”, and its Pitch is dimmed; moving the gain clears both', async () => {
    await openShape({ mode: 'advanced', trackId: 't4', tips: true });
    act(() => void session.accepted(cmd.insertEffect(session.store, 't4', 'eq')));
    await clickEl(tab('Effects'));
    const eq = () => document.getElementById('rack-card-t4:eq')!;
    const hints = () => [...eq().querySelectorAll('p')].filter((p) => p.textContent?.startsWith('Set this band’s gain first'));
    expect(hints()).toHaveLength(3);
    expect(dimmed(slider(eq(), 'Lows Pitch'))).toBe(true);
    await keysOn(slider(eq(), 'Lows'), '{ArrowUp}');
    await settleFrames();
    expect(hints()).toHaveLength(2);
    expect(dimmed(slider(eq(), 'Lows Pitch'))).toBe(false);
  });
});
