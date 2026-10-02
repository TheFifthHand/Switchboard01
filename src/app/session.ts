/**
 * Session: the single controller that connects the layers for the running app.
 *
 * - Owns the ProjectStore (undoable edits), the audio context, the engine,
 *   the sequencer + real-time transport, the sample bank and autosave.
 * - Creates/resumes audio only from a user gesture (Jump In, Play, a pad).
 * - Pushes every project change into the engine (declarative reconcile) and
 *   invalidates scheduled notes when musical content changes.
 * - Is the facade for recordable actions (launches, notes, macro and knob
 *   moves, mute, tempo, swing, master) so Record Performance captures them.
 *
 * The UI never touches audio nodes; it calls session methods and reads
 * stores (project, ui, runtime).
 */
import type { AudioEngineApi, MeterFrame } from '../audio/contracts';
import { AudioEngine } from '../audio/engine';
import { drumVoiceJob, quantizeDrumDecay } from '../audio/instruments/drumSynth';
import { resolveKitId } from '../audio/instruments/kits';
import { SampleBank } from '../audio/instruments/sampleBank';
import { BLANK_STARTER, JUMP_IN_SCENE_ROW, JUMP_IN_STARTER_ID, STARTERS, getStarter } from '../content/starters';
import { snapToScale } from '../music/scales';
import { moduleId, uid } from '../project/factory';
import { BASS_PARAMS, DRUM_KIT_PARAMS, DRUM_VOICE_PARAM_SPECS, INSTRUMENT_PARAMS, POLY_PARAMS, SAMPLER_PARAMS, clampParam, readParam, specById } from '../project/params';
import { resolveAllParams, specsForModule } from '../project/resolve';
import {
  MACRO_IDS,
  TICKS_PER_BAR,
  sceneCount,
  type ClipBars,
  type Id,
  type MacroId,
  type MacroTarget,
  type Performance,
  type PerformanceEvent,
  type Project,
  type QuantizeGrid,
  type SampleMeta,
  type Track,
} from '../project/types';
import { computeRenderPlan, measureExport, renderOffline, type ExportReport, type RenderSource } from '../render/offline';
import { encodeWav } from '../render/wav';
import * as cmd from '../state/commands';
import { ProjectStore, type ApplyResult } from '../state/projectStore';
import { selectSlot, selectTrack, setPadMode, setView, slotFor, uiStore, type UiState } from '../state/uiStore';
import { createAutosaver, type Autosaver } from '../persistence/autosave';
import { decodeAudioFile, checkAudioFile } from '../persistence/audioImport';
import { exportBundle, importBundle, bundleFileName } from '../persistence/bundle';
import * as db from '../persistence/db';
import * as library from '../persistence/library';
import type { LaunchResult, SongLoop } from '../time/contracts';
import { recordedNoteAt } from '../time/recordWindow';
import { makeSnapshot, projectFromSnapshot } from '../time/snapshot';
import { Sequencer, songBlocks, songSignature, type NoteEvent } from '../time/sequencer';
import { SongLoopHistory, sameSongLoop, songLoopRange } from '../time/songLoop';
import { BRACE_AHEAD, BRACE_MS, RealtimeTransport, outputDelaySeconds } from '../time/transport';
import { meterWake } from '../ui/components/meterScheduler';
import { notify, patchRuntime, runtimeStore, setTrackRuntime, type PlayMode } from './runtime';

/**
 * Where a live note comes from. 'preview' is an editor/browser audition: it
 * plays exactly the pitch given (no Musical Assist, no arpeggiator) and is
 * never recorded into clips or performance takes. 'chord' is a chord pad:
 * its notes are already the chord in the key (chordAt), so Musical Assist
 * leaves them as they are (a pentatonic or blues key can hold a chord note
 * outside its five notes), but they are recorded and arpeggiated like keys.
 */
export type NoteSource = 'keyboard' | 'computer' | 'pad' | 'midi' | 'preview' | 'chord';

export interface BootInfo {
  /** The project that was reopened from storage, if any. */
  lastProject: { id: Id; name: string } | null;
  /** What the user should know about the reopen: a damaged project skipped, repairs made on load. */
  warnings: string[];
  /** Browser storage itself failed (saving is unavailable in this window). */
  storageError: string | null;
}

export interface StarterOptions {
  /**
   * The user chose to replace the open project although its latest edits
   * could not be stored. Without it, starting a starter refuses to take such
   * a project off the screen.
   */
  discardCurrent?: boolean;
}

export interface ExportOptions {
  source: RenderSource;
  sampleRate: 44100 | 48000;
  bitDepth: 16 | 24;
  tailSeconds: number;
  /** False: render with the project's mastering off (the output limiter and its −1 dBFS ceiling stay). Default true. */
  mastering?: boolean;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** Labels of edits that a performance take records (everything else is refused during a take). */
const RECORDABLE_LABELS: ReadonlySet<string> = new Set([
  ...MACRO_IDS.map((m) => `track:Change ${m[0].toUpperCase()}${m.slice(1)}`),
  ...[...BASS_PARAMS, ...POLY_PARAMS, ...SAMPLER_PARAMS, ...DRUM_KIT_PARAMS].flatMap((s) => [`track:Change ${s.label}`, `sample:Change ${s.label}`]),
  'track:Mute part',
  'track:Unmute part',
  'project:Change tempo',
  'project:Change swing',
  'project:Change master volume',
]);
const isRecordableLabel = (label: string) => label.startsWith('module:') || RECORDABLE_LABELS.has(label);

/**
 * Where the values a take records live in the project: tempo, swing, master
 * volume, a part's mute, macros and instrument knobs, and module knobs. While
 * a take records, only undo/redo steps that change nothing else go through.
 */
function isRecordablePath(path: readonly (string | number)[]): boolean {
  const [a, b, c, d] = path;
  if (path.length === 1) return a === 'bpm' || a === 'swing' || a === 'masterVolumeDb';
  if (a === 'tracks' && typeof b === 'number') {
    return (path.length === 3 && c === 'mute') || (path.length === 4 && c === 'macros') || (path.length === 5 && c === 'instrument' && d === 'params');
  }
  return a === 'patch' && b === 'modules' && typeof c === 'number' && path.length === 5 && d === 'params';
}

export const PAUSE_UNAVAILABLE_MESSAGE = 'Pause is not available while a performance records: a take cannot hold a pause. Stop ends the take and keeps it.';

export const TAKE_LOCK_MESSAGE =
  'Recording a performance: cables, clips, sounds, the song and saved takes are locked until you stop. Knob, macro, mute and tempo changes are recorded, and so is undoing them. Mastering is locked too: it applies to the whole song, not the take.';

interface HeldNote {
  trackId: Id;
  /** Pitch actually played (after Musical Assist). */
  pitch: number;
  velocity: number;
  /**
   * The key went to the arpeggiator (its part's arp was on when it was
   * pressed), so its release goes there too, whatever the arp is set to by then.
   */
  viaArp: boolean;
  /** Where Record Notes writes the note (the downbeat for one caught early), or null when not recording notes. */
  recTick: number | null;
  /** Transport tick when it was pressed (Record Notes measures its length from there). */
  recPressTick: number | null;
  /** Clip start tick when recording notes. */
  recClipStart: number | null;
}

interface Take {
  startTick: number;
  snapshot: Performance['snapshot'];
  events: PerformanceEvent[];
  /** Last recorded time per continuous control, to thin knob streams to ~30 events/s. */
  lastControlTime: Map<string, number>;
}

interface NoteRecording {
  trackId: Id;
  slot: number;
  gesture: string;
  added: number;
  /** Arpeggiator notes played and not written into the clip yet (ticks from the clip's loop start). */
  arpNotes: { tick: number; pitch: number; velocity: number; duration: number }[];
  arpFlush: ReturnType<typeof setTimeout> | null;
  /**
   * The target clip's latest loop start heard: in song playback a block that
   * does not play it still records into it, counted from there.
   */
  lastLoopStart: number | null;
  /** The "this block does not play it" notice was shown for this pass. */
  inaudibleTold: boolean;
  /** The tick recording started at when it had to wait for it (a launch at the next bar, a count-in), else null. */
  startsAt: number | null;
}

/** Arpeggiator notes are written into the clip in batches (their ticks come from the audio clock). */
const ARP_RECORD_BATCH_MS = 200;
/**
 * While an export prepares and renders, live playback is scheduled this far
 * ahead (see RealtimeTransport.holdAhead): building the export's engine
 * blocks the main thread for a moment (about a third of a second on a fast
 * computer, several times that on a slow one), and the music plays on
 * through it.
 */
const EXPORT_LOOKAHEAD_S = 2;
/**
 * Shown when playback stopped by itself: only a background (throttled) tab
 * or a paused audio device stops it. In a visible tab a busy moment never
 * stops playback (it skips ahead in time, see SKIP_NOTICE).
 */
export const STALL_MESSAGE = 'Playback stopped because the tab was in the background or the audio device paused. Press Play to continue.';
/** A quiet notice, at most once a minute, when a busy moment made playback skip ahead to stay in time (no banner). */
export const SKIP_NOTICE = 'Omni Song was busy for a moment, so a few notes were skipped to stay in time.';
const SKIP_NOTICE_EVERY_MS = 60_000;
/**
 * Edits that change a lot at once: a version of the project is kept just
 * before them (autosaver.snapshotBefore, at most once per kind of edit every
 * SNAPSHOT_BEFORE_EVERY_MS here; persistence thins further). Matched on the
 * undo step's words.
 */
const BULK_EDIT = /^(Variation|Subtle variation|Bold variation|Clear|Delete clip|Delete scene|Replace|Build up|Strip down|Breakdown|Make song blocks|Make a scene from a block|Change kit|Change sound|Change recording|Import|Move the song)/;
const SNAPSHOT_BEFORE_EVERY_MS = 2 * 60 * 1000;
/** Shortest note Record Notes keeps (ticks; a 64th note): a tap is still a note you can see and hear. */
const MIN_RECORDED_TICKS = 6;
/** Sound edits during a gesture re-schedule what is scheduled at most this often (ms). */
const SOUND_EDIT_MS = 80;

export class Session {
  readonly store: ProjectStore;
  autosaver: Autosaver | null = null;

  ctx: AudioContext | null = null;
  engine: AudioEngine | null = null;
  sequencer: Sequencer | null = null;
  transport: RealtimeTransport | null = null;
  bank: SampleBank | null = null;

  private audioPromise: Promise<boolean> | null = null;
  private unsubs: (() => void)[] = [];
  private held = new Map<string, HeldNote>();
  private take: Take | null = null;
  /** A/B comparison (Mix view): mastering bypassed for listening only. */
  private masteringBypass = false;
  private noteRec: NoteRecording | null = null;
  /** The open project is the preview starter shown on first launch: stored only once it is changed. */
  private previewOnly = false;
  /** The open project is a starter that could not be stored when it was started: its first save adds it to the library. */
  private unstored = false;
  private replayingId: Id | null = null;
  /** What was playing when playback stalled, so Resume restarts the same thing (the song block by id). */
  private stallResume: { mode: PlayMode; songBlock: number | null; songBlockId: Id | null; replayId: Id | null } | null = null;
  private loadedSampleIds = new Set<Id>();
  /** Keys pressed before the engine existed: played as soon as audio is ready. */
  private pendingKeys = new Map<string, { released: boolean }>();
  private auditionCounter = 0;
  private sampleLoads = new Map<Id, Promise<void>>();
  /** Told whenever every held note was let go of (Stop, Pause, Mute All, blur, a stall, a new project). */
  private releaseListeners = new Set<() => void>();
  /** Asked before Record Performance or Record Notes starts: a reason to wait, or null (see addRecordGuard). */
  private recordGuards = new Set<() => string | null>();
  /** How the song loop follows edits, and undo and redo of the steps that changed it. */
  private readonly loopHistory = new SongLoopHistory();
  /** Exports preparing or rendering (live playback is scheduled further ahead meanwhile). */
  private exportsRunning = 0;
  /** When the last "skipped ahead" notice was shown (performance.now). */
  private lastSkipNotice = -Infinity;
  /** Sound edits not yet applied to what is scheduled (see noteSoundEdits), and when the last batch went. */
  private readonly soundEditsPending: { tracks: Set<Id>; beats: boolean; timer: ReturnType<typeof setTimeout> | null; at: number } = {
    tracks: new Set(),
    beats: false,
    timer: null,
    at: -Infinity,
  };
  /** readMetersShared: one engine read per animation frame. */
  private readonly sharedFrame: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
  private sharedFrameAt = -Infinity;
  private sharedFrameKey: number | null = null;
  private sharedFrameLive = false;
  /** Clip recordings (Clip.sample ids) already handed to the engine to load ahead. */
  private preloaded = new Set<Id>();
  /** capability-06: when a version was last kept before each kind of bulk edit, and the step it was for. */
  private readonly snapshotAt = new Map<string, number>();
  private snapshotEntry: number | null = null;
  private readonly uiUnsub: () => void;

  constructor(initial: Project) {
    this.store = new ProjectStore(initial);
    this.store.subscribe((p, prev) => this.onProjectChange(p, prev));
    // Switching views and modes is the app's heaviest main-thread work: schedule further ahead first.
    this.uiUnsub = uiStore.subscribe((s: UiState, prev: UiState) => {
      if (s.view !== prev.view || s.padMode !== prev.padMode || s.uiMode !== prev.uiMode || s.cablesOpen !== prev.cablesOpen) this.brace();
    });
  }

  /**
   * Heavy main-thread work is about to happen (a view or mode switch, a
   * dialog, opening a project): live playback is scheduled `seconds` ahead
   * (default 1 s) for the next few seconds, so it plays on through it. Edits,
   * launches, Pause and Stop still act at once. No-op before audio starts.
   */
  brace(seconds: number = BRACE_AHEAD): void {
    this.transport?.brace(seconds, BRACE_MS);
  }

  /* ------------------------------------------------------------------ */
  /* Boot & projects                                                     */
  /* ------------------------------------------------------------------ */

