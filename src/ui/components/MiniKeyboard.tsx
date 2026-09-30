/**
 * MiniKeyboard — a two-octave (25 keys, C..C) on-screen keyboard.
 *
 * Pointer input is handled by the whole keyboard with pointer capture, so a
 * finger or mouse can glide across keys (the previous note is released, the
 * next one starts). Velocity comes from where a key is struck: lower on the
 * key = louder, like a real key's front edge. Each pointer id is tracked
 * separately (multi-touch); a note held by two pointers sounds once.
 *
 * No stuck notes: notes are released on pointerup, pointercancel,
 * lostpointercapture, pointerleave with no buttons, window blur, the tab
 * becoming hidden, `disabled`, and unmount.
 *
 * `scaleMask` is indexed by absolute pitch class (midi % 12, 0 = C): in-scale
 * keys get a small teal dot and out-of-scale keys are dimmed. `rootPc` marks
 * the root keys with a ring and their note name.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { velocityFromPosition } from './Pad';
import styles from './MiniKeyboard.module.css';

export interface MiniKeyboardProps {
  /** MIDI note of the leftmost key (a C, e.g. 48 = C3). */
  baseNote: number;
  onNoteOn(midi: number, velocity: number): void;
  onNoteOff(midi: number): void;
  /** Notes sounding from other sources (sequencer, computer keys) to light up. */
  activeNotes?: ReadonlySet<number>;
  /** 12 booleans by pitch class (0 = C). */
  scaleMask?: readonly boolean[];
  /** MIDI note -> computer key legend. */
  keyLabels?: Readonly<Record<number, string>>;
  /** Pitch class of the scale root (0 = C). */
  rootPc?: number;
  /** Number of keys (default 25). */
  keys?: number;
  /** Height in px (default 104). */
  height?: number;
  disabled?: boolean;
  /** Accessible name (default "Keyboard, C3 to C5"). */
  label?: string;
  className?: string;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
/** Black key centre offsets from the white-key boundary, in white-key widths. */
const BLACK_OFFSET: Record<number, number> = { 1: -0.08, 3: 0.08, 6: -0.1, 8: 0, 10: 0.1 };
const BLACK_WIDTH = 0.6; // of a white key
export const BLACK_KEY_HEIGHT = 0.62; // of the keyboard height

/** "C4" for MIDI 60. */
export function noteName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

interface KeyGeom {
  midi: number;
  black: boolean;
  /** Left edge and width as fractions of the keyboard width. */
  x: number;
  w: number;
}

function layoutKeys(baseNote: number, count: number): { keys: KeyGeom[]; whites: number } {
  // Never start on a black key.
  const start = BLACK_PCS.has(((baseNote % 12) + 12) % 12) ? baseNote - 1 : baseNote;
  const midis = Array.from({ length: count }, (_, i) => start + i);
  const whites = midis.filter((m) => !BLACK_PCS.has(m % 12)).length;
  // A black key at the top end (e.g. a 16-key drum layout ending on D#) gets room to show in full.
  const lastPc = midis[midis.length - 1] % 12;
  const tail = BLACK_PCS.has(lastPc) ? Math.max(0, BLACK_OFFSET[lastPc] + BLACK_WIDTH / 2) : 0;
  const ww = 1 / (whites + tail);
  const keys: KeyGeom[] = [];
  let wi = 0;
  for (const m of midis) {
    const pc = m % 12;
    if (BLACK_PCS.has(pc)) {
      const centre = (wi + BLACK_OFFSET[pc]) * ww;
      keys.push({ midi: m, black: true, x: centre - (BLACK_WIDTH * ww) / 2, w: BLACK_WIDTH * ww });
    } else {
      keys.push({ midi: m, black: false, x: wi * ww, w: ww });
      wi += 1;
    }
  }
  return { keys, whites };
}

