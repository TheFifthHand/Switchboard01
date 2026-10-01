/**
 * The selected part (right of the pads): Mute, Solo and Volume at the top
 * (Pan in Advanced), the instrument card with Change instrument, the six
 * macros with a one-line caption each, Variation and Lock.
 */
import { useState } from 'react';
import { Button, Icon, Knob, Tooltip, type IconName } from '../../ui/components';
import { CHANNEL_PARAMS, specById } from '../../project/params';
import { moduleId } from '../../project/factory';
import { describeMacro } from '../../project/resolve';
import { MACRO_IDS, type Instrument, type MacroId } from '../../project/types';
import { applyVariation, setLocked } from '../../state/commands';
import { hashString } from '../../project/rng';
import { describeVariation } from '../../music/variation';
import { setView, uiStore } from '../../state/uiStore';
import { session, useProject, useUi } from '../instance';
import { notify, runtimeStore } from '../runtime';
import { soundName } from '../labels';
import { MACRO_CAPTION, MACRO_SPECS } from '../macros';
import { SoundBrowser } from './SoundBrowser';
import styles from './PartPanel.module.css';

const LEVEL_SPEC = specById(CHANNEL_PARAMS, 'level')!;
const PAN_SPEC = specById(CHANNEL_PARAMS, 'pan')!;

/** The instrument type in plain words, with its icon. */
const INSTRUMENT_TYPE: Record<Instrument['kind'], { name: string; icon: IconName }> = {
  drums: { name: 'Drum kit', icon: 'drum' },
  bass: { name: 'Bass synth', icon: 'wave' },
  poly: { name: 'Synth', icon: 'keys' },
  sampler: { name: 'Sampler', icon: 'mic' },
};


function MacroKnob(props: { trackId: string; macro: MacroId }) {
  const { trackId, macro } = props;
  const value = useProject((p) => p.tracks.find((t) => t.id === trackId)?.macros[macro] ?? 0);
  const targets = useProject((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    return t ? describeMacro(p, t, macro).map((d) => d.label).join(', ') : '';
  });
  const spec = MACRO_SPECS[macro];
  // The detail lists what this part's macro really moves (its live mappings), never a fixed description.
  const moves = targets ? `Moves: ${targets}.` : 'No mappings: this macro does nothing.';
  return (
    <div className={styles.macro}>
      <Knob
        spec={spec}
        value={value}
        size="lg"
        onChange={(v, info) => session.setMacro(trackId, macro, v, info.gesture)}
        tip={spec.tip}
        detail={`${moves} ${spec.detail ? `${spec.detail} ` : ''}Shape shows and edits what it moves.`}
        id={`macro-${macro}`}
      />
      <span className={styles.macroCaption} aria-hidden="true">
        {targets ? MACRO_CAPTION[macro] : 'Moves nothing yet'}
      </span>
    </div>
  );
}

/**
 * Clip Variation changes: the part's selected clip (the one Steps shows and
 * the Loops pad ring marks), else its playing clip, else its first clip.
 */
function variationSlot(trackId: string): number {
  const chosen = uiStore.getState().selectedSlot[trackId];
  if (chosen !== undefined) return chosen;
  const playing = runtimeStore.getState().tracks[trackId]?.playingSlot;
  if (playing != null) return playing;
  const first = session.store.getState().tracks.find((t) => t.id === trackId)?.clips.findIndex((c) => !!c) ?? -1;
  return first < 0 ? 0 : first;
}

function vary(trackId: string): void {
  const p = session.store.getState();
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) return;
  const slot = variationSlot(trackId);
  const clip = track.clips[slot];
  if (!clip) {
    notify(`Slot ${slot + 1} of ${track.name} is empty. Select a clip with notes: Variation changes a pattern.`, 'warn');
    return;
  }
  const generation = (clip.variation?.generation ?? 0) + 1;
  const seed = (hashString(`${clip.id}:${generation}`) ^ p.seed) >>> 0;
  const before = clip.notes;
  const r = applyVariation(session.store, trackId, slot, seed);
  if (!session.accepted(r)) return;
  const after = session.store.getState().tracks.find((t) => t.id === trackId)?.clips[slot]?.notes ?? before;
  // Varying a clip other than the one playing is silent until it is launched: say so
  // (unless it is already queued to start).
  const rt = runtimeStore.getState();
  const tr = rt.tracks[trackId];
  const playingSlot = rt.playing && tr?.queued?.slot !== slot ? (tr?.playingSlot ?? null) : null;
  const playingClip = playingSlot !== null && playingSlot !== slot ? track.clips[playingSlot] : null;
  const elsewhere = playingClip ? ` ${playingClip.name} is playing: launch ${clip.name} to hear it.` : '';
  notify(`Variation on ${track.name} · ${clip.name}: ${describeVariation(before, after)}.${elsewhere}`, 'info', 'undo');
}

