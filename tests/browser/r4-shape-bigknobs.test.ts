/**
 * shape-02 (P1): big knobs stay honest.
 *
 * - A big knob whose settings are gone or not heard (macroReach) reads
 *   "Moves nothing here" and is unavailable.
 * - Removing an effect a big knob uses names it in the toast ("The Motion big
 *   knob now moves nothing."), with Undo.
 * - Adding the effect back reconnects the big knob (Motion moves the cutoff
 *   again: offline renders differ), and Reset big knobs gives every big knob
 *   back what the sound designs it to move, the LFO's cable included.
 * Real clicks and keys throughout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { moduleId } from '../../src/project/factory';
import * as cmd from '../../src/state/commands';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { selectTrack, setView } from '../../src/state/uiStore';
import { openApp, setUp, tearDown } from './r4-play-helpers';
import { button, card, clickEl, closeShape, heard, keysOn, notice, nullDb, openShape, project, renderSolo, track } from './r4-shape-helpers';
import { settleFrames } from './r4-uikit-input';

const tile = (macro: string) => document.querySelector<HTMLElement>(`[data-macro="${macro}"]`)!;
const tileKnob = (macro: string) => document.getElementById(`shape-macro-${macro}`)!;
const lfoCables = (t = 't4') => project().patch.connections.filter((c) => c.from.module === moduleId.lfo(t));

/** The app's toast that shows `text`, if it is on screen. */
const toastWith = (text: string) => [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((x) => x.textContent?.includes(text)) ?? null;

describe('in the whole app: the remove toast names the big knob, with Undo', () => {
  beforeEach(setUp);
  afterEach(tearDown);

  it('Chords: remove Filter → “The Motion big knob now moves nothing.” and Undo; Undo puts the Filter and Motion back', async () => {
    await openApp(1366, 768);
    act(() => {
      selectTrack('t4');
      setView('shape');
    });
    await settleFrames(3);
    await clickEl(button('Remove Filter', card('t4:filter')));
    const toast = toastWith('Removed Filter. The Motion big knob now moves nothing.');
    expect(toast, 'toast on screen').not.toBeNull();
    expect(runtimeStore.getState().notice?.action).toBe('undo');
    expect(document.getElementById('shape-macro-motion')!.getAttribute('aria-disabled')).toBe('true');
    await clickEl(button('Undo', toast!));
    expect(project().patch.modules.some((m) => m.id === 't4:filter')).toBe(true);
    expect(document.getElementById('shape-macro-motion')!.getAttribute('aria-disabled')).toBeNull();
  }, 60_000);
});

describe('removing the Filter on Chords', () => {
  beforeEach(async () => {
    await openShape({ w: 1366, hh: 768, mode: 'simple', trackId: 't4' });
  });
  afterEach(closeShape);

  it('Motion is disabled and says “Moves nothing here”; the toast names it; adding Filter back makes Motion move the cutoff again', async () => {
    expect(tileKnob('motion').getAttribute('aria-disabled')).toBeNull();
    await clickEl(button('Remove Filter', card('t4:filter')));
    expect(project().patch.modules.some((m) => m.id === 't4:filter')).toBe(false);
    expect(lfoCables()).toHaveLength(0);
    expect(notice()).toBe('Removed Filter. The Motion big knob now moves nothing.');
    expect(runtimeStore.getState().notice?.action).toBe('undo');
    expect(tileKnob('motion').getAttribute('aria-disabled')).toBe('true');
    expect(tile('motion').textContent).toContain('Moves nothing here');
    // Tone still moves the synth's own cutoff: it stays live.
    expect(tileKnob('tone').getAttribute('aria-disabled')).toBeNull();

    // Add effect → Filter: it takes back the part's Filter slot, so Motion (and Tone's brightness) move it again.
    await clickEl(document.getElementById('shape-add-effect'));
    await clickEl(document.querySelector('[role="menu"] [data-effect="filter"]'));
    expect(notice()).toMatch(/^Added Filter\..*The Motion big knob moves it again\.$/);
    expect(lfoCables().map((c) => `${c.to.module}.${c.to.port}`)).toEqual(['t4:filter.cutoff']);
    expect(track('t4').macroMap.motion.map((x) => `${x.module}.${x.param}`)).toContain('t4:filter.cutoff');
    expect(tileKnob('motion').getAttribute('aria-disabled')).toBeNull();
    expect(tile('motion').textContent).toContain('Moves in time');

    // Motion 0 vs 100 % (real keys on the tile) now changes what is heard.
    await keysOn(tileKnob('motion'), '{Home}');
    const lo = structuredClone(project());
    await keysOn(tileKnob('motion'), '{End}');
    const hi = structuredClone(project());
    const a = await renderSolo(lo, 't4', 4);
    const b = await renderSolo(hi, 't4', 4);
    const h = heard(a, b);
    console.info(`[bigknobs] Motion after re-adding Filter: ${h.text}, difference ${nullDb(a, b).toFixed(1)} dB`);
    expect(h.db >= 1 || h.centroid >= 0.1, h.text).toBe(true);
  }, 120_000);

  it('Undo in the toast brings the Filter and Motion back at once', async () => {
    await clickEl(button('Remove Filter', card('t4:filter')));
    expect(tileKnob('motion').getAttribute('aria-disabled')).toBe('true');
    act(() => session.undo());
    await settleFrames();
    expect(lfoCables()).toHaveLength(1);
    expect(tileKnob('motion').getAttribute('aria-disabled')).toBeNull();
  });

  it('removing the Drive names the Drive big knob', async () => {
    await clickEl(button('Remove Drive', card('t4:drive')));
    expect(notice()).toBe('Removed Drive. The Drive big knob now moves nothing.');
    expect(tileKnob('drive').getAttribute('aria-disabled')).toBe('true');
  });

  it('Drums: an LFO that lost its only cable leaves Motion (which moves only that LFO) with nothing to move', async () => {
    act(() => selectTrack('t1'));
    await settleFrames();
    expect(tileKnob('motion').getAttribute('aria-disabled')).toBeNull();
    // Unplug the LFO's only cable (as the cable panel would).
    act(() => void session.accepted(cmd.disconnect(session.store, lfoCables('t1')[0].id)));
    await settleFrames();
    expect(tileKnob('motion').getAttribute('aria-disabled')).toBe('true');
    expect(tile('motion').textContent).toContain('Moves nothing here');
  });
});

describe('Reset big knobs (Simple)', () => {
  beforeEach(async () => {
    await openShape({ w: 1366, hh: 768, mode: 'simple', trackId: 't4' });
  });
  afterEach(closeShape);

  it('Drums: gives back the design’s mappings and the LFO cable in one undo step; positions stay', async () => {
    act(() => selectTrack('t1'));
    await settleFrames();
    // Break things the ways a user can: unmap Tone's cutoff, unplug the LFO, then move Space.
    act(() => {
      session.accepted(cmd.removeMacroTarget(session.store, 't1', 'tone', 0));
      session.accepted(cmd.disconnect(session.store, lfoCables('t1')[0].id));
    });
    await keysOn(document.getElementById('shape-macro-space')!, '{End}');
    await settleFrames();
    expect(tileKnob('motion').getAttribute('aria-disabled')).toBe('true');
    const space = track('t1').macros.space;
    const before = project();

    await clickEl(document.getElementById('simple-reset-big-knobs'));
    expect(notice()).toBe('Drums’ big knobs move what its sound is designed to move again.');
    expect(runtimeStore.getState().notice?.action).toBe('undo');
    expect(track('t1').macroMap).toEqual(cmd.soundMacroMap(track('t1')));
    expect(lfoCables('t1').map((c) => `${c.to.module}.${c.to.port}`)).toEqual(['t1:filter.cutoff']);
    expect(tileKnob('motion').getAttribute('aria-disabled')).toBeNull();
    expect(track('t1').macros.space).toBe(space);

    // One undo step brings the broken state back (mappings and cable together).
    act(() => session.undo());
    expect(project().patch.connections).toEqual(before.patch.connections);
    expect(track('t1').macroMap).toEqual(before.tracks.find((t) => t.id === 't1')!.macroMap);

    // Pressed again on a sound that already matches its design: it says so, with no Undo.
    act(() => session.redo());
    await clickEl(document.getElementById('simple-reset-big-knobs'));
    expect(notice()).toBe('Drums’ big knobs already move what its sound is designed to move.');
    expect(runtimeStore.getState().notice?.action).toBeUndefined();
  });

  it('with the Filter gone, Motion still moves nothing after a reset, and the toast says what to do', async () => {
    await clickEl(button('Remove Filter', card('t4:filter')));
    await clickEl(document.getElementById('simple-reset-big-knobs'));
    expect(notice()).toMatch(/Motion still moves nothing: the effect it moves is not in this part \(Add effect puts one back\)\.$/);
    expect(tileKnob('motion').getAttribute('aria-disabled')).toBe('true');
  });

  it('Advanced “Reset mappings” does the same (the Macros column)', async () => {
    act(() => void session.accepted(cmd.disconnect(session.store, lfoCables()[0].id)));
    await clickEl(document.getElementById('shape-mode-toggle'));
    await clickEl(button('Reset mappings'));
    expect(lfoCables()).toHaveLength(1);
    expect(notice()).toBe('Chords’ big knobs move what its sound is designed to move again.');
  });
});
