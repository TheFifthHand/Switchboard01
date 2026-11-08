/**
 * Round 7 shell in Simple, the whole app in real Chromium at 1366×768:
 * - the top bar is Project ▾, Play, Stop, Record, Undo, Redo, Share and ⋯
 *   only (no view tabs, tempo box, master, meters, Mute All or mode switch),
 *   and the app opens on the Song screen even when a sheet was left open;
 * - ⋯ opens Jam pads, the Mixer and Every setting as sheets under
 *   "Back to my song" (Esc returns), Mute all sound, and Show every control
 *   (Advanced: 2.4's tabs, plus Share; back to Simple lands on the home);
 * - Play, Space and ● Record act on the song;
 * - the keyboard strip is hidden but the computer keys still play;
 * - Project ▾: Speed (one undo step per burst, no BPM number), Mood (moves
 *   the song, one undo step), Rename, the save state in words.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { offlineStore } from '../../src/app/runtime';
import { closeLoopEditor, editorStore } from '../../src/app/views/arrange/editorStore';
import { setUiMode, setView, uiStore } from '../../src/state/uiStore';
import { page } from 'vitest/browser';
import { button, buttons, click, closeShell, keys, openShell, settle, shown, toasts, transport, until } from './r4-shell-harness';

afterEach(async () => {
  vi.restoreAllMocks();
  act(() => {
    closeLoopEditor();
    offlineStore.setState({ state: 'unsupported', apply: null });
  });
  await closeShell();
});

/** Open the app past the Welcome card (Just look around). */
async function home(): Promise<void> {
  await openShell({ mode: 'simple' });
  await keys('{Escape}');
}

const ui = () => uiStore.getState();
const menuItem = (name: string | RegExp) =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find((el) => (typeof name === 'string' ? el.textContent?.trim().startsWith(name) : name.test(el.textContent ?? '')));
async function more(item: string): Promise<void> {
  await click(button(/^More/, transport())!);
  const el = await until(() => menuItem(item), `⋯ › ${item}`);
  await click(el);
}

