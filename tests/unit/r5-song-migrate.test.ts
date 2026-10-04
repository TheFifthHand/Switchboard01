/**
 * Song v4 migration (schema 3 → 4): a song of blocks (a scene played N times,
 * with per-part changes and song moves) opens as loops on each part's row and
 * named sections that play exactly what 2.2 played: the same clip at the same
 * bar and in the same phase, bar by bar, for every part.
 *
 * The real songs come from fixtures/v3-songs-2.2.json: every starter as the
 * 2.2 release (commit 3464535) built it, plus House edited with 2.2's own
 * commands (scenes layered in, parts switched off, a build-up, a breakdown, a
 * strip-down ending, renamed blocks, song moves), saved as version 3. It was
 * written by running that commit's buildStarter and arrangement commands;
 * clip notes are left out (the song does not depend on them). What 2.2
 * played is worked out here from 2.2's own rules (blockPart, blockBars and
 * the song layout, copied below), independently of the migration code.
 */
import { describe, expect, it } from 'vitest';
import { clipBarAt, mergeTouching, regionAt, songBars } from '../../src/project/arrangement';
import { createClip, createProject } from '../../src/project/factory';
import { migrateProject } from '../../src/project/migrate';
import { PROJECT_VERSION, type ClipBars, type Project } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import SONGS_2_2 from './fixtures/v3-songs-2.2.json';

/* ------------------------------------------------------------------ */
/* 2.2's rules (copied from 3464535 project/arrangement.ts and sequencer.ts) */
/* ------------------------------------------------------------------ */

interface OldBlock {
  id: string;
  sceneId: string;
  repeats: number;
  label?: string;
  parts?: Record<string, string | null>;
  moves?: { id: string; kind: string; parts?: string[] }[];
}
type OldProject = Omit<Project, 'arrangement' | 'version'> & { version: number; arrangement: { blocks: OldBlock[]; tailSeconds: number } };

const oldRow = (p: OldProject, sceneId: string) => p.scenes.findIndex((s) => s.id === sceneId);
const oldRepeats = (r: unknown) => (typeof r === 'number' && Number.isFinite(r) ? Math.min(16, Math.max(1, Math.round(r))) : 1);

/** blockPart: the clip a part plays in a block (null: silent). */
function oldPart(p: OldProject, b: OldBlock, t: Project['tracks'][number]) {
  const parts = b.parts;
  const has = parts !== undefined && Object.prototype.hasOwnProperty.call(parts, t.id);
  const choice = has ? parts![t.id] : undefined;
  if (choice === null) return null;
  if (choice !== undefined && choice !== b.sceneId) {
    const row = oldRow(p, choice);
    if (row >= 0) return t.clips[row] ?? null;
  }
  const row = oldRow(p, b.sceneId);
  return row < 0 ? null : (t.clips[row] ?? null);
}

/** blockBars: one pass is the longest clip the block plays (at least 1 bar). */
function oldPass(p: OldProject, b: OldBlock): number {
  let bars = 1;
  for (const t of p.tracks) {
    const c = oldPart(p, b, t);
    if (c && c.bars > bars) bars = c.bars;
  }
  return bars;
}

/**
 * What 2.2 played: blocks laid out in order (a missing scene's block skipped),
 * every block launching its parts' clips at its first bar. `at(track, bar)`
 * says which clip a part plays at a bar and how far into it ("clip@phase"),
 * or null.
 */
function oldSong(p: OldProject) {
  const blocks: { b: OldBlock; start: number; bars: number }[] = [];
  let at = 0;
  for (const b of p.arrangement.blocks) {
    if (oldRow(p, b.sceneId) < 0) continue;
    const bars = oldPass(p, b) * oldRepeats(b.repeats);
    blocks.push({ b, start: at, bars });
    at += bars;
  }
  return {
    bars: at,
    blocks,
    at(trackId: string, bar: number): string | null {
      const x = blocks.find((k) => k.start <= bar && bar < k.start + k.bars);
      const c = x ? oldPart(p, x.b, p.tracks.find((t) => t.id === trackId)!) : null;
      return x && c ? `${c.id}@${(bar - x.start) % c.bars}` : null;
    },
  };
}