  /** Reopen the last project from storage, or show the Jump In starter as a preview. */
  async boot(): Promise<BootInfo> {
    const info: BootInfo = { lastProject: null, warnings: [], storageError: null };
    this.unstored = false;
    /** A rescue copy that could not be stored yet: it opens as unsaved (autosave keeps trying). */
    let unsaved: Project | null = null;
    try {
      const opened = await library.openLast();
      if (opened) {
        if (opened.unsaved) unsaved = opened.project;
        else this.store.replace(opened.project);
        info.lastProject = { id: opened.project.id, name: opened.project.name };
        info.warnings = opened.warnings;
        this.setPreview(false);
      } else {
        this.loadPreview();
      }
    } catch (e) {
      // Stored projects that cannot be read are a problem with those projects, not with saving.
      if (library.isUnreadableLibrary(e)) info.warnings = [e.message];
      else info.storageError = e instanceof Error ? e.message : 'Browser storage is unavailable.';
      this.loadPreview();
    }
    this.startAutosave();
    if (unsaved) {
      // After the autosaver: it sees the project as an edit not stored yet, and adds it to the library once it can.
      this.unstored = true;
      this.store.replace(unsaved);
    }
    if (!info.storageError) void db.garbageCollectSamples({ keep: db.sampleIdsOf(this.store.getState()) }).catch(() => undefined);
    return info;
  }

  private loadPreview(): void {
    const starter = getStarter(JUMP_IN_STARTER_ID) ?? STARTERS[0];
    this.store.replace(starter.build());
    this.setPreview(true);
  }

  private setPreview(preview: boolean): void {
    this.previewOnly = preview;
    if (runtimeStore.getState().preview !== preview) patchRuntime({ preview });
  }

  private startAutosave(): void {
    // An earlier autosaver (booting again) still writes its pending edits, but not the state just loaded.
    const previous = this.autosaver;
    previous?.markSaved(this.store.getState());
    void previous?.dispose();
    this.autosaver = createAutosaver({
      store: this.store,
      save: async (p) => {
        if ((this.previewOnly || this.unstored) && p.id === this.store.getState().id) {
          // The first change turns the preview into a normal project: stored, and reopened next time.
          // An untouched preview never gets here, so it is never stored. A starter that could not be
          // stored when it was started is added the same way once storage works again.
          await library.addToLibrary(p);
          this.unstored = false;
          this.setPreview(false);
          return;
        }
        await db.saveProject(p);
      },
    });
    this.autosaver.markSaved(this.store.getState());
  }

  /**
   * Load a project into the store (stops playback and recording first).
   * `unsaved`: it could not be stored, so autosave keeps trying (and shows
   * "Not saved" while it fails) instead of treating it as saved; its first
   * successful save adds it to the library as the project to reopen.
   */
  private async loadProject(project: Project, opts: { unsaved?: boolean } = {}): Promise<void> {
    // An A/B comparison belongs to the project that was open, and so does a song loop.
    this.setMasteringListen(false);
    this.stopEverything();
    this.setSongLoop(null);
    await this.autosaver?.flush();
    this.setPreview(false);
    this.unstored = !!opts.unsaved;
    // The new project's graph is built right below (whatever plays meanwhile keeps playing in time).
    this.brace();
    this.store.replace(project);
    if (!opts.unsaved) this.autosaver?.markSaved(project);
    this.resetRuntimeTracks();
    await this.loadProjectSamples(project);
    // Instruments warm up in idle slices (what the clips play first), never in one long task.
    void this.engine?.prepareInstruments({ incremental: true });
    this.preloadClipSamples(this.store.getState());
  }

  /**
   * Jump In: enable audio (this must run inside the click), save whatever is
   * open, start a fresh House starter session and play its Groove scene on
   * the Loops pads (whatever view was left open last time).
   */
  async jumpIn(): Promise<void> {
    const audio = this.startAudio();
    const starter = getStarter(JUMP_IN_STARTER_ID) ?? STARTERS[0];
    try {
      await this.createFromStarter(starter.build());
    } catch (e) {
      // The open project has edits that could not be stored: it stays on screen.
      notify(e instanceof Error ? e.message : String(e), 'error');
      return;
    }
    setView('play');
    setPadMode('loops');
    selectTrack('t4');
    if (!(await audio)) return;
    this.transport!.launchScene(JUMP_IN_SCENE_ROW);
    this.selectRow(JUMP_IN_SCENE_ROW);
    await this.play();
  }

  /**
   * Start a new project from a starter (current project is saved first; see
   * StarterOptions). The project it replaced on screen (it stays in the
   * library) is in runtime `starterReplaced`.
   */
  async newFromStarter(starterId: string, opts: StarterOptions = {}): Promise<void> {
    const def = starterId === 'blank' ? BLANK_STARTER : getStarter(starterId);
    if (!def) return;
    await this.createFromStarter(def.build(), opts);
  }

  /**
   * Store the open project, then load the starter as a new stored project.
   * Rejects, and leaves the open project on screen, when its latest edits
   * could not be stored, unless `discardCurrent` is set. When only the new
   * project cannot be stored, it still loads (with a warning) and autosave
   * keeps trying: once storage works it is added to the library and reopened
   * next time.
   */
  private async createFromStarter(starter: Project, opts: StarterOptions = {}): Promise<void> {
    // Pending edits are written first; an edited preview becomes a stored project here.
    await this.autosaver?.flush();
    const saving = this.autosaver?.status.getState();
    if (saving?.status === 'error' && !opts.discardCurrent) {
      throw new db.StorageError(saving.lastError?.kind ?? 'unknown', saving.lastError?.message ?? 'The open project could not be saved.');
    }
    // Even when replacing it anyway, the open project is still kept if storage allows.
    const current = this.previewOnly ? null : this.store.getState();
    let project = starter;
    let stored = true;
    let replaced: { id: Id; name: string } | null = null;
    try {
      ({ project, replaced } = await library.createFromStarter(starter, current));
    } catch (e) {
      stored = false;
      replaced = current ? { id: current.id, name: current.name } : null;
      notify(`Could not save to browser storage: ${e instanceof Error ? e.message : String(e)}. You can keep playing; export the project file to keep a copy.`, 'warn');
    }
    await this.loadProject(project, { unsaved: !stored });
    // The shell says which project the starter took the place of (it is still in My projects).
    patchRuntime({ starterReplaced: replaced });
  }

  /** Continue the reopened project (audio starts from this gesture; nothing auto-plays). */
  async continueProject(): Promise<void> {
    await this.startAudio();
  }

  async openProject(id: Id): Promise<void> {
    this.brace();
    await this.autosaver?.flush();
    const opened = await library.openProject(id);
    // A rescue copy that could not be stored opens as unsaved: autosave keeps trying to store it.
    await this.loadProject(opened.project, { unsaved: !!opened.unsaved });
    for (const w of opened.warnings) notify(w, 'warn');
  }

  async importProjectFile(file: File): Promise<{ ok: boolean; message: string }> {
    const res = await importBundle(file, { newId: true });
    if (!res.ok) return { ok: false, message: res.error };
    try {
      const names = new Set((await library.listProjects()).map((x) => x.name));
      if (names.has(res.project.name)) res.project.name = `${res.project.name} (imported)`.slice(0, 60);
    } catch {
      /* the library list is only used to avoid duplicate names */
    }
    // Pending edits first: an edited preview stored now must not become the project reopened next time.
    await this.autosaver?.flush();
    try {
      for (const s of res.samples) await db.putSample(s.meta, s.blob);
      await library.addToLibrary(res.project);
    } catch (e) {
      return { ok: false, message: `The project file is fine, but it could not be stored in this browser: ${e instanceof Error ? e.message : String(e)}` };
    }
    await this.loadProject(res.project);
    const extra = res.warnings.length ? ` (${res.warnings.length} note${res.warnings.length === 1 ? '' : 's'}: ${res.warnings[0]})` : '';
    return { ok: true, message: `Opened "${res.project.name}"${extra}.` };
  }

  async exportProjectFile(): Promise<{ blob: Blob; filename: string }> {
    await this.autosaver?.flush();
    const project = this.store.getState();
    const blob = await exportBundle(project, async (id) => (await db.getSample(id))?.blob ?? null);
    return { blob, filename: bundleFileName(project) };
  }

  /** True while the open project is the Jump In preview shown on first launch and not changed yet. */
  get isPreview(): boolean {
    return this.previewOnly;
  }

  /* ------------------------------------------------------------------ */
  /* Audio lifecycle                                                     */
  /* ------------------------------------------------------------------ */

  get audioRunning(): boolean {
    return runtimeStore.getState().audio === 'running';
  }

  /**
   * Create (once) and resume the AudioContext. Call it synchronously from a
   * user gesture handler; later calls resume a suspended context.
   */
  startAudio(): Promise<boolean> {
    if (this.audioPromise) {
      if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined);
      return this.audioPromise;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' });
    } catch {
      patchRuntime({ audio: 'error', audioMessage: 'This browser cannot make sound here (Web Audio is unavailable). Try current Chrome or Edge.' });
      return Promise.resolve(false);
    }
    this.ctx = ctx;
    const resumed = ctx.resume().catch(() => undefined);
    patchRuntime({ audio: 'starting', audioMessage: null });
    this.audioPromise = (async () => {
      await resumed;
      // The view change this click made (Welcome to Play) paints before the engine is built.
      await nextFrame();
      const project = this.store.getState();
      const bank = new SampleBank(ctx.sampleRate);
      // What the engine loads ahead (preloadSamples) and is not in the bank yet comes from browser storage.
      bank.setLoader((id) => this.loadSampleForBank(bank, ctx, id));
      this.bank = bank;
      await this.loadProjectSamples(project);
      const engine = await AudioEngine.create(ctx, { samples: this.bank, seed: project.seed, meters: true });
      this.engine = engine;
      engine.setMasterVolume(project.masterVolumeDb);
      engine.setProject(project);
      // Mute All pressed before audio started still holds; so does an A/B comparison.
      if (runtimeStore.getState().muteAll) engine.setMuteAll(true);
      if (this.masteringBypass) engine.setMasteringBypass(true);
      // perf-06: what the clips play is made ready first, in short tasks that let the page paint (not
      // in idle time, which a busy page hands out slowly); the rest of the warm-up follows in idle time.
      await warmSounds(this.store.getState(), bank, ctx.sampleRate);
      void engine.prepareInstruments({ incremental: true });
      this.preloadClipSamples(this.store.getState());
      const sequencer = new Sequencer({ getProject: () => this.store.getState() });
      // A song loop set before audio started applies to the first song start.
      sequencer.setSongLoop(runtimeStore.getState().songLoop, 0);
      const transport = new RealtimeTransport({ ctx, engine, sequencer });
      this.sequencer = sequencer;
      this.transport = transport;
      if (this.exportsRunning) transport.holdAhead(EXPORT_LOOKAHEAD_S);
      // The first seconds after audio starts are busy (the rest of the warm-up, the first renders).
      transport.brace();
      this.wireTransport(transport);
      ctx.onstatechange = () => this.updateAudioState();
      this.updateAudioState();
      return true;
    })().catch((e: unknown) => {
      console.error(e);
      this.discardFailedAudio(ctx);
      patchRuntime({ audio: 'error', audioMessage: `Audio could not start: ${e instanceof Error ? e.message : String(e)}` });
      return false;
    });
    return this.audioPromise;
  }

  /**
   * A start that failed leaves nothing behind: its context is closed (no
   * second live context on the next try) and the sample bookkeeping is reset
   * so the next start decodes recordings into its own bank again.
   */
  private discardFailedAudio(ctx: AudioContext): void {
    this.audioPromise = null;
    ctx.onstatechange = null;
    void ctx.close().catch(() => undefined);
    if (this.ctx !== ctx) return;
    try {
      this.engine?.dispose();
    } catch {
      /* the engine never finished setting up */
    }
    this.engine = null;
    this.bank = null;
    this.ctx = null;
    this.loadedSampleIds.clear();
    this.sampleLoads.clear();
    this.preloaded.clear();
  }

  /** "Resume audio" button: resume a suspended or interrupted context. */
  async resumeAudio(): Promise<void> {
    if (!this.ctx) {
      await this.startAudio();
      return;
    }
    try {
      await this.ctx.resume();
    } catch {
      /* state handler reports it */
    }
    this.updateAudioState();
  }

  private updateAudioState(): void {
    const ctx = this.ctx;
    if (!ctx || !this.engine) return;
    const state = ctx.state as string;
    if (state === 'running') patchRuntime({ audio: 'running', audioMessage: null });
    else if (state === 'closed') patchRuntime({ audio: 'error', audioMessage: 'Audio output closed. Reload the page to start again.' });
    else patchRuntime({ audio: 'suspended', audioMessage: 'The browser paused audio output (device change or system interruption).' });
  }

  private wireTransport(t: RealtimeTransport): void {
    this.unsubs.push(
      t.on('launch', (ev) => {
        const cur = runtimeStore.getState().tracks[ev.trackId];
        const queued = cur?.queued && cur.queued.atTick > ev.tick ? cur.queued : null;
        setTrackRuntime(ev.trackId, { playingSlot: ev.slot, queued });
        const rec = this.noteRec;
        if (rec && ev.trackId === rec.trackId) {
          if (ev.slot === rec.slot) {
            // The clip being recorded into sounds (again): recording counts from its loop start.
            rec.lastLoopStart = this.sequencer?.playingAt(ev.trackId, ev.tick)?.startTick ?? ev.tick;
            rec.inaudibleTold = false;
            patchRuntime({ recordStartsAtTick: null, recordTargetAudible: true });
          } else if (runtimeStore.getState().mode === 'song') this.recordTargetSilent(rec);
          // On the live pads another clip on the part ends the pass.
          else this.stopRecordNotes();
        }
      }),
      // Found by id: the block may have moved since its event was scheduled. One deleted meanwhile is
      // never named: the plan has the block taking over from it.
      t.on('block', (ev) => {
        const i = this.store.getState().arrangement.blocks.findIndex((b) => b.id === ev.blockId);
        if (i >= 0) patchRuntime({ songBlock: i, songBlockId: ev.blockId });
        else this.syncSongBlock();
        // Playing into the loop (or a jump to it) starts looping here.
        this.syncSongLooping();
      }),
      t.on('beat', (ev) => {
        const rt = runtimeStore.getState();
        if (rt.countingIn !== ev.countIn) patchRuntime({ countingIn: ev.countIn });
        // Record Notes waited for this downbeat (a count-in, or its clip at the next bar): it records now.
        if (rt.recordStartsAtTick != null && ev.tick >= rt.recordStartsAtTick) patchRuntime({ recordStartsAtTick: null });
      }),
      t.on('end', () => this.stop()),
      t.on('arpNote', (ev) => this.recordArpNote(ev)),
      // Only a background tab or a paused audio device stops playback by itself (see RealtimeTransport).
      t.on('stalled', (s) => {
        const rt = runtimeStore.getState();
        // The transport found the song block where the music stopped before the stop cleared the song.
        const songBlockId = rt.mode === 'song' ? (s.songBlockId ?? rt.songBlockId) : rt.songBlockId;
        this.stallResume = { mode: rt.mode, songBlock: rt.songBlock, songBlockId, replayId: this.replayingId };
        this.finishTake('stalled');
        this.stopRecordNotes();
        this.releaseAllNotes();
        // The transport is back on the live pads: pads, keys and knobs work again until Resume.
        this.endReplay();
        patchRuntime({
          playing: false,
          paused: false,
          mode: 'live',
          songBlock: null, songBlockId: null, songLooping: false,
          countingIn: false,
          stalled: STALL_MESSAGE,
        });
        this.refreshLauncherRuntime();
      }),
      // A busy moment in a visible tab: playback skipped ahead in time and plays on (a take keeps recording).
      t.on('skipped', () => {
        const now = performance.now();
        if (now - this.lastSkipNotice < SKIP_NOTICE_EVERY_MS) return;
        this.lastSkipNotice = now;
        notify(SKIP_NOTICE, 'info');
      }),
      t.on('state', () => this.updateAudioState()),
    );
  }

