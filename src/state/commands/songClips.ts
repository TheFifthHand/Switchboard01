/**
 * Loops that live in the song (schema v5 song clips, see project/clips.ts).
 *
 * A song clip is a loop only the song plays: a library loop dropped on the
 * song, a new empty loop, a take recorded in the Song view, or the copy
 * "Make this copy different" makes so one region can change without the
 * others. It never appears on the pads; copyLoopToPad puts a copy there.
 * A song clip no region plays leaves the part in the same undo step as the
 * edit that left it unplayed (common.ts keepSongWithClips).
 *
 * Every command is one undo step with plain Undo words, and refuses bad
 * input with nothing changed and no step. New regions are placed like any
 * region: they win where they land (project/arrangement.ts placeRegions).
 */
import { placeRegions, regionClip } from '../../project/arrangement';
import { cloneClipWithNewIds } from '../../project/clone';
import { clipAtSlot, isSongSlot, slotOfClip, trackClips } from '../../project/clips';
import { uid } from '../../project/factory';
import {
  MAX_CLIP_BARS,
  MAX_SONG_BARS,
  MAX_SONG_CLIPS,
  TICKS_PER_BAR,
  type Clip,
  type ClipBars,
  type Id,
  type Note,
  type Project,
  type QuantizeGrid,
  type SongRegion,
  type Track,
} from '../../project/types';
import { VALIDATION_LIMITS, sanitizeClip } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { isClipBars } from './clips';
import { NOT_FOUND, clamp, cleanName, draftTrack, findTrack, isFiniteNumber, isSlot, partName, refuse, run, type CommandResult } from './common';
import { QUANTIZE_TICKS, pitchRangeFor, quantizeTick } from './notes';

/** A loop to put in the song: a library loop, a new empty loop or a recorded take's piece. */
export interface NewLoop {
  name?: string;
  bars: ClipBars;
  notes?: Omit<Note, 'id'>[];
}

/** A take recorded in the Song view: notes timed from the start bar (ticks), over `bars` bars. */
export interface SongTake {
  trackId: Id;
  startBar: number;
  bars: number;
  notes: Omit<Note, 'id'>[];
  /** Grid the notes snap to; left out: the project's Record quantize setting (settings.recordQuantize). */
  quantize?: QuantizeGrid;
}

/** Bars of one song clip a recorded take is cut into. */
export const TAKE_CLIP_BARS = 8;

const newRegionId = (): Id => uid('rg');

const REGION_LIMIT = `The song already holds as many loops as it can (${VALIDATION_LIMITS.maxRegions}).`;

function songClipsFull(p: Project, trackId: Id): CommandResult {
  return refuse('limit', `${partName(p, trackId)} already has as many loops in the song as it can hold (${MAX_SONG_CLIPS}). Delete some from the song first.`);
}

/** Hands out names not used by any clip of the part (pads or song): "<stem> <first>", then the next free number. */
function nameMaker(track: Track, stem: string, first = 1): () => string {
  const used = new Set(trackClips(track).map((c) => c.clip.name));
  let n = first;
  return () => {
    const make = () => `${stem.slice(0, 55)} ${n}`;
    while (used.has(make())) n++;
    const name = make();
    used.add(name);
    return name;
  };
}

/** The project as it reads with `fresh` added to a part's song clips (for placing their regions). */
function withSongClips(p: Project, trackId: Id, fresh: readonly Clip[]): Pick<Project, 'tracks'> {
  return { tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, songClips: [...(t.songClips ?? []), ...fresh] } : t)) };
}

/** Where a clip is after an edit (song clips dropped in the same step can move song slots). */
function slotNow(store: ProjectStore, trackId: Id, clipId: Id): number | undefined {
  const t = findTrack(store.getState(), trackId);
  const slot = t ? slotOfClip(t, clipId) : -1;
  return slot >= 0 ? slot : undefined;
}

