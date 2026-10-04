/**
 * Edits while the song plays or is paused (the session lays the song out
 * again on every change of what it plays): from the edit point on, every
 * part plays what the edited regions say, in phase (notes sounding across a
 * change end there; a part joining mid-loop does not play what it missed);
 * the playhead never jumps (time is absolute); an edit that changes nothing
 * you hear changes nothing. Pads tapped during the song win until the song
 * changes that part. A fuzz of random region edits, undo and redo, pauses,
 * tempo changes and loops checks that no note is ever doubled or dropped
 * against the oracle of the song as edited at each edit point, and that
 * every chased note is a note the song sounds there, none is lost where a
 * pass starts or playback resumes, and none doubles a note still sounding.
 */
import { describe, expect, it } from 'vitest';
import { carve, insertTime, moveRegions, placeRegions, regionAt, regionClip, removeRegions, removeTime, resizeRegions, splitRegions, swapRegionClip, duplicateRegions } from '../../src/project/arrangement';
import type { Id, Project, SongRegion } from '../../src/project/types';
import { notesOf, ofKind } from './sequencer-fixtures';
import { BAR, MARGIN, Rig, UNEDITED, beatFixture, clipId, expectedChases, expectedNotes, fixture, mulberry32, pitchOf, plays, region, songTickOf, soundingAt, straight, withSong } from './r5-engine-rig';

let counter = 0;
const newId = () => `x${++counter}`;
const before = (tick: number) => ([t]: readonly [number, ...unknown[]]) => t < tick;
const from = (tick: number) => ([t]: readonly [number, ...unknown[]]) => t >= tick;
/** The fixture's regions of one scene stretch (slot `slot` from bar `start`), on the parts given. */
const stretch = (slot: number, start: number, parts = ['t1', 't2', 't4']) => parts.map((t) => `s${slot}@${start}:${t}`);

