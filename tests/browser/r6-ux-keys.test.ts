/**
 * r6 UX fixes, keys (real Chromium, real mouse and keys through CDP):
 * - Space plays / pauses from anywhere: after a click on a step of a new
 *   beat (Make a beat from scratch), the step stays on and the transport is
 *   asked to play; the same in the Song view's editor pane after a click on
 *   its grid. Enter still toggles a focused step.
 * - E (and a loop menu's Edit notes) opens the editor pane with keyboard
 *   focus in its grid, so the keys go on editing there; Esc closes it and
 *   focus goes back to the loop.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { editorStore } from '../../src/app/views/arrange/editorStore';
import { ppbStore } from '../../src/app/views/arrange/laneStore';
import type { Project } from '../../src/project/types';
import { closeShell, keys, openShell, until } from './r4-shell-harness';
import { centre, clickAt, on, openSong, press, project, region, regionEl, resetSong, settle, teardownSong, waitFor, advancedMode } from './r5-song-helpers';

/** What the transport was asked to do (the real one would start audio). */
let calls: string[] = [];
const realToggle = session.togglePlay;
function stubTransport(): void {
  calls = [];
  (session as unknown as { togglePlay: (o?: { song?: boolean }) => Promise<void> }).togglePlay = async (o = {}) => void calls.push(o.song ? 'play/pause song' : 'play/pause');
}
function restoreTransport(): void {
  (session as unknown as { togglePlay: typeof realToggle }).togglePlay = realToggle;
}

const welcome = () => document.querySelector('[role="dialog"][aria-labelledby="welcome-title"]');
const kickStep = (n: number) => document.querySelector<HTMLButtonElement>(`button[aria-label^="Kick, step ${n}"]`)!;
const drumsNotes = () => project().tracks.find((t) => t.instrument.kind === 'drums')!.clips[0]?.notes.length ?? 0;

describe('Space after a click on a new beat’s step', () => {
  afterEach(async () => {
    restoreTransport();
    if (session.playing || session.paused) act(() => session.stop());
    await closeShell();
  });

  it('the step stays on and Space plays / pauses; Enter on the focused step still toggles it', async () => {
    await openShell();
    await act(async () => {
      [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Make a beat from scratch'))!.click();
    });
    await until(() => !welcome(), 'the card to go', 15000);
    await until(() => kickStep(1), 'the kick row');
    stubTransport();
    // A real click: the grid focuses the step by script, which must not make it a "keyboard" control.
    await clickAt(centre(kickStep(1)));
    expect(kickStep(1).getAttribute('aria-pressed')).toBe('true');
    expect(drumsNotes()).toBe(1);
    await press(' ');
    expect(kickStep(1).getAttribute('aria-pressed')).toBe('true');
    expect(drumsNotes()).toBe(1);
    expect(calls).toEqual(['play/pause']);
    await press(' ');
    expect(calls).toEqual(['play/pause', 'play/pause']);
    expect(drumsNotes()).toBe(1);
    // Enter is the key that presses a step.
    kickStep(1).focus();
    await keys('{Enter}');
    expect(kickStep(1).getAttribute('aria-pressed')).toBe('false');
    expect(calls).toHaveLength(2);
  });
});

/** Drums: A over bars 1–8; Bass: C over bars 1–16. */
function song(p: Project): void {
  const drums = p.tracks[0];
  const bass = p.tracks[2];
  p.arrangement.regions = [region('A', drums.id, drums.clips.find((c) => c)!.id, 0, 8), region('C', bass.id, bass.clips.find((c) => c)!.id, 0, 16)];
  p.arrangement.sections = [];
}

const pane = () => document.querySelector<HTMLElement>('[data-loop-editor]');

describe('the Song view’s editor pane from the keyboard', () => {
  beforeEach(async () => {
    localStorage.removeItem('switchboard01.songEditorHeight');
    await resetSong();
    // Round 7: in Simple a click on a loop opens it (r7-home-song); E is tested where a click only selects.
    advancedMode();
    await openSong(1366, 768, song);
    act(() => ppbStore.setState(32));
    await settle();
  });
  afterEach(async () => {
    restoreTransport();
    act(() => editorStore.setState(null));
    await teardownSong();
  });

  it('E opens the loop with focus in the editor’s grid; the arrow keys and Enter edit there; Esc goes back to the loop', async () => {
    await clickAt(on('C'));
    expect(document.activeElement).toBe(regionEl('C'));
    await press('e');
    await waitFor(() => !!pane() && pane()!.contains(document.activeElement), 'focus in the editor pane');
    // The grid's entry: the piano roll's cursor (Bass).
    expect(document.activeElement?.hasAttribute('data-steps-entry')).toBe(true);
    const bass = () => project().tracks[2];
    const slot = editorStore.getState()!;
    const notesNow = () => bass().clips.find((c) => c?.id === slot.clipId)!.notes.length;
    const before = notesNow();
    await press('ArrowRight');
    await press('Enter');
    expect(notesNow()).toBe(before + 1);
    // Esc: the pane closes and the loop has focus again.
    await press('Escape');
    if (pane()) await press('Escape');
    await waitFor(() => !pane(), 'the pane closed');
    expect(document.activeElement).toBe(regionEl('C'));
  });

  it('a click in the pane’s grid, then Space: the song plays, the note there is untouched', async () => {
    await press('Escape');
    await clickAt(on('A'));
    await press('e');
    await waitFor(() => !!pane(), 'the editor pane');
    const cell = pane()!.querySelector<HTMLButtonElement>('[role="row"][data-voice="0"] [data-col="2"]')!;
    stubTransport();
    await clickAt(centre(cell));
    const pressed = cell.getAttribute('aria-pressed');
    const notes = JSON.stringify(project().tracks[0].clips.find((c) => c?.id === editorStore.getState()!.clipId)!.notes);
    await press(' ');
    expect(calls).toEqual(['play/pause song']);
    expect(cell.getAttribute('aria-pressed')).toBe(pressed);
    expect(JSON.stringify(project().tracks[0].clips.find((c) => c?.id === editorStore.getState()!.clipId)!.notes)).toBe(notes);
  });
});