export function PartPanel() {
  const trackId = useUi((s) => s.selectedTrackId);
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const header = useProject(
    (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      return t ? { name: t.name, sound: soundName(p, t.instrument), kind: t.instrument.kind, locked: t.locked, mute: t.mute, solo: t.solo, index: p.tracks.indexOf(t) } : null;
    },
    (a, b) =>
      a === b ||
      (!!a && !!b && a.name === b.name && a.sound === b.sound && a.kind === b.kind && a.locked === b.locked && a.mute === b.mute && a.solo === b.solo && a.index === b.index),
  );
  const anySolo = useProject((p) => p.tracks.some((t) => t.solo));
  const level = useProject((p) => p.patch.modules.find((m) => m.id === moduleId.channel(trackId))?.params.level ?? LEVEL_SPEC.default);
  const pan = useProject((p) => p.patch.modules.find((m) => m.id === moduleId.channel(trackId))?.params.pan ?? PAN_SPEC.default);
  const [soundOpen, setSoundOpen] = useState(false);
  if (!header) return null;
  const type = INSTRUMENT_TYPE[header.kind];
  const status = header.mute ? 'Muted' : anySolo && !header.solo ? 'Not soloed' : header.solo ? 'Solo' : null;
  return (
    <section className={styles.panel} aria-labelledby="part-title">
      <div className={styles.head}>
        <div className={`${styles.num} mono`}>{header.index + 1}</div>
        <div className={styles.titles}>
          <h2 id="part-title" className={styles.title}>
            {header.name}
          </h2>
          {status && (
            <span className={styles.status} data-status={status === 'Solo' ? 'solo' : status === 'Muted' ? 'muted' : 'quiet'}>
              {status}
            </span>
          )}
        </div>
        <Button size="sm" variant="ghost" icon="sliders" onClick={() => setView('shape')} tip="Open the Shape view: every sound setting and effect of this part.">
          Shape
        </Button>
      </div>

      <div className={styles.mix} role="group" aria-label={`${header.name}: mute, solo and volume`}>
        <div className={styles.mixKeys}>
          <Tooltip tip={header.mute ? `Unmute ${header.name}.` : `Silence ${header.name} (it keeps playing in time).`} detail="M mutes the selected part.">
            <button type="button" className={styles.toggle} data-kind="mute" aria-pressed={header.mute} aria-keyshortcuts="M" onClick={() => session.setMute(trackId, !header.mute)}>
              <Icon name="speaker" size={16} />
              <span>Mute</span>
            </button>
          </Tooltip>
          <Tooltip tip={header.solo ? `Stop soloing ${header.name}.` : `Hear only the soloed parts.`} detail="Solo has no key: S plays a note. M mutes the selected part.">
            <button type="button" className={styles.toggle} data-kind="solo" aria-pressed={header.solo} aria-keyshortcuts="S" onClick={() => session.setSolo(trackId, !header.solo)}>
              <Icon name="headphones" size={16} />
              <span>Solo</span>
            </button>
          </Tooltip>
        </div>
        <Knob spec={LEVEL_SPEC} value={level} size="lg" label="Volume" onChange={(v, info) => session.setModuleParam(moduleId.channel(trackId), 'level', v, info.gesture)} className={styles.volume} />
        {advanced && <Knob spec={PAN_SPEC} value={pan} size="sm" onChange={(v, info) => session.setModuleParam(moduleId.channel(trackId), 'pan', v, info.gesture)} />}
      </div>

      <div className={styles.instrument}>
        <span className={styles.instrumentIcon} aria-hidden="true">
          <Icon name={type.icon} size={22} />
        </span>
        <div className={styles.instrumentText}>
          <span className={styles.instrumentType}>{type.name}</span>
          <span className={styles.instrumentSound}>{header.sound}</span>
        </div>
        <Button
          size="md"
          variant="primary"
          onClick={() => setSoundOpen(true)}
          aria-haspopup="dialog"
          aria-label={`Change instrument (now ${type.name}: ${header.sound})`}
          tip="Choose a different drum kit, synth sound or recording for this part. Undo brings the old one back."
          className={styles.change}
        >
          Change instrument
        </Button>
      </div>

      <div className={styles.macros} role="group" aria-label={`${header.name} macros`}>
        {MACRO_IDS.map((m) => (
          <MacroKnob key={m} trackId={trackId} macro={m} />
        ))}
      </div>

      <div className={styles.actions}>
        <Button icon="dice" onClick={() => vary(trackId)} disabled={header.locked} tip="Make a new variation of this part's selected clip (the one Steps shows). Undo brings the old one back." detail="Deterministic: the seed is stored, so saved projects and exports reproduce it.">
          Variation
        </Button>
        <Tooltip tip={header.locked ? 'This part is locked: Variation will not change it.' : 'Lock this part so Variation never changes it.'}>
          <Button icon={header.locked ? 'lock' : 'unlock'} variant="ghost" pressed={header.locked} onClick={() => session.accepted(setLocked(session.store, trackId, !header.locked))}>
            {header.locked ? 'Locked' : 'Lock'}
          </Button>
        </Tooltip>
      </div>
      <SoundBrowser open={soundOpen} trackId={trackId} onClose={() => setSoundOpen(false)} />
    </section>
  );
}
