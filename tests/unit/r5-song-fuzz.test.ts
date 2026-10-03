/**
 * Thousands of random song edits (and clip and scene edits the song must
 * follow) on a starter, with good and bad input mixed: after every step the
 * song is valid (regions on their own parts' clips, whole bars inside the
 * song, offsets inside their clips, no overlaps, in time order; sections the
 * same), a refusal changes nothing and leaves no undo step, an edit leaves
 * one step (or joins its gesture's), and validation finds nothing to repair.
 * Undo and Redo walk back and forth through the steps exactly.
 */
import { describe, expect, it } from 'vitest';
import { getStarter } from '../../src/content/starters';
import { sortRegions, sortSections } from '../../src/project/arrangement';
import { mulberry32 } from '../../src/project/rng';
import { MAX_SECTION_NAME, MAX_SONG_BARS, SONG_MOVE_KINDS, TICKS_PER_BAR, type Id, type Project } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';
import * as cmd from '../../src/state/commands';
import { makeSnapshot } from '../../src/time/snapshot';

/** What is wrong with the song (nothing: an empty list). Checked independently of the code under test. */
function songProblems(p: Project): string[] {
  const out: string[] = [];
  const ids = new Set<Id>();
  const reach = new Map<Id, number>();
  for (const r of p.arrangement.regions) {
    if (ids.has(r.id)) out.push(`two loops are ${r.id}`);
    ids.add(r.id);
    const clip = p.tracks.find((t) => t.id === r.trackId)?.clips.find((c) => c?.id === r.clipId);
    if (!clip) out.push(`${r.id} plays a clip that is not on its part`);
    if (![r.start, r.bars, r.offset].every(Number.isInteger)) out.push(`${r.id} is not in whole bars`);
    if (r.start < 0 || r.bars < 1 || r.start + r.bars > MAX_SONG_BARS) out.push(`${r.id} is outside the song`);
    if (clip && (r.offset < 0 || r.offset >= clip.bars)) out.push(`${r.id} starts outside its clip`);
    if ((reach.get(r.trackId) ?? 0) > r.start) out.push(`${r.id} overlaps a loop before it`);
    reach.set(r.trackId, r.start + r.bars);
  }
  if (sortRegions(p, p.arrangement.regions).some((r, i) => r !== p.arrangement.regions[i])) out.push('loops out of order');
  let end = 0;
  const secIds = new Set<Id>();
  for (const s of p.arrangement.sections) {
    if (secIds.has(s.id)) out.push(`two sections are ${s.id}`);
    secIds.add(s.id);
    if (![s.start, s.bars].every(Number.isInteger) || s.start < end || s.bars < 1 || s.start + s.bars > MAX_SONG_BARS) out.push(`section ${s.name} is out of place`);
    if (!s.name || s.name !== s.name.replace(/\s+/g, ' ').trim() || s.name.length > MAX_SECTION_NAME) out.push(`section name "${s.name}"`);
    const kinds = (s.moves ?? []).map((m) => m.kind);
    if (new Set(kinds).size !== kinds.length || (s.moves && !s.moves.length)) out.push(`section ${s.name} moves`);
    end = s.start + s.bars;
  }
  if (sortSections(p.arrangement.sections).some((s, i) => s !== p.arrangement.sections[i])) out.push('sections out of order');
  return out;
}

function expectValidated(p: Project, what: string): void {
  const r = validateProject(JSON.parse(JSON.stringify(p)));
  expect(r.ok, what).toBe(true);
  if (!r.ok) return;
  expect(r.warnings, what).toEqual([]);
  expect(r.project.arrangement, what).toEqual(JSON.parse(JSON.stringify(p.arrangement)));
}

/** House with a take that launched scenes and pads (for "Make song from a take"). */
function start(): ProjectStore {
  const p = getStarter('house')!.build();
  p.performances.push({
    id: 'perf_1',
    name: 'Take 1',
    createdAt: 0,
    startTick: 0,
    endTick: 12 * TICKS_PER_BAR,
    snapshot: makeSnapshot(p, [{ trackId: 't1', playing: { slot: 1, startTick: 0 } }], 0),
    events: [
      { t: 0, type: 'scene', row: 1, atTick: 2 * TICKS_PER_BAR },
      { t: 1, type: 'launch', trackId: 't3', slot: 2, atTick: 6 * TICKS_PER_BAR },
      { t: 2, type: 'stopAll', atTick: 10 * TICKS_PER_BAR },
    ],
  });
  return new ProjectStore(p);
}

