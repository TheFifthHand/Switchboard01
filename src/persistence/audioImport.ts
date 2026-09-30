/**
 * Importing recordings (WAV / MP3) from the user's device.
 *
 * Files are checked before decoding (type and size), decoded locally with the
 * browser's decoder, and rejected with an actionable message when too long or
 * undecodable. The original bytes are kept (as a Blob) for storage and
 * bundles; the decoded buffer is what the sampler plays.
 */
import { uid } from '../project/factory';
import type { SampleMeta } from '../project/types';

export const IMPORT_LIMITS = {
  maxBytes: 50 * 1024 * 1024,
  maxSeconds: 60,
  types: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3'] as readonly string[],
  extensions: ['.wav', '.mp3'] as readonly string[],
  /** Shown before choosing a file. */
  description: 'WAV or MP3 files up to 50 MB and 60 seconds long. Recordings are decoded on this device and play at their original pitch.',
} as const;

export const DECODE_FAILED_MESSAGE = 'This file could not be decoded. Try exporting it as 16-bit WAV or MP3.';

export type CheckResult = { ok: true } | { ok: false; message: string };

/** The parts of a File the checks need (so callers and tests can pass plain objects). */
export interface FileLike {
  name: string;
  type: string;
  size: number;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function mb(bytes: number): string {
  const v = bytes / (1024 * 1024);
  return v >= 10 ? v.toFixed(0) : v.toFixed(1);
}

/** Normalised MIME type for storage: the browser's type when it is a supported one, else derived from the extension. */
export function audioMimeFor(file: FileLike): string {
  const t = (file.type || '').toLowerCase();
  if (IMPORT_LIMITS.types.includes(t)) return t === 'audio/mp3' ? 'audio/mpeg' : t;
  return extensionOf(file.name) === '.mp3' ? 'audio/mpeg' : 'audio/wav';
}

/** Check type and size before reading the file. */
export function checkAudioFile(file: FileLike): CheckResult {
  const name = file.name || 'This file';
  const typeOk = IMPORT_LIMITS.types.includes((file.type || '').toLowerCase());
  const extOk = IMPORT_LIMITS.extensions.includes(extensionOf(file.name || ''));
  if (!typeOk && !extOk) {
    return { ok: false, message: `"${name}" is not a WAV or MP3 file. Convert it to WAV or MP3 and try again.` };
  }
  if (file.size <= 0) return { ok: false, message: `"${name}" is empty.` };
  if (file.size > IMPORT_LIMITS.maxBytes) {
    return { ok: false, message: `"${name}" is ${mb(file.size)} MB. The limit is ${mb(IMPORT_LIMITS.maxBytes)} MB — trim it or export a shorter or compressed (MP3) version.` };
  }
  return { ok: true };
}

/** A display name from a file name: without extension, trimmed. */
export function sampleNameFrom(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const base = (dot > 0 ? fileName.slice(0, dot) : fileName).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (base || 'Recording').slice(0, 80);
}

/** The decoded-buffer surface used here (AudioBuffer, or a test double). */
export interface BufferLike {
  readonly length: number;
  readonly duration: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * Waveform overview: `points` min/max pairs ([min0, max0, min1, max1, ...])
 * across all channels, clamped to -1..1 and rounded to 3 decimals.
 */
export function computePeaks(buffer: BufferLike, points = 480): number[] {
  const n = Math.max(1, Math.floor(points));
  const out: number[] = new Array(n * 2).fill(0);
  const len = buffer.length;
  if (len === 0 || buffer.numberOfChannels === 0) return out;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const r = (v: number) => Math.round(Math.min(1, Math.max(-1, v)) * 1000) / 1000;
  for (let i = 0; i < n; i++) {
    const start = Math.floor((i * len) / n);
    const end = Math.max(start + 1, Math.floor(((i + 1) * len) / n));
    let min = Infinity;
    let max = -Infinity;
    for (const data of channels) {
      for (let j = start; j < end && j < len; j++) {
        const v = data[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (min === Infinity) min = max = 0;
    out[2 * i] = r(min);
    out[2 * i + 1] = r(max);
  }
  return out;
}

export type DecodeResult = { ok: true; buffer: AudioBuffer; meta: SampleMeta; blob: Blob } | { ok: false; message: string };

/** The decoding surface used here (BaseAudioContext, or a test double). */
export interface DecoderLike {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
}

/**
 * Check, read and decode a recording. The project is untouched on failure;
 * callers store `blob` (original bytes) and add `meta` to the project on success.
 */
export async function decodeAudioFile(file: File, ctx: DecoderLike): Promise<DecodeResult> {
  const check = checkAudioFile(file);
  if (!check.ok) return check;
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return { ok: false, message: `"${file.name}" could not be read. Check that the file is still available and try again.` };
  }
  let buffer: AudioBuffer;
  try {
    // decodeAudioData detaches the buffer it is given, so decode a copy and keep the original bytes.
    buffer = await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    return { ok: false, message: DECODE_FAILED_MESSAGE };
  }
  if (!buffer || !(buffer.length > 0) || !Number.isFinite(buffer.duration)) return { ok: false, message: DECODE_FAILED_MESSAGE };
  if (buffer.duration > IMPORT_LIMITS.maxSeconds) {
    return {
      ok: false,
      message: `"${file.name}" is ${buffer.duration.toFixed(1)} seconds long. The limit is ${IMPORT_LIMITS.maxSeconds} seconds — trim it and try again.`,
    };
  }
  const mime = audioMimeFor(file);
  const meta: SampleMeta = {
    id: uid('smp'),
    name: sampleNameFrom(file.name),
    mime,
    byteLength: bytes.byteLength,
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    peaks: computePeaks(buffer),
  };
  return { ok: true, buffer, meta, blob: new Blob([bytes], { type: mime }) };
}
