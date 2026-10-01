/**
 * Recording audio in real Chromium: the "microphone" is a MediaStream made
 * by the session's own AudioContext (MediaStreamAudioDestinationNode), so
 * what goes in is known exactly. A take records N bars from a downbeat in
 * time with the transport, is shifted by the latency estimate plus the
 * user's offset, becomes a stored WAV recording on the part with a clip that
 * plays it from the downbeat (one undo step), and every way it can end
 * (early stop, unplug, tempo change, a performance take, a refused or
 * missing input, full storage) leaves a clear message and no leftovers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_INPUT_SETTINGS_KEY,
  AudioInputController,
  INPUT_DENIED_MESSAGE,
  INPUT_ENDED_MESSAGE,
  INPUT_NONE_MESSAGE,
  INPUT_UNSUPPORTED_MESSAGE,
} from '../../src/app/audioInput';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session, sampleStorageMessage } from '../../src/app/session';
import type { MeterFrame } from '../../src/audio/contracts';
import { OUTPUT_CEILING } from '../../src/audio/contracts';
import * as db from '../../src/persistence/db';
import { createProject } from '../../src/project/factory';
import type { SamplerInstrument } from '../../src/project/types';
import { defaultUiState, selectSlot, uiStore } from '../../src/state/uiStore';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

let sessions: Session[] = [];
let inputs: AudioInputController[] = [];
const created: string[] = [];

/** A session at `bpm` (200 BPM: one bar = 1.2 s, one beat = 0.3 s) with sound running. */
async function started(bpm = 200): Promise<Session> {
  const s = new Session(createProject({ name: 'Record test', bpm, now: 1 }));
  sessions.push(s);
  expect(await s.startAudio()).toBe(true);
  return s;
}

function controller(s: Session, opts: { bars?: 1 | 2 | 4; countIn?: boolean } = {}): AudioInputController {
  const c = new AudioInputController(s);
  inputs.push(c);
  c.setBars(opts.bars ?? 1);
  c.setCountIn(opts.countIn ?? false);
  return c;
}

interface FakeMic {
  /** Streams handed out by getUserMedia. */
  streams: MediaStream[];
  dest: MediaStreamAudioDestinationNode;
}

/**
 * getUserMedia hands out streams of a destination node in the session's
 * context; `feed` connects what the "microphone" plays into it.
 */
function fakeMic(s: Session, feed?: (ctx: AudioContext, into: AudioNode) => void): FakeMic {
  const ctx = s.ctx as AudioContext;
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 1;
  feed?.(ctx, dest);
  const mic: FakeMic = { streams: [], dest };
  vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async (c) => {
    const audio = (c as MediaStreamConstraints).audio as MediaTrackConstraints;
    // The app asks for the raw sound: no echo cancellation, noise suppression or automatic level.
    expect(audio).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    const stream = new MediaStream(dest.stream.getAudioTracks().map((t) => t.clone()));
    mic.streams.push(stream);
    return stream;
  });
  vi.spyOn(navigator.mediaDevices, 'enumerateDevices').mockResolvedValue([{ deviceId: 'mic-1', groupId: 'g', kind: 'audioinput', label: 'Test microphone', toJSON: () => ({}) } as MediaDeviceInfo]);
  return mic;
}

function sine(amp: number, hz = 440) {
  return (ctx: AudioContext, into: AudioNode) => {
    const osc = new OscillatorNode(ctx, { frequency: hz });
    const g = new GainNode(ctx, { gain: amp });
    osc.connect(g).connect(into);
    osc.start();
  };
}

const t8 = (s: Session) => s.store.getState().tracks.find((t) => t.id === 't8')!;

async function decodeStored(s: Session, id: string): Promise<Float32Array> {
  const rec = await db.getSample(id);
  expect(rec).not.toBeNull();
  const buf = await s.ctx!.decodeAudioData(await rec!.blob.arrayBuffer());
  return buf.getChannelData(0);
}

