/**
 * MIDI file export: the bytes of a Standard MIDI File (type 1) and the notes
 * the song plays (regions over pad clips and song clips, offsets, swing,
 * muted parts left out, drums on channel 10 with General MIDI notes).
 */
import { describe, expect, it } from 'vitest';
import { drumPadForNote } from '../../src/app/midi';
import { createClip, createProject } from '../../src/project/factory';
import { SONG_SLOT_BASE, TICKS_PER_BAR, type Project } from '../../src/project/types';
import { DRUM_CHANNEL, GM_DRUM_NOTES, encodeMidi, exportNotes, songMidi, varLen } from '../../src/render/midi';

/** A minimal SMF reader: header fields and each track's events with absolute ticks. */
function readMidi(b: Uint8Array) {
  const s = (at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
  const u32 = (at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
  const u16 = (at: number) => (b[at] << 8) | b[at + 1];
  expect(s(0, 4)).toBe('MThd');
  expect(u32(4)).toBe(6);
  const header = { format: u16(8), tracks: u16(10), division: u16(12) };
  let at = 14;
  const tracks: { tick: number; bytes: number[] }[][] = [];
  for (let t = 0; t < header.tracks; t++) {
    expect(s(at, 4)).toBe('MTrk');
    const len = u32(at + 4);
    const end = at + 8 + len;
    let p = at + 8;
    let tick = 0;
    const events: { tick: number; bytes: number[] }[] = [];
    while (p < end) {
      let d = 0;
      for (;;) {
        const v = b[p++];
        d = (d << 7) | (v & 0x7f);
        if (!(v & 0x80)) break;
      }
      tick += d;
      const status = b[p];
      let n: number;
      if (status === 0xff) n = 3 + b[p + 2];
      else if ((status & 0xf0) === 0x90 || (status & 0xf0) === 0x80) n = 3;
      else throw new Error(`unexpected status ${status}`);
      events.push({ tick, bytes: [...b.subarray(p, p + n)] });
      p += n;
    }
    expect(p).toBe(end);
    tracks.push(events);
    at = end;
  }
  expect(at).toBe(b.length);
  return { header, tracks };
}

const notesOf = (events: { tick: number; bytes: number[] }[]) => events.filter((e) => e.bytes[0] < 0xf0);

function emptyProject(): Project {
  const p = createProject({ bpm: 120, now: 0 });
  for (const t of p.tracks) t.clips = t.clips.map(() => null);
  p.swing = 0;
  return p;
}

describe('variable-length quantities', () => {
  it('encode as the SMF specification lists them', () => {
    expect(varLen(0)).toEqual([0x00]);
    expect(varLen(0x40)).toEqual([0x40]);
    expect(varLen(0x7f)).toEqual([0x7f]);
    expect(varLen(0x80)).toEqual([0x81, 0x00]);
    expect(varLen(0x2000)).toEqual([0xc0, 0x00]);
    expect(varLen(0x3fff)).toEqual([0xff, 0x7f]);
    expect(varLen(0x4000)).toEqual([0x81, 0x80, 0x00]);
    expect(varLen(0x0fffffff)).toEqual([0xff, 0xff, 0xff, 0x7f]);
  });
});

describe('encodeMidi', () => {
  it('writes a type-1 header, a tempo track (name, tempo, 4/4) and one track per part', () => {
    const bytes = encodeMidi({
      name: 'Demo',
      bpm: 120,
      tracks: [{ name: 'Bass', channel: 2, notes: [{ tick: 0, duration: 96, pitch: 36, velocity: 1 }] }],
    });
    const { header, tracks } = readMidi(bytes);
    expect(header).toEqual({ format: 1, tracks: 2, division: 96 });
    const tempo = tracks[0];
    expect(tempo[0].bytes.slice(0, 2)).toEqual([0xff, 0x03]);
    expect(String.fromCharCode(...tempo[0].bytes.slice(3))).toBe('Demo');
    // 120 BPM = 500 000 µs per quarter note = 0x07A120.
    expect(tempo[1].bytes).toEqual([0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]);
    expect(tempo[2].bytes).toEqual([0xff, 0x58, 0x04, 4, 2, 24, 8]);
    expect(tempo[tempo.length - 1].bytes).toEqual([0xff, 0x2f, 0x00]);
    const part = tracks[1];
    expect(String.fromCharCode(...part[0].bytes.slice(3))).toBe('Bass');
    expect(notesOf(part)).toEqual([
      { tick: 0, bytes: [0x92, 36, 127] },
      { tick: 96, bytes: [0x82, 36, 0x40] },
    ]);
  });

  it('delta times count from the previous event; offs come before ons at one tick', () => {
    const bytes = encodeMidi({
      name: 'x',
      bpm: 90,
      tracks: [
        {
          name: 'Keys',
          channel: 0,
          notes: [
            { tick: 0, duration: 200, pitch: 60, velocity: 0.5 },
            { tick: 200, duration: 100, pitch: 62, velocity: 0.5 },
          ],
        },
      ],
    });
    // Raw track 2: name meta, then delta 0 on 60, delta 200 (0x81 0x48) off 60, delta 0 on 62, delta 100 off 62.
    expect([...bytes.subarray(bytes.length - 21)]).toEqual([0x00, 0x90, 60, 64, 0x81, 0x48, 0x80, 60, 0x40, 0x00, 0x90, 62, 64, 0x64, 0x80, 62, 0x40, 0x00, 0xff, 0x2f, 0x00]);
    const ev = notesOf(readMidi(bytes).tracks[1]);
    expect(ev.map((e) => [e.tick, e.bytes[0] & 0xf0, e.bytes[1]])).toEqual([
      [0, 0x90, 60],
      [200, 0x80, 60],
      [200, 0x90, 62],
      [300, 0x80, 62],
    ]);
    // 90 BPM = 666 667 µs.
    expect(readMidi(bytes).tracks[0][1].bytes.slice(3)).toEqual([0x0a, 0x2c, 0x2b]);
  });

  it('every note-on has its own note-off: a same-pitch note ends the one still sounding', () => {
    const bytes = encodeMidi({
      name: 'x',
      bpm: 120,
      tracks: [
        {
          name: 'Lead',
          channel: 4,
          notes: [
            { tick: 0, duration: 300, pitch: 64, velocity: 0.8 },
            { tick: 96, duration: 96, pitch: 64, velocity: 0.8 },
            { tick: 96, duration: 96, pitch: 67, velocity: 0 },
          ],
        },
      ],
    });
    const ev = notesOf(readMidi(bytes).tracks[1]);
    const sounding = new Map<number, number>();
    for (const e of ev) {
      const on = (e.bytes[0] & 0xf0) === 0x90;
      const pitch = e.bytes[1];
      if (on) {
        expect(sounding.has(pitch)).toBe(false);
        expect(e.bytes[2]).toBeGreaterThan(0);
        sounding.set(pitch, e.tick);
      } else {
        expect(sounding.has(pitch)).toBe(true);
        sounding.delete(pitch);
      }
    }
    expect(sounding.size).toBe(0);
    expect(ev.map((e) => [e.tick, e.bytes[0] & 0xf0, e.bytes[1]])).toEqual([
      [0, 0x90, 64],
      [96, 0x80, 64],
      [96, 0x90, 64],
      [96, 0x90, 67],
      [192, 0x80, 64],
      [192, 0x80, 67],
    ]);
  });
});

describe('the notes the song plays', () => {
  it('regions repeat their clip, start `offset` bars in, and are cut where they end', () => {
    const p = emptyProject();
    const bass = p.tracks[2];
    bass.clips[0] = createClip('Two bars', 2, [
      { tick: 0, pitch: 40, velocity: 0.8, duration: 96 },
      { tick: TICKS_PER_BAR, pitch: 43, velocity: 0.8, duration: 2 * TICKS_PER_BAR },
    ]);
    // Three bars from the clip's second bar: 43 (cut where the clip starts over), 40, then 43 cut where the region ends.
    p.arrangement.regions = [{ id: 'r1', trackId: bass.id, clipId: bass.clips[0]!.id, start: 0, bars: 3, offset: 1 }];
    const parts = exportNotes(p, { kind: 'song' });
    const notes = parts.find((x) => x.trackId === bass.id)!.notes;
    expect(notes.map((n) => [n.tick, n.pitch, n.duration])).toEqual([
      [0, 43, TICKS_PER_BAR],
      [TICKS_PER_BAR, 40, 96],
      [2 * TICKS_PER_BAR, 43, TICKS_PER_BAR],
    ]);
  });

  it('song clips play like pad clips; a loop of the song starts at its first bar', () => {
    const p = emptyProject();
    const lead = p.tracks[4];
    lead.songClips = [createClip('Lead 1', 1, [{ tick: 48, pitch: 72, velocity: 0.5, duration: 48 }])];
    p.arrangement.regions = [{ id: 'r', trackId: lead.id, clipId: lead.songClips[0].id, start: 2, bars: 2, offset: 0 }];
    const song = exportNotes(p, { kind: 'song' }).find((x) => x.trackId === lead.id)!.notes;
    expect(song.map((n) => n.tick)).toEqual([2 * TICKS_PER_BAR + 48, 3 * TICKS_PER_BAR + 48]);
    const range = exportNotes(p, { kind: 'songRange', fromBar: 3, toBar: 4 }).find((x) => x.trackId === lead.id)!.notes;
    expect(range.map((n) => n.tick)).toEqual([48]);
    expect(SONG_SLOT_BASE).toBe(100);
  });

  it('swing moves the off-beat sixteenths, as playback does', () => {
    const p = emptyProject();
    const chords = p.tracks[3];
    chords.clips[0] = createClip('c', 1, [
      { tick: 0, pitch: 60, velocity: 0.5, duration: 24 },
      { tick: 24, pitch: 62, velocity: 0.5, duration: 24 },
    ]);
    p.arrangement.regions = [{ id: 'r', trackId: chords.id, clipId: chords.clips[0]!.id, start: 0, bars: 1, offset: 0 }];
    p.swing = 0.5;
    const n = exportNotes(p, { kind: 'song' }).find((x) => x.trackId === chords.id)!.notes;
    expect(n[0].tick).toBe(0);
    expect(n[1].tick).toBeGreaterThan(24);
  });

  it('a scene loops each part’s clip for the bars asked; muted parts and parts left out by Solo are not heard', () => {
    const p = emptyProject();
    p.tracks[0].clips[1] = createClip('beat', 1, [{ tick: 0, pitch: 0, velocity: 1, duration: 24 }]);
    p.tracks[2].clips[1] = createClip('bass', 2, [{ tick: 0, pitch: 36, velocity: 1, duration: 24 }]);
    p.tracks[3].clips[1] = createClip('chords', 1, [{ tick: 0, pitch: 60, velocity: 1, duration: 24 }]);
    p.tracks[3].mute = true;
    const parts = exportNotes(p, { kind: 'scene', row: 1, bars: 4 });
    expect(parts.find((x) => x.trackId === p.tracks[0].id)!.notes).toHaveLength(4);
    expect(parts.find((x) => x.trackId === p.tracks[2].id)!.notes).toHaveLength(2);
    expect(parts.some((x) => x.trackId === p.tracks[3].id)).toBe(false);
    p.tracks[2].solo = true;
    expect(exportNotes(p, { kind: 'scene', row: 1, bars: 4 }).map((x) => x.trackId)).toEqual([p.tracks[2].id]);
  });

  it('the MIDI file: one track per part with notes, drums on channel 10 with General MIDI notes, others on their own channels', () => {
    const p = emptyProject();
    const drums = p.tracks[0];
    drums.clips[0] = createClip('beat', 1, [
      { tick: 0, pitch: 0, velocity: 1, duration: 24 },
      { tick: 96, pitch: 2, velocity: 1, duration: 24 },
      { tick: 48, pitch: 4, velocity: 0.6, duration: 24 },
    ]);
    const bass = p.tracks[2];
    bass.clips[0] = createClip('bass', 1, [{ tick: 0, pitch: 36, velocity: 1, duration: 96 }]);
    const pad = p.tracks[5];
    pad.clips[0] = createClip('pad', 1, [{ tick: 0, pitch: 60, velocity: 1, duration: 384 }]);
    p.arrangement.regions = [drums, bass, pad].map((t, i) => ({ id: `r${i}`, trackId: t.id, clipId: t.clips[0]!.id, start: 0, bars: 2, offset: 0 }));
    const { header, tracks } = readMidi(songMidi(p, { kind: 'song' })!);
    expect(header.tracks).toBe(4);
    const names = tracks.slice(1).map((t) => String.fromCharCode(...t[0].bytes.slice(3)));
    expect(names).toEqual([drums.name, bass.name, pad.name]);
    const ons = (t: number) => notesOf(tracks[t]).filter((e) => (e.bytes[0] & 0xf0) === 0x90);
    expect(new Set(ons(1).map((e) => e.bytes[0] & 0x0f))).toEqual(new Set([DRUM_CHANNEL]));
    expect(ons(1).map((e) => e.bytes[1])).toEqual([36, 42, 38, 36, 42, 38]);
    expect(ons(2)[0].bytes[0] & 0x0f).toBe(0);
    expect(ons(3)[0].bytes[0] & 0x0f).toBe(1);
    expect(ons(2)).toHaveLength(2);
  });

  it('General MIDI drum notes come back to the same pad through MIDI input', () => {
    expect(GM_DRUM_NOTES).toHaveLength(16);
    GM_DRUM_NOTES.forEach((note, pad) => expect(drumPadForNote(note)).toBe(pad));
  });

  it('nothing to write when no heard part plays notes', () => {
    expect(songMidi(emptyProject(), { kind: 'scene', row: 0, bars: 4 })).toBeNull();
  });
});
