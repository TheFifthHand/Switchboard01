/**
 * INSTRUMENT column: every synthesis parameter of the selected part.
 *
 * - Bass / poly synths: parameters grouped by what they do — Tones,
 *   Unison, FM, Noise, Pitch & movement, Filter, Envelope, Output (anything
 *   unlisted lands in "More"). A group whose main control is at zero says
 *   "Off" and which control turns it on, so its other knobs never look
 *   broken.
 * - Drum kits: kit-wide parameters plus a 16-voice table with tune, decay,
 *   level and pan per voice and an audition button.
 * - Samplers: the sampler editor (recording, waveform trim, playback, tempo).
 * Parameters a macro moves are read-only and badged with the macro name.
 */
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Button, Icon, Knob, Panel, Tooltip } from '../../../ui/components';
import { getKitVoiceNames } from '../../../audio/instruments/kits';
import { kitInfo } from '../../../content/catalog';
import { moduleId } from '../../../project/factory';
import { DRUM_VOICE_PARAM_SPECS, INSTRUMENT_PARAMS, specById, type ParamSpec } from '../../../project/params';
import type { DrumVoiceSettings, Id, InstrumentKind } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { drumVoiceFor, selectDrumVoice } from '../../../state/uiStore';
import { session, useProject, useUi } from '../../instance';
import { INSTRUMENT_LABEL, soundName } from '../../labels';
import { useRuntime } from '../../runtime';
import { SamplerEditor } from '../sampler/SamplerEditor';
import { SoundBrowser } from '../SoundBrowser';
import { ParamKnob } from './ParamKnob';
import { effectiveValue } from './paramState';
import styles from './InstrumentColumn.module.css';

interface Section {
  title: string;
  params: readonly string[];
  /** The group does nothing while this control sits at `off`; the header then says so. */
  gate?: { param: string; off: number; hint: string };
}

type SectionKind = 'bass' | 'poly' | 'drums';

const SYNTH_SECTIONS: Record<SectionKind, readonly Section[]> = {
  bass: [
    { title: 'Tones', params: ['wave', 'octave', 'sub', 'subWave', 'unisonDetune', 'glide'] },
    { title: 'FM', params: ['fmAmount', 'fmRatio', 'fmDecay'], gate: { param: 'fmAmount', off: 0, hint: 'turn up FM Amount' } },
    { title: 'Pitch Sweep', params: ['pitchEnv', 'pitchDecay'], gate: { param: 'pitchEnv', off: 0, hint: 'set a Pitch Sweep' } },
    { title: 'Filter', params: ['cutoff', 'resonance', 'envAmount', 'filterDecay'] },
    { title: 'Envelope', params: ['attack', 'decay', 'sustain', 'release'] },
    { title: 'Output', params: ['drive', 'velocity', 'level'] },
  ],
  poly: [
    { title: 'Tones', params: ['osc1Wave', 'osc2Wave', 'osc2Semi', 'detune', 'osc2Level'] },
    { title: 'Unison', params: ['unison', 'unisonDetune', 'width'] },
    { title: 'FM', params: ['fmAmount', 'fmRatio', 'fmDecay'], gate: { param: 'fmAmount', off: 0, hint: 'turn up FM Amount' } },
    { title: 'Noise', params: ['noise', 'noiseColor'], gate: { param: 'noise', off: 0, hint: 'turn up Noise' } },
    { title: 'Pitch & movement', params: ['pitchEnv', 'pitchDecay', 'vibrato', 'vibratoRate', 'drift'] },
    { title: 'Filter', params: ['cutoff', 'resonance', 'filterEnv', 'filterDecay'] },
    { title: 'Envelope', params: ['attack', 'decay', 'sustain', 'release'] },
    { title: 'Output', params: ['velocity', 'level'] },
  ],
  drums: [{ title: 'Whole kit', params: ['tune', 'decay', 'cutoff', 'velocity', 'level'] }],
};

/** Sections with every registry parameter placed exactly once (unlisted ones go to "More"). */
interface ResolvedSection {
  title: string;
  specs: ParamSpec[];
  gate?: Section['gate'];
}

function sectionsFor(kind: SectionKind): ResolvedSection[] {
  const all = INSTRUMENT_PARAMS[kind];
  const used = new Set<string>();
  const out: ResolvedSection[] = SYNTH_SECTIONS[kind].map((s) => ({
    title: s.title,
    gate: s.gate,
    specs: s.params.flatMap((id) => {
      const spec = specById(all, id);
      if (!spec) return [];
      used.add(id);
      return [spec];
    }),
  }));
  const rest = all.filter((s) => !used.has(s.id));
  if (rest.length) out.push({ title: 'More', specs: rest });
  return out.filter((s) => s.specs.length > 0);
}