/** How many regions of the song play this clip of this part. */
export function loopUse(p: Project, trackId: Id, clipId: Id): number {
  let n = 0;
  for (const r of p.arrangement.regions) if (r.trackId === trackId && r.clipId === clipId) n++;
  return n;
}

/**
 * A new song clip and a region of its length at `atBar` (placed like any
 * region: it wins), in one undo step. `atBar` is rounded to a bar and kept
 * inside the song's range. The notes are checked like a pasted clip (notes
 * the part cannot play, or outside the loop, are left out). Without a name
 * the loop is called "<Part> 1", "<Part> 2"… (unique among the part's
 * clips). With no notes it is a new empty loop. Refused when the part holds
 * MAX_SONG_CLIPS song clips already.
 */
export function addLoopToSong(
  store: ProjectStore,
  trackId: Id,
  atBar: number,
  loop: NewLoop,
  opts: { display?: string } = {},
): CommandResult & { clipId?: Id; slot?: number; regionId?: Id } {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  if (!loop || typeof loop !== 'object' || !isClipBars(loop.bars)) return refuse('invalid', `Loops are 1 to ${MAX_CLIP_BARS} bars.`);
  if (!isFiniteNumber(atBar)) return refuse('invalid', 'Choose a bar in the song.');
  if (loop.notes !== undefined && !Array.isArray(loop.notes)) return refuse('invalid', 'The loop’s notes could not be read.');
  if ((t.songClips?.length ?? 0) >= MAX_SONG_CLIPS) return songClipsFull(p, trackId);
  if (p.arrangement.regions.length >= VALIDATION_LIMITS.maxRegions) return refuse('limit', REGION_LIMIT);
  const name = (loop.name !== undefined && cleanName(loop.name)) || nameMaker(t, partName(p, trackId))();
  const raw = { id: uid('clip'), name, bars: loop.bars, notes: (loop.notes ?? []).map((n) => ({ ...n, id: uid('n') })) };
  const { clip: clean } = sanitizeClip(raw, t.instrument.kind);
  if (!clean) return refuse('invalid', `The loop could not be used: a loop holds at most ${VALIDATION_LIMITS.maxNotesPerClip} notes.`);
  const clip = cloneClipWithNewIds(clean);
  const start = clamp(Math.round(atBar), 0, MAX_SONG_BARS - clip.bars);
  const region: SongRegion = { id: newRegionId(), trackId, clipId: clip.id, start, bars: clip.bars, offset: 0 };
  const placed = placeRegions(withSongClips(p, trackId, [clip]), p.arrangement.regions, [region], { newId: newRegionId }).regions;
  const r = run(store, 'arrange:Add loop', (d) => {
    (draftTrack(d, trackId).songClips ??= []).push(clip);
    d.arrangement.regions = placed;
  }, undefined, { display: opts.display ?? `Add ${clip.name}` });
  if (!r.changed) return r;
  return { ...r, clipId: clip.id, slot: slotNow(store, trackId, clip.id), regionId: region.id };
}

/** "Four Floor" and "Four Floor 2" both count copies from "Four Floor". */
function nameStem(name: string): string {
  return name.replace(/\s+\d+$/, '') || name;
}

/**
 * "Make this copy different": the region's clip (a pad clip or a song clip)
 * is copied into a new song clip ("Four Floor 2", "Four Floor 3"…, unique
 * among the part's clips) and only this region plays it, from the same place
 * in the loop. Edits to it then change this region alone. Refused for a song
 * clip only this region plays: it is already its own.
 */
