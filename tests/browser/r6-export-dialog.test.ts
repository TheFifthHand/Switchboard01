/**
 * r6 Export, with the real session's offline renders and real input (CDP mouse and keyboard):
 * - Simple shows only: what, format, "Make it as loud as streaming songs" (on), file name and a
 *   folded "More options" (sample rate, bit depth, tail, mastering or not); Advanced shows them all.
 * - Escape closes the dialog, also with a list box focused.
 * - "Make it as loud as streaming songs" renders, measures and renders a copy with Loudness drive
 *   moved so the file lands on −14 LUFS, never above the −1 dBTP ceiling, and says what it did. Only
 *   the file changes (round 7): the song's mastering and undo history stay as they were. It is for
 *   the whole song: a scene is saved at the level it plays.
 * - Smaller file for sharing (Opus in Ogg, saved as .ogg, audio/ogg): decodes in the browser, the right
 *   length, not silent.
 * - Parts as separate files: a .zip with one WAV per part that plays, each soloed and not silent.
 * - MIDI file: a type-1 file with a track per part that plays, the project's tempo.
 * - While it renders, the progress shows in the export button's place.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { unzipSync } from 'fflate';
import '../../src/ui/theme.css';
import { ToastProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { ExportDialog, FORMAT_LABEL, clockText, defaultExportSource, formatsFor } from '../../src/app/views/ExportDialog';
import { opusSupported } from '../../src/render/opus';
import { setLoudnessTarget } from '../../src/app/views/mix/mixPrefs';
import { getStarter } from '../../src/content/starters';
import { MASTERING_PARAMS, readParam } from '../../src/project/params';
import { measureLoudness } from '../../src/render/loudness';
import { stemParts } from '../../src/render/stems';
import { parseWav } from '../../src/render/wav';
import * as cmd from '../../src/state/commands';
import { setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';
import { centre, click, send, settleFrames } from './r4-uikit-input';

let saved: { name: string; blob: Blob }[] = [];
let closes = 0;

beforeEach(async () => {
  await page.viewport(1366, 768);
  // Chromium encodes Opus (r6-export-opus): the dialog offers it once the browser has said so.
  expect(await opusSupported()).toBe(true);
  saved = [];
  closes = 0;
  setLoudnessTarget('streaming');
  act(() => {
    session.store.replace(getStarter('house')!.build(), { resetHistory: true });
    setView('play');
    setUiMode('simple');
  });
  patchRuntime({ playing: false, paused: false, mode: 'live', songLoop: null, recording: 'off', notice: null });
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
  act(() => setUiMode('simple'));
});

function open(initialSource?: string) {
  mount(h(ToastProvider, null, h(ExportDialog, { open: true, onClose: () => closes++, initialSource })), { width: 1366 });
  return () => document.querySelector<HTMLElement>('[role="dialog"]')!;
}

const byText = (root: ParentNode, text: string | RegExp) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')))!;
const selects = (root: ParentNode) => [...root.querySelectorAll<HTMLSelectElement>('select')];
const label = (el: Element) => document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() ?? el.getAttribute('aria-label') ?? '';

async function press(el: HTMLElement) {
  await click(centre(el));
  await act(async () => wait(20));
}

async function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settleFrames();
}

async function exportAndWait(dialog: () => HTMLElement, key: RegExp, timeout = 60_000): Promise<string[]> {
  const phases = new Set<string>();
  await press(byText(dialog(), key));
  const end = performance.now() + timeout;
  while (performance.now() < end && byText(dialog(), 'Cancel export')) {
    const p = dialog().querySelector('[data-testid="export-progress-text"]')?.textContent;
    if (p) phases.add(p.replace(/… .*/, ''));
    await act(async () => wait(50));
  }
  await act(async () => wait(50));
  return [...phases];
}

/** Set the scene export's length by typing into the Length field (the first number field). */
async function length(dialog: () => HTMLElement, bars: number) {
  const field = dialog().querySelector<HTMLInputElement>('input[role="spinbutton"]')!;
  await press(field);
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await userEvent.keyboard(`{Control>}a{/Control}${bars}{Enter}`);
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
  await settleFrames();
  expect(dialog().querySelector<HTMLInputElement>('input[role="spinbutton"]')!.value).toBe(String(bars));
}

const lufsOf = (b: AudioBuffer) => measureLoudness(b.getChannelData(0), b.numberOfChannels > 1 ? b.getChannelData(1) : null, b.sampleRate, { truePeak: false }).integrated;
const peakDb = (chs: Float32Array[]) => 20 * Math.log10(Math.max(...chs.map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0))));

