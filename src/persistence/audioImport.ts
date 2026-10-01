/**
 * Importing recordings (WAV / MP3) from the user's device.
 *
 * Files are checked before decoding (type and size, then the length their
 * WAV header or MP3 frames describe), decoded locally with the browser's
 * decoder, and rejected with an actionable message when too long or
 * undecodable. Checking the length first matters: a small file can hold a
 * very long recording (a 45 MB MP3 is ~47 minutes), and decoding it would
 * need about a gigabyte of memory before it could be refused. The original
 * bytes are kept (as a Blob) for storage and bundles; the decoded buffer is
 * what the sampler plays.
 */
import { uid } from '../project/factory';
import type { SampleMeta } from '../project/types';
import { encodeWav } from '../render/wav';

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

/* ------------------------------------------------------------------ */
/* Length from the file itself (before decoding)                       */
/* ------------------------------------------------------------------ */

/** A recording's length read from its bytes. `atLeast`: the file was only read up to a damaged spot. */
export interface HeaderLength {
  seconds: number;
  atLeast: boolean;
}

/**
 * Headers are read, not decoded: a length a little over the limit is left to
 * the exact check after decoding (MP3 encoders add a few ms of padding).
 */
const HEADER_TOLERANCE_SECONDS = 0.5;

function fourCC(v: DataView, o: number): string {
  return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
}

/** WAV (RIFF/WAVE): data chunk bytes / average bytes per second. Null if the header is not readable. */
export function wavLength(bytes: ArrayBuffer): HeaderLength | null {
  const v = new DataView(bytes);
  const len = v.byteLength;
  if (len < 12 || fourCC(v, 0) !== 'RIFF' || fourCC(v, 8) !== 'WAVE') return null;
  let byteRate = 0;
  let o = 12;
  while (o + 8 <= len) {
    const id = fourCC(v, o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= len) {
      byteRate = v.getUint32(body + 8, true);
    } else if (id === 'data') {
      if (!(byteRate > 0)) return null;
      // A header written before recording finished may claim more data than the file holds.
      return { seconds: Math.min(size, len - body) / byteRate, atLeast: false };
    }
    o = body + size + (size & 1);
  }
  return null;
}

const MP3_BITRATES_KBPS: Record<string, readonly number[]> = {
  'v1l1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  'v1l2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  'v1l3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  'v2l1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  'v2l2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SAMPLE_RATES: Record<number, readonly number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface Mp3Frame {
  /** Version and layer bits and sample rate: every frame of one stream shares them. */
  stream: number;
  sampleRate: number;
  samples: number;
  bytes: number;
}

