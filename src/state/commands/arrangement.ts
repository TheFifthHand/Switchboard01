/**
 * The song (schema v4), built like GarageBand's tracks area: loops placed on
 * each part's row (regions, see SongRegion) and named sections over the
 * timeline (SongSection). The placement rules are pure and live in
 * project/arrangement.ts, so the Song view's drag preview, playback, export
 * and these commands agree: what the lane draws is what plays.
 *
 * Every command is one undo step labelled "arrange:<Words>", with `display`
 * words that name the clip, part or section ("Move Four Floor", "Lengthen
 * Bounce", "Delete 3 loops"). Bad input is refused with nothing changed and
 * no undo step; an edit that would change nothing leaves no step either.
 * A shared `gesture` id merges a drag's calls into one undo step; deltas are
 * always relative to where things are now. Every command leaves the song
 * valid: regions inside the song's range, in whole bars, never overlapping
 * on a part, sections never overlapping (validateProject finds nothing to
 * fix). Positions and lengths are whole bars (integers).
 */
import {
  carve,
  clampMove,
  clipBarAt,
  clipBarsOf,
  duplicateRegions as duplicatePure,
  insertTime,
  mergeTouching,
  moveRegions as movePure,
  placeRegions,
  placeSection,
  regionClip,
  regionEnd,
  removeRegions as removePure,
  removeTime,
  resizeRegions as resizePure,
  rowBars,
  sceneRegions,
  sectionRegions,
  songBars,
  sortRegions,
  sortSections,
  spanOf,
  splitRegions as splitPure,
  swapRegionClip,
  type Edge,
  type NewId,
} from '../../project/arrangement';
import { uid } from '../../project/factory';
import {
  MAX_SECTION_NAME,
  MAX_SONG_BARS,
  SONG_MOVE_KINDS,
  TICKS_PER_BAR,
  type Clip,
  type Id,
  type Project,
  type SongMove,
  type SongMoveKind,
  type SongRegion,
  type SongSection,
  type Track,
  type TrackRole,
} from '../../project/types';
import { VALIDATION_LIMITS } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { NOT_FOUND, clamp, cleanName, deepEqual, isFiniteNumber, partName, refuse, run, type CommandResult } from './common';

export type { Edge } from '../../project/arrangement';

/* ------------------------------------------------------------------ */
/* Results and shared rules                                            */
/* ------------------------------------------------------------------ */

/** A loop to put on the song: one of the part's clips from bar `start` for `bars` bars (`offset`: bars into the clip, default 0). */
export interface RegionDraft {
  trackId: Id;
  clipId: Id;
  start: number;
  bars: number;
  offset?: number;
}

export interface SongEditResult extends CommandResult {
  /** The regions the edit made or moved, as they landed (see each command). */
  ids?: Id[];
  /** Regions it landed on, or cut, that were cut short, started later or split. */
  trimmed?: number;
  /** Regions that disappeared (under what landed, or taken out). */
  removed?: number;
}

const newRegionId: NewId = () => uid('rg');
const newSectionId = (): Id => uid('sec');

const TOO_LONG = `A song can be at most ${MAX_SONG_BARS} bars long.`;
const WHOLE_BARS = 'Loops and sections start on a bar line and last whole bars.';
const REGION_LIMIT = `The song already holds as many loops as it can (${VALIDATION_LIMITS.maxRegions}).`;
const SECTION_LIMIT = `The song already has as many sections as it can (${VALIDATION_LIMITS.maxSections}).`;

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** "1 bar", "4 bars". */
function barsText(n: number): string {
  return `${n} ${n === 1 ? 'bar' : 'bars'}`;
}

/** The regions with these ids, in song order (unknown ids and repeats are ignored). */
function pickRegions(p: Project, ids: readonly Id[]): SongRegion[] {
  if (!Array.isArray(ids)) return [];
  const want = new Set(ids);
  return p.arrangement.regions.filter((r) => want.has(r.id));
}

function findSection(p: Project, id: Id): SongSection | undefined {
  return p.arrangement.sections.find((s) => s.id === id);
}

