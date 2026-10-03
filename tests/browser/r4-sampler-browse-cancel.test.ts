/**
 * shape-07 and design-16: browsing sounds is safe. The whole app (House
 * starter), real clicks and keys:
 * - the dialog is titled like the key that opens it ("Change instrument: Chords");
 * - Tone tweaked to 0.70, then Glass Keys → Tine Piano → House Stab →
 *   "Cancel (back to House Stab as you had it)" gives Tone 0.70 and the
 *   whole sound back, leaves no undo step, and Undo still undoes the Tone move;
 * - Done, × and Escape keep the choice, and the whole browse is one Undo;
 * - the footer fits at 1366 x 768, 1920 x 1080 and 960 x 540.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { snapshotTrackSound } from '../../src/state/commands';
import { selectTrack } from '../../src/state/uiStore';
import { SIZES, button, clickEl, openApp, press, project, setUp, tearDown, track, until } from './r4-sampler-helpers';
import { settleFrames } from './r4-uikit-input';

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
const card = (name: string) => [...(dialog()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find((o) => o.textContent?.includes(name)) ?? null;
const tone = () => track('t4').macros.tone;
const sound = () => snapshotTrackSound(project(), 't4');

async function openBrowser(): Promise<HTMLElement> {
  act(() => selectTrack('t4'));
  await settleFrames();
  // The part panel's key for the selected part (Chords).
  const key = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Change instrument"]')].find((b) => b.offsetParent !== null);
  await clickEl(key ?? null);
  await until(() => !!dialog(), 'the sound browser');
  return dialog()!;
}

async function choose(name: string): Promise<void> {
  const c = card(name);
  if (!c) throw new Error(`no card ${name}`);
  await clickEl(c);
  await until(() => card(name)?.getAttribute('aria-selected') === 'true', `${name} to be chosen`);
}

beforeEach(async () => {
  await setUp();
});
afterEach(async () => {
  await tearDown();
});

describe('Sound browser: Cancel and one undo step (shape-07)', () => {
  it('Tone 0.70, then Glass Keys → Tine Piano → House Stab → Cancel: Tone 0.70 and the sound exactly as it was; Undo still undoes the Tone move', async () => {
    await openApp(1366, 768);
    const starterTone = tone();
    act(() => session.setMacro('t4', 'tone', 0.7));
    expect(tone()).toBe(0.7);
    const before = sound();
    expect(session.store.undoLabel()).toBe('Change Tone');

    const d = await openBrowser();
    // design-16: the title matches the key that opened it.
    expect(d.querySelector('h2')?.textContent).toBe('Change instrument: Chords');
    expect(document.getElementById(d.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Change instrument: Chords');
    const cancel = button('Cancel (back to House Stab as you had it)', d);
    expect(cancel, 'Cancel names the sound it goes back to').not.toBeNull();
    expect(cancel!.textContent).toBe('Cancel (back to House Stab as you had it)');

    await choose('Glass Keys');
    expect(track('t4').instrument).toMatchObject({ presetId: 'poly-glass-keys' });
    await choose('Tine Piano');
    await choose('House Stab');
    // Re-choosing the original loads its preset: the tweak is gone (the reason Cancel exists).
    expect(tone()).not.toBe(0.7);
    // The whole browse is one step so far.
    expect(session.store.undoLabel()).toBe('Change sound');

    await clickEl(button('Cancel (back to House Stab as you had it)', dialog()!));
    await until(() => !dialog(), 'the dialog to close');
    expect(tone()).toBe(0.7);
    expect(sound()).toEqual(before);
    expect(runtimeStore.getState().notice?.text).toBe('Chords is back to House Stab as you had it.');
    // No step was left: Undo is still about the Tone move (real Ctrl+Z).
    expect(session.store.undoLabel()).toBe('Change Tone');
    await press('{Control>}z{/Control}');
    await until(() => tone() === starterTone, 'Undo to undo the Tone move');
  });

  it('Done keeps the choice; the whole browse is one Undo back to the tweaked sound', async () => {
    await openApp(1366, 768);
    act(() => session.setMacro('t4', 'tone', 0.7));
    const before = sound();
    await openBrowser();
    await choose('Glass Keys');
    await choose('Tine Piano');
    await clickEl(button('Done', dialog()!));
    await until(() => !dialog(), 'the dialog to close');
    expect(track('t4').instrument).toMatchObject({ presetId: 'poly-tine-piano' });
    expect(runtimeStore.getState().notice?.text).toBe('Chords now plays Tine Piano. Undo brings back House Stab as you had it.');
    expect(session.store.undoLabel()).toBe('Change sound');
    act(() => session.undo());
    expect(sound()).toEqual(before);
    expect(tone()).toBe(0.7);
    expect(session.store.undoLabel()).toBe('Change Tone');
  });

  it('Escape and × keep the choice too', async () => {
    await openApp(1366, 768);
    await openBrowser();
    await choose('Glass Keys');
    await press('{Escape}');
    await until(() => !dialog(), 'Escape to close');
    expect(track('t4').instrument).toMatchObject({ presetId: 'poly-glass-keys' });
    await openBrowser();
    // Cancel now goes back to what was kept.
    expect(button('Cancel (back to Glass Keys as you had it)', dialog()!)).not.toBeNull();
    await choose('Tine Piano');
    await clickEl(dialog()!.querySelector('button[aria-label="Close"]'));
    await until(() => !dialog(), '× to close');
    expect(track('t4').instrument).toMatchObject({ presetId: 'poly-tine-piano' });
    // Two browses, two steps.
    act(() => session.undo());
    expect(track('t4').instrument).toMatchObject({ presetId: 'poly-glass-keys' });
    act(() => session.undo());
    expect(track('t4').instrument).toMatchObject({ presetId: 'poly-house-stab' });
  });

  it('a browse that changed nothing leaves no step, and Cancel right away changes nothing', async () => {
    await openApp(1366, 768);
    act(() => session.setMacro('t4', 'tone', 0.7));
    const p0 = project();
    await openBrowser();
    await clickEl(button('Cancel (back to House Stab as you had it)', dialog()!));
    await until(() => !dialog(), 'the dialog to close');
    expect(project()).toBe(p0);
    expect(session.store.undoLabel()).toBe('Change Tone');
  });

  for (const size of SIZES) {
    it(`the footer fits at ${size.name}: Cancel, Preview and Done are whole, at least 32 px tall`, async () => {
      await openApp(size.w, size.h);
      const d = await openBrowser();
      for (const a of document.getAnimations()) a.finish();
      await settleFrames();
      const r = d.getBoundingClientRect();
      expect(r.right).toBeLessThanOrEqual(size.w + 0.5);
      expect(r.bottom).toBeLessThanOrEqual(size.h + 0.5);
      for (const name of ['Cancel (back to House Stab as you had it)', 'Preview', 'Done']) {
        const b = button(name, d)!;
        const br = b.getBoundingClientRect();
        expect(br.height, name).toBeGreaterThanOrEqual(32);
        expect(br.left, name).toBeGreaterThanOrEqual(r.left - 0.5);
        expect(br.right, name).toBeLessThanOrEqual(r.right + 0.5);
      }
      // The Cancel key's own words fit, or are cut with an ellipsis inside it (never spilling out).
      const c = button('Cancel (back to House Stab as you had it)', d)!;
      expect(c.scrollWidth).toBeLessThanOrEqual(c.clientWidth + 1);
    });
  }
});
