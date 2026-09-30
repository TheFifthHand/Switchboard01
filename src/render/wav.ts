/**
 * WAV (RIFF/WAVE) encoding and parsing.
 *
 * Encoding writes interleaved integer PCM (16 or 24 bit). Samples are
 * clamped to [-1, 1] and rounded without dither, so the same audio always
 * produces the same bytes.
 */

export type WavBitDepth = 16 | 24;

export interface ParsedWav {
  sampleRate: number;
  bitDepth: number;
  /** 'pcm' = integer samples, 'float' = IEEE float samples. */
  format: 'pcm' | 'float';
  channels: Float32Array[];
}

const HEADER_BYTES = 44;
const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/** Clamped, rounded integer for a sample: -1 maps to -2^(n-1), +1 to 2^(n-1) - 1. */
function quantize(x: number, positiveMax: number): number {
  const v = Number.isFinite(x) ? (x > 1 ? 1 : x < -1 ? -1 : x) : 0;
  return v < 0 ? Math.round(v * (positiveMax + 1)) : Math.round(v * positiveMax);
}

export function encodeWav(channels: readonly Float32Array[], sampleRate: number, bitDepth: WavBitDepth = 16): ArrayBuffer {
  if (!channels.length) throw new RangeError('encodeWav needs at least one channel');
  if (channels.length > 32) throw new RangeError('encodeWav supports at most 32 channels');
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError(`Invalid sample rate ${sampleRate}`);
  if (bitDepth !== 16 && bitDepth !== 24) throw new RangeError(`Unsupported bit depth ${String(bitDepth)}`);
  const nCh = channels.length;
  const frames = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const bytesPerSample = bitDepth / 8;
  const blockAlign = nCh * bytesPerSample;
  const dataBytes = frames * blockAlign;
  // RIFF chunks are word aligned: an odd-sized data chunk (mono 24-bit, odd frame count) gets a pad byte.
  const pad = dataBytes & 1;
  if (HEADER_BYTES + dataBytes + pad > 0xffffffff) throw new RangeError('Audio is too long for a WAV file (4 GB limit)');

  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes + pad);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes + pad, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, nCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  const bytes = new Uint8Array(buffer, HEADER_BYTES, dataBytes);
  let o = 0;
  if (bitDepth === 16) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nCh; c++) {
        const ch = channels[c];
        const v = quantize(i < ch.length ? ch[i] : 0, 32767);
        bytes[o] = v & 0xff;
        bytes[o + 1] = (v >> 8) & 0xff;
        o += 2;
      }
    }
  } else {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nCh; c++) {
        const ch = channels[c];
        const v = quantize(i < ch.length ? ch[i] : 0, 8388607);
        bytes[o] = v & 0xff;
        bytes[o + 1] = (v >> 8) & 0xff;
        bytes[o + 2] = (v >> 16) & 0xff;
        o += 3;
      }
    }
  }
  return buffer;
}

