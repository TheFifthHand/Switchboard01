/**
 * MIDI keyboards and controllers (Web MIDI API).
 *
 * - Connect asks the browser for MIDI access (only from a click). On later
 *   visits it reconnects by itself, but only when the user connected before
 *   and the browser says the permission is already granted.
 * - Every input plays "the selected part" (default) or a fixed part. Notes go
 *   through session.noteOn / noteOff with source 'midi', so Musical Assist,
 *   the arpeggiator, Record Notes and Record Performance treat them exactly
 *   like the computer keyboard. Drum parts follow the General MIDI drum map.
 * - Sustain pedal (CC 64) holds notes until it is let go of. Pitch bend bends
 *   the part (±2 semitones by default, up to ±12). The mod wheel (CC 1) moves
 *   the part's Motion macro (recorded like a knob).
 * - MIDI learn maps a knob, fader or wheel to one of the selected part's six
 *   macros, its volume, the master volume or the tempo. Mappings, routes and
 *   the bend range belong to this browser's setup (localStorage), not to the
 *   project.
 * - No stuck notes: unplugging a device, window blur, Stop, Pause, Mute All
 *   (everything that releases all notes in the session) and changing the
 *   selected part let go of the keys (and pedal-held notes) concerned.
 *
 * The audio clock is not involved here: a message plays when it arrives,
 * exactly like a key press on the computer keyboard.
 */
import { moduleId } from '../project/factory';
import { BPM_SPEC, CHANNEL_PARAMS, MASTER_VOLUME_SPEC, specById } from '../project/params';
import { MACRO_IDS, type Id, type MacroId, type Project } from '../project/types';
import { createStore, type Store } from '../state/store';
import { uiStore } from '../state/uiStore';
import { faderValue } from '../ui/components/Fader';
import { MACRO_SPECS } from './macros';
import { notify } from './runtime';
import type { NoteSource } from './session';

/* ------------------------------------------------------------------ */
/* Web MIDI surfaces (the browser's, or test doubles)                  */
/* ------------------------------------------------------------------ */

export interface MidiMessageLike {
  data: Uint8Array | null;
}

export interface MidiInputLike {
  readonly id: string;
  readonly name: string | null;
  readonly manufacturer?: string | null;
  readonly state: string;
  onmidimessage: ((e: MidiMessageLike) => void) | null;
}

export interface MidiAccessLike {
  readonly inputs: { forEach(cb: (input: MidiInputLike) => void): void };
  onstatechange: ((e: { port?: { id: string; type: string; state: string } | null }) => void) | null;
}

export type MidiPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

/** What the controller needs from the browser (navigator by default; tests pass doubles). */
export interface MidiEnvironment {
  /** null: this browser has no Web MIDI. */
  requestAccess: (() => Promise<MidiAccessLike>) | null;
  /** False on a page that is not a secure context (Web MIDI is unavailable there). */
  secure: boolean;
  permission(): Promise<MidiPermission>;
  /** Has the page had a click or key press yet (browsers only start sound after one)? */
  hasUserActivation(): boolean;
}

export function browserMidiEnvironment(): MidiEnvironment {
  const nav = globalThis.navigator as (Navigator & { requestMIDIAccess?: (o?: { sysex?: boolean }) => Promise<unknown> }) | undefined;
  const request = nav && typeof nav.requestMIDIAccess === 'function' ? nav.requestMIDIAccess.bind(nav) : null;
  return {
    requestAccess: request ? async () => (await request({ sysex: false })) as MidiAccessLike : null,
    secure: globalThis.isSecureContext !== false,
    async permission() {
      try {
        const st = await nav?.permissions?.query({ name: 'midi' as PermissionName });
        return st?.state ?? 'unknown';
      } catch {
        return 'unknown';
      }
    },
    hasUserActivation: () => (nav as Navigator & { userActivation?: { hasBeenActive: boolean } })?.userActivation?.hasBeenActive ?? true,
  };
}

/* ------------------------------------------------------------------ */
/* Settings (this browser's setup)                                     */
/* ------------------------------------------------------------------ */

