/**
 * PLAY-25: Record Notes keeps a note played a little before the recording
 * starts (up to an 8th note before its downbeat), snapped to the downbeat;
 * earlier notes are not recorded. In song playback, a block that does not
 * play the target clip still records into it, where its loop would be.
 */
import { describe, expect, it } from 'vitest';
import { RECORD_EARLY_TICKS, recordedNoteAt } from '../../src/time/recordWindow';

const BAR = 384;

describe('Record Notes window', () => {
  it('an 8th note is the early window', () => {
    expect(RECORD_EARLY_TICKS).toBe(48);
  });

  it('a note 1/8 before the downbeat is recorded at tick 0; a note half a bar early is not', () => {
    // Waiting for the clip launched at bar 2 (tick 768); the part still plays another clip (slot 0).
    const waiting = { playing: { slot: 0, startTick: 0 }, slot: 1, startsAt: 2 * BAR };
    const early = recordedNoteAt({ ...waiting, tick: 2 * BAR - 48 });
    expect(early).toEqual({ tick: 768, loopStart: 768 });
    // Its place in the clip: tick − loopStart = 0.
    expect(early!.tick - early!.loopStart).toBe(0);
    expect(recordedNoteAt({ ...waiting, tick: 2 * BAR - 192 })).toBeNull();
    expect(recordedNoteAt({ ...waiting, tick: 2 * BAR - 49 })).toBeNull();
  });

  it('during the count-in: a note just before bar 1 lands on it, earlier ones are dropped', () => {
    const counting = { playing: { slot: 1, startTick: 0 }, slot: 1, startsAt: 0 };
    expect(recordedNoteAt({ ...counting, tick: -20 })).toEqual({ tick: 0, loopStart: 0 });
    expect(recordedNoteAt({ ...counting, tick: -200 })).toBeNull();
  });

  it('while the clip plays, a note counts from its loop start at the tick it was played', () => {
    const playing = { playing: { slot: 1, startTick: 768 }, slot: 1, startsAt: null };
    expect(recordedNoteAt({ ...playing, tick: 1000 })).toEqual({ tick: 1000, loopStart: 768 });
    // Another clip plays and nothing waits: not recorded (live pads).
    expect(recordedNoteAt({ playing: { slot: 0, startTick: 0 }, slot: 1, startsAt: null, tick: 1000 })).toBeNull();
  });

  it('song playback: a block that does not play the target still records into it, where its loop would be', () => {
    expect(recordedNoteAt({ playing: { slot: 2, startTick: 1536 }, slot: 1, startsAt: null, tick: 1600, lastLoopStart: 768 })).toEqual({ tick: 1600, loopStart: 768 });
    expect(recordedNoteAt({ playing: null, slot: 1, startsAt: null, tick: 1600, lastLoopStart: 768 })).toEqual({ tick: 1600, loopStart: 768 });
  });
});
