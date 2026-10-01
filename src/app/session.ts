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
import { engineLatencyFrames } from '../audio/worklets/limiter';
import { SampleBank } from '../audio/instruments/sampleBank';
import { BLANK_STARTER, JUMP_IN_SCENE_ROW, JUMP_IN_STARTER_ID, STARTERS, getStarter } from '../content/starters';
import { snapToScale } from '../music/scales';
import { uid } from '../project/factory';
import { BASS_PARAMS, DRUM_KIT_PARAMS, INSTRUMENT_PARAMS, POLY_PARAMS, SAMPLER_PARAMS, specById } from '../project/params';
import { specsForModule } from '../project/resolve';
import {
  MACRO_IDS,
  TICKS_PER_BAR,
  TICKS_PER_STEP,
  type ClipBars,
  type Id,
  type MacroId,
  type Performance,
  type PerformanceEvent,
  type Project,
  type QuantizeGrid,
  type SampleMeta,
  type Track,
} from '../project/types';
import { computeRenderPlan, renderOffline, type RenderSource } from '../render/offline';
import { encodeWav } from '../render/wav';
import * as cmd from '../state/commands';
import { ProjectStore, type ApplyResult } from '../state/projectStore';
import { selectSlot, selectTrack, setPadMode, setView, slotFor, uiStore } from '../state/uiStore';
import { createAutosaver, type Autosaver } from '../persistence/autosave';
import { decodeAudioFile, checkAudioFile } from '../persistence/audioImport';
import { exportBundle, importBundle, bundleFileName } from '../persistence/bundle';
import * as db from '../persistence/db';
import * as library from '../persistence/library';
import type { LaunchResult, SongLoop } from '../time/contracts';
import { makeSnapshot, projectFromSnapshot } from '../time/snapshot';
import { Sequencer, songBlocks, songSignature, type NoteEvent } from '../time/sequencer';
import { sameSongLoop, songLoopAfterEdit, songLoopRange } from '../time/songLoop';
import { RealtimeTransport } from '../time/transport';
import { notify, patchRuntime, runtimeStore, setTrackRuntime, type PlayMode } from './runtime';

/**
 * Where a live note comes from. 'preview' is an editor/browser audition: it
 * plays exactly the pitch given (no Musical Assist, no arpeggiator) and is
 * never recorded into clips or performance takes.
 */
export type NoteSource = 'keyboard' | 'computer' | 'pad' | 'midi' | 'preview';

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
  /** Transport tick when pressed (for Record Notes), or null when not recording notes. */
  recTick: number | null;
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
}