/** The MPEG audio frame header at `o`, or null. Free-format frames are not supported (no fixed length). */
function mp3Frame(b: Uint8Array, o: number): Mp3Frame | null {
  if (o + 4 > b.length || b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[o + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = (b[o + 1] >> 1) & 3; // 3 = Layer I, 2 = Layer II, 1 = Layer III
  const brIndex = b[o + 2] >> 4;
  const srIndex = (b[o + 2] >> 2) & 3;
  if (version === 1 || layer === 0 || brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const v1 = version === 3;
  const table = v1 ? `v1l${4 - layer}` : layer === 3 ? 'v2l1' : 'v2l2';
  const bitrate = MP3_BITRATES_KBPS[table][brIndex] * 1000;
  const sampleRate = MP3_SAMPLE_RATES[version][srIndex];
  const padding = (b[o + 2] >> 1) & 1;
  const samples = layer === 3 ? 384 : layer === 2 || v1 ? 1152 : 576;
  const bytes = layer === 3 ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4 : Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  return { stream: (b[o + 1] & 0x1e) | (srIndex << 5), sampleRate, samples, bytes };
}

/**
 * MP3: skips ID3v2 tags, then walks the frame headers and adds up their
 * samples, which is exact for constant and variable bit rates alike. If the
 * frames stop matching before the end of the file (damage, or a trailing
 * tag), the result is a lower bound (`atLeast`). Null if no frames are found.
 */
export function mp3Length(bytes: ArrayBuffer): HeaderLength | null {
  const b = new Uint8Array(bytes);
  let o = 0;
  while (o + 10 <= b.length && b[o] === 0x49 && b[o + 1] === 0x44 && b[o + 2] === 0x33) {
    const size = ((b[o + 6] & 0x7f) << 21) | ((b[o + 7] & 0x7f) << 14) | ((b[o + 8] & 0x7f) << 7) | (b[o + 9] & 0x7f);
    o += 10 + size + (b[o + 5] & 0x10 ? 10 : 0);
  }
  // The first frame: a header whose successor starts right where it ends.
  let first: Mp3Frame | null = null;
  const searchEnd = Math.min(b.length, o + 64 * 1024);
  for (; o < searchEnd; o++) {
    const f = mp3Frame(b, o);
    if (!f) continue;
    const next = mp3Frame(b, o + f.bytes);
    if (next && next.stream === f.stream) {
      first = f;
      break;
    }
    if (o + f.bytes >= b.length) {
      first = f;
      break;
    }
  }
  if (!first) return null;
  let samples = 0;
  for (;;) {
    const f = mp3Frame(b, o);
    if (!f || f.stream !== first.stream) break;
    if (o + f.bytes > b.length) {
      // A last frame cut short still decodes (in part): count what is there.
      samples += (f.samples * (b.length - o)) / f.bytes;
      o = b.length;
      break;
    }
    samples += f.samples;
    o += f.bytes;
  }
  // Anything but a trailing ID3v1 tag after the last frame means the walk stopped early.
  const rest = b.length - o;
  const tail = rest === 128 && b[o] === 0x54 && b[o + 1] === 0x41 && b[o + 2] === 0x47;
  return { seconds: samples / first.sampleRate, atLeast: rest > 0 && !tail };
}

/** The recording's length read from its header or frames (null: the format does not tell before decoding). */
export function headerLength(bytes: ArrayBuffer, mime: string): HeaderLength | null {
  try {
    return mime === 'audio/mpeg' ? mp3Length(bytes) : wavLength(bytes);
  } catch {
    return null;
  }
}

function tooLongMessage(name: string, seconds: number, atLeast = false): string {
  return `"${name}" is ${atLeast ? 'at least ' : ''}${seconds.toFixed(1)} seconds long. The limit is ${IMPORT_LIMITS.maxSeconds} seconds — trim it and try again.`;
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
  const mime = audioMimeFor(file);
  // Refuse an over-long recording before decoding it (see the file comment).
  const told = headerLength(bytes, mime);
  if (told && told.seconds > IMPORT_LIMITS.maxSeconds + HEADER_TOLERANCE_SECONDS) {
    return { ok: false, message: tooLongMessage(file.name, told.seconds, told.atLeast) };
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
    return { ok: false, message: tooLongMessage(file.name, buffer.duration) };
  }
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

/* ------------------------------------------------------------------ */
/* Audio made in the app (recorded takes, edited versions)             */
/* ------------------------------------------------------------------ */

/**
 * The import limits apply to audio made in the app too (a recorded take, an
 * edited version): null when it fits, else what to do, in words.
 */
export function madeAudioLimitMessage(name: string, seconds: number, bytes: number): string | null {
  if (!(seconds > 0) || !(bytes > 0)) return `"${name}" is empty.`;
  if (seconds > IMPORT_LIMITS.maxSeconds + 1e-6) return `"${name}" would be ${seconds.toFixed(1)} seconds long. The limit is ${IMPORT_LIMITS.maxSeconds} seconds — record fewer bars or crop it first.`;
  if (bytes > IMPORT_LIMITS.maxBytes) return `"${name}" would be ${mb(bytes)} MB. The limit is ${mb(IMPORT_LIMITS.maxBytes)} MB — record fewer bars or crop it first.`;
  return null;
}

/** Metadata for audio made in the app, in the same shape an import gets (a fresh id, a waveform overview). */
export function madeAudioMeta(name: string, buffer: BufferLike, byteLength: number, mime = 'audio/wav'): SampleMeta {
  return {
    id: uid('smp'),
    name: (name.replace(/\s+/g, ' ').trim() || 'Recording').slice(0, 80),
    mime,
    byteLength,
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    peaks: computePeaks(buffer),
  };
}

export type MadeAudio = { ok: true; meta: SampleMeta; blob: Blob } | { ok: false; message: string };

/**
 * Encode audio made in the app as a WAV file to keep like an import: 24-bit
 * (16-bit when 24-bit would pass the size limit), within the import limits,
 * with its metadata. Nothing is stored here.
 */
export function encodeMadeAudio(name: string, channels: readonly Float32Array[], sampleRate: number): MadeAudio {
  const frames = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const seconds = frames / sampleRate;
  const header = 44;
  const bytes24 = header + frames * channels.length * 3;
  const depth = bytes24 <= IMPORT_LIMITS.maxBytes ? 24 : 16;
  const bytes = depth === 24 ? bytes24 : header + frames * channels.length * 2;
  const problem = madeAudioLimitMessage(name, seconds, bytes);
  if (problem) return { ok: false, message: problem };
  const wav = encodeWav(channels, sampleRate, depth);
  const like: BufferLike = { length: frames, duration: seconds, sampleRate, numberOfChannels: channels.length, getChannelData: (c) => channels[c] };
  return { ok: true, meta: madeAudioMeta(name, like, wav.byteLength), blob: new Blob([wav], { type: 'audio/wav' }) };
}
