/**
 * Recording from a microphone or an instrument plugged into the computer
 * (getUserMedia), in time with the transport.
 *
 * - The input opens only from a click (the browser asks for permission then),
 *   with echo cancellation, noise suppression and automatic gain off, so an
 *   instrument is recorded as it sounds. Everything stays on this device.
 * - An input level meter, the device choice, mono or stereo, optional
 *   monitoring (off by default: speakers can howl) and a user "Recording
 *   offset" live in the MIDI & audio dialog; they are remembered in this
 *   browser (monitoring always starts off).
 * - Record audio (sampler editor): an optional one-bar count-in, then N bars
 *   from a downbeat. The capture window is set on the audio clock, in an
 *   AudioWorklet that copies exactly those frames (a one-second ring buffer
 *   means a window that starts a moment before its message arrives is still
 *   complete). It is shifted by the known output + input latency (the
 *   context's baseLatency and outputLatency, the limiter's look-ahead, the
 *   track's reported input latency) plus the user's offset, so the take lines
 *   up with what the player heard.
 * - The take becomes a WAV recording stored like an import (same limits and
 *   messages), put on the part with a clip that plays it from the downbeat:
 *   one undo step (cmd.addRecordedTake).
 * - Stop, Pause, Mute All or the input going away end a take early and keep
 *   what was recorded; a tempo change, a performance take or Record Notes
 *   starting cancel it (it could not stay in time or would mix into their
 *   undo step). Recording audio is unavailable during a performance take.
 */
import { audioBufferFromChannels } from '../audio/instruments/sampleBank';
import { LIMITER_PROCESSOR_NAME, engineLatencyFrames, limiterProcessorOptions } from '../audio/worklets/limiter';
import { encodeMadeAudio } from '../persistence/audioImport';
import * as db from '../persistence/db';
import { TICKS_PER_BAR, type ClipBars, type Id } from '../project/types';
import * as cmd from '../state/commands';
import { createStore, type Store } from '../state/store';
import { selectSlot, slotFor, uiStore } from '../state/uiStore';
import { nextBarTick } from '../time/sequencer';
import { notify, runtimeStore, type RuntimeState } from './runtime';
import type { Session } from './session';

/* ------------------------------------------------------------------ */
/* Recorder worklet                                                    */
/* ------------------------------------------------------------------ */

export const RECORDER_PROCESSOR_NAME = 'omni-input-recorder';

/** Frames per message from the recorder (~170 ms at 48 kHz). */
const CHUNK_FRAMES = 8192;

const RECORDER_SOURCE = /* js */ `
class OmniInputRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.max(4096, Math.round(sampleRate));
    this.ring = [new Float32Array(this.size), new Float32Array(this.size)];
    this.ringEnd = 0;
    this.from = -1;
    this.to = -1;
    this.cursor = -1;
    this.channels = 1;
    this.chunk = null;
    this.chunkStart = 0;
    this.fill = 0;
    this.alive = true;
    this.port.onmessage = (e) => this.onMessage(e.data || {});
  }
  onMessage(m) {
    if (m.type === 'window') {
      this.from = m.from;
      this.to = m.to;
      this.cursor = m.from;
      this.channels = m.channels === 2 ? 2 : 1;
      this.chunk = null;
      this.fill = 0;
    } else if (m.type === 'end') {
      if (this.from >= 0) this.to = Math.max(this.from, Math.min(this.to, m.at));
    } else if (m.type === 'cancel' || m.type === 'dispose') {
      this.from = this.to = this.cursor = -1;
      this.chunk = null;
      this.fill = 0;
      // Disposed: the processor stops, so the node can be collected.
      if (m.type === 'dispose') this.alive = false;
    }
  }
  flush() {
    if (this.chunk && this.fill > 0) {
      const out = this.chunk.map((c) => c.slice(0, this.fill));
      this.port.postMessage({ type: 'chunk', frame: this.chunkStart, channels: out }, out.map((c) => c.buffer));
    }
    this.chunk = null;
    this.fill = 0;
  }
  process(inputs) {
    if (!this.alive) return false;
    const input = inputs[0] || [];
    const n = (input[0] && input[0].length) || 128;
    const start = currentFrame;
    for (let c = 0; c < 2; c++) {
      const src = input.length ? input[Math.min(c, input.length - 1)] : null;
      const ring = this.ring[c];
      for (let i = 0; i < n; i++) ring[(start + i) % this.size] = src ? src[i] : 0;
    }
    this.ringEnd = start + n;
    if (this.from < 0) return true;
    // Frames older than the ring are gone (they stay silent in the take).
    if (this.cursor < this.ringEnd - this.size) this.cursor = this.ringEnd - this.size;
    const until = Math.min(this.ringEnd, this.to);
    while (this.cursor < until) {
      if (!this.chunk) {
        this.chunk = [];
        for (let c = 0; c < this.channels; c++) this.chunk.push(new Float32Array(${CHUNK_FRAMES}));
        this.chunkStart = this.cursor;
        this.fill = 0;
      }
      const take = Math.min(until - this.cursor, ${CHUNK_FRAMES} - this.fill);
      for (let c = 0; c < this.channels; c++) {
        const ring = this.ring[c];
        const dst = this.chunk[c];
        for (let i = 0; i < take; i++) dst[this.fill + i] = ring[(this.cursor + i) % this.size];
      }
      this.fill += take;
      this.cursor += take;
      if (this.fill === ${CHUNK_FRAMES}) this.flush();
    }
    if (this.cursor >= this.to) {
      this.flush();
      this.port.postMessage({ type: 'done', frame: this.to });
      this.from = this.to = this.cursor = -1;
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(RECORDER_PROCESSOR_NAME)}, OmniInputRecorder);
`;