  /* ------------------------------------------------------------------ */
  /* Project → engine                                                    */
  /* ------------------------------------------------------------------ */

  private onProjectChange(p: Project, prev: Project): void {
    // A bulk edit (Variation, Clear, Delete scene …): keep a version of the state before it (capability-06).
    this.keepVersionBefore(prev);
    // First the launcher follows clips that moved, so the regeneration below already plays them from their new pads.
    if (p.tracks !== prev.tracks) this.followMovedClips(p, prev);
    // The edit and selected clips follow scene rows inserted, copied, deleted or moved (undo and redo too).
    if (p.scenes !== prev.scenes || p.id !== prev.id) this.followScenes(p, prev);
    if (this.engine && !this.replayingId) {
      this.engine.setProject(p);
      if (p.masterVolumeDb !== prev.masterVolumeDb) this.engine.setMasterVolume(p.masterVolumeDb);
    }
    // The song loop follows the edit (see SongLoopHistory: undoing an edit that shrank it brings it back);
    // another project has none.
    const loopWas = runtimeStore.getState().songLoop;
    if (p.id !== prev.id) this.loopHistory.clear();
    const loop = p.id !== prev.id ? null : this.loopHistory.follow(loopWas, prev, p, this.store.lastChange());
    if (this.transport && !this.replayingId) {
      if (p.bpm !== prev.bpm) this.transport.setTempo(p.bpm);
      if (p.swing !== prev.swing) this.transport.setSwing(p.swing);
      // Switching a part's arpeggiator or its Latch off ends a latched pattern, so it never restarts on its own later.
      if (p.tracks !== prev.tracks) {
        for (const t of p.tracks) {
          const was = prev.tracks.find((x) => x.id === t.id)?.arp;
          if (was && was !== t.arp && ((was.enabled && !t.arp.enabled) || (was.latch && !t.arp.latch))) this.transport.clearArpLatch(t.id);
        }
      }
      // A song playing (or paused) follows edits to its blocks and to the clips they play, in the edit's own
      // task, so nothing ever reads a plan the edit made stale (measured: under a millisecond on a fast
      // computer, a few at 4x CPU slowdown; see docs/ARCHITECTURE.md). The replan also regenerates.
      const replanned = this.followSongEdits(p, prev, loop);
      // Song moves (fades, filter rise, echo throw) edited while the song plays: re-sent from now, in phase.
      const regenerated = !replanned && (musicChanged(p, prev) || movesChanged(p, prev));
      if (regenerated) this.transport.invalidate();
      // Everything not started was scheduled again with the engine's new settings, or a sound edit
      // schedules again what was scheduled for the parts it changed (M1: notes take an instrument's
      // settings when they are scheduled, up to a second ahead).
      const newInstrument = instrumentsChanged(p, prev);
      if (replanned || regenerated) this.dropSoundEdits();
      else this.noteSoundEdits(soundEdits(p, prev), newInstrument);
      // A new instrument builds nodes and warms up voices: schedule further ahead (now on the new sound).
      if (newInstrument) {
        this.brace();
        this.warmNewSounds(p, prev);
      }
    }
    // Not replanned (stopped, live pads, a replay): the sequencer keeps the loop for the next song start.
    if (this.transport && this.sequencer && !sameSongLoop(this.sequencer.songLoop, loop)) this.transport.replanSong(loop);
    if (loop !== loopWas) patchRuntime({ songLoop: loop });
    if (p.samples !== prev.samples) void this.loadProjectSamples(p).then(() => this.preloadClipSamples(this.store.getState()));
    else if (p.tracks !== prev.tracks) this.preloadClipSamples(p);
    if (p.tracks !== prev.tracks) this.stopPartsWithoutClip(p);
  }

  /**
   * A sound edit while music plays (sound settings, a kit or preset, Pump,
   * the metronome): what was already scheduled is scheduled again with the
   * new settings, for the parts it changed (transport.revoice), or every
   * beat-timed sound with everything else when Pump or the metronome changed
   * (transport.invalidate). During a gesture (a knob drag) at most once every
   * SOUND_EDIT_MS: the first change at once, the rest batched. `now`: at once
   * (a new kit or preset is a single choice).
   */
  private noteSoundEdits(e: { tracks: readonly Id[]; beats: boolean }, now: boolean): void {
    if (!e.tracks.length && !e.beats) return;
    const pending = this.soundEditsPending;
    for (const id of e.tracks) pending.tracks.add(id);
    pending.beats ||= e.beats;
    const wait = pending.at + SOUND_EDIT_MS - performance.now();
    if (now || wait <= 0) this.flushSoundEdits();
    else pending.timer ??= setTimeout(() => this.flushSoundEdits(), wait);
  }

  private flushSoundEdits(): void {
    const pending = this.soundEditsPending;
    const tracks = [...pending.tracks];
    const beats = pending.beats;
    this.dropSoundEdits();
    pending.at = performance.now();
    const transport = this.transport;
    if (!transport || this.replayingId) return;
    if (beats) transport.invalidate();
    else if (tracks.length) transport.revoice(tracks);
  }

  /**
   * A new kit or recording: until its drum voices are rendered (the engine
   * does it in idle time), hits play the slot's previous sound. They are
   * rendered now in short tasks (see warmSounds), and what is scheduled for
   * those parts is scheduled again with them.
   */
  private warmNewSounds(p: Project, prev: Project): void {
    const bank = this.bank;
    const ctx = this.ctx;
    if (!bank || !ctx) return;
    const ids = p.tracks.filter((t, i) => soundIdentity(t) !== soundIdentity(prev.tracks[i])).map((t) => t.id);
    if (!ids.length) return;
    void warmSounds(p, bank, ctx.sampleRate, new Set(ids)).then(() => {
      if (this.bank === bank && this.transport && !this.replayingId) this.transport.revoice(ids);
    });
  }

  /** Sound edits waiting for their batch are covered (everything not started was generated again). */
  private dropSoundEdits(): void {
    const pending = this.soundEditsPending;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
    pending.tracks.clear();
    pending.beats = false;
  }

  /**
   * capability-06: just before a bulk edit (one that changes a lot at once,
   * BULK_EDIT), keep a version of the project as it was, at most once per
   * kind of edit every two minutes (persistence thins further). Undo and redo
   * keep none, nor does a gesture going on (one step).
   */
  private keepVersionBefore(prev: Project): void {
    const change = this.store.lastChange();
    if (change.kind !== 'edit' || change.entryId === null || change.entryId === this.snapshotEntry) return;
    this.snapshotEntry = change.entryId;
    if (!this.autosaver || this.previewOnly || prev.id !== this.store.getState().id) return;
    const label = this.store.undoLabel();
    if (!label || !BULK_EDIT.test(label)) return;
    const now = Date.now();
    const last = this.snapshotAt.get(label);
    if (last !== undefined && now - last < SNAPSHOT_BEFORE_EVERY_MS && now >= last) return;
    this.snapshotAt.set(label, now);
    void this.autosaver.snapshotBefore(prev, label);
  }

  /**
   * Scene rows were inserted, copied, deleted or moved (or such a step undone
   * or redone): each part's selected clip stays the same clip (an empty
   * selected pad stays on its scene; one whose scene went goes to the row
   * now there, within the scene count), and Record Notes keeps recording into
   * its clip. Another project: selections beyond its scenes come back in range.
   */
  private followScenes(p: Project, prev: Project): void {
    const ui = uiStore.getState();
    const count = sceneCount(p);
    const same = p.id === prev.id;
    for (const t of p.tracks) {
      const sel = ui.selectedSlot[t.id];
      if (sel === undefined) continue;
      let to = -1;
      if (same) {
        const clipId = prev.tracks.find((x) => x.id === t.id)?.clips[sel]?.id;
        if (clipId) to = t.clips.findIndex((c) => c?.id === clipId);
        const sceneId = prev.scenes[sel]?.id;
        if (to < 0 && sceneId) to = p.scenes.findIndex((s) => s.id === sceneId);
      }
      if (to < 0) to = Math.max(0, Math.min(sel, count - 1));
      if (to !== sel) selectSlot(t.id, to);
    }
    const rec = this.noteRec;
    if (!rec || !same) return;
    const clipId = prev.tracks.find((x) => x.id === rec.trackId)?.clips[rec.slot]?.id;
    const at = clipId ? (p.tracks.find((x) => x.id === rec.trackId)?.clips.findIndex((c) => c?.id === clipId) ?? -1) : -1;
    if (at >= 0 && at !== rec.slot) {
      rec.slot = at;
      patchRuntime({ recordTarget: { trackId: rec.trackId, slot: at } });
    }
  }

  /**
   * Load ahead the recordings clips play themselves (Clip.sample), once each,
   * so no note waits for one: built-in sounds are generated, recordings come
   * from the bank, which reads browser storage for one it does not hold yet
   * (loadSampleForBank).
   */
  private preloadClipSamples(p: Project): void {
    const engine = this.engine;
    if (!engine?.preloadSamples) return;
    const ids: Id[] = [];
    for (const id of cmd.clipSampleIds(p)) {
      if (this.preloaded.has(id)) continue;
      this.preloaded.add(id);
      ids.push(id);
    }
    if (ids.length) void engine.preloadSamples(ids);
  }

  /**
   * Record Notes in the song: the song moved into a block that does not play
   * the clip being recorded into. Notes still go into it (where its loop
   * would be); the transport says so once.
   */
  private recordTargetSilent(rec: NoteRecording): void {
    patchRuntime({ recordTargetAudible: false });
    if (rec.inaudibleTold) return;
    rec.inaudibleTold = true;
    const p = this.store.getState();
    const track = p.tracks.find((t) => t.id === rec.trackId);
    const clip = track?.clips[rec.slot];
    notify(`Recording into ${track?.name ?? 'the part'} · ${clip?.name ?? 'its clip'}, which this block does not play.`, 'warn');
  }

  /**
   * Clips that moved (a drag between pads, a scene reorder, or undoing one)
   * take the launcher with them: a clip moved within its part keeps playing
   * (in phase) or stays armed or queued, from its new pad. A clip moved to
   * another part stops on its old part at once and does not start by itself
   * on the new one (tap it there). A copy or paste that replaces a playing
   * clip plays in its place, as before. Song playback keeps its scenes; while
   * the song plays (or is paused) a clip that left its part is left to the
   * song replan, which switches the part off and back on (Undo) itself.
   */
  private followMovedClips(p: Project, prev: Project): void {
    const t = this.transport;
    if (!t) return;
    const song = this.sequencer?.mode.kind === 'song';
    const rowsChanged = p.scenes !== prev.scenes && p.id === prev.id;
    if (rowsChanged) {
      // Scenes moved, inserted above, or deleted (-1: what played its row goes silent).
      const rows = new Map<number, number>();
      prev.scenes.forEach((s, i) => {
        const j = p.scenes.findIndex((x) => x.id === s.id);
        if (j !== i) rows.set(i, j);
      });
      if (rows.size) t.relocateSongRows(rows);
    }
    const partOf = new Map<Id, Id>();
    for (const tr of p.tracks) for (const c of tr.clips) if (c) partOf.set(c.id, tr.id);
    let moved = false;
    for (const tr of p.tracks) {
      const was = prev.tracks.find((x) => x.id === tr.id);
      if (!was || was.clips === tr.clips) continue;
      const slots = new Map<number, number | null>();
      was.clips.forEach((c, s) => {
        if (!c || tr.clips[s]?.id === c.id) return;
        const to = tr.clips.findIndex((x) => x?.id === c.id);
        if (to >= 0) slots.set(s, to);
        // Song mode: the part's slot is empty now, so it is silent at once; stopping it here as well
        // would put it outside the song's plan, and an Undo could not bring it back. A clip deleted with its
        // scene row (another clip has its slot now) stops like one that left the part.
        else if ((partOf.has(c.id) || (rowsChanged && tr.clips[s])) && !song) slots.set(s, null);
      });
      if (!slots.size) continue;
      t.relocateSlots(tr.id, slots);
      moved = true;
    }
    if (moved && !this.replayingId) this.refreshLauncherRuntime();
  }

  /**
   * The song is always played as the Arrange lane shows it: an edit while it
   * plays or is paused (blocks, their order, lengths, scenes, part choices,
   * or the clips they play, undo and redo included) lays out the rest of the
   * song again from the block playing now (see Sequencer.replanSong). Scene
   * reorders were already followed by `followMovedClips`, which then changes
   * nothing more here. `loop`: the song loop after this edit (it never makes
   * playback jump). Returns true when playback changed.
   */
  private followSongEdits(p: Project, prev: Project, loop: SongLoop | null): boolean {
    const seq = this.sequencer;
    const t = this.transport;
    if (!seq || !t || seq.mode.kind !== 'song' || !(seq.playing || seq.paused)) return false;
    if (sameSongLoop(seq.songLoop, loop)) {
      // The song depends on the blocks, the scenes and the clips (not on sounds or knobs).
      if (!songEdited(p, prev)) return false;
      if (songSignature(p) === songSignature(prev)) return false;
    }
    const changed = t.replanSong(loop);
    this.syncSongBlock();
    // Pads show what each part plays now, or switches to when the next block starts.
    if (changed) this.refreshLauncherRuntime();
    return changed;
  }