describe('editing the song while it plays', () => {
  it('a later stretch moved plays at its new place; the song’s end follows', () => {
    const r = new Rig().playSong().to(1000);
    expect(r.regions((rs, p) => moveRegions(p, rs, stretch(3, 8), 2, { newId }).regions)).toBe(true);
    r.finish();
    expect(r.notes('t1')).toEqual([...UNEDITED.filter(before(3072)), ...plays(3, 3840, 4224)]);
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, 2304], [3840, 90, 4224]]);
    expect(r.ends()).toEqual([4224]);
  });

  it('the region playing lengthened: it plays on in phase (nothing relaunches); what it covers gives way', () => {
    const r = new Rig().playSong().to(1000);
    r.regions((rs, p) => resizeRegions(p, rs, stretch(1, 2), 'end', 2, newId).regions);
    r.finish();
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 3072), ...plays(3, 3072, 3456)]);
    expect(r.launches('t1')).toEqual([[0, 0], [768, 1], [3072, 3]]);
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, 2304], [2304, 50, 3072], [3072, 90, 3456]]);
  });

  it('shortened to end before the playhead: silent from the edit point, its sounding chord cut there', () => {
    const r = new Rig().playSong().to(1700);
    r.regions((rs, p) => resizeRegions(p, rs, stretch(1, 2), 'end', -3, newId).regions);
    const e = r.editTicks[0];
    r.finish();
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 1700), ...UNEDITED.filter(from(2304))]);
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, e], [3072, 90, 3456]]);
    expect(r.launches('t4')).toEqual([[0, 0], [768, 1], [e, null], [3072, 3]]);
  });

  it('shortened to end ahead of the playhead: it ends at its new end', () => {
    const r = new Rig().playSong().to(1000);
    r.regions((rs, p) => resizeRegions(p, rs, stretch(1, 2), 'end', -1, newId).regions);
    r.finish();
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 1920), ...UNEDITED.filter(from(2304))]);
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, 1920], [3072, 90, 3456]]);
  });

  it('deleted while it plays: silent from the edit point; the rest of the song plays on', () => {
    const r = new Rig().playSong().to(1700);
    r.regions((rs) => removeRegions(rs, stretch(1, 2)));
    const e = r.editTicks[0];
    r.finish();
    expect(r.notes('t2')).toEqual([...plays(0, 0, 768), ...plays(1, 768, 1700), ...UNEDITED.filter(from(2304))]);
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, e], [3072, 90, 3456]]);
    expect(r.ends()).toEqual([3456]);
  });

  it('a region put under the playhead joins at the edit point, in phase; what it would have played before is not played late', () => {
    const p = fixture();
    const without = withSong(p, p.arrangement.regions.filter((x) => !['s1@2:t2', 's1@2:t4'].includes(x.id)));
    const r = new Rig(without).playSong().to(1000);
    r.regions((rs, q) => [...rs, region(q, 'back2', 't2', 1, 2, 4), region(q, 'back4', 't4', 1, 2, 4)]);
    const e = r.editTicks[0];
    r.finish();
    // In phase with the region's start (bar 2): bar 3 is the clip's second bar.
    expect(r.notes('t2').filter((n) => n[0] >= 768 && n[0] < 2304)).toEqual(plays(1, 1152, 2304, 768));
    expect(r.notes('t2').find(([t]) => t >= 768)).toEqual([1152, pitchOf(1, 1)]);
    // The chord's note at 768 is not played late: it next starts with its clip at 1536.
    expect(r.held('t4')).toEqual([[0, 30, 768], [1536, 50, 2304], [3072, 90, 3456]]);
    expect(r.launches('t4')).toEqual([[0, 0], [768, null], [e, 1], [2304, null], [3072, 3]]);
  });

  it('another clip for the region playing: the part switches at the edit point, in phase with the region', () => {
    const r = new Rig().playSong().to(1000);
    r.regions((rs, p) => swapRegionClip(rs, 's1@2:t1', clipId(p, 't1', 0)));
    const e = r.editTicks[0];
    r.finish();
    expect(r.notes('t1').filter((n) => n[0] >= 768 && n[0] < 2304)).toEqual([[768, pitchOf(1, 0)], ...plays(0, 1152, 2304, 768)]);
    expect(r.launches('t1')).toEqual([[0, 0], [768, 1], [e, 0], [2304, 2], [3072, 3]]);
  });

  it('its start trimmed past the playhead: silent until its new start, where it plays as it did (the music stays in time)', () => {
    const r = new Rig().playSong().to(1000);
    r.regions((rs, p) => resizeRegions(p, rs, ['s1@2:t1'], 'start', 2, newId).regions);
    const e = r.editTicks[0];
    r.finish();
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), [768, pitchOf(1, 0)], ...plays(1, 1536, 2304, 768), ...UNEDITED.filter(from(2304))]);
    expect(r.launches('t1')).toEqual([[0, 0], [768, 1], [e, null], [1536, 1], [2304, 2], [3072, 3]]);
  });

  it('an edit that changes nothing you hear changes nothing: a split under the playhead, an edit behind it', () => {
    const r = new Rig().playSong().to(1000);
    expect(r.regions((rs, p) => splitRegions(p, rs, stretch(1, 2), 4, newId).regions)).toBe(false);
    r.to(2500);
    expect(r.regions((rs, p) => moveRegions(p, rs, stretch(0, 0), 0, { newId, copy: false }).regions.map((x) => (x.start === 0 ? { ...x, bars: 1 } : x)))).toBe(false);
    r.finish();
    expect(r.notes('t1')).toEqual(UNEDITED);
    expect(r.held('t4')).toEqual([[0, 30, 768], [768, 50, 1536], [1536, 50, 2304], [3072, 90, 3456]]);
  });

  it('undo at once leaves the song as it was; undo later switches back at once, in phase', () => {
    const a = new Rig().playSong().to(1000);
    a.regions((rs, p) => swapRegionClip(rs, 's1@2:t1', clipId(p, 't1', 0)));
    a.edit((s) => s.undo());
    a.finish();
    expect(a.notes('t1')).toEqual(UNEDITED);
    expect(a.launches('t1')).toEqual([[0, 0], [768, 1], [2304, 2], [3072, 3]]);

    const b = new Rig().playSong().to(1000);
    b.regions((rs, p) => swapRegionClip(rs, 's1@2:t1', clipId(p, 't1', 0)));
    b.to(1300);
    b.edit((s) => s.undo());
    const e = b.editTicks[1];
    b.finish();
    expect(b.notes('t1').filter((n) => n[0] >= e)).toEqual(UNEDITED.filter(from(e)));
  });

  it('the song cut short below the playhead ends at the next bar line, once', () => {
    const r = new Rig().playSong().to(1700);
    r.regions((rs) => rs.filter((x) => x.start < 2));
    r.finish();
    expect(r.ends()).toEqual([1920]);
    expect(r.notes('t1').filter(from(1700))).toEqual([]);
  });

  it('a clip made shorter while its region plays: the region keeps its bars, the clip loops in its new length from the edit point', () => {
    const r = new Rig().playSong().to(1000);
    r.edit((s) =>
      s.apply('clip:Length', (d) => {
        d.tracks[0].clips[1]!.bars = 1;
      }),
    );
    r.finish();
    expect(r.notes('t1')).toEqual([...plays(0, 0, 768), [768, pitchOf(1, 0)], [1152, pitchOf(1, 0)], [1536, pitchOf(1, 0)], [1920, pitchOf(1, 0)], ...UNEDITED.filter(from(2304))]);
  });
});

