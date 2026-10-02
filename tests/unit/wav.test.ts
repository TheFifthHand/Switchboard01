import { describe, expect, it } from 'vitest';
import { encodeWav, parseWav, wavBlob, wavDuration } from '../../src/render/wav';

function sine(n: number, freq: number, sr: number, amp = 0.5, phase = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr + phase);
  return out;
}

function ascii(view: DataView, off: number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(view.getUint8(off + i));
  return s;
}

describe('encodeWav', () => {
  it('writes a canonical RIFF/WAVE PCM header', () => {
    const sr = 48000;
    const L = sine(1000, 440, sr);
    const R = sine(1000, 660, sr);
    for (const bits of [16, 24] as const) {
      const buf = encodeWav([L, R], sr, bits);
      const v = new DataView(buf);
      const bytes = bits / 8;
      expect(ascii(v, 0, 4)).toBe('RIFF');
      expect(v.getUint32(4, true)).toBe(buf.byteLength - 8);
      expect(ascii(v, 8, 4)).toBe('WAVE');
      expect(ascii(v, 12, 4)).toBe('fmt ');
      expect(v.getUint32(16, true)).toBe(16);
      expect(v.getUint16(20, true)).toBe(1); // PCM
      expect(v.getUint16(22, true)).toBe(2);
      expect(v.getUint32(24, true)).toBe(sr);
      expect(v.getUint32(28, true)).toBe(sr * 2 * bytes);
      expect(v.getUint16(32, true)).toBe(2 * bytes);
      expect(v.getUint16(34, true)).toBe(bits);
      expect(ascii(v, 36, 4)).toBe('data');
      expect(v.getUint32(40, true)).toBe(1000 * 2 * bytes);
      expect(buf.byteLength).toBe(44 + 1000 * 2 * bytes);
    }
  });

  it('round-trips 16-bit (undithered) and 24-bit audio within one quantization step', () => {
    const sr = 44100;
    const L = sine(4410, 1000, sr, 0.9);
    const R = sine(4410, 250, sr, 0.3, 1);
    for (const [bits, step] of [
      [16, 1 / 32767],
      [24, 1 / 8388607],
    ] as const) {
      const parsed = parseWav(encodeWav([L, R], sr, bits, { dither: false }));
      expect(parsed.sampleRate).toBe(sr);
      expect(parsed.bitDepth).toBe(bits);
      expect(parsed.format).toBe('pcm');
      expect(parsed.channels).toHaveLength(2);
      for (const [src, out] of [
        [L, parsed.channels[0]],
        [R, parsed.channels[1]],
      ] as const) {
        expect(out.length).toBe(src.length);
        let maxErr = 0;
        for (let i = 0; i < src.length; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - src[i]));
        expect(maxErr).toBeLessThanOrEqual(step * 0.5 + 1e-7);
      }
    }
  });

  it('interleaves channels in frame order', () => {
    const buf = encodeWav([new Float32Array([1, 0]), new Float32Array([-1, 0.5])], 8000, 16, { dither: false });
    const v = new DataView(buf);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)]).toEqual([32767, -32768, 0, 16384]);
  });

  it('clamps out-of-range and non-finite samples and is deterministic', () => {
    const x = new Float32Array([2, -3, Number.NaN, Number.POSITIVE_INFINITY, 0.25]);
    const a = encodeWav([x], 22050, 24);
    const b = encodeWav([x], 22050, 24);
    expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
    const back = parseWav(a).channels[0];
    expect(Array.from(back).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, -1, 0, 0, 0.25]);
  });

  it('pads shorter channels with silence and reports duration', () => {
    const buf = encodeWav([new Float32Array(48000), new Float32Array(100).fill(0.5)], 48000, 16);
    expect(wavDuration(buf)).toBe(1);
    const parsed = parseWav(buf);
    expect(parsed.channels[1].length).toBe(48000);
    expect(parsed.channels[1][99]).toBeCloseTo(0.5, 4);
    expect(parsed.channels[1][100]).toBe(0);
  });

  it('rejects invalid arguments', () => {
    expect(() => encodeWav([], 48000, 16)).toThrow();
    expect(() => encodeWav([new Float32Array(1)], 0, 16)).toThrow();
    expect(() => encodeWav([new Float32Array(1)], 48000, 12 as 16)).toThrow();
  });

  it('makes an audio/wav Blob', async () => {
    const blob = wavBlob([new Float32Array(10)], 48000, 16);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 20);
    expect(parseWav(await blob.arrayBuffer()).channels[0].length).toBe(10);
  });
});

