/**
 * Shape view behaviour in real Chromium: the real session/store, real DOM
 * events, outcomes checked on the project.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { KNOB_BURST_IDLE_MS, TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { ShapeView } from '../../src/app/views/shape/ShapeView';
import { getKitVoiceNames } from '../../src/audio/instruments/kits';
import { createProject } from '../../src/project/factory';
import { trackChain } from '../../src/project/graph';
import { PATCH_LIMITS } from '../../src/project/modules';
import { FILTER_PARAMS, formatParam } from '../../src/project/params';
import { macroTargetValue } from '../../src/project/resolve';
import type { Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { drumVoiceFor, selectModule, selectTrack, setCablesOpen, uiStore } from '../../src/state/uiStore';
import { actFrame, cleanup, fire, key, mount, pointer, pointIn, wait } from './ui-harness';

const project = (): Project => session.store.getState();
const track = (id: string) => project().tracks.find((t) => t.id === id)!;
const moduleParams = (id: string) => project().patch.modules.find((m) => m.id === id)?.params ?? {};

function setup(trackId: string) {
  act(() => {
    session.store.replace(createProject({ name: 'Shape test', now: 1 }));
    selectTrack(trackId);
    setCablesOpen(false);
    selectModule(null);
  });
  const m = mount(h(TipsProvider, { enabled: false }, h(ShapeView)), { width: 1366 });
  m.container.style.height = '720px';
  return m;
}

/** A console section by its printed title (Panel h2). */
function panel(root: HTMLElement, title: string): HTMLElement {
  const heading = [...root.querySelectorAll('h2')].find((x) => x.textContent === title);
  if (!heading) throw new Error(`No panel "${title}"`);
  return heading.closest('section')!;
}

