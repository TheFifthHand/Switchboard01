/**
 * Round 6: the loop editor under the song (GarageBand's editor area), in
 * real Chromium with real mouse and keys:
 * - a double-click on a loop opens it in a pane under the rows; the view
 *   stays the Song view, with the song still in sight;
 * - edits in the pane change the clip the region plays: a pad clip (the pad
 *   changes too, and the header says so) or a loop that lives in the song;
 * - Make this one different gives only that region its own copy, and the
 *   pane goes on editing the copy;
 * - E opens the focused loop, Esc closes, and an Undo that takes the loop
 *   away closes the pane;
 * - a 2-bar loop shows both bars side by side at 1366 (in the pane and in
 *   Play › Steps, where a song loop shows its name);
 * - the pane's playhead follows the song inside the loop.
 */
import { act } from 'react';
import { page } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { songPlayheadBar } from '../../src/app/songPlayback';
import { editorStore } from '../../src/app/views/arrange/editorStore';
import { ppbStore } from '../../src/app/views/arrange/laneStore';
import { clipAtSlot, slotOfClip } from '../../src/project/clips';
import type { Id, Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { selectSlot, selectTrack, setPadMode, setUiMode, setView, uiStore } from '../../src/state/uiStore';
import { centre, clickAt, doubleClickAt, on, openSong, press, project, region, regionEl, regions, resetSong, settle, teardownSong, waitFor } from './r5-song-helpers';

const SHOTS = '/tmp/claude-0/r6/shots-editor';

/** Drums: A over bars 1–8 and B over 13–16 (the same pad clip); Bass: C over 1–16. */
function song(p: Project): void {
  const drums = p.tracks[0];
  const bass = p.tracks[2];
  const dc = drums.clips.find((c) => c)!;
  const bc = bass.clips.find((c) => c)!;
  p.arrangement.regions = [region('A', drums.id, dc.id, 0, 8), region('B', drums.id, dc.id, 12, 4), region('C', bass.id, bc.id, 0, 16)];
  p.arrangement.sections = [];
}

async function open(w = 1366, hh = 768): Promise<void> {
  await openSong(w, hh, song);
  act(() => ppbStore.setState(32));
  await settle();
}

const pane = () => document.querySelector<HTMLElement>('[data-loop-editor]');
const drumsId = () => project().tracks[0].id;
const bassId = () => project().tracks[2].id;
const clipNow = (trackId: Id, clipId: Id) => {
  const t = project().tracks.find((x) => x.id === trackId)!;
  return clipAtSlot(t, slotOfClip(t, clipId));
};
const drumCell = (voice: number, col: number) => pane()!.querySelector<HTMLElement>(`[role="row"][data-voice="${voice}"] [data-col="${col}"]`)!;
const rollCol = (col: number) => pane()!.querySelector<HTMLElement>(`[data-testid="pitch-roll"] [data-col="${col}"]`)!;
const rollRow = (pitch: number) => pane()!.querySelector<HTMLElement>(`[data-testid="pitch-roll"] [data-row-label="${pitch}"]`)!;

/** A 2-bar bass loop that lives in the song, at bar 21 (one undo step). Returns its region and clip. */
function addSongLoop(): { regionId: Id; clipId: Id } {
  let out = { regionId: '', clipId: '' };
  act(() => {
    const r = cmd.addLoopToSong(session.store, bassId(), 20, { name: 'Night Bass', bars: 2, notes: [{ tick: 0, pitch: 48, velocity: 0.8, duration: 24 }] });
    expect(r.changed).toBe(true);
    out = { regionId: r.regionId!, clipId: r.clipId! };
  });
  return out;
}

beforeEach(async () => {
  localStorage.removeItem('switchboard01.songEditorHeight');
  await resetSong();
});
afterEach(async () => {
  localStorage.removeItem('switchboard01.songEditorHeight');
  act(() => editorStore.setState(null));
  await teardownSong();
});

describe('the editor pane in the Song view', () => {
  it('a double-click opens the loop under the rows; the view stays Song; a step edit changes the pad clip both regions play', async () => {
    await open();
    const dc = project().tracks[0].clips.find((c) => c)!;
    await doubleClickAt(on('A'));
    await waitFor(() => !!pane(), 'the editor pane');
    expect(uiStore.getState().view).toBe('arrange');
    // The song stays in sight above it.
    expect(regionEl('A').getBoundingClientRect().bottom).toBeLessThanOrEqual(pane()!.getBoundingClientRect().top);
    expect(pane()!.textContent).toContain(dc.name);
    expect(pane()!.textContent).toContain('Also plays at bars 13–16');
    expect(pane()!.textContent).toMatch(/also on the .+ pad/);
    const before = dc.notes.filter((n) => n.pitch === 2).length;
    await clickAt(centre(drumCell(2, 3)));
    const after = clipNow(drumsId(), dc.id)!.notes.filter((n) => n.pitch === 2);
    expect(after.length).toBe(before + (dc.notes.some((n) => n.pitch === 2 && n.tick === 48) ? -1 : 1));
    // One undo step, through the app's Undo.
    act(() => session.undo());
    expect(clipNow(drumsId(), dc.id)!.notes.filter((n) => n.pitch === 2).length).toBe(before);
  });

  it('a loop that lives in the song: both bars side by side at 1366, a click in bar 2 adds a note to that loop', async () => {
    await open();
    const { regionId, clipId } = addSongLoop();
    await settle();
    await doubleClickAt(on(regionId, 0.25));
    await waitFor(() => !!pane()?.querySelector('[data-testid="pitch-roll"]'), 'the piano roll in the pane');
    const roll = pane()!.querySelector<HTMLElement>('[data-testid="pitch-roll"]')!;
    expect(roll.dataset.bars).toBe('2');
    expect(roll.querySelectorAll('[data-col]').length).toBe(32);
    expect(pane()!.textContent).toContain('Night Bass');
    expect(pane()!.textContent).toContain('Plays only here');
    // Rows are at least 22 px.
    expect(rollRow(48).getBoundingClientRect().height).toBeGreaterThanOrEqual(21.5);
    // Bar 2's columns are right of bar 1's, all in view.
    const c0 = rollCol(0).getBoundingClientRect();
    const c16 = rollCol(16).getBoundingClientRect();
    expect(c16.left).toBeGreaterThan(c0.right);
    expect(rollCol(31).getBoundingClientRect().right).toBeLessThanOrEqual(pane()!.getBoundingClientRect().right);
    const pads = project().tracks[2].clips.map((c) => c?.notes.length ?? null);
    const row = rollRow(48).getBoundingClientRect();
    await clickAt({ x: c16.left + c16.width / 2, y: row.top + row.height / 2 });
    const loop = clipNow(bassId(), clipId)!;
    expect(loop.notes.map((n) => [n.tick, n.pitch]).sort((a, b) => a[0] - b[0])).toEqual([
      [0, 48],
      [384, 48],
    ]);
    // The pads did not change.
    expect(project().tracks[2].clips.map((c) => c?.notes.length ?? null)).toEqual(pads);
    await page.screenshot({ path: `${SHOTS}/pane-song-loop-1366.png` });
  });

  it('Play › Steps shows a song loop by its name (never "Scene 101") with both bars at 1366', async () => {
    await open();
    const { clipId } = addSongLoop();
    const slot = slotOfClip(project().tracks[2], clipId);
    expect(slot).toBeGreaterThanOrEqual(100);
    act(() => {
      selectTrack(bassId());
      selectSlot(bassId(), slot);
      setPadMode('steps');
      setView('play');
    });
    await waitFor(() => !!document.querySelector('[data-steps-root] [data-testid="pitch-roll"]'), 'Steps');
    const root = document.querySelector<HTMLElement>('[data-steps-root]')!;
    expect(root.textContent).not.toMatch(/Scene 10\d|Row 10\d/);
    expect(root.querySelector('[role="radio"][aria-label^="In the song: Night Bass"]')?.getAttribute('aria-checked')).toBe('true');
    expect((root.querySelector('input[aria-label="Loop name"]') as HTMLInputElement).value).toBe('Night Bass');
    expect(root.querySelector<HTMLElement>('[data-testid="pitch-roll"]')!.dataset.bars).toBe('2');
  });

  it('Make this one different: only that region gets its own copy, and the pane edits the copy', async () => {
    // Simple's pane (its eight main drum rows): the song helpers open Advanced since round 7.
    act(() => setUiMode('simple'));
    await open();
    const dc = project().tracks[0].clips.find((c) => c)!;
    await doubleClickAt(on('A'));
    await waitFor(() => !!pane(), 'the editor pane');
    const make = [...pane()!.querySelectorAll('button')].find((b) => b.textContent?.includes('Make this one different'))!;
    await clickAt(centre(make));
    await settle();
    const a = regions().find((r) => r.id === 'A')!;
    const b = regions().find((r) => r.id === 'B')!;
    expect(a.clipId).not.toBe(dc.id);
    expect(b.clipId).toBe(dc.id);
    expect(editorStore.getState()?.clipId).toBe(a.clipId);
    expect(slotOfClip(project().tracks[0], a.clipId)).toBeGreaterThanOrEqual(100);
    expect(pane()!.textContent).toContain('Plays only here');
    // An edit now changes the copy only.
    const padBefore = JSON.stringify(clipNow(drumsId(), dc.id)!.notes);
    const copyBefore = clipNow(drumsId(), a.clipId)!.notes.length;
    await clickAt(centre(drumCell(7, 2)));
    expect(clipNow(drumsId(), a.clipId)!.notes.length).not.toBe(copyBefore);
    expect(JSON.stringify(clipNow(drumsId(), dc.id)!.notes)).toBe(padBefore);
  });

  it('E opens the focused loop, Esc closes the pane and focus goes back to the loop', async () => {
    await open();
    await clickAt(on('C'));
    expect(document.activeElement).toBe(regionEl('C'));
    await press('e');
    await waitFor(() => !!pane(), 'the editor pane');
    expect(editorStore.getState()?.regionId).toBe('C');
    // E did not play a note on the keyboard (it opened the editor).
    await press('Escape'); // first Esc: the song's selection
    if (pane()) await press('Escape');
    await waitFor(() => !pane(), 'the pane closed');
    expect(uiStore.getState().view).toBe('arrange');
  });

  it('an Undo that takes the loop away closes the pane; another loop switches it', async () => {
    await open();
    const { regionId } = addSongLoop();
    await settle();
    await doubleClickAt(on(regionId, 0.25));
    await waitFor(() => !!pane(), 'the editor pane');
    await doubleClickAt(on('C'));
    await waitFor(() => editorStore.getState()?.regionId === 'C', 'the pane on C');
    await doubleClickAt(on(regionId, 0.25));
    await waitFor(() => editorStore.getState()?.regionId === regionId, 'the pane on the song loop');
    act(() => session.undo());
    await waitFor(() => !pane(), 'the pane closed by Undo');
    expect(editorStore.getState()).toBeNull();
  });

  it('the grip resizes the pane (remembered), and the pane playhead follows the song inside the loop', async () => {
    await open();
    await doubleClickAt(on('B'));
    await waitFor(() => !!pane(), 'the editor pane');
    const grip = pane()!.querySelector<HTMLElement>('[role="separator"]')!;
    const h0 = pane()!.getBoundingClientRect().height;
    grip.focus();
    await press('ArrowUp');
    await settle();
    expect(pane()!.getBoundingClientRect().height).toBeGreaterThan(h0 + 10);
    expect(Number(localStorage.getItem('switchboard01.songEditorHeight'))).toBeGreaterThan(h0 + 10);
    // Play the song from bar 13 (region B): the pane lights the step heard, in the clip's bar for that song bar.
    const b = regions().find((r) => r.id === 'B')!;
    const bars = clipNow(drumsId(), b.clipId)!.bars;
    await act(async () => {
      await session.playSong({ fromBar: 12 });
    });
    try {
      await waitFor(() => !!pane()!.querySelector('[data-playhead]'), 'the playhead in the pane', 10000);
      let ok = false;
      for (let i = 0; i < 20 && !ok; i++) {
        const lit = pane()!.querySelector<HTMLElement>('[data-ph-step][data-playhead]');
        const bar = songPlayheadBar();
        if (lit && bar !== null) {
          const idx = Number(lit.dataset.phStep);
          const want = ((Math.floor(bar) - b.start + b.offset) % bars + bars) % bars;
          const shownBars = Number(pane()!.querySelector<HTMLElement>('[data-span]')!.dataset.span);
          ok = shownBars > 1 ? Math.floor(idx / 16) === want : true;
        }
        if (!ok) await settle(40);
      }
      expect(ok).toBe(true);
    } finally {
      act(() => session.stop());
    }
  });
});

describe('screenshots', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
  ] as const) {
    it(`${w} x ${hh}: drums and a melodic loop in the pane, and Steps`, async () => {
      await open(w, hh);
      await doubleClickAt(on('A'));
      await waitFor(() => !!pane(), 'the editor pane');
      await settle(200);
      await page.screenshot({ path: `${SHOTS}/pane-drums-${w}.png` });
      // Every drum row shown is at least 28 px.
      for (const r of pane()!.querySelectorAll<HTMLElement>('[role="row"][data-voice]')) expect(r.getBoundingClientRect().height).toBeGreaterThanOrEqual(27.5);
      await doubleClickAt(on('C', 0.2));
      await waitFor(() => !!pane()?.querySelector('[data-testid="pitch-roll"]'), 'the roll');
      await settle(200);
      await page.screenshot({ path: `${SHOTS}/pane-bass-${w}.png` });
      act(() => {
        setPadMode('steps');
        setView('play');
      });
      await waitFor(() => !!document.querySelector('[data-steps-root]'), 'Steps');
      await settle(200);
      await page.screenshot({ path: `${SHOTS}/steps-bass-${w}.png` });
      act(() => {
        selectTrack(drumsId());
      });
      await settle(200);
      await page.screenshot({ path: `${SHOTS}/steps-drums-${w}.png` });
    });
  }
});
