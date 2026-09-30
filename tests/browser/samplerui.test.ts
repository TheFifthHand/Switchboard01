/**
 * Sampler editor and local audio import in real Chromium: the real session
 * and store, real DOM pointer/keyboard/change events, real IndexedDB and the
 * browser's own decoder. Outcomes are checked on the project.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/ui/theme.css';
import { TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { ImportSampleButton, SamplerEditor } from '../../src/app/views/sampler';
import { importStore } from '../../src/app/views/sampler/importState';
import { DECODE_FAILED_MESSAGE } from '../../src/persistence/audioImport';
import * as db from '../../src/persistence/db';
import { createProject } from '../../src/project/factory';
import type { Project, SamplerInstrument } from '../../src/project/types';
import { encodeWav } from '../../src/render/wav';
import { cleanup, fire, key, mount, pointer, wait } from './ui-harness';

const project = (): Project => session.store.getState();
const track = (id: string) => project().tracks.find((t) => t.id === id)!;
const samplerParams = (id: string) => (track(id).instrument as SamplerInstrument).params;

function setup(trackId: string, el: 'editor' | 'button' = 'editor') {
  act(() => {
    session.store.replace(createProject({ name: 'Sampler UI test', now: 1 }));
  });
  const child = el === 'editor' ? h(SamplerEditor, { trackId }) : h(ImportSampleButton, { trackId, variant: 'button' });
  return mount(h(TipsProvider, { enabled: false }, child), { width: 420 });
}

function slider(root: Element, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[role="slider"][aria-label="${name}"]`);
  if (!el) throw new Error(`No slider "${name}"`);
  return el;
}

function button(root: Element, name: string | RegExp): HTMLButtonElement {
  const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => {
    const label = x.getAttribute('aria-label') ?? x.textContent ?? '';
    return typeof name === 'string' ? label === name : name.test(label);
  });
  if (!b) throw new Error(`No button "${String(name)}"`);
  return b;
}

function radio(root: Element, name: string): HTMLButtonElement {
  const r = [...root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((x) => x.textContent?.trim() === name);
  if (!r) throw new Error(`No radio "${name}"`);
  return r;
}

function switchNamed(root: Element, name: string): HTMLButtonElement {
  const s = [...root.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((x) => document.getElementById(x.getAttribute('aria-labelledby') ?? '')?.textContent === name);
  if (!s) throw new Error(`No switch "${name}"`);
  return s;
}

const click = (el: HTMLElement) => fire(el, new MouseEvent('click', { bubbles: true, cancelable: true }));

function fileInput(root: Element): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('No file input');
  return input;
}

/** Choose a file in the (hidden) file input, as the browser does after the picker closes. */
function chooseFile(input: HTMLInputElement, file: File): void {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  fire(input, new Event('change', { bubbles: true }));
}

function statusText(root: Element): string {
  return [...root.querySelectorAll('[role="status"]')].map((s) => s.textContent ?? '').join(' | ');
}

async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await act(async () => {
      await wait(25);
    });
  }
}

/** A short 16-bit mono WAV (440 Hz sine). */
function toneWav(seconds: number, sampleRate = 48000): ArrayBuffer {
  const x = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  return encodeWav([x], sampleRate, 16);
}

const createdSamples: string[] = [];

beforeEach(() => {
  runtimeStore.setState((s) => ({ ...s, notice: null, recording: 'off' }));
  importStore.setState({});
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  for (const id of createdSamples.splice(0)) await db.deleteSample(id).catch(() => undefined);
});

