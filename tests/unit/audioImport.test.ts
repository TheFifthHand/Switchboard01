import { describe, expect, it } from 'vitest';
import {
  DECODE_FAILED_MESSAGE,
  IMPORT_LIMITS,
  audioMimeFor,
  checkAudioFile,
  computePeaks,
  decodeAudioFile,
  sampleNameFrom,
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

  it('checks type and size before decoding', async () => {
    const dec = decoder({ seconds: 1 });
    const r = await decodeAudioFile(new File(['x'], 'clip.ogg', { type: 'audio/ogg' }), dec);
    expect(r.ok).toBe(false);
    expect(dec.received).toHaveLength(0);
  });
});
