/**
 * MIDI file export (pure: no DOM, no audio).
 *
 * `exportNotes` lists the notes each part plays over an export source, as
 * the song plays them: song regions (pad clips and song clips alike) with
 * their clips repeating to fill them and starting `offset` bars in, a scene
 * or the playing pads looped for a number of bars. Swing is applied (the
 * notes land where they are heard), a note is cut where its region or the
 * export ends, and parts the song does not let you hear (muted, or not
 * soloed while another part is) are left out.
 *
 * `encodeMidi` writes a Standard MIDI File, type 1: a tempo track (name,
 * tempo, 4/4) and one track per part. The division is the project's PPQ (96),
 * so ticks carry over unchanged. Drum parts play on channel 10 with General
 * MIDI drum notes (`GM_DRUM_NOTES`, the same map MIDI input uses backwards:
 * each pad comes back to itself); other parts take the other channels in
 * order. A same-pitch note that starts while the last one still sounds ends
 * that one first, so every note-on has its own note-off.
 */
import { clipAtSlot, slotOfClip } from '../project/clips';
import { regionEnd } from '../project/arrangement';
import { DRUM_VOICES, MAX_SONG_BARS, PPQ, TICKS_PER_BAR, type Id, type Clip, type LauncherSnapshotEntry, type Project, type Track } from '../project/types';
import { clampBpm, swingWarp } from '../time/clock';

/** One note in export ticks (0 = the first beat of the export). */
export interface ExportNote {
  tick: number;
  duration: number;
  /** MIDI note number (melodic parts) or drum pad 0..15 (drum parts). */
  pitch: number;
  /** 0..1 */
  velocity: number;
}

export interface PartNotes {
  trackId: Id;
  name: string;
  drums: boolean;
  notes: ExportNote[];
}

/** What a MIDI file (or a set of part files) can be made of: the song, part of it, a scene or the pads playing now. */
export type NoteSource =
  | { kind: 'song' }
  | { kind: 'songRange'; fromBar: number; toBar: number }
  | { kind: 'scene'; row: number; bars: number }
  | { kind: 'launcher'; launcher: LauncherSnapshotEntry[]; bars: number };

/**
 * General MIDI drum notes for the 16 drum pads, in pad order: Kick, Kick 2,
 * Snare, Clap, Closed hat, Open hat, Shaker, Rim, Low, Mid and High tom,
 * Cowbell, Crash, Ride, Conga, FX.
 */
export const GM_DRUM_NOTES: readonly number[] = [36, 35, 38, 39, 42, 46, 70, 37, 41, 45, 48, 56, 49, 51, 63, 58];
/** Channel 10 (zero-based 9): drums in General MIDI. */
export const DRUM_CHANNEL = 9;

/** A part is heard: not muted, and soloed when any part is. */
export function partHeard(p: Pick<Project, 'tracks'>, t: Pick<Track, 'mute' | 'solo'>): boolean {
  const anySolo = p.tracks.some((x) => x.solo);
  return !t.mute && (!anySolo || t.solo);
}

function wholeBars(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : lo;
}

/** A drum part plays pads 0..15 only (drumKit.trigger ignores other notes, kept from a part that was melodic once). */
function drumPlays(pitch: number): boolean {
  const slot = Math.round(pitch);
  return slot >= 0 && slot < DRUM_VOICES;
}

/**
 * A clip's notes as the sequencer plays them: each ends by the clip's end (a
 * looping clip starts over there); on a one-note part (bass) the lowest of
 * notes starting together wins and a note ends where the next one starts; on
 * a drum part (`drums`) notes no pad plays are left out, as they are silent.
 */
export function playedNotes(clip: Pick<Clip, 'notes' | 'bars'>, mono: boolean, drums = false): ExportNote[] {
  const length = clip.bars * TICKS_PER_BAR;
  let list = clip.notes
    .filter((n) => Number.isFinite(n.tick) && Number.isFinite(n.pitch) && n.tick >= 0 && n.tick < length && (!drums || drumPlays(n.pitch)))
    .map((n) => ({ tick: n.tick, pitch: n.pitch, velocity: n.velocity, duration: Math.min(n.tick + (Number.isFinite(n.duration) && n.duration > 0 ? n.duration : 1), length) - n.tick }))
    .sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  if (mono) {
    const one: ExportNote[] = [];
    for (const n of list) if (!one.length || one[one.length - 1].tick !== n.tick) one.push(n);
    for (let i = 0; i + 1 < one.length; i++) one[i] = { ...one[i], duration: Math.min(one[i].duration, one[i + 1].tick - one[i].tick) };
    list = one;
  }
  return list;
}