describe('what the dialog opens on, and in which words', () => {
  it('the whole song whenever it has loops, else the selected scene; never “the loops playing now” when nothing plays', () => {
    const p = getStarter('house')!.build();
    expect(defaultExportSource(p, { selectedRow: 2, padsPlaying: false, canReplay: true })).toBe('song');
    const noSong = { ...p, arrangement: { ...p.arrangement, regions: [] } };
    expect(defaultExportSource(noSong, { selectedRow: 2, padsPlaying: false, canReplay: true })).toBe('scene:2');
    expect(defaultExportSource(noSong, { selectedRow: null, padsPlaying: true, canReplay: true })).toBe('scene:0');
    const empty = { ...noSong, tracks: noSong.tracks.map((t) => ({ ...t, clips: t.clips.map(() => null) })) };
    expect(defaultExportSource(empty, { selectedRow: 1, padsPlaying: true, canReplay: true })).toBe('now');
    expect(clockText(139.4)).toBe('2:19');
    expect(clockText(5)).toBe('0:05');
    // Notes and parts are made of loops: not of a recorded performance. The small file only where it can be made.
    expect(formatsFor('song', true)).toEqual(['wav', 'opus', 'stems', 'midi']);
    expect(formatsFor('song', false)).toEqual(['wav', 'stems', 'midi']);
    expect(formatsFor('perf:x', true)).toEqual(['wav', 'opus']);
  });

  it('the House starter in Play: “The whole song (m:ss)”, chosen', () => {
    const dialog = open();
    const what = selects(dialog())[0];
    expect(what.value).toBe('song');
    expect(what.selectedOptions[0].textContent).toMatch(/^The whole song \(\d:\d\d\)$/);
  });
});

describe('Simple shows only what a first export needs', () => {
  it('what, format, “Make it as loud as streaming songs” (on), file name, and More options folded', async () => {
    const dialog = open();
    const d = dialog();
    expect(selects(d).map(label)).toEqual(['What to export', 'Format']);
    expect([...selects(d)[1].options].map((o) => o.textContent)).toEqual([FORMAT_LABEL.wav, FORMAT_LABEL.opus, FORMAT_LABEL.stems, FORMAT_LABEL.midi]);
    const sw = [...d.querySelectorAll<HTMLElement>('[role="switch"]')];
    expect(sw).toHaveLength(1);
    expect(sw[0].textContent).toContain('Make it as loud as streaming songs');
    expect(sw[0].getAttribute('aria-checked')).toBe('true');
    expect(d.querySelector('input[type="text"]:not([role="spinbutton"])')).not.toBeNull();
    for (const hidden of ['Sample rate', 'Bit depth', 'Echo tail', 'Mix without mastering']) expect(d.textContent, hidden).not.toContain(hidden);
    expect(d.querySelectorAll('[role="radio"]')).toHaveLength(0);
    const more = byText(d, 'More options');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await press(more);
    for (const shown of ['Sample rate', 'Bit depth', 'Echo tail', 'Mix without mastering']) expect(dialog().textContent, shown).toContain(shown);
    // Mix without mastering takes the loudness switch away (it moves the mastering).
    await press([...dialog().querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => r.textContent === 'Mix without mastering')!);
    expect(dialog().querySelector('[role="switch"]')).toBeNull();
  });

  it('Advanced shows every setting at once (no More options)', async () => {
    act(() => setUiMode('advanced'));
    const dialog = open();
    expect(byText(dialog(), 'More options')).toBeUndefined();
    for (const shown of ['Sample rate', 'Bit depth', 'Echo tail', 'Mix without mastering']) expect(dialog().textContent, shown).toContain(shown);
  });

  it('MIDI shows no audio settings; the file extension follows the format', async () => {
    const dialog = open();
    const ext = () => dialog().querySelector('[class*="ext"]')!.textContent;
    expect(ext()).toBe('.wav');
    await choose(selects(dialog())[1], 'opus');
    // Opus in Ogg: .ogg, the extension players know (round 7; 2.4 saved .opus).
    expect(ext()).toBe('.ogg');
    await choose(selects(dialog())[1], 'stems');
    expect(ext()).toBe('.zip');
    expect(dialog().querySelector('[role="switch"]')).toBeNull();
    await choose(selects(dialog())[1], 'midi');
    expect(ext()).toBe('.mid');
    expect(byText(dialog(), 'Export MIDI')).toBeDefined();
    // The song has no tail or sample rate to choose: More options has nothing for a song's notes.
    expect(byText(dialog(), 'More options')).toBeUndefined();
  });

  it('Escape closes the dialog, also with a list box focused', async () => {
    const dialog = open();
    for (const i of [0, 1]) {
      const sel = selects(dialog())[i];
      sel.focus();
      expect(document.activeElement).toBe(sel);
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await act(async () => wait(30));
      expect(closes, `select ${i}`).toBe(i + 1);
    }
  });
});

