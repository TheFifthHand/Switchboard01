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
 * With `loops`, song loops are also set (before Play, or while it plays or
 * is paused), changed and cleared at random, and the session's loop rules
 * apply to every edit (see songLoopAfterEdit). Then also:
 * - between edits the lane playhead moves back only while a loop is set,
 *   and only into the loop;
 * - while a loop is set and the playhead is inside it, the playhead's lane
 *   position stays inside the loop range, and the playhead does not leave
 *   the loop until an edit or a loop change;
 * - the loop is cleared before the end, and the song then ends as planned.
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

export function runFuzz(seed: number, opts: { split: boolean; steps?: number; loops?: boolean }): string[] {
  const problems: string[] = [];
  const where = `seed ${seed}${opts.split ? ' (split)' : ''}${opts.loops ? ' (loops)' : ''}`;
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const r = new Rig();
  if (opts.loops && rnd() < 0.4) {
    const ids = r.project.arrangement.blocks.map((b) => b.id);
    r.setLoop(pick(ids), pick(ids)).playSong();
  } else r.play();
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
      // (Within the look-ahead of the end Pause stops instead: nothing to pause.)
      if (r.seq.ended) break;
      if (rnd() < 0.12) {
        r.pause();
        paused = true;
      }
    }
    const p = r.project;
    const ids = p.arrangement.blocks.map((b) => b.id);
    const scene = () => pick(p.scenes).id;
    const op = Math.floor(rnd() * (opts.loops ? 20 : 17));
    if (op === 16 && !paused) {
      r.setTempo(pick([90, 120, 150, 175]));
      lastEditTick = r.seq.getPosition(r.now + MARGIN).tick;
      continue;
    }
    // Edits apply from now + MARGIN: what is due before that is already scheduled.
    const pos = r.seq.getPosition(paused ? r.now : r.now + MARGIN).tick;
    const before = r.seq.songPlan()?.find((b) => pos < b.endTick);
    const playingBefore = before?.blockId;
    if (op >= 17) {
      // A loop: anywhere, around the block playing (so the playhead is often inside it), or cleared.
      const playing = r.seq.songBlockAt(pos)?.blockId;
      const i = playing ? ids.indexOf(playing) : -1;
      if (op === 17 && ids.length) r.setLoop(pick(ids), pick(ids));
      else if (op === 18 && i >= 0) r.setLoop(ids[Math.max(0, i - Math.floor(rnd() * 2))], ids[Math.min(ids.length - 1, i + Math.floor(rnd() * 3))]);
      else r.setLoop(null);
      lastEditTick = pos;
      // Setting the loop changes what follows, never the block the playhead is in (once it sounds).
      const now = r.seq.songPlan()?.find((b) => pos < b.endTick);
      if (before && now && before.startTick < pos && (now.blockId !== before.blockId || now.startTick !== before.startTick)) {
        problems.push(`${where}: setting the loop moved the playhead from ${before.blockId}@${before.startTick} to ${now.blockId}@${now.startTick}`);
      }
      continue;
    }
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
    // Continued in another block, or (in a loop) in another pass of the same one.
    if (now && now.index >= 0 && (now.blockId !== playingBefore || now.startTick !== before?.startTick) && now.startTick < pos) continued.add(now.blockId);
    const at = r.seq.songBlockAt(r.tick);
    if (at && !r.project.arrangement.blocks.some((b) => b.id === at.blockId)) problems.push(`${where}: the playing block ${at.blockId} is not in the song`);
    const loop = r.loop;
    if (loop && ![loop.fromBlockId, loop.toBlockId].every((id) => r.project.arrangement.blocks.some((b) => b.id === id))) problems.push(`${where}: the loop names a deleted block`);
  }
  if (paused) r.resume();
  // A loop never ends: clear it (an edit like any other), then the song plays to its end.
  if (r.loop) {
    lastEditTick = r.seq.getPosition(r.now + MARGIN).tick;
    r.setLoop(null);
  }
  r.finish();

  const ends = r.ends();
  if (ends.length !== 1) problems.push(`${where}: ends ${JSON.stringify(ends)}`);
  const plan = r.seq.songPlan();
  if (plan && ends.length && ends[0] !== (plan.at(-1)?.endTick ?? ends[0])) problems.push(`${where}: end ${ends[0]} vs plan end ${plan.at(-1)?.endTick}`);
  for (const l of ofKind(r.out, 'launch')) if (l.tick % BAR && !r.editTicks.includes(l.tick)) problems.push(`${where}: launch off bar ${l.tick}`);
  const bl = ofKind(r.out, 'block');
  for (let i = 1; i < bl.length; i++) if (bl[i].tick <= bl[i - 1].tick) problems.push(`${where}: block events not increasing ${bl[i - 1].tick} -> ${bl[i].tick}`);

  // The lane playhead: inside the lane, and only forward between edits (back only into a loop).
  const tr = r.laneTrace;
  const inLoop = (x: (typeof tr)[number]) => !!x.loop && x.lane >= x.loop[0] - 1e-6 && x.lane <= x.loop[1] + 1e-6;
  for (let i = 0; i < tr.length; i++) {
    const x = tr[i];
    if (x.lane < 0 || x.lane > x.total) problems.push(`${where}: lane playhead ${x.lane} outside [0, ${x.total}]`);
    if (x.inside && !inLoop(x)) problems.push(`${where}: lane playhead ${x.lane} outside the loop ${JSON.stringify(x.loop)} it plays in`);
    if (!i || x.edits !== tr[i - 1].edits) continue;
    const y = tr[i - 1];
    if (x.lane < y.lane - 1e-6 && !(x.loop && inLoop(x))) problems.push(`${where}: lane playhead went back ${y.lane} -> ${x.lane}`);
    if (y.inside && !x.inside && JSON.stringify(x.loop) === JSON.stringify(y.loop)) problems.push(`${where}: the playhead left the loop ${JSON.stringify(x.loop)} at lane ${y.lane} -> ${x.lane}`);
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
