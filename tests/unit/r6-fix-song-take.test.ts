/**
 * Review probes: a take recorded in the Song view (time/songTake.ts → commands/songClips.ts recordTakeIntoSong).
 */
import { describe, expect, it } from 'vitest';
import { songStore } from './r5-song-fixtures';
import * as cmd from '../../src/state/commands';
import { songTakeFrom, type TakeEvent } from '../../src/time/songTake';
import { TICKS_PER_BAR } from '../../src/project/types';

describe('arpeggiator notes in a song take', () => {
  it('stay on the arpeggiator grid (session hands songTakeFrom output straight to recordTakeIntoSong)', () => {
    const { store } = songStore();
    expect(store.getState().settings.recordQuantize).toBe('1/16'); // the default
    // One held key, arpeggiator at 1/32 (12 ticks), 1 octave: the same pitch every 12 ticks, as session.recordArpNote captures it.
    const events: TakeEvent[] = [];
    for (let i = 0; i < 16; i++) {
      events.push({ kind: 'on', tick: i * 12, key: `arp:${i}`, pitch: 60, velocity: 0.8, quantize: false });
      events.push({ kind: 'off', tick: i * 12 + 6, key: `arp:${i}` });
    }
    const take = songTakeFrom({ trackId: 't5', startBar: 0, events, stopTick: TICKS_PER_BAR, quantize: '1/16', maxBars: 512 });
    expect(take.notes.map((n) => n.tick)).toEqual([0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132, 144, 156, 168, 180]);
    const r = cmd.recordTakeIntoSong(store, take);
    expect(r.changed).toBe(true);
    const t = store.getState().tracks.find((x) => x.id === 't5')!;
    const clip = t.songClips![0];
    // What was heard: 16 notes, 12 ticks apart. What gets stored:
    expect(clip.notes.map((n) => n.tick)).toEqual([0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132, 144, 156, 168, 180]);
  });
});

describe('a take whose length is not 1, 2, 4 or 8 bars', () => {
  it('only replaces the bars that were recorded', () => {
    const { store, clip } = songStore();
    // Bass "Walk" (2 bars) plays bars 5-6.
    expect(cmd.addRegions(store, [{ trackId: 't3', clipId: clip.Walk, start: 5, bars: 2 }]).changed).toBe(true);
    const take = songTakeFrom({
      trackId: 't3', startBar: 0, quantize: '1/16', maxBars: 512,
      events: [{ kind: 'on', tick: 0, key: 'a', pitch: 40, velocity: 0.8 }, { kind: 'off', tick: 48, key: 'a' }],
      stopTick: 5 * TICKS_PER_BAR - 10, // stopped just before bar 6: a 5-bar take
    });
    expect(take.bars).toBe(5);
    expect(cmd.recordTakeIntoSong(store, take).changed).toBe(true);
    const p = store.getState();
    const regions = p.arrangement.regions.filter((r) => r.trackId === 't3');
    // The take covered bars 1-5 (0-based 0-4). Walk at bars 6-7 (0-based 5-6) was never recorded over.
    expect(regions.map((r) => `${r.clipId === clip.Walk ? 'Walk' : 'take'}@${r.start}+${r.bars}`)).toEqual(['take@0+5', 'Walk@5+2']);
  });
});
