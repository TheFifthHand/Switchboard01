/**
 * The song timeline (pure: no DOM, no audio).
 *
 * A song is a set of regions, one row per part (see SongRegion), plus named
 * sections over the timeline (SongSection). Everything here returns new
 * arrays and never changes its input, so the commands, the Song view's drag
 * preview, playback and export share one set of rules: what the lane draws
 * is what plays.
 *
 * Placement rule (as in GarageBand): regions that are placed, moved or
 * resized win. Where they land on a part's row, the regions already there
 * are carved: cut short, started later (their clip carries on in time, so
 * it stays in phase), split in two, or removed when nothing is left of them.
 * Positions and lengths are whole bars.
 */
import { clipAtSlot, slotOfClip } from './clips';
import { MAX_SONG_BARS, type Clip, type Id, type Project, type SongRegion, type SongSection, type Track } from './types';

/** Makes a fresh id for a region or section that an edit creates (a split's second piece, a copy). */
export type NewId = () => Id;

/** Bar just after a region or section. */
export function regionEnd(r: Pick<SongRegion, 'start' | 'bars'>): number {
  return r.start + r.bars;
}

/** a mod n, always in [0, n). */
function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/** The clip a region plays, its part and its row, or null when the clip is gone. */
export function regionClip(p: Pick<Project, 'tracks'>, r: Pick<SongRegion, 'trackId' | 'clipId'>): { track: Track; clip: Clip; slot: number } | null {
  const track = p.tracks.find((t) => t.id === r.trackId);
  if (!track) return null;
  const slot = slotOfClip(track, r.clipId);
  const clip = clipAtSlot(track, slot);
  return clip ? { track, clip, slot } : null;
}

/** Length of a region's clip in bars (1 when the clip is gone). */
export function clipBarsOf(p: Pick<Project, 'tracks'>, r: Pick<SongRegion, 'trackId' | 'clipId'>): number {
  return regionClip(p, r)?.clip.bars ?? 1;
}

/**
 * Song length in bars: where the last region ends (0 when no loop is in the
 * song). The song plays and exports to here; a section label past the music
 * does not make it longer (see timelineBars).
 */
export function songBars(p: Pick<Project, 'arrangement'>): number {
  let end = 0;
  for (const r of p.arrangement.regions) end = Math.max(end, regionEnd(r));
  return end;
}

/** How far the timeline is in use: where the last region or section ends (0 when there is neither). */
export function timelineBars(p: Pick<Project, 'arrangement'>): number {
  let end = songBars(p);
  for (const s of p.arrangement.sections) end = Math.max(end, regionEnd(s));
  return end;
}

/**
 * Regions in time order: by start, then by part (the project's track order),
 * then by id. Every function here returns this order, so equal songs compare
 * equal.
 */