/** The notes of a clip looped from `anchor` (a tick where the clip starts over), inside [from, to). */
function loopNotes(out: ExportNote[], notes: readonly ExportNote[], len: number, anchor: number, from: number, to: number): void {
  if (!(len > 0) || to <= from) return;
  let k = Math.floor((from - anchor) / len);
  for (let base = anchor + k * len; base < to; base = anchor + ++k * len) {
    for (const n of notes) {
      const at = base + n.tick;
      if (at < from || at >= to) continue;
      out.push({ tick: at, duration: Math.min(n.duration, to - at), pitch: n.pitch, velocity: n.velocity });
    }
  }
}

/** Each heard part's notes over `source`, in parts order (parts with no notes there included, with none). */
export function exportNotes(project: Project, source: NoteSource): PartNotes[] {
  const raw = new Map<Id, ExportNote[]>(project.tracks.map((t) => [t.id, []]));
  let start = 0;
  let end = 0;
  switch (source.kind) {
    case 'song':
    case 'songRange': {
      let songEnd = 0;
      for (const r of project.arrangement.regions) songEnd = Math.max(songEnd, regionEnd(r));
      const fromBar = source.kind === 'song' ? 0 : wholeBars(source.fromBar, 0, MAX_SONG_BARS);
      const toBar = source.kind === 'song' ? songEnd : wholeBars(source.toBar, 0, MAX_SONG_BARS);
      start = fromBar * TICKS_PER_BAR;
      end = Math.max(start, toBar * TICKS_PER_BAR);
      // Each part's regions in time order; should two overlap, the later one wins from its start (as the sequencer plays them).
      const byPart = new Map<Id, { from: number; to: number; anchor: number; clip: Clip }[]>();
      for (const r of project.arrangement.regions) {
        const track = project.tracks.find((t) => t.id === r.trackId);
        const clip = track ? clipAtSlot(track, slotOfClip(track, r.clipId)) : null;
        if (!track || !clip) continue;
        const from = r.start * TICKS_PER_BAR;
        const list = byPart.get(r.trackId) ?? [];
        list.push({ from, to: regionEnd(r) * TICKS_PER_BAR, anchor: from - r.offset * TICKS_PER_BAR, clip });
        byPart.set(r.trackId, list);
      }
      for (const [trackId, list] of byPart) {
        list.sort((a, b) => a.from - b.from);
        for (let i = 0; i + 1 < list.length; i++) if (list[i].to > list[i + 1].from) list[i] = { ...list[i], to: list[i + 1].from };
        const out = raw.get(trackId)!;
        const kind = project.tracks.find((t) => t.id === trackId)?.instrument.kind;
        for (const s of list) loopNotes(out, playedNotes(s.clip, kind === 'bass', kind === 'drums'), s.clip.bars * TICKS_PER_BAR, s.anchor, Math.max(s.from, start), Math.min(s.to, end));
      }
      break;
    }
    case 'scene':
    case 'launcher': {
      end = wholeBars(source.bars, 1, 256) * TICKS_PER_BAR;
      for (const t of project.tracks) {
        let clip: Clip | null = null;
        let anchor = 0;
        if (source.kind === 'scene') clip = t.clips[source.row] ?? null;
        else {
          const e = source.launcher.find((x) => x.trackId === t.id)?.playing;
          if (e) {
            clip = clipAtSlot(t, e.slot);
            anchor = Number.isFinite(e.startTick) ? e.startTick : 0;
          }
        }
        if (clip) loopNotes(raw.get(t.id)!, playedNotes(clip, t.instrument.kind === 'bass', t.instrument.kind === 'drums'), clip.bars * TICKS_PER_BAR, anchor, 0, end);
      }
      break;
    }
  }
  const swing = project.swing;
  const out: PartNotes[] = [];
  for (const t of project.tracks) {
    if (!partHeard(project, t)) continue;
    const notes = raw
      .get(t.id)!
      .map((n) => {
        // Swing moves where notes are heard on the song's grid; the export starts at `start`.
        const on = Math.round(swingWarp(n.tick, swing)) - start;
        const off = Math.round(swingWarp(n.tick + n.duration, swing)) - start;
        return { ...n, tick: on, duration: Math.max(1, Math.min(off, end - start) - on) };
      })
      .sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
    out.push({ trackId: t.id, name: t.name, drums: t.instrument.kind === 'drums', notes });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Standard MIDI File                                                  */
/* ------------------------------------------------------------------ */

export interface MidiTrackInput {
  name: string;
  /** 0..15 */
  channel: number;
  notes: { tick: number; duration: number; pitch: number; velocity: number }[];
}

/** A variable-length quantity: 7 bits per byte, most significant first, the high bit set on all but the last. */
export function varLen(n: number): number[] {
  let v = Math.max(0, Math.floor(n));
  if (v > 0x0fffffff) throw new RangeError('MIDI delta time too large');
  const bytes = [v & 0x7f];
  while ((v >>= 7) > 0) bytes.unshift((v & 0x7f) | 0x80);
  return bytes;
}

const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));