export function makeLoopUnique(store: ProjectStore, regionId: Id): CommandResult & { clipId?: Id; slot?: number } {
  const p = store.getState();
  const region = p.arrangement.regions.find((r) => r.id === regionId);
  if (!region) return NOT_FOUND('loop');
  const rc = regionClip(p, region);
  if (!rc) return NOT_FOUND('clip');
  if (isSongSlot(rc.slot) && loopUse(p, region.trackId, region.clipId) <= 1) {
    return refuse('invalid', 'Only this loop plays these notes already: changing it changes nothing else in the song.');
  }
  if ((rc.track.songClips?.length ?? 0) >= MAX_SONG_CLIPS) return songClipsFull(p, region.trackId);
  const copy = cloneClipWithNewIds(rc.clip);
  copy.name = nameMaker(rc.track, nameStem(rc.clip.name), 2)();
  const r = run(store, 'arrange:Make loop different', (d) => {
    (draftTrack(d, region.trackId).songClips ??= []).push(copy);
    const dr = d.arrangement.regions.find((x) => x.id === regionId);
    if (dr) dr.clipId = copy.id;
  }, undefined, { display: `Make ${copy.name}` });
  if (!r.changed) return r;
  return { ...r, clipId: copy.id, slot: slotNow(store, region.trackId, copy.id) };
}

/**
 * A copy of a song clip on one of the part's pads, so it can be played live:
 * the first empty pad, or `row`. The song keeps playing its own loop. Refused
 * when the chosen pad has a clip, or every pad of the part has one.
 */
export function copyLoopToPad(store: ProjectStore, trackId: Id, slot: number, row?: number): CommandResult & { slot?: number } {
  const p = store.getState();
  const t = findTrack(p, trackId);
  if (!t) return NOT_FOUND('part');
  if (!isSongSlot(slot)) return refuse('invalid', 'That clip is already on a pad.');
  const clip = clipAtSlot(t, slot);
  if (!clip) return NOT_FOUND('loop');
  let to: number;
  if (row !== undefined) {
    if (!isSlot(row, t)) return refuse('invalid', 'There is no pad there.');
    if (t.clips[row]) return refuse('occupied', 'That pad already has a clip: choose an empty pad.');
    to = row;
  } else {
    to = t.clips.findIndex((c) => c === null);
    if (to < 0) return refuse('occupied', `All ${t.clips.length} pads of ${partName(p, trackId)} are full: delete or move a clip first.`);
  }
  const copy = cloneClipWithNewIds(clip);
  const r = run(store, 'clip:Copy loop to a pad', (d) => {
    draftTrack(d, trackId).clips[to] = copy;
  }, undefined, { display: `Copy ${clip.name} to a pad` });
  return r.changed ? { ...r, slot: to } : r;
}

/** A take's last clip length: the bars left, rounded up to 1, 2, 4 or 8. */
function roundUpBars(n: number): ClipBars {
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : 8) as ClipBars;
}

/**
 * "Record into the song": a finished Song-view take becomes song clips and
 * regions in one undo step that Undo calls "Record <Part>". The take is cut
 * into one clip per 8 bars (the last one rounded up to 1, 2, 4 or 8 bars),
 * each named like a new loop ("Bass 1", "Bass 2"…), with regions back to
 * back from the start bar, placed like any region (they win over what was
 * there). The take lasts `bars` bars, longer when a note starts later. Notes
 * snap to `take.quantize` (else the project's Record quantize setting); a
 * note snapped before the start lands on it. Each note goes into the clip its
 * start falls in, its tick counted from that clip's start; a note crossing
 * into the next clip is cut at the boundary (never dropped). Notes past the
 * song's longest length are left out (said in `message`). A take with no
 * notes is refused with no step.
 */
