/**
 * ClipSketch — a tiny picture of a clip's notes, for a pad's empty middle, so a busy hat loop and
 * a held chord look different before they are played.
 *
 * - Time runs left to right over `lengthTicks`.
 * - Melodic clips ('notes'): one row per pitch, from the lowest to the highest note the clip
 *   uses (high at the top), each note as long as it lasts.
 * - Drum clips ('drums'): one row per kit sound the clip uses (pad 0, the kick, at the bottom),
 *   each hit a short tick.
 * - Louder notes are darker. Colour is `currentColor`, so the pad decides it.
 *
 * Memoised: it draws again only when `notes` (by identity), `lengthTicks` or `kind` change. It
 * is decorative (aria-hidden); the pad's name and length say what it is.
 */
import { memo, useMemo } from 'react';
import styles from './ClipSketch.module.css';

export interface SketchNote {
  /** Start in ticks from the clip start. */
  tick: number;
  /** MIDI note (melodic) or kit sound index (drums). */
  pitch: number;
  /** Length in ticks. */
  duration: number;
  /** 0..1 (default 0.8). */
  velocity?: number;
}

export interface ClipSketchProps {
  notes: readonly SketchNote[];
  /** The clip's length in ticks (e.g. bars x 384). */
  lengthTicks: number;
  kind: 'notes' | 'drums';
  className?: string;
}

/** Drawing space: x in ticks, y in rows of ROW units. */
const ROW = 10;
const GAP = 2;
/** The fewest rows a melodic sketch spans, so one or two pitches do not fill the pad. */
const MIN_PITCH_ROWS = 5;

interface Mark {
  x: number;
  y: number;
  w: number;
  o: number;
}

function layout(notes: readonly SketchNote[], lengthTicks: number, kind: 'notes' | 'drums'): { marks: Mark[]; rows: number } {
  const len = lengthTicks > 0 ? lengthTicks : 1;
  const inClip = notes.filter((n) => Number.isFinite(n.tick) && n.tick >= 0 && n.tick < len);
  if (inClip.length === 0) return { marks: [], rows: 1 };
  // Row index from the top for each note.
  let rowOf: (pitch: number) => number;
  let rows: number;
  if (kind === 'drums') {
    const used = [...new Set(inClip.map((n) => n.pitch))].sort((a, b) => b - a); // highest sound on top, kick at the bottom
    const index = new Map(used.map((p, i) => [p, i]));
    rowOf = (p) => index.get(p) ?? 0;
    rows = used.length;
  } else {
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of inClip) {
      lo = Math.min(lo, n.pitch);
      hi = Math.max(hi, n.pitch);
    }
    const span = hi - lo + 1;
    const pad = Math.max(0, MIN_PITCH_ROWS - span);
    const top = hi + Math.ceil(pad / 2);
    rows = span + pad;
    rowOf = (p) => top - p;
  }
  // A drum hit, or a very short note, still shows: at least 1/64 of the clip.
  const minW = len / 64;
  const marks = inClip.map((n) => {
    const w = kind === 'drums' ? minW : Math.max(minW, Math.min(n.duration, len - n.tick));
    const v = n.velocity ?? 0.8;
    return { x: n.tick, y: rowOf(n.pitch) * ROW, w, o: 0.45 + 0.55 * Math.min(1, Math.max(0, v)) };
  });
  return { marks, rows };
}

function ClipSketchView({ notes, lengthTicks, kind, className }: ClipSketchProps) {
  const { marks, rows } = useMemo(() => layout(notes, lengthTicks, kind), [notes, lengthTicks, kind]);
  const len = lengthTicks > 0 ? lengthTicks : 1;
  return (
    <svg
      className={[styles.sketch, className].filter(Boolean).join(' ')}
      viewBox={`0 0 ${len} ${rows * ROW}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      data-kind={kind}
      data-notes={marks.length}
    >
      {marks.map((m, i) => (
        <rect key={i} x={m.x} y={m.y + GAP / 2} width={m.w} height={ROW - GAP} fill="currentColor" fillOpacity={m.o} />
      ))}
    </svg>
  );
}

/** A clip's notes as a small picture; redrawn only when its inputs change. */
export const ClipSketch = memo(ClipSketchView);
