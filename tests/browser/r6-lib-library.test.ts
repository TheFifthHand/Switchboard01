/**
 * The Song view's loop library and the region/row menus that make loops of
 * the song's own, in real Chromium with a real mouse and keys:
 *
 * - the browser's two tabs; the Library's Part and Style chips and search;
 * - a library loop dragged onto a part's row (or added with Enter) becomes a
 *   loop of the song's own and a region, in one undo step "Add <name>"; onto
 *   the wrong kind of part it is refused in words;
 * - ▶ plays the loop's notes on the part's instrument, timed on the audio
 *   clock, and a second press stops it;
 * - "Make this one different", the "Used 3×" badge, "Put on a pad";
 * - a row's empty spot: "New empty loop" and "Start from a beat…";
 * - the section menu's Move earlier / Move later;
 * - the empty song's card (library/EmptySong);
 * - screenshots at 1366 × 768 and 1920 × 1080.
 */
import { act, createElement as h } from 'react';
import { cdp, page } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { previewStore, stopPreview } from '../../src/app/preview';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { EmptySong } from '../../src/app/views/arrange/library/EmptySong';
import { addClipWhereScenePlays } from '../../src/app/views/arrange/songActions';
import { libraryQueryStore } from '../../src/app/views/arrange/library/LibraryPanel';
import { editorStore } from '../../src/app/views/arrange/editorStore';
import { browserTabStore } from '../../src/app/views/arrange/LoopBrowser';
import { ppbStore } from '../../src/app/views/arrange/laneStore';
import { clipById } from '../../src/project/clips';
import { TICKS_PER_BAR, type Project } from '../../src/project/types';
import { selectTrack } from '../../src/state/uiStore';
import { ticksToSeconds } from '../../src/time/clock';
import { isInScale } from '../../src/music/scales';
import { mount } from './ui-harness';
import {
  barX,
  centre,
  clickAt,
  doubleClickAt,
  dragCursorNow,
  dragTo,
  menuItem,
  on,
  openSong,
  press,
  project,
  region,
  regionEl,
  regions,
  release,
  resetSong,
  rightClickAt,
  rowY,
  setSong,
  settle,
  teardownSong,
  trackId,
  undoCount,
  waitFor,
  advancedMode,
} from './r5-song-helpers';

// Screenshots for a person to look at, beside the test results (git-ignored); the path is relative to this file.
const SHOTS = '../../test-results/shots-lanelib';

const emptySong = (p: Project) => {
  p.arrangement.regions = [];
  p.arrangement.sections = [];
};

beforeEach(async () => {
  await resetSong();
  act(() => {
    libraryQueryStore.setState(null);
    browserTabStore.setState(null);
    editorStore.setState(null);
  });
});
afterEach(async () => {
  stopPreview();
  await teardownSong();
});

const browser = () => document.querySelector<HTMLElement>('[data-testid="loop-browser"]')!;
const tab = (id: 'song' | 'library') => document.querySelector<HTMLElement>(`[data-testid="loops-tab-${id}"]`)!;
const libRow = (id: string) => {
  const el = document.querySelector<HTMLElement>(`[data-library-loop="${id}"]`);
  if (!el) throw new Error(`No library row ${id}: ${[...document.querySelectorAll<HTMLElement>('[data-library-loop]')].map((x) => x.dataset.libraryLoop).join(', ')}`);
  el.scrollIntoView({ block: 'nearest' });
  return el;
};
const listed = () => [...document.querySelectorAll<HTMLElement>('[data-library-loop]')].map((x) => x.dataset.libraryLoop!);
const notice = () => runtimeStore.getState().notice?.text ?? '';
const songClipsOf = (name: string) => project().tracks.find((t) => t.name === name)!.songClips ?? [];

/** The loop browser shown (a long song opens with it hidden). */
async function showBrowser(): Promise<void> {
  if (document.querySelector('[data-testid="loop-browser"]')) return;
  await clickAt(centre(document.querySelector('[data-testid="loops-toggle"]')!));
  await waitFor(() => !!document.querySelector('[data-testid="loop-browser"]'), 'the loop browser');
}

async function openLibrary(): Promise<void> {
  await showBrowser();
  // (Simple's LOOPS is the library alone, with no tabs.)
  const libTab = document.querySelector('[data-testid="loops-tab-library"]');
  if (libTab) await clickAt(centre(libTab));
  await waitFor(() => !!document.querySelector('[data-testid="loop-library"]'), 'the library');
}

