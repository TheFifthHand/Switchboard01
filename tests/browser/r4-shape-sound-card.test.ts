/**
 * shape-09 / shape-13 / design-02: Simple Shape's Sound card.
 *
 * - Synths: Soft start (Attack), Length (Release), Octave and Character on
 *   the bass; Character and Thickness (Unison) on the poly synth. Each turns
 *   its own instrument setting through the same commands as Advanced (one
 *   undo step per gesture), and is heard (offline render).
 * - Drums: a drum mix: Kick, Snare and Hats levels and Kick tune, on the
 *   kit's own voices (Hats moves the closed and open hats together, keeping
 *   their balance).
 * - Samplers: Start (keeps the length), Length, Pitch and a small waveform.
 * - Edit sound opens the instrument in Advanced for this part (its tab on a
 *   short window), keyboard focus inside it.
 * - 1920 × 1080: the big knobs are 'xl', 3 × 2, and the effect cards share
 *   the row (grid minmax(260px, 1fr)).
 * Real keys and clicks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { session } from '../../src/app/instance';
import * as cmd from '../../src/state/commands';
import { selectTrack, uiStore } from '../../src/state/uiStore';
import { clickEl, closeShape, heard, keysOn, openShape, project, renderSolo, slider, track } from './r4-shape-helpers';
import { settleFrames } from './r4-uikit-input';
import type { Instrument } from '../../src/project/types';

afterEach(closeShape);

const sound = () => document.querySelector<HTMLElement>('section[data-kind]')!;
const voices = (id = 't1') => (track(id).instrument as Extract<Instrument, { kind: 'drums' }>).voices;
const params = (id: string) => track(id).instrument.params;
const knobNames = () => [...sound().querySelectorAll('[role="slider"]')].map((x) => x.getAttribute('aria-label'));

describe('synths', () => {
  it('Chords (poly): Soft start, Length, Character, Thickness turn the instrument’s own settings; one undo step each', async () => {
    await openShape({ mode: 'simple', trackId: 't4' });
    expect(sound().querySelector('h3')?.textContent).toBe('Sound');
    expect(knobNames()).toEqual(['Soft start', 'Length', 'Character', 'Thickness']);
    await keysOn(slider(sound(), 'Soft start'), '{End}');
    expect(params('t4').attack).toBe(4);
    await keysOn(slider(sound(), 'Length'), '{Home}');
    expect(params('t4').release).toBe(0.01);
    await keysOn(slider(sound(), 'Character'), '{End}');
    expect(params('t4').osc1Wave).toBe(3);
    await keysOn(slider(sound(), 'Thickness'), '{ArrowUp}{ArrowUp}');
    expect(params('t4').unison).toBe(3);
    await new Promise((r) => setTimeout(r, 900));
    act(() => session.undo());
    expect(params('t4').unison).toBe(1);
    expect(params('t4').osc1Wave).toBe(3);
  });

  it('Chords: Soft start is heard (offline render, part soloed)', async () => {
    await openShape({ mode: 'simple', trackId: 't4' });
    await keysOn(slider(sound(), 'Soft start'), '{Home}');
    const lo = structuredClone(project());
    await keysOn(slider(sound(), 'Soft start'), '{End}');
    const hi = structuredClone(project());
    const h = heard(await renderSolo(lo, 't4'), await renderSolo(hi, 't4'));
    expect(h.db >= 1 || h.centroid >= 0.1, h.text).toBe(true);
  }, 180_000);

  it('Bass: Soft start, Length, Octave, Character; Octave moves the bass down an octave', async () => {
    await openShape({ mode: 'simple', trackId: 't3' });
    expect(knobNames()).toEqual(['Soft start', 'Length', 'Octave', 'Character']);
    await keysOn(slider(sound(), 'Octave'), '{ArrowDown}');
    expect(params('t3').octave).toBe(-1);
  });
});

describe('drums: the drum mix', () => {
  it('Kick, Snare, Hats and Kick tune move the kit’s voices; Hats keeps the closed / open balance', async () => {
    await openShape({ mode: 'simple', trackId: 't1' });
    expect(sound().querySelector('h3')?.textContent).toBe('Drum mix');
    expect(knobNames()).toEqual(['Kick', 'Snare', 'Hats', 'Kick tune']);
    // Make the open hat quieter than the closed one first (as Advanced could), so Hats must keep the ratio.
    act(() => void session.accepted(cmd.setDrumVoice(session.store, 't1', 5, { level: 0.5 })));
    await keysOn(slider(sound(), 'Hats'), '{PageDown}{PageDown}');
    const v = voices();
    expect(v[4].level).toBeLessThan(1);
    expect(v[5].level / v[4].level).toBeCloseTo(0.5, 2);
    await new Promise((r) => setTimeout(r, 900));
    // One gesture, one undo step (both hats back).
    act(() => session.undo());
    expect(voices()[4].level).toBe(1);
    expect(voices()[5].level).toBe(0.5);
    await keysOn(slider(sound(), 'Kick'), '{End}');
    expect(voices()[0].level).toBe(1.5);
    await keysOn(slider(sound(), 'Kick tune'), '{ArrowUp}');
    expect(voices()[0].tune).toBeGreaterThan(0);
    await keysOn(slider(sound(), 'Snare'), '{Home}');
    expect(voices()[2].level).toBe(0);
  });

  it('Kick level is heard (offline render, Drums soloed)', async () => {
    await openShape({ mode: 'simple', trackId: 't1' });
    await keysOn(slider(sound(), 'Kick'), '{Home}');
    const lo = structuredClone(project());
    await keysOn(slider(sound(), 'Kick'), '{End}');
    const hi = structuredClone(project());
    const h = heard(await renderSolo(lo, 't1'), await renderSolo(hi, 't1'));
    expect(h.db >= 1 || h.centroid >= 0.1, h.text).toBe(true);
  }, 180_000);

  it('drum voices are locked while a performance records, and the knobs say why', async () => {
    await openShape({ mode: 'simple', trackId: 't1' });
    act(() => session.store.setLock('Recording a performance.'));
    await settleFrames();
    expect(slider(sound(), 'Kick').getAttribute('aria-disabled')).toBe('true');
  });
});

describe('samplers', () => {
  it('Vocal: Start keeps the length, Length sets the end, Pitch transposes; a waveform shows what plays', async () => {
    await openShape({ mode: 'simple', trackId: 't8' });
    expect(knobNames()).toEqual(['Start', 'Length', 'Pitch']);
    expect(sound().querySelector('figure canvas')).not.toBeNull();
    await keysOn(slider(sound(), 'Length'), '{Home}{PageUp}{PageUp}{PageUp}');
    const len = params('t8').end - (params('t8').start ?? 0);
    expect(len).toBeGreaterThan(0.25);
    expect(len).toBeLessThan(0.35);
    await keysOn(slider(sound(), 'Start'), '{PageUp}{PageUp}');
    expect(params('t8').start).toBeCloseTo(0.2, 5);
    expect(params('t8').end - params('t8').start).toBeCloseTo(len, 5);
    await keysOn(slider(sound(), 'Pitch'), '{ArrowUp}{ArrowUp}');
    expect(params('t8').pitch).toBe(2);
  });
});

describe('Edit sound', () => {
  it('opens the instrument in Advanced for this part: on a short window its tab, focus inside it', async () => {
    await openShape({ mode: 'simple', trackId: 't3', w: 1366, hh: 768 });
    await clickEl(document.getElementById('simple-edit-sound'));
    await settleFrames(4);
    expect(uiStore.getState().uiMode).toBe('advanced');
    const col = document.getElementById('shape-col-instrument');
    expect(col).not.toBeNull();
    expect(col!.contains(document.activeElement)).toBe(true);
    expect(document.getElementById('shape-col-macros')).toBeNull();
    act(() => selectTrack('t3'));
  });

  it('on a tall window all three columns show, the instrument one focused', async () => {
    await openShape({ mode: 'simple', trackId: 't4', w: 1920, hh: 1080 });
    await clickEl(document.getElementById('simple-edit-sound'));
    await settleFrames(4);
    expect(document.getElementById('shape-col-macros')).not.toBeNull();
    expect(document.getElementById('shape-col-instrument')!.contains(document.activeElement)).toBe(true);
  });
});

describe('a big screen fills (design-02)', () => {
  it('1920 × 1080: xl big knobs in 3 × 2 that fill the panel; effect cards at least 260 px share the row', async () => {
    await openShape({ mode: 'simple', trackId: 't4', w: 1920, hh: 1080 });
    const grid = document.querySelector<HTMLElement>('[data-xl]');
    expect(grid, 'xl grid').not.toBeNull();
    const knobs = [...grid!.querySelectorAll<HTMLElement>('[data-size="xl"]')];
    expect(knobs).toHaveLength(6);
    const tops = new Set(knobs.map((k) => Math.round(k.getBoundingClientRect().top)));
    expect(tops.size).toBe(2);
    const panel = grid!.closest('section')!.getBoundingClientRect();
    const tiles = [...grid!.children].map((c) => c.getBoundingClientRect());
    expect(tiles[5].bottom).toBeGreaterThan(panel.bottom - 30);
    const cards = [...document.querySelectorAll<HTMLElement>('[role="listitem"]')].map((c) => c.getBoundingClientRect());
    expect(cards.length).toBeGreaterThanOrEqual(2);
    for (const c of cards) expect(c.width).toBeGreaterThanOrEqual(259);
    expect(Math.round(cards[0].top)).toBe(Math.round(cards[1].top));
    // The Sound card uses medium knobs on a tall window.
    expect(sound().querySelector('[data-size="md"]')).not.toBeNull();
  });

  it('1366 × 768: the left column (instrument, sound, big knobs) fits without scrolling', async () => {
    await openShape({ mode: 'simple', trackId: 't4', w: 1366, hh: 768 });
    const left = sound().closest('[class*="left"]') as HTMLElement;
    expect(left.scrollHeight).toBeLessThanOrEqual(left.clientHeight + 1);
  });
});
