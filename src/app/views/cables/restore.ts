/**
 * Restore Connection, shared by the cable panel and the Shape view's effects
 * rack so the same button does the same thing in both: plug back the one
 * cable that makes a silent part heard again, and only when no single cable
 * can do that, put the part's default cables back (which removes effects,
 * LFOs and cables to other parts that were added to it). Either way it is
 * one undo step.
 */
import { describePathProblem } from '../../../project/graph';
import type { Id, Project } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { session } from '../../instance';
import { notify } from '../../runtime';
import { cableName, moduleInfos, repairPlan, type RepairPlan } from './model';

/** What Restore Connection would do for a part, or null while the part is heard. */
export function restorePlanFor(p: Project, trackId: Id): RepairPlan | null {
  return describePathProblem(p.patch, trackId) ? repairPlan(p.patch, trackId) : null;
}

/** The cable a 'connect' repair adds, named as the cable panel names it ("Drive Out → Filter In"). */
export function repairCableName(p: Project, plan: Extract<RepairPlan, { kind: 'connect' }>, trackId: Id): string {
  return cableName(moduleInfos(p.patch), plan, p.tracks.map((t) => ({ id: t.id, name: t.name })), trackId);
}

export interface RestoreOutcome {
  plan: RepairPlan;
  /** True when the patch changed (one undo step). */
  changed: boolean;
  /** Name of the cable added (a 'connect' repair). */
  cable: string | null;
}

/**
 * Run Restore Connection for a part. A refusal (the take lock, a patch
 * limit) is shown as a warning, like any other refused edit.
 */
export function restoreConnection(trackId: Id): RestoreOutcome {
  const p = session.store.getState();
  const plan = repairPlan(p.patch, trackId);
  if (plan.kind === 'connect') {
    const cable = repairCableName(p, plan, trackId);
    const r = cmd.connect(session.store, plan.from, plan.to);
    if (!r.ok) notify(r.message, 'warn');
    return { plan, changed: r.ok, cable };
  }
  return { plan, changed: session.accepted(cmd.restoreTrackPatch(session.store, trackId)), cable: null };
}
