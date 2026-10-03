/**
 * The Simple Compressor card's knob: Squeeze (see squeeze.ts). One amount
 * that writes Threshold, ratio, Makeup and Attack together, in one gesture
 * (one undo step), through the session so performance takes record each of them.
 * Shows the amount the compressor's threshold stands for now.
 */
import { Knob, newGestureId } from '../../../ui/components';
import type { Id } from '../../../project/types';
import { shallowEqual } from '../../../state/store';
import { session, useProject } from '../../instance';
import { useKnobExtras } from './knobExtras';
import { controllerName, derived } from './paramState';
import { SQUEEZE_SPEC, squeezeOf, squeezeParams } from './squeeze';

export function SqueezeKnob(props: { moduleId: Id; trackId: Id; id: string; className?: string }) {
  const { moduleId, trackId, id, className } = props;
  const st = useProject(
    (p) => ({
      value: squeezeOf(derived(p).resolved.get(moduleId)),
      by: controllerName(p, moduleId, 'threshold', trackId) ?? controllerName(p, moduleId, 'ratio', trackId) ?? controllerName(p, moduleId, 'makeup', trackId),
    }),
    shallowEqual,
  );
  const set = (amount: number, gesture: string) => {
    const s = squeezeParams(amount);
    session.setModuleParam(moduleId, 'threshold', s.threshold, gesture);
    session.setModuleParam(moduleId, 'ratio', s.ratio, gesture);
    session.setModuleParam(moduleId, 'makeup', s.makeup, gesture);
    session.setModuleParam(moduleId, 'attack', s.attack, gesture);
  };
  useKnobExtras(id, { onAltReset: st.by ? undefined : () => set(SQUEEZE_SPEC.default, newGestureId('knob-reset')) });
  return (
    <Knob
      id={id}
      spec={SQUEEZE_SPEC}
      value={st.value}
      size="md"
      className={className}
      controlledBy={st.by ?? undefined}
      onChange={(v, info) => set(v, info.gesture)}
    />
  );
}
