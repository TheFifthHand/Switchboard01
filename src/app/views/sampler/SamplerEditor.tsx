/**
 * Sampler editor for one part (used in the Shape view's Instrument column).
 *
 * What it edits follows the part's selected clip (samplerTarget.ts,
 * capability-01): a clip that plays a recording of its own (an import, a
 * recorded take, a recording chosen for it) is edited as that clip's
 * recording; otherwise the part's recording. The header says which:
 * "Recording 2 — plays in Vocal · Groove".
 *
 * A sampler part with a recording shows:
 *   RECORDING  picker (built-in + imported) · Audition · waveform with Start/End
 *              trim handles, zoom and an overview strip · fade in / fade out ·
 *              start/length/end readouts
 *   EDIT       Normalize · Reverse · Crop to region · Fade in / out · Gain, each a
 *              new version of the recording (one undo step)
 *   PLAYBACK   One-shot / Loop · root note · gain, pitch, fine, attack, release, cutoff
 *   TEMPO      Tempo Sync (speed and pitch together) · Original BPM · bars helper
 *   YOUR OWN   Record audio from a microphone or instrument in time with the music
 *              (count-in, 1/2/4/8 bars, its own clip that plays it from the
 *              downbeat), or import a WAV or MP3 from this device (its own clip)
 *
 * The picker sets the selected clip's recording (cmd.setClipSampleRegion),
 * or the part's when no clip is selected (cmd.assignSample). Start, End and
 * Root are the clip's own for a clip's recording; mode, level, pitch, fades
 * and tempo are the part's and apply to every clip on it.
 *
 * A part that is not a sampler yet (or has no recording) shows the import
 * drop zone and the recording picker; either one turns it into a sampler.
 *
 * Every control edits the real project: parameters through
 * session.setInstrumentParam (recordable, one undo step per gesture), clip
 * recordings through cmd.setClipSampleRegion, imports through
 * session.importSample, recorded takes through the audio input
 * (app/audioInput.ts) and edits through sampleVersions.ts.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Icon, NumberField, SegmentedControl, Select, Switch, noteName, type SelectOption } from '../../../ui/components';
import { BUILTIN_SAMPLES, builtinSampleInfo } from '../../../content/catalog';
import { moduleId } from '../../../project/factory';
import type { Id, Project } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { session, useProject } from '../../instance';
import { INSTRUMENT_LABEL, soundName } from '../../labels';
import { runtimeStore, useRuntime } from '../../runtime';
import { ParamKnob } from '../shape/ParamKnob';
import { auditionClipSample, type ClipAuditionVoice } from './clipAudition';
import { EditRecording } from './EditRecording';
import { ImportSampleButton } from './ImportSampleButton';
import { RecordAudio } from './RecordAudio';
import { importInProgress, importedRecently } from './importState';
import { useSampleDetail } from './sampleDetail';
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
  MIN_LOOP_CROSSFADE_MS,
  rateToSemitones,
  noteRate,
  stepBars,
  suggestedBars,
  suggestionNeedsHits,
  syncRate,
} from './samplerMath';
import { clipSampleOf, readTargetValues, recordingName, setTargetValue, targetHeading, useSamplerTarget, useTargetController, useTargetValues, type SamplerTarget } from './samplerTarget';
import { samplerSpec, useSamplerController, useSamplerValues, type SamplerParamId } from './samplerValues';
import { WaveformTrim } from './WaveformTrim';
import styles from './SamplerEditor.module.css';

export interface SamplerEditorProps {
  trackId: string;
}

/** Parts whose picker should take keyboard focus when the full editor appears (after a choice from the empty state). */
const focusPickerOnMount = new Set<Id>();
const pickerId = (trackId: Id) => `sampler-recording-${trackId}`;
/** Picker value that gives a clip the part's recording back. */
const PART_RECORDING = '__part__';

const ROOT_OPTIONS: SelectOption[] = (() => {
  const spec = samplerSpec('rootNote');
  const out: SelectOption[] = [];
  for (let m = spec.min; m <= spec.max; m++) out.push({ value: String(m), label: noteName(m) });
  return out;
})();

/* ------------------------------------------------------------------ */
/* Recording picker                                                    */
/* ------------------------------------------------------------------ */

/**
 * The recording picker. With a clip selected it chooses that clip's own
 * recording (the other clips keep theirs; "<Part>’s recording" gives the
 * clip the part's back); with no clip selected (or from the empty state,
 * `partOnly`) it chooses the part's recording.
 */