/** What the upgraded song plays at a bar, in the same words. */
function newAt(p: Project, trackId: string, bar: number): string | null {
  const r = regionAt(p.arrangement.regions, trackId, bar);
  if (!r) return null;
  const clip = p.tracks.find((t) => t.id === trackId)!.clips.find((c) => c?.id === r.clipId)!;
  return `${r.clipId}@${clipBarAt(r, clip.bars, bar)}`;
}

/** Upgrade (and validate) version-3 data; throws on refusal. */
function upgrade(v3: unknown) {
  const r = validateProject(JSON.parse(JSON.stringify(v3)));
  if (!r.ok) throw new Error(r.errors.join(' '));
  return r;
}

/** Proves, bar by bar and part by part, that the upgraded song plays what 2.2 played. */
function expectSameMusic(old: OldProject, now: Project): void {
  const song = oldSong(old);
  expect(songBars(now)).toBe(song.bars);
  for (const t of old.tracks) {
    const was: (string | null)[] = [];
    const is: (string | null)[] = [];
    for (let bar = 0; bar < song.bars; bar++) {
      was.push(song.at(t.id, bar));
      is.push(newAt(now, t.id, bar));
    }
    expect(is, t.name).toEqual(was);
  }
  // A section per block, named by its label or else its scene, over its bars, with its moves.
  expect(now.arrangement.sections.map((s) => [s.id, s.name, s.start, s.bars, s.moves ?? []])).toEqual(
    song.blocks.map((k) => [k.b.id, (k.b.label?.trim() || old.scenes[oldRow(old, k.b.sceneId)].name).slice(0, 40), k.start, k.bars, k.b.moves ?? []]),
  );
  // Nothing is left to join: touching loops that play on as one are one loop.
  expect(mergeTouching(now, now.arrangement.regions)).toEqual(now.arrangement.regions);
}

/* ------------------------------------------------------------------ */
/* Synthetic version-3 songs                                           */
/* ------------------------------------------------------------------ */

/** Rows: 0 Intro (t1 Kick 1 bar, t3 Sub 2), 1 Groove (t1 Beat 2, t3 Bass 4, t4 Keys 1), 2 Lift (t5 Lead 3), 3 Break (empty). */
function base() {
  const p = createProject({ now: 0 });
  const ids: Record<string, string> = {};
  const put = (track: number, row: number, name: string, bars: ClipBars) => {
    const c = createClip(name, bars);
    p.tracks[track].clips[row] = c;
    ids[name] = c.id;
  };
  put(0, 0, 'Kick', 1);
  put(2, 0, 'Sub', 2);
  put(0, 1, 'Beat', 2);
  put(2, 1, 'Bass', 4);
  put(3, 1, 'Keys', 1);
  put(4, 2, 'Lead', 3);
  const [intro, groove, lift, brk] = p.scenes.map((s) => s.id);
  return { p, ids, scene: { intro, groove, lift, brk } };
}

/** `p` as a version-3 file with this song of blocks. */
function asV3(p: Project, blocks: unknown[], tailSeconds = 3): OldProject {
  const d = JSON.parse(JSON.stringify(p));
  d.version = 3;
  d.arrangement = { blocks, tailSeconds };
  return d;
}

/** The loops by name: "t1:Kick@0+4~0". */
function sketch(p: Project): string[] {
  const name = (trackId: string, clipId: string) => p.tracks.find((t) => t.id === trackId)!.clips.find((c) => c?.id === clipId)!.name;
  return p.arrangement.regions.map((r) => `${r.trackId}:${name(r.trackId, r.clipId)}@${r.start}+${r.bars}~${r.offset}`);
}