const SECTIONS: Record<SectionKind, ResolvedSection[]> = {
  bass: sectionsFor('bass'),
  poly: sectionsFor('poly'),
  drums: sectionsFor('drums'),
};

/**
 * A kit's Level resets (double-click) to the level that matches the kit to
 * the synth parts, not to 0 dB, which would make the drums 10+ dB louder.
 */
function kitLevelSpec(spec: ParamSpec, kitId: string): ParamSpec {
  const matched = kitInfo(kitId)?.level;
  if (matched === undefined) return spec;
  return { ...spec, default: matched, detail: `Output trim. The default, ${matched} dB, matches this kit to the other sounds.` };
}

function ParamSections(props: { trackId: Id; kind: SectionKind; kitId?: string }) {
  const { trackId, kind, kitId } = props;
  const inst = moduleId.inst(trackId);
  const sections = useMemo(
    () =>
      kind === 'drums' && kitId
        ? SECTIONS.drums.map((s) => ({ ...s, specs: s.specs.map((spec) => (spec.id === 'level' ? kitLevelSpec(spec, kitId) : spec)) }))
        : SECTIONS[kind],
    [kind, kitId],
  );
  return (
    <div className={styles.sections}>
      {sections.map((section) => (
        <section key={section.title} className={styles.section} aria-label={section.title}>
          <h3 className={styles.sectionTitle}>
            {section.title}
            {section.gate && <GateState trackId={trackId} gate={section.gate} />}
          </h3>
          <div className={styles.knobs}>
            {section.specs.map((spec) => (
              <ParamKnob key={spec.id} moduleId={inst} param={spec.id} spec={spec} ownerTrackId={trackId} instrumentTrackId={trackId} size="sm" />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** "Off: turn up FM Amount" while a group's main control is at its off value. */
function GateState(props: { trackId: Id; gate: NonNullable<Section['gate']> }) {
  const { trackId, gate } = props;
  const off = useProject((p) => {
    const v = effectiveValue(p, moduleId.inst(trackId), gate.param) ?? p.tracks.find((t) => t.id === trackId)?.instrument.params[gate.param];
    return v === undefined || v === gate.off;
  });
  if (!off) return null;
  return <span className={styles.sectionState}>Off: {gate.hint}</span>;
}

/* ------------------------------------------------------------------ */
/* Drum voices                                                         */
/* ------------------------------------------------------------------ */

const VOICE_KEYS = ['tune', 'decay', 'level', 'pan'] as const;
type VoiceKey = (typeof VOICE_KEYS)[number];
const VOICE_LABEL: Record<VoiceKey, string> = { tune: 'Tune', decay: 'Decay', level: 'Level', pan: 'Pan' };
/** Voice specs as the table shows them: level reads as a percentage of the designed volume (1 = 100%). */
const VOICE_SPECS: Record<VoiceKey, ParamSpec> = {
  ...DRUM_VOICE_PARAM_SPECS,
  level: { ...DRUM_VOICE_PARAM_SPECS.level, unit: '%' },
};

function Audition(props: { trackId: Id; voice: number; name: string }) {
  const { trackId, voice, name } = props;
  const held = useRuntime((s) => s.held[trackId]?.includes(voice) ?? false);
  const down = useRef(false);
  const start = () => {
    if (down.current) return;
    down.current = true;
    selectDrumVoice(trackId, voice);
    session.noteOn(trackId, voice, 0.85, 'pad');
  };
  const end = () => {
    if (!down.current) return;
    down.current = false;
    session.noteOff(trackId, voice, 'pad');
  };
  // Never leave a sound hanging when the row goes away mid-press.
  useEffect(
    () => () => {
      if (!down.current) return;
      down.current = false;
      session.noteOff(trackId, voice, 'pad');
    },
    [trackId, voice],
  );
  return (
    <Tooltip name={`Play ${name}`} tip="Hear this sound; hold to let it ring. It also becomes the sound the Steps editor edits.">
      <button
        type="button"
        className={styles.audition}
        data-held={held || undefined}
        aria-label={`Play ${name}${held ? ' (sounding)' : ''}`}
        onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
          if (e.button !== 0) return;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* synthetic pointer */
          }
          start();
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          if (!e.repeat) start();
        }}
        onKeyUp={(e: KeyboardEvent<HTMLButtonElement>) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          end();
        }}
        onBlur={end}
      >
        <Icon name="play" size={12} />
      </button>
    </Tooltip>
  );
}

const VoiceRow = memo(function VoiceRow(props: { trackId: Id; index: number; name: string; selected: boolean }) {
  const { trackId, index, name, selected } = props;
  const voice = useProject<DrumVoiceSettings | null>((p) => {
    const inst = p.tracks.find((t) => t.id === trackId)?.instrument;
    return inst?.kind === 'drums' ? (inst.voices[index] ?? null) : null;
  });
  if (!voice) return null;
  return (
    <tr className={styles.voiceRow} data-selected={selected || undefined}>
      <td className={styles.cellPlay}>
        <Audition trackId={trackId} voice={index} name={name} />
      </td>
      <th scope="row" className={styles.voiceName}>
        <span className={styles.voiceLabel}>
          <span className={`${styles.voiceNum} mono`}>{String(index + 1).padStart(2, '0')}</span>
          <span className={styles.voiceText}>{name}</span>
          {selected && <span className="visually-hidden"> (selected for step editing)</span>}
        </span>
      </th>
      {VOICE_KEYS.map((k) => (
        <td key={k} className={styles.cellKnob}>
          <Knob
            className={styles.mini}
            spec={VOICE_SPECS[k]}
            value={voice[k]}
            size="sm"
            label={`${name} ${VOICE_LABEL[k].toLowerCase()}`}
            tip={`${VOICE_SPECS[k].tip} (${name})`}
            onChange={(v, info) => session.accepted(cmd.setDrumVoice(session.store, trackId, index, { [k]: v }, info.gesture))}
          />
        </td>
      ))}
    </tr>
  );
});

function DrumVoiceTable(props: { trackId: Id; kitId: string }) {
  const { trackId, kitId } = props;
  const names = useMemo(() => getKitVoiceNames(kitId), [kitId]);
  const selectedVoice = useUi((s) => drumVoiceFor(s, trackId));
  const kitName = kitInfo(kitId)?.name ?? 'Drum kit';
  return (
    <section className={styles.section} aria-label="Drum voices">
      <h3 className={styles.sectionTitle}>Voices</h3>
      <div className={styles.voicesWrap}>
        <table className={styles.voices}>
          <caption className="visually-hidden">The 16 sounds of {kitName}: tune, decay, level and pan for each.</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Play</span>
              </th>
              <th scope="col" className={styles.headName}>
                Sound
              </th>
              {VOICE_KEYS.map((k) => (
                <th key={k} scope="col">
                  {VOICE_LABEL[k]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {names.map((n, i) => (
              <VoiceRow key={i} trackId={trackId} index={i} name={n} selected={i === selectedVoice} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Column                                                              */
/* ------------------------------------------------------------------ */

interface Header {
  kind: InstrumentKind;
  sound: string;
  soundId: string;
}

function sameHeader(a: Header | null, b: Header | null): boolean {
  return a === b || (!!a && !!b && a.kind === b.kind && a.sound === b.sound && a.soundId === b.soundId);
}

function ChangeSound(props: { trackId: Id; sound: string }) {
  const { trackId, sound } = props;
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        iconRight="chevronDown"
        aria-haspopup="dialog"
        aria-label={`Sound: ${sound}. Change sound`}
        onClick={() => setOpen(true)}
        tip="Choose a different drum kit, synth preset or recording for this part. Undo brings the old one back."
      >
        {sound}
      </Button>
      <SoundBrowser open={open} trackId={trackId} onClose={() => setOpen(false)} />
    </>
  );
}

export function InstrumentColumn(props: { trackId: Id; className?: string }) {
  const { trackId, className } = props;
  const header = useProject<Header | null>((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return null;
    const inst = t.instrument;
    const soundId = inst.kind === 'drums' ? inst.kitId : inst.kind === 'sampler' ? (inst.sampleId ?? '') : inst.presetId;
    return { kind: inst.kind, sound: soundName(p, inst), soundId };
  }, sameHeader);
  if (!header) return null;
  const { kind } = header;
  return (
    <Panel
      title="Instrument"
      subtitle={<span className={styles.kind}>{INSTRUMENT_LABEL[kind]}</span>}
      className={className}
      bodyClassName={styles.scroll}
      dense
      actions={<ChangeSound trackId={trackId} sound={header.sound} />}
    >
      {kind === 'sampler' ? (
        <SamplerEditor trackId={trackId} />
      ) : (
        <>
          <ParamSections trackId={trackId} kind={kind} kitId={kind === 'drums' ? header.soundId : undefined} />
          {kind === 'drums' && <DrumVoiceTable trackId={trackId} kitId={header.soundId} />}
        </>
      )}
    </Panel>
  );
}
