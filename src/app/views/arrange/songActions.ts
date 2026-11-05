/**
 * Song view actions: each runs one undoable song command through the
 * session, then selects what it made (moved, copied, pasted, added) and, for
 * edits made from a key or a menu, says what happened with Undo ("Deleted 3
 * loops"). Drags say nothing: the timeline shows the result and Undo is one
 * key away.
 *
 * While a performance take records, the song is locked: an action is refused
 * at once with one plain line instead of reaching the command.
 *
 * The loop clipboard lives here (module level): Ctrl+C keeps the selected
 * loops (part, clip, length, where in the clip and where from each other),
 * Ctrl+V puts copies at the playhead on the same parts.
 */
import { regionEnd } from '../../../project/arrangement';
import { clipById, isSongSlot, slotOfClip } from '../../../project/clips';
import type { ClipBars, Id, SongMoveKind } from '../../../project/types';
import { uiStore } from '../../../state/uiStore';
import { session } from '../../instance';
import { notify, runtimeStore } from '../../runtime';
import * as songCmd from '../../../state/commands';
import type { Edge, RegionClipboard, ShapeKind, SongEditResult } from '../../../state/commands';
import { editorStore } from './editorStore';
import { clearSelection, setSelection } from './laneStore';
import { freshName, libraryLoop, loopTarget, partProblem, realizeFor } from './library/libraryModel';
import { barsText, scenePlaces } from './songModel';

const project = () => session.store.getState();
const regions = () => project().arrangement.regions;

/** Said when an edit is refused while a performance take records. */
export const LOCKED_TEXT = 'The song is locked while a performance records. Stop the take to change it.';

export function songLocked(): boolean {
  return session.store.info.getState().lock !== null;
}

function lockedNow(): boolean {
  if (!songLocked()) return false;
  notify(LOCKED_TEXT, 'warn');
  return true;
}

/** A loop's name: its clip's name (a pad's clip or a loop of the song's own). */
export function regionName(id: Id): string {
  const p = project();
  const r = p.arrangement.regions.find((x) => x.id === id);
  if (!r) return 'loop';
  const t = p.tracks.find((x) => x.id === r.trackId);
  return (t && clipById(t, r.clipId)?.name) || 'loop';
}

/** "Four Floor", or "3 loops". */
export function loopsWords(ids: readonly Id[]): string {
  return ids.length === 1 ? regionName(ids[0]) : `${ids.length} loops`;
}

function said(text: string, r: { noStep?: boolean }): void {
  notify(text, 'info', r.noStep ? undefined : 'undo');
}

/** Select what an edit made (and put keyboard focus on the first of it). */
function select(ids: readonly Id[] | undefined): void {
  if (!ids?.length) return;
  setSelection({ ids: [...ids], focus: ids[0] });
}

function run(r: SongEditResult, opts: { select?: boolean; text?: string } = {}): SongEditResult {
  if (!session.accepted(r)) return r;
  if (opts.select !== false) select(r.ids);
  if (opts.text) said(opts.text, r);
  return r;
}

/* ------------------------------------------------------------------ */
/* Regions                                                             */
/* ------------------------------------------------------------------ */

export function moveLoops(ids: readonly Id[], delta: number, opts: { copy?: boolean; say?: boolean } = {}): SongEditResult | null {
  if (!ids.length || lockedNow()) return null;
  if (!delta && !opts.copy) return null;
  // The words only when they are said (a drop says nothing: it is drawn).
  const words = opts.say ? loopsWords(ids) : '';
  const r = songCmd.moveRegions(session.store, ids, delta, { copy: opts.copy });
  const first = opts.say && r.ids?.length ? regions().find((x) => x.id === r.ids![0]) : null;
  return run(r, { text: opts.say ? `${opts.copy ? 'Copied' : 'Moved'} ${words}${first ? ` to bar ${first.start + 1}` : ''}` : undefined });
}

