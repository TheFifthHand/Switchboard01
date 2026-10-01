/**
 * Shape, Simple mode: the selected part's sound in three plain blocks.
 *
 *   [ Instrument card: icon, type, sound, Change instrument ]  [ Effects: one card per effect,   ]
 *   [ Big knobs: the six macros, large, with a caption      ]  [ in signal order, + Add effect   ]
 *
 * Every control edits the real project through the session and commands
 * (the same edits as the Advanced view), so undo, performance recording and
 * the take lock behave exactly as there. Nothing is hidden for good: each
 * effect card opens its every setting in Advanced, and so does the header.
 * An effect card's one knob always changes the sound: it is the first of the
 * effect's main settings that no big knob sets (or that big knob itself).
 */
import { memo, useId, useState } from 'react';
import { Button, Icon, IconButton, Knob, Panel, Switch, type IconName } from '../../../ui/components';
import { builtinSampleInfo, kitInfo, presetInfo } from '../../../content/catalog';
import { findModule } from '../../../project/graph';
import { PATCH_LIMITS } from '../../../project/modules';
import type { MacroControl } from '../../../project/resolve';
import { MACRO_IDS, type Id, type InstrumentKind, type MacroId, type ModuleType, type Project } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { selectModule } from '../../../state/uiStore';
import { session, useProject } from '../../instance';
import { INSTRUMENT_LABEL, soundName } from '../../labels';
import { MACRO_SPECS } from '../../macros';
import { notify } from '../../runtime';
import { SoundBrowser } from '../SoundBrowser';
import { AddEffectMenu } from './AddEffectMenu';
import { effectSentence, mainKnobCandidates } from './effectCatalog';
import { MACRO_CAPTION, macroDetail, useMacroRows } from './MacroColumn';
import { ParamKnob } from './ParamKnob';
import { controllerName, derived, moduleName } from './paramState';
import { FlowLine, LockNotice, PathWarning, SHOW_EVERY_SETTING, effectCount, focusLater, onAudiblePath, useAdvancedSwitch, useEditLock, usePartEffects } from './shared';
import { RecordAudio } from '../sampler/RecordAudio';
import styles from './SimpleShape.module.css';

export const ADD_EFFECT_ID = 'shape-add-effect';