const recorderModules = new WeakMap<BaseAudioContext, Promise<void>>();

function loadRecorder(ctx: BaseAudioContext): Promise<void> {
  let job = recorderModules.get(ctx);
  if (!job) {
    const url = URL.createObjectURL(new Blob([RECORDER_SOURCE], { type: 'text/javascript' }));
    job = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    job.catch(() => recorderModules.delete(ctx));
    recorderModules.set(ctx, job);
  }
  return job;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

export type InputStatus = 'off' | 'requesting' | 'open' | 'denied' | 'unsupported' | 'nodevice' | 'error';
export type RecordBars = 1 | 2 | 4;
export const RECORD_BAR_CHOICES: readonly RecordBars[] = [1, 2, 4];

export interface InputDevice {
  id: string;
  label: string;
}

export interface TakeInfo {
  trackId: Id;
  bars: number;
  /** Transport ticks: the take runs from the downbeat at startTick to endTick. */
  startTick: number;
  endTick: number;
  /** waiting: count-in / before its downbeat; recording; saving: being stored. */
  phase: 'waiting' | 'recording' | 'saving';
}

export interface AudioInputState {
  status: InputStatus;
  /** What the user should know (why the input is off, a problem), in words. */
  message: string | null;
  devices: InputDevice[];
  /** The device in use, or the one chosen for next time. */
  deviceId: string | null;
  deviceLabel: string | null;
  channels: 1 | 2;
  /** Hear the input through the speakers or headphones. Always starts off. */
  monitor: boolean;
  /** User correction added to the measured delay (ms; more = the take moves earlier). */
  offsetMs: number;
  bars: RecordBars;
  countIn: boolean;
  take: TakeInfo | null;
  /** The last take's result, for the sampler editor. */
  result: { trackId: Id; ok: boolean; message: string } | null;
}

export const AUDIO_INPUT_SETTINGS_KEY = 'switchboard01.audioInput';
export const OFFSET_RANGE_MS = { min: -200, max: 300 } as const;

interface Persisted {
  deviceId: string | null;
  channels: 1 | 2;
  offsetMs: number;
  bars: RecordBars;
  countIn: boolean;
}

function readPersisted(): Persisted {
  const out: Persisted = { deviceId: null, channels: 1, offsetMs: 0, bars: 4, countIn: true };
  try {
    const raw = globalThis.localStorage?.getItem(AUDIO_INPUT_SETTINGS_KEY);
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    if (!v || typeof v !== 'object') return out;
    if (typeof v.deviceId === 'string' && v.deviceId) out.deviceId = v.deviceId;
    if (v.channels === 2) out.channels = 2;
    if (typeof v.offsetMs === 'number' && Number.isFinite(v.offsetMs)) out.offsetMs = Math.max(OFFSET_RANGE_MS.min, Math.min(OFFSET_RANGE_MS.max, Math.round(v.offsetMs)));
    if (RECORD_BAR_CHOICES.includes(v.bars as RecordBars)) out.bars = v.bars as RecordBars;
    if (typeof v.countIn === 'boolean') out.countIn = v.countIn;
  } catch {
    /* defaults */
  }
  return out;
}

export const INPUT_UNSUPPORTED_MESSAGE = 'This browser cannot record from a microphone or instrument here. Use current Chrome or Edge, opened from the app’s launcher.';
export const INPUT_INSECURE_MESSAGE = 'Recording needs the app opened from its own launcher (http://127.0.0.1…) or a secure https address.';
export const INPUT_DENIED_MESSAGE = 'Microphone access was blocked. Allow the microphone for this page in the browser’s site settings (the icon left of the address), then press Use input again.';
export const INPUT_NONE_MESSAGE = 'No microphone or audio input was found. Plug one in (or switch it on), then press Use input again.';
export const INPUT_BUSY_MESSAGE = 'The input is busy or not working: another app may be using it. Close that app or choose another input.';
export const INPUT_ENDED_MESSAGE = 'The input stopped: it was unplugged or switched off. Plug it back in and press Use input.';
export const MONITOR_WARNING = 'Use headphones: with speakers, hearing the input can howl (feedback).';

/** Seconds of setup before a take's first downbeat when playback is already running. */
const SETUP_SECONDS = 0.3;
/** A take shorter than this (seconds) is not kept. */
const MIN_TAKE_SECONDS = 0.25;
/** Below about -66 dBFS a take counts as silent (the message says to check the input). */
const SILENT_PEAK = 5e-4;

/** What the controller needs from the session (the app's Session, or one a test made). */
export type InputSession = Pick<
  Session,
  'ctx' | 'engine' | 'bank' | 'transport' | 'sequencer' | 'store' | 'startAudio' | 'startPlaybackForRecording' | 'storeSample' | 'pressClip'
>;

export type RecordResult = { ok: boolean; message: string };

interface ActiveTake {
  info: TakeInfo;
  /** The project the take belongs to: it is never put into another one. */
  projectId: Id;
  from: number;
  to: number;
  sampleRate: number;
  channels: 1 | 2;
  data: Float32Array[];
  received: number;
  bpm: number;
  startTime: number;
  resolve: (r: RecordResult) => void;
  unsubs: (() => void)[];
  timers: ReturnType<typeof setTimeout>[];
  stopping: boolean;
  /** Being stored: it can no longer be stopped or cancelled. */
  finishing: boolean;
}

/* ------------------------------------------------------------------ */
/* Controller                                                          */
/* ------------------------------------------------------------------ */

export class AudioInputController {
  readonly state: Store<AudioInputState>;
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuf: Float32Array<ArrayBuffer> | null = null;
  private recorder: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private monitorNodes: { gain: GainNode; limiter: AudioNode | null; out: AudioNode } | null = null;
  private openJob: Promise<boolean> | null = null;
  private take: ActiveTake | null = null;
  /** A Record audio press is opening the input / starting playback (a second press waits for it). */
  private starting = false;
  private deviceListener: (() => void) | null = null;
  private unsubs: (() => void)[] = [];

  constructor(private readonly session: InputSession) {
    const p = readPersisted();
    this.state = createStore<AudioInputState>({
      status: 'off',
      message: null,
      devices: [],
      deviceId: p.deviceId,
      deviceLabel: null,
      channels: p.channels,
      monitor: false,
      offsetMs: p.offsetMs,
      bars: p.bars,
      countIn: p.countIn,
      take: null,
      result: null,
    });
    this.unsubs.push(
      // Mute All silences monitoring too.
      runtimeStore.subscribe((s, prev) => {
        if (s.muteAll !== prev.muteAll) this.updateMonitor();
      }),
      // A take's result belongs to the project it happened in.
      session.store.subscribe((p, prev) => {
        if (p.id !== prev.id && this.state.getState().result) this.patch({ result: null });
      }),
    );
  }

  private patch(p: Partial<AudioInputState>): void {
    this.state.setState((s) => ({ ...s, ...p }));
  }

  private persist(): void {
    const s = this.state.getState();
    try {
      globalThis.localStorage?.setItem(AUDIO_INPUT_SETTINGS_KEY, JSON.stringify({ deviceId: s.deviceId, channels: s.channels, offsetMs: s.offsetMs, bars: s.bars, countIn: s.countIn } satisfies Persisted));
    } catch {
      /* not remembered */
    }
  }

  get isOpen(): boolean {
    return this.state.getState().status === 'open';
  }

  /** Why recording from an input cannot work in this browser (null: it can). */
  unavailableReason(): string | null {
    if (globalThis.isSecureContext === false) return INPUT_INSECURE_MESSAGE;
    if (typeof globalThis.navigator?.mediaDevices?.getUserMedia !== 'function') return INPUT_UNSUPPORTED_MESSAGE;
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Opening and closing the input                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Open an input (the chosen one by default). Call it from a click: the
   * browser asks for permission the first time. Audio starts too.
   */
  open(deviceId: string | null = this.state.getState().deviceId): Promise<boolean> {
    if (this.openJob) return this.openJob;
    const why = this.unavailableReason();
    if (why) {
      this.patch({ status: 'unsupported', message: why });
      return Promise.resolve(false);
    }
    this.openJob = this.doOpen(deviceId).finally(() => {
      this.openJob = null;
    });
    return this.openJob;
  }

  private async doOpen(deviceId: string | null): Promise<boolean> {
    const wasOpen = this.isOpen;
    this.patch({ status: 'requesting', message: null });
    // Sound starts inside the same click (the input feeds the app's audio context).
    if (!(await this.session.startAudio()) || !this.session.ctx) {
      this.patch({ status: 'error', message: 'Sound could not start, so the input cannot be used. Press Resume audio or reload the page.' });
      return false;
    }
    const ctx = this.session.ctx;
    const channels = this.state.getState().channels;
    const constraints = (id: string | null): MediaStreamConstraints => ({
      audio: {
        ...(id ? { deviceId: { exact: id } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: channels },
      },
      video: false,
    });
    let stream: MediaStream;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
      } catch (e) {
        const name = (e as { name?: string } | null)?.name;
        // The chosen device is gone: use the default one.
        if (!deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw e;
        stream = await navigator.mediaDevices.getUserMedia(constraints(null));
      }
    } catch (e) {
      const name = (e as { name?: string } | null)?.name ?? '';
      if (wasOpen) this.teardown();
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') this.patch({ status: 'denied', message: INPUT_DENIED_MESSAGE });
      else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') this.patch({ status: 'nodevice', message: INPUT_NONE_MESSAGE });
      else if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') this.patch({ status: 'error', message: INPUT_BUSY_MESSAGE });
      else this.patch({ status: 'error', message: `The input could not be opened: ${e instanceof Error ? e.message : String(e)}` });
      return false;
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      for (const t of stream.getTracks()) t.stop();
      if (wasOpen) this.teardown();
      this.patch({ status: 'nodevice', message: INPUT_NONE_MESSAGE });
      return false;
    }
    try {
      await loadRecorder(ctx);
    } catch (e) {
      for (const t of stream.getTracks()) t.stop();
      if (wasOpen) this.teardown();
      this.patch({ status: 'error', message: `The recorder could not start: ${e instanceof Error ? e.message : String(e)}` });
      return false;
    }
    // A take running on the previous input ends here, keeping what it has.
    if (this.take) this.stopTake('input');
    this.teardown();
    this.stream = stream;
    this.track = track;
    track.addEventListener('ended', this.onTrackEnded);
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const recorder = new AudioWorkletNode(ctx, RECORDER_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: channels,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    recorder.port.onmessage = (e: MessageEvent) => this.onRecorderMessage(e.data);
    // The recorder is pulled by the graph through a silent gain.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(recorder);
    recorder.connect(sink);
    sink.connect(ctx.destination);
    this.source = source;
    this.analyser = analyser;
    this.levelBuf = new Float32Array(analyser.fftSize);
    this.recorder = recorder;
    this.sink = sink;
    if (!this.deviceListener && navigator.mediaDevices.addEventListener) {
      this.deviceListener = () => void this.refreshDevices();
      navigator.mediaDevices.addEventListener('devicechange', this.deviceListener);
    }
    const settings = track.getSettings();
    const id = settings.deviceId ?? deviceId;
    this.patch({ status: 'open', message: null, deviceId: id, deviceLabel: track.label || 'Audio input' });
    this.persist();
    await this.refreshDevices();
    // The name the device list uses for it (the same as the track's on real devices).
    const listed = this.state.getState().devices.find((d) => d.id === id)?.label;
    if (listed) this.patch({ deviceLabel: listed });
    this.updateMonitor();
    return true;
  }

  /** Turn the input off (the browser's recording indicator goes away). A take running ends and is kept. */
  close(): void {
    if (this.take) this.stopTake('input');
    this.teardown();
    if (this.deviceListener) {
      navigator.mediaDevices?.removeEventListener?.('devicechange', this.deviceListener);
      this.deviceListener = null;
    }
    this.patch({ status: 'off', message: null, monitor: false });
  }

  private teardown(): void {
    this.removeMonitor(true);
    this.track?.removeEventListener('ended', this.onTrackEnded);
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    if (this.recorder) {
      this.recorder.port.onmessage = null;
      this.recorder.port.postMessage({ type: 'dispose' });
    }
    for (const n of [this.source, this.analyser, this.recorder, this.sink]) {
      try {
        n?.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.stream = null;
    this.track = null;
    this.source = null;
    this.analyser = null;
    this.levelBuf = null;
    this.recorder = null;
    this.sink = null;
  }

  private onTrackEnded = (): void => {
    if (this.take) this.stopTake('input');
    this.teardown();
    this.patch({ status: 'off', message: INPUT_ENDED_MESSAGE, monitor: false });
    void this.refreshDevices();
  };

  /** The list of inputs (names appear once the browser allowed the microphone). */
  async refreshDevices(): Promise<void> {
    try {
      const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
      const inputs = all.filter((d) => d.kind === 'audioinput');
      this.patch({ devices: inputs.map((d, i) => ({ id: d.deviceId, label: d.label || `Input ${i + 1}` })) });
    } catch {
      /* the list stays as it was */
    }
  }

  /** Use another input (reopens it). */
  async setDevice(id: string): Promise<boolean> {
    this.patch({ deviceId: id });
    this.persist();
    return this.isOpen ? this.open(id) : true;
  }

  async setChannels(n: 1 | 2): Promise<void> {
    if (this.state.getState().channels === n) return;
    this.patch({ channels: n });
    this.persist();
    if (this.isOpen && !this.take) await this.open(this.state.getState().deviceId);
  }

  setOffset(ms: number): void {
    const v = Math.max(OFFSET_RANGE_MS.min, Math.min(OFFSET_RANGE_MS.max, Math.round(Number.isFinite(ms) ? ms : 0)));
    this.patch({ offsetMs: v });
    this.persist();
  }

  setBars(bars: RecordBars): void {
    if (!RECORD_BAR_CHOICES.includes(bars)) return;
    this.patch({ bars });
    this.persist();
  }

  setCountIn(on: boolean): void {
    this.patch({ countIn: on });
    this.persist();
  }

  /** Input peak level (linear) right now, for the meter. */
  readLevel(): number {
    const a = this.analyser;
    const buf = this.levelBuf;
    if (!a || !buf) return 0;
    a.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i]);
      if (v > peak) peak = v;
    }
    return peak;
  }

  /* ---------------------------------------------------------------- */
  /* Monitoring                                                        */
  /* ---------------------------------------------------------------- */

  setMonitor(on: boolean): void {
    this.patch({ monitor: on });
    this.updateMonitor();
  }

  /**
   * Monitoring plays the input into the app's final output stage (the
   * engine's safety clipper bounded to the -1 dBFS ceiling), through its own
   * look-ahead limiter. Mute All silences it.
   */
  private updateMonitor(): void {
    const want = this.state.getState().monitor && !!this.source && !runtimeStore.getState().muteAll;
    if (want && !this.monitorNodes) {
      const ctx = this.session.ctx!;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      let limiter: AudioNode | null = null;
      try {
        limiter = new AudioWorkletNode(ctx, LIMITER_PROCESSOR_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
          processorOptions: limiterProcessorOptions(false),
        });
      } catch {
        limiter = null;
      }
      const out = this.session.engine?.output ?? ctx.destination;
      this.source!.connect(gain);
      if (limiter) {
        gain.connect(limiter);
        limiter.connect(out);
      } else gain.connect(out);
      gain.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
      this.monitorNodes = { gain, limiter, out };
    } else if (!want && this.monitorNodes) {
      this.removeMonitor(runtimeStore.getState().muteAll);
    }
  }

  private removeMonitor(now: boolean): void {
    const m = this.monitorNodes;
    if (!m) return;
    this.monitorNodes = null;
    const drop = () => {
      for (const n of [m.gain, m.limiter]) {
        try {
          n?.disconnect();
        } catch {
          /* already gone */
        }
      }
      // The limiter's processor stops too, so nothing keeps running after monitoring ends.
      if (m.limiter instanceof AudioWorkletNode) m.limiter.port.postMessage('stop');
      try {
        this.source?.disconnect(m.gain);
      } catch {
        /* the source went first */
      }
    };
    const ctx = this.session.ctx;
    if (now || !ctx) {
      m.gain.gain.cancelScheduledValues(0);
      m.gain.gain.value = 0;
      drop();
      return;
    }
    // A short fade, then the nodes go.
    m.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.008);
    setTimeout(drop, 80);
  }

  /* ---------------------------------------------------------------- */
  /* Latency                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * How far a take is moved earlier, in ms: what the player hears comes out
   * of the speakers later than its audio-clock time (output), and what they
   * play reaches the app later again (input). The user's offset is added.
   */
  latency(): { outputMs: number; inputMs: number; offsetMs: number; totalMs: number } {
    const ctx = this.session.ctx;
    const offsetMs = this.state.getState().offsetMs;
    if (!ctx) return { outputMs: 0, inputMs: 0, offsetMs, totalMs: offsetMs };
    const out = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + engineLatencyFrames(ctx.sampleRate) / ctx.sampleRate;
    const reported = (this.track?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined)?.latency;
    const input = typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 ? reported : ctx.baseLatency || 0;
    const outputMs = Math.round(out * 1000);
    const inputMs = Math.round(input * 1000);
    return { outputMs, inputMs, offsetMs, totalMs: outputMs + inputMs + offsetMs };
  }

  /* ---------------------------------------------------------------- */
  /* Recording a take                                                  */
  /* ---------------------------------------------------------------- */

  /** Why Record audio cannot start on this part right now (null: it can). */
  blockedReason(trackId: Id, rt: Pick<RuntimeState, 'recording' | 'replayId' | 'mode' | 'playing' | 'paused'> = runtimeStore.getState()): string | null {
    if (this.take) return 'A recording is already running. Wait for it to finish.';
    if (rt.recording === 'performance') return 'Recording audio is not available while a performance records. Stop that take first.';
    if (rt.recording === 'notes') return 'Record Notes is on. Stop recording notes first, then record audio.';
    if (rt.replayId !== null) return 'A recorded performance is replaying. Stop it to record audio.';
    if ((rt.playing || rt.paused) && rt.mode === 'song') return 'The song is playing. Recording audio follows the live pads: stop the song first.';
    return null;
  }

  /**
   * Record a take of `bars` bars (state.bars) onto a sampler part. Opens the
   * input when needed (from this click), starts playback (with the one-bar
   * count-in when chosen and playback was stopped) and records from the
   * next downbeat. Resolves when the take is kept, cancelled or failed.
   */
  async record(trackId: Id): Promise<RecordResult> {
    const fail = (message: string, keepResult = true): RecordResult => {
      if (keepResult) this.patch({ result: { trackId, ok: false, message } });
      return { ok: false, message };
    };
    if (this.take || this.starting) return fail('A recording is already starting or running.', false);
    const blocked = this.blockedReason(trackId);
    if (blocked) return fail(blocked);
    const track = this.session.store.getState().tracks.find((t) => t.id === trackId);
    if (!track) return fail('That part no longer exists.');
    this.patch({ result: null });
    this.starting = true;
    try {
      return await this.startTake(trackId, fail);
    } finally {
      this.starting = false;
    }
  }

  private async startTake(trackId: Id, fail: (message: string) => RecordResult): Promise<RecordResult> {
    if (!this.isOpen && !(await this.open())) return fail(this.state.getState().message ?? 'The input could not be opened.');
    const s = this.session;
    const { bars, countIn, channels } = this.state.getState();
    const transport = s.transport;
    if (!transport || !s.sequencer || !s.ctx || !this.recorder) return fail('Sound is not running.');
    // The checks again: things may have changed while the input opened.
    const again = this.blockedReason(trackId);
    if (again) return fail(again);
    // Room in browser storage for the take (as WAV), checked before anything plays.
    const room = await storageRoom();
    const needed = 44 + ((bars * 4 * 60) / s.store.getState().bpm) * s.ctx.sampleRate * channels * 3;
    if (room !== null && room < needed * 1.5) return fail('Browser storage is almost full, so a take could not be kept. Delete old projects or export and remove recordings, then record again.');
    const fromStop = !transport.playing && !transport.paused;
    if (!(await s.startPlaybackForRecording(fromStop && countIn ? 1 : 0))) return fail('Recording audio follows the live pads. Stop the song or the replay first, then record.');
    const ctx = s.ctx;
    const seq = s.sequencer;
    let startTick: number;
    if (fromStop) startTick = 0;
    else {
      const soon = seq.tickAt(ctx.currentTime + SETUP_SECONDS);
      startTick = (soon <= 0 ? 0 : nextBarTick(soon)) + (countIn ? TICKS_PER_BAR : 0);
    }
    const endTick = startTick + bars * TICKS_PER_BAR;
    const lat = this.latency().totalMs / 1000;
    const sr = ctx.sampleRate;
    const startTime = seq.timeAt(startTick);
    const from = Math.round((startTime + lat) * sr);
    const to = Math.round((seq.timeAt(endTick) + lat) * sr);
    const info: TakeInfo = { trackId, bars, startTick, endTick, phase: 'waiting' };
    return new Promise<RecordResult>((resolve) => {
      const take: ActiveTake = {
        info,
        projectId: s.store.getState().id,
        from,
        to,
        sampleRate: sr,
        channels,
        data: Array.from({ length: channels }, () => new Float32Array(Math.max(1, to - from))),
        received: 0,
        bpm: s.store.getState().bpm,
        startTime,
        resolve,
        unsubs: [],
        timers: [],
        stopping: false,
        finishing: false,
      };
      this.take = take;
      this.recorder!.port.postMessage({ type: 'window', from, to, channels });
      this.patch({ take: info });
      // The phase word for the editor (display only: the worklet does the timing).
      take.timers.push(setTimeout(() => this.take === take && !take.stopping && this.patch({ take: { ...info, phase: 'recording' } }), Math.max(0, (startTime - ctx.currentTime) * 1000)));
      // If the audio clock stops (a suspended device), finish with what arrived.
      take.timers.push(setTimeout(() => void this.finish(take, take.received), Math.max(0, (to / sr - ctx.currentTime) * 1000) + 3000));
      take.unsubs.push(
        runtimeStore.subscribe((rt, prev) => {
          if (this.take !== take) return;
          if (rt.recording !== prev.recording && rt.recording !== 'off') {
            this.cancelTake(rt.recording === 'performance' ? 'A performance take started, so the audio recording was cancelled. Record audio before or after a take.' : 'Record Notes started, so the audio recording was cancelled.');
          } else if (!rt.playing || rt.mode !== 'live' || (rt.muteAll && !prev.muteAll)) {
            this.stopTake(rt.muteAll ? 'muted' : 'transport');
          }
        }),
        s.store.subscribe((p, prev) => {
          if (this.take === take && p.bpm !== prev.bpm) this.cancelTake('The tempo changed while recording, so the take could not stay in time. Nothing was kept: record again.');
          else if (this.take === take && p.id !== prev.id) this.cancelTake('Another project opened, so the recording was cancelled.');
        }),
      );
    });
  }

  /** Stop the take now: before its downbeat nothing is kept; after it, what was recorded so far is kept. */
  stopTake(why: 'button' | 'transport' | 'muted' | 'input' = 'button'): void {
    const take = this.take;
    const ctx = this.session.ctx;
    if (!take || take.stopping || take.finishing) return;
    const now = ctx ? Math.round(ctx.currentTime * take.sampleRate) : take.from;
    if (now <= take.from) {
      this.cancelTake(why === 'button' ? 'Stopped before the recording began: nothing was kept.' : why === 'input' ? INPUT_ENDED_MESSAGE : 'Playback stopped before the recording began: nothing was kept.');
      return;
    }
    take.stopping = true;
    // The input is going away: keep what already arrived. Otherwise the recorder sends the rest up to now.
    if (why === 'input' || !this.recorder) void this.finish(take, take.received);
    else this.recorder.port.postMessage({ type: 'end', at: now });
  }

  /** Cancel the take: nothing is kept. */
  cancelTake(message: string): void {
    const take = this.take;
    if (!take || take.finishing) return;
    this.recorder?.port.postMessage({ type: 'cancel' });
    this.stopWatching(take);
    this.take = null;
    this.patch({ take: null, result: { trackId: take.info.trackId, ok: false, message } });
    notify(message, 'warn');
    take.resolve({ ok: false, message });
  }

  private stopWatching(take: ActiveTake): void {
    for (const u of take.unsubs) u();
    for (const t of take.timers) clearTimeout(t);
    take.unsubs = [];
    take.timers = [];
  }

  private onRecorderMessage(msg: unknown): void {
    const take = this.take;
    if (!take || !msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; frame?: number; channels?: Float32Array[] };
    if (m.type === 'chunk' && Array.isArray(m.channels) && typeof m.frame === 'number') {
      const at = m.frame - take.from;
      for (let c = 0; c < take.data.length; c++) {
        const src = m.channels[c] ?? m.channels[0];
        if (!src || at >= take.data[c].length) continue;
        take.data[c].set(at < 0 ? src.subarray(-at) : src.subarray(0, take.data[c].length - at), Math.max(0, at));
      }
      take.received = Math.max(take.received, Math.min(take.to - take.from, at + (m.channels[0]?.length ?? 0)));
    } else if (m.type === 'done' && typeof m.frame === 'number') {
      void this.finish(take, Math.max(0, Math.min(take.to, m.frame) - take.from));
    }
  }

  /** The take is complete (or stopped early): store it and put it on the part. */
  private async finish(take: ActiveTake, frames: number): Promise<void> {
    if (this.take !== take || take.finishing) return;
    take.finishing = true;
    this.stopWatching(take);
    const { trackId } = take.info;
    let settled = false;
    const done = (r: RecordResult, tone: 'info' | 'warn' = r.ok ? 'info' : 'warn') => {
      if (settled) return;
      settled = true;
      if (this.take === take) this.take = null;
      this.patch({ take: null, result: { trackId, ok: r.ok, message: r.message } });
      notify(r.message, tone, r.ok ? 'undo' : undefined);
      take.resolve(r);
    };
    try {
      await this.keep(take, frames, done);
    } catch (e) {
      // Whatever went wrong, the take ends with a message and Record audio works again.
      done({ ok: false, message: `The recording could not be kept: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private async keep(take: ActiveTake, frames: number, done: (r: RecordResult, tone?: 'info' | 'warn') => void): Promise<void> {
    const { trackId } = take.info;
    const sr = take.sampleRate;
    if (frames < MIN_TAKE_SECONDS * sr) {
      done({ ok: false, message: 'The recording was too short to keep.' });
      return;
    }
    this.patch({ take: { ...take.info, phase: 'saving' } });
    const s = this.session;
    const channels = take.data.map((c) => c.subarray(0, frames));
    const barSeconds = (4 * 60) / take.bpm;
    const clipBars = Math.max(1, Math.min(take.info.bars, Math.ceil(frames / sr / barSeconds - 0.02))) as ClipBars;
    const name = nextRecordingName(s.store.getState().samples.map((x) => x.name));
    // Let the status repaint before the encoding work.
    await new Promise((r) => setTimeout(r, 0));
    const made = encodeMadeAudio(name, channels, sr);
    if (!made.ok) {
      done({ ok: false, message: made.message });
      return;
    }
    let peak = 0;
    for (const c of channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
    const stored = await s.storeSample(made.meta, made.blob, audioBufferFromChannels(channels, sr));
    if (!stored.ok) {
      done({ ok: false, message: stored.message });
      return;
    }
    if (s.store.getState().id !== take.projectId) {
      // Another project opened while the take was being stored.
      s.bank?.remove(made.meta.id);
      void db.deleteSample(made.meta.id).catch(() => undefined);
      done({ ok: false, message: 'Another project opened, so the recording was not kept.' });
      return;
    }
    const slot = chooseSlot(s, trackId);
    const p = s.store.getState();
    const replaced = p.tracks.find((t) => t.id === trackId)?.clips[slot] ?? null;
    const r = cmd.addRecordedTake(s.store, { trackId, meta: made.meta, slot, bars: clipBars, bpm: take.bpm, clipName: name });
    if (!r.changed) {
      s.bank?.remove(made.meta.id);
      void db.deleteSample(made.meta.id).catch(() => undefined);
      done({ ok: false, message: r.refused ?? r.message ?? 'The recording could not be put on the part.' });
      return;
    }
    selectSlot(trackId, slot);
    // Hear it back in time: its clip starts at the next bar while the pads play.
    const rt = runtimeStore.getState();
    if (rt.playing && rt.mode === 'live' && rt.tracks[trackId]?.playingSlot !== slot) void s.pressClip(trackId, slot);
    const after = s.store.getState();
    const partName = after.tracks.find((t) => t.id === trackId)?.name ?? 'the part';
    const where = `${partName} · ${after.scenes[slot]?.name ?? `row ${slot + 1}`}`;
    const seconds = frames / sr;
    let message = `Recorded “${name}” (${seconds.toFixed(1)} s, ${clipBars} bar${clipBars === 1 ? '' : 's'}): its clip on ${where} plays it from the downbeat${replaced ? `, replacing “${replaced.name}”` : ''}. Undo removes it.`;
    if (frames < take.to - take.from - sr * 0.05) message = `Stopped early. ${message}`;
    if (peak < SILENT_PEAK) message += ' The take is silent: check the input and its level in MIDI & audio.';
    done({ ok: true, message }, peak < SILENT_PEAK ? 'warn' : 'info');
  }

  dispose(): void {
    if (this.take) this.cancelTake('Recording cancelled.');
    this.close();
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }
}

/** Bytes browser storage still has room for (null: the browser does not say). */
async function storageRoom(): Promise<number | null> {
  const est = await db.storageEstimate();
  return est ? Math.max(0, est.quota - est.usage) : null;
}

/** "Recording 3": numbered after the recordings already in the project. */
export function nextRecordingName(existing: readonly string[]): string {
  let n = 0;
  for (const e of existing) {
    const m = /^Recording (\d+)$/.exec(e);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `Recording ${n + 1}`;
}

/** The part's selected clip slot when it is empty, else its first empty slot, else the selected one (replaced; Undo brings it back). */
function chooseSlot(s: InputSession, trackId: Id): number {
  const clips = s.store.getState().tracks.find((t) => t.id === trackId)?.clips ?? [];
  const selected = slotFor(uiStore.getState(), trackId);
  if (!clips[selected]) return selected;
  const empty = clips.findIndex((c) => !c);
  return empty >= 0 ? empty : selected;
}