export function resizeLoops(ids: readonly Id[], edge: Edge, delta: number, opts: { say?: boolean } = {}): SongEditResult | null {
  if (!ids.length || !delta || lockedNow()) return null;
  const words = opts.say ? loopsWords(ids) : '';
  const r = songCmd.resizeRegions(session.store, ids, edge, delta);
  const one = ids.length === 1 ? regions().find((x) => x.id === ids[0]) : null;
  const text = edge === 'end' ? (one ? `${words} now lasts ${barsText(one.bars)}` : `${delta > 0 ? 'Lengthened' : 'Shortened'} ${words}`) : one ? `${words} now starts at bar ${one.start + 1}` : `Trimmed ${words}`;
  return run(r, { select: false, text: opts.say ? text : undefined });
}

/** "Make it 2× longer": the loop lasts twice as long (its clip repeats to fill it). */
export function doubleLoop(id: Id): SongEditResult | null {
  const r = regions().find((x) => x.id === id);
  if (!r) return null;
  return resizeLoops([id], 'end', r.bars, { say: true });
}

export function deleteLoops(ids: readonly Id[], opts: { cut?: boolean } = {}): SongEditResult | null {
  if (!ids.length || lockedNow()) return null;
  const words = loopsWords(ids);
  const r = songCmd.removeRegions(session.store, ids, { cut: opts.cut });
  if (!session.accepted(r)) return r;
  clearSelection();
  said(`${opts.cut ? 'Cut' : 'Deleted'} ${words}`, r);
  return r;
}

export function duplicateLoops(ids: readonly Id[]): SongEditResult | null {
  if (!ids.length || lockedNow()) return null;
  const words = loopsWords(ids);
  return run(songCmd.duplicateRegions(session.store, ids), { text: `Duplicated ${words}` });
}

/** Split the loops `ids` that cross bar `at`: the right-hand pieces are selected (the next Split, Delete or drag acts on them). */
export function splitLoops(ids: readonly Id[], at: number): SongEditResult | null {
  if (lockedNow()) return null;
  const crossing = ids.filter((id) => {
    const r = regions().find((x) => x.id === id);
    return r && r.start < at && at < regionEnd(r);
  });
  if (!crossing.length) {
    notify(`Nothing to split at bar ${at + 1}: put the playhead inside a selected loop.`, 'warn');
    return null;
  }
  const words = loopsWords(crossing);
  const r = songCmd.splitRegions(session.store, crossing, at);
  if (!session.accepted(r)) return r;
  select(r.ids);
  said(`Split ${words} at bar ${at + 1}`, r);
  return r;
}

export function swapLoopClip(id: Id, clipId: Id): SongEditResult | null {
  if (lockedNow()) return null;
  const r = songCmd.setRegionClip(session.store, id, clipId);
  return run(r, { select: false, text: `Now plays ${regionName(id)}` });
}

/** A part's loop placed at `bar` (its clip's length). */
export function addLoop(trackId: Id, clipId: Id, bar: number): SongEditResult | null {
  if (lockedNow()) return null;
  return run(songCmd.addClipToSong(session.store, trackId, clipId, bar));
}

/**
 * A scene's loops placed from `bar` (with a section named after it where
 * there is none). Nothing is left selected: the next press on one of its
 * loops (to stretch or move it) acts on that loop alone.
 */
export function addScene(row: number, bar: number): SongEditResult | null {
  if (lockedNow()) return null;
  const r = run(songCmd.addSceneToSong(session.store, row, bar), { select: false });
  if (r.changed) clearSelection();
  return r;
}

/* ------------------------------------------------------------------ */
/* Loops of the song's own (library loops, new empty loops, copies)    */
/* ------------------------------------------------------------------ */

const partNameOf = (trackId: Id) => project().tracks.find((t) => t.id === trackId)?.name ?? 'the part';

/**
 * A library loop (or a beat) put on part `trackId` from `bar`: its notes in
 * the song's key (on the part's kit), as a new loop of the song's own, in one
 * undo step "Add <name>". Refused in plain words when the part cannot play
 * it. The new loop is selected; `say` (Enter, a menu) says where it went.
 */
