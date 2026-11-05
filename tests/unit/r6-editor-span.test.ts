/**
 * Round 6 editor: the pure parts behind bars side by side (how many bars
 * fit, the shared columns, numbering and words) and the Song view's editor
 * pane (which loop it shows after edits, where else the loop plays, its
 * height).
 */
import { describe, expect, it } from 'vitest';
import { alsoPlaysText, clampEditorHeight, defaultEditorHeight, EDITOR_MIN_H, resolveEditor } from '../../src/app/views/arrange/editorStore';
import { MIN_BAR_PX, STEP_GRID, barCells, barsShown, cellColumn, cellLabel, cellWords, drumPageGrid, gridSpec, pageNoteViews, spanColumns, spanSpec, velocityVoices } from '../../src/app/views/steps/model';
import { createProject } from '../../src/project/factory';
import type { Note, Project, SongRegion } from '../../src/project/types';

const note = (id: string, tick: number, pitch: number, duration = 24, velocity = 0.8): Note => ({ id, tick, pitch, duration, velocity });

describe('bars side by side', () => {
  it('shows the whole clip when its bars fit (at most 4), else one bar a page', () => {
    // About 1366 px: Steps has ~840 px of cells; the Song view's pane ~1190.
    expect(barsShown(1, 840)).toBe(1);
    expect(barsShown(2, 840)).toBe(2);
    expect(barsShown(4, 840)).toBe(1);
    expect(barsShown(2, 1190)).toBe(2);
    // About 1920 px: up to 4 bars.
    expect(barsShown(4, 1740)).toBe(4);
    expect(barsShown(3, 1740)).toBe(3);
    expect(barsShown(8, 1740)).toBe(1);
    // Never measured yet, or too narrow: one bar.
    expect(barsShown(2, 0)).toBe(1);
    expect(barsShown(2, MIN_BAR_PX * 2 - 1)).toBe(1);
  });

  it('a span runs the cells on across the bars, a wider spacer between bars', () => {
    const two = spanSpec(STEP_GRID, 2);
    expect(two.cells).toBe(32);
    expect(barCells(two)).toBe(16);
    expect(spanSpec(STEP_GRID, 1)).toBe(STEP_GRID);
    expect(spanColumns(STEP_GRID)).toBeNull();
    const cols = spanColumns(two)!.split(/ (?=repeat|\d+px)/);
    // 8 beats of cells and 7 spacers: one of them (after beat 4) the bar's.
    expect(cols.filter((c) => c.startsWith('repeat'))).toHaveLength(8);
    expect(cols.filter((c) => c.endsWith('px'))).toEqual(['5px', '5px', '5px', '14px', '5px', '5px', '5px']);
    // cellColumn holds across the bars: bar 2's first cell sits right after the bar spacer.
    expect(cellColumn(15, 4)).toBe(2 + 15 + 3);
    expect(cellColumn(16, 4)).toBe(cellColumn(15, 4) + 2);
  });

  it('numbers count from 1 in each bar, and words name the bar', () => {
    const two = spanSpec(STEP_GRID, 2);
    expect(cellLabel(16, two)).toEqual({ text: '1', beat: true });
    expect(cellLabel(20, two).text).toBe('5');
    expect(cellWords(4, STEP_GRID)).toBe('step 5');
    expect(cellWords(20, two)).toBe('bar 2, step 5');
    const fine = spanSpec(gridSpec('1/32'), 2);
    expect(cellWords(33, fine)).toBe('bar 2, 32nd 2 of 32');
  });

  it('the drum grid, the notes and the velocity voices cover every bar shown', () => {
    const notes = [note('a', 0, 0), note('b', 384 + 48, 2, 24, 0.5), note('c', 336, 40, 96)];
    const g = drumPageGrid(notes, 0, 16, 2);
    expect(g[0]).toHaveLength(32);
    expect(g[0][0]).toBe(0.8);
    expect(g[2][18]).toBe(0.5);
    // A note over the bar line is one block across both bars (no "continues" marks).
    const views = pageNoteViews(notes, 0, 768, 24, 2).find((v) => v.id === 'c')!;
    expect([views.first, views.last, views.fromPrev, views.toNext]).toEqual([14, 17, false, false]);
    const one = pageNoteViews(notes, 0, 768, 24).find((v) => v.id === 'c')!;
    expect(one.toNext).toBe(true);
    const voices = velocityVoices(notes, 0, spanSpec(STEP_GRID, 2), new Set());
    expect(voices).toHaveLength(32);
    expect(voices[18].map((v) => v.id)).toEqual(['b']);
  });
});

