/**
 * Mixer strips: one per part, and the master strip.
 *
 *   [ 1 Drums · Round Machine ]   name + sound (click selects the part)
 *   [ Muted / Solo / Not soloed ] state in words
 *   ( Effects: Drive · Filter )   Advanced: opens that part in Shape
 *   ( Reverb Amount  Echo Amount ) Advanced
 *   (Pan)
 *   [ Mute ] [ Solo ]
 *   [ fader | meter ]             level in dB, post-fader meter
 *
 * Level, pan and the send amounts are the part's channel module parameters,
 * changed through the session so a performance take records them; each drag
 * is one undo step. Values shown are the effective ones (after macros); a
 * control that a macro sets is read-only and names the macro.
 */
import { memo, useRef } from 'react';
import { Fader, Icon, Knob, Meter, Tooltip, useRafLoop, type FaderChangeInfo, type KnobChangeInfo } from '../../../ui/components';
import { CHANNEL_PARAMS, MASTER_VOLUME_SPEC, specById } from '../../../project/params';
import type { Id } from '../../../project/types';
import { setSolo } from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { selectModule, selectTrack, setView } from '../../../state/uiStore';
import { session, useProject, useUi } from '../../instance';
import { INSTRUMENT_LABEL, soundName } from '../../labels';
import { notify, useRuntime } from '../../runtime';
import { formatDb, formatLevel, readMixFrame, trackPeak } from './mixMeters';
import { channelController, channelModulated, channelOf, channelValue, partEffects, sameEffects } from './mixState';
import styles from './ChannelStrip.module.css';

const LEVEL = specById(CHANNEL_PARAMS, 'level')!;
const PAN = specById(CHANNEL_PARAMS, 'pan')!;
const SEND_A = specById(CHANNEL_PARAMS, 'sendA')!;
const SEND_B = specById(CHANNEL_PARAMS, 'sendB')!;

export const SOLO_LOCKED_MESSAGE = 'Solo cannot change while a performance records: a take records mutes, not solos. Use Mute, or stop recording first.';

const formatPartLevel = (v: number) => formatLevel(v, LEVEL.min);
const formatMasterLevel = (v: number) => formatLevel(v, MASTER_VOLUME_SPEC.min);

interface StripInfo {
  name: string;
  sound: string;
  kind: string;
  mute: boolean;
  solo: boolean;
  channel: Id | null;
  level: number;
  pan: number;
  sendA: number;
  sendB: number;
  levelBy: string | null;
  panBy: string | null;
  sendABy: string | null;
  sendBBy: string | null;
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
      sendA: channelValue(p, trackId, 'sendA'),
      sendB: channelValue(p, trackId, 'sendB'),
      levelBy: channelController(p, trackId, 'level'),
      panBy: channelController(p, trackId, 'pan'),
      sendABy: channelController(p, trackId, 'sendA'),
      sendBBy: channelController(p, trackId, 'sendB'),
      levelMod: channelModulated(p, trackId, 'level'),
      panMod: channelModulated(p, trackId, 'pan'),
    };
  }, shallowEqual);
}

/** Open a part (and one of its effects) in Shape. */
function openInShape(trackId: Id, moduleIdStr: Id | null): void {
  selectTrack(trackId);
  selectModule(moduleIdStr);
  setView('shape');
}