export function addLibraryLoop(loopId: string, trackId: Id, bar: number, opts: { say?: boolean } = {}): (songCmd.CommandResult & { regionId?: Id }) | null {
  if (lockedNow()) return null;
  const p = project();
  const loop = libraryLoop(loopId);
  const t = p.tracks.find((x) => x.id === trackId);
  if (!loop || !t) return null;
  const problem = partProblem(loop, t);
  if (problem) {
    notify(problem, 'warn');
    return null;
  }
  const notes = realizeFor(p, loop, t);
  if (!notes) return null;
  const name = freshName(t, notes.name);
  const r = songCmd.addLoopToSong(session.store, trackId, bar, { name, bars: notes.bars, notes: notes.notes }, { display: `Add ${name}` });
  if (!session.accepted(r)) return r;
  select(r.regionId ? [r.regionId] : undefined);
  const placed = r.regionId ? regions().find((x) => x.id === r.regionId) : undefined;
  if (opts.say) said(`Added ${name} to ${t.name}${placed ? ` at bar ${placed.start + 1}` : ''}`, r);
  return r;
}

/** Enter on a library loop: it goes to its kind of part (see loopTarget) at `bar`, said with Undo. */
export function addLibraryLoopHere(loopId: string, bar: number): (songCmd.CommandResult & { regionId?: Id }) | null {
  const loop = libraryLoop(loopId);
  if (!loop) return null;
  const target = loopTarget(project(), loop, uiStore.getState().selectedTrackId);
  if ('problem' in target) {
    notify(target.problem, 'warn');
    return null;
  }
  return addLibraryLoop(loopId, target.trackId, bar, { say: true });
}

/** "New empty loop" (a row's empty spot): a loop `bars` long with no notes at `bar`, opened in the editor below to fill. */
export function newEmptyLoop(trackId: Id, bar: number, bars: ClipBars): (songCmd.CommandResult & { regionId?: Id }) | null {
  if (lockedNow()) return null;
  const r = songCmd.addLoopToSong(session.store, trackId, bar, { bars });
  if (!session.accepted(r) || !r.regionId || !r.clipId) return r;
  select([r.regionId]);
  editorStore.setState({ trackId, clipId: r.clipId, regionId: r.regionId });
  const name = clipById(project().tracks.find((t) => t.id === trackId)!, r.clipId)?.name ?? 'a new loop';
  said(`Added ${name}, an empty ${barsText(bars).replace(/s$/, '')} loop on ${partNameOf(trackId)}: add notes in the editor below`, r);
  return r;
}

/** How many places the song plays a region's loop (its regions). */
export function loopUses(regionId: Id): number {
  const p = project();
  const r = p.arrangement.regions.find((x) => x.id === regionId);
  return r ? songCmd.loopUse(p, r.trackId, r.clipId) : 0;
}

/**
 * "Make this one different": the region gets its own copy of its loop (a
 * loop of the song's own), so editing it leaves the other places (and the
 * pad) as they are. An editor open on the region follows the copy.
 */
export function makeLoopDifferent(regionId: Id): (songCmd.CommandResult & { clipId?: Id }) | null {
  if (lockedNow()) return null;
  const before = regions().find((x) => x.id === regionId);
  if (!before) return null;
  const r = songCmd.makeLoopUnique(session.store, regionId);
  if (!session.accepted(r) || !r.clipId) return r;
  const e = editorStore.getState();
  if (e && e.regionId === regionId) editorStore.setState({ ...e, clipId: r.clipId });
  select([regionId]);
  said(`This loop now plays its own copy, ${regionName(regionId)}: edits to it change only ${before.bars === 1 ? `bar ${before.start + 1}` : `bars ${before.start + 1}–${regionEnd(before)}`}`, r);
  return r;
}