export function MiniKeyboard({
  baseNote,
  onNoteOn,
  onNoteOff,
  activeNotes,
  scaleMask,
  keyLabels,
  rootPc,
  keys: keyCount = 25,
  height = 104,
  disabled = false,
  label,
  className,
}: MiniKeyboardProps) {
  const { keys } = useMemo(() => layoutKeys(baseNote, keyCount), [baseNote, keyCount]);
  const rootRef = useRef<HTMLDivElement>(null);
  const cbs = useRef({ onNoteOn, onNoteOff });
  useEffect(() => {
    cbs.current = { onNoteOn, onNoteOff };
  });

  /** pointerId -> note under that pointer (null when off the keys). */
  const pointers = useRef(new Map<number, number | null>());
  /** note -> number of pointers holding it. */
  const counts = useRef(new Map<number, number>());
  const [pressed, setPressed] = useState<ReadonlySet<number>>(() => new Set());

  const syncPressed = () => setPressed(new Set(counts.current.keys()));

  const press = (midi: number, velocity: number) => {
    const n = counts.current.get(midi) ?? 0;
    counts.current.set(midi, n + 1);
    if (n === 0) {
      cbs.current.onNoteOn(midi, velocity);
      syncPressed();
    }
  };

  const unpress = (midi: number) => {
    const n = counts.current.get(midi) ?? 0;
    if (n <= 1) {
      if (n === 0) return;
      counts.current.delete(midi);
      cbs.current.onNoteOff(midi);
      syncPressed();
    } else counts.current.set(midi, n - 1);
  };

  const releaseAll = useCallback(() => {
    pointers.current.clear();
    if (counts.current.size === 0) return;
    const notes = [...counts.current.keys()];
    counts.current.clear();
    for (const m of notes) cbs.current.onNoteOff(m);
    setPressed(new Set());
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') releaseAll();
    };
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onVisibility);
      releaseAll();
    };
  }, [releaseAll]);

  useEffect(() => {
    if (disabled) releaseAll();
  }, [disabled, releaseAll]);

  // The key layout changed under held notes (octave shift): release them.
  useEffect(() => releaseAll, [baseNote, keyCount, releaseAll]);

  const hitTest = (clientX: number, clientY: number): { midi: number; velocity: number } | null => {
    const el = rootRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const x = (clientX - r.left) / r.width;
    const y = (clientY - r.top) / r.height;
    if (x < 0 || x >= 1 || y < 0 || y >= 1) return null;
    if (y < BLACK_KEY_HEIGHT) {
      const black = keys.find((k) => k.black && x >= k.x && x < k.x + k.w);
      if (black) return { midi: black.midi, velocity: velocityFromPosition(y / BLACK_KEY_HEIGHT, 0.35) };
    }
    const white = keys.find((k) => !k.black && x >= k.x && x < k.x + k.w);
    return white ? { midi: white.midi, velocity: velocityFromPosition(y, 0.35) } : null;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (pointers.current.has(e.pointerId)) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    const hit = hitTest(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, hit?.midi ?? null);
    if (hit) press(hit.midi, hit.velocity);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId) ?? null;
    const hit = hitTest(e.clientX, e.clientY);
    const next = hit?.midi ?? null;
    if (next === prev) return;
    pointers.current.set(e.pointerId, next);
    if (prev !== null) unpress(prev);
    if (hit) press(hit.midi, hit.velocity);
  };

  const end = (pointerId: number) => {
    if (!pointers.current.has(pointerId)) return;
    const prev = pointers.current.get(pointerId) ?? null;
    pointers.current.delete(pointerId);
    if (prev !== null) unpress(prev);
    const el = rootRef.current;
    try {
      if (el?.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
  };

  const top = keys[keys.length - 1]?.midi ?? baseNote;
  const name = label ?? `Keyboard, ${noteName(keys[0]?.midi ?? baseNote)} to ${noteName(top)}`;

  return (
    <div
      ref={rootRef}
      className={[styles.keyboard, className].filter(Boolean).join(' ')}
      style={{ height }}
      role="group"
      aria-label={name}
      aria-disabled={disabled || undefined}
      data-disabled={disabled || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => end(e.pointerId)}
      onPointerCancel={(e) => end(e.pointerId)}
      onLostPointerCapture={(e) => end(e.pointerId)}
      onPointerLeave={(e) => {
        if (e.buttons === 0) end(e.pointerId);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {keys.map((k) => {
        const pc = k.midi % 12;
        const inScale = scaleMask ? Boolean(scaleMask[pc]) : undefined;
        const isRoot = rootPc !== undefined && ((rootPc % 12) + 12) % 12 === pc;
        const lit = pressed.has(k.midi) || Boolean(activeNotes?.has(k.midi));
        const keyLabel = keyLabels?.[k.midi];
        const showName = pc === 0 || isRoot;
        const style: CSSProperties = { left: `${k.x * 100}%`, width: `${k.w * 100}%` };
        if (k.black) style.height = `${BLACK_KEY_HEIGHT * 100}%`;
        return (
          <div
            key={k.midi}
            className={k.black ? styles.black : styles.white}
            style={style}
            data-midi={k.midi}
            data-note={noteName(k.midi)}
            data-lit={lit || undefined}
            data-pressed={pressed.has(k.midi) || undefined}
            data-scale={inScale === undefined ? undefined : inScale ? 'in' : 'out'}
            data-root={isRoot || undefined}
            aria-hidden="true"
          >
            <span className={styles.glow} />
            {inScale && <span className={styles.dot} />}
            <span className={styles.legend}>
              {keyLabel && <span className={styles.keycap}>{keyLabel}</span>}
              {showName && !k.black && <span className={styles.name}>{isRoot && pc !== 0 ? NOTE_NAMES[pc] : noteName(k.midi)}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