describe('Simple top bar', () => {
  it('holds only Project, Play, Stop, Record, Undo, Redo, Share and More, and opens on the Song screen', async () => {
    await home();
    // openShell left the view on Play: Simple opens on its one home anyway.
    expect(ui().view).toBe('arrange');
    const bar = transport();
    const names = buttons(bar)
      .filter(shown)
      .map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim());
    expect(names[0]).toMatch(/^Project: House/);
    expect(names).toEqual(expect.arrayContaining(['Play', 'Stop', 'Share']));
    expect(names.some((n) => /^Record/.test(n))).toBe(true);
    expect(names.some((n) => /^Undo/.test(n))).toBe(true);
    expect(names.some((n) => /^Redo/.test(n))).toBe(true);
    expect(names.some((n) => /^More/.test(n))).toBe(true);
    expect(names.length).toBeLessThanOrEqual(9);
    // Nothing else: no view tabs, tempo box, master knob, meters, Mute All or Simple/Advanced switch.
    expect(bar.querySelector('[role="tab"]')).toBeNull();
    expect(bar.querySelector('input')).toBeNull();
    expect(bar.querySelector('[role="slider"]')).toBeNull();
    expect(bar.querySelector('[data-master-meters]')).toBeNull();
    expect(button(/Mute All|MUTED/, bar)).toBeNull();
    expect(bar.querySelector('[role="radiogroup"]')).toBeNull();
    // The keyboard strip is not shown; the bar fits the window.
    expect(document.querySelector('section[aria-label="Keyboard"]')).toBeNull();
    expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it('fits one row from 1024 to 1920 px, with an update waiting and a failed save, every key 32 px or more', async () => {
    await home();
    for (const w of [1024, 1100, 1180, 1280, 1366, 1440, 1600, 1920]) {
      await page.viewport(w, 800);
      for (const state of ['unsupported', 'update-ready'] as const) {
        act(() => offlineStore.setState({ state, apply: state === 'update-ready' ? () => {} : null }));
        await settle(60);
        const bar = transport();
        const label = `${w} px, ${state}`;
        expect(bar.scrollWidth, `${label}: overflow`).toBeLessThanOrEqual(bar.clientWidth + 1);
        expect(bar.getBoundingClientRect().height, `${label}: one row`).toBeLessThan(70);
        const keys = buttons(bar).filter(shown);
        expect(keys.length, `${label}: keys`).toBeGreaterThanOrEqual(8);
        for (const b of keys) expect(Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height), `${label}: ${b.getAttribute('aria-label') ?? b.textContent}`).toBeGreaterThanOrEqual(31.5);
        // Share and More are always whole inside the bar.
        for (const name of ['Share', /^More/]) {
          const r = button(name, bar)!.getBoundingClientRect();
          expect(r.right, `${label}: ${String(name)}`).toBeLessThanOrEqual(bar.getBoundingClientRect().right + 0.5);
        }
      }
    }
    await page.viewport(1366, 768);
  });

  it('Play and Space play the song; Record records into the song', async () => {
    await home();
    const toggle = vi.spyOn(session, 'togglePlay').mockResolvedValue();
    const rec = vi.spyOn(session, 'toggleRecordNotes').mockResolvedValue();
    await click(button('Play', transport())!);
    expect(toggle).toHaveBeenLastCalledWith({ song: true });
    // Space plays the song too, also after a sheet was opened and closed.
    act(() => setView('play'));
    await settle(100);
    await keys(' ');
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(toggle).toHaveBeenLastCalledWith({ song: true });
    await click(button(/^Record .* into the song$/, transport())!);
    expect(rec).toHaveBeenCalledWith({ song: true });
  });

  it('while a take records, Record reads Stop recording and a line says what records', async () => {
    await home();
    vi.spyOn(session, 'toggleRecordNotes').mockResolvedValue();
    const name = session.store.getState().tracks.find((t) => t.id === ui().selectedTrackId)!.name;
    act(() => runtimeStore.setState({ ...runtimeStore.getState(), recording: 'notes', songRecording: { trackId: ui().selectedTrackId, startBar: 0 } as never, countingIn: false }));
    await settle(60);
    expect(button('Stop recording', transport())).not.toBeNull();
    expect(transport().textContent).toContain(`Recording ${name} into your song`);
    act(() => runtimeStore.setState({ ...runtimeStore.getState(), recording: 'off', songRecording: null }));
  });

  it('the computer keys still play the selected instrument with the strip hidden', async () => {
    await home();
    const on = vi.spyOn(session, 'noteOn').mockImplementation(() => undefined);
    vi.spyOn(session, 'noteOff').mockImplementation(() => undefined);
    await keys('{a>}');
    await keys('{/a}');
    expect(on).toHaveBeenCalled();
    expect(on.mock.calls[0][0]).toBe(ui().selectedTrackId);
  });
});

describe('Make a beat from scratch (Simple)', () => {
  it('opens the Song screen with the editor on the new 1-bar drum loop at the start of the song', async () => {
    await openShell({ mode: 'simple' });
    await click(button('Make a beat from scratch')!);
    await until(() => editorStore.getState(), 'the editor on the new loop', 8000);
    expect(ui().view).toBe('arrange');
    const e = editorStore.getState()!;
    const p = session.store.getState();
    expect(p.tracks.find((t) => t.id === e.trackId)!.instrument.kind).toBe('drums');
    expect(p.arrangement.regions.find((r) => r.id === e.regionId)).toMatchObject({ start: 0, bars: 1 });
    act(() => session.stop());
  });
});