/** "Put on a pad": a copy of a loop of the song's own on the part's first empty pad, to play it live. */
export function putLoopOnPad(trackId: Id, clipId: Id): (songCmd.CommandResult & { slot?: number }) | null {
  if (lockedNow()) return null;
  const p = project();
  const t = p.tracks.find((x) => x.id === trackId);
  const slot = t ? slotOfClip(t, clipId) : -1;
  if (!t || !isSongSlot(slot)) return null;
  const name = clipById(t, clipId)?.name ?? 'the loop';
  const r = songCmd.copyLoopToPad(session.store, trackId, slot);
  if (!session.accepted(r) || r.slot === undefined) return r;
  const scene = p.scenes[r.slot]?.name || `scene ${r.slot + 1}`;
  said(`Put a copy of ${name} on the ${t.name} pad in ${scene}: play it live in Play`, r);
  return r;
}

/**
 * A pad clip made in a scene the song uses, added where that scene plays
 * (each place where this part has nothing yet), as one undo step "Add
 * <Loop> where <Scene> plays". Null when there is no such place.
 */
export function addClipWhereScenePlays(trackId: Id, row: number): SongEditResult | null {
  if (lockedNow()) return null;
  const p = project();
  const t = p.tracks.find((x) => x.id === trackId);
  const clip = t?.clips[row];
  if (!t || !clip) return null;
  const places = scenePlaces(p, row, trackId);
  if (!places.length) return null;
  const scene = p.scenes[row]?.name || `Scene ${row + 1}`;
  const r = songCmd.addRegions(
    session.store,
    places.map((pl) => ({ trackId, clipId: clip.id, start: pl.start, bars: pl.bars })),
    { display: `Add ${clip.name} where ${scene} plays` },
  );
  return run(r, { select: false, text: `Added ${clip.name} where ${scene} plays (${places.length === 1 ? '1 place' : `${places.length} places`})` });
}

export function fillFromScenes(): SongEditResult | null {
  if (lockedNow()) return null;
  return run(songCmd.fillSongFromScenes(session.store), { select: false, text: 'Made a song from your scenes' });
}

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */

let clipboard: RegionClipboard | null = null;


/** For tests: empty the loop clipboard. */
export function clearLoopClipboard(): void {
  clipboard = null;
}

export function copyLoops(ids: readonly Id[]): boolean {
  if (!ids.length) return false;
  const c = songCmd.copyRegions(project(), ids);
  if (!c?.items.length) return false;
  clipboard = c;
  notify(`Copied ${loopsWords(ids)}. Ctrl+V puts a copy at the playhead.`);
  return true;
}

/**
 * Delete what is selected: the loops `ids` and the section labels
 * `sectionIds` (their music stays unless it is selected too), as one undo
 * step ("Delete 30 loops and 6 sections").
 */
export function deleteSelection(ids: readonly Id[], sectionIds: readonly Id[] = []): boolean {
  if ((!ids.length && !sectionIds.length) || lockedNow()) return false;
  const p = project();
  const loops = ids.filter((id) => p.arrangement.regions.some((r) => r.id === id));
  const labels = sectionIds.filter((id) => p.arrangement.sections.some((s) => s.id === id));
  if (!labels.length) return !!deleteLoops(loops)?.changed;
  const loopWords = loops.length ? loopsWords(loops) : '';
  const labelWords = labels.length === 1 ? `the section ${sectionName(labels[0])}` : `${labels.length} sections`;
  const words = loopWords ? `${loopWords} and ${labelWords}` : labelWords;
  // One undo step for both (a Record Notes pass already groups every edit it makes).
  const group = runtimeStore.getState().recording !== 'notes';
  if (group) session.store.beginGroup(`arrange:Delete ${words}`);
  let changed = false;
  try {
    if (loops.length) changed = session.accepted(songCmd.removeRegions(session.store, loops)) || changed;
    for (const id of labels) changed = session.accepted(songCmd.removeSection(session.store, id, { withMusic: false })) || changed;
  } finally {
    if (group) session.store.endGroup();
  }
  if (!changed) return false;
  clearSelection();
  notify(`Deleted ${words}`, 'info', 'undo');
  return true;
}

export function cutLoops(ids: readonly Id[]): SongEditResult | null {
  if (!ids.length || lockedNow()) return null;
  const c = songCmd.copyRegions(project(), ids);
  if (!c?.items.length) return null;
  clipboard = c;
  return deleteLoops(ids, { cut: true });
}

