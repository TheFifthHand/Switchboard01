/**
 * Recorded performances in words (pure: no DOM, no React).
 *
 * A take stores absolute transport ticks; the list shows them as
 * bar.beat.step from the start of the take. Names come from the take's own
 * snapshot (the parts, clips and modules as they were when it was recorded),
 * so the list describes what the replay will actually do.
 *
 * A played note is a noteOn/noteOff pair. Replay pairs a noteOn with the next
 * event of the same part and key when that is a noteOff (the same rule as
 * `performanceEventGroup` in the commands), so the list shows one row per note
 * and deleting it removes both halves.
 */
import { MODULE_DEFS } from '../../../project/modules';
import { INSTRUMENT_PARAMS, MODULE_PARAMS, formatParam, specById, type ParamSpec } from '../../../project/params';
import { TICKS_PER_BAR, TICKS_PER_BEAT, TICKS_PER_STEP, type Id, type Performance, type PerformanceEvent, type Track } from '../../../project/types';
import { TempoMap } from '../../../time/clock';
import { getKitVoiceNames } from '../../../audio/instruments/kits';
import { noteName } from '../../../ui/components';
import { MACRO_SPECS } from '../../macros';

export type EventKind = 'Launch' | 'Scene' | 'Note' | 'Macro' | 'Knob' | 'Mute' | 'Tempo' | 'Swing' | 'Master';

export interface EventRow {
  /** Index in `performance.events` to pass to deletePerformanceEvent (a note's noteOn). */
  index: number;
  /** Absolute transport tick. */
  tick: number;
  /** bar.beat.step from the start of the take, e.g. "3.2.4". */
  time: string;
  kind: EventKind;
  /** Plain-language description, e.g. "Bass → Rolling, from bar 3". */
  detail: string;
  /** The paired noteOff index for a note (deleted together). */
  pairIndex?: number;
}

/** "bar.beat.step" (1-based) for a tick offset from the start of a take. */
export function formatPosition(relTick: number): string {
  const t = Math.max(0, relTick);
  const bar = Math.floor(t / TICKS_PER_BAR);
  const inBar = t - bar * TICKS_PER_BAR;
  const beat = Math.floor(inBar / TICKS_PER_BEAT);
  const step = Math.floor((inBar - beat * TICKS_PER_BEAT) / TICKS_PER_STEP);
  return `${bar + 1}.${beat + 1}.${step + 1}`;
}

/** Tempo map of a take: its starting tempo plus its recorded tempo changes. */
export function takeTempoMap(perf: Performance): TempoMap {
  const map = new TempoMap({ time: 0, tick: perf.startTick, bpm: perf.snapshot.bpm });
  const tempos = perf.events
    .filter((e): e is Extract<PerformanceEvent, { type: 'tempo' }> => e.type === 'tempo' && e.t >= perf.startTick && e.t < perf.endTick)
    .sort((a, b) => a.t - b.t);
  for (const e of tempos) map.reanchorAtTick(e.t, e.bpm);
  return map;
}

/** Length of a take in seconds (follows its recorded tempo changes). */
export function performanceSeconds(perf: Performance): number {
  return Math.max(0, takeTempoMap(perf).timeAt(Math.max(perf.endTick, perf.startTick)));
}

function seconds(s: number): string {
  return `${s < 0.095 ? s.toFixed(2) : s.toFixed(1)} s`;
}

export interface EventCount {
  key: string;
  count: number;
  /** "3 launches", "1 note", … */
  text: string;
}

const COUNT_WORDS: { key: string; types: PerformanceEvent['type'][]; one: string; many: string }[] = [
  { key: 'launch', types: ['launch', 'stopAll'], one: 'launch', many: 'launches' },
  { key: 'scene', types: ['scene'], one: 'scene', many: 'scenes' },
  { key: 'note', types: ['noteOn'], one: 'note', many: 'notes' },
  { key: 'macro', types: ['macro'], one: 'macro move', many: 'macro moves' },
  { key: 'param', types: ['param'], one: 'knob move', many: 'knob moves' },
  { key: 'mute', types: ['mute'], one: 'mute', many: 'mutes' },
  { key: 'tempo', types: ['tempo'], one: 'tempo change', many: 'tempo changes' },
  { key: 'swing', types: ['swing'], one: 'swing change', many: 'swing changes' },
  { key: 'master', types: ['master'], one: 'volume change', many: 'volume changes' },
];