  /**
   * The runtime's song block is the block the plan has at the playhead, at
   * its place in the arrangement. An edit can change it without a 'block'
   * event: a split or join continues in the block that now covers the
   * playhead, and a block deleted while it plays hands over (at the next bar
   * line) to the block reported here already. Null when nothing follows.
   */
  private syncSongBlock(): void {
    const seq = this.sequencer;
    const t = this.transport;
    const rt = runtimeStore.getState();
    if (!seq || !t || rt.mode !== 'song') return;
    const id = seq.songBlockAt(t.getPosition().tick)?.blockId ?? null;
    const i = id === null ? -1 : this.store.getState().arrangement.blocks.findIndex((b) => b.id === id);
    const songBlock = i >= 0 ? i : null;
    if (songBlock !== rt.songBlock || id !== rt.songBlockId) patchRuntime({ songBlock, songBlockId: id });
    this.syncSongLooping();
  }

  /**
   * Runtime `songLooping`: the song plays (or is paused) inside its loop and
   * will repeat it, as the sequencer has it at the playhead (false while it
   * plays towards the loop or on to its end, and whenever the song is not on).
   */
  private syncSongLooping(): void {
    const seq = this.sequencer;
    const t = this.transport;
    const rt = runtimeStore.getState();
    const looping = !!seq && !!t && rt.mode === 'song' && seq.mode.kind === 'song' && (seq.playing || seq.paused) && seq.songLoopingAt(t.getPosition().tick);
    if (looping !== rt.songLooping) patchRuntime({ songLooping: looping });
  }

  /**
   * A part whose playing (or armed) clip was deleted stops, so undo does not
   * silently resume it. Not in song mode: the empty slot is already silent
   * and the song replan switches the part off at once (Undo switches it back
   * on), while a stop queued here would outlast an Undo.
   */
  private stopPartsWithoutClip(p: Project): void {
    if (!this.sequencer || !this.transport || this.replayingId || this.sequencer.mode.kind === 'song') return;
    const rt = runtimeStore.getState().tracks;
    for (const t of p.tracks) {
      const slot = rt[t.id]?.playingSlot;
      if (slot === null || slot === undefined || t.clips[slot]) continue;
      this.transport.stopTrack(t.id);
      setTrackRuntime(t.id, { playingSlot: null, queued: null });
    }
  }

  /**
   * The live bank's loader: a recording it does not hold yet, read from
   * browser storage and decoded (one decode per id: a load already under way
   * for the project's samples is waited for). Null when there is none.
   */
  private async loadSampleForBank(bank: SampleBank, ctx: AudioContext, id: Id): Promise<AudioBuffer | null> {
    const pending = this.sampleLoads.get(id);
    if (pending) {
      await pending;
      return bank.get(id);
    }
    const rec = await db.getSample(id).catch(() => null);
    if (!rec) return null;
    const buffer = await ctx.decodeAudioData(await rec.blob.arrayBuffer());
    if (this.bank === bank) this.loadedSampleIds.add(id);
    return buffer;
  }

  /** Decode every sample the project uses into the bank (once per id). */
  private async loadProjectSamples(p: Project): Promise<void> {
    const bank = this.bank;
    const ctx = this.ctx;
    if (!bank || !ctx) return;
    const loads: Promise<void>[] = [];
    for (const meta of p.samples) {
      if (this.loadedSampleIds.has(meta.id)) continue;
      let job = this.sampleLoads.get(meta.id);
      if (!job) {
        job = (async () => {
          const rec = await db.getSample(meta.id).catch(() => null);
          if (!rec) {
            notify(`The recording "${meta.name}" is missing from this browser. Import the project file again to restore it.`, 'warn');
            return;
          }
          const buffer = await ctx.decodeAudioData(await rec.blob.arrayBuffer());
          bank.add(meta.id, buffer);
          // A bank discarded by a failed audio start does not count as loaded.
          if (this.bank === bank) this.loadedSampleIds.add(meta.id);
        })()
          .catch(() => notify(`The recording "${meta.name}" could not be decoded.`, 'warn'))
          .finally(() => {
            this.sampleLoads.delete(meta.id);
            // A sampler whose buffer just arrived must pick it up.
            if (this.engine && !this.replayingId) this.engine.setProject(this.store.getState());
          });
        this.sampleLoads.set(meta.id, job);
      }
      loads.push(job);
    }
    await Promise.all(loads);
  }

  /* ------------------------------------------------------------------ */
  /* Transport                                                           */
  /* ------------------------------------------------------------------ */

  get playing(): boolean {
    return !!this.transport?.playing;
  }

  /** Holding at a pause: Play continues from there (the live pads, the song or the replay). */
  get paused(): boolean {
    return !!this.transport?.paused;
  }

  /** Play: continue a pause from where it stopped, else start the lit pads from the top. */
  async play(): Promise<void> {
    if (!(await this.startAudio())) return;
    if (this.transport!.paused) {
      this.resumeFromPause();
      return;
    }
    if (this.replayingId) this.endReplay();
    this.armDefaultSceneIfIdle();
    this.transport!.start({ mode: { kind: 'live' }, countInBars: 0 });
    this.stallResume = null;
    patchRuntime({ playing: true, paused: false, mode: 'live', stalled: null, songBlock: null, songBlockId: null, songLooping: false });
    this.refreshLauncherRuntime();
    meterWake();
  }

  stop(): void {
    this.finishTake('stop');
    this.stopRecordNotes();
    // Stop releases every held note (keyboard, pads, arpeggio).
    this.releaseAllNotes();
    if (this.transport) this.transport.stop();
    if (this.replayingId) this.endReplay();
    this.stallResume = null;
    patchRuntime({ playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null, songLooping: false, countingIn: false, recordStartsAtTick: null });
    this.refreshLauncherRuntime();
  }

  /**
   * Pause: hold the bar and beat and every playing clip's phase (also in song
   * mode and during a replay); Play continues from exactly there. Held notes
   * are released. During Record Notes the pass ends first (one undo step).
   * Unavailable while a performance take records: a take cannot hold a pause
   * (Stop ends it).
   */
  pause(): void {
    const t = this.transport;
    if (!t?.playing) return;
    if (this.take) {
      notify(PAUSE_UNAVAILABLE_MESSAGE, 'warn');
      return;
    }
    this.stopRecordNotes();
    if (!t.pause()) {
      // The song or take had just reached its end: that is a stop.
      this.stop();
      return;
    }
    this.releaseAllNotes();
    this.stallResume = null;
    patchRuntime({ playing: false, paused: true, countingIn: false });
    this.syncSongLooping();
    this.refreshLauncherRuntime();
  }

  private resumeFromPause(): void {
    if (!this.transport?.resume()) return;
    this.stallResume = null;
    // The mode, song block and replay carry on as they were.
    patchRuntime({ playing: true, paused: false, stalled: null });
    this.syncSongLooping();
    this.refreshLauncherRuntime();
    meterWake();
  }

  /**
   * Space / the transport's Play: Pause while playing; otherwise continue a
   * pause (whatever was playing: the pads, the song or a replay), else start.
   * `song` (the Arrange view): a start plays the song, from the loop's first
   * block when a loop is set; with no block that can play, the pads.
   */
  async togglePlay(opts: { song?: boolean } = {}): Promise<void> {
    if (this.playing) {
      this.pause();
      return;
    }
    if (opts.song && !this.transport?.paused && songBlocks(this.store.getState()).length) await this.playSong();
    else await this.play();
  }

  /**
   * Loop part of the song: the blocks from `fromBlockId` to `toBlockId`
   * (inclusive, either way round, in the song's current order), or play it
   * through again (null). The session is the only owner of the loop
   * (runtime `songLoop`, never saved); views read it there. While the song
   * plays or is paused: with the playhead inside the new loop playback goes
   * on and loops at the loop's end; outside it, playback continues at the
   * loop's first block at the next bar line (on Resume when paused);
   * cleared, the song plays on to its end (see Sequencer.setSongLoop).
   * Edits keep it valid, and Undo of an edit that shrank it brings it back
   * (see songLoopAfterEdit, SongLoopHistory). Returns false (and changes
   * nothing) when a block it names is not in the song.
   */
  setSongLoop(range: SongLoop | null): boolean {
    const loop = range ? { fromBlockId: range.fromBlockId, toBlockId: range.toBlockId } : null;
    if (loop) {
      const ids = new Set(this.store.getState().arrangement.blocks.map((b) => b.id));
      if (!ids.has(loop.fromBlockId) || !ids.has(loop.toBlockId)) return false;
    }
    if (sameSongLoop(runtimeStore.getState().songLoop, loop)) return true;
    const t = this.transport;
    const changed = t ? t.setSongLoop(loop) : false;
    // After the transport: the song plan the views take on this change already has the loop.
    patchRuntime({ songLoop: loop });
    if (t) {
      this.syncSongBlock();
      if (changed) this.refreshLauncherRuntime();
    }
    return true;
  }

  /**
   * Play the arrangement from block `fromBlock`, or from bar `opts.fromBar`
   * (0-based, on the song timeline as the Arrange lane draws it); a start
   * before the end of the song loop plays into the loop, one after it plays
   * to the song's end. Neither given (Play song): from the loop's first
   * block when a loop is set, else from the first block.
   */
  async playSong(fromBlock?: number, opts: { fromBar?: number } = {}): Promise<void> {
    if (!(await this.startAudio())) return;
    this.finishTake('stop');
    this.stopRecordNotes();
    if (this.replayingId) this.endReplay();
    const p = this.store.getState();
    if (p.arrangement.blocks.length === 0) {
      notify('The arrangement is empty. Add scene blocks in Arrange first.', 'warn');
      return;
    }
    const fromBar = opts.fromBar;
    const fromTick = fromBar !== undefined && Number.isFinite(fromBar) ? Math.max(0, Math.floor(fromBar)) * TICKS_PER_BAR : undefined;
    let block = fromBlock ?? 0;
    if (fromBlock === undefined && fromTick === undefined) {
      const lane = songBlocks(p);
      const range = songLoopRange(lane, runtimeStore.getState().songLoop);
      if (range) block = lane[range[0]].index;
    }
    this.transport!.start({ mode: { kind: 'song', fromBlock: block }, fromTick });
    this.stallResume = null;
    // The block the song starts in (its 'block' event confirms it when it sounds).
    const at = this.transport!.getPosition().tick;
    const first = this.sequencer!.songPlan()?.find((b) => at < b.endTick);
    patchRuntime({ playing: true, paused: false, mode: 'song', songBlock: first ? first.index : block, songBlockId: first?.blockId ?? null, stalled: null });
    this.syncSongLooping();
    this.refreshLauncherRuntime();
    meterWake();
  }

  /**
   * Play with nothing armed would only run the bar counter. Arm a scene so
   * Play is always audible: a starter's core groove row, else the row with
   * the most clips.
   */
  private armDefaultSceneIfIdle(): void {
    const seq = this.sequencer;
    const p = this.store.getState();
    if (!seq || !this.transport) return;
    if (p.tracks.some((t) => {
      const st = seq.getTrackState(t.id);
      return st.playing !== null || (st.queued !== null && st.queued.slot !== null);
    })) return;
    const counts = p.scenes.map((_, row) => p.tracks.filter((t) => t.clips[row]).length);
    const row = p.starterId && counts[JUMP_IN_SCENE_ROW] > 0 ? JUMP_IN_SCENE_ROW : counts.indexOf(Math.max(...counts));
    if (row < 0 || counts[row] === 0) return;
    this.transport.launchScene(row);
    this.selectRow(row);
  }

  /** Point every part's edit slot at the row just launched (Steps, Record Notes, Variation follow it). */
  private selectRow(row: number): void {
    const p = this.store.getState();
    if (!Number.isInteger(row) || row < 0 || row >= sceneCount(p)) return;
    for (const t of p.tracks) if (t.clips[row]) selectSlot(t.id, row);
  }

  /**
   * Resume after a stall: start the same thing again. The live pads resume
   * with the same clips, the song from the block that was playing (from the
   * block taking over, when the playing one had just been deleted; with a
   * song loop, inside the loop: from its first block when that block lies
   * outside it), and a replayed take from its start.
   */
  async resumeAfterStall(): Promise<void> {
    const resume = this.stallResume;
    this.stallResume = null;
    patchRuntime({ stalled: null });
    // Playback was started again another way meanwhile (e.g. Record Notes): only the banner goes.
    if (this.transport?.playing) return;
    const replayId = resume?.mode === 'replay' ? resume.replayId : null;
    if (resume?.mode === 'song') {
      // The block where it stopped, found by id (blocks may have moved meanwhile).
      const p = this.store.getState();
      const blocks = p.arrangement.blocks;
      const byId = resume.songBlockId ? blocks.findIndex((b) => b.id === resume.songBlockId) : -1;
      let block = byId >= 0 ? byId : Math.min(resume.songBlock ?? 0, Math.max(0, blocks.length - 1));
      const lane = songBlocks(p);
      const range = songLoopRange(lane, runtimeStore.getState().songLoop);
      const at = lane.findIndex((b) => b.index === block);
      if (range && (at < range[0] || at > range[1])) block = lane[range[0]].index;
      await this.playSong(block);
    }
    else if (replayId && this.store.getState().performances.some((p) => p.id === replayId)) await this.replayPerformance(replayId);
    else await this.play();
  }

  private stopEverything(): void {
    if (this.transport) this.stop();
    this.releaseAllNotes();
  }

  /** Set runtime pad state from the sequencer (after start/stop/load). */
  private refreshLauncherRuntime(): void {
    const seq = this.sequencer;
    const p = this.store.getState();
    for (const t of p.tracks) {
      if (!seq) {
        setTrackRuntime(t.id, { playingSlot: null, queued: null });
        continue;
      }
      const st = seq.getTrackState(t.id);
      setTrackRuntime(t.id, { playingSlot: st.playing?.slot ?? null, queued: st.queued ? { slot: st.queued.slot, atTick: st.queued.atTick } : null });
    }
  }

  private resetRuntimeTracks(): void {
    const p = this.store.getState();
    for (const t of p.tracks) setTrackRuntime(t.id, { playingSlot: null, queued: null });
    if (this.sequencer) {
      // A new project: clear the launcher (armed clips of the old project do not apply).
      for (const t of p.tracks) {
        const st = this.sequencer.getTrackState(t.id);
        if (st.playing || st.queued) this.sequencer.stopTrack(t.id, this.ctx!.currentTime);
      }
      this.refreshLauncherRuntime();
      for (const t of p.tracks) setTrackRuntime(t.id, { playingSlot: null, queued: null });
    }
  }

  private currentTick(): number {
    return this.transport && this.transport.playing ? this.transport.getPosition().tick : 0;
  }

