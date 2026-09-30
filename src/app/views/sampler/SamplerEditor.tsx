/**
 * Sampler editor for one part (used in the Shape view's Instrument column).
 *
 * A sampler part with a recording shows:
 *   RECORDING  picker (built-in + imported) · Audition · waveform with Start/End
 *              trim handles · fade in / fade out · start/length/end readouts
 *   PLAYBACK   One-shot / Loop · root note · gain, pitch, fine, attack, release, cutoff
 *   TEMPO      Tempo Sync (speed and pitch together) · Original BPM · bars helper
 *   IMPORT     import a WAV or MP3 from this device
 *
 * A part that is not a sampler yet (or has no recording) shows the import
 * drop zone and the recording picker; either one turns it into a sampler.
 *
 * Every control edits the real project: parameters through
 * session.setInstrumentParam (recordable, one undo step per gesture), the
 * recording through cmd.assignSample, imports through session.importSample.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Icon, NumberField, SegmentedControl, Select, Switch, noteName, type SelectOption } from '../../../ui/components';
import { BUILTIN_SAMPLES, builtinSampleInfo } from '../../../content/catalog';
import { snapToScale } from '../../../music/scales';
import { moduleId } from '../../../project/factory';
import type { Id } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { session, useProject } from '../../instance';
import { INSTRUMENT_LABEL, soundName } from '../../labels';
import { useRuntime } from '../../runtime';
import { ParamKnob } from '../shape/ParamKnob';
import { ImportSampleButton } from './ImportSampleButton';
import { importedRecently } from './importState';
import { isBuiltinId, useSampleOverview } from './sampleOverview';
import {
  BARS_MAX,
  BARS_MIN,
  BARS_STEP,
  ORIGINAL_BPM_MAX,
  ORIGINAL_BPM_MIN,
  barsRange,
  barsToBpm,
  fileKind,
  formatBars,
  formatBpm,
  formatBytes,
  formatDuration,
  formatSampleRate,
  formatSemitones,
  formatTime,
  rateToSemitones,
  rootRate,
  suggestedBars,
  syncRate,
} from './samplerMath';
import { readSamplerValues, samplerSpec, useSamplerController, useSamplerValues, type SamplerParamId } from './samplerValues';
import { WaveformTrim } from './WaveformTrim';
import styles from './SamplerEditor.module.css';

export interface SamplerEditorProps {
  trackId: string;
}

/** Parts whose picker should take keyboard focus when the full editor appears (after a choice from the empty state). */
const focusPickerOnMount = new Set<Id>();
const pickerId = (trackId: Id) => `sampler-recording-${trackId}`;

const ROOT_OPTIONS: SelectOption[] = (() => {
  const spec = samplerSpec('rootNote');
  const out: SelectOption[] = [];
  for (let m = spec.min; m <= spec.max; m++) out.push({ value: String(m), label: noteName(m) });
  return out;
})();

/* ------------------------------------------------------------------ */
/* Recording picker                                                    */
/* ------------------------------------------------------------------ */

