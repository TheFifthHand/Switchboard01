/**
 * The Channel drawer under the mixer (MIX-07, capability-13), with real clicks: a strip's effect
 * chip opens the drawer on that effect and the view stays Mix; the drawer holds the part's effects
 * rack (Shape's EffectsRack, the same cards and commands); Add EQ and Add Compressor insert one more
 * effect in one click (undoable), and at the effect limit they are unavailable with a note; Open in
 * Shape is still there. Inactive inserts read "(off)" on their chips.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { TAKE_LOCK_MESSAGE } from '../../src/app/session';
import { MixView } from '../../src/app/views/mix/MixView';
import { closeChannelDrawer } from '../../src/app/views/mix/channelDrawer';
import { resetLoudnessWatch } from '../../src/app/views/mix/loudnessMatch';
import { resetMixFrame } from '../../src/app/views/mix/mixMeters';
import { setSendsRow } from '../../src/app/views/mix/mixPrefs';
import { createProject } from '../../src/project/factory';
import { PATCH_LIMITS } from '../../src/project/modules';
import * as cmd from '../../src/state/commands';
import { selectModule, selectTrack, setUiMode, setView, uiStore, type UiMode } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';
import { centre, click, settleFrames } from './r4-uikit-input';

const project = () => session.store.getState();
const effectsOf = (trackId: string) => project().patch.modules.filter((m) => m.trackId === trackId && !['instrument', 'channel', 'lfo'].includes(m.type));

async function setup(mode: UiMode = 'advanced') {
  await page.viewport(1366, 768);
  act(() => {
    session.store.replace(createProject({ name: 'Channel drawer', now: 1 }));
    setUiMode(mode);
    setView('mix');
    selectTrack('t1');
    selectModule(null);
    setSendsRow(true);
  });
  resetMixFrame();
  resetLoudnessWatch();
  const m = mount(h(TipsProvider, { enabled: false }, h(MixView)), { width: 1366 });
  m.container.style.padding = '0';
  m.container.style.height = '610px';
  await settleFrames(3);
  return m;
}

const button = (root: ParentNode, name: string | RegExp) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => {
    const label = b.getAttribute('aria-label') ?? b.textContent ?? '';
    return typeof name === 'string' ? label === name || b.textContent?.trim() === name : name.test(label) || name.test(b.textContent ?? '');
  })!;
const drawer = (root: ParentNode) => root.querySelector<HTMLElement>('[data-testid="channel-drawer"]');
const strip = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-testid="strip-${id}"]`)!;

/** Click with the real mouse, after bringing the element into view. */
async function press(el: HTMLElement) {
  el.scrollIntoView({ block: 'center' });
  await settleFrames();
  await click(centre(el));
  await act(async () => wait(30));
}

beforeEach(() => {
  runtimeStore.setState((s) => ({ ...s, notice: null, recording: 'off', playing: false }));
});

afterEach(() => {
  cleanup();
  act(() => {
    session.store.setLock(null);
    patchRuntime({ recording: 'off' });
    setUiMode('simple');
    setSendsRow(null);
    closeChannelDrawer();
    setView('play');
  });
  resetLoudnessWatch();
});

