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
 * the project's mastering on, for the whole song or a performance) runs the
 * loudness match on the render itself (share/fileMaker renderLoud): the song
 * is rendered and measured, and when it is more than 0.5 dB from the loudness
 * target it is rendered again from a copy of the project with the
 * mastering's Loudness drive moved, up to two corrections. Only the file
 * changes: the project's mastering stays as it is and no undo step is made
 * (round 7; 2.4 set Loudness drive once the file was saved). The result says
 * by how much the file was made louder. The output limiter stays, so nothing
 * clips.
 *
 * Parts as separate files: one WAV per part the song lets you hear that
 * plays notes there, each on its own with its effects and its share of the
 * Reverb and Echo, without the mastering (render/stems.ts). MIDI: the notes
 * as the song plays them, one track per part (render/midi.ts). The small
 * file is Opus in an Ogg file, saved as .ogg (audio/ogg).
 *
 * After an audio render a line reports the file's integrated loudness and
 * true peak against the target. While it renders the dialog stays open (only
 * Cancel export stops it) and the progress shows in the export button's
 * place. "Saved …" and "Export cancelled" survive the dialog: shown in it,
 * and raised as a toast when the dialog closes (at once if it is closed
 * already). Changing any setting clears the last result.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Dialog, Icon, NumberField, SegmentedControl, Select, Switch, useToasts, type ToastApi } from '../../ui/components';
import { measureExport, type ExportReport, type RenderSource } from '../../render/offline';
import { encodeWav } from '../../render/wav';
import type { NoteSource } from '../../render/midi';
import { encodeOggOpus, opusSupported, opusSupportKnown, OPUS_BITRATE, OPUS_RATE } from '../../render/opus';
import { setView, uiStore } from '../../state/uiStore';
import { songBars } from '../../project/arrangement';
import { MAX_SCENES, type Project } from '../../project/types';
import { barRangeWords } from '../../time/songLoop';
import { session, useProject, useUi } from '../instance';
import { notify, runtimeStore, useRuntime } from '../runtime';
import { formatSeconds } from '../session';
import { downloadBlob } from '../download';
import { requestMatchFocus } from './mix/loudnessMatch';
import { loudLabel, loudnessTarget } from './mix/mixPrefs';
import {
  FILE_EXT,
  FILE_MIME,
  abortIfAsked,
  clockText,
  makeMidi,
  progressTracker,
  renderLoud,
  renderStemsZip,
  stereo,
  safeName,
  nameLosesCharacters,
  type Busy,
  type FileFormat,
  type LoudFile,
  type LoudPhase,
} from './share/fileMaker';
import styles from './ExportDialog.module.css';

// Shared with Share (share/fileMaker): kept importable from here.
export { LOUD_PASSES, LOUD_TOLERANCE_DB, clockText, nameLosesCharacters, safeName, timeLeftText } from './share/fileMaker';

type SourceKey = string; // 'now' | 'song' | 'loop' | `perf:<id>` | `scene:<row>`
type Output = 'mix' | 'dry';
export type ExportFormat = FileFormat;

const MINUS = '−';

const minus = (v: number) => `${v < 0 ? MINUS : ''}${Math.abs(v)}`;
const dbText = (v: number, unit: string) => (Number.isFinite(v) ? `${v < 0 ? MINUS : v > 0 ? '+' : ''}${Math.abs(Math.round(v * 10) / 10).toFixed(1)} ${unit}` : `— ${unit}`);
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

/** The app's toasts; null where no ToastProvider is mounted (the dialog rendered on its own). */
function useToastsIfAny(): ToastApi | null {
  try {
    return useToasts();
  } catch {
    return null;
  }
}