describe('a version-3 song of blocks becomes loops and sections', () => {
  it('a block is a section over its bars and a loop for every part that plays, from its clip’s start', () => {
    const { p, scene } = base();
    const v3 = asV3(p, [
      { id: 'b1', sceneId: scene.intro, repeats: 2 },
      { id: 'b2', sceneId: scene.groove, repeats: 1, label: 'Verse' },
      { id: 'b3', sceneId: scene.brk, repeats: 2 },
    ], 4.5);
    const r = upgrade(v3);
    expect(r.warnings).toEqual([]);
    expect(r.project.version).toBe(PROJECT_VERSION);
    expect(sketch(r.project)).toEqual(['t1:Kick@0+4~0', 't3:Sub@0+4~0', 't1:Beat@4+4~0', 't3:Bass@4+4~0', 't4:Keys@4+4~0']);
    expect(r.project.arrangement.regions.map((x) => x.id)).toEqual(['b1:t1', 'b1:t3', 'b2:t1', 'b2:t3', 'b2:t4']);
    // An empty scene still takes its bars (a scene is at least one bar long), as silence.
    expect(r.project.arrangement.sections).toEqual([
      { id: 'b1', name: 'Intro', start: 0, bars: 4 },
      { id: 'b2', name: 'Verse', start: 4, bars: 4 },
      { id: 'b3', name: 'Break', start: 8, bars: 2 },
    ]);
    expect(r.project.arrangement.tailSeconds).toBe(4.5);
    expectSameMusic(v3, r.project);
    // Everything but the song is the file as it was.
    expect({ ...r.project, arrangement: null, version: 3 }).toEqual({ ...JSON.parse(JSON.stringify(v3)), arrangement: null });
  });

  it('a clip layered in plays and counts for the length; a part switched off is silent and does not count', () => {
    const { p, scene } = base();
    // Groove with the Lead layered in from Lift (3 bars) and the 4-bar Bass off: the block is 3 bars.
    const v3 = asV3(p, [
      { id: 'b1', sceneId: scene.groove, repeats: 2, parts: { t5: scene.lift, t3: null } },
      // A layer whose scene was deleted plays the block's own scene; one with no clip for the part is silent.
      { id: 'b2', sceneId: scene.groove, repeats: 1, parts: { t3: 'scene_gone', t1: scene.lift } },
    ]);
    const r = upgrade(v3);
    // The 1-bar Keys play on in phase across both blocks: one loop.
    expect(sketch(r.project)).toEqual(['t1:Beat@0+6~0', 't4:Keys@0+10~0', 't5:Lead@0+6~0', 't3:Bass@6+4~0']);
    expect(r.project.arrangement.sections.map((s) => [s.start, s.bars])).toEqual([[0, 6], [6, 4]]);
    expectSameMusic(v3, r.project);
  });

  it('skips a block whose scene is gone, without a gap', () => {
    const { p, scene } = base();
    const v3 = asV3(p, [
      { id: 'b1', sceneId: scene.intro, repeats: 1 },
      { id: 'b2', sceneId: 'scene_gone', repeats: 4 },
      { id: 'b3', sceneId: scene.groove, repeats: 1 },
    ]);
    const r = upgrade(v3);
    expect(r.project.arrangement.sections.map((s) => `${s.name}@${s.start}+${s.bars}`)).toEqual(['Intro@0+2', 'Groove@2+4']);
    expectSameMusic(v3, r.project);
  });

  it('joins neighbours that play on in phase; a clip that started again out of phase stays two loops', () => {
    const { p, scene } = base();
    // Groove is 4 bars: Beat (2) and Keys (1) go on in phase, the 4-bar Bass too, and the Beat
    // layered into the first Lift (3 bars) still does. The second Lift starts the Beat again
    // one bar into its 2-bar clip: a new loop. The 3-bar Lead plays on across both Lifts.
    const v3 = asV3(p, [
      { id: 'b1', sceneId: scene.groove, repeats: 1 },
      { id: 'b2', sceneId: scene.groove, repeats: 3 },
      { id: 'b3', sceneId: scene.lift, repeats: 1, parts: { t1: scene.groove } },
      { id: 'b4', sceneId: scene.lift, repeats: 1, parts: { t1: scene.groove } },
    ]);
    const r = upgrade(v3);
    expect(sketch(r.project)).toEqual(['t1:Beat@0+19~0', 't3:Bass@0+16~0', 't4:Keys@0+16~0', 't5:Lead@16+6~0', 't1:Beat@19+3~0']);
    expect(r.project.arrangement.regions.find((x) => x.start === 0 && x.trackId === 't1')!.id).toBe('b1:t1');
    expectSameMusic(v3, r.project);
  });

  it('reads repeats as 2.2 did: rounded, 1 to 16', () => {
    const { p, scene } = base();
    const v3 = asV3(p, [
      { id: 'b1', sceneId: scene.intro, repeats: 0 },
      { id: 'b2', sceneId: scene.intro, repeats: 40 },
      { id: 'b3', sceneId: scene.groove, repeats: 2.6 },
      { id: 'b4', sceneId: scene.groove, repeats: 'twice' },
    ]);
    const r = upgrade(v3);
    expect(r.project.arrangement.sections.map((s) => s.bars)).toEqual([2, 32, 12, 4]);
    expectSameMusic(v3, r.project);
  });

  it('carries names and song moves to the sections; damaged moves are repaired by validation, which says so', () => {
    const { p, scene } = base();
    const v3 = asV3(p, [
      { id: 'b1', sceneId: scene.intro, repeats: 1, label: '  Big   Drop ', moves: [{ id: 'mv_a', kind: 'fadeIn' }] },
      { id: 'b2', sceneId: scene.groove, repeats: 1, label: 'x'.repeat(50), moves: [{ id: 'mv_b', kind: 'filterRise', parts: ['t4'] }, { id: 'mv_c', kind: 'echoThrow' }] },
      { id: 'b3', sceneId: scene.lift, repeats: 1, label: '   ', moves: [] },
      { id: 'b4', sceneId: scene.lift, repeats: 1, moves: 'loud' },
    ]);
    const r = upgrade(v3);
    expect(r.project.arrangement.sections).toEqual([
      { id: 'b1', name: 'Big Drop', start: 0, bars: 2, moves: [{ id: 'mv_a', kind: 'fadeIn' }] },
      { id: 'b2', name: 'x'.repeat(40), start: 2, bars: 4, moves: [{ id: 'mv_b', kind: 'filterRise', parts: ['t4'] }, { id: 'mv_c', kind: 'echoThrow' }] },
      { id: 'b3', name: 'Lift', start: 6, bars: 3 },
      { id: 'b4', name: 'Lift', start: 9, bars: 3 },
    ]);
    expect(r.warnings).toEqual(['Removed damaged song moves from a section.']);
  });

  it('is deterministic, and what it makes opens again unchanged with nothing to repair', () => {
    const { p, scene } = base();
    const v3 = asV3(p, [
      { id: 'b1', sceneId: scene.groove, repeats: 2, parts: { t5: scene.lift } },
      { id: 'b2', sceneId: scene.intro, repeats: 3, moves: [{ id: 'mv_a', kind: 'fadeOut' }] },
    ]);
    const a = migrateProject(JSON.parse(JSON.stringify(v3)));
    const b = migrateProject(JSON.parse(JSON.stringify(v3)));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.data).toEqual(b.data);
    const r = upgrade(v3);
    const again = upgrade(r.project);
    expect(again.warnings).toEqual([]);
    expect(again.project).toEqual(r.project);
  });

  it('cuts a song longer than 512 bars at bar 512, and says so', () => {
    const { p, scene } = base();
    p.tracks[5].clips[3] = createClip('Wash', 8);
    // 40 blocks of 8 bars × 16 = 5120 bars in 2.2.
    const v3 = asV3(p, Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, sceneId: scene.brk, repeats: 16 })));
    const r = upgrade(v3);
    expect(songBars(r.project)).toBe(512);
    expect(r.project.arrangement.regions.map((x) => `${x.start}+${x.bars}`)).toEqual(['0+512']);
    expect(r.project.arrangement.sections.map((s) => `${s.start}+${s.bars}`)).toEqual(['0+128', '128+128', '256+128', '384+128']);
    expect(r.warnings).toEqual(['Shortened the song to 512 bars, the longest a song can be. (37 times)']);
    expect(upgrade(r.project).warnings).toEqual([]);
  });

  it('a damaged or missing song opens empty and says so', () => {
    const { p } = base();
    const damaged = asV3(p, []);
    (damaged.arrangement as unknown as Record<string, unknown>).blocks = 'all of them';
    const r = upgrade(damaged);
    expect(r.project.arrangement).toEqual({ regions: [], sections: [], tailSeconds: 3 });
    expect(r.warnings).toEqual(['Reset a damaged song.']);
    const missing = asV3(p, []);
    delete (missing as unknown as Record<string, unknown>).arrangement;
    const m = upgrade(missing);
    expect(m.project.arrangement).toEqual({ regions: [], sections: [], tailSeconds: 3 });
    expect(m.warnings).toEqual(['Reset a missing song.']);
  });

  it('versions 1 and 2 upgrade through 3 to 4 the same way', () => {
    const { p, scene } = base();
    for (const version of [1, 2]) {
      const old = asV3(p, [{ id: 'b1', sceneId: scene.groove, repeats: 2 }]) as unknown as Record<string, unknown>;
      old.version = version;
      if (version === 1) delete old.mastering;
      const r = upgrade(old);
      expect(r.project.version).toBe(PROJECT_VERSION);
      expect(sketch(r.project)).toEqual(['t1:Beat@0+8~0', 't3:Bass@0+8~0', 't4:Keys@0+8~0']);
      expect(r.project.mastering.enabled).toBe(true);
    }
  });
});

