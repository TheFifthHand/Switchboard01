/**
 * Randomised edits while the song plays (3-bar clips, scene and clip moves,
 * layer / reset / split / join / duplicate, undo and redo, tempo changes,
 * pause and resume), checked against what the final plan says. Returns the
 * problems found (empty when every invariant holds):
 * - the end is handed out exactly once, where the plan ends; no note after it;
 * - launches lie on bar lines, or where an edit took effect (an edit to what
 *   the playing block plays switches there); block events go forward;
 * - one clip at a time per part, no note twice;
 * - the lane playhead stays inside the lane and only moves forward between
 *   edits; the runtime's block (songBlockAt) is never a deleted block;
 * - from the bar line after the last edit, every part plays exactly what the
 *   plan says (a block that was continued after a split or join keeps the
 *   loop phases it had, so there any bar-aligned phase of the right clip is
 *   accepted).
 */
import type { ClipBars, Id, Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { nextBarTick } from '../../src/time/sequencer';
import { notesOf, ofKind } from './sequencer-fixtures';
import { BAR, MARGIN, Rig, mulberry32 } from './song-live-rig';

const PARTS = ['t1', 't2', 't4'] as const;

/** Note starts a part should play over [from, to) with the clip in `row` looping from `loop`. */
function expected(p: Project, trackId: Id, row: number | null, loop: number, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  if (row === null) return out;
  const clip = p.tracks.find((t) => t.id === trackId)!.clips[row];
  if (!clip) return out;
  const len = clip.bars * BAR;
  for (let base = loop; base < to; base += len) {
    for (const n of clip.notes) {
      if (n.tick >= len) continue;
      const t = base + n.tick;
      if (t >= from && t < to) out.push([t, n.pitch]);
    }
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

export function runFuzz(seed: number, opts: { split: boolean; steps?: number }): string[] {
  const problems: string[] = [];
  const where = `seed ${seed}${opts.split ? ' (split)' : ''}`;
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const r = new Rig().play();
  r.traceLane = true;
  let paused = false;
  let lastEditTick = 0;
  /** Blocks playback continued in (a split, join, …): their parts may keep the loop phase they had. */
  const continued = new Set<Id>();
  const steps = opts.steps ?? 16;
  for (let step = 0; step < steps && !r.seq.ended; step++) {
    if (paused) {
      r.now += 0.3;
      if (rnd() < 0.5) {
        r.resume();
        paused = false;
      }
    } else {
      r.to(r.tick + 40 + Math.floor(rnd() * 600));
      if (r.seq.ended) break;
      // Real clocks never land exactly on a tick boundary.
      r.now += 0.0007;
      r.pump();
      if (rnd() < 0.12) {
        r.pause();
        paused = true;
      }
    }
    const p = r.project;
    const ids = p.arrangement.blocks.map((b) => b.id);
    const scene = () => pick(p.scenes).id;
    const op = Math.floor(rnd() * 17);
    if (op === 16 && !paused) {
      r.setTempo(pick([90, 120, 150, 175]));
      lastEditTick = r.seq.getPosition(r.now + MARGIN).tick;
      continue;
    }
    // Edits apply from now + MARGIN: what is due before that is already scheduled.
    const pos = r.seq.getPosition(paused ? r.now : r.now + MARGIN).tick;
    const playingBefore = r.seq.songPlan()?.find((b) => pos < b.endTick)?.blockId;
    const changedBefore = r.project;
    r.edit((s) => {
      if (op === 0 && ids.length) cmd.moveBlocks(s, [pick(ids)], Math.floor(rnd() * (ids.length + 1)));
      else if (op === 1) cmd.insertBlocks(s, [{ sceneId: scene(), repeats: 1 + Math.floor(rnd() * 3) }], Math.floor(rnd() * (ids.length + 1)));
      else if (op === 2 && ids.length > 2) cmd.removeBlocks(s, ids.filter(() => rnd() < 0.3));
      else if (op === 3 && ids.length) cmd.setBlockRepeats(s, pick(ids), 1 + Math.floor(rnd() * 4));
      else if (op === 4 && ids.length) cmd.setBlockPart(s, pick(ids), pick(PARTS), pick([null, undefined, scene()]));
      else if (op === 5 && ids.length) cmd.setBlockScene(s, pick(ids), scene());
      else if (op === 6) s.undo();
      else if (op === 7) s.redo();
      else if (op === 8) cmd.setClipBars(s, pick(PARTS), Math.floor(rnd() * 4), pick([1, 2, 3, 4] as ClipBars[]));
      else if (op === 9 && ids.length && opts.split) {
        const b = s.getState().arrangement.blocks.find((x) => x.id === pick(ids));
        if (b && b.repeats > 1) cmd.splitBlock(s, b.id, 1 + Math.floor(rnd() * (b.repeats - 1)));
      } else if (op === 10 && ids.length) cmd.layerScene(s, pick(ids), scene());
      else if (op === 11 && ids.length) cmd.resetBlockParts(s, pick(ids));
      else if (op === 12 && ids.length) cmd.joinWithNext(s, pick(ids));
      else if (op === 13 && ids.length) cmd.duplicateBlocks(s, [pick(ids)]);
      else if (op === 14) cmd.moveScene(s, Math.floor(rnd() * 4), Math.floor(rnd() * 4));
      else if (op === 15) {
        const t = pick(PARTS);
        const from = Math.floor(rnd() * 4);
        const to = Math.floor(rnd() * 4);
        if (from !== to && s.getState().tracks.find((x) => x.id === t)!.clips[from]) cmd.moveClip(s, t, from, t, to);
      }
    });
    if (r.project === changedBefore) continue;
    lastEditTick = pos;
    const now = r.seq.songPlan()?.find((b) => pos < b.endTick);
    if (now && now.index >= 0 && now.blockId !== playingBefore && now.startTick < pos) continued.add(now.blockId);
    const at = r.seq.songBlockAt(r.tick);
    if (at && !r.project.arrangement.blocks.some((b) => b.id === at.blockId)) problems.push(`${where}: the playing block ${at.blockId} is not in the song`);
  }
  if (paused) r.resume();
  r.finish();

  const ends = r.ends();
  if (ends.length !== 1) problems.push(`${where}: ends ${JSON.stringify(ends)}`);
  const plan = r.seq.songPlan();
  if (plan && ends.length && ends[0] !== (plan.at(-1)?.endTick ?? ends[0])) problems.push(`${where}: end ${ends[0]} vs plan end ${plan.at(-1)?.endTick}`);
  for (const l of ofKind(r.out, 'launch')) if (l.tick % BAR && !r.editTicks.includes(l.tick)) problems.push(`${where}: launch off bar ${l.tick}`);
  const bl = ofKind(r.out, 'block');
  for (let i = 1; i < bl.length; i++) if (bl[i].tick <= bl[i - 1].tick) problems.push(`${where}: block events not increasing ${bl[i - 1].tick} -> ${bl[i].tick}`);

  // The lane playhead: inside the lane, and only forward between edits.
  const tr = r.laneTrace;
  for (let i = 0; i < tr.length; i++) {
    if (tr[i].lane < 0 || tr[i].lane > tr[i].total) problems.push(`${where}: lane playhead ${tr[i].lane} outside [0, ${tr[i].total}]`);
    if (i && tr[i].edits === tr[i - 1].edits && tr[i].lane < tr[i - 1].lane - 1e-6) problems.push(`${where}: lane playhead went back ${tr[i - 1].lane} -> ${tr[i].lane}`);
  }

  for (const trackId of PARTS) {
    const ns = notesOf(r.out, trackId).sort((a, b) => a.tick - b.tick);
    const seen = new Set<string>();
    for (const n of ns) {
      const k = `${n.tick}:${n.pitch}`;
      if (seen.has(k)) problems.push(`${where}: ${trackId} note ${k} twice`);
      seen.add(k);
      if (ends.length && n.tick >= ends[0]) problems.push(`${where}: ${trackId} note after end ${n.tick}`);
    }
    for (const n of ns) {
      for (const m of ns) {
        if (m === n || m.clipId === n.clipId || m.tick < n.tick) continue;
        if (r.endOf(n) > m.tick) problems.push(`${where}: ${trackId} ${n.clipId}@${n.tick} overlaps ${m.clipId}@${m.tick}`);
      }
    }
  }

  // After the last edit: from the next bar line on, the plan is what plays.
  if (plan && ends.length) {
    const F = nextBarTick(lastEditTick);
    const p = r.project;
    const deleted = plan.filter((e) => e.index < 0);
    for (const trackId of PARTS) {
      const got = r.notes(trackId).filter(([t]) => t >= F && !deleted.some((e) => t >= e.startTick && t < e.endTick));
      for (const e of plan) {
        if (e.endTick <= F || e.index < 0) continue;
        const row = Object.prototype.hasOwnProperty.call(e.parts, trackId) ? e.parts[trackId] : e.row;
        const from = Math.max(F, e.startTick);
        const mine = got.filter(([t]) => t >= from && t < e.endTick);
        const loops = [e.startTick];
        const clip = row === null ? null : p.tracks.find((t) => t.id === trackId)!.clips[row];
        if (continued.has(e.blockId) && e.startTick < F && clip) for (let k = 1; k < clip.bars; k++) loops.push(e.startTick - k * BAR);
        const ok = loops.some((loop) => JSON.stringify(mine) === JSON.stringify(expected(p, trackId, row, loop, from, e.endTick)));
        if (!ok) problems.push(`${where}: ${trackId} in ${e.blockId} [${from}, ${e.endTick}): got ${JSON.stringify(mine.slice(0, 8))} want ${JSON.stringify(expected(p, trackId, row, e.startTick, from, e.endTick).slice(0, 8))}`);
      }
    }
  }
  return problems;
}
