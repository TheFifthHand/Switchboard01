/**
 * Reduced motion keeps the lights still (the OS setting, emulated through CDP): in the running app
 * the record dot and the ring of the Performance key, sampled over 30 frames while a take records,
 * do not change at all; with normal motion they pulse (so the sampling would see it). A blinking
 * Led rests steadily on, and a looping animation anywhere rests in its base state.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { deleteDb } from '../../src/persistence/db';
import { setGuideDone, setTipsEnabled, setUiMode, setView } from '../../src/state/uiStore';
import { Led } from '../../src/ui/components';
import { cleanup, mount, nextFrame, wait } from './ui-harness';
import { reducedMotion } from './r4-uikit-input';

let boot: BootInfo;

beforeEach(async () => {
  await deleteDb();
  act(() => {
    setGuideDone(true);
    setTipsEnabled(true);
    setUiMode('simple');
    setView('play');
    patchRuntime({ playing: false, paused: false, recording: 'off', notice: null, tracks: {}, muteAll: false });
  });
  boot = await session.boot();
});

afterEach(async () => {
  await reducedMotion(false);
  cleanup();
  act(() => patchRuntime({ playing: false, paused: false, recording: 'off', tracks: {} }));
  await session.autosaver?.flush();
  await deleteDb();
});

async function openApp() {
  await page.viewport(1366, 768);
  const m = mount(h(App, { boot }));
  m.container.style.width = '';
  m.container.style.padding = '0';
  const look = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Just look around');
  await act(async () => {
    look?.click();
    await wait(20);
  });
  await act(async () => {
    await session.newFromStarter('house');
  });
  // No audio: the recording state alone is what is drawn.
  act(() => patchRuntime({ playing: true, paused: false, recording: 'performance', tracks: {} }));
  await act(async () => {
    await wait(100);
  });
}

/** Computed `prop` of `el` on each of `n` frames. */
async function sample(el: Element, prop: 'opacity' | 'boxShadow', n = 30): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    await nextFrame();
    out.push(getComputedStyle(el)[prop]);
  }
  return out;
}

describe('reduced motion', () => {
  it('the record dot and the recording key stay still for 30 frames (no flicker)', async () => {
    await reducedMotion(true);
    await openApp();
    const dot = document.querySelector<HTMLElement>('[class*="recDot"]')!;
    const key = document.querySelector<HTMLElement>('header[aria-label="Transport"] button[aria-label="Stop recording performance"]')!;
    expect(dot).not.toBeNull();
    expect(key).not.toBeNull();
    await nextFrame();
    const dots = await sample(dot, 'opacity');
    const rings = await sample(key, 'boxShadow');
    expect(new Set(dots)).toEqual(new Set(['1'])); // solid
    expect(new Set(rings).size).toBe(1);
  });

  it('with normal motion the same dot pulses (what the sampling would catch)', async () => {
    await reducedMotion(false);
    await openApp();
    const dot = document.querySelector<HTMLElement>('[class*="recDot"]')!;
    const dots = await sample(dot, 'opacity');
    expect(new Set(dots).size).toBeGreaterThan(3);
  });

  it('a blinking Led rests on, and any looping animation rests in its base state', async () => {
    await reducedMotion(true);
    const style = document.createElement('style');
    style.textContent = '@keyframes r4pulse { 50% { opacity: 0.2 } } .r4loop { animation: r4pulse 0.9s ease-in-out infinite; }';
    document.head.append(style);
    try {
      const m = mount(h('div', null, h(Led, { on: true, blink: true, label: 'Saving…' }), h('span', { className: 'r4loop' }, 'loop')));
      const lamp = m.container.querySelector<HTMLElement>('[class*="lamp"]')!;
      const loop = m.container.querySelector<HTMLElement>('.r4loop')!;
      await nextFrame();
      expect(new Set(await sample(lamp, 'opacity'))).toEqual(new Set(['1']));
      expect(new Set(await sample(loop, 'opacity'))).toEqual(new Set(['1']));
    } finally {
      style.remove();
    }
  });
});