/** Show the library with this search and chips (set straight, for tests about something else). */
async function showLoops(text: string, role: 'drums' | 'bass' | 'chords' | null = null): Promise<void> {
  act(() => libraryQueryStore.setState({ text, role, genre: null }));
  await openLibrary();
}

async function typeText(text: string): Promise<void> {
  await act(async () => {
    await cdp().send('Input.insertText', { text });
  });
  await settle(60);
}

describe('the browser’s tabs and the library list', () => {
  it('This song is first in a song with loops; Library lists loops by part, style and search', async () => {
    // 2.4's Song view controls: Advanced since round 7.
    advancedMode();
    await openSong(1366, 768);
    await showBrowser();
    expect(tab('song').getAttribute('aria-selected')).toBe('true');
    expect(browser().querySelector('[data-scene-row]')).toBeTruthy();
    // Drums is the selected part: the library opens on its loops (Beats).
    act(() => selectTrack(trackId('Drums')));
    await openLibrary();
    expect(document.querySelector('[data-role-chip="drums"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(listed().length).toBeGreaterThan(5);
    expect(listed().every((id) => id.startsWith('beat-'))).toBe(true);
    // The Bass chip: bass loops only.
    await clickAt(centre(document.querySelector('[data-role-chip="bass"]')!));
    expect(document.querySelector('[data-role-chip="bass"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(listed().every((id) => id.startsWith('loop-bass-'))).toBe(true);
    const bassCount = listed().length;
    // A style narrows it.
    const style = document.querySelector<HTMLElement>('[data-style-chip="trap"]')!;
    await clickAt(centre(style));
    expect(listed().length).toBeGreaterThan(0);
    expect(listed().length).toBeLessThan(bassCount);
    // Pressed again: every style again.
    await clickAt(centre(document.querySelector('[data-style-chip="trap"]')!));
    expect(listed().length).toBe(bassCount);
    // Search: typed words narrow the list (every word must match), and the count says how many.
    await clickAt(centre(document.querySelector('[data-role-chip="bass"]')!));
    await clickAt(centre(document.querySelector('[data-testid="library-search"]')!));
    await typeText('steady four');
    expect(listed()[0]).toBe('beat-steady-four');
    expect(document.querySelector('[data-testid="library-count"]')!.textContent).toMatch(/^\d+ loops? · drag onto a part, or press Enter$/);
    await typeText(' zzz');
    expect(listed()).toEqual([]);
    expect(document.querySelector('[data-testid="library-count"]')!.textContent).toBe('No loops match.');
  });

  it('a project with few loops of its own opens on the Library; a long list shows more on request', async () => {
    // 2.4's Song view controls: Advanced since round 7.
    advancedMode();
    await openSong(1366, 768, (p) => {
      emptySong(p);
      for (const t of p.tracks) t.clips = t.clips.map(() => null);
      p.scenes = p.scenes.slice(0, 1);
      for (const t of p.tracks) t.clips = t.clips.slice(0, 1);
    });
    await waitFor(() => !!document.querySelector('[data-testid="loop-library"]'), 'the library tab');
    expect(tab('library').getAttribute('aria-selected')).toBe('true');
    act(() => libraryQueryStore.setState({ text: '', role: null, genre: null }));
    await settle();
    expect(listed()).toHaveLength(30);
    const more = document.querySelector<HTMLElement>('[data-testid="library-more"]')!;
    more.scrollIntoView({ block: 'nearest' });
    await clickAt(centre(more));
    expect(listed()).toHaveLength(60);
    // The tabs take arrow keys.
    tab('library').focus();
    await press('ArrowLeft');
    expect(tab('song').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('song'));
  });
});

describe('adding a library loop to the song', () => {
  it('dragged onto a drum row: the row lights, the loop is drawn where it lands, and the drop adds it (one undo step)', async () => {
    await openSong(1366, 768, emptySong);
    act(() => ppbStore.setState(32));
    await showLoops('steady four', 'drums');
    const drums = trackId('Drums');
    const before = undoCount();
    const to = { x: barX(4) + 8, y: rowY(drums) };
    await dragTo(centre(libRow('beat-steady-four'), 0.6), to, { release: false });
    const ghost = document.querySelector<HTMLElement>('[data-testid="library-ghost"] [data-ghost]')!;
    expect(ghost).toBeTruthy();
    expect(ghost.textContent).toContain('Steady Four');
    expect(ghost.getBoundingClientRect().left).toBeCloseTo(barX(4), -1);
    expect(dragCursorNow()).toBe('grabbing');
    expect(regions()).toEqual([]);
    await release(to);
    expect(regions()).toHaveLength(1);
    const r = regions()[0];
    expect(r).toMatchObject({ trackId: drums, start: 4, bars: 1, offset: 0 });
    const clip = songClipsOf('Drums').find((c) => c.id === r.clipId)!;
    expect(clip.name).toBe('Steady Four');
    expect(clip.notes.length).toBeGreaterThan(4);
    expect(undoCount()).toBe(before + 1);
    expect(session.store.undoLabel()).toBe('Add Steady Four');
    expect(document.querySelector('[data-testid="library-ghost"]')).toBeNull();
    expect(dragCursorNow()).toBeNull();
    // The new loop is selected; Undo takes the loop and its region away together.
    expect(regionEl(r.id).getAttribute('aria-pressed')).toBe('true');
    act(() => session.undo());
    expect(regions()).toEqual([]);
    expect(songClipsOf('Drums')).toEqual([]);
  });

  it('dropped on the wrong kind of part: the pointer says what it needs, and the drop is refused in words', async () => {
    await openSong(1366, 768, emptySong);
    await showLoops('steady four', 'drums');
    const bass = trackId('Bass');
    const before = undoCount();
    const to = { x: barX(2) + 8, y: rowY(bass) };
    await dragTo(centre(libRow('beat-steady-four'), 0.6), to, { release: false });
    expect(document.querySelector('[data-testid="library-not-here"]')!.textContent).toBe('Drums only');
    expect(dragCursorNow()).toBe('not-allowed');
    await release(to);
    expect(regions()).toEqual([]);
    expect(undoCount()).toBe(before);
    expect(notice()).toBe('“Steady Four” is a drum loop and Bass plays notes: put it on a drum or percussion instrument.');
  });

  it('Escape while carrying adds nothing', async () => {
    await openSong(1366, 768, emptySong);
    await showLoops('steady four', 'drums');
    const to = { x: barX(2) + 8, y: rowY(trackId('Drums')) };
    await dragTo(centre(libRow('beat-steady-four'), 0.6), to, { release: false });
    await press('Escape');
    await release(to);
    expect(regions()).toEqual([]);
  });

  it('Enter adds it at the song cursor on its kind of part, in the song’s key, and says where', async () => {
    await openSong(1366, 768, emptySong);
    act(() => patchRuntime({ songCursor: 8 }));
    act(() => selectTrack(trackId('Drums')));
    await showLoops('', 'bass');
    const id = listed()[0];
    libRow(id).focus();
    await press('Enter');
    expect(regions()).toHaveLength(1);
    const r = regions()[0];
    expect(r.trackId).toBe(trackId('Bass'));
    expect(r.start).toBe(8);
    const clip = songClipsOf('Bass')[0];
    expect(notice()).toBe(`Added ${clip.name} to Bass at bar 9`);
    // Every note is in the song's key.
    const p = project();
    for (const n of clip.notes) expect(isInScale(n.pitch, p.root, p.scale)).toBe(true);
    // Again, further on: a second copy gets its own name. (At the same bar it would replace the first.)
    act(() => patchRuntime({ songCursor: 16 }));
    libRow(id).focus();
    await press('Enter');
    expect(songClipsOf('Bass').map((c) => c.name)).toEqual([clip.name, `${clip.name} 2`]);
  });
});

describe('hearing a library loop', () => {
  it('▶ plays its notes on the part’s instrument, timed on the audio clock; a second press stops it', async () => {
    await openSong(1366, 768, emptySong);
    await act(async () => {
      await session.startAudio();
    });
    await showLoops('steady four', 'drums');
    const engine = session.engine!;
    const ctx = session.ctx!;
    const calls: { trackId: string; time: number; pitch: number; at: number }[] = [];
    const orig = engine.scheduleNote.bind(engine);
    engine.scheduleNote = (id, n) => {
      calls.push({ trackId: id, time: n.time, pitch: n.pitch, at: ctx.currentTime });
      return orig(id, n);
    };
    try {
      const play = libRow('beat-steady-four').querySelector<HTMLElement>('[data-testid="library-audition"]')!;
      const t0 = ctx.currentTime;
      await clickAt(centre(play));
      await waitFor(() => previewStore.getState() !== null, 'the preview');
      const s = previewStore.getState()!;
      expect(s.key).toBe('beat-steady-four');
      expect(s.trackId).toBe(trackId('Drums'));
      expect(s.start).toBeGreaterThanOrEqual(t0);
      expect(play.getAttribute('aria-pressed')).toBe('true');
      // One bar at the song's tempo, give or take the last note's length.
      const bar = ticksToSeconds(TICKS_PER_BAR, project().bpm);
      await waitFor(() => calls.length > 6, 'notes handed to the engine');
      expect(calls.every((c) => c.trackId === trackId('Drums'))).toBe(true);
      // Each note is handed over a little ahead of its time (look-ahead), never after it, at a time on the loop's grid.
      for (const c of calls) {
        expect(c.time).toBeGreaterThanOrEqual(c.at - 0.03);
        const tick = ((c.time - s.start) / bar) * TICKS_PER_BAR;
        expect(Math.abs(tick - Math.round(tick / 6) * 6)).toBeLessThan(0.5);
      }
      const n = calls.length;
      // A second press stops it: nothing more is handed over.
      await clickAt(centre(play));
      expect(previewStore.getState()).toBeNull();
      expect(play.getAttribute('aria-pressed')).toBe('false');
      await settle(300);
      expect(calls.length).toBe(n);
      // Played to its end on its own, it stops by itself.
      await clickAt(centre(play));
      await waitFor(() => previewStore.getState() === null, 'the preview to end', bar * 1000 + 3000);
    } finally {
      engine.scheduleNote = orig;
    }
  });

  it('while the song plays, ▶ is unavailable and says why; starting the song stops a loop being heard', async () => {
    await openSong(1366, 768);
    await act(async () => {
      await session.startAudio();
    });
    await showLoops('steady four', 'drums');
    const play = () => libRow('beat-steady-four').querySelector<HTMLElement>('[data-testid="library-audition"]')!;
    await clickAt(centre(play()));
    await waitFor(() => previewStore.getState() !== null, 'the preview');
    await act(async () => {
      await session.playSong();
    });
    await settle();
    expect(previewStore.getState()).toBeNull();
    expect(play().getAttribute('aria-disabled')).toBe('true');
    await clickAt(centre(play()));
    expect(previewStore.getState()).toBeNull();
    act(() => session.stop());
    await settle();
    expect(play().getAttribute('aria-disabled')).toBeNull();
  });
});

describe('the region menu', () => {
  it('a loop that plays in 3 places shows “Used 3×”; Make this one different gives one region its own copy', async () => {
    await openSong(1366, 768);
    const drums = trackId('Drums');
    const clip = project().tracks[0].clips[1]!;
    setSong([region('A', drums, clip.id, 0, 4), region('B', drums, clip.id, 4, 4), region('C', drums, clip.id, 8, 4)]);
    await settle();
    for (const id of ['A', 'B', 'C']) {
      expect(regionEl(id).dataset.places).toBe('3');
      expect(regionEl(id).querySelector('[class*="places"]')!.textContent).toBe('Used 3×');
      expect(regionEl(id).getAttribute('aria-label')).toContain('this loop plays in 3 places');
    }
    await rightClickAt(on('B'));
    expect(menuItem('Make this one different').textContent).toContain('Plays in 3 places');
    const before = undoCount();
    await clickAt(centre(menuItem('Make this one different')));
    const b = regions().find((r) => r.id === 'B')!;
    expect(b.clipId).not.toBe(clip.id);
    const copy = clipById(project().tracks[0], b.clipId)!;
    expect(copy.name).toBe(`${clip.name} 2`);
    expect(copy.notes.map((n) => [n.tick, n.pitch])).toEqual(clip.notes.map((n) => [n.tick, n.pitch]));
    expect(undoCount()).toBe(before + 1);
    expect(notice()).toContain('edits to it change only bars 5–8');
    await settle();
    expect(regionEl('A').dataset.places).toBe('2');
    expect(regionEl('B').dataset.places).toBeUndefined();
    expect(regionEl('B').querySelector('[class*="places"]')).toBeNull();
  });

  it('Put on a pad copies a loop of the song’s own onto the part’s first empty pad', async () => {
    await openSong(1366, 768, emptySong);
    await showLoops('steady four', 'drums');
    libRow('beat-steady-four').focus();
    act(() => selectTrack(trackId('Drums')));
    await press('Enter');
    const r = regions()[0];
    const t0 = project().tracks[0];
    const free = t0.clips.findIndex((c) => c === null);
    expect(free).toBeGreaterThanOrEqual(0);
    await rightClickAt(on(r.id));
    // A loop that plays once and is not on a pad has nothing to be different from.
    expect(() => menuItem('Make this one different')).toThrow();
    await clickAt(centre(menuItem('Put on a pad')));
    const pad = project().tracks[0].clips[free]!;
    expect(pad.name).toBe('Steady Four');
    expect(pad.notes.length).toBe(clipById(project().tracks[0], r.clipId)!.notes.length);
    expect(notice()).toMatch(/^Put a copy of Steady Four on the Drums pad in /);
    // The song still plays its own loop.
    expect(regions()[0].clipId).toBe(r.clipId);
  });
});

describe('an empty spot on a row', () => {
  it('New empty loop: a loop of that many bars with no notes, opened in the editor below', async () => {
    await openSong(1366, 768, emptySong);
    act(() => ppbStore.setState(32));
    await settle();
    const lead = trackId('Lead');
    // Left of the empty song's card (its buttons sit across the middle rows).
    await doubleClickAt({ x: barX(2) + 10, y: rowY(lead) });
    const key = document.querySelector<HTMLElement>('[role="menu"] [data-row="new-loop"][data-bars="4"]')!;
    expect(key.getAttribute('aria-label')).toBe('New empty loop, 4 bars');
    await clickAt(centre(key));
    expect(regions()).toMatchObject([{ trackId: lead, start: 2, bars: 4 }]);
    const clip = songClipsOf('Lead')[0];
    expect(clip).toMatchObject({ name: 'Lead 1', bars: 4, notes: [] });
    expect(editorStore.getState()).toMatchObject({ trackId: lead, clipId: clip.id });
    expect(session.store.undoLabel()).toBe('Add Lead 1');
    // No more "make a loop on the pads in Play first".
    expect(document.body.textContent).not.toContain('on the pads in Play first');
  });

  it('Start from a beat… (drum parts): beats by style with ▶; choosing one puts it there', async () => {
    await openSong(1366, 768, emptySong);
    act(() => ppbStore.setState(32));
    await settle();
    // A melodic part has no beats to offer.
    await doubleClickAt({ x: barX(3) + 10, y: rowY(trackId('Bass')) });
    expect(() => menuItem('Start from a beat')).toThrow();
    await press('Escape');
    const perc = trackId('Percussion');
    await doubleClickAt({ x: barX(3) + 10, y: rowY(perc) });
    await clickAt(centre(menuItem('Start from a beat')));
    const list = document.querySelector<HTMLElement>('[data-testid="beat-picker"]')!;
    expect(list.querySelectorAll('[data-beat]').length).toBe(52);
    expect(list.textContent).toContain('Boom Bap');
    await act(async () => {
      await session.startAudio();
    });
    const hear = list.querySelector<HTMLElement>('[data-beat-hear="beat-steady-four"]')!;
    hear.scrollIntoView({ block: 'nearest' });
    await clickAt(centre(hear));
    await waitFor(() => previewStore.getState()?.key === 'beat-steady-four', 'the beat heard');
    expect(previewStore.getState()!.trackId).toBe(perc);
    const beat = list.querySelector<HTMLElement>('[data-beat="beat-steady-four"]')!;
    await clickAt(centre(beat));
    // Choosing closes the menu (and stops the beat being heard) and places it.
    expect(previewStore.getState()).toBeNull();
    expect(regions()).toMatchObject([{ trackId: perc, start: 3, bars: 1 }]);
    expect(songClipsOf('Percussion')[0].name).toBe('Steady Four');
    expect(notice()).toBe('Added Steady Four to Percussion at bar 4');
  });
});

describe('the section menu', () => {
  it('Move earlier / Move later move a section one place with its music; the ends say why not', async () => {
    await openSong(1366, 768);
    const first = project().arrangement.sections[0];
    const second = project().arrangement.sections[1];
    const el = document.querySelector<HTMLElement>(`[data-section-id="${first.id}"]`)!;
    await rightClickAt(centre(el));
    expect(menuItem('Move earlier').getAttribute('aria-disabled')).toBe('true');
    expect(menuItem('Move earlier').textContent).toContain('Already the first section');
    await clickAt(centre(menuItem('Move later')));
    const now = project().arrangement.sections;
    expect(now.find((s) => s.id === first.id)!.start).toBe(second.bars);
    expect(now.find((s) => s.id === second.id)!.start).toBe(0);
    expect(notice()).toBe(`${first.name} moved later`);
  });
});

describe('a pad clip made in a scene the song uses', () => {
  it('goes where that scene plays (each place the part is free), in one undo step', async () => {
    await openSong(1366, 768, (p) => {
      const lead = p.tracks.find((t) => t.name === 'Lead')!;
      lead.clips[1] = { ...structuredClone(lead.clips[2]!), id: 'clip-lead-groove', name: 'Lead 1' };
    });
    const lead = trackId('Lead');
    const before = undoCount();
    let r: ReturnType<typeof addClipWhereScenePlays> = null;
    act(() => {
      r = addClipWhereScenePlays(lead, 1);
    });
    expect(r!.changed).toBe(true);
    expect(regions().filter((x) => x.clipId === 'clip-lead-groove').map((x) => [x.start, x.bars])).toEqual([
      [8, 16],
      [64, 8],
    ]);
    expect(undoCount()).toBe(before + 1);
    expect(session.store.undoLabel()).toBe('Add Lead 1 where Groove plays');
    expect(notice()).toBe('Added Lead 1 where Groove plays (2 places)');
    // Again: the part is no longer free there, so nothing more is offered.
    expect(addClipWhereScenePlays(lead, 1)).toBeNull();
  });
});

describe('the empty song', () => {
  it('says what to do in one line, with Open the loop library (and Make a song from my scenes)', async () => {
    // 2.4's Song view controls: Advanced since round 7.
    advancedMode();
    await openSong(1366, 768, emptySong);
    act(() => browserTabStore.setState({ projectId: project().id, tab: 'song' }));
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:200px;--head-w:0px;--ruler-h:0px;--sections-h:0px';
    document.body.appendChild(host);
    const m = mount(h(EmptySong, { hasScenes: true }));
    host.appendChild(m.container);
    await settle();
    const card = m.container.querySelector<HTMLElement>('[data-testid="song-empty"]')!;
    expect(card.querySelector('p')!.textContent).toBe('The song is empty. Add loops from the library, or drag a scene or a loop here.');
    expect(card.querySelector('[data-testid="empty-make-song"]')).toBeTruthy();
    // Hide the browser, then open the library from the card: it shows on its Library tab, search focused.
    await clickAt(centre(document.querySelector('[data-testid="loops-toggle"]')!));
    expect(document.querySelector('[data-testid="loop-browser"]')).toBeNull();
    await clickAt(centre(card.querySelector('[data-testid="empty-open-library"]')!));
    await waitFor(() => !!document.querySelector('[data-testid="loop-library"]'), 'the library');
    expect(tab('library').getAttribute('aria-selected')).toBe('true');
    await waitFor(() => document.activeElement === document.querySelector('[data-testid="library-search"]'), 'the search focused');
    host.remove();
  });
});

describe('screenshots', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
  ] as const) {
    it(`the library, a carried loop and the beat picker at ${w}`, async () => {
      await openSong(w, hh);
      act(() => selectTrack(trackId('Bass')));
      await openLibrary();
      await settle(200);
      await page.screenshot({ path: `${SHOTS}/library-${w}.png` });
      const drums = trackId('Drums');
      const clip = project().tracks[0].clips[1]!;
      setSong([region('A', drums, clip.id, 0, 4), region('B', drums, clip.id, 4, 4), region('C', drums, clip.id, 8, 4)]);
      act(() => libraryQueryStore.setState({ text: '', role: 'drums', genre: null }));
      await settle();
      const to = { x: barX(14) + 8, y: rowY(drums) };
      await dragTo(centre(libRow('beat-steady-four'), 0.6), to, { release: false });
      await settle(150);
      await page.screenshot({ path: `${SHOTS}/carry-${w}.png` });
      await release(to);
      await doubleClickAt({ x: barX(20) + 10, y: rowY(drums) });
      await clickAt(centre(menuItem('Start from a beat')));
      await settle(150);
      await page.screenshot({ path: `${SHOTS}/beats-${w}.png` });
      await press('Escape');
      await rightClickAt(on('B'));
      await settle(150);
      await page.screenshot({ path: `${SHOTS}/region-menu-${w}.png` });
      await press('Escape');
    });
  }
});
