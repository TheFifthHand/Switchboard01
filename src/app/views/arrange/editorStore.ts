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
import { TICKS_PER_BAR, TICKS_PER_BEAT, type Clip, type ClipBars, type Id, type Project } from '../../../project/types';
import { createStore } from '../../../state/store';

export interface EditorTarget {
  trackId: Id;
  clipId: Id;
  /** The region the pane was opened from (Make this one different splits this one off). */
  regionId: Id;
  /** Set when the pane was opened from the keyboard (E, a menu): it then takes focus (a new number each time). */
  focus?: number;
}

export const editorStore = createStore<EditorTarget | null>(null);

let focusAsks = 0;

/**
 * Open the editor on the loop a region plays (false when the region or its
 * loop is not found). `focus`: keyboard focus moves into the pane's grid
 * (opened with E or a menu, so the keyboard can go on editing there).
 */
export function openLoopEditor(p: Project, regionId: Id, opts: { focus?: boolean } = {}): boolean {
  const r = p.arrangement.regions.find((x) => x.id === regionId);
  const t = r ? p.tracks.find((x) => x.id === r.trackId) : undefined;
  if (!r || !t || slotOfClip(t, r.clipId) < 0) return false;
  editorStore.setState({ trackId: t.id, clipId: r.clipId, regionId, ...(opts.focus ? { focus: ++focusAsks } : {}) });
  return true;
}

export function closeLoopEditor(): void {
  editorStore.setState(null);
}

/**
 * The editor's two sides: Draw (the step grid or the piano roll) and Play
 * (the instrument's pads, recorded into the loop). Kept while other loops
 * open, so a person who plays goes on playing.
 */
export type EditorMode = 'draw' | 'play';

export const editorModeStore = createStore<EditorMode>('draw');

export function setEditorMode(mode: EditorMode): void {
  if (mode === 'draw' || mode === 'play') editorModeStore.setState(mode);
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
/* Length (Shorter / Longer)                                           */
/* ------------------------------------------------------------------ */

/** The lengths Shorter and Longer step through (halves and doubles: the loop stays in step with the song). */
export const LENGTH_STEPS: readonly ClipBars[] = [1, 2, 4, 8];

/** The next length up (null: as long as a loop gets). */
export function longerBars(bars: number): ClipBars | null {
  return LENGTH_STEPS.find((b) => b > bars) ?? null;
}

/** The next length down (null: as short as a loop gets). */
export function shorterBars(bars: number): ClipBars | null {
  return [...LENGTH_STEPS].reverse().find((b) => b < bars) ?? null;
}

/** How long a loop of `bars` lasts at `bpm`, in plain words: "2 seconds", "4.5 seconds". */
export function loopSecondsText(bars: number, bpm: number): string {
  const beats = (bars * TICKS_PER_BAR) / TICKS_PER_BEAT;
  const s = bpm > 0 ? (beats * 60) / bpm : 0;
  const shown = s >= 10 ? Math.round(s) : Math.round(s * 10) / 10;
  return `${shown} second${shown === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ */
/* Where else the loop plays                                           */
/* ------------------------------------------------------------------ */

function barsText(a: number, b: number): string {
  return b - a <= 1 ? `${a + 1}` : `${a + 1}–${b}`;
}

/** Simple's words for where a loop plays: "Plays only here", "Plays 2 places". */
export function placesText(uses: number): string {
  return uses <= 1 ? 'Plays only here' : `Plays ${uses} places`;
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
