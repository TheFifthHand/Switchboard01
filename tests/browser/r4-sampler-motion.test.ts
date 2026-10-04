/**
 * design-01 (the sampler's part): with reduced motion nothing in the
 * sampler editor blinks or spins. The recording dot is a steady coral dot,
 * the Stop recording key keeps a steady ring, and a spinner (a ring that
 * would stand still) gives way to the words beside it, said once
 * ("Normalizing…", "Decoding … on this device…"). Sampled across animation
 * frames under the browser's own reduced-motion setting (CDP).
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/ui/theme.css';
import { TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { audioInput } from '../../src/app/views/devices';
import { SamplerEditor } from '../../src/app/views/sampler';
import { editStore } from '../../src/app/views/sampler/sampleVersions';
import { importStore } from '../../src/app/views/sampler/importState';
import { createProject } from '../../src/project/factory';
import { reducedMotion } from './r4-uikit-input';
import { cleanup, mount } from './ui-harness';

/** Computed `prop` of `el` over `n` animation frames. */
async function sample(el: Element, prop: string, n = 20): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    out.push(getComputedStyle(el).getPropertyValue(prop));
  }
  return out;
}

function setUpTake(): HTMLElement {
  act(() => {
    session.store.replace(createProject({ name: 'Motion', now: 1 }));
    // A take on Vocal (the UI's view of it; no device involved).
    audioInput.state.setState((st) => ({ ...st, take: { trackId: 't8', bars: 1, startTick: 0, endTick: 384, phase: 'recording' } }));
    editStore.setState({ t8: { phase: 'working', kind: 'normalize' } });
    importStore.setState({ t8: { phase: 'decoding', fileName: 'Loop.wav' } });
  });
  return mount(h(TipsProvider, { enabled: false }, h(SamplerEditor, { trackId: 't8' })), { width: 420 }).container;
}

beforeEach(async () => {
  await reducedMotion(false);
});
afterEach(async () => {
  cleanup();
  act(() => {
    audioInput.state.setState((st) => ({ ...st, take: null }));
    editStore.setState({});
    importStore.setState({});
  });
  await reducedMotion(false);
});

describe('Reduced motion in the sampler editor (design-01)', () => {
  it('reduce: a steady coral dot and ring; no spinner, the words beside it said once', async () => {
    await reducedMotion(true);
    const root = setUpTake();
    const dot = root.querySelector<HTMLElement>('[class*="recDot"]')!;
    const stop = [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Stop recording')!;
    expect(dot).toBeTruthy();
    expect(stop).toBeTruthy();
    const opacity = await sample(dot, 'opacity');
    expect(new Set(opacity)).toEqual(new Set(['1']));
    expect(getComputedStyle(dot).animationName).toBe('none');
    // Coral (recording), solid.
    const probe = document.createElement('span');
    probe.style.background = 'var(--coral)';
    document.body.append(probe);
    expect(getComputedStyle(dot).backgroundColor).toBe(getComputedStyle(probe).backgroundColor);
    probe.remove();
    const ring = await sample(stop, 'box-shadow');
    expect(new Set(ring).size).toBe(1);
    expect(ring[0]).not.toBe('none');
    // No spinner stands still: they go, and the words beside them say what is going on, once each.
    const spinners = [...root.querySelectorAll<HTMLElement>('[class*="spinner"]')];
    expect(spinners.length).toBe(2);
    for (const sp of spinners) expect(getComputedStyle(sp).display).toBe('none');
    const text = root.textContent ?? '';
    expect(text).toContain('Normalizing…');
    expect(text).toContain('Decoding “Loop.wav” on this device…');
    expect(text).not.toContain('Loading…');
  });

  it('no preference: the dot blinks, the ring pulses and the spinners turn', async () => {
    const root = setUpTake();
    const dot = root.querySelector<HTMLElement>('[class*="recDot"]')!;
    expect(getComputedStyle(dot).animationName).not.toBe('none');
    expect(new Set(await sample(dot, 'opacity', 40)).size).toBeGreaterThan(3);
    for (const sp of root.querySelectorAll<HTMLElement>('[class*="spinner"]')) {
      expect(getComputedStyle(sp).animationName).not.toBe('none');
      expect(sp.getBoundingClientRect().width).toBeGreaterThan(0);
    }
  });
});
