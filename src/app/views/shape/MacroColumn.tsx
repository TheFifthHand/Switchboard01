/**
 * MACROS column: the six performance macros of the selected part, each with
 * the list of settings it moves (inspectable and editable).
 *
 * - Knobs change the macro through the session (recorded in performances).
 * - Each mapping shows its target, its range (min → max, editable with small
 *   knobs), the curve, the part of the macro's travel it uses and where the
 *   macro currently puts it. A range edit is committed when the gesture ends
 *   so one drag is one undo step.
 * - Removing a mapping hands the setting back to its own knob.
 */
import { Button, IconButton, Knob, Panel } from '../../../ui/components';
import { moduleId } from '../../../project/factory';
import { PUMP_DIVISIONS, formatParam, type ParamSpec } from '../../../project/params';
import { describeMacro, macroTargetValue } from '../../../project/resolve';
import { MACRO_IDS, type Id, type MacroId, type MacroTarget } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { session, useProject } from '../../instance';
import { MACRO_SPECS } from '../../macros';
import { notify } from '../../runtime';
import { moduleName } from './paramState';
import styles from './MacroColumn.module.css';

/** One-line summary of what each macro is for. */
const MACRO_CAPTION: Record<MacroId, string> = {
  tone: 'Darker ↔ brighter',
  space: 'Room around the sound',
  echo: 'Echoes in time',
  motion: 'Movement with the beat',
  drive: 'Warmth, then grit',
  pump: 'Ducks with the beat',
};

interface Row {
  target: MacroTarget;
  label: string;
  spec?: ParamSpec;
}

function sameRows(a: readonly Row[], b: readonly Row[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((r, i) => r.target === b[i].target && r.label === b[i].label && r.spec === b[i].spec);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function MappingRow(props: { trackId: Id; macro: MacroId; index: number; row: Row; macroValue: number }) {
  const { trackId, macro, index, row, macroValue } = props;
  const { target, label, spec } = row;
  const macroName = MACRO_SPECS[macro].label;
  const from = target.macroFrom ?? 0;
  const to = target.macroTo ?? 1;
  const partial = from !== 0 || to !== 1;
  const now = macroTargetValue(target, macroValue);
  const fmt = (v: number) => (spec ? formatParam(spec, v) : String(Number(v.toFixed(3))));

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
        <span className={`${styles.meta} mono`}>
          <span aria-hidden="true">{target.curve === 'exp' ? 'exp' : 'lin'}</span>
          {partial && (
            <span aria-hidden="true">
              {macroName} {Math.round(from * 100)}–{pct(to)}
            </span>
          )}
          <span className={styles.now} aria-hidden="true">
            now {fmt(now)}
          </span>
          <span className="visually-hidden">
            {`${target.curve === 'exp' ? 'Exponential' : 'Linear'} curve${partial ? `, over ${macroName} ${pct(from)} to ${pct(to)}` : ''}, now ${fmt(now)}.`}
          </span>
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
            detail={`${target.curve === 'exp' ? 'Exponential' : 'Linear'} curve.`}
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
            detail={`${target.curve === 'exp' ? 'Exponential' : 'Linear'} curve.`}
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
      not listen to the drums or any other sound (no audio sidechain). Pump Rate in the channel strip sets how often.
    </p>
  );
}

function MacroCard(props: { trackId: Id; macro: MacroId }) {
  const { trackId, macro } = props;
  const spec = MACRO_SPECS[macro];
  const value = useProject((p) => p.tracks.find((t) => t.id === trackId)?.macros[macro] ?? 0);
  const rows = useProject<Row[]>((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return [];
    // describeMacro gives target + spec; the label is rebuilt with the rack's module names ("LFO Depth", "Drive 2 Mix").
    return describeMacro(p, t, macro).map((d) => {
      const mod = p.patch.modules.find((m) => m.id === d.target.module);
      if (!mod) return d;
      const modName = moduleName(p, mod, trackId);
      const paramName = d.spec?.label ?? d.target.param;
      return { ...d, label: paramName === modName ? `${modName} amount` : `${modName} ${paramName}` };
    });
  }, sameRows);
  return (
    <section className={styles.card} aria-label={`${spec.label} macro`} data-macro={macro}>
      <div className={styles.knobCell}>
        <Knob
          spec={spec}
          value={value}
          size="md"
          id={`shape-macro-${macro}`}
          tip={spec.tip}
          detail={rows.length ? `Moves ${rows.map((r) => r.label).join(', ')}.` : 'This macro has no mappings, so it does nothing.'}
          onChange={(v, info) => session.setMacro(trackId, macro, v, info.gesture)}
        />
      </div>
      <div className={styles.body}>
        <div className={styles.caption}>{MACRO_CAPTION[macro]}</div>
        {rows.length === 0 ? (
          <p className={styles.empty}>No mappings — {spec.label} does nothing. “Reset mappings” restores the sound’s design.</p>
        ) : (
          <div className={styles.rows}>
            {rows.map((row, i) => (
              <MappingRow key={`${row.target.module}.${row.target.param}.${i}`} trackId={trackId} macro={macro} index={i} row={row} macroValue={value} />
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
  const onReset = () => {
    // Same result resetMacroMap would store (the sound's map, minus modules no longer in the patch):
    // when nothing would change, say so instead of adding an empty undo step.
    const p = session.store.getState();
    const t = p.tracks.find((x) => x.id === trackId);
    if (t) {
      const ids = new Set(p.patch.modules.map((m) => m.id));
      const designed = cmd.soundMacroMap(t);
      const same = MACRO_IDS.every((m) => cmd.deepEqual(t.macroMap[m], designed[m].filter((x) => ids.has(x.module))));
      if (same) {
        notify('The macro mappings already match the sound’s design.', 'info');
        return;
      }
    }
    const r = cmd.resetMacroMap(session.store, trackId);
    if (session.accepted(r)) notify('Macro mappings restored to the sound’s design.', 'info', 'undo');
  };
  return (
    <Panel
      title="Macros"
      className={className}
      bodyClassName={styles.scroll}
      dense
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon="undo"
          onClick={onReset}
          tip="Put every macro mapping of this part back the way its sound was designed."
          detail="Mappings on modules that are no longer in the patch are skipped. Undo restores your edits."
        >
          Reset mappings
        </Button>
      }
    >
      <p className={styles.intro}>Each macro turns several settings at once. A setting a macro moves is read-only elsewhere (teal badge) — remove the mapping to set it by hand.</p>
      <div className={styles.cards}>
        {MACRO_IDS.map((m) => (
          <MacroCard key={m} trackId={trackId} macro={m} />
        ))}
      </div>
    </Panel>
  );
}