/** Switch to Advanced (with `toAdvanced`, which says so) with one module selected, its card in view and focused. */
export function showInAdvanced(moduleId: Id, toAdvanced: () => void): void {
  selectModule(moduleId);
  toAdvanced();
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
      {info.kind === 'sampler' && (
        // Record your voice or an instrument straight into this part (same control as in Advanced).
        <div className={styles.instRecord}>
          <RecordAudio trackId={trackId} />
        </div>
      )}
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
    <div className={styles.macro} role="group" aria-label={`${spec.label} big knob`} data-macro={macro}>
      <Knob
        spec={spec}
        value={value}
        size="lg"
        id={`shape-macro-${macro}`}
        disabled={inert}
        tip={inert ? `${spec.label} moves nothing for this sound. ${SHOW_EVERY_SETTING} gives it something to move.` : spec.tip}
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
    <Panel title="Big knobs" subtitle={<span className={styles.panelNote}>Each turns several settings at once</span>} dense className={styles.macroPanel} bodyClassName={styles.macroBody}>
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

/** What an effect card's one knob is. */
interface MainKnob {
  /** The parameter the knob sets: the first candidate no macro controls; null when macros set them all. */
  param: string | null;
  /** The candidates passed over because a big knob (macro) sets them, with that knob's name. */
  controlled: readonly { label: string; by: string }[];
  /** When macros set every candidate: the macro that sets the first one (the card shows its knob). */
  macro: MacroControl | null;
}

const sameMainKnob = (a: MainKnob | null, b: MainKnob | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.param === b.param &&
    a.macro?.trackId === b.macro?.trackId &&
    a.macro?.macro === b.macro?.macro &&
    a.controlled.length === b.controlled.length &&
    a.controlled.every((c, i) => c.label === b.controlled[i].label && c.by === b.controlled[i].by));

/**
 * The card's knob must change the sound when turned. A setting a macro
 * controls is read-only, so pick the first candidate no macro controls; when
 * macros control them all, the card shows the macro's own knob instead.
 */
export function chooseMainKnob(p: Project, moduleId: Id, type: ModuleType, ownerTrackId: Id): MainKnob {
  const map = derived(p).controlled;
  const candidates = mainKnobCandidates(type);
  const controlled: { label: string; by: string }[] = [];
  for (const spec of candidates) {
    if (!map.has(`${moduleId}.${spec.id}`)) return { param: spec.id, controlled, macro: null };
    controlled.push({ label: spec.label, by: controllerName(p, moduleId, spec.id, ownerTrackId) ?? '' });
  }
  return { param: null, controlled, macro: candidates.length ? (map.get(`${moduleId}.${candidates[0].id}`) ?? null) : null };
}

const joinAnd = (xs: readonly string[]) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** "Drive is set by the Drive knob." / "Cutoff and Brightness are set by the Tone knob." */
function controlledSentences(controlled: MainKnob['controlled']): string[] {
  const byKnob = new Map<string, string[]>();
  for (const c of controlled) byKnob.set(c.by, [...(byKnob.get(c.by) ?? []), c.label]);
  return [...byKnob].map(([by, labels]) => `${joinAnd(labels)} ${labels.length > 1 ? 'are' : 'is'} set by the ${by} knob.`);
}

/** The knob of the macro that sets every main setting of an effect (turning it turns the big knob). */
function MacroCardKnob(props: { control: MacroControl; ownerTrackId: Id; className?: string }) {
  const { control, ownerTrackId, className } = props;
  const spec = MACRO_SPECS[control.macro];
  const value = useProject((p) => p.tracks.find((t) => t.id === control.trackId)?.macros[control.macro] ?? spec.default);
  const otherPart = useProject((p) => (control.trackId === ownerTrackId ? null : (p.tracks.find((t) => t.id === control.trackId)?.name ?? null)));
  const name = otherPart ? `${otherPart} ${spec.label}` : spec.label;
  const rows = useMacroRows(control.trackId, control.macro);
  return (
    <Knob
      spec={spec}
      value={value}
      size="md"
      label={`${name} (big knob)`}
      tip={`This is the ${name} big knob (${MACRO_CAPTION[control.macro].toLowerCase()}): turning it here turns it in Big knobs too.`}
      detail={macroDetail(rows)}
      className={className}
      onChange={(v, info) => session.setMacro(control.trackId, control.macro, v, info.gesture)}
    />
  );
}

const EffectCard = memo(function EffectCard(props: { trackId: Id; moduleId: Id; index: number; count: number; inChain: boolean; next: Id | null; locked: boolean }) {
  const { trackId, moduleId, index, count, inChain, next, locked } = props;
  const info = useProject<CardInfo | null>((p) => {
    const m = findModule(p.patch, moduleId);
    return m ? { type: m.type, bypass: m.bypass, name: moduleName(p, m, trackId) } : null;
  }, shallowEqual);
  const main = useProject<MainKnob | null>((p) => {
    const m = findModule(p.patch, moduleId);
    return m ? chooseMainKnob(p, moduleId, m.type, trackId) : null;
  }, sameMainKnob);
  const silent = useProject((p) => !inChain && !onAudiblePath(p.patch, trackId, moduleId));
  const { toAdvanced } = useAdvancedSwitch();
  if (!info || !main) return null;
  const { name, bypass, type } = info;
  const spec = main.param !== null ? mainKnobCandidates(type).find((x) => x.id === main.param) : undefined;
  const remove = () => {
    if (!session.accepted(cmd.removeEffect(session.store, moduleId))) return;
    notify(silent ? `Removed ${name}.` : `Removed ${name}. The sound now flows straight past it.`, 'info', 'undo');
    focusLater(next ? `simple-${next}-onoff` : ADD_EFFECT_ID, ADD_EFFECT_ID);
  };
  const state = [inChain ? `effect ${index + 1} of ${count}` : null, silent ? 'not heard' : null, bypass ? 'off' : null].filter(Boolean).join(', ');
  const setBy = controlledSentences(main.controlled);
  const everySetting = () => showInAdvanced(moduleId, toAdvanced);
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
        {spec ? (
          <ParamKnob moduleId={moduleId} param={spec.id} spec={spec} ownerTrackId={trackId} size="md" className={styles.cardKnob} />
        ) : (
          main.macro && <MacroCardKnob control={main.macro} ownerTrackId={trackId} className={styles.cardKnob} />
        )}
        <div className={styles.cardText}>
          <p className={styles.sentence}>{effectSentence(type, spec?.id ?? '')}</p>
          {setBy.length > 0 && (
            <p className={styles.controlled}>
              <Icon name="link" size={12} />
              <span>
                {setBy.join(' ')}
                {!spec && main.macro && ' The knob here turns that big knob.'}
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
          aria-label={`Every setting of ${name} (Advanced)`}
          onClick={everySetting}
          tip={`Show every setting of ${name}. This switches the whole app to Advanced; “Show fewer settings (Simple)” brings this view back.`}
        >
          Every setting
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
      ? `This part has custom cable routing: “${SHOW_EVERY_SETTING}” to place effects with cables.`
      : `This part already has ${PATCH_LIMITS.maxEffectsPerTrack} effects, the most it can hold. Remove one to add another.`;
  const onAdded = (id: Id) =>
    requestAnimationFrame(() => document.getElementById(`simple-card-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  return (
    <Panel
      title="Effects"
      subtitle={<span className={styles.count}>{linear ? effectCount(effects.length) : 'Custom routing'}</span>}
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
            <strong>This part has custom cable routing.</strong> Its effects are listed in patch order; “{SHOW_EVERY_SETTING}” lets you rearrange them with cables.
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
          {offPath.length === 1 ? 'One more effect of this part is' : `${offPath.length} more effects of this part are`} patched outside the chain. “{SHOW_EVERY_SETTING}” shows{' '}
          {offPath.length === 1 ? 'it' : 'them'}.
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