/** Parse a RIFF/WAVE file: integer PCM (8/16/24/32 bit), IEEE float (32/64 bit), plain or extensible. */
export function parseWav(data: ArrayBuffer): ParsedWav {
  const view = new DataView(data);
  const ascii = (off: number, n: number): string => {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  };
  if (data.byteLength < 12 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('Not a WAV file (missing RIFF/WAVE header)');

  let fmt: { format: number; channels: number; sampleRate: number; blockAlign: number; bits: number } | null = null;
  let dataOffset = -1;
  let dataBytes = 0;
  let off = 12;
  while (off + 8 <= data.byteLength) {
    const id = ascii(off, 4);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > data.byteLength) throw new Error('WAV fmt chunk is too short');
      let format = view.getUint16(body, true);
      if (format === FORMAT_EXTENSIBLE && size >= 40 && body + 26 <= data.byteLength) format = view.getUint16(body + 24, true);
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataBytes = dataChunkBytes(view, body, size);
      if (fmt) break;
    }
    off = body + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV file has no fmt chunk');
  if (dataOffset < 0) throw new Error('WAV file has no data chunk');
  const { format, channels: nCh, sampleRate, bits } = fmt;
  if (nCh < 1) throw new Error('WAV file has no channels');
  if (sampleRate < 1) throw new Error('WAV file has an invalid sample rate');
  const isFloat = format === FORMAT_FLOAT;
  if (!isFloat && format !== FORMAT_PCM) throw new Error(`Unsupported WAV encoding (format ${format})`);
  if (isFloat ? bits !== 32 && bits !== 64 : ![8, 16, 24, 32].includes(bits)) throw new Error(`Unsupported WAV bit depth ${bits}`);
  const bytesPerSample = bits / 8;
  const blockAlign = Math.max(fmt.blockAlign, nCh * bytesPerSample);
  const frames = Math.floor(dataBytes / blockAlign);
  const channels = Array.from({ length: nCh }, () => new Float32Array(frames));

  for (let i = 0; i < frames; i++) {
    const frame = dataOffset + i * blockAlign;
    for (let c = 0; c < nCh; c++) {
      const p = frame + c * bytesPerSample;
      let v: number;
      if (isFloat) {
        v = bits === 32 ? view.getFloat32(p, true) : view.getFloat64(p, true);
      } else if (bits === 8) {
        const u = view.getUint8(p) - 128;
        v = u < 0 ? u / 128 : u / 127;
      } else if (bits === 16) {
        const s = view.getInt16(p, true);
        v = s < 0 ? s / 32768 : s / 32767;
      } else if (bits === 24) {
        let s = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
        if (s & 0x800000) s -= 0x1000000;
        v = s < 0 ? s / 8388608 : s / 8388607;
      } else {
        const s = view.getInt32(p, true);
        v = s < 0 ? s / 2147483648 : s / 2147483647;
      }
      channels[c][i] = v;
    }
  }
  return { sampleRate, bitDepth: bits, format: isFloat ? 'float' : 'pcm', channels };
}

export function wavBlob(channels: readonly Float32Array[], sampleRate: number, bitDepth: WavBitDepth = 16): Blob {
  return new Blob([encodeWav(channels, sampleRate, bitDepth)], { type: 'audio/wav' });
}

/** Channel data of a rendered buffer, ready for `encodeWav`. */
export function audioBufferChannels(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
}

/** Duration in seconds of a WAV file's audio (from its header), without decoding the samples. */
export function wavDuration(data: ArrayBuffer): number {
  const parsed = parseWavHeader(data);
  return parsed.frames / parsed.sampleRate;
}

/**
 * Audio bytes in a data chunk starting at `body`. Streaming writers that never
 * went back to fill in sizes leave 0xffffffff, or 0 in both the data and the
 * RIFF header: then the audio runs to the end of the file. Otherwise a 0 is a
 * genuinely empty chunk (other chunks may follow it).
 */
function dataChunkBytes(view: DataView, body: number, size: number): number {
  const available = Math.max(0, view.byteLength - body);
  const riff = view.getUint32(4, true);
  const unknown = size === 0xffffffff || (size === 0 && (riff === 0 || riff === 0xffffffff));
  return unknown ? available : Math.min(size, available);
}

function parseWavHeader(data: ArrayBuffer): { sampleRate: number; frames: number } {
  const view = new DataView(data);
  const magic = (off: number): string => String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  if (data.byteLength < HEADER_BYTES || magic(0) !== 'RIFF' || magic(8) !== 'WAVE') throw new Error('Not a WAV file (missing RIFF/WAVE header)');
  let off = 12;
  let sampleRate = 0;
  let blockAlign = 0;
  let dataBytes = -1;
  // Same chunk walk as parseWav: the data chunk may come before fmt.
  while (off + 8 <= data.byteLength) {
    const id = magic(off);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ' && off + 24 <= data.byteLength) {
      sampleRate = view.getUint32(off + 12, true);
      blockAlign = view.getUint16(off + 20, true);
    } else if (id === 'data') {
      dataBytes = dataChunkBytes(view, off + 8, size);
    }
    if (sampleRate && blockAlign && dataBytes >= 0) return { sampleRate, frames: Math.floor(dataBytes / blockAlign) };
    off += 8 + size + (size & 1);
  }
  throw new Error('WAV file is missing its fmt or data chunk');
}
