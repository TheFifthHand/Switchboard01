/**
 * Shared set-up for the song (schema v4) command tests: a project with clips
 * of different lengths on several parts, and short ways to read a song.
 */
import { expect } from 'vitest';
import { createClip, createProject } from '../../src/project/factory';
import type { ClipBars, Id, Project } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import { ProjectStore } from '../../src/state/projectStore';

/**
 * Rows (scenes Intro, Groove, Lift, Break):
 * - t1 Drums: Beat (row 0, 2 bars), Fill (row 1, 1 bar)
 * - t2 Percussion: Shaker (row 0, 1 bar)
 * - t3 Bass: Bounce (row 0, 4 bars), Walk (row 1, 2 bars)
 * - t4 Chords: Stabs (row 0, 4 bars)
 * - t5 Lead: Hook (row 1, 2 bars), Riff (row 2, 3 bars)
 * - t6 Pad: Wash (row 0, 8 bars)
 * Break (row 3) is empty. `clip.<Name>` is each clip's id.
 */
export function songProject(): { p: Project; clip: Record<string, Id> } {
  const p = createProject({ now: 0 });
  const clip: Record<string, Id> = {};
  const put = (track: number, row: number, name: string, bars: ClipBars) => {
    const c = createClip(name, bars, [{ tick: 0, pitch: track === 0 ? 0 : 48, velocity: 0.8, duration: 24 }]);
    p.tracks[track].clips[row] = c;
    clip[name] = c.id;
  };
  put(0, 0, 'Beat', 2);
  put(0, 1, 'Fill', 1);
  put(1, 0, 'Shaker', 1);
  put(2, 0, 'Bounce', 4);
  put(2, 1, 'Walk', 2);
  put(3, 0, 'Stabs', 4);
  put(4, 1, 'Hook', 2);
  put(4, 2, 'Riff', 3);
  put(5, 0, 'Wash', 8);
  return { p, clip };
}

export function songStore(): { store: ProjectStore; clip: Record<string, Id> } {
  const { p, clip } = songProject();
  return { store: new ProjectStore(p), clip };
}

/** The song's loops in words: "t3:Bounce@0+8~0" (part:clip@start+bars~offset), in song order. */
export function sketch(p: Project): string[] {
  const name = (trackId: Id, clipId: Id) => p.tracks.find((t) => t.id === trackId)?.clips.find((c) => c?.id === clipId)?.name ?? '?';
  return p.arrangement.regions.map((r) => `${r.trackId}:${name(r.trackId, r.clipId)}@${r.start}+${r.bars}~${r.offset}`);
}

/** The sections in words: "Drop@8+8" (name@start+bars), with their moves' kinds after a slash. */
export function sections(p: Project): string[] {
  return p.arrangement.sections.map((s) => `${s.name}@${s.start}+${s.bars}${s.moves?.length ? `/${s.moves.map((m) => m.kind).join(',')}` : ''}`);
}

/** The project is valid as it is: validation repairs nothing and changes nothing. */
export function expectValid(p: Project, what = ''): void {
  const r = validateProject(JSON.parse(JSON.stringify(p)));
  expect(r.ok, what).toBe(true);
  if (!r.ok) return;
  expect(r.warnings, what).toEqual([]);
  expect(r.project.arrangement, what).toEqual(JSON.parse(JSON.stringify(p.arrangement)));
}

/** Runs `edit` and checks it was refused with nothing changed and no undo step. */
export function expectRefused(store: ProjectStore, edit: () => { changed: boolean; reason?: string; message?: string }, reason?: string): void {
  const before = store.getState();
  const steps = store.historySize().undo;
  const r = edit();
  expect(r.changed).toBe(false);
  if (reason) expect(r.reason).toBe(reason);
  expect(r.message, 'a refusal says why').toBeTruthy();
  expect(store.getState()).toBe(before);
  expect(store.historySize().undo).toBe(steps);
}