describe('edits while paused, and right after Play', () => {
  it('an edit while paused applies at the pause point when Play resumes', () => {
    const r = new Rig().playSong().to(1000).pause();
    r.regions((rs, p) => swapRegionClip(rs, 's1@2:t1', clipId(p, 't1', 0)));
    r.wait(0.5).resume().finish();
    expect(r.notes('t1').filter((n) => n[0] >= 768 && n[0] < 2304)).toEqual([[768, pitchOf(1, 0)], ...plays(0, 1152, 2304, 768)]);
  });

  it('two edits while paused at the same point both apply (the second keeps the first’s switch)', () => {
    const r = new Rig().playSong().to(1000).pause();
    r.regions((rs, p) => swapRegionClip(rs, 's1@2:t1', clipId(p, 't1', 0)));
    r.regions((rs, p) => moveRegions(p, rs, stretch(3, 8), 1, { newId }).regions);
    r.wait(0.5).resume().finish();
    expect(r.notes('t1').filter((n) => n[0] >= 768 && n[0] < 2304)).toEqual([[768, pitchOf(1, 0)], ...plays(0, 1152, 2304, 768)]);
    expect(r.notes('t1').filter(from(2304))).toEqual([...plays(2, 2304, 3072), ...plays(3, 3456, 3840)]);
  });

  it('an edit right after Play, before anything sounded, plays from the start as edited', () => {
    const r = new Rig().playSong();
    r.regions((rs, p) => swapRegionClip(rs, 's0@0:t1', clipId(p, 't1', 2)));
    r.finish();
    expect(r.notes('t1').filter(before(768))).toEqual(plays(2, 0, 768));
    expect(r.launches('t1')[0]).toEqual([0, 2]);
  });
});