const EffectsList = memo(function EffectsList(props: { trackId: Id; name: string }) {
  const { trackId, name } = props;
  const effects = useProject((p) => partEffects(p, trackId), sameEffects);
  return (
    <div className={styles.effects} role="group" aria-label={`${name} effects`}>
      <span className={styles.sectionLabel}>Effects</span>
      {effects.length === 0 ? (
        <Tooltip tip={`${name} has no effects. Add some in Shape.`}>
          <button type="button" className={styles.effect} data-empty="" onClick={() => openInShape(trackId, null)} aria-label={`${name} has no effects: add one in Shape`}>
            None · Add
          </button>
        </Tooltip>
      ) : (
        <ul className={styles.effectList}>
          {effects.map((e) => (
            <li key={e.id}>
              <Tooltip tip={`Open ${name} in Shape with its ${e.name} selected${e.bypass ? ' (it is switched off)' : ''}.`}>
                <button
                  type="button"
                  className={styles.effect}
                  data-off={e.bypass || undefined}
                  onClick={() => openInShape(trackId, e.id)}
                  aria-label={`${e.name}${e.bypass ? ' (off)' : ''}: open in Shape`}
                >
                  <span className={styles.effectName}>{e.name}</span>
                  {e.bypass && <span className={styles.effectOff}>Off</span>}
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

export interface ChannelStripProps {
  trackId: Id;
  index: number;
  advanced: boolean;
}

export const ChannelStrip = memo(function ChannelStrip({ trackId, index, advanced }: ChannelStripProps) {
  const info = useStripInfo(trackId);
  const anySolo = useProject((p) => p.tracks.some((t) => t.solo));
  const selected = useUi((s) => s.selectedTrackId === trackId);
  if (!info) return null;
  const { name, channel } = info;
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
      <button
        type="button"
        className={styles.head}
        aria-pressed={selected}
        aria-label={`Select ${name} (${info.sound}, ${info.kind})`}
        onClick={() => selectTrack(trackId)}
      >
        <span className={styles.headTop}>
          <span className={`${styles.num} mono`}>{index + 1}</span>
          <span className={styles.name} title={name}>
            {name}
          </span>
        </span>
        <span className={styles.sound} title={info.sound}>
          {info.sound}
        </span>
      </button>
      <div className={styles.state} data-tone={stateTone}>
        {state}
      </div>
      {advanced && <EffectsList trackId={trackId} name={name} />}
      {advanced && (
        <div className={styles.sends}>
          <Knob spec={SEND_A} value={info.sendA} size="sm" onChange={setParam('sendA')} controlledBy={info.sendABy ?? undefined} disabled={noChannel} />
          <Knob spec={SEND_B} value={info.sendB} size="sm" onChange={setParam('sendB')} controlledBy={info.sendBBy ?? undefined} disabled={noChannel} />
        </div>
      )}
      <Knob
        spec={PAN}
        value={info.pan}
        size="sm"
        onChange={setParam('pan')}
        controlledBy={info.panBy ?? undefined}
        modulated={info.panMod}
        disabled={noChannel}
        className={styles.pan}
      />
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
          onChange={setParam('level')}
          controlledBy={info.levelBy ?? undefined}
          modulated={info.levelMod}
          disabled={noChannel}
          tip={`How loud ${name} is in the mix.`}
          detail="The part's channel fader, after its effects. 0 dB leaves the level as designed; the bottom is silence."
        />
        <span className={styles.meterWell}>
          <Meter read={() => trackPeak(trackId)} label={`${name} meter`} orientation="vertical" thickness={6} segments={24} />
        </span>
      </div>
    </div>
  );
});

/** Master output: volume, stereo meter, limiter activity (Advanced) and Mute All. */
export const MasterStrip = memo(function MasterStrip(props: { advanced: boolean }) {
  const { advanced } = props;
  const masterDb = useProject((p) => p.masterVolumeDb);
  const muteAll = useRuntime((s) => s.muteAll);
  const takeRecording = useRuntime((s) => s.recording === 'performance');
  return (
    <div className={`${styles.strip} ${styles.master}`} role="group" aria-label="Master" data-dimmed={muteAll || undefined} data-testid="strip-master">
      <div className={styles.head} data-static="">
        <span className={styles.headTop}>
          <span className={styles.name}>Master</span>
        </span>
        <span className={styles.sound}>Whole mix</span>
      </div>
      <div className={styles.state} data-tone={muteAll ? 'coral' : 'quiet'}>
        {muteAll ? 'Muted' : ''}
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
          onChange={(v, i) => session.setMasterVolume(v, i.gesture)}
          tip="Overall volume of everything, before mastering."
          detail="Master gain before the mastering chain and the output limiter (ceiling −1 dBFS)."
        />
        <span className={styles.meterWell}>
          <Meter read={() => readMixFrame().masterPeakL} label="Master left meter" orientation="vertical" thickness={6} segments={24} />
        </span>
        <span className={styles.meterWell}>
          <Meter read={() => readMixFrame().masterPeakR} label="Master right meter" orientation="vertical" thickness={6} segments={24} />
        </span>
      </div>
    </div>
  );
});

/** How hard the output limiter is working right now (written to the DOM, not rendered). */
function LimiterReadout() {
  const ref = useRef<HTMLSpanElement>(null);
  const at = useRef(0);
  useRafLoop((_, now) => {
    if (now - at.current < 120 || !ref.current) return;
    at.current = now;
    const gr = readMixFrame().limiterReductionDb;
    const text = gr >= 0.1 ? formatDb(-gr) : 'Resting';
    if (ref.current.textContent !== text) ref.current.textContent = text;
    ref.current.dataset.active = gr >= 0.1 ? '1' : '0';
  }, true);
  return (
    <Tooltip tip="How much the output limiter is turning peaks down right now, so nothing goes above −1 dBFS." detail="A few dB on the loudest hits is normal. Constant limiting squashes the mix: lower Loudness or the master volume.">
      <div className={styles.limiter} role="group" aria-label="Output limiter">
        <span className={styles.sectionLabel}>Limiter</span>
        <span ref={ref} className={`${styles.limiterValue} mono`} data-active="0">
          Resting
        </span>
      </div>
    </Tooltip>
  );
}
