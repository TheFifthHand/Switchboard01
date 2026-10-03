/** Recorded performances (takes): add, rename, delete, edit events, trim the end or the start. */
import { BPM_SPEC, INSTRUMENT_PARAMS, MASTER_VOLUME_SPEC, MODULE_PARAMS, SWING_SPEC, clampParam, specById, type ParamSpec } from '../../project/params';
import type { Id, MacroId, Performance, PerformanceEvent } from '../../project/types';
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
 * Shorten a take so it ends at `endTick`. Events at or after the new end are
 * removed (replay ignores them anyway: a take plays [startTick, endTick)); a
 * note still held at the new end sounds until the end. Only the end can be
 * trimmed: the start is tied to the captured snapshot.
 */
export function trimPerformance(store: ProjectStore, perfId: Id, endTick: number): CommandResult {
  const perf = store.getState().performances.find((x) => x.id === perfId);
  if (!perf) return NOT_FOUND('performance');
  if (!isFiniteNumber(endTick) || endTick <= perf.startTick) return refuse('invalid', 'The end must be after the start of the take.');
  if (endTick === perf.endTick) return { changed: false };
  if (endTick > perf.endTick) return refuse('invalid', 'A take can only be shortened: choose a point before its current end.');
  return run(store, 'performance:Trim performance', (d) => {
    const x = d.performances.find((q) => q.id === perfId);
    if (!x) return;
    x.endTick = endTick;
    x.events = x.events.filter((e) => e.t < endTick);
  });
}

const macroSpec = (macro: MacroId): ParamSpec => ({ id: macro, label: macro[0].toUpperCase() + macro.slice(1), min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: '' });

/**
 * The range and units of the value a recorded event carries: a macro or knob
 * move, a tempo, swing or master volume change. Knob ranges come from the
 * take's own snapshot (the modules and sounds it replays with). Null for
 * events without an editable value (launches, notes, mutes) or a knob the
 * registry does not know.
 */
export function performanceEventSpec(perf: Performance, e: PerformanceEvent): ParamSpec | null {
  switch (e.type) {
    case 'macro':
      return macroSpec(e.macro);
    case 'tempo':
      return BPM_SPEC;
    case 'swing':
      return SWING_SPEC;
    case 'master':
      return MASTER_VOLUME_SPEC;
    case 'param': {
      const mod = perf.snapshot.patch.modules.find((m) => m.id === e.module);
      let specs: readonly ParamSpec[] = [];
      if (mod && mod.type !== 'instrument') specs = MODULE_PARAMS[mod.type] ?? [];
      else {
        const trackId = mod?.trackId ?? (e.module.endsWith(':inst') ? e.module.slice(0, -':inst'.length) : null);
        const track = trackId ? perf.snapshot.tracks.find((t) => t.id === trackId) : undefined;
        specs = track ? INSTRUMENT_PARAMS[track.instrument.kind] : [];
      }
      return specById(specs, e.param) ?? null;
    }
    default:
      return null;
  }
}

/** The value a recorded event carries (see performanceEventSpec), or null. */
export function performanceEventValue(e: PerformanceEvent): number | null {
  switch (e.type) {
    case 'macro':
    case 'param':
      return e.value;
    case 'tempo':
      return e.bpm;
    case 'swing':
      return e.swing;
    case 'master':
      return e.volumeDb;
    default:
      return null;
  }
}

/**
 * Change the value of one recorded event (a knob or macro position, a tempo,
 * swing or master volume) without moving it in time. The value is clamped to
 * the control's range, like a knob.
 */
export function setPerformanceEventValue(store: ProjectStore, perfId: Id, index: number, value: number): CommandResult {
  const perf = store.getState().performances.find((x) => x.id === perfId);
  if (!perf) return NOT_FOUND('performance');
  const e = Number.isInteger(index) ? perf.events[index] : undefined;
  if (!e) return refuse('invalid', 'That event does not exist.');
  const spec = performanceEventSpec(perf, e);
  if (!spec) return refuse('invalid', 'Only knob, macro, tempo, swing and volume changes have a value to edit.');
  if (!isFiniteNumber(value)) return refuse('invalid', 'Type a number.');
  const v = clampParam(spec, value);
  if (performanceEventValue(e) === v) return { changed: false };
  return run(store, 'performance:Change recorded value', (d) => {
    const x = d.performances.find((q) => q.id === perfId)?.events[index];
    if (!x) return;
    if (x.type === 'macro' || x.type === 'param') x.value = v;
    else if (x.type === 'tempo') x.bpm = v;
    else if (x.type === 'swing') x.swing = v;
    else if (x.type === 'master') x.volumeDb = v;
  });
}

/**
 * Start a take later, at `tick` (startTick < tick < endTick): "Start later…".
 * What happened before the new start becomes the take's starting state, so
 * the replay from there sounds as the take did at that point: the pads that
 * were playing then (launches that landed before it), knob, macro, mute,
 * tempo, swing and volume values reached by then, and notes still held then
 * (they start at the new start). A launch pressed before the new start that
 * lands after it is kept. Events before the new start are removed. One undo
 * step.
 */
