import { describe, expect, it } from 'vitest';
import {
  DECODE_FAILED_MESSAGE,
  IMPORT_LIMITS,
  audioMimeFor,
  checkAudioFile,
  computePeaks,
  decodeAudioFile,
  mp3Length,
  sampleNameFrom,
  wavLength,
  type BufferLike,
  type DecoderLike,
} from '../../src/persistence/audioImport';
import { sanitizeSampleMeta } from '../../src/project/validate';

const MB = 1024 * 1024;

function fakeBuffer(channels: number[][], sampleRate = 44100): BufferLike & AudioBuffer {
  const data = channels.map((c) => Float32Array.from(c));
  const length = data[0]?.length ?? 0;
  return {
    length,
    duration: length / sampleRate,
    sampleRate,
    numberOfChannels: data.length,
    getChannelData: (c: number) => data[c],
  } as unknown as BufferLike & AudioBuffer;
}

/** A RIFF/WAVE file of `seconds` of silent PCM. */
function wavBytes(seconds: number, rate: number, channels: number, bytesPerSample: number): Uint8Array<ArrayBuffer> {
  const block = channels * bytesPerSample;
  const dataSize = Math.round(seconds * rate) * block;
  const out = new Uint8Array(44 + dataSize);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * block, true);
  v.setUint16(32, block, true);
  v.setUint16(34, bytesPerSample * 8, true);
  tag(36, 'data');
  v.setUint32(40, dataSize, true);
  if (bytesPerSample === 1) out.fill(128, 44);
  return out;
}

/** MPEG-1 Layer III bit rates (kbps) by header index. */
const L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

/**
 * An MP3 stream of `seconds` at 44.1 kHz (1152 samples per frame), frames
 * cycling through the given bit-rate indices (default 64 kbps), optionally
 * behind an ID3v2 tag of `id3Bytes`.
 */
function mp3Bytes(seconds: number, opts: { bitrates?: number[]; id3Bytes?: number } = {}): Uint8Array<ArrayBuffer> {
  const rates = opts.bitrates ?? [5];
  const frames = Math.round((seconds * 44100) / 1152);
  const id3 = opts.id3Bytes ?? 0;
  const sizes = Array.from({ length: frames }, (_, i) => Math.floor((144 * L3_KBPS[rates[i % rates.length]] * 1000) / 44100));
  const out = new Uint8Array((id3 ? 10 + id3 : 0) + sizes.reduce((a, b) => a + b, 0));
  let o = 0;
  if (id3) {
    out.set([0x49, 0x44, 0x33, 3, 0, 0, (id3 >> 21) & 0x7f, (id3 >> 14) & 0x7f, (id3 >> 7) & 0x7f, id3 & 0x7f]);
    o = 10 + id3;
  }
  sizes.forEach((size, i) => {
    out.set([0xff, 0xfb, rates[i % rates.length] << 4, 0xc4], o);
    o += size;
  });
  return out;
}

/** A decoder double: returns a buffer with the given duration, or fails. */
function decoder(result: { seconds: number } | 'fail'): DecoderLike & { received: ArrayBuffer[] } {
  const received: ArrayBuffer[] = [];
  return {
    received,
    async decodeAudioData(data: ArrayBuffer) {
      received.push(data);
      if (result === 'fail') throw new DOMException('Unable to decode audio data', 'EncodingError');
      const sr = 8000;
      const n = Math.round(result.seconds * sr);
      return fakeBuffer([Array.from({ length: n }, (_, i) => Math.sin(i / 10) * 0.5), Array.from({ length: n }, () => 0)], sr);
    },
  };
}

