/**
 * r6-start, in real Chromium with real clicks and keys:
 * - Welcome's "Make a beat from scratch": a blank project, Drums selected,
 *   Steps open on a new 1-bar loop that plays; "Start from a beat…" right
 *   there puts a beat in the loop (heard at once) and trying another keeps
 *   one undo step;
 * - a tap on an empty pad makes a loop (as long as its scene's) and opens
 *   Steps; the ⋯ menu keeps the length, a beat and Paste;
 * - the transport: the project's name at the left (click to rename in
 *   place), "Saved" in words, ● Record that records into the song in the
 *   Song view (and says where), Performance and its panel only in Advanced;
 * - the keyboard folded in Song until a note is played;
 * - toasts never cover the hint chip;
 * - starter cards lead with mood and tempo; the pads chip in Song;
 * - screenshots at 1366 and 1920.
 */
import { act } from 'react';
import { page } from 'vitest/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { session } from '../../src/app/instance';
import { notify, patchRuntime, runtimeStore } from '../../src/app/runtime';
import { hintsStore } from '../../src/app/views/hints/hintsState';
import { BEATS } from '../../src/content/beats';
import { bottomAboveGuidance } from '../../src/ui/components/Toast';
import { keyboardCollapsedFor, setUiMode, setView, uiStore } from '../../src/state/uiStore';
import { button, click, closeShell, keys, openShell, settle, shown, transport, until } from './r4-shell-harness';

const SHOTS = '/tmp/claude-0/r6/shots-start';

afterEach(async () => {
  if (session.playing) session.stop();
  await closeShell();
});

const drumsOf = () => session.store.getState().tracks.find((t) => t.instrument.kind === 'drums')!;
const welcome = () => document.querySelector('[role="dialog"][aria-labelledby="welcome-title"]');