describe('Sheets from ⋯', () => {
  it('Jam pads, Mixer and Every setting open under "Back to my song"; Esc and Back return home', async () => {
    await home();
    await more('Jam pads');
    expect(ui().view).toBe('play');
    const back = await until(() => button('Back to my song'), 'the way back');
    expect(document.activeElement).toBe(back);
    expect(document.getElementById('pad-surface')).not.toBeNull();
    expect(transport().querySelector('[role="tab"]')).toBeNull();
    // Jam pads keep 2.4's keyboard strip under them (the Song screen does not show it).
    expect(document.querySelector('section[aria-label="Keyboard"]')).not.toBeNull();
    await keys('{Escape}');
    expect(ui().view).toBe('arrange');
    expect(button('Back to my song')).toBeNull();

    await more('Mixer');
    expect(ui().view).toBe('mix');
    expect(document.querySelector('[data-sheet="mix"] h2')?.textContent).toBe('Mixer');
    await click(button('Back to my song')!);
    expect(ui().view).toBe('arrange');

    await more('Every setting');
    expect(ui().view).toBe('shape');
    await click(button('Back to my song')!);
    expect(ui().view).toBe('arrange');
  });

  it('Mute all sound is in ⋯ and silences everything', async () => {
    await home();
    await more('Mute all sound');
    expect(runtimeStore.getState().muteAll).toBe(true);
    await more('Mute all sound');
    expect(runtimeStore.getState().muteAll).toBe(false);
  });

  it('Show every control is Advanced (2.4 tabs, Export and Share); back to Simple keeps the view, as a sheet', async () => {
    await home();
    await more('Show every control');
    expect(ui().uiMode).toBe('advanced');
    await settle(100);
    expect(transport().querySelectorAll('[role="tab"]').length).toBe(4);
    expect(button(/^Export/, transport())).not.toBeNull();
    // Share is in Advanced's More menu, beside Export.
    await click(button(/^More/, transport())!);
    expect(menuItem('Share…')).toBeDefined();
    await keys('{Escape}');
    act(() => setView('mix'));
    act(() => setUiMode('simple'));
    await settle(100);
    expect(ui().view).toBe('mix');
    expect(transport().querySelector('[role="tab"]')).toBeNull();
    await click(button('Back to my song')!);
    expect(ui().view).toBe('arrange');
  });
});

describe('Project ▾', () => {
  const panel = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Project"]');
  async function openProject(): Promise<HTMLElement> {
    await click(button(/^Project: /, transport())!);
    return until(panel, 'the Project panel');
  }

  it('says the save state in words and offers My projects, New song, Rename and a copy to keep', async () => {
    await home();
    const p = await openProject();
    expect(p.textContent).toMatch(/Not kept yet|Saved in this browser/);
    for (const name of ['My projects…', 'New song…', 'Rename', 'Save a copy to my computer']) expect(button(name, p)).not.toBeNull();
    // No BPM number in Simple.
    expect(p.textContent).not.toMatch(/BPM|\b124\b/);
  });

  it('Speed: slow ↔ fast in words; one key burst is one undo step', async () => {
    await home();
    const p = await openProject();
    const slider = p.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.getAttribute('aria-valuetext')).toBe('Lively');
    const bpm = session.store.getState().bpm;
    slider.focus();
    await keys('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(session.store.getState().bpm).toBe(bpm + 3);
    await keys('{Escape}');
    act(() => session.undo());
    expect(session.store.getState().bpm).toBe(bpm);
  });

  it('Mood moves the song into the chosen mood in one undo step', async () => {
    await home();
    const p = await openProject();
    const before = session.store.getState();
    expect(before.scale).toBe('dorian');
    await click(button(/^moody$/, p)!);
    const after = session.store.getState();
    expect(after.scale).toBe('minor');
    expect(after.root).toBe(before.root);
    await until(() => toasts().find((t) => t.startsWith('Mood: moody.')), 'the mood toast');
    act(() => session.undo());
    expect(session.store.getState().scale).toBe('dorian');
    expect(JSON.stringify(session.store.getState().tracks)).toBe(JSON.stringify(before.tracks));
  });

  it('Rename renames in place (Enter keeps it)', async () => {
    await home();
    const p = await openProject();
    await click(button('Rename', p)!);
    const field = p.querySelector<HTMLInputElement>('input[aria-label="Song name"]')!;
    expect(document.activeElement).toBe(field);
    await keys('My first song{Enter}');
    expect(session.store.getState().name).toBe('My first song');
    expect(button(/^Project: My first song/, transport())).not.toBeNull();
  });
});
