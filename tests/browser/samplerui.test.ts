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
import { snapToScale } from '../../src/music/scales';
import * as cmd from '../../src/state/commands';
import { ImportSampleButton, SamplerEditor } from '../../src/app/views/sampler';
import { importStore } from '../../src/app/views/sampler/importState';
import { headerSampleRate } from '../../src/app/views/sampler/samplerMath';
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

/** The editor's drop zone (the element that takes dropped files). */
function dropZone(root: Element): HTMLElement {
  const title = [...root.querySelectorAll('p')].find((x) => /Drop a WAV or MP3 here|Release to import/.test(x.textContent ?? ''));
  if (!title?.parentElement) throw new Error('No drop zone');
  return title.parentElement;
}

function drag(target: EventTarget, type: 'dragenter' | 'dragover' | 'drop', file: File): DragEvent {
  const dt = new DataTransfer();
  dt.items.add(file);
  return fire(target, new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })) as DragEvent;
}

/** One device pixel of the waveform canvas at fractions of its width and height. */
function pixel(canvas: HTMLCanvasElement, fx: number, fy = 0.5): [number, number, number, number] {
  const x = Math.min(canvas.width - 1, Math.round(canvas.width * fx));
  const y = Math.round(canvas.height * fy);
  const d = canvas.getContext('2d')!.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}