/** A clip anywhere in the project, with its part (clip ids are unique in a project). */
function findClip(p: Project, clipId: Id): { track: Track; clip: Clip } | null {
  for (const track of p.tracks) {
    const clip = track.clips.find((c) => c?.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

/** What Undo calls a region: its clip's name (its part's when the clip has none). */
function regionWords(p: Project, r: Pick<SongRegion, 'trackId' | 'clipId'>): string {
  return regionClip(p, r)?.clip.name || partName(p, r.trackId);
}

/** "Four Floor" for one region, "3 loops" for several. */
function loopsWords(p: Project, regions: readonly Pick<SongRegion, 'trackId' | 'clipId'>[]): string {
  return regions.length === 1 ? regionWords(p, regions[0]) : `${regions.length} loops`;
}

/** A section name as stored: one line, at most MAX_SECTION_NAME characters. */
function sectionName(name: string, fallback = 'Section'): string {
  return cleanName(name, MAX_SECTION_NAME) ?? fallback;
}

/** What taking bars [from, to) out does to the regions there: those inside go, those across an edge are cut. */
function gapChanges(regions: readonly SongRegion[], from: number, to: number): { trimmed: number; removed: number } {
  let trimmed = 0;
  let removed = 0;
  for (const r of regions) {
    if (regionEnd(r) <= from || r.start >= to) continue;
    if (r.start >= from && regionEnd(r) <= to) removed++;
    else trimmed++;
  }
  return { trimmed, removed };
}

interface SongChange {
  regions?: SongRegion[];
  sections?: SongSection[];
  tailSeconds?: number;
}

/**
 * Write a song change as one undo step (only the parts that differ): refused
 * beyond the song's limits; nothing (and no step) when nothing would change.
 */
function commit(store: ProjectStore, p: Project, label: string, display: string, change: SongChange, gesture?: string): CommandResult {
  const a = p.arrangement;
  const regions = change.regions && !deepEqual(change.regions, a.regions) ? change.regions : null;
  const sections = change.sections && !deepEqual(change.sections, a.sections) ? change.sections : null;
  const tail = change.tailSeconds !== undefined && change.tailSeconds !== a.tailSeconds ? change.tailSeconds : null;
  if (regions && regions.length > VALIDATION_LIMITS.maxRegions && regions.length > a.regions.length) return refuse('limit', REGION_LIMIT);
  if (sections && sections.length > VALIDATION_LIMITS.maxSections && sections.length > a.sections.length) return refuse('limit', SECTION_LIMIT);
  if (!regions && !sections && tail === null) return { changed: false };
  return run(
    store,
    label,
    (d) => {
      if (regions) d.arrangement.regions = regions;
      if (sections) d.arrangement.sections = sections;
      if (tail !== null) d.arrangement.tailSeconds = tail;
    },
    gesture,
    { display },
  );
}

/* ------------------------------------------------------------------ */
/* Song moves                                                          */
/* ------------------------------------------------------------------ */

/** What the song moves are called in menus and undo steps. */
export const SONG_MOVE_NAMES: Readonly<Record<SongMoveKind, string>> = {
  fadeIn: 'Fade in',
  fadeOut: 'Fade out',
  filterRise: 'Filter rise',
  echoThrow: 'Echo throw',
};

/** A song move without its identity (what setSectionMoves takes). */
export interface SongMoveTemplate {
  kind: SongMoveKind;
  parts?: Id[];
}

/**
 * Moves cleaned for `p`: known kinds, one of each (the first wins), `parts`
 * limited to existing parts without repeats (fades never carry parts; an
 * empty list is left out: every melodic part). Ids are kept when `keepIds`
 * and given, else new.
 */
function cleanMoves(p: Project, moves: readonly (SongMoveTemplate & { id?: Id })[] | undefined, keepIds: boolean): SongMove[] {
  const out: SongMove[] = [];
  for (const m of moves ?? []) {
    if (!m || !SONG_MOVE_KINDS.includes(m.kind) || out.some((x) => x.kind === m.kind)) continue;
    const move: SongMove = { id: keepIds && typeof m.id === 'string' ? m.id : uid('mv'), kind: m.kind };
    if (m.kind !== 'fadeIn' && m.kind !== 'fadeOut' && Array.isArray(m.parts)) {
      const parts = m.parts.filter((t, i, a) => typeof t === 'string' && p.tracks.some((x) => x.id === t) && a.indexOf(t) === i);
      if (parts.length) move.parts = parts;
    }
    out.push(move);
  }
  return out;
}

/** Copies of moves with new ids (a copied section carries its own). */
function copyMoves(moves: readonly SongMove[] | undefined): SongMove[] | undefined {
  if (!moves?.length) return undefined;
  return moves.map((m) => (m.parts ? { id: uid('mv'), kind: m.kind, parts: [...m.parts] } : { id: uid('mv'), kind: m.kind }));
}

/** Section `s` carrying `moves` (none: the field is left out). */
function withMoves(s: SongSection, moves: SongMove[] | undefined): SongSection {
  const out: SongSection = { id: s.id, name: s.name, start: s.start, bars: s.bars };
  if (moves?.length) out.moves = moves;
  return out;
}

/**
 * Set a section's song moves (one undo step): at most one of each kind (the
 * first wins), parts limited to existing parts. An empty list removes them.
 * Moves already on the section keep their ids.
 */
export function setSectionMoves(store: ProjectStore, id: Id, moves: readonly (SongMoveTemplate & { id?: Id })[]): CommandResult {
  const p = store.getState();
  const s = findSection(p, id);
  if (!s) return NOT_FOUND('section');
  if (!Array.isArray(moves)) return refuse('invalid', 'The song moves could not be read.');
  if (moves.some((m) => !m || !SONG_MOVE_KINDS.includes(m.kind))) return refuse('invalid', 'That is not a song move.');
  const own = new Map((s.moves ?? []).map((m) => [m.kind, m.id]));
  const next = cleanMoves(p, moves.map((m) => ({ ...m, id: own.get(m.kind) })), true);
  return commit(store, p, 'arrange:Change song moves', `Change song moves in ${s.name}`, { sections: p.arrangement.sections.map((x) => (x.id === id ? withMoves(x, next) : x)) });
}

/**
 * Add a move of `kind` to a section, or remove it when the section has one
 * (one undo step, "Add Fade in" / "Remove Fade in"). `parts` (filter rise,
 * echo throw) lists the parts it acts on; left out: every melodic part.
 */
export function toggleSectionMove(store: ProjectStore, id: Id, kind: SongMoveKind, parts?: readonly Id[]): CommandResult & { on?: boolean } {
  const p = store.getState();
  const s = findSection(p, id);
  if (!s) return NOT_FOUND('section');
  if (!SONG_MOVE_KINDS.includes(kind)) return refuse('invalid', 'That is not a song move.');
  const has = (s.moves ?? []).some((m) => m.kind === kind);
  const next = has ? (s.moves ?? []).filter((m) => m.kind !== kind) : [...(s.moves ?? []), ...cleanMoves(p, [{ kind, ...(parts ? { parts: [...parts] } : {}) }], false)];
  const r = commit(store, p, 'arrange:Change song moves', `${has ? 'Remove' : 'Add'} ${SONG_MOVE_NAMES[kind]}`, { sections: p.arrangement.sections.map((x) => (x.id === id ? withMoves(x, next) : x)) });
  return { ...r, on: !has };
}

/* ------------------------------------------------------------------ */
/* Placing loops                                                       */
/* ------------------------------------------------------------------ */

/** A region from a draft, or why it cannot be placed. */
function regionFromDraft(p: Project, dr: RegionDraft): SongRegion | CommandResult {
  if (!dr || typeof dr !== 'object') return refuse('invalid', 'The loop could not be read.');
  if (!p.tracks.some((t) => t.id === dr.trackId)) return NOT_FOUND('part');
  const rc = regionClip(p, dr);
  if (!rc) return NOT_FOUND('clip');
  const offset = dr.offset ?? 0;
  if (!isInt(dr.start) || dr.start < 0 || !isInt(dr.bars) || dr.bars < 1 || !isInt(offset)) return refuse('invalid', WHOLE_BARS);
  if (dr.start + dr.bars > MAX_SONG_BARS) return refuse('limit', TOO_LONG);
  return { id: newRegionId(), trackId: dr.trackId, clipId: dr.clipId, start: dr.start, bars: dr.bars, offset: mod(offset, rc.clip.bars) };
}

/** Regions put on the song as they are, the later winning (pure; shared by the adding commands). */
function landRegions(p: Project, placed: readonly SongRegion[]): { regions: SongRegion[]; ids: Id[]; trimmed: number; removed: number } {
  const res = placeRegions(p, p.arrangement.regions, placed, { newId: newRegionId });
  const here = new Set(res.regions.map((r) => r.id));
  return { regions: res.regions, ids: placed.map((r) => r.id).filter((id) => here.has(id)), trimmed: res.trimmed, removed: res.removed };
}

/**
 * Put loops on the song (one undo step). Each plays one of its part's clips
 * from `start` for `bars` bars, `offset` bars into the clip (default 0;
 * wrapped into the clip). Like a drop in GarageBand, they win: the regions
 * already where they land are cut short, start later, split or go (`trimmed`,
 * `removed`); among the drafts a later one wins over an earlier one. `ids`:
 * the new regions. Refused (nothing changes) when a part or clip is gone, a
 * position is not whole bars, or the song would pass MAX_SONG_BARS.
 */
export function addRegions(store: ProjectStore, drafts: readonly RegionDraft[], opts: { display?: string } = {}): SongEditResult {
  const p = store.getState();
  if (!Array.isArray(drafts) || !drafts.length) return refuse('empty', 'Nothing to add to the song.');
  const placed: SongRegion[] = [];
  for (const dr of drafts) {
    const r = regionFromDraft(p, dr);
    if ('changed' in r) return r;
    placed.push(r);
  }
  const res = landRegions(p, placed);
  const r = commit(store, p, 'arrange:Add loops', opts.display ?? `Add ${loopsWords(p, placed)}`, { regions: res.regions });
  return { ...r, ids: res.ids, trimmed: res.trimmed, removed: res.removed };
}

/** Put one clip on the song from bar `start` for `bars` bars (default: the clip's length). One undo step, "Add Four Floor". */
export function addClipToSong(store: ProjectStore, trackId: Id, clipId: Id, start: number, bars?: number): SongEditResult {
  const p = store.getState();
  if (!p.tracks.some((t) => t.id === trackId)) return NOT_FOUND('part');
  const rc = regionClip(p, { trackId, clipId });
  if (!rc) return NOT_FOUND('clip');
  return addRegions(store, [{ trackId, clipId, start, bars: bars ?? rc.clip.bars }], { display: `Add ${rc.clip.name}` });
}

/**
 * Put a scene row on the song from bar `start`: a region for every part that
 * has a clip in that row, all `bars` long (default: the scene's length, its
 * longest clip), each clip from its start. With `section` (the default), a
 * section named after the scene labels those bars too, when no section
 * overlaps them already (`sectionId`). One undo step, "Add Groove".
 */
export function addSceneToSong(store: ProjectStore, row: number, start: number, opts: { bars?: number; section?: boolean } = {}): SongEditResult & { sectionId?: Id } {
  const p = store.getState();
  const scene = isInt(row) ? p.scenes[row] : undefined;
  if (!scene) return NOT_FOUND('scene');
  const bars = opts.bars ?? rowBars(p, row);
  if (!isInt(start) || start < 0 || !isInt(bars) || bars < 1) return refuse('invalid', WHOLE_BARS);
  if (start + bars > MAX_SONG_BARS) return refuse('limit', TOO_LONG);
  const placed = sceneRegions(p, row, start, newRegionId, bars);
  if (!placed.length) return refuse('empty', `${scene.name} has no clips yet: make some in Play first.`);
  const res = landRegions(p, placed);
  let sections = p.arrangement.sections;
  let sectionId: Id | undefined;
  if (opts.section !== false && !sections.some((s) => s.start < start + bars && regionEnd(s) > start)) {
    sectionId = newSectionId();
    sections = sortSections([...sections, { id: sectionId, name: sectionName(scene.name), start, bars }]);
  }
  const r = commit(store, p, 'arrange:Add scene to song', `Add ${scene.name}`, { regions: res.regions, sections });
  return { ...r, ids: res.ids, trimmed: res.trimmed, removed: res.removed, ...(r.changed && sectionId ? { sectionId } : {}) };
}

/**
 * "Make a song from my scenes": only for an empty song. Every scene row that
 * has clips, in order, each played twice its length, with a section named
 * after each scene. One undo step; `ids`: the new regions.
 */
export function fillSongFromScenes(store: ProjectStore): SongEditResult {
  const p = store.getState();
  if (songBars(p) > 0) return refuse('invalid', 'The song already has music: a song is made from the scenes only when it is empty.');
  const regions: SongRegion[] = [];
  const sections: SongSection[] = [];
  let at = 0;
  p.scenes.forEach((scene, row) => {
    if (!p.tracks.some((t) => t.clips[row])) return;
    const bars = 2 * rowBars(p, row);
    if (at + bars > MAX_SONG_BARS) return;
    regions.push(...sceneRegions(p, row, at, newRegionId, bars));
    sections.push({ id: newSectionId(), name: sectionName(scene.name), start: at, bars });
    at += bars;
  });
  if (!regions.length) return refuse('empty', 'Your scenes have no clips yet: make some in Play first.');
  const r = commit(store, p, 'arrange:Make a song from scenes', 'Make a song from my scenes', { regions: sortRegions(p, regions), sections });
  return { ...r, ids: regions.map((x) => x.id) };
}

/* ------------------------------------------------------------------ */
/* Editing loops                                                       */
/* ------------------------------------------------------------------ */

/**
 * Move regions `ids` `delta` bars along their rows (limited to the song's
 * range); with `copy`, copies (new ids) land there and the originals stay.
 * What they land on is carved (see placeRegions). `ids` in the result: the
 * moved regions (or the copies). One undo step, "Move Four Floor" / "Copy 3
 * loops"; a drag passes the same `gesture` on every call (after a copy, it
 * moves the copies by their ids).
 */
export function moveRegions(store: ProjectStore, ids: readonly Id[], delta: number, opts: { copy?: boolean; gesture?: string } = {}): SongEditResult {
  const p = store.getState();
  const picked = pickRegions(p, ids);
  if (!picked.length) return NOT_FOUND('loop');
  if (!isInt(delta)) return refuse('invalid', 'Loops move by whole bars.');
  const pickedIds = picked.map((r) => r.id);
  const d = clampMove(p.arrangement.regions, pickedIds, delta);
  if (d === 0) return { changed: false, ids: opts.copy ? [] : pickedIds };
  const res = movePure(p, p.arrangement.regions, pickedIds, d, { copy: opts.copy, newId: newRegionId });
  const verb = opts.copy ? 'Copy' : 'Move';
  const r = commit(store, p, `arrange:${verb} loops`, `${verb} ${loopsWords(p, picked)}`, { regions: res.regions }, opts.gesture);
  return { ...r, ids: res.moved.map((x) => x.id), trimmed: res.trimmed, removed: res.removed };
}

/**
 * Drag one edge of regions `ids` by `delta` bars (each kept at least one bar
 * long and inside the song). The end edge changes the length (the clip
 * repeats to fill it); the start edge keeps the music where it is in time (the
 * region starts earlier or later in its clip). Neighbours it grows over are
 * carved. `ids`: the resized regions. One undo step, "Lengthen Bounce" /
 * "Shorten 2 loops".
 */
export function resizeRegions(store: ProjectStore, ids: readonly Id[], edge: Edge, delta: number, gesture?: string): SongEditResult {
  const p = store.getState();
  const picked = pickRegions(p, ids);
  if (!picked.length) return NOT_FOUND('loop');
  if (edge !== 'start' && edge !== 'end') return refuse('invalid', 'Drag the start or the end of a loop.');
  if (!isInt(delta)) return refuse('invalid', 'Loops change length by whole bars.');
  const pickedIds = picked.map((r) => r.id);
  if (delta === 0) return { changed: false, ids: pickedIds };
  const res = resizePure(p, p.arrangement.regions, pickedIds, edge, delta, newRegionId);
  const longer = edge === 'end' ? delta > 0 : delta < 0;
  const r = commit(store, p, 'arrange:Resize loops', `${longer ? 'Lengthen' : 'Shorten'} ${loopsWords(p, picked)}`, { regions: res.regions }, gesture);
  return { ...r, ids: res.moved.map((x) => x.id), trimmed: res.trimmed, removed: res.removed };
}

/** Cut regions `ids` in two at bar `atBar` (those that cross it). `ids` in the result: the new right pieces. One undo step. */
export function splitRegions(store: ProjectStore, ids: readonly Id[], atBar: number): SongEditResult {
  const p = store.getState();
  const picked = pickRegions(p, ids);
  if (!picked.length) return NOT_FOUND('loop');
  if (!isInt(atBar)) return refuse('invalid', 'Loops split on a bar line.');
  const crossing = picked.filter((r) => r.start < atBar && atBar < regionEnd(r));
  if (!crossing.length) return refuse('invalid', 'Split inside a loop: pick a bar between its start and its end.');
  const res = splitPure(p, p.arrangement.regions, crossing.map((r) => r.id), atBar, newRegionId);
  const r = commit(store, p, 'arrange:Split loops', `Split ${loopsWords(p, crossing)}`, { regions: res.regions });
  return { ...r, ids: res.made.map((x) => x.id) };
}

/** Take regions `ids` out of the song (one undo step, "Delete Four Floor"; `cut`: the step says Cut, as the clipboard's Cut does). */
export function removeRegions(store: ProjectStore, ids: readonly Id[], opts: { cut?: boolean } = {}): SongEditResult {
  const p = store.getState();
  const picked = pickRegions(p, ids);
  if (!picked.length) return NOT_FOUND('loop');
  const verb = opts.cut ? 'Cut' : 'Delete';
  const r = commit(store, p, `arrange:${verb} loops`, `${verb} ${loopsWords(p, picked)}`, { regions: removePure(p.arrangement.regions, picked.map((x) => x.id)) });
  return { ...r, removed: r.changed ? picked.length : 0 };
}

/**
 * Copy regions `ids` right after themselves (GarageBand's Duplicate): the
 * copies keep their places relative to each other and start where the
 * selection ends. Refused when there is no room before MAX_SONG_BARS.
 * `ids` in the result: the copies.
 */
export function duplicateRegions(store: ProjectStore, ids: readonly Id[]): SongEditResult {
  const p = store.getState();
  const picked = pickRegions(p, ids);
  if (!picked.length) return NOT_FOUND('loop');
  const span = spanOf(picked)!;
  if (span[1] + (span[1] - span[0]) > MAX_SONG_BARS) return refuse('limit', `There is no room after ${loopsWords(p, picked)}: ${TOO_LONG}`);
  const res = duplicatePure(p, p.arrangement.regions, picked.map((x) => x.id), newRegionId);
  const r = commit(store, p, 'arrange:Duplicate loops', `Duplicate ${loopsWords(p, picked)}`, { regions: res.regions });
  return { ...r, ids: res.moved.map((x) => x.id), trimmed: res.trimmed, removed: res.removed };
}

/** Copied loops (UI state): each item's part, clip, length, offset and `at`, bars after the first item's start. */
export interface RegionClipboard {
  items: { trackId: Id; clipId: Id; at: number; bars: number; offset: number }[];
}

/** Regions `ids` as clipboard items (pure), or null when none exists. */
export function copyRegions(p: Project, ids: readonly Id[]): RegionClipboard | null {
  const picked = pickRegions(p, ids);
  if (!picked.length) return null;
  const first = spanOf(picked)![0];
  return { items: picked.map((r) => ({ trackId: r.trackId, clipId: r.clipId, at: r.start - first, bars: r.bars, offset: r.offset })) };
}

/**
 * Paste copied loops with the first one at bar `atBar` (the others keep
 * their distances). A loop whose clip moved to another part since lands on
 * that part's row; one whose clip is gone is skipped (`skipped`). They win
 * where they land. `ids` in the result: the pasted regions. One undo step.
 */
export function pasteRegions(store: ProjectStore, clip: RegionClipboard, atBar: number): SongEditResult & { skipped?: number } {
  const p = store.getState();
  if (!clip || !Array.isArray(clip.items) || !clip.items.length) return refuse('empty', 'Nothing to paste.');
  if (!isInt(atBar) || atBar < 0) return refuse('invalid', WHOLE_BARS);
  const placed: SongRegion[] = [];
  let skipped = 0;
  for (const it of clip.items) {
    if (!it || !isInt(it.at) || it.at < 0 || !isInt(it.bars) || it.bars < 1 || !isInt(it.offset)) return refuse('invalid', 'The copied loops could not be read.');
    const where = findClip(p, it.clipId);
    if (!where) {
      skipped++;
      continue;
    }
    const start = atBar + it.at;
    if (start + it.bars > MAX_SONG_BARS) return refuse('limit', `There is no room to paste there: ${TOO_LONG}`);
    placed.push({ id: newRegionId(), trackId: where.track.id, clipId: it.clipId, start, bars: it.bars, offset: mod(it.offset, where.clip.bars) });
  }
  if (!placed.length) return { ...refuse('empty', 'The copied loops played clips that have been deleted since.'), skipped };
  const res = landRegions(p, placed);
  const r = commit(store, p, 'arrange:Paste loops', `Paste ${loopsWords(p, placed)}`, { regions: res.regions });
  return { ...r, ids: res.ids, trimmed: res.trimmed, removed: res.removed, skipped };
}

/** Region `id` plays another of its part's clips instead, from that clip's start (one undo step). */
export function setRegionClip(store: ProjectStore, id: Id, clipId: Id): SongEditResult {
  const p = store.getState();
  const region = p.arrangement.regions.find((r) => r.id === id);
  if (!region) return NOT_FOUND('loop');
  const rc = regionClip(p, { trackId: region.trackId, clipId });
  if (!rc) return refuse('invalid', `That clip is not one of ${partName(p, region.trackId)}’s: a loop plays a clip of its own part.`);
  if (clipId === region.clipId) return { changed: false, ids: [id] };
  const r = commit(store, p, 'arrange:Change loop clip', `Play ${rc.clip.name} instead of ${regionWords(p, region)}`, { regions: swapRegionClip(p.arrangement.regions, id, clipId) });
  return { ...r, ids: [id] };
}

/* ------------------------------------------------------------------ */
/* Time: insert and remove bars                                        */
/* ------------------------------------------------------------------ */

/**
 * Insert `bars` empty bars at bar `at`: everything from there on moves later
 * (a loop crossing `at` is split there, `trimmed`; a section crossing it
 * grows). Refused when the song would pass MAX_SONG_BARS, or when nothing
 * comes after `at`. One undo step.
 */
export function insertBars(store: ProjectStore, at: number, bars: number): SongEditResult {
  const p = store.getState();
  if (!isInt(at) || at < 0 || !isInt(bars) || bars < 1) return refuse('invalid', 'Insert whole bars at a bar line.');
  const end = songBars(p);
  if (at >= end) return refuse('empty', 'Nothing comes after that bar, so there is nothing to move.');
  if (end + bars > MAX_SONG_BARS) return refuse('limit', `There is no room for ${barsText(bars)} more: ${TOO_LONG}`);
  const te = insertTime(p, p.arrangement.regions, p.arrangement.sections, at, bars, newRegionId);
  const split = p.arrangement.regions.filter((r) => r.start < at && at < regionEnd(r)).length;
  const r = commit(store, p, 'arrange:Insert bars', `Insert ${barsText(bars)}`, te);
  return { ...r, trimmed: split };
}

/**
 * Take bars [from, to) out of the song: what lay there goes and everything
 * after moves earlier to close the gap (a loop crossing it keeps its parts on
 * either side, joined when they play on as one; sections shrink or go).
 * `removed`: loops that went; `trimmed`: loops that were cut. One undo step.
 */
export function removeBars(store: ProjectStore, from: number, to: number): SongEditResult {
  const p = store.getState();
  if (!isInt(from) || !isInt(to) || from < 0 || to <= from) return refuse('invalid', 'Remove whole bars: pick where they start and end.');
  if (from >= songBars(p)) return refuse('empty', 'There is nothing there to remove.');
  const te = removeTime(p, p.arrangement.regions, p.arrangement.sections, from, to, newRegionId);
  const r = commit(store, p, 'arrange:Remove bars', `Remove ${barsText(to - from)}`, te);
  return { ...r, ...gapChanges(p.arrangement.regions, from, to) };
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

/** "Section N" with the first N (from the number of sections + 1) no section is called. */
function newSectionName(p: Project): string {
  const taken = new Set(p.arrangement.sections.map((s) => s.name.toLowerCase()));
  for (let n = p.arrangement.sections.length + 1; ; n++) if (!taken.has(`section ${n}`)) return `Section ${n}`;
}

/**
 * Add a section over bars [start, start + bars) named `name` (default
 * "Section N"). Sections it overlaps are cut short, start later or go (see
 * placeSection). One undo step; `sectionId`: the new section.
 */
export function addSection(store: ProjectStore, start: number, bars: number, name?: string): SongEditResult & { sectionId?: Id } {
  const p = store.getState();
  if (!isInt(start) || start < 0 || !isInt(bars) || bars < 1) return refuse('invalid', WHOLE_BARS);
  if (start + bars > MAX_SONG_BARS) return refuse('limit', TOO_LONG);
  const given = name !== undefined ? cleanName(name, MAX_SECTION_NAME) : null;
  const s: SongSection = { id: newSectionId(), name: given ?? newSectionName(p), start, bars };
  const r = commit(store, p, 'arrange:Add section', `Add ${s.name}`, { sections: placeSection(p.arrangement.sections, s) });
  return { ...r, ...(r.changed ? { sectionId: s.id } : {}) };
}

/** Rename a section (one undo step). An empty name is refused. */
export function renameSection(store: ProjectStore, id: Id, name: string): CommandResult {
  const p = store.getState();
  const s = findSection(p, id);
  if (!s) return NOT_FOUND('section');
  const v = cleanName(name, MAX_SECTION_NAME);
  if (!v) return refuse('invalid', 'A section needs a name.');
  return commit(store, p, 'arrange:Rename section', `Rename ${s.name} to ${v}`, { sections: p.arrangement.sections.map((x) => (x.id === id ? { ...x, name: v } : x)) });
}

/**
 * Drag one edge of a section by `delta` bars. A section is a label: this
 * never moves music. It stays at least one bar long and stops at its
 * neighbours (sections never overlap). One undo step per `gesture`.
 */
export function resizeSection(store: ProjectStore, id: Id, edge: Edge, delta: number, gesture?: string): CommandResult {
  const p = store.getState();
  const sorted = sortSections(p.arrangement.sections);
  const i = sorted.findIndex((s) => s.id === id);
  if (i < 0) return NOT_FOUND('section');
  if (edge !== 'start' && edge !== 'end') return refuse('invalid', 'Drag the start or the end of a section.');
  if (!isInt(delta)) return refuse('invalid', 'Sections change length by whole bars.');
  const s = sorted[i];
  const end = regionEnd(s);
  let start = s.start;
  let stop = end;
  if (edge === 'end') stop = clamp(end + delta, s.start + 1, i + 1 < sorted.length ? sorted[i + 1].start : MAX_SONG_BARS);
  else start = clamp(s.start + delta, i > 0 ? regionEnd(sorted[i - 1]) : 0, end - 1);
  if (start === s.start && stop === end) return { changed: false };
  const longer = stop - start > s.bars;
  return commit(store, p, 'arrange:Resize section', `${longer ? 'Lengthen' : 'Shorten'} ${s.name}`, { sections: p.arrangement.sections.map((x) => (x.id === id ? { ...x, start, bars: stop - start } : x)) }, gesture);
}

/**
 * Move a section `delta` bars, with the regions that start inside it (as
 * moveRegions moves them: they win where they land); with `copy`, a copy of
 * the section (its name and moves) and of those regions lands there instead.
 * Sections it lands on are cut short, start later or go. Limited to the
 * song's range. `sectionId`: the moved section or the copy; `ids`: the
 * moved or copied regions. One undo step per `gesture`.
 */
export function moveSection(store: ProjectStore, id: Id, delta: number, opts: { copy?: boolean; gesture?: string } = {}): SongEditResult & { sectionId?: Id } {
  const p = store.getState();
  const s = findSection(p, id);
  if (!s) return NOT_FOUND('section');
  if (!isInt(delta)) return refuse('invalid', 'Sections move by whole bars.');
  const owned = sectionRegions(p.arrangement.regions, s);
  const span = spanOf([s, ...owned])!;
  const d = clamp(delta, -span[0], MAX_SONG_BARS - span[1]);
  if (d === 0) return opts.copy ? { changed: false } : { changed: false, sectionId: id, ids: owned.map((r) => r.id) };
  const res = owned.length
    ? movePure(p, p.arrangement.regions, owned.map((r) => r.id), d, { copy: opts.copy, newId: newRegionId })
    : { regions: p.arrangement.regions, moved: [] as SongRegion[], trimmed: 0, removed: 0 };
  const landed: SongSection = opts.copy ? withMoves({ ...s, id: newSectionId() }, copyMoves(s.moves)) : s;
  const sections = placeSection(p.arrangement.sections, { ...landed, start: s.start + d });
  const verb = opts.copy ? 'Copy' : 'Move';
  const r = commit(store, p, `arrange:${verb} section`, `${verb} ${s.name}`, { regions: res.regions, sections }, opts.gesture);
  return { ...r, sectionId: landed.id, ids: res.moved.map((x) => x.id), trimmed: res.trimmed, removed: res.removed };
}

/**
 * Play a section twice: its length is inserted right after it (insertTime)
 * and a copy of the section (its name and moves) fills those bars with a
 * copy of what plays in it: the part of every region that lies inside the
 * section, in the same phase, so the copy sounds like the section.
 * `sectionId`: the copy; `ids`: the copied regions. One undo step.
 */
export function duplicateSection(store: ProjectStore, id: Id): SongEditResult & { sectionId?: Id } {
  const p = store.getState();
  const s = findSection(p, id);
  if (!s) return NOT_FOUND('section');
  const end = regionEnd(s);
  if (songBars(p) + s.bars > MAX_SONG_BARS) return refuse('limit', `There is no room to play ${s.name} twice: ${TOO_LONG}`);
  const te = insertTime(p, p.arrangement.regions, p.arrangement.sections, end, s.bars, newRegionId);
  const copies: SongRegion[] = [];
  for (const r of te.regions) {
    if (regionEnd(r) <= s.start || r.start >= end) continue;
    const from = Math.max(r.start, s.start);
    copies.push({ ...r, id: newRegionId(), start: from + s.bars, bars: Math.min(regionEnd(r), end) - from, offset: clipBarAt(r, clipBarsOf(p, r), from) });
  }
  const regions = placeRegions(p, te.regions, copies, { newId: newRegionId }).regions;
  const copy = withMoves({ id: newSectionId(), name: s.name, start: end, bars: s.bars }, copyMoves(s.moves));
  const r = commit(store, p, 'arrange:Duplicate section', `Duplicate ${s.name}`, { regions, sections: placeSection(te.sections, copy) });
  return { ...r, ids: copies.map((x) => x.id), ...(r.changed ? { sectionId: copy.id } : {}) };
}

/**
 * Delete a section. Without `withMusic` only the label (and its moves) goes;
 * the music stays. With it, its bars are taken out of the song (removeTime):
 * the loops there go and everything after moves earlier (`removed`: loops
 * that went, `trimmed`: loops cut at its edges). One undo step.
 */
export function removeSection(store: ProjectStore, id: Id, opts: { withMusic?: boolean } = {}): SongEditResult {
  const p = store.getState();
  const s = findSection(p, id);
  if (!s) return NOT_FOUND('section');
  if (!opts.withMusic) return commit(store, p, 'arrange:Delete section', `Delete ${s.name}`, { sections: p.arrangement.sections.filter((x) => x.id !== id) });
  const te = removeTime(p, p.arrangement.regions, p.arrangement.sections, s.start, regionEnd(s), newRegionId);
  const r = commit(store, p, 'arrange:Delete section with its music', `Delete ${s.name} and its music`, te);
  return { ...r, ...gapChanges(p.arrangement.regions, s.start, regionEnd(s)) };
}

/* ------------------------------------------------------------------ */
/* Song helpers: build up, strip down, breakdown                       */
/* ------------------------------------------------------------------ */

/**
 * The order parts come in during a build-up (and leave in reverse during a
 * strip-down), by role: the atmosphere first (texture, then pad), then the
 * harmony and the tunes (chords, lead, then the sampler part, which carries
 * vocals and chops), then the rhythm section (percussion, bass) and the drums
 * last, so the beat lands as the payoff. Parts with the same role keep their
 * track order.
 */
export const BUILD_ORDER: readonly TrackRole[] = ['texture', 'pad', 'chords', 'lead', 'sampler', 'percussion', 'bass', 'drums'];

/** The parts a breakdown takes out of a section. */
export const BREAKDOWN_ROLES: readonly TrackRole[] = ['drums', 'percussion', 'bass'];

/**
 * - 'build': parts come in one at a time across the section, in BUILD_ORDER;
 * - 'strip': the reverse: every part first, then they drop out one at a time;
 * - 'breakdown': the drums, percussion and bass leave the section.
 */
export type ShapeKind = 'build' | 'strip' | 'breakdown';

/** The parts that play somewhere in bars [from, to) of `regions`, in build order (pure). */
export function soundingInBuildOrder(p: Project, regions: readonly SongRegion[], from: number, to: number): Id[] {
  const rank = (role: TrackRole) => {
    const i = BUILD_ORDER.indexOf(role);
    return i < 0 ? BUILD_ORDER.length : i;
  };
  const sounding = new Set(regions.filter((r) => r.start < to && regionEnd(r) > from).map((r) => r.trackId));
  return p.tracks
    .map((t, i) => ({ id: t.id, rank: rank(t.role), i }))
    .filter((t) => sounding.has(t.id))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((t) => t.id);
}

/** Bars in [lo, hi) where region `r`'s clip starts again. */
function clipStarts(r: SongRegion, cb: number, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let b = lo + mod(-clipBarAt(r, cb, lo), cb); b < hi; b += cb) out.push(b);
  return out;
}

/** The candidate nearest `target`; a tie goes to the later one when `later`, else to the earlier. */
function nearest(candidates: readonly number[], target: number, later: boolean): number {
  let best = candidates[0];
  for (const c of candidates) {
    const d = Math.abs(c - target);
    const bd = Math.abs(best - target);
    if (d < bd || (d === bd && (later ? c > best : c < best))) best = c;
  }
  return best;
}

interface ShapePlan {
  regions: SongRegion[];
  /** The parts whose regions were cut. */
  parts: Id[];
  trimmed: number;
  removed: number;
}

/**
 * What a song helper does to bars [from, to) of `regions` (pure; L = to −
 * from, k parts playing there in build order). Build: part i comes in near
 * bar from + i·L/k, where its clip starts (the bars before are cut from its
 * regions, so each starts later by whole clip lengths and stays in phase).
 * Strip: part i drops out near bar to − i·L/k, where its clip has just
 * played through (the bars after are cut up to `to`; music after it stays).
 * Breakdown: the drums, percussion and bass are cut out of the bars.
 */
function shapePlan(p: Project, regions: readonly SongRegion[], from: number, to: number, kind: ShapeKind): ShapePlan {
  const L = to - from;
  const order = soundingInBuildOrder(p, regions, from, to);
  const beat = new Set<TrackRole>(BREAKDOWN_ROLES);
  const k = order.length;
  const cut = new Set<Id>();
  let trimmed = 0;
  let removed = 0;
  const out: SongRegion[] = [];
  for (const r of regions) {
    const i = order.indexOf(r.trackId);
    const s0 = Math.max(r.start, from);
    const e0 = Math.min(regionEnd(r), to);
    let gap: [number, number] | null = null;
    if (i >= 0 && s0 < e0) {
      const cb = clipBarsOf(p, r);
      if (kind === 'breakdown') {
        if (beat.has(p.tracks.find((t) => t.id === r.trackId)!.role)) gap = [s0, e0];
      } else if (kind === 'build') {
        const target = from + Math.round((i * L) / k);
        if (target >= e0) gap = [s0, e0];
        else if (target > s0) {
          const c = nearest([s0, ...clipStarts(r, cb, s0 + 1, e0)], target, true);
          if (c > s0) gap = [s0, c];
        }
      } else {
        const target = to - Math.round((i * L) / k);
        if (target <= s0) gap = [s0, e0];
        else if (target < e0) {
          const c = nearest([...clipStarts(r, cb, s0 + 1, e0), e0], target, false);
          if (c < e0) gap = [c, e0];
        }
      }
    }
    if (!gap) {
      out.push(r);
      continue;
    }
    cut.add(r.trackId);
    const pieces = carve(r, gap[0], gap[1], clipBarsOf(p, r), newRegionId);
    if (pieces.length) trimmed++;
    else removed++;
    out.push(...pieces);
  }
  return { regions: sortRegions(p, out), parts: order.filter((id) => cut.has(id)), trimmed, removed };
}

/** Why a song helper would do nothing to bars [from, to) of `regions`, in plain words, or null. */
function shapeProblemFor(p: Project, regions: readonly SongRegion[], from: number, to: number, kind: ShapeKind): string | null {
  const order = soundingInBuildOrder(p, regions, from, to);
  if (!order.length) return 'No part plays here.';
  if (kind === 'breakdown') {
    const roles = new Set<TrackRole>(BREAKDOWN_ROLES);
    const beat = order.filter((id) => roles.has(p.tracks.find((t) => t.id === id)!.role));
    if (!beat.length) return 'No drums, percussion or bass play here.';
    if (beat.length === order.length) return 'Only drums, percussion and bass play here: a breakdown would leave silence.';
    return null;
  }
  if (order.length === 1) return `Only one part plays here: there is nothing to ${kind === 'build' ? 'bring in' : 'drop out'} one at a time.`;
  if (!shapePlan(p, regions, from, to, kind).parts.length) {
    return `The clips here are as long as the section, so the parts cannot ${kind === 'build' ? 'come in' : 'drop out'} one at a time: make the section longer first.`;
  }
  return null;
}

/** Why `kind` would do nothing to section `id`, in plain words, or null when it can shape it. */
export function shapeProblem(p: Project, id: Id, kind: ShapeKind): string | null {
  const s = findSection(p, id);
  if (!s) return 'That section no longer exists.';
  return shapeProblemFor(p, p.arrangement.regions, s.start, regionEnd(s), kind);
}

const SHAPE_WORDS: Record<ShapeKind, string> = { build: 'Build up', strip: 'Strip down', breakdown: 'Breakdown' };

/**
 * Shape a section with a song helper (one undo step, "Build up Drop", "Strip
 * down Outro", "Breakdown in Break"): build up (parts come in one at a time),
 * strip down (they drop out one at a time) or breakdown (drums, percussion
 * and bass leave). Only regions are cut, at clip boundaries, so everything
 * stays in phase and the song keeps its length. Refused, saying why
 * (shapeProblem), when it would do nothing. `ids`: the regions now playing in
 * the section.
 */
export function shapeSection(store: ProjectStore, id: Id, kind: ShapeKind): SongEditResult {
  const p = store.getState();
  const s = findSection(p, id);
  if (!s) return NOT_FOUND('section');
  if (!Object.prototype.hasOwnProperty.call(SHAPE_WORDS, kind)) return refuse('invalid', 'That is not a song helper.');
  const problem = shapeProblem(p, id, kind);
  if (problem) return refuse('invalid', problem);
  const end = regionEnd(s);
  const plan = shapePlan(p, p.arrangement.regions, s.start, end, kind);
  const display = kind === 'breakdown' ? `Breakdown in ${s.name}` : `${SHAPE_WORDS[kind]} ${s.name}`;
  const r = commit(store, p, `arrange:${SHAPE_WORDS[kind]}`, display, { regions: plan.regions });
  const ids = plan.regions.filter((x) => x.start < end && regionEnd(x) > s.start).map((x) => x.id);
  return { ...r, ids, trimmed: plan.trimmed, removed: plan.removed };
}

/* ------------------------------------------------------------------ */
/* An intro and an ending                                              */
/* ------------------------------------------------------------------ */

/** Seconds of echo tail an added ending makes sure of (when the tail was off). */
export const ENDING_TAIL_SECONDS = 2;

/** Where an intro or ending takes its clips from: the first (last) section with music, else the song's first (last) 8 bars. */
function edgeRange(p: Project, which: 'first' | 'last'): [number, number] | null {
  const regions = p.arrangement.regions;
  const span = spanOf(regions);
  if (!span) return null;
  const sections = sortSections(p.arrangement.sections).filter((s) => regions.some((r) => r.start < regionEnd(s) && regionEnd(r) > s.start));
  const s = which === 'first' ? sections[0] : sections[sections.length - 1];
  if (s) return [s.start, regionEnd(s)];
  return which === 'first' ? [span[0], Math.min(span[1], span[0] + 8)] : [Math.max(span[0], span[1] - 8), span[1]];
}

/** For every part playing in bars [from, to), the clip of its first (or last) region there, in track order. */
function edgeClips(p: Project, from: number, to: number, which: 'first' | 'last'): { trackId: Id; clip: Clip }[] {
  const out: { trackId: Id; clip: Clip }[] = [];
  for (const t of p.tracks) {
    const rs = p.arrangement.regions.filter((r) => r.trackId === t.id && r.start < to && regionEnd(r) > from);
    const r = which === 'first' ? rs[0] : rs[rs.length - 1];
    const rc = r ? regionClip(p, r) : null;
    if (rc) out.push({ trackId: t.id, clip: rc.clip });
  }
  return out;
}

/**
 * Length of an intro or ending, 4 to 8 bars: whole passes of its longest
 * clip, one pass per part as 2.2's helpers had it (2 to 4 passes), fewer when
 * that would pass 8 bars and more when it would be under 4.
 */
function edgeBars(clips: readonly { clip: Clip }[]): number {
  const pass = Math.max(1, ...clips.map((c) => c.clip.bars));
  let n = clamp(clips.length, 2, 4);
  while (n > 1 && n * pass > 8) n--;
  while (n * pass < 4) n++;
  return n * pass;
}

/**
 * "Add an intro": 4 to 8 bars before the song made from the clips its first
 * section plays (each from its start), the parts coming in one at a time in
 * build order (the quieter ones first, the drums last), under a section
 * named Intro. The song moves later to make room. One undo step;
 * `sectionId`: the Intro, `ids`: its regions.
 */
export function addIntro(store: ProjectStore): SongEditResult & { sectionId?: Id } {
  const p = store.getState();
  const range = edgeRange(p, 'first');
  if (!range) return refuse('empty', 'The song has no music yet: add some loops first.');
  const clips = edgeClips(p, range[0], range[1], 'first');
  const bars = edgeBars(clips);
  if (songBars(p) + bars > MAX_SONG_BARS) return refuse('limit', `There is no room for an intro: ${TOO_LONG}`);
  const te = insertTime(p, p.arrangement.regions, p.arrangement.sections, 0, bars, newRegionId);
  const intro: SongRegion[] = clips.map((c) => ({ id: newRegionId(), trackId: c.trackId, clipId: c.clip.id, start: 0, bars, offset: 0 }));
  const shaped = clips.length > 1 ? shapePlan(p, intro, 0, bars, 'build').regions : intro;
  const section: SongSection = { id: newSectionId(), name: 'Intro', start: 0, bars };
  const r = commit(store, p, 'arrange:Add an intro', 'Add an intro', { regions: sortRegions(p, [...te.regions, ...shaped]), sections: placeSection(te.sections, section) });
  return { ...r, ids: shaped.map((x) => x.id), ...(r.changed ? { sectionId: section.id } : {}) };
}

/**
 * "Add an ending": 4 to 8 bars after the song made from the clips its last
 * section plays, the parts dropping out one at a time (the drums first),
 * under a section named Ending that fades out. An export tail of 0 s becomes
 * ENDING_TAIL_SECONDS so the end rings out. One undo step; `sectionId`: the
 * Ending, `ids`: its regions.
 */
export function addEnding(store: ProjectStore): SongEditResult & { sectionId?: Id } {
  const p = store.getState();
  const range = edgeRange(p, 'last');
  if (!range) return refuse('empty', 'The song has no music yet: add some loops first.');
  const clips = edgeClips(p, range[0], range[1], 'last');
  const bars = edgeBars(clips);
  const start = songBars(p);
  if (start + bars > MAX_SONG_BARS) return refuse('limit', `There is no room for an ending: ${TOO_LONG}`);
  const ending: SongRegion[] = clips.map((c) => ({ id: newRegionId(), trackId: c.trackId, clipId: c.clip.id, start, bars, offset: 0 }));
  const shaped = clips.length > 1 ? shapePlan(p, ending, start, start + bars, 'strip').regions : ending;
  const section: SongSection = { id: newSectionId(), name: 'Ending', start, bars, moves: [{ id: uid('mv'), kind: 'fadeOut' }] };
  const change: SongChange = { regions: sortRegions(p, [...p.arrangement.regions, ...shaped]), sections: placeSection(p.arrangement.sections, section) };
  if (p.arrangement.tailSeconds === 0) change.tailSeconds = ENDING_TAIL_SECONDS;
  const r = commit(store, p, 'arrange:Add an ending', 'Add an ending', change);
  return { ...r, ids: shaped.map((x) => x.id), ...(r.changed ? { sectionId: section.id } : {}) };
}

/** Effect tail appended to exports, 0–10 seconds. A shared gesture id (a drag) makes one undo step. */
export function setTailSeconds(store: ProjectStore, seconds: number, gesture?: string): CommandResult {
  if (!isFiniteNumber(seconds)) return refuse('invalid', 'The tail length must be a number.');
  return commit(store, store.getState(), 'arrange:Change tail length', 'Change tail length', { tailSeconds: clamp(seconds, 0, 10) }, gesture);
}

/* ------------------------------------------------------------------ */
/* A recorded take as song loops                                       */
/* ------------------------------------------------------------------ */

export interface TakeRegionsPlan {
  /** Regions from bar 0 (the take's start), in time order, without ids. */
  regions: Omit<SongRegion, 'id'>[];
  /** The take's length in whole bars. */
  bars: number;
  /** A launch, or the take's start, fell between bar lines (rounded to the nearest). */
  rounded: boolean;
  /** Stretches whose clip has been deleted since (left out). */
  missing: number;
}

/**
 * What a recorded take played, as song regions (pure): what each part played
 * when the take began, and each later launch (a pad, a scene, Stop All),
 * plays until that part's next launch or stop, in whole bars from the take's
 * start. A launch starts its clip from the top; what was already playing
 * when the take began carries on in its phase. Clips are found by id (rows
 * may have moved since, or the clip moved to another part); a clip deleted
 * since is left out (`missing`). Touching regions that play on as one are
 * joined. Null when there is no such take.
 */
export function takeToRegions(p: Project, takeId: Id): TakeRegionsPlan | null {
  const perf = p.performances.find((x) => x.id === takeId);
  if (!perf) return null;
  const snap = perf.snapshot;
  const start = perf.startTick;
  const total = Math.max(0, Math.round((perf.endTick - start) / TICKS_PER_BAR));
  let rounded = false;
  const barOf = (tick: number): number => {
    const exact = (tick - start) / TICKS_PER_BAR;
    if (Math.abs(exact - Math.round(exact)) > 1e-6) rounded = true;
    return clamp(Math.round(exact), 0, total);
  };
  // What each part of the take plays now: its clip (by id), since which bar, from which bar of the clip.
  const now = new Map<Id, { clipId: Id | null; since: number; offset: number }>();
  for (const t of snap.tracks) now.set(t.id, { clipId: null, since: 0, offset: 0 });
  for (const e of snap.launcher) {
    const t = snap.tracks.find((x) => x.id === e.trackId);
    const clip = e.playing && t ? t.clips[e.playing.slot] : null;
    if (!t || !clip || !e.playing) continue;
    const phase = (start - e.playing.startTick) / TICKS_PER_BAR;
    if (Math.abs(phase - Math.round(phase)) > 1e-6) rounded = true;
    now.set(t.id, { clipId: clip.id, since: 0, offset: mod(Math.round(phase), clip.bars) });
  }
  const stretches: Omit<SongRegion, 'id'>[] = [];
  const play = (trackId: Id, clipId: Id | null, bar: number) => {
    const cur = now.get(trackId);
    if (!cur) return;
    if (cur.clipId && bar > cur.since) stretches.push({ trackId, clipId: cur.clipId, start: cur.since, bars: bar - cur.since, offset: cur.offset });
    now.set(trackId, { clipId, since: bar, offset: 0 });
  };
  const changes = perf.events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => (e.type === 'launch' || e.type === 'scene' || e.type === 'stopAll') && e.atTick >= start && e.atTick < perf.endTick)
    .sort((a, b) => (a.e as { atTick: number }).atTick - (b.e as { atTick: number }).atTick || a.i - b.i);
  for (const { e } of changes) {
    if (e.type === 'launch') {
      const t = snap.tracks.find((x) => x.id === e.trackId);
      play(e.trackId, (t && e.slot !== null ? t.clips[e.slot]?.id : null) ?? null, barOf(e.atTick));
    } else if (e.type === 'scene') {
      const bar = barOf(e.atTick);
      for (const t of snap.tracks) play(t.id, t.clips[e.row]?.id ?? null, bar);
    } else if (e.type === 'stopAll') {
      const bar = barOf(e.atTick);
      for (const t of snap.tracks) play(t.id, null, bar);
    }
  }
  for (const t of snap.tracks) play(t.id, null, total);

  let missing = 0;
  const regions: SongRegion[] = [];
  for (const st of stretches) {
    const where = findClip(p, st.clipId);
    if (!where) {
      missing++;
      continue;
    }
    regions.push({ ...st, id: `take${regions.length}`, trackId: where.track.id, offset: mod(st.offset, where.clip.bars) });
  }
  const joined = mergeTouching(p, regions).map(({ id: _id, ...r }) => r);
  return { regions: joined, bars: total, rounded, missing };
}

/**
 * "Make song from a take" (one undo step): what the take played becomes
 * regions from bar `at` (default: the song's end), winning where they land
 * (see takeToRegions). `ids`: the new regions; `rounded` and `missing` let
 * the message say what was rounded or left out.
 */
export function songFromTake(store: ProjectStore, takeId: Id, opts: { at?: number } = {}): SongEditResult & { rounded?: boolean; missing?: number } {
  const p = store.getState();
  const perf = p.performances.find((x) => x.id === takeId);
  const plan = takeToRegions(p, takeId);
  if (!perf || !plan) return NOT_FOUND('take');
  const at = opts.at ?? songBars(p);
  if (!isInt(at) || at < 0) return refuse('invalid', WHOLE_BARS);
  if (!plan.regions.length) {
    const why = plan.missing ? 'the clips it played have been deleted since' : 'nothing played in it for a whole bar';
    return { ...refuse('empty', `This take makes no song: ${why}.`), rounded: plan.rounded, missing: plan.missing };
  }
  const end = Math.max(...plan.regions.map((r) => r.start + r.bars));
  if (at + end > MAX_SONG_BARS) return refuse('limit', `There is no room for this take there: ${TOO_LONG}`);
  const res = landRegions(p, plan.regions.map((r) => ({ ...r, id: newRegionId(), start: r.start + at })));
  const r = commit(store, p, 'arrange:Make song from a take', `Make song from ${perf.name}`, { regions: res.regions });
  return { ...r, ids: res.ids, trimmed: res.trimmed, removed: res.removed, rounded: plan.rounded, missing: plan.missing };
}
