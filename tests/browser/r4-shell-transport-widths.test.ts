/**
 * The transport at every supported width, Simple and Advanced (shell-09,
 * design-05, design-22, design-04, shell-08, PLAY-25, perf-01/03):
 * - one row from 1024 px (Advanced: from 1180 px), no overflow, every target
 *   at least 32 px; Export (and the word "Stop") from 1366 px in both modes;
 *   the right-hand group as wide in both modes, so the Simple · Advanced
 *   switch does not move when pressed; the bar.beat readout (and its state
 *   word) in both modes except Advanced at 1366-1439 px; Projects on the
 *   strip from 1600 px and the words of Undo and Redo from 1800 px, in both
 *   modes;
 * - below 1024 px two balanced rows (Master and Mute All on the second),
 *   within 15 % of a 540 px window;
 * - "Tempo" and the Record caption share one label style;
 * - playing with no clip in any part reads "Nothing to play yet";
 * - Record Notes waiting for its downbeat counts the beats ("Recording in 3…");
 * - a view tab braces playback first and shows at once; the meters read the
 *   shared per-frame meter frame.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { readMeterFrame } from '../../src/app/views/TransportBar';
import { setUiMode } from '../../src/state/uiStore';
import type { MeterFrame } from '../../src/audio/contracts';
import { button, click, closeShell, keys, openShell, settle, shown, transport, until } from './r4-shell-harness';

afterEach(async () => {
  vi.restoreAllMocks();
  await closeShell();
});

/** Visible clickable things on the strip smaller than 32 px either way. */
function smallTargets(): string[] {
  return [...transport().querySelectorAll<HTMLElement>('button, [role="tab"], [role="radio"], [role="slider"], input')]
    .filter((el) => shown(el) && !el.closest('[aria-hidden="true"]'))
    .filter((el) => el.tagName !== 'INPUT')
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width < 31.5 || r.height < 31.5;
    })
    .map((el) => `${el.getAttribute('aria-label') ?? el.textContent?.trim()} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`);
}

const exportKey = () => buttonOnStrip('Export');
function buttonOnStrip(name: string) {
  return [...transport().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name) ?? null;
}
const right = () => transport().querySelector<HTMLElement>('[role="radiogroup"][aria-label="Simple or Advanced"]')?.parentElement ?? null;
const positionShown = () => shown(transport().querySelector('[role="group"][aria-label="Position"]'));
const projectsShown = () => shown(transport().querySelector('[class*="projectKey"]'));
const undoWordShown = () => {
  const word = [...transport().querySelectorAll('button span')].find((s) => s.textContent === 'Undo');
  return !!word && word.getBoundingClientRect().width > 2;
};
const stopWordShown = () => {
  const word = [...transport().querySelectorAll('button span')].find((s) => s.textContent === 'Stop');
  return !!word && word.getBoundingClientRect().width > 2;
};

describe('the strip at every width', () => {
  it('fits, keeps Export and Stop from 1366 px in both modes, and the switch stays put', async () => {
    await openShell();
    await keys('{Escape}');
    for (const w of [1024, 1280, 1366, 1440, 1520, 1599, 1600, 1700, 1799, 1800, 1920]) {
      await page.viewport(w, w >= 1920 ? 1080 : 768);
      const at: Record<string, { right: number; switchX: number | null }> = {};
      for (const mode of ['simple', 'advanced'] as const) {
        act(() => setUiMode(mode));
        await settle(80);
        const label = `${w} ${mode}`;
        expect(transport().scrollWidth, `${label}: overflow`).toBeLessThanOrEqual(transport().clientWidth + 1);
        expect(document.scrollingElement!.scrollWidth, `${label}: page`).toBeLessThanOrEqual(window.innerWidth);
        expect(smallTargets(), `${label}: small targets`).toEqual([]);
        if (w >= 1366) {
          expect(shown(exportKey()), `${label}: Export`).toBe(true);
          expect(stopWordShown(), `${label}: the word Stop`).toBe(true);
          // The bar.beat readout gives way to Swing only in Advanced at 1366-1439 px.
          expect(positionShown(), `${label}: bar.beat`).toBe(!(mode === 'advanced' && w < 1440));
          expect(projectsShown(), `${label}: Projects`).toBe(w >= 1600);
          expect(undoWordShown(), `${label}: the word Undo`).toBe(w >= 1800);
        }
        if (mode === 'simple' || w >= 1180) expect(Math.round(transport().getBoundingClientRect().height), `${label}: one row`).toBe(58);
        const sw = transport().querySelector('[role="radiogroup"][aria-label="Simple or Advanced"]');
        at[mode] = { right: Math.round(right()!.getBoundingClientRect().width), switchX: shown(sw) ? Math.round(sw!.getBoundingClientRect().left) : null };
      }
      // The right-hand group is one width in both modes: the switch does not jump.
      expect(at.advanced, `${w}: right group`).toEqual(at.simple);
    }
  });

  it('below 1024 px: two balanced rows within 15 % of a 540 px window, Master and Mute All on the second', async () => {
    await openShell({ width: 960, height: 540 });
    await keys('{Escape}');
    for (const mode of ['simple', 'advanced'] as const) {
      act(() => setUiMode(mode));
      await settle(80);
      const bar = transport().getBoundingClientRect();
      expect(bar.height, `${mode}: height`).toBeLessThanOrEqual(540 * 0.15);
      const views = transport().querySelector('[role="tablist"]')!.getBoundingClientRect();
      const muteAll = button('Mute All', transport())!.getBoundingClientRect();
      const master = transport().querySelector('[role="slider"]')!.getBoundingClientRect();
      expect(muteAll.top, `${mode}: Mute All on row 2`).toBeGreaterThanOrEqual(views.bottom);
      expect(master.top, `${mode}: Master on row 2`).toBeGreaterThanOrEqual(views.bottom - 4);
      expect(transport().scrollWidth).toBeLessThanOrEqual(transport().clientWidth + 1);
      expect(smallTargets(), `${mode}: small targets`).toEqual([]);
    }
  });
});

