/**
 * The effects rack shown outside Shape (Mix's channel drawer renders
 * <EffectsRack trackId embedded />): its undo steps name the part in words
 * ("Drums filter cutoff", "Turn off Drums drive"), a shared return's name
 * the return, and the rack leaves the take-lock notice to its host. In Shape
 * itself the commands' own names stay. Real keys and clicks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { TipsProvider, ToastProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { EffectsRack } from '../../src/app/views/shape/EffectsRack';
import { HOUSE } from '../../src/content/starters/house';
import { selectTrack } from '../../src/state/uiStore';
import { clickEl, keysOn, slider } from './r4-shape-helpers';
import { settleFrames } from './r4-uikit-input';
import { cleanup, mount } from './ui-harness';

afterEach(() => {
  cleanup();
  session.store.setLock(null);
});

const undoLabel = () => session.store.info.getState().undoLabel;

async function openRack(embedded: boolean): Promise<HTMLElement> {
  await page.viewport(1366, 900);
  act(() => {
    session.store.setLock(null);
    session.store.replace(HOUSE.build());
    selectTrack('t1');
  });
  const m = mount(h(TipsProvider, { enabled: false }, h(ToastProvider, null, h(EffectsRack, { trackId: 't1', embedded }))), { width: 900 });
  m.container.style.height = '760px';
  await settleFrames(3);
  return m.container;
}

describe('the effects rack outside Shape (embedded)', () => {
  it('names the part in its undo steps: “Drums filter cutoff”, “Turn off Drums drive”, “Reverb size”', async () => {
    const root = await openRack(true);
    const filter = document.getElementById('rack-card-t1:filter')!;
    await keysOn(slider(filter, 'Resonance'), '{ArrowUp}');
    expect(undoLabel()).toBe('Drums filter resonance');
    const drive = document.getElementById('rack-card-t1:drive')!;
    await clickEl(drive.querySelector<HTMLElement>('[role="switch"]'));
    expect(undoLabel()).toBe('Turn off Drums drive');
    const reverb = [...root.querySelectorAll<HTMLElement>('section, [role="group"]')].find((x) => x.getAttribute('aria-label') === 'Shared Reverb return')!;
    await keysOn(slider(reverb, 'Size'), '{ArrowUp}');
    expect(undoLabel()).toBe('Reverb size');
  });

  it('leaves the take-lock notice to its host; in Shape the rack shows it and keeps the commands’ own undo names', async () => {
    const root = await openRack(true);
    act(() => session.store.setLock('Recording a performance.'));
    await settleFrames();
    expect(root.textContent).not.toContain('Effects are locked while a performance records.');
    cleanup();
    const own = await openRack(false);
    act(() => session.store.setLock('Recording a performance.'));
    await settleFrames();
    expect(own.textContent).toContain('Effects are locked while a performance records.');
    act(() => session.store.setLock(null));
    await settleFrames();
    await keysOn(slider(document.getElementById('rack-card-t1:filter')!, 'Resonance'), '{ArrowUp}');
    expect(undoLabel()).not.toMatch(/^Drums /);
  });
});
