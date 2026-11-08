/**
 * Round 7 fix 1: what the beginner re-test found, in the running app with a
 * real mouse (Simple mode).
 *
 * - "Add an intro" (and every edit that moves the song) while "Repeat this
 *   part" is on: the repeat follows the music it repeated, and the beat is
 *   still heard (engine meters), or it goes off with a word.
 * - "Make it longer" builds a song from a 1-bar beat around its main part:
 *   Intro · Verse · Chorus · Ending, about a minute, whatever the playhead.
 * - A ready-made loop put into a loop: the song plays all of it and the
 *   block says its name.
 * - Sheets: no way to another 2.4 view, no floating "Try this" chip.
 * - The tip line after a ready-made song opens: try a loop first.
 * - The editor and the Sound panel follow the instrument being worked on.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import type { MeterFrame } from '../../src/audio/contracts';
import { readyLoopsFor } from '../../src/app/views/arrange/library/readyLoops';
import { realizeFor } from '../../src/app/views/arrange/library/libraryModel';
import { editorStore, openLoopEditor } from '../../src/app/views/arrange/editorStore';
import { closeSound, openSound, sidePanelStore } from '../../src/app/views/arrange/sidePanelStore';
import { songSeconds } from '../../src/app/views/arrange/songHome';
import { regionEnd, songBars, sortSections } from '../../src/project/arrangement';
import { clipById } from '../../src/project/clips';
import type { Id } from '../../src/project/types';
import { setTipsEnabled, setUiMode, setView } from '../../src/state/uiStore';
import { centre, clickAt, menuItem, on, openSong, project, region, regions, resetSong, rt, sections, setSong, settle, teardownSong, trackId, waitFor } from './r5-song-helpers';

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const buttons = (text: RegExp) => [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].filter((b) => text.test(b.textContent ?? ''));

/** "Make a beat from scratch" and two "+ Add instrument"s: Drums, Bass and Chords, 1 bar each at bar 1, no sections. */
function oneBarBeat(): void {
  const p = project();
  const one = (name: string, idx: number) => region(`r-${name}`, trackId(name), p.tracks[idx].clips.find(Boolean)!.id, 0, 1);
  setSong([one('Drums', 0), one('Bass', 2), one('Chords', 3)]);
}

/** The highest peak each instrument reaches over `ms` of real playback. */
async function peaks(ms: number): Promise<Record<Id, number>> {
  const frame: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
  const out: Record<Id, number> = {};
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    session.readMeters(frame);
    for (const t of frame.tracks) out[t.trackId] = Math.max(out[t.trackId] ?? 0, t.peak);
    await settle(80);
  }
  return out;
}

