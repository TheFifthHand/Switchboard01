/**
 * Mixer strips: one per part, and the master strip.
 *
 *   [ 1                  Muted ]  number and state in words (Muted / Solo / Not soloed)
 *   [ Hand Percussion          ]  name (up to two lines) + sound; click selects the part
 *   [ Congas                   ]
 *   ( Effects: Drive (off) · Filter )   Advanced, Sends and effects row: opens the Channel drawer
 *   ( Reverb (Space)  Echo )            Advanced, Sends and effects row: the part's big knobs
 *   (Pan)
 *   [ Mute ] [ Solo ]
 *   [ fader | meter ]             level in dB; the post-fader meter on the fader's own scale
 *                       −12.4     highest peak (a click resets it; coral above −1 dBFS)
 *
 * Level and pan are the part's channel module parameters, changed through the
 * session so a performance take records them; each drag is one undo step that
 * names the part ("Bass level"). Reverb and Echo are the part's Space and Echo
 * big knobs (session.setMacro: undoable and recorded by takes), which set the
 * amounts the part sends to the shared Reverb and Echo; when a send has no big
 * knob of its own (its mapping was removed), the send amount itself is shown.
 * Values shown are the effective ones (after macros); a control that a macro
 * sets is read-only and names the macro.
 */
import { memo, useMemo, useRef } from 'react';
import { Fader, Icon, Knob, Meter, Tooltip, faderPosition, type FaderChangeInfo, type KnobChangeInfo } from '../../../ui/components';
import { CHANNEL_PARAMS, MASTER_VOLUME_SPEC, specById, type ParamSpec } from '../../../project/params';
import type { Id, MacroId } from '../../../project/types';
import { setSolo } from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { selectTrack } from '../../../state/uiStore';
import { MACRO_SPECS } from '../../macros';
import { session, useProject, useUi } from '../../instance';
import { INSTRUMENT_LABEL, soundName } from '../../labels';
import { notify, useRuntime } from '../../runtime';
import { openChannelDrawer } from './channelDrawer';
import { formatDb, formatLevel, formatLevelShort, readMixFrame, trackPeak } from './mixMeters';
import { channelController, channelModulated, channelOf, channelValue, partEffects, sameEffects, sendMacro } from './mixState';
import { useMixTask } from './useMixTask';
import styles from './ChannelStrip.module.css';

const LEVEL = specById(CHANNEL_PARAMS, 'level')!;
const PAN = specById(CHANNEL_PARAMS, 'pan')!;
const SEND_A = specById(CHANNEL_PARAMS, 'sendA')!;
const SEND_B = specById(CHANNEL_PARAMS, 'sendB')!;

export const SOLO_LOCKED_MESSAGE = 'Solo cannot change while a performance records: a take records mutes, not solos. Use Mute, or stop recording first.';

/** Strip meters share their fader's scale, so a level lights up next to the same number on the fader. */
export const PART_METER_SCALE = (db: number) => faderPosition(LEVEL, db);
export const MASTER_METER_SCALE = (db: number) => faderPosition(MASTER_VOLUME_SPEC, db);
/** The output limiter's ceiling, marked on the master meters. */
export const CEILING_DBFS = -1;
/** Meter thickness (px) on the strips; the meter well's padding (ChannelStrip.module.css) lines it up with the fader travel. */
const METER_THICKNESS = 5;

const formatPartLevel = (v: number) => formatLevel(v, LEVEL.min);
const shortPartLevel = (v: number) => formatLevelShort(v, LEVEL.min);
const formatMasterLevel = (v: number) => formatLevel(v, MASTER_VOLUME_SPEC.min);
const shortMasterLevel = (v: number) => formatLevelShort(v, MASTER_VOLUME_SPEC.min);

interface StripInfo {
  name: string;
  sound: string;
  kind: string;
  mute: boolean;
  solo: boolean;
  channel: Id | null;
  level: number;
  pan: number;
  levelBy: string | null;
  panBy: string | null;
  levelMod: boolean;
  panMod: boolean;
}

function useStripInfo(trackId: Id): StripInfo | null {
  return useProject<StripInfo | null>((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return null;
    return {
      name: t.name,
      sound: soundName(p, t.instrument),
      kind: INSTRUMENT_LABEL[t.instrument.kind],
      mute: t.mute,
      solo: t.solo,
      channel: channelOf(p, trackId),
      level: channelValue(p, trackId, 'level'),
      pan: channelValue(p, trackId, 'pan'),
      levelBy: channelController(p, trackId, 'level'),
      panBy: channelController(p, trackId, 'pan'),
      levelMod: channelModulated(p, trackId, 'level'),
      panMod: channelModulated(p, trackId, 'pan'),
    };
  }, shallowEqual);
}

