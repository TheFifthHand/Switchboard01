/**
 * Song lane actions: every one runs one undoable arrange command through
 * the session and says what happened in words. Edits get a short toast with
 * Undo that names the block ("Moved Groove to position 3"); a new toast
 * replaces the one before, so a gesture shows one. The returned text is for
 * the lane's polite status line.
 *
 * While a performance take records the song is locked: an action is refused
 * before it reaches the command, quietly, through the lane's lock line (see
 * onSongLocked) instead of the long lock message.
 *
 * The block clipboard lives here (module level): Ctrl+C keeps templates of
 * the selected blocks (no ids), Ctrl+V inserts fresh copies.
 */
import { blockBars } from '../../../project/arrangement';
import { MAX_BLOCK_REPEATS, type Id } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { session } from '../../instance';
import { notify } from '../../runtime';
import { barsText, cellToast, timesText } from './songModel';

const blocks = () => session.store.getState().arrangement.blocks;
const sceneName = (sceneId: Id) => session.store.getState().scenes.find((s) => s.id === sceneId)?.name ?? 'Missing scene';

/** What a block is called: its label, else its scene's name. */
export function blockName(id: Id): string {
  const b = blocks().find((x) => x.id === id);
  if (!b) return 'block';
  return b.label || sceneName(b.sceneId);
}

function names(ids: readonly Id[]): string {
  if (ids.length === 1) return blockName(ids[0]);
  return `${ids.length} blocks`;
}

function position(id: Id): number {
  return blocks().findIndex((b) => b.id === id) + 1;
}

/**
 * A toast for the edit just made (it replaces the toast before it), with Undo
 * unless the edit left no undo step of its own (`r.noStep`: a gesture that
 * came back to where it started; Undo would take back an older edit).
 */
function done(text: string, r?: { noStep?: boolean }): string {
  if (r?.noStep) notify(text.replace(/\.$/, ''));
  else notify(text.replace(/\.$/, ''), 'info', 'undo');
  return text;
}

/* ------------------------------------------------------------------ */
/* The take lock                                                       */
/* ------------------------------------------------------------------ */

let lockedHandler: (() => void) | null = null;

/** The lane says "The song is locked while a take records." its own way; returns the unsubscribe. */
export function onSongLocked(fn: () => void): () => void {
  lockedHandler = fn;
  return () => {
    if (lockedHandler === fn) lockedHandler = null;
  };
}

/** The song is locked (a performance take records). */
export function songLocked(): boolean {
  return session.store.getLock() !== null;
}

/** Refuse an edit while the song is locked: quietly through the lane when it is showing, else as a notice. */
function refusedWhileLocked(): boolean {
  if (!songLocked()) return false;
  if (lockedHandler) lockedHandler();
  else notify(LOCKED_TEXT, 'warn');
  return true;
}

export const LOCKED_TEXT = 'The song is locked while a take records.';

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */

let clipboard: cmd.BlockTemplate[] | null = null;
/**
 * Where the last Cut took its blocks from (an insertion gap) and the song as
 * the Cut left it: while the song is still exactly that, Paste puts them back
 * there.
 */
let cutFrom: { gap: number; blocks: readonly unknown[] } | null = null;

export function hasBlockClipboard(): boolean {
  return !!clipboard?.length;
}

/** For tests: empty the block clipboard. */
export function clearBlockClipboard(): void {
  clipboard = null;
  cutFrom = null;
}

/** Where the blocks just cut came from, while nothing else changed the song since the Cut; else null. */
export function cutOrigin(): number | null {
  return cutFrom && cutFrom.blocks === blocks() ? cutFrom.gap : null;
}

export function copyBlocks(ids: readonly Id[]): string | null {
  const list = blocks().filter((b) => ids.includes(b.id));
  if (!list.length) return null;
  clipboard = list.map((b) => cmd.blockTemplate(b));
  cutFrom = null;
  const text = `Copied ${names(list.map((b) => b.id))}. Ctrl+V pastes after the selected block.`;
  notify(text);
  return text;
}

export function cutBlocks(ids: readonly Id[]): string | null {
  if (refusedWhileLocked()) return null;
  const list = blocks().filter((b) => ids.includes(b.id));
  if (!list.length) return null;
  const label = names(list.map((b) => b.id));
  const templates = list.map((b) => cmd.blockTemplate(b));
  const gap = blocks().findIndex((b) => b.id === list[0].id);
  if (!session.accepted(cmd.removeBlocks(session.store, list.map((b) => b.id), { cut: true }))) return null;
  clipboard = templates;
  cutFrom = { gap, blocks: blocks() };
  const text = `Cut ${label}. Ctrl+V pastes ${list.length === 1 ? 'it' : 'them'} back, after the block you select.`;
  notify(text, 'info', 'undo');
  return text;
}