// Ask the browser early, so the dialog knows on its first render whether it can offer the small file.
void opusSupported();

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
  // Only a whole piece sets the song's level: the song, or a performance (it plays through the song's mastering).
  const loudSource = source === 'song' || source.startsWith('perf:');
  const loudShown = mastered && masteringOn && loudSource;
  const target = loudnessTarget();
  const ext = FILE_EXT[format];
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

  /** Progress of one phase, with the time left once it can be told (`passesAfter`: renders still to come). */
  const tracker = (phase: string, passesAfter = 0) => progressTracker(setBusy, phase, passesAfter);

  /** Render the chosen source at `sampleRate` (`project`: a part on its own). */
  const renderMix = (signal: AbortSignal, sampleRate: 44100 | 48000, phase: string, opts: { project?: Project; mastering?: boolean; passesAfter?: number } = {}) =>
    session.renderAudio({
      source: renderSourceOf(source),
      sampleRate,
      tailSeconds: tail,
      mastering: opts.mastering ?? output === 'mix',
      signal,
      onProgress: tracker(phase, opts.passesAfter),
      project: opts.project,
    });

  /** What the progress says during each render of a loud export. */
  const LOUD_PHASE: Record<LoudPhase, string> = { plain: 'Exporting', measure: 'Checking loudness', louder: 'Making it louder', quieter: 'Making it quieter' };

  /**
   * Render, and with "Make it as loud…" on: measure, and render again from a
   * copy with Loudness drive moved until the file is on the target
   * (share/fileMaker renderLoud). The project is never changed.
   */
  const renderLoudFile = (signal: AbortSignal, sampleRate: 44100 | 48000, loudOn: boolean): Promise<LoudFile> =>
    renderLoud({
      base: session.store.getState(),
      loud: loudOn,
      targetLufs: target.lufs,
      signal,
      render: (project, o) => renderMix(signal, sampleRate, LOUD_PHASE[o.phase], { project, passesAfter: o.passesAfter }),
    });

  /** What "Make it as loud…" did to the file, in words (the song itself is never changed). */
  const loudWords = (loud: LoudFile): string | undefined => {
    const where = `${minus(target.lufs)} LUFS, the ${target.name} level`;
    let did: string | null = null;
    const by = Math.abs(loud.drive - loud.first);
    if (by >= 0.05)
      did = `The file was made ${by.toFixed(1)} dB ${loud.drive > loud.first ? 'louder' : 'quieter'} to ${loud.reached ? 'reach' : 'come near'} ${where}. Your song’s mastering in Mix was not changed. The limiter keeps every peak under ${MINUS}1 dB, so nothing clips.`;
    else if (loud.reached) did = `Already at ${where}: nothing needed changing.`;
    const note =
      loud.stop === 'quiet'
        ? 'The song is too quiet to measure (are its parts muted?), so the file was saved at the level it plays.'
        : loud.stop === 'max'
          ? 'Loudness drive is at its highest: to get louder still, raise the parts or the master volume in Mix.'
          : null;
    return [did, note].filter(Boolean).join(' ') || undefined;
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
        const { bytes, tracks: n } = makeMidi(session.store.getState(), renderSourceOf(source) as NoteSource, 'No part plays notes here, so there is nothing to write.');
        downloadBlob(new Blob([bytes as BlobPart], { type: FILE_MIME.midi }), name);
        result = { tone: 'ok', text: `Saved ${name}: ${n} part${n === 1 ? '' : 's'}, ${Math.round(bpm)} BPM${plan ? `, ${clockText(plan.musicSeconds)}` : ''}.` };
      } else if (format === 'stems') {
        const sr = Number(rate) as 44100 | 48000;
        const { zip, names: parts } = await renderStemsZip({
          project: session.store.getState(),
          source: renderSourceOf(source) as NoteSource,
          depth: Number(depth) as 16 | 24,
          signal,
          nothing: 'No part plays notes here, so there is nothing to save.',
          render: (project, i, n, partName) => renderMix(signal, sr, `Part ${i + 1} of ${n} (${partName})`, { project, mastering: false }),
        });
        downloadBlob(new Blob([zip as BlobPart], { type: FILE_MIME.stems }), name);
        result = {
          tone: 'ok',
          text: `Saved ${name} (${mb(zip.length)}): ${parts.length} part${parts.length === 1 ? '' : 's'} (${parts.join(', ')})${plan ? `, ${formatSeconds(plan.totalSeconds)} each` : ''}, without mastering.`,
        };
      } else {
        const sr = format === 'opus' ? OPUS_RATE : (Number(rate) as 44100 | 48000);
        const made = await renderLoudFile(signal, sr, loudShown && loud);
        const { buffer } = made;
        setBusy({ phase: 'Saving', fraction: 1, left: null });
        const report = await measureExport(buffer);
        abortIfAsked(signal);
        let blob: Blob;
        if (format === 'opus') {
          const bytes = await encodeOggOpus(stereo(buffer), { title: projectName, signal, onProgress: tracker('Making the small file') });
          blob = new Blob([bytes as BlobPart], { type: FILE_MIME.opus });
        } else blob = new Blob([encodeWav(stereo(buffer), buffer.sampleRate, Number(depth) as 16 | 24)], { type: FILE_MIME.wav });
        abortIfAsked(signal);
        downloadBlob(blob, name);
        const did = loudShown && loud ? loudWords(made) : undefined;
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
              tip={`The song is measured, and the file is made with the mastering’s Loudness drive moved so it lands at ${minus(target.lufs)} LUFS. Only the file changes: your song’s mastering stays as it is.`}
              detail="Match target in Mix, done on a copy for the file only. The output limiter keeps peaks under −1 dBTP, so nothing clips. When the song is not on the target yet it is rendered twice."
            />
            <p className={styles.hint} data-testid="export-loud-hint">
              {loud ? `The file lands at ${minus(target.lufs)} LUFS; your song in Mix stays as it is. Nothing clips: the limiter stays.` : 'Saved at the level it plays now.'}
            </p>
          </div>
        )}
        {mastered && !masteringOn && <p className={styles.hint}>Mastering is off in Mix, so the song is saved at the level it plays now.</p>}
        {mastered && masteringOn && !loudSource && (
          <p className={styles.hint} data-testid="export-loud-song-only">
            Saved at the level it plays now. To {loudLabel(target).replace(/^M/, 'm')}, export the whole song.
          </p>
        )}
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
            {message.offTarget && advanced && (
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
