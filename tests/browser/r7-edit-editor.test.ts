/**
 * Round 7: the Song screen's editor (EASY_SPEC §5) in real Chromium, real
 * mouse and keys:
 * - Simple shows Draw | Play, Try a ready-made…, Shorter / Longer, Make it
 *   different and "Plays 2 places" [Just here]; nothing else (no velocity
 *   lane, no 16-sound switch, no row zoom). Advanced keeps 2.4's;
 * - Shorter / Longer change the loop's length (Longer repeats it), Make it
 *   different is Variation on this loop, each one undo step;
 * - Try a ready-made loop… puts a library loop for the instrument in this
 *   loop, in key; ten tries are one undo step; Try a ready-made beat… leaves
 *   a playing song playing;
 * - Play shows the instrument's pads (kit pads; note pads with Chords and
 *   Lower / Higher), and Record into this loop repeats this place of the
 *   song while what is played goes into this loop (one undo step), then
 *   gives the song its repeat back;
 * - the pane fits under the song at 1366 x 768, Draw and Play.
 */
import { act } from 'react';
import { page } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { editorModeStore, editorStore } from '../../src/app/views/arrange/editorStore';
import { ppbStore } from '../../src/app/views/arrange/laneStore';
import { realizeFor } from '../../src/app/views/arrange/library/libraryModel';
import { fitReadyLoop, readyLoopsFor } from '../../src/app/views/arrange/library/readyLoops';
import { clipAtSlot, slotOfClip } from '../../src/project/clips';
import { isInScale } from '../../src/music/scales';
import type { Id, Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { setUiMode, uiStore } from '../../src/state/uiStore';
import { centre, clickAt, doubleClickAt, mouse, on, openSong, project, region, regions, resetSong, settle, teardownSong, waitFor } from './r5-song-helpers';

/** Screenshots for the report, in the ignored .vitest folder (relative to this file); never a reason to fail. */
const shot = (name: string) => page.screenshot({ path: `../../.vitest/shots-r7-edit/${name}` }).catch(() => undefined);

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
const button = (text: string, root: ParentNode | null = pane()) => [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent?.trim() === text) ?? null;
const radio = (name: string) => [...pane()!.querySelectorAll<HTMLElement>('[role="radio"]')].find((b) => b.textContent?.includes(name))!;
const regionClip = (id: Id) => {
  const r = regions().find((x) => x.id === id)!;
  const t = project().tracks.find((x) => x.id === r.trackId)!;
  const slot = slotOfClip(t, r.clipId);
  return { slot, clip: clipAtSlot(t, slot)! };
};
// Every property a change can touch: a variation may only lengthen a note or play it softer.
const notesSig = (id: Id) =>
  regionClip(id)
    .clip.notes.map((n) => `${n.tick}:${n.pitch}:${n.duration}:${n.velocity}`)
    .sort()
    .join(',');

async function openRegion(id: Id): Promise<void> {
  await doubleClickAt(on(id));
  await waitFor(() => !!pane(), 'the editor pane');
  await settle(150);
}

/** Interactive controls a person can see in the pane (buttons, sliders, radios, the grid cells count as one). */
function visibleControls(root: HTMLElement): number {
  const els = [...root.querySelectorAll<HTMLElement>('button, [role="slider"], input, select, [role="radio"]')].filter((el) => {
    if (el.closest('[role="grid"]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  });
  return els.length + (root.querySelector('[role="grid"], [data-testid="pitch-roll"]') ? 1 : 0);
}

beforeEach(async () => {
  localStorage.removeItem('switchboard01.songEditorHeight');
  await resetSong('simple');
  act(() => editorModeStore.setState('draw'));
});
afterEach(async () => {
  localStorage.removeItem('switchboard01.songEditorHeight');
  act(() => {
    editorStore.setState(null);
    editorModeStore.setState('draw');
  });
  await teardownSong();
});

describe('the editor in Simple', () => {
  it('shows Draw | Play, Try a ready-made beat…, Shorter / Longer, Make it different, "Plays 2 places" and Just here; nothing more', async () => {
    await open();
    await openRegion('A');
    const text = pane()!.textContent!;
    for (const words of ['Draw', 'Play', 'Try a ready-made beat…', 'Shorter', 'Longer', 'Make it different', 'Plays 2 places', 'Just here']) expect(text, words).toContain(words);
    // No bar numbers for where it plays, no pads, no velocity, no 16-sound switch, no row zoom.
    expect(text).not.toContain('Also plays at');
    expect(text).not.toContain('pad');
    expect(pane()!.querySelector('[data-testid="velocity-lane"]')).toBeNull();
    expect(text).not.toMatch(/Show all 16|Main sounds/);
    expect(pane()!.querySelector('[aria-label="Row height"]')).toBeNull();
    // The length in seconds (the drums loop is 1 bar at 124 BPM).
    expect(text).toMatch(/\d(\.\d)? seconds?/);
    // The pane fits under the song at 1366 x 768: no page scroll.
    expect(pane()!.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight);
    const count = visibleControls(pane()!);
    console.log(`[r7-edit] Simple editor (drums, Draw) controls: ${count}`);
    await shot(`editor-draw-drums-1366.png`);

    // Just here: this place gets its own loop; the other keeps the shared one.
    const shared = regions().find((r) => r.id === 'A')!.clipId;
    await clickAt(centre(button('Just here')!));
    await settle();
    expect(regions().find((r) => r.id === 'A')!.clipId).not.toBe(shared);
    expect(regions().find((r) => r.id === 'B')!.clipId).toBe(shared);
    expect(pane()!.textContent).toContain('Plays only here');
    expect(button('Just here')).toBeNull();
    act(() => session.undo());
    await settle();
    expect(regions().find((r) => r.id === 'A')!.clipId).toBe(shared);
  });

  it('Advanced keeps 2.4: bar numbers, the velocity lane and Make this one different', async () => {
    await open();
    act(() => setUiMode('advanced'));
    // Advanced shows every instrument's row, so the loop moves down: let the rows settle first.
    await settle();
    await openRegion('C');
    expect(pane()!.querySelector('[data-testid="velocity-lane"]')).not.toBeNull();
    expect(pane()!.querySelector('[aria-label="Row height"]')).not.toBeNull();
    expect(pane()!.textContent).toMatch(/Plays only here|also on the/);
    expect(pane()!.textContent).toMatch(/\d bars?/);
  });

  it('Longer doubles the loop by repeating it, Shorter halves it (the cut notes said), each one undo step', async () => {
    await open();
    await openRegion('C');
    const before = regionClip('C').clip;
    const n = before.notes.length;
    expect(before.bars).toBe(2);
    await clickAt(centre(button('Longer')!));
    expect(regionClip('C').clip.bars).toBe(4);
    expect(regionClip('C').clip.notes.length).toBe(2 * n);
    act(() => session.undo());
    expect(regionClip('C').clip.bars).toBe(2);
    const late = before.notes.filter((x) => x.tick >= 384).length;
    await clickAt(centre(button('Shorter')!));
    expect(regionClip('C').clip.bars).toBe(1);
    expect(regionClip('C').clip.notes.length).toBe(n - late);
    if (late > 0) expect(runtimeStore.getState().notice?.text ?? '').toMatch(/went: Undo brings/);
    act(() => session.undo());
    expect(regionClip('C').clip.notes.length).toBe(n);
  });

  it('Make it different varies a loop that lives in the song, as one undo step', async () => {
    await open();
    let regionId = '';
    act(() => {
      const notes = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ tick: i * 96, pitch: 43 + (i % 3) * 2, velocity: 0.8, duration: 48 }));
      const r = cmd.addLoopToSong(session.store, bassId(), 20, { name: 'Night Bass', bars: 2, notes });
      regionId = r.regionId!;
    });
    await settle();
    await openRegion(regionId);
    const before = notesSig(regionId);
    const steps = session.store.historySize().undo;
    await clickAt(centre(button('Make it different')!));
    await settle();
    expect(notesSig(regionId)).not.toBe(before);
    expect(session.store.historySize().undo).toBe(steps + 1);
    act(() => session.undo());
    expect(notesSig(regionId)).toBe(before);
  });
});

describe('ready-made loops and beats', () => {
  it('Try a ready-made loop… puts a bass loop in this loop, in key; trying three leaves one undo step', async () => {
    await open();
    await openRegion('C');
    const before = notesSig('C');
    const steps = session.store.historySize().undo;
    await clickAt(centre(button('Try a ready-made loop…')!));
    await waitFor(() => !!document.querySelector('[data-testid="ready-loops"]'), 'the ready-made loops');
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[data-ready-loop]')];
    expect(rows.length).toBeGreaterThan(5);
    const p = project();
    const bass = p.tracks[2];
    expect(rows.map((r) => r.dataset.readyLoop)).toEqual(readyLoopsFor(bass.role, bass.instrument.kind).map((l) => l.id));
    await shot(`editor-ready-loops-1366.png`);
    for (const row of rows.slice(0, 3)) await clickAt(centre(row));
    const third = readyLoopsFor(bass.role, bass.instrument.kind)[2];
    const want = fitReadyLoop(realizeFor(p, third, bass)!, 2);
    const clip = regionClip('C').clip;
    expect(clip.bars).toBe(want.bars);
    expect(clip.notes.map((n) => `${n.tick}:${n.pitch}`).sort()).toEqual(want.notes.map((n) => `${n.tick}:${n.pitch}`).sort());
    if (p.scale !== 'chromatic') for (const n of clip.notes) expect(isInScale(n.pitch, p.root, p.scale)).toBe(true);
    expect(rows[2].getAttribute('aria-pressed')).toBe('true');
    expect(session.store.historySize().undo).toBe(steps + 1);
    act(() => session.undo());
    expect(notesSig('C')).toBe(before);
  });

  it('Try a ready-made beat… puts a beat in the drum loop and a playing song plays on', async () => {
    await open();
    await act(async () => {
      await session.playSong({ fromBar: 0 });
    });
    await openRegion('A');
    const before = notesSig('A');
    await clickAt(centre(button('Try a ready-made beat…')!));
    const beat = () => document.querySelector<HTMLElement>('[role="dialog"] button[data-beat]');
    await waitFor(() => !!beat(), 'the beats');
    await shot(`editor-ready-beat-1366.png`);
    await clickAt(centre(beat()!));
    await settle();
    expect(notesSig('A')).not.toBe(before);
    const rt = runtimeStore.getState();
    expect(rt.mode).toBe('song');
    expect(rt.playing).toBe(true);
    act(() => session.undo());
    expect(notesSig('A')).toBe(before);
  });
});

describe('Play', () => {
  it('drums: the kit’s 16 pads; Record into this loop repeats this place and keeps what is played, as one undo step', async () => {
    await open();
    await openRegion('A');
    await clickAt(centre(radio('Play')));
    await waitFor(() => (pane()?.querySelectorAll('[data-pad-grid] button').length ?? 0) === 16, 'the kit pads');
    expect(pane()!.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    const grid = pane()!.querySelector<HTMLElement>('[data-pad-grid]')!;
    expect(grid.getBoundingClientRect().bottom).toBeLessThanOrEqual(pane()!.getBoundingClientRect().bottom + 0.5);
    console.log(`[r7-edit] Simple editor (drums, Play) controls: ${visibleControls(pane()!)}`);
    await shot(`editor-play-drums-1366.png`);

    const { slot } = regionClip('A');
    const voice = 9;
    const had = regionClip('A').clip.notes.filter((n) => n.pitch === voice).length;
    const steps = session.store.historySize().undo;
    await clickAt(centre(button('Record into this loop')!));
    await waitFor(() => runtimeStore.getState().recording === 'notes', 'recording');
    const rt = runtimeStore.getState();
    expect(rt.mode).toBe('song');
    expect(rt.songLoop).toEqual({ fromBar: 0, toBar: 8 });
    expect(rt.recordTarget).toEqual({ trackId: drumsId(), slot });
    expect(pane()!.textContent).toContain('Recording: play along');
    // A real press on a pad (pointer down, held a moment, up).
    const pad = pane()!.querySelector<HTMLElement>(`#drum-pad-${voice}`)!;
    await settle(300);
    const at = centre(pad, 0.5, 0.4);
    await mouse('mouseMoved', at);
    await mouse('mousePressed', at);
    await settle(80);
    await mouse('mouseReleased', at);
    await settle(200);
    await clickAt(centre(button('Stop recording')!));
    await waitFor(() => runtimeStore.getState().recording === 'off', 'recording stopped');
    expect(regionClip('A').clip.notes.filter((n) => n.pitch === voice).length).toBe(had + 1);
    // The repeat goes back to what it was (none).
    expect(runtimeStore.getState().songLoop).toBeNull();
    expect(session.store.historySize().undo).toBe(steps + 1);
    act(() => session.undo());
    expect(regionClip('A').clip.notes.filter((n) => n.pitch === voice).length).toBe(had);
  });

  it('a melodic loop: note pads with Chords and Lower / Higher; a chord pad plays a chord', async () => {
    await open();
    await openRegion('C');
    act(() => editorModeStore.setState('play'));
    await waitFor(() => (pane()?.querySelectorAll('[data-pad-grid] button').length ?? 0) === 16, 'the note pads');
    expect(pane()!.textContent).toContain('Record into this loop');
    expect(pane()!.textContent).toContain('Every square plays a note that fits your song.');
    const octave = uiStore.getState().notesOctave;
    await clickAt(centre(button('Higher')!));
    expect(uiStore.getState().notesOctave).toBe(octave + 1);
    await clickAt(centre(button('Lower')!));
    expect(uiStore.getState().notesOctave).toBe(octave);
    const chords = pane()!.querySelector<HTMLElement>('[role="switch"]')!;
    await clickAt(centre(chords));
    await waitFor(() => !!pane()!.querySelector('[data-chord]'), 'chord pads');
    await shot(`editor-play-chords-1366.png`);
    const pad = pane()!.querySelector<HTMLElement>('[data-chord] button')!;
    const at = centre(pad);
    await mouse('mouseMoved', at);
    await mouse('mousePressed', at);
    await settle(80);
    expect((runtimeStore.getState().held[bassId()] ?? []).length).toBeGreaterThanOrEqual(3);
    await mouse('mouseReleased', at);
    await settle(80);
    act(() => uiStore.setState({ ...uiStore.getState(), notesChords: { ...uiStore.getState().notesChords, on: false } }));
  });
});

describe('screenshots', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
  ] as const) {
    it(`${w} x ${hh}: the bass loop in Draw and Play`, async () => {
      await open(w, hh);
      await openRegion('C');
      await shot(`editor-draw-bass-${w}.png`);
      expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight);
      console.log(`[r7-edit] ${w}: Simple editor (bass, Draw) controls: ${visibleControls(pane()!)}`);
      act(() => editorModeStore.setState('play'));
      await settle(200);
      await shot(`editor-play-bass-${w}.png`);
      expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight);
      console.log(`[r7-edit] ${w}: Simple editor (bass, Play) controls: ${visibleControls(pane()!)}`);
    });
  }
});
