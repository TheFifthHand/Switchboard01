/**
 * r7 Share (EASY_SPEC §8), with the real session's offline renders and real mouse input:
 * - It opens on "A music file to send": the whole song with its length, the Sound the song has now,
 *   "As loud as streaming songs" on, a name, More choices folded, [Save to my computer].
 * - An empty song offers no music file ("Your song is empty — add a loop first", no button); the
 *   project can still be saved.
 * - A Sound and "As loud as streaming songs" change only the file: the project, its mastering and the
 *   undo history stay exactly as they were. The loud file lands near −14 LUFS under the ceiling, and
 *   the result says so in plain words (no LUFS).
 * - Every kind of file downloads with the right name and extension: .wav, .ogg (Opus), a .zip of
 *   one WAV per instrument, .mid, one section of the song; the project as .omnisong.zip, which
 *   imports back to the same song.
 * - Cancel while it renders: nothing saved, nothing changed.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { unzipSync } from 'fflate';
import '../../src/ui/theme.css';
import { ToastProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { ShareDialog } from '../../src/app/views/share/ShareDialog';
import { setLoudnessTarget } from '../../src/app/views/mix/mixPrefs';
import { getStarter } from '../../src/content/starters';
import { importBundle } from '../../src/persistence/bundle';
import { opusSupported } from '../../src/render/opus';
import { measureLoudness } from '../../src/render/loudness';
import { stemParts } from '../../src/render/stems';
import { parseWav } from '../../src/render/wav';
import type { Project } from '../../src/project/types';
import { setUiMode } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';
import { centre, click } from './r4-uikit-input';

let saved: { name: string; blob: Blob }[] = [];
let closes = 0;

/** The House starter's scene-2 loops for 4 bars, with two sections (Intro: bars 1–2, Main: bars 3–4): quick renders. */
function shortSong(): Project {
  const p = getStarter('house')!.build();
  p.name = 'My beat';
  p.arrangement.regions = p.tracks.flatMap((t) => (t.clips[1] ? [{ id: `rg_${t.id}`, trackId: t.id, clipId: t.clips[1].id, start: 0, bars: 4, offset: 0 }] : []));
  p.arrangement.sections = [
    { id: 'sec_a', name: 'Intro', start: 0, bars: 2 },
    { id: 'sec_b', name: 'Main', start: 2, bars: 2 },
  ];
  return p;
}

beforeEach(async () => {
  await page.viewport(1366, 768);
  expect(await opusSupported()).toBe(true);
  saved = [];
  closes = 0;
  setLoudnessTarget('streaming');
  act(() => {
    session.store.replace(shortSong(), { resetHistory: true });
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
});

function open() {
  mount(h(ToastProvider, null, h(ShareDialog, { onClose: () => closes++ })), { width: 1366 });
  return () => document.querySelector<HTMLElement>('[role="dialog"]')!;
}

const buttonByText = (root: ParentNode, text: string | RegExp) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')));
const labelByText = (root: ParentNode, text: string | RegExp) =>
  [...root.querySelectorAll<HTMLLabelElement>('label')].find((l) => (typeof text === 'string' ? l.textContent?.trim() === text : text.test(l.textContent ?? '')))!;
const checkedIn = (root: ParentNode, legend: string) => {
  const set = [...root.querySelectorAll('fieldset')].find((f) => f.querySelector('legend')?.textContent === legend)!;
  return set.querySelector<HTMLInputElement>('input:checked')!.closest('label')!.textContent?.trim();
};
const text = (d: HTMLElement, id: string) => d.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

async function press(el: Element) {
  await click(centre(el));
  await act(async () => wait(20));
}

/** Save and wait for the render to end; returns the progress phases seen in the button's place. */
async function save(dialog: () => HTMLElement, timeout = 120_000): Promise<string[]> {
  const phases = new Set<string>();
  await press(buttonByText(dialog(), 'Save to my computer')!);
  const end = performance.now() + timeout;
  while (performance.now() < end && dialog().querySelector('[data-testid="share-progress"]')) {
    const p = dialog().querySelector('[data-testid="share-progress"]')?.textContent;
    if (p) phases.add(p.replace(/… .*/, '').replace(/…$/, ''));
    await act(async () => wait(40));
  }
  await act(async () => wait(50));
  return [...phases];
}

async function wavOf(blob: Blob) {
  const wav = parseWav(await blob.arrayBuffer());
  const buf = new AudioBuffer({ numberOfChannels: 2, length: wav.channels[0].length, sampleRate: wav.sampleRate });
  wav.channels.forEach((c, i) => buf.copyToChannel(new Float32Array(c), i));
  const lufs = measureLoudness(buf.getChannelData(0), buf.getChannelData(1), buf.sampleRate, { truePeak: false }).integrated;
  const peak = 20 * Math.log10(Math.max(...wav.channels.map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0))));
  return { wav, lufs, peak, seconds: wav.channels[0].length / wav.sampleRate };
}