export function trimTakeStart(store: ProjectStore, takeId: Id, tick: number): CommandResult {
  const perf = store.getState().performances.find((x) => x.id === takeId);
  if (!perf) return NOT_FOUND('performance');
  if (!isFiniteNumber(tick) || tick >= perf.endTick) return refuse('invalid', 'The new start must be before the end of the take.');
  if (tick === perf.startTick) return { changed: false };
  if (tick < perf.startTick) return refuse('invalid', 'A take can only start later: choose a point after its current start.');
  const next = takeStartingAt(perf, tick);
  return run(store, 'performance:Start take later', (d) => {
    const i = d.performances.findIndex((q) => q.id === takeId);
    if (i >= 0) d.performances[i] = next;
  });
}

/** The take as if recording had started at `tick` (pure; see trimTakeStart). */
export function takeStartingAt(perf: Performance, tick: number): Performance {
  const snapshot = structuredClone(perf.snapshot);
  const playing = new Map(snapshot.launcher.map((e) => [e.trackId, e.playing]));
  const clipAtRow = (trackId: Id, row: number) => snapshot.tracks.find((t) => t.id === trackId)?.clips[row] ?? null;
  const setParam = (moduleId: Id, param: string, value: number) => {
    const mod = snapshot.patch.modules.find((m) => m.id === moduleId);
    if (mod && mod.type !== 'instrument') {
      const spec = specById(MODULE_PARAMS[mod.type], param);
      if (spec) mod.params[param] = clampParam(spec, value);
      return;
    }
    const trackId = mod?.trackId ?? (moduleId.endsWith(':inst') ? moduleId.slice(0, -':inst'.length) : null);
    const track = trackId ? snapshot.tracks.find((t) => t.id === trackId) : undefined;
    const spec = track ? specById(INSTRUMENT_PARAMS[track.instrument.kind], param) : undefined;
    if (track && spec) track.instrument.params[param] = clampParam(spec, value);
  };

  // Notes that sound across the new start begin there.
  const heldFrom = new Map<string, PerformanceEvent>();
  const noteKey = (e: { trackId: Id; key: string }) => `${e.trackId}\u0000${e.key}`;
  const kept: PerformanceEvent[] = [];
  for (const e of perf.events) {
    if (e.t >= tick) {
      if (e.type === 'noteOff' && heldFrom.has(noteKey(e))) {
        kept.push({ ...heldFrom.get(noteKey(e))!, t: tick });
        heldFrom.delete(noteKey(e));
      }
      kept.push(e);
      continue;
    }
    switch (e.type) {
      case 'launch':
      case 'scene':
      case 'stopAll':
        if (e.atTick >= tick) {
          // Pressed before the new start, lands after it: still happens.
          kept.push({ ...e, t: tick });
        } else if (e.type === 'launch') {
          const clip = e.slot === null ? null : clipAtRow(e.trackId, e.slot);
          playing.set(e.trackId, clip && e.slot !== null ? { slot: e.slot, startTick: e.atTick } : null);
        } else if (e.type === 'scene') {
          for (const t of snapshot.tracks) playing.set(t.id, t.clips[e.row] ? { slot: e.row, startTick: e.atTick } : null);
        } else {
          for (const t of snapshot.tracks) playing.set(t.id, null);
        }
        break;
      case 'noteOn':
        heldFrom.set(noteKey(e), e);
        break;
      case 'noteOff':
        heldFrom.delete(noteKey(e));
        break;
      case 'macro': {
        const t = snapshot.tracks.find((x) => x.id === e.trackId);
        if (t) t.macros[e.macro] = Math.min(1, Math.max(0, e.value));
        break;
      }
      case 'param':
        setParam(e.module, e.param, e.value);
        break;
      case 'mute': {
        const t = snapshot.tracks.find((x) => x.id === e.trackId);
        if (t) t.mute = e.mute;
        break;
      }
      case 'tempo':
        snapshot.bpm = clampParam(BPM_SPEC, e.bpm);
        break;
      case 'swing':
        snapshot.swing = clampParam(SWING_SPEC, e.swing);
        break;
      case 'master':
        snapshot.masterVolumeDb = clampParam(MASTER_VOLUME_SPEC, e.volumeDb);
        break;
    }
  }
  // A note still held at the end of the take sounds from the new start (replay closes it at the end).
  const opened = [...heldFrom.values()].map((e) => ({ ...e, t: tick }));
  snapshot.launcher = snapshot.tracks.map((t) => ({ trackId: t.id, playing: playing.get(t.id) ?? null }));
  // Stable: events at the same time keep their order.
  const events = [...opened, ...kept].sort((a, b) => a.t - b.t);
  return { id: perf.id, name: perf.name, createdAt: perf.createdAt, startTick: tick, endTick: perf.endTick, snapshot, events };
}
