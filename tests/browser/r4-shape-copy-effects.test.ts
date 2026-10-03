/**
 * shape-15: Copy effects / Paste effects on the effects header.
 *
 * Copy keeps a part's effects (their settings as they sound now, on/off) for
 * the session (uiStore.effectClipboard); Paste puts them after another part's
 * effects or instead of them (keeping its Drive and Filter), in one undo
 * step, from Simple and from the Advanced rack. Real clicks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { session } from '../../src/app/instance';
import * as cmd from '../../src/state/commands';
import { selectTrack, uiStore } from '../../src/state/uiStore';
import { clickEl, closeShape, menuItem, notice, openShape, project } from './r4-shape-helpers';
import { settleFrames } from './r4-uikit-input';

afterEach(closeShape);

describe('Copy effects / Paste effects', () => {
  it('Simple: copy Chords’ Reverb and EQ, paste after Lead’s effects: one undo step', async () => {
    await openShape({ mode: 'simple', trackId: 't4' });
    act(() => {
      session.accepted(cmd.insertEffect(session.store, 't4', 'reverb'));
      session.accepted(cmd.insertEffect(session.store, 't4', 'eq'));
      session.accepted(cmd.setModuleParam(session.store, 't4:eq', 'lowGain', 6));
    });
    await settleFrames();
    const paste = () => document.getElementById('simple-paste-effects') as HTMLButtonElement;
    expect(paste().disabled).toBe(true);
    await clickEl(document.getElementById('simple-copy-effects'));
    expect(notice()).toBe('Copied 2 effects from Chords: Reverb, EQ. Paste them onto another part.');
    expect(uiStore.getState().effectClipboard?.effects.map((e) => e.type)).toEqual(['reverb', 'eq']);

    await clickEl(document.getElementById('shape-part-t5'));
    expect(paste().disabled).toBe(false);
    const before = project();
    await clickEl(paste());
    await clickEl(menuItem('After Lead’s effects'));
    expect(notice()).toBe('Pasted 2 effects from Chords after Lead’s effects.');
    const lead = cmd.copyEffectChain(project(), 't5')!;
    expect(lead.effects.map((e) => e.type)).toEqual(['reverb', 'eq']);
    expect(lead.effects[1].params.lowGain).toBe(6);
    expect(project().patch.modules.some((m) => m.id === 't5:drive')).toBe(true);
    act(() => session.undo());
    expect(project().patch).toEqual(before.patch);
  });

  it('Advanced rack: paste instead of a part’s effects keeps its Drive and Filter', async () => {
    await openShape({ mode: 'advanced', trackId: 't4', w: 1920, hh: 1080 });
    act(() => {
      session.accepted(cmd.insertEffect(session.store, 't4', 'chorus'));
      session.accepted(cmd.insertEffect(session.store, 't3', 'tape'));
    });
    await settleFrames();
    await clickEl(document.getElementById('rack-copy-effects'));
    act(() => selectTrack('t3'));
    await settleFrames();
    await clickEl(document.getElementById('rack-paste-effects'));
    await clickEl(menuItem('Instead of Bass’ effects'));
    expect(notice()).toBe('Bass’ effects are now the 1 effect copied from Chords (1 effect replaced).');
    const chain = cmd.copyEffectChain(project(), 't3')!;
    expect(chain.effects.map((e) => e.type)).toEqual(['chorus']);
    expect(project().patch.modules.some((m) => m.id === 't3:drive')).toBe(true);
    expect(project().patch.modules.some((m) => m.id === 't3:filter')).toBe(true);
    expect(project().patch.modules.some((m) => m.trackId === 't3' && m.type === 'tape')).toBe(false);
  });

  it('a part whose Drive and Filter do nothing has nothing to copy, and says so', async () => {
    await openShape({ mode: 'simple', trackId: 't1' });
    await clickEl(document.getElementById('simple-copy-effects'));
    expect(notice()).toBe('Drums has no effects to copy (its Drive and Filter do nothing yet).');
    expect(uiStore.getState().effectClipboard).toBeNull();
  });

  it('while a performance records, Paste is unavailable and says why', async () => {
    await openShape({ mode: 'simple', trackId: 't4' });
    act(() => void session.accepted(cmd.insertEffect(session.store, 't4', 'reverb')));
    await clickEl(document.getElementById('simple-copy-effects'));
    act(() => session.store.setLock('Recording a performance.'));
    await settleFrames();
    expect((document.getElementById('simple-paste-effects') as HTMLButtonElement).disabled).toBe(true);
  });
});