/** Event counts by kind (non-zero only), in a fixed order. */
export function eventCounts(perf: Performance): EventCount[] {
  const by = new Map<string, number>();
  for (const e of perf.events) by.set(e.type, (by.get(e.type) ?? 0) + 1);
  const out: EventCount[] = [];
  for (const w of COUNT_WORDS) {
    const count = w.types.reduce((n, t) => n + (by.get(t) ?? 0), 0);
    if (count > 0) out.push({ key: w.key, count, text: `${count} ${count === 1 ? w.one : w.many}` });
  }
  return out;
}

/** noteOn index → its noteOff index (replay's pairing rule, in recorded order). */
export function pairNotes(events: readonly PerformanceEvent[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const open = new Map<string, number>();
  events.forEach((e, i) => {
    if (e.type !== 'noteOn' && e.type !== 'noteOff') return;
    const k = `${e.trackId}\u0000${e.key}`;
    if (e.type === 'noteOn') {
      open.set(k, i);
    } else {
      const on = open.get(k);
      if (on !== undefined) pairs.set(on, i);
      open.delete(k);
    }
  });
  return pairs;
}

interface Names {
  track(id: Id): Track | undefined;
  trackName(id: Id): string;
  pitchName(trackId: Id, pitch: number): string;
}

function namesFor(perf: Performance): Names {
  const tracks = new Map(perf.snapshot.tracks.map((t) => [t.id, t]));
  const kitNames = new Map<string, string[]>();
  return {
    track: (id) => tracks.get(id),
    trackName: (id) => tracks.get(id)?.name ?? 'Unknown part',
    pitchName(trackId, pitch) {
      const t = tracks.get(trackId);
      if (t?.instrument.kind === 'drums') {
        const kitId = t.instrument.kitId;
        let names = kitNames.get(kitId);
        if (!names) {
          try {
            names = getKitVoiceNames(kitId);
          } catch {
            names = [];
          }
          kitNames.set(kitId, names);
        }
        return `${names[pitch] ?? `Sound ${pitch + 1}`} hit`;
      }
      return `${noteName(pitch)} note`;
    },
  };
}

function paramText(perf: Performance, names: Names, module: Id, param: string, value: number): string {
  const mod = perf.snapshot.patch.modules.find((m) => m.id === module);
  let specs: readonly ParamSpec[] = [];
  let owner = '';
  let what = '';
  if (mod) {
    if (mod.type === 'instrument') {
      const t = mod.trackId ? names.track(mod.trackId) : undefined;
      specs = t ? INSTRUMENT_PARAMS[t.instrument.kind] : [];
    } else {
      specs = MODULE_PARAMS[mod.type];
      // Channel knobs read naturally without the module name ("Bass · Level").
      if (mod.type !== 'channel') what = mod.label ?? MODULE_DEFS[mod.type].label;
    }
    owner = mod.trackId ? names.trackName(mod.trackId) : '';
  } else if (module.endsWith(':inst')) {
    const trackId = module.slice(0, -':inst'.length);
    const t = names.track(trackId);
    specs = t ? INSTRUMENT_PARAMS[t.instrument.kind] : [];
    owner = t?.name ?? '';
  }
  const spec = specById(specs, param);
  const label = spec?.label ?? param;
  const val = spec ? formatParam(spec, value) : String(Math.round(value * 100) / 100);
  const control = what && !label.toLowerCase().startsWith(what.toLowerCase()) ? `${what} ${label}` : label;
  return owner ? `${owner} · ${control} ${val}` : `${control} ${val}`;
}

function launchText(perf: Performance, names: Names, trackId: Id, slot: number | null): string {
  const part = names.trackName(trackId);
  if (slot === null) return `${part} → Stop`;
  const clip = names.track(trackId)?.clips[slot];
  return `${part} → ${clip?.name ?? `Slot ${slot + 1}`}`;
}

/**
 * When a queued launch takes effect, in the same bar.beat.step terms as the
 * Time column. Replay drops a launch queued for after the take's end, and the
 * row says so.
 */
function when(perf: Performance, verb: 'starts' | 'stops', tick: number): string {
  if (tick >= perf.endTick) return `queued for after the take ends, so it is not heard`;
  return `${verb} at ${formatPosition(tick - perf.startTick)}`;
}

/**
 * For a noteOn without a release: the next press of the same key on the same
 * part, which is where replay ends it (-1 when none: it is held to the end).
 */
function nextPressOfKey(events: readonly PerformanceEvent[], index: number): number {
  const e = events[index];
  if (e.type !== 'noteOn') return -1;
  for (let i = index + 1; i < events.length; i++) {
    const x = events[i];
    if (x.type === 'noteOn' && x.trackId === e.trackId && x.key === e.key) return i;
  }
  return -1;
}

/**
 * One row per recorded action, in time order. Paired noteOffs are folded
 * into their note's row.
 */
export function performanceRows(perf: Performance): EventRow[] {
  const names = namesFor(perf);
  const pairs = pairNotes(perf.events);
  const pairedOffs = new Set(pairs.values());
  const map = takeTempoMap(perf);
  const rows: EventRow[] = [];
  perf.events.forEach((e, index) => {
    if (e.type === 'noteOff' && pairedOffs.has(index)) return;
    const rel = e.t - perf.startTick;
    const base = { index, tick: e.t, time: formatPosition(rel) };
    switch (e.type) {
      case 'launch':
        rows.push({ ...base, kind: 'Launch', detail: `${launchText(perf, names, e.trackId, e.slot)}, ${when(perf, e.slot === null ? 'stops' : 'starts', e.atTick)}` });
        break;
      case 'stopAll':
        rows.push({ ...base, kind: 'Launch', detail: `All parts → Stop, ${when(perf, 'stops', e.atTick)}` });
        break;
      case 'scene': {
        const scene = perf.snapshot.scenes[e.row];
        rows.push({ ...base, kind: 'Scene', detail: `${scene?.name ?? `Scene ${e.row + 1}`} for all parts, ${when(perf, 'starts', e.atTick)}` });
        break;
      }
      case 'noteOn': {
        const off = pairs.get(index);
        const track = names.track(e.trackId);
        // On a part with the arpeggiator on, replay feeds the key to the arpeggiator (as when it was played).
        const arp = track?.arp.enabled === true;
        const what = `${names.trackName(e.trackId)} · ${names.pitchName(e.trackId, e.pitch)}${arp ? ' into the arpeggiator' : ''}`;
        const velocity = `velocity ${Math.round(Math.min(1, Math.max(0, e.velocity)) * 100)}%`;
        let length: string;
        if (off !== undefined) {
          length = seconds(Math.max(0, map.timeAt(perf.events[off].t) - map.timeAt(e.t)));
        } else {
          const next = nextPressOfKey(perf.events, index);
          length = next >= 0 ? `${seconds(Math.max(0, map.timeAt(perf.events[next].t) - map.timeAt(e.t)))} (until the next press)` : 'held to the end';
        }
        rows.push({ ...base, kind: 'Note', detail: `${what}, ${length}, ${velocity}`, pairIndex: off });
        break;
      }
      case 'noteOff':
        rows.push({ ...base, kind: 'Note', detail: `${names.trackName(e.trackId)} · ${names.pitchName(e.trackId, e.pitch)} released` });
        break;
      case 'macro':
        rows.push({ ...base, kind: 'Macro', detail: `${names.trackName(e.trackId)} · ${MACRO_SPECS[e.macro]?.label ?? e.macro} ${Math.round(Math.min(1, Math.max(0, e.value)) * 100)}%` });
        break;
      case 'param':
        rows.push({ ...base, kind: 'Knob', detail: paramText(perf, names, e.module, e.param, e.value) });
        break;
      case 'mute':
        rows.push({ ...base, kind: 'Mute', detail: `${names.trackName(e.trackId)} ${e.mute ? 'muted' : 'unmuted'}` });
        break;
      case 'tempo':
        rows.push({ ...base, kind: 'Tempo', detail: `Tempo ${Math.round(e.bpm * 10) / 10} BPM` });
        break;
      case 'swing':
        rows.push({ ...base, kind: 'Swing', detail: `Swing ${Math.round(e.swing * 100)}%` });
        break;
      case 'master':
        rows.push({ ...base, kind: 'Master', detail: `Master volume ${e.volumeDb > 0 ? '+' : ''}${e.volumeDb.toFixed(1)} dB` });
        break;
    }
  });
  // Stable sort by time: the list reads in the order things happened.
  return rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.tick - b.r.tick || a.i - b.i).map((x) => x.r);
}
