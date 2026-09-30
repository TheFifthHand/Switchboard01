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
import type { MeterFrame } from '../audio/contracts';
import { AudioEngine } from '../audio/engine';
import { engineLatencyFrames } from '../audio/worklets/limiter';
import { SampleBank } from '../audio/instruments/sampleBank';
import { BLANK_STARTER, JUMP_IN_SCENE_ROW, JUMP_IN_STARTER_ID, STARTERS, getStarter } from '../content/starters';
import { snapToScale } from '../music/scales';
import { uid } from '../project/factory';
import { BASS_PARAMS, DRUM_KIT_PARAMS, POLY_PARAMS, SAMPLER_PARAMS } from '../project/params';
import {
  MACRO_IDS,
  TICKS_PER_BAR,
  type ClipBars,
  type Id,
  type MacroId,
  type Performance,
  type PerformanceEvent,
  type Project,
  type SampleMeta,
} from '../project/types';
import { computeRenderPlan, renderOffline, type RenderSource } from '../render/offline';
import { encodeWav } from '../render/wav';
import * as cmd from '../state/commands';
import { ProjectStore } from '../state/projectStore';
import { selectSlot, selectTrack, slotFor, uiStore } from '../state/uiStore';
import { createAutosaver, type Autosaver } from '../persistence/autosave';
import { decodeAudioFile, checkAudioFile } from '../persistence/audioImport';
import { exportBundle, importBundle, bundleFileName } from '../persistence/bundle';
import * as db from '../persistence/db';
import * as library from '../persistence/library';
import type { LaunchResult } from '../time/contracts';
import { makeSnapshot, projectFromSnapshot } from '../time/snapshot';
import { Sequencer } from '../time/sequencer';
import { RealtimeTransport } from '../time/transport';
import { notify, patchRuntime, runtimeStore, setTrackRuntime } from './runtime';

/**
 * Where a live note comes from. 'preview' is an editor/browser audition: it
 * plays exactly the pitch given (no Musical Assist, no arpeggiator) and is
 * never recorded into clips or performance takes.
 */
export type NoteSource = 'keyboard' | 'computer' | 'pad' | 'preview';

