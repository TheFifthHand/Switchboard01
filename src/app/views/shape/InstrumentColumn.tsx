/**
 * INSTRUMENT column: every synthesis parameter of the selected part.
 *
 * - Bass / poly synths: parameters grouped into Oscillators, Filter,
 *   Envelope and Output sections (anything else lands in "More").
 * - Drum kits: kit-wide parameters plus a 16-voice table with tune, decay,
 *   level and pan per voice and an audition button.
 * - Samplers: the sampler editor (waveform, trim, playback).
 * Parameters a macro moves are read-only and badged with the macro name.
 */
import { memo, useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { Icon, Knob, Panel, Select, Tooltip, type SelectOption } from '../../../ui/components';
import { getKitVoiceNames } from '../../../audio/instruments/kits';
import { KITS, SYNTH_PRESETS, kitInfo, presetInfo } from '../../../content/catalog';
import { moduleId } from '../../../project/factory';
import { DRUM_VOICE_PARAM_SPECS, INSTRUMENT_PARAMS, specById, type ParamSpec } from '../../../project/params';
import type { DrumVoiceSettings, Id, InstrumentKind } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { drumVoiceFor, selectDrumVoice } from '../../../state/uiStore';
import { session, useProject, useUi } from '../../instance';
import { INSTRUMENT_LABEL, soundName } from '../../labels';
import { useRuntime } from '../../runtime';
import { SamplerEditor } from './__devStubs'; // DEVSTUB
import { ParamKnob } from './ParamKnob';
import styles from './InstrumentColumn.module.css';

interface Section {
  title: string;
  params: readonly string[];
}

const SYNTH_SECTIONS: Record<'bass' | 'poly' | 'drums', readonly Section[]> = {
  bass: [
    { title: 'Oscillator', params: ['wave', 'octave', 'sub', 'glide'] },
    { title: 'Filter', params: ['cutoff', 'resonance', 'envAmount', 'filterDecay'] },
    { title: 'Envelope', params: ['attack', 'decay', 'sustain', 'release'] },
    { title: 'Output', params: ['drive', 'velocity', 'level'] },
  ],
  poly: [
    { title: 'Oscillators', params: ['osc1Wave', 'osc2Wave', 'osc2Semi', 'detune', 'osc2Level', 'noise', 'width'] },
    { title: 'Filter', params: ['cutoff', 'resonance', 'filterEnv', 'filterDecay'] },
    { title: 'Envelope', params: ['attack', 'decay', 'sustain', 'release'] },
    { title: 'Output', params: ['velocity', 'level'] },
  ],
  drums: [{ title: 'Whole kit', params: ['tune', 'decay', 'cutoff', 'velocity', 'level'] }],
};

/** Sections with every registry parameter placed exactly once (unlisted ones go to "More"). */
function sectionsFor(kind: 'bass' | 'poly' | 'drums'): { title: string; specs: ParamSpec[] }[] {
  const all = INSTRUMENT_PARAMS[kind];
  const used = new Set<string>();
  const out = SYNTH_SECTIONS[kind].map((s) => ({
    title: s.title,
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

const SECTIONS = { bass: sectionsFor('bass'), poly: sectionsFor('poly'), drums: sectionsFor('drums') };

const SYNTH_OPTIONS: SelectOption[] = SYNTH_PRESETS.map((p) => ({ value: p.id, label: p.name, group: INSTRUMENT_LABEL[p.kind] }));
const KIT_OPTIONS: SelectOption[] = KITS.map((k) => ({ value: k.id, label: k.name }));

function ParamSections(props: { trackId: Id; kind: 'bass' | 'poly' | 'drums' }) {
  const { trackId, kind } = props;
  const inst = moduleId.inst(trackId);
  return (
    <div className={styles.sections}>
      {SECTIONS[kind].map((section) => (
        <section key={section.title} className={styles.section} aria-label={section.title}>
          <h3 className={styles.sectionTitle}>{section.title}</h3>
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

/* ------------------------------------------------------------------ */
/* Drum voices                                                         */
/* ------------------------------------------------------------------ */

const VOICE_KEYS = ['tune', 'decay', 'level', 'pan'] as const;
type VoiceKey = (typeof VOICE_KEYS)[number];
const VOICE_LABEL: Record<VoiceKey, string> = { tune: 'Tune', decay: 'Decay', level: 'Level', pan: 'Pan' };

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
            spec={DRUM_VOICE_PARAM_SPECS[k]}
            value={voice[k]}
            size="sm"
            label={`${name} ${VOICE_LABEL[k].toLowerCase()}`}
            tip={`${DRUM_VOICE_PARAM_SPECS[k].tip} (${name})`}
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

function SoundPicker(props: { trackId: Id; kind: InstrumentKind; soundId: string }) {
  const { trackId, kind, soundId } = props;
  if (kind === 'sampler') return null;
  const drums = kind === 'drums';
  return (
    <Select
      label={drums ? 'Drum kit' : 'Synth sound'}
      hideLabel
      size="sm"
      width={150}
      value={soundId}
      options={drums ? KIT_OPTIONS : SYNTH_OPTIONS}
      tip={
        drums
          ? 'Swap this part’s drum kit. Patterns stay; voice settings go back to the kit’s design.'
          : 'Swap this part’s synth sound. Clips stay; the sound’s settings and macro mappings are loaded.'
      }
      onChange={(id) => {
        const nextKind: InstrumentKind = drums ? 'drums' : (presetInfo(id)?.kind ?? kind);
        session.accepted(cmd.changeInstrumentSound(session.store, trackId, nextKind, id));
      }}
    />
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
      subtitle={<span className={styles.kind}>{kind === 'sampler' ? `${INSTRUMENT_LABEL[kind]} · ${header.sound}` : INSTRUMENT_LABEL[kind]}</span>}
      className={className}
      bodyClassName={styles.scroll}
      dense
      actions={<SoundPicker trackId={trackId} kind={kind} soundId={header.soundId} />}
    >
      {kind === 'sampler' ? (
        <SamplerEditor trackId={trackId} />
      ) : (
        <>
          <ParamSections trackId={trackId} kind={kind} />
          {kind === 'drums' && <DrumVoiceTable trackId={trackId} kitId={header.soundId} />}
        </>
      )}
    </Panel>
  );
}
