/**
 * Export: renders offline with the same engine, routing, timing and
 * automation as playback (not a recording of the speakers) and saves a file.
 *
 *   What to export   The whole song (2:19) · a loop of the song · a scene ·
 *                    the loops playing now · a performance
 *   Format           WAV (best quality) · Smaller file for sharing (Opus,
 *                    only where the browser can encode it) · Parts as
 *                    separate files (.zip of WAVs) · MIDI file (.mid)
 *   [on] Make it as loud as streaming songs
 *   File name
 *   More options     (Simple: folded; Advanced: always shown) length of a
 *                    looped scene, mastering or not, echo tail, sample rate,
 *                    bit depth
 *
 * What it opens on: the whole song whenever the song has loops, in any view;
 * otherwise the selected scene (never a choice that cannot be exported).
 *
 * "Make it as loud as streaming songs" (on by default, audio formats with
 * the project's mastering on) runs the loudness Match on the render itself:
 * the song is rendered and measured, and when it is more than 0.5 dB from
 * the loudness target the mastering's Loudness drive is set (the same
 * command Match in Mix uses, one undo step) and the song is rendered again,
 * up to two corrections. The output limiter stays, so nothing clips. The
 * result says what it did.
 *
 * Parts as separate files: one WAV per part the song lets you hear that
 * plays notes there, each on its own with its effects and its share of the
 * Reverb and Echo, without the mastering (render/stems.ts). MIDI: the notes
 * as the song plays them, one track per part (render/midi.ts).
 *
 * After an audio render a line reports the file's integrated loudness and
 * true peak against the target. While it renders the dialog stays open (only
 * Cancel export stops it) and the progress shows in the export button's
 * place. "Saved …" and "Export cancelled" survive the dialog: shown in it,
 * and raised as a toast when the dialog closes (at once if it is closed
 * already). Changing any setting clears the last result.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Dialog, Icon, NumberField, SegmentedControl, Select, Switch, newGestureId, useToasts, type ToastApi } from '../../ui/components';
import { measureExport, type ExportReport, type RenderSource } from '../../render/offline';
import { measureLoudness } from '../../render/loudness';
import { encodeWav } from '../../render/wav';
import { songMidi, type NoteSource } from '../../render/midi';
import { encodeOggOpus, opusSupported, opusSupportKnown, OPUS_BITRATE, OPUS_RATE } from '../../render/opus';
import { soloPart, stemFileNames, stemParts, zipFiles } from '../../render/stems';
import { setView, uiStore } from '../../state/uiStore';
import { matchLoudnessTarget } from '../../state/commands';
import { MASTERING_PARAMS, readParam } from '../../project/params';
import { songBars } from '../../project/arrangement';
import { MAX_SCENES, type Project } from '../../project/types';
import { barRangeWords } from '../../time/songLoop';
import { session, useProject, useUi } from '../instance';
import { notify, runtimeStore, useRuntime } from '../runtime';
import { formatSeconds } from '../session';
import { downloadBlob } from '../download';
import { requestMatchFocus } from './mix/loudnessMatch';
import { loudLabel, loudnessTarget } from './mix/mixPrefs';
import styles from './ExportDialog.module.css';

type SourceKey = string; // 'now' | 'song' | 'loop' | `perf:<id>` | `scene:<row>`
type Output = 'mix' | 'dry';
export type ExportFormat = 'wav' | 'opus' | 'stems' | 'midi';

const MINUS = '−';
/** Characters a file name cannot hold on common systems. */
const UNSAFE = /[\\/:*?"<>|]+/g;
/** Loud export: a render this close to the target (dB) is kept as it is. */
export const LOUD_TOLERANCE_DB = 0.5;
/** Loud export: at most this many corrections (each one renders the song again). */
export const LOUD_PASSES = 2;
/** Quieter than this (LUFS) is not music to match: silence, or everything muted. */
const LOUD_FLOOR_LUFS = -40;

/** A file name without the characters file systems refuse, spaces collapsed ("My: song / test?" → "My song test"). */
export function safeName(s: string): string {
  return s.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim() || 'omni-song';
}

/** True when `safeName` would leave characters out of what was typed. */
export function nameLosesCharacters(s: string): boolean {
  return /[\\/:*?"<>|]/.test(s);
}

/** "about 40 s left" from how far the render is and how long it has taken (null while too early to say). */
export function timeLeftText(fraction: number, elapsedMs: number): string | null {
  if (!(fraction > 0.02) || elapsedMs < 1000 || fraction >= 1) return null;
  const left = (elapsedMs * (1 - fraction)) / fraction / 1000;
  if (left < 8) return 'a few seconds left';
  if (left < 60) return `about ${Math.max(10, Math.round(left / 5) * 5)} s left`;
  const min = Math.round(left / 60);
  return `about ${min} min left`;
}

/** "2:19" (minutes and seconds, as a music player shows a length). */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const minus = (v: number) => `${v < 0 ? MINUS : ''}${Math.abs(v)}`;
const dbText = (v: number, unit: string) => (Number.isFinite(v) ? `${v < 0 ? MINUS : v > 0 ? '+' : ''}${Math.abs(Math.round(v * 10) / 10).toFixed(1)} ${unit}` : `— ${unit}`);
const signedDb = (v: number) => `${v < 0 ? MINUS : '+'}${Math.abs(v).toFixed(1)} dB`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;

/**
 * What the dialog opens on: the whole song whenever the song has loops;
 * otherwise the selected scene (or, when it is empty, the first scene with
 * loops); else the loops playing now, the last performance, the first scene.
 */
export function defaultExportSource(p: Project, ctx: { selectedRow: number | null; padsPlaying: boolean; canReplay: boolean }): SourceKey {
  if (songBars(p) > 0) return 'song';
  const hasLoops = (row: number) => p.tracks.some((t) => t.clips[row]);
  const row = ctx.selectedRow;
  if (row !== null && row >= 0 && row < p.scenes.length && hasLoops(row)) return `scene:${row}`;
  for (let r = 0; r < p.scenes.length; r++) if (hasLoops(r)) return `scene:${r}`;
  if (ctx.padsPlaying) return 'now';
  if (ctx.canReplay && p.performances.length) return `perf:${p.performances[p.performances.length - 1].id}`;
  return 'scene:0';
}

/** Formats that can be made of a source: notes and parts need loops (not a recorded performance). */
export function formatsFor(source: SourceKey, opus: boolean): ExportFormat[] {
  const out: ExportFormat[] = ['wav'];
  if (opus) out.push('opus');
  if (!source.startsWith('perf:')) out.push('stems', 'midi');
  return out;
}

export const FORMAT_LABEL: Record<ExportFormat, string> = {
  wav: 'WAV (best quality)',
  opus: 'Smaller file for sharing',
  stems: 'Parts as separate files',
  midi: 'MIDI file (notes only)',
};
const FORMAT_EXT: Record<ExportFormat, string> = { wav: 'wav', opus: 'opus', stems: 'zip', midi: 'mid' };
const FORMAT_BUTTON: Record<ExportFormat, string> = { wav: 'Export WAV', opus: 'Export small file', stems: 'Export parts', midi: 'Export MIDI' };
const FORMAT_SAYS: Record<ExportFormat, string> = {
  wav: 'Full quality, for streaming services, CDs and other music apps.',
  opus: 'About a tenth of the size of a WAV (Opus, 128 kbps), for sending to friends. Plays in web browsers and most music players.',
  stems: 'A .zip with one WAV per part, each on its own with its effects, reverb and echo, without the mastering: for mixing in another app. Muted parts are left out.',
  midi: 'The notes each part plays, with the tempo, for another music app: no sound, the other app plays them with its own instruments. Drums use General MIDI drum notes on channel 10.',
};

interface Result {
  tone: 'ok' | 'error';
  text: string;
  /** What "Make it as loud…" did. */
  loud?: string;
  /** The loudness report line ("Integrated −17.6 LUFS · true peak −1.0 dBTP (Streaming target −14)"). */
  report?: string;
  /** More than 1 dB off the loudness target (a mastered export, with the project's mastering on): offer Match target. */
  offTarget?: boolean;
}

interface Busy {
  /** What the progress says ("Exporting", "Checking loudness", "Part 2 of 5 (Bass)"). */
  phase: string;
  fraction: number;
  left: string | null;
}

/** The app's toasts; null where no ToastProvider is mounted (the dialog rendered on its own). */
function useToastsIfAny(): ToastApi | null {
  try {
    return useToasts();
  } catch {
    return null;
  }
}

function abortIfAsked(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
}

// Ask the browser early, so the dialog knows on its first render whether it can offer the small file.
void opusSupported();

const stereo = (b: AudioBuffer) => [b.getChannelData(0), b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)];

export function ExportDialog(props: { open: boolean; onClose(): void; initialSource?: SourceKey }) {
  const { open, onClose } = props;
  const toasts = useToastsIfAny();
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const projectName = useProject((p) => p.name);
  const performances = useProject((p) => p.performances);
  const scenes = useProject((p) => p.scenes);
  const songLength = useProject(songBars);
  const bpm = useProject((p) => p.bpm);
  const masteringOn = useProject((p) => p.mastering.enabled);
  const defaultTail = useProject((p) => p.arrangement.tailSeconds);
  const songLoop = useRuntime((s) => s.songLoop);
  // Re-read the pads when they start or stop.
  useRuntime((s) => s.playing);
  const takeRunning = useRuntime((s) => s.recording === 'performance');
  // The looped bars as the ruler counts them ("Bars 9–16"), or null.
  const loopBars = songLoop ? barRangeWords(songLoop.fromBar, songLoop.toBar) : null;

  const [source, setSource] = useState<SourceKey>('song');
  const [format, setFormat] = useState<ExportFormat>('wav');
  const [loud, setLoud] = useState(true);
  const [more, setMore] = useState(false);
  const [bars, setBars] = useState(8);
  const [tail, setTail] = useState(defaultTail);
  const [rate, setRate] = useState<'44100' | '48000'>('48000');
  const [depth, setDepth] = useState<'16' | '24'>('24');
  const [output, setOutput] = useState<Output>('mix');
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState<Busy | null>(null);
  const [message, setMessage] = useState<Result | null>(null);
  const [opusOk, setOpusOk] = useState(() => opusSupportKnown() ?? false);
  const abortRef = useRef<AbortController | null>(null);
  /** The last result, to raise as a toast once the dialog closes. */
  const pending = useRef<{ tone: 'info' | 'error'; text: string } | null>(null);
  /** The result, brought into view in a short window (200 % zoom). */
  const resultRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;

  // Pads playing now (read on each render: the dialog re-renders when playback starts or stops).
  const padsPlaying = session.sequencer?.getLauncherSnapshot().some((e) => e.playing) ?? false;

  useEffect(() => {
    let live = true;
    void opusSupported().then((ok) => live && setOpusOk(ok));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    setBusy(null);
    setTail(defaultTail);
    setBars(8);
    // Each export starts from the mix as heard, made as loud as the target: one-file choices, not settings kept.
    setOutput('mix');
    setLoud(true);
    const rt = runtimeStore.getState();
    const ui = uiStore.getState();
    const sel = ui.selectedSlot[ui.selectedTrackId];
    const init =
      props.initialSource ??
      defaultExportSource(session.store.getState(), {
        selectedRow: sel !== undefined && sel < MAX_SCENES ? sel : null,
        padsPlaying: session.sequencer?.getLauncherSnapshot().some((e) => e.playing) ?? false,
        canReplay: rt.recording === 'off',
      });
    setSource(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** A setting changed: the last result no longer describes what Export would make. */
  const changed =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setMessage(null);
      pending.current = null;
    };

  const renderSourceOf = (key: SourceKey): RenderSource => {
    if (key === 'song') return { kind: 'song' };
    if (key === 'loop') {
      if (!songLoop) throw new Error('No loop is set');
      // The looped bars once, as the song plays them there.
      return { kind: 'songRange', fromBar: songLoop.fromBar, toBar: songLoop.toBar };
    }
    if (key.startsWith('perf:')) return { kind: 'performance', performanceId: key.slice(5) };
    if (key.startsWith('scene:')) return { kind: 'scene', row: Number(key.slice(6)), bars };
    const launcher = session.sequencer?.getLauncherSnapshot() ?? session.store.getState().tracks.map((t) => ({ trackId: t.id, playing: null }));
    return { kind: 'launcher', launcher, bars };
  };

  const options = useMemo(() => {
    const len = (key: SourceKey) => {
      try {
        return ` (${clockText(session.renderPlan(renderSourceOf(key), 0).musicSeconds)})`;
      } catch {
        return '';
      }
    };
    const o: { value: string; label: string }[] = [];
    if (songLength) o.push({ value: 'song', label: `The whole song${len('song')}` });
    if (loopBars) o.push({ value: 'loop', label: `The looped part of the song, ${loopBars.toLowerCase()}${len('loop')}` });
    for (let r = 0; r < scenes.length; r++) o.push({ value: `scene:${r}`, label: `Scene “${scenes[r].name}”, looped${len(`scene:${r}`)}` });
    // Only while something plays: never a choice that would export silence.
    if (padsPlaying || source === 'now') o.push({ value: 'now', label: `The loops playing now${len('now')}` });
    for (const p of performances) o.push({ value: `perf:${p.id}`, label: `Performance “${p.name}”${len(`perf:${p.id}`)}` });
    return o;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenes, songLength, loopBars, performances, padsPlaying, source, bars, bpm]);

  // The loop was cleared while it was chosen: the whole song instead.
  useEffect(() => {
    if (source === 'loop' && !loopBars && busy === null) setSource(songLength ? 'song' : 'scene:0');
  }, [source, loopBars, songLength, busy]);

  const formats = formatsFor(source, opusOk);
  // A format the chosen source cannot be made into (MIDI of a performance): back to WAV.
  useEffect(() => {
    if (!formatsFor(source, opusOk).includes(format) && busy === null) setFormat('wav');
  }, [source, opusOk, format, busy]);

  let plan: { musicSeconds: number; totalSeconds: number } | null = null;
  try {
    plan = session.renderPlan(renderSourceOf(source), tail);
  } catch {
    plan = null;
  }
  const loopish = source === 'now' || source.startsWith('scene:');
  const audio = format !== 'midi';
  // Loud applies to a mastered mix; parts are made without the mastering.
  const mastered = (format === 'wav' || format === 'opus') && output === 'mix';
  const loudShown = mastered && masteringOn;
  const target = loudnessTarget();
  const ext = FORMAT_EXT[format];
  const what =
    source === 'song'
      ? ''
      : source === 'loop' && loopBars
        ? loopBars
        : source.startsWith('scene:')
          ? (scenes[Number(source.slice(6))]?.name ?? 'Scene')
          : source.startsWith('perf:')
            ? (performances.find((p) => p.id === source.slice(5))?.name ?? 'Performance')
            : 'Loops';
  const baseName = what ? `${safeName(projectName)} - ${safeName(what)}` : safeName(projectName);
  const defaultFile = format === 'stems' ? `${baseName} (parts)` : baseName;
  useEffect(() => {
    if (message) resultRef.current?.scrollIntoView({ block: 'nearest' });
  }, [message]);
  const typedName = filename.trim();
  const fileName = `${safeName(typedName || defaultFile)}.${ext}`;
  const nameHint = typedName && nameLosesCharacters(filename) ? `Saved as “${fileName}”: a file name cannot hold \\ / : * ? " < > |.` : null;

  const raise = (r: { tone: 'info' | 'error'; text: string }) => {
    if (toasts) toasts.show({ id: 'export', tone: r.tone, message: r.text, duration: r.tone === 'error' ? 8000 : 6000 });
    else notify(r.text, r.tone === 'error' ? 'warn' : 'info');
  };
  /** The result as a toast: now when the dialog is closed, else once it closes. */
  const toast = (tone: 'info' | 'error', text: string) => {
    if (openRef.current) pending.current = { tone, text };
    else raise({ tone, text });
  };
  const close = () => {
    if (abortRef.current) return;
    const r = pending.current;
    pending.current = null;
    onClose();
    if (r) raise(r);
  };

  /** Progress of one phase, with the time left once it can be told. */
  const tracker = (phase: string) => {
    const started = performance.now();
    let shownAt = 0;
    let left: string | null = null;
    setBusy({ phase, fraction: 0, left: null });
    return (f: number) => {
      const now = performance.now();
      // The estimate settles if it is not redrawn on every chunk.
      if (now - shownAt >= 500) {
        shownAt = now;
        left = timeLeftText(f, now - started);
      }
      setBusy({ phase, fraction: f, left });
    };
  };

  /** Render the chosen source at `sampleRate` (`project`: a part on its own). */
  const renderMix = (signal: AbortSignal, sampleRate: 44100 | 48000, phase: string, opts: { project?: Project; mastering?: boolean } = {}) =>
    session.renderAudio({
      source: renderSourceOf(source),
      sampleRate,
      tailSeconds: tail,
      mastering: opts.mastering ?? output === 'mix',
      signal,
      onProgress: tracker(phase),
      project: opts.project,
    });

  /**
   * Render, and with "Make it as loud…" on: measure, set Loudness drive by the
   * distance to the target (scaled by what the last correction did, as Match in
   * Mix does) and render again, until within LOUD_TOLERANCE_DB or after LOUD_PASSES.
   */
  const renderLoud = async (signal: AbortSignal, sampleRate: 44100 | 48000, loudOn: boolean): Promise<{ buffer: AudioBuffer; loud?: string }> => {
    let buffer = await renderMix(signal, sampleRate, loudOn ? 'Checking loudness' : 'Exporting');
    if (!loudOn) return { buffer };
    const read = (b: AudioBuffer) => measureLoudness(b.getChannelData(0), b.numberOfChannels > 1 ? b.getChannelData(1) : null, b.sampleRate, { truePeak: false }).integrated;
    let reading = read(buffer);
    const drive = () => readParam(MASTERING_PARAMS, session.store.getState().mastering.params, 'loudness');
    const first = drive();
    const gesture = newGestureId('export-loudness');
    let slope = 1;
    let note: string | null = null;
    for (let pass = 0; pass < LOUD_PASSES && !(Math.abs(reading - target.lufs) <= LOUD_TOLERANCE_DB); pass++) {
      if (!Number.isFinite(reading) || reading < LOUD_FLOOR_LUFS) {
        note = 'The song is too quiet to measure (are its parts muted?), so its loudness was left as it is.';
        break;
      }
      abortIfAsked(signal);
      const step = (target.lufs - reading) / slope;
      const before = drive();
      // matchLoudnessTarget moves the drive by (target − measured): ask for the scaled step.
      const r = matchLoudnessTarget(session.store, target.lufs, target.lufs - step, gesture);
      if (r.refused) {
        note = `The loudness was left as it is: ${r.message ?? 'the mastering cannot change now.'}`;
        break;
      }
      if (!r.changed) {
        if (r.limit === 'max') note = 'Loudness drive is at its highest: to get louder still, raise the parts or the master volume in Mix.';
        break;
      }
      buffer = await renderMix(signal, sampleRate, r.after > before ? 'Making it louder' : 'Making it quieter');
      const next = read(buffer);
      const moved = r.after - before;
      if (Math.abs(moved) > 0.05 && Number.isFinite(next)) slope = Math.min(1.2, Math.max(0.25, (next - reading) / moved));
      reading = next;
    }
    const last = drive();
    const where = `${minus(target.lufs)} LUFS, the ${target.name} level`;
    const did =
      Math.abs(last - first) >= 0.05
        ? `${last > first ? 'Made it louder' : 'Made it quieter'} to reach ${where}: Loudness drive in Mix went from ${signedDb(first)} to ${signedDb(last)} (Undo puts it back). The limiter keeps every peak under ${MINUS}1 dB, so nothing clips.`
        : Math.abs(reading - target.lufs) <= LOUD_TOLERANCE_DB
          ? `Already at ${where}: nothing needed changing.`
          : null;
    return { buffer, loud: [did, note].filter(Boolean).join(' ') || undefined };
  };

  const loudnessLine = (report: ExportReport) =>
    `Integrated ${dbText(report.integratedLufs, 'LUFS')} · true peak ${dbText(report.truePeakDb, 'dBTP')} (${target.name} target ${MINUS}${Math.abs(target.lufs)})`;

  const start = async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    abortRef.current = controller;
    pending.current = null;
    setMessage(null);
    setBusy({ phase: 'Exporting', fraction: 0, left: null });
    const name = fileName;
    try {
      let result: Result;
      if (format === 'midi') {
        const bytes = songMidi(session.store.getState(), renderSourceOf(source) as NoteSource);
        if (!bytes) throw new Error('No part plays notes here, so there is nothing to write.');
        downloadBlob(new Blob([bytes as BlobPart], { type: 'audio/midi' }), name);
        // The header's track count, less the tempo track.
        const n = ((bytes[10] << 8) | bytes[11]) - 1;
        result = { tone: 'ok', text: `Saved ${name}: ${n} part${n === 1 ? '' : 's'}, ${Math.round(bpm)} BPM${plan ? `, ${clockText(plan.musicSeconds)}` : ''}.` };
      } else if (format === 'stems') {
        const project = session.store.getState();
        const parts = stemParts(project, renderSourceOf(source) as NoteSource);
        if (!parts.length) throw new Error('No part plays notes here, so there is nothing to save.');
        const sr = Number(rate) as 44100 | 48000;
        const names = stemFileNames(
          parts.map((p) => ({ name: p.name, index: project.tracks.findIndex((t) => t.id === p.trackId) })),
          'wav',
        );
        const files: { name: string; data: Uint8Array }[] = [];
        for (let i = 0; i < parts.length; i++) {
          abortIfAsked(signal);
          const b = await renderMix(signal, sr, `Part ${i + 1} of ${parts.length} (${parts[i].name})`, { project: soloPart(project, parts[i].trackId), mastering: false });
          files.push({ name: names[i], data: new Uint8Array(encodeWav(stereo(b), b.sampleRate, Number(depth) as 16 | 24)) });
        }
        const zip = zipFiles(files);
        downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), name);
        result = {
          tone: 'ok',
          text: `Saved ${name} (${mb(zip.length)}): ${parts.length} part${parts.length === 1 ? '' : 's'} (${parts.map((p) => p.name).join(', ')})${plan ? `, ${formatSeconds(plan.totalSeconds)} each` : ''}, without mastering.`,
        };
      } else {
        const sr = format === 'opus' ? OPUS_RATE : (Number(rate) as 44100 | 48000);
        const { buffer, loud: did } = await renderLoud(signal, sr, loudShown && loud);
        setBusy({ phase: 'Saving', fraction: 1, left: null });
        const report = await measureExport(buffer);
        abortIfAsked(signal);
        let blob: Blob;
        if (format === 'opus') {
          const bytes = await encodeOggOpus(stereo(buffer), { title: projectName, signal, onProgress: tracker('Making the small file') });
          blob = new Blob([bytes as BlobPart], { type: 'audio/ogg; codecs=opus' });
        } else blob = new Blob([encodeWav(stereo(buffer), buffer.sampleRate, Number(depth) as 16 | 24)], { type: 'audio/wav' });
        abortIfAsked(signal);
        const integrated = report.integratedLufs;
        const off = Number.isFinite(integrated) && Math.abs(integrated - target.lufs) > 1;
        // Match target moves the mastering's Loudness drive: only offered while the project's mastering is on.
        const canMatch = output === 'mix' && session.store.getState().mastering.enabled;
        result = {
          tone: 'ok',
          text: `Saved ${name} (${mb(blob.size)}, ${formatSeconds(report.seconds)}${output === 'mix' ? '' : ', without mastering'}).`,
          loud: did,
          report: loudnessLine(report),
          offTarget: canMatch && off,
        };
        downloadBlob(blob, name);
      }
      session.exportSaved();
      setMessage(result);
      toast('info', [result.text, result.loud, result.report ? `${result.report}.` : ''].filter(Boolean).join(' '));
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        setMessage({ tone: 'error', text: 'Export cancelled. Nothing was saved.' });
        toast('info', 'Export cancelled. Nothing was saved.');
      } else {
        const text = `Export failed: ${e instanceof Error ? e.message : String(e)}`;
        setMessage({ tone: 'error', text });
        toast('error', text);
      }
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  };

  const matchInMix = () => {
    // Mix opens with Match target in view and focused.
    requestMatchFocus();
    close();
    setView('mix');
  };

  // Escape closes the dialog from a focused list box too (a native select may keep the key to itself).
  const onFormKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || busy || !(e.target instanceof HTMLSelectElement)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const pct = Math.round((busy?.fraction ?? 0) * 100);
  const busyText = busy ? `${busy.phase}… ${pct}%${busy.left ? ` · ${busy.left}` : ''}` : '';

  // The settings under "More options" (Simple folds them; Advanced shows them).
  const lengthField = loopish && (
    <NumberField
      label="Length"
      value={bars}
      min={1}
      max={64}
      step={1}
      unit="bars"
      onChange={changed((v: number) => setBars(Math.round(v)))}
      disabled={!!busy}
      chars={3}
      tip="How many bars of the looping scene to save."
    />
  );
  const tailField = audio && (
    <NumberField
      label="Echo tail"
      value={tail}
      min={0}
      max={10}
      step={0.5}
      unit="s"
      onChange={changed(setTail)}
      disabled={!!busy}
      chars={3}
      tip="Extra seconds at the end so echoes and reverb can ring out."
    />
  );
  const outputField = (format === 'wav' || format === 'opus') && (
    <div className={styles.field}>
      <span className={styles.fieldLabel} aria-hidden="true">
        Output
      </span>
      <SegmentedControl<Output>
        label="Output"
        kind="radio"
        size="sm"
        options={[
          { value: 'mix', label: 'Mix', tip: 'The song as you hear it, with the mastering set in Mix.' },
          { value: 'dry', label: 'Mix without mastering', tip: 'The mix before the mastering chain (for mastering elsewhere). The output limiter still keeps peaks under −1 dBTP.' },
        ]}
        value={output}
        onChange={changed(setOutput)}
        disabled={!!busy}
      />
    </div>
  );
  const pcmFields = (format === 'wav' || format === 'stems') && (
    <div className={styles.row}>
      <div className={styles.field}>
        <span className={styles.fieldLabel} aria-hidden="true">
          Sample rate
        </span>
        <SegmentedControl<'44100' | '48000'>
          label="Sample rate"
          kind="radio"
          size="sm"
          options={[
            { value: '44100', label: '44.1 kHz' },
            { value: '48000', label: '48 kHz' },
          ]}
          value={rate}
          onChange={changed(setRate)}
          disabled={!!busy}
        />
      </div>
      <div className={styles.field}>
        <span className={styles.fieldLabel} aria-hidden="true">
          Bit depth
        </span>
        <SegmentedControl<'16' | '24'>
          label="Bit depth"
          kind="radio"
          size="sm"
          options={[
            { value: '16', label: '16-bit', tip: 'Smaller files (CD quality), with dither so quiet tails stay clean.' },
            { value: '24', label: '24-bit', tip: 'The full detail of the render: the usual choice for streaming services and further work.' },
          ]}
          value={depth}
          onChange={changed(setDepth)}
          disabled={!!busy}
        />
      </div>
    </div>
  );
  const hasMore = !!(lengthField || tailField || outputField || pcmFields);
  const showMore = advanced || more;

  const summary = (() => {
    if (!plan) return 'This cannot be exported.';
    const length = `Duration ${formatSeconds(plan.totalSeconds)} (${formatSeconds(plan.musicSeconds)} of music + ${tail} s tail)`;
    if (format === 'midi') return `${formatSeconds(plan.musicSeconds)} of notes · ${Math.round(bpm)} BPM`;
    if (format === 'opus') return `${length} · stereo · Opus ${OPUS_BITRATE / 1000} kbps · about ${mb((plan.totalSeconds * OPUS_BITRATE) / 8)}`;
    if (format === 'stems') return `${length} · one stereo WAV per part · ${Number(rate) / 1000} kHz · ${depth}-bit · without mastering`;
    const bytes = plan.totalSeconds * Number(rate) * 2 * (Number(depth) / 8);
    return `${length} · stereo · ${Number(rate) / 1000} kHz · ${depth}-bit · about ${mb(bytes)}${output === 'dry' ? ' · without mastering' : ''}`;
  })();

  return (
    <Dialog
      open={open}
      // Only Cancel export stops a render: a stray click outside or Esc does nothing while it runs.
      dismissible={!busy}
      onClose={close}
      title="Export"
      description="Makes a file on this device with the same sounds, effects and timing you hear. It is not a recording of your speakers."
      size="md"
      actions={
        busy ? (
          <>
            <Button variant="secondary" onClick={() => abortRef.current?.abort()}>
              Cancel export
            </Button>
            <div
              className={styles.progress}
              role="progressbar"
              aria-label="Export progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-valuetext={busyText}
              data-testid="export-progress"
            >
              <span className={styles.progressFill} style={{ width: `${pct}%` }} aria-hidden="true" />
              <span className={styles.progressText} data-testid="export-progress-text">
                {busyText}
              </span>
            </div>
          </>
        ) : (
          <Button variant="primary" icon="download" onClick={() => void start()} disabled={!plan}>
            {FORMAT_BUTTON[format]}
          </Button>
        )
      }
    >
      <div className={styles.form} onKeyDown={onFormKey}>
        <Select label="What to export" value={source} options={options} onChange={changed(setSource)} disabled={!!busy} />
        <div className={styles.fieldGroup}>
          <Select
            label="Format"
            value={format}
            options={formats.map((f) => ({ value: f, label: FORMAT_LABEL[f] }))}
            onChange={changed((v: string) => setFormat(v as ExportFormat))}
            disabled={!!busy}
          />
          <p className={styles.hint} data-testid="export-format-says">
            {FORMAT_SAYS[format]}
          </p>
        </div>
        {loudShown && (
          <div className={styles.fieldGroup}>
            <Switch
              label={loudLabel(target)}
              checked={loud}
              onChange={changed(setLoud)}
              disabled={!!busy}
              tip={`Before saving, the song is measured and the mastering’s Loudness drive is set so it lands at ${minus(target.lufs)} LUFS. Undo puts it back.`}
              detail="The same as Match target in Mix, done on the export itself. The output limiter keeps peaks under −1 dBTP, so nothing clips. When the song is not on the target yet it is rendered twice."
            />
            <p className={styles.hint}>
              {loud ? `Sets the mastering’s Loudness drive so the song lands at ${minus(target.lufs)} LUFS. Nothing clips: the limiter stays.` : 'Saved at the level it plays now.'}
            </p>
            {takeRunning && loud && <p className={styles.hint}>A performance is recording: the loudness cannot change until it ends.</p>}
          </div>
        )}
        {mastered && !masteringOn && <p className={styles.hint}>Mastering is off in Mix, so the song is saved at the level it plays now.</p>}
        <div className={styles.fileField}>
          <label className={styles.file}>
            <span>File name</span>
            <input
              type="text"
              value={filename}
              placeholder={defaultFile}
              onChange={(e) => {
                setFilename(e.target.value);
                setMessage(null);
                pending.current = null;
              }}
              disabled={!!busy}
              maxLength={80}
              aria-describedby={nameHint ? 'export-name-hint' : undefined}
            />
            <span className={styles.ext}>.{ext}</span>
          </label>
          {nameHint && (
            <p id="export-name-hint" className={styles.hint} data-testid="export-name-hint">
              {nameHint}
            </p>
          )}
        </div>
        {hasMore && !advanced && (
          <button type="button" className={styles.moreToggle} aria-expanded={more} aria-controls="export-more" onClick={() => setMore((m) => !m)}>
            <Icon name={more ? 'chevronDown' : 'chevronRight'} size={14} />
            More options
          </button>
        )}
        {hasMore && showMore && (
          <div id="export-more" className={advanced ? styles.moreOpen : styles.more}>
            {lengthField}
            {outputField}
            {tailField}
            {pcmFields}
          </div>
        )}
        <p className={styles.summary} data-testid="export-summary">
          {summary}
        </p>
        {message && (
          <div ref={resultRef} className={message.tone === 'ok' ? styles.ok : styles.error} role="status" data-testid="export-result">
            <p className={styles.resultText}>{message.text}</p>
            {message.loud && (
              <p className={styles.resultText} data-testid="export-loud">
                {message.loud}
              </p>
            )}
            {message.report && (
              <p className={`${styles.report} mono`} data-testid="export-report">
                {message.report}
              </p>
            )}
            {message.offTarget && (
              <Button size="sm" variant="ghost" icon="sparkle" onClick={matchInMix} className={styles.link} tip="Open Mix, where Match target sets Loudness drive so the song lands on the target.">
                Match target in Mix
              </Button>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