describe('Make it as loud as streaming songs', () => {
  // Round 7 (intended change): the file is made loud from a copy; 2.4 also set the song's Loudness drive (one undo step).
  it('makes the file land on −14 LUFS, under the ceiling, says what it did, and leaves the song’s mastering and undo history as they were', async () => {
    const drive = () => readParam(MASTERING_PARAMS, session.store.getState().mastering.params, 'loudness');
    // A short song (scene 2's loops for 4 bars) keeps the renders quick.
    act(() => {
      const p = getStarter('house')!.build();
      p.arrangement.regions = p.tracks.flatMap((t) => (t.clips[1] ? [{ id: `rg_${t.id}`, trackId: t.id, clipId: t.clips[1].id, start: 0, bars: 4, offset: 0 }] : []));
      p.arrangement.sections = [];
      session.store.replace(p, { resetHistory: true });
    });
    const before = drive();
    act(() => setUiMode('advanced'));
    const dialog = open('song');
    const phases = await exportAndWait(dialog, /^Export WAV$/, 120_000);
    // The progress showed in the button's place: first the measuring render, then the louder one.
    expect(phases[0]).toBe('Checking loudness');
    expect(phases).toContain('Making it louder');
    expect(saved).toHaveLength(1);
    const wav = parseWav(await saved[0].blob.arrayBuffer());
    const buf = new AudioBuffer({ numberOfChannels: 2, length: wav.channels[0].length, sampleRate: wav.sampleRate });
    wav.channels.forEach((c, i) => buf.copyToChannel(new Float32Array(c), i));
    const lufs = lufsOf(buf);
    const loud = dialog().querySelector('[data-testid="export-loud"]')!.textContent ?? '';
    console.info(`[export-loud] ${lufs.toFixed(2)} LUFS, peak ${peakDb(wav.channels).toFixed(2)} dBFS, drive ${before} → ${drive()} | ${loud}`);
    expect(Math.abs(lufs + 14)).toBeLessThanOrEqual(1);
    expect(peakDb(wav.channels)).toBeLessThan(-0.9);
    expect(loud).toMatch(
      /^The file was made \d+\.\d dB louder to reach −14 LUFS, the Streaming level\. Your song’s mastering in Mix was not changed\. The limiter keeps every peak under −1 dB, so nothing clips\.$/,
    );
    // Only the file changed.
    expect(drive()).toBe(before);
    expect(session.store.historySize().undo).toBe(0);
    // So a second export makes the same loud file again, and still changes nothing.
    const again = await exportAndWait(dialog, /^Export WAV$/, 120_000);
    console.info(`[export-loud] again: ${again.join(', ')} | ${dialog().querySelector('[data-testid="export-loud"]')?.textContent}`);
    expect(again).toContain('Making it louder');
    expect(saved).toHaveLength(2);
    expect(drive()).toBe(before);
    expect(session.store.historySize().undo).toBe(0);
  }, 240_000);

  it('a scene is saved at the level it plays: no switch, the song’s mastering stays, and it says how to make it louder', async () => {
    const drive = () => readParam(MASTERING_PARAMS, session.store.getState().mastering.params, 'loudness');
    const before = drive();
    const dialog = open('scene:1');
    expect(dialog().querySelector('[role="switch"]')).toBeNull();
    expect(dialog().querySelector('[data-testid="export-loud-song-only"]')!.textContent).toBe(
      'Saved at the level it plays now. To make it as loud as streaming songs, export the whole song.',
    );
    await press(byText(dialog(), 'More options'));
    await length(dialog, 1);
    const phases = await exportAndWait(dialog, /^Export WAV$/);
    expect(phases).not.toContain('Checking loudness');
    expect(saved).toHaveLength(1);
    expect(drive()).toBe(before);
    expect(session.store.historySize().undo).toBe(0);
  }, 120_000);
});

