/**
 * Return strips: the shared Reverb (fx:reverb) and Echo (fx:delay) that every
 * part sends to, between the parts and the master.
 *
 *   [ Reverb              Muted ]  name, state
 *   [ Shared room               ]  one-line caption
 *   (Size)  (Tone)                 Echo: (Time) (Feedback)
 *   [ Mute ]                       switches the return off for every part
 *   [ fader | meter ]              return level; what the return adds to the mix
 *
 * The level is the return module's Mix (its wet level), shown in dB on a
 * fader like the parts' (0 dB = the Mix all the way up, the bottom = 0).
 * Mute switches the return off (Bypass): the engine then silences a return
 * that only sends feed, with a short glide, and its own settings, the level
 * included, stay as they were. Every change goes through the session and the
 * patch commands (undoable; knob and level changes are recorded by a
 * performance take, Mute is refused during one, with the reason). The meter
 * reads the engine's tap after the return (MeterFrame.returns).
 */
import { memo, useMemo } from 'react';
import { Fader, Icon, Knob, Meter, Tooltip, faderPosition, type FaderChangeInfo } from '../../../ui/components';
import { DELAY_ID, REVERB_ID } from '../../../project/factory';
import { DELAY_PARAMS, REVERB_PARAMS, specById, type ParamSpec } from '../../../project/params';
import type { Id } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { session, useProject } from '../../instance';
import { notify } from '../../runtime';
import { formatDb, returnPeak } from './mixMeters';
import { controllerName, moduleValue } from './mixState';
import styles from './ChannelStrip.module.css';

export type ReturnKind = 'reverb' | 'delay';

interface ReturnDef {
  kind: ReturnKind;
  id: Id;
  name: string;
  caption: string;
  /** What the caption means, in a sentence (tooltip). */
  about: string;
  knobs: readonly { param: string; label: string }[];
  params: readonly ParamSpec[];
}

export const RETURNS: readonly ReturnDef[] = [
  {
    kind: 'reverb',
    id: REVERB_ID,
    name: 'Reverb',
    caption: 'Shared room',
    about: 'One room for every part. Each part’s Reverb (its Space big knob) sets how much of it goes in; this strip sets how much of the room you hear.',
    knobs: [
      { param: 'decay', label: 'Size' },
      { param: 'tone', label: 'Tone' },
    ],
    params: REVERB_PARAMS,
  },
  {
    kind: 'delay',
    id: DELAY_ID,
    name: 'Echo',
    caption: 'Shared echo',
    about: 'One echo for every part, in time with the beat. Each part’s Echo big knob sets how much of it goes in; this strip sets how much of the echoes you hear.',
    knobs: [
      { param: 'division', label: 'Time' },
      { param: 'feedback', label: 'Feedback' },
    ],
    params: DELAY_PARAMS,
  },
];

/** The return level fader: the module's Mix in dB (the bottom is silence). */
export const RETURN_LEVEL_MIN_DB = -60;

function levelSpec(name: string): ParamSpec {
  return {
    id: 'returnLevel',
    label: `${name} return level`,
    min: RETURN_LEVEL_MIN_DB,
    max: 0,
    default: 0,
    unit: 'dB',
    curve: 'lin',
    tip: `How much of the shared ${name} you hear, for every part at once.`,
    detail: `The ${name} module’s Mix (its wet level), in dB: 0 dB is 100%, the bottom is 0%.`,
  };
}

/** Mix (0..1) as the level fader shows it (dB, the bottom for 0). */
export function mixToDb(mix: number): number {
  if (!(mix > 0)) return RETURN_LEVEL_MIN_DB;
  return Math.max(RETURN_LEVEL_MIN_DB, Math.min(0, Math.round(20 * Math.log10(mix) * 10) / 10));
}

/** The Mix for a fader level in dB (0 at the bottom). */
export function dbToMix(db: number): number {
  if (db <= RETURN_LEVEL_MIN_DB) return 0;
  return Math.min(1, Math.round(Math.pow(10, db / 20) * 10000) / 10000);
}

const RETURN_SCALE = (db: number) => faderPosition(levelSpec('Return'), db);
const formatReturn = (db: number) => (db <= RETURN_LEVEL_MIN_DB ? `${formatDb(db)}, silent` : formatDb(db));
const shortReturn = (db: number) => (db <= RETURN_LEVEL_MIN_DB ? 'Silent' : formatDb(db));

