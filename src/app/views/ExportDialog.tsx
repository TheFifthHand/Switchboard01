/**
 * Export audio: renders offline with the same engine, routing, timing and
 * automation as playback (not a recording of the speakers) and saves a
 * stereo PCM WAV.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, NumberField, SegmentedControl, Select } from '../../ui/components';
import type { RenderSource } from '../../render/offline';
import { session, useProject } from '../instance';
import { runtimeStore } from '../runtime';
import { formatSeconds } from '../session';
import { downloadBlob } from '../download';
import styles from './ExportDialog.module.css';

type SourceKey = string; // 'now' | 'song' | `perf:<id>` | `scene:<row>`

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) || 'switchboard';
}

export function ExportDialog(props: { open: boolean; onClose(): void; initialSource?: SourceKey }) {
  const { open, onClose } = props;
  const projectName = useProject((p) => p.name);
  const performances = useProject((p) => p.performances);
  const scenes = useProject((p) => p.scenes);
  const blocks = useProject((p) => p.arrangement.blocks.length);
  const defaultTail = useProject((p) => p.arrangement.tailSeconds);

  const [source, setSource] = useState<SourceKey>('now');
  const [bars, setBars] = useState(8);
  const [tail, setTail] = useState(defaultTail);
  const [rate, setRate] = useState<'44100' | '48000'>('48000');
  const [depth, setDepth] = useState<'16' | '24'>('16');
  const [filename, setFilename] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    setProgress(null);
    setTail(defaultTail);
    const init = props.initialSource ?? (performances.length && runtimeStore.getState().recording === 'off' ? `perf:${performances[performances.length - 1].id}` : 'now');
    setSource(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const options = useMemo(() => {
    const o = [{ value: 'now', label: 'Clips playing now (loop)' }];
    for (let r = 0; r < scenes.length; r++) o.push({ value: `scene:${r}`, label: `Scene: ${scenes[r].name} (loop)` });
    if (blocks) o.push({ value: 'song', label: 'Song (arrangement)' });
    for (const p of performances) o.push({ value: `perf:${p.id}`, label: `Performance: ${p.name}` });
    return o;
  }, [scenes, blocks, performances]);

  const renderSource = (): RenderSource => {
    if (source === 'song') return { kind: 'song' };
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
  const defaultFile = `${safeName(projectName)} - ${safeName(label.replace(/^(Performance|Scene): /, '').replace(/ \(.*\)$/, ''))}`;
  const busy = progress !== null;

  const start = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setMessage(null);
    setProgress(0);
    try {
      const blob = await session.renderWav({
        source: renderSource(),
        sampleRate: Number(rate) as 44100 | 48000,
        bitDepth: Number(depth) as 16 | 24,
        tailSeconds: tail,
        signal: controller.signal,
        onProgress: (f) => setProgress(f),
      });
      const name = `${safeName(filename || defaultFile)}.wav`;
      downloadBlob(blob, name);
      setMessage({ tone: 'ok', text: `Saved ${name} (${(blob.size / 1024 / 1024).toFixed(1)} MB, ${plan ? formatSeconds(plan.totalSeconds) : ''}).` });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') setMessage({ tone: 'error', text: 'Export cancelled. Nothing was saved.' });
      else setMessage({ tone: 'error', text: `Export failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        abortRef.current?.abort();
        onClose();
      }}
      title="Export audio"
      description="Renders a stereo WAV on this device with the same sounds, effects and timing you hear. It is not a recording of your speakers."
      size="md"
      actions={
        busy ? (
          <Button variant="secondary" onClick={() => abortRef.current?.abort()}>
            Cancel export
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" icon="download" onClick={() => void start()} disabled={!plan || nothingPlaying}>
              Export WAV
            </Button>
          </>
        )
      }
    >
      <div className={styles.form}>
        <Select label="What to export" value={source} options={options} onChange={setSource} disabled={busy} />
        {loopish && (
          <NumberField label="Length" value={bars} min={1} max={64} step={1} unit="bars" onChange={(v) => setBars(Math.round(v))} disabled={busy} chars={3} />
        )}
        <NumberField label="Tail" value={tail} min={0} max={10} step={0.5} unit="s" onChange={setTail} disabled={busy} chars={3} tip="Extra seconds at the end so echoes and reverb can ring out." />
        <div className={styles.row}>
          <SegmentedControl<'44100' | '48000'> label="Sample rate" kind="radio" size="sm" options={[{ value: '44100', label: '44.1 kHz' }, { value: '48000', label: '48 kHz' }]} value={rate} onChange={setRate} disabled={busy} />
          <SegmentedControl<'16' | '24'> label="Bit depth" kind="radio" size="sm" options={[{ value: '16', label: '16-bit' }, { value: '24', label: '24-bit' }]} value={depth} onChange={setDepth} disabled={busy} />
        </div>
        <label className={styles.file}>
          <span>File name</span>
          <input type="text" value={filename} placeholder={defaultFile} onChange={(e) => setFilename(e.target.value)} disabled={busy} maxLength={80} />
          <span className={styles.ext}>.wav</span>
        </label>
        <p className={styles.summary}>
          {nothingPlaying
            ? 'Nothing is playing right now. Launch some clips, or choose a scene, the song or a performance.'
            : plan
              ? `Duration ${formatSeconds(plan.totalSeconds)} (${formatSeconds(plan.musicSeconds)} of music + ${tail} s tail) · stereo · ${Number(rate) / 1000} kHz · ${depth}-bit`
              : 'This source cannot be exported.'}
        </p>
        {busy && (
          <div className={styles.progress} role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)}>
            <div className={styles.progressFill} style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            <span className={`${styles.progressText} mono`}>{Math.round((progress ?? 0) * 100)}%</span>
          </div>
        )}
        {message && (
          <p className={message.tone === 'ok' ? styles.ok : styles.error} role="status">
            {message.text}
          </p>
        )}
      </div>
    </Dialog>
  );
}
