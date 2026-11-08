/**
 * Round 7, the Song screen's editor in words and numbers: Shorter / Longer
 * step through musical lengths, the length reads in seconds, "Plays 2
 * places", and "Try a ready-made loop…" offers an instrument its own kind of
 * loop, in the song's key, filling the loop it goes into.
 */
import { describe, expect, it } from 'vitest';
import { longerBars, loopSecondsText, placesText, shorterBars } from '../../src/app/views/arrange/editorStore';
import { realizeFor } from '../../src/app/views/arrange/library/libraryModel';
import { fitReadyLoop, readyLoopsFor } from '../../src/app/views/arrange/library/readyLoops';
import { isInScale } from '../../src/music/scales';
import { getStarter } from '../../src/content/starters';
import { TICKS_PER_BAR } from '../../src/project/types';

describe('Shorter and Longer', () => {
  it('halve and double, and stop at the ends', () => {
    expect(longerBars(1)).toBe(2);
    expect(longerBars(2)).toBe(4);
    expect(longerBars(3)).toBe(4);
    expect(longerBars(4)).toBe(8);
    expect(longerBars(8)).toBeNull();
    expect(shorterBars(8)).toBe(4);
    expect(shorterBars(3)).toBe(2);
    expect(shorterBars(2)).toBe(1);
    expect(shorterBars(1)).toBeNull();
  });

  it('say the length in seconds at the song’s speed', () => {
    expect(loopSecondsText(1, 120)).toBe('2 seconds');
    expect(loopSecondsText(2, 124)).toBe('3.9 seconds');
    expect(loopSecondsText(8, 90)).toBe('21 seconds');
    expect(loopSecondsText(1, 240)).toBe('1 second');
  });
});

describe('where a loop plays, in Simple’s words', () => {
  it('counts places, never bars', () => {
    expect(placesText(1)).toBe('Plays only here');
    expect(placesText(2)).toBe('Plays 2 places');
    expect(placesText(5)).toBe('Plays 5 places');
  });
});

describe('ready-made loops', () => {
  it('an instrument gets its own kind of loop: bass loops for a bass, chords for keys; none for a recording', () => {
    const bass = readyLoopsFor('bass', 'bass');
    expect(bass.length).toBeGreaterThan(5);
    expect(bass.every((l) => l.role === 'bass')).toBe(true);
    const chords = readyLoopsFor('chords', 'poly');
    expect(chords.length).toBeGreaterThan(5);
    expect(chords.every((l) => l.role === 'chords')).toBe(true);
    // A drum kit never gets a pitched loop, and a percussion part gets percussion loops.
    expect(readyLoopsFor('bass', 'drums')).toEqual([]);
    expect(readyLoopsFor('percussion', 'drums').every((l) => l.role === 'percussion')).toBe(true);
    expect(readyLoopsFor('vocal' as never, 'sampler')).toEqual([]);
  });

  it('a loop’s notes are in the song’s key and repeat to fill a longer loop', () => {
    const p = getStarter('house')!.build();
    const bassTrack = p.tracks.find((t) => t.role === 'bass')!;
    for (const loop of readyLoopsFor(bassTrack.role, bassTrack.instrument.kind)) {
      const r = realizeFor(p, loop, bassTrack)!;
      if (p.scale !== 'chromatic') for (const n of r.notes) expect(isInScale(n.pitch, p.root, p.scale), `${loop.id} ${n.pitch}`).toBe(true);
      // Into an 8-bar loop: repeated to 8 bars when it divides 8, else its own length.
      const fit = fitReadyLoop(r, 8);
      expect(fit.bars).toBe(8 % r.bars === 0 ? 8 : r.bars);
      expect(fit.notes.length).toBe(r.notes.length * (fit.bars / r.bars));
      expect(fit.notes.every((n) => n.tick >= 0 && n.tick < fit.bars * TICKS_PER_BAR)).toBe(true);
    }
  });

  it('a loop shorter than the library loop takes the library loop’s length', () => {
    const fit = fitReadyLoop({ bars: 2, notes: [{ tick: 0, pitch: 40, velocity: 1, duration: 24 }, { tick: 400, pitch: 43, velocity: 1, duration: 24 }] }, 1);
    expect(fit.bars).toBe(2);
    expect(fit.notes.map((n) => n.tick)).toEqual([0, 400]);
    const odd = fitReadyLoop({ bars: 2, notes: [{ tick: 0, pitch: 40, velocity: 1, duration: 24 }] }, 3);
    expect(odd.bars).toBe(2);
  });
});