function metaText(type: number, text: string): number[] {
  const b = utf8(text).slice(0, 255);
  return [0xff, type, ...varLen(b.length), ...b];
}

function chunk(id: string, body: number[]): number[] {
  const n = body.length;
  return [...id.split('').map((c) => c.charCodeAt(0)), (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...body];
}

/** 1..127 from 0..1 (a note that sounds never has velocity 0, which would mean note-off). */
export function midiVelocity(v: number): number {
  return Number.isFinite(v) ? Math.max(1, Math.min(127, Math.round(v * 127))) : 100;
}

/** A track body: absolute-time events → delta times, ending with End of Track. */
function trackBody(events: { tick: number; order: number; bytes: number[] }[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let last = 0;
  for (const e of events) {
    body.push(...varLen(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  body.push(0, 0xff, 0x2f, 0);
  return body;
}

/** The note events of a track: a same-pitch note ends the one still sounding, offs come before ons at one tick. */
function noteEvents(t: MidiTrackInput): { tick: number; order: number; bytes: number[] }[] {
  const ch = Math.max(0, Math.min(15, Math.round(t.channel)));
  const notes = t.notes
    .filter((n) => Number.isFinite(n.tick) && n.tick >= 0 && Number.isFinite(n.pitch))
    .map((n) => ({ tick: Math.round(n.tick), end: Math.round(n.tick) + Math.max(1, Math.round(n.duration)), pitch: Math.max(0, Math.min(127, Math.round(n.pitch))), vel: midiVelocity(n.velocity) }))
    .sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  const sounding = new Map<number, (typeof notes)[number]>();
  for (const n of notes) {
    const prev = sounding.get(n.pitch);
    if (prev && prev.end > n.tick) prev.end = n.tick;
    sounding.set(n.pitch, n);
  }
  const out: { tick: number; order: number; bytes: number[] }[] = [];
  for (const n of notes) {
    // Two notes of one pitch at one tick: the later one replaces the first (it would end at once).
    if (n.end <= n.tick) continue;
    out.push({ tick: n.tick, order: 2, bytes: [0x90 | ch, n.pitch, n.vel] });
    out.push({ tick: n.end, order: 1, bytes: [0x80 | ch, n.pitch, 0x40] });
  }
  return out;
}

/** A Standard MIDI File, type 1: a tempo track, then one track per entry of `tracks`. */
export function encodeMidi(opts: { name: string; bpm: number; ppq?: number; tracks: readonly MidiTrackInput[] }): Uint8Array {
  const ppq = opts.ppq ?? PPQ;
  const usPerQuarter = Math.round(60_000_000 / clampBpm(opts.bpm));
  const tempo: { tick: number; order: number; bytes: number[] }[] = [
    { tick: 0, order: 0, bytes: metaText(0x03, opts.name) },
    { tick: 0, order: 1, bytes: [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] },
    // 4/4, a click every quarter note, 8 thirty-seconds per quarter.
    { tick: 0, order: 2, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] },
  ];
  const n = opts.tracks.length + 1;
  const bytes = [...chunk('MThd', [0, 1, (n >> 8) & 0xff, n & 0xff, (ppq >> 8) & 0xff, ppq & 0xff]), ...chunk('MTrk', trackBody(tempo))];
  for (const t of opts.tracks) bytes.push(...chunk('MTrk', trackBody([{ tick: 0, order: 0, bytes: metaText(0x03, t.name) }, ...noteEvents(t)])));
  return Uint8Array.from(bytes);
}

/** The MIDI file of an export source: one track per heard part that plays notes there. Null when no part does. */
export function songMidi(project: Project, source: NoteSource): Uint8Array | null {
  const parts = exportNotes(project, source).filter((p) => p.notes.length > 0);
  if (!parts.length) return null;
  let next = 0;
  const tracks = parts.map((p): MidiTrackInput => {
    if (p.drums) return { name: p.name, channel: DRUM_CHANNEL, notes: p.notes.map((n) => ({ ...n, pitch: GM_DRUM_NOTES[n.pitch] ?? 36 + (n.pitch & 15) })) };
    if (next === DRUM_CHANNEL) next++;
    const channel = Math.min(15, next++);
    return { name: p.name, channel, notes: p.notes };
  });
  return encodeMidi({ name: project.name, bpm: project.bpm, tracks });
}
