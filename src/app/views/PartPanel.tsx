/**
 * The selected part's sound controls: six macros, Variation, lock, level/pan.
 */
import { Button, Knob, Tooltip } from '../../ui/components';
import { CHANNEL_PARAMS, specById } from '../../project/params';
import { moduleId } from '../../project/factory';
import { describeMacro } from '../../project/resolve';
import { MACRO_IDS, type MacroId } from '../../project/types';
import { applyVariation, setLocked } from '../../state/commands';
import { hashString } from '../../project/rng';
import { describeVariation } from '../../music/variation';
import { setView, slotFor, uiStore } from '../../state/uiStore';
import { session, useProject, useUi } from '../instance';
import { notify, runtimeStore } from '../runtime';
import { INSTRUMENT_LABEL, soundName } from '../labels';
import { MACRO_SPECS } from '../macros';
import styles from './PartPanel.module.css';

const LEVEL_SPEC = specById(CHANNEL_PARAMS, 'level')!;
const PAN_SPEC = specById(CHANNEL_PARAMS, 'pan')!;

function MacroKnob(props: { trackId: string; macro: MacroId }) {
  const { trackId, macro } = props;
  const value = useProject((p) => p.tracks.find((t) => t.id === trackId)?.macros[macro] ?? 0);
  const targets = useProject((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    return t ? describeMacro(p, t, macro).map((d) => d.label).join(', ') : '';
  });
  const spec = MACRO_SPECS[macro];
  return (
    <Knob
      spec={spec}
      value={value}
      size="md"
      onChange={(v, info) => session.setMacro(trackId, macro, v, info.gesture)}
      tip={spec.tip}
      detail={targets ? `Moves: ${targets}. ${spec.detail ?? ''}` : spec.detail}
      id={`macro-${macro}`}
    />
  );
}

/** Clip Variation should change: the part's playing clip, else its selected slot. */
function variationSlot(trackId: string): number {
  const playing = runtimeStore.getState().tracks[trackId]?.playingSlot;
  return playing ?? slotFor(uiStore.getState(), trackId);
}

function vary(trackId: string): void {
  const p = session.store.getState();
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) return;
  const slot = variationSlot(trackId);
  const clip = track.clips[slot];
  if (!clip) {
    notify('Select a clip on this part first — Variation changes a pattern.', 'warn');
    return;
  }
  const generation = (clip.variation?.generation ?? 0) + 1;
  const seed = (hashString(`${clip.id}:${generation}`) ^ p.seed) >>> 0;
  const before = clip.notes;
  const r = applyVariation(session.store, trackId, slot, seed);
  if (!session.accepted(r)) return;
  const after = session.store.getState().tracks.find((t) => t.id === trackId)?.clips[slot]?.notes ?? before;
  notify(`Variation on ${track.name} · ${clip.name}: ${describeVariation(before, after)}.`, 'info', 'undo');
}

export function PartPanel() {
  const trackId = useUi((s) => s.selectedTrackId);
  const header = useProject(
    (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      return t ? { name: t.name, sound: soundName(p, t.instrument), kind: t.instrument.kind, locked: t.locked, index: p.tracks.indexOf(t) } : null;
    },
    (a, b) => a === b || (!!a && !!b && a.name === b.name && a.sound === b.sound && a.kind === b.kind && a.locked === b.locked && a.index === b.index),
  );
  const level = useProject((p) => p.patch.modules.find((m) => m.id === moduleId.channel(trackId))?.params.level ?? 0);
  const pan = useProject((p) => p.patch.modules.find((m) => m.id === moduleId.channel(trackId))?.params.pan ?? 0);
  if (!header) return null;
  return (
    <section className={styles.panel} aria-labelledby="part-title">
      <div className={styles.head}>
        <div className={`${styles.num} mono`}>{header.index + 1}</div>
        <div className={styles.titles}>
          <h2 id="part-title" className={styles.title}>
            {header.name}
          </h2>
          <div className={styles.sound}>
            {header.sound} · {INSTRUMENT_LABEL[header.kind]}
          </div>
        </div>
        <Button size="sm" variant="ghost" icon="settings" onClick={() => setView('shape')} tip="Open the Shape view: all sound settings, effects and cables for this part.">
          Shape
        </Button>
      </div>

      <div className={styles.macros} role="group" aria-label={`${header.name} macros`}>
        {MACRO_IDS.map((m) => (
          <MacroKnob key={m} trackId={trackId} macro={m} />
        ))}
      </div>

      <div className={styles.actions}>
        <Button icon="dice" onClick={() => vary(trackId)} disabled={header.locked} tip="Make a new variation of this part's pattern. Undo brings the old one back." detail="Deterministic: the seed is stored, so saved projects and exports reproduce it.">
          Variation
        </Button>
        <Tooltip tip={header.locked ? 'This part is locked: Variation will not change it.' : 'Lock this part so Variation never changes it.'}>
          <Button icon={header.locked ? 'lock' : 'unlock'} variant="ghost" pressed={header.locked} onClick={() => session.accepted(setLocked(session.store, trackId, !header.locked))}>
            {header.locked ? 'Locked' : 'Lock'}
          </Button>
        </Tooltip>
      </div>

      <div className={styles.mix}>
        <Knob spec={LEVEL_SPEC} value={level} size="sm" onChange={(v, info) => session.setModuleParam(moduleId.channel(trackId), 'level', v, info.gesture)} />
        <Knob spec={PAN_SPEC} value={pan} size="sm" onChange={(v, info) => session.setModuleParam(moduleId.channel(trackId), 'pan', v, info.gesture)} />
      </div>
    </section>
  );
}