export function pasteLoops(atBar: number): SongEditResult | null {
  if (!clipboard?.items.length) {
    notify('Nothing to paste yet: select loops and press Ctrl+C first.', 'warn');
    return null;
  }
  if (lockedNow()) return null;
  const n = clipboard.items.length;
  const r = songCmd.pasteRegions(session.store, clipboard, atBar);
  return run(r, { text: `Pasted ${r.ids?.length === 1 ? regionName(r.ids[0]) : `${r.ids?.length ?? n} loops`} at bar ${atBar + 1}` });
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

const sectionName = (id: Id) => project().arrangement.sections.find((s) => s.id === id)?.name ?? 'section';

/** A section over bars [start, start + bars) (`sectionId`: the new one, so it can be named at once). */
export function addSectionAt(start: number, bars: number): SongEditResult & { sectionId?: Id } {
  if (lockedNow()) return { changed: false };
  const r = songCmd.addSection(session.store, start, bars);
  session.accepted(r);
  return r;
}

export function renameSectionTo(id: Id, name: string): boolean {
  if (lockedNow()) return false;
  return session.accepted(songCmd.renameSection(session.store, id, name));
}

export function moveSectionBy(id: Id, delta: number, copy: boolean): SongEditResult | null {
  if (lockedNow() || (!delta && !copy)) return null;
  return run(songCmd.moveSection(session.store, id, delta, { copy }));
}

export function resizeSectionBy(id: Id, edge: Edge, delta: number): boolean {
  if (lockedNow() || !delta) return false;
  return session.accepted(songCmd.resizeSection(session.store, id, edge, delta));
}

export function duplicateSectionNow(id: Id): SongEditResult | null {
  if (lockedNow()) return null;
  const name = sectionName(id);
  return run(songCmd.duplicateSection(session.store, id), { text: `Duplicated ${name}` });
}

export function removeSectionNow(id: Id, withMusic: boolean): SongEditResult | null {
  if (lockedNow()) return null;
  const name = sectionName(id);
  const r = songCmd.removeSection(session.store, id, { withMusic });
  if (!session.accepted(r)) return r;
  if (withMusic) clearSelection();
  said(withMusic ? `Deleted ${name} and its music` : `Deleted the section ${name} (the music stays)`, r);
  return r;
}

export function toggleSectionMoveNow(id: Id, kind: SongMoveKind): boolean {
  if (lockedNow()) return false;
  return session.accepted(songCmd.toggleSectionMove(session.store, id, kind));
}

export const SHAPE_WORDS: Record<ShapeKind, string> = { build: 'Build up', strip: 'Strip down', breakdown: 'Breakdown' };

export function shapeSectionNow(id: Id, kind: ShapeKind): SongEditResult | null {
  if (lockedNow()) return null;
  const name = sectionName(id);
  return run(songCmd.shapeSection(session.store, id, kind), { select: false, text: `${SHAPE_WORDS[kind]}: ${name}` });
}


/** "Add an intro" / "Add an ending" (Shape the song…): the new bars are selected. */
export function addIntroNow(): SongEditResult | null {
  if (lockedNow()) return null;
  return run(songCmd.addIntro(session.store), { text: 'Added an intro' });
}

export function addEndingNow(): SongEditResult | null {
  if (lockedNow()) return null;
  return run(songCmd.addEnding(session.store), { text: 'Added an ending' });
}

/** A performance take's launches put in the song after its end (each loop on its part's row, as long as it played). */
export function takeToSong(takeId: Id, name: string): SongEditResult | null {
  if (lockedNow()) return null;
  const at = songEnd();
  const r = songCmd.songFromTake(session.store, takeId, { at });
  return run(r, { text: `Put ${name} in the song from bar ${at + 1}` });
}

function songEnd(): number {
  let end = 0;
  for (const r of regions()) end = Math.max(end, regionEnd(r));
  for (const s of project().arrangement.sections) end = Math.max(end, regionEnd(s));
  return end;
}
