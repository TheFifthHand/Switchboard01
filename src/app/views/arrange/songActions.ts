/**
 * Song lane actions: every one runs one undoable arrange command through
 * the session (which shows a refusal, e.g. while a performance take records)
 * and says what happened in words. Destructive or multi-block changes get a
 * toast with Undo; the returned text is for the lane's polite status line.
 *
 * The block clipboard lives here (module level): Ctrl+C keeps templates of
 * the selected blocks (no ids), Ctrl+V inserts fresh copies.
 */
import { blockBars } from '../../../project/arrangement';
import { MAX_BLOCK_REPEATS, type Id } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { session } from '../../instance';
import { notify } from '../../runtime';
import { barsText, passesText } from './songModel';

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

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */

let clipboard: cmd.BlockTemplate[] | null = null;

export function hasBlockClipboard(): boolean {
  return !!clipboard?.length;
}

/** For tests: empty the block clipboard. */
export function clearBlockClipboard(): void {
  clipboard = null;
}

export function copyBlocks(ids: readonly Id[]): string | null {
  const list = blocks().filter((b) => ids.includes(b.id));
  if (!list.length) return null;
  clipboard = list.map((b) => cmd.blockTemplate(b));
  const text = `Copied ${names(list.map((b) => b.id))}. Ctrl+V pastes after the selected block.`;
  notify(text);
  return text;
}

export function cutBlocks(ids: readonly Id[]): string | null {
  const list = blocks().filter((b) => ids.includes(b.id));
  if (!list.length) return null;
  const label = names(list.map((b) => b.id));
  const templates = list.map((b) => cmd.blockTemplate(b));
  if (!session.accepted(cmd.removeBlocks(session.store, list.map((b) => b.id)))) return null;
  clipboard = templates;
  const text = `Cut ${label}. Ctrl+V pastes it back where you want it.`;
  notify(text, 'info', 'undo');
  return text;
}

/** Paste the clipboard at insertion gap `gap`; returns the new block ids. */
export function pasteBlocks(gap: number): { ids: Id[]; text: string } | null {
  if (!clipboard?.length) {
    notify('Nothing to paste yet: copy blocks first (Ctrl+C).', 'warn');
    return null;
  }
  const r = cmd.insertBlocks(session.store, clipboard, gap);
  if (!session.accepted(r) || !r.blockIds?.length) return null;
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
  const list = blocks();
  const order = list.filter((b) => ids.includes(b.id)).map((b) => b.id);
  if (!order.length) return null;
  const label = order.length === 1 ? `${blockName(order[0])} (block ${position(order[0])})` : `${order.length} blocks`;
  if (!session.accepted(cmd.removeBlocks(session.store, order))) return null;
  const text = `Removed ${label} from the song.`;
  notify(text, 'info', 'undo');
  return text;
}

/** Move blocks to insertion gap `gap` (one undo step). */
export function moveBlocks(ids: readonly Id[], gap: number): string | null {
  if (!session.accepted(cmd.moveBlocks(session.store, ids, gap))) return null;
  const order = blocks().filter((b) => ids.includes(b.id));
  if (!order.length) return null;
  const at = position(order[0].id);
  return order.length === 1 ? `Moved ${blockName(order[0].id)} to position ${at}.` : `Moved ${order.length} blocks to positions ${at}–${at + order.length - 1}.`;
}

