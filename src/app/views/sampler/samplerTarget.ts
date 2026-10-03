/**
 * Which recording the sampler editor works on (capability-01).
 *
 * A sampler clip can play a recording of its own (Clip.sample: which
 * recording, its region and its root key); a clip without one plays the
 * part's recording. The editor follows the part's selected clip (uiStore
 * `selectedSlot`, as the pad ring shows it):
 *
 * - the selected clip has its own recording: the editor edits that clip's
 *   recording, region (Start/End) and root key (cmd.setClipSampleRegion);
 * - otherwise it edits the part's recording and its Start/End/Root params.
 *
 * Everything else a sampler part has (mode, gain, pitch, fades, tempo sync,
 * Original BPM) belongs to the part and applies to every clip on it.
 */
import { builtinSampleInfo } from '../../../content/catalog';
import type { ClipSample, Id, InstrumentKind, Project } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { uiStore } from '../../../state/uiStore';
import { session, useProject, useUi } from '../../instance';
import { runtimeStore, useRuntime } from '../../runtime';
import { defaultSlot } from '../../selection';
import { readSamplerValues, useSamplerController, type SamplerParamId } from './samplerValues';

export interface SamplerTarget {
  trackId: Id;
  /** 'clip': the selected clip plays a recording of its own, and that is what is edited. 'part': the part's recording. */
  kind: 'clip' | 'part';
  /** The part's selected pad (row). */
  slot: number;
  /** The selected clip's name; null when the selected pad is empty (no clip selected). */
  clipName: string | null;
  /** Name of the selected pad's scene ("Groove"). */
  sceneName: string;
  /** The recording that is edited (the clip's own or the part's); null: none. */
  sampleId: Id | null;
  /** The part's own recording (null: none, or not a sampler). */
  partSampleId: Id | null;
  partName: string;
  partKind: InstrumentKind;
}

/** Display name of a recording (built-in or imported). */
export function recordingName(p: Project, id: Id | null): string {
  if (!id) return 'No recording';
  return builtinSampleInfo(id)?.name ?? p.samples.find((s) => s.id === id)?.name ?? 'Missing recording';
}

/** The part's selected pad: its chosen slot, else the one the selection would give it (selection.ts). */
export function selectedSlotOf(p: Project, trackId: Id, chosen: number | undefined, playing: number | null): number {
  return chosen ?? defaultSlot(p, trackId, playing);
}

/** What the editor works on for a part, from the project and the part's selected pad. */
export function readTarget(p: Project, trackId: Id, slot: number): SamplerTarget | null {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return null;
  const inst = t.instrument;
  const clip = t.clips[slot] ?? null;
  const partSampleId = inst.kind === 'sampler' ? inst.sampleId : null;
  const own = inst.kind === 'sampler' && clip?.sample ? clip.sample : null;
  return {
    trackId,
    kind: own ? 'clip' : 'part',
    slot,
    clipName: clip?.name ?? null,
    sceneName: p.scenes[slot]?.name ?? `Row ${slot + 1}`,
    sampleId: own ? own.id : partSampleId,
    partSampleId,
    partName: t.name,
    partKind: inst.kind,
  };
}

/** The target as it is now (outside React). */
export function currentTarget(trackId: Id): SamplerTarget | null {
  const p = session.store.getState();
  const slot = selectedSlotOf(p, trackId, uiStore.getState().selectedSlot[trackId], runtimeStore.getState().tracks[trackId]?.playingSlot ?? null);
  return readTarget(p, trackId, slot);
}

export function useSamplerTarget(trackId: Id): SamplerTarget | null {
  const chosen = useUi((s) => s.selectedSlot[trackId]);
  const playing = useRuntime((s) => s.tracks[trackId]?.playingSlot ?? null);
  return useProject((p) => readTarget(p, trackId, selectedSlotOf(p, trackId, chosen, playing)), shallowEqual);
}

/** The clip's own recording settings when `target` is a clip, else null. */
export function clipSampleOf(p: Project, target: Pick<SamplerTarget, 'trackId' | 'slot' | 'kind'>): ClipSample | null {
  if (target.kind !== 'clip') return null;
  return p.tracks.find((t) => t.id === target.trackId)?.clips[target.slot]?.sample ?? null;
}

/** Ids that a clip's own recording settings replace. */
const CLIP_IDS = new Set<SamplerParamId>(['start', 'end', 'rootNote']);

/**
 * Effective sampler values for the target: the part's (after macros), with
 * Start, End and Root from the clip's own recording settings when the
 * target is a clip.
 */
export function readTargetValues<K extends SamplerParamId>(p: Project, target: Pick<SamplerTarget, 'trackId' | 'slot' | 'kind'>, ids: readonly K[]): Record<K, number> {
  const out = readSamplerValues(p, target.trackId, ids);
  const own = clipSampleOf(p, target);
  if (!own) return out;
  for (const id of ids) {
    if (!CLIP_IDS.has(id)) continue;
    if (id === 'start') out[id] = own.start as Record<K, number>[K];
    else if (id === 'end') out[id] = own.end as Record<K, number>[K];
    else out[id] = own.rootNote as Record<K, number>[K];
  }
  return out;
}

export function useTargetValues<K extends SamplerParamId>(target: Pick<SamplerTarget, 'trackId' | 'slot' | 'kind'>, ids: readonly K[]): Record<K, number> {
  return useProject((p) => readTargetValues(p, target, ids), shallowEqual);
}

/** The macro that moves one of the target's values (read-only then), or null. A clip's own Start/End/Root are never mapped. */
export function useTargetController(target: Pick<SamplerTarget, 'trackId' | 'kind'>, id: SamplerParamId): string | null {
  const ctl = useSamplerController(target.trackId, id);
  return target.kind === 'clip' && CLIP_IDS.has(id) ? null : ctl;
}

/**
 * Set Start, End or Root on the target: the clip's own recording settings
 * (one undo step per gesture), or the part's parameters (recordable, as
 * every sampler knob). Returns whether the project took it.
 */
export function setTargetValue(target: Pick<SamplerTarget, 'trackId' | 'slot' | 'kind'>, id: 'start' | 'end' | 'rootNote', value: number, gesture?: string): boolean {
  if (target.kind === 'clip') {
    return session.accepted(cmd.setClipSampleRegion(session.store, target.trackId, target.slot, { [id]: value }, gesture));
  }
  session.setInstrumentParam(target.trackId, id, value, gesture);
  return true;
}

/** "Recording 2 — plays in Vocal · Groove" / "Vocal “Oh” — plays in Vocal: Oh Chops, Long Oh". */
export function targetHeading(p: Project, target: SamplerTarget): string {
  const name = recordingName(p, target.sampleId);
  if (target.kind === 'clip') return `${name} — plays in ${target.partName} · ${target.sceneName}`;
  const t = p.tracks.find((x) => x.id === target.trackId);
  const users = (t?.clips ?? []).filter((c): c is NonNullable<typeof c> => !!c && !c.sample).map((c) => c.name);
  if (!users.length) return `${name} — ${target.partName}’s recording (no clip plays it yet)`;
  return `${name} — plays in ${target.partName}: ${users.join(', ')}`;
}
