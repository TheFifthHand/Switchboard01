/**
 * The Export dialog (MIX-09, MIX-14, MIX-16, shell-05, design-16, design-21) with the real session's
 * offline renders and real input (CDP mouse and keyboard):
 * - Output: Mix (default) or Mix without mastering, which is quieter with a loud master; 24-bit by
 *   default; visible labels for every setting; "Echo tail"; one close pattern (× and one primary key).
 * - After a render, a report line: "Integrated −17.6 LUFS · true peak −1.0 dBTP (Streaming target
 *   −14)", with "Match target in Mix" when the file is more than 1 dB off and the project's mastering
 *   is on (it asks Mix to bring Match target into view and focus it); changing a setting clears it.
 * - Output starts at Mix each time the dialog opens ("without mastering" is a choice for one file).
 * - While it renders, Esc and a click outside do nothing: Cancel export is the only way out; the
 *   time left is shown; "Export cancelled" and "Saved …" outlive the dialog as toasts (raised when it
 *   closes, so they never cover its keys).
 * - A file name loses the characters file systems refuse, with collapsed spaces and a hint.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { ToastProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { ExportDialog, safeName, timeLeftText } from '../../src/app/views/ExportDialog';
import { takeMatchFocusRequest } from '../../src/app/views/mix/loudnessMatch';
import { setLoudnessTarget } from '../../src/app/views/mix/mixPrefs';
import { getStarter } from '../../src/content/starters';
import { parseWav } from '../../src/render/wav';
import * as cmd from '../../src/state/commands';
import { setView, uiStore } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';
import { centre, click, send, settleFrames } from './r4-uikit-input';

interface Saved {
  name: string;
  blob: Blob;
}

let saved: Saved[] = [];
let closes = 0;

beforeEach(async () => {
  await page.viewport(1366, 768);
  saved = [];
  closes = 0;
  setLoudnessTarget('streaming');
  act(() => {
    session.store.replace(getStarter('house')!.build(), { resetHistory: true });
    setView('play');
  });
  patchRuntime({ playing: false, paused: false, mode: 'live', songLoop: null, recording: 'off', notice: null });
  // Keep the files instead of downloading them.
  const blobs = new Map<string, Blob>();
  const create = URL.createObjectURL.bind(URL);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
    const url = create(b as Blob);
    blobs.set(url, b as Blob);
    return url;
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href);
    if (blob) saved.push({ name: this.download, blob });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open() {
  const el = (shown: boolean) => h(ToastProvider, null, h(ExportDialog, { open: shown, onClose: () => closes++, initialSource: 'scene:1' }));
  const m = mount(el(true), { width: 900 });
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
  /** Close the dialog and open it again. */
  const reopen = () => {
    m.rerender(el(false));
    m.rerender(el(true));
  };
  return { m, dialog, reopen };
}

const byText = (root: ParentNode, text: string | RegExp) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')))!;
const radio = (root: ParentNode, name: string) => [...root.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => r.textContent?.trim() === name)!;
/** What the toasts say (not the dialog's own status line). */
const toastText = () =>
  [...document.querySelectorAll('[role="status"], [role="alert"]')]
    .filter((e) => !e.closest('[role="dialog"]'))
    .map((e) => e.textContent ?? '')
    .join(' | ');

async function press(el: HTMLElement) {
  await click(centre(el));
  await act(async () => wait(20));
}

/** Set the scene export's length to `bars` by typing into the field. */
async function setLength(dialog: HTMLElement, bars: number) {
  // The first number field is Length (a scene export loops).
  const field = dialog.querySelector<HTMLInputElement>('input[role="spinbutton"]')!;
  await press(field);
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await userEvent.keyboard(`{Control>}a{/Control}${bars}{Enter}`);
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
  await settleFrames();
}

async function exportAndWait(dialog: HTMLElement): Promise<void> {
  await press(byText(dialog, 'Export WAV'));
  const end = performance.now() + 40_000;
  while (performance.now() < end && byText(dialog, 'Cancel export')) await act(async () => wait(100));
  await act(async () => wait(50));
}

