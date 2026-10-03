/**
 * capability-01 (UI): per-clip recordings in the sampler editor. The whole
 * app (House starter), the Shape view on Vocal, real clicks and keys; the
 * "microphone" is a stream made by the session's own AudioContext (as in
 * omni-input-audio.test.ts):
 * - two takes go into two clips, and each plays its own recording (offline
 *   renders: take 1 at 440 Hz, take 2 at 660 Hz); "Oh Chops" and "Long Oh"
 *   keep Vocal "Oh"; the header says "Recording 2 — plays in Vocal · Groove";
 *   the Record audio tooltip says what happens to the take, and 8 bars is offered;
 * - the "Recording for Vocal" picker sets the selected clip's recording (the
 *   other clips keep theirs; "Vocal’s recording" gives it back), and the
 *   part's when no clip is selected;
 * - Start/End and Root edit the clip's own region and root key, not the part's.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { audioInput } from '../../src/app/views/devices';
import { TAKE_CLIP_TEXT } from '../../src/app/views/sampler/RecordAudio';
import type { SamplerInstrument } from '../../src/project/types';
import { selectSlot, uiStore } from '../../src/state/uiStore';
import { button, clickEl, described, energyAt, openApp, project, renderPart, setUp, shapeOn, tearDown, track, until } from './r4-sampler-helpers';
import { centre, mouse, settleFrames } from './r4-uikit-input';

const editorText = () => document.querySelector('[aria-label^="Waveform of"]')?.closest('section')?.parentElement?.textContent ?? '';
const picker = () => document.querySelector<HTMLSelectElement>('#sampler-recording-t8')!;
const pickerName = () => picker().getAttribute('aria-label') ?? document.querySelector(`label[for="${picker().id}"]`)?.textContent ?? '';

async function pick(select: HTMLSelectElement, value: string): Promise<void> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await userEvent.selectOptions(select, value);
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
  await settleFrames();
}

/** getUserMedia hands out a stream of a sine from the session's own context; returns the oscillator. */
function fakeMic(): OscillatorNode {
  const ctx = session.ctx as AudioContext;
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 1;
  const osc = new OscillatorNode(ctx, { frequency: 440 });
  osc.connect(new GainNode(ctx, { gain: 0.4 })).connect(dest);
  osc.start();
  vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async () => new MediaStream(dest.stream.getAudioTracks().map((t) => t.clone())));
  vi.spyOn(navigator.mediaDevices, 'enumerateDevices').mockResolvedValue([{ deviceId: 'mic-1', groupId: 'g', kind: 'audioinput', label: 'Test microphone', toJSON: () => ({}) } as MediaDeviceInfo]);
  return osc;
}

beforeEach(async () => {
  await setUp();
});
afterEach(async () => {
  if (audioInput.state.getState().take) audioInput.stopTake('button');
  audioInput.close();
  vi.restoreAllMocks();
  await tearDown();
});