function songProject(): { p: Project; drums: string; dc: string } {
  const p = createProject({ name: 'Pane' });
  const t = p.tracks[0];
  t.clips[0] = { id: 'pad1', name: 'Rolling', bars: 2, notes: [] } as unknown as (typeof t.clips)[number];
  const r = (id: string, start: number, bars: number, clipId = 'pad1'): SongRegion => ({ id, trackId: t.id, clipId, start, bars, offset: 0 });
  p.arrangement.regions = [r('A', 24, 16), r('B', 48, 16)];
  return { p, drums: t.id, dc: 'pad1' };
}

describe('the editor pane', () => {
  it('says where else the loop plays', () => {
    const { p, drums } = songProject();
    expect(alsoPlaysText(p, drums, 'pad1', 'A')).toBe('Also plays at bars 49–64');
    expect(alsoPlaysText(p, drums, 'pad1', 'B')).toBe('Also plays at bars 25–40');
    p.arrangement.regions.push({ id: 'C', trackId: drums, clipId: 'pad1', start: 64, bars: 1, offset: 0 }, { id: 'D', trackId: drums, clipId: 'pad1', start: 70, bars: 1, offset: 0 });
    // Touching places join; a single bar says "bar".
    expect(alsoPlaysText(p, drums, 'pad1', 'A')).toBe('Also plays at bars 49–65 and 71');
    p.arrangement.regions = p.arrangement.regions.filter((r) => r.id === 'A' || r.id === 'D');
    expect(alsoPlaysText(p, drums, 'pad1', 'A')).toBe('Also plays at bar 71');
    p.arrangement.regions = p.arrangement.regions.filter((r) => r.id === 'A');
    expect(alsoPlaysText(p, drums, 'pad1', 'A')).toBe('Plays only here');
  });

  it('follows the loop, not the region: another region of it when that one goes, nothing when the loop goes', () => {
    const { p, drums } = songProject();
    expect(resolveEditor(p, { trackId: drums, clipId: 'pad1', regionId: 'B' })).toMatchObject({ regionId: 'B', slot: 0 });
    p.arrangement.regions = p.arrangement.regions.filter((r) => r.id !== 'B');
    expect(resolveEditor(p, { trackId: drums, clipId: 'pad1', regionId: 'B' })?.regionId).toBe('A');
    p.arrangement.regions = [];
    expect(resolveEditor(p, { trackId: drums, clipId: 'pad1', regionId: 'B' })).toBeNull();
    expect(resolveEditor(p, null)).toBeNull();
  });

  it('a song loop is found at its slot after earlier song loops went', () => {
    const { p, drums } = songProject();
    const t = p.tracks[0];
    t.songClips = [
      { id: 's1', name: 'One', bars: 1, notes: [] },
      { id: 's2', name: 'Two', bars: 1, notes: [] },
    ] as unknown as typeof t.songClips;
    p.arrangement.regions.push({ id: 'S', trackId: drums, clipId: 's2', start: 0, bars: 1, offset: 0 });
    expect(resolveEditor(p, { trackId: drums, clipId: 's2', regionId: 'S' })?.slot).toBe(101);
    t.songClips = t.songClips!.slice(1);
    expect(resolveEditor(p, { trackId: drums, clipId: 's2', regionId: 'S' })?.slot).toBe(100);
  });

  it('keeps its height within the view, taking about half until resized', () => {
    expect(clampEditorHeight(100, 600)).toBe(EDITOR_MIN_H);
    expect(clampEditorHeight(900, 600)).toBe(450);
    expect(defaultEditorHeight(0)).toBe(300);
    expect(defaultEditorHeight(540)).toBe(300);
    expect(defaultEditorHeight(800)).toBe(416);
    expect(defaultEditorHeight(2000)).toBe(460);
  });
});