describe('pads during the song', () => {
  it('a pad tapped while the song plays wins until the song changes that part; edits to other parts leave it', () => {
    const r = new Rig().playSong().to(1000);
    r.tap('t1', 3).to(1200);
    // An edit to another part: t1 keeps its pad.
    r.regions((rs) => rs.filter((x) => x.id !== 's1@2:t2'));
    r.to(2000);
    expect(r.notes('t1').filter((n) => n[0] >= 1152 && n[0] < 2000)).toEqual(plays(3, 1152, 2000));
    // The song's next change for t1 (slot 2 at bar 6) takes it back.
    r.finish();
    expect(r.notes('t1').filter(from(2304))).toEqual(UNEDITED.filter(from(2304)));
  });

  it('an edit to the part a pad plays takes it back at the edit point', () => {
    const r = new Rig().playSong().to(1000);
    r.tap('t1', 3).to(1200);
    r.regions((rs, p) => swapRegionClip(rs, 's1@2:t1', clipId(p, 't1', 0)));
    const e = r.editTicks[0];
    r.to(2300);
    expect(r.launches('t1').filter((l) => l[0] > 1152 && l[0] < 2304)).toEqual([[e, 0]]);
    expect(r.notes('t1').filter((n) => n[0] >= e && n[0] < 2304)).toEqual(plays(0, Math.ceil(e / BAR) * BAR, 2304, 768));
  });

  it('a pad tapped for a bar where the song changes the part wins there', () => {
    const r = new Rig().playSong().to(700);
    r.tap('t1', 3).to(2300);
    expect(r.notes('t1').filter((n) => n[0] >= 768 && n[0] < 2304)).toEqual(plays(3, 768, 2304));
    r.finish();
    expect(r.notes('t1').filter(from(2304))).toEqual(UNEDITED.filter(from(2304)));
  });
});

/* ------------------------------------------------------------------ */
/* Fuzz                                                                */
/* ------------------------------------------------------------------ */

const FUZZ_PARTS = ['t1', 't2', 't4', 't5'] as const;

/**
 * Random edits while the song plays (region moves, copies, resizes at both
 * edges, splits, deletions, duplicates, new regions, other clips, inserted
 * and removed bars, undo and redo), with pauses, tempo changes and, with
 * `loops`, song loops set, changed and cleared. Returns the problems found:
 * - between two edit points, every part plays exactly the notes the song as
 *   edited at the first of them plays there (straight from its regions,
 *   through the passes), nothing doubled, nothing missing;
 * - one end, nothing after it.
 */
/**
 * Chased notes in a fuzz run: each one is a note the song (as edited there)
 * sounds at that point; none doubles a note of that pitch still sounding;
 * none is missing where a pass starts or playback resumed.
 */
function chaseProblems(r: Rig, segments: readonly { from: number; project: Project }[], passes: ReturnType<Rig['allPasses']>, end: number, id: Id, where: string): string[] {
  const problems: string[] = [];
  const projectAt = (tick: number) => [...segments].reverse().find((s) => s.from <= tick)!.project;
  const all = notesOf(r.out, id);
  for (const c of all.filter((n) => n.chased)) {
    const s = songTickOf(passes, c.tick);
    const real = s !== null && soundingAt(projectAt(c.tick), id, s).some((n) => n.pitch === c.pitch);
    if (!real) problems.push(`${where}: ${id} chased ${c.tick}:${c.pitch} is not sounding in the song there`);
    for (const n of all) if (n !== c && n.pitch === c.pitch && n.tick < c.tick && r.endOf(n) > c.tick + 1e-6) problems.push(`${where}: ${id} chased ${c.tick}:${c.pitch} doubles ${n.tick}`);
  }
  const got = new Set(r.chased(id).map(([t, p]) => `${t}:${p}`));
  // Pass starts (one where an edit took effect is left out: what played before it is the earlier song).
  for (let i = 0; i < segments.length; i++) {
    const lo = segments[i].from;
    const hi = Math.min(end, segments[i + 1]?.from ?? Infinity);
    for (const [t, p] of expectedChases(segments[i].project, passes, id, lo, hi)) {
      if (i > 0 && t === lo) continue;
      if (!got.has(`${t}:${p}`)) problems.push(`${where}: ${id} lost the chase of ${p} at pass start ${t}`);
    }
  }
  // Resume points (left out: one an edit while paused took effect at, or too near a switch or the end).
  for (const at of r.pauses) {
    if (at >= end - 48 || r.editTicks.some((e) => Math.abs(e - at) <= 1)) continue;
    const pass = passes[passes.findLastIndex((p) => p.at <= at)];
    const s = songTickOf(passes, at);
    if (!pass || s === null) continue;
    for (const n of soundingAt(projectAt(at), id, s)) {
      if (Math.min(n.end, pass.to) - s < 48) continue;
      if (!got.has(`${at}:${n.pitch}`)) problems.push(`${where}: ${id} lost the chase of ${n.pitch} at resume ${at}`);
    }
  }
  return problems;
}