export interface BootInfo {
  /** The project that was reopened from storage, if any. */
  lastProject: { id: Id; name: string } | null;
  warnings: string[];
  storageError: string | null;
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

export const TAKE_LOCK_MESSAGE =
  'Recording a performance: cables, clips, sounds, the song and saved takes are locked until you stop. Knobs, macros, mutes and tempo are recorded.';

interface HeldNote {
  trackId: Id;
  /** Pitch actually played (after Musical Assist). */
  pitch: number;
  velocity: number;
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
}

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
  private noteRec: NoteRecording | null = null;
  /** Project that is not saved yet (the preview starter shown before Jump In). */
  private previewOnly = false;
  private replayingId: Id | null = null;
  private loadedSampleIds = new Set<Id>();
  /** Keys pressed before the engine existed: played as soon as audio is ready. */
  private pendingKeys = new Map<string, { released: boolean }>();
  private auditionCounter = 0;
  private sampleLoads = new Map<Id, Promise<void>>();

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
    try {
      const opened = await library.openLast();
      if (opened) {
        this.store.replace(opened.project);
        info.lastProject = { id: opened.project.id, name: opened.project.name };
        info.warnings = opened.warnings;
        this.previewOnly = false;
      } else {
        this.loadPreview();
      }
      void db.garbageCollectSamples({ keep: db.sampleIdsOf(this.store.getState()) }).catch(() => undefined);
    } catch (e) {
      info.storageError = e instanceof Error ? e.message : 'Browser storage is unavailable.';
      this.loadPreview();
    }
    this.startAutosave();
    return info;
  }

  private loadPreview(): void {
    const starter = getStarter(JUMP_IN_STARTER_ID) ?? STARTERS[0];
    this.store.replace(starter.build());
    this.previewOnly = true;
  }

  private startAutosave(): void {
    void this.autosaver?.dispose();
    this.autosaver = createAutosaver({
      store: this.store,
      save: async (p) => {
        if (this.previewOnly) return;
        await db.saveProject(p);
      },
    });
    this.autosaver.markSaved(this.store.getState());
  }

  /** Load a project into the store (stops playback and recording first). */
  private async loadProject(project: Project, opts: { preview?: boolean } = {}): Promise<void> {
    this.stopEverything();
    await this.autosaver?.flush();
    this.previewOnly = !!opts.preview;
    this.store.replace(project);
    this.autosaver?.markSaved(project);
    this.resetRuntimeTracks();
    await this.loadProjectSamples(project);
    this.engine?.prepareInstruments();
  }

  /**
   * Jump In: enable audio (this must run inside the click), save whatever is
   * open, start a fresh House starter session and play its Groove scene.
   */
  async jumpIn(): Promise<void> {
    const audio = this.startAudio();
    const starter = getStarter(JUMP_IN_STARTER_ID) ?? STARTERS[0];
    await this.createFromStarter(starter.build());
    selectTrack('t4');
    if (!(await audio)) return;
    this.transport!.launchScene(JUMP_IN_SCENE_ROW);
    this.selectRow(JUMP_IN_SCENE_ROW);
    await this.play();
  }

  /** Start a new project from a starter (current project is saved first). */
  async newFromStarter(starterId: string): Promise<void> {
    const def = starterId === 'blank' ? BLANK_STARTER : getStarter(starterId);
    if (!def) return;
    await this.createFromStarter(def.build());
  }

  private async createFromStarter(starter: Project): Promise<void> {
    const current = this.previewOnly ? null : this.store.getState();
    let project = starter;
    try {
      await this.autosaver?.flush();
      project = await library.createFromStarter(starter, current);
    } catch (e) {
      notify(`Could not save to browser storage: ${e instanceof Error ? e.message : String(e)}. You can keep playing; export the project file to keep a copy.`, 'warn');
    }
    await this.loadProject(project);
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
    try {
      for (const s of res.samples) await db.putSample(s.meta, s.blob);
      await library.addToLibrary(res.project);
    } catch (e) {
      return { ok: false, message: `The project file is fine, but it could not be stored in this browser: ${e instanceof Error ? e.message : String(e)}` };
    }
    await this.autosaver?.flush();
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

  /** True while the open project is the unsaved Jump In preview shown before any choice. */
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
      const sequencer = new Sequencer({ getProject: () => this.store.getState() });
      const transport = new RealtimeTransport({ ctx, engine, sequencer });
      this.sequencer = sequencer;
      this.transport = transport;
      this.wireTransport(transport);
      ctx.onstatechange = () => this.updateAudioState();
      this.updateAudioState();
      return true;
    })().catch((e: unknown) => {
      console.error(e);
      patchRuntime({ audio: 'error', audioMessage: `Audio could not start: ${e instanceof Error ? e.message : String(e)}` });
      this.audioPromise = null;
      return false;
    });
    return this.audioPromise;
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
      t.on('block', (ev) => patchRuntime({ songBlock: ev.blockIndex })),
      t.on('beat', (ev) => {
        const counting = runtimeStore.getState().countingIn;
        if (counting !== ev.countIn) patchRuntime({ countingIn: ev.countIn });
      }),
      t.on('end', () => this.stop()),
      t.on('stalled', (s) => {
        this.finishTake('stalled');
        this.stopRecordNotes();
        this.releaseAllNotes();
        patchRuntime({
          playing: false,
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
    if (this.engine && !this.replayingId) {
      this.engine.setProject(p);
      if (p.masterVolumeDb !== prev.masterVolumeDb) this.engine.setMasterVolume(p.masterVolumeDb);
    }
    if (this.transport && !this.replayingId) {
      if (p.bpm !== prev.bpm) this.transport.setTempo(p.bpm);
      if (p.swing !== prev.swing) this.transport.setSwing(p.swing);
      if (musicChanged(p, prev)) this.transport.invalidate();
    }
    if (p.samples !== prev.samples) void this.loadProjectSamples(p);
    if (p.tracks !== prev.tracks) this.stopPartsWithoutClip(p);
  }

  /** A part whose playing (or armed) clip was deleted stops, so undo does not silently resume it. */
  private stopPartsWithoutClip(p: Project): void {
    if (!this.sequencer || !this.transport || this.replayingId) return;
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
          this.loadedSampleIds.add(meta.id);
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

  async play(): Promise<void> {
    if (!(await this.startAudio())) return;
    if (this.replayingId) this.endReplay();
    this.armDefaultSceneIfIdle();
    this.transport!.start({ mode: { kind: 'live' }, countInBars: 0 });
    patchRuntime({ playing: true, mode: 'live', stalled: null, songBlock: null });
    this.refreshLauncherRuntime();
  }

  stop(): void {
    this.finishTake('stop');
    this.stopRecordNotes();
    // Stop releases every held note (keyboard, pads, arpeggio).
    this.releaseAllNotes();
    if (this.transport) this.transport.stop();
    if (this.replayingId) this.endReplay();
    patchRuntime({ playing: false, mode: 'live', songBlock: null, countingIn: false });
    this.refreshLauncherRuntime();
  }

  async togglePlay(): Promise<void> {
    if (this.playing) this.stop();
    else await this.play();
  }

  /** Play the arrangement from a block. */
  async playSong(fromBlock = 0): Promise<void> {
    if (!(await this.startAudio())) return;
    this.finishTake('stop');
    this.stopRecordNotes();
    if (this.replayingId) this.endReplay();
    if (this.store.getState().arrangement.blocks.length === 0) {
      notify('The arrangement is empty. Add scene blocks in Arrange first.', 'warn');
      return;
    }
    this.transport!.start({ mode: { kind: 'song', fromBlock } });
    patchRuntime({ playing: true, mode: 'song', songBlock: fromBlock, stalled: null });
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

  /** Resume after a stall: restart from the bar where playback stopped, same clips. */
  async resumeAfterStall(): Promise<void> {
    patchRuntime({ stalled: null });
    await this.play();
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

  /** Mute All: silence everything now, including held notes and effect tails. */
  setMuteAll(muted: boolean): void {
    if (muted) this.releaseAllNotes();
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

  undo(): void {
    const r = this.store.undo();
    if (r.refused) notify(r.refused, 'warn');
  }

  redo(): void {
    const r = this.store.redo();
    if (r.refused) notify(r.refused, 'warn');
  }

  /* ------------------------------------------------------------------ */
  /* Live notes                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Play a note on a part. `rawPitch` is the key pressed (MIDI, or drum pad
   * index); Musical Assist snaps melodic notes into the project scale.
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
    const drums = track.instrument.kind === 'drums';
    const preview = source === 'preview';
    const pitch = !drums && !preview && p.assist ? snapToScale(rawPitch, p.root, p.scale) : rawPitch;
    const v = Math.max(0.05, Math.min(1, velocity));
    const note: HeldNote = { trackId, pitch, velocity: v, recTick: null, recClipStart: null };
    if (!preview && this.noteRec && this.noteRec.trackId === trackId && this.transport?.playing) {
      const pos = this.recordingTick();
      const rt = this.sequencer?.getTrackState(trackId);
      if (rt?.playing && rt.playing.slot === this.noteRec.slot) {
        note.recTick = pos;
        note.recClipStart = rt.playing.startTick;
      }
    }
    this.held.set(key, note);
    if (track.arp.enabled && !drums && !preview) {
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
    const track = this.store.getState().tracks.find((t) => t.id === trackId);
    if (source !== 'preview' && track?.arp.enabled && track.instrument.kind !== 'drums') this.transport?.setArpHeld(trackId, this.heldPitches(trackId, true));
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
    if (this.transport) for (const t of this.store.getState().tracks) this.transport.setArpHeld(t.id, []);
    patchRuntime({ held: {} });
  }

  /** Pitches held on a part; `forArp` leaves out previews, which never feed the arpeggiator. */
  private heldPitches(trackId: Id, forArp = false): number[] {
    const out: number[] = [];
    for (const [key, n] of this.held) if (n.trackId === trackId && !(forArp && key.startsWith('preview:')) && !out.includes(n.pitch)) out.push(n.pitch);
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
   * count-in when that option is on).
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
    if (!(await this.startAudio())) return;
    const ui = uiStore.getState();
    const trackId = ui.selectedTrackId;
    const p = this.store.getState();
    const track = p.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const playingSlot = runtimeStore.getState().tracks[trackId]?.playingSlot ?? null;
    const slot = playingSlot ?? slotFor(ui, trackId);
    if (!track.clips[slot]) {
      const bars: ClipBars = track.instrument.kind === 'drums' ? 1 : 2;
      cmd.createClip(this.store, trackId, slot, bars, 'Take');
    }
    selectSlot(trackId, slot);
    this.noteRec = { trackId, slot, gesture: uid('rec'), added: 0 };
    patchRuntime({ recording: 'notes', recordTarget: { trackId, slot } });
    const seqState = this.sequencer!.getTrackState(trackId);
    if (!this.transport!.playing) {
      if (seqState.playing?.slot !== slot) this.transport!.launchClip(trackId, slot);
      const countIn = p.settings.countIn ? 1 : 0;
      this.transport!.start({ mode: { kind: 'live' }, countInBars: countIn });
      patchRuntime({ playing: true, mode: 'live', countingIn: countIn > 0 });
      this.refreshLauncherRuntime();
    } else if (seqState.playing?.slot !== slot) {
      this.applyLaunchResults([this.transport!.launchClip(trackId, slot)]);
    }
  }

  stopRecordNotes(): void {
    if (!this.noteRec) return;
    // Notes still held are committed with their length so far.
    for (const n of this.held.values()) if (n.recTick !== null) this.commitRecordedNote(n);
    const added = this.noteRec.added;
    this.noteRec = null;
    this.store.endGesture();
    if (runtimeStore.getState().recording === 'notes') patchRuntime({ recording: 'off', recordTarget: null });
    else patchRuntime({ recordTarget: null });
    if (added > 0) notify(`Recorded ${added} note${added === 1 ? '' : 's'} into the clip. Undo removes the whole take.`, 'info', 'undo');
  }

  private commitRecordedNote(n: HeldNote): void {
    const rec = this.noteRec;
    if (!rec || n.recTick === null || n.recClipStart === null) return;
    const p = this.store.getState();
    const clip = p.tracks.find((t) => t.id === rec.trackId)?.clips[rec.slot];
    if (!clip) return;
    const len = clip.bars * TICKS_PER_BAR;
    const now = this.recordingTick();
    const duration = Math.max(6, now - n.recTick);
    let local = (n.recTick - n.recClipStart) % len;
    if (local < 0) local += len;
    const r = cmd.addRecordedNotes(this.store, rec.trackId, rec.slot, [{ tick: local, pitch: n.pitch, velocity: n.velocity, duration: Math.min(duration, len) }], { quantize: p.settings.recordQuantize, mode: 'overdub', gesture: rec.gesture });
    if (r.changed) rec.added += 1;
    n.recTick = null;
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
    if (this.noteRec) this.stopRecordNotes();
    if (!(await this.startAudio())) return;
    if (this.replayingId) this.stop();
    if (!this.transport!.playing) {
      this.transport!.start({ mode: { kind: 'live' } });
      patchRuntime({ playing: true, mode: 'live', stalled: null });
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
    this.store.setLock(TAKE_LOCK_MESSAGE, isRecordableLabel);
    patchRuntime({ recording: 'performance' });
  }

  private finishTake(reason: 'button' | 'stop' | 'stalled'): void {
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
    const why = reason === 'stalled' ? ' (recording stopped early because playback was interrupted)' : '';
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
    patchRuntime({ playing: true, mode: 'replay', replayId: id, stalled: null });
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
      return { ok: false, message: e instanceof db.StorageError && e.kind === 'quota' ? 'Browser storage is full, so the recording could not be kept. Delete old projects or export and remove recordings.' : `The recording could not be stored: ${e instanceof Error ? e.message : String(e)}` };
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

export function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s - m * 60);
  return m > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `${s.toFixed(1)} s`;
}
