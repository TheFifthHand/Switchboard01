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
import type { Id, Project } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { session, useProject } from '../../instance';
import { INSTRUMENT_LABEL, soundName } from '../../labels';
import { runtimeStore, useRuntime } from '../../runtime';
import { ParamKnob } from '../shape/ParamKnob';
import { ImportSampleButton } from './ImportSampleButton';
import { importInProgress, importedRecently } from './importState';
import { isBuiltinId, useSampleOverview, useStoredFile } from './sampleOverview';
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
  noteRate,
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

/** The pitch a pad plays for `key` on this project (Musical Assist keeps it in the key). */
function heardPitch(p: Project, key: number): number {
  return p.assist ? snapToScale(key, p.root, p.scale) : key;
}

/** True when the part's arpeggiator keeps playing released notes (Latch on). */
function latchedArp(p: Project, trackId: Id): boolean {
  const t = p.tracks.find((x) => x.id === trackId);
  return !!t && t.arp.enabled && t.arp.latch;
}

/** Why Audition cannot play right now (null: it can). A preview must never end up in a take. */
function auditionBlock(s: { recording: string; recordTarget: { trackId: Id } | null; replayId: Id | null }, trackId: Id): string | null {
  if (s.recording === 'performance') return 'A performance is recording, so Audition is off (a preview must not end up in the take). Play the pads or keyboard to be recorded.';
  if (s.recording === 'notes' && s.recordTarget?.trackId === trackId) return 'Record Notes is writing into this part, so Audition is off (it would be recorded).';
  if (s.replayId !== null) return 'A recorded performance is replaying. Stop it to audition.';
  return null;
}

function Audition(props: { trackId: Id; sampleId: Id; duration: number; available: boolean }) {
  const { trackId, sampleId, duration, available } = props;
  const root = useProject((p) => Math.round(readSamplerValues(p, trackId, ['rootNote']).rootNote));
  const heard = useProject((p) => heardPitch(p, root));
  const blocked = useRuntime((s) => auditionBlock(s, trackId));
  /** The pitch this audition holds (as the session publishes it), or null. */
  const [holding, setHolding] = useState<number | null>(null);
  // The session releases every held note on Stop, Mute All, window blur and pointer cancel:
  // the button follows the real note, so it never says "Stop" over silence.
  const sounding = useRuntime((s) => holding !== null && (s.held[trackId]?.includes(holding) ?? false));
  const current = useRef<{ key: number; timer: number } | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);

  const stop = useCallback(() => {
    pending.current = false;
    const c = current.current;
    if (!c) return;
    current.current = null;
    window.clearTimeout(c.timer);
    session.noteOff(trackId, c.key, 'preview');
    // A latched arpeggio would keep playing the root on the idle clock with no visible Stop.
    // While the transport is stopped, Stop ends only that (and any other held notes).
    if (latchedArp(session.store.getState(), trackId) && !runtimeStore.getState().playing) session.stop();
    if (alive.current) setHolding(null);
  }, [trackId]);

  // Stop when the part or its recording changes, and when the editor goes away.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop();
    };
  }, [stop, sampleId]);

  // The note was released elsewhere (Stop, Mute All, blur): forget it without a second note-off.
  useEffect(() => {
    if (holding === null || sounding) return;
    const c = current.current;
    if (c) window.clearTimeout(c.timer);
    current.current = null;
    setHolding(null);
  }, [holding, sounding]);

  // A take or a replay starting mid-audition ends it.
  useEffect(() => {
    if (blocked) stop();
  }, [blocked, stop]);

  const start = () => {
    stop();
    pending.current = true;
    // startAudio runs inside the click: this gesture may be what enables browser audio.
    void session.startAudio().then((ok) => {
      if (!ok || !alive.current || !pending.current) return;
      pending.current = false;
      const rt = runtimeStore.getState();
      if (auditionBlock(rt, trackId)) return;
      const p = session.store.getState();
      const v = readSamplerValues(p, trackId, AUDITION_IDS);
      const key = Math.round(v.rootNote);
      const pitch = heardPitch(p, key);
      session.noteOn(trackId, key, 0.85, 'preview');
      if (!runtimeStore.getState().held[trackId]?.includes(pitch)) return;
      // One-shot: the voice ends by itself at the region end; the key is released after it.
      // Loop: it repeats until Stop.
      const seconds = (Math.abs(v.end - v.start) * duration) / noteRate(v, pitch, p.bpm);
      const timer = v.mode === 1 ? 0 : window.setTimeout(stop, Math.min(MAX_AUDITION_SECONDS, seconds) * 1000 + 150);
      current.current = { key, timer };
      setHolding(pitch);
    });
  };

  const playing = holding !== null && sounding;
  const rootName = noteName(root);
  const off = !playing && (!!blocked || !available);
  return (
    <Button
      size="sm"
      icon={playing ? 'stop' : 'play'}
      pressed={playing}
      tone="amber"
      className={styles.audition}
      disabled={off}
      aria-label={playing ? `Stop audition (playing ${noteName(heard)})` : `Audition: play ${rootName}${off ? ' (unavailable)' : ''}`}
      onClick={() => (playing ? stop() : start())}
      tip={
        playing
          ? 'Stops the audition.'
          : !available
            ? 'This recording’s audio is not in this browser, so there is nothing to play.'
            : (blocked ??
              (heard === root
                ? `Plays the trimmed recording at its root note (${rootName}). One-shot plays it once; Loop repeats until you press Stop.`
                : `Plays the trimmed recording on its root key. Musical Assist keeps played notes in the key, so ${rootName} sounds as ${noteName(heard)}.`))
      }
    >
      {playing ? 'Stop' : 'Audition'}
    </Button>
  );
}

