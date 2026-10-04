/**
 * MiniKeyboard — a two-octave (25 keys, C..C) on-screen keyboard, or a 4 x 4 kit of named sound
 * keys (`variant="kit"`).
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
 *
 * Geometry: each black key is centred on the line between its two white keys,
 * 60 % of a white key wide and BLACK_KEY_HEIGHT of the keys tall, so every
 * white key keeps a wide strip below the black keys to press.
 *
 * `notes` makes a scale keyboard: exactly those notes (the in-key notes, say),
 * one row of equal keys with no black keys, so every key is its own note.
 * Each key shows its name spelled by the key (`pitchNames`: B♭ in F major) and
 * its computer letter; a root key adds its octave over a teal underline, and a
 * thin divider before each root marks the octaves.
 *
 * Every note key is a button named by its note ("G3 (root)", "B♭3") for
 * assistive technology, but not a Tab stop (the computer keys play the notes);
 * a click with no pointer press (a screen reader's) plays it briefly.
 *
 * Legends: `keyLabels` puts a computer key's letter on its key. Note names (C
 * keys and the root) go where `noteNames` says: 'legend' (default) in the key's
 * legend, under its letter; 'above' on a slim rail across the top of the
 * keyboard, over their keys, so every key can show its letter and nothing
 * stacks on the scale dots; 'none' leaves them out.
 *
 * `fit`: the keyboard fills its container's width, its keys widening up to
 * `keyMaxWidth` (no extra keys appear). Kit variant: 16 sound keys (key n plays
 * `baseNote + n`), each with its sound's name (`kitNames`) and letter. `kitLayout`
 * 'grid' (default) lays them out as the drum pads and the computer keys are (pad 0
 * bottom-left, rows bottom to top; rows at least 32 px tall); 'row' puts them in one
 * row of four groups, one per row of computer keys (Z–V, A–F, Q–R, 1–4), for a
 * strip only one key tall; on a narrow strip (under ~44 px a key) two rows of
 * eight (Q–R 1–4 above Z–V A–F), and when even those keys are narrow, short
 * names ("CH", "Snr") with the whole name as the key's title.
 *
 * `noteNames` spell the root on the rail (and in a legend) the way the key
 * writes it: pass the key's 12 names by pitch class (keyNoteNames), e.g. 'B♭'
 * in F major; without them, sharps.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { velocityFromPosition } from './Pad';
import { useElementSize } from '../hooks/useElementSize';
import styles from './MiniKeyboard.module.css';

export interface MiniKeyboardProps {
  /** MIDI note of the leftmost key (a C, e.g. 48 = C3); kit: the note of sound 0. */
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
  /** Number of keys (default 25; the kit variant always has 16). */
  keys?: number;
  /** Height in px (default 104; the kit variant is at least 148, so its rows stay 32 px or more). */
  height?: number;
  disabled?: boolean;
  /** Accessible name (default "Keyboard, C3 to C5"). */
  label?: string;
  /** 'piano' (default) or 'kit': 16 named sound keys in 4 rows. */
  variant?: 'piano' | 'kit';
  /** Kit variant: the name of each sound, by index (16). */
  kitNames?: readonly string[];
  /** Where the note names of C keys and the root go (default 'legend'). */
  noteNames?: 'legend' | 'above' | 'none';
  /** The 12 note names by pitch class (0 = C) used for the root's name, spelled by the key (default: sharps). */
  pitchNames?: readonly string[];
  /** Kit variant: 'grid' (default, 4 x 4 like the drum pads) or 'row' (one row of four groups of four). */
  kitLayout?: 'grid' | 'row';
  /** Fill the container's width, keys widening up to `keyMaxWidth`. */
  fit?: boolean;
  /** Widest a white key gets in `fit` mode (px; default the --key-max-w token, 44). */
  keyMaxWidth?: number;
  /** A scale keyboard: exactly these notes (ascending MIDI), as equal keys; `baseNote` and `keys` are then unused. */
  notes?: readonly number[];
  className?: string;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
