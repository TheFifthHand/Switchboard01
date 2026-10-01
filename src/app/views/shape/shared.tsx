/**
 * Pieces shared by the Simple and Advanced Shape views: the part's effect
 * list (chain order), the signal-flow line, the no-path warning with Restore
 * Connection, the recording lock notice, and the switch to Advanced with the
 * toast that says so.
 */
import { useCallback } from 'react';
import { Notice, useToasts, type ToastApi } from '../../../ui/components';
import { MASTER_ID, moduleId as mid } from '../../../project/factory';
import { connectionKind, findModule, trackChain } from '../../../project/graph';
import { MODULE_DEFS, PATCH_LIMITS } from '../../../project/modules';
import type { Id, Patch } from '../../../project/types';
import { useStore } from '../../../state/store';
import { setUiMode } from '../../../state/uiStore';
import { session, useProject } from '../../instance';
import { notify } from '../../runtime';
import { samePlan, type RepairPlan } from '../cables/model';
import { repairCableName, restoreConnection as restoreFor, restorePlanFor } from '../cables/restore';
import { moduleName, sameItems } from './paramState';
import styles from './shared.module.css';

/** The Shape view's names for the two modes, used on every button that switches between them. */
export const SHOW_EVERY_SETTING = 'Show every setting (Advanced)';
export const SHOW_FEWER_SETTINGS = 'Show fewer settings (Simple)';
export const ADVANCED_TOAST_ID = 'shape-advanced';
export const ADVANCED_TOAST_TEXT = 'Now showing every setting (Advanced), in every view. Back to Simple brings back the short view.';

/** The app's toasts; null where no ToastProvider is mounted (a view rendered on its own). */
function useToastsIfAny(): ToastApi | null {
  try {
    return useToasts();
  } catch {
    return null;
  }
}

/**
 * Switching to Advanced from Shape changes the whole app, so it says so in a
 * toast with "Back to Simple". Returns the switch, and a way to take that toast away.
 */
export function useAdvancedSwitch(): { toAdvanced(): void; dismiss(): void } {
  const toasts = useToastsIfAny();
  const toAdvanced = useCallback(() => {
    setUiMode('advanced');
    toasts?.show({
      id: ADVANCED_TOAST_ID,
      tone: 'info',
      message: ADVANCED_TOAST_TEXT,
      action: {
        label: 'Back to Simple',
        onAction: () => {
          setUiMode('simple');
          focusLater('shape-mode-toggle');
        },
      },
    });
  }, [toasts]);
  const dismiss = useCallback(() => toasts?.dismiss(ADVANCED_TOAST_ID), [toasts]);
  return { toAdvanced, dismiss };
}

/** "2 effects (up to 6)": how many effects the part has, and how many it can hold. */
export function effectCount(n: number): string {
  const most = PATCH_LIMITS.maxEffectsPerTrack;
  return n === 0 ? `None yet (up to ${most})` : `${n} effect${n === 1 ? '' : 's'} (up to ${most})`;
}

/** Focus an element once the DOM has caught up (a moved or new card), or a fallback. */
export const focusLater = (id: string, fallback?: string) =>
  requestAnimationFrame(() => {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el && !el.disabled) el.focus();
    else if (fallback) (document.getElementById(fallback) as HTMLElement | null)?.focus();
  });

/** True when an audio path runs from the part's instrument through `id` to the master output. */
export function onAudiblePath(patch: Patch, trackId: Id, id: Id): boolean {
  const audio = patch.connections.filter((c) => connectionKind(patch, c) === 'audio');
  const walk = (start: Id, forward: boolean): Set<Id> => {
    const seen = new Set<Id>([start]);
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const c of audio) {
        const [a, b] = forward ? [c.from.module, c.to.module] : [c.to.module, c.from.module];
        if (a === cur && !seen.has(b)) {
          seen.add(b);
          stack.push(b);
        }
      }
    }
    return seen;
  };
  return walk(mid.inst(trackId), true).has(id) && walk(MASTER_ID, false).has(id);
}