/** The project as stored, and the undo history: what Share must never change. */
const snapshot = () => ({ json: JSON.stringify(session.store.getState()), undo: session.store.historySize().undo });

describe('what Share opens on', () => {
  it('a music file: the whole song with its length, the Sound it has now, loud on, a name, More choices folded', () => {
    const dialog = open();
    const d = dialog();
    expect(d.textContent).toContain('Share your song');
    const choice = d.querySelector<HTMLInputElement>('[role="radiogroup"] input:checked')!;
    expect(choice.closest('label')!.textContent).toContain('A music file to send');
    expect(text(d, 'share-what')).toMatch(/^The whole song · 0:0\d$/);
    // A new song sounds Clean: that chip is chosen and says it is how the song sounds now.
    expect(checkedIn(d, 'Sound')).toBe('Clean');
    expect(text(d, 'share-sound-says')).toContain('This is how your song sounds now.');
    const sw = d.querySelector<HTMLElement>('[role="switch"]')!;
    expect(sw.textContent).toContain('As loud as streaming songs');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(text(d, 'share-file-only')).toBe('The Sound and loudness change only the file. Your song stays as it is.');
    expect(d.querySelector<HTMLInputElement>('input[type="text"]')!.placeholder).toBe('My beat');
    expect(text(d, 'share-ext')).toBe('.wav');
    expect(buttonByText(d, 'More choices')!.getAttribute('aria-expanded')).toBe('false');
    expect(buttonByText(d, 'Save to my computer')).toBeDefined();
    // Simple words: no studio jargon on the first screen.
    for (const word of ['LUFS', 'dBTP', 'mastering', 'BPM', 'MIDI', 'WAV (', 'Export']) expect(d.textContent, word).not.toContain(word);
  });

  it('an empty song offers no music file, and says what to do; the project can still be saved', async () => {
    act(() => {
      const p = shortSong();
      p.arrangement.regions = [];
      p.arrangement.sections = [];
      session.store.replace(p, { resetHistory: true });
    });
    const dialog = open();
    expect(text(dialog(), 'share-empty')).toBe('Your song is empty — add a loop first.');
    expect(buttonByText(dialog(), 'Save to my computer')).toBeUndefined();
    expect(dialog().querySelector('[role="switch"]')).toBeNull();
    await press(labelByText(dialog(), /The project, to keep working/));
    expect(buttonByText(dialog(), 'Save to my computer')).toBeDefined();
  });
});

