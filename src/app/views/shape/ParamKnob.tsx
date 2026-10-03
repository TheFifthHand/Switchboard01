/**
 * A knob bound to one patch-module or instrument parameter.
 *
 * - Shows the effective value (after macros).
 * - A parameter moved by a big knob (macro) is read-only: the knob's chain
 *   mark, its teal outer arc over the span the macro sweeps (`macroRange`)
 *   and its tip say which one.
 * - A parameter reached by a modulation cable shows the teal modulation mark.
 * - Double-click (and Delete) return it to the value the part's sound was
 *   designed with (knobHome: a preset's own value, a kit's matched level,
 *   where an added effect starts); Alt+double-click to the plain default.
 * - A control that does nothing until another one is raised (ParamSpec.gate)
 *   is dimmed, and its tip starts with the reason. It still turns.
 * - Right-click, a long press, Shift+F10 or the menu key: Assign to big knob.
 * - Changes go through the session so Record Performance captures them.
 */
import { useId, useMemo, useState } from 'react';
import { Knob, newGestureId, type KnobSize } from '../../../ui/components';
import type { ParamSpec } from '../../../project/params';
import type { Id } from '../../../project/types';
import { shallowEqual } from '../../../state/store';
import { session, useProject } from '../../instance';
import type { MenuAnchor } from '../ClipMenu';
import { AssignMenu } from './AssignMenu';
import { useKnobExtras } from './knobExtras';
import { controllerName, controllingTarget, effectiveValue, gateReason, homeNote, isModulated, knobHome, type KnobHome } from './paramState';
import shared from './shared.module.css';

export interface ParamKnobProps {
  /** Patch module id, e.g. "t3:filter", or "t3:inst" for the instrument. */
  moduleId: Id;
  param: string;
  spec: ParamSpec;
  /** Part whose view shows the knob (names macros of other parts in full). */
  ownerTrackId?: Id;
  /** Set for instrument parameters: changes go through session.setInstrumentParam. */
  instrumentTrackId?: Id;
  size?: KnobSize;
  /** Visible label and accessible name (defaults to the spec label). */
  label?: string;
  tip?: string;
  detail?: string;
  disabled?: boolean;
  className?: string;
  /** Id of the knob's slider (default: a generated one). */
  id?: string;
  /** No Assign to big knob menu. */
  noMenu?: boolean;
}

interface KnobState {
  value: number;
  controlledBy: string | null;
  modulated: boolean;
  home: number;
  homeKind: KnobHome['kind'];
  gate: string | null;
  lo: number | null;
  hi: number | null;
}

export function ParamKnob(props: ParamKnobProps) {
  const { moduleId, param, spec, ownerTrackId, instrumentTrackId, size = 'sm', label, tip, detail, disabled, className, id, noMenu } = props;
  const autoId = useId();
  const sliderId = id ?? `pk${autoId}`;
  const st = useProject<KnobState>((p) => {
    let value = effectiveValue(p, moduleId, param);
    if (value === undefined && instrumentTrackId) value = p.tracks.find((t) => t.id === instrumentTrackId)?.instrument.params[param];
    const target = controllingTarget(p, moduleId, param);
    const h = knobHome(p, moduleId, param, spec);
    return {
      value: value ?? spec.default,
      controlledBy: controllerName(p, moduleId, param, ownerTrackId),
      modulated: isModulated(p, moduleId, param),
      home: h.home,
      homeKind: h.kind,
      gate: gateReason(p, moduleId, spec),
      lo: target ? target.min : null,
      hi: target ? target.max : null,
    };
  }, shallowEqual);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

  const homeSpec = useMemo(() => (st.home === spec.default ? spec : { ...spec, default: st.home }), [spec, st.home]);
  const note = homeNote(spec, { home: st.home, kind: st.homeKind });
  const baseTip = tip ?? spec.tip;
  const shownTip = st.gate ? `${st.gate} ${baseTip}` : baseTip;
  const shownDetail = [detail ?? spec.detail, note].filter(Boolean).join(' ') || undefined;
  const set = (v: number, gesture: string) => {
    if (instrumentTrackId) session.setInstrumentParam(instrumentTrackId, param, v, gesture);
    else session.setModuleParam(moduleId, param, v, gesture);
  };
  const interactive = !disabled && !st.controlledBy;

  useKnobExtras(sliderId, {
    onAltReset: interactive ? () => set(spec.default, newGestureId('knob-reset')) : undefined,
    onMenu: noMenu || disabled ? undefined : setMenu,
  });

  return (
    <>
      <Knob
        id={sliderId}
        spec={homeSpec}
        value={st.value}
        size={size}
        label={label}
        tip={shownTip}
        detail={shownDetail}
        disabled={disabled}
        className={[className, st.gate ? shared.gated : null].filter(Boolean).join(' ') || undefined}
        controlledBy={st.controlledBy ?? undefined}
        macroRange={st.lo !== null && st.hi !== null ? [st.lo, st.hi] : undefined}
        modulated={st.modulated}
        onChange={(v, info) => set(v, info.gesture)}
      />
      {menu && (
        <AssignMenu
          moduleId={moduleId}
          param={param}
          spec={spec}
          ownerTrackId={ownerTrackId}
          anchor={menu}
          returnFocus={document.getElementById(sliderId)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
