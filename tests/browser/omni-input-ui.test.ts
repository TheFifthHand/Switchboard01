/**
 * MIDI & audio in the running interface (real Chromium, the app's styles and
 * fonts): the sampler editor's Edit recording keys make new versions of the
 * recording (one undo step each, audio checked), Record audio records a take
 * from a "microphone" made by the app's own AudioContext, the MIDI & audio
 * dialog connects a (fake) MIDI keyboard with live activity lights, MIDI
 * learn and the audio input, and at 1366 x 768 and 960 x 540 the dialog, the
 * transport (with its MIDI & audio key) and the sampler editor fit, with no
 * target under 32 px.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { AUDIO_INPUT_SETTINGS_KEY, INPUT_DENIED_MESSAGE } from '../../src/app/audioInput';
import { session } from '../../src/app/instance';
import { MIDI_SETTINGS_KEY, type MidiAccessLike, type MidiInputLike, type MidiMessageLike } from '../../src/app/midi';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { audioInput, midi } from '../../src/app/views/devices';
import { SamplerEditor } from '../../src/app/views/sampler';
import { editStore } from '../../src/app/views/sampler/sampleVersions';
import { TipsProvider } from '../../src/ui/components';
import * as db from '../../src/persistence/db';
import { createProject } from '../../src/project/factory';
import type { SamplerInstrument } from '../../src/project/types';
import { selectTrack, setGuideDone, setKeyboardCollapsed, setPadMode, setTipsEnabled, setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, fire, mount, wait } from './ui-harness';

async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await act(async () => {
      await wait(20);
    });
  }
}
const click = (el: Element) => fire(el, new MouseEvent('click', { bubbles: true, cancelable: true }));
async function press(el: Element): Promise<void> {
  await act(async () => {
    click(el);
    await wait(0);
  });
}
function button(root: ParentNode, name: string | RegExp): HTMLButtonElement {
  const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => {
    const label = (x.getAttribute('aria-label') ?? x.textContent ?? '').trim();
    return typeof name === 'string' ? label === name : name.test(label);
  });
  if (!b) throw new Error(`No button "${String(name)}"`);
  return b;
}
function selectNamed(root: ParentNode, name: string): HTMLSelectElement {
  const s = [...root.querySelectorAll<HTMLSelectElement>('select')].find((x) => x.labels?.[0]?.textContent === name || x.getAttribute('aria-label') === name);
  if (!s) throw new Error(`No select "${name}"`);
  return s;
}
function choose(sel: HTMLSelectElement, value: string): void {
  sel.value = value;
  fire(sel, new Event('change', { bubbles: true }));
}
const statusText = (root: ParentNode) => [...root.querySelectorAll('[role="status"]')].map((s) => s.textContent ?? '').join(' | ');
const t8 = () => session.store.getState().tracks.find((t) => t.id === 't8')!;
const created: string[] = [];

class FakeInput implements MidiInputLike {
  onmidimessage: ((e: MidiMessageLike) => void) | null = null;
  state = 'connected';
  constructor(
    readonly id: string,
    readonly name: string,
  ) {}
  send(...bytes: number[]): void {
    this.onmidimessage?.({ data: new Uint8Array(bytes) });
  }
}

function fakeMidi(...names: string[]): FakeInput[] {
  const ins = names.map((n, i) => new FakeInput(`in-${i}`, n));
  const access: MidiAccessLike = { inputs: new Map(ins.map((i) => [i.id, i])), onstatechange: null };
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access });
  return ins;
}

/** The "microphone": a MediaStream of a sine made in the app's own AudioContext. */
async function fakeMic(amp = 0.4): Promise<void> {
  expect(await session.startAudio()).toBe(true);
  const ctx = session.ctx as AudioContext;
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 1;
  const osc = new OscillatorNode(ctx, { frequency: 330 });
  osc.connect(new GainNode(ctx, { gain: amp })).connect(dest);
  osc.start();
  vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async () => new MediaStream(dest.stream.getAudioTracks().map((t) => t.clone())));
  vi.spyOn(navigator.mediaDevices, 'enumerateDevices').mockResolvedValue([{ deviceId: 'mic-1', groupId: 'g', kind: 'audioinput', label: 'Desk microphone', toJSON: () => ({}) } as MediaDeviceInfo]);
}