/** Which part an input plays: the part selected on screen, or a fixed part. */
export type MidiRoute = 'selected' | Id;

export type LearnTarget = { kind: 'macro'; macro: MacroId } | { kind: 'volume' } | { kind: 'master' } | { kind: 'tempo' };

export interface MidiMapping {
  id: string;
  /** Input the control is on, and its name when it was learned (shown in the list). */
  inputId: string;
  inputName: string;
  /** 0-15 (shown as 1-16). */
  channel: number;
  cc: number;
  target: LearnTarget;
}

export interface MidiSettings {
  /** The user connected MIDI before: reconnect on later visits if the permission is granted. */
  remember: boolean;
  /** Pitch bend range in semitones (1-12). */
  bendRange: number;
  routes: Record<string, MidiRoute>;
  mappings: MidiMapping[];
}

export const MIDI_SETTINGS_KEY = 'switchboard01.midi';
export const DEFAULT_BEND_RANGE = 2;
export const MAX_BEND_RANGE = 12;
/** Controls MIDI learn leaves alone: sustain pedal, channel mode messages. */
const UNLEARNABLE = new Set([64, 120, 121, 122, 123, 124, 125, 126, 127]);
/** Tempo from a control: one BPM per step from 60 (0) to 187 (127). */
export const TEMPO_CC_BASE = 60;

function defaultSettings(): MidiSettings {
  return { remember: false, bendRange: DEFAULT_BEND_RANGE, routes: {}, mappings: [] };
}

function validTarget(t: unknown): t is LearnTarget {
  if (!t || typeof t !== 'object') return false;
  const k = (t as { kind?: unknown }).kind;
  if (k === 'macro') return MACRO_IDS.includes((t as { macro?: unknown }).macro as MacroId);
  return k === 'volume' || k === 'master' || k === 'tempo';
}

