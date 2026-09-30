/**
 * Shared helpers for the sequencer / song / replay / arp unit tests: small
 * hand-made projects built on createProject(), and ways to look at the
 * generated event stream.
 */
import { createClip, createProject } from '../../src/project/factory';
import type { Clip, ClipBars, Id, Project } from '../../src/project/types';
import type { SeqEvent } from '../../src/time/contracts';
import type { NoteCut, NoteEvent, Sequencer } from '../../src/time/sequencer';

export type NoteSpec = [tick: number, pitch: number, duration?: number, velocity?: number];

/** A project at `bpm` with every clip slot empty. */
export function makeProject(bpm = 120): Project {
  const p = createProject({ bpm, now: 0 });
  p.seed = 1234;
  return p;
}

export function makeClip(bars: ClipBars, notes: NoteSpec[], name = 'clip'): Clip {
  return createClip(
    name,
    bars,
    notes.map(([tick, pitch, duration = 12, velocity = 0.8]) => ({ tick, pitch, duration, velocity })),
  );
}

/** Put a clip into a slot, immutably (like the store does). */
export function setClip(p: Project, trackId: Id, slot: number, clip: Clip | null): Project {
  return {
    ...p,
    tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, clips: t.clips.map((c, i) => (i === slot ? clip : c)) } : t)),
  };
}

/** A mutable project holder the sequencer reads from. */
export class Holder {
  constructor(public project: Project) {}
  get = (): Project => this.project;
}

export function notesOf(events: readonly SeqEvent[], trackId?: Id): NoteEvent[] {
  return events.filter((e): e is NoteEvent => e.kind === 'note' && (trackId === undefined || e.trackId === trackId));
}

export function ofKind<K extends SeqEvent['kind']>(events: readonly SeqEvent[], kind: K): Extract<SeqEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<SeqEvent, { kind: K }> => e.kind === kind);
}

/** Process in small steps up to `until` (like a ticker), collecting every event. */
export function runTo(seq: Sequencer, from: number, until: number, step = 0.025): SeqEvent[] {
  const out: SeqEvent[] = [];
  for (let i = 1; ; i++) {
    const t = from + i * step;
    if (t >= until) break;
    out.push(...seq.process(t));
  }
  out.push(...seq.process(until));
  return out;
}

/** Seconds of `ticks` at `bpm`. */
export function sec(ticks: number, bpm = 120): number {
  return (ticks * 60) / (bpm * 96);
}

/** Effective end time of each note after applying cuts. */
export function effectiveEnds(notes: readonly NoteEvent[], cuts: readonly NoteCut[]): Map<NoteEvent, number> {
  const ends = new Map<NoteEvent, number>();
  for (const n of notes) ends.set(n, n.time + n.duration);
  for (const c of cuts) {
    const e = ends.get(c.note);
    if (e !== undefined) ends.set(c.note, Math.min(e, c.time));
  }
  return ends;
}
