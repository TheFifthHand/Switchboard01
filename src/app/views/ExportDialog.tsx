/**
 * Export audio: renders offline with the same engine, routing, timing and
 * automation as playback (not a recording of the speakers) and saves a
 * stereo PCM WAV (24-bit by default; 16-bit files are dithered).
 *
 * Opened from Arrange (or while the song plays) it offers the song first.
 * With a song loop set, "Loop" exports the looped blocks once (with the
 * tail). Music playing on goes on while the export prepares and renders.
 *
 * Output: the mix as heard (with the project's mastering), or the mix without
 * mastering (the output limiter and its ceiling stay). After a render a line
 * reports the file's integrated loudness and true peak against the loudness
 * target chosen in Mix, with a way back to Match target when it is more than
 * 1 dB off. While it renders the dialog stays open (only Cancel export stops
 * it). "Saved …" and "Export cancelled" survive the dialog: shown in it, and
 * raised as a toast when the dialog closes (at once if it is closed already),
 * so a toast never covers the dialog's own keys. Changing any setting clears
 * the last result.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, NumberField, SegmentedControl, Select, useToasts, type ToastApi } from '../../ui/components';
import type { RenderSource } from '../../render/offline';
import { setView, uiStore } from '../../state/uiStore';
import { songBlocks } from '../../time/sequencer';
import { songLoopRange } from '../../time/songLoop';
import { session, useProject } from '../instance';
import { notify, runtimeStore, useRuntime } from '../runtime';
import { formatSeconds } from '../session';
import { downloadBlob } from '../download';
import { requestMatchFocus } from './mix/loudnessMatch';
import { loudnessTarget } from './mix/mixPrefs';
import styles from './ExportDialog.module.css';

type SourceKey = string; // 'now' | 'song' | 'loop' | `perf:<id>` | `scene:<row>`
type Output = 'mix' | 'dry';

const MINUS = '−';
/** Characters a file name cannot hold on common systems. */
const UNSAFE = /[\\/:*?"<>|]+/g;

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

const dbText = (v: number, unit: string) => (Number.isFinite(v) ? `${v < 0 ? MINUS : v > 0 ? '+' : ''}${Math.abs(Math.round(v * 10) / 10).toFixed(1)} ${unit}` : `— ${unit}`);

interface Result {
  tone: 'ok' | 'error';
  text: string;
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

export function ExportDialog(props: { open: boolean; onClose(): void; initialSource?: SourceKey }) {
  const { open, onClose } = props;
  const toasts = useToastsIfAny();
  const projectName = useProject((p) => p.name);
  const performances = useProject((p) => p.performances);
  const scenes = useProject((p) => p.scenes);
  const blocks = useProject((p) => p.arrangement.blocks.length);
  const defaultTail = useProject((p) => p.arrangement.tailSeconds);
  const songLoop = useRuntime((s) => s.songLoop);
  // The loop's first and last block on the lane (1-based, as the lane counts them), or null.
  const loopBlocks = useProject((p) => {
    const r = songLoopRange(songBlocks(p), songLoop);
    return r ? `${r[0] + 1}-${r[1] + 1}` : null;
  });

  const [source, setSource] = useState<SourceKey>('now');
  const [bars, setBars] = useState(8);
  const [tail, setTail] = useState(defaultTail);
  const [rate, setRate] = useState<'44100' | '48000'>('48000');
  const [depth, setDepth] = useState<'16' | '24'>('24');
  const [output, setOutput] = useState<Output>('mix');
  const [filename, setFilename] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [left, setLeft] = useState<string | null>(null);
  const [message, setMessage] = useState<Result | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedAt = useRef(0);
  const leftAt = useRef(0);
  /** The last result, to raise as a toast once the dialog closes. */
  const pending = useRef<{ tone: 'info' | 'error'; text: string } | null>(null);
  /** The progress bar, then the result: brought into view in a short window (200 % zoom). */
  const progressRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    setProgress(null);
    setTail(defaultTail);
    // Each export starts from the mix as heard: "without mastering" is a choice for one file, not a setting kept.
    setOutput('mix');
    const rt = runtimeStore.getState();
    // From Arrange, or while the song plays or is paused, the song is what there is to export.
    const song = blocks > 0 && (uiStore.getState().view === 'arrange' || (rt.mode === 'song' && (rt.playing || rt.paused)));
    const init = props.initialSource ?? (song ? 'song' : performances.length && rt.recording === 'off' ? `perf:${performances[performances.length - 1].id}` : 'now');
    setSource(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** A setting changed: the last result no longer describes what Export WAV would make. */
  const changed =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setMessage(null);
      pending.current = null;
    };

  const options = useMemo(() => {
    const o = [{ value: 'now', label: 'Clips playing now (loop)' }];
    for (let r = 0; r < scenes.length; r++) o.push({ value: `scene:${r}`, label: `Scene: ${scenes[r].name} (loop)` });
    if (blocks) o.push({ value: 'song', label: 'Song (arrangement)' });
    if (loopBlocks) {
      const [a, b] = loopBlocks.split('-');
      o.push({ value: 'loop', label: a === b ? `Loop (block ${a})` : `Loop (blocks ${a}–${b})` });
    }
    for (const p of performances) o.push({ value: `perf:${p.id}`, label: `Performance: ${p.name}` });
    return o;
  }, [scenes, blocks, loopBlocks, performances]);

  // The loop was cleared while it was chosen: the whole song instead.
  useEffect(() => {
    if (source === 'loop' && !loopBlocks && progress === null) setSource(blocks ? 'song' : 'now');
  }, [source, loopBlocks, blocks, progress]);

  const renderSource = (): RenderSource => {
    if (source === 'song') return { kind: 'song' };
    if (source === 'loop') {
      if (!songLoop) throw new Error('No loop is set');
      // The looped blocks once, as the song plays them there.
      return { kind: 'songRange', fromBlockId: songLoop.fromBlockId, toBlockId: songLoop.toBlockId };
    }
    if (source.startsWith('perf:')) return { kind: 'performance', performanceId: source.slice(5) };
    if (source.startsWith('scene:')) return { kind: 'scene', row: Number(source.slice(6)), bars };
    const launcher = session.sequencer?.getLauncherSnapshot() ?? session.store.getState().tracks.map((t) => ({ trackId: t.id, playing: null }));
    return { kind: 'launcher', launcher, bars };
  };

  let plan: { musicSeconds: number; totalSeconds: number } | null = null;
  try {
    plan = session.renderPlan(renderSource(), tail);
  } catch {
    plan = null;
  }
  const loopish = source === 'now' || source.startsWith('scene:');
  const nothingPlaying = source === 'now' && !(session.sequencer?.getLauncherSnapshot().some((e) => e.playing) ?? false);
  const label = options.find((o) => o.value === source)?.label ?? '';
  const defaultFile = `${safeName(projectName)} - ${safeName(source === 'loop' && loopBlocks ? `Loop ${loopBlocks}` : label.replace(/^(Performance|Scene): /, '').replace(/ \(.*\)$/, ''))}`;
  const busy = progress !== null;
  useEffect(() => {
    if (busy) progressRef.current?.scrollIntoView({ block: 'nearest' });
  }, [busy]);
  useEffect(() => {
    if (message) resultRef.current?.scrollIntoView({ block: 'nearest' });
  }, [message]);
  const typedName = filename.trim();
  const fileName = `${safeName(typedName || defaultFile)}.wav`;
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

  const start = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    pending.current = null;
    setMessage(null);
    setProgress(0);
    setLeft(null);
    startedAt.current = performance.now();
    leftAt.current = 0;
    const name = fileName;
    const mastering = output === 'mix';
    try {
      const { blob, report } = await session.renderWavWithReport({
        source: renderSource(),
        sampleRate: Number(rate) as 44100 | 48000,
        bitDepth: Number(depth) as 16 | 24,
        tailSeconds: tail,
        mastering,
        signal: controller.signal,
        onProgress: (f) => {
          setProgress(f);
          const now = performance.now();
          // The estimate settles if it is not redrawn on every chunk.
          if (now - leftAt.current >= 500) {
            leftAt.current = now;
            setLeft(timeLeftText(f, now - startedAt.current));
          }
        },
      });
      downloadBlob(blob, name);
      const t = loudnessTarget();
      const integrated = report.integratedLufs;
      const off = Number.isFinite(integrated) && Math.abs(integrated - t.lufs) > 1;
      // Match target moves the mastering's Loudness drive: only offered while the project's mastering is on.
      const canMatch = mastering && session.store.getState().mastering.enabled;
      const line = `Integrated ${dbText(integrated, 'LUFS')} · true peak ${dbText(report.truePeakDb, 'dBTP')} (${t.name} target ${MINUS}${Math.abs(t.lufs)})`;
      const text = `Saved ${name} (${(blob.size / 1024 / 1024).toFixed(1)} MB, ${formatSeconds(report.seconds)}${mastering ? '' : ', without mastering'}).`;
      setMessage({ tone: 'ok', text, report: line, offTarget: canMatch && off });
      toast('info', `${text} ${line}.`);
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
      setProgress(null);
      setLeft(null);
      abortRef.current = null;
    }
  };

  const matchInMix = () => {
    // Mix opens with Match target in view and focused.
    requestMatchFocus();
    close();
    setView('mix');
  };

  const pct = Math.round((progress ?? 0) * 100);

  return (
    <Dialog
      open={open}
      // Only Cancel export stops a render: a stray click outside or Esc does nothing while it runs.
      dismissible={!busy}
      onClose={close}
      title="Export audio"
      description="Renders a stereo WAV on this device with the same sounds, effects and timing you hear. It is not a recording of your speakers."
      size="md"
      actions={
        busy ? (
          <Button variant="secondary" onClick={() => abortRef.current?.abort()}>
            Cancel export
          </Button>
        ) : (
          <Button variant="primary" icon="download" onClick={() => void start()} disabled={!plan || nothingPlaying}>
            Export WAV
          </Button>
        )
      }
    >
      <div className={styles.form}>
        <Select label="What to export" value={source} options={options} onChange={changed(setSource)} disabled={busy} />
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
            disabled={busy}
          />
        </div>
        {loopish && (
          <NumberField label="Length" value={bars} min={1} max={64} step={1} unit="bars" onChange={changed((v: number) => setBars(Math.round(v)))} disabled={busy} chars={3} />
        )}
        <NumberField
          label="Echo tail"
          value={tail}
          min={0}
          max={10}
          step={0.5}
          unit="s"
          onChange={changed(setTail)}
          disabled={busy}
          chars={3}
          tip="Extra seconds at the end so echoes and reverb can ring out."
        />
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
              disabled={busy}
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
              disabled={busy}
            />
          </div>
        </div>
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
              disabled={busy}
              maxLength={80}
              aria-describedby={nameHint ? 'export-name-hint' : undefined}
            />
            <span className={styles.ext}>.wav</span>
          </label>
          {nameHint && (
            <p id="export-name-hint" className={styles.hint} data-testid="export-name-hint">
              {nameHint}
            </p>
          )}
        </div>
        <p className={styles.summary}>
          {nothingPlaying
            ? 'Nothing is playing right now. Launch some clips, or choose a scene, the song or a performance.'
            : plan
              ? `Duration ${formatSeconds(plan.totalSeconds)} (${formatSeconds(plan.musicSeconds)} of music + ${tail} s tail) · stereo · ${Number(rate) / 1000} kHz · ${depth}-bit${output === 'dry' ? ' · without mastering' : ''}`
              : 'This source cannot be exported.'}
        </p>
        {busy && (
          <div ref={progressRef} className={styles.progress} role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${pct}%${left ? `, ${left}` : ''}`}>
            <div className={styles.progressFill} style={{ width: `${pct}%` }} />
            <span className={`${styles.progressText} mono`} data-testid="export-progress-text">
              {pct}%{left ? ` · ${left}` : ''}
            </span>
          </div>
        )}
        {message && (
          <div ref={resultRef} className={message.tone === 'ok' ? styles.ok : styles.error} role="status" data-testid="export-result">
            <p className={styles.resultText}>{message.text}</p>
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
