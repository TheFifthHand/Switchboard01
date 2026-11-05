/**
 * A loud export only changes the song once its file is saved: cancelled while it renders louder, or
 * failing to save, it leaves the mastering exactly as it was and no undo step.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { ToastProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { ExportDialog } from '../../src/app/views/ExportDialog';
import { setLoudnessTarget } from '../../src/app/views/mix/mixPrefs';
import { getStarter } from '../../src/content/starters';
import { MASTERING_PARAMS, readParam } from '../../src/project/params';
import { setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';
import { centre, click } from './r4-uikit-input';

beforeEach(async () => {
  await page.viewport(1366, 768);
  setLoudnessTarget('streaming');
  act(() => {
    session.store.replace(getStarter('house')!.build(), { resetHistory: true });
    setView('play');
    setUiMode('simple');
  });
  patchRuntime({ playing: false, paused: false, mode: 'live', songLoop: null, recording: 'off', notice: null });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const byText = (root: ParentNode, text: string | RegExp) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')));

it('Cancel during “Making it louder”: the Loudness drive and the undo history stay as they were', async () => {
  const drive = () => readParam(MASTERING_PARAMS, session.store.getState().mastering.params, 'loudness');
  const before = drive();
  const steps = session.store.historySize().undo;
  mount(h(ToastProvider, null, h(ExportDialog, { open: true, onClose: () => {} })), { width: 1366 });
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
  await click(centre(byText(dialog(), /^Export WAV$/)!));
  const end = performance.now() + 120_000;
  let cancelled = false;
  while (performance.now() < end && byText(dialog(), 'Cancel export')) {
    const p = dialog().querySelector('[data-testid="export-progress-text"]')?.textContent ?? '';
    if (/^Making it louder/.test(p) && !cancelled) {
      await click(centre(byText(dialog(), 'Cancel export')!));
      cancelled = true;
    }
    await act(async () => wait(30));
  }
  await act(async () => wait(50));
  expect(cancelled).toBe(true);
  const text = dialog().textContent ?? '';
  console.info('[review] after cancel:', drive(), 'was', before, '| undo', session.store.undoLabel(), '|', text.match(/Export cancelled[^.]*\./)?.[0]);
  // The file was not saved, but the song itself changed:
  expect(drive()).toBeCloseTo(before, 5);
  expect(session.store.historySize().undo).toBe(steps);
  expect(text).toContain('Export cancelled. Nothing was saved.');
}, 200_000);

it('a loud export whose file cannot be saved leaves the mastering as it was', async () => {
  // A short song (scene 2's loops for 4 bars) keeps the renders quick.
  act(() => {
    const p = getStarter('house')!.build();
    p.arrangement.regions = p.tracks.flatMap((t) => (t.clips[1] ? [{ id: `rg_${t.id}`, trackId: t.id, clipId: t.clips[1].id, start: 0, bars: 4, offset: 0 }] : []));
    p.arrangement.sections = [];
    session.store.replace(p, { resetHistory: true });
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
    throw new Error('The disk is full');
  });
  const drive = () => readParam(MASTERING_PARAMS, session.store.getState().mastering.params, 'loudness');
  const before = drive();
  mount(h(ToastProvider, null, h(ExportDialog, { open: true, onClose: () => {} })), { width: 1366 });
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
  await click(centre(byText(dialog(), /^Export WAV$/)!));
  const phases = new Set<string>();
  const end = performance.now() + 120_000;
  while (performance.now() < end && byText(dialog(), 'Cancel export')) {
    const p = dialog().querySelector('[data-testid="export-progress-text"]')?.textContent;
    if (p) phases.add(p.replace(/… .*/, ''));
    await act(async () => wait(30));
  }
  await act(async () => wait(50));
  // It did render louder, then the save failed.
  expect([...phases]).toContain('Making it louder');
  expect(dialog().textContent).toContain('Export failed: The disk is full');
  expect(drive()).toBe(before);
  expect(session.store.historySize().undo).toBe(0);
}, 200_000);