/** A part's effects as chips; a click opens the Channel drawer on that effect (the view stays Mix). */
const EffectsList = memo(function EffectsList(props: { trackId: Id; name: string }) {
  const { trackId, name } = props;
  const effects = useProject((p) => partEffects(p, trackId), sameEffects);
  return (
    <div className={styles.effects} role="group" aria-label={`${name} effects`}>
      <span className={styles.sectionLabel}>Effects</span>
      {effects.length === 0 ? (
        <Tooltip tip={`${name} has no effects. Open the Channel drawer to add an EQ or a compressor.`}>
          <button type="button" className={styles.effect} data-empty="" onClick={() => openChannelDrawer(trackId)} aria-label={`${name} has no effects: add one in the Channel drawer`}>
            None · Add
          </button>
        </Tooltip>
      ) : (
        <ul className={styles.effectList}>
          {effects.map((e) => (
            <li key={e.id}>
              <Tooltip tip={`${e.name}${e.idle ? ` is not in use: ${e.idle}` : ''}. Opens ${name}’s channel under the mixer, with its effects.`}>
                <button
                  type="button"
                  className={styles.effect}
                  data-off={e.idle ? '' : undefined}
                  onClick={() => openChannelDrawer(trackId, e.id)}
                  aria-label={`${e.name}${e.idle ? ' (off)' : ''}: open in the Channel drawer`}
                >
                  <span className={styles.effectName}>{e.idle ? `${e.name} (off)` : e.name}</span>
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

/**
 * How much a part sends to the shared Reverb (sendA) or Echo (sendB): the
 * part's Space or Echo big knob when that knob sets the send, else the send
 * amount itself.
 */
const SendKnob = memo(function SendKnob(props: { trackId: Id; name: string; send: 'sendA' | 'sendB' }) {
  const { trackId, name, send } = props;
  const reverb = send === 'sendA';
  const macro = useProject<MacroId | null>((p) => sendMacro(p, trackId, send));
  const macroValue = useProject((p) => (macro ? (p.tracks.find((t) => t.id === trackId)?.macros[macro] ?? 0) : 0));
  const raw = useProject((p) => (macro ? 0 : channelValue(p, trackId, send)));
  const rawBy = useProject((p) => (macro ? null : channelController(p, trackId, send)));
  const channel = useProject((p) => channelOf(p, trackId));
  const words = reverb ? 'reverb' : 'echo';
  const spec = useMemo<ParamSpec>(() => {
    if (macro) {
      const m = MACRO_SPECS[macro];
      const shown = reverb ? `Reverb (${m.label})` : macro === 'echo' ? 'Echo' : `Echo (${m.label})`;
      return {
        ...m,
        label: `${name} ${words}`,
        short: shown,
        tip: `How much of ${name} goes to the shared ${reverb ? 'Reverb' : 'Echo'}. This is ${name}’s ${m.label} big knob, the same one as in Play and Shape.`,
        detail: `${m.label} sets ${name}’s ${reverb ? 'Reverb' : 'Echo'} Amount (and anything else ${m.label} is set to move). One undo step per turn; a performance take records it.`,
      };
    }
    const s = reverb ? SEND_A : SEND_B;
    return { ...s, label: `${name} ${words}`, short: reverb ? 'Reverb' : 'Echo' };
  }, [macro, name, reverb, words]);
  if (macro) {
    return <Knob spec={spec} value={macroValue} size="sm" onChange={(v, i) => session.setMacro(trackId, macro, v, i.gesture)} />;
  }
  return (
    <Knob
      spec={spec}
      value={raw}
      size="sm"
      controlledBy={rawBy ?? undefined}
      disabled={!channel}
      onChange={(v, i) => {
        if (channel) session.setModuleParam(channel, send, v, i.gesture);
      }}
    />
  );
});

/** Advanced: the strip's Sends and effects row. */
function SendsRow(props: { trackId: Id; name: string }) {
  return (
    <div className={styles.sendsRow} data-testid={`sends-${props.trackId}`}>
      <EffectsList trackId={props.trackId} name={props.name} />
      <div className={styles.sends} role="group" aria-label={`${props.name} sends`}>
        <SendKnob trackId={props.trackId} name={props.name} send="sendA" />
        <SendKnob trackId={props.trackId} name={props.name} send="sendB" />
      </div>
    </div>
  );
}

export interface ChannelStripProps {
  trackId: Id;
  index: number;
  advanced: boolean;
  /** Advanced: show the Sends and effects row. */
  sends: boolean;
}

export const ChannelStrip = memo(function ChannelStrip({ trackId, index, advanced, sends }: ChannelStripProps) {
  const info = useStripInfo(trackId);
  const anySolo = useProject((p) => p.tracks.some((t) => t.solo));
  const selected = useUi((s) => s.selectedTrackId === trackId);
  const name = info?.name ?? '';
  const panSpec = useMemo<ParamSpec>(() => ({ ...PAN, label: `${name} pan`, short: 'Pan' }), [name]);
  if (!info) return null;
  const { channel } = info;
  const notSoloed = anySolo && !info.solo;
  const state = info.mute ? 'Muted' : info.solo ? 'Solo' : notSoloed ? 'Not soloed' : '';
  const stateTone = info.mute ? 'coral' : info.solo ? 'amber' : 'quiet';
  const noChannel = channel === null;

  const setParam = (param: string) => (v: number, i: FaderChangeInfo | KnobChangeInfo) => {
    if (channel) session.setModuleParam(channel, param, v, i.gesture);
  };
  const toggleSolo = () => {
    const r = setSolo(session.store, trackId, !info.solo);
    if (r.refused) notify(SOLO_LOCKED_MESSAGE, 'warn');
    else session.accepted(r);
  };

  return (
    <div
      className={styles.strip}
      role="group"
      aria-label={`${index + 1} ${name}`}
      data-selected={selected || undefined}
      data-dimmed={info.mute || notSoloed || undefined}
      data-testid={`strip-${trackId}`}
    >
      <div className={styles.top}>
        <button
          type="button"
          className={styles.head}
          aria-pressed={selected}
          aria-label={`Select ${name} (${info.sound}, ${info.kind})`}
          onClick={() => selectTrack(trackId)}
        >
          <span className={`${styles.num} mono`}>{index + 1}</span>
          <span className={styles.name} title={name}>
            {name}
          </span>
          <span className={styles.sound} title={info.sound}>
            {info.sound}
          </span>
        </button>
        {/* The state word sits in the number's row: Mute and Solo move nothing. */}
        <span className={styles.state} data-tone={stateTone}>
          {state}
        </span>
      </div>
      {advanced && sends && <SendsRow trackId={trackId} name={name} />}
      <Knob spec={panSpec} value={info.pan} size="sm" onChange={setParam('pan')} controlledBy={info.panBy ?? undefined} modulated={info.panMod} disabled={noChannel} className={styles.pan} />
      <div className={styles.ms}>
        <Tooltip tip={info.mute ? `Hear ${name} again.` : `Silence ${name}. It keeps playing in time, so unmuting brings it straight back.`}>
          <button type="button" className={`${styles.msButton} ${styles.mute}`} aria-pressed={info.mute} aria-label={`Mute ${name}`} onClick={() => session.setMute(trackId, !info.mute)}>
            <Icon name={info.mute ? 'mute' : 'speaker'} size={14} />
            <span>Mute</span>
          </button>
        </Tooltip>
        <Tooltip tip={info.solo ? `Stop soloing ${name}.` : `Hear only ${name} (and any other soloed part).`}>
          <button type="button" className={`${styles.msButton} ${styles.solo}`} aria-pressed={info.solo} aria-label={`Solo ${name}`} onClick={toggleSolo}>
            <Icon name="headphones" size={14} />
            <span>Solo</span>
          </button>
        </Tooltip>
      </div>
      <div className={styles.faderRow}>
        <Fader
          spec={LEVEL}
          value={info.level}
          label={`${name} level`}
          format={formatPartLevel}
          formatShort={shortPartLevel}
          onChange={setParam('level')}
          controlledBy={info.levelBy ?? undefined}
          modulated={info.levelMod}
          disabled={noChannel}
          tip={`How loud ${name} is in the mix. The meter beside it uses the same scale.`}
          detail="The part's channel fader, after its effects. 0 dB leaves the level as designed; the bottom is silence. The number under the meter is the highest peak (dBFS): click it to start again."
        />
        <Meter
          read={() => trackPeak(trackId)}
          label={`${name} meter`}
          orientation="vertical"
          thickness={METER_THICKNESS}
          segments={24}
          floorDb={LEVEL.min}
          scale={PART_METER_SCALE}
          peakHold
          className={styles.meterWell}
        />
      </div>
    </div>
  );
});

/** Master output: volume, stereo meter on the fader's scale with the −1 dBFS ceiling, limiter activity (Advanced) and Mute All. */
export const MasterStrip = memo(function MasterStrip(props: { advanced: boolean }) {
  const { advanced } = props;
  const masterDb = useProject((p) => p.masterVolumeDb);
  const muteAll = useRuntime((s) => s.muteAll);
  const takeRecording = useRuntime((s) => s.recording === 'performance');
  return (
    <div className={`${styles.strip} ${styles.master}`} role="group" aria-label="Master" data-dimmed={muteAll || undefined} data-testid="strip-master">
      <div className={styles.top}>
        <div className={styles.head} data-static="">
          <span className={styles.name}>Master</span>
          <span className={styles.sound}>Whole mix</span>
        </div>
        <span className={styles.state} data-tone={muteAll ? 'coral' : 'quiet'}>
          {muteAll ? 'Muted' : ''}
        </span>
      </div>
      {advanced && <LimiterReadout />}
      <Tooltip
        tip={
          muteAll
            ? 'Everything is silenced. Press to hear sound again.'
            : takeRecording
              ? 'Silence everything at once, including echoes and held notes. This also ends the performance recording, keeping what came before.'
              : 'Silence everything at once, including echoes and held notes.'
        }
      >
        <button type="button" className={`${styles.msButton} ${styles.mute} ${styles.muteAll}`} aria-pressed={muteAll} aria-label="Mute All" onClick={() => session.toggleMuteAll()}>
          <Icon name="mute" size={14} />
          <span>{muteAll ? 'Muted' : 'Mute All'}</span>
        </button>
      </Tooltip>
      <div className={styles.faderRow}>
        <Fader
          spec={MASTER_VOLUME_SPEC}
          value={masterDb}
          label="Master volume"
          format={formatMasterLevel}
          formatShort={shortMasterLevel}
          onChange={(v, i) => session.setMasterVolume(v, i.gesture)}
          tip="Overall volume of everything, before mastering."
          detail="Master gain before the mastering chain and the output limiter (ceiling −1 dBTP)."
        />
        <Tooltip
          tip="The level of the whole mix, left and right, on the fader’s scale. The line across them is the limiter’s −1 dBFS ceiling: the loudest peaks reach it on a loud master, and nothing goes above it."
          detail="Sample peaks of the output after mastering and the limiter. The lamp on top lights only at full scale (0 dBFS)."
        >
          <span className={styles.masterMeters} data-testid="master-meters">
            <Meter read={() => readMixFrame().masterPeakL} label="Master left meter" orientation="vertical" thickness={METER_THICKNESS} segments={24} floorDb={MASTER_VOLUME_SPEC.min} scale={MASTER_METER_SCALE} className={styles.masterMeter} />
            <Meter read={() => readMixFrame().masterPeakR} label="Master right meter" orientation="vertical" thickness={METER_THICKNESS} segments={24} floorDb={MASTER_VOLUME_SPEC.min} scale={MASTER_METER_SCALE} className={styles.masterMeter} />
            <span className={styles.ceilingTrack} aria-hidden="true">
              <span className={styles.ceiling} data-testid="ceiling-mark" style={{ ['--at' as string]: MASTER_METER_SCALE(CEILING_DBFS) }}>
                <span className={`${styles.ceilingText} mono`}>{formatDb(CEILING_DBFS).replace(/\.0 dB$/, '')}</span>
              </span>
            </span>
          </span>
        </Tooltip>
      </div>
    </div>
  );
});

/** How hard the output limiter is working right now (written to the DOM, not rendered). */
function LimiterReadout() {
  const ref = useRef<HTMLSpanElement>(null);
  useMixTask({
    frame() {
      const el = ref.current;
      if (!el) return false;
      const gr = readMixFrame().limiterReductionDb;
      const text = gr >= 0.1 ? formatDb(-gr) : 'Resting';
      if (el.textContent !== text) el.textContent = text;
      el.dataset.active = gr >= 0.1 ? '1' : '0';
      return gr >= 0.1;
    },
  });
  return (
    <Tooltip tip="How much the output limiter is turning peaks down right now, so nothing goes above −1 dBTP." detail="A few dB on the loudest hits is normal. Constant limiting squashes the mix: lower Loudness drive or the master volume.">
      <div className={styles.limiter} role="group" aria-label="Output limiter">
        <span className={styles.sectionLabel}>Limiter</span>
        <span ref={ref} className={`${styles.limiterValue} mono`} data-active="0">
          Resting
        </span>
      </div>
    </Tooltip>
  );
}