export function readMidiSettings(storage: Pick<Storage, 'getItem'> | null | undefined = globalThis.localStorage): MidiSettings {
  const out = defaultSettings();
  try {
    const raw = storage?.getItem(MIDI_SETTINGS_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object') return out;
    const o = v as Record<string, unknown>;
    out.remember = o.remember === true;
    if (typeof o.bendRange === 'number' && Number.isInteger(o.bendRange) && o.bendRange >= 1 && o.bendRange <= MAX_BEND_RANGE) out.bendRange = o.bendRange;
    if (o.routes && typeof o.routes === 'object') {
      for (const [k, r] of Object.entries(o.routes as Record<string, unknown>)) if (typeof r === 'string' && r) out.routes[k] = r;
    }
    if (Array.isArray(o.mappings)) {
      for (const m of o.mappings.slice(0, 128)) {
        if (!m || typeof m !== 'object') continue;
        const x = m as Record<string, unknown>;
        if (typeof x.id !== 'string' || typeof x.inputId !== 'string' || typeof x.channel !== 'number' || typeof x.cc !== 'number' || !validTarget(x.target)) continue;
        if (!Number.isInteger(x.channel) || x.channel < 0 || x.channel > 15 || !Number.isInteger(x.cc) || x.cc < 0 || x.cc > 127) continue;
        out.mappings.push({ id: x.id, inputId: x.inputId, inputName: typeof x.inputName === 'string' ? x.inputName : '', channel: x.channel, cc: x.cc, target: x.target });
      }
    }
  } catch {
    /* storage unavailable or damaged: defaults */
  }
  return out;
}

function writeMidiSettings(s: MidiSettings): void {
  try {
    globalThis.localStorage?.setItem(MIDI_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* not remembered */
  }
}

/* ------------------------------------------------------------------ */
/* Plain words                                                         */
/* ------------------------------------------------------------------ */

const LEVEL_SPEC = specById(CHANNEL_PARAMS, 'level')!;

export function learnTargetName(t: LearnTarget): string {
  switch (t.kind) {
    case 'macro':
      return `${MACRO_SPECS[t.macro].label} (selected part)`;
    case 'volume':
      return 'Volume (selected part)';
    case 'master':
      return 'Master volume';
    case 'tempo':
      return 'Tempo';
  }
}

export function learnTargetKey(t: LearnTarget): string {
  return t.kind === 'macro' ? `macro:${t.macro}` : t.kind;
}

export function learnTargetFromKey(key: string): LearnTarget | null {
  if (key.startsWith('macro:')) {
    const macro = key.slice(6) as MacroId;
    return MACRO_IDS.includes(macro) ? { kind: 'macro', macro } : null;
  }
  return key === 'volume' || key === 'master' || key === 'tempo' ? { kind: key } : null;
}

export const LEARN_TARGETS: readonly LearnTarget[] = [...MACRO_IDS.map((macro) => ({ kind: 'macro', macro }) as LearnTarget), { kind: 'volume' }, { kind: 'master' }, { kind: 'tempo' }];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function midiNoteName(n: number): string {
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/**
 * General MIDI drum notes to the kit's pads (0 Kick … 15 Snap FX). Notes
 * outside the map wrap onto the 16 pads from C1 up, so every key plays a pad.
 */
const GM_DRUMS: Readonly<Record<number, number>> = {
  35: 1, 36: 0, 37: 7, 38: 2, 39: 3, 40: 2, 41: 8, 42: 4, 43: 8, 44: 6, 45: 9, 46: 5, 47: 9, 48: 10, 49: 12, 50: 10, 51: 13,
  52: 12, 53: 13, 54: 14, 55: 12, 56: 11, 57: 12, 58: 15, 59: 13, 60: 14, 61: 14, 62: 14, 63: 14, 64: 14, 69: 6, 70: 6, 75: 7, 76: 7, 77: 7,
};
export function drumPadForNote(note: number): number {
  return GM_DRUMS[note] ?? ((((note - 36) % 16) + 16) % 16);
}

/* ------------------------------------------------------------------ */
/* Controller                                                          */
/* ------------------------------------------------------------------ */

/** What the controller drives: the Session (structurally), or a test double. */
export interface MidiSessionApi {
  readonly store: { getState(): Project };
  readonly engine: unknown;
  noteOn(trackId: Id, pitch: number, velocity: number, source: NoteSource): void;
  noteOff(trackId: Id, pitch: number, source: NoteSource): void;
  setPitchBend(trackId: Id, cents: number): void;
  setMacro(trackId: Id, macro: MacroId, value: number, gesture?: string): void;
  setModuleParam(moduleId: Id, param: string, value: number, gesture?: string): void;
  setMasterVolume(db: number, gesture?: string): void;
  setBpm(bpm: number, gesture?: string): void;
  onAllNotesReleased(fn: () => void): () => void;
}

export type MidiStatus = 'off' | 'requesting' | 'connected' | 'denied' | 'unsupported' | 'error';

export interface MidiInputInfo {
  id: string;
  name: string;
}

export interface MidiState {
  status: MidiStatus;
  /** What the user should know about the status, in words (null when all is well). */
  message: string | null;
  inputs: MidiInputInfo[];
  /** MIDI learn is waiting for a control to move. */
  learning: LearnTarget | null;
  /** The last mapping learned (the dialog confirms it). */
  learned: MidiMapping | null;
  settings: MidiSettings;
}

interface Sounding {
  trackId: Id;
  /** Pitch handed to the session (drum pad index on drum parts). */
  pitch: number;
  /** Routed through "the selected part" (released when the selection changes). */
  viaSelected: boolean;
  /** Keys holding it: `${input}:${channel}:${note}`. */
  keys: Set<string>;
  /** Sustain pedals holding it after its keys were let go of: `${input}:${channel}`. */
  pedals: Set<string>;
}

interface Wheel {
  trackId: Id;
  /** Wheel position, -1..1 (0 = centre). */
  norm: number;
  viaSelected: boolean;
}

/** One undo step per control movement (all controls moved together count as one): a pause this long starts the next one. */
const GESTURE_IDLE_MS = 600;
/** How long an activity light stays lit after a message. */
export const ACTIVITY_MS = 140;

export const MIDI_UNSUPPORTED_MESSAGE = 'This browser cannot use MIDI keyboards. Chrome or Edge on a computer can; your computer keyboard and the on-screen keys still play.';
export const MIDI_INSECURE_MESSAGE = 'MIDI only works when the app is opened from its own launcher (http://127.0.0.1…) or a secure https address.';
export const MIDI_DENIED_MESSAGE = 'MIDI access was blocked. Allow MIDI devices for this page in the browser’s site settings (the icon left of the address), then press Connect MIDI again.';
/** Any other failure to start MIDI (the browser's own error text means nothing to most people). */
export const MIDI_FAILED_MESSAGE = 'Omni Song can’t reach MIDI on this computer. Check the keyboard is plugged in, use Chrome or Edge, then press Connect MIDI again.';
export const MIDI_SOUND_OFF_MESSAGE = 'Your MIDI keyboard is connected. Click anywhere in the app once (or press Play) to turn the sound on; then it plays.';

export class MidiController {
  readonly state: Store<MidiState>;
  private access: MidiAccessLike | null = null;
  private attached = new Map<string, MidiInputLike>();
  private sounding = new Map<string, Sounding>();
  /** Key held → its sounding entry key. */
  private pressed = new Map<string, string>();
  /** Sustain pedals down: `${input}:${channel}`. */
  private pedals = new Set<string>();
  /** Pitch wheel per `${input}:${channel}`. */
  private wheels = new Map<string, Wheel>();
  private activity = new Map<string, number>();
  private lastActivityAt = -Infinity;
  /** The undo gesture shared by every control moving now (see gesture()). */
  private openGesture: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private gestureSeq = 0;
  private soundOffNoticeShown = false;
  private unsubs: (() => void)[] = [];
  private connectJob: Promise<boolean> | null = null;
  private autoTried = false;

  constructor(
    private readonly session: MidiSessionApi,
    private readonly env: () => MidiEnvironment = browserMidiEnvironment,
  ) {
    this.state = createStore<MidiState>({ status: 'off', message: null, inputs: [], learning: null, learned: null, settings: readMidiSettings() });
    this.unsubs.push(
      session.onAllNotesReleased(() => this.forgetHeld()),
      uiStore.subscribe((s, prev) => {
        if (s.selectedTrackId !== prev.selectedTrackId) this.selectionChanged(prev.selectedTrackId, s.selectedTrackId);
      }),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Connecting                                                        */
  /* ---------------------------------------------------------------- */

  /** Is Web MIDI available here at all (null: yes; else why not, in words)? */
  unavailableReason(): string | null {
    const env = this.env();
    if (!env.secure) return MIDI_INSECURE_MESSAGE;
    if (!env.requestAccess) return MIDI_UNSUPPORTED_MESSAGE;
    return null;
  }

  /** Connect MIDI (call it from a click: the browser may ask for permission). */
  connect(): Promise<boolean> {
    if (this.access) return Promise.resolve(true);
    if (this.connectJob) return this.connectJob;
    const env = this.env();
    const why = this.unavailableReason();
    if (why) {
      this.patch({ status: 'unsupported', message: why });
      return Promise.resolve(false);
    }
    this.patch({ status: 'requesting', message: null });
    this.connectJob = (async () => {
      try {
        const access = await env.requestAccess!();
        this.attach(access);
        this.saveSettings({ ...this.state.getState().settings, remember: true });
        return true;
      } catch (e) {
        const name = (e as { name?: string } | null)?.name ?? '';
        if (name === 'SecurityError' || name === 'NotAllowedError') this.patch({ status: 'denied', message: MIDI_DENIED_MESSAGE });
        else this.patch({ status: 'error', message: MIDI_FAILED_MESSAGE });
        return false;
      } finally {
        this.connectJob = null;
      }
    })();
    return this.connectJob;
  }

  /**
   * On a later visit: reconnect without asking, but only when the user
   * connected before and the browser reports the permission as granted.
   */
  async autoConnect(): Promise<boolean> {
    if (this.autoTried || this.access) return !!this.access;
    this.autoTried = true;
    if (!this.state.getState().settings.remember || this.unavailableReason()) return false;
    if ((await this.env().permission()) !== 'granted') return false;
    return this.connect();
  }

  /** Stop using MIDI: every key is let go of, and it does not reconnect by itself next time. */
  disconnect(): void {
    this.releaseEverything();
    for (const input of this.attached.values()) input.onmidimessage = null;
    this.attached.clear();
    if (this.access) this.access.onstatechange = null;
    this.access = null;
    this.saveSettings({ ...this.state.getState().settings, remember: false });
    this.patch({ status: 'off', message: null, inputs: [], learning: null });
  }

  private attach(access: MidiAccessLike): void {
    this.access = access;
    access.onstatechange = (e) => {
      const port = e?.port;
      if (port && port.type === 'input' && port.state !== 'connected') this.releaseInput(port.id);
      this.syncInputs();
    };
    this.syncInputs();
    this.patch({ status: 'connected', message: null });
  }

  /** Listen to every connected input; forget unplugged ones (their keys are let go of). */
  private syncInputs(): void {
    const access = this.access;
    if (!access) return;
    const seen = new Set<string>();
    const list: MidiInputInfo[] = [];
    access.inputs.forEach((input) => {
      if (input.state !== 'connected') return;
      seen.add(input.id);
      list.push({ id: input.id, name: (input.name ?? '').trim() || 'MIDI input' });
      // Setting the handler (again, after a re-plug) opens the port.
      const handler = (e: MidiMessageLike) => this.handleMessage(input.id, e.data);
      input.onmidimessage = handler;
      this.attached.set(input.id, input);
    });
    for (const [id, input] of [...this.attached]) {
      if (seen.has(id)) continue;
      this.releaseInput(id);
      input.onmidimessage = null;
      this.attached.delete(id);
    }
    this.patch({ inputs: list });
  }

  /* ---------------------------------------------------------------- */
  /* Settings                                                          */
  /* ---------------------------------------------------------------- */

  routeOf(inputId: string): MidiRoute {
    const r = this.state.getState().settings.routes[inputId] ?? 'selected';
    return r === 'selected' || this.session.store.getState().tracks.some((t) => t.id === r) ? r : 'selected';
  }

  /** Which part an input plays. Its keys still down are let go of first. */
  setRoute(inputId: string, route: MidiRoute): void {
    this.releaseInput(inputId);
    const s = this.state.getState().settings;
    const routes = { ...s.routes };
    if (route === 'selected') delete routes[inputId];
    else routes[inputId] = route;
    this.saveSettings({ ...s, routes });
  }

  setBendRange(semitones: number): void {
    const n = Math.max(1, Math.min(MAX_BEND_RANGE, Math.round(semitones)));
    this.saveSettings({ ...this.state.getState().settings, bendRange: n });
    // A wheel held off-centre follows the new range at once.
    for (const w of this.wheels.values()) this.session.setPitchBend(w.trackId, this.cents(w.norm));
  }

  startLearn(target: LearnTarget): void {
    this.patch({ learning: target, learned: null });
  }

  cancelLearn(): void {
    if (this.state.getState().learning) this.patch({ learning: null });
  }

  removeMapping(id: string): void {
    const s = this.state.getState().settings;
    this.saveSettings({ ...s, mappings: s.mappings.filter((m) => m.id !== id) });
    if (this.state.getState().learned?.id === id) this.patch({ learned: null });
  }

  private saveSettings(settings: MidiSettings): void {
    this.patch({ settings });
    writeMidiSettings(settings);
  }

  private patch(p: Partial<MidiState>): void {
    this.state.setState((s) => ({ ...s, ...p }));
  }

  /* ---------------------------------------------------------------- */
  /* Activity (for lights, read in animation frames)                   */
  /* ---------------------------------------------------------------- */

  /** performance.now() of the last message from this input (or any input). */
  lastActivity(inputId?: string): number {
    return inputId === undefined ? this.lastActivityAt : (this.activity.get(inputId) ?? -Infinity);
  }

  /* ---------------------------------------------------------------- */
  /* Messages                                                          */
  /* ---------------------------------------------------------------- */

  /** Handle one MIDI message from an input (public for tests and the browser's handler). */
  handleMessage(inputId: string, data: Uint8Array | readonly number[] | null | undefined): void {
    if (!data || data.length === 0) return;
    const status = data[0];
    // System messages (clock, active sensing, sysex) carry no notes or controls here.
    if (status < 0x80 || status >= 0xf0) return;
    const now = performance.now();
    this.activity.set(inputId, now);
    this.lastActivityAt = now;
    const type = status & 0xf0;
    const ch = status & 0x0f;
    const d1 = (data[1] ?? 0) & 0x7f;
    const d2 = (data[2] ?? 0) & 0x7f;
    switch (type) {
      case 0x90:
        if (d2 > 0) this.noteOn(inputId, ch, d1, d2);
        else this.noteOff(inputId, ch, d1);
        break;
      case 0x80:
        this.noteOff(inputId, ch, d1);
        break;
      case 0xb0:
        this.control(inputId, ch, d1, d2);
        break;
      case 0xe0:
        this.bend(inputId, ch, d1 | (d2 << 7));
        break;
      default:
        break;
    }
  }

  private targetTrack(inputId: string): { trackId: Id; viaSelected: boolean } | null {
    const route = this.routeOf(inputId);
    const trackId = route === 'selected' ? uiStore.getState().selectedTrackId : route;
    return this.session.store.getState().tracks.some((t) => t.id === trackId) ? { trackId, viaSelected: route === 'selected' } : null;
  }

  /** Sound only starts after a click or key press on the page: say so once instead of starting a muted context. */
  private canPlay(): boolean {
    if (this.session.engine || this.env().hasUserActivation()) return true;
    if (!this.soundOffNoticeShown) {
      this.soundOffNoticeShown = true;
      notify(MIDI_SOUND_OFF_MESSAGE, 'info');
    }
    return false;
  }

  private noteOn(inputId: string, ch: number, note: number, vel: number): void {
    const keyId = `${inputId}:${ch}:${note}`;
    const target = this.targetTrack(inputId);
    const play = target !== null && this.canPlay();
    const track = target ? this.session.store.getState().tracks.find((t) => t.id === target.trackId) : undefined;
    const pitch = track?.instrument.kind === 'drums' ? drumPadForNote(note) : note;
    const sKey = play && target ? `${target.trackId}:${pitch}` : null;
    // A second note-on without a note-off between: the earlier press ends (on the same note the session retriggers it).
    const prevKey = this.pressed.get(keyId);
    if (prevKey !== undefined) {
      const prev = this.dropKey(keyId);
      if (prev && prevKey !== sKey && prev.keys.size === 0) this.endSounding(prevKey, prev);
    }
    if (!sKey || !target) return;
    let s = this.sounding.get(sKey);
    if (!s) {
      s = { trackId: target.trackId, pitch, viaSelected: target.viaSelected, keys: new Set(), pedals: new Set() };
      this.sounding.set(sKey, s);
    }
    s.keys.add(keyId);
    // Struck again: the key holds it now, not the pedal.
    s.pedals.clear();
    this.pressed.set(keyId, sKey);
    this.session.noteOn(target.trackId, pitch, vel / 127, 'midi');
  }

  /** A key let go of: its note ends, unless another key or this input's sustain pedal still holds it. */
  private noteOff(inputId: string, ch: number, note: number): void {
    const keyId = `${inputId}:${ch}:${note}`;
    const sKey = this.pressed.get(keyId);
    if (sKey === undefined) return;
    const s = this.dropKey(keyId);
    if (!s || s.keys.size > 0) return;
    const pedal = `${inputId}:${ch}`;
    if (this.pedals.has(pedal)) {
      s.pedals.add(pedal);
      return;
    }
    if (s.pedals.size === 0) this.endSounding(sKey, s);
  }

  /** Forget a key press (its note is not ended here). */
  private dropKey(keyId: string): Sounding | undefined {
    const sKey = this.pressed.get(keyId);
    this.pressed.delete(keyId);
    const s = sKey === undefined ? undefined : this.sounding.get(sKey);
    s?.keys.delete(keyId);
    return s;
  }

  private endSounding(sKey: string, s: Sounding): void {
    this.sounding.delete(sKey);
    for (const k of s.keys) this.pressed.delete(k);
    this.session.noteOff(s.trackId, s.pitch, 'midi');
  }

  private control(inputId: string, ch: number, cc: number, value: number): void {
    const st = this.state.getState();
    if (st.learning && !UNLEARNABLE.has(cc)) {
      this.learn(st.learning, inputId, ch, cc);
      return;
    }
    if (cc === 64) {
      this.sustain(inputId, ch, value >= 64);
      return;
    }
    if (cc === 120 || cc === 123) {
      // All Sound Off / All Notes Off from the device.
      this.releaseInput(inputId, ch);
      return;
    }
    if (cc === 121) {
      // Reset All Controllers: pedal up, wheel centred.
      this.sustain(inputId, ch, false);
      this.bend(inputId, ch, 8192);
      return;
    }
    const mapping = st.settings.mappings.find((m) => m.cc === cc && m.channel === ch && m.inputId === inputId);
    if (mapping) {
      this.applyMapping(mapping, value);
      return;
    }
    if (cc === 1) {
      const target = this.targetTrack(inputId);
      if (target) this.session.setMacro(target.trackId, 'motion', value / 127, this.gesture());
    }
  }

  private learn(target: LearnTarget, inputId: string, ch: number, cc: number): void {
    const s = this.state.getState().settings;
    const name = this.state.getState().inputs.find((i) => i.id === inputId)?.name ?? 'MIDI input';
    this.gestureSeq += 1;
    const mapping: MidiMapping = { id: `map_${Date.now().toString(36)}_${this.gestureSeq}`, inputId, inputName: name, channel: ch, cc, target };
    // One control drives one thing: a control learned again replaces its old mapping.
    const mappings = [...s.mappings.filter((m) => !(m.inputId === inputId && m.channel === ch && m.cc === cc)), mapping];
    this.saveSettings({ ...s, mappings });
    this.patch({ learning: null, learned: mapping });
  }

  private applyMapping(m: MidiMapping, value: number): void {
    const x = value / 127;
    const selected = uiStore.getState().selectedTrackId;
    const t = m.target;
    switch (t.kind) {
      case 'macro':
        this.session.setMacro(selected, t.macro, x, this.gesture());
        break;
      case 'volume':
        this.session.setModuleParam(moduleId.channel(selected), 'level', faderValue(LEVEL_SPEC, x), this.gesture());
        break;
      case 'master':
        this.session.setMasterVolume(faderValue(MASTER_VOLUME_SPEC, x), this.gesture());
        break;
      case 'tempo':
        this.session.setBpm(Math.max(BPM_SPEC.min, Math.min(BPM_SPEC.max, TEMPO_CC_BASE + value)), this.gesture());
        break;
    }
  }

  private sustain(inputId: string, ch: number, down: boolean): void {
    const pedal = `${inputId}:${ch}`;
    if (down) {
      this.pedals.add(pedal);
      return;
    }
    if (!this.pedals.delete(pedal)) return;
    for (const [sKey, s] of [...this.sounding]) {
      if (!s.pedals.delete(pedal)) continue;
      if (s.keys.size === 0 && s.pedals.size === 0) this.endSounding(sKey, s);
    }
  }

  private bend(inputId: string, ch: number, value14: number): void {
    const wheelKey = `${inputId}:${ch}`;
    const norm = value14 >= 8192 ? (value14 - 8192) / 8191 : (value14 - 8192) / 8192;
    const target = this.targetTrack(inputId);
    const was = this.wheels.get(wheelKey);
    if (was && was.trackId !== target?.trackId) this.session.setPitchBend(was.trackId, 0);
    if (!target) {
      this.wheels.delete(wheelKey);
      return;
    }
    if (norm === 0) this.wheels.delete(wheelKey);
    else this.wheels.set(wheelKey, { trackId: target.trackId, norm, viaSelected: target.viaSelected });
    this.session.setPitchBend(target.trackId, this.cents(norm));
  }

  /** Bend in cents for a wheel position, with the chosen range. */
  private cents(norm: number): number {
    return Math.round(norm * this.state.getState().settings.bendRange * 100 * 100) / 100;
  }

  /**
   * The undo gesture for a control movement. Every control moving at the same
   * time shares one gesture (the store merges only into the step still open,
   * so one gesture per control would make a step per message when two move
   * together, and push older edits out of the history). It ends after a pause
   * of GESTURE_IDLE_MS with no control moving.
   */
  private gesture(): string {
    if (this.openGesture) clearTimeout(this.openGesture.timer);
    else this.gestureSeq += 1;
    const id = this.openGesture?.id ?? `midi:controls:${this.gestureSeq}`;
    const timer = setTimeout(() => {
      if (this.openGesture?.id === id) this.openGesture = null;
    }, GESTURE_IDLE_MS);
    this.openGesture = { id, timer };
    return id;
  }

  /* ---------------------------------------------------------------- */
  /* Letting go                                                        */
  /* ---------------------------------------------------------------- */

  /** Every key, pedal-held note and pitch bend of one input (or one channel of it) ends now. */
  private releaseInput(inputId: string, ch?: number): void {
    const mine = (key: string) => (ch === undefined ? key.startsWith(`${inputId}:`) : key === `${inputId}:${ch}` || key.startsWith(`${inputId}:${ch}:`));
    for (const k of [...this.pressed.keys()]) if (mine(k)) this.dropKey(k);
    for (const p of [...this.pedals]) if (mine(p)) this.pedals.delete(p);
    for (const [sKey, s] of [...this.sounding]) {
      for (const p of [...s.pedals]) if (mine(p)) s.pedals.delete(p);
      if (s.keys.size === 0 && s.pedals.size === 0) this.endSounding(sKey, s);
    }
    for (const [wk, w] of [...this.wheels]) {
      if (!mine(wk)) continue;
      this.wheels.delete(wk);
      this.session.setPitchBend(w.trackId, 0);
    }
  }

  /** Let go of everything from MIDI now (keys, pedal-held notes, bends). */
  releaseEverything(): void {
    for (const [sKey, s] of [...this.sounding]) this.endSounding(sKey, s);
    this.pressed.clear();
    this.centreWheels();
  }

  /** The session let go of every note itself (Stop, Pause, Mute All, blur…): forget them, centre the bends. */
  private forgetHeld(): void {
    this.sounding.clear();
    this.pressed.clear();
    this.centreWheels();
  }

  private centreWheels(): void {
    const parts = new Set([...this.wheels.values()].map((w) => w.trackId));
    this.wheels.clear();
    for (const t of parts) this.session.setPitchBend(t, 0);
  }

  /** The selected part changed: what "the selected part" inputs held on the old one ends; their wheel moves over. */
  private selectionChanged(from: Id, to: Id): void {
    for (const [sKey, s] of [...this.sounding]) if (s.viaSelected && s.trackId === from) this.endSounding(sKey, s);
    for (const w of this.wheels.values()) {
      if (!w.viaSelected || w.trackId !== from) continue;
      this.session.setPitchBend(from, 0);
      w.trackId = to;
      this.session.setPitchBend(to, this.cents(w.norm));
    }
  }

  /** Notes MIDI holds right now (for tests and diagnostics). */
  heldCount(): number {
    return this.sounding.size;
  }

  dispose(): void {
    this.disconnectSilently();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.openGesture) clearTimeout(this.openGesture.timer);
    this.openGesture = null;
  }

  private disconnectSilently(): void {
    this.releaseEverything();
    for (const input of this.attached.values()) input.onmidimessage = null;
    this.attached.clear();
    if (this.access) this.access.onstatechange = null;
    this.access = null;
  }
}