const isAmber = ([r, g, b, a]: number[]) => a > 200 && r > 200 && r - b > 90 && g > b;
/** Height (device px) of the amber signal in one canvas column. */
function amberHeight(canvas: HTMLCanvasElement, fx: number): number {
  const x = Math.min(canvas.width - 1, Math.round(canvas.width * fx));
  const d = canvas.getContext('2d')!.getImageData(x, 0, 1, canvas.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (isAmber([d[i], d[i + 1], d[i + 2], d[i + 3]])) n++;
  return n;
}
const isGrey = ([r, g, b, a]: number[]) => a > 40 && Math.abs(r - g) < 25 && Math.abs(g - b) < 25;

/**
 * Stand-ins for the session's live-note path (no audio device in this test): they publish
 * the held pitch exactly as the session does. A 'preview' plays exactly the key given (the
 * session never applies Musical Assist to previews).
 */
function fakeNotes() {
  vi.spyOn(session, 'startAudio').mockResolvedValue(true);
  const noteOn = vi.spyOn(session, 'noteOn').mockImplementation((trackId, key, _velocity, source) => {
    const p = project();
    const pitch = source !== 'preview' && p.assist ? snapToScale(key, p.root, p.scale) : key;
    runtimeStore.setState((s) => ({ ...s, held: { ...s.held, [trackId]: [pitch] } }));
  });
  const noteOff = vi.spyOn(session, 'noteOff').mockImplementation((trackId) => {
    runtimeStore.setState((s) => ({ ...s, held: { ...s.held, [trackId]: [] } }));
  });
  return { noteOn, noteOff };
}

async function press(el: HTMLElement): Promise<void> {
  await act(async () => {
    click(el);
    await wait(0);
  });
}

/** A short 16-bit mono WAV (440 Hz sine). */
function toneWav(seconds: number, sampleRate = 48000): ArrayBuffer {
  const x = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  return encodeWav([x], sampleRate, 16);
}

const createdSamples: string[] = [];

beforeEach(() => {
  runtimeStore.setState((s) => ({ ...s, notice: null, recording: 'off', recordTarget: null, replayId: null, held: {} }));
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

  it('draws the recording: amber where it plays, grey outside the trimmed region, shaped by the fades', async () => {
    const m = setup('t8');
    const canvas = m.container.querySelector<HTMLCanvasElement>('[aria-label^="Waveform of"] canvas')!;
    await until(() => canvas.width > 100, 'the canvas to be sized');
    // The whole file plays: the loud attack of the glass chord is a tall amber band.
    expect(amberHeight(canvas, 0.03)).toBeGreaterThan(20);
    act(() => {
      session.setInstrumentParam('t8', 'start', 0.1);
      session.setInstrumentParam('t8', 'end', 0.7);
    });
    await act(async () => wait(20));
    expect(amberHeight(canvas, 0.03), 'no amber before Start').toBe(0);
    expect(isGrey(pixel(canvas, 0.03)), 'grey before Start').toBe(true);
    expect(isGrey(pixel(canvas, 0.85)), 'grey after End').toBe(true);
    const unfaded = amberHeight(canvas, 0.12);
    expect(unfaded, 'amber just after Start').toBeGreaterThan(10);
    // A long fade-in shapes what is drawn: just after Start the heard signal is far smaller.
    act(() => session.setInstrumentParam('t8', 'fadeIn', 400));
    await act(async () => wait(20));
    expect(amberHeight(canvas, 0.12)).toBeLessThan(unfaded * 0.4);
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
    // Done: the key says so in words and stays focusable (not disabled).
    expect(set.textContent).toBe('216 BPM set');
    expect(set.getAttribute('aria-disabled')).toBe('true');
    expect(set.disabled).toBe(false);
    act(() => session.undo());
    expect(samplerParams('t8').originalBpm).toBe(120);
    expect(set.textContent).toBe('Set 216 BPM');
    await act(async () => wait(800)); // let the field's key burst end
  });

  it('says what One-shot and Loop do with the note length and the loop point', () => {
    act(() => {
      session.store.replace(createProject({ name: 'Sampler UI test', now: 1 }));
    });
    const m = mount(h(TipsProvider, { enabled: true }, h(SamplerEditor, { trackId: 't8' })), { width: 420 });
    const described = (el: Element) =>
      (el.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
    expect(described(radio(m.container, 'One-shot'))).toContain('plays the whole trimmed region once, however short the note');
    expect(described(radio(m.container, 'Loop'))).toContain('crossfade at the loop point');
    click(radio(m.container, 'Loop'));
    expect(described(slider(m.container, 'Fade out'))).toContain('crossfades the loop point');
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

  it('the picker assigns built-in recordings, turning a synth part into a sampler (undoable)', async () => {
    const m = setup('t4');
    expect(track('t4').instrument.kind).toBe('poly');
    expect(m.container.textContent).toContain('turn this part into a sampler');
    const picker = [...m.container.querySelectorAll('select')].find((s) => s.id === 'sampler-recording-t4')!;
    picker.value = 'builtin:bell-hit';
    fire(picker, new Event('change', { bubbles: true }));
    expect(track('t4').instrument).toMatchObject({ kind: 'sampler', sampleId: 'builtin:bell-hit' });
    // The full editor replaces the empty state, and keyboard focus lands on its picker.
    await until(() => !!m.container.querySelector('[aria-label="Trim start"]'), 'the sampler editor');
    expect(document.activeElement?.id).toBe('sampler-recording-t4');
    expect(m.container.textContent).toContain('Bell Hit');
    act(() => session.undo());
    expect(track('t4').instrument.kind).toBe('poly');
    await until(() => m.container.textContent?.includes('turn this part into a sampler') ?? false, 'the empty state again');
  });

  it('Audition holds the root key, follows the real note, and is off while a take records', async () => {
    const { noteOn, noteOff } = fakeNotes();
    const m = setup('t8');
    click(radio(m.container, 'Loop'));
    await press(button(m.container, 'Audition: play C4'));
    expect(noteOn).toHaveBeenCalledWith('t8', 60, 0.85, 'preview');
    expect(button(m.container, /^Stop audition/).getAttribute('aria-pressed')).toBe('true');
    expect(button(m.container, /^Stop audition/).textContent).toBe('Stop');

    // Mute All / Stop / window blur release every held note in the session: the key follows.
    act(() => runtimeStore.setState((s) => ({ ...s, held: {} })));
    expect(button(m.container, 'Audition: play C4').getAttribute('aria-pressed')).toBe('false');
    expect(noteOff).not.toHaveBeenCalled();

    // Stop releases the key it pressed.
    await press(button(m.container, 'Audition: play C4'));
    click(button(m.container, /^Stop audition/));
    expect(noteOff).toHaveBeenCalledWith('t8', 60, 'preview');
    expect(button(m.container, 'Audition: play C4').getAttribute('aria-pressed')).toBe('false');

    // A root outside the project's key: the recording still plays at its own pitch on exactly that key,
    // and Stop lets go of it.
    act(() => session.setInstrumentParam('t8', 'rootNote', 61));
    expect(snapToScale(61, project().root, project().scale)).not.toBe(61);
    expect(m.container.textContent).not.toContain('Musical Assist plays it as');
    await press(button(m.container, 'Audition: play C#4'));
    expect(noteOn).toHaveBeenLastCalledWith('t8', 61, 0.85, 'preview');
    const stopKey = button(m.container, 'Stop audition (playing C#4)');
    expect(stopKey.getAttribute('aria-pressed')).toBe('true');
    click(stopKey);
    expect(noteOff).toHaveBeenLastCalledWith('t8', 61, 'preview');
    expect(button(m.container, 'Audition: play C#4').getAttribute('aria-pressed')).toBe('false');
    await press(button(m.container, 'Audition: play C#4'));

    // A performance starting mid-audition ends it; Audition stays off during the take.
    noteOff.mockClear();
    act(() => runtimeStore.setState((s) => ({ ...s, recording: 'performance' })));
    expect(noteOff).toHaveBeenCalledWith('t8', 61, 'preview');
    expect(button(m.container, /^Audition: play C#4/).disabled).toBe(true);
    // Record Notes into this part: off. Into another part: on.
    act(() => runtimeStore.setState((s) => ({ ...s, recording: 'notes', recordTarget: { trackId: 't8', slot: 0 } })));
    expect(button(m.container, /^Audition: play C#4/).disabled).toBe(true);
    act(() => runtimeStore.setState((s) => ({ ...s, recordTarget: { trackId: 't1', slot: 0 } })));
    expect(button(m.container, 'Audition: play C#4').disabled).toBe(false);

    // Leaving the editor mid-audition lets go of the key.
    act(() => runtimeStore.setState((s) => ({ ...s, recording: 'off', recordTarget: null })));
    await press(button(m.container, 'Audition: play C#4'));
    noteOff.mockClear();
    cleanup();
    expect(noteOff).toHaveBeenCalledWith('t8', 61, 'preview');
  });

  it('a recording whose audio is not in this browser says so and cannot be auditioned', async () => {
    const m = setup('t8');
    act(() => {
      cmd.addSampleMeta(session.store, { id: 'smp_lost_take', name: 'Lost Take', mime: 'audio/wav', byteLength: 2048, duration: 1, sampleRate: 48000, channels: 1, peaks: [-0.5, 0.5, -0.4, 0.4] });
      cmd.assignSample(session.store, 't8', 'smp_lost_take');
    });
    await until(() => m.container.textContent?.includes('audio missing') ?? false, 'the missing-audio label');
    expect(statusText(m.container)).toContain('is not stored in this browser');
    expect(button(m.container, /^Audition/).disabled).toBe(true);
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

    // A file released just outside the zone must not make the browser open it in place of the app.
    const outside = new File(['x'], 'near miss.wav', { type: 'audio/wav' });
    expect(drag(document.body, 'dragover', outside).defaultPrevented).toBe(true);
    expect(drag(document.body, 'drop', outside).defaultPrevented).toBe(true);
    expect(project()).toBe(before);
  });

  it('the details show the file’s own sample rate, read from its WAV or MP3 header', () => {
    expect(headerSampleRate(new Uint8Array(toneWav(0.01, 22050)))).toBe(22050);
    // An MP3 with an ID3v2 tag (10-byte header + 5 bytes), then an MPEG-1 Layer III frame at 48 kHz.
    const id3 = [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5];
    expect(headerSampleRate(new Uint8Array([...id3, 0xff, 0xfb, 0x94, 0x00]))).toBe(48000);
    // MPEG-2 Layer III at 22.05 kHz, no tag.
    expect(headerSampleRate(new Uint8Array([0xff, 0xf3, 0x80, 0x00]))).toBe(22050);
    expect(headerSampleRate(new Uint8Array([1, 2, 3, 4, 5, 6]))).toBeNull();
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

  it('a small generated WAV dropped on the zone is decoded, stored in IndexedDB and assigned; the part becomes a sampler', async () => {
    const m = setup('t4');
    expect(track('t4').instrument.kind).toBe('poly');
    const file = new File([toneWav(0.5, 44100)], 'Test Tone.wav', { type: 'audio/wav' });
    const zone = dropZone(m.container);
    drag(zone, 'dragenter', file);
    expect(drag(zone, 'dragover', file).defaultPrevented).toBe(true);
    expect(zone.textContent).toContain('Release to import');
    drag(zone, 'drop', file);
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
    // Keyboard continuity: the drop zone is gone, so focus lands on the new editor's picker.
    expect(document.activeElement?.id).toBe('sampler-recording-t4');
    // The file's own rate (44.1 kHz), not the rate the browser decoded it at.
    await until(() => m.container.textContent?.includes('0.50 s · 44.1 kHz · Mono · WAV') ?? false, 'the recording details');
    await until(() => statusText(m.container).includes('Imported "Test Tone" (0.5 s).'), 'the result message');
    const picker = m.container.querySelector<HTMLSelectElement>('#sampler-recording-t4')!;
    expect(picker.value).toBe(meta.id);
    expect([...picker.options].some((o) => o.value === meta.id && o.textContent === 'Test Tone (0.50 s)')).toBe(true);
  });
});
