/**
 * The loop open in the Song view's editor pane (GarageBand's editor area
 * under the tracks), and the pane's height.
 *
 * The pane remembers the loop by part and clip id, and the region it was
 * opened from: song slots shift when an earlier song loop goes, so the slot
 * is resolved from the clip id on every use (`resolveEditor`). When the
 * region is gone but the loop still plays elsewhere, the pane moves to
 * another region of that loop; when the loop is gone (deleted, or an Undo
 * took it away), the pane closes. The height is remembered on this device
 * (every storage access guarded, as laneSettings does).
 */
import { regionEnd } from '../../../project/arrangement';
import { clipAtSlot, slotOfClip } from '../../../project/clips';
import type { Clip, Id, Project } from '../../../project/types';
import { createStore } from '../../../state/store';

export interface EditorTarget {
  trackId: Id;
  clipId: Id;
  /** The region the pane was opened from (Make this one different splits this one off). */
  regionId: Id;
}

export const editorStore = createStore<EditorTarget | null>(null);

/** Open the editor on the loop a region plays (false when the region or its loop is not found). */
export function openLoopEditor(p: Project, regionId: Id): boolean {
  const r = p.arrangement.regions.find((x) => x.id === regionId);
  const t = r ? p.tracks.find((x) => x.id === r.trackId) : undefined;
  if (!r || !t || slotOfClip(t, r.clipId) < 0) return false;
  editorStore.setState({ trackId: t.id, clipId: r.clipId, regionId });
  return true;
}

export function closeLoopEditor(): void {
  editorStore.setState(null);
}

export interface ResolvedEditor {
  trackId: Id;
  regionId: Id;
  slot: number;
  clip: Clip;
}

/**
 * Where the open loop is in `p` now: its slot, the clip, and a region that
 * plays it (the one it was opened from while it exists, else the earliest
 * other one). Null when the loop, or every region playing it, is gone.
 */
export function resolveEditor(p: Project, e: EditorTarget | null): ResolvedEditor | null {
  if (!e) return null;
  const t = p.tracks.find((x) => x.id === e.trackId);
  if (!t) return null;
  const slot = slotOfClip(t, e.clipId);
  const clip = slot >= 0 ? clipAtSlot(t, slot) : null;
  if (!clip) return null;
  const regions = p.arrangement.regions.filter((r) => r.trackId === t.id && r.clipId === e.clipId);
  const region = regions.find((r) => r.id === e.regionId) ?? [...regions].sort((a, b) => a.start - b.start)[0];
  if (!region) return null;
  return { trackId: t.id, regionId: region.id, slot, clip };
}

/* ------------------------------------------------------------------ */
/* Height                                                              */
/* ------------------------------------------------------------------ */

export const EDITOR_HEIGHT_KEY = 'switchboard01.songEditorHeight';
export const EDITOR_MIN_H = 180;
export const EDITOR_DEFAULT_H = 300;

/** The height the person gave the pane, or null (never resized: the pane takes its share of the view). */
export function readEditorHeight(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(EDITOR_HEIGHT_KEY);
    const v = raw ? Number(raw) : NaN;
    return Number.isFinite(v) && v >= EDITOR_MIN_H ? Math.round(v) : null;
  } catch {
    return null;
  }
}

/** Until resized, the pane takes about half of what the Song view has (300 px to 460 px). */
export function defaultEditorHeight(available: number): number {
  if (!(available > 0)) return EDITOR_DEFAULT_H;
  return Math.round(Math.min(460, Math.max(EDITOR_DEFAULT_H, available * 0.52)));
}

export function writeEditorHeight(px: number): void {
  try {
    globalThis.localStorage?.setItem(EDITOR_HEIGHT_KEY, String(Math.round(px)));
  } catch {
    /* not remembered: storage is full or blocked */
  }
}

/** The pane's height within what the view has: at least EDITOR_MIN_H, leaving the song at least `keep` px. */
export function clampEditorHeight(px: number, available: number, keep = 150): number {
  const max = Math.max(EDITOR_MIN_H, available - keep);
  return Math.round(Math.min(max, Math.max(EDITOR_MIN_H, px)));
}

/* ------------------------------------------------------------------ */
/* Where else the loop plays                                           */
/* ------------------------------------------------------------------ */

function barsText(a: number, b: number): string {
  return b - a <= 1 ? `${a + 1}` : `${a + 1}–${b}`;
}

/**
 * "Also plays at bars 49–64" (the other regions of the loop, joined where
 * they touch), "Also plays in 5 other places" when there are many, or
 * "Plays only here".
 */
export function alsoPlaysText(p: Project, trackId: Id, clipId: Id, regionId: Id): string {
  const spans = p.arrangement.regions
    .filter((r) => r.trackId === trackId && r.clipId === clipId && r.id !== regionId)
    .map((r) => [r.start, regionEnd(r)] as [number, number])
    .sort((x, y) => x[0] - y[0]);
  const joined: [number, number][] = [];
  for (const s of spans) {
    const last = joined[joined.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else joined.push([s[0], s[1]]);
  }
  if (joined.length === 0) return 'Plays only here';
  if (joined.length > 3) return `Also plays in ${joined.length} other places`;
  const words = joined.map(([a, b]) => barsText(a, b));
  const single = joined.length === 1 && joined[0][1] - joined[0][0] <= 1;
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `Also plays at ${single ? 'bar' : 'bars'} ${list}`;
}