export interface PartEffects {
  /** Instrument → effects → channel, or null when the routing is not a simple chain. */
  chain: Id[] | null;
  /** The part's insert effects: in signal order for a chain, otherwise in patch order. */
  effects: Id[];
  /** Effects of this part that its chain does not pass through. */
  offPath: Id[];
}

/** The part's effects as the rack lists them. */
export function usePartEffects(trackId: Id): PartEffects {
  const chain = useProject((p) => trackChain(p.patch, trackId), sameItems);
  const partEffects = useProject<Id[]>((p) => p.patch.modules.filter((m) => m.trackId === trackId && MODULE_DEFS[m.type].family === 'effect').map((m) => m.id), sameItems);
  const effects = chain ? chain.slice(1, -1) : partEffects;
  const offPath = chain ? partEffects.filter((id) => !chain.includes(id)) : [];
  return { chain, effects, offPath };
}

/** The edit lock's reason while a performance take records (routing edits are refused), or null. */
export function useEditLock(): string | null {
  return useStore(session.store.info, (s) => s.lock);
}

/** Says why effects cannot be added, moved, switched or removed right now; knobs keep working. */
export function LockNotice(props: { lock: string | null }) {
  if (!props.lock) return null;
  return (
    <Notice tone="info" title="Effects are locked while a performance records.">
      {props.lock}
    </Notice>
  );
}

/** Instrument → … → Master, with bypassed effects marked "off" in words. */
export function FlowLine(props: { trackId: Id; chain: readonly Id[] }) {
  const { trackId, chain } = props;
  const names = useProject<string[]>(
    (p) => chain.map((id) => (id === mid.inst(trackId) ? 'Instrument' : id === mid.channel(trackId) ? 'Channel' : moduleName(p, findModule(p.patch, id), trackId))),
    sameItems,
  );
  const off = useProject<boolean[]>((p) => chain.map((id) => findModule(p.patch, id)?.bypass ?? false), sameItems);
  const steps = [...names.map((name, i) => ({ name, off: off[i] ?? false, end: i === 0 || i === names.length - 1 })), { name: 'Master', off: false, end: true }];
  return (
    <ol className={styles.flow} aria-label="Signal flow">
      {steps.map((step, i) => (
        <li key={i} className={styles.flowItem}>
          {i > 0 && (
            <span className={styles.flowArrow} aria-hidden="true">
              →
            </span>
          )}
          <span className={styles.flowChip} data-end={step.end || undefined} data-off={step.off || undefined}>
            <span className={styles.flowName}>{step.name}</span>
            {step.off && <span className={styles.flowOff}> off</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

interface RepairInfo {
  plan: RepairPlan;
  cable: string;
}

const sameRepair = (a: RepairInfo | null, b: RepairInfo | null) => a === b || (!!a && !!b && samePlan(a.plan, b.plan) && a.cable === b.cable);

/** "This part has no path to the output", with the same Restore Connection as the cable panel. */
export function PathWarning(props: { trackId: Id }) {
  const { trackId } = props;
  // What Restore Connection would do (null while the part is heard), and the cable it would add.
  const repair = useProject<RepairInfo | null>((p) => {
    const plan = restorePlanFor(p, trackId);
    return plan && { plan, cable: plan.kind === 'connect' ? repairCableName(p, plan, trackId) : '' };
  }, sameRepair);
  if (!repair) return null;
  const restoreConnection = () => {
    const out = restoreFor(trackId);
    if (!out.changed) return;
    notify(out.plan.kind === 'connect' ? `Connected ${out.cable}: this part is heard again.` : 'Restored this part’s default cables, so it reaches the output again.', 'info', 'undo');
  };
  return (
    <Notice tone="warning" title="This part has no path to the output." action={{ label: 'Restore Connection', onAction: restoreConnection }}>
      Its sound never reaches the master, so you will not hear it.{' '}
      {repair.plan.kind === 'connect'
        ? `Restore Connection plugs in ${repair.cable}; everything else stays as you patched it.`
        : 'No single cable can reconnect it, so Restore Connection puts its default cables back: effects and LFOs you added to it, and its cables to other parts, are removed. Undo brings them back.'}
    </Notice>
  );
}
