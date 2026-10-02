/**
 * A few facts about a stored project for lists (the library rows and the
 * version history): scenes, song blocks and the song's length. Pure; never
 * throws, even on a damaged stored project.
 */
import { blockBars, clampRepeats, sceneRow } from '../project/arrangement';
import { BEATS_PER_BAR, type Project } from '../project/types';

export interface ProjectShape {
  /** Number of scenes. */
  scenes: number;
  /** Number of song blocks that play (their scene exists). */
  blocks: number;
  /** Song length in bars (every block's pass × repeats). */
  songBars: number;
  /** Song length in seconds at the project's tempo. */
  songSeconds: number;
}

const EMPTY: ProjectShape = { scenes: 0, blocks: 0, songBars: 0, songSeconds: 0 };

export function projectShape(p: Project | null | undefined): ProjectShape {
  if (!p || typeof p !== 'object') return EMPTY;
  try {
    const scenes = Array.isArray(p.scenes) ? p.scenes.length : 0;
    let blocks = 0;
    let bars = 0;
    for (const b of Array.isArray(p.arrangement?.blocks) ? p.arrangement.blocks : []) {
      if (sceneRow(p, b.sceneId) < 0) continue;
      blocks += 1;
      bars += blockBars(p, b) * clampRepeats(b.repeats);
    }
    const bpm = typeof p.bpm === 'number' && p.bpm > 0 ? p.bpm : 120;
    return { scenes, blocks, songBars: bars, songSeconds: (bars * BEATS_PER_BAR * 60) / bpm };
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

/** "6 blocks · 2:19", "1 block · 0:16", or "No song yet". */
export function songLine(shape: Pick<ProjectShape, 'blocks' | 'songSeconds'>): string {
  if (shape.blocks <= 0) return 'No song yet';
  return `${shape.blocks} ${shape.blocks === 1 ? 'block' : 'blocks'} · ${formatClock(shape.songSeconds)}`;
}