export function sortRegions(p: Pick<Project, 'tracks'>, regions: readonly SongRegion[]): SongRegion[] {
  const order = new Map(p.tracks.map((t, i) => [t.id, i]));
  return [...regions].sort((a, b) => a.start - b.start || (order.get(a.trackId) ?? 99) - (order.get(b.trackId) ?? 99) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One part's regions in time order. */
export function partRegions(regions: readonly SongRegion[], trackId: Id): SongRegion[] {
  return regions.filter((r) => r.trackId === trackId).sort((a, b) => a.start - b.start);
}

/** The region of a part that plays at `bar` (fractional bars allowed), or null. */
export function regionAt(regions: readonly SongRegion[], trackId: Id, bar: number): SongRegion | null {
  for (const r of regions) if (r.trackId === trackId && r.start <= bar && bar < regionEnd(r)) return r;
  return null;
}

/** How far into its clip a region is at song bar `bar` (fractional), in bars: 0 ≤ result < clipBars. */
export function clipBarAt(r: Pick<SongRegion, 'start' | 'offset'>, clipBars: number, bar: number): number {
  return mod(r.offset + (bar - r.start), Math.max(1, clipBars));
}

/**
 * What is left of region `r` after the bars [from, to) are cut out of it:
 * nothing, one piece or two. A piece after the cut starts later in its clip
 * (the music stays where it was in time). The left piece keeps `r`'s id; a
 * right piece keeps it too when there is no left piece, else it gets `newId()`.
 */
export function carve(r: SongRegion, from: number, to: number, clipBars: number, newId: NewId): SongRegion[] {
  const end = regionEnd(r);
  if (to <= r.start || from >= end) return [r];
  const out: SongRegion[] = [];
  if (from > r.start) out.push({ ...r, bars: from - r.start });
  if (to < end) {
    const start = Math.max(to, r.start);
    out.push({ ...r, id: out.length ? newId() : r.id, start, bars: end - start, offset: mod(r.offset + (start - r.start), Math.max(1, clipBars)) });
  }
  return out;
}

/** Counts of what an edit did to the regions it landed on, for the UI's words. */
export interface PlaceResult {
  regions: SongRegion[];
  /** Regions that were cut short, started later or split. */
  trimmed: number;
  /** Regions that disappeared under the placed ones. */
  removed: number;
}

/**
 * `placed` put on the timeline. First every region whose id is in
 * `opts.replacing` is taken away (a move or resize replaces the regions it
 * changes); then each placed region carves the regions of its part that it
 * overlaps (see `carve`), in the order given, so a later one in `placed`
 * wins over an earlier one where they overlap.
 */
export function placeRegions(p: Pick<Project, 'tracks'>, regions: readonly SongRegion[], placed: readonly SongRegion[], opts: { replacing?: Iterable<Id>; newId: NewId }): PlaceResult {
  const replacing = new Set(opts.replacing ?? []);
  let list = regions.filter((r) => !replacing.has(r.id));
  const touched = new Set<Id>();
  const gone = new Set<Id>();
  for (const pr of placed) {
    const next: SongRegion[] = [];
    for (const r of list) {
      if (r.trackId !== pr.trackId || regionEnd(r) <= pr.start || r.start >= regionEnd(pr)) {
        next.push(r);
        continue;
      }
      const pieces = carve(r, pr.start, regionEnd(pr), clipBarsOf(p, r), opts.newId);
      if (pieces.length) touched.add(r.id);
      else gone.add(r.id);
      next.push(...pieces);
    }
    next.push(pr);
    list = next;
  }
  // A placed region that a later placed one covers counts as neither.
  const placedIds = new Set(placed.map((r) => r.id));
  let trimmed = 0;
  let removed = 0;
  for (const id of touched) if (!placedIds.has(id) && !gone.has(id) && list.some((r) => r.id === id)) trimmed++;
  for (const id of gone) if (!placedIds.has(id)) removed++;
  return { regions: sortRegions(p, list), trimmed, removed };
}

/** A region kept inside the song: start ≥ 0, at least one bar, ending by MAX_SONG_BARS. Null when nothing fits. */
function fitRegion(r: SongRegion, clipBars: number): SongRegion | null {
  let start = Math.round(r.start);
  let end = Math.round(r.start + r.bars);
  let offset = r.offset;
  if (start < 0) {
    offset = offset - start;
    start = 0;
  }
  end = Math.min(end, MAX_SONG_BARS);
  if (end - start < 1) return null;
  return { ...r, start, bars: end - start, offset: mod(Math.round(offset), Math.max(1, clipBars)) };
}

/** The bars a set of regions spans: [first start, last end), or null for none. */
export function spanOf(regions: readonly Pick<SongRegion, 'start' | 'bars'>[]): [number, number] | null {
  if (!regions.length) return null;
  let a = Infinity;
  let b = -Infinity;
  for (const r of regions) {
    a = Math.min(a, r.start);
    b = Math.max(b, regionEnd(r));
  }
  return [a, b];
}

/**
 * How far regions `ids` can move: `delta` limited so the earliest stays at
 * bar 0 or later and the latest ends by MAX_SONG_BARS.
 */
export function clampMove(regions: readonly SongRegion[], ids: readonly Id[], delta: number): number {
  const span = spanOf(regions.filter((r) => ids.includes(r.id)));
  if (!span) return 0;
  return clampInt(delta, -span[0], MAX_SONG_BARS - span[1]);
}

/** The result of moving, copying or resizing regions: the new song regions and where the edited ones ended up. */
export interface MoveResult extends PlaceResult {
  /** The moved or resized regions (or the new copies) as they landed. */
  moved: SongRegion[];
}

/**
 * Regions `ids` moved `delta` bars along their rows (limited, see
 * `clampMove`). With `copy`, the originals stay and copies with new ids
 * land instead. Whatever they land on is carved.
 */
export function moveRegions(p: Pick<Project, 'tracks'>, regions: readonly SongRegion[], ids: readonly Id[], delta: number, opts: { copy?: boolean; newId: NewId }): MoveResult {
  const d = clampMove(regions, ids, delta);
  const picked = regions.filter((r) => ids.includes(r.id));
  const moved = picked.map((r) => ({ ...r, id: opts.copy ? opts.newId() : r.id, start: r.start + d }));
  const res = placeRegions(p, regions, moved, { replacing: opts.copy ? [] : picked.map((r) => r.id), newId: opts.newId });
  const ids2 = new Set(moved.map((m) => m.id));
  return { ...res, moved: res.regions.filter((r) => ids2.has(r.id)) };
}

/** Which edge of a region (or section) is dragged. */
export type Edge = 'start' | 'end';

/**
 * Regions `ids` with one edge moved by `delta` bars, each limited to at least
 * one bar and to the song's range. The end edge changes the length: the clip
 * repeats to fill it. The start edge moves the start: the music stays where
 * it is in time, so the region begins earlier or later in its clip. Where a
 * region grows over a neighbour, the neighbour is carved; among the regions
 * resized together, the earlier one wins.
 */
export function resizeRegions(p: Pick<Project, 'tracks'>, regions: readonly SongRegion[], ids: readonly Id[], edge: Edge, delta: number, newId: NewId): MoveResult {
  const picked = regions.filter((r) => ids.includes(r.id));
  const changed: SongRegion[] = [];
  for (const r of picked) {
    const cb = clipBarsOf(p, r);
    const end = regionEnd(r);
    if (edge === 'end') {
      const e = clampInt(end + delta, r.start + 1, MAX_SONG_BARS);
      changed.push({ ...r, bars: e - r.start });
    } else {
      const s = clampInt(r.start + delta, 0, end - 1);
      changed.push({ ...r, start: s, bars: end - s, offset: mod(r.offset + (s - r.start), cb) });
    }
  }
  // Placed later wins, so the earlier region goes last.
  changed.sort((a, b) => b.start - a.start);
  const res = placeRegions(p, regions, changed, { replacing: picked.map((r) => r.id), newId });
  return { ...res, moved: res.regions.filter((r) => ids.includes(r.id)) };
}

/**
 * Regions `ids` cut in two at bar `at` (only those that cross it). The
 * second piece gets a new id and starts later in its clip.
 */
export function splitRegions(p: Pick<Project, 'tracks'>, regions: readonly SongRegion[], ids: readonly Id[], at: number, newId: NewId): { regions: SongRegion[]; made: SongRegion[] } {
  const made: SongRegion[] = [];
  const out: SongRegion[] = [];
  for (const r of regions) {
    if (!ids.includes(r.id) || at <= r.start || at >= regionEnd(r)) {
      out.push(r);
      continue;
    }
    const right: SongRegion = { ...r, id: newId(), start: at, bars: regionEnd(r) - at, offset: mod(r.offset + (at - r.start), clipBarsOf(p, r)) };
    out.push({ ...r, bars: at - r.start }, right);
    made.push(right);
  }
  return { regions: sortRegions(p, out), made };
}

/** Regions `ids` taken out of the song. */
export function removeRegions(regions: readonly SongRegion[], ids: readonly Id[]): SongRegion[] {
  return regions.filter((r) => !ids.includes(r.id));
}

/**
 * Regions `ids` copied right after themselves (GarageBand's Duplicate): the
 * copies keep their places relative to each other and start where the
 * selection ends.
 */
export function duplicateRegions(p: Pick<Project, 'tracks'>, regions: readonly SongRegion[], ids: readonly Id[], newId: NewId): MoveResult {
  const span = spanOf(regions.filter((r) => ids.includes(r.id)));
  if (!span) return { regions: [...regions], trimmed: 0, removed: 0, moved: [] };
  return moveRegions(p, regions, ids, span[1] - span[0], { copy: true, newId });
}

/** Region `id` playing another of its part's clips instead (from that clip's start). */
export function swapRegionClip(regions: readonly SongRegion[], id: Id, clipId: Id): SongRegion[] {
  return regions.map((r) => (r.id === id ? { ...r, clipId, offset: 0 } : r));
}

/* ------------------------------------------------------------------ */
/* Time: insert and remove bars                                        */
/* ------------------------------------------------------------------ */

/**
 * One change to the song's time line, as an edit reports it (so what keeps
 * a place in the song, such as the repeat range, can follow the music):
 * `bars` > 0: that many bars inserted at bar `at` (everything from `at` on
 * plays later); `bars` < 0: bars [at, at − bars) taken out (everything
 * after plays earlier). An edit's shifts apply in order.
 */
export interface TimeShift {
  at: number;
  bars: number;
}

/** The shifts that take an edit's shifts back (Undo): each one reversed, in reverse order. */
export function invertShifts(shifts: readonly TimeShift[]): TimeShift[] {
  return [...shifts].reverse().map((s) => ({ at: s.at, bars: -s.bars }));
}

/**
 * Bars [from, to) after `shifts`: bars inserted before the range move it
 * later, inside it make it longer; bars taken out before it move it earlier,
 * inside it make it shorter. Null when nothing of it is left.
 */
export function shiftRange(shifts: readonly TimeShift[], from: number, to: number): [number, number] | null {
  let a = from;
  let b = to;
  for (const s of shifts) {
    if (s.bars > 0) {
      if (a >= s.at) a += s.bars;
      if (b > s.at) b += s.bars;
    } else if (s.bars < 0) {
      const end = s.at - s.bars;
      const map = (x: number) => (x <= s.at ? x : x >= end ? x + s.bars : s.at);
      a = map(a);
      b = map(b);
    }
    if (b <= a) return null;
  }
  return [a, b];
}

/** The song's regions and sections after an edit of its time line. */
export interface TimeEdit {
  regions: SongRegion[];
  sections: SongSection[];
}

/**
 * `bars` empty bars inserted at bar `at`: regions and sections from `at` on
 * move later; a region crossing `at` is split there (its second piece moves,
 * later in its clip); a section crossing `at` grows over the new bars.
 * Anything pushed past MAX_SONG_BARS is cut there.
 */
export function insertTime(p: Pick<Project, 'tracks'>, regions: readonly SongRegion[], sections: readonly SongSection[], at: number, bars: number, newId: NewId): TimeEdit {
  const n = Math.max(0, Math.round(bars));
  const out: SongRegion[] = [];
  for (const r of regions) {
    const cb = clipBarsOf(p, r);
    if (regionEnd(r) <= at) out.push(r);
    else if (r.start >= at) {
      const f = fitRegion({ ...r, start: r.start + n }, cb);
      if (f) out.push(f);
    } else {
      out.push({ ...r, bars: at - r.start });
      const f = fitRegion({ ...r, id: newId(), start: at + n, bars: regionEnd(r) - at, offset: mod(r.offset + (at - r.start), cb) }, cb);
      if (f) out.push(f);
    }
  }
  const secs: SongSection[] = [];
  for (const s of sections) {
    let start = s.start;
    let end = regionEnd(s);
    if (start >= at) {
      start += n;
      end += n;
    } else if (end > at) end += n;
    end = Math.min(end, MAX_SONG_BARS);
    if (end - start >= 1) secs.push({ ...s, start, bars: end - start });
  }
  return { regions: sortRegions(p, out), sections: sortSections(secs) };
}

/**
 * Bars [from, to) taken out of the song: what lay there goes, and everything
 * after moves earlier to close the gap. A region crossing the gap keeps its
 * parts on either side (joined again when they play on as one); a section
 * crossing it shrinks, and one inside it goes.
 */
export function removeTime(p: Pick<Project, 'tracks'>, regions: readonly SongRegion[], sections: readonly SongSection[], from: number, to: number, newId: NewId): TimeEdit {
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  const n = b - a;
  const out: SongRegion[] = [];
  for (const r of regions) {
    for (const piece of carve(r, a, b, clipBarsOf(p, r), newId)) out.push(piece.start >= b ? { ...piece, start: piece.start - n } : piece);
  }
  const secs: SongSection[] = [];
  for (const s of sections) {
    const end = regionEnd(s);
    // Bars of the section before the gap, and after it.
    const before = Math.max(0, Math.min(end, a) - s.start);
    const after = Math.max(0, end - Math.max(s.start, b));
    if (before + after < 1) continue;
    secs.push({ ...s, start: s.start < a ? s.start : Math.max(s.start, b) - n, bars: before + after });
  }
  // Only the pieces that meet where the gap was are joined: regions the user split elsewhere stay apart.
  return { regions: mergeTouching(p, out, a), sections: sortSections(secs) };
}

/**
 * Two regions of a part that touch and play on as one (same clip, the second
 * carrying on in the clip where the first ends) are joined into one: the
 * pieces a gap removal leaves on either side of it come back together. With
 * `at`, only regions that meet at that bar are joined.
 */
export function mergeTouching(p: Pick<Project, 'tracks'>, regions: readonly SongRegion[], at?: number): SongRegion[] {
  const out: SongRegion[] = [];
  for (const r of sortRegions(p, regions)) {
    const i = at !== undefined && r.start !== at ? -1 : out.findIndex((q) => q.trackId === r.trackId && regionEnd(q) === r.start && q.clipId === r.clipId);
    if (i >= 0) {
      const q = out[i];
      if (mod(q.offset + q.bars, clipBarsOf(p, q)) === r.offset) {
        out[i] = { ...q, bars: q.bars + r.bars };
        continue;
      }
    }
    out.push(r);
  }
  return sortRegions(p, out);
}

/* ------------------------------------------------------------------ */
/* Reordering sections (ripple)                                        */
/* ------------------------------------------------------------------ */

/** A section moved to another place in the song's order, with everything that plays in it. */
export interface SectionReorder extends TimeEdit {
  /** The moved section where it lands. */
  section: SongSection;
  /** How far it moved, in bars (negative: earlier). */
  delta: number;
  /** The regions that moved with it, as they land. */
  moved: SongRegion[];
}

/**
 * Section `id` moved to just before section `before` (null: after the last
 * section), like GarageBand's arrangement track: the music under it goes
 * with it, the bars between where it was and where it goes close up behind
 * it, nothing is cut and the song keeps its length.
 *
 * The time line is cut at three bars: the section's start and end and the
 * place it goes to. A region crossing one of them is split there first (the
 * piece after the cut carries on in its clip, so every bar still plays what
 * it played): the pieces inside the section move with it, the others stay
 * with the bars they are in. So only the order of the bars changes, never
 * what plays in them. Pieces of one region that meet again afterwards, in
 * the same phase, are joined again; separate loops are never joined.
 *
 * Null when nothing would change: an unknown section, `before` unknown or
 * the section itself, or the section already there (just before `before`,
 * or already the last one for null).
 */
export function reorderSection(p: Pick<Project, 'tracks'>, regions: readonly SongRegion[], sections: readonly SongSection[], id: Id, before: Id | null, newId: NewId): SectionReorder | null {
  const sorted = sortSections(sections);
  const i = sorted.findIndex((x) => x.id === id);
  if (i < 0 || before === id) return null;
  const s = sorted[i];
  const a = s.start;
  const b = regionEnd(s);
  const len = b - a;
  let target: number;
  if (before === null) {
    if (i === sorted.length - 1) return null;
    target = Math.max(...sorted.filter((x) => x.id !== id).map((x) => regionEnd(x)));
  } else {
    const j = sorted.findIndex((x) => x.id === before);
    if (j < 0 || j === i + 1) return null;
    target = sorted[j].start;
  }
  if (target > a && target < b) return null;
  // Where a bar goes: the section's bars to the target, the bars between the two close up behind it.
  const shift = (start: number): number => {
    if (start >= a && start < b) return target < a ? start - (a - target) : start + (target - b);
    if (target < a && start >= target && start < a) return start + len;
    if (target > b && start >= b && start < target) return start - len;
    return start;
  };
  // Cut the regions at the three bars (no region crosses one afterwards); remember which pieces were one region.
  const root = new Map<Id, Id>();
  let cut = [...regions];
  for (const at of [a, b, target]) {
    const next: SongRegion[] = [];
    for (const r of cut) {
      if (at <= r.start || at >= regionEnd(r)) {
        next.push(r);
        continue;
      }
      const right: SongRegion = { ...r, id: newId(), start: at, bars: regionEnd(r) - at, offset: mod(r.offset + (at - r.start), Math.max(1, clipBarsOf(p, r))) };
      root.set(right.id, root.get(r.id) ?? r.id);
      next.push({ ...r, bars: at - r.start }, right);
    }
    cut = next;
  }
  const shifted = sortRegions(
    p,
    cut.map((r) => ({ ...r, start: shift(r.start) })),
  );
  // Join pieces of one region that meet again in the same phase. Loops that were apart stay apart.
  const rootOf = (r: SongRegion) => root.get(r.id) ?? r.id;
  const out: SongRegion[] = [];
  for (const r of shifted) {
    const k = out.findIndex((q) => q.trackId === r.trackId && q.clipId === r.clipId && regionEnd(q) === r.start && rootOf(q) === rootOf(r));
    if (k >= 0 && mod(out[k].offset + out[k].bars, Math.max(1, clipBarsOf(p, out[k]))) === r.offset) {
      out[k] = { ...out[k], bars: out[k].bars + r.bars };
      continue;
    }
    out.push(r);
  }
  const landed: SongSection = { ...s, start: shift(a) };
  const secs = sortSections(sorted.map((x) => (x.id === id ? landed : { ...x, start: shift(x.start) })));
  const moved = out.filter((r) => r.start >= landed.start && r.start < regionEnd(landed));
  return { regions: sortRegions(p, out), sections: secs, section: landed, delta: landed.start - a, moved };
}

/**
 * The section a reorder drag points at: the dragged section's middle, moved
 * `delta` bars, goes before the first other section whose middle is later
 * (null: after the last one). `same` is true when that is where the section
 * already is (dropping changes nothing).
 */
export function reorderTarget(sections: readonly SongSection[], id: Id, delta: number): { before: Id | null; same: boolean } | null {
  const sorted = sortSections(sections);
  const i = sorted.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const s = sorted[i];
  const mid = s.start + s.bars / 2 + delta;
  const others = sorted.filter((x) => x.id !== id);
  const next = others.find((x) => x.start + x.bars / 2 > mid) ?? null;
  const same = next ? sorted[i + 1]?.id === next.id : i === sorted.length - 1;
  return { before: next?.id ?? null, same };
}

/* ------------------------------------------------------------------ */
/* Scenes as song material                                             */
/* ------------------------------------------------------------------ */

/** Length of a scene row in bars: its longest clip (at least 1). */
export function rowBars(p: Pick<Project, 'tracks'>, row: number): number {
  let bars = 1;
  for (const t of p.tracks) {
    const c = t.clips[row];
    if (c && c.bars > bars) bars = c.bars;
  }
  return bars;
}

/**
 * Regions that play scene row `row` from bar `at` for `bars` bars (default:
 * the scene's length): one per part that has a clip in that row.
 */
export function sceneRegions(p: Pick<Project, 'tracks'>, row: number, at: number, newId: NewId, bars = rowBars(p, row)): SongRegion[] {
  const out: SongRegion[] = [];
  for (const t of p.tracks) {
    const c = t.clips[row];
    if (!c) continue;
    const f = fitRegion({ id: newId(), trackId: t.id, clipId: c.id, start: at, bars, offset: 0 }, c.bars);
    if (f) out.push(f);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

export function sortSections(sections: readonly SongSection[]): SongSection[] {
  return [...sections].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The section at `bar` (fractional allowed), or null. */
export function sectionAt(sections: readonly SongSection[], bar: number): SongSection | null {
  for (const s of sections) if (s.start <= bar && bar < regionEnd(s)) return s;
  return null;
}

/**
 * Section `s` put on the timeline (kept inside the song's range): sections it
 * overlaps are cut short, start later, or go; one it lands in the middle of
 * keeps its first part (sections are never split in two). Sections whose id
 * is in `replacing` (and an older copy of `s` itself) are taken away first.
 */
export function placeSection(sections: readonly SongSection[], s: SongSection, replacing: Iterable<Id> = []): SongSection[] {
  const skip = new Set(replacing);
  const start = clampInt(s.start, 0, MAX_SONG_BARS - 1);
  const end = clampInt(s.start + s.bars, start + 1, MAX_SONG_BARS);
  const placed = { ...s, start, bars: end - start };
  const out: SongSection[] = [];
  for (const o of sections) {
    if (skip.has(o.id) || o.id === s.id) continue;
    const oe = regionEnd(o);
    if (oe <= start || o.start >= end) out.push(o);
    else if (o.start < start) out.push({ ...o, bars: start - o.start });
    else if (oe > end) out.push({ ...o, start: end, bars: oe - end });
  }
  out.push(placed);
  return sortSections(out);
}

/** The regions that belong to a section: those that start inside it. */
export function sectionRegions(regions: readonly SongRegion[], s: Pick<SongSection, 'start' | 'bars'>): SongRegion[] {
  return regions.filter((r) => r.start >= s.start && r.start < regionEnd(s));
}

/** Stretches before bar `end` that no section covers, as [start, end) pairs. */
export function sectionGaps(sections: readonly SongSection[], end: number): [number, number][] {
  const gaps: [number, number][] = [];
  let at = 0;
  for (const s of sortSections(sections)) {
    if (at >= end) break;
    if (s.start > at) gaps.push([at, Math.min(s.start, end)]);
    at = Math.max(at, regionEnd(s));
  }
  if (at < end) gaps.push([at, end]);
  return gaps.filter(([a, b]) => b > a);
}

/* ------------------------------------------------------------------ */
/* Tidying (loading, validation)                                       */
/* ------------------------------------------------------------------ */

/**
 * Regions made playable: those whose part or clip is gone are dropped, each
 * is kept inside the song's range with its offset inside its clip, and where
 * two of a part overlap the earlier one keeps its bars and the later one
 * starts after it (or goes). `fixed` counts the regions changed or dropped.
 */
export function tidyRegions(p: Pick<Project, 'tracks'>, regions: readonly SongRegion[]): { regions: SongRegion[]; fixed: number } {
  let fixed = 0;
  const kept: SongRegion[] = [];
  for (const r of regions) {
    const rc = regionClip(p, r);
    const f = rc ? fitRegion(r, rc.clip.bars) : null;
    if (!f) {
      fixed++;
      continue;
    }
    if (f.start !== r.start || f.bars !== r.bars || f.offset !== r.offset) fixed++;
    kept.push(f);
  }
  const out: SongRegion[] = [];
  const reach = new Map<Id, number>();
  for (const r of sortRegions(p, kept)) {
    const after = reach.get(r.trackId) ?? 0;
    if (r.start >= after) {
      out.push(r);
      reach.set(r.trackId, regionEnd(r));
      continue;
    }
    fixed++;
    if (regionEnd(r) <= after) continue;
    out.push({ ...r, start: after, bars: regionEnd(r) - after, offset: mod(r.offset + (after - r.start), clipBarsOf(p, r)) });
    reach.set(r.trackId, regionEnd(r));
  }
  return { regions: sortRegions(p, out), fixed };
}

/** Sections made tidy: inside the song's range and not overlapping (a later one starts after an earlier one, or goes). */
export function tidySections(sections: readonly SongSection[]): { sections: SongSection[]; fixed: number } {
  let fixed = 0;
  const out: SongSection[] = [];
  let reach = 0;
  for (const s of sortSections(sections)) {
    let start = clampInt(s.start, 0, MAX_SONG_BARS);
    const end = clampInt(s.start + s.bars, 0, MAX_SONG_BARS);
    if (start < reach) start = reach;
    if (end - start < 1) {
      fixed++;
      continue;
    }
    if (start !== s.start || end - start !== s.bars) fixed++;
    out.push(start === s.start && end - start === s.bars ? s : { ...s, start, bars: end - start });
    reach = end;
  }
  return { sections: out, fixed };
}

/* ------------------------------------------------------------------ */
/* Plain section names for a growing song                              */
/* ------------------------------------------------------------------ */

/** The names "Add a part after" gives new sections, in turn (then "Verse 2", "Chorus 2"…). */
export const PART_NAMES = ['Verse', 'Chorus', 'Bridge'] as const;

/** `base`, or "<base> 2", "<base> 3"… when a section is already called that (case aside). */
export function uniqueSectionName(sections: readonly Pick<SongSection, 'name'>[], base: string): string {
  const taken = new Set(sections.map((s) => s.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/**
 * The next plain name for a new part of the song: Verse, Chorus, Bridge,
 * then Verse 2, Chorus 2, Bridge 2, Verse 3… (the first one no section has),
 * so a song that grows never has two new parts with the same name.
 */
export function nextPartName(sections: readonly Pick<SongSection, 'name'>[]): string {
  const taken = new Set(sections.map((s) => s.name.trim().toLowerCase()));
  for (let n = 1; ; n++) {
    for (const base of PART_NAMES) {
      const name = n === 1 ? base : `${base} ${n}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }
}

/** How much music section `s` holds: the parts playing in it, on average over its bars. */
export function musicPerBar(regions: readonly Pick<SongRegion, 'start' | 'bars'>[], s: Pick<SongSection, 'start' | 'bars'>): number {
  const end = regionEnd(s);
  let bars = 0;
  for (const r of regions) bars += Math.max(0, Math.min(regionEnd(r), end) - Math.max(r.start, s.start));
  return s.bars > 0 ? bars / s.bars : 0;
}

/** A section that fades out (an added ending): never the main part, and new parts go before it. */
function fadesOut(s: SongSection): boolean {
  return !!s.moves?.some((m) => m.kind === 'fadeOut');
}

/**
 * The song's main part, the one "Make it longer" repeats: the section with
 * the most music (the most parts playing per bar, so an intro or ending,
 * where parts come in or drop out, is never it), then the longest, then the
 * earliest. A section that fades out is it only when nothing else has music.
 * Null when no section has music.
 */
export function mainSection(p: Pick<Project, 'arrangement'>): SongSection | null {
  const regions = p.arrangement.regions;
  let best: { s: SongSection; m: number; fade: boolean } | null = null;
  for (const s of sortSections(p.arrangement.sections)) {
    const m = musicPerBar(regions, s);
    if (m <= 0) continue;
    const fade = fadesOut(s);
    const better = !best || (best.fade && !fade) || (best.fade === fade && (m > best.m + 1e-9 || (Math.abs(m - best.m) <= 1e-9 && s.bars > best.s.bars)));
    if (better) best = { s, m, fade };
  }
  return best?.s ?? null;
}

/**
 * The section a new part of the song goes after: the last one that plays
 * as much music as `main` (so the new part lands after the other main parts,
 * before an ending, which has less music or fades out).
 */
export function partPlace(p: Pick<Project, 'arrangement'>, main: SongSection): SongSection {
  const full = musicPerBar(p.arrangement.regions, main);
  const sorted = sortSections(p.arrangement.sections);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i];
    if (s.start < main.start) break;
    if (!fadesOut(s) && musicPerBar(p.arrangement.regions, s) >= full - 1e-9) return s;
  }
  return main;
}

/** Bars [from, to) of the song with music but no section over them, in time order. */
export function unlabelledMusic(p: Pick<Project, 'arrangement'>): [number, number][] {
  const sections = sortSections(p.arrangement.sections);
  const covered = (bar: number) => sections.some((s) => s.start <= bar && bar < regionEnd(s));
  const music = new Set<number>();
  for (const r of p.arrangement.regions) for (let b = r.start; b < regionEnd(r); b++) music.add(b);
  const out: [number, number][] = [];
  for (const b of [...music].sort((x, y) => x - y)) {
    if (covered(b)) continue;
    const last = out[out.length - 1];
    if (last && last[1] === b) last[1] = b + 1;
    else out.push([b, b + 1]);
  }
  return out;
}
