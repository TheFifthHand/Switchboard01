/**
 * What the Song view shows, in words and numbers (pure: no DOM, no React).
 *
 * The rows (one per part, in track order, each with its own colour), the
 * regions' names, notches and spoken labels ("Four Floor, Drums, bars 9 to
 * 16, plays 4 times"), the badges a drag shows ("Bar 9", "8 bars · plays 4×",
 * "starts at bar 5"), the song's length ("32 bars · 1:02"), and the loop
 * browser's scenes and loops. Bars are 0-based in the data and 1-based in
 * every word a person reads.
 */
import { rowBars } from '../../../project/arrangement';
import type { Id, Project, SongRegion, SongSection, Track } from '../../../project/types';
import { INSTRUMENT_LABEL, soundName } from '../../labels';

/* ------------------------------------------------------------------ */
/* Parts                                                               */
/* ------------------------------------------------------------------ */

/**
 * Hues of the part colours, in track order. They keep clear of amber
 * (playing), teal (selection) and coral (recording, mute), which keep their
 * meaning on top of any region; a row's colour always comes with its name.
 */
export const PART_HUES = [214, 268, 136, 318, 196, 84, 240, 292] as const;

export function partHue(index: number): number {
  return PART_HUES[((index % PART_HUES.length) + PART_HUES.length) % PART_HUES.length];
}

export interface RowView {
  id: Id;
  index: number;
  /** 1-based, as the part's number reads. */
  number: number;
  name: string;
  /** The instrument's sound ("Deep House Kit"), or its kind when unknown. */
  sound: string;
  hue: number;
  mute: boolean;
  solo: boolean;
}

export function rowView(p: Project, t: Track, index: number): RowView {
  const name = t.name || `Part ${index + 1}`;
  let sound: string;
  try {
    sound = soundName(p, t.instrument);
  } catch {
    sound = INSTRUMENT_LABEL[t.instrument.kind];
  }
  return { id: t.id, index, number: index + 1, name, sound, hue: partHue(index), mute: t.mute, solo: t.solo };
}

export function rowViews(p: Project): RowView[] {
  return p.tracks.map((t, i) => rowView(p, t, i));
}

/** Two row lists that show the same (the same array is kept while nothing changed). */
export function sameRows(a: readonly RowView[], b: readonly RowView[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.name === b[i].name && x.sound === b[i].sound && x.mute === b[i].mute && x.solo === b[i].solo && x.index === b[i].index);
}

/** Whether a part is heard, in words: Muted, Solo, Not soloed (another part is soloed), or null. */
export function partStatus(row: Pick<RowView, 'mute' | 'solo'>, anySolo: boolean): 'Muted' | 'Solo' | 'Not soloed' | null {
  if (row.mute) return 'Muted';
  if (row.solo) return 'Solo';
  return anySolo ? 'Not soloed' : null;
}

/* ------------------------------------------------------------------ */
/* Numbers in words                                                    */
/* ------------------------------------------------------------------ */

export function barsText(bars: number): string {
  return bars === 1 ? '1 bar' : `${bars} bars`;
}

