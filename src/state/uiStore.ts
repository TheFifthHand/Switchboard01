/**
 * UI-only state: what is selected and shown, never part of the Project and
 * never undoable. A few preferences (selected part, view, pad mode, octaves,
 * tips, guide progress, Simple/Advanced, the keyboard folded per view, Steps
 * follow, chord pads) are remembered in localStorage; unknown remembered keys
 * are ignored. Every storage access is guarded because it can be unavailable
 * or throw (private mode, quotas).
 */
import { cloneClip } from '../project/clone';
import { DRUM_VOICES, MAX_CLIP_BARS, MAX_SCENES, type Clip, type Id } from '../project/types';
import type { EffectChainClip } from './commands/patch';
import { createStore, type Store } from './store';

export type View = 'play' | 'shape' | 'arrange' | 'mix';
/** Simple shows the essentials (pads, big knobs, mute/solo, record, export); Advanced shows every control. */
export type UiMode = 'simple' | 'advanced';
export type PadMode = 'loops' | 'drums' | 'notes' | 'steps';
/** The step grid Steps shows: 16ths (default), 32nds, eighth-note triplets or 16th triplets. */
export type StepGrid = '1/16' | '1/32' | '1/8T' | '1/16T';
export const STEP_GRIDS: readonly StepGrid[] = ['1/16', '1/32', '1/8T', '1/16T'];

/** Chord pads in Notes: on/off and how many notes a chord has. */
export interface NotesChords {
  on: boolean;
  size: 3 | 4;
}

/** The song lane's zoom and scroll, kept per project for the session (shell-17). */
export interface LaneView {
  /** Zoom step index, or 'fit' (fitted when Arrange opens). */
  zoomStep: number | 'fit';
  /** Horizontal scroll, px. */
  scrollLeft: number;
}

export interface UiState {
  selectedTrackId: Id;
  view: View;
  padMode: PadMode;
  /** Clip slot being edited, per part. */
  selectedSlot: Record<Id, number>;
  /** Step editor page (bar), per part. */
  stepPage: Record<Id, number>;
  /** Drum voice whose steps are edited, per part. */
  selectedDrumVoice: Record<Id, number>;
  /** Octave of the leftmost key of the on-screen keyboard (4 = C4). */
  keyboardOctave: number;
  /** Octave of the bottom-left pad in Notes mode. */
  notesOctave: number;
  tipsEnabled: boolean;
  cablesOpen: boolean;
  guideDone: boolean;
  /** Copied clip (a detached copy), or null. */
  clipboard: Clip | null;
  /** Record Notes armed. */
  recordArmed: boolean;
  /** Module selected in the effects rack / cable panel. */
  selectedModuleId: Id | null;
  /** Simple (default) or Advanced: how much of the instrument is shown. Remembered. */
  uiMode: UiMode;
  /** The on-screen keyboard is folded to a slim bar (computer keys still play). Remembered. */
  keyboardCollapsed: boolean;
  /**
   * The keyboard folded or not, per view (remembered); a view not listed
   * folds as `keyboardCollapsed` says, except Mix, which starts folded. Read it
   * with keyboardCollapsedFor.
   */
  keyboardCollapsedByView: Partial<Record<View, boolean>>;
  /** Steps turns the bar page with the playhead. Remembered; off at first. */
  stepsFollow: boolean;
  /** The step grid Steps shows (this session only). */
  stepGrid: StepGrid;
  /** Chord pads in Notes. Remembered. */
  notesChords: NotesChords;
  /** The song lane's zoom and scroll per project id (this session only). */
  laneView: Record<Id, LaneView>;
  /** Copied effects of a part, or null (this session only). */
  effectClipboard: EffectChainClip | null;
}

export const UI_STORAGE_KEY = 'switchboard01.ui';
export const OCTAVE_RANGE = { min: 1, max: 7 } as const;