describe('Export dialog: settings', () => {
  it('24-bit and Mix are the defaults; every setting has a visible label; one close pattern', () => {
    const { dialog } = open();
    const d = dialog();
    expect(radio(d, '24-bit').getAttribute('aria-checked')).toBe('true');
    expect(radio(d, 'Mix').getAttribute('aria-checked')).toBe('true');
    expect(radio(d, 'Mix without mastering').getAttribute('aria-checked')).toBe('false');
    for (const label of ['What to export', 'Output', 'Echo tail', 'Sample rate', 'Bit depth', 'File name']) expect(d.textContent, label).toContain(label);
    expect(d.textContent).not.toMatch(/\bTail\b(?! )/);
    // × in the header, one primary key in the footer.
    expect(d.querySelector('button[aria-label="Close"]')).not.toBeNull();
    expect(byText(d, 'Close')).toBeUndefined();
    expect(byText(d, 'Export WAV')).toBeDefined();
  });

  it('file names lose the characters file systems refuse, spaces collapse, and a hint says so', async () => {
    expect(safeName('My: song / test?')).toBe('My song test');
    expect(safeName('  a\\b  c  ')).toBe('a b c');
    expect(safeName('???')).toBe('omni-song');
    const { dialog } = open();
    const input = dialog().querySelector<HTMLInputElement>('input[type="text"]:not([role="spinbutton"])')!;
    await press(input);
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    g.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      await userEvent.keyboard('My: song / test?');
    } finally {
      g.IS_REACT_ACT_ENVIRONMENT = true;
    }
    await settleFrames();
    expect(dialog().querySelector('[data-testid="export-name-hint"]')!.textContent).toBe('Saved as “My song test.wav”: a file name cannot hold \\ / : * ? " < > |.');
    await setLength(dialog(), 1);
    await exportAndWait(dialog());
    expect(saved.map((s) => s.name)).toEqual(['My song test.wav']);
  });

  it('time left is worked out from the progress', () => {
    expect(timeLeftText(0.01, 3000)).toBeNull();
    expect(timeLeftText(0.5, 500)).toBeNull();
    expect(timeLeftText(0.2, 10_000)).toBe('about 40 s left');
    expect(timeLeftText(0.5, 3000)).toBe('a few seconds left');
    expect(timeLeftText(0.1, 30_000)).toBe('about 5 min left');
  });
});