async function longer(item: string | RegExp): Promise<void> {
  await clickAt(centre(byTestId('make-longer')!));
  const el = typeof item === 'string' ? menuItem(item) : [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((x) => item.test(x.textContent ?? ''))!;
  await clickAt(centre(el));
  await settle();
}

beforeEach(async () => {
  await resetSong('simple');
  act(() => closeSound());
});
afterEach(async () => {
  act(() => {
    closeSound();
    editorStore.setState(null);
  });
  await teardownSong();
});

describe('Repeat this part follows the music', () => {
  it('Add an intro while the beat repeats: the whole song repeats, beat included (not the intro’s first bar)', async () => {
    await openSong(1366, 768);
    oneBarBeat();
    act(() => session.setSongLoop({ fromBar: 0, toBar: 1 }));
    await settle();
    expect(byTestId('repeat-part')!.textContent).toBe('Repeating: the whole song');
    await longer('Add an intro');
    expect(sortSections(sections()).map((s) => s.name)).toEqual(['Intro', 'Verse']);
    // The repeat covers the intro and the beat (now the Verse), and says so.
    expect(rt().songLoop).toEqual({ fromBar: 0, toBar: songBars(project()) });
    expect(byTestId('repeat-part')!.textContent).toBe('Repeating: the whole song');
    const drums = trackId('Drums');
    const verse = sections().find((s) => s.name === 'Verse')!;
    expect(regions().some((r) => r.trackId === drums && r.start < rt().songLoop!.toBar && regionEnd(r) > verse.start)).toBe(true);
  });

  it('a repeated section keeps playing its music after an intro goes in before it (meters), and Undo brings it back', async () => {
    await openSong(1366, 768);
    const groove = sections().find((s) => s.name === 'Groove')!;
    act(() => session.setSongLoop({ fromBar: groove.start, toBar: regionEnd(groove) }));
    act(() => session.setSongCursor(groove.start));
    await act(async () => {
      await session.playSong();
    });
    await waitFor(() => rt().playing, 'the song playing');
    await longer('Add an intro');
    const now = sections().find((s) => s.id === groove.id)!;
    expect(rt().songLoop).toEqual({ fromBar: now.start, toBar: regionEnd(now) });
    expect(now.start).toBeGreaterThan(groove.start);
    expect(byTestId('repeat-part')!.textContent).toBe('Repeating: Groove');
    // The drums of Groove are heard (the intro's first bars have none).
    await settle(1200);
    const heard = await peaks(2500);
    expect(heard[trackId('Drums')] ?? 0).toBeGreaterThan(0.01);
    act(() => session.undo());
    await settle();
    expect(rt().songLoop).toEqual({ fromBar: groove.start, toBar: regionEnd(groove) });
  });

  it('goes off with a word when the part it repeated is deleted with its music', async () => {
    await openSong(1366, 768);
    const s = sortSections(sections())[1];
    act(() => session.setSongLoop({ fromBar: s.start + 1, toBar: s.start + 2 }));
    await settle();
    const { removeSectionNow } = await import('../../src/app/views/arrange/songActions');
    act(() => {
      removeSectionNow(s.id, true);
    });
    await settle();
    expect(rt().songLoop).toBeNull();
    // Said with the delete's own words, keeping its Undo.
    expect(rt().notice?.text).toMatch(/^Deleted .+ and its music\. What you were repeating is gone, so repeat is off/);
    expect(rt().notice?.action).toBe('undo');
    expect(byTestId('repeat-part')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('Advanced keeps 2.4’s absolute range', async () => {
    await openSong(1366, 768);
    act(() => setUiMode('advanced'));
    const groove = sections().find((s) => s.name === 'Groove')!;
    const loop = { fromBar: groove.start, toBar: regionEnd(groove) };
    act(() => session.setSongLoop(loop));
    const { addIntroNow } = await import('../../src/app/views/arrange/songActions');
    act(() => {
      addIntroNow();
    });
    await settle();
    expect(rt().songLoop).toEqual(loop);
  });
});

describe('Make it longer', () => {
  it('turns a 1-bar beat into Intro · Verse · Chorus · Ending, about a minute, from the main part whatever the playhead', async () => {
    await openSong(1366, 768);
    oneBarBeat();
    await settle();
    await longer('Add an intro');
    act(() => session.setSongCursor(0));
    await settle();
    // The playhead is in the Intro: the menu still offers the main part.
    await clickAt(centre(byTestId('make-longer')!));
    expect(menuItem('Repeat Verse again')).toBeTruthy();
    expect(menuItem('Add a section after Verse')).toBeTruthy();
    await clickAt(centre(menuItem('Add a section after Verse')));
    await settle();
    expect(rt().notice?.text).toBe('Added Chorus after Verse: it plays the music of Verse, ready to change');
    await longer('Add an ending');
    const p = project();
    expect(sortSections(p.arrangement.sections).map((s) => s.name)).toEqual(['Intro', 'Verse', 'Chorus', 'Ending']);
    expect(songSeconds(p)).toBeGreaterThanOrEqual(55);
    expect(byTestId('song-length')!.textContent).toMatch(/^· 1:0\d$/);
    // Chorus plays all three instruments (the main part's music, not the intro's build-up).
    const chorus = sections().find((s) => s.name === 'Chorus')!;
    const inChorus = new Set(regions().filter((r) => r.start < regionEnd(chorus) && regionEnd(r) > chorus.start).map((r) => r.trackId));
    expect(inChorus.size).toBe(3);
    // The whole song is in view after it grew (the Ending's last loop ends inside the visible lanes).
    const sc = byTestId('lane-scroller')!.getBoundingClientRect();
    const last = [...regions()].sort((a, b) => regionEnd(b) - regionEnd(a))[0];
    expect(document.querySelector<HTMLElement>(`[data-region-id="${last.id}"]`)!.getBoundingClientRect().right).toBeLessThanOrEqual(sc.right + 1);
  });
});

describe('a ready-made loop in the song', () => {
  it('plays all of it in the song and the block says its name', async () => {
    await openSong(1366, 768);
    oneBarBeat();
    await settle();
    const chords = trackId('Chords');
    const t = project().tracks.find((x) => x.id === chords)!;
    // A ready-made loop longer than the 1-bar loop in the song.
    const pick = readyLoopsFor(t.role, t.instrument.kind).find((l) => (realizeFor(project(), l, t)?.bars ?? 0) >= 2)!;
    expect(pick).toBeTruthy();
    const longBars = realizeFor(project(), pick, t)!.bars;
    // Its own loop (a loop of the song's own), as + Add instrument makes one.
    const { makeLoopDifferent } = await import('../../src/app/views/arrange/songActions');
    act(() => {
      makeLoopDifferent('r-Chords');
    });
    await clickAt(on('r-Chords'));
    await waitFor(() => !!editorStore.getState(), 'the editor');
    await clickAt(centre(buttons(/^Try a ready-made loop…$/)[0]));
    await clickAt(centre(document.querySelector<HTMLElement>(`[data-ready-loop="${pick.id}"]`)!));
    await settle();
    const r = regions().find((x) => x.id === 'r-Chords')!;
    expect(r.bars).toBe(longBars);
    const clip = clipById(project().tracks.find((x) => x.id === chords)!, r.clipId)!;
    expect(clip.name.startsWith(pick.name)).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-region-id="r-Chords"]')!.textContent).toContain(pick.name);
    // The other instruments play on with it.
    expect(regions().map((x) => regionEnd(x))).toEqual([longBars, longBars, longBars]);
  });
});

describe('sheets', () => {
  it('lead nowhere but back to the song, and the floating “Try this” chip never shows in Simple', async () => {
    await openSong(1366, 768);
    act(() => setTipsEnabled(true));
    for (const view of ['play', 'mix', 'shape'] as const) {
      act(() => setView(view));
      await settle(200);
      expect(document.querySelector(`[data-sheet="${view}"]`), view).not.toBeNull();
      expect(buttons(/Back to Play|Open in Shape|^Go to Play$/), view).toEqual([]);
      expect(document.querySelectorAll('aside[data-hint]').length, view).toBe(0);
      // The part panel's "Shape" (Jam pads) is gone too.
      if (view === 'play') expect(buttons(/^Shape$/), view).toEqual([]);
    }
    act(() => setView('arrange'));
    await settle(200);
    expect(document.querySelectorAll('aside[data-hint]').length).toBe(0);
    // Advanced keeps 2.4's ways and the chip.
    act(() => {
      setUiMode('advanced');
      setView('shape');
    });
    await settle(200);
    expect(buttons(/Back to Play/).length).toBe(1);
  });
});

describe('the tip line and the instrument being worked on', () => {
  it('a ready-made song first says to try a loop; a click on one moves the tip on', async () => {
    await openSong(1366, 768);
    act(() => setTipsEnabled(true));
    await settle();
    expect(byTestId('song-tip')!.dataset.step).toBe('try');
    expect(byTestId('song-tip')!.textContent).toContain('Click any loop in your song to change its notes');
    await clickAt(on(regions()[0].id));
    await waitFor(() => !!editorStore.getState(), 'the editor');
    await settle();
    expect(byTestId('song-tip')!.dataset.step).toBe('share');
  });

  it('+ Add instrument with the editor open: the editor and the Sound panel follow', async () => {
    await openSong(1366, 768);
    oneBarBeat();
    // Only drums: Bass and Chords are offered.
    setSong(regions().filter((r) => r.id === 'r-Drums'));
    await settle();
    act(() => {
      openLoopEditor(project(), 'r-Drums');
      openSound(trackId('Drums'));
    });
    await settle();
    await clickAt(centre(byTestId('add-instrument')!));
    await clickAt(centre(menuItem('Bass')));
    await settle(200);
    expect(editorStore.getState()?.trackId).toBe(trackId('Bass'));
    act(() => session.stop());
    // The Sound panel shows what the editor shows: Bass's sound open, then a click on the drums loop.
    act(() => openSound(trackId('Bass')));
    await clickAt(on('r-Drums'));
    expect(editorStore.getState()?.trackId).toBe(trackId('Drums'));
    expect(sidePanelStore.getState()).toEqual({ kind: 'sound', trackId: trackId('Drums') });
  });
});