describe('Make a beat from scratch', () => {
  it('opens a blank project on its drums: Steps on a playing 1-bar loop, with Start from a beat… right there', async () => {
    await openShell({ guideDone: false });
    const key = button('Make a beat from scratch')!;
    expect(key).not.toBeNull();
    expect(key.dataset.variant).toBe('secondary');
    await click(key);
    await until(() => !welcome(), 'the card to go', 15000);
    const drums = drumsOf();
    const ui = uiStore.getState();
    expect(session.store.getState().starterId).toBe('blank');
    expect(ui.view).toBe('play');
    expect(ui.padMode).toBe('steps');
    expect(ui.selectedTrackId).toBe(drums.id);
    expect(drums.clips[0]).toMatchObject({ name: `${drums.name} 1`, bars: 1 });
    // The loop plays, so every square clicked is heard at once.
    await until(() => runtimeStore.getState().playing && runtimeStore.getState().tracks[drums.id]?.playingSlot === 0, 'the loop to play', 10000);
    // Not the starter's guide; the hints start at the step grid.
    expect(document.querySelector('[data-guide-next]')).toBeNull();
    expect(hintsStore.getState().started).toBe(true);
    await until(() => document.querySelector('[data-hint="beat"]'), 'the "Click squares" hint');
    // Count-in is on for a new project.
    expect(session.store.getState().settings.countIn).toBe(true);
    const beatKey = await until(() => button('Start from a beat…'), 'Start from a beat…');
    expect(shown(beatKey)).toBe(true);
  });

  it('Start from a beat… puts the beat in the loop, swaps on another pick, and Undo goes back in one step', async () => {
    await openShell();
    await click(button('Make a beat from scratch')!);
    await until(() => !welcome(), 'the card to go', 15000);
    const drums = drumsOf();
    await click(await until(() => button('Start from a beat…'), 'Start from a beat…'));
    const picker = await until(() => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Start from a beat"]'), 'the picker');
    // Styles as a radio group; the beats of the chosen one.
    const styles = [...picker.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(styles.length).toBeGreaterThan(10);
    const house = styles.find((s) => s.textContent === 'House')!;
    await click(house);
    expect(house.getAttribute('aria-checked')).toBe('true');
    const beatButtons = () => [...picker.querySelectorAll<HTMLButtonElement>('button[data-beat]')];
    expect(beatButtons().length).toBe(BEATS.filter((b) => b.genre === 'house').length);
    const undoBefore = session.store.undoEntryId();
    await click(beatButtons()[0]);
    const first = BEATS.find((b) => b.id === beatButtons()[0].dataset.beat)!;
    let clip = session.store.getState().tracks.find((t) => t.id === drums.id)!.clips[0]!;
    expect(clip.notes.length).toBeGreaterThan(4);
    expect(clip.bars % first.bars).toBe(0);
    expect(session.store.undoLabel()).toBe(`Start from ${first.name}`);
    expect(beatButtons()[0].getAttribute('aria-pressed')).toBe('true');
    expect(beatButtons()[0].textContent).toContain('In the loop');
    // Another beat: it replaces the first, still one step to undo.
    await click(beatButtons()[1]);
    const second = BEATS.find((b) => b.id === beatButtons()[1].dataset.beat)!;
    clip = session.store.getState().tracks.find((t) => t.id === drums.id)!.clips[0]!;
    expect(session.store.undoLabel()).toBe(`Start from ${second.name}`);
    session.undo();
    await settle(60);
    expect(session.store.getState().tracks.find((t) => t.id === drums.id)!.clips[0]!.notes).toHaveLength(0);
    expect(session.store.undoEntryId()).toBe(undoBefore);
    // The loop kept playing all along (the beats were heard in it).
    expect(runtimeStore.getState().tracks[drums.id]?.playingSlot).toBe(0);
  });
});

describe('an empty pad', () => {
  it('a tap makes a loop as long as its scene’s loops and opens it in Steps; ⋯ keeps the other ways', async () => {
    await openShell();
    await click(button('Other starters & projects')!);
    const blank = await until(() => document.querySelector<HTMLElement>('[data-starter="blank"]'), 'the Blank card');
    await click(blank);
    await until(() => !document.querySelector('[role="dialog"][aria-modal="true"]'), 'the library to close', 10000);
    act(() => setView('play'));
    await settle(100);
    const p = session.store.getState();
    const bass = p.tracks.find((t) => t.role === 'bass')!;
    // A blank project starts on its drums.
    expect(uiStore.getState().selectedTrackId).toBe(drumsOf().id);
    act(() => uiStore.setState((s) => ({ ...s, padMode: 'loops' })));
    await settle(100);
    // Give the first scene a 2-bar loop on the drums, then tap the empty bass pad of that scene.
    session.accepted((await import('../../src/state/commands')).createClip(session.store, drumsOf().id, 0, 2));
    await settle(60);
    const pad = await until(() => document.getElementById(`pad-${bass.id}-0`) ?? document.querySelector<HTMLElement>(`[data-track="${bass.id}"][data-slot="0"] [role="button"], [data-track="${bass.id}"][data-slot="0"] button`), 'the bass pad');
    await click(pad);
    const made = session.store.getState().tracks.find((t) => t.id === bass.id)!.clips[0];
    expect(made).toMatchObject({ name: `${bass.name} 1`, bars: 2 });
    expect(uiStore.getState().padMode).toBe('steps');
    expect(uiStore.getState().selectedTrackId).toBe(bass.id);
    // Back on the pads: the ⋯ menu of an empty drum pad offers a beat, the length and Paste.
    act(() => uiStore.setState((s) => ({ ...s, padMode: 'loops' })));
    await settle(100);
    const drumPad = document.querySelector<HTMLElement>(`[data-track="${drumsOf().id}"][data-slot="1"]`)!;
    drumPad.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: drumPad.getBoundingClientRect().left + 10, clientY: drumPad.getBoundingClientRect().top + 10 }));
    await settle(100);
    const menu = await until(() => document.querySelector<HTMLElement>('[role="menu"][aria-label^="Empty pad"]'), 'the empty-pad menu');
    expect(menu.textContent).toContain('Start from a beat…');
    expect(menu.querySelector('[aria-label="New loop, 4 bars"]')).not.toBeNull();
    expect(menu.textContent).toContain('Paste');
  });
});

