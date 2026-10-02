/**
 * The looped part of the song as the lane shows and edits it (pure: no DOM,
 * no React).
 *
 * The loop itself is playback state (runtime `songLoop`: the blocks from
 * `fromBlockId` to `toBlockId`, inclusive, in the song's current order). The
 * lane draws it as a band over the ruler and sets it three ways: a drag
 * across the ruler (every block from the one under the press to the one
 * under the pointer: the band always snaps to block edges), a drag of one of
 * the band's ends (to the nearest block edge, never past the other end), and
 * the Loop button / block menu. The Loop button names what it acts on: the
 * blocks the user selected, else the loop that is on (pressing turns it
 * off), else the block playing now, else the first block; when the user
 * selected other blocks than the loop, pressing it moves the loop there. A
 * loop whose blocks are gone is no loop.
 */
import type { SongLayout } from './songLayout';

type Id = string;

export interface LoopRange {
  fromBlockId: Id;
  toBlockId: Id;
}

/** A loop as block indices in the current order, `from` ≤ `to`. */
export interface LoopSpan {
  from: number;
  to: number;
}

/** The looped blocks as indices in `order`, or null when there is no loop or one of its blocks is gone. */
export function loopSpan(order: readonly Id[], loop: LoopRange | null | undefined): LoopSpan | null {
  if (!loop) return null;
  const a = order.indexOf(loop.fromBlockId);
  const b = order.indexOf(loop.toBlockId);
  if (a < 0 || b < 0) return null;
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/** The runtime loop for a span of `order`. */
export function loopRange(order: readonly Id[], span: LoopSpan): LoopRange | null {
  const from = order[span.from];
  const to = order[span.to];
  return from && to ? { fromBlockId: from, toBlockId: to } : null;
}

export function sameSpan(a: LoopSpan | null, b: LoopSpan | null): boolean {
  return a === b || (!!a && !!b && a.from === b.from && a.to === b.to);
}

/** The block at lane position `x`, clamped to the song (before the first block: 0, past the last: the last); -1 on an empty lane. */
export function blockIndexAt(layout: SongLayout, x: number): number {
  const blocks = layout.blocks;
  if (!blocks.length) return -1;
  for (const b of blocks) if (x < b.x + b.width) return b.index;
  return blocks[blocks.length - 1].index;
}

/** The loop a drag across the ruler from `x0` to `x1` sets: every block from the one under `x0` to the one under `x1`. */
export function loopFromDrag(layout: SongLayout, x0: number, x1: number): LoopSpan | null {
  const a = blockIndexAt(layout, x0);
  const b = blockIndexAt(layout, x1);
  if (a < 0 || b < 0) return null;
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/**
 * Dragging one end of the loop band to lane position `x`: that end moves to
 * the nearest block edge, never past the other end (a loop is at least one
 * block).
 */
export function loopEdgeDrag(layout: SongLayout, span: LoopSpan, end: 'start' | 'end', x: number): LoopSpan {
  const blocks = layout.blocks;
  if (!blocks.length) return span;
  if (end === 'start') {
    // Start edges of blocks 0..to: the nearest one.
    let best = 0;
    for (let i = 0; i <= Math.min(span.to, blocks.length - 1); i++) if (Math.abs(blocks[i].x - x) < Math.abs(blocks[best].x - x)) best = i;
    return { from: best, to: span.to };
  }
  // End edges of blocks from..n-1: the nearest one.
  const right = (i: number) => blocks[i].x + blocks[i].width;
  let best = Math.min(Math.max(0, span.from), blocks.length - 1);
  for (let i = best; i < blocks.length; i++) if (Math.abs(right(i) - x) < Math.abs(right(best) - x)) best = i;
  return { from: span.from, to: best };
}

/** Where a span is on the lane (its left and right edges). */
export function spanX(layout: SongLayout, span: LoopSpan): { left: number; right: number } | null {
  const a = layout.blocks[span.from];
  const b = layout.blocks[span.to];
  if (!a || !b) return null;
  return { left: a.x, right: b.x + b.width };
}

/**
 * What a block menu's Loop item loops: the span of the given blocks (first to
 * last), else the block playing now, else the first block.
 */
export function loopTarget(order: readonly Id[], selected: readonly Id[], playingId: Id | null): LoopSpan | null {
  const idx = selected.map((id) => order.indexOf(id)).filter((i) => i >= 0);
  if (idx.length) return { from: Math.min(...idx), to: Math.max(...idx) };
  const p = playingId ? order.indexOf(playingId) : -1;
  if (p >= 0) return { from: p, to: p };
  return order.length ? { from: 0, to: 0 } : null;
}

/**
 * What the Loop button acts on: the blocks the user selected (by a click or
 * the keyboard: `userSelected`, empty when the selection was left by an
 * action such as a drop or a paste), else the loop that is on, else the block
 * playing now, else the first block.
 */
export function loopButtonTarget(order: readonly Id[], userSelected: readonly Id[], playingId: Id | null, current: LoopSpan | null): LoopSpan | null {
  if (userSelected.some((id) => order.includes(id))) return loopTarget(order, userSelected, null);
  if (current) return current;
  return loopTarget(order, [], playingId);
}

/** What pressing the Loop button does: turn the loop off (it is on `target` already), or set (or move) it to `target`. */
export function loopButtonPress(current: LoopSpan | null, target: LoopSpan | null): LoopSpan | null {
  if (!target) return null;
  return current && sameSpan(current, target) ? null : target;
}

/** "Groove (block 2)" or "Groove to Lift (blocks 2–4)". */
export function loopName(names: readonly string[], span: LoopSpan): string {
  const a = names[span.from] ?? 'block';
  const b = names[span.to] ?? 'block';
  if (span.from === span.to) return `${a} (block ${span.from + 1})`;
  return `${a} to ${b} (blocks ${span.from + 1}–${span.to + 1})`;
}

/** The Loop button's target, short: "Groove (block 3)" or "blocks 2–4". */
export function loopTargetName(names: readonly string[], span: LoopSpan): string {
  return span.from === span.to ? loopName(names, span) : `blocks ${span.from + 1}–${span.to + 1}`;
}

/** The Loop button's name and tooltip for `target`, with the loop that is on now. */
export function loopButtonText(names: readonly string[], current: LoopSpan | null, target: LoopSpan | null): { label: string; tip: string } {
  if (!target) return { label: 'Loop', tip: 'Add scene blocks first.' };
  const what = loopTargetName(names, target);
  const label = `Loop ${what}`;
  if (!current) return { label, tip: `Repeat ${what} while the song plays.` };
  if (sameSpan(current, target)) return { label, tip: `Loop on: ${loopName(names, current)}. Press to play the song through.` };
  return { label, tip: `Loop on: ${loopName(names, current)}. Press to move the loop to ${what}.` };
}

/**
 * What the lane says when the loop changes. "Loop on", not "looping": the
 * loop is set whether or not the song plays inside it now (the mode box says
 * "looping" only while it does).
 */
export function loopStatus(names: readonly string[], span: LoopSpan | null): string {
  return span ? `Loop on: ${loopName(names, span)}.` : 'Loop off: the song plays through.';
}