const BLACK_WIDTH = 0.6; // of a white key, centred on the line between its white keys
/** Of the keys' height: at the strip's 90 px (76 px of keys under the rail) white keys keep 34 px below the black ones. */
export const BLACK_KEY_HEIGHT = 0.55;
/** A press without a pointer (a screen reader's click): how long and how loud the note plays. */
const TAP_MS = 300;
const TAP_VELOCITY = 0.8;
/** Height of the note-name rail ('above'), px. */
export const NOTE_RAIL_PX = 14;
/** Kit variant: sounds, rows and the smallest height that keeps rows at least 32 px. */
export const KIT_KEYS = 16;
const KIT_COLS = 4;
const KIT_MIN_HEIGHT = 148;
/** Kit 'row': the space between groups of four keys, px (the keys' own gap is 3 px). */
export const KIT_GROUP_GAP_PX = 8;

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
  const tail = BLACK_PCS.has(midis[midis.length - 1] % 12) ? BLACK_WIDTH / 2 : 0;
  const ww = 1 / (whites + tail);
  const keys: KeyGeom[] = [];
  let wi = 0;
  for (const m of midis) {
    const pc = m % 12;
    if (BLACK_PCS.has(pc)) {
      const centre = wi * ww;
      keys.push({ midi: m, black: true, x: centre - (BLACK_WIDTH * ww) / 2, w: BLACK_WIDTH * ww });
    } else {
      keys.push({ midi: m, black: false, x: wi * ww, w: ww });
      wi += 1;
    }
  }
  return { keys, whites: whites + tail };
}

/** A scale keyboard: the notes as equal keys, left to right. */
function layoutScale(notes: readonly number[]): { keys: KeyGeom[]; whites: number } {
  const n = notes.length;
  return { keys: notes.map((midi, i) => ({ midi, black: false, x: i / n, w: 1 / n })), whites: n };
}

/** Kit key n: its column and row from the top (pad 0 bottom-left, rows bottom to top). */
function kitCell(index: number): { col: number; row: number } {
  return { col: index % KIT_COLS, row: KIT_COLS - 1 - Math.floor(index / KIT_COLS) };
}

/** Kit 'row' key n: its grid column (four keys, a spacer track, four keys…). */
function kitRowColumn(index: number): number {
  return index + 1 + Math.floor(index / KIT_COLS);
}

const GROUP = `repeat(4, minmax(0, 1fr))`;
const SPACER = `${KIT_GROUP_GAP_PX - 6}px`;
const KIT_ROW_COLUMNS = [GROUP, SPACER, GROUP, SPACER, GROUP, SPACER, GROUP].join(' ');
const KIT_TWO_ROW_COLUMNS = [GROUP, SPACER, GROUP].join(' ');
/**
 * Kit 'row' on a narrow strip: under this width per key the 16 keys go in two rows of eight
 * (Q–R 1–4 above Z–V A–F), each key twice as wide; under KIT_SHORT_PX per key even then, the
 * names are shortened ("CH" for Closed Hat; the whole name is the key's title).
 */
export const KIT_ONE_ROW_MIN_PX = 44;
const KIT_SHORT_PX = 40;

/** Kit 'row' in two rows: key n's column and row (keys 0-7 below, 8-15 above). */
function kitTwoRowCell(index: number): { col: number; row: number } {
  const i = index % 8;
  return { col: i + 1 + Math.floor(i / KIT_COLS), row: index < 8 ? 2 : 1 };
}

/**
 * A sound's name in a few letters, for keys too narrow for it: the initials of several words
 * ("Closed Hat" -> "CH", "Kick 2" -> "K2"); one longer word keeps its first letter and the
 * consonants after it ("Snare" -> "Snr", "Cowbell" -> "Cwbl"), as drum machines label pads.
 */