/** Copies of blocks at `gap` (default: right after them). */
export function duplicateBlocks(ids: readonly Id[], gap?: number): { ids: Id[]; text: string } | null {
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

/** Add a scene as a new block at `gap` (default: the end). */
export function addScene(sceneId: Id, gap?: number): { id: Id; text: string } | null {
  const r = cmd.addBlock(session.store, sceneId, gap);
  if (!session.accepted(r) || !r.blockId) return null;
  return { id: r.blockId, text: `Added ${sceneName(sceneId)} as block ${position(r.blockId)}.` };
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

/** "Groove: 3 passes, 12 bars". */
export function lengthStatus(name: string, repeats: number, passBars: number): string {
  return `${name}: ${passesText(repeats)}, ${barsText(passBars * repeats)}.`;
}

/**
 * Set repeats on blocks (one undo step for all of them; `gesture` lets an
 * edge drag pass its own id).
 */
export function setRepeats(ids: readonly Id[], repeats: (current: number) => number, gesture?: string): string | null {
  const g = gesture ?? newGesture('repeats');
  const changed: Id[] = [];
  for (const id of ids) {
    const b = blocks().find((x) => x.id === id);
    if (!b) continue;
    const want = Math.min(MAX_BLOCK_REPEATS, Math.max(1, repeats(b.repeats)));
    if (want === b.repeats) continue;
    if (!session.accepted(cmd.setBlockRepeats(session.store, id, want, g))) break;
    changed.push(id);
  }
  session.store.endGesture();
  if (!changed.length) return null;
  if (changed.length > 1) return `${changed.length} blocks changed length.`;
  const b = blocks().find((x) => x.id === changed[0])!;
  return lengthStatus(blockName(changed[0]), b.repeats, blockBars(session.store.getState(), b));
}

/** Split a block after pass `afterPass`; returns the new block's id. */
export function splitBlock(id: Id, afterPass: number): { id: Id; text: string } | null {
  const name = blockName(id);
  const r = cmd.splitBlock(session.store, id, afterPass);
  if (!session.accepted(r) || !r.blockId) return null;
  const b = blocks().find((x) => x.id === r.blockId)!;
  const text = `Split ${name} after pass ${afterPass}: ${passesText(afterPass)} and ${passesText(b.repeats)}.`;
  notify(text, 'info', 'undo');
  return { id: r.blockId, text };
}

export function joinWithNext(id: Id): string | null {
  const name = blockName(id);
  if (!session.accepted(cmd.joinWithNext(session.store, id))) return null;
  const b = blocks().find((x) => x.id === id);
  const text = `Joined ${name} with the next block: ${passesText(b?.repeats ?? 1)}.`;
  notify(text, 'info', 'undo');
  return text;
}

/* ------------------------------------------------------------------ */
/* Scene, name, parts                                                  */
/* ------------------------------------------------------------------ */

export function changeScene(id: Id, sceneId: Id): string | null {
  if (!session.accepted(cmd.setBlockScene(session.store, id, sceneId))) return null;
  return `Block ${position(id)} now plays ${sceneName(sceneId)}.`;
}

export function renameBlock(id: Id, label: string): string | null {
  const r = cmd.renameBlock(session.store, id, label);
  if (!session.accepted(r)) return null;
  const b = blocks().find((x) => x.id === id);
  return b?.label ? `Block ${position(id)} is now called ${b.label}.` : `Block ${position(id)} shows its scene name again.`;
}

export function layerScene(id: Id, sceneId: Id): string | null {
  const into = blockName(id);
  const r = cmd.layerScene(session.store, id, sceneId);
  if (!session.accepted(r)) return null;
  const n = r.parts ?? 0;
  const text = `Layered ${sceneName(sceneId)} into ${into}: ${n === 1 ? '1 part plays' : `${n} parts play`} its clips in this block.`;
  notify(text, 'info', 'undo');
  return text;
}

/** One part in one block: a scene id (its clip), null (off), or undefined (follow the block's scene). */
export function setPart(id: Id, trackId: Id, choice: Id | null | undefined): string | null {
  if (!session.accepted(cmd.setBlockPart(session.store, id, trackId, choice))) return null;
  const part = session.store.getState().tracks.find((t) => t.id === trackId)?.name ?? 'Part';
  const what = choice === null ? 'off' : choice === undefined ? 'follows the scene' : `plays ${sceneName(choice)}`;
  return `${part} in ${blockName(id)}: ${what}.`;
}

export function resetParts(id: Id): string | null {
  if (!session.accepted(cmd.resetBlockParts(session.store, id))) return null;
  const text = `Every part of ${blockName(id)} follows its scene again.`;
  notify(text, 'info', 'undo');
  return text;
}
