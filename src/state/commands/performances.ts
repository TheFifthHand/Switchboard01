/** Recorded performances (takes): add, rename, delete, edit events, trim. */
import type { Id, Performance, PerformanceEvent } from '../../project/types';
import { VALIDATION_LIMITS, validatePerformance } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, cleanName, isFiniteNumber, refuse, run, type CommandResult } from './common';

/** Add a recorded take. It is validated (and copied) first; a take that cannot replay is refused. */
export function addPerformance(store: ProjectStore, perf: Performance): CommandResult & { performanceId?: Id; warnings?: string[] } {
  const p = store.getState();
  if (p.performances.length >= VALIDATION_LIMITS.maxPerformances) return refuse('limit', 'This project already holds as many recorded performances as it can. Delete one first.');
  const { performance, warnings } = validatePerformance(perf, p);
  if (!performance) return { ...refuse('invalid', 'The recording could not be kept because it is incomplete.'), warnings };
  if (p.performances.some((x) => x.id === performance.id)) return refuse('occupied', 'This performance is already saved.');
  const r = run(store, 'performance:Save performance', (d) => {
    d.performances.push(performance);
  });
  return { ...r, performanceId: performance.id, warnings };
}

export function renamePerformance(store: ProjectStore, perfId: Id, name: string): CommandResult {
  if (!store.getState().performances.some((x) => x.id === perfId)) return NOT_FOUND('performance');
  const n = cleanName(name, 80);
  if (!n) return refuse('invalid', 'A performance needs a name.');
  return run(store, 'performance:Rename performance', (d) => {
    const x = d.performances.find((q) => q.id === perfId);
    if (x) x.name = n;
  });
}

export function deletePerformance(store: ProjectStore, perfId: Id): CommandResult {
  if (!store.getState().performances.some((x) => x.id === perfId)) return NOT_FOUND('performance');
  return run(store, 'performance:Delete performance', (d) => {
    d.performances = d.performances.filter((x) => x.id !== perfId);
  });
}

/**
 * Indices that must be removed together with event `index`. Replay pairs a
 * noteOn with the next noteOff of the same part and key (a new noteOn on that
 * key also ends it), so a played note is deleted as a unit: removing only its
 * noteOff would leave it sounding until the end of the take.
 */
export function performanceEventGroup(events: readonly PerformanceEvent[], index: number): number[] {
  const e = events[index];
  if (!e || (e.type !== 'noteOn' && e.type !== 'noteOff')) return [index];
  const sameKey = (x: PerformanceEvent) => (x.type === 'noteOn' || x.type === 'noteOff') && x.trackId === e.trackId && x.key === e.key;
  if (e.type === 'noteOn') {
    for (let i = index + 1; i < events.length; i++) {
      if (sameKey(events[i])) return events[i].type === 'noteOff' ? [index, i] : [index];
    }
  } else {
    for (let i = index - 1; i >= 0; i--) {
      if (sameKey(events[i])) return events[i].type === 'noteOn' ? [i, index] : [index];
    }
  }
  return [index];
}

/** Remove one event from a take (for editing a recorded sequence); a note's on/off pair goes together. */
export function deletePerformanceEvent(store: ProjectStore, perfId: Id, index: number): CommandResult {
  const perf = store.getState().performances.find((x) => x.id === perfId);
  if (!perf) return NOT_FOUND('performance');
  if (!Number.isInteger(index) || index < 0 || index >= perf.events.length) return refuse('invalid', 'That event does not exist.');
  const remove = performanceEventGroup(perf.events, index);
  return run(store, remove.length > 1 ? 'performance:Delete note' : 'performance:Delete event', (d) => {
    const events = d.performances.find((x) => x.id === perfId)?.events;
    if (!events) return;
    for (const i of [...remove].sort((a, b) => b - a)) events.splice(i, 1);
  });
}

/**
 * Shorten a take so it ends at `endTick` (events after it are removed). Only
 * the end can be trimmed: the start is tied to the captured snapshot.
 */
export function trimPerformance(store: ProjectStore, perfId: Id, endTick: number): CommandResult {
  const perf = store.getState().performances.find((x) => x.id === perfId);
  if (!perf) return NOT_FOUND('performance');
  if (!isFiniteNumber(endTick) || endTick <= perf.startTick) return refuse('invalid', 'The end must be after the start.');
  if (endTick >= perf.endTick) return { changed: false };
  return run(store, 'performance:Trim performance', (d) => {
    const x = d.performances.find((q) => q.id === perfId);
    if (!x) return;
    x.endTick = endTick;
    x.events = x.events.filter((e) => e.t <= endTick);
  });
}
