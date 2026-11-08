/**
 * The Song view's part headers and rows, round 6, in real Chromium with a
 * real mouse and keys:
 * - each header has a volume slider (in dB) and a pan dial that change the
 *   part's channel level and pan, the very parameters its Mix fader and pan
 *   knob change; a drag is one undo step; keys, double-click and typed
 *   values work; the wheel changes nothing;
 * - ⋯ / right-click on a header: Rename part…, Change instrument… (the
 *   sound browser);
 * - everything fits the header at 1366 and 1920;
 * - while Record writes into the song, a coral "Recording…" region grows on
 *   the part's row from the bar the take began;
 * - a press 12 px inside a loop's end still grabs the end (14 px grip).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { ppbStore } from '../../src/app/views/arrange/laneStore';
import { readZoom } from '../../src/app/views/arrange/laneSettings';
import { moduleId } from '../../src/project/factory';
import type { Project } from '../../src/project/types';
import { centre, clickAt, doubleClickAt, dragTo, menuItem, mouse, on, openSong, press, project, region, regionEl, regions, resetSong, rightClickAt, settle, teardownSong, undoCount, wheelAt, advancedMode } from './r5-song-helpers';

const head = (trackId: string) => document.querySelector<HTMLElement>(`[data-lane-row="${trackId}"] [data-part-head]`)!;
const slider = (trackId: string) => head(trackId).querySelector<HTMLElement>('[role="slider"][aria-label$=" volume"]')!;
const panDial = (trackId: string) => head(trackId).querySelector<HTMLElement>('[role="slider"][aria-label$=" pan"]')!;
const channelParam = (trackId: string, param: 'level' | 'pan') => project().patch.modules.find((m) => m.id === moduleId.channel(trackId))!.params[param] ?? 0;

/** Drums: a 4-bar loop at bar 1; Bass: an 8-bar loop at bar 5. */
function song(p: Project): void {
  const d = p.tracks[0];
  const b = p.tracks[2];
  p.arrangement.regions = [region('D', d.id, d.clips.find((c) => c)!.id, 0, 4), region('B', b.id, b.clips.find((c) => c)!.id, 4, 8)];
  p.arrangement.sections = [];
}

beforeEach(resetSong);
afterEach(teardownSong);

describe('volume and pan in the part headers', () => {
  it('the slider changes the part’s channel level (Mix’s fader): a drag is one undo step; dB for screen readers, no dB text in Simple', async () => {
    await openSong(1366, 768, song);
    const bass = project().tracks[2];
    const el = slider(bass.id);
    expect(el.getAttribute('aria-valuetext')).toMatch(/dB/);
    // Round 7 words: Simple shows the level as the bar alone (no dB text); screen readers still hear it in dB.
    expect(el.textContent).not.toMatch(/dB/);
    const before = channelParam(bass.id, 'level');
    const steps = undoCount();
    const r = el.getBoundingClientRect();
    const from = { x: r.left + r.width * 0.5, y: r.top + r.height / 2 };
    // A press alone changes nothing.
    await mouse('mousePressed', from);
    await mouse('mouseReleased', from);
    await settle(60);
    expect(channelParam(bass.id, 'level')).toBe(before);
    await dragTo(from, { x: from.x - r.width * 0.3, y: from.y });
    const after = channelParam(bass.id, 'level');
    expect(after).toBeLessThan(before - 1);
    expect(undoCount()).toBe(steps + 1);
    expect(session.store.undoLabel()).toBe(`${bass.name} level`);
    expect(el.getAttribute("aria-valuetext")).toContain(Math.abs(after).toFixed(1));
    // Double-click: back to 0 dB.
    await doubleClickAt(centre(el));
    expect(channelParam(bass.id, 'level')).toBe(0);
  });

  it('keys move it 0.5 dB (Shift 0.1), Enter types a value, and the wheel never changes it', async () => {
    await openSong(1366, 768, song);
    const drums = project().tracks[0];
    const el = slider(drums.id);
    const start = channelParam(drums.id, 'level');
    act(() => el.focus());
    await press('ArrowRight');
    expect(channelParam(drums.id, 'level')).toBeCloseTo(start + 0.5, 5);
    await press('ArrowLeft', 8);
    expect(channelParam(drums.id, 'level')).toBeCloseTo(start + 0.4, 5);
    await press('Enter');
    const field = head(drums.id).querySelector<HTMLInputElement>('input[aria-label$="volume in dB"]')!;
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    act(() => {
      field.select();
    });
    await press('-');
    await press('6');
    await press('Enter');
    expect(channelParam(drums.id, 'level')).toBe(-6);
    expect(document.activeElement).toBe(slider(drums.id));
    // The lane's keys did not act on the song meanwhile.
    expect(regions().find((r) => r.id === 'D')).toMatchObject({ start: 0, bars: 4 });
    await wheelAt(centre(slider(drums.id)), -300);
    expect(channelParam(drums.id, 'level')).toBe(-6);
  });

  it('the pan dial changes the part’s channel pan (Mix’s pan knob), one undo step per drag', async () => {
    // 2.4's Song view controls: Advanced since round 7.
    advancedMode();
    await openSong(1366, 768, song);
    const bass = project().tracks[2];
    const dial = panDial(bass.id);
    const steps = undoCount();
    const c = centre(dial);
    await dragTo(c, { x: c.x, y: c.y - 60 });
    expect(channelParam(bass.id, 'pan')).toBeGreaterThan(0.2);
    expect(undoCount()).toBe(steps + 1);
  });

  it('⋯ and a right-click open the part’s menu: Rename part…, Change instrument… opens the sound browser', async () => {
    await openSong(1366, 768, song);
    const bass = project().tracks[2];
    await rightClickAt(centre(head(bass.id), 0.3, 0.3));
    expect(menuItem('Rename part')).toBeTruthy();
    await clickAt(centre(menuItem('Rename part')));
    const field = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    expect(field).not.toBeNull();
    act(() => field.select());
    for (const ch of 'Sub') await press(ch);
    await clickAt(centre([...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find((x) => x.textContent?.trim() === 'Rename')!));
    expect(project().tracks[2].name).toBe('Sub');
    await clickAt(centre(head(bass.id).querySelector('[data-kind="more"]')!));
    await clickAt(centre(menuItem('Change instrument')));
    await settle(200);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    expect(dialog?.textContent ?? '').toMatch(/Sub/);
    await press('Escape');
  });

  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
  ] as const) {
    it(`everything fits the header at ${w}×${hh}`, async () => {
      await openSong(w, hh);
      for (const t of project().tracks) {
        const box = head(t.id).getBoundingClientRect();
        for (const el of head(t.id).querySelectorAll<HTMLElement>('[role="slider"], button, [class*="partName"]')) {
          const r = el.getBoundingClientRect();
          expect(r.left, `${t.name}: ${el.getAttribute('aria-label') ?? el.textContent}`).toBeGreaterThanOrEqual(box.left - 0.5);
          expect(r.right).toBeLessThanOrEqual(box.right + 0.5);
          expect(r.top).toBeGreaterThanOrEqual(box.top - 0.5);
          expect(r.bottom).toBeLessThanOrEqual(box.bottom + 0.5);
        }
        expect(slider(t.id).getBoundingClientRect().width).toBeGreaterThanOrEqual(56);
        expect(head(t.id).querySelector('[class*="partName"]')!.getBoundingClientRect().width).toBeGreaterThan(30);
      }
    });
  }
});