const VIEWS: readonly View[] = ['play', 'shape', 'arrange', 'mix'];
const UI_MODES: readonly UiMode[] = ['simple', 'advanced'];
const PAD_MODES: readonly PadMode[] = ['loops', 'drums', 'notes', 'steps'];
const PERSISTED = [
  'selectedTrackId',
  'view',
  'padMode',
  'keyboardOctave',
  'notesOctave',
  'tipsEnabled',
  'guideDone',
  'uiMode',
  'keyboardCollapsed',
  'keyboardCollapsedByView',
  'stepsFollow',
  'notesChords',
] as const;
type Persisted = Pick<UiState, (typeof PERSISTED)[number]>;

export function defaultUiState(): UiState {
  return {
    selectedTrackId: 't1',
    view: 'play',
    padMode: 'loops',
    selectedSlot: {},
    stepPage: {},
    selectedDrumVoice: {},
    keyboardOctave: 4,
    notesOctave: 3,
    tipsEnabled: true,
    cablesOpen: false,
    guideDone: false,
    clipboard: null,
    recordArmed: false,
    selectedModuleId: null,
    uiMode: 'simple',
    keyboardCollapsed: false,
    keyboardCollapsedByView: {},
    stepsFollow: false,
    stepGrid: '1/16',
    notesChords: { on: false, size: 3 },
    laneView: {},
    effectClipboard: null,
  };
}

/** Minimal storage surface (window.localStorage or a test double). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): KeyValueStorage | null {
  try {
    const ls = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

function clampOctave(o: unknown, fallback: number): number {
  return typeof o === 'number' && Number.isFinite(o) ? Math.min(OCTAVE_RANGE.max, Math.max(OCTAVE_RANGE.min, Math.round(o))) : fallback;
}

/** Read remembered preferences, ignoring anything malformed. */
function readPersisted(storage: KeyValueStorage | null): Partial<Persisted> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(UI_STORAGE_KEY);
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return {};
    const o = v as Record<string, unknown>;
    const d = defaultUiState();
    const out: Partial<Persisted> = {};
    if (typeof o.selectedTrackId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(o.selectedTrackId)) out.selectedTrackId = o.selectedTrackId;
    if (VIEWS.includes(o.view as View)) out.view = o.view as View;
    if (PAD_MODES.includes(o.padMode as PadMode)) out.padMode = o.padMode as PadMode;
    if (o.keyboardOctave !== undefined) out.keyboardOctave = clampOctave(o.keyboardOctave, d.keyboardOctave);
    if (o.notesOctave !== undefined) out.notesOctave = clampOctave(o.notesOctave, d.notesOctave);
    if (typeof o.tipsEnabled === 'boolean') out.tipsEnabled = o.tipsEnabled;
    if (typeof o.guideDone === 'boolean') out.guideDone = o.guideDone;
    if (UI_MODES.includes(o.uiMode as UiMode)) out.uiMode = o.uiMode as UiMode;
    if (typeof o.keyboardCollapsed === 'boolean') out.keyboardCollapsed = o.keyboardCollapsed;
    if (typeof o.keyboardCollapsedByView === 'object' && o.keyboardCollapsedByView !== null) {
      const byView: Partial<Record<View, boolean>> = {};
      for (const [k, v] of Object.entries(o.keyboardCollapsedByView as Record<string, unknown>)) if (VIEWS.includes(k as View) && typeof v === 'boolean') byView[k as View] = v;
      out.keyboardCollapsedByView = byView;
    }
    if (typeof o.stepsFollow === 'boolean') out.stepsFollow = o.stepsFollow;
    if (typeof o.notesChords === 'object' && o.notesChords !== null) {
      const c = o.notesChords as Record<string, unknown>;
      if (typeof c.on === 'boolean' && (c.size === 3 || c.size === 4)) out.notesChords = { on: c.on, size: c.size };
    }
    return out;
  } catch {
    return {};
  }
}

function persistedSlice(s: UiState): Persisted {
  const out = {} as Record<string, unknown>;
  for (const k of PERSISTED) out[k] = s[k];
  return out as Persisted;
}

export type UiStore = Store<UiState>;

