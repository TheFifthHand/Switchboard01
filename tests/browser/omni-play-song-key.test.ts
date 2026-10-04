/**
 * The transport's Play key and Space in the Song view play the song (from
 * its cursor, or the loop when one is set); in the other views they play the
 * pads. A pause resumes whatever was playing. In the Song view the key says
 * so: its name and tip are
 * "Play song" and the word "song" is drawn in the key (its width unchanged);
 * the state word reads "Song" while the song plays. Stop ends the song and
 * Export opens with the song chosen there. With the real engine.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { deleteDb } from '../../src/persistence/db';
import { songBars } from '../../src/project/arrangement';
import { setGuideDone, setPadMode, setTipsEnabled, setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, mount, nextFrame, wait } from './ui-harness';

let boot: BootInfo;
const rt = () => runtimeStore.getState();

beforeEach(async () => {
  await deleteDb();
  act(() => {
    setGuideDone(true);
    setTipsEnabled(true);
    setUiMode('simple');
    setView('play');
    setPadMode('loops');
    patchRuntime({ playing: false, paused: false, recording: 'off', notice: null, mode: 'live', songLoop: null, songCursor: 0 });
  });
  boot = await session.boot();
});

afterEach(async () => {
  act(() => session.stop());
  cleanup();
  act(() => {
    setView('play');
    patchRuntime({ playing: false, paused: false, mode: 'live', songLoop: null });
  });
  await session.autosaver?.flush();
  await deleteDb();
});

async function real(fn: () => Promise<unknown>): Promise<void> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await fn();
    await nextFrame();
    await nextFrame();
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
}

async function until(fn: () => boolean, what: string, ms = 5000) {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await wait(15);
    });
  }
}

async function openApp() {
  await page.viewport(1366, 768);
  const m = mount(h(App, { boot }));
  m.container.style.width = '';
  m.container.style.padding = '0';
  const look = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Just look around');
  await act(async () => {
    look?.click();
    await wait(20);
  });
  await act(async () => {
    await session.newFromStarter('house');
  });
  // The starter may start the pads: begin stopped.
  act(() => session.stop());
  await act(async () => {
    await wait(50);
  });
}

const playKey = () => document.querySelector<HTMLButtonElement>('header[aria-label="Transport"] button[aria-keyshortcuts="Space"]')!;
const stateWord = () => document.querySelector<HTMLElement>('header[aria-label="Transport"] [aria-label="Position"] [role="status"]')?.textContent;
const description = (el: Element) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

describe('Play and Space in the Song view', () => {
  it('the key says Play song in the Song view, at the same width; Play elsewhere', async () => {
    await openApp();
    const width = playKey().getBoundingClientRect().width;
    expect(playKey().getAttribute('aria-label') ?? playKey().textContent).toBe('Play');
    act(() => setView('arrange'));
    await act(async () => {
      await wait(60);
    });
    const k = playKey();
    expect(k.getAttribute('aria-label')).toBe('Play song');
    expect(k.textContent?.replace(/\s+/g, ' ').trim()).toBe('Play song');
    expect(description(k)).toContain('Play song');
    expect(k.getBoundingClientRect().width).toBeCloseTo(width, 0);
    act(() => setView('shape'));
    await act(async () => {
      await wait(30);
    });
    expect(playKey().getAttribute('aria-label') ?? playKey().textContent).toBe('Play');
  });

  it('the key and Space play the song from the loop; a pause resumes the song; in Play they play the pads', async () => {
    await openApp();
    act(() => setView('arrange'));
    await act(async () => {
      await wait(60);
    });
    expect(songBars(session.store.getState())).toBeGreaterThan(12);
    const startBar = () => session.sequencer!.songPasses()![0].from / 384;

    // The key: the song, from its cursor (bar 1).
    await real(() => userEvent.click(playKey()));
    await until(() => rt().playing && rt().mode === 'song', 'the song to play');
    expect(startBar()).toBe(0);
    expect(stateWord()).toBe('Song');
    // Pause and resume: the song carries on (Space this time).
    await real(() => userEvent.keyboard(' '));
    await until(() => rt().paused, 'pause');
    expect(stateWord()).toBe('Paused');
    await real(() => userEvent.keyboard(' '));
    await until(() => rt().playing, 'resume');
    expect(rt().mode).toBe('song');
    act(() => session.stop());
    await until(() => !rt().playing && !rt().paused, 'stop');

    // With a loop set (the cursor outside it), Space starts at the loop.
    act(() => {
      session.setSongLoop({ fromBar: 8, toBar: 12 });
    });
    (document.activeElement as HTMLElement | null)?.blur();
    await real(() => userEvent.keyboard(' '));
    await until(() => rt().playing && rt().mode === 'song', 'the song from the loop');
    expect(startBar()).toBe(8);
    act(() => session.stop());
    await until(() => !rt().playing, 'stop');
    act(() => session.setSongLoop(null));

    // In Play, the same key and Space play the pads.
    act(() => setView('play'));
    await act(async () => {
      await wait(40);
    });
    await real(() => userEvent.keyboard(' '));
    await until(() => rt().playing, 'the pads to play');
    expect(rt().mode).toBe('live');
    expect(stateWord()).toBe('Playing');
  });

  it('Stop and Export in the transport act on the song in the Song view (real clicks)', async () => {
    await openApp();
    act(() => setView('arrange'));
    await act(async () => {
      await wait(60);
    });
    const bar = document.querySelector<HTMLElement>('header[aria-label="Transport"]')!;
    const stop = [...bar.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Stop')!;
    const exportKey = [...bar.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Export')!;
    expect(description(exportKey)).toContain('Export the song');
    await real(() => userEvent.click(playKey()));
    await until(() => rt().playing && rt().mode === 'song', 'the song to play');
    expect(description(stop)).toContain('Stop the song');
    await real(() => userEvent.click(stop));
    await until(() => !rt().playing && !rt().paused, 'Stop to end the song');
    // Export opens with the song chosen.
    await real(() => userEvent.click(exportKey));
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    await until(() => !!dialog()?.querySelector('select'), 'the export dialog');
    expect(dialog()!.querySelector<HTMLSelectElement>('select')!.value).toBe('song');
    await real(() => userEvent.keyboard('{Escape}'));
    await until(() => !dialog(), 'the dialog to close');
    // In Play, Export offers what plays now (no takes yet), not the song.
    act(() => setView('play'));
    await act(async () => {
      await wait(40);
    });
    await real(() => userEvent.click(exportKey));
    await until(() => !!dialog()?.querySelector('select'), 'the export dialog');
    expect(dialog()!.querySelector<HTMLSelectElement>('select')!.value).toBe('now');
    await real(() => userEvent.keyboard('{Escape}'));
  });
});
