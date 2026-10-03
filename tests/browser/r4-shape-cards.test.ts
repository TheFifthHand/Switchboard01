/**
 * shape-01 (P1): every Simple effect card's knob is audibly live.
 *
 * On all eight parts of the House starter (the Jump In song), each Simple
 * effect card's knob is set to its minimum and its maximum with real keys
 * (Home / End on the focused knob), and the part, soloed, is rendered
 * offline both ways: the two renders differ by at least 1 dB RMS or 10 % of
 * spectral centroid. The one exception is Drive, which the engine keeps
 * level-matched and whose Fizz low-pass keeps the brightness where it was:
 * its distortion is measured as the difference between the two renders
 * (null test), at least −20 dB relative to the part (a distortion product
 * a twentieth of the level is plainly heard). The Drive card carries the
 * Drive big knob, the Filter
 * card the Tone or Motion big knob (the big knob that sets its cutoff); the
 * Filter card offers Resonance only while the cutoff is below 12 kHz.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '../../src/project/types';
import { card, closeShape, heard, keysOn, nullDb, openShape, project, renderSolo, slider, track } from './r4-shape-helpers';
import { act } from 'react';
import { selectTrack } from '../../src/state/uiStore';
import { settleFrames } from './r4-uikit-input';

beforeEach(async () => {
  await openShape({ w: 1366, hh: 768, mode: 'simple' });
});
afterEach(closeShape);

const PARTS = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'] as const;

/** Every knob on a part's Simple effect cards, with the card it is on. */
function cardKnobs(): { cardId: string; knob: HTMLElement; name: string }[] {
  const out: { cardId: string; knob: HTMLElement; name: string }[] = [];
  for (const c of document.querySelectorAll<HTMLElement>('article[id^="simple-card-"]')) {
    for (const k of c.querySelectorAll<HTMLElement>('[role="slider"]')) out.push({ cardId: c.id.replace('simple-card-', ''), knob: k, name: k.getAttribute('aria-label') ?? '' });
  }
  return out;
}

describe('Simple effect cards: every knob changes the sound (offline renders, part soloed)', () => {
  for (const id of PARTS) {
    it(`part ${id}: each card knob, min vs max, moves the part by ≥ 1 dB or ≥ 10 % centroid`, async () => {
      act(() => selectTrack(id));
      await settleFrames(2);
      const name = track(id).name;
      const knobs = cardKnobs();
      // The Drive card shows the Drive big knob; the Filter card the big knob that sets its cutoff.
      expect(knobs.find((k) => k.cardId === `${id}:drive`)?.name, name).toBe('Drive');
      expect(['Tone', 'Motion'], name).toContain(knobs.find((k) => k.cardId === `${id}:filter`)?.name);
      const lines: string[] = [];
      for (const k of cardKnobs()) {
        const knob = document.getElementById(k.knob.id) ?? k.knob;
        await keysOn(knob, '{Home}');
        const lo: Project = structuredClone(project());
        await keysOn(knob, '{End}');
        const hi: Project = structuredClone(project());
        expect(JSON.stringify(hi), `${name} ${k.name} moved nothing in the project`).not.toBe(JSON.stringify(lo));
        // Motion sweeps with the part's LFO, as slow as one cycle in 4 bars: render a whole cycle.
        const bars = k.name === 'Motion' ? 4 : 2;
        const a = await renderSolo(lo, id, bars);
        const b = await renderSolo(hi, id, bars);
        const h = heard(a, b);
        const diff = nullDb(a, b);
        const line = `${name} ${k.cardId} “${k.name}”: ${h.text}, difference ${diff.toFixed(1)} dB`;
        lines.push(line);
        const drive = k.cardId.endsWith(':drive');
        expect(h.db >= 1 || h.centroid >= 0.1 || (drive && diff >= -20), line).toBe(true);
        // Back where it was, for the next knob (and so a filter's Resonance is judged at the part's own cutoff).
        await keysOn(knob, '{Delete}');
      }
      console.info(`[shape-cards] ${lines.join(' | ')}`);
    }, 240_000);
  }
});

describe('the Filter card offers Resonance only while the filter is closed below 12 kHz', () => {
  it('Chords: wide open (Motion 0) it has no Resonance and says when it comes; Motion up brings it, and it rings', async () => {
    const filter = () => card('t4:filter');
    expect([...filter().querySelectorAll('[role="slider"]')].map((x) => x.getAttribute('aria-label'))).toEqual(['Motion']);
    expect(filter().textContent).toContain('Resonance appears once the filter closes below 12 kHz.');
    // Motion 30 % (real keys on the card's own knob) puts the cutoff at about 4.5 kHz.
    const motion = slider(filter(), 'Motion');
    await keysOn(motion, '{Home}');
    for (let i = 0; i < 3; i++) await keysOn(motion, '{PageUp}');
    expect(track('t4').macros.motion).toBeCloseTo(0.3, 5);
    const res = slider(filter(), 'Resonance');
    expect(res.hasAttribute('aria-readonly')).toBe(false);
    await keysOn(res, '{Home}');
    const lo = structuredClone(project());
    await keysOn(res, '{End}');
    const hi = structuredClone(project());
    const h = heard(await renderSolo(lo, 't4'), await renderSolo(hi, 't4'));
    console.info(`[shape-cards] Chords resonance at Motion 30 %: ${h.text}`);
    expect(h.centroid >= 0.1 || h.db >= 1, h.text).toBe(true);
    // Back to Motion 0: the cutoff opens to 20 kHz and Resonance goes away again.
    await keysOn(slider(filter(), 'Motion'), '{Home}');
    expect([...filter().querySelectorAll('[role="slider"]')].map((x) => x.getAttribute('aria-label'))).toEqual(['Motion']);
  }, 120_000);

  it('Pad and Texture (Motion up by design) offer Resonance from the start', () => {
    for (const id of ['t6', 't7']) {
      act(() => selectTrack(id));
      expect([...card(`${id}:filter`).querySelectorAll('[role="slider"]')].map((x) => x.getAttribute('aria-label')), id).toEqual(['Motion', 'Resonance']);
    }
  });
});