function runFuzz(seed: number, opts: { loops?: boolean; steps?: number } = {}): string[] {
  const problems: string[] = [];
  const where = `seed ${seed}${opts.loops ? ' (loops)' : ''}`;
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const r = new Rig(beatFixture());
  const segments: { from: number; project: Project }[] = [{ from: 0, project: r.project }];
  const note = (n: number) => {
    if (r.editTicks.length > n) segments.push({ from: r.editTicks[r.editTicks.length - 1], project: r.project });
  };
  if (opts.loops && rnd() < 0.4) {
    const a = int(0, 7);
    r.setLoop({ fromBar: a, toBar: a + int(1, 4) });
    r.editTicks.length = 0;
  }
  r.playSong(rnd() < 0.2 ? int(1, 5) : 0);
  let paused = false;
  for (let step = 0; step < (opts.steps ?? 24) && !r.seq.ended; step++) {
    if (paused) {
      r.now += 0.3;
      if (rnd() < 0.5) {
        r.resume();
        paused = false;
      }
    } else {
      r.to(r.tick + 40 + Math.floor(rnd() * 700));
      if (r.seq.ended) break;
      // Real clocks never land exactly on a tick boundary.
      r.now += 0.0007;
      r.pump();
      if (r.seq.ended) break;
      if (rnd() < 0.12) {
        r.pause();
        paused = true;
      }
    }
    const p = r.project;
    const rs = p.arrangement.regions;
    const bar = r.bar ?? 0;
    // Often the region under the playhead, else any.
    const underPlayhead = rs.filter((x) => x.start <= bar && bar < x.start + x.bars);
    const target = (): SongRegion | null => (rs.length ? (underPlayhead.length && rnd() < 0.5 ? pick(underPlayhead) : pick(rs)) : null);
    const op = int(0, opts.loops ? 14 : 12);
    const n = r.editTicks.length;
    const set = (next: SongRegion[]) => r.setRegions(next);
    if (op === 12) {
      if (!paused) r.setTempo(pick([90, 120, 150, 175]));
      continue;
    }
    if (op >= 13) {
      const a = int(0, 9);
      r.setLoop(op === 13 ? { fromBar: a, toBar: a + int(1, 4) } : null);
      continue;
    }
    if (op === 10 || op === 11) {
      r.edit((s) => (op === 10 ? s.undo() : s.redo()));
      note(n);
      continue;
    }
    const t = target();
    if (op === 6 || !t) {
      // A new region of a part's clip, anywhere (it wins where it lands).
      const trackId = pick(FUZZ_PARTS);
      const slots = p.tracks.find((x) => x.id === trackId)!.clips.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
      if (!slots.length) continue;
      const slot = pick(slots);
      const bars = p.tracks.find((x) => x.id === trackId)!.clips[slot]!.bars;
      const placed = { id: newId(), trackId, clipId: clipId(p, trackId, slot), start: int(Math.max(0, Math.floor(bar) - 2), Math.floor(bar) + 6), bars: int(1, 5), offset: int(0, bars - 1) };
      set(placeRegions(p, rs, [placed], { newId }).regions);
    } else if (op === 0) set(moveRegions(p, rs, [t.id], int(-3, 3), { newId, copy: rnd() < 0.25 }).regions);
    else if (op === 1) set(resizeRegions(p, rs, [t.id], 'end', int(-3, 3), newId).regions);
    else if (op === 2) set(resizeRegions(p, rs, [t.id], 'start', int(-3, 3), newId).regions);
    else if (op === 3) set(splitRegions(p, rs, [t.id], int(t.start, t.start + t.bars), newId).regions);
    else if (op === 4) set(removeRegions(rs, [t.id]));
    else if (op === 5) set(duplicateRegions(p, rs, [t.id], newId).regions);
    else if (op === 7) {
      const clips = p.tracks.find((x) => x.id === t.trackId)!.clips.filter((c) => !!c);
      set(swapRegionClip(rs, t.id, pick(clips)!.id));
    } else if (op === 8 || op === 9) {
      const at = int(Math.max(0, Math.floor(bar) - 1), Math.floor(bar) + 4);
      const e = op === 8 ? insertTime(p, rs, p.arrangement.sections, at, int(1, 2), newId) : removeTime(p, rs, p.arrangement.sections, at, at + int(1, 2), newId);
      r.edit((s) =>
        s.apply('arrange:Time', (d) => {
          d.arrangement.regions = e.regions;
          d.arrangement.sections = e.sections;
        }),
      );
    }
    note(n);
  }
  if (paused) r.resume();
  if (opts.loops) {
    r.setLoop(null);
  }
  r.finish();
  const ends = r.ends();
  if (ends.length !== 1) problems.push(`${where}: ends ${JSON.stringify(ends)}`);
  const end = ends[0] ?? Infinity;
  const passes = r.allPasses();
  segments.sort((a, b) => a.from - b.from);
  for (const id of FUZZ_PARTS) {
    const got = r.notes(id);
    if (got.some(([t]) => t >= end)) problems.push(`${where}: ${id} plays after the end`);
    for (let i = 0; i < segments.length; i++) {
      const lo = segments[i].from;
      const hi = Math.min(end, segments[i + 1]?.from ?? Infinity);
      if (hi <= lo) continue;
      const want = expectedNotes(segments[i].project, passes, id, lo, hi);
      const have = got.filter(([t]) => t >= lo && t < hi);
      if (JSON.stringify(want) !== JSON.stringify(have)) {
        problems.push(`${where}: ${id} over [${lo}, ${hi}) after edit ${i}: expected ${JSON.stringify(want.slice(0, 12))}… got ${JSON.stringify(have.slice(0, 12))}…`);
        break;
      }
    }
    // No note twice.
    const seen = new Set<string>();
    for (const n of notesOf(r.out, id)) {
      const k = `${n.tick}:${n.pitch}`;
      if (seen.has(k)) problems.push(`${where}: ${id} ${k} twice`);
      seen.add(k);
    }
    problems.push(...chaseProblems(r, segments, passes, end, id, where));
  }
  // One clip at a time per part: every launch is a switch of the part as a whole (by construction), and
  // launches lie on bar lines or where an edit took effect.
  for (const l of ofKind(r.out, 'launch')) {
    if (l.tick % BAR !== 0 && !r.editTicks.includes(l.tick)) problems.push(`${where}: launch off the bar at ${l.tick}`);
  }
  return problems;
}