describe('checkAudioFile', () => {
  it('accepts WAV and MP3 by type or by extension', () => {
    expect(checkAudioFile({ name: 'loop.wav', type: 'audio/wav', size: 1000 })).toEqual({ ok: true });
    expect(checkAudioFile({ name: 'loop.WAV', type: '', size: 1000 })).toEqual({ ok: true });
    expect(checkAudioFile({ name: 'voice.mp3', type: 'application/octet-stream', size: 1000 })).toEqual({ ok: true });
    expect(checkAudioFile({ name: 'noext', type: 'audio/x-wav', size: 1000 })).toEqual({ ok: true });
    expect(checkAudioFile({ name: 'song.mp3', type: 'audio/mpeg', size: IMPORT_LIMITS.maxBytes })).toEqual({ ok: true });
  });

  it('rejects other types with a conversion hint', () => {
    const r = checkAudioFile({ name: 'song.flac', type: 'audio/flac', size: 1000 });
    expect(r).toEqual({ ok: false, message: '"song.flac" is not a WAV or MP3 file. Convert it to WAV or MP3 and try again.' });
    expect(checkAudioFile({ name: 'notes.txt', type: 'text/plain', size: 10 }).ok).toBe(false);
  });

  it('rejects files over 50 MB, stating the size and the limit', () => {
    const r = checkAudioFile({ name: 'big.wav', type: 'audio/wav', size: 72 * MB });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('72 MB');
      expect(r.message).toContain('50 MB');
    }
    expect(checkAudioFile({ name: 'empty.wav', type: 'audio/wav', size: 0 })).toEqual({ ok: false, message: '"empty.wav" is empty.' });
  });

  it('describes the limits for display before importing', () => {
    expect(IMPORT_LIMITS.maxBytes).toBe(50 * MB);
    expect(IMPORT_LIMITS.maxSeconds).toBe(60);
    expect(IMPORT_LIMITS.description).toMatch(/WAV or MP3/);
    expect(IMPORT_LIMITS.description).toMatch(/50 MB/);
    expect(IMPORT_LIMITS.description).toMatch(/60 seconds/);
  });

  it('derives storage types and names', () => {
    expect(audioMimeFor({ name: 'a.mp3', type: '', size: 1 })).toBe('audio/mpeg');
    expect(audioMimeFor({ name: 'a.mp3', type: 'audio/mp3', size: 1 })).toBe('audio/mpeg');
    expect(audioMimeFor({ name: 'a.wav', type: 'audio/wave', size: 1 })).toBe('audio/wave');
    expect(sampleNameFrom('my_cool_loop.wav')).toBe('my cool loop');
  });
});

