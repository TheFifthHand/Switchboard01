/**
 * Exporting the song loop (its bars once, with the tail) through the real
 * session and engine: the WAV is exactly as long as the loop's bars plus the
 * tail (an export starts on the music's first downbeat, MIX-04), and its
 * music is what the song render has over those bars.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../../src/app/session';
import { createClip, createProject } from '../../src/project/factory';
import type { Clip, ClipBars, Id, Project } from '../../src/project/types';
import { rms } from '../../src/render/analysis';
import { parseWav } from '../../src/render/wav';
import { deleteDb } from '../../src/persistence/db';

const SR = 48000;

function clip(name: string, bars: ClipBars, notes: [tick: number, pitch: number, duration: number][]): Clip {
  return createClip(name, bars, notes.map(([tick, pitch, duration]) => ({ tick, pitch, duration, velocity: 0.9 })));
}
const track = (p: Project, id: Id) => p.tracks.find((t) => t.id === id)!;

/** Dry (no reverb or delay sends) song at 120 BPM: row 0 for a bar, row 1 for two, rows 2 and 3 a bar each; bass and chords, notes ending inside each bar. */
function drySong(): Project {
  const p = createProject({ bpm: 120, now: 0 });
  p.seed = 7;
  for (const t of p.tracks) {
    t.clips = t.clips.map(() => null);
    t.macros.space = 0;
    t.macros.echo = 0;
  }
  for (let row = 0; row < 4; row++) {
    track(p, 't3').clips[row] = clip(`bass${row}`, 1, [[0, 36 + 2 * row, 96], [192, 43 + 2 * row, 96]]);
    track(p, 't4').clips[row] = clip(`chord${row}`, 1, [[0, 60 + row, 240], [0, 64 + row, 240]]);
  }
  const at = [0, 1, 3, 4];
  p.arrangement = {
    tailSeconds: 1,
    sections: [],
    regions: [0, 1, 2, 3].flatMap((row) => ['t3', 't4'].map((t) => ({ id: `${t}:${row}`, trackId: t, clipId: track(p, t).clips[row]!.id, start: at[row], bars: row === 1 ? 2 : 1, offset: 0 }))),
  };
  return p;
}

let live: Session[] = [];
beforeEach(async () => {
  await deleteDb();
});
afterEach(async () => {
  for (const s of live) s.dispose();
  live = [];
  await deleteDb();
});

async function wav(s: Session, source: Parameters<Session['renderWav']>[0]['source'], tail: number) {
  const blob = await s.renderWav({ source, sampleRate: SR, bitDepth: 24, tailSeconds: tail });
  return parseWav(await blob.arrayBuffer());
}

describe('Export: the loop', () => {
  it('the WAV is the loop’s bars plus the tail, and plays what the song plays over those bars', async () => {
    const s = new Session(drySong());
    live.push(s);
    // Bars 2–4: 3 bars at 120 BPM = 6 s, from 2 s into the song.
    const loop = await wav(s, { kind: 'songRange', fromBar: 1, toBar: 4 }, 1.5);
    expect(loop.sampleRate).toBe(SR);
    expect(loop.channels[0].length).toBe(Math.round((6 + 1.5) * SR));
    const song = await wav(s, { kind: 'song' }, 1.5);
    expect(song.channels[0].length).toBe(Math.round((10 + 1.5) * SR));
    // Bar by bar (each 2 s), the loop file and the song file sound the same: same level, and their
    // difference is small next to the music (24-bit files of the same engine and notes).
    for (let bar = 0; bar < 3; bar++) {
      for (const ch of [0, 1]) {
        const a = loop.channels[ch].subarray(Math.round(bar * 2 * SR), Math.round((bar * 2 + 2) * SR));
        const off = Math.round((2 + bar * 2) * SR);
        const b = song.channels[ch].subarray(off, off + a.length);
        const d = new Float32Array(a.length);
        for (let i = 0; i < a.length; i++) d[i] = a[i] - b[i];
        expect(rms(a)).toBeGreaterThan(0.01);
        expect(rms(a) / rms(b)).toBeGreaterThan(0.97);
        expect(rms(a) / rms(b)).toBeLessThan(1.03);
        expect(rms(d) / rms(b)).toBeLessThan(0.05);
      }
    }
    // After the loop's last bar nothing new starts: the tail only rings out.
    const tail = loop.channels[0].subarray(Math.round(6.5 * SR));
    const songNext = song.channels[0].subarray(Math.round(8.0 * SR), Math.round(8.5 * SR));
    expect(rms(tail)).toBeLessThan(rms(songNext) * 0.05);
  });

  it('a loop starting inside a held note: the note sounds from the loop’s first bar, as the song plays it there (note chase)', async () => {
    // Chords hold one note through bars 1–4 (a 4-bar clip); export bars 3–4.
    const p = drySong();
    track(p, 't4').clips[0] = clip('pad', 4, [[0, 57, 4 * 384]]);
    p.arrangement = { tailSeconds: 0, sections: [], regions: [{ id: 'pad', trackId: 't4', clipId: track(p, 't4').clips[0]!.id, start: 0, bars: 4, offset: 0 }] };
    const s = new Session(p);
    live.push(s);
    const loop = await wav(s, { kind: 'songRange', fromBar: 2, toBar: 4 }, 0);
    const song = await wav(s, { kind: 'song' }, 0);
    expect(loop.channels[0].length).toBe(4 * SR);
    // Bars 3–4 are 4 s from 4 s into the song. The loop file is not silent there (it was, before notes were chased).
    const a = loop.channels[0];
    const b = song.channels[0].subarray(4 * SR, 8 * SR);
    expect(rms(a)).toBeGreaterThan(0.01);
    expect(rms(a)).toBeGreaterThan(rms(b) * 0.5);
    // Once its attack is over it sounds at the song's level (the same note, held).
    const late = (x: Float32Array) => rms(x.subarray(2 * SR, 4 * SR));
    expect(late(a) / late(b)).toBeGreaterThan(0.8);
    expect(late(a) / late(b)).toBeLessThan(1.25);
  });
});