/** Shown when Musical Assist moves the root key: the recording is heard off its own pitch. */
function AssistNote(props: { trackId: Id }) {
  const { trackId } = props;
  const root = useProject((p) => Math.round(readSamplerValues(p, trackId, ['rootNote']).rootNote));
  const heard = useProject((p) => heardPitch(p, root));
  if (heard === root) return null;
  const diff = heard - root;
  return (
    <p className={styles.assistNote}>
      <Icon name="info" size={12} className={styles.explainIcon} />
      <span>
        Root {noteName(root)} is outside the key, so Musical Assist plays it as {noteName(heard)} ({diff > 0 ? '+' : '−'}
        {Math.abs(diff)} st). Turn Assist off to hear the recording at its own pitch.
      </span>
    </p>
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

/**
 * "2.00 s · 44.1 kHz · Stereo · WAV · 345 KB". `rate` is the file's own sample rate
 * (null: unknown, left out); built-ins are made at the rate they play at.
 */
function metaText(info: { duration: number; channels: number } | null, rate: number | null, source: string): string {
  if (!info) return source;
  return [formatDuration(info.duration), rate ? formatSampleRate(rate) : null, info.channels === 1 ? 'Mono' : 'Stereo', source].filter(Boolean).join(' · ');
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
          tip={
            rootCtl
              ? `The ${rootCtl} macro sets the root note. Remove that mapping in Macros to set it here.`
              : 'The key that plays the recording at its original pitch. Other keys play it higher or lower (and faster or slower).'
          }
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
          tip={
            syncCtl
              ? `The ${syncCtl} macro switches Tempo Sync. Remove that mapping in Macros to switch it here.`
              : 'Speeds the recording up or down to follow the project tempo. Its pitch moves with the speed.'
          }
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
          tip={
            obpmCtl
              ? `The ${obpmCtl} macro sets Original BPM. Remove that mapping in Macros to set it here.`
              : on
                ? 'The tempo the recording was made at. Tempo Sync compares it with the project tempo.'
                : 'The tempo the recording was made at. It takes effect when Tempo Sync is on.'
          }
        />
      </div>
      <p className={styles.explain}>
        <Icon name="info" size={14} className={styles.explainIcon} />
        <span>
          Speed and pitch change together <span className={styles.nowrap}>(no time-stretch)</span>
        </span>
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
          icon={matches ? 'check' : undefined}
          disabled={!inRange || !!obpmCtl}
          // Already set: the key keeps focus (aria-disabled) and says so in words.
          aria-disabled={matches || undefined}
          aria-describedby={!inRange ? warnId : undefined}
          aria-label={matches ? `Original BPM already matches: ${formatBpm(target)}` : undefined}
          onClick={() => {
            if (!matches) session.setInstrumentParam(trackId, 'originalBpm', Math.round(target * 100) / 100);
          }}
          tip={
            obpmCtl
              ? `The ${obpmCtl} macro sets Original BPM. Remove that mapping in Macros to set it here.`
              : `Sets Original BPM so ${formatBars(bars)} fill the ${formatTime(regionSeconds, duration)} region: ${formatBars(bars)} × 4 beats × 60 ÷ ${regionSeconds.toFixed(3)} s.`
          }
        >
          {!inRange ? 'Set BPM' : matches ? `${formatBpm(target)} set` : `Set ${formatBpm(target)}`}
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
  const found = useSampleOverview(sampleId);
  const file = useStoredFile(sampleId);
  const builtin = isBuiltinId(sampleId);
  const meta = found.meta;
  // An imported recording whose audio is not in this browser cannot play: say so rather than draw it.
  const missing = found.status === 'missing' || (!builtin && (!meta || file?.stored === false));
  const overview = missing ? null : found.overview;
  const status = missing ? 'missing' : found.status;
  const duration = found.overview?.duration ?? meta?.duration ?? 0;
  const source = builtin ? 'Built-in' : meta ? `${fileKind(meta.mime)} · ${formatBytes(meta.byteLength)}${missing ? ' · audio missing' : ''}` : 'Missing';
  const info = found.overview ?? meta;
  const rate = builtin ? (found.overview?.sampleRate ?? null) : file?.stored ? file.rate : null;

  // Keyboard continuity: after a choice or import in the empty state (whose controls are now gone), focus the picker.
  useEffect(() => {
    const chose = focusPickerOnMount.delete(trackId);
    if (!chose && !importedRecently(trackId) && !importInProgress(trackId)) return;
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
          <span className={`${styles.meta} mono`}>{metaText(info, rate, source)}</span>
        </div>
        <div className={styles.pickRow}>
          <SamplePicker trackId={trackId} sampleId={sampleId} label={`Recording for ${partName}`} />
          <Audition trackId={trackId} sampleId={sampleId} duration={duration} available={!missing} />
        </div>
        <AssistNote trackId={trackId} />
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