describe('Sampler editor: trim', () => {
  it('dragging the Start and End handles changes start/end, keeps end after start, and is one undo step per drag', () => {
    const m = setup('t8');
    const wave = m.container.querySelector<HTMLElement>('[role="group"][aria-label^="Waveform of"]')!;
    expect(wave).toBeTruthy();
    const start = slider(m.container, 'Trim start');
    const end = slider(m.container, 'Trim end');
    const r = wave.getBoundingClientRect();
    const x = (f: number) => r.left + r.width * f;
    const y = r.top + r.height / 2;
    expect(samplerParams('t8').start).toBe(0);
    expect(samplerParams('t8').end).toBe(1);

    // Drag Start from the left edge to 30%.
    pointer(start, 'pointerdown', { clientX: x(0), clientY: y });
    pointer(start, 'pointermove', { clientX: x(0.15), clientY: y });
    pointer(start, 'pointermove', { clientX: x(0.3), clientY: y });
    pointer(start, 'pointerup', { clientX: x(0.3), clientY: y });
    expect(samplerParams('t8').start).toBeCloseTo(0.3, 2);
    expect(start.getAttribute('aria-valuenow')).toBe('30');
    expect(start.getAttribute('aria-valuetext')).toMatch(/^0\.7\d\d s \(30% of the recording\)$/);

    // The whole drag is one undo step.
    act(() => session.undo());
    expect(samplerParams('t8').start).toBe(0);
    act(() => session.redo());
    expect(samplerParams('t8').start).toBeCloseTo(0.3, 2);

    // Drag End past Start: it stops just after Start.
    pointer(end, 'pointerdown', { clientX: x(1), clientY: y });
    pointer(end, 'pointermove', { clientX: x(0.1), clientY: y });
    pointer(end, 'pointerup', { clientX: x(0.1), clientY: y });
    const p1 = samplerParams('t8');
    expect(p1.end).toBeGreaterThan(p1.start);
    expect(p1.end).toBeLessThan(p1.start + 0.01);

    // Drag Start past End: it stops just before End.
    pointer(start, 'pointerdown', { clientX: x(0.3), clientY: y });
    pointer(start, 'pointermove', { clientX: x(0.95), clientY: y });
    pointer(start, 'pointerup', { clientX: x(0.95), clientY: y });
    const p2 = samplerParams('t8');
    expect(p2.start).toBeLessThan(p2.end);

    // Pressing on the waveform moves the nearest handle there (right of the region: End).
    pointer(wave, 'pointerdown', { clientX: x(0.8), clientY: y });
    pointer(wave, 'pointerup', { clientX: x(0.8), clientY: y });
    expect(samplerParams('t8').end).toBeCloseTo(0.8, 2);
    expect(samplerParams('t8').start).toBeLessThan(samplerParams('t8').end);

    // Readouts show the region in seconds (glass chord is 2.5 s long).
    const readouts = m.container.querySelector('dl[aria-label="Trim region"]')!.textContent ?? '';
    expect(readouts).toContain('2.000 s');
  });

  it('handles work from the keyboard (arrows, Shift = fine, Home/End) and double-click resets', () => {
    const m = setup('t8');
    const start = slider(m.container, 'Trim start');
    const end = slider(m.container, 'Trim end');
    key(end, 'keydown', { key: 'ArrowLeft' });
    expect(samplerParams('t8').end).toBeCloseTo(0.99, 5);
    key(end, 'keydown', { key: 'ArrowLeft', shiftKey: true });
    expect(samplerParams('t8').end).toBeCloseTo(0.989, 5);
    key(start, 'keydown', { key: 'PageUp' });
    expect(samplerParams('t8').start).toBeCloseTo(0.1, 5);
    // End (key) pushes Start as far as it may go: just before End.
    key(start, 'keydown', { key: 'End' });
    expect(samplerParams('t8').start).toBeLessThan(samplerParams('t8').end);
    expect(samplerParams('t8').start).toBeGreaterThan(0.98);
    fire(start, new MouseEvent('dblclick', { bubbles: true }));
    expect(samplerParams('t8').start).toBe(0);
  });
});