  /** Tap a clip pad: start it (next bar), or stop it if it is already playing. */
  async pressClip(trackId: Id, slot: number): Promise<void> {
    if (this.replayingId) return;
    if (!(await this.startAudio())) return;
    const p = this.store.getState();
    const track = p.tracks.find((t) => t.id === trackId);
    if (!track?.clips[slot]) return;
    const rt = runtimeStore.getState().tracks[trackId];
    const wasPlaying = this.transport!.playing;
    if (this.transport!.paused && rt?.playingSlot === slot && (!rt.queued || rt.queued.slot === slot)) {
      // The clip that holds at the pause: tapping it continues playback, in phase.
      selectSlot(trackId, slot);
      await this.play();
      return;
    }
    // Paused, another clip queues for the next bar after the pause point and playback continues.
    let res: LaunchResult;
    if (wasPlaying && rt?.playingSlot === slot && (!rt.queued || rt.queued.slot === slot)) {
      res = this.transport!.stopTrack(trackId);
      this.recordEvent({ t: this.currentTick(), type: 'launch', trackId, slot: null, atTick: res.atTick });
    } else {
      res = this.transport!.launchClip(trackId, slot);
      this.recordEvent({ t: this.currentTick(), type: 'launch', trackId, slot, atTick: res.atTick });
    }
    selectSlot(trackId, slot);
    if (!wasPlaying) await this.play();
    else this.applyLaunchResults([res]);
  }

  async launchScene(row: number): Promise<void> {
    if (this.replayingId) return;
    // Scenes are the project's rows (1 to 8 of them).
    if (!Number.isInteger(row) || row < 0 || row >= sceneCount(this.store.getState())) return;
    if (!(await this.startAudio())) return;
    if (row >= sceneCount(this.store.getState())) return;
    const wasPlaying = this.transport!.playing;
    const results = this.transport!.launchScene(row);
    this.selectRow(row);
    this.recordEvent({ t: this.currentTick(), type: 'scene', row, atTick: results[0]?.atTick ?? 0 });
    if (!wasPlaying) await this.play();
    else this.applyLaunchResults(results);
  }

  stopTrack(trackId: Id): void {
    if (!this.transport || this.replayingId) return;
    const res = this.transport.stopTrack(trackId);
    this.recordEvent({ t: this.currentTick(), type: 'launch', trackId, slot: null, atTick: res.atTick });
    if (this.transport.playing) this.applyLaunchResults([res]);
    else this.refreshLauncherRuntime();
  }

  /** Stop every part at the next bar (the transport keeps running). */
  stopAllClips(): void {
    if (!this.transport || this.replayingId) return;
    const results = this.transport.stopAll();
    this.recordEvent({ t: this.currentTick(), type: 'stopAll', atTick: results[0]?.atTick ?? 0 });
    if (this.transport.playing) this.applyLaunchResults(results);
    else this.refreshLauncherRuntime();
  }

