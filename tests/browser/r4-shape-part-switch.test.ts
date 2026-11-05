/**
 * shape-18 follow-ups: what happens around a part switch now that the Shape
 * columns are not remounted per part.
 *
 * - A knob drag that spans a part switch (a shortcut, or a recording import
 *   that selects its part when it finishes) ends at the switch: the rest of
 *   the drag never writes to the part switched to.
 * - While the Advanced columns catch up with a switch (a busy machine), a
 *   click on them goes nowhere and, after a moment, a note says which part is
 *   on its way; then the new part's controls work as usual.
 * Real mouse input through the DevTools protocol.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { selectTrack } from '../../src/state/uiStore';
import { clickEl, closeShape, openShape, slider, track } from './r4-shape-helpers';
import { centre, mouse, send, settleFrames } from './r4-uikit-input';

afterEach(closeShape);

const tab = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.includes(name)) ?? null;
const frame = () => new Promise((r) => requestAnimationFrame(r));

/** Press on `el`, move up `before` px, switch to `to` (as a shortcut would), move up `after` px more, release. */
async function dragAcrossSwitch(el: HTMLElement, to: string, before = 30, after = 40): Promise<void> {
  const a = centre(el);
  await mouse('mouseMoved', a);
  await mouse('mousePressed', a);
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', { x: a.x, y: a.y - (before * i) / 6 }, { buttons: 1 });
    await frame();
  }
  act(() => selectTrack(to));
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', { x: a.x, y: a.y - before - (after * i) / 6 }, { buttons: 1 });
    await frame();
  }
  await mouse('mouseReleased', { x: a.x, y: a.y - before - after });
  await settleFrames(3);
}

describe('a knob drag that spans a part switch', () => {
  it('Advanced: dragging Chords Detune, then Lead is selected: the rest of the drag does not reach Lead', async () => {
    await openShape({ mode: 'advanced', w: 1366, hh: 768, trackId: 't4' });
    await clickEl(tab('Instrument'));
    const detune = slider(document.getElementById('shape-col-instrument')!, 'Detune');
    detune.scrollIntoView({ block: 'center' });
    await settleFrames();
    const chords = track('t4').instrument.params.detune;
    const lead = track('t5').instrument.params.detune;
    await dragAcrossSwitch(detune, 't5');
    expect(track('t4').instrument.params.detune, 'the part the drag began on moved').not.toBe(chords);
    expect(track('t5').instrument.params.detune, 'the part switched to').toBe(lead);
  });

  it('Simple: dragging the Space big knob of Chords, then Lead is selected: Lead’s Space stays', async () => {
    await openShape({ mode: 'simple', w: 1366, hh: 768, trackId: 't4' });
    const lead = track('t5').macros.space;
    const chords = track('t4').macros.space;
    await dragAcrossSwitch(document.getElementById('shape-macro-space')!, 't5');
    expect(track('t4').macros.space).not.toBe(chords);
    expect(track('t5').macros.space).toBe(lead);
  });
});

describe('while the Advanced columns catch up with a switch', () => {
  it('a click there goes nowhere, a note says which part is coming, then the new part’s knobs work', async () => {
    await openShape({ mode: 'advanced', w: 1920, hh: 1080, trackId: 't4' });
    const cols = document.querySelector<HTMLElement>('[data-col]')!.parentElement!;
    // A very slow machine: the deferred column render takes a while.
    await send('Emulation.setCPUThrottlingRate', { rate: 30 });
    try {
      // A real click, without waiting for React (the helpers' click settles inside act, which would finish the render).
      const part = centre(document.getElementById('shape-part-t5')!);
      await mouse('mouseMoved', part);
      await mouse('mousePressed', part);
      await mouse('mouseReleased', part);
      const busy = cols.getAttribute('aria-busy') === 'true';
      console.info(`[part-switch] columns still catching up after the click: ${busy}`);
      expect(busy, 'at 30× slower, the columns are still catching up right after the click').toBe(true);
      // A press on a column control meanwhile changes nothing (the knob still shows Chords).
      const before = { t4: track('t4').instrument.params.detune, t5: track('t5').instrument.params.detune };
      const detune = slider(document.getElementById('shape-col-instrument')!, 'Detune');
      const a = centre(detune);
      await mouse('mousePressed', a);
      await mouse('mouseMoved', { x: a.x, y: a.y - 40 }, { buttons: 1 });
      await mouse('mouseReleased', { x: a.x, y: a.y - 40 });
      expect(track('t4').instrument.params.detune).toBe(before.t4);
      expect(track('t5').instrument.params.detune).toBe(before.t5);
      await new Promise((r) => setTimeout(r, 200));
      const note = cols.querySelector<HTMLElement>('[class*="busy"]');
      console.info(`[part-switch] still catching up 200 ms later: ${cols.getAttribute('aria-busy') === 'true'}, note: ${note?.textContent ?? 'none'}`);
      if (cols.getAttribute('aria-busy') === 'true') {
        expect(note?.textContent).toBe('Showing Lead…');
        expect(Number(getComputedStyle(note!).opacity)).toBeGreaterThan(0.9);
      }
    } finally {
      await send('Emulation.setCPUThrottlingRate', { rate: 1 });
    }
    await settleFrames(4);
    expect(cols.getAttribute('aria-busy')).toBeNull();
    expect(cols.querySelector('[class*="busy"]')).toBeNull();
    // Caught up: the knobs are Lead's.
    const detune = slider(document.getElementById('shape-col-instrument')!, 'Detune');
    expect(Number(detune.getAttribute('aria-valuenow'))).toBe(track('t5').instrument.params.detune);
  }, 120_000);
});
