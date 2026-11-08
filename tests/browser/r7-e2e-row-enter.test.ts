/**
 * Round 7 (found by the e2e keyboard tour): Enter on a real button inside the
 * song's timeline presses that button. An instrument's name opens its Sound
 * panel and Mute mutes, from the keyboard as with the mouse (the Song view's
 * Enter-means-playhead-home key had taken Enter from them). Enter on a loop,
 * or with nothing focused, still takes the playhead back to the start.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { patchRuntime } from '../../src/app/runtime';
import { closeSound, sidePanelStore } from '../../src/app/views/arrange/sidePanelStore';
import { clipOf, openSong, project, region, regionEl, resetSong, rt, setSong, settle, teardownSong, trackId } from './r5-song-helpers';

function drumsSong(): void {
  const drums = trackId('Drums');
  setSong([region('d1', drums, clipOf(0, 0).id, 0, 8), region('d2', drums, clipOf(0, 1).id, 8, 8)], [{ id: 'sA', name: 'Intro', start: 0, bars: 16 }]);
}

beforeEach(async () => {
  await resetSong('simple');
  act(() => closeSound());
});
afterEach(async () => {
  act(() => closeSound());
  await teardownSong();
});

describe('Enter in the song timeline (Simple)', () => {
  it("Enter on an instrument's name opens its sound; Enter on its Mute mutes it", async () => {
    await openSong(1366, 768);
    drumsSong();
    await settle();
    const name = document.querySelector<HTMLElement>('[data-testid="row-name"]')!;
    expect(name.getAttribute('aria-label')).toBe('Drums (Drums): open its sound');
    act(() => name.focus());
    // A real Enter (key down, the character, key up): what makes the browser press a focused button.
    await userEvent.keyboard('{Enter}');
    await settle(60);
    expect(sidePanelStore.getState()).toEqual({ kind: 'sound', trackId: trackId('Drums') });
    expect(name.getAttribute('aria-pressed')).toBe('true');

    const mute = document.querySelector<HTMLButtonElement>('button[aria-label="Mute Drums"]')!;
    act(() => mute.focus());
    await userEvent.keyboard('{Enter}');
    await settle(60);
    expect(project().tracks.find((t) => t.name === 'Drums')!.mute).toBe(true);
    await userEvent.keyboard('{Enter}');
    await settle(60);
    expect(project().tracks.find((t) => t.name === 'Drums')!.mute).toBe(false);
  });

  it('Enter on a loop still takes the playhead back to the start', async () => {
    await openSong(1366, 768);
    drumsSong();
    await settle();
    act(() => patchRuntime({ songCursor: 9 }));
    act(() => regionEl('d2').focus());
    await userEvent.keyboard('{Enter}');
    await settle(60);
    expect(rt().songCursor).toBe(0);
  });
});
