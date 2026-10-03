/**
 * The save state and what surrounds it (shell-10, shell-11, design-17,
 * design-19, design-01), in the running app with real clicks and keys:
 * - a shape per state in neutral ink (check, turning arc, hollow ring), a
 *   coral warning for Not saved, each named in words;
 * - a failed save tells once per run of failures, "Not saved: browser storage
 *   is full." with Export project file; again only after saving worked;
 * - the "Saving failed" panel is the shared popover: Esc and a press outside
 *   close it;
 * - the tab title names the project (▶ while playing), each view has an h1;
 * - under reduced motion the record light, its ring and the saving arc hold
 *   still; the strip's height is on the page root (--transport-h).
 */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { setView } from '../../src/state/uiStore';
import { reducedMotion } from './r4-uikit-input';
import { button, click, closeShell, keys, openShell, settle, toasts, transport, until } from './r4-shell-harness';

let restoreWrites: (() => void) | null = null;
afterEach(async () => {
  restoreWrites?.();
  restoreWrites = null;
  await reducedMotion(false);
  await closeShell();
});

function failWrites(): () => void {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  };
  return () => {
    IDBObjectStore.prototype.put = put;
  };
}

const save = () => transport().querySelector<HTMLButtonElement>('button[aria-label^="Autosave: "]')!;
const inkOf = (el: Element) => getComputedStyle(el).color;
const failToasts = () => toasts().filter((t) => t.startsWith('Not saved: browser storage is full.'));

describe('the save state', () => {
  it('a shape per state in neutral ink, each named in words; Not saved in coral with a warning', async () => {
    await openShell();
    await keys('{Escape}');
    // Preview: a hollow ring.
    expect(save().getAttribute('aria-label')).toBe('Autosave: Preview, not stored until you change it');
    expect(save().dataset.save).toBe('preview');
    expect(save().querySelector('svg')).toBeNull();
    // Saving: the arc; Saved: the check.
    act(() => session.setBpm(117));
    expect(save().getAttribute('aria-label')).toBe('Autosave: Saving…');
    expect(save().querySelector('svg path')?.getAttribute('d')).toMatch(/^M8 2\.6 A/);
    await until(() => save().getAttribute('aria-label') === 'Autosave: Saved', 'Saved');
    expect(save().dataset.save).toBe('saved');
    // Neutral ink: neither teal (selection) nor amber (playing).
    const probe = document.createElement('span');
    probe.style.color = 'var(--ink-3)';
    document.body.append(probe);
    const ink3 = getComputedStyle(probe).color;
    probe.remove();
    expect(inkOf(save())).toBe(ink3);
    // Not saved: the coral warning.
    restoreWrites = failWrites();
    act(() => session.setBpm(116));
    await until(() => save().getAttribute('aria-label') === 'Autosave: Not saved', 'Not saved');
    expect(save().dataset.save).toBe('error');
    expect(inkOf(save())).not.toBe(ink3);
  });

  it('a failed save tells once per run of failures, with Export project file; the panel closes with Esc and a press outside', async () => {
    await openShell();
    await keys('{Escape}');
    act(() => session.setBpm(117));
    await until(() => save().getAttribute('aria-label') === 'Autosave: Saved', 'Saved');
    restoreWrites = failWrites();
    act(() => session.setBpm(116));
    await until(() => failToasts().length === 1, 'the toast');
    expect(failToasts()[0]).toContain('Export project file');
    // More failures in the same run: no second toast.
    act(() => session.setBpm(115));
    await until(() => (session.autosaver!.status.getState().failures ?? 0) >= 2, 'a second failure');
    await settle();
    expect(failToasts()).toHaveLength(1);
    // The panel: the shared popover (a non-modal dialog), closed by Esc and by a press outside.
    await click(save());
    const panel = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Saving failed"]');
    await until(panel, 'the panel');
    expect(panel()!.textContent).toContain('Browser storage is full');
    await keys('{Escape}');
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(save());
    await click(save());
    await until(panel, 'the panel again');
    await click(document.querySelector('main')!);
    expect(panel()).toBeNull();
    // Saving works again: the toast goes; the next failure is a new run and tells again.
    restoreWrites();
    restoreWrites = null;
    await act(async () => {
      await session.autosaver!.retry();
    });
    await until(() => save().getAttribute('aria-label') === 'Autosave: Saved', 'Saved again');
    await until(() => failToasts().length === 0, 'the toast to go');
    restoreWrites = failWrites();
    act(() => session.setBpm(114));
    await until(() => failToasts().length === 1, 'the toast for the new run');
  });
});

describe('titles and headings', () => {
  it('the tab says the project (▶ while playing); each view has one h1 naming it and the project', async () => {
    await openShell();
    expect(document.title).toBe('Omni Song');
    await keys('{Escape}');
    const name = session.store.getState().name;
    await until(() => document.title === `${name} — Omni Song`, 'the title');
    act(() => patchRuntime({ playing: true }));
    await until(() => document.title === `▶ ${name} — Omni Song`, 'the playing title');
    act(() => patchRuntime({ playing: false }));
    const h1 = () => [...document.querySelectorAll('h1')].map((x) => x.textContent);
    expect(h1()).toEqual([`Omni Song — Play · ${name}`]);
    act(() => setView('mix'));
    await settle();
    expect(h1()).toEqual([`Omni Song — Mix · ${name}`]);
  });
});

describe('reduced motion and the strip height', () => {
  it('the record light and ring and the saving arc hold still; --transport-h is the strip’s height', async () => {
    await openShell();
    await keys('{Escape}');
    await reducedMotion(true);
    act(() => patchRuntime({ recording: 'performance', playing: true }));
    await settle(100);
    const dot = transport().querySelector<HTMLElement>('[data-live] > span[aria-hidden="true"]')!;
    expect(getComputedStyle(dot).animationName).toBe('none');
    expect(getComputedStyle(dot).opacity).toBe('1');
    const take = button('Stop recording performance', transport())!;
    expect(getComputedStyle(take).animationName).toBe('none');
    expect(getComputedStyle(take).boxShadow).toContain('0px 0px 0px 3px');
    act(() => patchRuntime({ recording: 'off', playing: false }));
    act(() => session.setBpm(117));
    const arc = save().querySelector('svg')!;
    expect(getComputedStyle(arc).animationName).toBe('none');
    const h = Math.round(transport().getBoundingClientRect().height);
    expect(getComputedStyle(document.documentElement).getPropertyValue('--transport-h').trim()).toBe(`${h}px`);
  });
});
