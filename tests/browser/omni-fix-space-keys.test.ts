/**
 * Space = Play / Pause and Shift+Space = Stop with real mouse clicks and key
 * presses (trusted input in Chromium): after clicking a pad, a part's Mute, a
 * scene or the Play button, Space still plays / pauses (the clicked control
 * is not pressed again) and Shift+Space stops. A keyboard user who reaches a
 * button with Tab still presses it with Space. Typing in a text field and an
 * open dialog keep Space; after the dialog's Done, Space is the transport's
 * again.
 */
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { getStarter } from '../../src/content/starters';
import { deleteDb } from '../../src/persistence/db';
import { setGuideDone } from '../../src/state/uiStore';
import { cleanup, fire, mount, nextFrame } from './ui-harness';

/** Trusted input goes through the browser outside React's act(). */
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
const click = (el: Element) => real(() => userEvent.click(el));
const press = (keys: string) => real(() => userEvent.keyboard(keys));
const SPACE = ' ';
const SHIFT_SPACE = '{Shift>} {/Shift}';

const button = (name: string | RegExp): HTMLButtonElement => {
  const all = [...document.querySelectorAll<HTMLButtonElement>('button')];
  const found = all.find((b) => {
    const n = b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '';
    return typeof name === 'string' ? n === name : name.test(n);
  });
  if (!found) throw new Error(`no button ${name}`);
  return found;
};

/** What the transport and the pads were asked to do (the real ones would start audio). */
let calls: string[] = [];
const stubbed = ['togglePlay', 'stop', 'pressClip', 'launchScene'] as const;

beforeEach(async () => {
  await deleteDb();
  await page.viewport(1920, 1080);
  setGuideDone(true);
  session.store.replace(getStarter('house')!.build());
  patchRuntime({ muteAll: false, stalled: null, playing: false, paused: false, mode: 'live', replayId: null, recording: 'off', recordTarget: null, notice: null });
  calls = [];
  const s = session as unknown as Record<(typeof stubbed)[number], unknown>;
  s.togglePlay = async () => void calls.push('play/pause');
  s.stop = () => void calls.push('stop');
  s.pressClip = async (trackId: string, slot: number) => void calls.push(`pad ${trackId}:${slot}`);
  s.launchScene = async (row: number) => void calls.push(`scene ${row}`);
  mount(h(App, { boot: { lastProject: null, warnings: [], storageError: null } }), { width: 1880 });
  fire(button('Just look around'), new MouseEvent('click', { bubbles: true }));
  await nextFrame();
});

afterEach(async () => {
  cleanup();
  for (const name of stubbed) delete (session as unknown as Record<string, unknown>)[name];
  await deleteDb();
});

describe('Space after a mouse click', () => {
  it('plays / pauses after clicking a pad, a part’s Mute, a scene or Play; Shift+Space stops', async () => {
    const pad = document.getElementById('pad-t1-0')!;
    expect(pad).not.toBeNull();
    await click(pad);
    expect(calls).toEqual(['pad t1:0']);
    expect(document.activeElement).toBe(pad);
    await press(SPACE);
    // The transport got it; the pad was not pressed again.
    expect(calls).toEqual(['pad t1:0', 'play/pause']);

    const drums = session.store.getState().tracks[0].name;
    const mute = button(`Mute ${drums}`);
    await click(mute);
    expect(session.store.getState().tracks[0].mute).toBe(true);
    calls = [];
    await press(SPACE);
    expect(calls).toEqual(['play/pause']);
    expect(session.store.getState().tracks[0].mute).toBe(true);

    const scene = document.querySelector<HTMLButtonElement>('button[data-scene]')!;
    await click(scene);
    calls = [];
    await press(SPACE);
    await press(SHIFT_SPACE);
    expect(calls).toEqual(['play/pause', 'stop']);

    // Shift+Space on the clicked Play button stops (it does not toggle).
    const play = document.querySelector<HTMLButtonElement>('header[aria-label="Transport"] button[aria-keyshortcuts="Space"]')!;
    await click(play);
    expect(calls).toEqual(['play/pause', 'stop', 'play/pause']);
    await press(SHIFT_SPACE);
    expect(calls).toEqual(['play/pause', 'stop', 'play/pause', 'stop']);
  });
});

describe('Space for keyboard users', () => {
  it('presses a button reached with Tab; Shift+Space still stops', async () => {
    const drums = session.store.getState().tracks[0].name;
    await click(button(`Mute ${drums}`));
    calls = [];
    await press('{Tab}');
    const reached = document.activeElement as HTMLElement;
    expect(reached.tagName).toBe('BUTTON');
    expect(reached.matches(':focus-visible')).toBe(true);
    let pressed = 0;
    reached.addEventListener('click', () => (pressed += 1));
    await press(SPACE);
    expect(pressed).toBe(1);
    expect(calls).toEqual([]);
    await press(SHIFT_SPACE);
    expect(calls).toEqual(['stop']);
    expect(pressed).toBe(1);
  });
});

describe('Where Space is not the transport’s', () => {
  it('types in a text field, belongs to an open dialog, and comes back after Done', async () => {
    const field = document.createElement('input');
    document.body.append(field);
    try {
      await click(field);
      await press(`a${SPACE}b`);
      expect(field.value).toBe('a b');
      expect(calls).toEqual([]);
    } finally {
      field.remove();
    }

    // MIDI & audio, from the More menu (clicked).
    await click(button(/^More: /));
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.includes('MIDI & audio'))!;
    await click(item);
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(dialog?.textContent).toContain('MIDI & audio');
    await press(SPACE);
    expect(calls).toEqual([]);
    await click(button('Done'));
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
    // Focus went back where it was before the dialog: Space is Play / Pause again.
    await press(SPACE);
    expect(calls).toEqual(['play/pause']);
  });
});