function SamplePicker(props: { trackId: Id; target: SamplerTarget | null; partOnly?: boolean; label: string; onAssigned?(): void }) {
  const { trackId, target, partOnly, label, onAssigned } = props;
  const samples = useProject((p) => p.samples);
  const partRecording = useProject((p) => (target?.partSampleId ? recordingName(p, target.partSampleId) : null));
  const takeLocked = useRuntime((s) => s.recording === 'performance');
  const forClip = !partOnly && !!target && target.clipName !== null;
  const ownClip = forClip && target?.kind === 'clip';
  const sampleId = partOnly ? null : (target?.sampleId ?? null);
  const options = useMemo(() => {
    const out: SelectOption[] = [];
    if (sampleId === null) out.push({ value: '', label: 'Choose a recording…', disabled: true });
    else if (!isBuiltinId(sampleId) && !samples.some((s) => s.id === sampleId)) out.push({ value: sampleId, label: 'Missing recording', disabled: true });
    else if (isBuiltinId(sampleId) && !builtinSampleInfo(sampleId)) out.push({ value: sampleId, label: 'Unknown built-in recording', disabled: true });
    if (ownClip && target?.partSampleId && partRecording) out.push({ value: PART_RECORDING, label: `${target.partName}’s recording (${partRecording})`, group: 'This part' });
    for (const b of BUILTIN_SAMPLES) out.push({ value: b.id, label: b.name, group: 'Built-in' });
    for (const s of samples) out.push({ value: s.id, label: `${s.name} (${formatDuration(s.duration)})`, group: 'Imported into this project' });
    return out;
  }, [samples, sampleId, ownClip, target?.partSampleId, target?.partName, partRecording]);
  const clipWords = forClip && target ? `“${target.clipName}” (${target.partName} · ${target.sceneName})` : '';
  const tip = takeLocked
    ? 'A performance is recording, so the sound can’t change until you stop.'
    : forClip
      ? `Choose the recording ${clipWords} plays. The part’s other clips keep theirs. Undo brings the previous one back.`
      : 'Choose the recording this part plays: a built-in one or one imported into this project. Undo brings the previous one back.';
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
      tip={tip}
      onChange={(id) => {
        if (!id || id === sampleId) return;
        let ok: boolean;
        if (forClip && target) {
          const r = id === PART_RECORDING ? cmd.setClipSampleRegion(session.store, trackId, target.slot, null) : cmd.setClipSampleRegion(session.store, trackId, target.slot, { id, start: 0, end: 1 });
          ok = session.accepted(r);
        } else ok = session.accepted(cmd.assignSample(session.store, trackId, id));
        if (ok) onAssigned?.();
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

/**
 * Audition plays the recording being edited at its own pitch on its root
 * key, and lets go of it on Stop or, for a one-shot, after the trimmed
 * region has played. The part's recording plays as a session preview key
 * (which skips Musical Assist); a clip's own recording through the engine
 * as that clip's notes play it (clipAudition.ts).
 */
function Audition(props: { target: SamplerTarget; sampleId: Id; duration: number; available: boolean }) {
  const { target, sampleId, duration, available } = props;
  const trackId = target.trackId;
  const clip = target.kind === 'clip';
  const root = useProject((p) => Math.round(readTargetValues(p, target, ['rootNote']).rootNote));
  const blocked = useRuntime((s) => auditionBlock(s, trackId));
  /** The root key this audition holds (as the session publishes it), or null. */
  const [holding, setHolding] = useState<number | null>(null);
  // The session releases every held note on Stop, Mute All, window blur and pointer cancel:
  // the button follows the real note, so it never says "Stop" over silence.
  const heldBySession = useRuntime((s) => holding !== null && (s.held[trackId]?.includes(holding) ?? false));
  const [clipSounding, setClipSounding] = useState(false);
  const sounding = clip ? clipSounding : heldBySession;
  const current = useRef<{ key: number; timer: number; voice: ClipAuditionVoice | null; poll: number } | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);

  const stop = useCallback(() => {
    pending.current = false;
    const c = current.current;
    if (!c) return;
    current.current = null;
    window.clearTimeout(c.timer);
    window.clearInterval(c.poll);
    if (c.voice) c.voice.stop();
    else {
      session.noteOff(trackId, c.key, 'preview');
      // A latched arpeggio would keep playing the root on the idle clock with no visible Stop.
      // While the transport is stopped, Stop ends only that (and any other held notes).
      if (latchedArp(session.store.getState(), trackId) && !runtimeStore.getState().playing) session.stop();
    }
    if (alive.current) {
      setHolding(null);
      setClipSounding(false);
    }
  }, [trackId]);

  // Stop when the part, the recording or the clip changes, and when the editor goes away.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop();
    };
  }, [stop, sampleId, target.kind, target.slot]);

  // The note was released elsewhere (Stop, Mute All, blur): forget it without a second note-off.
  useEffect(() => {
    if (clip || holding === null || heldBySession) return;
    const c = current.current;
    if (c) window.clearTimeout(c.timer);
    current.current = null;
    setHolding(null);
  }, [clip, holding, heldBySession]);

  // A take or a replay starting mid-audition ends it.
  useEffect(() => {
    if (blocked) stop();
  }, [blocked, stop]);

  // A clip's own recording plays outside the session's held keys: Stop, Pause, Mute All, a window
  // switch and everything else that lets go of every note let go of it too.
  useEffect(
    () =>
      session.onAllNotesReleased(() => {
        if (current.current?.voice) stop();
      }),
    [stop],
  );

  const start = () => {
    stop();
    pending.current = true;
    // startAudio runs inside the click: this gesture may be what enables browser audio.
    void session.startAudio().then(async (ok) => {
      if (!ok || !alive.current || !pending.current) return;
      const rt = runtimeStore.getState();
      if (auditionBlock(rt, trackId)) return;
      const p = session.store.getState();
      const v = readTargetValues(p, target, AUDITION_IDS);
      const key = Math.round(v.rootNote);
      // One-shot: the voice ends by itself at the region end; the key is released after it.
      // Loop: it repeats until Stop.
      const seconds = (Math.abs(v.end - v.start) * duration) / noteRate(v, key, p.bpm);
      const hold = v.mode === 1 ? MAX_AUDITION_SECONDS : Math.min(MAX_AUDITION_SECONDS, seconds);
      if (clip) {
        const own = clipSampleOf(p, target);
        if (!own) return;
        const voice = await auditionClipSample(trackId, key, 0.85, own, hold);
        if (!voice) return;
        if (!alive.current || !pending.current) {
          voice.stop();
          return;
        }
        pending.current = false;
        // The voice ends by itself (one-shot), or with Stop and Mute All: the key follows it.
        const poll = window.setInterval(() => {
          if (current.current?.voice === voice && voice.ended) stop();
        }, 120);
        current.current = { key, timer: window.setTimeout(stop, hold * 1000 + 150), voice, poll };
        setHolding(key);
        setClipSounding(true);
        return;
      }
      pending.current = false;
      session.noteOn(trackId, key, 0.85, 'preview');
      if (!runtimeStore.getState().held[trackId]?.includes(key)) return;
      const timer = v.mode === 1 ? 0 : window.setTimeout(stop, hold * 1000 + 150);
      current.current = { key, timer, voice: null, poll: 0 };
      setHolding(key);
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
      aria-label={playing ? `Stop audition (playing ${noteName(holding ?? root)})` : `Audition: play ${rootName}${off ? ' (unavailable)' : ''}`}
      onClick={() => (playing ? stop() : start())}
      tip={
        playing
          ? 'Stops the audition.'
          : !available
            ? 'This recording’s audio is not in this browser, so there is nothing to play.'
            : (blocked ??
              `Plays the trimmed recording at its own pitch on its root key (${rootName})${clip ? ', as this clip plays it' : ''}. One-shot plays it once; Loop repeats until you press Stop.`)
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

function TrimFooter(props: { target: SamplerTarget; duration: number }) {
  const { target, duration } = props;
  const trackId = target.trackId;
  const v = useTargetValues(target, TRIM_READ_IDS);
  const lo = Math.min(v.start, v.end);
  const hi = Math.max(v.start, v.end);
  const loop = v.mode === 1;
  const every = target.kind === 'clip' ? ` It is ${target.partName}’s setting, for every clip on it.` : '';
  return (
    <div className={styles.trimRow}>
      {knob(trackId, 'fadeIn', 'Fade in', { className: styles.fadeIn, tip: (loop ? 'Softens the start of each note.' : 'Softens the start of the region to avoid clicks.') + every })}
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
        tip:
          (loop
            ? `In Loop mode, crossfades the loop point over this time (at least ${MIN_LOOP_CROSSFADE_MS} ms) so repeats never click, and sets the shortest fade after you let go of the note.`
            : 'Softens the end of the region to avoid clicks.') + every,
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
  { value: 'oneshot', label: 'One-shot', tip: 'Each note plays the whole trimmed region once, however short the note. Stop and Mute All cut it short.' },
  { value: 'loop', label: 'Loop', tip: 'Each note repeats the region for as long as it is held, with a short crossfade at the loop point.' },
] as const;

const PLAY_READ_IDS = ['mode', 'rootNote'] as const;

function PlaybackSection(props: { target: SamplerTarget }) {
  const { target } = props;
  const trackId = target.trackId;
  const titleId = useId();
  const v = useTargetValues(target, PLAY_READ_IDS);
  const modeCtl = useSamplerController(trackId, 'mode');
  const rootCtl = useTargetController(target, 'rootNote');
  const clip = target.kind === 'clip';
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <div className={styles.head}>
        <h3 id={titleId} className={styles.sectionTitle}>
          Playback
        </h3>
        <span className={styles.rule} aria-hidden="true" />
      </div>
      {clip && (
        <p className={styles.partWide}>
          <Icon name="info" size={14} className={styles.explainIcon} />
          <span>
            Root is this clip’s own. One-shot or Loop, the knobs below, the fades and Tempo are {target.partName}’s: they apply to every clip on it.
          </span>
        </p>
      )}
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
              : clip
                ? 'The key that plays this clip’s recording at its original pitch. Other keys play it higher or lower (and faster or slower).'
                : 'The key that plays the recording at its original pitch. Other keys play it higher or lower (and faster or slower).'
          }
          onChange={(val) => setTargetValue(target, 'rootNote', Number(val))}
        />
      </div>
      <div className={styles.knobs}>
        {knob(trackId, 'gain', 'Gain')}
        {knob(trackId, 'pitch', 'Pitch', { detail: 'Playback-rate transposition: speed changes with pitch (no time-stretch).' })}
        {knob(trackId, 'fine', 'Fine')}
        {knob(trackId, 'attack', 'Attack')}
        {knob(trackId, 'release', 'Release', {
          tip: v.mode === 1 ? 'How long notes fade after they end.' : 'How long the sound fades when Stop cuts a one-shot short (it otherwise plays to the region end).',
        })}
        {knob(trackId, 'cutoff', 'Cutoff')}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Tempo                                                               */
/* ------------------------------------------------------------------ */

const TEMPO_READ_IDS = ['sync', 'originalBpm', 'start', 'end'] as const;

function TempoSection(props: { target: SamplerTarget; sampleId: Id; duration: number }) {
  const { target, sampleId, duration } = props;
  const trackId = target.trackId;
  const titleId = useId();
  const warnId = useId();
  const v = useTargetValues(target, TEMPO_READ_IDS);
  const bpm = useProject((p) => p.bpm);
  const syncCtl = useSamplerController(trackId, 'sync');
  const obpmCtl = useSamplerController(trackId, 'originalBpm');
  const on = v.sync === 1;
  const lo = Math.min(v.start, v.end);
  const regionSeconds = Math.abs(v.end - v.start) * duration;
  // Two loop lengths about as near the project tempo: the recording's hits settle it (loaded only then).
  const needsHits = suggestionNeedsHits(regionSeconds, bpm, v.originalBpm);
  const detail = useSampleDetail(sampleId, needsHits);
  const hits = useMemo(() => (detail ? detail.onsets.map((t) => t - lo * duration).filter((t) => t >= 0 && t <= regionSeconds) : undefined), [detail, lo, duration, regionSeconds]);
  // The helper's bar count: the user's entry for this region, else the suggestion (shape-06).
  const regionKey = `${sampleId}:${target.kind}:${target.slot}:${Math.round(regionSeconds * 1000)}`;
  const [entry, setEntry] = useState<{ key: string; bars: number } | null>(null);
  const bars = entry && entry.key === regionKey ? entry.bars : suggestedBars(regionSeconds, bpm, { originalBpm: v.originalBpm, onsets: hits });
  const targetBpm = barsToBpm(bars, regionSeconds);
  const inRange = Number.isFinite(targetBpm) && targetBpm >= ORIGINAL_BPM_MIN && targetBpm <= ORIGINAL_BPM_MAX;
  const matches = inRange && Math.abs(targetBpm - v.originalBpm) < 0.05;
  const range = barsRange(regionSeconds);
  const rate = syncRate(v.originalBpm, bpm);
  const forPart = target.kind === 'clip' ? ` It is ${target.partName}’s setting, for every clip on it.` : '';

  // Arrow keys step through whole loop lengths (… 1, 2, 4, 8 …); Shift+arrows and typing still reach quarter bars.
  const onBarsKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!(regionSeconds > 0)) return;
    e.preventDefault();
    e.stopPropagation();
    setEntry({ key: regionKey, bars: stepBars(bars, e.key === 'ArrowUp' ? 1 : -1) });
  };

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
              : `Speeds the recording up or down to follow the project tempo. Its pitch moves with the speed.${forPart}`
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
                ? `The tempo the recording was made at. Tempo Sync compares it with the project tempo.${forPart}`
                : `The tempo the recording was made at. It takes effect when Tempo Sync is on.${forPart}`
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
        <div className={styles.barsField} onKeyDownCapture={onBarsKey}>
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
            tip="How many bars of 4/4 the trimmed region lasts: the suggestion is the whole loop length (1, 2, 4 or 8 bars) nearest the project tempo. Set then works out its Original BPM."
            detail="Arrow keys step through 1, 2, 4 and 8 bars; Shift+arrows move a beat; or type any length."
          />
        </div>
        <span className={styles.barsText}>{bars === 1 ? 'bar' : 'bars'}</span>
        <Button
          size="sm"
          className={styles.setBpm}
          icon={matches ? 'check' : undefined}
          disabled={!inRange || !!obpmCtl}
          // Already set: the key keeps focus (aria-disabled) and says so in words.
          aria-disabled={matches || undefined}
          aria-describedby={!inRange ? warnId : undefined}
          aria-label={matches ? `Original BPM already matches: ${formatBpm(targetBpm)}` : undefined}
          onClick={() => {
            if (!matches) session.setInstrumentParam(trackId, 'originalBpm', Math.round(targetBpm * 100) / 100);
          }}
          tip={
            obpmCtl
              ? `The ${obpmCtl} macro sets Original BPM. Remove that mapping in Macros to set it here.`
              : `Sets Original BPM so ${formatBars(bars)} fill the ${formatTime(regionSeconds, duration)} region: ${formatBars(bars)} × 4 beats × 60 ÷ ${regionSeconds.toFixed(3)} s.${forPart}`
          }
        >
          {!inRange ? 'Set BPM' : matches ? `${formatBpm(targetBpm)} set` : `Set ${formatBpm(targetBpm)}`}
        </Button>
      </div>
      {!inRange && regionSeconds > 0 && (
        <p id={warnId} className={styles.warn}>
          <Icon name="warning" size={14} className={styles.warnIcon} />
          <span>
            {formatBars(bars)} in {formatTime(regionSeconds, duration)} would be {Number.isFinite(targetBpm) ? formatBpm(targetBpm) : 'out of range'}; Original BPM must be {ORIGINAL_BPM_MIN}–{ORIGINAL_BPM_MAX}.
            {range ? ` For this region choose ${formatBars(range.min).replace(/ bars?$/, '')}–${formatBars(range.max)}.` : ' Trim a longer or shorter region.'}
          </span>
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* A clip's recording played through the part's settings               */
/* ------------------------------------------------------------------ */

const PART_WIDE_IDS = ['mode', 'pitch', 'fine', 'sync'] as const;

/**
 * For a clip's own recording (an import, a take): what the part's settings
 * do to it, in words, when they change how it sounds (a recording keeps its
 * pitch otherwise). Nothing when they leave it as recorded.
 */
function PartSettingsNote(props: { target: SamplerTarget }) {
  const { target } = props;
  const v = useSamplerValues(target.trackId, PART_WIDE_IDS);
  if (target.kind !== 'clip') return null;
  const semis = v.pitch + v.fine / 100;
  const what = [
    v.mode === 1 ? 'Loop mode (it repeats while its note lasts, and stops with it)' : '',
    Math.abs(semis) > 0.004 ? `transposed ${formatSemitones(semis)}` : '',
    v.sync === 1 ? 'Tempo Sync (speed and pitch change together)' : '',
  ].filter(Boolean);
  if (!what.length) return null;
  return (
    <p className={styles.partNote}>
      <Icon name="info" size={14} className={styles.explainIcon} />
      <span>
        {target.partName}’s settings change how this recording sounds: {what.join(', ')}. They apply to every clip on {target.partName}; set them in Playback and Tempo below.
      </span>
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Full editor (a recording to edit)                                   */
/* ------------------------------------------------------------------ */

function RecordingEditor(props: { target: SamplerTarget; sampleId: Id }) {
  const { target, sampleId } = props;
  const trackId = target.trackId;
  const titleId = useId();
  const importTitleId = useId();
  const found = useSampleOverview(sampleId);
  const file = useStoredFile(sampleId);
  const builtin = isBuiltinId(sampleId);
  const meta = found.meta;
  const name = useProject((p) => recordingName(p, sampleId));
  const heading = useProject((p) => targetHeading(p, target));
  // An imported recording whose audio is not in this browser cannot play: say so rather than draw it.
  const missing = found.status === 'missing' || (!builtin && (!meta || file?.stored === false));
  const overview = missing ? null : found.overview;
  const status = missing ? 'missing' : found.status;
  const duration = found.overview?.duration ?? meta?.duration ?? 0;
  const source = builtin ? 'Built-in' : meta ? `${fileKind(meta.mime)} · ${formatBytes(meta.byteLength)}${missing ? ' · audio missing' : ''}` : 'Missing';
  const info = found.overview ?? meta;
  const rate = builtin ? (found.overview?.sampleRate ?? null) : file?.stored ? file.rate : null;
  const pickLabel = target.clipName !== null ? `Recording for ${target.partName} · ${target.sceneName}` : `Recording for ${target.partName}`;

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
        <p className={styles.target} data-kind={target.kind} aria-live="polite">
          <Icon name={target.kind === 'clip' ? 'layers' : 'wave'} size={14} className={styles.targetIcon} />
          <span>{heading}</span>
        </p>
        <PartSettingsNote target={target} />
        <div className={styles.pickRow}>
          <SamplePicker trackId={trackId} target={target} label={pickLabel} />
          <Audition target={target} sampleId={sampleId} duration={duration} available={!missing} />
        </div>
        <WaveformTrim target={target} sampleId={sampleId} name={name} overview={overview} status={status} duration={duration} />
        <TrimFooter target={target} duration={duration} />
      </section>
      <EditRecording target={target} available={!missing} />
      <PlaybackSection target={target} />
      <TempoSection target={target} sampleId={sampleId} duration={duration} />
      <section className={styles.section} aria-labelledby={importTitleId}>
        <div className={styles.head}>
          <h3 id={importTitleId} className={styles.sectionTitle}>
            Your own recording
          </h3>
          <span className={styles.rule} aria-hidden="true" />
        </div>
        <RecordAudio trackId={trackId} />
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
  /** Clips with notes, which a recording would then play at their notes' pitches. */
  noteClips: number;
}

function NoRecording(props: { trackId: Id; info: PartInfo; target: SamplerTarget | null }) {
  const { trackId, info, target } = props;
  const titleId = useId();
  const sampler = info.kind === 'sampler';
  const clips = info.noteClips;
  return (
    <div className={styles.editor}>
      <p className={styles.intro}>
        {sampler ? (
          <>
            <strong>{info.name}</strong> has no recording yet. Record one from a microphone or instrument, import one from this device, or choose a built-in recording.
          </>
        ) : (
          <>
            <strong>{info.name}</strong> plays the {INSTRUMENT_LABEL[info.kind].toLowerCase()} <strong>{info.sound}</strong>. Import a recording or choose a built-in one to turn this part into a sampler.
            {clips > 0 ? ` Its ${clips === 1 ? 'clip then plays' : `${clips} clips then play`} the recording at ${clips === 1 ? 'its' : 'their'} notes’ pitches${info.kind === 'drums' ? ' (drum hits are very low notes)' : ''}.` : ''} Undo brings {info.sound} back.
          </>
        )}
      </p>
      {sampler && <RecordAudio trackId={trackId} />}
      <ImportSampleButton trackId={trackId} variant="dropzone" />
      <section className={styles.section} aria-labelledby={titleId}>
        <div className={styles.head}>
          <h3 id={titleId} className={styles.sectionTitle}>
            Or choose a recording
          </h3>
          <span className={styles.rule} aria-hidden="true" />
        </div>
        <SamplePicker trackId={trackId} target={target} partOnly label={`Recording for ${info.name}`} onAssigned={() => focusPickerOnMount.add(trackId)} />
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
    return {
      name: t.name,
      kind: inst.kind,
      sound: soundName(p, inst),
      sampleId: inst.kind === 'sampler' ? inst.sampleId : null,
      noteClips: t.clips.filter((c) => !!c && c.notes.length > 0).length,
    };
  }, shallowEqual);
  const target = useSamplerTarget(trackId);
  if (!info) return null;
  if (info.kind !== 'sampler' || !target?.sampleId) return <NoRecording trackId={trackId} info={info} target={target} />;
  return <RecordingEditor target={target} sampleId={target.sampleId} />;
}
