/**
 * Shape, Simple mode: the selected part's sound in plain blocks.
 *
 *   [ Instrument card: icon, type, sound, Change instrument ]  [ Effects: one card per effect,   ]
 *   [ Sound: 3–4 knobs for this instrument, Edit sound       ]  [ in signal order; Copy / Paste  ]
 *   [ Big knobs: the six macros, large, with a caption      ]  [ effects, + Add effect         ]
 *
 * Every control edits the real project through the session and commands
 * (the same edits as the Advanced view), so undo, performance recording and
 * the take lock behave exactly as there. Nothing is hidden for good: each
 * effect card opens its every setting in Advanced, Edit sound opens the
 * instrument's, and so does the header.
 *
 * An effect card's knob always changes the sound: it is the effect's main
 * setting, or the big knob that sets it (cardKnob.ts). A big knob whose
 * settings are gone or not heard (macroReach) says "Moves nothing here" and
 * is unavailable; Reset big knobs gives each one back what the part's sound
 * designs it to move.
 *
 * Every part shares one SimpleShape (no remount per part): per-part local
 * state (the sound browser) closes on a part switch.
 */
import { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, Icon, IconButton, Knob, Panel, Switch, newGestureId, type IconName, type KnobSize } from '../../../ui/components';
import { useElementSize } from '../../../ui/hooks/useElementSize';
import { builtinSampleInfo, kitInfo, presetInfo } from '../../../content/catalog';
import { findModule } from '../../../project/graph';
import { PATCH_LIMITS } from '../../../project/modules';
import { specById } from '../../../project/params';
import type { MacroControl } from '../../../project/resolve';
import { MACRO_IDS, type Id, type InstrumentKind, type MacroId, type ModuleType } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { selectModule } from '../../../state/uiStore';
import { session, useProject } from '../../instance';
import { INSTRUMENT_LABEL, soundName } from '../../labels';
import { MACRO_SPECS, macroHomeNote, macroPlainDefault, macroSpecFor } from '../../macros';
import { notify } from '../../runtime';
import { SoundBrowser } from '../SoundBrowser';
import { AddEffectMenu } from './AddEffectMenu';
import { chooseMainKnob, sameMainKnob, type MainKnob } from './cardKnob';
import { effectSentence, knobSays, mainKnobCandidates } from './effectCatalog';
import { EffectsClipboard } from './EffectsClipboard';
import { GrMeter } from './GrMeter';
import { resetBigKnobs } from './bigKnobs';
import { useKnobExtras } from './knobExtras';
import { MACRO_CAPTION, macroDetail, useMacroRows } from './MacroColumn';
import { ParamKnob } from './ParamKnob';
import { moduleName, partKey } from './paramState';
import { setAdvancedTab, useMediaQuery } from './shapeLayout';
import { FlowLine, LockNotice, PathWarning, SHOW_EVERY_SETTING, effectCount, focusLater, onAudiblePath, removedEffectNotice, useAdvancedSwitch, useEditLock, usePartEffects } from './shared';
import { SoundCard } from './SoundCard';
import { SqueezeKnob } from './SqueezeKnob';
import { RecordAudio } from '../sampler/RecordAudio';
import styles from './SimpleShape.module.css';

export const ADD_EFFECT_ID = 'shape-add-effect';
export { chooseMainKnob, resetBigKnobs };

/** Switch to Advanced (with `toAdvanced`, which says so) with one module selected, its card in view and focused. */
export function showInAdvanced(moduleId: Id, toAdvanced: () => void): void {
  selectModule(moduleId);
  setAdvancedTab('effects');
  toAdvanced();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const card = document.getElementById(`rack-card-${moduleId}`);
      card?.scrollIntoView({ block: 'nearest' });
      (document.getElementById(`rack-${moduleId}-name`) as HTMLElement | null)?.focus({ preventScroll: true });
    }),
  );
}

/** Switch to Advanced with the part's instrument column in view (its tab on a short window) and its first control focused. */
export function showInstrumentInAdvanced(toAdvanced: () => void): void {
  setAdvancedTab('instrument');
  toAdvanced();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const col = document.getElementById('shape-col-instrument');
      col?.scrollIntoView({ block: 'nearest' });
      col?.querySelector<HTMLElement>('[role="slider"]:not([aria-disabled="true"]), button:not([disabled])')?.focus({ preventScroll: true });
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
  kitId: string | null;
}