/** Frames where an impulse starts (|x| over half scale after a quiet stretch). */
function impulses(x: Float32Array): number[] {
  const out: number[] = [];
  let quietUntil = 0;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) > 0.5 && i >= quietUntil) {
      out.push(i);
      quietUntil = i + 200;
    }
  }
  return out;
}

beforeEach(() => {
  localStorage.removeItem(AUDIO_INPUT_SETTINGS_KEY);
  uiStore.setState({ ...defaultUiState() });
  patchRuntime({ muteAll: false, stalled: null, playing: false, paused: false, mode: 'live', replayId: null, recording: 'off', recordTarget: null, countingIn: false, held: {}, notice: null, tracks: {} });
});

afterEach(async () => {
  for (const c of inputs) c.dispose();
  inputs = [];
  vi.restoreAllMocks();
  for (const s of sessions) s.dispose();
  sessions = [];
  for (const id of created.splice(0)) await db.deleteSample(id).catch(() => undefined);
  localStorage.removeItem(AUDIO_INPUT_SETTINGS_KEY);
  patchRuntime({ muteAll: false, playing: false, paused: false, recording: 'off', recordTarget: null, held: {}, notice: null, tracks: {} });
});

describe('Opening the input', () => {
  it('opens the chosen input with the raw sound, lists the devices and shows a live level', async () => {
    const s = await started();
    fakeMic(s, sine(0.5));
    const c = controller(s);
    expect(c.state.getState().status).toBe('off');
    expect(await c.open()).toBe(true);
    const st = c.state.getState();
    expect(st.status).toBe('open');
    expect(st.devices).toEqual([{ id: 'mic-1', label: 'Test microphone' }]);
    await sleep(150);
    expect(c.readLevel()).toBeGreaterThan(0.4);
    expect(c.readLevel()).toBeLessThan(0.6);
    const lat = c.latency();
    expect(lat.totalMs).toBe(lat.outputMs + lat.inputMs);
    expect(lat.outputMs).toBeGreaterThan(0);
    c.setOffset(12);
    expect(c.latency().totalMs).toBe(lat.totalMs + 12);
    expect(JSON.parse(localStorage.getItem(AUDIO_INPUT_SETTINGS_KEY)!).offsetMs).toBe(12);
  });

  it('a refused microphone, a missing one and a browser without input explain themselves; nothing changes', async () => {
    const s = await started();
    const before = s.store.getState();
    const c = controller(s);
    const gum = vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    expect(await c.open()).toBe(false);
    expect(c.state.getState()).toMatchObject({ status: 'denied', message: INPUT_DENIED_MESSAGE });
    const r = await c.record('t8');
    expect(r).toEqual({ ok: false, message: INPUT_DENIED_MESSAGE });
    expect(c.state.getState().result).toMatchObject({ trackId: 't8', ok: false, message: INPUT_DENIED_MESSAGE });
    gum.mockRejectedValue(Object.assign(new Error('none'), { name: 'NotFoundError' }));
    expect(await c.open()).toBe(false);
    expect(c.state.getState()).toMatchObject({ status: 'nodevice', message: INPUT_NONE_MESSAGE });
    expect(s.store.getState()).toBe(before);
    expect(runtimeStore.getState().playing).toBe(false);

    const md = Object.getOwnPropertyDescriptor(Navigator.prototype, 'mediaDevices')!;
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    try {
      expect(c.unavailableReason()).toBe(INPUT_UNSUPPORTED_MESSAGE);
      expect(await c.open()).toBe(false);
      expect(c.state.getState()).toMatchObject({ status: 'unsupported', message: INPUT_UNSUPPORTED_MESSAGE });
    } finally {
      delete (navigator as { mediaDevices?: unknown }).mediaDevices;
      expect(Object.getOwnPropertyDescriptor(Navigator.prototype, 'mediaDevices')).toEqual(md);
    }
  });
});