describe('a Sound and loudness change only the file', () => {
  it('Warm and loud: a .wav near −14 LUFS under the ceiling, in plain words; the project and undo history unchanged', async () => {
    const before = snapshot();
    const dialog = open();
    await press(labelByText(dialog(), 'Warm'));
    expect(checkedIn(dialog(), 'Sound')).toMatch(/Warm$/);
    expect(text(dialog(), 'share-sound-says')).toBe('Rounder and cosier: fuller lows and softer highs.');
    const phases = await save(dialog, 180_000);
    expect(phases[0]).toBe('Listening to your song');
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('My beat.wav');
    expect(saved[0].blob.type).toBe('audio/wav');
    const { wav, lufs, peak } = await wavOf(saved[0].blob);
    console.info(`[share-loud] phases ${phases.join(' → ')} | ${lufs.toFixed(2)} LUFS, peak ${peak.toFixed(2)} dBFS | ${text(dialog(), 'share-result')}`);
    expect(wav.sampleRate).toBe(44100);
    expect(wav.bitDepth).toBe(16);
    expect(Math.abs(lufs + 14)).toBeLessThanOrEqual(1);
    expect(peak).toBeLessThan(-0.9);
    expect(text(dialog(), 'share-result')).toBe('Saved “My beat.wav” — as loud as streaming songs, with the Warm sound. Find it in your Downloads.');
    expect(snapshot()).toEqual(before);
  }, 240_000);

  it('the Sound is really in the file: Clean and Lo-fi files differ; loud off keeps the level; nothing in the project moves', async () => {
    const before = snapshot();
    const dialog = open();
    await press(dialog().querySelector('[role="switch"]')!);
    expect(dialog().querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
    await save(dialog);
    expect(text(dialog(), 'share-result')).toBe('Saved “My beat.wav”. Find it in your Downloads.');
    await press(labelByText(dialog(), 'Lo-fi'));
    await save(dialog);
    expect(text(dialog(), 'share-result')).toBe('Saved “My beat.wav” — with the Lo-fi sound. Find it in your Downloads.');
    expect(saved).toHaveLength(2);
    const clean = await wavOf(saved[0].blob);
    const lofi = await wavOf(saved[1].blob);
    // Lo-fi cuts the lows and highs and narrows the sound: a different file, same length.
    const sideEnergy = (w: typeof clean) => w.wav.channels[0].reduce((s, l, i) => s + (l - w.wav.channels[1][i]) ** 2, 0);
    console.info(`[share-sound] clean ${clean.lufs.toFixed(1)} LUFS side ${sideEnergy(clean).toFixed(2)} | lofi ${lofi.lufs.toFixed(1)} LUFS side ${sideEnergy(lofi).toFixed(2)}`);
    expect(Math.abs(clean.seconds - lofi.seconds)).toBeLessThan(0.01);
    expect(sideEnergy(lofi)).toBeLessThan(sideEnergy(clean) * 0.6);
    expect(snapshot()).toEqual(before);
  }, 180_000);
});

describe('every kind of file', () => {
  async function kind(dialog: () => HTMLElement, label: RegExp) {
    if (buttonByText(dialog(), 'More choices')!.getAttribute('aria-expanded') === 'false') await press(buttonByText(dialog(), 'More choices')!);
    await press(labelByText(dialog(), label));
  }

  it('Smaller file: an Ogg Opus file saved as .ogg (audio/ogg) that the browser plays, with the music in it', async () => {
    const before = snapshot();
    const dialog = open();
    await kind(dialog, /^Smaller file \(\.ogg\)$/);
    expect(text(dialog(), 'share-ext')).toBe('.ogg');
    await press(dialog().querySelector('[role="switch"]')!);
    await save(dialog);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('My beat.ogg');
    expect(saved[0].blob.type).toBe('audio/ogg');
    const bytes = new Uint8Array(await saved[0].blob.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('OggS');
    const decoded = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(bytes.slice().buffer);
    const plan = session.renderPlan({ kind: 'song' }, session.store.getState().arrangement.tailSeconds);
    expect(Math.abs(decoded.duration - plan.fileSeconds)).toBeLessThan(0.03);
    expect(measureLoudness(decoded.getChannelData(0), decoded.getChannelData(1), 48000, { truePeak: false }).integrated).toBeGreaterThan(-40);
    expect(text(dialog(), 'share-result')).toBe('Saved “My beat.ogg”. Find it in your Downloads.');
    expect(snapshot()).toEqual(before);
  }, 120_000);

  it('Each instrument as its own file: a .zip with one WAV per instrument; no Sound or loudness to choose', async () => {
    const dialog = open();
    await kind(dialog, /^Each instrument as its own file/);
    expect(dialog().querySelector('[role="switch"]')).toBeNull();
    expect([...dialog().querySelectorAll('legend')].map((l) => l.textContent)).not.toContain('Sound');
    expect(text(dialog(), 'share-ext')).toBe('.zip');
    const phases = await save(dialog, 180_000);
    const parts = stemParts(session.store.getState(), { kind: 'song' });
    expect(phases.some((p) => new RegExp(`^Instrument \\d of ${parts.length} \\(`).test(p))).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('My beat (instruments).zip');
    const files = unzipSync(new Uint8Array(await saved[0].blob.arrayBuffer()));
    expect(Object.keys(files)).toHaveLength(parts.length);
    expect(text(dialog(), 'share-result')).toMatch(new RegExp(`^Saved “My beat \\(instruments\\)\\.zip” — one file for each of ${parts.length} instruments \\(`));
  }, 240_000);

  it('Just the notes: a .mid with a track per instrument', async () => {
    const dialog = open();
    await kind(dialog, /^Just the notes/);
    expect(text(dialog(), 'share-ext')).toBe('.mid');
    await save(dialog);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('My beat.mid');
    const b = new Uint8Array(await saved[0].blob.arrayBuffer());
    expect(String.fromCharCode(...b.subarray(0, 4))).toBe('MThd');
    const tracks = ((b[10] << 8) | b[11]) - 1;
    expect(tracks).toBe(stemParts(session.store.getState(), { kind: 'song' }).length);
    expect(text(dialog(), 'share-result')).toBe(`Saved “My beat.mid” — the notes of ${tracks} instruments, for another music app. Find it in your Downloads.`);
  });

  it('one section of the song: named after it, as long as it', async () => {
    const dialog = open();
    await press(buttonByText(dialog(), 'More choices')!);
    const select = dialog().querySelector<HTMLSelectElement>('select')!;
    expect([...select.options].map((o) => o.textContent)).toEqual([expect.stringMatching(/^The whole song \(0:0\d\)$/), expect.stringMatching(/^Intro \(0:0\d\)$/), expect.stringMatching(/^Main \(0:0\d\)$/)]);
    act(() => {
      select.value = 'sec_b';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => wait(20));
    expect(text(dialog(), 'share-what')).toMatch(/^Main · 0:0\d$/);
    await press(dialog().querySelector('[role="switch"]')!);
    await save(dialog);
    expect(saved[0].name).toBe('My beat - Main.wav');
    const plan = session.renderPlan({ kind: 'songRange', fromBar: 2, toBar: 4 }, session.store.getState().arrangement.tailSeconds);
    const { seconds } = await wavOf(saved[0].blob);
    expect(Math.abs(seconds - plan.fileSeconds)).toBeLessThan(0.01);
  }, 120_000);

  it('The project, to keep working: the .omnisong.zip that imports back to the same song', async () => {
    const before = snapshot();
    const dialog = open();
    await press(labelByText(dialog(), /The project, to keep working/));
    expect(text(dialog(), 'share-project-says')).toContain('Saves “My beat” as one file (.omnisong.zip)');
    expect(dialog().querySelector('[role="switch"]')).toBeNull();
    await save(dialog);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('My-beat.omnisong.zip');
    expect(text(dialog(), 'share-result')).toMatch(/^Saved “My-beat\.omnisong\.zip” — your whole project, with its sounds and recordings\. Find it in your Downloads\./);
    const back = await importBundle(saved[0].blob);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const now = session.store.getState();
    expect(back.project.name).toBe('My beat');
    expect(back.project.arrangement).toEqual(now.arrangement);
    expect(back.project.tracks.map((t) => t.id)).toEqual(now.tracks.map((t) => t.id));
    expect(back.project.mastering).toEqual(now.mastering);
    expect(snapshot()).toEqual(before);
  }, 60_000);
});

it('Cancel while it renders: nothing saved, nothing changed, and it says so', async () => {
  const before = snapshot();
  const dialog = open();
  await press(buttonByText(dialog(), 'Save to my computer')!);
  const end = performance.now() + 60_000;
  while (performance.now() < end && !buttonByText(dialog(), 'Cancel')) await act(async () => wait(10));
  // Esc and a click outside do nothing while it renders: only Cancel stops it.
  expect(dialog().textContent).not.toContain('Save to my computer');
  await press(buttonByText(dialog(), 'Cancel')!);
  while (performance.now() < end && dialog().querySelector('[data-testid="share-progress"]')) await act(async () => wait(20));
  await act(async () => wait(50));
  expect(text(dialog(), 'share-result')).toBe('Cancelled. Nothing was saved.');
  expect(saved).toHaveLength(0);
  expect(snapshot()).toEqual(before);
  expect(closes).toBe(0);
}, 90_000);
