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
import type { Id, SongMoveKind } from '../../../project/types';
import { session } from '../../instance';
import { notify } from '../../runtime';
import { songCmd, type Edge, type RegionClipboard, type ShapeKind, type SongEditResult } from './songApi';
import { clearSelection, selectionStore, setSelection } from './laneStore';
import { barsText } from './songModel';

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

/** A loop's name: its clip's name. */
export function regionName(id: Id): string {
  const p = project();
  const r = p.arrangement.regions.find((x) => x.id === id);
  if (!r) return 'loop';
  const t = p.tracks.find((x) => x.id === r.trackId);
  return t?.clips.find((c) => c?.id === r.clipId)?.name || 'loop';
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
  const words = loopsWords(ids);
  const r = songCmd.moveRegions(session.store, ids, delta, { copy: opts.copy });
  const first = r.ids?.length ? regions().find((x) => x.id === r.ids![0]) : null;
  return run(r, { text: opts.say ? `${opts.copy ? 'Copied' : 'Moved'} ${words}${first ? ` to bar ${first.start + 1}` : ''}` : undefined });
}

export function resizeLoops(ids: readonly Id[], edge: Edge, delta: number, opts: { say?: boolean } = {}): SongEditResult | null {
  if (!ids.length || !delta || lockedNow()) return null;
  const words = loopsWords(ids);
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

/** Split the loops `ids` that cross bar `at` (both halves stay selected). */
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
  select([...crossing, ...(r.ids ?? [])]);
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

/** A scene's loops placed from `bar` (with a section named after it where there is none). */
export function addScene(row: number, bar: number): SongEditResult | null {
  if (lockedNow()) return null;
  return run(songCmd.addSceneToSong(session.store, row, bar));
}

export function fillFromScenes(): SongEditResult | null {
  if (lockedNow()) return null;
  return run(songCmd.fillSongFromScenes(session.store), { select: false, text: 'Made a song from your scenes' });
}

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */

let clipboard: RegionClipboard | null = null;

export function hasLoopClipboard(): boolean {
  return !!clipboard?.items.length;
}

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

/** The selection now (for menus and keys that act on it). */
export function selectedIds(): readonly Id[] {
  return selectionStore.getState().ids;
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
