/**
 * r6 UX fixes in the running app (real Chromium, real clicks; screenshots at
 * 1366 × 768 and 1920 × 1080 in test-results/shots-fix2):
 * - the recording readout says the whole "Recording · Lead · into the song at
 *   bar 9" where the strip has room, and a shorter whole wording where it has
 *   not (never "RECOR…");
 * - the project's name is not cut when the strip has room;
 * - Make a beat from scratch names the project "My beat" ("My beat 2"…);
 * - a beat picked in such a fresh project brings its tempo (said in the
 *   toast, one undo step); in any other project the song keeps its tempo
 *   and the beats show theirs as a hint; the beat key stays after a step is
 *   clicked ("Replace with a beat…");
 * - toasts sit on the keyboard strip, never over the song's ruler and sections, nor the
 *   pads' action bar or the step lanes just above the strip;
 * - "Used 2×" on a loop that plays in two places, with its tooltip;
 * - the "Click squares…" hint only while Steps shows the drums;
 * - the keyboard spans the strip again after it was folded (in Steps);
 * - an opened project lands in the view it was last in;
 * - Simple says "Only notes that fit the song are shown." (the scale's name on hover);
 * - Export's tooltip is "Export the song as a file".
 */
import { act } from 'react';
import { page } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { notify, patchRuntime } from '../../src/app/runtime';
import { BEATS } from '../../src/content/beats';
import { setKeyboardCollapsed, setPadMode, setUiMode, setView, selectTrack, uiStore } from '../../src/state/uiStore';
import { button, click, closeShell, keys, openShell, settle, shown, transport, until } from './r4-shell-harness';

// Screenshots for a person to look at, beside the test results (git-ignored); the path is relative to this file.
const SHOTS = '../../test-results/shots-fix2';
const welcome = () => document.querySelector('[role="dialog"][aria-labelledby="welcome-title"]');
const described = (el: Element) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

afterEach(async () => {
  if (session.playing || session.paused) session.stop();
  await closeShell();
});

async function jumpIn(w = 1366, h = 768): Promise<void> {
  await openShell({ width: w, height: h });
  await click(button('Jump In')!);
  await until(() => !welcome(), 'the card to go');
}

async function makeBeat(w = 1366, h = 768): Promise<void> {
  await openShell({ width: w, height: h });
  await click(button('Make a beat from scratch')!);
  await until(() => !welcome(), 'the card to go', 15000);
  await settle(200);
}

describe('the recording readout', () => {
  for (const [w, h, whole] of [
    [1920, 1080, true],
    [1366, 768, false],
  ] as const) {
    it(`at ${w}: says the part and the bar, never cut`, async () => {
      await jumpIn(w, h);
      act(() => setView('arrange'));
      await settle(200);
      const lead = session.store.getState().tracks.find((t) => t.name === 'Lead')!;
      act(() => patchRuntime({ recording: 'notes', songRecording: { trackId: lead.id, startBar: 8, bars: 4 }, recordTarget: null, countingIn: false }));
      await settle(200);
      const caption = transport().querySelector<HTMLElement>('[role="group"][aria-label="Recording"] [aria-live="polite"]')!;
      const text = caption.querySelector<HTMLElement>('[class*="recText"]')!;
      expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
      expect(caption.scrollWidth).toBeLessThanOrEqual(caption.clientWidth + 1);
      if (whole) expect(text.textContent).toBe('Recording · Lead · into the song at bar 9');
      else expect(text.textContent).toMatch(/^(Recording|Rec) · Lead · bar 9$/);
      // Screen readers get the whole sentence whatever the room.
      expect(caption.textContent).toContain('Recording · Lead · into the song at bar 9');
      // Nothing else in the strip is pushed off or overlapped.
      const bar = transport();
      expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth + 1);
      const right = bar.querySelector<HTMLElement>('[data-bar-right]')!.getBoundingClientRect();
      const output = bar.querySelector<HTMLElement>('[role="group"][aria-label="Output"]')!.getBoundingClientRect();
      expect(output.right).toBeLessThanOrEqual(right.left);
      await page.screenshot({ path: `${SHOTS}/rec-readout-${w}.png`, clip: { x: 0, y: 0, width: w, height: 64 } });
      act(() => patchRuntime({ recording: 'off', songRecording: null }));
    });
  }
});

