/**
 * The decoded audio of a recording for close-ups and snapping: the sampler
 * waveform draws its zoomed-in view from it (the overview has only a few
 * hundred points), and Shift-drag snaps a trim handle to its hits.
 *
 * Read once per recording (the live sample bank, the built-in generator or
 * the stored file; see loadSampleAudio) and kept for the few recordings
 * looked at last.
 */
import { useEffect, useState } from 'react';
import { detectOnsets } from '../../../render/analysis';
import type { Id } from '../../../project/types';
import { loadSampleAudio } from './sampleVersions';

export interface SampleDetail {
  /** The recording's channels at `sampleRate`. */
  channels: Float32Array[];
  sampleRate: number;
  /** Length in seconds. */
  duration: number;
  /** Where its hits start (seconds), oldest first. */
  onsets: number[];
}

/** Recordings kept decoded (most recent last). */
const KEEP = 4;
const cache = new Map<Id, SampleDetail | null>();
const jobs = new Map<Id, Promise<SampleDetail | null>>();

/**
 * Hits (seconds): where the short-term level rises through a quarter of
 * the recording's peak after having fallen below half of that (so a hit is
 * found once, and quiet noise is never one); at least 50 ms apart.
 */
export function findOnsets(channels: readonly Float32Array[], sampleRate: number): number[] {
  if (!channels.length || !channels[0].length) return [];
  const n = channels[0].length;
  let mono: Float32Array;
  if (channels.length === 1) mono = channels[0];
  else {
    mono = new Float32Array(n);
    for (const c of channels) for (let i = 0; i < n; i++) mono[i] += c[i] / channels.length;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mono[i]));
  if (peak < 1e-4) return [];
  const threshold = Math.max(0.004, peak * 0.25);
  return detectOnsets(mono, sampleRate, { threshold, minGapMs: 50, windowMs: 4 }).map((i) => i / sampleRate);
}

function remember(id: Id, d: SampleDetail | null): void {
  cache.delete(id);
  cache.set(id, d);
  while (cache.size > KEEP) cache.delete(cache.keys().next().value as Id);
}

/** The recording's detail, loaded once (null: its audio is not in this browser). */
export function loadSampleDetail(id: Id): Promise<SampleDetail | null> {
  if (cache.has(id)) return Promise.resolve(cache.get(id) ?? null);
  let job = jobs.get(id);
  if (!job) {
    job = loadSampleAudio(id)
      .then((audio) => {
        if (!audio || !audio.channels.length) return null;
        const length = audio.channels[0].length;
        return { channels: audio.channels, sampleRate: audio.sampleRate, duration: length / audio.sampleRate, onsets: findOnsets(audio.channels, audio.sampleRate) };
      })
      .catch(() => null)
      .then((d) => {
        // A recording whose audio is missing may still arrive (a project file being imported): only keep hits.
        if (d) remember(id, d);
        return d;
      })
      .finally(() => jobs.delete(id));
    jobs.set(id, job);
  }
  return job;
}

/** The detail already loaded for a recording, if any. */
export function cachedSampleDetail(id: Id): SampleDetail | null {
  return cache.get(id) ?? null;
}

/** The recording's detail once loaded (null before, and when `enabled` is false and nothing is cached). */
export function useSampleDetail(id: Id | null, enabled = true): SampleDetail | null {
  const [loaded, setLoaded] = useState<{ id: Id; detail: SampleDetail | null } | null>(null);
  const cached = id ? cachedSampleDetail(id) : null;
  useEffect(() => {
    if (!id || !enabled || cachedSampleDetail(id)) return;
    let alive = true;
    void loadSampleDetail(id).then((detail) => {
      if (alive) setLoaded({ id, detail });
    });
    return () => {
      alive = false;
    };
  }, [id, enabled]);
  if (!id) return null;
  return cached ?? (loaded && loaded.id === id ? loaded.detail : null);
}
