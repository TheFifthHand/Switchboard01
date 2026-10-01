/**
 * Shape, Simple mode: the selected part's sound in three plain blocks.
 *
 *   [ Instrument card: icon, type, sound, Change instrument ]  [ Effects: one card per effect,   ]
 *   [ Macros: the six macro knobs, large, with a caption    ]  [ in signal order, + Add effect   ]
 *
 * Every control edits the real project through the session and commands
 * (the same edits as the Advanced view), so undo, performance recording and
 * the take lock behave exactly as there. Nothing is hidden for good: each
 * effect card opens its every setting in Advanced, and so does the header.
 */
import { memo, useId, useState } from 'react';
import { Button, Icon, IconButton, Knob, Panel, Switch, type IconName } from '../../../ui/components';
import { builtinSampleInfo, kitInfo, presetInfo } from '../../../content/catalog';
import { findModule } from '../../../project/graph';
import { PATCH_LIMITS } from '../../../project/modules';
import { MACRO_IDS, type Id, type InstrumentKind, type MacroId, type ModuleType } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { selectModule, setUiMode } from '../../../state/uiStore';
import { session, useProject } from '../../instance';
import { INSTRUMENT_LABEL, soundName } from '../../labels';
import { MACRO_SPECS } from '../../macros';
import { notify } from '../../runtime';
import { SoundBrowser } from '../SoundBrowser';
import { AddEffectMenu } from './AddEffectMenu';
import { effectSentence, mainParamSpec } from './effectCatalog';
import { MACRO_CAPTION, macroDetail, useMacroRows } from './MacroColumn';
import { ParamKnob } from './ParamKnob';
import { controllerName, moduleName } from './paramState';
import { FlowLine, LockNotice, PathWarning, focusLater, onAudiblePath, useEditLock, usePartEffects } from './shared';
import styles from './SimpleShape.module.css';

export const ADD_EFFECT_ID = 'shape-add-effect';

