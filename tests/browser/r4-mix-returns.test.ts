/**
 * Return strips (MIX-08, capability-13) on the real session and audio engine, with real input:
 * the shared Reverb and Echo sit between the parts and the master, each with a one-line caption,
 * its two character knobs (Size/Tone, Time/Feedback), Mute, a level fader (the module's Mix) and a
 * meter after the return (MeterFrame.returns). Every change is the real patch: undoable; knobs and
 * the level are recorded by a performance take, Mute is refused during one, with the reason.
 */
import { act, createElement as h } from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import type { MeterFrame } from '../../src/audio/contracts';
import { TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { TAKE_LOCK_MESSAGE } from '../../src/app/session';
import { MixView } from '../../src/app/views/mix/MixView';
import { resetLoudnessWatch } from '../../src/app/views/mix/loudnessMatch';
import { getStarter } from '../../src/content/starters';
import { DELAY_ID, REVERB_ID } from '../../src/project/factory';
import { setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';
import { centre, click, send, settleFrames } from './r4-uikit-input';

const frame: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
const mod = (id: string) => session.store.getState().patch.modules.find((m) => m.id === id)!;

/** Loudest reading after a return (or of the master) over `ms` of real output. */
async function peakOver(ms: number, which?: 'reverb' | 'delay'): Promise<number> {
  let peak = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    session.readMeters(frame);
    const v = which ? (frame.returns?.[which].peak ?? 0) : Math.max(frame.masterPeakL, frame.masterPeakR);
    peak = Math.max(peak, v);
    await act(async () => wait(25));
  }
  return peak;
}

async function pressKey(key: string, code: string, vk: number) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  await settleFrames();
}

let root: HTMLElement;
const strip = (kind: 'reverb' | 'delay') => root.querySelector<HTMLElement>(`[data-testid="strip-return-${kind}"]`)!;
const slider = (el: ParentNode, name: string) => el.querySelector<HTMLElement>(`[role="slider"][aria-label="${name}"]`)!;

async function press(el: HTMLElement) {
  el.scrollIntoView({ block: 'center' });
  await click(centre(el));
  await act(async () => wait(30));
}

beforeAll(async () => {
  await page.viewport(1366, 768);
  act(() => {
    const p = getStarter('house')!.build();
    // Chords send plenty to both returns.
    const chords = p.tracks.find((t) => t.id === 't4')!;
    chords.macros = { ...chords.macros, space: 0.7, echo: 0.6 };
    session.store.replace(p);
    setUiMode('simple');
    setView('mix');
  });
  resetLoudnessWatch();
  const m = mount(h(TipsProvider, { enabled: false }, h(MixView)), { width: 1366 });
  m.container.style.padding = '0';
  m.container.style.height = '610px';
  root = m.container;
  await act(async () => {
    await session.play();
  });
  expect(runtimeStore.getState().audio).toBe('running');
  await act(async () => wait(1500));
});

afterAll(() => {
  act(() => session.stop());
  cleanup();
  session.dispose();
  patchRuntime({ playing: false, muteAll: false, recording: 'off' });
});

