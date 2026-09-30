/**
 * Shape view behaviour in real Chromium: the real session/store, real DOM
 * events, outcomes checked on the project.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/ui/theme.css';
import { KNOB_BURST_IDLE_MS, TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { ShapeView } from '../../src/app/views/shape/ShapeView';
import { getKitVoiceNames } from '../../src/audio/instruments/kits';
import { createProject } from '../../src/project/factory';
import { trackChain } from '../../src/project/graph';
import { PATCH_LIMITS } from '../../src/project/modules';
import { macroTargetValue } from '../../src/project/resolve';
import type { Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { drumVoiceFor, selectModule, selectTrack, setCablesOpen, uiStore } from '../../src/state/uiStore';
import { cleanup, fire, key, mount, pointer, pointIn, wait } from './ui-harness';

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

beforeEach(() => {
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
    // Committed when the gesture ends, as one undo step.
    expect(track('t3').macroMap.tone[0].max).toBe(before);
    await endBurst();
    const edited = track('t3').macroMap.tone[0].max;
    expect(edited).toBeLessThan(before * 0.5);
    expect(Number(max.getAttribute('aria-valuenow'))).toBeCloseTo(edited, 3);

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
    const rows = toneCard.querySelectorAll('li[role="group"]');
    expect(rows).toHaveLength(designed.tone.length);
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

    click(switchNamed(card, 'Chorus'));
    expect(project().patch.modules.find((x) => x.id === 't3:chorus')?.bypass).toBe(true);
    expect(card.getAttribute('aria-label')).toMatch(/bypassed/);

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

  it('sampler parts show the sampler editor (or the sampler’s own knobs until that module exists)', () => {
    const hasEditor = Object.keys(import.meta.glob('../../src/app/views/sampler/SamplerEditor.tsx')).length > 0;
    const m = setup('t8');
    expect(track('t8').instrument.kind).toBe('sampler');
    const inst = panel(m.container, 'Instrument');
    expect(inst.textContent).toContain('Sampler');
    if (hasEditor) return; // the editor module has its own tests
    const gain = slider(inst, 'Gain');
    key(gain, 'keydown', { key: 'ArrowUp' });
    expect(track('t8').instrument.params.gain).toBeGreaterThan(0);
    expect(inst.textContent).toMatch(/change speed and pitch together/);
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
});
