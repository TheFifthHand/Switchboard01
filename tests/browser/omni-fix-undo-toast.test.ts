/**
 * An undo toast belongs to the edit it describes. "Moved …" [Undo] undoes the
 * move, and only while the move is the newest edit: after Ctrl+Z, another edit
 * or another project, that toast is gone (it never undoes something else).
 * Undo and Redo say what they did ("Undid: Move clip" [Redo], "Redid: …"
 * [Undo]), tied the same way.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { getStarter } from '../../src/content/starters';
import { deleteDb } from '../../src/persistence/db';
import { createProject } from '../../src/project/factory';
import type { Id } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { setGuideDone } from '../../src/state/uiStore';
import { actFrame, cleanup, fire, key, mount } from './ui-harness';

/** The notice toasts on screen: their text and button. */
function toasts(): { text: string; button: HTMLButtonElement | null }[] {
  return [...document.querySelectorAll<HTMLElement>('[aria-live="polite"] > [role="status"], [aria-live="polite"] > [role="alert"]')].map((el) => ({
    text: el.textContent ?? '',
    button: [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') !== 'Dismiss') ?? null,
  }));
}
const only = () => {
  const list = toasts();
  expect(list).toHaveLength(1);
  return list[0];
};
const press = (b: HTMLButtonElement | null) => fire(b!, new MouseEvent('click', { bubbles: true }));
const ctrlZ = () => key(document.body, 'keydown', { key: 'z', code: 'KeyZ', ctrlKey: true });

/** A part with a clip in row 1 and an empty row to move it to. */
function moveTarget(): { trackId: Id; to: number; name: string } {
  const t = session.store.getState().tracks.find((x) => x.clips[0] && x.clips.some((c) => !c))!;
  return { trackId: t.id, to: t.clips.findIndex((c) => !c), name: t.clips[0]!.name };
}
const clipAt = (trackId: Id, slot: number) => session.store.getState().tracks.find((t) => t.id === trackId)!.clips[slot];

beforeEach(async () => {
  await deleteDb();
  setGuideDone(true);
  session.store.replace(getStarter('house')!.build());
  patchRuntime({ playing: false, paused: false, recording: 'off', recordTarget: null, notice: null });
  mount(h(App, { boot: { lastProject: null, warnings: [], storageError: null } }), { width: 1300 });
  const look = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Just look around');
  if (look) fire(look, new MouseEvent('click', { bubbles: true }));
  await actFrame();
});

afterEach(async () => {
  cleanup();
  await deleteDb();
});

describe('Undo toasts', () => {
  it('after Ctrl+Z the toast says what was undone and offers Redo; it never undoes an older edit', async () => {
    act(() => void cmd.setBpm(session.store, 133)); // an earlier edit, without a message
    const m = moveTarget();
    act(() => void session.moveClip({ trackId: m.trackId, slot: 0 }, { trackId: m.trackId, slot: m.to }));
    await actFrame();
    let t = only();
    expect(t.text).toContain(`Moved “${m.name}”`);
    expect(t.button?.textContent).toBe('Undo');

    act(() => void ctrlZ());
    await actFrame();
    t = only();
    expect(t.text).toContain('Undid: Move clip');
    expect(t.button?.textContent).toBe('Redo');
    expect(clipAt(m.trackId, 0)?.name).toBe(m.name);
    expect(session.store.getState().bpm).toBe(133);

    // Redo from the toast; its own toast offers Undo of that same step.
    press(t.button);
    await actFrame();
    expect(clipAt(m.trackId, m.to)?.name).toBe(m.name);
    t = only();
    expect(t.text).toContain('Redid: Move clip');
    expect(t.button?.textContent).toBe('Undo');
    press(t.button);
    await actFrame();
    expect(clipAt(m.trackId, 0)?.name).toBe(m.name);
    expect(only().text).toContain('Undid: Move clip');
    // The earlier edit is untouched by all of it.
    expect(session.store.getState().bpm).toBe(133);
  });

  it('the toast goes away when its edit is no longer the newest: another edit, or another project', async () => {
    const m = moveTarget();
    act(() => void session.moveClip({ trackId: m.trackId, slot: 0 }, { trackId: m.trackId, slot: m.to }));
    await actFrame();
    expect(only().button?.textContent).toBe('Undo');
    // A knob or tempo change made after it (no message of its own).
    act(() => void session.setBpm(141));
    await actFrame();
    expect(toasts()).toEqual([]);
    // Ctrl+Z now undoes the tempo change, and says so.
    act(() => void ctrlZ());
    await actFrame();
    expect(only().text).toContain('Undid: Change tempo');
    expect(clipAt(m.trackId, m.to)?.name).toBe(m.name);

    act(() => void session.moveClip({ trackId: m.trackId, slot: m.to }, { trackId: m.trackId, slot: 0 }));
    await actFrame();
    expect(only().button?.textContent).toBe('Undo');
    act(() => session.store.replace(createProject({ name: 'Another', now: 2 })));
    await actFrame();
    expect(toasts()).toEqual([]);
  });

  it('the Undo button undoes the edit it describes', async () => {
    act(() => void cmd.setBpm(session.store, 128));
    const m = moveTarget();
    act(() => void session.moveClip({ trackId: m.trackId, slot: 0 }, { trackId: m.trackId, slot: m.to }));
    await actFrame();
    press(only().button);
    await actFrame();
    expect(clipAt(m.trackId, 0)?.name).toBe(m.name);
    expect(clipAt(m.trackId, m.to)).toBeNull();
    expect(session.store.getState().bpm).toBe(128);
    expect(only().text).toContain('Undid: Move clip');
  });
});
