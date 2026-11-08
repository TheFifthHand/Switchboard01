/**
 * Round 7: the Sound panel of one instrument (EASY_SPEC §6), in real
 * Chromium with real mouse and keys, as the Song screen's side shows it
 * (about 300 px wide): its name (rename on click), Change sound… (the Sound
 * browser), Volume, Mute and Hear it alone (the part's own level, Mute and
 * Solo), the six big knobs with plain captions (the part's macros), Every
 * setting (the Shape view on this instrument) and ✕ / Esc (back to LOOPS).
 */
import { act, createElement as h } from 'react';
import { page } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/ui/theme.css';
import { session } from '../../src/app/instance';
import { SoundPanel } from '../../src/app/views/arrange/SoundPanel';
import { channelValue } from '../../src/app/views/mix/mixState';
import { MACRO_CAPTION } from '../../src/app/macros';
import { MACRO_IDS } from '../../src/project/types';
import { setView, uiStore } from '../../src/state/uiStore';
import { centre, clickAt, press, project, resetSong, settle, teardownSong, waitFor } from './r5-song-helpers';
import { mount } from './ui-harness';

/** Screenshots for the report, in the ignored .vitest folder (relative to this file); never a reason to fail. */
const shot = (name: string) => page.screenshot({ path: `../../.vitest/shots-r7-edit/${name}` }).catch(() => undefined);

let closed = 0;
const panel = () => document.querySelector<HTMLElement>('[data-testid="sound-panel"]')!;
const button = (text: string) => [...panel().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!;
const chords = () => project().tracks[3];

async function show(trackIndex = 3): Promise<void> {
  await page.viewport(1366, 768);
  closed = 0;
  const id = project().tracks[trackIndex].id;
  const m = mount(
    h(SoundPanel, {
      trackId: id,
      onClose: () => {
        closed += 1;
      },
    }),
    { width: 300 },
  );
  m.container.style.height = '640px';
  await document.fonts.load('600 13px "Inter Variable"');
  await settle(150);
}

beforeEach(async () => {
  await resetSong('simple');
  act(() => setView('arrange'));
});
afterEach(async () => {
  await teardownSong();
});

describe('the Sound panel', () => {
  it('shows the instrument, its sound, Change sound…, Volume, Mute, Hear it alone, six captioned big knobs and Every setting', async () => {
    await show();
    const text = panel().textContent!;
    expect(text).toContain(chords().name);
    for (const words of ['Change sound…', 'Mute', 'Hear it alone', 'Every setting ▸']) expect(text, words).toContain(words);
    for (const m of MACRO_IDS) expect(text, m).toContain(MACRO_CAPTION[m]);
    const sliders = [...panel().querySelectorAll('[role="slider"]')].map((s) => s.getAttribute('aria-label') ?? '');
    expect(sliders.length).toBe(7);
    expect(sliders.some((l) => l.startsWith('Volume'))).toBe(true);
    // Nothing spills out of the side's width.
    const box = panel().getBoundingClientRect();
    for (const el of panel().querySelectorAll<HTMLElement>('button, [role="slider"]')) expect(el.getBoundingClientRect().right, el.textContent ?? '').toBeLessThanOrEqual(box.right + 0.5);
    const controls = [...panel().querySelectorAll<HTMLElement>('button, [role="slider"], input')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    }).length;
    console.log(`[r7-edit] Sound panel controls: ${controls}`);
    await shot(`sound-panel.png`);
  });

  it('Mute, Hear it alone, Volume and a big knob change the instrument itself', async () => {
    await show();
    await clickAt(centre(button('Mute')));
    expect(chords().mute).toBe(true);
    expect(panel().textContent).toContain('is muted');
    await clickAt(centre(button('Mute')));
    expect(chords().mute).toBe(false);
    await clickAt(centre(button('Hear it alone')));
    expect(chords().solo).toBe(true);
    await clickAt(centre(button('Hear it alone')));
    expect(chords().solo).toBe(false);

    const vol = panel().querySelector<HTMLElement>('[role="slider"][aria-label^="Volume"]')!;
    const level = channelValue(project(), chords().id, 'level');
    act(() => vol.focus());
    await press('ArrowDown');
    expect(channelValue(project(), chords().id, 'level')).toBeLessThan(level);

    const tone = panel().querySelector<HTMLElement>('[data-macro="tone"] [role="slider"]')!;
    const before = chords().macros.tone;
    act(() => tone.focus());
    await press('ArrowUp');
    expect(chords().macros.tone).toBeGreaterThan(before);
  });

  it('a click on the name renames it (Enter keeps, Esc leaves it); Change sound… opens the Sound browser', async () => {
    await show();
    const was = chords().name;
    await clickAt(centre(panel().querySelector('h2 button')!));
    const input = panel().querySelector<HTMLInputElement>('input[aria-label="Instrument name"]')!;
    expect(document.activeElement).toBe(input);
    await press('Escape');
    expect(chords().name).toBe(was);
    expect(closed).toBe(0);
    await clickAt(centre(panel().querySelector('h2 button')!));
    for (const k of 'Keys') await press(k);
    await press('Enter');
    expect(chords().name).toBe('Keys');
    expect(panel().textContent).toContain('Keys');
    act(() => session.undo());
    expect(chords().name).toBe(was);

    await clickAt(centre(button('Change sound…')));
    await waitFor(() => !!document.querySelector('[role="dialog"]'), 'the Sound browser');
    await press('Escape');
    await settle();
  });

  it('Every setting opens Shape on this instrument; ✕ and Esc go back to the loops', async () => {
    await show(2);
    await clickAt(centre(button('Every setting ▸')));
    expect(uiStore.getState().view).toBe('shape');
    expect(uiStore.getState().selectedTrackId).toBe(project().tracks[2].id);
    await clickAt(centre(panel().querySelector('[aria-label="Close the sound (back to the loops)"]')!));
    expect(closed).toBe(1);
    act(() => button('Mute').focus());
    await press('Escape');
    expect(closed).toBe(2);
  });

  it('closes by itself when its instrument is gone', async () => {
    await show(4);
    const lead = project().tracks[4].id;
    act(() => {
      const p = structuredClone(session.store.getState());
      p.tracks = p.tracks.filter((t) => t.id !== lead);
      p.arrangement.regions = p.arrangement.regions.filter((r) => r.trackId !== lead);
      session.store.replace(p, { resetHistory: true });
    });
    await settle();
    expect(closed).toBe(1);
  });
});