export function recordTakeIntoSong(store: ProjectStore, take: SongTake): CommandResult & { regionIds?: Id[]; clipIds?: Id[] } {
  const p = store.getState();
  if (!take || typeof take !== 'object') return refuse('invalid', 'The take could not be read.');
  const t = findTrack(p, take.trackId);
  if (!t) return NOT_FOUND('part');
  const startBar = take.startBar;
  if (!Number.isInteger(startBar) || startBar < 0 || startBar >= MAX_SONG_BARS) return refuse('invalid', 'The take must start on a bar inside the song.');
  const grid = take.quantize ?? p.settings.recordQuantize;
  if (!(grid in QUANTIZE_TICKS)) return refuse('invalid', 'Unknown quantize setting.');
  const [lo, hi] = pitchRangeFor(t.instrument.kind);
  const played = Array.isArray(take.notes)
    ? take.notes.filter((n) => n && [n.tick, n.pitch, n.velocity, n.duration].every(isFiniteNumber) && Math.round(n.pitch) >= lo && Math.round(n.pitch) <= hi)
    : [];
  if (!played.length) return refuse('empty', 'Nothing was played, so nothing was recorded.');

  const timed = played.map((n) => ({ n, tick: Math.max(0, quantizeTick(n.tick, grid)) }));
  const lastTick = Math.max(...timed.map((x) => x.tick));
  const takeBars = Number.isInteger(take.bars) && take.bars > 0 ? take.bars : 1;
  const total = Math.min(MAX_SONG_BARS - startBar, Math.max(takeBars, Math.floor(lastTick / TICKS_PER_BAR) + 1));
  const count = Math.ceil(total / TAKE_CLIP_BARS);
  if ((t.songClips?.length ?? 0) + count > MAX_SONG_CLIPS) return songClipsFull(p, take.trackId);
  const clipBars = (i: number): ClipBars => (i === count - 1 ? roundUpBars(total - i * TAKE_CLIP_BARS) : (TAKE_CLIP_BARS as ClipBars));

  // One clip per window; the last note played wins a tick and pitch played twice.
  const windowTicks = TAKE_CLIP_BARS * TICKS_PER_BAR;
  const windows: Map<string, Note>[] = Array.from({ length: count }, () => new Map());
  let outside = 0;
  for (const { n, tick } of timed) {
    if (tick >= total * TICKS_PER_BAR) {
      outside++;
      continue;
    }
    const w = Math.floor(tick / windowTicks);
    const rel = tick - w * windowTicks;
    const len = clipBars(w) * TICKS_PER_BAR;
    const pitch = Math.round(n.pitch);
    const duration = clamp(Math.min(n.duration, len - rel), VALIDATION_LIMITS.minNoteTicks, Math.min(len, VALIDATION_LIMITS.maxNoteTicks));
    windows[w].set(`${rel}|${pitch}`, { id: uid('n'), tick: rel, pitch, velocity: clamp(n.velocity, 0, 1), duration });
  }
  const stem = partName(p, take.trackId);
  const nextName = nameMaker(t, stem);
  let full = false;
  const clips: Clip[] = windows.map((w, i) => {
    let notes = [...w.values()].sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
    if (notes.length > VALIDATION_LIMITS.maxNotesPerClip) {
      notes = notes.slice(0, VALIDATION_LIMITS.maxNotesPerClip);
      full = true;
    }
    return { id: uid('clip'), name: nextName(), bars: clipBars(i), notes };
  });
  const regions: SongRegion[] = clips.map((c, i) => {
    const start = startBar + i * TAKE_CLIP_BARS;
    return { id: newRegionId(), trackId: take.trackId, clipId: c.id, start, bars: Math.min(c.bars, MAX_SONG_BARS - start), offset: 0 };
  });
  const placed = placeRegions(withSongClips(p, take.trackId, clips), p.arrangement.regions, regions, { newId: newRegionId }).regions;
  if (placed.length > VALIDATION_LIMITS.maxRegions && placed.length > p.arrangement.regions.length) return refuse('limit', REGION_LIMIT);
  const r = run(store, 'arrange:Record into the song', (d) => {
    (draftTrack(d, take.trackId).songClips ??= []).push(...clips);
    d.arrangement.regions = placed;
  }, undefined, { display: `Record ${stem}` });
  if (!r.changed) return r;
  const said = [
    outside ? `${outside} note${outside === 1 ? '' : 's'} past the end of the song (${MAX_SONG_BARS} bars) could not be kept.` : '',
    full ? `A loop holds at most ${VALIDATION_LIMITS.maxNotesPerClip} notes, so some recorded notes were not kept.` : '',
  ].filter(Boolean);
  return { ...r, regionIds: regions.map((x) => x.id), clipIds: clips.map((c) => c.id), ...(said.length ? { message: said.join(' ') } : {}) };
}