describe('Recording a take', () => {
  it('records the bars from the downbeat; the take becomes the part’s recording with a clip, in one undo step', async () => {
    const s = await started();
    fakeMic(s, sine(0.5));
    const c = controller(s, { bars: 1, countIn: false });
    selectSlot('t8', 1);
    const before = s.store.getState();
    const res = await c.record('t8');
    expect(res.ok, res.message).toBe(true);
    expect(res.message).toMatch(/^Recorded “Recording 1” \(1\.2 s, 1 bar\): its clip on Sampler · .* plays it from the downbeat\. Undo removes it\.$/);
    const p = s.store.getState();
    expect(p.samples).toHaveLength(1);
    const meta = p.samples[0];
    created.push(meta.id);
    expect(meta).toMatchObject({ name: 'Recording 1', mime: 'audio/wav', channels: 1 });
    expect(meta.duration).toBeCloseTo(1.2, 2);
    const inst = t8(s).instrument as SamplerInstrument;
    expect(inst.sampleId).toBe(meta.id);
    expect(inst.params).toMatchObject({ start: 0, end: 1, mode: 0, sync: 0, originalBpm: 200, pitch: 0 });
    const clip = t8(s).clips[1]!;
    expect(clip.bars).toBe(1);
    expect(clip.notes).toEqual([expect.objectContaining({ tick: 0, pitch: inst.params.rootNote, velocity: 1, duration: 384 })]);
    // Stored like an import: the WAV in IndexedDB holds the sine, at the level it came in.
    const x = await decodeStored(s, meta.id);
    expect(Math.abs(x.length - s.ctx!.sampleRate * 1.2)).toBeLessThanOrEqual(1);
    let sum = 0;
    for (let i = 2000; i < x.length - 2000; i++) sum += x[i] * x[i];
    expect(Math.sqrt(sum / (x.length - 4000))).toBeCloseTo(0.5 / Math.SQRT2, 2);
    // Its clip plays right away at the next bar (the transport kept running).
    await until(() => runtimeStore.getState().tracks.t8?.playingSlot === 1 || runtimeStore.getState().tracks.t8?.queued?.slot === 1, 'the new clip to be launched');
    expect(c.state.getState().take).toBeNull();
    // One undo step removes all of it.
    s.undo();
    expect(s.store.getState().samples).toEqual(before.samples);
    expect(t8(s).instrument).toEqual(before.tracks.find((t) => t.id === 't8')!.instrument);
    expect(t8(s).clips[1]).toEqual(before.tracks.find((t) => t.id === 't8')!.clips[1]);
    s.redo();
    expect((t8(s).instrument as SamplerInstrument).sampleId).toBe(meta.id);
    s.stop();
  });

  it('lines the take up with the beat: the latency estimate and the Recording offset move it by exactly that much', async () => {
    const s = await started();
    const sr = s.ctx!.sampleRate;
    const beat = 0.3 * sr;
    // A real input never stops sending; a near-silent hum keeps this one streaming the same way.
    const mic = fakeMic(s, (ctx, into) => {
      const hum = new ConstantSourceNode(ctx, { offset: 1e-4 });
      hum.connect(into);
      hum.start();
    });
    const c = controller(s, { bars: 1, countIn: true });
    await c.open();
    // A player who plays every beat exactly in time with what they hear, through a device
    // 30 ms slower than the app's estimate (a click per beat, into the "microphone").
    const playAlong = (deviceDelay: number) => {
      const take = c.state.getState().take!;
      const imp = s.ctx!.createBuffer(1, 8, sr);
      imp.getChannelData(0).fill(0.9);
      for (let k = 0; k < 4; k++) {
        const src = new AudioBufferSourceNode(s.ctx!, { buffer: imp });
        src.connect(mic.dest);
        src.start(s.sequencer!.timeAt(take.startTick + k * 96) + deviceDelay);
      }
    };
    const estimate = c.latency().totalMs / 1000;
    const takeOnce = async (): Promise<number[]> => {
      const p = c.record('t8');
      await until(() => c.state.getState().take !== null, 'the take to start');
      playAlong(estimate + 0.03);
      const res = await p;
      expect(res.ok, res.message).toBe(true);
      const id = (t8(s).instrument as SamplerInstrument).sampleId!;
      created.push(id);
      s.stop();
      const x = await decodeStored(s, id);
      return impulses(x);
    };
    const first = await takeOnce();
    expect(first).toHaveLength(4);
    // In time with the transport: one beat apart, to the sample.
    for (let k = 1; k < 4; k++) expect(Math.abs(first[k] - first[k - 1] - beat)).toBeLessThanOrEqual(1);
    // Late by the device's extra delay (plus the stream's own small delay).
    const lateMs = (first[0] / sr) * 1000;
    expect(lateMs).toBeGreaterThanOrEqual(29);
    expect(lateMs).toBeLessThan(80);
    // The user sets the offset to (just under) what they hear: the next take starts on the beat,
    // moved earlier by exactly the offset (the stream's own delay may wobble by a fraction of a ms).
    const offset = Math.floor(lateMs) - 2;
    c.setOffset(offset);
    const second = await takeOnce();
    expect(second).toHaveLength(4);
    const nowMs = (second[0] / sr) * 1000;
    expect(Math.abs(lateMs - offset - nowMs)).toBeLessThan(1);
    expect(nowMs).toBeLessThan(4);
    for (let k = 1; k < 4; k++) expect(Math.abs(second[k] - second[k - 1] - beat)).toBeLessThanOrEqual(1);
  });

  it('with the count-in, playback starts a bar early and the take starts on bar 1; while playing, at the next bar', async () => {
    const s = await started();
    fakeMic(s, sine(0.3));
    const c = controller(s, { bars: 1, countIn: true });
    const p = c.record('t8');
    await until(() => c.state.getState().take !== null, 'the take');
    expect(c.state.getState().take).toMatchObject({ trackId: 't8', startTick: 0, endTick: 384, phase: 'waiting' });
    expect(runtimeStore.getState().countingIn).toBe(true);
    expect(s.transport!.getPosition().tick).toBeLessThan(0);
    await until(() => c.state.getState().take?.phase === 'recording', 'recording to begin', 3000);
    expect(s.transport!.getPosition().tick).toBeGreaterThanOrEqual(-8);
    const r1 = await p;
    expect(r1.ok, r1.message).toBe(true);
    created.push((t8(s).instrument as SamplerInstrument).sampleId!);
    // Playing now: the next take waits for the next bar line (no count-in).
    c.setCountIn(false);
    const tick = s.transport!.getPosition().tick;
    const p2 = c.record('t8');
    await until(() => c.state.getState().take !== null, 'the second take');
    const take = c.state.getState().take!;
    expect(take.startTick % 384).toBe(0);
    expect(take.startTick).toBeGreaterThan(tick);
    const r2 = await p2;
    expect(r2.ok, r2.message).toBe(true);
    created.push((t8(s).instrument as SamplerInstrument).sampleId!);
    expect(s.store.getState().samples.map((x) => x.name)).toEqual(['Recording 1', 'Recording 2']);
    s.stop();
  });

  it('stopping before the downbeat keeps nothing; stopping (or Stop, or unplugging) during the take keeps what was recorded', async () => {
    const s = await started();
    const mic = fakeMic(s, sine(0.4));
    const c = controller(s, { bars: 4, countIn: true });
    const before = s.store.getState();
    // Before the downbeat: nothing.
    const p0 = c.record('t8');
    await until(() => c.state.getState().take !== null, 'the take');
    c.stopTake('button');
    expect(await p0).toEqual({ ok: false, message: 'Stopped before the recording began: nothing was kept.' });
    expect(s.store.getState()).toBe(before);
    s.stop();
    // Stop during the take: kept, 2 bars (about 1.5 s recorded).
    const p1 = c.record('t8');
    await until(() => c.state.getState().take?.phase === 'recording', 'recording', 3000);
    await sleep(1500);
    s.stop();
    const r1 = await p1;
    expect(r1.ok, r1.message).toBe(true);
    expect(r1.message).toMatch(/^Stopped early\. Recorded “Recording 1” \(1\.\d s, 2 bars\)/);
    const meta = s.store.getState().samples[0];
    created.push(meta.id);
    expect(meta.duration).toBeGreaterThan(1.3);
    expect(meta.duration).toBeLessThan(1.8);
    expect(t8(s).clips.find((cl) => cl?.name === 'Recording 1')?.bars).toBe(2);
    // The input unplugged during a take: kept, and the input says what happened.
    const p2 = c.record('t8');
    await until(() => c.state.getState().take?.phase === 'recording', 'recording again', 3000);
    await sleep(600);
    const track = mic.streams.at(-1)!.getAudioTracks()[0];
    track.dispatchEvent(new Event('ended'));
    const r2 = await p2;
    expect(r2.ok, r2.message).toBe(true);
    created.push((t8(s).instrument as SamplerInstrument).sampleId!);
    expect(c.state.getState()).toMatchObject({ status: 'off', message: INPUT_ENDED_MESSAGE });
    // Every track the app opened is stopped.
    for (const st of mic.streams) for (const t of st.getTracks()) expect(t.readyState).toBe('ended');
    s.stop();
  });

  it('a tempo change or a performance take cancels a take; during a performance take Record audio is refused', async () => {
    const s = await started();
    fakeMic(s, sine(0.3));
    const c = controller(s, { bars: 2, countIn: true });
    const before = s.store.getState();
    const p = c.record('t8');
    await until(() => c.state.getState().take !== null, 'the take');
    s.setBpm(150);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/tempo changed while recording/);
    expect(s.store.getState().samples).toEqual(before.samples);
    s.stop();

    const p2 = c.record('t8');
    await until(() => c.state.getState().take !== null, 'the take');
    await s.togglePerformance();
    const r2 = await p2;
    expect(r2.ok).toBe(false);
    expect(r2.message).toMatch(/A performance take started/);
    // During the take: refused, and the project stays as it is.
    const r3 = await c.record('t8');
    expect(r3).toEqual({ ok: false, message: 'Recording audio is not available while a performance records. Stop that take first.' });
    s.stop();
    expect(s.store.getState().samples).toEqual(before.samples);
  });

  it('full browser storage: the take is not kept and the message says what to do', async () => {
    const s = await started();
    fakeMic(s, sine(0.3));
    const c = controller(s, { bars: 1 });
    const before = s.store.getState();
    vi.spyOn(s, 'storeSample').mockResolvedValue({ ok: false, message: sampleStorageMessage(new db.StorageError('quota', 'Browser storage is full.')) });
    const r = await c.record('t8');
    expect(r).toEqual({ ok: false, message: 'Browser storage is full, so the recording could not be kept. Delete old projects or export and remove recordings.' });
    expect(s.store.getState().samples).toEqual(before.samples);
    expect(t8(s).clips).toEqual(before.tracks.find((t) => t.id === 't8')!.clips);
    s.stop();
  });
});