function editorSetup(bpm = 200) {
  act(() => {
    session.store.replace(createProject({ name: 'Input UI test', bpm, now: 1 }));
  });
  return mount(h(TipsProvider, { enabled: false }, h(SamplerEditor, { trackId: 't8' })), { width: 420 });
}

beforeEach(() => {
  localStorage.removeItem(MIDI_SETTINGS_KEY);
  localStorage.removeItem(AUDIO_INPUT_SETTINGS_KEY);
  editStore.setState({});
  patchRuntime({ notice: null, recording: 'off', recordTarget: null, replayId: null, held: {}, muteAll: false });
});

afterEach(async () => {
  cleanup();
  midi.disconnect();
  audioInput.close();
  audioInput.state.setState((s) => ({ ...s, result: null }));
  if (session.transport?.playing) session.stop();
  vi.restoreAllMocks();
  delete (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess;
  for (const id of created.splice(0)) await db.deleteSample(id).catch(() => undefined);
  localStorage.removeItem(MIDI_SETTINGS_KEY);
  localStorage.removeItem(AUDIO_INPUT_SETTINGS_KEY);
});

/* ------------------------------------------------------------------ */
/* Edit recording                                                      */
/* ------------------------------------------------------------------ */

describe('Edit recording (sampler editor)', () => {
  it('Normalize makes a new version that the part plays, stored in this browser; one Undo brings the original back', async () => {
    const m = editorSetup();
    const original = (t8().instrument as SamplerInstrument).sampleId!;
    expect(original.startsWith('builtin:')).toBe(true);
    await press(button(m.container, 'Normalize'));
    await until(() => statusText(m.container).includes('Normalized'), 'the result');
    expect(statusText(m.container)).toMatch(/Normalized: the loudest peak of the region is now at -1 dB\. Now playing “.+ \(edit 1\)”\. Undo goes back\./);
    const p = session.store.getState();
    expect(p.samples).toHaveLength(1);
    const v = p.samples[0];
    created.push(v.id);
    expect((t8().instrument as SamplerInstrument).sampleId).toBe(v.id);
    expect(v.name).toMatch(/\(edit 1\)$/);
    const rec = await db.getSample(v.id);
    const buf = await new OfflineAudioContext(1, 1, v.sampleRate).decodeAudioData(await rec!.blob.arrayBuffer());
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) for (const x of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(x));
    expect(peak).toBeCloseTo(10 ** (-1 / 20), 3);
    expect(session.store.info.getState().undoLabel).toBe('Normalize recording');
    act(() => session.undo());
    expect((t8().instrument as SamplerInstrument).sampleId).toBe(original);
    expect(session.store.getState().samples).toEqual([]);
    // The editor follows: the picker shows the built-in again.
    await until(() => (m.container.querySelector<HTMLSelectElement>('#sampler-recording-t8')?.value ?? '') === original, 'the picker');
  });

  it('Crop keeps the trimmed region; Fade in, Reverse and Gain work on the region; Crop is off when there is nothing to crop', async () => {
    const m = editorSetup();
    expect(button(m.container, 'Crop to region').disabled).toBe(true);
    act(() => {
      session.setInstrumentParam('t8', 'start', 0.2);
      session.setInstrumentParam('t8', 'end', 0.6);
    });
    const crop = button(m.container, 'Crop to region');
    expect(crop.disabled).toBe(false);
    await press(crop);
    await until(() => statusText(m.container).includes('Cropped'), 'the crop');
    const v1 = session.store.getState().samples[0];
    created.push(v1.id);
    expect(v1.duration).toBeCloseTo(2.5 * 0.4, 2);
    const params = (t8().instrument as SamplerInstrument).params;
    expect(params.start).toBe(0);
    expect(params.end).toBe(1);
    // Fade in over the whole region: it starts from silence and rises evenly.
    choose(selectNamed(m.container, 'Fade length'), 'region');
    await press(button(m.container, 'Fade in'));
    await until(() => statusText(m.container).includes('Faded in'), 'the fade');
    const v2 = session.store.getState().samples.find((x) => x.id !== v1.id)!;
    created.push(v2.id);
    // The cropped version is no longer used by anything: it left the project's list (Undo brings it back).
    expect(session.store.getState().samples.map((x) => x.id)).toEqual([v2.id]);
    const rec = await db.getSample(v2.id);
    const buf = await new OfflineAudioContext(1, 1, v2.sampleRate).decodeAudioData(await rec!.blob.arrayBuffer());
    const x = buf.getChannelData(0);
    expect(Math.abs(x[0])).toBeLessThan(1e-3);
    // Normalized, then 12 dB more: past full scale, and the message says it clipped.
    await press(button(m.container, 'Normalize'));
    await until(() => statusText(m.container).includes('Normalized'), 'the normalize');
    act(() => {
      const field = [...m.container.querySelectorAll<HTMLInputElement>('input[role="spinbutton"]')].find((i) => i.labels?.[0]?.textContent === 'Gain')!;
      field.focus();
    });
    for (let i = 0; i < 18; i++) {
      const field = [...m.container.querySelectorAll<HTMLInputElement>('input[role="spinbutton"]')].find((f) => f.labels?.[0]?.textContent === 'Gain')!;
      fire(field, new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    }
    await press(button(m.container, 'Apply gain'));
    await until(() => statusText(m.container).includes('louder'), 'the gain');
    expect(statusText(m.container)).toMatch(/Made the region 12 dB louder\. Its loudest peaks went over full scale and were clipped/);
    created.push(...session.store.getState().samples.map((s) => s.id));
    // Four edits, four undo steps.
    for (let i = 0; i < 4; i++) act(() => session.undo());
    expect((t8().instrument as SamplerInstrument).sampleId?.startsWith('builtin:')).toBe(true);
    expect((t8().instrument as SamplerInstrument).params.start).toBe(0.2);
    await act(async () => wait(800));
  });

  it('edits are off while a performance records or audio records onto the part, and say why', async () => {
    const m = editorSetup();
    act(() => patchRuntime({ recording: 'performance' }));
    expect(button(m.container, 'Normalize').disabled).toBe(true);
    expect(statusText(m.container)).toContain('A performance is recording, so the recording can’t change until you stop.');
    expect(button(m.container, 'Record audio').disabled).toBe(true);
    expect(statusText(m.container)).toContain('Recording audio is not available while a performance records.');
    act(() => patchRuntime({ recording: 'off' }));
    expect(button(m.container, 'Normalize').disabled).toBe(false);
    expect(button(m.container, 'Record audio').disabled).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Record audio                                                        */
/* ------------------------------------------------------------------ */

describe('Record audio (sampler editor)', () => {
  it('records a take in time and shows its progress; it becomes the part’s recording with a clip; one Undo removes it', async () => {
    await fakeMic();
    const m = editorSetup();
    const before = session.store.getState();
    // One bar, no count-in.
    await press([...m.container.querySelectorAll('[role="radio"]')].find((r) => r.textContent === '1')!);
    const countIn = [...m.container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((x) => document.getElementById(x.getAttribute('aria-labelledby') ?? '')?.textContent === 'Count-in')!;
    if (countIn.getAttribute('aria-checked') === 'true') await press(countIn);
    expect(audioInput.state.getState()).toMatchObject({ bars: 1, countIn: false });
    await press(button(m.container, 'Record audio'));
    await until(() => !!m.container.querySelector('[data-phase]'), 'the progress line');
    await until(() => /Recording: bar 1 of 1/.test(m.container.textContent ?? ''), 'the bar counter');
    expect(button(m.container, 'Stop recording')).toBeTruthy();
    await until(() => /Recorded \d+\.\d s \(1 bar\)\. Recording 1 plays in its own clip on /.test(statusText(m.container)), 'the result', 10000);
    const meta = session.store.getState().samples.find((s) => s.name === 'Recording 1')!;
    created.push(meta.id);
    expect(meta.duration).toBeCloseTo(1.2, 1);
    // The take is its own clip's recording (the part's other clips keep theirs).
    expect(t8().clips.some((c) => c?.sample?.id === meta.id)).toBe(true);
    expect(m.container.textContent).toContain('Input: Desk microphone'.replace('Desk microphone', audioInput.state.getState().deviceLabel ?? ''));
    expect(session.store.info.getState().undoLabel).toBe('Record audio');
    act(() => session.undo());
    expect(session.store.getState().samples).toEqual(before.samples);
    expect(t8().clips).toEqual(before.tracks.find((t) => t.id === 't8')!.clips);
    act(() => session.stop());
  });

  it('a refused microphone shows the reason in the editor and changes nothing', async () => {
    const m = editorSetup();
    const before = session.store.getState();
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
    await press(button(m.container, 'Record audio'));
    await until(() => statusText(m.container).includes(INPUT_DENIED_MESSAGE), 'the message');
    expect(session.store.getState()).toBe(before);
    expect(runtimeStore.getState().playing).toBe(false);
  });

  it('Input settings… opens MIDI & audio at the audio input', async () => {
    const m = editorSetup();
    await press(button(m.container, 'Input settings…'));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!;
    expect(dialog).toBeTruthy();
    // Focus starts on the audio section's first action (its heading is read out with the dialog).
    expect(document.activeElement?.textContent).toBe('Use input');
    expect(dialog.contains(document.activeElement)).toBe(true);
    await press(button(dialog, 'Done'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The dialog and the transport, in the app                            */
/* ------------------------------------------------------------------ */

let boot: BootInfo;

async function settle() {
  await Promise.all(['400 13px "Inter Variable"', '600 13px "Inter Variable"', '650 15px "Inter Variable"', '400 12px "IBM Plex Mono"'].map((f) => document.fonts.load(f)));
  await document.fonts.ready;
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await wait(30);
  });
}

async function openApp(w: number, hh: number) {
  await db.deleteDb();
  act(() => {
    setGuideDone(true);
    setTipsEnabled(true);
    setUiMode('simple');
    setView('play');
    setPadMode('loops');
    setKeyboardCollapsed(false);
  });
  boot = await session.boot();
  await page.viewport(w, hh);
  const m = mount(h(App, { boot }));
  m.container.style.width = '';
  m.container.style.padding = '0';
  const look = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Just look around');
  await act(async () => {
    look?.click();
    await wait(20);
  });
  act(() => selectTrack('t4'));
  await settle();
  return m;
}

const transport = () => document.querySelector<HTMLElement>('header[aria-label="Transport"]')!;
const shown = (el: Element | null | undefined): el is HTMLElement => !!el && el.getBoundingClientRect().width > 1 && getComputedStyle(el).visibility !== 'hidden';
function smallTargets(root: ParentNode, min: number): string[] {
  return [...root.querySelectorAll<HTMLElement>('button, [role="switch"], [role="radio"], [role="tab"], select, input')]
    .filter((el) => shown(el) && !el.closest('[aria-hidden="true"]') && !el.classList.contains('visually-hidden'))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width < min - 0.5 || r.height < min - 0.5;
    })
    .map((el) => `${el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName} (${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)})`);
}

async function openDevices(): Promise<HTMLElement> {
  await press(button(transport(), /^More/));
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((x) => x.textContent?.includes('MIDI & audio…'))!;
  expect(item).toBeTruthy();
  await press(item);
  await settle();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!;
  expect(dialog.getAttribute('aria-labelledby') && document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('MIDI & audio');
  return dialog;
}

describe('MIDI & audio dialog', () => {
  afterEach(async () => {
    cleanup();
    await session.autosaver?.flush();
    await db.deleteDb();
  });

  it('More → MIDI & audio…: Connect MIDI lists the keyboard with a live light, routes it and learns a knob; the transport shows the MIDI key', async () => {
    const [kb] = fakeMidi('Keys 49');
    await openApp(1366, 768);
    expect(transport().querySelector('button[aria-label^="MIDI & audio"]')).toBeNull();
    const dialog = await openDevices();
    await press(button(dialog, 'Connect MIDI'));
    await until(() => statusText(dialog).includes('1 MIDI input connected.'), 'the connection');
    const list = dialog.querySelector('ul[aria-label="MIDI inputs"]')!;
    expect(list.textContent).toContain('Keys 49');
    expect(dialog.textContent).toContain('The light next to a device flashes when it sends notes or controls.');
    // The activity light flashes on a message (amber), then goes out.
    const lamp = list.querySelector<HTMLElement>('li > span[aria-hidden="true"]')!;
    expect(lamp.dataset.on).toBeUndefined();
    kb.send(0xb0, 20, 64);
    await until(() => lamp.dataset.on === '1', 'the light');
    await until(() => lamp.dataset.on === undefined, 'the light to go out', 2000);
    // Route it to a fixed part.
    const route = selectNamed(dialog, 'Keys 49 plays');
    expect(route.value).toBe('selected');
    choose(route, 't5');
    expect(midi.routeOf('in-0')).toBe('t5');
    // MIDI learn: Tone of the selected part.
    choose(selectNamed(dialog, 'Control'), 'macro:tone');
    await press(button(dialog, 'Learn'));
    expect(statusText(dialog)).toContain('Move a knob, fader or wheel on your controller to control Tone (selected part)…');
    act(() => kb.send(0xb0, 74, 100));
    await settle();
    expect(statusText(dialog)).toContain('Mapped: CC 74 · channel 1 · Keys 49 now controls Tone (selected part).');
    const mappings = dialog.querySelector('ul[aria-label="Learned controls"]')!;
    expect(mappings.textContent).toContain('CC 74 · channel 1 · Keys 49');
    act(() => kb.send(0xb0, 74, 127));
    expect(session.store.getState().tracks.find((t) => t.id === 't4')!.macros.tone).toBe(1);
    await press(button(mappings, 'Remove: CC 74 · channel 1 · Keys 49 controls Tone (selected part)'));
    expect(dialog.querySelector('ul[aria-label="Learned controls"]')).toBeNull();
    // The transport now has the MIDI & audio key; it opens the dialog too.
    await press(button(dialog, 'Done'));
    const key = transport().querySelector<HTMLButtonElement>('button[aria-label^="MIDI & audio"]')!;
    expect(key.getAttribute('aria-label')).toBe('MIDI & audio: 1 MIDI input');
    await press(key);
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
  });

  it('the transport fits on one row from 1024 to 1920 px, Simple and Advanced, with MIDI and the audio input on', async () => {
    fakeMidi('Keys');
    await openApp(1366, 768);
    await fakeMic();
    await act(async () => {
      await midi.connect();
      await audioInput.open();
    });
    for (const w of [1024, 1100, 1180, 1250, 1320, 1366, 1440, 1600, 1700, 1920]) {
      await page.viewport(w, 800);
      for (const mode of ['simple', 'advanced'] as const) {
        act(() => setUiMode(mode));
        await act(async () => wait(40));
        expect(transport().scrollWidth, `${w} ${mode}`).toBeLessThanOrEqual(transport().clientWidth + 1);
        expect(document.scrollingElement!.scrollWidth, `${w} ${mode}`).toBeLessThanOrEqual(window.innerWidth);
        // Where the key has room it shows; MIDI & audio is always in the More menu.
        const key = transport().querySelector<HTMLElement>('button[aria-label^="MIDI & audio"]');
        if (w >= 1280 || (mode === 'simple' && w >= 1180)) expect(shown(key), `${w} ${mode}: the key`).toBe(true);
      }
    }
    act(() => setUiMode('simple'));
  });

  for (const [w, hh] of [
    [1366, 768],
    [960, 540],
  ] as const) {
    it(`at ${w} x ${hh}: the dialog (MIDI and audio input on), the transport with its MIDI & audio key and the sampler editor fit, with 32 px targets`, async () => {
      fakeMidi('Arturia KeyStep 37', 'Akai MPD218 Pads');
      await openApp(w, hh);
      await fakeMic();
      const dialog = await openDevices();
      await press(button(dialog, 'Connect MIDI'));
      await until(() => statusText(dialog).includes('2 MIDI inputs connected.'), 'the connection');
      await press(button(dialog, 'Use input'));
      await until(() => audioInput.state.getState().status === 'open', 'the input');
      await settle();
      expect(dialog.querySelector('[aria-label="Input level"]')).not.toBeNull();
      expect(button(dialog, 'Turn input off')).toBeTruthy();
      // The dialog fits the window and never scrolls sideways.
      const box = dialog.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(window.innerWidth);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
      const body = dialog.querySelector<HTMLElement>('[role="dialog"] > div:nth-of-type(2)') ?? dialog;
      for (const el of [dialog, body]) expect(el.scrollWidth, 'dialog scrolls sideways').toBeLessThanOrEqual(el.clientWidth + 1);
      expect(smallTargets(dialog, 32)).toEqual([]);
      await press(button(dialog, 'Done'));
      await settle();
      // Transport: the MIDI & audio key is there, and nothing overflows.
      const key = transport().querySelector<HTMLButtonElement>('button[aria-label^="MIDI & audio"]')!;
      expect(shown(key)).toBe(true);
      expect(key.getAttribute('aria-label')).toBe('MIDI & audio: 2 MIDI inputs, audio input on');
      expect(transport().scrollWidth).toBeLessThanOrEqual(transport().clientWidth + 1);
      expect(document.scrollingElement!.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      expect(smallTargets(transport(), 32)).toEqual([]);
      // The sampler editor (Shape, every setting) with Record audio and Edit recording fits its column.
      act(() => {
        setUiMode('advanced');
        setView('shape');
        selectTrack('t8');
      });
      await settle();
      const edit = [...document.querySelectorAll<HTMLElement>('section')].find((s) => s.querySelector('h3')?.textContent === 'Edit recording')!;
      expect(edit).toBeTruthy();
      const rec = button(document, 'Record audio');
      expect(shown(rec)).toBe(true);
      const column = edit.closest<HTMLElement>('section[aria-labelledby], [class*="col"]') ?? edit.parentElement!;
      for (const el of [edit, rec.parentElement!]) {
        expect(el.scrollWidth, 'sampler editor overflows').toBeLessThanOrEqual(el.clientWidth + 1);
        const r = el.getBoundingClientRect();
        expect(r.right).toBeLessThanOrEqual(column.getBoundingClientRect().right + 1);
      }
      expect(smallTargets(edit, 32)).toEqual([]);
      expect(smallTargets(rec.parentElement!.parentElement!, 32)).toEqual([]);
      const wide = [...document.querySelectorAll<HTMLElement>('body *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5).map((el) => el.getAttribute('aria-label') ?? el.tagName);
      expect(wide).toEqual([]);
      expect(document.scrollingElement!.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      act(() => setUiMode('simple'));
    });
  }
});