describe('the transport', () => {
  it('shows the project’s name at the left, renamed in place; the save state in words', async () => {
    await openShell();
    await click(button('Jump In')!);
    await until(() => !welcome(), 'the card to go');
    const name = session.store.getState().name;
    const title = transport().querySelector<HTMLElement>('[role="group"][aria-label="Project"]')!;
    const views = transport().querySelector('[role="tablist"]')!;
    expect(title.getBoundingClientRect().right).toBeLessThanOrEqual(views.getBoundingClientRect().left + 1);
    const nameKey = button(`Project: ${name}. Rename`)!;
    expect(shown(nameKey)).toBe(true);
    expect(title.querySelector('[data-title-save]')!.textContent).toMatch(/Saved|Preview|Saving/);
    await click(nameKey);
    const field = await until(() => title.querySelector<HTMLInputElement>('input[aria-label="Project name"]'), 'the name field');
    expect(document.activeElement).toBe(field);
    await keys('{Control>}a{/Control}My First Beat{Enter}');
    expect(session.store.getState().name).toBe('My First Beat');
    expect(session.store.undoLabel()).toMatch(/Rename/);
    await until(() => button('Project: My First Beat. Rename'), 'the new name');
    // Esc keeps the old name.
    await click(button('Project: My First Beat. Rename')!);
    await until(() => title.querySelector('input'), 'the field');
    await keys('Other{Escape}');
    expect(session.store.getState().name).toBe('My First Beat');
    const savedWords = await until(() => title.querySelector<HTMLElement>('[data-title-save="saved"]'), 'Saved');
    expect(savedWords.textContent).toBe('Saved');
    expect(savedWords.querySelector('svg')).not.toBeNull();
  });

  it('● Record records into the song in the Song view and says where; Performance is in Advanced only', async () => {
    await openShell();
    await click(button('Jump In')!);
    await until(() => !welcome(), 'the card to go');
    const rec = () => button(/^Record (Notes|into the song)$/, transport());
    expect(rec()!.textContent).toBe('Record');
    expect(rec()!.querySelector('svg')).not.toBeNull();
    expect(button('Record Performance', transport())).toBeNull();
    act(() => setUiMode('advanced'));
    await settle(60);
    expect(button('Record Performance', transport())).not.toBeNull();
    act(() => setUiMode('simple'));
    act(() => setView('arrange'));
    await settle(200);
    // No takes yet: no Performances panel in Simple.
    expect(document.body.textContent).not.toContain('No takes yet');
    expect(rec()!.getAttribute('aria-label')).toBe('Record into the song');
    const spy = vi.spyOn(session, 'toggleRecordNotes').mockImplementation(async () => {});
    await click(rec()!);
    expect(spy).toHaveBeenCalledWith({ song: true });
    spy.mockRestore();
    // While a take into the song runs, the caption says what and where.
    const lead = session.store.getState().tracks.find((t) => t.role === 'lead')!;
    act(() => patchRuntime({ recording: 'notes', songRecording: { trackId: lead.id, startBar: 8, bars: 1 }, recordTarget: null }));
    await settle(60);
    const caption = transport().querySelector('[role="group"][aria-label="Recording"]')!.textContent!;
    expect(caption).toContain(`Recording · ${lead.name} · into the song at bar 9`);
    act(() => patchRuntime({ recording: 'off', songRecording: null }));
  });

  it('the Song view’s chip says the pads are playing, with Play the song instead', async () => {
    await openShell();
    await click(button('Jump In')!);
    await until(() => !welcome(), 'the card to go');
    act(() => {
      patchRuntime({ playing: true, mode: 'live' });
      // 2.4's Song header (with its pads chip): Advanced since round 7.
      setUiMode('advanced');
      setView('arrange');
    });
    await settle(200);
    const chip = await until(() => document.querySelector<HTMLElement>('[data-testid="pads-playing"]'), 'the chip');
    expect(chip.textContent).toContain('Pads are playing');
    expect(chip.textContent).toContain('Play the song instead');
    act(() => patchRuntime({ playing: false }));
  });
});

