/**
 * "Try this" hints for every first project, and the song track (shell-14,
 * arrange-no-song-hints, shell-08, shell-15), in the running app with real
 * clicks:
 * - Just look around, a starter or Blank picked on Welcome all start the hints;
 * - in a Blank project the pad and drag steps are passed over (nothing to tap
 *   or drag yet);
 * - opening Arrange makes the song track current: play the song in Arrange, a
 *   block's length, a part switched off in a block, an export finished, each
 *   done when the real state says so;
 * - in another view the song step collapses to one line, "Next, in Arrange:
 *   …", with Open Arrange;
 * - Hide hints points to Help.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import { exportsDone, hintsStore } from '../../src/app/views/hints/hintsState';
import { setBlockPart, setBlockRepeats } from '../../src/state/commands';
import { uiStore } from '../../src/state/uiStore';
import { button, click, closeShell, keys, openShell, settle, toasts, transport, until } from './r4-shell-harness';

afterEach(async () => {
  vi.restoreAllMocks();
  await closeShell();
});

const chip = () => document.querySelector<HTMLElement>('aside[data-hint]');
const tab = (name: string) => [...transport().querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === name)!;
/** The chip, once it is on screen. */
const shownChip = () => until(() => (chip()?.hasAttribute('data-ready') ? chip() : null), 'the hint chip');

describe('every first project starts the hints', () => {
  it('Just look around', async () => {
    await openShell();
    await click(button('Just look around')!);
    const c = await shownChip();
    expect(c.getAttribute('aria-label')).toBe('Try this, hint 1 of 7');
    expect(c.textContent).toContain('Tap a pad in the Bass column.');
  });

  it('a starter picked on Welcome, and Blank, where the pad and drag steps are passed over', async () => {
    await openShell();
    await click(button('Other starters & projects')!);
    const blank = await until(() => button(/^Start Blank project/), 'the Blank card');
    await click(blank);
    await until(() => !document.querySelector('[role="dialog"][aria-modal="true"]'), 'the library to close');
    expect(hintsStore.getState().started).toBe(true);
    const c = await shownChip();
    // Nothing to launch or drag yet: the first step is Mute, one of five.
    expect(c.dataset.hint).toBe('mute');
    expect(c.getAttribute('aria-label')).toBe('Try this, hint 1 of 5');
  });
});

describe('the song track', () => {
  it('becomes current when Arrange opens; each step is done by the real action', async () => {
    await openShell();
    await click(button('Just look around')!);
    await shownChip();
    await click(tab('Arrange'));
    let c = await until(() => (chip()?.dataset.hint === 'song-play' ? chip() : null), 'the song track');
    expect(c.getAttribute('aria-label')).toBe('Try this, song hint 1 of 4');
    expect(c.textContent).toContain('Press Play to hear your song.');
    // The song plays in Arrange.
    act(() => patchRuntime({ playing: true, mode: 'song', songBlock: 0 }));
    c = await until(() => (chip()?.dataset.hint === 'song-repeats' ? chip() : null), 'the next song step');
    expect(c.textContent).toContain('Drag a block’s right edge to play it more times.');
    act(() => patchRuntime({ playing: false, mode: 'live', songBlock: null }));
    const block = session.store.getState().arrangement.blocks[0];
    // A split is not a longer block: only a block's own repeats count.
    act(() => void session.accepted(setBlockRepeats(session.store, block.id, block.repeats + 1)));
    c = await until(() => (chip()?.dataset.hint === 'song-part' ? chip() : null), 'the part step');
    expect(c.textContent).toContain('Click a part in a block to switch it off there.');
    act(() => void session.accepted(setBlockPart(session.store, block.id, 't1', null)));
    c = await until(() => (chip()?.dataset.hint === 'song-export' ? chip() : null), 'the export step');
    expect(c.textContent).toMatch(/Export/);
    // An export that finishes (the session's export, its rendering stubbed) is the last song step.
    const before = exportsDone.getState();
    vi.spyOn(Session.prototype as unknown as { renderExport: () => Promise<unknown> }, 'renderExport').mockResolvedValue({ blob: new Blob([]), report: null });
    await act(async () => {
      await session.renderWav({ source: { kind: 'song' }, sampleRate: 44100, bitDepth: 16, tailSeconds: 0 } as Parameters<typeof session.renderWav>[0]);
    });
    expect(exportsDone.getState()).toBe(before + 1);
    // Then the basics carry on where they were.
    c = await until(() => (chip()?.dataset.hint === 'pad' ? chip() : null), 'the basics');
    expect(hintsStore.getState().done).toEqual(expect.arrayContaining(['song-play', 'song-repeats', 'song-part', 'song-export']));
  });

  it('in another view a song step is one line, "Next, in Arrange: …", with Open Arrange', async () => {
    await openShell();
    await click(button('Just look around')!);
    await shownChip();
    await click(tab('Arrange'));
    await until(() => chip()?.dataset.hint === 'song-play', 'the song track');
    await click(tab('Play'));
    const c = await until(() => (chip()?.hasAttribute('data-collapsed') && chip()?.hasAttribute('data-ready') ? chip() : null), 'the collapsed chip');
    expect(c.textContent).toContain('Next, in Arrange:');
    expect(c.textContent).toContain('Press Play to hear your song.');
    expect(button('Next hint', c)).toBeNull();
    // One line: no taller than its buttons and padding.
    expect(c.getBoundingClientRect().height).toBeLessThanOrEqual(48);
    await settle(500);
    await click(button('Open Arrange', c)!);
    expect(uiStore.getState().view).toBe('arrange');
  });

  it('Hide hints says where to find them again: Help', async () => {
    await openShell();
    await click(button('Just look around')!);
    const c = await shownChip();
    button('Hide hints', c)!.focus();
    await keys('{Enter}');
    expect(chip()).toBeNull();
    const t = await until(() => toasts().find((x) => x.startsWith('Hints are off.')), 'the toast');
    expect(t).toContain('Help');
    expect(t).toContain('Show hints again');
  });
});