/** Switch to Advanced with one module selected, its card in view and focused. */
export function showInAdvanced(moduleId: Id): void {
  selectModule(moduleId);
  setUiMode('advanced');
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const card = document.getElementById(`rack-card-${moduleId}`);
      card?.scrollIntoView({ block: 'nearest' });
      (document.getElementById(`rack-${moduleId}-name`) as HTMLElement | null)?.focus({ preventScroll: true });
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Instrument card                                                     */
/* ------------------------------------------------------------------ */

const KIND_ICON: Record<InstrumentKind, IconName> = { drums: 'drum', bass: 'wave', poly: 'keys', sampler: 'mic' };

interface InstInfo {
  kind: InstrumentKind;
  sound: string;
  description: string;
}

function InstrumentCard(props: { trackId: Id }) {
  const { trackId } = props;
  const [open, setOpen] = useState(false);
  const headId = useId();
  const info = useProject<InstInfo | null>((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return null;
    const inst = t.instrument;
    const description =
      inst.kind === 'drums'
        ? (kitInfo(inst.kitId)?.description ?? '')
        : inst.kind === 'sampler'
          ? (inst.sampleId ? (builtinSampleInfo(inst.sampleId)?.description ?? 'A recording, played at its own pitch.') : 'No recording yet: choose one or import your own.')
          : (presetInfo(inst.presetId)?.description ?? '');
    return { kind: inst.kind, sound: soundName(p, inst), description };
  }, shallowEqual);
  if (!info) return null;
  return (
    <section className={styles.inst} aria-labelledby={headId}>
      <span className={styles.instIcon} aria-hidden="true">
        <Icon name={KIND_ICON[info.kind]} size={24} />
      </span>
      <div className={styles.instText}>
        <h2 id={headId} className={styles.instType}>
          Instrument <span aria-hidden="true">·</span> {INSTRUMENT_LABEL[info.kind]}
        </h2>
        <div className={styles.instSound}>{info.sound}</div>
        {info.description && <div className={styles.instDesc}>{info.description}</div>}
      </div>
      <Button
        id="simple-change-instrument"
        className={styles.big}
        variant="primary"
        icon="search"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        tip="Choose a different drum kit, synth sound or recording for this part. Undo brings the old one back."
      >
        Change instrument
      </Button>
      <SoundBrowser open={open} trackId={trackId} onClose={() => setOpen(false)} />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Macros                                                              */
/* ------------------------------------------------------------------ */

function MacroTile(props: { trackId: Id; macro: MacroId }) {
  const { trackId, macro } = props;
  const spec = MACRO_SPECS[macro];
  const value = useProject((p) => p.tracks.find((t) => t.id === trackId)?.macros[macro] ?? 0);
  const rows = useMacroRows(trackId, macro);
  const inert = rows.length === 0;
  return (
    <div className={styles.macro} role="group" aria-label={`${spec.label} macro`} data-macro={macro}>
      <Knob
        spec={spec}
        value={value}
        size="lg"
        id={`shape-macro-${macro}`}
        disabled={inert}
        tip={inert ? `${spec.label} moves nothing for this sound. Show every setting to give it something to move.` : spec.tip}
        detail={macroDetail(rows)}
        onChange={(v, info) => session.setMacro(trackId, macro, v, info.gesture)}
      />
      <div className={styles.macroCaption} data-inert={inert || undefined}>
        {inert ? 'Moves nothing here' : MACRO_CAPTION[macro]}
      </div>
    </div>
  );
}

function MacroPanel(props: { trackId: Id }) {
  return (
    <Panel title="Macros" subtitle={<span className={styles.panelNote}>Each turns several settings at once</span>} dense className={styles.macroPanel} bodyClassName={styles.macroBody}>
      <div className={styles.macros}>
        {MACRO_IDS.map((m) => (
          <MacroTile key={m} trackId={props.trackId} macro={m} />
        ))}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Effect cards                                                        */
/* ------------------------------------------------------------------ */

interface CardInfo {
  type: ModuleType;
  bypass: boolean;
  name: string;
}

const EffectCard = memo(function EffectCard(props: { trackId: Id; moduleId: Id; index: number; count: number; inChain: boolean; next: Id | null; locked: boolean }) {
  const { trackId, moduleId, index, count, inChain, next, locked } = props;
  const info = useProject<CardInfo | null>((p) => {
    const m = findModule(p.patch, moduleId);
    return m ? { type: m.type, bypass: m.bypass, name: moduleName(p, m, trackId) } : null;
  }, shallowEqual);
  const spec = info ? mainParamSpec(info.type) : undefined;
  const controlledBy = useProject((p) => (spec ? controllerName(p, moduleId, spec.id, trackId) : null));
  const silent = useProject((p) => !inChain && !onAudiblePath(p.patch, trackId, moduleId));
  if (!info) return null;
  const { name, bypass, type } = info;
  const remove = () => {
    if (!session.accepted(cmd.removeEffect(session.store, moduleId))) return;
    notify(silent ? `Removed ${name}.` : `Removed ${name}. The sound now flows straight past it.`, 'info', 'undo');
    focusLater(next ? `simple-${next}-onoff` : ADD_EFFECT_ID, ADD_EFFECT_ID);
  };
  const state = [inChain ? `effect ${index + 1} of ${count}` : null, silent ? 'not heard' : null, bypass ? 'off' : null].filter(Boolean).join(', ');
  return (
    <article id={`simple-card-${moduleId}`} className={styles.card} data-bypassed={bypass || undefined} aria-label={state ? `${name}, ${state}` : name}>
      <header className={styles.cardHead}>
        {inChain && (
          <span className={`${styles.slot} mono`} aria-hidden="true">
            {index + 1}
          </span>
        )}
        <h3 className={styles.cardTitle}>{name}</h3>
        <IconButton
          id={`simple-${moduleId}-remove`}
          className={styles.remove}
          icon="trash"
          size="sm"
          variant="danger"
          disabled={locked}
          label={`Remove ${name}`}
          tip="Take this effect out. The sound keeps flowing; Undo puts it back."
          onClick={remove}
        />
      </header>
      <div className={styles.cardBody}>
        {spec && <ParamKnob moduleId={moduleId} param={spec.id} spec={spec} ownerTrackId={trackId} size="md" className={styles.cardKnob} />}
        <div className={styles.cardText}>
          <p className={styles.sentence}>{effectSentence(type)}</p>
          {controlledBy && (
            <p className={styles.controlled}>
              <Icon name="link" size={12} />
              <span>
                {spec?.label} is set by the {controlledBy} macro.
              </span>
            </p>
          )}
          {silent && <p className={styles.notHeard}>Not heard: no path from the instrument to the output.</p>}
        </div>
      </div>
      <footer className={styles.cardFoot}>
        <Switch
          id={`simple-${moduleId}-onoff`}
          className={styles.onOff}
          label={name}
          hideLabel
          checked={!bypass}
          disabled={locked}
          tip={bypass ? `Turn ${name} back on.` : `Turn ${name} off: the sound passes through it unchanged.`}
          onChange={(on) => session.accepted(cmd.setBypass(session.store, moduleId, !on))}
        />
        <Button
          size="sm"
          variant="ghost"
          icon="sliders"
          className={styles.allSettings}
          aria-label={`All settings of ${name}`}
          onClick={() => showInAdvanced(moduleId)}
          tip={`Show every setting of ${name} in the Advanced view.`}
        >
          All settings
        </Button>
      </footer>
    </article>
  );
});

function EffectsPanel(props: { trackId: Id; className?: string }) {
  const { trackId, className } = props;
  const { chain, effects, offPath } = usePartEffects(trackId);
  const lock = useEditLock();
  const linear = chain !== null;
  const full = linear && effects.length >= PATCH_LIMITS.maxEffectsPerTrack;
  const addDisabled = !linear || full || lock !== null;
  const reason = lock
    ? 'Effects cannot be added while a performance records.'
    : !linear
      ? 'This part has custom cable routing: show every setting to place effects with cables.'
      : `This part already has ${PATCH_LIMITS.maxEffectsPerTrack} effects, the most it can hold. Remove one to add another.`;
  const onAdded = (id: Id) =>
    requestAnimationFrame(() => document.getElementById(`simple-card-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  return (
    <Panel
      title="Effects"
      subtitle={<span className={`${styles.count} mono`}>{linear ? `${effects.length} of ${PATCH_LIMITS.maxEffectsPerTrack}` : 'Custom routing'}</span>}
      className={className}
      bodyClassName={styles.fxBody}
      dense
      actions={<AddEffectMenu id={ADD_EFFECT_ID} trackId={trackId} size="md" className={styles.big} disabled={addDisabled} disabledReason={reason} onAdded={onAdded} />}
    >
      <PathWarning trackId={trackId} />
      <LockNotice lock={lock} />
      {linear ? (
        <FlowLine trackId={trackId} chain={chain} />
      ) : (
        <div className={styles.custom} role="status">
          <Icon name="cable" size={16} />
          <span>
            <strong>This part has custom cable routing.</strong> Its effects are listed in patch order; “Show every setting” lets you rearrange them with cables.
          </span>
        </div>
      )}
      {effects.length === 0 ? (
        <div className={styles.empty}>
          <p>{linear ? 'No effects yet: the instrument goes straight to its channel.' : 'This part has no effects of its own.'}</p>
          {linear && <p>Add one to change how this part sounds: a room around it, echoes, warmth, movement…</p>}
        </div>
      ) : (
        <div className={styles.cards} role="list" aria-label={linear ? 'Effects in signal order' : 'Effects of this part'}>
          {effects.map((id, i) => (
            <div key={id} role="listitem" className={styles.cardCell}>
              <EffectCard trackId={trackId} moduleId={id} index={i} count={effects.length} inChain={linear} next={effects[i + 1] ?? effects[i - 1] ?? null} locked={lock !== null} />
            </div>
          ))}
        </div>
      )}
      {full && !lock && <p className={styles.hint}>{reason}</p>}
      {offPath.length > 0 && (
        <p className={styles.hint}>
          {offPath.length === 1 ? 'One more effect of this part is' : `${offPath.length} more effects of this part are`} patched outside the chain. “Show every setting” shows {offPath.length === 1 ? 'it' : 'them'}.
        </p>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function SimpleShape(props: { trackId: Id }) {
  const { trackId } = props;
  return (
    <div className={styles.simple}>
      <div className={styles.left}>
        <InstrumentCard trackId={trackId} />
        <MacroPanel trackId={trackId} />
      </div>
      <EffectsPanel trackId={trackId} className={styles.fxPanel} />
    </div>
  );
}