describe('the keyboard in Song', () => {
  it('starts folded and opens when a note key is played', async () => {
    await openShell();
    await click(button('Jump In')!);
    await until(() => !welcome(), 'the card to go');
    // As on a new install: no fold chosen in any view yet.
    act(() => {
      uiStore.setState((s) => ({ ...s, keyboardCollapsedByView: {} }));
      setView('arrange');
    });
    await settle(200);
    const strip = () => document.querySelector<HTMLElement>('section[aria-label="Keyboard"]')!;
    expect(strip().hasAttribute('data-collapsed')).toBe(true);
    expect(button('Show the keyboard')).not.toBeNull();
    (document.activeElement as HTMLElement | null)?.blur();
    await keys('a');
    await until(() => !strip().hasAttribute('data-collapsed'), 'the keyboard to open');
    expect(keyboardCollapsedFor(uiStore.getState(), 'arrange')).toBe(false);
  });
});

describe('toasts and guidance', () => {
  it('stack above what they would cover (pure)', () => {
    const chip = { left: 400, right: 900, top: 620, bottom: 660 };
    expect(bottomAboveGuidance(660, 420, 940, 48, [chip])).toBe(612);
    expect(bottomAboveGuidance(660, 950, 1300, 48, [chip])).toBe(660);
    // Two in a column: above both.
    expect(bottomAboveGuidance(660, 420, 940, 48, [chip, { left: 420, right: 600, top: 570, bottom: 610 }])).toBe(562);
  });

  it('a toast never covers the hint chip', async () => {
    await openShell();
    await keys('{Escape}');
    const chip = await until(() => document.querySelector<HTMLElement>('aside[data-hint][data-ready]'), 'the hint chip', 8000);
    act(() => notify('A message that is long enough to reach across the middle of the window, where the chip may sit.', 'info'));
    await settle(700);
    const toast = await until(() => [...document.querySelectorAll<HTMLElement>('[aria-live="polite"][aria-relevant] [role="status"]')][0], 'the toast');
    const a = chip.getBoundingClientRect();
    const b = toast.getBoundingClientRect();
    const overlap = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    expect(overlap).toBe(false);
  });
});

describe('words', () => {
  it('starter cards lead with mood and tempo; the key’s name is on hover', async () => {
    await openShell();
    await click(button('Other starters & projects')!);
    const house = await until(() => document.querySelector<HTMLElement>('[data-starter="house"]'), 'the House card');
    const feel = house.querySelector<HTMLElement>('[data-feel]')!;
    expect(feel.textContent).toBe('warm, bouncy · 124 BPM');
    expect(feel.title).toMatch(/^Key: /);
    expect(document.querySelectorAll('[data-starter]').length).toBe(14);
  });
});

describe('screenshots', () => {
  for (const [w, h] of [
    [1366, 768],
    [1920, 1080],
  ] as const) {
    it(`at ${w}×${h}`, async () => {
      await openShell({ width: w, height: h });
      await page.screenshot({ path: `${SHOTS}/welcome-${w}.png` });
      await click(button('Make a beat from scratch')!);
      await until(() => !welcome(), 'the card to go', 15000);
      await settle(600);
      await page.screenshot({ path: `${SHOTS}/beat-steps-${w}.png` });
      await click(await until(() => button('Start from a beat…'), 'Start from a beat…'));
      const picker = await until(() => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Start from a beat"]'), 'the picker');
      await click(picker.querySelector<HTMLButtonElement>('button[data-beat]')!);
      await settle(300);
      await page.screenshot({ path: `${SHOTS}/beat-picker-${w}.png` });
      await keys('{Escape}');
      act(() => setView('arrange'));
      await settle(500);
      await page.screenshot({ path: `${SHOTS}/song-${w}.png` });
      session.stop();
      act(() => setView('play'));
      act(() => uiStore.setState((s) => ({ ...s, padMode: 'loops' })));
      await settle(400);
      await page.screenshot({ path: `${SHOTS}/loops-${w}.png` });
      act(() => setUiMode('advanced'));
      await settle(300);
      await page.screenshot({ path: `${SHOTS}/loops-advanced-${w}.png` });
      act(() => setUiMode('simple'));
    });
  }
});
