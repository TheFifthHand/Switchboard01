/**
 * Recording into the song (time/songTake.ts): the notes caught during a take
 * become the take put in the song, with Record Notes' rules (early notes on
 * the downbeat, quantize, held notes closed at the stop).
 */
import { describe, expect, it } from 'vitest';
import { MIN_TAKE_NOTE_TICKS, songTakeFrom, type TakeCapture, type TakeEvent } from '../../src/time/songTake';
import { RECORD_EARLY_TICKS } from '../../src/time/recordWindow';

const BAR = 384;

const on = (tick: number, pitch: number, key = `k${pitch}`, extra: Partial<Extract<TakeEvent, { kind: 'on' }>> = {}): TakeEvent => ({ kind: 'on', tick, key, pitch, velocity: 0.8, ...extra });
const off = (tick: number, pitch: number, key = `k${pitch}`): TakeEvent => ({ kind: 'off', tick, key });
const take = (events: TakeEvent[], over: Partial<TakeCapture> = {}) =>
  songTakeFrom({ trackId: 't1', startBar: 4, events, stopTick: 2 * BAR, quantize: 'off', ...over });

describe('songTakeFrom', () => {
  it('keeps each note where it was played, as long as it was held, from the start bar', () => {
    const t = take([on(10, 60), off(100, 60), on(BAR + 5, 64), off(BAR + 200, 64)]);
    expect(t).toEqual({
      trackId: 't1',
      startBar: 4,
      bars: 2,
      notes: [
        { tick: 10, pitch: 60, velocity: 0.8, duration: 90 },
        { tick: BAR + 5, pitch: 64, velocity: 0.8, duration: 195 },
      ],
    });
  });

  it('overlapping notes (other keys, the same pitch from two keys) are all kept', () => {
    const t = take([on(0, 60), on(50, 64), on(60, 60, 'mouse'), off(100, 64), off(200, 60), off(300, 60, 'mouse')]);
    expect(t.notes.map((n) => [n.tick, n.pitch, n.duration])).toEqual([[0, 60, 200], [50, 64, 50], [60, 60, 240]]);
  });

  it('a key pressed again before its release ends the earlier note there', () => {
    const t = take([on(0, 60), on(96, 60), off(150, 60)]);
    expect(t.notes.map((n) => [n.tick, n.duration])).toEqual([[0, 96], [96, 54]]);
  });

  it('a key still held at the stop ends at the stop; a tap is at least the shortest note', () => {
    const t = take([on(BAR, 48), on(BAR + 10, 50), off(BAR + 11, 50)], { stopTick: BAR + 300 });
    expect(t.bars).toBe(2);
    expect(t.notes).toEqual([
      { tick: BAR, pitch: 48, velocity: 0.8, duration: 300 },
      { tick: BAR + 10, pitch: 50, velocity: 0.8, duration: MIN_TAKE_NOTE_TICKS },
    ]);
  });

  it('notes before the start: up to an 8th early on the downbeat (length from the press), earlier ones dropped with their release', () => {
    const t = take([on(-RECORD_EARLY_TICKS, 60), off(100, 60), on(-RECORD_EARLY_TICKS - 1, 62), off(50, 62), on(-BAR / 2, 64)]);
    expect(t.notes).toEqual([{ tick: 0, pitch: 60, velocity: 0.8, duration: 100 + RECORD_EARLY_TICKS }]);
  });

  it('quantize snaps starts to the grid, not lengths; arpeggiator notes keep their place', () => {
    const t = take([on(13, 60), off(50, 60), on(37, 62), off(40, 62), on(37, 64, 'arp:1', { quantize: false }), off(61, 64, 'arp:1')], { quantize: '1/16' });
    expect(t.notes.map((n) => [n.tick, n.pitch, n.duration])).toEqual([[24, 60, 37], [37, 64, 24], [48, 62, MIN_TAKE_NOTE_TICKS]]);
  });

  it('a note quantized past where the take stopped makes the take a bar longer; same tick and pitch: the last one wins', () => {
    const t = take([on(BAR - 5, 60), off(BAR - 1, 60), on(3, 62, 'a'), off(10, 62, 'a'), on(4, 62, 'b', { velocity: 0.3 }), off(20, 62, 'b')], { quantize: '1/4', stopTick: BAR - 2 });
    expect(t.bars).toBe(2);
    expect(t.notes).toEqual([
      { tick: 0, pitch: 62, velocity: 0.3, duration: 16 },
      { tick: BAR, pitch: 60, velocity: 0.8, duration: MIN_TAKE_NOTE_TICKS },
    ]);
  });

  it('a take longer than 8 bars stays one take (the command splits it into song clips); notes end with the take', () => {
    const t = take([on(0, 60), off(BAR, 60), on(9 * BAR + 10, 62), off(13 * BAR, 62)], { stopTick: 10 * BAR + 20 });
    expect(t.bars).toBe(11);
    expect(t.notes.map((n) => [n.tick, n.duration])).toEqual([[0, BAR], [9 * BAR + 10, 11 * BAR - (9 * BAR + 10)]]);
  });

  it('started mid-song: ticks count from its start bar, which the take keeps', () => {
    const t = songTakeFrom({ trackId: 't2', startBar: 37, events: [on(BAR * 2 + 7, 70), off(BAR * 2 + 50, 70)], stopTick: 3 * BAR - 1, quantize: 'off' });
    expect(t).toMatchObject({ trackId: 't2', startBar: 37, bars: 3, notes: [{ tick: 2 * BAR + 7, duration: 43 }] });
  });

  it('the song looping while recording: passes merge, a note held across the loop end ends there, the take reaches the loop end', () => {
    // Loop end 2 bars after the start: the second pass comes back to tick 0.
    const until = 2 * BAR;
    const t = take(
      [on(BAR + 300, 60, 'k', { until }), off(20, 60, 'k'), on(10, 62, 'j', { until }), off(30, 62, 'j')],
      { stopTick: 40, reachedTick: until - 1 },
    );
    expect(t.bars).toBe(2);
    expect(t.notes.map((n) => [n.tick, n.pitch, n.duration])).toEqual([[10, 62, 20], [BAR + 300, 60, until - (BAR + 300)]]);
  });

  it('nothing played: an empty take of one bar (the command refuses it with its message)', () => {
    expect(take([], { stopTick: 0 })).toEqual({ trackId: 't1', startBar: 4, bars: 1, notes: [] });
    expect(take([on(-BAR, 60), off(-10, 60)], { stopTick: -5 }).notes).toEqual([]);
  });

  it('never longer than the room the song has after its start', () => {
    const t = take([on(0, 60), off(10, 60), on(3 * BAR, 61), off(3 * BAR + 10, 61)], { stopTick: 5 * BAR, maxBars: 2 });
    expect(t.bars).toBe(2);
    expect(t.notes.map((n) => n.pitch)).toEqual([60]);
  });
});
