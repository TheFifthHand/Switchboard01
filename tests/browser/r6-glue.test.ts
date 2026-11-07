/**
 * Round-6 glue, in real Chromium with a real mouse:
 *
 * - the empty song shows the empty-song card; its Open the loop library
 *   shows a hidden browser on the Library tab with the search focused;
 * - a pad loop made in a scene the song plays is offered once ("Add Lead 1
 *   to the song where Groove plays (2 places)?" [Add]); Add puts it there in
 *   one undo step; nothing is offered for the song's own copies (Put on a
 *   pad), during a performance, or for an edit that makes several loops; a
 *   loop made while a pad records is offered when the recording stops; Undo
 *   of the loop takes the offer away;
 * - a library loop carried to the timeline's right edge scrolls the song
 *   and lands where the pointer is after the scroll;
 * - screenshots at 1366 × 768 and 1920 × 1080.
 */
import { act } from 'react';
import { page } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore, withdrawOffer } from '../../src/app/runtime';
import { emptySongText } from '../../src/app/views/arrange/library/EmptySong';
import { libraryQueryStore } from '../../src/app/views/arrange/library/LibraryPanel';
import { browserTabStore } from '../../src/app/views/arrange/LoopBrowser';
import { dragStore, ppbStore } from '../../src/app/views/arrange/laneStore';
import { putLoopOnPad } from '../../src/app/views/arrange/songActions';
import { sceneOfferText } from '../../src/app/views/arrange/songModel';
import type { Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { startHints } from '../../src/app/views/hints';
import { setTipsEnabled } from '../../src/state/uiStore';
import { barX, centre, clickAt, dragTo, mouse, openSong, project, region, regions, release, resetSong, rowY, scroller, settle, teardownSong, trackId, undoCount, waitFor, advancedMode } from './r5-song-helpers';

// Screenshots for a person to look at, beside the test results (git-ignored); the path is relative to this file.
const SHOTS = '../../test-results/shots-glue';

beforeEach(async () => {
  await resetSong();
  act(() => {
    withdrawOffer();
    libraryQueryStore.setState(null);
    browserTabStore.setState(null);
  });
});
afterEach(async () => {
  act(() => withdrawOffer());
  await teardownSong();
});

const emptySong = (p: Project) => {
  p.arrangement.regions = [];
  p.arrangement.sections = [];
};

const offerText = () => runtimeStore.getState().offer?.text ?? null;
/** The toast showing the offer, if any. */
const offerToast = () => [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((el) => el.textContent?.includes('to the song where')) ?? null;

/**
 * Scene 1 (row 0, Intro) plays at bars 1 and 9 (Drums and Percussion there);
 * Lead plays nothing and has no loop on its row-0 pad.
 */
const sceneSong = (p: Project) => {
  const [drums, perc] = p.tracks;
  const lead = p.tracks.find((t) => t.name === 'Lead')!;
  lead.clips[0] = null;
  p.arrangement.sections = [];
  p.arrangement.regions = [region('d1', drums.id, drums.clips[0]!.id, 0, 4), region('p1', perc.id, perc.clips[0]!.id, 0, 4), region('d2', drums.id, drums.clips[0]!.id, 8, 4)];
};

describe('the empty song', () => {
  it('shows the empty-song card; Open the loop library shows a hidden browser on its Library tab, search focused', async () => {
    // 2.4's Song view controls: Advanced since round 7.
    advancedMode();
    await openSong(1366, 768, emptySong);
    const card = document.querySelector<HTMLElement>('[data-testid="song-empty"]')!;
    expect(card.textContent).toContain(emptySongText(true));
    // Hide the browser (it opens by itself for a short song), then ask for the library from the card.
    await clickAt(centre(document.querySelector('[data-testid="loops-toggle"]')!));
    await waitFor(() => !document.querySelector('[data-testid="loop-browser"]'), 'the browser hidden');
    await clickAt(centre(document.querySelector('[data-testid="empty-open-library"]')!));
    await waitFor(() => !!document.querySelector('[data-testid="loop-library"]'), 'the library shown');
    expect(document.querySelector('[data-testid="loops-tab-library"]')!.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => document.activeElement === document.querySelector('[data-testid="library-search"]'), 'the search focused');
  });
});

describe('scenes → song: the offer after a pad loop is made', () => {
  it('a loop made on a pad of a scene the song plays: offered once; Add puts it where the scene plays (one undo step)', async () => {
    await openSong(1366, 768, sceneSong);
    const lead = trackId('Lead');
    const scene = project().scenes[0].name;
    act(() => {
      session.accepted(cmd.createClip(session.store, lead, 0, 1));
    });
    await settle(150);
    const clip = project().tracks.find((t) => t.id === lead)!.clips[0]!;
    expect(offerText()).toBe(sceneOfferText(clip.name, scene, 2));
    const toast = offerToast()!;
    expect(toast).toBeTruthy();
    const add = [...toast.querySelectorAll('button')].find((b) => b.textContent === 'Add')!;
    const before = undoCount();
    await clickAt(centre(add));
    await settle(150);
    expect(regions().filter((r) => r.trackId === lead).map((r) => [r.clipId, r.start, r.bars])).toEqual([
      [clip.id, 0, 4],
      [clip.id, 8, 4],
    ]);
    expect(undoCount()).toBe(before + 1);
    expect(session.store.undoLabel()).toBe(`Add ${clip.name} where ${scene} plays`);
    expect(offerText()).toBeNull();
    expect(offerToast()).toBeNull();
    // Editing that loop afterwards offers nothing more.
    act(() => {
      session.accepted(cmd.setClipBars(session.store, lead, 0, 2));
    });
    expect(offerText()).toBeNull();
  });

  it('Undo of the new loop takes the offer away; Redo does not offer it again', async () => {
    await openSong(1366, 768, sceneSong);
    const lead = trackId('Lead');
    act(() => {
      session.accepted(cmd.createClip(session.store, lead, 0, 1));
    });
    expect(offerText()).not.toBeNull();
    act(() => session.undo());
    expect(offerText()).toBeNull();
    act(() => session.redo());
    expect(offerText()).toBeNull();
  });

  it('nothing is offered for Put on a pad, during a performance, or for a row the song does not play', async () => {
    await openSong(1366, 768, sceneSong);
    const lead = trackId('Lead');
    // Put on a pad: the song's own copy lands on Lead's free row-0 pad.
    let songClip = '';
    act(() => {
      const r = cmd.addLoopToSong(session.store, lead, 20, { bars: 1 });
      songClip = r.clipId!;
    });
    act(() => {
      putLoopOnPad(lead, songClip);
    });
    expect(project().tracks.find((t) => t.id === lead)!.clips[0]).not.toBeNull();
    expect(offerText()).toBeNull();
    // A performance recording: nothing, then or after.
    act(() => session.undo());
    expect(project().tracks.find((t) => t.id === lead)!.clips[0]).toBeNull();
    act(() => patchRuntime({ recording: 'performance' }));
    act(() => {
      expect(session.accepted(cmd.createClip(session.store, lead, 0, 1))).toBe(true);
    });
    act(() => patchRuntime({ recording: 'off' }));
    expect(offerText()).toBeNull();
    // A scene the song does not play (row 1, Groove, is not in this song).
    let made = false;
    act(() => {
      made = session.accepted(cmd.createClip(session.store, trackId('Pad'), 1, 1));
    });
    expect(made).toBe(true);
    expect(offerText()).toBeNull();
  });

  it('a loop made while a pad records is offered when the recording stops (with notes in it)', async () => {
    await openSong(1366, 768, sceneSong);
    const lead = trackId('Lead');
    act(() => patchRuntime({ recording: 'notes', recordTarget: { trackId: lead, slot: 0 } }));
    act(() => {
      session.accepted(cmd.createClip(session.store, lead, 0, 1));
      session.accepted(cmd.addNote(session.store, lead, 0, { tick: 0, pitch: 72, velocity: 0.8, duration: 96 }));
    });
    expect(offerText()).toBeNull();
    act(() => patchRuntime({ recording: 'off', recordTarget: null }));
    const clip = project().tracks.find((t) => t.id === lead)!.clips[0]!;
    expect(offerText()).toBe(sceneOfferText(clip.name, project().scenes[0].name, 2));
  });

  it('a pass that recorded nothing offers nothing', async () => {
    await openSong(1366, 768, sceneSong);
    const lead = trackId('Lead');
    act(() => patchRuntime({ recording: 'notes', recordTarget: { trackId: lead, slot: 0 } }));
    act(() => {
      session.accepted(cmd.createClip(session.store, lead, 0, 1));
    });
    act(() => patchRuntime({ recording: 'off', recordTarget: null }));
    expect(offerText()).toBeNull();
  });
});

describe('carrying a library loop', () => {
  it('to the timeline’s right edge: the song scrolls, and the loop lands where the pointer is', async () => {
    const long = (p: Project) => {
      const drums = p.tracks[0];
      p.arrangement.sections = [];
      p.arrangement.regions = [region('A', drums.id, drums.clips[0]!.id, 0, 64)];
    };
    await openSong(1366, 768, long);
    act(() => ppbStore.setState(32));
    await settle();
    act(() => libraryQueryStore.setState({ text: 'steady four', role: 'drums', genre: null }));
    if (!document.querySelector('[data-testid="loop-browser"]')) await clickAt(centre(document.querySelector('[data-testid="loops-toggle"]')!));
    await waitFor(() => !!document.querySelector('[data-testid="loop-browser"]'), 'the browser');
    // (Simple's LOOPS is the library alone, with no tabs.)
    const libTab = document.querySelector('[data-testid="loops-tab-library"]');
    if (libTab) await clickAt(centre(libTab));
    await waitFor(() => !!document.querySelector('[data-library-loop="beat-steady-four"]'), 'the library row');
    const sc = scroller();
    expect(sc.scrollLeft).toBe(0);
    const drums = trackId('Drums');
    const view = sc.getBoundingClientRect();
    const y = rowY(drums);
    const row = document.querySelector<HTMLElement>('[data-library-loop="beat-steady-four"]')!;
    // Well inside the rows first (crossing the edge on the way in does not scroll), then to the right edge.
    await dragTo(centre(row, 0.6), { x: view.left + sc.clientWidth / 2, y }, { release: false });
    expect(sc.scrollLeft).toBe(0);
    const edgeX = view.left + sc.clientWidth - 2;
    // The bar under the drop point before any scroll.
    const unscrolled = Math.floor((edgeX - 120 - barX(0)) / 32);
    await mouse('mouseMoved', { x: edgeX, y }, { buttons: 1 });
    // (At most 2 bars a second, eased in.)
    await waitFor(() => sc.scrollLeft > 3 * 32, 'the song scrolled by itself', 6000);
    await mouse('mouseMoved', { x: edgeX - 120, y }, { buttons: 1 });
    await settle(200);
    // The ghost and its bar follow the scroll.
    expect(document.querySelector('[data-testid="library-ghost"]')).toBeTruthy();
    const badge = dragStore.getState()?.badge?.text ?? '';
    const bar = Number(/^Bar (\d+)$/.exec(badge)?.[1]) - 1;
    expect(bar).toBeGreaterThanOrEqual(unscrolled + 3);
    expect(Math.abs(barX(bar) - (edgeX - 120))).toBeLessThan(32);
    await page.screenshot({ path: `${SHOTS}/carry-scrolled-1366.png` });
    const before = undoCount();
    await release({ x: edgeX - 120, y });
    expect(undoCount()).toBe(before + 1);
    expect(session.store.undoLabel()).toBe('Add Steady Four');
    expect(regions().some((r) => r.trackId === drums && r.start === bar && r.clipId !== project().tracks[0].clips[0]!.id)).toBe(true);
    expect(document.querySelector('[data-testid="library-ghost"]')).toBeNull();
  });
});

describe('screenshots', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
  ] as const) {
    it(`the empty song with the hint chip at ${w}`, async () => {
      await openSong(w, hh, emptySong);
      act(() => {
        setTipsEnabled(true);
        startHints();
      });
      await settle(1200);
      await page.screenshot({ path: `${SHOTS}/empty-song-${w}.png` });
      act(() => setTipsEnabled(false));
    });

    it(`the offer toast at ${w}`, async () => {
      await openSong(w, hh, sceneSong);
      act(() => {
        session.accepted(cmd.createClip(session.store, trackId('Lead'), 0, 1));
      });
      await settle(400);
      expect(offerToast()).toBeTruthy();
      await page.screenshot({ path: `${SHOTS}/offer-${w}.png` });
    });
  }
});