describe('Return strips on the real engine', () => {
  it('sit between the parts and the master, with a one-line caption and their two main knobs', () => {
    const order = [...root.querySelectorAll<HTMLElement>('[data-testid^="strip-"]')].map((s) => s.dataset.testid);
    expect(order.slice(-3)).toEqual(['strip-return-reverb', 'strip-return-delay', 'strip-master']);
    for (const [kind, name, caption, knobs] of [
      ['reverb', 'Reverb', 'Shared room', ['Reverb size', 'Reverb tone']],
      ['delay', 'Echo', 'Shared echo', ['Echo time', 'Echo feedback']],
    ] as const) {
      const s = strip(kind);
      expect(s.getAttribute('aria-label')).toBe(`${name} return`);
      const cap = s.querySelector<HTMLElement>(`[data-testid="return-caption-${kind}"]`)!;
      expect(cap.textContent).toBe(caption);
      // One line, whole.
      const r = document.createRange();
      r.selectNodeContents(cap);
      expect(r.getClientRects().length).toBe(1);
      expect(cap.scrollWidth).toBeLessThanOrEqual(cap.clientWidth + 1);
      for (const k of knobs) expect(slider(s, k), k).not.toBeNull();
      expect(slider(s, `${name} return level`).getAttribute('aria-valuetext')).toBe('0.0 dB');
      expect(s.querySelector(`[role="meter"][aria-label="${name} return meter"]`)).not.toBeNull();
    }
  });

  it('the meters read what each return adds to the mix', async () => {
    expect(await peakOver(1200, 'reverb')).toBeGreaterThan(0.003);
    expect(await peakOver(1200, 'delay')).toBeGreaterThan(0.003);
    await act(async () => wait(200));
    const meter = strip('reverb').querySelector('[role="meter"]')!;
    expect(meter.getAttribute('aria-valuetext')).not.toBe('Silent');
  });

  it('Mute switches the return off for every part (the meter reads silence, the parts play on), keeps its level, and is undoable', async () => {
    const s = strip('reverb');
    const mute = s.querySelector<HTMLButtonElement>('button[aria-label="Mute Reverb return"]')!;
    const mixBefore = mod(REVERB_ID).params.mix ?? 1;
    await press(mute);
    expect(mod(REVERB_ID).bypass).toBe(true);
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    expect(s.textContent).toContain('Muted');
    expect(runtimeStore.getState().notice?.text).toMatch(/shared Reverb is muted/);
    // Undo names it in the strip's words.
    expect(session.store.undoLabel()).toBe('Mute Reverb return');
    await act(async () => wait(150));
    expect(await peakOver(600, 'reverb')).toBe(0);
    expect(await peakOver(600)).toBeGreaterThan(0.01);
    // Its own settings are kept.
    expect(mod(REVERB_ID).params.mix ?? 1).toBe(mixBefore);
    act(() => session.undo());
    expect(mod(REVERB_ID).bypass).toBe(false);
    expect(await peakOver(1500, 'reverb')).toBeGreaterThan(0.003);
    // Muted and unmuted again: each its own step, in words.
    await press(mute);
    await press(mute);
    expect(mod(REVERB_ID).bypass).toBe(false);
    expect(session.store.undoLabel()).toBe('Unmute Reverb return');
    act(() => session.undo());
    act(() => session.undo());
    expect(mod(REVERB_ID).bypass).toBe(false);
  });

  it('the level fader sets the return’s Mix in dB (keys, one undo step); 0 dB is all the way up', async () => {
    const s = strip('delay');
    const f = slider(s, 'Echo return level');
    await press(f);
    await pressKey('ArrowDown', 'ArrowDown', 40);
    await pressKey('ArrowDown', 'ArrowDown', 40);
    // −1 dB of the echo's level: its Mix is 10^(−1/20).
    expect(mod(DELAY_ID).params.mix).toBeCloseTo(10 ** (-1 / 20), 3);
    expect(f.getAttribute('aria-valuetext')).toBe('−1.0 dB');
    await act(async () => wait(900));
    expect(session.store.undoLabel()).toBe('Echo return level');
    await pressKey('Home', 'Home', 36);
    expect(mod(DELAY_ID).params.mix).toBe(0);
    expect(f.getAttribute('aria-valuetext')).toBe('−60.0 dB, silent');
    await act(async () => wait(900));
    // A send-only return passes its wet sound times its Mix (no dry path): at the bottom it is silent.
    const atZero = await peakOver(800, 'delay');
    console.info(`[returns] echo return at Mix 0 reads ${atZero.toFixed(4)}`);
    expect(atZero).toBeLessThan(1e-3);
    act(() => session.undo());
    act(() => session.undo());
    expect(mod(DELAY_ID).params.mix ?? 1).toBe(1);
  });

  it('Size and Time turn the shared Reverb and Echo (undoable)', async () => {
    const size = slider(strip('reverb'), 'Reverb size');
    const before = mod(REVERB_ID).params.decay ?? 2.4;
    await press(size);
    await pressKey('PageUp', 'PageUp', 33);
    expect(mod(REVERB_ID).params.decay).toBeGreaterThan(before);
    const time = slider(strip('delay'), 'Echo time');
    const div = mod(DELAY_ID).params.division ?? 2;
    await press(time);
    await pressKey('ArrowUp', 'ArrowUp', 38);
    expect(mod(DELAY_ID).params.division).toBe(div + 1);
    expect(session.store.undoLabel()).toBe('Echo time');
    expect(strip('delay').textContent).toContain('Time');
    await act(async () => wait(900));
    act(() => session.undo());
    act(() => session.undo());
    expect(mod(REVERB_ID).params.decay ?? 2.4).toBe(before);
    expect(mod(DELAY_ID).params.division ?? 2).toBe(div);
  });

  it('during a performance take: the level is recorded, Mute is refused with the reason', async () => {
    act(() => {
      session.store.setLock(TAKE_LOCK_MESSAGE, (label) => label.startsWith('module:'));
      patchRuntime({ recording: 'performance' });
    });
    try {
      const s = strip('reverb');
      await press(s.querySelector<HTMLButtonElement>('button[aria-label="Mute Reverb return"]')!);
      expect(mod(REVERB_ID).bypass).toBe(false);
      expect(runtimeStore.getState().notice?.text).toBe(TAKE_LOCK_MESSAGE);
      const f = slider(s, 'Reverb return level');
      await press(f);
      await pressKey('ArrowDown', 'ArrowDown', 40);
      expect(mod(REVERB_ID).params.mix).toBeLessThan(1);
    } finally {
      act(() => {
        session.store.setLock(null);
        patchRuntime({ recording: 'off' });
      });
    }
  });
});
