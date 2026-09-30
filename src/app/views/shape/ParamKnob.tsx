/**
 * A knob bound to one patch-module or instrument parameter.
 *
 * - Shows the effective value (after macros).
 * - A parameter moved by a macro is read-only and badged with the macro name.
 * - A parameter reached by a modulation cable shows the teal modulation mark.
 * - Changes go through the session so Record Performance captures them.
 */
import { Knob, type KnobSize } from '../../../ui/components';
import type { ParamSpec } from '../../../project/params';
import type { Id } from '../../../project/types';
import { session, useProject } from '../../instance';
import { controllerName, effectiveValue, isModulated } from './paramState';

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
}

export function ParamKnob(props: ParamKnobProps) {
  const { moduleId, param, spec, ownerTrackId, instrumentTrackId, size = 'sm', label, tip, detail, disabled, className } = props;
  const value = useProject((p) => {
    const v = effectiveValue(p, moduleId, param);
    if (v !== undefined) return v;
    if (instrumentTrackId) {
      const stored = p.tracks.find((t) => t.id === instrumentTrackId)?.instrument.params[param];
      if (stored !== undefined) return stored;
    }
    return spec.default;
  });
  const controlledBy = useProject((p) => controllerName(p, moduleId, param, ownerTrackId));
  const modulated = useProject((p) => isModulated(p, moduleId, param));
  return (
    <Knob
      spec={spec}
      value={value}
      size={size}
      label={label}
      tip={tip}
      detail={detail}
      disabled={disabled}
      className={className}
      controlledBy={controlledBy ?? undefined}
      modulated={modulated}
      onChange={(v, info) => {
        if (instrumentTrackId) session.setInstrumentParam(instrumentTrackId, param, v, info.gesture);
        else session.setModuleParam(moduleId, param, v, info.gesture);
      }}
    />
  );
}