describe('the project', () => {
  it('Make a beat from scratch: "My beat", then "My beat 2"; the name is not cut at 1920', async () => {
    await makeBeat(1920, 1080);
    expect(session.store.getState().name).toBe('My beat');
    const name = transport().querySelector<HTMLElement>('[role="group"][aria-label="Project"] [class*="titleText"]')!;
    expect(name.textContent).toBe('My beat');
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
    await act(async () => {
      await session.beatFromScratch();
    });
    await settle(200);
    expect(session.store.getState().name).toBe('My beat 2');
  });

  it('a starter’s name is whole at 1920 and at 1366', async () => {
    for (const [w, h] of [
      [1920, 1080],
      [1366, 768],
    ] as const) {
      await jumpIn(w, h);
      const name = transport().querySelector<HTMLElement>('[role="group"][aria-label="Project"] [class*="titleText"]')!;
      expect(name.textContent).toBe('House Starter');
      expect(name.scrollWidth, `at ${w}`).toBeLessThanOrEqual(name.clientWidth);
      await page.screenshot({ path: `${SHOTS}/title-${w}.png`, clip: { x: 0, y: 0, width: w, height: 64 } });
      await closeShell();
    }
  });

  it('an opened project lands in the view it was last in', async () => {
    await jumpIn();
    const first = session.store.getState().id;
    act(() => setView('mix'));
    await settle(100);
    await act(async () => {
      await session.newFromStarter('techno');
    });
    act(() => setView('arrange'));
    await settle(100);
    await act(async () => {
      await session.openProject(first);
    });
    await settle(100);
    expect(uiStore.getState().view).toBe('mix');
  });
});

describe('beats', () => {
  const picker = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Start from a beat"]');

  it('in a fresh beat project a beat brings its tempo, says so, and Undo takes both back; the key stays to try another', async () => {
    await makeBeat();
    const bpm = session.store.getState().bpm;
    await click(await until(() => button('Start from a beat…'), 'Start from a beat…'));
    await until(picker, 'the picker');
    expect(picker()!.textContent).toContain('Each beat brings its own tempo to this new project.');
    const other = [...picker()!.querySelectorAll<HTMLButtonElement>('button[data-beat]')].find((b) => BEATS.find((x) => x.id === b.dataset.beat)!.bpm !== Math.round(bpm))!;
    const beat = BEATS.find((b) => b.id === other.dataset.beat)!;
    await click(other);
    expect(session.store.getState().bpm).toBe(beat.bpm);
    expect(document.body.textContent).toContain(`Tempo set to ${beat.bpm} BPM, ${beat.name}’s own (it was ${Math.round(bpm)}).`);
    await keys('{Escape}');
    await settle(100);
    // The loop has notes now: the key stays, worded for what it does then.
    expect(shown(button('Replace with a beat…'))).toBe(true);
    act(() => session.undo());
    await settle(60);
    expect(session.store.getState().bpm).toBe(bpm);
  });

  it('in a project with music the song keeps its tempo; each beat shows its own as a hint', async () => {
    await jumpIn();
    const drums = session.store.getState().tracks.find((t) => t.instrument.kind === 'drums')!;
    act(() => {
      selectTrack(drums.id);
      setPadMode('steps');
    });
    await settle(200);
    const bpm = session.store.getState().bpm;
    await click(await until(() => button('Replace with a beat…'), 'Replace with a beat…'));
    await until(picker, 'the picker');
    expect(picker()!.textContent).toContain(`Beats play at your song’s tempo, ${Math.round(bpm)} BPM.`);
    const first = picker()!.querySelector<HTMLButtonElement>('button[data-beat]')!;
    expect(first.textContent).toMatch(/best at \d+ BPM/);
    await click(first);
    expect(session.store.getState().bpm).toBe(bpm);
    await keys('{Escape}');
  });
});