describe('random edits while the song plays', () => {
  it('never double or drop a note against the song as edited, from each edit point on', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 60; seed++) problems.push(...runFuzz(seed));
    expect(problems).toEqual([]);
  });

  it('nor with song loops set, changed and cleared while it plays', () => {
    const problems: string[] = [];
    for (let seed = 101; seed <= 160; seed++) problems.push(...runFuzz(seed, { loops: true }));
    expect(problems).toEqual([]);
  });
});

it('fuzz helpers agree with the pure rules (the oracle reads regions as arrangement.ts does)', () => {
  const p = fixture();
  const rs = p.arrangement.regions;
  const r0 = rs.find((x) => x.id === 's1@2:t1')!;
  expect(regionAt(rs, 't1', 3)).toEqual(r0);
  expect(regionClip(p, r0)!.slot).toBe(1);
  expect(carve(r0, 3, 4, 2, newId).map((x) => [x.start, x.bars, x.offset])).toEqual([[2, 1, 0], [4, 2, 0]]);
  expect(expectedNotes(p, straight(), 't1', 0, 3456)).toEqual(UNEDITED);
  const ids: Id[] = stretch(0, 0);
  expect(ids).toEqual(['s0@0:t1', 's0@0:t2', 's0@0:t4']);
  expect(MARGIN).toBeGreaterThan(0);
});