describe('parseWav', () => {
  it('reads IEEE float files and skips unknown chunks', () => {
    // RIFF + fmt(float, mono, 32-bit) + LIST chunk (odd size, padded) + data
    const samples = [0.5, -0.25, 1.5];
    const listSize = 5;
    const size = 12 + 24 + 8 + listSize + 1 + 8 + samples.length * 4;
    const buf = new ArrayBuffer(size);
    const v = new DataView(buf);
    const w = (off: number, s: string) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
    w(0, 'RIFF');
    v.setUint32(4, size - 8, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 3, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 32000, true);
    v.setUint32(28, 32000 * 4, true);
    v.setUint16(32, 4, true);
    v.setUint16(34, 32, true);
    w(36, 'LIST');
    v.setUint32(40, listSize, true);
    w(44, 'abcde');
    const dataAt = 44 + listSize + 1;
    w(dataAt, 'data');
    v.setUint32(dataAt + 4, samples.length * 4, true);
    samples.forEach((s, i) => v.setFloat32(dataAt + 8 + i * 4, s, true));
    const parsed = parseWav(buf);
    expect(parsed).toMatchObject({ sampleRate: 32000, bitDepth: 32, format: 'float' });
    expect(Array.from(parsed.channels[0])).toEqual(samples);
  });

  /** A RIFF/WAVE file built from chunks (each padded to an even size). */
  function riff(chunks: [string, Uint8Array][], riffSize?: number): ArrayBuffer {
    const total = 12 + chunks.reduce((s, [, b]) => s + 8 + b.length + (b.length & 1), 0);
    const out = new Uint8Array(total);
    const v = new DataView(out.buffer);
    const w = (off: number, s: string) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
    w(0, 'RIFF');
    v.setUint32(4, riffSize ?? total - 8, true);
    w(8, 'WAVE');
    let off = 12;
    for (const [id, body] of chunks) {
      w(off, id);
      v.setUint32(off + 4, body.length, true);
      out.set(body, off + 8);
      off += 8 + body.length + (body.length & 1);
    }
    return out.buffer;
  }

  function fmt16(channels: number, sr: number): Uint8Array {
    const b = new Uint8Array(16);
    const v = new DataView(b.buffer);
    v.setUint16(0, 1, true);
    v.setUint16(2, channels, true);
    v.setUint32(4, sr, true);
    v.setUint32(8, sr * channels * 2, true);
    v.setUint16(12, channels * 2, true);
    v.setUint16(14, 16, true);
    return b;
  }

  it('pads an odd-sized data chunk (mono 24-bit, odd frame count) to keep the RIFF word alignment', () => {
    const x = new Float32Array([0.5, -0.5, 0.25]);
    const buf = encodeWav([x], 44100, 24);
    const v = new DataView(buf);
    expect(v.getUint32(40, true)).toBe(9); // the data size itself is not padded
    expect(buf.byteLength).toBe(44 + 9 + 1);
    expect(v.getUint32(4, true)).toBe(buf.byteLength - 8);
    expect(wavDuration(buf)).toBeCloseTo(3 / 44100, 12);
    expect(Array.from(parseWav(buf).channels[0]).map((s) => Math.round(s * 1e6) / 1e6)).toEqual([0.5, -0.5, 0.25]);
  });

  it('reads an empty data chunk as no audio, even when other chunks follow it', () => {
    const buf = riff([
      ['fmt ', fmt16(1, 8000)],
      ['data', new Uint8Array(0)],
      ['LIST', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])],
    ]);
    expect(parseWav(buf).channels[0].length).toBe(0);
    expect(wavDuration(buf)).toBe(0);
  });

  it('reads to the end of the file when a streaming writer left the sizes unset', () => {
    const pcm = new Uint8Array(8); // 4 mono 16-bit frames
    new DataView(pcm.buffer).setInt16(6, -16384, true);
    const unset = new DataView(riff([['fmt ', fmt16(1, 8000)], ['data', pcm]], 0));
    unset.setUint32(40, 0, true);
    expect(parseWav(unset.buffer).channels[0]).toEqual(new Float32Array([0, 0, 0, -0.5]));
    const ffff = new DataView(riff([['fmt ', fmt16(1, 8000)], ['data', pcm]]));
    ffff.setUint32(40, 0xffffffff, true);
    expect(wavDuration(ffff.buffer)).toBe(4 / 8000);
  });

  it('finds the data chunk before or after fmt, and wavDuration agrees with parseWav', () => {
    const pcm = new Uint8Array(12); // 3 stereo 16-bit frames
    const buf = riff([
      ['data', pcm],
      ['fmt ', fmt16(2, 16000)],
    ]);
    expect(parseWav(buf).channels.map((c) => c.length)).toEqual([3, 3]);
    expect(wavDuration(buf)).toBe(3 / 16000);
    expect(() => wavDuration(new Uint8Array(64).buffer)).toThrow(/Not a WAV/);
  });

  it('rejects files that are not WAV', () => {
    expect(() => parseWav(new ArrayBuffer(8))).toThrow(/Not a WAV/);
    const junk = new Uint8Array(64);
    junk.set([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]); // RIFF....WAVE, no chunks
    expect(() => parseWav(junk.buffer)).toThrow(/fmt/);
  });
});