describe('labels, words and counts', () => {
  it('"Tempo" and the Record caption share one label style', async () => {
    await openShell();
    await keys('{Escape}');
    const tempo = transport().querySelector('label')!;
    const rec = transport().querySelector('[role="group"][aria-label="Recording"] > span')!;
    const style = (el: Element) => {
      const cs = getComputedStyle(el);
      return [cs.fontSize, cs.fontWeight, cs.letterSpacing, cs.textTransform, cs.color].join(' ');
    };
    expect(tempo.textContent).toBe('Tempo');
    expect(style(rec)).toBe(style(tempo));
  });

  it('playing with no clip in any part says "Nothing to play yet"', async () => {
    await openShell();
    await keys('{Escape}');
    const word = () => transport().querySelector('[role="group"][aria-label="Position"] [role="status"]')!.textContent;
    act(() => patchRuntime({ playing: true, mode: 'live', tracks: { t1: { playingSlot: 1, queued: null } } }));
    await settle(800);
    expect(word()).toBe('Playing');
    act(() => patchRuntime({ tracks: { t1: { playingSlot: null, queued: null } } }));
    await until(() => word() === 'Nothing to play yet', 'the words', 3000);
    // A clip queued for the next bar counts as something to play.
    act(() => patchRuntime({ tracks: { t1: { playingSlot: null, queued: { slot: 2, atTick: 384 } } } }));
    await settle(50);
    expect(word()).toBe('Playing');
  });

  it('Record Notes waiting for its downbeat counts the beats as heard', async () => {
    await openShell();
    await keys('{Escape}');
    let tick = 384 - 3 * 96 + 10;
    // The transport as far as the strip reads it: the position (bar.beat) and the position heard.
    const fake = {
      playing: true,
      paused: false,
      audibleTick: () => tick,
      getPosition: () => ({ tick, bar: Math.floor(tick / 384), beat: Math.floor((tick % 384) / 96) }),
      // What the pads read for their loop progress: nothing plays in this stand-in.
      clipPhase: () => null,
      queuedAt: () => null,
      // The pads' progress animation reads the tempo from it.
      sequencer: { bpm: 120 },
    } as unknown as NonNullable<typeof session.transport>;
    const real = session.transport;
    session.transport = fake;
    try {
      act(() => patchRuntime({ playing: true, mode: 'live', recording: 'notes', recordTarget: { trackId: 't3', slot: 1 }, recordStartsAtTick: 384 }));
      const caption = () => transport().querySelector('[role="group"][aria-label="Recording"] > span')!.textContent ?? '';
      await until(() => caption().includes('Recording in 3…'), 'three beats');
      expect(caption()).toContain('Bass');
      tick = 384 - 96 + 1;
      await until(() => caption().includes('Recording in 1…'), 'one beat');
      act(() => patchRuntime({ recordStartsAtTick: null, tracks: { t3: { playingSlot: 1, queued: null } } }));
      await until(() => caption().includes('Recording · Bass'), 'recording');
    } finally {
      session.transport = real;
      act(() => patchRuntime({ recording: 'off', recordTarget: null, playing: false, tracks: {} }));
    }
  });
});

describe('switching views and reading meters', () => {
  it('a view tab braces playback first and is selected at once; the strip reads the shared meter frame', async () => {
    await openShell();
    await keys('{Escape}');
    const order: string[] = [];
    const brace = vi.spyOn(session, 'brace').mockImplementation(() => void order.push('brace'));
    const tab = [...transport().querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Mix')!;
    await click(tab);
    expect(brace).toHaveBeenCalled();
    expect(tab.getAttribute('aria-selected')).toBe('true');
    const frame: MeterFrame = { masterPeakL: 0.5, masterPeakR: 0.25, masterRms: 0.1, limiterReductionDb: 0, tracks: [] };
    const shared = vi.spyOn(session, 'readMetersShared').mockReturnValue(frame);
    expect(readMeterFrame()).toBe(frame);
    expect(shared).toHaveBeenCalled();
    shared.mockReturnValue(null);
    expect(readMeterFrame().masterPeakL).toBe(0);
  });
});
