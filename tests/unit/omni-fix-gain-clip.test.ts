/**
 * A gain edit that pushes peaks over full scale: the version that plays right
 * away (the sample bank gets the edit's channels) must sound like the WAV that
 * is stored and reloaded later. Both are clipped at full scale, and the user is
 * still told that it clipped.
 */
import { describe, expect, it } from 'vitest';
import { applySampleEdit, editSummary, peakOf } from '../../src/app/views/sampler/sampleEdit';
import { encodeMadeAudio } from '../../src/persistence/audioImport';
import { parseWav } from '../../src/render/wav';

describe('Gain edit over full scale', () => {
  it('plays exactly what is stored: the edit is clipped like the WAV, and the message says it clipped', async () => {
    const sr = 48000;
    const ch = new Float32Array(sr);
    for (let i = 0; i < sr; i++) ch[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sr);
    const source = Float32Array.from(ch);
    const res = applySampleEdit([ch], sr, 0, 1, { kind: 'gain', db: 12 });
    if (!res.ok) throw new Error(res.message);
    // What the part plays now (sampleVersions hands res.channels to the bank).
    expect(peakOf(res.channels)).toBeLessThanOrEqual(1);
    // What the project keeps.
    const made = encodeMadeAudio('v', res.channels, sr);
    if (!made.ok) throw new Error(made.message);
    const stored = parseWav(await made.blob.arrayBuffer());
    let worst = 0;
    for (let i = 0; i < sr; i++) worst = Math.max(worst, Math.abs(res.channels[0][i] - stored.channels[0][i]));
    // Only 24-bit rounding apart (about -138 dBFS), not a clipped-versus-unclipped difference.
    expect(worst).toBeLessThan(1e-6);
    // The edit really was louder, and the user is told the peaks clipped.
    expect(res.peak).toBeGreaterThan(1.9);
    expect(editSummary({ kind: 'gain', db: 12 }, res)).toMatch(/clipped/);
    // The source (maybe the buffer playing now) is untouched.
    expect(ch).toEqual(source);
  });

  it('an edit that stays under full scale is not changed by the clipping', () => {
    const ch = new Float32Array(1000).map((_, i) => 0.25 * Math.sin(i / 7));
    const res = applySampleEdit([ch], 48000, 0, 1, { kind: 'gain', db: 6 });
    if (!res.ok) throw new Error(res.message);
    const g = 10 ** (6 / 20);
    for (let i = 0; i < ch.length; i++) expect(res.channels[0][i]).toBeCloseTo(ch[i] * g, 6);
    expect(editSummary({ kind: 'gain', db: 6 }, res)).not.toMatch(/clipped/);
  });
});
