/**
 * shape-08 / shape-20: give a big knob a new setting to move, and edit how.
 *
 * - Every ParamKnob has a menu (right-click, a long press, Shift+F10):
 *   "Assign to big knob" with the six big knobs. Choosing one adds a mapping
 *   (setMacroTarget at index = list length) whose range keeps the setting
 *   where it is at the big knob's current position (no jump), then moves it.
 *   The big knob moving it now is checked; choosing it again stops it.
 * - A mapping row says its curve in words ("curve: even" / "curve: gentle", a
 *   key that switches it) and the part of the big knob's travel it uses
 *   ("over Motion [0]–[100] %", keyboard accessible), each one undo step.
 * Real clicks, keys and touch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { session } from '../../src/app/instance';
import { effectiveValue } from '../../src/app/views/shape/paramState';
import { button, clickEl, closeShape, keysOn, menuItem, nullDb, openShape, press, project, renderSolo, slider, track } from './r4-shape-helpers';
import { centre, settleFrames, touch } from './r4-uikit-input';

beforeEach(async () => {
  await openShape({ w: 1366, hh: 768, mode: 'advanced', trackId: 't4' });
});
afterEach(closeShape);

const tab = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.includes(name)) ?? null;
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const rackCard = (id: string) => document.getElementById(`rack-card-${id}`)!;
const resonance = () => effectiveValue(project(), 't4:filter', 'resonance')!;

describe('Assign to big knob', () => {
  it('right-click Filter Resonance → Motion: a mapping that keeps the sound, then moves it; checked next time; choosing it again stops it', async () => {
    await clickEl(tab('Effects'));
    const res = slider(rackCard('t4:filter'), 'Resonance');
    const before = resonance();
    const n = track('t4').macroMap.motion.length;
    await clickEl(res, { button: 'right' });
    expect(menu()?.getAttribute('aria-label')).toBe('Assign Filter Resonance to a big knob');
    expect([...menu()!.querySelectorAll('[role="menuitemcheckbox"] [class*="itemText"]')].map((x) => x.textContent)).toEqual(['Tone', 'Space', 'Echo', 'Motion', 'Drive', 'Pump']);
    await clickEl(menuItem('Motion'));
    expect(menu()).toBeNull();
    const list = track('t4').macroMap.motion;
    expect(list).toHaveLength(n + 1);
    expect(list[n]).toMatchObject({ module: 't4:filter', param: 'resonance', curve: 'lin' });
    // No jump: at Motion's current position the setting is where it was.
    expect(resonance()).toBeCloseTo(before, 5);
    // The knob is now read-only (Motion sets it) and turning Motion moves it.
    expect(slider(rackCard('t4:filter'), 'Resonance').getAttribute('aria-readonly')).toBe('true');
    await clickEl(tab('Macros'));
    await keysOn(document.getElementById('shape-macro-motion')!, '{End}');
    expect(resonance()).toBeGreaterThan(before + 0.3);
    await new Promise((r) => setTimeout(r, 900));
    // One undo step took it away again (the assignment), the Motion turn is its own step.
    act(() => session.undo());
    act(() => session.undo());
    expect(track('t4').macroMap.motion).toHaveLength(n);
  });

  it('an option control: Filter Mode → Space (at 28 %) keeps Low-pass and the sound (render), and steps on only past 28 %', async () => {
    await clickEl(tab('Effects'));
    const mode = () => effectiveValue(project(), 't4:filter', 'mode')!;
    expect(track('t4').macros.space).toBeCloseTo(0.28, 5);
    expect(mode()).toBe(0);
    const before = await renderSolo(structuredClone(project()), 't4');
    await clickEl(slider(rackCard('t4:filter'), 'Mode'), { button: 'right' });
    await clickEl(menuItem('Space'));
    const added = track('t4').macroMap.space.at(-1)!;
    expect(added).toMatchObject({ module: 't4:filter', param: 'mode', min: 0, max: 2, macroFrom: 0.28, macroTo: 1 });
    expect(mode()).toBe(0);
    const after = await renderSolo(structuredClone(project()), 't4');
    const diff = nullDb(before, after);
    console.info(`[assign] Filter Mode → Space at 28 %: null ${diff.toFixed(1)} dB`);
    expect(diff).toBeLessThan(-60);
    // Space down: still Low-pass; Space all the way up: Band-pass.
    await clickEl(tab('Macros'));
    await keysOn(document.getElementById('shape-macro-space')!, '{Home}');
    expect(mode()).toBe(0);
    await keysOn(document.getElementById('shape-macro-space')!, '{End}');
    expect(mode()).toBe(2);
  }, 90_000);

  it('a setting a big knob moves: its menu checks that big knob, and “Stop Motion moving it” hands it back to its own knob', async () => {
    await clickEl(tab('Effects'));
    const cutoff = slider(rackCard('t4:filter'), 'Cutoff');
    expect(cutoff.getAttribute('aria-readonly')).toBe('true');
    await clickEl(cutoff, { button: 'right' });
    expect(menuItem('Motion').getAttribute('aria-checked')).toBe('true');
    expect(menuItem('Tone').getAttribute('aria-checked')).toBe('false');
    await clickEl(menuItem('Stop Motion moving it'));
    expect(track('t4').macroMap.motion.some((x) => x.module === 't4:filter' && x.param === 'cutoff')).toBe(false);
    expect(slider(rackCard('t4:filter'), 'Cutoff').getAttribute('aria-readonly')).toBeNull();
  });

  it('Shift+F10 on a focused knob opens the same menu; Escape closes it and gives focus back', async () => {
    await clickEl(tab('Effects'));
    const mix = slider(rackCard('t4:filter'), 'Brightness');
    await keysOn(mix, '{Shift>}{F10}{/Shift}');
    expect(menu()).not.toBeNull();
    expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
    await press('{Escape}');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(slider(rackCard('t4:filter'), 'Brightness'));
  });

  it('a long press with a finger opens it too (and turns nothing)', async () => {
    await clickEl(tab('Instrument'));
    const col = document.getElementById('shape-col-instrument')!;
    const detune = slider(col, 'Detune');
    detune.scrollIntoView({ block: 'center' });
    await settleFrames();
    const value = track('t4').instrument.params.detune;
    const p = centre(detune, 0.5, 0.3);
    await touch('touchStart', [p]);
    await new Promise((r) => setTimeout(r, 900));
    await touch('touchEnd', []);
    await settleFrames(3);
    expect(menu(), 'menu after a long press').not.toBeNull();
    expect(track('t4').instrument.params.detune).toBe(value);
    await press('{Escape}');
  });

  it('a long press that then moves the finger opens the menu and still turns nothing', async () => {
    await clickEl(tab('Instrument'));
    const col = document.getElementById('shape-col-instrument')!;
    const detune = slider(col, 'Detune');
    detune.scrollIntoView({ block: 'center' });
    await settleFrames();
    const value = track('t4').instrument.params.detune;
    for (const at of [centre(detune, 0.5, 0.3), centre(detune, 0.15, 0.85)]) {
      await touch('touchStart', [at]);
      await new Promise((r) => setTimeout(r, 800));
      for (let i = 1; i <= 8; i++) {
        await touch('touchMove', [{ x: at.x, y: at.y - i * 6 }]);
        await new Promise((r) => requestAnimationFrame(r));
      }
      await touch('touchEnd', []);
      await settleFrames(3);
      expect(menu(), 'menu after a long press').not.toBeNull();
      expect(track('t4').instrument.params.detune, 'the finger moved after the menu opened').toBe(value);
      await press('{Escape}');
      await settleFrames(2);
    }
  });

  it('while a performance records, the Macros column’s mapping controls are unavailable and say why', async () => {
    await clickEl(tab('Macros'));
    act(() => session.store.setLock('Recording a performance.'));
    await settleFrames();
    const row = document.querySelector<HTMLElement>('[role="group"][aria-label="Tone moves Instrument Cutoff"]')!;
    const curve = [...row.querySelectorAll('button')].find((b) => b.textContent?.startsWith('curve:'))!;
    expect(curve.disabled).toBe(true);
    for (const f of row.querySelectorAll('input')) expect((f as HTMLInputElement).disabled).toBe(true);
    for (const k of row.querySelectorAll('[role="slider"]')) expect(k.getAttribute('aria-disabled')).toBe('true');
    expect(row.querySelector<HTMLButtonElement>('button[aria-label^="Remove"]')!.disabled).toBe(true);
    expect(button('Reset mappings').disabled).toBe(true);
    // Unlocked again: all of them work.
    act(() => session.store.setLock(null));
    await settleFrames();
    expect(curve.disabled).toBe(false);
    expect(button('Reset mappings').disabled).toBe(false);
  });

  it('while a performance records, the rows are unavailable and say why', async () => {
    await clickEl(tab('Effects'));
    act(() => session.store.setLock('Recording a performance.'));
    await settleFrames();
    await clickEl(slider(rackCard('t4:filter'), 'Resonance'), { button: 'right' });
    expect(menuItem('Space').getAttribute('aria-disabled')).toBe('true');
    expect(menuItem('Space').textContent).toContain('Locked while recording');
    await press('{Escape}');
  });
});

describe('mapping rows: curve and travel in words, editable', () => {
  it('“curve: gentle” switches to “curve: even” (one undo step); a range that reaches 0 cannot be gentle and says why', async () => {
    const tone = document.querySelector<HTMLElement>('section[aria-label="Tone macro"]')!;
    const cutoffRow = tone.querySelector<HTMLElement>('[aria-label="Tone moves Instrument Cutoff"]')!;
    const curve = button(/curve: gentle/, cutoffRow);
    expect(curve.textContent).toBe('curve: gentle');
    await clickEl(curve);
    expect(track('t4').macroMap.tone[0].curve).toBe('lin');
    expect(button(/curve: even/, cutoffRow).textContent).toBe('curve: even');
    act(() => session.undo());
    expect(track('t4').macroMap.tone[0].curve).toBe('exp');

    const space = document.querySelector<HTMLElement>('section[aria-label="Space macro"]')!;
    const sendCurve = button(/curve: even/, space);
    expect(sendCurve.disabled).toBe(true);
  });

  it('“over Tone [60]–[100] %”: the from and to fields take arrow keys and typing, each burst one undo step', async () => {
    const tone = document.querySelector<HTMLElement>('section[aria-label="Tone macro"]')!;
    const row = tone.querySelector<HTMLElement>('[aria-label="Tone moves Filter Brightness"]')!;
    expect(row.textContent).toContain('over Tone');
    const field = (text: string) => {
      const label = [...row.querySelectorAll('label')].find((l) => l.textContent?.startsWith(text));
      return label ? document.getElementById(label.htmlFor) : null;
    };
    const from = field('Filter Brightness: from Tone at')!;
    const to = field('Filter Brightness: to Tone at')!;
    expect(from, 'from field').not.toBeNull();
    expect(track('t4').macroMap.tone[1].macroFrom).toBeCloseTo(0.6, 5);
    await keysOn(from, '{ArrowUp}{ArrowUp}');
    await new Promise((r) => setTimeout(r, 900));
    expect(track('t4').macroMap.tone[1].macroFrom).toBeCloseTo(0.7, 5);
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    act(() => session.undo());
    expect(track('t4').macroMap.tone[1].macroFrom).toBeCloseTo(0.6, 5);
    // The to field can never go below from + 5 %.
    await keysOn(to, '{Control>}a{/Control}10{Enter}');
    expect(track('t4').macroMap.tone[1].macroTo).toBeCloseTo(0.65, 5);
    // Words for screen readers.
    expect(row.textContent).toMatch(/curve: even, over Tone 60–65%, from 0\.0 dB to \+5\.0 dB, now/);
  });
});
