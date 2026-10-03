/**
 * MACROS column: the six performance macros of the selected part, each with
 * the list of settings it moves (inspectable and editable).
 *
 * - Knobs change the macro through the session (recorded in performances).
 * - Each mapping shows its target, its range (min → max, editable with small
 *   knobs), its curve in words ("curve: gentle" / "curve: even", a key that
 *   switches it), the part of the macro's travel it uses ("over Tone
 *   [60]–[100] %", typed, dragged or stepped with the arrow keys) and where
 *   the macro puts it now. One drag or key burst is one undo step.
 * - Removing a mapping hands the setting back to its own knob. Any knob's
 *   menu (right-click, long press, Shift+F10) assigns it to a big knob.
 */
import { Button, IconButton, Knob, NumberField, Panel, newGestureId } from '../../../ui/components';
import { moduleId } from '../../../project/factory';
import { PUMP_DIVISIONS, formatParam, type ParamSpec } from '../../../project/params';
import { describeMacro, macroTargetValue } from '../../../project/resolve';
import { MACRO_IDS, type Id, type MacroId, type MacroTarget } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { session, useProject } from '../../instance';
import { MACRO_CAPTION, MACRO_SPECS, macroHomeNote, macroPlainDefault, macroSpecFor } from '../../macros';
import { notify } from '../../runtime';
import { shallowEqual } from '../../../state/store';
import { resetBigKnobs } from './bigKnobs';
import { useKnobExtras } from './knobExtras';
import { curveWord, mappingWords, rangeWords } from './macroAssign';
import { moduleName, partKey } from './paramState';
import styles from './MacroColumn.module.css';

/** One-line summary of what each macro is for. */
export { MACRO_CAPTION };

export interface MacroRow {
  target: MacroTarget;
  label: string;
  spec?: ParamSpec;
}
type Row = MacroRow;

