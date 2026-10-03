/**
 * The Welcome card (shell-02, shell-21) with real keys and clicks:
 * - first visit: Jump In is the focused main key; Tab and Shift+Tab stay on
 *   the card; Esc acts as "Just look around" (the card goes, the hints start);
 * - coming back: Continue “<name>” is the focused main key and "Start a new
 *   groove" the secondary one; starting a new groove says which project it
 *   took the place of (still in My projects), with Open it (which says that
 *   playback stopped), after the quick guide when the guide comes first;
 * - after Jump In keyboard focus is on the quick guide's Next (or on Play /
 *   Pause once the guide was done);
 * - MIDI & audio opens with focus on Connect MIDI; Connect MIDI and Use input
 *   are secondary keys, Done the one primary key.
 */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { hintsStore } from '../../src/app/views/hints/hintsState';
import { button, click, closeShell, keys, openShell, settle, toasts, transport, until } from './r4-shell-harness';

afterEach(closeShell);

const card = () => document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="welcome-title"]');

describe('Welcome, first visit', () => {
  it('Jump In has focus; Tab and Shift+Tab go round the card; Esc looks around and starts the hints', async () => {
    await openShell();
    const jump = button('Jump In')!;
    expect(document.activeElement).toBe(jump);
    expect(jump.dataset.variant).toBe('primary');
    // Round the card with Tab: Jump In → Other starters → Just look around → Jump In.
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await keys('{Tab}');
      seen.push((document.activeElement?.textContent ?? '').trim());
      expect(card()!.contains(document.activeElement), `Tab ${i + 1} stays on the card`).toBe(true);
    }
    expect(seen).toEqual(['Other starters & projects', 'Just look around', 'Jump In', 'Other starters & projects']);
    // Shift+Tab from the first key goes to the last.
    await keys('{Shift>}{Tab}{/Shift}');
    await keys('{Shift>}{Tab}{/Shift}');
    expect((document.activeElement?.textContent ?? '').trim()).toBe('Just look around');
    expect(card()!.contains(document.activeElement)).toBe(true);
    // Esc = Just look around: the card goes and the hints start (they show at once: no guide was offered).
    await keys('{Escape}');
    expect(card()).toBeNull();
    expect(hintsStore.getState().started).toBe(true);
    await until(() => document.querySelector('[data-hint]'), 'the hint chip');
  });

  it('after Jump In focus is on the guide’s Next; with the guide done, on Play / Pause', async () => {
    await openShell({ guideDone: false });
    await click(button('Jump In')!);
    await until(() => !card(), 'the card to go');
    const next = await until(() => document.querySelector<HTMLElement>('[data-guide-next]'), 'the guide');
    await until(() => document.activeElement === next, 'focus on Next');
    // The hints were started with it (they show after the guide).
    expect(hintsStore.getState().started).toBe(true);
    await closeShell();

    await openShell({ guideDone: true });
    await click(button('Jump In')!);
    await until(() => !card(), 'the card to go');
    const play = transport().querySelector<HTMLElement>('button[aria-keyshortcuts="Space"]')!;
    await until(() => document.activeElement === play, 'focus on Play / Pause');
  });
});

describe('Welcome, coming back', () => {
  it('Continue “<name>” is the focused main key, Start a new groove the secondary one', async () => {
    const { boot } = await openShell({ stored: true });
    expect(boot.lastProject).not.toBeNull();
    const name = session.store.getState().name;
    const cont = button(`Continue “${name}”`)!;
    expect(cont).not.toBeNull();
    expect(document.activeElement).toBe(cont);
    expect(cont.dataset.variant).toBe('primary');
    const fresh = button('Start a new groove')!;
    expect(fresh.dataset.variant).toBe('secondary');
    expect(button('Jump In')).toBeNull();
    // Enter continues the song as it was (nothing replaced).
    await keys('{Enter}');
    expect(card()).toBeNull();
    expect(session.store.getState().id).toBe(boot.lastProject!.id);
    expect(toasts().some((t) => t.includes('Started a new'))).toBe(false);
  });

  it('Start a new groove says which project it replaced on screen, and Open it brings that one back', async () => {
    const { boot } = await openShell({ stored: true });
    const earlier = boot.lastProject!;
    await click(button('Start a new groove')!);
    await until(() => !card(), 'the card to go');
    const now = session.store.getState();
    expect(now.id).not.toBe(earlier.id);
    // Numbered so the two can be told apart in My projects.
    expect(now.name).toBe(`${earlier.name} 2`);
    const toast = await until(() => toasts().find((t) => t.includes('Started a new')), 'the toast');
    expect(toast).toContain(`Started a new ${now.name}. Your earlier “${earlier.name}” is in My projects.`);
    // Opening it stops what plays: the notice says so.
    act(() => patchRuntime({ playing: true }));
    await click(button('Open it')!);
    await until(() => session.store.getState().id === earlier.id, 'the earlier project');
    await settle();
    expect(toasts().some((t) => t.includes(`Opened “${earlier.name}”. Playback stopped: press Play (or Space) to hear it.`))).toBe(true);
  });

  it('with the quick guide still to come, the toast waits until the guide is closed (it never sits over the guide)', async () => {
    await openShell({ stored: true, guideDone: false });
    await click(button('Start a new groove')!);
    await until(() => !card(), 'the card to go');
    await until(() => document.querySelector('[data-guide-step]'), 'the quick guide');
    await settle(800);
    expect(toasts().some((t) => t.includes('Started a new'))).toBe(false);
    await click(button('Skip guide')!);
    await until(() => toasts().find((t) => t.includes('Started a new')), 'the toast after the guide');
  });
});

describe('MIDI & audio', () => {
  it('opens with focus on Connect MIDI; Connect MIDI and Use input are secondary, Done is the primary key', async () => {
    await openShell();
    await keys('{Escape}');
    await click(button(/^More/, transport())!);
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((x) => x.textContent?.includes('MIDI & audio…'))!;
    await click(item);
    const dialog = await until(() => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]'), 'the dialog');
    const connect = button('Connect MIDI', dialog)!;
    await until(() => document.activeElement === connect, 'focus on Connect MIDI');
    expect(connect.dataset.variant).toBe('secondary');
    expect(button('Use input', dialog)!.dataset.variant).toBe('secondary');
    const primary = [...dialog.querySelectorAll<HTMLButtonElement>('button[data-variant="primary"]')].map((b) => b.textContent?.trim());
    expect(primary).toEqual(['Done']);
    await act(async () => {
      button('Done', dialog)!.click();
    });
  });
});
