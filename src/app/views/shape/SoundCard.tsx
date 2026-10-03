/**
 * Simple Shape's "Sound" card: a few friendly knobs for the part's own
 * instrument, built on the same commands as Advanced (so Undo, performance
 * recording and the take lock behave the same), and "Edit sound", which
 * opens the instrument's every setting in Advanced for this part.
 *
 * - Synths: Soft start (Attack), Length (Release), then Octave and
 *   Character (the wave) on the bass synth; Character (Tone 1's wave) and
 *   Thickness (Unison) on the poly synth, which has no octave control.
 * - Drum kits: a drum mix: the kick, snare and hats levels and the kick's
 *   tune (the kit's own voices, setDrumVoice; Hats moves the closed and open
 *   hats together, keeping their balance).
 * - Samplers: Start and Length of the region that plays (moving Start keeps
 *   the length), Pitch, and a small picture of the recording.
 */
import { useEffect, useId, useMemo, useRef } from 'react';
import { Button, Knob, newGestureId, type KnobSize } from '../../../ui/components';
import { getKitVoiceNames } from '../../../audio/instruments/kits';
import { kitInfo } from '../../../content/catalog';
import { moduleId } from '../../../project/factory';
import { DRUM_VOICE_PARAM_SPECS, INSTRUMENT_PARAMS, SAMPLER_PARAMS, clampParam, specById, type ParamSpec } from '../../../project/params';
import type { DrumVoiceSettings, Id, InstrumentKind } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { session, useProject } from '../../instance';
import { useEditLocked, LOCKED_TEXT } from '../ClipMenu';
import { useSampleOverview } from '../sampler/sampleOverview';
import { useKnobExtras } from './knobExtras';
import { ParamKnob } from './ParamKnob';
import { controllerName, effectiveValue } from './paramState';
import styles from './SoundCard.module.css';

/* ------------------------------------------------------------------ */
/* Synths                                                              */
/* ------------------------------------------------------------------ */

interface SoundKnobDef {
  param: string;
  label: string;
  tip: string;
}

const SYNTH_KNOBS: Record<'bass' | 'poly', readonly SoundKnobDef[]> = {
  bass: [
    { param: 'attack', label: 'Soft start', tip: 'Turn up to make each note fade in instead of starting at once.' },
    { param: 'release', label: 'Length', tip: 'How long each note keeps sounding after it ends.' },
    { param: 'octave', label: 'Octave', tip: 'Moves the whole bass up or down by octaves.' },
    { param: 'wave', label: 'Character', tip: 'The basic colour: Saw is buzzy, Square hollow, Triangle and Sine round.' },
  ],
  poly: [
    { param: 'attack', label: 'Soft start', tip: 'Turn up to make chords swell in instead of starting at once.' },
    { param: 'release', label: 'Length', tip: 'How long notes keep sounding after they end.' },
    { param: 'osc1Wave', label: 'Character', tip: 'The main tone colour: Saw is bright and buzzy, Square hollow, Triangle and Sine soft.' },
    { param: 'unison', label: 'Thickness', tip: 'Stacks copies of the main tone: 1 is a single tone, 5 to 7 sound huge and wide.' },
  ],
};

