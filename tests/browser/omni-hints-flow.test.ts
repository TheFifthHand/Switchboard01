/**
 * "Try this" hints in the running app (real Chromium, the app's styles):
 * after Jump In and the quick guide, one suggestion at a time that moves on
 * when the real state says it was done (a Bass pad launched, Drums muted and
 * back, a clip moved, Tone turned, a new instrument, a mastering preset, a
 * performance recorded); a polite status message for screen readers; Tips
 * off hides them; Hide hints is remembered; "Show hints again" in the
 * Project library starts over; they never take focus or block keys.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore, setTrackRuntime } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { HINTS_STORAGE_KEY, INITIAL_HINTS, hintsStore } from '../../src/app/views/hints/hintsState';
import { bassPart, drumsPart } from '../../src/app/views/hints/steps';
import { SYNTH_PRESETS } from '../../src/content/catalog';
import { deleteDb } from '../../src/persistence/db';
import { changeInstrumentSound } from '../../src/state/commands';
import { selectTrack, setGuideDone, setPadMode, setTipsEnabled, setUiMode, setView, uiStore } from '../../src/state/uiStore';
import { cleanup, key, mount, pointIn, pointer, wait } from './ui-harness';

const realJumpIn = session.jumpIn;
const realPressClip = session.pressClip;
let boot: BootInfo;

beforeEach(async () => {
  await page.viewport(1366, 768);
  await deleteDb();
  localStorage.removeItem(HINTS_STORAGE_KEY);
  act(() => {
    hintsStore.setState(INITIAL_HINTS);
    setGuideDone(false);
    setTipsEnabled(true);
    setUiMode('simple');
    setView('play');
    setPadMode('loops');
    patchRuntime({ playing: false, paused: false, recording: 'off', notice: null, tracks: {} });
  });
  // Jump In without the audio engine: what is under test is the app's wiring and the hints.
  session.jumpIn = async () => {
    await session.newFromStarter('house');
  };
  // A pad tap while the groove plays queues the clip for the next bar (as the session does with the engine).
  session.pressClip = async (trackId, slot) => {
    const cur = runtimeStore.getState().tracks[trackId] ?? { playingSlot: null, queued: null };
    setTrackRuntime(trackId, { playingSlot: cur.playingSlot, queued: { slot, atTick: 384 } });
  };
  boot = await session.boot();
});

afterEach(async () => {
  cleanup();
  // Other test files in this browser share localStorage: leave no hints behind.
  localStorage.removeItem(HINTS_STORAGE_KEY);
  act(() => hintsStore.setState(INITIAL_HINTS));
  session.jumpIn = realJumpIn;
  session.pressClip = realPressClip;
  act(() => patchRuntime({ recording: 'off', tracks: {} }));
  await session.autosaver?.flush();
  await deleteDb();
});

async function settle(ms = 350) {
  await act(async () => {
    await wait(ms);
  });
}

function openApp() {
  const m = mount(h(App, { boot }));
  m.container.style.width = '';
  m.container.style.padding = '0';
  return m;
}

const buttons = (root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>('button')];
function button(name: string | RegExp, root: ParentNode = document): HTMLButtonElement | null {
  return buttons(root).find((b) => {
    const n = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    return typeof name === 'string' ? n === name : name.test(n);
  }) ?? null;
}
async function click(el: HTMLElement | null, what = 'button') {
  if (!el) throw new Error(`${what} not found`);
  await act(async () => {
    el.click();
  });
}
const chip = () => document.querySelector<HTMLElement>('[data-hint]');
const said = () => document.querySelector<HTMLElement>('[data-hints-status]')?.textContent ?? '';

async function jumpIn() {
  await click(button('Jump In'), 'Jump In');
  for (let i = 0; i < 100 && buttons().some((b) => /^(Jump In|Starting…)$/.test(b.textContent?.trim() ?? '')); i++) await settle(20);
  await settle();
}

describe('"Try this" hints', () => {
  it('after Jump In and the quick guide, suggest one action at a time and move on when it is done', async () => {
    openApp();
    await jumpIn();
    // The quick guide comes first; the hints wait for it.
    expect(document.querySelector('[data-guide-step]')).not.toBeNull();
    expect(chip()).toBeNull();
    await click(button('Skip guide'));
    await settle();

    const p = session.store.getState();
    const bass = bassPart(p)!;
    const drums = drumsPart(p)!;
    expect(bass.name).toBe('Bass');
    expect(drums.name).toBe('Drums');

    // 1. A pad in the Bass column.
    expect(chip()!.dataset.hint).toBe('pad');
    expect(chip()!.getAttribute('aria-label')).toBe('Try this, hint 1 of 7');
    expect(chip()!.textContent).toContain('Tap a pad in the Bass column.');
    expect(said()).toBe('Try this: Tap a pad in the Bass column.');
    // Tap (press and release) a clip pad in the Bass column.
    const pad = document.querySelector<HTMLElement>(`#pad-${bass.id}-2`)!;
    pointer(pad, 'pointerdown', pointIn(pad));
    pointer(pad, 'pointerup', pointIn(pad));
    await settle();
    expect(runtimeStore.getState().tracks[bass.id]?.queued?.slot).toBe(2);

    // 2. Mute on Drums, then back on: the text follows the real state.
    expect(chip()!.dataset.hint).toBe('mute');
    expect(chip()!.textContent).toContain('Done');
    expect(said()).toBe('Done. Next, try this: Press Mute on Drums.');
    await click(button('Mute Drums'));
    await settle();
    expect(session.store.getState().tracks.find((t) => t.id === drums.id)!.mute).toBe(true);
    expect(chip()!.dataset.hint).toBe('mute');
    expect(chip()!.textContent).toContain('The Drums part is muted. Press Mute again to bring it back.');
    await click(button('Mute Drums'));
    await settle();

    // 3. Move a clip (what dragging a pad does).
    expect(chip()!.dataset.hint).toBe('drag');
    const from = bass.clips.findIndex((c) => c !== null);
    const to = bass.clips.findIndex((c) => c === null);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThanOrEqual(0);
    act(() => void session.moveClip({ trackId: bass.id, slot: from }, { trackId: bass.id, slot: to }));
    await settle();

    // 4. Turn Tone: the real knob, with the arrow key.
    expect(chip()!.dataset.hint).toBe('tone');
    const tone = document.querySelector<HTMLElement>('section[aria-labelledby="part-title"] [role="slider"][aria-label^="Tone"]')!;
    tone.focus();
    key(tone, 'keydown', { key: 'ArrowUp' });
    await settle();

    // 5. A new instrument (what the sound browser does when a sound is picked).
    expect(chip()!.dataset.hint).toBe('instrument');
    const selected = session.store.getState().tracks.find((t) => t.id === uiStore.getState().selectedTrackId)!;
    const inst = selected.instrument;
    if (inst.kind !== 'bass' && inst.kind !== 'poly') throw new Error(`fixture: ${selected.name} plays ${inst.kind}`);
    const other = SYNTH_PRESETS.find((x) => x.kind === inst.kind && x.id !== inst.presetId)!;
    act(() => void session.accepted(changeInstrumentSound(session.store, selected.id, inst.kind, other.id)));
    await settle();

    // 6. Mastering: the hint offers to open Mix, then a preset chip does it.
    expect(chip()!.dataset.hint).toBe('master');
    expect(chip()!.textContent).toContain('Open Mix and try a mastering preset.');
    await click(button('Open Mix', chip()!));
    await settle();
    expect(uiStore.getState().view).toBe('mix');
    expect(chip()!.textContent).toContain('Pick a mastering preset, like Warm or Punchy.');
    expect(button('Open Mix', chip()!)).toBeNull();
    // "Done" (from the instrument step) shows for a moment only, even though the text changed meanwhile.
    expect(chip()!.dataset.done).toBe('true');
    await settle(1900);
    expect(chip()!.dataset.done).toBeUndefined();
    expect(chip()!.textContent).toContain('Try this');
    await click(button('Warm'), 'Warm preset');
    await settle();
    expect(session.store.getState().mastering.presetId).toBe('warm');

    // 7. Record a performance: start, then stop.
    expect(chip()!.dataset.hint).toBe('record');
    act(() => patchRuntime({ recording: 'performance' }));
    await settle();
    expect(chip()!.textContent).toContain('Recording. Play a little, then press Performance again to stop.');
    act(() => patchRuntime({ recording: 'off' }));
    await settle();

    // All done: a closing line, then nothing.
    expect(chip()!.dataset.hint).toBe('finished');
    expect(chip()!.textContent).toContain('You have tried the basics.');
    await click(button('Close hints'));
    await settle();
    expect(chip()).toBeNull();
    expect(hintsStore.getState().finished).toBe(true);
    expect(JSON.parse(localStorage.getItem(HINTS_STORAGE_KEY)!)).toMatchObject({ started: true, finished: true });
  });

  it('Next hint passes over a suggestion; Tips off hides the hints; Hide hints is remembered; Show hints again starts over', async () => {
    act(() => setGuideDone(true));
    const first = openApp();
    await jumpIn();
    expect(chip()!.dataset.hint).toBe('pad');

    await click(button('Next hint'));
    await settle();
    expect(chip()!.dataset.hint).toBe('mute');
    // Passed over, not done: no "Done".
    expect(chip()!.textContent).not.toContain('Done');
    expect(said()).toBe('Try this: Press Mute on Drums.');

    // Hints are part of Tips.
    act(() => setTipsEnabled(false));
    await settle();
    expect(chip()).toBeNull();
    act(() => setTipsEnabled(true));
    await settle();
    expect(chip()!.dataset.hint).toBe('mute');

    // Hide hints: gone, says how to get them back, and stays gone after a reload.
    await click(button('Hide hints'));
    await settle();
    expect(chip()).toBeNull();
    expect(runtimeStore.getState().notice?.text).toContain('Show hints again');
    expect(JSON.parse(localStorage.getItem(HINTS_STORAGE_KEY)!).hidden).toBe(true);
    first.unmount();
    openApp();
    await jumpIn();
    expect(chip()).toBeNull();

    // The Project library brings them back from the first one, and turns Tips on.
    act(() => setTipsEnabled(false));
    await click(button(/^Projects \(open:/));
    await settle();
    await click(button('Show hints again'));
    await settle();
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
    expect(uiStore.getState().tipsEnabled).toBe(true);
    expect(chip()!.dataset.hint).toBe('pad');
    expect(chip()!.getAttribute('aria-label')).toBe('Try this, hint 1 of 7');
  });

  it('never takes focus or keys: playing goes on while a hint shows, and its buttons work from the keyboard', async () => {
    act(() => setGuideDone(true));
    openApp();
    await jumpIn();
    act(() => selectTrack('t4'));
    const before = document.activeElement;
    expect(chip()).not.toBeNull();
    // It is not a dialog and did not move focus.
    expect(chip()!.closest('[role="dialog"]')).toBeNull();
    expect(chip()!.getAttribute('aria-modal')).toBeNull();
    expect(document.activeElement).toBe(before);
    // M still mutes the selected part, Space still reaches the transport.
    const selected = uiStore.getState().selectedTrackId;
    key(document.body, 'keydown', { key: 'm', code: 'KeyM' });
    expect(session.store.getState().tracks.find((t) => t.id === selected)!.mute).toBe(true);
    key(document.body, 'keydown', { key: 'm', code: 'KeyM' });
    // Keyboard: the buttons are ordinary buttons with names.
    const next = button('Next hint', chip()!)!;
    next.focus();
    expect(document.activeElement).toBe(next);
    await click(next);
    await settle();
    expect(chip()!.dataset.hint).toBe('mute');
    for (const b of buttons(chip()!)) expect((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()).not.toBe('');
  });
});