describe('hints', () => {
  it('"Click squares…" only while Steps shows the drums; elsewhere a button goes there', async () => {
    await makeBeat();
    await until(() => document.querySelector('[data-hint="beat"]'), 'the beat hint');
    const lead = session.store.getState().tracks.find((t) => t.name === 'Lead')!;
    act(() => selectTrack(lead.id));
    await settle(300);
    const chip = document.querySelector<HTMLElement>('aside[data-hint="beat"]')!;
    expect(chip.textContent).toContain('Next, in Steps on Drums:');
    // The chip finds its new place for the longer words first.
    await settle(500);
    await click(button('Show me', chip)!);
    const drums = session.store.getState().tracks.find((t) => t.instrument.kind === 'drums')!;
    expect(uiStore.getState().selectedTrackId).toBe(drums.id);
    await settle(200);
    expect(document.querySelector<HTMLElement>('aside[data-hint="beat"]')!.textContent).not.toContain('Next, in');
  });
});

describe('toasts', () => {
  for (const [w, h] of [
    [1366, 768],
    [1920, 1080],
  ] as const) {
    it(`at ${w}: in the Song view they sit on the keyboard strip, never over the ruler, the sections or the rows`, async () => {
      await jumpIn(w, h);
      act(() => setView('arrange'));
      await settle(300);
      act(() => notify('Inserted 4 bars at bar 25.', 'info', 'undo'));
      await settle(500);
      const toast = [...document.querySelectorAll<HTMLElement>('[aria-live="polite"][aria-relevant] [role="status"]')].find((t) => t.textContent?.includes('Inserted 4 bars'))!;
      const t = toast.getBoundingClientRect();
      const sections = document.querySelector<HTMLElement>('[data-sections]')!.getBoundingClientRect();
      expect(t.top).toBeGreaterThan(sections.bottom);
      const keyboard = document.querySelector<HTMLElement>('section[aria-label="Keyboard"]')!.getBoundingClientRect();
      // On the strip (folded in Song: a line of words), reaching at most a little above it.
      expect(t.top).toBeGreaterThanOrEqual(keyboard.top - 16);
      expect(t.bottom).toBeLessThanOrEqual(keyboard.bottom);
      await page.screenshot({ path: `${SHOTS}/toast-song-${w}.png` });
      // Play › Steps: never over the header (part, loop, name and length).
      act(() => {
        setView('play');
        setPadMode('steps');
      });
      await settle(300);
      act(() => notify('New loop “Lead 1” (1 bar) on Lead. Click in the grid to add notes.', 'info', 'undo'));
      await settle(500);
      const t2 = [...document.querySelectorAll<HTMLElement>('[aria-live="polite"][aria-relevant] [role="status"]')].find((x) => x.textContent?.includes('New loop'))!.getBoundingClientRect();
      for (const field of document.querySelectorAll<HTMLElement>('[data-steps-root] input, [data-steps-root] [role="radiogroup"], [data-steps-root] [data-step], [data-steps-root] button')) {
        const r = field.getBoundingClientRect();
        // Rows scrolled out of the roll's view are not on screen.
        const box = field.closest('[class*="scroller"]')?.getBoundingClientRect();
        if (box && (r.top >= box.bottom || r.bottom <= box.top)) continue;
        expect(t2.top < r.bottom && r.top < t2.bottom && t2.left < r.right && r.left < t2.right, field.outerHTML.slice(0, 80)).toBe(false);
      }
      await page.screenshot({ path: `${SHOTS}/toast-steps-${w}.png` });
      // Loops: never over the selected pad's action bar (Edit steps, Duplicate, Move, Rename, Delete).
      act(() => setPadMode('loops'));
      await settle(300);
      act(() => notify('Undid: Duplicate.', 'info', 'redo'));
      await settle(500);
      const t3 = [...document.querySelectorAll<HTMLElement>('[aria-live="polite"][aria-relevant] [role="status"]')].find((x) => x.textContent?.includes('Undid'))!.getBoundingClientRect();
      for (const el of document.querySelectorAll<HTMLElement>('[data-pad-actions] button')) {
        const r = el.getBoundingClientRect();
        expect(t3.top < r.bottom && r.top < t3.bottom && t3.left < r.right && r.left < t3.right, el.textContent ?? '').toBe(false);
      }
      await page.screenshot({ path: `${SHOTS}/toast-loops-${w}.png` });
    });
  }
});