function SynthKnobs(props: { trackId: Id; kind: 'bass' | 'poly'; size: KnobSize }) {
  const { trackId, kind, size } = props;
  const inst = moduleId.inst(trackId);
  return (
    <>
      {SYNTH_KNOBS[kind].map((k) => {
        const spec = specById(INSTRUMENT_PARAMS[kind], k.param);
        if (!spec) return null;
        return (
          <ParamKnob
            key={k.param}
            id={`simple-sound-${k.param}`}
            moduleId={inst}
            param={k.param}
            spec={spec}
            ownerTrackId={trackId}
            instrumentTrackId={trackId}
            size={size}
            label={k.label}
            tip={k.tip}
            detail={`${spec.label} in every setting. ${spec.detail ?? ''}`.trim()}
          />
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Drum mix                                                            */
/* ------------------------------------------------------------------ */

/** A level of a drum voice (1 = as the kit was designed), shown in percent. */
const VOICE_LEVEL: ParamSpec = { ...DRUM_VOICE_PARAM_SPECS.level, unit: '%' };

interface MixGroup {
  key: string;
  label: string;
  /** Voice slots it moves; the first one's value is shown, the others keep their balance with it. */
  slots: readonly number[];
}

/** The kit's kick, snare and hats (standard kits), or its first three sounds (percussion kits). */
export function drumMixGroups(kitId: string): MixGroup[] {
  const names = getKitVoiceNames(kitId);
  const family = kitInfo(kitId)?.family ?? 'kit';
  if (family === 'kit') {
    const hats = [4, 5, 6].filter((s) => s < 6 || /hat/i.test(names[s] ?? ''));
    return [
      { key: 'kick', label: 'Kick', slots: [0] },
      { key: 'snare', label: 'Snare', slots: [2] },
      { key: 'hats', label: 'Hats', slots: hats },
    ];
  }
  return [0, 2, 4].map((s) => ({ key: `v${s}`, label: names[s] ?? `Sound ${s + 1}`, slots: [s] }));
}

function useVoices(trackId: Id): DrumVoiceSettings[] | null {
  return useProject(
    (p) => {
      const inst = p.tracks.find((t) => t.id === trackId)?.instrument;
      return inst?.kind === 'drums' ? inst.voices : null;
    },
    (a, b) => a === b,
  );
}

function setVoices(trackId: Id, changes: readonly [number, Partial<DrumVoiceSettings>][], gesture: string): void {
  for (const [slot, partial] of changes) if (!session.accepted(cmd.setDrumVoice(session.store, trackId, slot, partial, gesture))) return;
}

function VoiceKnob(props: { id: string; label: string; spec: ParamSpec; value: number; tip: string; size: KnobSize; locked: boolean; onSet(v: number, gesture: string): void }) {
  const { id, label, spec, value, tip, size, locked, onSet } = props;
  useKnobExtras(id, { onAltReset: locked ? undefined : () => onSet(spec.default, newGestureId('knob-reset')) });
  return (
    <Knob
      id={id}
      spec={spec}
      value={value}
      size={size}
      label={label}
      tip={locked ? `${LOCKED_TEXT}: drum sounds cannot change during a take.` : tip}
      disabled={locked}
      onChange={(v, info) => onSet(v, info.gesture)}
    />
  );
}

function DrumMix(props: { trackId: Id; kitId: string; size: KnobSize }) {
  const { trackId, kitId, size } = props;
  const voices = useVoices(trackId);
  const locked = useEditLocked();
  const groups = useMemo(() => drumMixGroups(kitId), [kitId]);
  if (!voices) return null;
  const kick = groups[0];
  const levelOf = (g: MixGroup) => voices[g.slots[0]]?.level ?? 1;
  const setGroup = (g: MixGroup, v: number, gesture: string) => {
    const cur = levelOf(g);
    const ratio = cur > 0.001 ? v / cur : null;
    setVoices(
      trackId,
      g.slots.map((s, i) => [s, { level: i === 0 || ratio === null ? v : clampParam(VOICE_LEVEL, (voices[s]?.level ?? 1) * ratio) }] as [number, Partial<DrumVoiceSettings>]),
      gesture,
    );
  };
  const tuneSpec: ParamSpec = { ...DRUM_VOICE_PARAM_SPECS.tune, label: `${kick.label} tune` };
  return (
    <>
      {groups.map((g) => (
        <VoiceKnob
          key={g.key}
          id={`simple-drum-${g.key}`}
          label={g.label}
          spec={{ ...VOICE_LEVEL, label: g.label }}
          value={levelOf(g)}
          size={size}
          locked={locked}
          tip={g.slots.length > 1 ? `How loud the ${g.label.toLowerCase()} are, together (100% is as the kit was designed).` : `How loud the ${g.label.toLowerCase()} is (100% is as the kit was designed).`}
          onSet={(v, gesture) => setGroup(g, v, gesture)}
        />
      ))}
      <VoiceKnob
        id="simple-drum-kick-tune"
        label={tuneSpec.label}
        spec={tuneSpec}
        value={voices[kick.slots[0]]?.tune ?? 0}
        size={size}
        locked={locked}
        tip={`Tunes the ${kick.label.toLowerCase()} up or down, in semitones.`}
        onSet={(v, gesture) => setVoices(trackId, [[kick.slots[0], { tune: v }]], gesture)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Sampler                                                             */
/* ------------------------------------------------------------------ */

const START: ParamSpec = { ...specById(SAMPLER_PARAMS, 'start')!, tip: 'Where in the recording each note starts playing. Moving it keeps the length.' };
const LENGTH: ParamSpec = { id: 'length', label: 'Length', min: 0.01, max: 1, default: 1, unit: '%', curve: 'lin', tip: 'How much of the recording plays from Start, as a share of the whole recording.', detail: 'Sets End (End = Start + Length).' };

interface Region {
  start: number;
  end: number;
  sampleId: string | null;
  startBy: string | null;
  endBy: string | null;
}

function SamplerKnobs(props: { trackId: Id; size: KnobSize }) {
  const { trackId, size } = props;
  const r = useProject<Region>((p) => {
    const inst = p.tracks.find((t) => t.id === trackId)?.instrument;
    const mod = moduleId.inst(trackId);
    const read = (id: 'start' | 'end') => clampParam(specById(SAMPLER_PARAMS, id)!, effectiveValue(p, mod, id) ?? (inst?.kind === 'sampler' ? inst.params[id] : undefined) ?? specById(SAMPLER_PARAMS, id)!.default);
    return {
      start: read('start'),
      end: read('end'),
      sampleId: inst?.kind === 'sampler' ? inst.sampleId : null,
      startBy: controllerName(p, mod, 'start', trackId),
      endBy: controllerName(p, mod, 'end', trackId),
    };
  }, shallowEqual);
  const set = (param: 'start' | 'end', v: number, gesture: string) => session.setInstrumentParam(trackId, param, v, gesture);
  const length = Math.max(LENGTH.min, r.end - r.start);
  const onStart = (v: number, gesture: string) => {
    set('start', v, gesture);
    if (!r.endBy) set('end', Math.min(1, v + length), gesture);
  };
  useKnobExtras('simple-sound-start', { onAltReset: r.startBy ? undefined : () => onStart(START.default, newGestureId('knob-reset')) });
  useKnobExtras('simple-sound-length', { onAltReset: r.endBy ? undefined : () => set('end', Math.min(1, r.start + LENGTH.default), newGestureId('knob-reset')) });
  const pitch = specById(SAMPLER_PARAMS, 'pitch')!;
  return (
    <>
      <Knob id="simple-sound-start" spec={START} value={r.start} size={size} controlledBy={r.startBy ?? undefined} onChange={(v, info) => onStart(v, info.gesture)} />
      <Knob
        id="simple-sound-length"
        spec={LENGTH}
        value={length}
        size={size}
        controlledBy={r.endBy ?? undefined}
        onChange={(v, info) => set('end', Math.min(1, r.start + v), info.gesture)}
      />
      <ParamKnob
        id="simple-sound-pitch"
        moduleId={moduleId.inst(trackId)}
        param="pitch"
        spec={pitch}
        ownerTrackId={trackId}
        instrumentTrackId={trackId}
        size={size}
        tip="Plays the recording higher or lower; its speed changes with it. 0 is the recording's own pitch."
      />
      {r.sampleId && <Wave sampleId={r.sampleId} start={r.start} end={r.end} />}
    </>
  );
}

/** A small picture of the recording with the part that plays lit. */
function Wave(props: { sampleId: string; start: number; end: number }) {
  const { sampleId, start, end } = props;
  const { overview, status } = useSampleOverview(sampleId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !overview) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const cs = getComputedStyle(c);
    const on = cs.getPropertyValue('--amber').trim() || '#e39b2f';
    const off = cs.getPropertyValue('--ink-3').trim() || '#8a9097';
    ctx.clearRect(0, 0, w, h);
    const pairs = overview.peaks.length / 2;
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const i = Math.min(pairs - 1, Math.floor((x / w) * pairs));
      const lo = overview.peaks[2 * i];
      const hi = overview.peaks[2 * i + 1];
      const f = x / w;
      ctx.fillStyle = f >= start && f <= end ? on : off;
      ctx.globalAlpha = f >= start && f <= end ? 1 : 0.4;
      const y0 = mid - hi * mid;
      const y1 = mid - lo * mid;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    ctx.globalAlpha = 1;
  }, [overview, start, end]);
  return (
    <figure className={styles.wave} aria-label={`The recording, ${Math.round(start * 100)}% to ${Math.round(end * 100)}% plays`}>
      <canvas ref={canvasRef} className={styles.waveCanvas} aria-hidden="true" />
      {status !== 'ready' && <figcaption className={styles.waveNote}>{status === 'loading' ? 'Loading…' : 'Not in this browser'}</figcaption>}
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

const TITLE: Record<InstrumentKind, string> = { bass: 'Sound', poly: 'Sound', drums: 'Drum mix', sampler: 'Sound' };
const NOTE: Record<InstrumentKind, string> = {
  bass: 'How each note starts, rings and sounds',
  poly: 'How each note starts, rings and sounds',
  drums: 'The kit’s main drums',
  sampler: 'Which part of the recording plays',
};

export interface SoundCardProps {
  trackId: Id;
  kind: InstrumentKind;
  kitId?: string;
  size?: KnobSize;
  /** Opens the instrument's every setting (Advanced) for this part. */
  onEditSound(): void;
}

/** A sub-card of the instrument card: its title and what it is for, the knobs, Edit sound. */
export function SoundCard(props: SoundCardProps) {
  const { trackId, kind, kitId, size = 'md', onEditSound } = props;
  const headId = useId();
  return (
    <section className={styles.card} aria-labelledby={headId} data-kind={kind} data-size={size}>
      <div className={styles.head}>
        <h3 id={headId} className={styles.title}>
          {TITLE[kind]}
        </h3>
        <span className={styles.note}>{NOTE[kind]}</span>
      </div>
      <div className={styles.knobs}>
        {kind === 'drums' && kitId ? <DrumMix trackId={trackId} kitId={kitId} size={size} /> : kind === 'sampler' ? <SamplerKnobs trackId={trackId} size={size} /> : kind === 'bass' || kind === 'poly' ? <SynthKnobs trackId={trackId} kind={kind} size={size} /> : null}
      </div>
      <Button
        id="simple-edit-sound"
        size="sm"
        variant="ghost"
        icon="sliders"
        className={styles.edit}
        onClick={onEditSound}
        tip="Every setting of this part’s instrument, in Advanced (the switch changes every view; “Show fewer settings (Simple)” comes back here)."
      >
        Edit sound
      </Button>
    </section>
  );
}