/** Paste the clipboard at insertion gap `gap`; returns the new block ids. */
export function pasteBlocks(gap: number): { ids: Id[]; text: string } | null {
  if (!clipboard?.length) {
    notify('Nothing to paste yet: copy blocks first (Ctrl+C).', 'warn');
    return null;
  }
  if (refusedWhileLocked()) return null;
  const r = cmd.insertBlocks(session.store, clipboard, gap);
  if (!session.accepted(r) || !r.blockIds?.length) return null;
  cutFrom = null;
  const first = position(r.blockIds[0]);
  const where = r.blockIds.length === 1 ? `block ${first}` : `blocks ${first}–${first + r.blockIds.length - 1}`;
  const skipped = r.skipped ? ` ${r.skipped === 1 ? 'One block was' : `${r.skipped} blocks were`} left out: its scene no longer exists.` : '';
  const text = `Pasted ${r.blockIds.length === 1 ? blockName(r.blockIds[0]) : `${r.blockIds.length} blocks`} as ${where}.${skipped}`;
  notify(text, 'info', 'undo');
  return { ids: r.blockIds, text };
}

/* ------------------------------------------------------------------ */
/* Structure                                                           */
/* ------------------------------------------------------------------ */

export function removeBlocks(ids: readonly Id[]): string | null {
  if (refusedWhileLocked()) return null;
  const list = blocks();
  const order = list.filter((b) => ids.includes(b.id)).map((b) => b.id);
  if (!order.length) return null;
  const label = order.length === 1 ? `${blockName(order[0])} (block ${position(order[0])})` : `${order.length} blocks`;
  if (!session.accepted(cmd.removeBlocks(session.store, order))) return null;
  return done(`Removed ${label} from the song.`);
}

/** Move blocks to insertion gap `gap` (one undo step). */
export function moveBlocks(ids: readonly Id[], gap: number): string | null {
  if (refusedWhileLocked()) return null;
  if (!session.accepted(cmd.moveBlocks(session.store, ids, gap))) return null;
  const order = blocks().filter((b) => ids.includes(b.id));
  if (!order.length) return null;
  const at = position(order[0].id);
  return done(order.length === 1 ? `Moved ${blockName(order[0].id)} to position ${at}.` : `Moved ${order.length} blocks to positions ${at}–${at + order.length - 1}.`);
}

/** Copies of blocks at `gap` (default: right after them). */
export function duplicateBlocks(ids: readonly Id[], gap?: number): { ids: Id[]; text: string } | null {
  if (refusedWhileLocked()) return null;
  const r = cmd.duplicateBlocks(session.store, ids, gap);
  if (!session.accepted(r) || !r.blockIds?.length) return null;
  const at = position(r.blockIds[0]);
  const text =
    r.blockIds.length === 1
      ? `Duplicated ${blockName(r.blockIds[0])}: the copy is block ${at}.`
      : `Duplicated ${r.blockIds.length} blocks: the copies are blocks ${at}–${at + r.blockIds.length - 1}.`;
  notify(text, 'info', 'undo');
  return { ids: r.blockIds, text };
}

/** Add a scene as a new block at `gap` (default: the end). `gesture` joins several additions into one undo step (no toast then). */
export function addScene(sceneId: Id, gap?: number, gesture?: string): { id: Id; text: string } | null {
  if (refusedWhileLocked()) return null;
  const r = cmd.addBlock(session.store, sceneId, gap, undefined, gesture);
  if (!session.accepted(r) || !r.blockId) return null;
  const n = position(r.blockId);
  const text = gap === undefined ? `Added ${sceneName(sceneId)} at the end of the song (block ${n}).` : `Added ${sceneName(sceneId)} as block ${n}.`;
  if (!gesture) done(text);
  return { id: r.blockId, text };
}

/* ------------------------------------------------------------------ */
/* Length                                                              */
/* ------------------------------------------------------------------ */

let gestureCounter = 0;

/** A fresh gesture id: edits that share it are one undo step. */
export function newGesture(what: string): string {
  gestureCounter += 1;
  return `${what}-${Date.now()}-${gestureCounter}`;
}

/** "Groove: plays 3 times, 12 bars". */
export function lengthStatus(name: string, repeats: number, passBars: number): string {
  return `${name}: plays ${timesText(repeats)}, ${barsText(passBars * repeats)}.`;
}

/**
 * Set repeats on blocks (one undo step for all of them; `gesture` lets an
 * edge drag pass its own id). `open` leaves the gesture open, so the next
 * call with the same gesture joins this undo step (quick + / − presses).
 */
export function setRepeats(ids: readonly Id[], repeats: (current: number) => number, gesture?: string, open = false): string | null {
  if (refusedWhileLocked()) return null;
  const g = gesture ?? newGesture('repeats');
  const changed: Id[] = [];
  let noStep = false;
  for (const id of ids) {
    const b = blocks().find((x) => x.id === id);
    if (!b) continue;
    const want = Math.min(MAX_BLOCK_REPEATS, Math.max(1, repeats(b.repeats)));
    if (want === b.repeats) continue;
    const r = cmd.setBlockRepeats(session.store, id, want, g);
    if (!session.accepted(r)) break;
    noStep = !!r.noStep;
    changed.push(id);
  }
  if (!open) session.store.endGesture();
  if (!changed.length) return null;
  if (changed.length > 1) return done(`${changed.length} blocks changed length.`, { noStep });
  const b = blocks().find((x) => x.id === changed[0])!;
  return done(lengthStatus(blockName(changed[0]), b.repeats, blockBars(session.store.getState(), b)), { noStep });
}

