/**
 * A few facts about a stored project for lists (the library rows and the
 * version history): scenes, the song's loops and sections, and its length.
 * Pure; never throws, even on a damaged stored project.
 */
import { BEATS_PER_BAR, type Project } from '../project/types';

export interface ProjectShape {
  /** Number of scenes. */
  scenes: number;
  /** Loops (regions) on the song timeline. */
  regions: number;
  /** Named sections of the song. */
  sections: number;
  /**
   * The number of loops under the name the library's rows have kept for it
   * (ProjectSummary.blockCount): more than 0 when the song has music.
   */
  blocks: number;
  /** Song length in bars: where its last loop ends (see songBars). */
  songBars: number;
  /** Song length in seconds at the project's tempo. */
  songSeconds: number;
}

const EMPTY: ProjectShape = { scenes: 0, regions: 0, sections: 0, blocks: 0, songBars: 0, songSeconds: 0 };

/** Items of a stored list with a usable bar range, and where the last of them ends. */
function spans(list: unknown): { count: number; end: number } {
  let count = 0;
  let end = 0;
  for (const x of Array.isArray(list) ? (list as unknown[]) : []) {
    const r = x as { start?: unknown; bars?: unknown } | null;
    if (!r || typeof r.start !== 'number' || typeof r.bars !== 'number' || !Number.isFinite(r.start + r.bars)) continue;
    count += 1;
    end = Math.max(end, r.start + r.bars);
  }
  return { count, end };
}

export function projectShape(p: Project | null | undefined): ProjectShape {
  if (!p || typeof p !== 'object') return EMPTY;
  try {
    const scenes = Array.isArray(p.scenes) ? p.scenes.length : 0;
    const regions = spans(p.arrangement?.regions);
    const sections = spans(p.arrangement?.sections);
    // The same length as songBars (project/arrangement.ts) gives a valid project: the song ends with its
    // last loop (a section label past the music does not make it play longer).
    const bars = regions.end;
    const bpm = typeof p.bpm === 'number' && p.bpm > 0 ? p.bpm : 120;
    return { scenes, regions: regions.count, sections: sections.count, blocks: regions.count, songBars: bars, songSeconds: (bars * BEATS_PER_BAR * 60) / bpm };
  } catch {
    return EMPTY;
  }
}

/** "2:19", "0:07", "1:02:05". */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "4 sections · 2:19", "1 section · 0:16", "Song · 0:31" (no sections), or "No song yet". */
export function songLine(shape: Pick<ProjectShape, 'regions' | 'sections' | 'songSeconds'>): string {
  if (shape.regions <= 0) return 'No song yet';
  const what = shape.sections > 0 ? `${shape.sections} ${shape.sections === 1 ? 'section' : 'sections'}` : 'Song';
  return `${what} · ${formatClock(shape.songSeconds)}`;
}
