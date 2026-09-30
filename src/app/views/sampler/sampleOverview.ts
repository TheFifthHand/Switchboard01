/**
 * Waveform overviews (min/max peak pairs) for the sampler editor.
 *
 * - Imported recordings: SampleMeta.peaks, computed when the file was
 *   decoded. If a project carries no peaks, the decoded buffer in the live
 *   sample bank is used, else the stored file is decoded once from browser
 *   storage.
 * - Built-in recordings: the decoded buffer in the live sample bank (the one
 *   that actually plays), or, before audio has started, the same
 *   deterministic generator at 48 kHz.
 *
 * Overviews are cached, so switching parts or re-rendering never recomputes.
 */
import { useEffect, useMemo, useState } from 'react';
import { generateBuiltinSample } from '../../../audio/instruments/builtinSamples';
import { builtinSampleInfo } from '../../../content/catalog';
import { computePeaks, type BufferLike } from '../../../persistence/audioImport';
import * as db from '../../../persistence/db';
import type { Id, SampleMeta } from '../../../project/types';
import { session, useProject } from '../../instance';
import { useRuntime } from '../../runtime';

export interface SampleOverview {
  /** [min0, max0, min1, max1, ...] across all channels, -1..1. */
  peaks: readonly number[];
  duration: number;
  sampleRate: number;
  channels: number;
}

export type OverviewStatus = 'ready' | 'loading' | 'missing';

/** Peak pairs computed for built-ins and fallbacks (the canvas interpolates between them). */
export const OVERVIEW_POINTS = 1024;
/** Rate used for built-ins before audio has started (the generator is deterministic). */
export const PREVIEW_RATE = 48000;

const builtinCache = new Map<string, SampleOverview>();
const bufferCache = new WeakMap<AudioBuffer, SampleOverview>();
const decodedCache = new Map<Id, SampleOverview>();
const decodeJobs = new Map<Id, Promise<SampleOverview | null>>();

export function isBuiltinId(id: string): boolean {
  return id.startsWith('builtin:');
}

function overviewOf(buffer: BufferLike): SampleOverview {
  return {
    peaks: computePeaks(buffer, OVERVIEW_POINTS),
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
  };
}

function overviewOfBuffer(buffer: AudioBuffer): SampleOverview {
  let o = bufferCache.get(buffer);
  if (!o) {
    o = overviewOf(buffer);
    bufferCache.set(buffer, o);
  }
  return o;
}

/** Overview of a built-in recording (null for an unknown id). */
export function builtinOverview(id: string): SampleOverview | null {
  if (!builtinSampleInfo(id)) return null;
  const live = session.bank?.get(id);
  if (live) return overviewOfBuffer(live);
  const hit = builtinCache.get(id);
  if (hit) return hit;
  const gen = generateBuiltinSample(id, PREVIEW_RATE);
  if (!gen || gen.channels.length === 0) return null;
  const length = gen.channels[0].length;
  const like: BufferLike = {
    length,
    duration: length / gen.sampleRate,
    sampleRate: gen.sampleRate,
    numberOfChannels: gen.channels.length,
    getChannelData: (c) => gen.channels[c],
  };
  const o = overviewOf(like);
  builtinCache.set(id, o);
  return o;
}

/** Overview of an imported recording that is available right now, or null. */
export function importedOverview(meta: SampleMeta): SampleOverview | null {
  if (meta.peaks && meta.peaks.length >= 2) {
    return { peaks: meta.peaks, duration: meta.duration, sampleRate: meta.sampleRate, channels: meta.channels };
  }
  const live = session.bank?.get(meta.id);
  if (live) return overviewOfBuffer(live);
  return decodedCache.get(meta.id) ?? null;
}

/** Decode a stored recording once to draw it (projects whose metadata has no overview). */
function loadStoredOverview(id: Id): Promise<SampleOverview | null> {
  let job = decodeJobs.get(id);
  if (!job) {
    job = (async () => {
      const rec = await db.getSample(id).catch(() => null);
      if (!rec) return null;
      const ctx = new OfflineAudioContext(1, 1, PREVIEW_RATE);
      const buffer = await ctx.decodeAudioData(await rec.blob.arrayBuffer());
      const o = overviewOf(buffer);
      decodedCache.set(id, o);
      return o;
    })()
      .catch(() => null)
      .finally(() => decodeJobs.delete(id));
    decodeJobs.set(id, job);
  }
  return job;
}

export interface OverviewState {
  overview: SampleOverview | null;
  status: OverviewStatus;
  /** Metadata of an imported recording (null for built-ins). */
  meta: SampleMeta | null;
}

/** The overview to draw for a part's recording. */
export function useSampleOverview(sampleId: Id): OverviewState {
  const meta = useProject((p) => (isBuiltinId(sampleId) ? null : (p.samples.find((s) => s.id === sampleId) ?? null)));
  // Built-ins switch to the live bank buffer once audio runs (same sound, the device's rate).
  const audioRunning = useRuntime((s) => s.audio === 'running');
  const [loaded, setLoaded] = useState<{ id: Id; overview: SampleOverview | null } | null>(null);

  const immediate = useMemo(() => {
    if (isBuiltinId(sampleId)) return builtinOverview(sampleId);
    return meta ? importedOverview(meta) : null;
    // audioRunning: re-read once the live sample bank exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleId, meta, audioRunning]);

  const needsLoad = !immediate && !isBuiltinId(sampleId) && meta !== null;
  useEffect(() => {
    if (!needsLoad) return;
    let alive = true;
    void loadStoredOverview(sampleId).then((o) => {
      if (alive) setLoaded({ id: sampleId, overview: o });
    });
    return () => {
      alive = false;
    };
  }, [needsLoad, sampleId]);

  if (immediate) return { overview: immediate, status: 'ready', meta };
  if (!needsLoad) return { overview: null, status: 'missing', meta };
  if (loaded && loaded.id === sampleId) return { overview: loaded.overview, status: loaded.overview ? 'ready' : 'missing', meta };
  return { overview: null, status: 'loading', meta };
}