describe('computePeaks', () => {
  it('returns min/max pairs across channels, clamped to -1..1', () => {
    const buf = fakeBuffer([
      [0, 0.5, -0.25, 0.1, 2, -3, 0, 0],
      [0, -0.75, 0, 0, 0, 0, 0.3, 0.2],
    ]);
    expect(computePeaks(buf, 4)).toEqual([-0.75, 0.5, -0.25, 0.1, -1, 1, 0, 0.3]);
    expect(computePeaks(fakeBuffer([[]]), 3)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(computePeaks(fakeBuffer([Array.from({ length: 10000 }, (_, i) => Math.sin(i))])).length).toBe(960);
  });
});

describe('decodeAudioFile', () => {
  it('decodes a copy of the bytes and builds valid metadata', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'Warm_Pad.wav', { type: 'audio/wav' });
    const dec = decoder({ seconds: 2 });
    const r = await decodeAudioFile(file, dec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta).toMatchObject({ name: 'Warm Pad', mime: 'audio/wav', byteLength: 4, duration: 2, sampleRate: 8000, channels: 2 });
    expect(r.meta.peaks).toHaveLength(960);
    expect(sanitizeSampleMeta(r.meta)).toEqual(r.meta);
    // The original bytes are kept intact even though the decoder received (and may detach) its own copy.
    expect([...new Uint8Array(await r.blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(dec.received[0].byteLength).toBe(4);
  });

  it('reports recordings that are too long with their actual duration', async () => {
    const file = new File([new Uint8Array([1])], 'long.mp3', { type: 'audio/mpeg' });
    const r = await decodeAudioFile(file, decoder({ seconds: 94.3 }));
    expect(r).toEqual({ ok: false, message: '"long.mp3" is 94.3 seconds long. The limit is 60 seconds — trim it and try again.' });
  });

  it('reports undecodable files with the export advice', async () => {
    const file = new File([new Uint8Array([9, 9, 9])], 'broken.wav', { type: 'audio/wav' });
    expect(await decodeAudioFile(file, decoder('fail'))).toEqual({ ok: false, message: DECODE_FAILED_MESSAGE });
    expect(DECODE_FAILED_MESSAGE).toBe('This file could not be decoded. Try exporting it as 16-bit WAV or MP3.');
  });

  it('refuses an over-long WAV from its header, before decoding it', async () => {
    // 8 kHz mono 8-bit: 94.3 s is only 754 KB, but would decode to tens of MB of float audio.
    const long = new File([wavBytes(94.3, 8000, 1, 1)], 'field.wav', { type: 'audio/wav' });
    const dec = decoder({ seconds: 94.3 });
    expect(await decodeAudioFile(long, dec)).toEqual({ ok: false, message: '"field.wav" is 94.3 seconds long. The limit is 60 seconds — trim it and try again.' });
    expect(dec.received).toHaveLength(0);
    // Within the limit it is decoded as usual (44.1 kHz stereo 16-bit).
    const ok = decoder({ seconds: 2 });
    expect((await decodeAudioFile(new File([wavBytes(2, 44100, 2, 2)], 'ok.wav', { type: 'audio/wav' }), ok)).ok).toBe(true);
    expect(ok.received).toHaveLength(1);
  });

  it('refuses an over-long MP3 from its frames, before decoding it', async () => {
    // Behind a 3 MB ID3 tag (cover art), 90 s of 64 kbps audio: a small file with a long recording.
    const bytes = mp3Bytes(90, { id3Bytes: 3 * MB });
    const file = new File([bytes], 'mix.mp3', { type: 'audio/mpeg' });
    const dec = decoder({ seconds: 90 });
    const r = await decodeAudioFile(file, dec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/^"mix\.mp3" is 90\.0 seconds long\. The limit is 60 seconds — trim it and try again\.$/);
    expect(dec.received).toHaveLength(0);
    // A short one goes on to the decoder.
    const ok = decoder({ seconds: 5 });
    expect((await decodeAudioFile(new File([mp3Bytes(5)], 'hit.mp3', { type: 'audio/mpeg' }), ok)).ok).toBe(true);
    expect(ok.received).toHaveLength(1);
  });

  it('reads MP3 length exactly for variable bit rates, and as a lower bound when the frames break off', () => {
    // First frame at the lowest bit rate (a quiet intro) must not inflate the estimate.
    const vbr = mp3Bytes(30, { bitrates: [1, 14, 9, 11] });
    const l = mp3Length(vbr.buffer)!;
    expect(l.seconds).toBeCloseTo(30, 1);
    expect(l.atLeast).toBe(false);
    // Damaged in the middle: what was read is a lower bound, said as such.
    const damaged = mp3Bytes(80);
    damaged.fill(0, Math.floor(damaged.length * 0.9), Math.floor(damaged.length * 0.9) + 2000);
    const d = mp3Length(damaged.buffer)!;
    expect(d.atLeast).toBe(true);
    expect(d.seconds).toBeGreaterThan(70);
    expect(d.seconds).toBeLessThan(80);
    // Not MP3 or WAV data: nothing to tell, the decoder decides.
    expect(mp3Length(new Uint8Array(4000).buffer)).toBeNull();
    expect(wavLength(new Uint8Array(4000).buffer)).toBeNull();
  });

  it('says "at least" when an MP3 is only readable in part', async () => {
    const bytes = mp3Bytes(80);
    bytes.fill(0, Math.floor(bytes.length * 0.9), Math.floor(bytes.length * 0.9) + 2000);
    const r = await decodeAudioFile(new File([bytes], 'part.mp3', { type: 'audio/mpeg' }), decoder('fail'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/^"part\.mp3" is at least 7\d\.\d seconds long\. The limit is 60 seconds — trim it and try again\.$/);
  });

  it('checks type and size before decoding', async () => {
    const dec = decoder({ seconds: 1 });
    const r = await decodeAudioFile(new File(['x'], 'clip.ogg', { type: 'audio/ogg' }), dec);
    expect(r.ok).toBe(false);
    expect(dec.received).toHaveLength(0);
  });
});
