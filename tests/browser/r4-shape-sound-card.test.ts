/**
 * shape-09 / shape-13 / design-02: Simple Shape's Sound card.
 *
 * - Synths: Soft start (Attack), Length (Release), Octave and Character on
 *   the bass; Character and Thickness (Unison) on the poly synth. Each turns
 *   its own instrument setting through the same commands as Advanced (one
 *   undo step per gesture), and is heard (offline render).
 * - Drums: a drum mix of the voices the part plays: up to three level knobs
 *   by role (House: Kick, Snare & clap, Hats) and the first one's tune, on
 *   the kit's own voices (a group keeps its voices' balance, also through 0).
 *   Rendered for every starter: each knob changes that starter's drums.
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
import { clickEl, closeShape, heard, keysOn, levelDb, nullDb, openShape, project, renderSolo, rowFor, slider, track } from './r4-shape-helpers';
import { STARTERS } from '../../src/content/starters';
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
  it('Kick, Snare & clap, Hats and Kick tune move the kit’s voices; Hats keeps the closed / open balance, also through 0', async () => {
    await openShape({ mode: 'simple', trackId: 't1' });
    expect(sound().querySelector('h3')?.textContent).toBe('Drum mix');
    expect(knobNames()).toEqual(['Kick', 'Snare & clap', 'Hats', 'Kick tune']);
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
    // Through 0 and back up: the open hat is still half the closed one.
    await keysOn(slider(sound(), 'Hats'), '{Home}');
    expect([voices()[4].level, voices()[5].level]).toEqual([0, 0]);
    await keysOn(slider(sound(), 'Hats'), '{PageUp}{PageUp}{PageUp}{PageUp}{PageUp}');
    expect(voices()[4].level).toBeGreaterThan(0.2);
    expect(voices()[5].level / voices()[4].level).toBeCloseTo(0.5, 2);
    await keysOn(slider(sound(), 'Kick'), '{End}');
    expect(voices()[0].level).toBe(1.5);
    await keysOn(slider(sound(), 'Kick tune'), '{ArrowUp}');
    expect(voices()[0].tune).toBeGreaterThan(0);
    // Snare & clap: both, keeping their balance.
    await keysOn(slider(sound(), 'Snare & clap'), '{Home}');
    expect([voices()[2].level, voices()[3].level]).toEqual([0, 0]);
  });

  it('drum voices are locked while a performance records, and the knobs say why', async () => {
    await openShape({ mode: 'simple', trackId: 't1' });
    act(() => session.store.setLock('Recording a performance.'));
    await settleFrames();
    expect(slider(sound(), 'Kick').getAttribute('aria-disabled')).toBe('true');
  });
});

describe('every starter: each Drum mix knob changes that starter’s drums (offline render, part soloed)', () => {
  for (const starter of STARTERS) {
    it(starter.name, async () => {
      const p0 = starter.build();
      for (const t of p0.tracks.filter((x) => x.instrument.kind === 'drums')) {
        await openShape({ mode: 'simple', trackId: t.id, project: structuredClone(p0) });
        const all = [...sound().querySelectorAll<HTMLElement>('[role="slider"]')];
        expect(all.length, `${starter.name} ${t.name}`).toBeGreaterThanOrEqual(2);
        // Each knob in turn: the tune knob all the way up first, then the level knobs all the way down (each one
        // compared with the state just before it). The scene row rendered is one whose clip plays a voice the knob moves.
        const knobs = [...all.filter((k) => k.getAttribute('aria-label')!.endsWith(' tune')), ...all.filter((k) => !k.getAttribute('aria-label')!.endsWith(' tune'))];
        const states = [structuredClone(project())];
        const rows: number[] = [];
        const kit = (t.instrument as Extract<Instrument, { kind: 'drums' }>).kitId;
        for (const k of knobs) {
          const before = voices(t.id).map((v) => ({ ...v }));
          await keysOn(k, k.getAttribute('aria-label')!.endsWith(' tune') ? '{End}' : '{Home}');
          const moved = voices(t.id).flatMap((v, s) => (v.level !== before[s].level || v.tune !== before[s].tune ? [s] : []));
          expect(moved.length, `${starter.name} ${t.name} ${k.getAttribute('aria-label')} moves a voice`).toBeGreaterThan(0);
          const clips = track(t.id).clips;
          const row = [rowFor(project(), t.id), ...clips.keys()].find((r) => clips[r]?.notes.some((n) => moved.includes(n.pitch)));
          expect(row, `${starter.name} ${t.name} ${k.getAttribute('aria-label')} is played somewhere (${kit})`).not.toBeUndefined();
          rows.push(row!);
          states.push(structuredClone(project()));
        }
        for (let i = 0; i < knobs.length; i++) {
          const a = await renderSolo(states[i], t.id, 2, rows[i]);
          const b = await renderSolo(states[i + 1], t.id, 2, rows[i]);
          const h = heard(a, b);
          const diff = nullDb(a, b);
          const label = `${starter.name} ${t.name} ${knobs[i].getAttribute('aria-label')} (row ${rows[i]}): ${h.text}, null ${diff.toFixed(1)} dB`;
          console.info(`[drum-mix] ${label}`);
          expect(levelDb(a), `${label}: heard before`).toBeGreaterThan(-80);
          expect(h.db >= 1 || h.centroid >= 0.1 || diff >= -20, label).toBe(true);
        }
        closeShape();
      }
    }, 300_000);
  }
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

  for (const [w, hh] of [
    [1366, 768],
    [1280, 720],
  ] as const) {
    it(`${w} × ${hh}: for every part (the sampler with its recording controls too) the left column fits without scrolling, every big knob’s caption in view`, async () => {
      await openShape({ mode: 'simple', trackId: 't1', w, hh });
      for (const id of ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']) {
        act(() => selectTrack(id));
        await settleFrames(4);
        const left = sound().closest('[class*="left"]') as HTMLElement;
        const box = left.getBoundingClientRect();
        const grid = document.querySelector<HTMLElement>('[data-macro]')!.parentElement!;
        const layout = grid.hasAttribute('data-row') ? 'one row' : 'two rows';
        expect(left.scrollHeight, `${w} ${id} (${layout}): the column scrolls`).toBeLessThanOrEqual(left.clientHeight + 1);
        for (const cap of grid.querySelectorAll<HTMLElement>('[data-macro] > div:last-child')) {
          const r = cap.getBoundingClientRect();
          expect(r.bottom, `${w} ${id} (${layout}): “${cap.textContent}” cut off`).toBeLessThanOrEqual(box.bottom + 0.5);
          expect(cap.scrollWidth, `${w} ${id}: “${cap.textContent}” cut short`).toBeLessThanOrEqual(cap.clientWidth + 1);
        }
      }
    });
  }
});