function SamplePicker(props: { trackId: Id; sampleId: Id | null; label: string; onAssigned?(): void }) {
  const { trackId, sampleId, label, onAssigned } = props;
  const samples = useProject((p) => p.samples);
  const takeLocked = useRuntime((s) => s.recording === 'performance');
  const options = useMemo(() => {
    const out: SelectOption[] = [];
    if (sampleId === null) out.push({ value: '', label: 'Choose a recording…', disabled: true });
    else if (!isBuiltinId(sampleId) && !samples.some((s) => s.id === sampleId)) out.push({ value: sampleId, label: 'Missing recording', disabled: true });
    else if (isBuiltinId(sampleId) && !builtinSampleInfo(sampleId)) out.push({ value: sampleId, label: 'Unknown built-in recording', disabled: true });
    for (const b of BUILTIN_SAMPLES) out.push({ value: b.id, label: b.name, group: 'Built-in' });
    for (const s of samples) out.push({ value: s.id, label: `${s.name} (${formatDuration(s.duration)})`, group: 'Imported into this project' });
    return out;
  }, [samples, sampleId]);
  return (
    <Select
      id={pickerId(trackId)}
      label={label}
      hideLabel
      size="sm"
      className={styles.picker}
      value={sampleId ?? ''}
      options={options}
      disabled={takeLocked}
      tip={takeLocked ? 'A performance is recording, so the sound can’t change until you stop.' : 'Choose the recording this part plays: a built-in one or one imported into this project. Undo brings the previous one back.'}
      onChange={(id) => {
        if (!id || id === sampleId) return;
        if (session.accepted(cmd.assignSample(session.store, trackId, id))) onAssigned?.();
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Audition                                                            */
/* ------------------------------------------------------------------ */

const AUDITION_IDS = ['start', 'end', 'mode', 'pitch', 'fine', 'sync', 'originalBpm', 'rootNote'] as const;
/** Longest one-shot audition before the key releases by itself (seconds). */
const MAX_AUDITION_SECONDS = 60;

function Audition(props: { trackId: Id; duration: number }) {
  const { trackId, duration } = props;
  const root = useProject((p) => readSamplerValues(p, trackId, ['rootNote']).rootNote);
  const heard = useProject((p) => (p.assist ? snapToScale(root, p.root, p.scale) : root));
  const [playing, setPlaying] = useState(false);
  const current = useRef<{ key: number; timer: number } | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);

  const stop = useCallback(() => {
    pending.current = false;
    const c = current.current;
    if (!c) return;
    current.current = null;
    window.clearTimeout(c.timer);
    session.noteOff(trackId, c.key, 'pad');
    if (alive.current) setPlaying(false);
  }, [trackId]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop();
    };
  }, [stop]);

  const start = () => {
    stop();
    pending.current = true;
    // startAudio runs inside the click: this gesture may be what enables browser audio.
    void session.startAudio().then((ok) => {
      if (!ok || !alive.current || !pending.current) return;
      pending.current = false;
      const p = session.store.getState();
      const v = readSamplerValues(p, trackId, AUDITION_IDS);
      const key = Math.round(v.rootNote);
      session.noteOn(trackId, key, 0.85, 'pad');
      // One-shot: the voice ends by itself at the region end; the key is released after it.
      // Loop: it repeats until Stop.
      const seconds = (Math.abs(v.end - v.start) * duration) / rootRate(v, p.bpm);
      const timer = v.mode === 1 ? 0 : window.setTimeout(stop, Math.min(MAX_AUDITION_SECONDS, seconds) * 1000 + 150);
      current.current = { key, timer };
      setPlaying(true);
    });
  };

  const rootName = noteName(root);
  return (
    <Button
      size="sm"
      icon={playing ? 'stop' : 'play'}
      pressed={playing}
      tone="amber"
      className={styles.audition}
      aria-label={playing ? `Stop audition (playing ${noteName(heard)})` : `Audition: play ${rootName}`}
      onClick={() => (playing ? stop() : start())}
      tip={
        playing
          ? 'Stops the audition.'
          : heard === root
            ? `Plays the trimmed recording at its root note (${rootName}). One-shot plays it once; Loop repeats until you press Stop.`
            : `Musical Assist keeps played notes in the key, so ${rootName} plays as ${noteName(heard)}. Switch Musical Assist off to hear the original pitch.`
      }
    >
      {playing ? 'Stop' : 'Audition'}
    </Button>
  );
}

/* ------------------------------------------------------------------ */
/* Recording section: meta, waveform, trim readouts, fades             */
/* ------------------------------------------------------------------ */

function knob(trackId: Id, id: SamplerParamId, label: string, extra: { tip?: string; detail?: string; className?: string } = {}) {
  return (
    <ParamKnob
      key={id}
      moduleId={moduleId.inst(trackId)}
      param={id}
      spec={samplerSpec(id)}
      ownerTrackId={trackId}
      instrumentTrackId={trackId}
      size="sm"
      label={label}
      tip={extra.tip}
      detail={extra.detail}
      className={extra.className}
    />
  );
}

const TRIM_READ_IDS = ['start', 'end', 'mode'] as const;

function TrimFooter(props: { trackId: Id; duration: number }) {
  const { trackId, duration } = props;
  const v = useSamplerValues(trackId, TRIM_READ_IDS);
  const lo = Math.min(v.start, v.end);
  const hi = Math.max(v.start, v.end);
  const loop = v.mode === 1;
  return (
    <div className={styles.trimRow}>
      {knob(trackId, 'fadeIn', 'Fade in', { className: styles.fadeIn, tip: loop ? 'Softens the start of each note.' : 'Softens the start of the region to avoid clicks.' })}
      <dl className={styles.readouts} aria-label="Trim region">
        <div>
          <dt>Start</dt>
          <dd className="mono">{formatTime(lo * duration, duration)}</dd>
        </div>
        <div>
          <dt>Length</dt>
          <dd className="mono">{formatTime((hi - lo) * duration, duration)}</dd>
        </div>
        <div>
          <dt>End</dt>
          <dd className="mono">{formatTime(hi * duration, duration)}</dd>
        </div>
      </dl>
      {knob(trackId, 'fadeOut', 'Fade out', {
        className: styles.fadeOut,
        tip: loop ? 'In Loop mode, sets the shortest fade after you let go of the note.' : 'Softens the end of the region to avoid clicks.',
      })}
    </div>
  );
}

function metaText(overview: { duration: number; sampleRate: number; channels: number } | null, fallback: { duration: number; sampleRate: number; channels: number } | null, source: string): string {
  const o = overview ?? fallback;
  if (!o) return source;
  return [formatDuration(o.duration), formatSampleRate(o.sampleRate), o.channels === 1 ? 'Mono' : 'Stereo', source].join(' · ');
}

/* ------------------------------------------------------------------ */
/* Playback                                                            */
/* ------------------------------------------------------------------ */

type ModeValue = 'oneshot' | 'loop';
const MODE_OPTIONS = [
  { value: 'oneshot', label: 'One-shot', tip: 'Each note plays the region once, to its end.' },
  { value: 'loop', label: 'Loop', tip: 'Each note repeats the region for as long as it is held.' },
] as const;

const PLAY_READ_IDS = ['mode', 'rootNote'] as const;

function PlaybackSection(props: { trackId: Id }) {
  const { trackId } = props;
  const titleId = useId();
  const v = useSamplerValues(trackId, PLAY_READ_IDS);
  const modeCtl = useSamplerController(trackId, 'mode');
  const rootCtl = useSamplerController(trackId, 'rootNote');
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <div className={styles.head}>
        <h3 id={titleId} className={styles.sectionTitle}>
          Playback
        </h3>
        <span className={styles.rule} aria-hidden="true" />
      </div>
      <div className={styles.controlRow}>
        <SegmentedControl<ModeValue>
          label={modeCtl ? `Playback mode (set by ${modeCtl})` : 'Playback mode'}
          size="sm"
          options={MODE_OPTIONS}
          value={v.mode === 1 ? 'loop' : 'oneshot'}
          disabled={!!modeCtl}
          onChange={(m) => session.setInstrumentParam(trackId, 'mode', m === 'loop' ? 1 : 0)}
        />
        <Select
          label="Root"
          layout="inline"
          size="sm"
          value={String(Math.round(v.rootNote))}
          options={ROOT_OPTIONS}
          disabled={!!rootCtl}
          width={78}
          tip="The key that plays the recording at its original pitch. Other keys play it higher or lower (and faster or slower)."
          onChange={(val) => session.setInstrumentParam(trackId, 'rootNote', Number(val))}
        />
      </div>
      <div className={styles.knobs}>
        {knob(trackId, 'gain', 'Gain')}
        {knob(trackId, 'pitch', 'Pitch', { detail: 'Playback-rate transposition: speed changes with pitch (no time-stretch).' })}
        {knob(trackId, 'fine', 'Fine')}
        {knob(trackId, 'attack', 'Attack')}
        {knob(trackId, 'release', 'Release')}
        {knob(trackId, 'cutoff', 'Cutoff')}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Tempo                                                               */
/* ------------------------------------------------------------------ */

const TEMPO_READ_IDS = ['sync', 'originalBpm', 'start', 'end'] as const;

function TempoSection(props: { trackId: Id; sampleId: Id; duration: number }) {
  const { trackId, sampleId, duration } = props;
  const titleId = useId();
  const warnId = useId();
  const v = useSamplerValues(trackId, TEMPO_READ_IDS);
  const bpm = useProject((p) => p.bpm);
  const syncCtl = useSamplerController(trackId, 'sync');
  const obpmCtl = useSamplerController(trackId, 'originalBpm');
  const on = v.sync === 1;
  const regionSeconds = Math.abs(v.end - v.start) * duration;
  // The helper's bar count: the user's entry for this region, else what the Original BPM implies.
  const regionKey = `${sampleId}:${Math.round(regionSeconds * 1000)}`;
  const [entry, setEntry] = useState<{ key: string; bars: number } | null>(null);
  const bars = entry && entry.key === regionKey ? entry.bars : suggestedBars(regionSeconds, v.originalBpm);
  const target = barsToBpm(bars, regionSeconds);
  const inRange = Number.isFinite(target) && target >= ORIGINAL_BPM_MIN && target <= ORIGINAL_BPM_MAX;
  const matches = inRange && Math.abs(target - v.originalBpm) < 0.05;
  const range = barsRange(regionSeconds);
  const rate = syncRate(v.originalBpm, bpm);

  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <div className={styles.head}>
        <h3 id={titleId} className={styles.sectionTitle}>
          Tempo
        </h3>
        <span className={styles.rule} aria-hidden="true" />
      </div>
      <div className={styles.controlRow}>
        <Switch
          label="Tempo Sync"
          size="sm"
          onText="Speed"
          offText="Off"
          checked={on}
          disabled={!!syncCtl}
          onChange={(c) => session.setInstrumentParam(trackId, 'sync', c ? 1 : 0)}
          tip="Speeds the recording up or down to follow the project tempo. Its pitch moves with the speed."
          detail="Rate = project BPM ÷ Original BPM. Not pitch-preserving."
        />
        <NumberField
          label="Original BPM"
          layout="inline"
          size="sm"
          value={v.originalBpm}
          min={ORIGINAL_BPM_MIN}
          max={ORIGINAL_BPM_MAX}
          step={1}
          fineStep={0.1}
          unit="BPM"
          chars={5}
          disabled={!!obpmCtl}
          onChange={(val, info) => session.setInstrumentParam(trackId, 'originalBpm', val, info.gesture)}
          tip="The tempo the recording was made at. Tempo Sync compares it with the project tempo."
        />
      </div>
      <p className={styles.explain}>
        <Icon name="info" size={14} className={styles.explainIcon} />
        <span>Speed and pitch change together (no time-stretch)</span>
      </p>
      <p className={styles.syncState} data-on={on || undefined}>
        {on
          ? `Following ${formatBpm(bpm)}: plays at ${rate.toFixed(2)}× speed, ${formatSemitones(rateToSemitones(rate))}.`
          : 'Off: the recording plays at its own speed whatever the project tempo.'}
      </p>
      <div className={styles.barsRow}>
        <span className={styles.barsText}>This region is</span>
        <NumberField
          label="Region length in bars"
          hideLabel
          size="sm"
          value={bars}
          min={BARS_MIN}
          max={BARS_MAX}
          step={1}
          fineStep={BARS_STEP}
          chars={4}
          disabled={!(regionSeconds > 0)}
          onChange={(n) => setEntry({ key: regionKey, bars: n })}
          tip="How many bars of 4/4 the trimmed region lasts. Set then works out its Original BPM."
        />
        <span className={styles.barsText}>{bars === 1 ? 'bar' : 'bars'}</span>
        <Button
          size="sm"
          className={styles.setBpm}
          disabled={!inRange || matches || !!obpmCtl}
          aria-describedby={!inRange ? warnId : undefined}
          onClick={() => session.setInstrumentParam(trackId, 'originalBpm', Math.round(target * 100) / 100)}
          tip={`Sets Original BPM so ${formatBars(bars)} fill the ${formatTime(regionSeconds, duration)} region: ${formatBars(bars)} × 4 beats × 60 ÷ ${regionSeconds.toFixed(3)} s.`}
        >
          {inRange ? `Set ${formatBpm(target)}` : 'Set BPM'}
        </Button>
      </div>
      {!inRange && regionSeconds > 0 && (
        <p id={warnId} className={styles.warn}>
          <Icon name="warning" size={14} className={styles.warnIcon} />
          <span>
            {formatBars(bars)} in {formatTime(regionSeconds, duration)} would be {Number.isFinite(target) ? formatBpm(target) : 'out of range'}; Original BPM must be {ORIGINAL_BPM_MIN}–{ORIGINAL_BPM_MAX}.
            {range ? ` For this region choose ${formatBars(range.min).replace(/ bars?$/, '')}–${formatBars(range.max)}.` : ' Trim a longer or shorter region.'}
          </span>
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Full editor (sampler with a recording)                              */
/* ------------------------------------------------------------------ */

function RecordingEditor(props: { trackId: Id; sampleId: Id; name: string; partName: string }) {
  const { trackId, sampleId, name, partName } = props;
  const titleId = useId();
  const importTitleId = useId();
  const { overview, status, meta } = useSampleOverview(sampleId);
  const builtin = isBuiltinId(sampleId);
  const duration = overview?.duration ?? meta?.duration ?? 0;
  const source = builtin ? 'Built-in' : meta ? `${fileKind(meta.mime)} · ${formatBytes(meta.byteLength)}` : 'Missing';

  // Keyboard continuity: after a choice or import in the empty state (whose controls are now gone), focus the picker.
  useEffect(() => {
    const chose = focusPickerOnMount.delete(trackId);
    if (!chose && !importedRecently(trackId)) return;
    const active = document.activeElement;
    if (!active || active === document.body) document.getElementById(pickerId(trackId))?.focus({ preventScroll: true });
  }, [trackId]);

  return (
    <div className={styles.editor}>
      <section className={styles.section} aria-labelledby={titleId}>
        <div className={styles.head}>
          <h3 id={titleId} className={styles.sectionTitle}>
            Recording
          </h3>
          <span className={styles.rule} aria-hidden="true" />
          <span className={`${styles.meta} mono`}>{metaText(overview, meta, source)}</span>
        </div>
        <div className={styles.pickRow}>
          <SamplePicker trackId={trackId} sampleId={sampleId} label={`Recording for ${partName}`} />
          <Audition trackId={trackId} duration={duration} />
        </div>
        <WaveformTrim trackId={trackId} name={name} overview={overview} status={status} duration={duration} />
        <TrimFooter trackId={trackId} duration={duration} />
      </section>
      <PlaybackSection trackId={trackId} />
      <TempoSection trackId={trackId} sampleId={sampleId} duration={duration} />
      <section className={styles.section} aria-labelledby={importTitleId}>
        <div className={styles.head}>
          <h3 id={importTitleId} className={styles.sectionTitle}>
            Your own recording
          </h3>
          <span className={styles.rule} aria-hidden="true" />
        </div>
        <ImportSampleButton trackId={trackId} variant="button" />
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Empty state (not a sampler yet, or no recording)                    */
/* ------------------------------------------------------------------ */

interface PartInfo {
  name: string;
  kind: 'drums' | 'bass' | 'poly' | 'sampler';
  sound: string;
  sampleId: Id | null;
}

function NoRecording(props: { trackId: Id; info: PartInfo }) {
  const { trackId, info } = props;
  const titleId = useId();
  const sampler = info.kind === 'sampler';
  return (
    <div className={styles.editor}>
      <p className={styles.intro}>
        {sampler ? (
          <>
            <strong>{info.name}</strong> has no recording yet. Import one from this device or choose a built-in recording.
          </>
        ) : (
          <>
            <strong>{info.name}</strong> plays the {INSTRUMENT_LABEL[info.kind].toLowerCase()} <strong>{info.sound}</strong>. Import a recording or choose a built-in one to turn this part into a sampler. Undo brings {info.sound} back.
          </>
        )}
      </p>
      <ImportSampleButton trackId={trackId} variant="dropzone" />
      <section className={styles.section} aria-labelledby={titleId}>
        <div className={styles.head}>
          <h3 id={titleId} className={styles.sectionTitle}>
            Or choose a recording
          </h3>
          <span className={styles.rule} aria-hidden="true" />
        </div>
        <SamplePicker trackId={trackId} sampleId={null} label={`Recording for ${info.name}`} onAssigned={() => focusPickerOnMount.add(trackId)} />
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Public component                                                    */
/* ------------------------------------------------------------------ */

export function SamplerEditor({ trackId }: SamplerEditorProps) {
  const info = useProject<PartInfo | null>((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return null;
    const inst = t.instrument;
    return { name: t.name, kind: inst.kind, sound: soundName(p, inst), sampleId: inst.kind === 'sampler' ? inst.sampleId : null };
  }, shallowEqual);
  if (!info) return null;
  if (info.kind !== 'sampler' || info.sampleId === null) return <NoRecording trackId={trackId} info={info} />;
  return <RecordingEditor trackId={trackId} sampleId={info.sampleId} name={info.sound} partName={info.name} />;
}