describe('the Song view', () => {
  it('a loop that plays in two places says "Used 2×", with a tooltip; the pads chip says what Space does', async () => {
    await jumpIn(1920, 1080);
    act(() => setView('arrange'));
    await settle(400);
    const badge = await until(() => [...document.querySelectorAll<HTMLElement>('[data-region-id] [title]')].find((b) => /^Used \d+×$/.test(b.textContent ?? '') && shown(b)), 'a "Used N×" badge');
    const n = badge.textContent!.match(/\d+/)![0];
    expect(badge.title).toBe(`This loop plays in ${n} places`);
    await page.screenshot({ path: `${SHOTS}/song-badges-1920.png` });
    // Pads playing: the chip's key tip is true to what Space does.
    act(() => patchRuntime({ playing: true, paused: false, mode: 'live' }));
    await settle(100);
    const playSong = await until(() => document.querySelector<HTMLElement>('[data-testid="play-the-song"]'), 'Play the song instead');
    expect(described(playSong.closest('[aria-describedby]') ?? playSong)).toContain('Space pauses the pads first; press it again to play the song.');
    act(() => patchRuntime({ playing: false, paused: true, mode: 'live' }));
    await settle(100);
    expect(described(document.querySelector<HTMLElement>('[data-testid="play-the-song"]')!.closest('[aria-describedby]')!)).toContain('Space does the same now.');
    act(() => patchRuntime({ playing: false, paused: false }));
  });
});

describe('the keyboard strip', () => {
  it('spans the strip in Steps after it was folded in Song (more keys when wide); Simple names no scale', async () => {
    await jumpIn(1920, 1080);
    act(() => setView('arrange'));
    await settle(200);
    act(() => setKeyboardCollapsed(true));
    await settle(100);
    act(() => {
      setView('play');
      setPadMode('steps');
      selectTrack('t4');
      setKeyboardCollapsed(false);
    });
    await settle(400);
    const strip = document.querySelector<HTMLElement>('section[aria-label="Keyboard"]')!;
    const keysShown = strip.querySelectorAll('[data-note]').length;
    expect(keysShown).toBeGreaterThanOrEqual(15);
    const note = [...strip.querySelectorAll<HTMLElement>('p[aria-live="polite"]')].find((p) => p.textContent?.startsWith('Only'))!;
    expect(note.textContent).toBe('Only notes that fit the song are shown.');
    expect(described(note.closest('[aria-describedby]') ?? note)).toMatch(/The song’s key is G Dorian/);
    await page.screenshot({ path: `${SHOTS}/keyboard-steps-1920.png` });
    act(() => setUiMode('advanced'));
    await settle(100);
    expect([...strip.querySelectorAll<HTMLElement>('p[aria-live="polite"]')].find((p) => p.textContent?.startsWith('Only'))!.textContent).toBe('Only G Dorian notes are shown.');
  });
});

describe('export', () => {
  it('the Export key says "Export the song as a file"', async () => {
    await jumpIn(1920, 1080);
    const key = button('Export', transport())!;
    expect(described(key.closest('[aria-describedby]') ?? key)).toContain('Export the song as a file');
  });
});