/** Create a UI store that remembers preferences in `storage` (localStorage by default; null = don't remember). */
export function createUiStore(storage: KeyValueStorage | null = defaultStorage()): UiStore {
  const store = createStore<UiState>({ ...defaultUiState(), ...readPersisted(storage) });
  if (storage) {
    let last = JSON.stringify(persistedSlice(store.getState()));
    store.subscribe((s) => {
      const next = JSON.stringify(persistedSlice(s));
      if (next === last) return;
      last = next;
      try {
        storage.setItem(UI_STORAGE_KEY, next);
      } catch {
        // Storage full or blocked: preferences simply are not remembered.
      }
    });
  }
  return store;
}

/** The app's UI store. */
export const uiStore: UiStore = createUiStore();

/* ------------------------------------------------------------------ */
/* Setters                                                             */
/* ------------------------------------------------------------------ */

type Patchable = Partial<UiState>;
function set(store: UiStore, patch: Patchable): void {
  store.setState((s) => {
    for (const k of Object.keys(patch) as (keyof UiState)[]) if (!Object.is(s[k], patch[k])) return { ...s, ...patch };
    return s;
  });
}
function setIn(store: UiStore, key: 'selectedSlot' | 'stepPage' | 'selectedDrumVoice', trackId: Id, value: number): void {
  store.setState((s) => (s[key][trackId] === value ? s : { ...s, [key]: { ...s[key], [trackId]: value } }));
}

export function selectTrack(trackId: Id, store: UiStore = uiStore): void {
  set(store, { selectedTrackId: trackId });
}
export function setView(view: View, store: UiStore = uiStore): void {
  if (VIEWS.includes(view)) set(store, { view });
}
export function setPadMode(padMode: PadMode, store: UiStore = uiStore): void {
  if (PAD_MODES.includes(padMode)) set(store, { padMode });
}
export function selectSlot(trackId: Id, slot: number, store: UiStore = uiStore): void {
  if (Number.isInteger(slot) && slot >= 0 && slot < MAX_SCENES) setIn(store, 'selectedSlot', trackId, slot);
}
/**
 * Choose `slot` for a part only when none is chosen yet (PLAY-01: selecting a
 * part stores the clip the other controls will act on, so the ring, ▶,
 * Variation, Steps and Record Notes agree). A choice already made stays.
 */