/** Split a block after pass `afterPass`; returns the new block's id. */
export function splitBlock(id: Id, afterPass: number): { id: Id; text: string } | null {
  if (refusedWhileLocked()) return null;
  const name = blockName(id);
  const r = cmd.splitBlock(session.store, id, afterPass);
  if (!session.accepted(r) || !r.blockId) return null;
  const b = blocks().find((x) => x.id === r.blockId)!;
  const text = `Split ${name} in two: it plays ${timesText(afterPass)}, then ${timesText(b.repeats)}.`;
  notify(text, 'info', 'undo');
  return { id: r.blockId, text };
}

export function joinWithNext(id: Id): string | null {
  if (refusedWhileLocked()) return null;
  const name = blockName(id);
  if (!session.accepted(cmd.joinWithNext(session.store, id))) return null;
  const b = blocks().find((x) => x.id === id);
  const text = `Joined ${name} with the next block: it plays ${timesText(b?.repeats ?? 1)}.`;
  notify(text, 'info', 'undo');
  return text;
}

/* ------------------------------------------------------------------ */
/* Scene, name, parts                                                  */
/* ------------------------------------------------------------------ */

export function changeScene(id: Id, sceneId: Id): string | null {
  if (refusedWhileLocked()) return null;
  const before = blockName(id);
  if (!session.accepted(cmd.setBlockScene(session.store, id, sceneId))) return null;
  return done(`${before} (block ${position(id)}) now plays ${sceneName(sceneId)}.`);
}

export function renameBlock(id: Id, label: string): string | null {
  if (refusedWhileLocked()) return null;
  const r = cmd.renameBlock(session.store, id, label);
  if (!session.accepted(r)) return null;
  const b = blocks().find((x) => x.id === id);
  return done(b?.label ? `Block ${position(id)} is now called ${b.label}.` : `Block ${position(id)} shows its scene name again.`);
}

/** Layer a scene into a block: fill its silent parts, or (`replace`) every part the scene has. */
export function layerScene(id: Id, sceneId: Id, mode: cmd.LayerMode = 'fill'): string | null {
  if (refusedWhileLocked()) return null;
  const into = blockName(id);
  const b = blocks().find((x) => x.id === id);
  if (b && b.sceneId === sceneId) return `${into} already plays ${sceneName(sceneId)}: nothing changed.`;
  const r = cmd.layerScene(session.store, id, sceneId, mode);
  if (!session.accepted(r)) return null;
  const n = r.parts ?? 0;
  const parts = n === 1 ? '1 part' : `${n} parts`;
  return done(mode === 'replace' ? `Replaced ${parts} of ${into} with ${sceneName(sceneId)}’s.` : `Layered ${sceneName(sceneId)} into ${into}: ${parts} ${n === 1 ? 'plays' : 'play'} its clips.`);
}

/**
 * One part in one block: a scene id (its clip), null (off), or undefined
 * (follow the block's scene). Edits that share `gesture` are one undo step
 * (quick clicks on the same cell). The change is heard at once.
 */
export function setPart(id: Id, trackId: Id, choice: Id | null | undefined, gesture?: string): string | null {
  if (refusedWhileLocked()) return null;
  const r = cmd.setBlockPart(session.store, id, trackId, choice, gesture);
  if (!session.accepted(r)) return null;
  const part = session.store.getState().tracks.find((t) => t.id === trackId)?.name ?? 'Part';
  // Clicked back to where it was: no undo step of its own, so the toast offers no Undo.
  return done(`${cellToast(part, blockName(id), choice, typeof choice === 'string' ? sceneName(choice) : null)}.`, r);
}

/**
 * A song helper on one block (one undo step): build up, strip down or
 * breakdown. Returns what happened and the blocks it made (the first keeps
 * the block's id).
 */
export function shapeBlock(id: Id, kind: cmd.ShapeKind): { ids: Id[]; text: string } | null {
  if (refusedWhileLocked()) return null;
  const name = blockName(id);
  const r = cmd.shapeBlock(session.store, id, kind);
  if (!session.accepted(r) || !r.blockIds?.length) return null;
  const parts = r.parts ?? 0;
  const n = r.blockIds.length;
  const blocksText = n === 1 ? '' : ` (${n} blocks)`;
  const text =
    kind === 'build'
      ? `${name} builds up: its ${parts} parts come in one at a time${blocksText}.`
      : kind === 'strip'
        ? `${name} strips down: its ${parts} parts drop out one at a time${blocksText}.`
        : `Breakdown in ${name}: ${parts === 1 ? '1 part' : `${parts} parts`} of the beat and bass off.`;
  notify(text.replace(/\.$/, ''), 'info', 'undo');
  return { ids: r.blockIds, text };
}

export function resetParts(id: Id): string | null {
  if (refusedWhileLocked()) return null;
  if (!session.accepted(cmd.resetBlockParts(session.store, id))) return null;
  const text = `Every part of ${blockName(id)} follows its scene again.`;
  notify(text, 'info', 'undo');
  return text;
}