describe('Export dialog: report and output', () => {
  it('reports integrated loudness and true peak against the target, offers Match target in Mix when off, and a setting change clears it', async () => {
    const { dialog } = open();
    await setLength(dialog(), 2);
    await exportAndWait(dialog());
    expect(saved).toHaveLength(1);
    // 24-bit stereo at 48 kHz.
    const wav = parseWav(await saved[0].blob.arrayBuffer());
    expect(wav.bitDepth).toBe(24);
    expect(wav.sampleRate).toBe(48000);
    const report = dialog().querySelector('[data-testid="export-report"]')!.textContent ?? '';
    console.info(`[export] ${report}`);
    expect(report).toMatch(/^Integrated −\d+\.\d LUFS · true peak −\d+\.\d dBTP \(Streaming target −14\)$/);
    const lufs = -Number(/Integrated −(\d+\.\d)/.exec(report)![1]);
    expect(dialog().querySelector('[data-testid="export-result"]')!.textContent).toMatch(/^Saved .+\.wav \(\d+\.\d MB, /);
    // No toast over the open dialog (it would cover its keys).
    expect(toastText()).not.toMatch(/Saved .+\.wav/);
    const link = byText(dialog(), 'Match target in Mix');
    expect(Boolean(link)).toBe(Math.abs(lufs + 14) > 1);
    // Any change of a setting: the result no longer describes what Export WAV would make.
    await press(radio(dialog(), '16-bit'));
    expect(dialog().querySelector('[data-testid="export-result"]')).toBeNull();
    await press(radio(dialog(), '24-bit'));
    if (link) {
      await exportAndWait(dialog());
      takeMatchFocusRequest();
      await press(byText(dialog(), 'Match target in Mix'));
      expect(closes).toBe(1);
      expect(uiStore.getState().view).toBe('mix');
      // Mix is asked to bring Match target into view and focus it (r4-mix-match-steps checks that it does).
      expect(takeMatchFocusRequest()).toBe(true);
      // The result outlives the dialog as a toast.
      await act(async () => wait(50));
      expect(toastText()).toMatch(/Saved .+\.wav .*Integrated −\d+\.\d LUFS/);
    }
  }, 90_000);

  it('Mix without mastering is quieter than the Loud master, and the project keeps its mastering', async () => {
    act(() => {
      session.accepted(cmd.applyMasteringPreset(session.store, 'loud'));
    });
    const { dialog } = open();
    await setLength(dialog(), 2);
    await exportAndWait(dialog());
    const mastered = dialog().querySelector('[data-testid="export-report"]')!.textContent ?? '';
    await press(radio(dialog(), 'Mix without mastering'));
    expect(dialog().textContent).toContain('without mastering');
    await exportAndWait(dialog());
    const dry = dialog().querySelector('[data-testid="export-report"]')!.textContent ?? '';
    const lufs = (t: string) => -Number(/Integrated −(\d+\.\d)/.exec(t)![1]);
    console.info(`[export] mastered: ${mastered} | without mastering: ${dry}`);
    expect(lufs(dry)).toBeLessThan(lufs(mastered) - 3);
    expect(dialog().querySelector('[data-testid="export-result"]')!.textContent).toContain('without mastering');
    // Without mastering no Match link: it is not the master.
    expect(byText(dialog(), 'Match target in Mix')).toBeUndefined();
    expect(saved).toHaveLength(2);
    expect(session.store.getState().mastering.presetId).toBe('loud');
  }, 90_000);

  it('Output is back at Mix each time the dialog opens', async () => {
    const { dialog, reopen } = open();
    await press(radio(dialog(), 'Mix without mastering'));
    expect(radio(dialog(), 'Mix without mastering').getAttribute('aria-checked')).toBe('true');
    reopen();
    await settleFrames();
    expect(radio(dialog(), 'Mix').getAttribute('aria-checked')).toBe('true');
    expect(radio(dialog(), 'Mix without mastering').getAttribute('aria-checked')).toBe('false');
  });

  it('with the project’s mastering off, an off-target export offers no Match target (it moves the mastering)', async () => {
    act(() => {
      session.accepted(cmd.setMasteringEnabled(session.store, false));
    });
    const { dialog } = open();
    await setLength(dialog(), 2);
    await exportAndWait(dialog());
    const report = dialog().querySelector('[data-testid="export-report"]')!.textContent ?? '';
    const lufs = -Number(/Integrated −(\d+\.\d)/.exec(report)![1]);
    console.info(`[export] mastering off: ${report}`);
    // The house starter without mastering is well off the Streaming target, and still no link.
    expect(Math.abs(lufs + 14)).toBeGreaterThan(1);
    expect(byText(dialog(), 'Match target in Mix')).toBeUndefined();
  }, 90_000);
});

describe('Export dialog: while it renders', () => {
  it('Esc and a click outside do nothing, the time left shows, and Cancel export (the only way out) says so in a toast', async () => {
    const { dialog } = open();
    await setLength(dialog(), 64);
    await press(byText(dialog(), 'Export WAV'));
    expect(byText(dialog(), 'Cancel export')).toBeDefined();
    // No × while it renders.
    expect(dialog().querySelector('button[aria-label="Close"]')).toBeNull();
    // Esc, then a click on the dimmed area outside the dialog.
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await click({ x: 8, y: 8 });
    await act(async () => wait(100));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(closes).toBe(0);
    expect(byText(dialog(), 'Cancel export')).toBeDefined();
    // The progress says how long is left once it can tell.
    const text = () => dialog().querySelector('[data-testid="export-progress-text"]')?.textContent ?? '';
    const end = performance.now() + 20_000;
    while (performance.now() < end && !/left/.test(text())) await act(async () => wait(100));
    console.info(`[export] progress: ${text()}`);
    expect(text()).toMatch(/^\d+% · (about \d+ (s|min) left|a few seconds left)$/);
    await press(byText(dialog(), 'Cancel export'));
    await act(async () => wait(300));
    expect(dialog().querySelector('[data-testid="export-result"]')!.textContent).toBe('Export cancelled. Nothing was saved.');
    expect(saved).toHaveLength(0);
    // Idle again: the × is back, and closing leaves the message as a toast.
    const x = dialog().querySelector<HTMLElement>('button[aria-label="Close"]')!;
    expect(x).not.toBeNull();
    expect(toastText()).not.toContain('Export cancelled');
    await press(x);
    expect(closes).toBe(1);
    await act(async () => wait(50));
    expect(toastText()).toContain('Export cancelled. Nothing was saved.');
  }, 90_000);
});