export function shortSoundName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.map((w) => (/^\d/.test(w) ? w : w[0].toUpperCase())).join('');
  const w = words[0] ?? '';
  if (w.length <= 4) return w;
  return (w[0] + w.slice(1).replace(/[aeiouy]/gi, '')).slice(0, 4);
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
  variant = 'piano',
  kitNames,
  noteNames = 'legend',
  pitchNames,
  kitLayout = 'grid',
  fit = false,
  keyMaxWidth,
  notes: scaleNotes,
  className,
}: MiniKeyboardProps) {
  const kit = variant === 'kit';
  const kitRow = kit && kitLayout === 'row';
  const rootRef = useRef<HTMLDivElement>(null);
  const box = useElementSize(rootRef);
  // Kit 'row' on a narrow strip: two rows of eight, and short names when even those keys are narrow.
  const perKey = box.width > 0 ? (box.width - 3 * KIT_GROUP_GAP_PX - 12 * 3) / KIT_KEYS : Infinity;
  const kitRows: 1 | 2 = kitRow && perKey < KIT_ONE_ROW_MIN_PX ? 2 : 1;
  const shortNames = kitRows === 2 && perKey * 2 < KIT_SHORT_PX;
  const nameOf = (pc: number) => pitchNames?.[pc] ?? NOTE_NAMES[pc];
  /** "B♭3", spelled by the key when `pitchNames` are given. */
  const spelled = (midi: number) => `${nameOf(((midi % 12) + 12) % 12)}${Math.floor(midi / 12) - 1}`;
  const isRootPc = (pc: number) => rootPc !== undefined && ((rootPc % 12) + 12) % 12 === pc;
  // A scale keyboard (`notes`), and the identity of its notes: the layout (and held notes) follow a change.
  const scaleBoard = !kit && scaleNotes !== undefined && scaleNotes.length > 0;
  const notesId = scaleBoard ? scaleNotes.join(',') : '';
  const count = kit ? KIT_KEYS : scaleBoard ? scaleNotes.length : keyCount;
  const { keys, whites } = useMemo(
    () => (kit ? { keys: [] as KeyGeom[], whites: KIT_COLS } : notesId ? layoutScale(notesId.split(',').map(Number)) : layoutKeys(baseNote, count)),
    [kit, notesId, baseNote, count],
  );
  const rail = !kit && !scaleBoard && noteNames === 'above';
  const bedRef = useRef<HTMLDivElement>(null);
  const cbs = useRef({ onNoteOn, onNoteOff });
  useEffect(() => {
    cbs.current = { onNoteOn, onNoteOff };
  });

  /** pointerId -> note under that pointer (null when off the keys). */
  const pointers = useRef(new Map<number, number | null>());
  /** note -> number of pointers holding it. */
  const counts = useRef(new Map<number, number>());
  const [pressed, setPressed] = useState<ReadonlySet<number>>(() => new Set());
  /** Notes started by a click with no pointer press, ending after TAP_MS. */
  const taps = useRef(new Set<number>());

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
    const tapTimers = taps.current;
    return () => {
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const t of tapTimers) clearTimeout(t);
      tapTimers.clear();
      releaseAll();
    };
  }, [releaseAll]);

  useEffect(() => {
    if (disabled) releaseAll();
  }, [disabled, releaseAll]);

  // The key layout changed under held notes (octave shift, another variant, other scale notes): release them.
  useEffect(() => releaseAll, [baseNote, count, kit, notesId, releaseAll]);

  /** A click with no pointer press (a screen reader activating the key's button): the note sounds briefly. */
  const tap = (midi: number) => {
    if (disabled) return;
    press(midi, TAP_VELOCITY);
    const t = window.setTimeout(() => {
      taps.current.delete(t);
      unpress(midi);
    }, TAP_MS);
    taps.current.add(t);
  };

  const hitTest = (clientX: number, clientY: number): { midi: number; velocity: number } | null => {
    const el = bedRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const x = (clientX - r.left) / r.width;
    const y = (clientY - r.top) / r.height;
    if (x < 0 || x >= 1 || y < 0 || y >= 1) return null;
    if (kitRow) {
      // Rows of groups: the key under the point, or the nearest one across a gap (no dead strips).
      let best: { midi: number; d: number; top: number; height: number } | null = null;
      for (const key of el.querySelectorAll<HTMLElement>('[data-midi]')) {
        const k = key.getBoundingClientRect();
        const dx = clientX < k.left ? k.left - clientX : clientX >= k.right ? clientX - k.right : 0;
        const dy = clientY < k.top ? k.top - clientY : clientY >= k.bottom ? clientY - k.bottom : 0;
        const d = dx + dy;
        if (!best || d < best.d) best = { midi: Number(key.dataset.midi), d, top: k.top, height: k.height };
      }
      if (!best) return null;
      return { midi: best.midi, velocity: velocityFromPosition((clientY - best.top) / Math.max(1, best.height), 0.35) };
    }
    if (scaleBoard) {
      // Equal keys edge to edge: the key under the point, anywhere on it.
      const k = keys[Math.min(keys.length - 1, Math.floor(x * keys.length))];
      return k ? { midi: k.midi, velocity: velocityFromPosition(y, 0.35) } : null;
    }
    if (kit) {
      const col = Math.min(KIT_COLS - 1, Math.floor(x * KIT_COLS));
      const row = Math.min(KIT_COLS - 1, Math.floor(y * KIT_COLS));
      const index = (KIT_COLS - 1 - row) * KIT_COLS + col;
      return { midi: baseNote + index, velocity: velocityFromPosition(y * KIT_COLS - row, 0.35) };
    }
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

  const top = kit ? baseNote + KIT_KEYS - 1 : (keys[keys.length - 1]?.midi ?? baseNote);
  const name = label ?? (kit ? 'Drum kit keys' : `Keyboard, ${spelled(keys[0]?.midi ?? baseNote)} to ${spelled(top)}`);
  const rootStyle: CSSProperties = { height: kit && !kitRow ? Math.max(height, KIT_MIN_HEIGHT) : height };
  if (fit) {
    // A scale keyboard's keys widen like white keys: `whites` is its key count.
    const unit = keyMaxWidth !== undefined ? `${keyMaxWidth}px` : 'var(--key-max-w, 44px)';
    if (kitRow) rootStyle.maxWidth = `calc(${KIT_KEYS} * ${keyMaxWidth !== undefined ? `${keyMaxWidth}px` : 'var(--key-max-w, 44px)'} + ${3 * KIT_GROUP_GAP_PX}px)`;
    else rootStyle.maxWidth = kit ? `calc(${KIT_COLS} * ${keyMaxWidth !== undefined ? `${keyMaxWidth}px` : 'var(--kit-key-max-w, 150px)'})` : `calc(${whites.toFixed(3)} * ${unit})`;
  }

  /** A name on the rail: C keys (with their octave) and the root (its letter name). */
  const railName = (midi: number): { text: string; root: boolean } | null => {
    const pc = ((midi % 12) + 12) % 12;
    const root = isRootPc(pc);
    if (pc === 0) return { text: noteName(midi), root };
    if (root) return { text: nameOf(pc), root };
    return null;
  };

  /** A key's accessible name: "B♭3", "G3 (root)". */
  const spoken = (midi: number) => `${spelled(midi)}${isRootPc(((midi % 12) + 12) % 12) ? ' (root)' : ''}`;
  const isLit = (midi: number) => pressed.has(midi) || Boolean(activeNotes?.has(midi));

  const pianoKey = (k: KeyGeom) => {
    const pc = k.midi % 12;
    const inScale = scaleMask ? Boolean(scaleMask[pc]) : undefined;
    const isRoot = isRootPc(pc);
    const keyLabel = keyLabels?.[k.midi];
    const showName = noteNames === 'legend' && (pc === 0 || isRoot);
    const style: CSSProperties = { left: `${k.x * 100}%`, width: `${k.w * 100}%` };
    if (k.black) style.height = `${BLACK_KEY_HEIGHT * 100}%`;
    return (
      <div
        key={k.midi}
        className={k.black ? styles.black : styles.white}
        style={style}
        role="button"
        aria-label={spoken(k.midi)}
        onClick={(e) => e.detail === 0 && tap(k.midi)}
        data-midi={k.midi}
        data-note={noteName(k.midi)}
        data-lit={isLit(k.midi) || undefined}
        data-pressed={pressed.has(k.midi) || undefined}
        data-scale={inScale === undefined ? undefined : inScale ? 'in' : 'out'}
        data-root={isRoot || undefined}
      >
        <span className={styles.glow} />
        {inScale && <span className={styles.dot} />}
        <span className={styles.legend}>
          {keyLabel && <span className={styles.keycap}>{keyLabel}</span>}
          {showName && !k.black && <span className={styles.name}>{isRoot && pc !== 0 ? nameOf(pc) : noteName(k.midi)}</span>}
        </span>
      </div>
    );
  };

  /** A scale keyboard's key: its name as the key writes it (a root with its octave, over a teal underline) and its letter. */
  const scaleKey = (k: KeyGeom, i: number) => {
    const pc = k.midi % 12;
    const isRoot = isRootPc(pc);
    const keyLabel = keyLabels?.[k.midi];
    return (
      <div
        key={k.midi}
        className={styles.step}
        style={{ left: `${k.x * 100}%`, width: `${k.w * 100}%` }}
        role="button"
        aria-label={spoken(k.midi)}
        onClick={(e) => e.detail === 0 && tap(k.midi)}
        data-midi={k.midi}
        data-note={noteName(k.midi)}
        data-lit={isLit(k.midi) || undefined}
        data-pressed={pressed.has(k.midi) || undefined}
        data-root={isRoot || undefined}
        data-octave={(isRoot && i > 0) || undefined}
      >
        <span className={styles.glow} />
        <span className={styles.stepName}>{isRoot ? spelled(k.midi) : nameOf(pc)}</span>
        <span className={styles.legend}>{keyLabel && <span className={styles.keycap}>{keyLabel}</span>}</span>
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      className={[styles.keyboard, className].filter(Boolean).join(' ')}
      style={rootStyle}
      role="group"
      aria-label={name}
      aria-disabled={disabled || undefined}
      data-disabled={disabled || undefined}
      data-variant={kit ? 'kit' : undefined}
      data-layout={kitRow ? 'row' : undefined}
      data-rows={kitRow ? kitRows : undefined}
      data-rail={rail || undefined}
      data-fit={fit || undefined}
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
      {rail && (
        <div className={styles.rail} aria-hidden="true">
          {keys.map((k) => {
            const n = railName(k.midi);
            if (!n) return null;
            return (
              <span key={k.midi} className={styles.railName} data-root={n.root || undefined} data-black={k.black || undefined} style={{ left: `${(k.x + k.w / 2) * 100}%` }}>
                {n.text}
              </span>
            );
          })}
        </div>
      )}
      <div ref={bedRef} className={styles.bed} style={kitRow ? { gridTemplateColumns: kitRows === 2 ? KIT_TWO_ROW_COLUMNS : KIT_ROW_COLUMNS } : undefined}>
        {kit
          ? Array.from({ length: KIT_KEYS }, (_, i) => {
              const midi = baseNote + i;
              const { col, row } = kitCell(i);
              const soundName = kitNames?.[i] ?? `Sound ${i + 1}`;
              const keyLabel = keyLabels?.[midi];
              const two = kitTwoRowCell(i);
              const place = !kitRow ? { gridColumn: col + 1, gridRow: row + 1 } : kitRows === 2 ? { gridColumn: two.col, gridRow: two.row } : { gridColumn: kitRowColumn(i), gridRow: 1 };
              return (
                <div
                  key={i}
                  className={styles.pad}
                  style={place}
                  title={shortNames ? soundName : undefined}
                  data-midi={midi}
                  data-note={soundName}
                  data-lit={isLit(midi) || undefined}
                  data-pressed={pressed.has(midi) || undefined}
                  aria-hidden="true"
                >
                  <span className={styles.padName}>{shortNames ? shortSoundName(soundName) : soundName}</span>
                  {keyLabel && <span className={styles.padKey}>{keyLabel}</span>}
                </div>
              );
            })
          : keys.map((k, i) => (scaleBoard ? scaleKey(k, i) : pianoKey(k)))}
      </div>
    </div>
  );
}