describe('random song edits', () => {
  it('keep the song valid after every step, refuse cleanly, and undo/redo exactly', () => {
    let steps = 0;
    let changed = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const rnd = mulberry32(seed * 7919);
      const int = (n: number) => Math.floor(rnd() * n);
      const pick = <T,>(a: readonly T[]): T | undefined => a[int(a.length)];
      const some = <T,>(a: readonly T[]): T[] => a.filter(() => rnd() < 0.3).slice(0, 1 + int(4));
      const store = start();
      const gestures = ['g1', 'g2', undefined, undefined];
      let clipboard: cmd.RegionClipboard | null = null;
      for (let i = 0; i < 500; i++) {
        const p = store.getState();
        const regions = p.arrangement.regions.map((r) => r.id);
        const secs = p.arrangement.sections.map((s) => s.id);
        const track = pick(p.tracks)!;
        const clips = p.tracks.flatMap((t) => t.clips.filter((c) => c !== null).map((c) => ({ trackId: t.id, clipId: c!.id })));
        const anyClip = pick(clips) ?? { trackId: 't1', clipId: 'clip_none' };
        const bar = () => (rnd() < 0.05 ? pick([-1, 0.5, 600, Number.NaN])! : int(songEnd(p) + 8));
        const ops: [string, () => { changed: boolean; refused?: string }][] = [
          ['add', () => cmd.addClipToSong(store, anyClip.trackId, rnd() < 0.9 ? anyClip.clipId : 'clip_none', bar(), rnd() < 0.5 ? undefined : 1 + int(12))],
          ['addMany', () => cmd.addRegions(store, Array.from({ length: 1 + int(3) }, () => ({ ...(pick(clips) ?? anyClip), start: bar(), bars: 1 + int(10), offset: int(9) })))],
          ['scene', () => cmd.addSceneToSong(store, int(p.scenes.length + 1), bar(), { bars: rnd() < 0.5 ? undefined : 1 + int(16), section: rnd() < 0.7 })],
          ['fill', () => cmd.fillSongFromScenes(store)],
          ['move', () => cmd.moveRegions(store, some(regions), int(25) - 12, { copy: rnd() < 0.3, gesture: pick(gestures) })],
          ['resize', () => cmd.resizeRegions(store, some(regions), rnd() < 0.5 ? 'start' : 'end', int(17) - 8, pick(gestures))],
          ['split', () => {
            const r = pick(p.arrangement.regions);
            return cmd.splitRegions(store, [...some(regions), r?.id ?? 'rg_none'], r && rnd() < 0.8 ? r.start + int(r.bars + 1) : bar());
          }],
          ['remove', () => cmd.removeRegions(store, some(regions), { cut: rnd() < 0.5 })],
          ['duplicate', () => cmd.duplicateRegions(store, some(regions))],
          ['copy', () => ((clipboard = cmd.copyRegions(p, some(regions)) ?? clipboard), { changed: false })],
          ['paste', () => (clipboard ? cmd.pasteRegions(store, clipboard, bar()) : { changed: false })],
          ['swapClip', () => {
            const r = pick(p.arrangement.regions);
            const own = (r && rnd() < 0.8 ? p.tracks.find((t) => t.id === r.trackId) : undefined) ?? track;
            return cmd.setRegionClip(store, r?.id ?? 'rg_none', (pick(own.clips.filter((c) => c !== null)) ?? { id: 'clip_none' })!.id);
          }],
          ['insert', () => cmd.insertBars(store, bar(), 1 + int(8))],
          ['removeBars', () => {
            const a = bar();
            return cmd.removeBars(store, a, a + 1 + int(8));
          }],
          ['section', () => cmd.addSection(store, bar(), 1 + int(12), rnd() < 0.5 ? undefined : pick(['Drop', '  Big  Drop ', '', 'x'.repeat(60)]))],
          ['rename', () => cmd.renameSection(store, pick(secs) ?? 'sec_none', pick(['Verse', ' ', 'Chorus 2'])!)],
          ['resizeSection', () => cmd.resizeSection(store, pick(secs) ?? 'sec_none', rnd() < 0.5 ? 'start' : 'end', int(13) - 6, pick(gestures))],
          ['moveSection', () => cmd.moveSection(store, pick(secs) ?? 'sec_none', int(25) - 12, { copy: rnd() < 0.3, gesture: pick(gestures) })],
          ['dupSection', () => cmd.duplicateSection(store, pick(secs) ?? 'sec_none')],
          ['removeSection', () => cmd.removeSection(store, pick(secs) ?? 'sec_none', { withMusic: rnd() < 0.5 })],
          ['songMove', () => cmd.toggleSectionMove(store, pick(secs) ?? 'sec_none', pick(SONG_MOVE_KINDS)!, rnd() < 0.5 ? ['t4', 't5'] : undefined)],
          ['songMoves', () => cmd.setSectionMoves(store, pick(secs) ?? 'sec_none', some([...SONG_MOVE_KINDS, 'fadeIn' as const]).map((kind) => ({ kind, parts: ['t3'] })))],
          ['shape', () => cmd.shapeSection(store, pick(secs) ?? 'sec_none', pick(['build', 'strip', 'breakdown'] as const)!)],
          ['intro', () => cmd.addIntro(store)],
          ['ending', () => cmd.addEnding(store)],
          ['take', () => cmd.songFromTake(store, 'perf_1', { at: rnd() < 0.5 ? undefined : bar() })],
          ['tail', () => cmd.setTailSeconds(store, rnd() * 12, pick(gestures))],
          // Clip and scene edits the song follows.
          ['deleteClip', () => cmd.deleteClip(store, track.id, int(p.scenes.length))],
          ['clipBars', () => cmd.setClipBars(store, track.id, int(p.scenes.length), pick([1, 2, 3, 4, 8] as const)!)],
          ['moveClip', () => cmd.moveClip(store, track.id, int(p.scenes.length), pick(p.tracks)!.id, int(p.scenes.length))],
          ['copyClip', () => cmd.copyClipTo(store, track.id, int(p.scenes.length), pick(p.tracks)!.id, int(p.scenes.length))],
          ['clearPart', () => (rnd() < 0.2 ? cmd.clearTrackClips(store, track.id) : { changed: false })],
          ['deleteScene', () => (rnd() < 0.3 ? cmd.deleteScene(store, int(p.scenes.length)) : { changed: false })],
          ['addScene', () => cmd.insertScene(store, int(p.scenes.length + 1))],
          ['moveScene', () => cmd.moveScene(store, int(p.scenes.length), int(p.scenes.length))],
          ['undo', () => store.undo()],
          ['redo', () => store.redo()],
        ];
        const [name, op] = pick(ops)!;
        const before = store.getState();
        const history = store.historySize();
        const r = op();
        const what = `seed ${seed} step ${i}: ${name}`;
        steps++;
        if (!r.changed) {
          expect(store.getState(), what).toBe(before);
          expect(store.historySize(), what).toEqual(history);
        } else {
          changed++;
          if (name !== 'undo' && name !== 'redo') expect(store.historySize().undo - history.undo, what).toBeLessThanOrEqual(1);
        }
        expect(songProblems(store.getState()), what).toEqual([]);
        if (i % 25 === 0) expectValidated(store.getState(), what);
      }
      expectValidated(store.getState(), `seed ${seed} end`);
      // Undo walks back through valid states; Redo comes back to the same song.
      store.endGesture();
      const last = store.getState();
      let undone = 0;
      while (store.canUndo()) {
        store.undo();
        undone++;
        expect(songProblems(store.getState()), `seed ${seed} undo ${undone}`).toEqual([]);
      }
      for (let k = 0; k < undone; k++) store.redo();
      expect({ ...store.getState(), updatedAt: 0 }).toEqual({ ...last, updatedAt: 0 });
    }
    expect(steps).toBe(3000);
    // Most steps did something: the fuzz explores the song, not only refusals.
    expect(changed).toBeGreaterThan(1200);
  }, 120_000);
});

function songEnd(p: Project): number {
  let end = 0;
  for (const r of p.arrangement.regions) end = Math.max(end, r.start + r.bars);
  for (const s of p.arrangement.sections) end = Math.max(end, s.start + s.bars);
  return end;
}
