/**
 * Audio takes in real Chromium (the "microphone" is a stream made by the
 * session's own AudioContext, as in omni-input-audio.test.ts):
 *
 * - A finished take that is still being saved is never lost: Record
 *   Performance and Record Notes wait (with a message) until it is on the part.
 * - Stopping a take early keeps everything up to the moment of stopping. The
 *   take's window is shifted by the latency estimate plus the user's offset,
 *   and the stop is shifted the same way, so the last moments are not cut and
 *   a take stopped just after its downbeat is not thrown away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_INPUT_SETTINGS_KEY, AudioInputController, TAKE_SAVING_MESSAGE } from '../../src/app/audioInput';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session } from '../../src/app/session';
import * as db from '../../src/persistence/db';
import { createProject } from '../../src/project/factory';
import type { SamplerInstrument } from '../../src/project/types';
import { defaultUiState, uiStore } from '../../src/state/uiStore';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

let sessions: Session[] = [];
let inputs: AudioInputController[] = [];
const created: string[] = [];

/** A session at 200 BPM (one bar = 1.2 s) with sound running. */
async function started(): Promise<Session> {
  const s = new Session(createProject({ name: 'Take test', bpm: 200, now: 1 }));
  sessions.push(s);
  expect(await s.startAudio()).toBe(true);
  return s;
}

function controller(s: Session, bars: 1 | 2 | 4): AudioInputController {
  const c = new AudioInputController(s);
  inputs.push(c);
  c.setBars(bars);
  c.setCountIn(false);
  return c;
}

/** getUserMedia hands out a stream playing a steady sine from the session's own context. */
function fakeMic(s: Session): void {
  const ctx = s.ctx as AudioContext;
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 1;
  const osc = new OscillatorNode(ctx, { frequency: 440 });
  osc.connect(new GainNode(ctx, { gain: 0.3 })).connect(dest);
  osc.start();
  vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async () => new MediaStream(dest.stream.getAudioTracks().map((t) => t.clone())));
  vi.spyOn(navigator.mediaDevices, 'enumerateDevices').mockResolvedValue([{ deviceId: 'mic-1', groupId: 'g', kind: 'audioinput', label: 'Test microphone', toJSON: () => ({}) } as MediaDeviceInfo]);
}

const t8 = (s: Session) => s.store.getState().tracks.find((t) => t.id === 't8')!;

const resetRuntime = () =>
  patchRuntime({ muteAll: false, stalled: null, playing: false, paused: false, mode: 'live', replayId: null, recording: 'off', recordTarget: null, countingIn: false, held: {}, notice: null, tracks: {} });

beforeEach(() => {
  localStorage.removeItem(AUDIO_INPUT_SETTINGS_KEY);
  uiStore.setState({ ...defaultUiState() });
  resetRuntime();
});

afterEach(async () => {
  for (const c of inputs) c.dispose();
  inputs = [];
  vi.restoreAllMocks();
  for (const s of sessions) s.dispose();
  sessions = [];
  for (const id of created.splice(0)) await db.deleteSample(id).catch(() => undefined);
  localStorage.removeItem(AUDIO_INPUT_SETTINGS_KEY);
  resetRuntime();
});

describe('A finished take being saved', () => {
  it('is kept: Record Performance and Record Notes wait for it, saying why', async () => {
    const s = await started();
    fakeMic(s);
    const c = controller(s, 1);
    // Saving takes a while (a slow disk): it waits until the test lets it go on.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realStore = s.storeSample.bind(s);
    let saving = false;
    vi.spyOn(s, 'storeSample').mockImplementation(async (meta, blob, buffer) => {
      saving = true;
      await gate;
      return realStore(meta, blob, buffer);
    });
    const p = c.record('t8');
    await until(() => saving, 'the take to be saved');
    expect(c.state.getState().take?.phase).toBe('saving');

    // The user presses Record Performance, then Record Notes, while it is being saved.
    await s.togglePerformance();
    expect(runtimeStore.getState().notice?.text).toBe(TAKE_SAVING_MESSAGE);
    expect(s.recordingPerformance).toBe(false);
    expect(s.store.getLock()).toBeNull();
    patchRuntime({ notice: null });
    await s.toggleRecordNotes();
    expect(runtimeStore.getState().notice?.text).toBe(TAKE_SAVING_MESSAGE);
    expect(runtimeStore.getState().recording).toBe('off');

    release();
    const r = await p;
    expect(r.ok, r.message).toBe(true);
    const meta = s.store.getState().samples[0];
    created.push(meta.id);
    expect((t8(s).instrument as SamplerInstrument).sampleId).toBe(meta.id);
    expect(await db.hasSample(meta.id)).toBe(true);
    // Its own undo step (nothing else merged into it).
    expect(s.store.undoLabel()).toBe('Record audio');

    // Saved: recording a performance works again.
    await s.togglePerformance();
    expect(s.recordingPerformance).toBe(true);
    await s.togglePerformance();
    s.stop();
  });
});

describe('Stopping a take early', () => {
  it('keeps everything up to the moment of stopping, even just after the downbeat', async () => {
    const s = await started();
    fakeMic(s);
    const c = controller(s, 4);
    // A large Recording offset makes the take's shift easy to see (over 0.3 s in all).
    c.setOffset(300);
    expect(await c.open()).toBe(true);
    const lat = c.latency().totalMs / 1000;
    expect(lat).toBeGreaterThanOrEqual(0.3);

    const takeFor = async (seconds: number) => {
      const p = c.record('t8');
      await until(() => c.state.getState().take !== null, 'the take');
      const downbeat = s.sequencer!.timeAt(c.state.getState().take!.startTick);
      await until(() => s.ctx!.currentTime >= downbeat + seconds, `${seconds} s into the take`, 6000);
      const stoppedAt = s.ctx!.currentTime;
      c.stopTake('button');
      const r = await p;
      s.stop();
      return { r, played: stoppedAt - downbeat };
    };

    // 0.3 s in (less than the latency): the player has played 0.3 s, and that is kept.
    const short = await takeFor(0.3);
    expect(short.r.ok, short.r.message).toBe(true);
    let meta = s.store.getState().samples.at(-1)!;
    created.push(meta.id);
    expect(Math.abs(meta.duration - short.played)).toBeLessThan(0.03);

    // 1 s in: all of that second, not a second minus the latency.
    const long = await takeFor(1);
    expect(long.r.ok, long.r.message).toBe(true);
    expect(long.r.message).toMatch(/^Stopped early\./);
    meta = s.store.getState().samples.at(-1)!;
    created.push(meta.id);
    expect(Math.abs(meta.duration - long.played)).toBeLessThan(0.03);
  });
});