function sameRows(a: readonly Row[], b: readonly Row[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((r, i) => r.target === b[i].target && r.label === b[i].label && r.spec === b[i].spec);
}

/** The settings a macro of a part moves, named as the rack names them ("Filter Cutoff", "Drive 2 Mix"). */
export function useMacroRows(trackId: Id, macro: MacroId): MacroRow[] {
  return useProject<Row[]>((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return [];
    return describeMacro(p, t, macro).map((d) => {
      const mod = p.patch.modules.find((m) => m.id === d.target.module);
      if (!mod) return d;
      const modName = moduleName(p, mod, trackId);
      const paramName = d.spec?.label ?? d.target.param;
      return { ...d, label: paramName === modName ? `${modName} amount` : `${modName} ${paramName}` };
    });
  }, sameRows);
}

/** The macro knob's technical detail: what it moves, or that it does nothing. */
export function macroDetail(rows: readonly MacroRow[]): string {
  return rows.length ? `Moves ${rows.map((r) => r.label).join(', ')}.` : 'This macro has no mappings, so it does nothing.';
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
/** The smallest part of a big knob's travel a mapping can use. */
const MIN_SPAN = 0.05;

/** A mapping's curve as a key: "curve: gentle" / "curve: even"; a press switches it (one undo step). */
function CurveToggle(props: { target: MacroTarget; label: string; onSet(curve: MacroTarget['curve']): void }) {
  const { target, label, onSet } = props;
  const now = curveWord(target.curve);
  const next: MacroTarget['curve'] = target.curve === 'exp' ? 'lin' : 'exp';
  const blocked = next === 'exp' && !(target.min > 0 && target.max > 0);
  return (
    <Button
      size="sm"
      variant="ghost"
      className={styles.curve}
      disabled={blocked}
      aria-label={`${label} curve: ${now}. Switch to ${curveWord(next)}`}
      onClick={() => onSet(next)}
      tip={
        blocked
          ? 'Gentle needs a range that stays above zero.'
          : target.curve === 'exp'
            ? 'Gentle: equal steps in pitch or time across the big knob’s travel (best for frequencies and times). Press for even.'
            : 'Even: equal steps in the setting’s own units. Press for gentle (equal steps in pitch or time).'
      }
    >
      curve: {now}
    </Button>
  );
}

/** "over Tone [60]–[100] %": the part of the big knob's travel the mapping uses; typed, dragged or stepped with the arrow keys. */
function TravelRange(props: { macroName: string; label: string; from: number; to: number; onSet(part: Partial<MacroTarget>, gesture: string): void }) {
  const { macroName, label, from, to, onSet } = props;
  return (
    <span className={styles.travel} role="group" aria-label={`${label}: part of ${macroName}’s travel`}>
      <span aria-hidden="true">over {macroName}</span>
      <NumberField
        label={`${label}: from ${macroName} at`}
        hideLabel
        layout="inline"
        size="sm"
        chars={3}
        min={0}
        max={100}
        step={5}
        fineStep={1}
        unit="%"
        value={Math.round(from * 100)}
        className={styles.travelField}
        tip={`Where on ${macroName}’s travel this setting starts to move.`}
        onChange={(v, info) => onSet({ macroFrom: Math.min(v / 100, to - MIN_SPAN) }, info.gesture)}
      />
      <span aria-hidden="true">–</span>
      <NumberField
        label={`${label}: to ${macroName} at`}
        hideLabel
        layout="inline"
        size="sm"
        chars={3}
        min={0}
        max={100}
        step={5}
        fineStep={1}
        unit="%"
        value={Math.round(to * 100)}
        className={styles.travelField}
        tip={`Where on ${macroName}’s travel this setting stops moving.`}
        onChange={(v, info) => onSet({ macroTo: Math.max(v / 100, from + MIN_SPAN) }, info.gesture)}
      />
    </span>
  );
}

function MappingRow(props: { trackId: Id; macro: MacroId; index: number; row: Row; macroValue: number }) {
  const { trackId, macro, index, row, macroValue } = props;
  const { target, label, spec } = row;
  const macroName = MACRO_SPECS[macro].label;
  const from = target.macroFrom ?? 0;
  const to = target.macroTo ?? 1;
  const now = macroTargetValue(target, macroValue);
  const fmt = (v: number) => (spec ? formatParam(spec, v) : String(Number(v.toFixed(3))));
  const words = mappingWords(macroName, target, fmt(now));

  const commit = (partialTarget: Partial<MacroTarget>, gesture?: string) => {
    session.accepted(cmd.setMacroTarget(session.store, trackId, macro, index, partialTarget, gesture));
  };
  const remove = () => {
    const r = cmd.removeMacroTarget(session.store, trackId, macro, index);
    if (session.accepted(r)) notify(`${macroName} no longer moves ${label}. Its own knob sets it now.`, 'info', 'undo');
  };

  return (
    <div className={styles.row} role="group" aria-label={`${macroName} moves ${label}`}>
      <div className={styles.info}>
        <span className={styles.target}>{label}</span>
        <span className={styles.meta}>
          <CurveToggle target={target} label={label} onSet={(curve) => commit({ curve })} />
          <TravelRange macroName={macroName} label={label} from={from} to={to} onSet={commit} />
          <span className={styles.now} aria-hidden="true">
            {words.now}
          </span>
          <span className="visually-hidden">{`${words.curve}, ${words.over ?? `over all of ${macroName}`}, ${rangeWords(spec, target)}, ${words.now}.`}</span>
        </span>
      </div>
      {spec ? (
        <div className={styles.range}>
          <Knob
            className={styles.mini}
            spec={spec}
            value={target.min}
            size="sm"
            label={`${label} min`}
            tip={`${label} when ${macroName} is at ${pct(from)}.`}
            detail={`${words.curve}.`}
            onChange={(v, info) => commit({ min: v }, info.gesture)}
          />
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
          <Knob
            className={styles.mini}
            spec={spec}
            value={target.max}
            size="sm"
            label={`${label} max`}
            tip={`${label} when ${macroName} is at ${pct(to)}.`}
            detail={`${words.curve}.`}
            onChange={(v, info) => commit({ max: v }, info.gesture)}
          />
        </div>
      ) : (
        <div className={`${styles.range} ${styles.rangeText} mono`}>
          {fmt(target.min)} → {fmt(target.max)}
        </div>
      )}
      <IconButton
        icon="close"
        size="sm"
        className={styles.remove}
        label={`Remove ${label} from ${macroName}`}
        tip={`${macroName} stops moving ${label}; its own knob sets it again. Undo brings the mapping back.`}
        onClick={remove}
      />
    </div>
  );
}

function PumpNote(props: { trackId: Id }) {
  const div = useProject((p) => p.patch.modules.find((m) => m.id === moduleId.channel(props.trackId))?.params.pumpDiv ?? 0);
  const rate = PUMP_DIVISIONS[Math.round(div)] ?? PUMP_DIVISIONS[0];
  return (
    <p className={styles.note}>
      <strong>How Pump works:</strong> a tempo-synchronized ducking envelope. While the transport plays, the part’s volume dips at every {rate} note and swells back, locked to the beat grid. It does
      not listen to the drums or any other sound (no audio sidechain). Pump Speed in the channel strip sets how often.
    </p>
  );
}

function MacroCard(props: { trackId: Id; macro: MacroId }) {
  const { trackId, macro } = props;
  const base = MACRO_SPECS[macro];
  const st = useProject(
    (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      return { value: t?.macros[macro] ?? 0, home: macroSpecFor(t, macro).default, inert: cmd.macroReach(p, trackId, macro) === 'none' };
    },
    shallowEqual,
  );
  const rows = useMacroRows(trackId, macro);
  const spec = st.home === base.default ? base : { ...base, default: st.home };
  const id = `shape-macro-${macro}`;
  useKnobExtras(id, { onAltReset: st.inert ? undefined : () => session.setMacro(trackId, macro, macroPlainDefault(macro), newGestureId('knob-reset')) });
  const value = st.value;
  return (
    <section className={styles.card} aria-label={`${base.label} macro`} data-macro={macro}>
      <div className={styles.knobCell}>
        <Knob
          spec={spec}
          value={value}
          size="md"
          id={id}
          disabled={st.inert}
          tip={st.inert ? `${base.label} moves nothing heard here. “Reset mappings” restores what this sound’s design moves.` : base.tip}
          detail={[macroDetail(rows), macroHomeNote(macro, st.home)].filter(Boolean).join(' ')}
          onChange={(v, info) => session.setMacro(trackId, macro, v, info.gesture)}
        />
      </div>
      <div className={styles.body}>
        <div className={styles.caption}>{st.inert && rows.length > 0 ? 'Moves nothing here' : MACRO_CAPTION[macro]}</div>
        {st.inert && rows.length > 0 && <p className={styles.empty}>What {base.label} moves is not heard: an effect it moved was removed, or an LFO it moves has no cable.</p>}
        {rows.length === 0 ? (
          <p className={styles.empty}>No mappings: {spec.label} does nothing. “Reset mappings” restores the sound’s design, or right-click any knob to give it to {spec.label}.</p>
        ) : (
          <div className={styles.rows}>
            {rows.map((row, i) => (
              <MappingRow key={`${partKey(row.target.module)}.${row.target.param}.${i}`} trackId={trackId} macro={macro} index={i} row={row} macroValue={value} />
            ))}
          </div>
        )}
        {macro === 'pump' && <PumpNote trackId={trackId} />}
      </div>
    </section>
  );
}

export function MacroColumn(props: { trackId: Id; className?: string }) {
  const { trackId, className } = props;
  const onReset = () => resetBigKnobs(trackId);
  return (
    <Panel
      title="Macros (big knobs)"
      className={className}
      bodyClassName={styles.scroll}
      dense
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon="undo"
          onClick={onReset}
          tip="Put every macro mapping of this part back the way its sound was designed (and the LFO's cable to the filter, when a removed filter took it)."
          detail="Mappings on modules that are no longer in the patch are skipped. Undo restores your edits."
        >
          Reset mappings
        </Button>
      }
    >
      {/* A "Try this" chip may sit over this explanation (data-hint-home): the controls around it stay clear. */}
      <p className={styles.intro} data-hint-home="">
        Each macro turns several settings at once. A setting a macro moves is read-only elsewhere: its knob shows a chain mark and a teal arc over the span the macro sweeps. Remove the mapping to set it by hand;
        right-click any knob (or press Shift+F10 on it) to give it to a big knob.
      </p>
      <div className={styles.cards}>
        {MACRO_IDS.map((m) => (
          <MacroCard key={m} trackId={trackId} macro={m} />
        ))}
      </div>
    </Panel>
  );
}