function useInstInfo(trackId: Id): InstInfo | null {
  return useProject<InstInfo | null>((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return null;
    const inst = t.instrument;
    const description =
      inst.kind === 'drums'
        ? (kitInfo(inst.kitId)?.description ?? '')
        : inst.kind === 'sampler'
          ? inst.sampleId
            ? (builtinSampleInfo(inst.sampleId)?.description ?? 'A recording, played at its own pitch.')
            : 'No recording yet: choose one or import your own.'
          : (presetInfo(inst.presetId)?.description ?? '');
    return { kind: inst.kind, sound: soundName(p, inst), description, kitId: inst.kind === 'drums' ? inst.kitId : null };
  }, shallowEqual);
}

function InstrumentCard(props: { trackId: Id; info: InstInfo; children?: ReactNode }) {
  const { trackId, info, children } = props;
  const [open, setOpen] = useState(false);
  const headId = useId();
  // A part switch closes the sound browser (it was opened for the part left).
  useEffect(() => setOpen(false), [trackId]);
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
      {children}
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
/* Big knobs                                                           */
/* ------------------------------------------------------------------ */

interface MacroState {
  value: number;
  home: number;
  inert: boolean;
}

function useMacroState(trackId: Id, macro: MacroId): MacroState {
  return useProject<MacroState>((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    return {
      value: t?.macros[macro] ?? 0,
      home: macroSpecFor(t, macro).default,
      inert: !t || cmd.macroReach(p, trackId, macro) === 'none',
    };
  }, shallowEqual);
}

const MacroTile = memo(function MacroTile(props: { trackId: Id; macro: MacroId; size: KnobSize }) {
  const { trackId, macro, size } = props;
  const base = MACRO_SPECS[macro];
  const st = useMacroState(trackId, macro);
  const rows = useMacroRows(trackId, macro);
  const spec = st.home === base.default ? base : { ...base, default: st.home };
  const id = `shape-macro-${macro}`;
  useKnobExtras(id, { onAltReset: st.inert ? undefined : () => session.setMacro(trackId, macro, macroPlainDefault(macro), newGestureId('knob-reset')) });
  return (
    <div className={styles.macro} role="group" aria-label={`${base.label} big knob`} data-macro={macro} data-inert={st.inert || undefined}>
      <Knob
        spec={spec}
        value={st.value}
        size={size}
        id={id}
        disabled={st.inert}
        tip={st.inert ? `${base.label} moves nothing here: what it moved is gone or not heard. “Reset big knobs” gives it back what this sound is designed to move.` : base.tip}
        detail={[macroDetail(rows), macroHomeNote(macro, st.home)].filter(Boolean).join(' ')}
        onChange={(v, info) => session.setMacro(trackId, macro, v, info.gesture)}
      />
      <div className={styles.macroCaption} data-inert={st.inert || undefined}>
        {st.inert ? 'Moves nothing here' : MACRO_CAPTION[macro]}
      </div>
    </div>
  );
});

/** Big knobs grow to 'xl' when their grid has room for three of that size across and two rows. */
const XL_MIN_WIDTH = 3 * 120 + 2 * 8;
const XL_MIN_HEIGHT = 2 * 178 + 10;

function MacroPanel(props: { trackId: Id }) {
  const { trackId } = props;
  const gridRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(gridRef);
  const locked = useEditLock() !== null;
  const xl = size.width >= XL_MIN_WIDTH && size.height >= XL_MIN_HEIGHT;
  return (
    <Panel
      title="Big knobs"
      subtitle={<span className={styles.panelNote}>Each turns several settings at once</span>}
      dense
      className={styles.macroPanel}
      bodyClassName={styles.macroBody}
      actions={
        <Button
          id="simple-reset-big-knobs"
          size="sm"
          variant="ghost"
          icon="undo"
          disabled={locked}
          onClick={() => resetBigKnobs(trackId)}
          tip={locked ? 'Big knob assignments cannot change while a performance records.' : 'Give every big knob back what this sound is designed to move (after effects were removed or mappings changed).'}
          detail="Where each knob sits stays as it is; double-click a big knob to return it to this sound’s position. Undo brings your mappings back."
        >
          Reset big knobs
        </Button>
      }
    >
      <div ref={gridRef} className={styles.macros} data-xl={xl || undefined}>
        {MACRO_IDS.map((m) => (
          <MacroTile key={m} trackId={trackId} macro={m} size={xl ? 'xl' : 'lg'} />
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

/** The knob of the big knob (macro) that sets an effect's main setting: turning it here turns that big knob. */
function MacroCardKnob(props: { control: MacroControl; ownerTrackId: Id; id: string; className?: string }) {
  const { control, ownerTrackId, id, className } = props;
  const base = MACRO_SPECS[control.macro];
  const st = useMacroState(control.trackId, control.macro);
  const otherPart = useProject((p) => (control.trackId === ownerTrackId ? null : (p.tracks.find((t) => t.id === control.trackId)?.name ?? null)));
  const name = otherPart ? `${otherPart} ${base.label}` : base.label;
  const rows = useMacroRows(control.trackId, control.macro);
  const spec = st.home === base.default ? base : { ...base, default: st.home };
  useKnobExtras(id, { onAltReset: () => session.setMacro(control.trackId, control.macro, macroPlainDefault(control.macro), newGestureId('knob-reset')) });
  return (
    <Knob
      id={id}
      spec={spec}
      value={st.value}
      size="md"
      label={name}
      tip={`This is the ${name} big knob (${MACRO_CAPTION[control.macro].toLowerCase()}): turning it here turns it in Big knobs too.`}
      detail={[macroDetail(rows), macroHomeNote(control.macro, st.home)].filter(Boolean).join(' ')}
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
  const remove = () => {
    const r = cmd.removeEffect(session.store, moduleId);
    if (!session.accepted(r)) return;
    notify(removedEffectNotice(name, silent, r.affectedMacros ?? []), 'info', 'undo');
    focusLater(next ? `simple-${next}-onoff` : ADD_EFFECT_ID, ADD_EFFECT_ID);
  };
  const state = [inChain ? `effect ${index + 1} of ${count}` : null, silent ? 'not heard' : null, bypass ? 'off' : null].filter(Boolean).join(', ');
  const everySetting = () => showInAdvanced(moduleId, toAdvanced);
  const knobId = `simple-${moduleId}-knob`;
  const specs = mainKnobCandidates(type);
  const own = main.macro || main.param === 'squeeze' ? null : (specById(specs, main.param) ?? null);
  const resonance = main.extra ? specById(specs, main.extra) : undefined;
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
        <div className={styles.cardKnobs}>
          {main.macro ? (
            <MacroCardKnob control={main.macro} ownerTrackId={trackId} id={knobId} className={styles.cardKnob} />
          ) : main.param === 'squeeze' ? (
            <SqueezeKnob moduleId={moduleId} trackId={trackId} id={knobId} className={styles.cardKnob} />
          ) : own ? (
            <ParamKnob id={knobId} moduleId={moduleId} param={own.id} spec={own} ownerTrackId={trackId} size="md" className={styles.cardKnob} />
          ) : null}
          {resonance && (
            <ParamKnob id={`simple-${moduleId}-resonance`} moduleId={moduleId} param={resonance.id} spec={resonance} ownerTrackId={trackId} size="md" className={styles.cardKnob} />
          )}
        </div>
        <div className={styles.cardText}>
          <p className={styles.sentence}>{effectSentence(type, main.param)}</p>
          {main.macro && main.by && (
            <p className={styles.controlled}>
              <Icon name="link" size={12} />
              <span>
                {specById(specs, main.param)?.label ?? main.param} is set by the {main.by} big knob: the knob here turns it.
              </span>
            </p>
          )}
          {type === 'filter' && <p className={styles.extraNote}>{resonance ? knobSays(type, 'resonance') : 'Resonance appears once the filter closes below 12 kHz.'}</p>}
          {silent && <p className={styles.notHeard}>Not heard: no path from the instrument to the output.</p>}
        </div>
      </div>
      {(type === 'compressor' || type === 'gate') && <GrMeter moduleId={moduleId} kind={type} name={name} className={styles.gr} />}
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
      actions={
        <span className={styles.fxActions}>
          <EffectsClipboard trackId={trackId} size="sm" idPrefix="simple" />
          <AddEffectMenu id={ADD_EFFECT_ID} trackId={trackId} size="md" className={styles.big} disabled={addDisabled} disabledReason={reason} onAdded={onAdded} />
        </span>
      }
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
            <div key={partKey(id)} role="listitem" className={styles.cardCell}>
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
  const info = useInstInfo(trackId);
  const { toAdvanced } = useAdvancedSwitch();
  // Room for medium Sound knobs on a tall window; small ones keep 1366 × 768 free of scrolling.
  const tall = useMediaQuery('(min-height: 900px)');
  return (
    <div className={styles.simple}>
      <div className={styles.left}>
        {info && (
          <InstrumentCard trackId={trackId} info={info}>
            <SoundCard trackId={trackId} kind={info.kind} kitId={info.kitId ?? undefined} size={tall ? 'md' : 'sm'} onEditSound={() => showInstrumentInAdvanced(toAdvanced)} />
          </InstrumentCard>
        )}
        <MacroPanel trackId={trackId} />
      </div>
      <EffectsPanel trackId={trackId} className={styles.fxPanel} />
    </div>
  );
}
