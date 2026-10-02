/**
 * Changing the key moves the song (PLAY-04, capability-04), in the running app with real input:
 * changing Key or Scale in the strip (Advanced) asks once — "Move the song to A Dorian too?
 * Bass, Chords, Lead and Pad move up 2; drums stay." — with sampler parts as opt-in checkboxes;
 * [Move the song] transposes every melodic clip in one undo step (transposeSong) and toasts with
 * Undo; [Only what I play] changes the key alone; Escape keeps the old key.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { setUiMode } from '../../src/state/uiStore';
import type { Id } from '../../src/project/types';
import { clickEl, notice, openApp, press, project, setUp, tearDown, track, until } from './r4-play-helpers';
import { settleFrames } from './r4-uikit-input';
import { resetKeyboardFold, strip } from './r4-keys-helpers';
import { MENU_CLICK_GUARD_MS } from '../../src/app/views/ClipMenu';
import { wait } from './ui-harness';

beforeEach(async () => {
  await setUp();
  resetKeyboardFold();
});
afterEach(async () => {
  await tearDown();
  // Leave the keyboard unfolded everywhere for the next test file (the fold is remembered in storage).
  resetKeyboardFold();
});

const pitches = (id: Id) => track(id).clips.map((c) => (c ? c.notes.map((n) => n.pitch) : null));
const keySelect = () => strip().querySelectorAll<HTMLSelectElement>('select')[0];
const scaleSelect = () => strip().querySelectorAll<HTMLSelectElement>('select')[1];
const popover = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label^="Move the song"]');
const inPopover = (text: string) => [...popover()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!;

/** The question has just opened: wait out the menu click guard (a click within 300 ms of opening, with no pointer travel since, chooses nothing). */
async function asked(): Promise<void> {
  await until(() => !!popover(), 'the question');
  await wait(MENU_CLICK_GUARD_MS + 20);
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await userEvent.selectOptions(select, value);
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
  await settleFrames(2);
}

async function openAdvanced(): Promise<void> {
  await openApp(1366, 768);
  act(() => setUiMode('advanced'));
  await settleFrames(2);
  expect(project().root).toBe(7);
  expect(project().scale).toBe('dorian');
}

/** The synth parts of the House starter that hold notes, as the question lists them. */
function movingParts(): string {
  const names = project()
    .tracks.filter((t) => (t.instrument.kind === 'bass' || t.instrument.kind === 'poly') && t.clips.some((c) => c && c.notes.length))
    .map((t) => t.name);
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

describe('a key change asks once', () => {
  it('Move the song moves Bass (and every synth part) up 2 in one undo step; drums and the sampler stay', async () => {
    await openAdvanced();
    const bass = pitches('t3');
    const drums = pitches('t1');
    const vocal = pitches('t8');
    await choose(keySelect(), '9');
    await asked();
    expect(popover()!.textContent).toContain(`Move the song to A Dorian too? ${movingParts()} move up 2; drums stay.`);
    expect(movingParts()).toMatch(/^Bass, Chords, Lead/);
    // Not moved yet; the picker shows the key asked about.
    expect(project().root).toBe(7);
    expect(keySelect().value).toBe('9');
    // The sampler part is offered, unticked.
    const box = popover()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(false);
    expect(box.parentElement!.textContent).toContain(track('t8').name);
    await clickEl(inPopover('Move the song'));
    expect(popover()).toBeNull();
    expect(project().root).toBe(9);
    expect(pitches('t3')).toEqual(bass.map((c) => c && c.map((p) => p + 2)));
    expect(pitches('t1')).toEqual(drums);
    expect(pitches('t8')).toEqual(vocal);
    expect(notice()).toMatch(/^Moved the song to A Dorian: \d+ notes in \d+ clips\. Drums stayed\./);
    expect(session.store.undoLabel()).toBe('Move the song to A Dorian');
    // One Undo takes it all back.
    await press('{Control>}z{/Control}');
    expect(project().root).toBe(7);
    expect(pitches('t3')).toEqual(bass);
  });

  it('a ticked sampler part moves too', async () => {
    await openAdvanced();
    const vocal = pitches('t8');
    await choose(keySelect(), '9');
    await asked();
    await clickEl(popover()!.querySelector('input[type="checkbox"]'));
    await clickEl(inPopover('Move the song'));
    expect(pitches('t8')).toEqual(vocal.map((c) => c && c.map((p) => p + 2)));
  });

  it('Only what I play changes the key and leaves every clip alone', async () => {
    await openAdvanced();
    const all = project().tracks.map((t) => pitches(t.id));
    await choose(keySelect(), '9');
    await asked();
    await clickEl(inPopover('Only what I play'));
    expect(project().root).toBe(9);
    expect(project().tracks.map((t) => pitches(t.id))).toEqual(all);
    expect(notice()).toBe("Key: A Dorian for what you play. The song's clips stay in G Dorian.");
  });

  it('Escape keeps the old key; changing it again while asking updates the question; a scale change maps degrees', async () => {
    await openAdvanced();
    await choose(keySelect(), '9');
    await asked();
    await press('{Escape}');
    expect(popover()).toBeNull();
    expect(project().root).toBe(7);
    expect(keySelect().value).toBe('7');
    // Scale only: the parts move to its notes.
    await choose(scaleSelect(), 'minor');
    await asked();
    expect(popover()!.textContent).toContain(`Move the song to G minor too? ${movingParts()} move to its notes; drums stay.`);
    // The key too, while it asks: the same question, updated.
    await choose(keySelect(), '5');
    expect(popover()!.textContent).toContain(`Move the song to F minor too? ${movingParts()} move down 2 into its notes; drums stay.`);
    await clickEl(inPopover('Move the song'));
    expect(project().root).toBe(5);
    expect(project().scale).toBe('minor');
  });

  it('the root picker spells roots the way the key label does (B♭, not A#)', async () => {
    await openAdvanced();
    const labels = [...keySelect().options].map((o) => o.textContent);
    expect(labels).toContain('B♭');
    expect(labels).not.toContain('A#');
  });
});