describe('the real 2.2 songs', () => {
  const songs = SONGS_2_2 as unknown as Record<string, OldProject>;

  it('the fixture holds every starter and an edited song, as version 3', () => {
    expect(Object.keys(songs)).toEqual(['house', 'synthwave', 'ambient', 'techno', 'breakbeat', 'drumAndBass', 'downtempo', 'garage', 'house-edited']);
    for (const p of Object.values(songs)) expect(p.version).toBe(3);
    // The edited song has what made 2.2 songs hard to read: layers, parts off, helper blocks, moves.
    const edited = songs['house-edited'].arrangement.blocks;
    expect(edited.some((b) => b.parts && Object.values(b.parts).some((v) => v === null))).toBe(true);
    expect(edited.some((b) => b.parts && Object.values(b.parts).some((v) => typeof v === 'string'))).toBe(true);
    expect(edited.some((b) => b.label?.includes('build'))).toBe(true);
    expect(edited.some((b) => b.moves?.length)).toBe(true);
  });

  for (const [name, old] of Object.entries(SONGS_2_2 as unknown as Record<string, OldProject>)) {
    it(`${name}: every part plays the same clip at the same bar and phase as in 2.2`, () => {
      const r = upgrade(old);
      expect(r.warnings).toEqual([]);
      expect(r.project.version).toBe(PROJECT_VERSION);
      expectSameMusic(old, r.project);
      // Only the song changed form.
      expect({ ...r.project, arrangement: null, version: 3 }).toEqual({ ...JSON.parse(JSON.stringify(old)), arrangement: null });
    });
  }
});