describe('the rows', () => {
  it('a coral "Recording…" region grows on the part’s row while Record writes into the song', async () => {
    await openSong(1366, 768, song);
    const bass = project().tracks[2];
    const rec = () => document.querySelector<HTMLElement>(`[data-lane="${bass.id}"] [data-recording-region]`);
    expect(rec()).toBeNull();
    act(() => patchRuntime({ songRecording: { trackId: bass.id, startBar: 6, bars: 1 } }));
    await settle(60);
    const k = ppbStore.getState();
    const lane = document.querySelector<HTMLElement>(`[data-lane="${bass.id}"]`)!.getBoundingClientRect();
    expect(rec()?.textContent).toContain('Recording…');
    expect(rec()!.getBoundingClientRect().left - lane.left).toBeCloseTo(6 * k + 1, 0);
    const w1 = rec()!.getBoundingClientRect().width;
    act(() => patchRuntime({ songRecording: { trackId: bass.id, startBar: 6, bars: 3 } }));
    await settle(60);
    expect(rec()!.getBoundingClientRect().width).toBeCloseTo(w1 + 2 * k, 0);
    // Over the loop there (Bounce, bars 5–12): drawn on top of it, after it and above it.
    expect(regionEl('B').compareDocumentPosition(rec()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(Number(getComputedStyle(rec()!).zIndex)).toBeGreaterThan(Number(getComputedStyle(regionEl('B')).zIndex) || 0);
    expect(getComputedStyle(rec()!).backgroundImage).toContain('gradient');
    // No other row shows it; it goes when the take ends.
    expect(document.querySelectorAll('[data-recording-region]').length).toBe(1);
    act(() => patchRuntime({ songRecording: null }));
    await settle(60);
    expect(rec()).toBeNull();
  });

  it('a press 12 px inside a loop’s end grabs the end (it lengthens, it does not move)', async () => {
    await openSong(1366, 768, song);
    act(() => ppbStore.setState(48));
    await settle(120);
    const r = regionEl('B').getBoundingClientRect();
    const from = { x: r.right - 12, y: r.top + r.height / 2 };
    await dragTo(from, { x: from.x + 2 * 48, y: from.y });
    expect(regions().find((x) => x.id === 'B')).toMatchObject({ start: 4, bars: 10 });
    // The middle still moves it.
    const m = on('B');
    await dragTo(m, { x: m.x + 48, y: m.y });
    expect(regions().find((x) => x.id === 'B')).toMatchObject({ start: 5, bars: 10 });
  });

  it('the zoom a project opened with is remembered for it', async () => {
    await openSong(1366, 768, song);
    expect(readZoom(project().id)).toBe(ppbStore.getState());
  });
});