export function ensureSelectedSlot(trackId: Id, slot: number, store: UiStore = uiStore): void {
  if (store.getState().selectedSlot[trackId] !== undefined) return;
  selectSlot(trackId, slot, store);
}
export function setStepPage(trackId: Id, page: number, store: UiStore = uiStore): void {
  if (Number.isInteger(page) && page >= 0 && page < MAX_CLIP_BARS) setIn(store, 'stepPage', trackId, page);
}
export function selectDrumVoice(trackId: Id, voice: number, store: UiStore = uiStore): void {
  if (Number.isInteger(voice) && voice >= 0 && voice < DRUM_VOICES) setIn(store, 'selectedDrumVoice', trackId, voice);
}
export function setKeyboardOctave(octave: number, store: UiStore = uiStore): void {
  set(store, { keyboardOctave: clampOctave(octave, store.getState().keyboardOctave) });
}
export function shiftKeyboardOctave(delta: number, store: UiStore = uiStore): void {
  setKeyboardOctave(store.getState().keyboardOctave + delta, store);
}
export function setNotesOctave(octave: number, store: UiStore = uiStore): void {
  set(store, { notesOctave: clampOctave(octave, store.getState().notesOctave) });
}
export function shiftNotesOctave(delta: number, store: UiStore = uiStore): void {
  setNotesOctave(store.getState().notesOctave + delta, store);
}
export function setTipsEnabled(on: boolean, store: UiStore = uiStore): void {
  set(store, { tipsEnabled: !!on });
}
export function setCablesOpen(open: boolean, store: UiStore = uiStore): void {
  set(store, { cablesOpen: !!open });
}
export function toggleCables(store: UiStore = uiStore): void {
  set(store, { cablesOpen: !store.getState().cablesOpen });
}
export function setGuideDone(done: boolean, store: UiStore = uiStore): void {
  set(store, { guideDone: !!done });
}
/** Store a detached copy so later project edits never change the clipboard. */
export function setClipboard(clip: Clip | null, store: UiStore = uiStore): void {
  set(store, { clipboard: clip ? cloneClip(clip) : null });
}
export function setRecordArmed(armed: boolean, store: UiStore = uiStore): void {
  set(store, { recordArmed: !!armed });
}
export function selectModule(moduleId: Id | null, store: UiStore = uiStore): void {
  set(store, { selectedModuleId: moduleId });
}
export function setUiMode(mode: UiMode, store: UiStore = uiStore): void {
  if (UI_MODES.includes(mode)) set(store, { uiMode: mode });
}
export function setKeyboardCollapsed(collapsed: boolean, store: UiStore = uiStore): void {
  set(store, { keyboardCollapsed: !!collapsed });
}
/** Fold or unfold the keyboard in one view (remembered per view). */
export function setKeyboardCollapsedFor(view: View, collapsed: boolean, store: UiStore = uiStore): void {
  if (!VIEWS.includes(view)) return;
  store.setState((s) => (s.keyboardCollapsedByView[view] === !!collapsed ? s : { ...s, keyboardCollapsedByView: { ...s.keyboardCollapsedByView, [view]: !!collapsed } }));
}
export function setStepsFollow(on: boolean, store: UiStore = uiStore): void {
  set(store, { stepsFollow: !!on });
}
export function setStepGrid(grid: StepGrid, store: UiStore = uiStore): void {
  if (STEP_GRIDS.includes(grid)) set(store, { stepGrid: grid });
}
export function setNotesChords(next: Partial<NotesChords>, store: UiStore = uiStore): void {
  store.setState((s) => {
    const on = next.on === undefined ? s.notesChords.on : !!next.on;
    const size = next.size === 3 || next.size === 4 ? next.size : s.notesChords.size;
    return on === s.notesChords.on && size === s.notesChords.size ? s : { ...s, notesChords: { on, size } };
  });
}
/** Remember the song lane's zoom and scroll for a project (this session). */
export function setLaneView(projectId: Id, view: LaneView, store: UiStore = uiStore): void {
  const zoomOk = view.zoomStep === 'fit' || (Number.isInteger(view.zoomStep) && view.zoomStep >= 0);
  if (!zoomOk || !Number.isFinite(view.scrollLeft)) return;
  const next: LaneView = { zoomStep: view.zoomStep, scrollLeft: Math.max(0, view.scrollLeft) };
  store.setState((s) => {
    const cur = s.laneView[projectId];
    return cur && cur.zoomStep === next.zoomStep && cur.scrollLeft === next.scrollLeft ? s : { ...s, laneView: { ...s.laneView, [projectId]: next } };
  });
}
/** Keep a detached copy of a part's effects for Paste effects (this session). */
export function setEffectClipboard(clip: EffectChainClip | null, store: UiStore = uiStore): void {
  set(store, { effectClipboard: clip ? structuredClone(clip) : null });
}

/** Whether the keyboard is folded in `view` (Mix starts folded; other views follow keyboardCollapsed until set). */
export function keyboardCollapsedFor(s: UiState, view: View): boolean {
  return s.keyboardCollapsedByView[view] ?? (view === 'mix' ? true : s.keyboardCollapsed);
}

/** The song lane's remembered zoom and scroll for a project, or null (fit the song). */
export function laneViewFor(s: UiState, projectId: Id): LaneView | null {
  return s.laneView[projectId] ?? null;
}

/** Per-part lookups with defaults. */
export function slotFor(s: UiState, trackId: Id): number {
  return s.selectedSlot[trackId] ?? 0;
}
export function stepPageFor(s: UiState, trackId: Id): number {
  return s.stepPage[trackId] ?? 0;
}
export function drumVoiceFor(s: UiState, trackId: Id): number {
  return s.selectedDrumVoice[trackId] ?? 0;
}

/** A remembered selection that is not one of the project's parts falls back to the first part. */
export function validSelectedTrack(s: UiState, trackIds: readonly Id[]): Id {
  return trackIds.includes(s.selectedTrackId) ? s.selectedTrackId : (trackIds[0] ?? 't1');
}