/** Arpeggiator notes are written into the clip in batches (their ticks come from the audio clock). */
const ARP_RECORD_BATCH_MS = 200;

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

  constructor(initial: Project) {
    this.store = new ProjectStore(initial);
    this.store.subscribe((p, prev) => this.onProjectChange(p, prev));
  }

  /* ------------------------------------------------------------------ */
  /* Boot & projects                                                     */
  /* ------------------------------------------------------------------ */

  /** Reopen the last project from storage, or show the Jump In starter as a preview. */
  async boot(): Promise<BootInfo> {
    const info: BootInfo = { lastProject: null, warnings: [], storageError: null };
    this.unstored = false;
    try {
      const opened = await library.openLast();
      if (opened) {
        this.store.replace(opened.project);
        info.lastProject = { id: opened.project.id, name: opened.project.name };
        info.warnings = opened.warnings;
        this.setPreview(false);
      } else {
        this.loadPreview();
      }
      void db.garbageCollectSamples({ keep: db.sampleIdsOf(this.store.getState()) }).catch(() => undefined);
    } catch (e) {
      // Stored projects that cannot be read are a problem with those projects, not with saving.
      if (library.isUnreadableLibrary(e)) info.warnings = [e.message];
      else info.storageError = e instanceof Error ? e.message : 'Browser storage is unavailable.';
      this.loadPreview();
    }
    this.startAutosave();
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
    this.store.replace(project);
    if (!opts.unsaved) this.autosaver?.markSaved(project);
    this.resetRuntimeTracks();
    await this.loadProjectSamples(project);
    this.engine?.prepareInstruments();
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

  /** Start a new project from a starter (current project is saved first; see StarterOptions). */
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
    try {
      project = await library.createFromStarter(starter, current);
    } catch (e) {
      stored = false;
      notify(`Could not save to browser storage: ${e instanceof Error ? e.message : String(e)}. You can keep playing; export the project file to keep a copy.`, 'warn');
    }
    await this.loadProject(project, { unsaved: !stored });
  }

  /** Continue the reopened project (audio starts from this gesture; nothing auto-plays). */
  async continueProject(): Promise<void> {
    await this.startAudio();
  }

  async openProject(id: Id): Promise<void> {
    await this.autosaver?.flush();
    const opened = await library.openProject(id);
    await this.loadProject(opened.project);
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
      const project = this.store.getState();
      this.bank = new SampleBank(ctx.sampleRate);
      await this.loadProjectSamples(project);
      const engine = await AudioEngine.create(ctx, { samples: this.bank, seed: project.seed, meters: true });
      this.engine = engine;
      engine.setMasterVolume(project.masterVolumeDb);
      engine.setProject(project);
      engine.prepareInstruments();
      // Mute All pressed before audio started still holds; so does an A/B comparison.
      if (runtimeStore.getState().muteAll) engine.setMuteAll(true);
      if (this.masteringBypass) engine.setMasteringBypass(true);
      const sequencer = new Sequencer({ getProject: () => this.store.getState() });
      // A song loop set before audio started applies to the first song start.
      sequencer.setSongLoop(runtimeStore.getState().songLoop, 0);
      const transport = new RealtimeTransport({ ctx, engine, sequencer });
      this.sequencer = sequencer;
      this.transport = transport;
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
        if (this.noteRec && ev.trackId === this.noteRec.trackId && ev.slot !== this.noteRec.slot) this.stopRecordNotes();
      }),
      // Found by id: the block may have moved since its event was scheduled. One deleted meanwhile is
      // never named: the plan has the block taking over from it.
      t.on('block', (ev) => {
        const i = this.store.getState().arrangement.blocks.findIndex((b) => b.id === ev.blockId);
        if (i >= 0) patchRuntime({ songBlock: i, songBlockId: ev.blockId });
        else this.syncSongBlock();
      }),
      t.on('beat', (ev) => {
        const counting = runtimeStore.getState().countingIn;
        if (counting !== ev.countIn) patchRuntime({ countingIn: ev.countIn });
      }),
      t.on('end', () => this.stop()),
      t.on('arpNote', (ev) => this.recordArpNote(ev)),
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
          songBlock: null, songBlockId: null,
          countingIn: false,
          stalled:
            s.reason === 'suspended'
              ? 'Playback stopped because the audio device paused.'
              : 'Playback paused because the browser slowed this tab down (it was in the background or busy).',
        });
        this.refreshLauncherRuntime();
      }),
      t.on('state', () => this.updateAudioState()),
    );
  }

  /* ------------------------------------------------------------------ */
  /* Project → engine                                                    */
  /* ------------------------------------------------------------------ */

  private onProjectChange(p: Project, prev: Project): void {
    // First the launcher follows clips that moved, so the regeneration below already plays them from their new pads.
    if (p.tracks !== prev.tracks) this.followMovedClips(p, prev);
    if (this.engine && !this.replayingId) {
      this.engine.setProject(p);
      if (p.masterVolumeDb !== prev.masterVolumeDb) this.engine.setMasterVolume(p.masterVolumeDb);
    }
    // The song loop follows the edit (see songLoopAfterEdit); another project has none.
    const loopWas = runtimeStore.getState().songLoop;
    const loop = p.id !== prev.id ? null : songLoopAfterEdit(loopWas, prev, p);
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
      // A song playing (or paused) follows edits to its blocks and to the clips they play; that also regenerates.
      const replanned = this.followSongEdits(p, prev, loop);
      if (!replanned && musicChanged(p, prev)) this.transport.invalidate();
    }
    // Not replanned (stopped, live pads, a replay): the sequencer keeps the loop for the next song start.
    if (this.transport && this.sequencer && !sameSongLoop(this.sequencer.songLoop, loop)) this.transport.replanSong(loop);
    if (loop !== loopWas) patchRuntime({ songLoop: loop });
    if (p.samples !== prev.samples) void this.loadProjectSamples(p);
    if (p.tracks !== prev.tracks) this.stopPartsWithoutClip(p);
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
    if (p.scenes !== prev.scenes) {
      const rows = new Map<number, number>();
      prev.scenes.forEach((s, i) => {
        const j = p.scenes.findIndex((x) => x.id === s.id);
        if (j >= 0 && j !== i) rows.set(i, j);
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
        // would put it outside the song's plan, and an Undo could not bring it back.
        else if (partOf.has(c.id) && !song) slots.set(s, null);
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
      if (p.arrangement === prev.arrangement && p.scenes === prev.scenes && p.tracks.every((t, i) => t.clips === prev.tracks[i]?.clips)) return false;
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
    patchRuntime({ playing: true, paused: false, mode: 'live', stalled: null, songBlock: null, songBlockId: null });
    this.refreshLauncherRuntime();
  }

  stop(): void {
    this.finishTake('stop');
    this.stopRecordNotes();
    // Stop releases every held note (keyboard, pads, arpeggio).
    this.releaseAllNotes();
    if (this.transport) this.transport.stop();
    if (this.replayingId) this.endReplay();
    this.stallResume = null;
    patchRuntime({ playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null, countingIn: false });
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
    this.refreshLauncherRuntime();
  }

  private resumeFromPause(): void {
    if (!this.transport?.resume()) return;
    this.stallResume = null;
    // The mode, song block and replay carry on as they were.
    patchRuntime({ playing: true, paused: false, stalled: null });
    this.refreshLauncherRuntime();
  }

  /** Space: Play / Pause. */
  async togglePlay(opts: { song?: boolean } = {}): Promise<void> {
    if (this.playing) this.pause();
    // In Arrange, Play plays the song (from the loop, if one is set); a pause resumes what was playing.
    else if (opts.song && !this.transport?.paused && this.store.getState().arrangement.blocks.length) await this.playSong();
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
   * Edits keep it valid (see songLoopAfterEdit). Returns false (and changes
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
    this.refreshLauncherRuntime();
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
    for (const t of this.store.getState().tracks) if (t.clips[row]) selectSlot(t.id, row);
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
    if (!(await this.startAudio())) return;
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
    const scene = before.scenes[fromRow];
    if (!scene) return false;
    const r = cmd.moveScene(this.store, fromRow, toRow);
    if (!this.accepted(r)) return false;
    // Each part's chosen clip stays the same clip.
    const ui = uiStore.getState();
    for (const t of before.tracks) {
      const sel = ui.selectedSlot[t.id];
      if (sel === undefined) continue;
      const id = t.clips[sel]?.id;
      const now = this.store.getState().tracks.find((x) => x.id === t.id);
      const at = id && now ? now.clips.findIndex((c) => c?.id === id) : -1;
      if (at >= 0) selectSlot(t.id, at);
      else if (sel === fromRow) selectSlot(t.id, toRow);
    }
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
   * samplers (a recording keeps its pitch unless its own Pitch is changed)
   * and previews play exactly the key given.
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
    const kind = track.instrument.kind;
    const preview = source === 'preview';
    const exact = preview || kind === 'drums' || kind === 'sampler';
    const pitch = !exact && p.assist ? snapToScale(rawPitch, p.root, p.scale) : rawPitch;
    const v = Math.max(0.05, Math.min(1, velocity));
    const viaArp = track.arp.enabled && kind !== 'drums' && !preview;
    const note: HeldNote = { trackId, pitch, velocity: v, viaArp, recTick: null, recClipStart: null };
    // Record Notes keeps a played key as a note. With the arpeggiator on, the
    // notes it plays are recorded instead (recordArpNote), not the key held.
    if (!preview && !viaArp && this.noteRec && this.noteRec.trackId === trackId && this.transport?.playing) {
      const pos = this.recordingTick();
      const rt = this.sequencer?.getTrackState(trackId);
      // From about the clip's first downbeat on (up to half a step early, like a pushed beat), so not during the count-in.
      if (rt?.playing && rt.playing.slot === this.noteRec.slot && pos >= rt.playing.startTick - TICKS_PER_STEP / 2) {
        note.recTick = pos;
        note.recClipStart = rt.playing.startTick;
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

  /** Musical position the player meant: compensate for output latency. */
  private recordingTick(): number {
    const ctx = this.ctx!;
    const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + engineLatencyFrames(ctx.sampleRate) / ctx.sampleRate;
    const seq = this.sequencer!;
    return seq.tickAt(ctx.currentTime - latency);
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
    this.noteRec = { trackId, slot, gesture: uid('rec'), added: 0, arpNotes: [], arpFlush: null };
    patchRuntime({ recording: 'notes', recordTarget: { trackId, slot } });
    const seqState = this.sequencer!.getTrackState(trackId);
    if (this.transport!.paused) {
      // Paused: playback continues from the pause (no count-in); another clip starts at the next bar.
      if (seqState.playing?.slot !== slot) this.transport!.launchClip(trackId, slot);
      this.resumeFromPause();
    } else if (!this.transport!.playing) {
      if (seqState.playing?.slot !== slot) this.transport!.launchClip(trackId, slot);
      const countIn = p.settings.countIn ? 1 : 0;
      this.transport!.start({ mode: { kind: 'live' }, countInBars: countIn });
      patchRuntime({ playing: true, paused: false, mode: 'live', countingIn: countIn > 0, stalled: null });
      this.refreshLauncherRuntime();
    } else if (seqState.playing?.slot !== slot) {
      this.applyLaunchResults([this.transport!.launchClip(trackId, slot)]);
    }
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
    if (runtimeStore.getState().recording === 'notes') patchRuntime({ recording: 'off', recordTarget: null });
    else patchRuntime({ recordTarget: null });
    if (added > 0) notify(`Recorded ${added} note${added === 1 ? '' : 's'} into the clip. Undo removes the whole pass, with any knob moves made during it.`, 'info', 'undo', this.store.undoEntryId());
  }

  private commitRecordedNote(n: HeldNote): void {
    if (!this.noteRec || n.recTick === null || n.recClipStart === null) return;
    const duration = Math.max(6, this.recordingTick() - n.recTick);
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
    // Only while the recorded clip plays, from its first downbeat (not during the count-in).
    if (!at || at.slot !== rec.slot || ev.tick < at.startTick) return;
    rec.arpNotes.push({ tick: ev.tick - at.startTick, pitch: ev.pitch, velocity: ev.velocity, duration: ev.durationTicks });
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
    patchRuntime({ playing: true, paused: false, mode: 'replay', replayId: id, stalled: null });
    this.refreshLauncherRuntime();
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

  /** Import an audio file onto a part (turns it into a sampler). The project is untouched if anything fails. */
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
    if (this.bank) {
      this.bank.add(res.meta.id, res.buffer);
      this.loadedSampleIds.add(res.meta.id);
    }
    // Adding the recording and putting it on the part is one undo step.
    const gesture = uid('import');
    cmd.addSampleMeta(this.store, res.meta as SampleMeta, gesture);
    const a = cmd.assignSample(this.store, trackId, res.meta.id, gesture);
    this.store.endGesture();
    if (!a.changed && (a.refused || a.reason)) return { ok: false, message: a.refused ?? a.message ?? 'The recording could not be assigned to this part.' };
    return { ok: true, message: `Imported "${res.meta.name}" (${res.meta.duration.toFixed(1)} s).` };
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

  /** Render offline with the same engine and sequencer, and encode a WAV. */
  async renderWav(opts: ExportOptions): Promise<Blob> {
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
      createEngine: (ctx) => AudioEngine.create(ctx, { samples: bank, seed: project.seed, meters: false }),
    });
    const channels = [buffer.getChannelData(0), buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)];
    return new Blob([encodeWav(channels, buffer.sampleRate, opts.bitDepth)], { type: 'audio/wav' });
  }

  /** A sample bank at the export rate holding every recording the project uses. */
  private async offlineBank(project: Project, sampleRate: number): Promise<SampleBank> {
    const bank = new SampleBank(sampleRate);
    const ids = new Set<Id>(project.samples.map((s) => s.id));
    for (const perf of project.performances) for (const t of perf.snapshot.tracks) if (t.instrument.kind === 'sampler' && t.instrument.sampleId) ids.add(t.instrument.sampleId);
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