describe('Sampler editor: playback and tempo controls', () => {
  it('One-shot / Loop, Tempo Sync, root note and the bars helper change the real parameters', async () => {
    const m = setup('t8');
    // Mode
    click(radio(m.container, 'Loop'));
    expect(samplerParams('t8').mode).toBe(1);
    expect(m.container.textContent).toContain('Loop');
    click(radio(m.container, 'One-shot'));
    expect(samplerParams('t8').mode).toBe(0);

    // Tempo Sync, with the explicit explanation.
    expect(m.container.textContent).toContain('Speed and pitch change together (no time-stretch)');
    const sync = switchNamed(m.container, 'Tempo Sync');
    expect(sync.getAttribute('aria-checked')).toBe('false');
    click(sync);
    expect(samplerParams('t8').sync).toBe(1);
    expect(sync.getAttribute('aria-checked')).toBe('true');
    // The resulting speed/pitch change is stated in text.
    expect(m.container.textContent).toMatch(/Following \d+ BPM: plays at [\d.]+× speed/);

    // Root note
    const root = [...m.container.querySelectorAll('select')].find((s) => s.labels?.[0]?.textContent === 'Root')!;
    expect(root.value).toBe('60');
    root.value = '67';
    fire(root, new Event('change', { bubbles: true }));
    expect(samplerParams('t8').rootNote).toBe(67);

    // Bars helper: the 2.5 s glass chord at Original BPM 120 is 1.25 bars.
    const barsField = [...m.container.querySelectorAll<HTMLInputElement>('input[role="spinbutton"]')].find((i) => i.labels?.[0]?.textContent === 'Region length in bars')!;
    expect(barsField).toBeTruthy();
    expect(barsField.value).toBe('1.25');
    // 0.25 bars in 2.5 s would be 24 BPM: refused with a way out.
    key(barsField, 'keydown', { key: 'ArrowDown' });
    expect(barsField.value).toBe('0.25');
    expect(button(m.container, 'Set BPM').disabled).toBe(true);
    expect(m.container.textContent).toContain('Original BPM must be 40–220');
    // 2.25 bars → 2.25 × 240 / 2.5 = 216 BPM.
    key(barsField, 'keydown', { key: 'ArrowUp' });
    key(barsField, 'keydown', { key: 'ArrowUp' });
    expect(barsField.value).toBe('2.25');
    const set = button(m.container, 'Set 216 BPM');
    expect(set.disabled).toBe(false);
    click(set);
    expect(samplerParams('t8').originalBpm).toBeCloseTo(216, 5);
    await act(async () => wait(800)); // let the field's key burst end
  });

  it('knobs edit gain, pitch, fine, attack, release, cutoff, fade in and fade out', () => {
    const m = setup('t8');
    const cases: [string, string][] = [
      ['Gain', 'gain'],
      ['Pitch', 'pitch'],
      ['Fine', 'fine'],
      ['Attack', 'attack'],
      ['Release', 'release'],
      ['Cutoff', 'cutoff'],
      ['Fade in', 'fadeIn'],
      ['Fade out', 'fadeOut'],
    ];
    for (const [name, param] of cases) {
      const before = samplerParams('t8')[param];
      const k = slider(m.container, name);
      key(k, 'keydown', { key: name === 'Cutoff' ? 'ArrowDown' : 'ArrowUp' });
      expect(samplerParams('t8')[param], name).not.toBe(before);
    }
  });

  it('the picker assigns built-in recordings (turning a synth part into a sampler) and Audition plays the root note', async () => {
    const noteOn = vi.spyOn(session, 'noteOn').mockImplementation(() => undefined);
    const noteOff = vi.spyOn(session, 'noteOff').mockImplementation(() => undefined);
    vi.spyOn(session, 'startAudio').mockResolvedValue(true);
    const m = setup('t4');
    expect(track('t4').instrument.kind).toBe('poly');
    expect(m.container.textContent).toContain('turn this part into a sampler');
    const picker = [...m.container.querySelectorAll('select')].find((s) => s.id === 'sampler-recording-t4')!;
    picker.value = 'builtin:bell-hit';
    fire(picker, new Event('change', { bubbles: true }));
    expect(track('t4').instrument).toMatchObject({ kind: 'sampler', sampleId: 'builtin:bell-hit' });
    // The full editor replaces the empty state.
    await until(() => !!m.container.querySelector('[aria-label="Trim start"]'), 'the sampler editor');
    act(() => session.undo());
    expect(track('t4').instrument.kind).toBe('poly');
    act(() => session.redo());

    // Loop mode: Audition holds the root note until Stop.
    click(radio(m.container, 'Loop'));
    await act(async () => {
      click(button(m.container, 'Audition: play C4'));
      await wait(0);
    });
    expect(noteOn).toHaveBeenCalledWith('t4', 60, 0.85, 'pad');
    const stop = button(m.container, /^Stop audition/);
    expect(stop.getAttribute('aria-pressed')).toBe('true');
    click(stop);
    expect(noteOff).toHaveBeenCalledWith('t4', 60, 'pad');
    expect(button(m.container, 'Audition: play C4').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('Sampler import', () => {
  it('shows the limits before importing and refuses an unsupported file without changing the project', async () => {
    const m = setup('t4');
    const before = project();
    const input = fileInput(m.container);
    expect(input.accept).toBe('.wav,.mp3,audio/wav,audio/mpeg');
    expect(m.container.textContent).toContain('WAV or MP3, up to 50 MB and 60 seconds.');
    expect(m.container.textContent).toContain('Files stay on this device');
    expect(m.container.textContent).toContain('Imported recordings keep their pitch unless you change Pitch.');

    chooseFile(input, new File(['just some notes'], 'notes.txt', { type: 'text/plain' }));
    await until(() => statusText(m.container).includes('is not a WAV or MP3 file'), 'the error message');
    expect(statusText(m.container)).toContain('"notes.txt" is not a WAV or MP3 file. Convert it to WAV or MP3 and try again.');
    expect(project()).toBe(before);
    expect(track('t4').instrument.kind).toBe('poly');
  });

  it('a file that does not decode shows the actionable message and changes nothing', async () => {
    const m = setup('t8', 'button');
    const before = project();
    expect(statusText(m.container)).toContain('up to 50 MB and 60 seconds');
    chooseFile(fileInput(m.container), new File([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 5, 6, 7, 8])], 'broken.wav', { type: 'audio/wav' }));
    await until(() => statusText(m.container).includes(DECODE_FAILED_MESSAGE), 'the decode error');
    expect(project()).toBe(before);
    // The message can be dismissed.
    click(button(m.container, 'Dismiss import message'));
    expect(statusText(m.container)).not.toContain(DECODE_FAILED_MESSAGE);
  });

  it('a small generated WAV is decoded, stored in IndexedDB and assigned; the part becomes a sampler', async () => {
    const m = setup('t4');
    expect(track('t4').instrument.kind).toBe('poly');
    const file = new File([toneWav(0.5)], 'Test Tone.wav', { type: 'audio/wav' });
    chooseFile(fileInput(m.container), file);
    expect(statusText(m.container)).toContain('Decoding “Test Tone.wav” on this device…');
    await until(() => project().samples.length === 1, 'the recording in the project');
    const meta = project().samples[0];
    createdSamples.push(meta.id);
    expect(meta.name).toBe('Test Tone');
    expect(meta.duration).toBeCloseTo(0.5, 2);
    expect(meta.channels).toBe(1);
    expect(meta.peaks?.length).toBeGreaterThan(0);
    expect(track('t4').instrument).toMatchObject({ kind: 'sampler', sampleId: meta.id });
    const stored = await db.getSample(meta.id);
    expect(stored?.blob.size).toBe(file.size);

    // The full editor shows the recording with its waveform, and the result message carried over.
    await until(() => !!m.container.querySelector('[aria-label="Waveform of Test Tone. Drag Start and End to trim."]'), 'the waveform');
    expect(m.container.textContent).toContain('0.50 s · 48 kHz · Mono · WAV');
    await until(() => statusText(m.container).includes('Imported "Test Tone" (0.5 s).'), 'the result message');
    const picker = m.container.querySelector<HTMLSelectElement>('#sampler-recording-t4')!;
    expect(picker.value).toBe(meta.id);
    expect([...picker.options].some((o) => o.value === meta.id && o.textContent === 'Test Tone (0.50 s)')).toBe(true);
  });
});