describe('Per-clip recordings in the sampler editor (capability-01)', () => {
  it('two takes go into two clips and each plays its own recording; Oh Chops and Long Oh keep Vocal "Oh"', async () => {
    await openApp(1366, 768);
    expect(await session.startAudio()).toBe(true);
    const osc = fakeMic();
    await shapeOn('t8');
    const before = track('t8');
    act(() => {
      audioInput.setBars(1);
      audioInput.setCountIn(false);
    });
    // Lengths of 1, 2, 4 and 8 bars are offered.
    const bars = [...document.querySelectorAll<HTMLElement>('[role="radiogroup"]')].find((g) => g.getAttribute('aria-label') === 'Bars to record' || g.textContent === '1248');
    expect([...(bars?.querySelectorAll('[role="radio"]') ?? [])].map((r) => r.textContent)).toEqual(['1', '2', '4', '8']);
    const record = () => button('Record audio')!;
    expect(described(record())).toContain(TAKE_CLIP_TEXT);

    // Take 1 (440 Hz).
    await clickEl(record());
    await until(() => track('t8').clips.some((c) => c?.name === 'Recording 1'), 'take 1', 20000);
    // Take 2 (660 Hz).
    act(() => osc.frequency.setValueAtTime(660, session.ctx!.currentTime));
    await until(() => !!button('Record audio') && !button('Record audio')!.disabled, 'Record audio to be ready again', 10000);
    await clickEl(record());
    await until(() => track('t8').clips.some((c) => c?.name === 'Recording 2'), 'take 2', 20000);
    act(() => session.stop());

    const p = project();
    const t8 = track('t8');
    const s1 = p.samples.find((s) => s.name === 'Recording 1')!;
    const s2 = p.samples.find((s) => s.name === 'Recording 2')!;
    const r1 = t8.clips.findIndex((c) => c?.name === 'Recording 1');
    const r2 = t8.clips.findIndex((c) => c?.name === 'Recording 2');
    expect([r1, r2]).toEqual([0, 1]);
    // Each clip plays its own take; the part's recording, Oh Chops and Long Oh are as they were.
    expect(t8.clips[r1]?.sample?.id).toBe(s1.id);
    expect(t8.clips[r2]?.sample?.id).toBe(s2.id);
    expect((t8.instrument as SamplerInstrument).sampleId).toBe('builtin:vocal-oh');
    expect(t8.clips[2]).toBe(before.clips[2]);
    expect(t8.clips[3]).toBe(before.clips[3]);
    // The editor follows the new clip and says which recording it edits.
    expect(uiStore.getState().selectedSlot.t8).toBe(r2);
    await until(() => editorText().includes('Recording 2 — plays in Vocal · Groove'), 'the header');
    expect(picker().value).toBe(s2.id);

    // What each clip plays: take 1's 440 Hz in Intro, take 2's 660 Hz in Groove.
    const a = await renderPart(p, 't8', r1, 1);
    const b = await renderPart(p, 't8', r2, 1);
    expect(energyAt(a, 440)).toBeGreaterThan(5 * energyAt(a, 660));
    expect(energyAt(b, 660)).toBeGreaterThan(5 * energyAt(b, 440));
  });

  it('the picker sets the selected clip’s recording (the others keep theirs), and the part’s when no clip is selected', async () => {
    await openApp(1366, 768);
    act(() => selectSlot('t8', 2));
    await shapeOn('t8');
    const before = track('t8');
    // Oh Chops plays the part's recording: the editor shows that, and the picker is for this clip.
    await until(() => editorText().includes('Vocal "Oh" — plays in Vocal: Oh Chops, Long Oh'), 'the part header');
    expect(pickerName()).toBe('Recording for Vocal · Lift');
    expect(described(picker())).toContain('The part’s other clips keep theirs');
    await pick(picker(), 'builtin:bell-hit');
    expect(track('t8').clips[2]?.sample).toEqual({ id: 'builtin:bell-hit', start: 0, end: 1, rootNote: 60 });
    expect(track('t8').clips[3]).toBe(before.clips[3]);
    expect((track('t8').instrument as SamplerInstrument).sampleId).toBe('builtin:vocal-oh');
    await until(() => editorText().includes('Bell Hit — plays in Vocal · Lift'), 'the clip header');
    // "Vocal’s recording" gives the clip the part's back.
    expect([...picker().options].map((o) => o.textContent)).toContain('Vocal’s recording (Vocal "Oh")');
    await pick(picker(), '__part__');
    expect(track('t8').clips[2]?.sample).toBeUndefined();
    // No clip selected (an empty pad): the part's own recording.
    act(() => selectSlot('t8', 0));
    await settleFrames();
    expect(pickerName()).toBe('Recording for Vocal');
    await pick(picker(), 'builtin:bell-hit');
    expect((track('t8').instrument as SamplerInstrument).sampleId).toBe('builtin:bell-hit');
    expect(track('t8').clips[2]?.sample).toBeUndefined();
  });

  it('Start/End, Root, Audition and Edit recording on a clip’s recording work on that clip, not the part', { timeout: 120_000 }, async () => {
    await openApp(1366, 768);
    act(() => selectSlot('t8', 3));
    await shapeOn('t8');
    await pick(picker(), 'builtin:glass-chord');
    await until(() => editorText().includes('Glass Chord — plays in Vocal · Break'), 'the clip header');
    const partBefore = (track('t8').instrument as SamplerInstrument).params;
    const wave = document.querySelector<HTMLElement>('[aria-label^="Waveform of Glass Chord"]')!;
    const start = wave.querySelector<HTMLElement>('[role="slider"][aria-label="Trim start"]')!;
    const r = wave.getBoundingClientRect();
    // A real drag of Start to about 30%.
    const from = centre(start);
    await mouse('mouseMoved', from);
    await mouse('mousePressed', from);
    for (let i = 1; i <= 8; i++) {
      await mouse('mouseMoved', { x: from.x + (r.width * 0.3 * i) / 8, y: from.y }, { buttons: 1 });
      await new Promise((res) => requestAnimationFrame(res));
    }
    await mouse('mouseReleased', { x: from.x + r.width * 0.3, y: from.y });
    await settleFrames();
    const own = track('t8').clips[3]!.sample!;
    expect(own.start).toBeGreaterThan(0.25);
    expect(own.start).toBeLessThan(0.35);
    expect((track('t8').instrument as SamplerInstrument).params.start).toBe(partBefore.start);
    // One undo step for the drag.
    expect(session.store.undoLabel()).toBe('Trim clip recording');
    // Root: the clip's own key.
    const root = [...document.querySelectorAll<HTMLSelectElement>('select')].find((s) => s.labels?.[0]?.textContent === 'Root')!;
    await pick(root, '64');
    expect(track('t8').clips[3]!.sample!.rootNote).toBe(64);
    expect((track('t8').instrument as SamplerInstrument).params.rootNote).toBe(partBefore.rootNote);
    // The Playback section says which settings are the clip's and which the part's.
    expect(editorText()).toContain('Root is this clip’s own.');

    // Audition plays the clip's own recording (through the engine, as its notes play it) on its root key.
    expect(await session.startAudio()).toBe(true);
    const engine = session.engine!;
    const calls: { pitch: number; sample?: { id: string; rootNote: number; start: number } }[] = [];
    const real = engine.scheduleNote.bind(engine);
    const spy = vi.spyOn(engine, 'scheduleNote').mockImplementation((trackId, note) => {
      if (trackId === 't8') calls.push({ pitch: note.pitch, sample: note.sample });
      return real(trackId, note);
    });
    await clickEl(button('Audition: play E4'));
    await until(() => !!button('Stop audition (playing E4)'), 'the audition to sound');
    expect(calls.at(-1)).toMatchObject({ pitch: 64, sample: { id: 'builtin:glass-chord', rootNote: 64, start: own.start } });
    await clickEl(button('Stop audition (playing E4)'));
    await until(() => !!button('Audition: play E4'), 'the audition to stop');
    spy.mockRestore();

    // Edit recording works on the clip's recording: a new version for this clip only.
    const chops = track('t8').clips[2];
    await clickEl(button('Normalize'));
    await until(() => track('t8').clips[3]!.sample!.id !== 'builtin:glass-chord', 'the normalized version', 20000);
    expect(project().samples.some((x) => x.id === track('t8').clips[3]!.sample!.id)).toBe(true);
    expect((track('t8').instrument as SamplerInstrument).sampleId).toBe('builtin:vocal-oh');
    expect(track('t8').clips[2]).toBe(chops);
    expect(runtimeStore.getState().notice?.tone ?? 'info').not.toBe('error');
  });
});