describe('the other formats', () => {
  it('Smaller file for sharing: an Ogg Opus file the browser decodes, as long as the WAV, with the music in it', async () => {
    const dialog = open('scene:1');
    await choose(selects(dialog())[1], 'opus');
    await press(byText(dialog(), 'More options'));
    await length(dialog, 2);
    // A scene is saved at the level it plays (no loudness match): the file itself is what is checked here.
    expect(dialog().querySelector('[role="switch"]')).toBeNull();
    await exportAndWait(dialog, /^Export small file$/);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toMatch(/\.ogg$/);
    expect(saved[0].blob.type).toBe('audio/ogg');
    const bytes = new Uint8Array(await saved[0].blob.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('OggS');
    const plan = session.renderPlan({ kind: 'scene', row: 1, bars: 2 }, session.store.getState().arrangement.tailSeconds);
    const ctx = new OfflineAudioContext(2, 1, 48000);
    const decoded = await ctx.decodeAudioData(bytes.slice().buffer);
    console.info(`[export-opus] ${bytes.length} bytes, ${decoded.duration.toFixed(3)} s (plan ${plan.fileSeconds.toFixed(3)} s), ${lufsOf(decoded).toFixed(1)} LUFS`);
    expect(Math.abs(decoded.duration - plan.fileSeconds)).toBeLessThan(0.03);
    expect(lufsOf(decoded)).toBeGreaterThan(-40);
    // About a tenth of a 24-bit WAV of the same length.
    expect(bytes.length).toBeLessThan(plan.fileSeconds * 48000 * 6 * 0.15);
    expect(dialog().querySelector('[data-testid="export-result"]')!.textContent).toMatch(/^Saved .+\.ogg \(\d\.\d+ MB, /);
  }, 120_000);

  it('Parts as separate files: one WAV per part that plays, each that part alone, none silent, without mastering', async () => {
    const dialog = open('scene:1');
    await choose(selects(dialog())[1], 'stems');
    await press(byText(dialog(), 'More options'));
    await length(dialog, 1);
    const phases = await exportAndWait(dialog, /^Export parts$/, 180_000);
    const project = session.store.getState();
    const parts = stemParts(project, { kind: 'scene', row: 1, bars: 1 });
    expect(parts.length).toBeGreaterThanOrEqual(3);
    // The progress names each part as it is rendered ("Part 2 of 4 (Percussion)").
    expect(phases.some((p) => new RegExp(`^Part \\d of ${parts.length} \\(`).test(p))).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toMatch(/\(parts\)\.zip$/);
    const files = unzipSync(new Uint8Array(await saved[0].blob.arrayBuffer()));
    const names = Object.keys(files);
    expect(names).toHaveLength(parts.length);
    parts.forEach((p, i) => expect(names[i]).toBe(`${String(project.tracks.findIndex((t) => t.id === p.trackId) + 1).padStart(2, '0')} ${p.name}.wav`));
    const levels: number[] = [];
    for (const n of names) {
      const wav = parseWav(files[n].buffer.slice(files[n].byteOffset, files[n].byteOffset + files[n].byteLength) as ArrayBuffer);
      expect(wav.channels).toHaveLength(2);
      levels.push(peakDb(wav.channels));
    }
    console.info(`[export-stems] ${names.map((n, i) => `${n}: peak ${levels[i].toFixed(1)} dBFS`).join(' | ')}`);
    for (const l of levels) expect(l).toBeGreaterThan(-50);
    // Each file is a different part: no two the same.
    const sum = (b: Uint8Array) => b.reduce((h, v) => (h * 31 + v) >>> 0, 7);
    expect(new Set(names.map((n) => sum(files[n]))).size).toBe(names.length);
    expect(dialog().querySelector('[data-testid="export-result"]')!.textContent).toContain('without mastering');
  }, 240_000);

  it('MIDI file: a type-1 file with the tempo and a track per part that plays', async () => {
    act(() => void session.accepted(cmd.setBpm(session.store, 126)));
    const dialog = open('song');
    await choose(selects(dialog())[1], 'midi');
    await exportAndWait(dialog, /^Export MIDI$/);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toMatch(/\.mid$/);
    const b = new Uint8Array(await saved[0].blob.arrayBuffer());
    expect(String.fromCharCode(...b.subarray(0, 4))).toBe('MThd');
    expect((b[8] << 8) | b[9]).toBe(1);
    const tracks = ((b[10] << 8) | b[11]) - 1;
    const parts = stemParts(session.store.getState(), { kind: 'song' });
    expect(tracks).toBe(parts.length);
    // Tempo meta event: 60 000 000 / 126 µs per quarter note.
    const at = [...b].findIndex((v, i) => v === 0xff && b[i + 1] === 0x51 && b[i + 2] === 0x03);
    expect((b[at + 3] << 16) | (b[at + 4] << 8) | b[at + 5]).toBe(Math.round(60_000_000 / 126));
    expect(dialog().querySelector('[data-testid="export-result"]')!.textContent).toMatch(new RegExp(`^Saved .+\\.mid: ${tracks} parts, 126 BPM, \\d:\\d\\d\\.$`));
  });
});