/** Seconds as the transport shows a song's length: "1:02", "0:09". */
export function clockText(seconds: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, '0')}`;
}

/** The song's length for the header: "32 bars · 1:02". */
export function lengthText(bars: number, bpm: number): string {
  const seconds = (bars * 4 * 60) / Math.max(1, bpm);
  return `${barsText(bars)} · ${clockText(seconds)}`;
}

const FRACTIONS: readonly [number, string, string][] = [
  [1 / 4, '¼', 'a quarter'],
  [1 / 3, '⅓', 'a third'],
  [1 / 2, '½', 'a half'],
  [2 / 3, '⅔', 'two thirds'],
  [3 / 4, '¾', 'three quarters'],
];

function splitTimes(bars: number, clipBars: number): { whole: number; frac: number } {
  const t = bars / Math.max(1, clipBars);
  const whole = Math.floor(t + 1e-9);
  return { whole, frac: t - whole };
}

function fractionOf(frac: number): readonly [number, string, string] | null {
  return FRACTIONS.find(([v]) => Math.abs(v - frac) < 1e-6) ?? null;
}

/** How many times a region plays its clip, short: "4×", "2½×", "1⅓×", "1.4×". */
export function timesShort(bars: number, clipBars: number): string {
  const { whole, frac } = splitTimes(bars, clipBars);
  if (frac < 1e-9) return `${whole}×`;
  const f = fractionOf(frac);
  if (f) return `${whole || ''}${f[1]}×`;
  return `${(whole + frac).toFixed(1)}×`;
}

/** The same in words for screen readers: "plays once", "plays 4 times", "plays 2 and a half times", "plays a quarter of its loop". */
export function timesWords(bars: number, clipBars: number): string {
  const { whole, frac } = splitTimes(bars, clipBars);
  if (frac < 1e-9) return whole === 1 ? 'plays once' : whole === 2 ? 'plays twice' : `plays ${whole} times`;
  const f = fractionOf(frac);
  if (!whole) return f ? `plays ${f[2]} of its loop` : `plays ${frac.toFixed(1)} of its loop`;
  if (f) return `plays ${whole} and ${f[2]} times`;
  return `plays ${(whole + frac).toFixed(1)} times`;
}

/* ------------------------------------------------------------------ */
/* Regions                                                             */
/* ------------------------------------------------------------------ */

/** A region's name for screen readers: "Four Floor, Drums, bars 9 to 16, plays 4 times" (plus where it starts in its loop). */
export function regionLabel(clipName: string, partName: string, r: Pick<SongRegion, 'start' | 'bars' | 'offset'>, clipBars: number): string {
  const where = r.bars === 1 ? `bar ${r.start + 1}` : `bars ${r.start + 1} to ${r.start + r.bars}`;
  const from = r.offset > 0 ? `, starts ${barsText(r.offset)} into its loop` : '';
  return `${clipName}, ${partName}, ${where}, ${timesWords(r.bars, clipBars)}${from}`;
}

/**
 * Where a region's clip starts again, in bars from the region's start (the
 * thin notches): the first after the part of the clip it begins with, then
 * every clip length.
 */
export function notches(r: Pick<SongRegion, 'bars' | 'offset'>, clipBars: number): number[] {
  const len = Math.max(1, clipBars);
  const out: number[] = [];
  for (let at = (len - (r.offset % len)) % len || len; at < r.bars; at += len) out.push(at);
  return out;
}

/* ------------------------------------------------------------------ */
/* Drag badges                                                         */
/* ------------------------------------------------------------------ */

/** While moving: "Bar 9" (where the first moved region starts), "+ Copy · Bar 9" with the copy key held. */
export function moveBadge(start: number, copy: boolean, count = 1): string {
  const many = count > 1 ? `${count} loops · ` : '';
  return copy ? `+ Copy · ${many}Bar ${start + 1}` : `${many}Bar ${start + 1}`;
}

/** While dragging a right edge: "8 bars · plays 4×" ("4 loops · 8 bars · plays 4×" when several stretch together). */
export function lengthBadge(bars: number, clipBars: number, count = 1): string {
  return `${count > 1 ? `${count} loops · ` : ''}${barsText(bars)} · plays ${timesShort(bars, clipBars)}`;
}

/** While dragging a left edge: "starts at bar 5" ("4 loops · start at bar 5"). */
export function startBadge(start: number, count = 1): string {
  return count > 1 ? `${count} loops · start at bar ${start + 1}` : `starts at bar ${start + 1}`;
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

/** "Intro, bars 1 to 8" (for the section's button). */
export function sectionLabel(s: Pick<SongSection, 'name' | 'start' | 'bars'>): string {
  return `${s.name}, ${s.bars === 1 ? `bar ${s.start + 1}` : `bars ${s.start + 1} to ${s.start + s.bars}`}`;
}

/** Bars in words for a range: "Bars 9–16", "Bar 9". */
export function rangeText(fromBar: number, toBar: number): string {
  return toBar - fromBar <= 1 ? `Bar ${fromBar + 1}` : `Bars ${fromBar + 1}–${toBar}`;
}


/* ------------------------------------------------------------------ */
/* The loop browser                                                    */
/* ------------------------------------------------------------------ */

export interface SceneCard {
  id: Id;
  row: number;
  name: string;
  bars: number;
  /** The parts with a clip in this scene: their colours (dots on the card). */
  parts: { trackId: Id; hue: number; name: string }[];
}

/** One card per scene row that has at least one clip ("Groove · 4 bars · 4 parts"). */
export function sceneCards(p: Project): SceneCard[] {
  const out: SceneCard[] = [];
  p.scenes.forEach((s, row) => {
    const parts = p.tracks.flatMap((t, i) => (t.clips[row] ? [{ trackId: t.id, hue: partHue(i), name: t.name }] : []));
    if (parts.length) out.push({ id: s.id, row, name: s.name || `Scene ${row + 1}`, bars: rowBars(p, row), parts });
  });
  return out;
}

export function sceneCardText(c: Pick<SceneCard, 'name' | 'bars' | 'parts'>): string {
  return `${c.name} · ${barsText(c.bars)} · ${c.parts.length === 1 ? '1 part' : `${c.parts.length} parts`}`;
}

export interface LoopChip {
  trackId: Id;
  clipId: Id;
  slot: number;
  name: string;
  bars: number;
}

/** A part's clips, in scene order (for its chips, the picker and "Use another loop"). */
export function partLoops(p: Pick<Project, 'tracks'>, trackId: Id): LoopChip[] {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return [];
  return t.clips.flatMap((c, slot) => (c ? [{ trackId, clipId: c.id, slot, name: c.name || `Loop ${slot + 1}`, bars: c.bars }] : []));
}