interface ReturnInfo {
  exists: boolean;
  bypass: boolean;
  mix: number;
  mixBy: string | null;
}

const ReturnKnob = memo(function ReturnKnob(props: { def: ReturnDef; param: string; label: string; disabled: boolean }) {
  const { def, param, label, disabled } = props;
  const value = useProject((p) => moduleValue(p, def.id, param));
  const by = useProject((p) => controllerName(p, null, def.id, param));
  const spec = useMemo<ParamSpec>(() => {
    const s = specById(def.params, param)!;
    return { ...s, label: `${def.name} ${label.toLowerCase()}`, short: label };
  }, [def, param, label]);
  return <Knob spec={spec} value={value} size="sm" controlledBy={by ?? undefined} disabled={disabled} onChange={(v, i) => session.setModuleParam(def.id, param, v, i.gesture)} />;
});

export const ReturnStrip = memo(function ReturnStrip(props: { kind: ReturnKind }) {
  const def = RETURNS.find((r) => r.kind === props.kind)!;
  const info = useProject<ReturnInfo>((p) => {
    const m = p.patch.modules.find((x) => x.id === def.id);
    return { exists: !!m, bypass: !!m?.bypass, mix: m ? moduleValue(p, def.id, 'mix') : 0, mixBy: m ? controllerName(p, null, def.id, 'mix') : null };
  }, shallowEqual);
  const spec = useMemo(() => levelSpec(def.name), [def.name]);
  const muted = info.bypass;

  const setLevel = (db: number, i: FaderChangeInfo) => session.setModuleParam(def.id, 'mix', dbToMix(db), i.gesture);
  const toggleMute = () => {
    const r = cmd.setBypass(session.store, def.id, !muted);
    if (session.accepted(r))
      notify(muted ? `The shared ${def.name} is back on.` : `The shared ${def.name} is muted: every part is heard without it. Its settings are kept.`, 'info', 'undo');
  };

  return (
    <div
      className={`${styles.strip} ${styles.returnStrip}`}
      role="group"
      aria-label={`${def.name} return`}
      data-dimmed={muted || undefined}
      data-testid={`strip-return-${def.kind}`}
    >
      <div className={styles.top}>
        <Tooltip tip={def.about}>
          <div className={styles.head} data-static="">
            <span className={`${styles.num} ${styles.returnTag}`}>Return</span>
            <span className={styles.name}>{def.name}</span>
            <span className={styles.sound} data-testid={`return-caption-${def.kind}`}>
              {def.caption}
            </span>
          </div>
        </Tooltip>
        <span className={styles.state} data-tone={muted ? 'coral' : 'quiet'}>
          {muted ? 'Muted' : ''}
        </span>
      </div>
      {info.exists ? (
        <>
          <div className={styles.returnKnobs}>
            {def.knobs.map((k) => (
              <ReturnKnob key={k.param} def={def} param={k.param} label={k.label} disabled={false} />
            ))}
          </div>
          <div className={styles.ms}>
            <Tooltip tip={muted ? `Hear the shared ${def.name} again.` : `Silence the shared ${def.name} for every part. Its settings, and each part’s amount, are kept.`}>
              <button type="button" className={`${styles.msButton} ${styles.mute} ${styles.muteWide}`} aria-pressed={muted} aria-label={`Mute ${def.name} return`} onClick={toggleMute}>
                <Icon name={muted ? 'mute' : 'speaker'} size={14} />
                <span>Mute</span>
              </button>
            </Tooltip>
          </div>
          <div className={styles.faderRow}>
            <Fader
              spec={spec}
              value={mixToDb(info.mix)}
              label={`${def.name} return level`}
              format={formatReturn}
              formatShort={shortReturn}
              onChange={setLevel}
              controlledBy={info.mixBy ?? undefined}
            />
            <Meter
              read={() => returnPeak(def.kind)}
              label={`${def.name} return meter`}
              orientation="vertical"
              thickness={5}
              segments={24}
              floorDb={RETURN_LEVEL_MIN_DB}
              scale={RETURN_SCALE}
              peakHold
              className={styles.meterWell}
            />
          </div>
        </>
      ) : (
        <p className={styles.missing}>The shared {def.name} is not in the patch. Restore a part’s routing in Shape to bring it back.</p>
      )}
    </div>
  );
});