  private applyLaunchResults(results: readonly LaunchResult[]): void {
    for (const r of results) {
      const cur = runtimeStore.getState().tracks[r.trackId] ?? { playingSlot: null, queued: null };
      if (cur.playingSlot === r.slot && r.slot !== null) {
        // Re-launching the playing clip restarts it at the next bar.
        setTrackRuntime(r.trackId, { playingSlot: cur.playingSlot, queued: { slot: r.slot, atTick: r.atTick } });
      } else if (cur.playingSlot === null && r.slot === null) {
        setTrackRuntime(r.trackId, { playingSlot: null, queued: null });
      } else {
        setTrackRuntime(r.trackId, { playingSlot: cur.playingSlot, queued: { slot: r.slot, atTick: r.atTick } });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Recordable edits                                                    */
  /* ------------------------------------------------------------------ */

  setMacro(trackId: Id, macro: MacroId, value: number, gesture?: string): void {
    const r = cmd.setMacro(this.store, trackId, macro, value, gesture);
    if (this.accepted(r)) this.recordControl(`macro:${trackId}:${macro}`, { t: this.currentTick(), type: 'macro', trackId, macro, value });
  }

  setModuleParam(moduleId: Id, param: string, value: number, gesture?: string): void {
    const r = cmd.setModuleParam(this.store, moduleId, param, value, gesture);
    if (this.accepted(r)) this.recordControl(`param:${moduleId}:${param}`, { t: this.currentTick(), type: 'param', module: moduleId, param, value });
  }

  setInstrumentParam(trackId: Id, param: string, value: number, gesture?: string): void {
    const track = this.store.getState().tracks.find((t) => t.id === trackId);
    const r = track?.instrument.kind === 'sampler' ? cmd.setSamplerParam(this.store, trackId, param, value, gesture) : cmd.setInstrumentParam(this.store, trackId, param, value, gesture);
    if (this.accepted(r)) this.recordControl(`param:${trackId}:inst:${param}`, { t: this.currentTick(), type: 'param', module: `${trackId}:inst`, param, value });
  }

  setMute(trackId: Id, mute: boolean): void {
    const r = cmd.setMute(this.store, trackId, mute);
    if (this.accepted(r)) this.recordEvent({ t: this.currentTick(), type: 'mute', trackId, mute });
  }

  /**
   * Move a clip onto another pad (onto an occupied pad the two swap), or copy
   * it there (`copy`; onto an occupied pad it replaces that clip). One undo
   * step each, with a notice that says what happened. Refused across parts of
   * a different kind (drum steps and melodic notes), during a performance take
   * (clips are locked) and while Record Notes records (the pass is one undo
   * step of its own). Playback follows as `followMovedClips` describes.
   */
  moveClip(from: { trackId: Id; slot: number }, to: { trackId: Id; slot: number }, copy = false): boolean {
    if (this.noteRec) {
      notify(`Stop recording notes first, then ${copy ? 'copy' : 'move'} clips.`, 'warn');
      return false;
    }
    const p = this.store.getState();
    const src = p.tracks.find((t) => t.id === from.trackId);
    const dst = p.tracks.find((t) => t.id === to.trackId);
    const clip = src?.clips[from.slot];
    if (!src || !dst || !clip) return false;
    const replaced = dst.clips[to.slot] ?? null;
    const where = `${dst.name} · ${p.scenes[to.slot]?.name ?? `row ${to.slot + 1}`}`;
    const run = runtimeStore.getState();
    const rt = run.tracks[from.trackId];
    const wasPlaying = !copy && from.trackId !== to.trackId && (run.playing || run.paused) && (rt?.playingSlot === from.slot || rt?.queued?.slot === from.slot);
    const r = copy ? cmd.copyClipTo(this.store, from.trackId, from.slot, to.trackId, to.slot) : cmd.moveClip(this.store, from.trackId, from.slot, to.trackId, to.slot);
    if (!this.accepted(r)) return false;
    selectTrack(to.trackId);
    selectSlot(to.trackId, to.slot);
    let text: string;
    if (copy) text = replaced ? `Copied “${clip.name}” onto ${where}, replacing “${replaced.name}”.` : `Copied “${clip.name}” to ${where}.`;
    else text = replaced ? `Swapped “${clip.name}” and “${replaced.name}”.` : `Moved “${clip.name}” to ${where}.`;
    if (wasPlaying) text += ` ${src.name} stopped playing it; tap the pad to play it on ${dst.name}.`;
    notify(text, 'info', 'undo', this.store.undoEntryId());
    return true;
  }

  /** Move a scene row (every part's clip in it moves along), one undo step; song blocks keep their scenes. */
  moveScene(fromRow: number, toRow: number): boolean {
    if (this.noteRec) {
      notify('Stop recording notes first, then move scenes.', 'warn');
      return false;
    }
    const before = this.store.getState();
    const count = sceneCount(before);
    if (!Number.isInteger(fromRow) || !Number.isInteger(toRow) || fromRow < 0 || toRow < 0 || fromRow >= count || toRow >= count) return false;
    const scene = before.scenes[fromRow];
    if (!scene) return false;
    // Each part's chosen clip stays the same clip (followScenes, also on undo and redo).
    const r = cmd.moveScene(this.store, fromRow, toRow);
    if (!this.accepted(r)) return false;
    notify(`Moved the scene “${scene.name}” to row ${toRow + 1}; its clips moved with it.`, 'info', 'undo', this.store.undoEntryId());
    return true;
  }

  /** Solo a part (not part of a performance take: the take lock refuses it, with the reason). */
  setSolo(trackId: Id, solo: boolean): void {
    this.accepted(cmd.setSolo(this.store, trackId, solo));
  }

  /** M: mute or unmute a part. */
  toggleMute(trackId: Id): void {
    const t = this.store.getState().tracks.find((x) => x.id === trackId);
    if (t) this.setMute(trackId, !t.mute);
  }

  /** S: solo a part, or stop soloing it. */
  toggleSolo(trackId: Id): void {
    const t = this.store.getState().tracks.find((x) => x.id === trackId);
    if (t) this.setSolo(trackId, !t.solo);
  }

  setBpm(bpm: number, gesture?: string): void {
    const r = cmd.setBpm(this.store, bpm, gesture);
    if (this.accepted(r)) this.recordControl('tempo', { t: this.currentTick(), type: 'tempo', bpm: this.store.getState().bpm });
  }

  setSwing(swing: number, gesture?: string): void {
    const r = cmd.setSwing(this.store, swing, gesture);
    if (this.accepted(r)) this.recordControl('swing', { t: this.currentTick(), type: 'swing', swing: this.store.getState().swing });
  }

  setMasterVolume(volumeDb: number, gesture?: string): void {
    const r = cmd.setMasterVolume(this.store, volumeDb, gesture);
    if (this.accepted(r)) this.recordControl('master', { t: this.currentTick(), type: 'master', volumeDb: this.store.getState().masterVolumeDb });
  }

  /**
   * Mute All: silence everything now, including held notes and effect tails.
   * It also ends a performance take there (keeping what came before): a take
   * cannot hold the silence, so its replay and export would play on.
   */
  setMuteAll(muted: boolean): void {
    if (muted) {
      this.finishTake('muted');
      this.releaseAllNotes();
    }
    this.engine?.setMuteAll(muted);
    patchRuntime({ muteAll: muted });
  }

  toggleMuteAll(): void {
    this.setMuteAll(!runtimeStore.getState().muteAll);
  }

  /** True when an edit went through; reports refusals (take lock, invalid input) to the user. */
  accepted(r: cmd.CommandResult): boolean {
    if (r.refused) notify(r.refused, 'warn');
    else if (!r.changed && r.message) notify(r.message, 'warn');
    return r.changed;
  }

  /** Undo the newest edit; the message says what was undone, with Redo. */
  undo(): void {
    const label = this.store.undoLabel();
    if (this.stepHistory(() => this.store.undo())) notify(`Undid: ${label}`, 'info', 'redo', this.store.redoEntryId());
  }

  /** Redo the edit undone last; the message says what was redone, with Undo. */
  redo(): void {
    const label = this.store.redoLabel();
    if (this.stepHistory(() => this.store.redo())) notify(`Redid: ${label}`, 'info', 'undo', this.store.undoEntryId());
  }

  /** Undo or redo (true when it went through). During a take the values it changes are heard at once, so the take records them. */
  private stepHistory(step: () => ApplyResult): boolean {
    const before = this.store.getState();
    const r = step();
    if (r.refused) notify(r.refused, 'warn');
    else if (r.changed && this.take) this.recordChangedValues(before, this.store.getState());
    return r.changed;
  }

  /**
   * Record what an undo or redo changed during a take, as if the knob had
   * been moved there. The take's lock only lets through steps that change
   * such values (isRecordablePath), so nothing else can differ.
   */
  private recordChangedValues(prev: Project, next: Project): void {
    const t = this.currentTick();
    if (next.bpm !== prev.bpm) this.recordControl('tempo', { t, type: 'tempo', bpm: next.bpm });
    if (next.swing !== prev.swing) this.recordControl('swing', { t, type: 'swing', swing: next.swing });
    if (next.masterVolumeDb !== prev.masterVolumeDb) this.recordControl('master', { t, type: 'master', volumeDb: next.masterVolumeDb });
    const params = (module: Id, now: Readonly<Record<string, number>>, was: Readonly<Record<string, number>>) => {
      if (now === was) return;
      for (const param of new Set([...Object.keys(now), ...Object.keys(was)])) {
        if (now[param] === was[param]) continue;
        // A value the undo removed is back to its default.
        const value = now[param] ?? specById(specsForModule(next, module), param)?.default;
        if (value !== undefined) this.recordControl(`param:${module}:${param}`, { t, type: 'param', module, param, value });
      }
    };
    next.tracks.forEach((track, i) => {
      const was = prev.tracks[i];
      if (!was || was === track || was.id !== track.id) return;
      if (track.mute !== was.mute) this.recordEvent({ t, type: 'mute', trackId: track.id, mute: track.mute });
      for (const m of MACRO_IDS) {
        if (track.macros[m] !== was.macros[m]) this.recordControl(`macro:${track.id}:${m}`, { t, type: 'macro', trackId: track.id, macro: m, value: track.macros[m] });
      }
      params(`${track.id}:inst`, track.instrument.params, was.instrument.params);
    });
    next.patch.modules.forEach((mod, i) => {
      const was = prev.patch.modules[i];
      if (was && was.id === mod.id) params(mod.id, mod.params, was.params);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Live notes                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Play a note on a part. `rawPitch` is the key pressed (MIDI, or drum pad
   * index); Musical Assist snaps synth notes into the project scale. Drums,
   * samplers (a recording keeps its pitch unless its own Pitch is changed),
   * chord pads (their chord is already in the key) and previews play exactly
   * the key given.
   */
  noteOn(trackId: Id, rawPitch: number, velocity: number, source: NoteSource): void {
    if (this.replayingId) return;
    const key = `${source}:${trackId}:${rawPitch}`;
    if (!this.engine) {
      // The first touch also starts audio: keep that note and play it once the engine is ready.
      if (this.pendingKeys.has(key)) return;
      const pending = { released: false };
      this.pendingKeys.set(key, pending);
      void this.startAudio().then((ok) => {
        if (this.pendingKeys.get(key) !== pending) return;
        this.pendingKeys.delete(key);
        if (!ok || !this.engine) return;
        this.noteOn(trackId, rawPitch, velocity, source);
        if (pending.released) setTimeout(() => this.noteOff(trackId, rawPitch, source), 180);
      });
      return;
    }
    const p = this.store.getState();
    const track = p.tracks.find((t) => t.id === trackId);
    if (!track) return;
    if (this.held.has(key)) this.noteOff(trackId, rawPitch, source);
    // A fade-out that Stop is still bringing back up: a live note is heard at its level.
    this.transport?.restoreSongGain();
    meterWake();
    const kind = track.instrument.kind;
    const preview = source === 'preview';
    const exact = preview || source === 'chord' || kind === 'drums' || kind === 'sampler';
    const pitch = !exact && p.assist ? snapToScale(rawPitch, p.root, p.scale) : rawPitch;
    const v = Math.max(0.05, Math.min(1, velocity));
    const viaArp = track.arp.enabled && kind !== 'drums' && !preview;
    const note: HeldNote = { trackId, pitch, velocity: v, viaArp, recTick: null, recPressTick: null, recClipStart: null };
    // Record Notes keeps a played key as a note. With the arpeggiator on, the
    // notes it plays are recorded instead (recordArpNote), not the key held.
    if (!preview && !viaArp && this.noteRec && this.noteRec.trackId === trackId && this.transport?.playing) {
      const pressed = this.recordingTick();
      const at = this.recordWindow(this.noteRec, pressed);
      if (at) {
        note.recTick = at.tick;
        note.recPressTick = pressed;
        note.recClipStart = at.loopStart;
      }
    }
    this.held.set(key, note);
    if (viaArp) {
      this.transport?.setArpHeld(trackId, this.heldPitches(trackId, true), v);
    } else {
      this.engine.liveNoteOn(trackId, pitch, v, key);
    }
    if (!preview) this.recordEvent({ t: this.currentTick(), type: 'noteOn', trackId, pitch, velocity: v, key });
    this.publishHeld(trackId);
  }

  noteOff(trackId: Id, rawPitch: number, source: NoteSource): void {
    const key = `${source}:${trackId}:${rawPitch}`;
    const pending = this.pendingKeys.get(key);
    if (pending) pending.released = true;
    const note = this.held.get(key);
    if (!note) return;
    this.held.delete(key);
    // Released where it was pressed: the arpeggiator switched on or off meanwhile changes nothing.
    if (note.viaArp) this.transport?.setArpHeld(trackId, this.heldPitches(trackId, true));
    else this.engine?.liveNoteOff(trackId, key);
    if (source !== 'preview') this.recordEvent({ t: this.currentTick(), type: 'noteOff', trackId, pitch: note.pitch, key });
    if (note.recTick !== null && note.recClipStart !== null && this.noteRec) this.commitRecordedNote(note);
    this.publishHeld(trackId);
  }

  /**
   * Preview a note on a part (editors, sound browser): plays exactly `pitch`
   * (no Musical Assist, no arpeggiator) and is never recorded.
   */
  audition(trackId: Id, pitch: number, velocity = 0.8, ms = 320): void {
    const play = () => {
      if (!this.engine) return;
      this.transport?.restoreSongGain();
      meterWake();
      this.auditionCounter += 1;
      const key = `audition:${trackId}:${pitch}:${this.auditionCounter}`;
      this.engine.liveNoteOn(trackId, pitch, Math.max(0.05, Math.min(1, velocity)), key);
      setTimeout(() => this.engine?.liveNoteOff(trackId, key), Math.max(40, ms));
    };
    if (this.engine) play();
    else void this.startAudio().then((ok) => ok && play());
  }

  /** Release every held note (window blur, pointer cancel, input change, Stop, Mute All). */
  releaseAllNotes(): void {
    for (const p of this.pendingKeys.values()) p.released = true;
    const keys = [...this.held.keys()];
    for (const key of keys) {
      const n = this.held.get(key)!;
      const [source, , raw] = key.split(':');
      this.noteOff(n.trackId, Number(raw), source as NoteSource);
    }
    this.engine?.releaseLive();
    // A replayed take drives the arpeggiator itself (live keys are off then): it plays on.
    if (this.transport && !this.replayingId) for (const t of this.store.getState().tracks) this.transport.setArpHeld(t.id, []);
    patchRuntime({ held: {} });
    for (const fn of [...this.releaseListeners]) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
  }

  /**
   * Be told when every held note is let go of at once (Stop, Pause, Mute All,
   * window blur, a stall, a replay or another project starting), so outside
   * note sources (MIDI) can forget their keys and pedal-held notes too.
   */
  onAllNotesReleased(fn: () => void): () => void {
    this.releaseListeners.add(fn);
    return () => {
      this.releaseListeners.delete(fn);
    };
  }

  /**
   * Hold back Record Performance and Record Notes while `why` returns a
   * reason (shown to the user), e.g. while a finished audio take is being
   * saved: the take's lock or the notes' undo step would catch it.
   */
  addRecordGuard(why: () => string | null): () => void {
    this.recordGuards.add(why);
    return () => {
      this.recordGuards.delete(why);
    };
  }

  /** Why a recording cannot start right now (told to the user), or null. */
  private recordingHeldBack(): string | null {
    for (const why of this.recordGuards) {
      const reason = why();
      if (reason) {
        notify(reason, 'warn');
        return reason;
      }
    }
    return null;
  }

  /**
   * Bend a part's playing and future notes by `cents` (MIDI pitch wheel), now.
   * 0 = centred. Ignored during a replay (the take plays as recorded).
   */
  setPitchBend(trackId: Id, cents: number): void {
    if (!this.engine || !this.ctx || this.replayingId) return;
    this.engine.setPitchBend(trackId, Number.isFinite(cents) ? cents : 0, this.ctx.currentTime);
  }

  /** Pitches held on a part; `forArp`: only the keys that went to the arpeggiator. */
  private heldPitches(trackId: Id, forArp = false): number[] {
    const out: number[] = [];
    for (const n of this.held.values()) if (n.trackId === trackId && (!forArp || n.viaArp) && !out.includes(n.pitch)) out.push(n.pitch);
    return out;
  }

  private publishHeld(trackId: Id): void {
    const s = runtimeStore.getState();
    patchRuntime({ held: { ...s.held, [trackId]: this.heldPitches(trackId) } });
  }

  /* ------------------------------------------------------------------ */
  /* Record Notes                                                        */
  /* ------------------------------------------------------------------ */

  get recordingNotes(): boolean {
    return this.noteRec !== null;
  }

  /**
   * Musical position the player meant: what they heard when they played,
   * so the output delay (outputDelaySeconds: the device's and the engine's
   * latency, as for every visual playhead) is taken off the audio clock.
   */
  private recordingTick(): number {
    const ctx = this.ctx!;
    const seq = this.sequencer!;
    return seq.tickAt(ctx.currentTime - outputDelaySeconds(ctx, this.engine as AudioEngine & { outputLatencyFrames?: () => number }));
  }

  /**
   * Where Record Notes writes a note played at `tick` (see recordedNoteAt):
   * while its clip sounds, from the clip's loop start; up to an 8th before the
   * recording starts, on its downbeat; in the song, a block that does not
   * play the clip still records into it. Null: not recorded.
   */
  private recordWindow(rec: NoteRecording, tick: number): { tick: number; loopStart: number } | null {
    const seq = this.sequencer;
    if (!seq) return null;
    const song = runtimeStore.getState().mode === 'song';
    return recordedNoteAt({
      tick,
      playing: seq.playingAt(rec.trackId, tick),
      slot: rec.slot,
      // Kept after the downbeat: a note heard a moment before it (latency) still lands on it.
      startsAt: rec.startsAt,
      lastLoopStart: song ? rec.lastLoopStart : null,
    });
  }

  /**
   * Record Notes into the selected part's selected clip (a new 2-bar clip is
   * created in an empty slot). Starts playback if needed (with the one-bar
   * count-in when that option is on); a selected clip that is not the one
   * playing starts at the next bar, and recording begins there. With the
   * part's arpeggiator on, the notes the arpeggiator plays are recorded.
   */
  async toggleRecordNotes(): Promise<void> {
    if (this.noteRec) {
      this.stopRecordNotes();
      return;
    }
    if (this.take) {
      notify('Finish the performance recording first.', 'warn');
      return;
    }
    if (this.recordingHeldBack()) return;
    if (!(await this.startAudio())) return;
    // Again: a take may have started saving meanwhile (from here on nothing waits).
    if (this.recordingHeldBack()) return;
    const ui = uiStore.getState();
    const trackId = ui.selectedTrackId;
    const p = this.store.getState();
    const track = p.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const rt = runtimeStore.getState();
    const playingSlot = rt.tracks[trackId]?.playingSlot ?? null;
    const chosen = ui.selectedSlot[trackId] as number | undefined;
    // On the live pads the clip selected on the part (Steps, a pad tap or a scene launch choose it), else the one it plays.
    const slot = rt.mode === 'live' && chosen !== undefined ? chosen : (playingSlot ?? slotFor(ui, trackId));
    // The whole pass (a new clip, its notes, knob moves made meanwhile) is one undo step.
    this.store.beginGroup('Record notes');
    if (!track.clips[slot]) {
      const bars: ClipBars = track.instrument.kind === 'drums' ? 1 : 2;
      cmd.createClip(this.store, trackId, slot, bars, 'Take');
    }
    selectSlot(trackId, slot);
    const seq = this.sequencer!;
    // The clip heard now (the scheduler may already be past a switch that is not heard yet).
    const heard = this.transport!.playing ? seq.playingAt(trackId, this.transport!.audibleTick()) : null;
    const rec: NoteRecording = { trackId, slot, gesture: uid('rec'), added: 0, arpNotes: [], arpFlush: null, lastLoopStart: heard?.slot === slot ? heard.startTick : null, inaudibleTold: false, startsAt: null };
    this.noteRec = rec;
    patchRuntime({ recording: 'notes', recordTarget: { trackId, slot }, recordTargetAudible: true, recordStartsAtTick: null });
    const seqState = seq.getTrackState(trackId);
    // Where recording starts when it waits for it: the clip's launch at the next bar, or bar 1 after a count-in.
    let startsAt: number | null = null;
    if (this.transport!.paused) {
      // Paused: playback continues from the pause (no count-in); another clip starts at the next bar.
      if (seqState.playing?.slot !== slot) startsAt = this.transport!.launchClip(trackId, slot).atTick;
      this.resumeFromPause();
    } else if (!this.transport!.playing) {
      if (seqState.playing?.slot !== slot) this.transport!.launchClip(trackId, slot);
      const countIn = p.settings.countIn ? 1 : 0;
      this.transport!.start({ mode: { kind: 'live' }, countInBars: countIn });
      if (countIn > 0) startsAt = 0;
      patchRuntime({ playing: true, paused: false, mode: 'live', countingIn: countIn > 0, stalled: null });
      this.refreshLauncherRuntime();
    } else if (seqState.playing?.slot !== slot || heard?.slot !== slot) {
      const r = seqState.playing?.slot !== slot ? this.transport!.launchClip(trackId, slot) : null;
      if (r) this.applyLaunchResults([r]);
      startsAt = r ? r.atTick : (seq.queuedAtTick(trackId, this.transport!.audibleTick()) ?? null);
    }
    rec.startsAt = startsAt;
    if (startsAt !== null) patchRuntime({ recordStartsAtTick: startsAt });
    meterWake();
  }

  /**
   * Make sure the live pads are playing for an audio recording: continue a
   * pause (no count-in, as Record Notes does), or start from bar 1 with the
   * lit clips (a default scene when nothing is lit) after `countInBars` bars
   * of count-in. Already playing: nothing changes. False when audio cannot
   * start or a song or replay is playing (recordings follow the live pads).
   */
  async startPlaybackForRecording(countInBars: number): Promise<boolean> {
    if (!(await this.startAudio())) return false;
    const t = this.transport!;
    if (t.playing || t.paused) {
      if (this.replayingId || runtimeStore.getState().mode !== 'live') return false;
      if (t.paused) this.resumeFromPause();
      return true;
    }
    this.armDefaultSceneIfIdle();
    const countIn = Math.max(0, Math.min(4, Math.round(countInBars)));
    t.start({ mode: { kind: 'live' }, countInBars: countIn });
    this.stallResume = null;
    patchRuntime({ playing: true, paused: false, mode: 'live', songBlock: null, songBlockId: null, countingIn: countIn > 0, stalled: null });
    this.refreshLauncherRuntime();
    return true;
  }

  stopRecordNotes(): void {
    if (!this.noteRec) return;
    // Notes still held are committed with their length so far, and arpeggio notes already played.
    for (const n of this.held.values()) if (n.recTick !== null) this.commitRecordedNote(n);
    this.flushArpNotes();
    const added = this.noteRec.added;
    this.noteRec = null;
    this.store.endGroup();
    const done = { recordTarget: null, recordStartsAtTick: null, recordTargetAudible: true } as const;
    if (runtimeStore.getState().recording === 'notes') patchRuntime({ recording: 'off', ...done });
    else patchRuntime(done);
    if (added > 0) notify(`Recorded ${added} note${added === 1 ? '' : 's'} into the clip. Undo removes the whole pass, with any knob moves made during it.`, 'info', 'undo', this.store.undoEntryId());
  }

  private commitRecordedNote(n: HeldNote): void {
    if (!this.noteRec || n.recTick === null || n.recClipStart === null) return;
    // As long as it was held: a note caught early moves to the downbeat with its whole length.
    const duration = Math.max(MIN_RECORDED_TICKS, this.recordingTick() - (n.recPressTick ?? n.recTick));
    this.addRecordedNote(n.recTick - n.recClipStart, n.pitch, n.velocity, duration, this.store.getState().settings.recordQuantize);
    n.recTick = null;
  }

  /**
   * Record Notes on a part whose arpeggiator plays: each note it plays goes
   * into the clip where it sounded, as long as it sounded (called when the
   * audio clock reaches it). They already sit on the arpeggiator's grid, so
   * Record Notes timing does not move them (it would pull triplets and fast
   * rates onto its own grid).
   */
  private recordArpNote(ev: NoteEvent): void {
    const rec = this.noteRec;
    if (!rec || ev.trackId !== rec.trackId || !this.sequencer) return;
    const at = this.sequencer.playingAt(ev.trackId, ev.tick);
    let loopStart: number;
    // While the recorded clip plays, from its first downbeat (not during the count-in) …
    if (at && at.slot === rec.slot && ev.tick >= at.startTick) loopStart = at.startTick;
    // … or, in the song, in a block that does not play it, where its loop would be.
    else if (runtimeStore.getState().mode === 'song' && rec.lastLoopStart !== null && ev.tick >= rec.lastLoopStart) loopStart = rec.lastLoopStart;
    else return;
    const clip = this.store.getState().tracks.find((t) => t.id === rec.trackId)?.clips[rec.slot];
    const len = clip ? clip.bars * TICKS_PER_BAR : Infinity;
    rec.arpNotes.push({ tick: (ev.tick - loopStart) % len, pitch: ev.pitch, velocity: ev.velocity, duration: ev.durationTicks });
    rec.arpFlush ??= setTimeout(() => this.flushArpNotes(), ARP_RECORD_BATCH_MS);
  }

  /** Write the arpeggio notes played so far into the clip (one store edit, part of the take's undo step). */
  private flushArpNotes(): void {
    const rec = this.noteRec;
    if (!rec) return;
    if (rec.arpFlush !== null) clearTimeout(rec.arpFlush);
    rec.arpFlush = null;
    const notes = rec.arpNotes.splice(0);
    // A clip deleted meanwhile is not made again.
    if (!notes.length || !this.store.getState().tracks.find((t) => t.id === rec.trackId)?.clips[rec.slot]) return;
    const r = cmd.addRecordedNotes(this.store, rec.trackId, rec.slot, notes, { quantize: 'off', mode: 'overdub', gesture: rec.gesture });
    if (r.changed) rec.added += r.added ?? notes.length;
  }

  /** Overdub one note into the clip being recorded; `tick` counts from the clip's loop start (wrapped into the loop). */
  private addRecordedNote(tick: number, pitch: number, velocity: number, duration: number, quantize: QuantizeGrid): void {
    const rec = this.noteRec;
    if (!rec) return;
    const clip = this.store.getState().tracks.find((t) => t.id === rec.trackId)?.clips[rec.slot];
    if (!clip) return;
    const len = clip.bars * TICKS_PER_BAR;
    let local = tick % len;
    if (local < 0) local += len;
    const r = cmd.addRecordedNotes(this.store, rec.trackId, rec.slot, [{ tick: local, pitch, velocity, duration: Math.min(duration, len) }], { quantize, mode: 'overdub', gesture: rec.gesture });
    if (r.changed) rec.added += 1;
  }

  /* ------------------------------------------------------------------ */
  /* Record Performance                                                  */
  /* ------------------------------------------------------------------ */

  get recordingPerformance(): boolean {
    return this.take !== null;
  }

  async togglePerformance(): Promise<void> {
    if (this.take) {
      this.finishTake('button');
      return;
    }
    if (runtimeStore.getState().muteAll) {
      // A take cannot hold the silence: its replay and export would play at full level.
      notify('Mute All is on. Turn it off to record a performance.', 'warn');
      return;
    }
    if (this.recordingHeldBack()) return;
    if (this.noteRec) this.stopRecordNotes();
    if (!(await this.startAudio())) return;
    // Again: a take may have started saving meanwhile (from here on nothing waits).
    if (this.recordingHeldBack()) return;
    if (this.replayingId) this.stop();
    if (this.transport!.paused) {
      if (runtimeStore.getState().mode !== 'live') {
        notify('Performances record live pad playing. Stop the song first.', 'warn');
        return;
      }
      // The take starts where the pause continues, with the pads as they were.
      this.resumeFromPause();
    } else if (!this.transport!.playing) {
      this.transport!.start({ mode: { kind: 'live' } });
      patchRuntime({ playing: true, paused: false, mode: 'live', stalled: null });
      this.refreshLauncherRuntime();
    } else if (runtimeStore.getState().mode !== 'live') {
      notify('Performances record live pad playing. Stop the song first.', 'warn');
      return;
    }
    const startTick = Math.max(0, this.transport!.getPosition().tick);
    const project = this.store.getState();
    this.take = {
      startTick,
      snapshot: makeSnapshot(project, this.sequencer!.getLauncherSnapshot(), startTick),
      events: [],
      lastControlTime: new Map(),
    };
    this.seedTake(this.take, project);
    this.store.setLock(TAKE_LOCK_MESSAGE, isRecordableLabel, isRecordablePath);
    patchRuntime({ recording: 'performance' });
  }

  /**
   * Keys already down when a take starts belong in it: notes that keep
   * sounding while held, and the arpeggiator's input (keys held, and notes
   * kept by Latch), are written at the take's start, so the replay starts
   * with the same sound. (A replayed pattern counts its steps from there.)
   * A drum hit or a one-shot recording already played before the take and
   * is left out.
   */
  private seedTake(take: Take, project: Project): void {
    const seq = this.sequencer;
    if (!seq) return;
    const t = take.startTick;
    const on = (trackId: Id, pitch: number, velocity: number, key: string) => take.events.push({ t, type: 'noteOn', trackId, pitch, velocity, key });
    for (const track of project.tracks) {
      const keys = [...this.held].filter(([key, n]) => n.trackId === track.id && !key.startsWith('preview:'));
      if (!track.arp.enabled || track.instrument.kind === 'drums') {
        // A key fed to an arpeggiator switched off since makes no sound.
        if (soundsWhileHeld(track)) for (const [key, n] of keys) if (!n.viaArp) on(track.id, n.pitch, n.velocity, key);
        continue;
      }
      const input = seq.getArpInput(track.id);
      if (!input) continue;
      // The arp's notes in its own order (the order they were played); a latched note no key holds
      // is pressed and let go of at once, so the replayed latch keeps it as it did live.
      const released: PerformanceEvent[] = [];
      for (const pitch of track.arp.latch ? input.latched : input.held) {
        const pressed = keys.filter(([, n]) => n.viaArp && n.pitch === pitch);
        for (const [key] of pressed) on(track.id, pitch, input.velocity, key);
        if (pressed.length) continue;
        const key = `take:${track.id}:${pitch}`;
        on(track.id, pitch, input.velocity, key);
        released.push({ t, type: 'noteOff', trackId: track.id, pitch, key });
      }
      take.events.push(...released);
    }
  }

  private finishTake(reason: 'button' | 'stop' | 'stalled' | 'muted'): void {
    const take = this.take;
    if (!take) return;
    this.take = null;
    this.store.setLock(null);
    patchRuntime({ recording: 'off' });
    const endTick = Math.max(take.startTick + 1, this.transport?.getPosition().tick ?? take.startTick + TICKS_PER_BAR);
    // Close notes that are still held so replay releases them.
    const open = new Map<string, PerformanceEvent>();
    for (const ev of take.events) {
      if (ev.type === 'noteOn') open.set(`${ev.trackId}:${ev.key}`, ev);
      if (ev.type === 'noteOff') open.delete(`${ev.trackId}:${ev.key}`);
    }
    for (const ev of open.values()) if (ev.type === 'noteOn') take.events.push({ t: endTick, type: 'noteOff', trackId: ev.trackId, pitch: ev.pitch, key: ev.key });
    const count = this.store.getState().performances.length + 1;
    const perf: Performance = {
      id: uid('perf'),
      name: `Take ${count}`,
      createdAt: Date.now(),
      startTick: take.startTick,
      endTick,
      snapshot: take.snapshot,
      events: take.events,
    };
    const seconds = ((endTick - take.startTick) / 96) * (60 / this.store.getState().bpm);
    if (seconds < 0.5) {
      notify('The performance was too short to keep.', 'warn');
      return;
    }
    cmd.addPerformance(this.store, perf);
    const why =
      reason === 'stalled' ? ' (recording stopped early because playback was interrupted)' : reason === 'muted' ? ' (Mute All ended the recording there)' : '';
    notify(`Saved "${perf.name}" (${formatSeconds(seconds)})${why}. Replay or export it in Arrange.`, reason === 'stalled' ? 'warn' : 'info');
  }

  private recordEvent(ev: PerformanceEvent): void {
    if (!this.take) return;
    this.take.events.push(ev);
  }

  /** Continuous controls are thinned to ~30 events per second. */
  private recordControl(key: string, ev: PerformanceEvent): void {
    const take = this.take;
    if (!take) return;
    const now = performance.now();
    const last = take.lastControlTime.get(key) ?? -Infinity;
    if (now - last < 33) {
      // Replace the previous sample so the final value is always kept.
      for (let i = take.events.length - 1; i >= 0; i--) {
        const prev = take.events[i];
        if (prev.type === ev.type && controlKey(prev) === key) {
          take.events[i] = { ...ev, t: prev.t } as PerformanceEvent;
          return;
        }
      }
    }
    take.lastControlTime.set(key, now);
    take.events.push(ev);
  }

  /* ------------------------------------------------------------------ */
  /* Replay                                                              */
  /* ------------------------------------------------------------------ */

  async replayPerformance(id: Id): Promise<void> {
    if (!(await this.startAudio())) return;
    const project = this.store.getState();
    const perf = project.performances.find((x) => x.id === id);
    if (!perf) return;
    this.finishTake('stop');
    this.stopRecordNotes();
    this.releaseAllNotes();
    this.transport!.stop();
    this.replayingId = id;
    this.engine!.setProject(projectFromSnapshot(project, perf.snapshot));
    this.transport!.start({ mode: { kind: 'replay', performanceId: id } });
    patchRuntime({ playing: true, paused: false, mode: 'replay', replayId: id, stalled: null, songLooping: false });
    this.refreshLauncherRuntime();
    meterWake();
  }

  private endReplay(): void {
    if (!this.replayingId) return;
    this.replayingId = null;
    this.engine?.cancelScheduledAutomation(this.ctx?.currentTime ?? 0);
    const p = this.store.getState();
    this.engine?.setProject(p);
    this.engine?.setMasterVolume(p.masterVolumeDb);
    if (this.transport) {
      this.transport.setTempo(p.bpm);
      this.transport.setSwing(p.swing);
    }
    patchRuntime({ replayId: null, mode: 'live' });
  }

  /* ------------------------------------------------------------------ */
  /* Samples                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Import an audio file onto a part as a new clip that plays it (shape-05):
   * the file is stored, then one undo step adds the recording and a clip on
   * the part's selected pad (or the next empty one) that plays it once from
   * the downbeat at its recorded pitch, its length rounded to whole bars;
   * the part becomes a sampler if it is not one (see
   * cmd.importRecordingAsClip). The new clip is selected. Nothing changes if
   * anything fails (the message says why: a full part, storage, a file that
   * cannot be read).
   */
  async importSample(file: File, trackId: Id): Promise<{ ok: boolean; message: string }> {
    if (this.store.getLock()) return { ok: false, message: this.store.getLock()! };
    const check = checkAudioFile(file);
    if (!check.ok) return { ok: false, message: check.message };
    const decodeCtx: BaseAudioContext = this.ctx ?? new OfflineAudioContext(1, 1, 48000);
    const res = await decodeAudioFile(file, decodeCtx);
    if (!res.ok) return { ok: false, message: res.message };
    try {
      await db.putSample(res.meta, res.blob);
    } catch (e) {
      return { ok: false, message: sampleStorageMessage(e) };
    }
    // Decoded once: the live bank gets it before the project names it.
    if (this.bank) {
      this.bank.add(res.meta.id, res.buffer);
      this.loadedSampleIds.add(res.meta.id);
    }
    const before = this.store.getState();
    const track = before.tracks.find((t) => t.id === trackId);
    const r = cmd.importRecordingAsClip(this.store, trackId, res.meta.id, {
      durationSeconds: res.meta.duration,
      slot: slotFor(uiStore.getState(), trackId),
      meta: res.meta as SampleMeta,
    });
    if (!r.changed || r.slot === undefined) {
      this.bank?.remove(res.meta.id);
      this.loadedSampleIds.delete(res.meta.id);
      void db.deleteSample(res.meta.id).catch(() => undefined);
      return { ok: false, message: r.refused ?? r.message ?? 'The recording could not be put on this part.' };
    }
    selectTrack(trackId);
    selectSlot(trackId, r.slot);
    const after = this.store.getState();
    const part = after.tracks.find((t) => t.id === trackId);
    const where = `${part?.name ?? 'the part'} · ${after.scenes[r.slot]?.name ?? `row ${r.slot + 1}`}`;
    let message = `Imported “${res.meta.name}” as a new clip on ${where}. ${importPitchWords(part, r.partRecording === true)}`;
    // A synth or drum part became a sampler: its other clips now play the recording at their notes' pitches.
    if (track && track.instrument.kind !== 'sampler' && track.clips.some((c, i) => i !== r.slot && !!c && c.notes.length > 0)) {
      message += ` ${part?.name ?? 'The part'} plays recordings now, so its other clips play this one at their notes’ pitches.`;
    }
    return { ok: true, message };
  }

  /**
   * Keep audio made in the app (a recorded take, an edited version): its file
   * goes to browser storage like an import, and its decoded audio straight
   * into the live sample bank (no second decode). The project is not changed
   * here; the caller adds the metadata in one undoable step.
   */
  async storeSample(meta: SampleMeta, blob: Blob, buffer: AudioBuffer | null): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await db.putSample(meta, blob);
    } catch (e) {
      return { ok: false, message: sampleStorageMessage(e) };
    }
    if (buffer && this.bank && this.ctx && buffer.sampleRate === this.ctx.sampleRate) {
      this.bank.add(meta.id, buffer);
      this.loadedSampleIds.add(meta.id);
    }
    return { ok: true };
  }

  /* ------------------------------------------------------------------ */
  /* Export                                                              */
  /* ------------------------------------------------------------------ */

  renderPlan(source: RenderSource, tailSeconds: number) {
    return computeRenderPlan(this.store.getState(), source, tailSeconds);
  }

  /**
   * Render offline with the same engine and sequencer, and encode a WAV.
   * The file starts on the music's first downbeat (sample 0) and lasts
   * exactly the music plus the tail (see renderOffline `align`).
   * `opts.mastering: false` renders without the project's mastering (the
   * output limiter and its ceiling stay). Music playing meanwhile plays on:
   * while the export prepares and renders, live playback is scheduled
   * further ahead (EXPORT_LOOKAHEAD_S), so the moments the export keeps the
   * main thread busy (building its engine, encoding) do not interrupt it.
   */
  async renderWav(opts: ExportOptions): Promise<Blob> {
    return (await this.renderExport(opts, false)).blob;
  }

  /**
   * renderWav, plus a loudness report of the rendered audio (measured with
   * render/loudness on the buffer before it is encoded): integrated
   * loudness, true and sample peak, length.
   */
  async renderWavWithReport(opts: ExportOptions): Promise<{ blob: Blob; report: ExportReport }> {
    const r = await this.renderExport(opts, true);
    return { blob: r.blob, report: r.report! };
  }

  private async renderExport(opts: ExportOptions, measure: boolean): Promise<{ blob: Blob; report: ExportReport | null }> {
    if (this.exportsRunning++ === 0) this.transport?.holdAhead(EXPORT_LOOKAHEAD_S);
    try {
      await this.autosaver?.flush();
      const project = this.store.getState();
      const bank = await this.offlineBank(project, opts.sampleRate);
      const buffer = await renderOffline({
        project,
        source: opts.source,
        sampleRate: opts.sampleRate,
        tailSeconds: opts.tailSeconds,
        signal: opts.signal,
        onProgress: opts.onProgress,
        align: true,
        mastering: opts.mastering !== false,
        createEngine: (ctx) => AudioEngine.create(ctx, { samples: bank, seed: project.seed, meters: false }),
      });
      const report = measure ? await measureExport(buffer) : null;
      const channels = [buffer.getChannelData(0), buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)];
      return { blob: new Blob([encodeWav(channels, buffer.sampleRate, opts.bitDepth)], { type: 'audio/wav' }), report };
    } finally {
      if (--this.exportsRunning === 0) this.transport?.holdAhead(null);
    }
  }

  /** An export is preparing or rendering (see renderWav). */
  get exporting(): boolean {
    return this.exportsRunning > 0;
  }

  /** A sample bank at the export rate holding every recording the project uses. */
  private async offlineBank(project: Project, sampleRate: number): Promise<SampleBank> {
    const bank = new SampleBank(sampleRate);
    const ids = new Set<Id>(project.samples.map((s) => s.id));
    for (const perf of project.performances) for (const t of perf.snapshot.tracks) if (t.instrument.kind === 'sampler' && t.instrument.sampleId) ids.add(t.instrument.sampleId);
    // Recordings clips play themselves (also in takes' starting states).
    for (const id of cmd.clipSampleIds(project)) ids.add(id);
    let decoder: BaseAudioContext | null = null;
    for (const id of ids) {
      if (id.startsWith('builtin:')) continue;
      const live = this.bank?.get(id);
      if (live) {
        bank.add(id, live);
        continue;
      }
      const rec = await db.getSample(id).catch(() => null);
      if (!rec) continue;
      decoder ??= new OfflineAudioContext(2, 1, sampleRate);
      bank.add(id, await decoder.decodeAudioData(await rec.blob.arrayBuffer()));
    }
    return bank;
  }

  /* ------------------------------------------------------------------ */
  /* Meters & diagnostics                                                */
  /* ------------------------------------------------------------------ */

  readMeters(out: MeterFrame): boolean {
    if (!this.engine) return false;
    this.engine.readMeters(out);
    return true;
  }

  /**
   * One meter frame shared by every view in an animation frame (TransportBar,
   * the Loops grid, Mix): the engine is read once per frame (the analysers
   * hold ~21 ms, so no peak falls between reads) and the same object is
   * returned to every caller until the next frame. The frame is the
   * document timeline's time, which stays the same through a frame's
   * callbacks and the code they run, however long they take; without one,
   * reads are at least 8 ms apart. Null before audio starts. Read-only for
   * callers.
   */
  readMetersShared(): MeterFrame | null {
    if (!this.engine) return null;
    const key = frameKey();
    const now = performance.now();
    const same = key !== null ? key === this.sharedFrameKey : now - this.sharedFrameAt < 8 && now >= this.sharedFrameAt;
    if (!same) {
      this.sharedFrameKey = key;
      this.sharedFrameAt = now;
      this.sharedFrameLive = this.readMeters(this.sharedFrame);
    }
    return this.sharedFrameLive ? this.sharedFrame : null;
  }

  /** Output spectrum in dB per log-spaced band (see AudioEngineApi.readSpectrum); false when unavailable. */
  readSpectrum(out: Float32Array): boolean {
    const engine: AudioEngineApi | null = this.engine;
    if (!engine?.readSpectrum) return false;
    engine.readSpectrum(out);
    return true;
  }

  /**
   * A/B in the Mix view: hear the mix without mastering while `bypass` is on.
   * Listening only: the project and every export keep their mastering.
   */
  setMasteringListen(bypass: boolean): void {
    this.masteringBypass = !!bypass;
    const engine: AudioEngineApi | null = this.engine;
    engine?.setMasteringBypass?.(this.masteringBypass);
  }

  get masteringListenBypass(): boolean {
    return this.masteringBypass;
  }

  /** Restart the integrated loudness / true-peak measurement shown in the Mix view. */
  resetLoudness(): void {
    const engine: AudioEngineApi | null = this.engine;
    engine?.resetLoudness?.();
  }

  stats() {
    return {
      audio: runtimeStore.getState().audio,
      engine: this.engine?.getStats() ?? null,
      transport: this.transport?.getStats() ?? null,
      held: this.held.size,
      listeners: this.unsubs.length,
    };
  }

  dispose(): void {
    this.stopEverything();
    this.dropSoundEdits();
    this.uiUnsub();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.transport?.dispose();
    this.engine?.dispose();
    void this.ctx?.close();
    void this.autosaver?.dispose();
  }
}

function controlKey(ev: PerformanceEvent): string {
  switch (ev.type) {
    case 'macro':
      return `macro:${ev.trackId}:${ev.macro}`;
    case 'param':
      return `param:${ev.module}:${ev.param}`;
    case 'tempo':
      return 'tempo';
    case 'swing':
      return 'swing';
    case 'master':
      return 'master';
    default:
      return '';
  }
}

/** Does a key held on this part keep sounding while it is held (a synth note with sustain, a looping recording)? */
function soundsWhileHeld(track: Track): boolean {
  const inst = track.instrument;
  if (inst.kind === 'drums') return false;
  const value = (id: string) => inst.params[id] ?? specById(INSTRUMENT_PARAMS[inst.kind], id)?.default ?? 0;
  return inst.kind === 'sampler' ? value('mode') >= 1 : value('sustain') > 0;
}

/** Did anything the song plays change (its blocks, the scenes, the clips of a part)? */
function songEdited(p: Project, prev: Project): boolean {
  return p.arrangement !== prev.arrangement || p.scenes !== prev.scenes || p.tracks.some((t, i) => t.clips !== prev.tracks[i]?.clips);
}

/** Did a part's instrument change (a new kit, preset, recording or kind: nodes to build, voices to warm up)? */
function instrumentsChanged(p: Project, prev: Project): boolean {
  if (p.tracks === prev.tracks) return false;
  return p.tracks.some((t, i) => soundIdentity(t) !== soundIdentity(prev.tracks[i]));
}

/** Which instrument a part plays: its kind and kit, preset or recording. */
function soundIdentity(t: Track | undefined): string {
  if (!t) return '';
  const inst = t.instrument;
  switch (inst.kind) {
    case 'drums':
      return `drums:${inst.kitId}`;
    case 'sampler':
      return `sampler:${inst.sampleId ?? ''}`;
    default:
      return `${inst.kind}:${inst.presetId ?? ''}`;
  }
}

/** Did any song block's moves (fades, filter rise, echo throw) change? */
function movesChanged(p: Project, prev: Project): boolean {
  if (p.arrangement === prev.arrangement) return false;
  const a = p.arrangement.blocks;
  const b = prev.arrangement.blocks;
  if (a.length !== b.length) return a.some((x) => x.moves?.length) || b.some((x) => x.moves?.length);
  return a.some((x, i) => x.moves !== b[i].moves || (x.moves?.length && x.id !== b[i].id));
}

/**
 * What an edit changed in the sound of notes already scheduled (a note takes
 * its instrument's settings when it is scheduled, and a beat its Pump and
 * click): `tracks`, the parts whose instrument settings changed (params, drum
 * voices, kit, preset, recording, or a big knob mapped onto the instrument);
 * `beats`, a part's Pump or Pump Speed (or a big knob moving them, or a new
 * mapping), or the metronome.
 */
function soundEdits(p: Project, prev: Project): { tracks: Id[]; beats: boolean } {
  const tracks: Id[] = [];
  let beats = p.settings.metronome !== prev.settings.metronome;
  if (p.tracks !== prev.tracks) {
    for (let i = 0; i < p.tracks.length; i++) {
      const a = p.tracks[i];
      const b = prev.tracks[i];
      if (!b || a.id !== b.id) continue;
      if (a.instrument !== b.instrument || macrosMoved(a, b, (t) => t.module === moduleId.inst(a.id))) tracks.push(a.id);
      if (a.macroMap !== b.macroMap || macrosMoved(a, b, (t) => t.param === 'pump' || t.param === 'pumpDiv')) beats = true;
    }
  }
  if (!beats && p.patch !== prev.patch) beats = pumpChanged(p, prev);
  return { tracks, beats };
}

/** Did a big knob of the part move (or its mapping change) with a target that `hits`? */
function macrosMoved(a: Track, b: Track, hits: (t: MacroTarget) => boolean): boolean {
  if (a.macros === b.macros && a.macroMap === b.macroMap) return false;
  for (const m of MACRO_IDS) {
    if (a.macros[m] === b.macros[m] && a.macroMap[m] === b.macroMap[m]) continue;
    if ((a.macroMap[m] ?? []).some(hits) || (b.macroMap[m] ?? []).some(hits)) return true;
  }
  return false;
}

/** Did a channel's Pump, Pump Speed or bypass change? */
function pumpChanged(p: Project, prev: Project): boolean {
  const before = new Map(prev.patch.modules.filter((m) => m.type === 'channel').map((m) => [m.id, m]));
  for (const m of p.patch.modules) {
    if (m.type !== 'channel') continue;
    const b = before.get(m.id);
    if (!b || b.bypass !== m.bypass || b.params.pump !== m.params.pump || b.params.pumpDiv !== m.params.pumpDiv) return true;
  }
  return false;
}

/** What an imported clip's pitch is, in words: as recorded, unless the part's own settings move it. */
function importPitchWords(part: Track | undefined, partRecording: boolean): string {
  const inst = part?.instrument;
  if (partRecording || inst?.kind !== 'sampler') return 'It plays at its recorded pitch.';
  const v = (id: string) => inst.params[id] ?? specById(SAMPLER_PARAMS, id)?.default ?? 0;
  // The part's sampler settings apply to every clip on it, its own recordings too.
  const how = [v('mode') >= 1 ? 'Loop mode' : '', v('pitch') !== 0 || v('fine') !== 0 ? 'transposed' : '', v('sync') >= 1 ? 'Tempo sync, which changes speed and pitch together' : ''].filter(Boolean);
  if (!how.length) return 'It plays at its recorded pitch.';
  return `It plays with ${part!.name}’s sampler settings (${how.join(', ')}): set them in Shape to hear it as recorded.`;
}

/** Longest stretch of start-up warm-up work between two yields (ms). */
const WARM_SLICE_MS = 12;

/**
 * Make ready what the project's clips play (of the parts in `only`, when
 * given) before the first note needs it, so nothing renders inside the
 * scheduler: every drum voice a clip plays
 * (rendered into the shared drum voice cache, at the kit's and voice's
 * decay, as the kit will ask for it) and every built-in recording a sampler
 * part with clips plays. Short units of work, yielding to the page between
 * slices of about WARM_SLICE_MS (a task each, not idle time). The engine's
 * own preparation (prepareInstruments) finds them ready.
 */
async function warmSounds(project: Project, bank: SampleBank, sampleRate: number, only?: ReadonlySet<Id>): Promise<void> {
  const units: (() => boolean)[] = [];
  const resolved = resolveAllParams(project);
  for (const t of project.tracks) {
    if (only && !only.has(t.id)) continue;
    const inst = t.instrument;
    const used = t.clips.filter((c): c is NonNullable<typeof c> => !!c && c.notes.length > 0);
    if (!used.length) continue;
    if (inst.kind === 'drums') {
      const counts = new Map<number, number>();
      for (const c of used) for (const n of c.notes) counts.set(n.pitch, (counts.get(n.pitch) ?? 0) + 1);
      const kitId = resolveKitId(inst.kitId);
      const kitDecay = readParam(DRUM_KIT_PARAMS, resolved.get(moduleId.inst(t.id)) ?? inst.params, 'decay');
      // Most-played first, as the engine orders them.
      for (const [slot] of [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
        if (!Number.isInteger(slot) || slot < 0 || slot >= inst.voices.length) continue;
        const voiceDecay = clampParam(DRUM_VOICE_PARAM_SPECS.decay, inst.voices[slot]?.decay ?? DRUM_VOICE_PARAM_SPECS.decay.default);
        const job = drumVoiceJob(kitId, slot, sampleRate, quantizeDrumDecay(kitDecay * voiceDecay));
        units.push(() => job.step());
      }
    } else if (inst.kind === 'sampler') {
      const ids = new Set<string>();
      if (inst.sampleId?.startsWith('builtin:')) ids.add(inst.sampleId);
      for (const c of used) if (c.sample?.id.startsWith('builtin:')) ids.add(c.sample.id);
      for (const id of ids) {
        units.push(() => {
          bank.get(id);
          return false;
        });
      }
    }
  }
  while (units.length) {
    const start = performance.now();
    do {
      if (!units[0]()) units.shift();
    } while (units.length && performance.now() - start < WARM_SLICE_MS);
    if (units.length) await nextTask();
  }
}

/** Let the page run (paint, input) before going on: a new task, not idle time. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}

/** The current animation frame's time (document.timeline), or null where there is none. */
function frameKey(): number | null {
  if (typeof document === 'undefined') return null;
  const t = document.timeline?.currentTime;
  return typeof t === 'number' ? t : null;
}

/** One animation frame (then a task), so what a click changed on screen paints first; at most 100 ms (hidden tabs). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    if (typeof raf === 'function') raf(() => setTimeout(go, 0));
    setTimeout(go, 100);
  });
}

/** Did anything that changes generated notes change (clips, instrument kind, arp)? */
function musicChanged(p: Project, prev: Project): boolean {
  if (p.tracks === prev.tracks) return false;
  for (let i = 0; i < p.tracks.length; i++) {
    const a = p.tracks[i];
    const b = prev.tracks[i];
    if (!b || a.id !== b.id) return true;
    if (a.clips !== b.clips || a.arp !== b.arp || a.instrument.kind !== b.instrument.kind) return true;
  }
  return false;
}

/** Why a recording could not be put in browser storage, in words. */
export function sampleStorageMessage(e: unknown): string {
  return e instanceof db.StorageError && e.kind === 'quota'
    ? 'Browser storage is full, so the recording could not be kept. Delete old projects or export and remove recordings.'
    : `The recording could not be stored: ${e instanceof Error ? e.message : String(e)}`;
}

export function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s - m * 60);
  return m > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `${s.toFixed(1)} s`;
}
