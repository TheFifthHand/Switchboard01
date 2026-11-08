/**
 * "Smaller file for sharing": the browser's Opus encoder (WebCodecs) and our
 * Ogg writer make a file the browser itself decodes back, with every page's
 * CRC right, the length of the source audio (the last granule trims the
 * encoder's padding) and the music in it (not silent, the right pitch).
 */
import { describe, expect, it } from 'vitest';
import { OGG_BOS, OGG_EOS, parseOggPages, preSkipOf } from '../../src/render/ogg';
import { OPUS_RATE, encodeOggOpus, opusSupported } from '../../src/render/opus';

/** A 440 Hz tone at −12 dBFS on the left, 660 Hz on the right. */
function tones(seconds: number): Float32Array[] {
  const n = Math.round(seconds * OPUS_RATE);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / OPUS_RATE);
    r[i] = 0.25 * Math.sin((2 * Math.PI * 660 * i) / OPUS_RATE);
  }
  return [l, r];
}

/** Zero crossings per second ≈ 2 × frequency. */
function frequency(x: Float32Array, rate: number): number {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 !== x[i] < 0) n++;
  return n / 2 / (x.length / rate);
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

describe('Ogg Opus export', () => {
  it('Chromium can encode Opus (the format is offered here)', async () => {
    expect(await opusSupported()).toBe(true);
  });

  it('pages carry right CRCs, header pages come first, the last page ends the stream at the source length', async () => {
    const src = tones(3.3);
    const bytes = await encodeOggOpus(src, { title: 'Test song' });
    const pages = parseOggPages(bytes);
    expect(pages.length).toBeGreaterThan(4);
    expect(pages.every((p) => p.crcOk)).toBe(true);
    expect(pages[0].flags & OGG_BOS).toBeTruthy();
    expect(new TextDecoder().decode(pages[0].packets[0].subarray(0, 8))).toBe('OpusHead');
    expect(new TextDecoder().decode(pages[1].packets[0].subarray(0, 8))).toBe('OpusTags');
    expect(new TextDecoder().decode(pages[1].packets[0])).toContain('TITLE=Test song');
    const last = pages[pages.length - 1];
    expect(last.flags & OGG_EOS).toBeTruthy();
    const preSkip = preSkipOf(pages[0].packets[0])!;
    expect(last.granule - preSkip).toBe(src[0].length);
    expect(pages.map((p) => p.sequence)).toEqual(pages.map((_, i) => i));
    // About 128 kbps: 3.3 s is far smaller than its 16-bit WAV (633 kB).
    expect(bytes.length).toBeLessThan(80_000);
  });

  it('the browser decodes the file back: same length, not silent, the same tones', async () => {
    const src = tones(2.5);
    const bytes = await encodeOggOpus(src);
    const ctx = new OfflineAudioContext(2, 1, OPUS_RATE);
    const decoded = await ctx.decodeAudioData(bytes.slice().buffer);
    expect(Math.abs(decoded.duration - 2.5)).toBeLessThan(0.03);
    const l = decoded.getChannelData(0);
    const r = decoded.getChannelData(1);
    expect(rms(l)).toBeGreaterThan(0.12);
    expect(rms(r)).toBeGreaterThan(0.12);
    const mid = (x: Float32Array) => x.subarray(Math.round(0.2 * OPUS_RATE), Math.round(2.2 * OPUS_RATE));
    expect(Math.abs(frequency(mid(l), decoded.sampleRate) - 440)).toBeLessThan(5);
    expect(Math.abs(frequency(mid(r), decoded.sampleRate) - 660)).toBeLessThan(5);
  });
});