describe('Monitoring', () => {
  it('is off by default; on, the input is heard through the output limiter; Mute All silences it', async () => {
    const s = await started();
    fakeMic(s, sine(3)); // far too loud
    const c = controller(s);
    await c.open();
    const frame: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
    const peak = async () => {
      let p = 0;
      for (let i = 0; i < 8; i++) {
        await sleep(30);
        s.readMeters(frame);
        p = Math.max(p, frame.masterPeakL, frame.masterPeakR);
      }
      return p;
    };
    expect(c.state.getState().monitor).toBe(false);
    expect(await peak()).toBeLessThan(0.01);
    c.setMonitor(true);
    await sleep(100);
    const on = await peak();
    expect(on).toBeGreaterThan(0.5);
    expect(on).toBeLessThanOrEqual(OUTPUT_CEILING + 1e-3);
    s.setMuteAll(true);
    await sleep(100);
    expect(await peak()).toBeLessThan(0.01);
    s.setMuteAll(false);
    await sleep(100);
    expect(await peak()).toBeGreaterThan(0.5);
    c.setMonitor(false);
    await sleep(150);
    expect(await peak()).toBeLessThan(0.01);
    // Closing turns monitoring off too.
    c.setMonitor(true);
    c.close();
    expect(c.state.getState()).toMatchObject({ status: 'off', monitor: false });
  });
});