function slider(root: Element, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[role="slider"][aria-label="${name}"]`);
  if (!el) throw new Error(`No slider "${name}"`);
  return el;
}

function button(root: Element, name: string | RegExp): HTMLButtonElement {
  const all = [...root.querySelectorAll<HTMLButtonElement>('button')];
  const b = all.find((x) => {
    const label = x.getAttribute('aria-label') ?? x.textContent ?? '';
    return typeof name === 'string' ? label === name : name.test(label);
  });
  if (!b) throw new Error(`No button "${String(name)}"`);
  return b;
}

function switchNamed(root: Element, name: string): HTMLButtonElement {
  const s = [...root.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((x) => document.getElementById(x.getAttribute('aria-labelledby') ?? '')?.textContent === name);
  if (!s) throw new Error(`No switch "${name}"`);
  return s;
}

const click = (el: HTMLElement) => fire(el, new MouseEvent('click', { bubbles: true, cancelable: true }));

/** Let a keyboard burst on a knob end (its final onChange fires after an idle pause). */
const endBurst = () => act(async () => wait(KNOB_BURST_IDLE_MS + 120));

beforeEach(async () => {
  // The laptop size the layout is designed for (narrower windows reflow, see the last test).
  await page.viewport(1366, 768);
  window.scrollTo(0, 0);
  runtimeStore.setState((s) => ({ ...s, notice: null }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Shape view', () => {
  it('selects parts from the strip and shows that part', () => {
    const m = setup('t3');
    const parts = [...m.container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Part to shape"] [role="radio"]')];
    expect(parts).toHaveLength(8);
    expect(parts[2].getAttribute('aria-checked')).toBe('true');
    click(parts[0]);
    expect(uiStore.getState().selectedTrackId).toBe('t1');
    expect(panel(m.container, 'Instrument').textContent).toContain('Drum kit');
    // Arrow keys move the selection (radio group).
    key(m.container.querySelector('#shape-part-t1')!, 'keydown', { key: 'ArrowRight' });
    expect(uiStore.getState().selectedTrackId).toBe('t2');
  });

  it('keeps everything inside its panels: nothing in the scrolling columns stretches the page', async () => {
    const m = setup('t3');
    // A short workspace lower on the page, so most of each column is scrolled out of view and any
    // leaked content would land well below the viewport.
    const spacer = document.createElement('div');
    spacer.style.height = '500px';
    document.body.insertBefore(spacer, m.container);
    try {
      m.container.style.height = '300px';
      await actFrame();
      const bottom = m.container.getBoundingClientRect().bottom + window.scrollY;
      // Visually hidden text deep in a scrolled column must be clipped by that column, not extend the
      // document (which would let focus changes scroll the whole app, transport included).
      expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(Math.max(window.innerHeight, Math.ceil(bottom) + 16));
    } finally {
      spacer.remove();
    }
  });

  it('an instrument knob changes the instrument parameter (one undo step)', async () => {
    const m = setup('t3');
    const inst = panel(m.container, 'Instrument');
    const res = slider(inst, 'Resonance');
    const before = track('t3').instrument.params.resonance;
    key(res, 'keydown', { key: 'ArrowUp' });
    key(res, 'keydown', { key: 'ArrowUp' });
    const after = track('t3').instrument.params.resonance;
    expect(after).toBeCloseTo(before + 0.02, 5);
    expect(Number(res.getAttribute('aria-valuenow'))).toBeCloseTo(after, 5);
    await endBurst();
    act(() => session.undo());
    expect(track('t3').instrument.params.resonance).toBeCloseTo(before, 5);
  });

  it('a macro-controlled knob is read-only, badged and shows the macro-resolved value', () => {
    const m = setup('t3');
    // Map Tone onto the bass instrument's own cutoff.
    act(() => {
      session.accepted(cmd.setMacroTarget(session.store, 't3', 'tone', track('t3').macroMap.tone.length, { module: 't3:inst', param: 'cutoff', min: 200, max: 4000, curve: 'exp' }));
    });
    const inst = panel(m.container, 'Instrument');
    const cutoff = slider(inst, 'Cutoff');
    expect(cutoff.getAttribute('aria-readonly')).toBe('true');
    expect(cutoff.getAttribute('aria-valuetext')).toContain('set by Tone');
    const stored = track('t3').instrument.params.cutoff;
    const target = track('t3').macroMap.tone.at(-1)!;
    expect(Number(cutoff.getAttribute('aria-valuenow'))).toBeCloseTo(macroTargetValue(target, track('t3').macros.tone), 3);
    key(cutoff, 'keydown', { key: 'ArrowUp' });
    expect(track('t3').instrument.params.cutoff).toBe(stored);

    // Turning the macro moves the controlled knob.
    const toneCard = m.container.querySelector<HTMLElement>('[aria-label="Tone macro"]')!;
    key(slider(toneCard, 'Tone'), 'keydown', { key: 'PageUp' });
    expect(track('t3').macros.tone).toBeCloseTo(0.6, 5);
    expect(Number(cutoff.getAttribute('aria-valuenow'))).toBeCloseTo(macroTargetValue(target, 0.6), 3);

    // The channel's reverb send belongs to Space by default.
    const rack = panel(m.container, 'Effects');
    const send = slider(rack, 'Reverb Send');
    expect(send.getAttribute('aria-readonly')).toBe('true');
    expect(send.getAttribute('aria-valuetext')).toContain('set by Space');
  });

  it('editing a macro target range changes the mapping; remove and reset hand control back and forth', async () => {
    const m = setup('t3');
    const toneCard = m.container.querySelector<HTMLElement>('[aria-label="Tone macro"]')!;
    const max = slider(toneCard, 'Filter Cutoff max');
    const before = track('t3').macroMap.tone[0].max;
    key(max, 'keydown', { key: 'PageDown' });
    key(max, 'keydown', { key: 'PageDown' });
    // Applied live (so the sound follows), and the key burst is one undo step.
    const edited = track('t3').macroMap.tone[0].max;
    expect(edited).toBeLessThan(before * 0.5);
    expect(Number(max.getAttribute('aria-valuenow'))).toBeCloseTo(edited, 3);
    await endBurst();
    act(() => session.undo());
    expect(track('t3').macroMap.tone[0].max).toBe(before);
    act(() => session.redo());
    expect(track('t3').macroMap.tone[0].max).toBe(edited);

    // Remove the mapping: the filter's cutoff knob becomes playable by hand.
    const rack = panel(m.container, 'Effects');
    expect(slider(rack, 'Cutoff').getAttribute('aria-readonly')).toBe('true');
    click(button(toneCard, 'Remove Filter Cutoff from Tone'));
    expect(track('t3').macroMap.tone.some((t) => t.module === 't3:filter' && t.param === 'cutoff')).toBe(false);
    expect(slider(rack, 'Cutoff').hasAttribute('aria-readonly')).toBe(false);
    expect(runtimeStore.getState().notice?.text).toMatch(/no longer moves Filter Cutoff/);

    // Reset mappings restores the mapping the part's sound was designed with.
    click(button(panel(m.container, 'Macros'), /Reset mappings/));
    const designed = cmd.soundMacroMap(track('t3'));
    expect(track('t3').macroMap).toEqual(designed);
    const filterCutoffMapped = Object.values(designed).some((list) => list.some((t) => t.module === 't3:filter' && t.param === 'cutoff'));
    expect(slider(rack, 'Cutoff').getAttribute('aria-readonly')).toBe(filterCutoffMapped ? 'true' : null);
    // The macro cards list exactly the designed targets.
    const rows = toneCard.querySelectorAll('[role="group"][aria-label^="Tone moves"]');
    expect(rows).toHaveLength(designed.tone.length);
    // Resetting again changes nothing, and says so.
    const map = track('t3').macroMap;
    click(button(panel(m.container, 'Macros'), /Reset mappings/));
    expect(track('t3').macroMap).toBe(map);
    expect(runtimeStore.getState().notice?.text).toMatch(/already match/);
  });

  it('a pointer drag on a macro range knob changes the mapping live, as one undo step', async () => {
    const m = setup('t3');
    const toneCard = m.container.querySelector<HTMLElement>('[aria-label="Tone macro"]')!;
    const min = slider(toneCard, 'Filter Cutoff min');
    const before = track('t3').macroMap.tone[0].min;
    const start = pointIn(min, 0.3);
    pointer(min, 'pointerdown', start);
    for (let i = 1; i <= 6; i++) {
      pointer(min, 'pointermove', { clientX: start.clientX, clientY: start.clientY - i * 10 });
      await actFrame();
    }
    // The knob and the mapping follow the drag (the sound changes while you turn).
    expect(Number(min.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
    expect(track('t3').macroMap.tone[0].min).toBeGreaterThan(before);
    pointer(min, 'pointerup', { clientX: start.clientX, clientY: start.clientY - 60 });
    const after = track('t3').macroMap.tone[0].min;
    expect(after).toBeGreaterThan(before);
    expect(Number(min.getAttribute('aria-valuenow'))).toBeCloseTo(after, 3);
    // The "now" readout follows the new range.
    const row = min.closest<HTMLElement>('[role="group"][aria-label^="Tone moves"]')!;
    const target = track('t3').macroMap.tone[0];
    expect(row.textContent).toContain(`now ${formatParam(FILTER_PARAMS.find((x) => x.id === 'cutoff')!, macroTargetValue(target, track('t3').macros.tone))}`);
    act(() => session.undo());
    expect(track('t3').macroMap.tone[0].min).toBe(before);
  });

  it('explains Pump as a tempo-synchronized ducking envelope, not a sidechain', () => {
    const m = setup('t4');
    const pump = m.container.querySelector<HTMLElement>('[aria-label="Pump macro"]')!;
    expect(pump.textContent).toMatch(/tempo-synchronized ducking envelope/);
    expect(pump.textContent).toMatch(/no audio sidechain/);
  });

  it('effects rack: add, bypass, move and remove edit project.patch; undo restores each step', () => {
    const m = setup('t3');
    const original = project().patch;
    const rack = panel(m.container, 'Effects');
    expect(trackChain(project().patch, 't3')).toEqual(['t3:inst', 't3:drive', 't3:filter', 't3:ch']);

    click(button(rack, /Add effect/));
    const menu = rack.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    click(button(menu, /^Chorus/));
    expect(trackChain(project().patch, 't3')).toEqual(['t3:inst', 't3:drive', 't3:filter', 't3:chorus', 't3:ch']);
    expect(uiStore.getState().selectedModuleId).toBe('t3:chorus');
    const card = m.container.querySelector<HTMLElement>('#rack-card-t3\\:chorus')!;
    expect(card.getAttribute('aria-label')).toMatch(/Chorus, effect 3 of 3/);

    const flow = () => rack.querySelector('[aria-label="Signal flow"]')!.textContent ?? '';
    expect(flow()).not.toMatch(/Chorus off/i);
    click(switchNamed(card, 'Chorus'));
    expect(project().patch.modules.find((x) => x.id === 't3:chorus')?.bypass).toBe(true);
    expect(card.getAttribute('aria-label')).toMatch(/bypassed/);
    // The signal flow says so in words, not only by losing its colour.
    expect(flow()).toMatch(/Chorus off/i);

    // Its knobs set the module's params.
    const depth = slider(card, 'Depth');
    const d0 = moduleParams('t3:chorus').depth;
    key(depth, 'keydown', { key: 'ArrowUp' });
    expect(moduleParams('t3:chorus').depth).toBeGreaterThan(d0);

    click(button(card, 'Move Chorus earlier'));
    expect(trackChain(project().patch, 't3')).toEqual(['t3:inst', 't3:drive', 't3:chorus', 't3:filter', 't3:ch']);

    click(button(m.container.querySelector<HTMLElement>('#rack-card-t3\\:chorus')!, 'Remove Chorus'));
    expect(project().patch.modules.some((x) => x.id === 't3:chorus')).toBe(false);
    expect(trackChain(project().patch, 't3')).toEqual(['t3:inst', 't3:drive', 't3:filter', 't3:ch']);

    act(() => session.undo()); // remove
    expect(trackChain(project().patch, 't3')).toEqual(['t3:inst', 't3:drive', 't3:chorus', 't3:filter', 't3:ch']);
    act(() => session.undo()); // move
    expect(trackChain(project().patch, 't3')).toEqual(['t3:inst', 't3:drive', 't3:filter', 't3:chorus', 't3:ch']);
    act(() => session.undo()); // depth
    act(() => session.undo()); // bypass
    expect(project().patch.modules.find((x) => x.id === 't3:chorus')?.bypass).toBe(false);
    act(() => session.undo()); // add
    expect(project().patch.modules.map((x) => x.id)).toEqual(original.modules.map((x) => x.id));
    expect(project().patch.connections.map((c) => [c.from, c.to])).toEqual(original.connections.map((c) => [c.from, c.to]));
  });

  it('shows the per-part effect limit as a refusal', () => {
    const m = setup('t3');
    act(() => {
      for (let i = 0; i < PATCH_LIMITS.maxEffectsPerTrack - 2; i++) cmd.insertEffect(session.store, 't3', 'crusher');
    });
    const rack = panel(m.container, 'Effects');
    expect(rack.textContent).toContain(`${PATCH_LIMITS.maxEffectsPerTrack} of ${PATCH_LIMITS.maxEffectsPerTrack}`);
    const modules = project().patch.modules.length;
    click(button(rack, /Add effect/));
    click(button(rack.querySelector<HTMLElement>('[role="menu"]')!, /^Phaser/));
    expect(project().patch.modules.length).toBe(modules);
    expect(runtimeStore.getState().notice?.text).toMatch(new RegExp(`up to ${PATCH_LIMITS.maxEffectsPerTrack} effects`));
  });

  it('custom routing: lists the part’s effects and points to the cable panel', () => {
    const m = setup('t3');
    act(() => {
      const r = cmd.connect(session.store, { module: 't3:inst', port: 'out' }, { module: 't3:ch', port: 'in' });
      expect(r.ok).toBe(true);
    });
    const rack = panel(m.container, 'Effects');
    expect(rack.textContent).toContain('Custom routing — edit it with the cables below.');
    expect(button(rack, /Add effect/).disabled).toBe(true);
    expect(rack.querySelector('#rack-card-t3\\:drive')).not.toBeNull();
    expect(rack.querySelector('[aria-label="Move Drive earlier"]')).toBeNull();
    // Restore default brings the linear chain (and the rack's reordering) back.
    click(button(rack, /Restore default/));
    expect(trackChain(project().patch, 't3')).toEqual(['t3:inst', 't3:drive', 't3:filter', 't3:ch']);
  });

  it('drum voices: knobs edit the voice, the audition button plays and selects it', async () => {
    const m = setup('t1');
    const inst = track('t1').instrument;
    if (inst.kind !== 'drums') throw new Error('t1 should be a drum kit');
    const names = getKitVoiceNames(inst.kitId);
    const table = panel(m.container, 'Instrument').querySelector('table')!;
    expect(table.querySelectorAll('tbody tr')).toHaveLength(16);

    const tune = slider(table, `${names[2]} tune`);
    key(tune, 'keydown', { key: 'PageUp' });
    const v = track('t1').instrument;
    expect(v.kind === 'drums' && v.voices[2].tune).toBeGreaterThan(0);
    // Voice level reads as a percentage of the designed volume.
    expect(slider(table, `${names[2]} level`).getAttribute('aria-valuetext')).toMatch(/^\d+%$/);
    const pan = slider(table, `${names[2]} pan`);
    key(pan, 'keydown', { key: 'End' });
    const v2 = track('t1').instrument;
    expect(v2.kind === 'drums' && v2.voices[2].pan).toBe(1);
    await endBurst();

    const on = vi.spyOn(session, 'noteOn').mockImplementation(() => {});
    const off = vi.spyOn(session, 'noteOff').mockImplementation(() => {});
    const play = button(table, `Play ${names[3]}`);
    pointer(play, 'pointerdown', pointIn(play));
    expect(on).toHaveBeenCalledWith('t1', 3, expect.any(Number), 'pad');
    expect(drumVoiceFor(uiStore.getState(), 't1')).toBe(3);
    pointer(play, 'pointerup', pointIn(play));
    expect(off).toHaveBeenCalledWith('t1', 3, 'pad');
    // Keyboard audition too.
    key(play, 'keydown', { key: 'Enter' });
    key(play, 'keyup', { key: 'Enter' });
    expect(on).toHaveBeenCalledTimes(2);
    expect(off).toHaveBeenCalledTimes(2);
  });

  it('cable dock: opens, resizes from the keyboard, folds away; the rack and the cable panel share one patch', () => {
    const m = setup('t3');
    expect(m.container.querySelector('[role="region"][aria-label^="Cables for"]')).toBeNull();
    click(button(m.container, /Show cables/));
    expect(uiStore.getState().cablesOpen).toBe(true);
    const cables = m.container.querySelector<HTMLElement>('[role="region"][aria-label="Cables for Bass"]')!;
    expect(cables).not.toBeNull();

    const split = m.container.querySelector<HTMLElement>('[role="separator"][aria-label="Resize cable panel"]')!;
    const h0 = Number(split.getAttribute('aria-valuenow'));
    key(split, 'keydown', { key: 'ArrowDown' });
    expect(Number(split.getAttribute('aria-valuenow'))).toBe(h0 - 16);
    key(split, 'keydown', { key: 'Home' });
    expect(Number(split.getAttribute('aria-valuenow'))).toBe(Number(split.getAttribute('aria-valuemin')));

    // An effect added in the rack appears in the cable panel straight away.
    expect(cables.textContent).not.toContain('Phaser');
    const rack = panel(m.container, 'Effects');
    click(button(rack, /Add effect/));
    click(button(rack.querySelector<HTMLElement>('[role="menu"]')!, /^Phaser/));
    expect(cables.textContent).toContain('Phaser');

    click(button(cables, /^Hide/));
    expect(uiStore.getState().cablesOpen).toBe(false);
    expect(m.container.querySelector('[role="region"][aria-label^="Cables for"]')).toBeNull();
  });

  it('Change sound… opens the sound browser and swaps the part’s kit (undoable)', () => {
    const m = setup('t1');
    const kit = track('t1').instrument;
    if (kit.kind !== 'drums') throw new Error('t1 should be a drum kit');
    const inst = panel(m.container, 'Instrument');
    click(button(inst, /Change sound$/));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    const other = [...dialog.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.getAttribute('aria-selected') === 'false')!;
    const otherName = other.querySelector('span span:nth-child(2)')?.textContent ?? '';
    click(other);
    const after = track('t1').instrument;
    expect(after.kind === 'drums' && after.kitId).not.toBe(kit.kitId);
    expect(panel(m.container, 'Instrument').textContent).toContain(otherName);
    act(() => session.undo());
    const back = track('t1').instrument;
    expect(back.kind === 'drums' && back.kitId).toBe(kit.kitId);
  });

  it('sampler parts show the sampler editor, whose knobs edit the sampler', () => {
    const m = setup('t8');
    expect(track('t8').instrument.kind).toBe('sampler');
    const inst = panel(m.container, 'Instrument');
    expect(inst.textContent).toContain('Sampler');
    // The real editor: waveform trim readouts and the speed/pitch note.
    expect(inst.querySelector('dl[aria-label="Trim region"]')).not.toBeNull();
    expect(inst.textContent).toMatch(/Speed and pitch change together/);
    const gain = slider(inst, 'Gain');
    const before = track('t8').instrument.params.gain ?? 0;
    key(gain, 'keydown', { key: 'ArrowUp' });
    expect(track('t8').instrument.params.gain).toBeGreaterThan(before);
  });

  it('channel, returns and LFO knobs edit their modules; Add LFO opens the cable panel', () => {
    const m = setup('t4');
    const rack = panel(m.container, 'Effects');
    const level = slider(rack.querySelector('[aria-label="Channel strip"]')!, 'Level');
    const l0 = moduleParams('t4:ch').level;
    key(level, 'keydown', { key: 'ArrowDown' });
    expect(moduleParams('t4:ch').level).toBeLessThan(l0);

    const reverb = rack.querySelector<HTMLElement>('[aria-label="Shared Reverb return"]')!;
    const size = slider(reverb, 'Size');
    const s0 = moduleParams('fx:reverb').decay;
    key(size, 'keydown', { key: 'ArrowUp' });
    expect(moduleParams('fx:reverb').decay).toBeGreaterThan(s0);

    const lfo = rack.querySelector<HTMLElement>('[aria-label="LFO"]')!;
    expect(lfo.textContent).toContain('Cabled to Filter Cutoff');
    key(slider(lfo, 'Rate'), 'keydown', { key: 'ArrowUp' });
    expect(moduleParams('t4:lfo').division).toBe(3);

    click(button(rack, /Add LFO/));
    expect(project().patch.modules.some((x) => x.id === 't4:lfo-2')).toBe(true);
    expect(uiStore.getState().cablesOpen).toBe(true);
    expect(rack.textContent).toContain('Not cabled');
  });
  it('lists effects outside a linear chain and says whether they are heard', () => {
    const m = setup('t3');
    const link = (from: string, to: string) => project().patch.connections.find((c) => c.from.module === from && c.to.module === to)!.id;
    act(() => {
      expect(cmd.disconnect(session.store, link('t3:inst', 't3:drive')).changed).toBe(true);
      expect(cmd.disconnect(session.store, link('t3:drive', 't3:filter')).changed).toBe(true);
      expect(cmd.connect(session.store, { module: 't3:inst', port: 'out' }, { module: 't3:filter', port: 'in' }).ok).toBe(true);
    });
    expect(trackChain(project().patch, 't3')).toEqual(['t3:inst', 't3:filter', 't3:ch']);
    const rack = panel(m.container, 'Effects');
    expect(rack.textContent).toContain('1 of 6');
    const outside = rack.querySelector<HTMLElement>('[aria-label="Outside the chain"]')!;
    expect(outside).not.toBeNull();
    const drive = outside.querySelector<HTMLElement>('#rack-card-t3\\:drive')!;
    expect(drive.getAttribute('aria-label')).toMatch(/not heard/);
    expect(drive.textContent).toContain('Not heard');
    expect(drive.querySelector('[aria-label="Move Drive earlier"]')).toBeNull();

    // Patched from the channel's send to the output, it is heard (but still outside the chain).
    act(() => {
      expect(cmd.connect(session.store, { module: 't3:ch', port: 'sendA' }, { module: 't3:drive', port: 'in' }).ok).toBe(true);
      expect(cmd.connect(session.store, { module: 't3:drive', port: 'out' }, { module: 'master', port: 'in' }).ok).toBe(true);
    });
    expect(trackChain(project().patch, 't3')).toEqual(['t3:inst', 't3:filter', 't3:ch']);
    expect(drive.getAttribute('aria-label')).toMatch(/patched outside the chain/);
    expect(drive.textContent).not.toContain('Not heard');

    // Its card still edits and removes the real module.
    click(button(drive, 'Remove Drive'));
    expect(project().patch.modules.some((x) => x.id === 't3:drive')).toBe(false);
    expect(rack.querySelector('[aria-label="Outside the chain"]')).toBeNull();
  });

  it('the part strip shows playing and muted parts with a mark and in words', () => {
    const m = setup('t3');
    try {
      act(() => {
        session.accepted(cmd.setMute(session.store, 't5', true));
      });
      // What the launcher reports while part 2 plays (set after the edit, which the audio side may answer).
      act(() => {
        runtimeStore.setState((s) => ({ ...s, playing: true, tracks: { ...s.tracks, t2: { playingSlot: 0, queued: null } } }));
      });
      const t2 = m.container.querySelector<HTMLElement>('#shape-part-t2')!;
      expect(t2.getAttribute('aria-label')).toMatch(/, playing/);
      expect(t2.querySelector('svg')).not.toBeNull();
      const t4 = m.container.querySelector<HTMLElement>('#shape-part-t4')!;
      expect(t4.getAttribute('aria-label')).not.toMatch(/playing/);
      expect(t4.querySelector('svg')).toBeNull();
      const t5 = m.container.querySelector<HTMLElement>('#shape-part-t5')!;
      expect(t5.getAttribute('aria-label')).toMatch(/, muted/);
      expect(t5.querySelector('[class*="muted"]')?.textContent).toBe('M');
    } finally {
      act(() => runtimeStore.setState((s) => ({ ...s, playing: false, tracks: {} })));
    }
  });
  it('below 1024 px (200 % zoom) the panels reflow: macros and instrument side by side, effects underneath', async () => {
    await page.viewport(960, 540);
    const m = setup('t3');
    m.container.style.width = '920px';
    m.container.style.height = 'auto';
    await actFrame();
    const macros = panel(m.container, 'Macros').getBoundingClientRect();
    const inst = panel(m.container, 'Instrument').getBoundingClientRect();
    const fx = panel(m.container, 'Effects').getBoundingClientRect();
    expect(Math.abs(inst.top - macros.top)).toBeLessThan(2);
    expect(inst.left).toBeGreaterThan(macros.right - 1);
    expect(fx.top).toBeGreaterThanOrEqual(Math.max(macros.bottom, inst.bottom) - 1);
    expect(fx.width).toBeGreaterThan(macros.width + inst.width);
    // Nothing is cut off sideways.
    expect(m.container.scrollWidth).toBeLessThanOrEqual(m.container.clientWidth);
  });
});