describe('Channel drawer', () => {
  it('an effect chip opens the drawer on that effect and the view stays Mix; the rack is the part’s own', async () => {
    const m = await setup();
    const bass = project().tracks.find((t) => t.id === 't3')!.name;
    const chips = strip(m.container, 't3').querySelector<HTMLElement>('[role="group"][aria-label$="effects"]')!;
    // Drive at 0 does nothing: its chip says so.
    expect(chips.textContent).toContain('Drive (off)');
    expect(drawer(m.container)).toBeNull();
    await press(button(chips, 'Filter: open in the Channel drawer'));
    expect(uiStore.getState().view).toBe('mix');
    expect(uiStore.getState().selectedTrackId).toBe('t3');
    expect(uiStore.getState().selectedModuleId).toBe('t3:filter');
    const d = drawer(m.container)!;
    expect(d).not.toBeNull();
    expect(d.textContent).toContain(bass);
    // Shape's rack: the part's effect cards in signal order, its channel and the shared returns.
    expect(d.querySelector('[role="list"][aria-label="Insert effects in signal order"]')).not.toBeNull();
    expect(d.querySelectorAll('[data-rack-cell]').length).toBe(2);
    // The drawer sits under the mixer, and the mixer keeps its height.
    const mixer = strip(m.container, 't1').closest('section')!.getBoundingClientRect();
    expect(d.getBoundingClientRect().top).toBeGreaterThanOrEqual(mixer.bottom);
    // The header key closes it.
    const toggle = button(m.container, /^Channel$/);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await press(toggle);
    expect(drawer(m.container)).toBeNull();
  });

  it('Add EQ and Add Compressor insert an effect in one click (one undo step each), and the chip shows it', async () => {
    const m = await setup();
    const bass = project().tracks.find((t) => t.id === 't3')!.name;
    act(() => selectTrack('t3'));
    await press(button(m.container, /^Channel$/));
    const d = drawer(m.container)!;
    const before = effectsOf('t3').length;
    await press(button(d, 'Add EQ'));
    expect(effectsOf('t3').map((x) => x.type)).toContain('eq');
    expect(effectsOf('t3')).toHaveLength(before + 1);
    expect(session.store.undoLabel()).toMatch(/EQ/);
    expect(runtimeStore.getState().notice?.text).toBe(`Added an EQ to ${bass}, at the end of its effects.`);
    // A new EQ is flat: it changes nothing yet, and its chip says so.
    const chips = strip(m.container, 't3').querySelector<HTMLElement>('[role="group"][aria-label$="effects"]')!;
    expect(chips.textContent).toContain('EQ (off)');
    await press(button(d, 'Add Compressor'));
    expect(effectsOf('t3').map((x) => x.type)).toContain('compressor');
    expect(drawer(m.container)!.querySelectorAll('[data-rack-cell]').length).toBe(before + 2);
    act(() => session.undo());
    expect(effectsOf('t3').map((x) => x.type)).not.toContain('compressor');
    act(() => session.undo());
    expect(effectsOf('t3')).toHaveLength(before);
  });

  it('at the effect limit the quick keys are unavailable and a note says why; during a take they are refused', async () => {
    const m = await setup('simple');
    act(() => {
      selectTrack('t2');
      while (effectsOf('t2').length < PATCH_LIMITS.maxEffectsPerTrack) cmd.insertEffect(session.store, 't2', 'chorus');
    });
    await press(button(m.container, /^Channel$/));
    const d = drawer(m.container)!;
    const name = project().tracks.find((t) => t.id === 't2')!.name;
    expect(button(d, 'Add EQ').disabled).toBe(true);
    expect(button(d, 'Add Compressor').disabled).toBe(true);
    expect(d.textContent).toContain(`${name} has ${PATCH_LIMITS.maxEffectsPerTrack} effects, the most a part can hold.`);
    // Below the limit again (Undo), they are back.
    act(() => session.undo());
    await settleFrames();
    expect(button(drawer(m.container)!, 'Add EQ').disabled).toBe(false);
    // A performance take locks effects: the keys are unavailable and the rack says why.
    act(() => {
      session.store.setLock(TAKE_LOCK_MESSAGE, (label) => label.startsWith('module:'));
      patchRuntime({ recording: 'performance' });
    });
    await settleFrames();
    expect(button(drawer(m.container)!, 'Add EQ').disabled).toBe(true);
    expect(drawer(m.container)!.textContent).toContain('Effects are locked while a performance records.');
    expect(cmd.insertEffect(session.store, 't2', 'eq').refused).toBeTruthy();
  });

  it('Open in Shape still takes the part to Shape', async () => {
    const m = await setup();
    act(() => selectTrack('t5'));
    await press(button(m.container, /^Channel$/));
    await press(button(drawer(m.container)!, /^Open in Shape/));
    expect(uiStore.getState().view).toBe('shape');
    expect(uiStore.getState().selectedTrackId).toBe('t5');
  });
});
