/**
 * Play notes or drum pads from the computer keyboard.
 *
 * Keys are matched by physical position (KeyboardEvent.code), so the layout
 * works the same on QWERTY, QWERTZ and AZERTY keyboards; the exported labels
 * are the QWERTY legends (see `useKeyCapLabels` for the user's own legends).
 *
 * Notes layout (a piano on the home row, black keys on the row above):
 *
 *     W E   T Y U   O P
 *    A S D F G H J K L ; '     -> semitone offsets 0..17 from the keyboard's base note
 *    Z = octave down, X = octave up
 *
 * Drums layout (the 4x4 pad grid; rows of keys match rows of pads on
 * screen, so pad 0 — bottom-left — is Z):
 *
 *    1 2 3 4   -> pads 12 13 14 15   (top row)
 *    Q W E R   -> pads  8  9 10 11
 *    A S D F   -> pads  4  5  6  7
 *    Z X C V   -> pads  0  1  2  3   (bottom row)
 *
 * Safety rules: typing in inputs, textareas, selects and editable text is
 * never intercepted; Ctrl/Meta/Alt chords and events a focused control has
 * already handled (defaultPrevented) are ignored; key repeats are ignored;
 * every held key is released on key-up (whatever the modifiers), window
 * blur, the tab becoming hidden, octave changes, layout changes, disabling
 * and unmount — so no note can get stuck.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type ComputerKeyboardLayout = 'notes' | 'drums';

export interface KeyMapping {
  code: string;
  /** QWERTY legend. */
  label: string;
  /** Semitone offset (notes) or pad index (drums). */
  index: number;
}

export const NOTE_KEYS: readonly KeyMapping[] = [
  { code: 'KeyA', label: 'A', index: 0 },
  { code: 'KeyW', label: 'W', index: 1 },
  { code: 'KeyS', label: 'S', index: 2 },
  { code: 'KeyE', label: 'E', index: 3 },
  { code: 'KeyD', label: 'D', index: 4 },
  { code: 'KeyF', label: 'F', index: 5 },
  { code: 'KeyT', label: 'T', index: 6 },
  { code: 'KeyG', label: 'G', index: 7 },
  { code: 'KeyY', label: 'Y', index: 8 },
  { code: 'KeyH', label: 'H', index: 9 },
  { code: 'KeyU', label: 'U', index: 10 },
  { code: 'KeyJ', label: 'J', index: 11 },
  { code: 'KeyK', label: 'K', index: 12 },
  { code: 'KeyO', label: 'O', index: 13 },
  { code: 'KeyL', label: 'L', index: 14 },
  { code: 'KeyP', label: 'P', index: 15 },
  { code: 'Semicolon', label: ';', index: 16 },
  { code: 'Quote', label: "'", index: 17 },
];

export const OCTAVE_KEYS = {
  down: { code: 'KeyZ', label: 'Z' },
  up: { code: 'KeyX', label: 'X' },
} as const;

export const DRUM_KEYS: readonly KeyMapping[] = [
  { code: 'Digit1', label: '1', index: 12 },
  { code: 'Digit2', label: '2', index: 13 },
  { code: 'Digit3', label: '3', index: 14 },
  { code: 'Digit4', label: '4', index: 15 },
  { code: 'KeyQ', label: 'Q', index: 8 },
  { code: 'KeyW', label: 'W', index: 9 },
  { code: 'KeyE', label: 'E', index: 10 },
  { code: 'KeyR', label: 'R', index: 11 },
  { code: 'KeyA', label: 'A', index: 4 },
  { code: 'KeyS', label: 'S', index: 5 },
  { code: 'KeyD', label: 'D', index: 6 },
  { code: 'KeyF', label: 'F', index: 7 },
  { code: 'KeyZ', label: 'Z', index: 0 },
  { code: 'KeyX', label: 'X', index: 1 },
  { code: 'KeyC', label: 'C', index: 2 },
  { code: 'KeyV', label: 'V', index: 3 },
];

/** Velocity for computer-key notes; Shift plays an accent. */
export const KEY_VELOCITY = 0.8;
export const KEY_ACCENT_VELOCITY = 1;

/** Key legend for a drum pad index (0 = bottom-left), or undefined. */
export function drumKeyHint(pad: number, labels?: ReadonlyMap<string, string> | null): string | undefined {
  const k = DRUM_KEYS.find((m) => m.index === pad);
  if (!k) return undefined;
  return labels?.get(k.code) ?? k.label;
}

/** MIDI note -> key legend for a keyboard whose A key plays `baseMidi` (for MiniKeyboard keyLabels). */
export function noteKeyLabels(baseMidi: number, labels?: ReadonlyMap<string, string> | null): Record<number, string> {
  const out: Record<number, string> = {};
  for (const k of NOTE_KEYS) out[baseMidi + k.index] = labels?.get(k.code) ?? k.label;
  return out;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') !== null;
}

export interface ComputerKeyboardOptions {
  enabled: boolean;
  layout: ComputerKeyboardLayout;
  /** Notes: semitone offset 0..17. Drums: pad index 0..15. */
  onNoteOn(index: number, velocity: number): void;
  onNoteOff(index: number): void;
  /** Notes layout only: Z / X. Held notes are released before this is called. */
  onOctave?(delta: -1 | 1): void;
}

export interface ComputerKeyboardControls {
  /** Release every held key now (e.g. on transport Stop or Mute All). */
  releaseAll(): void;
}

export function useComputerKeyboard(options: ComputerKeyboardOptions): ComputerKeyboardControls {
  const { enabled, layout } = options;
  const opts = useRef(options);
  useEffect(() => {
    opts.current = options;
  });
  /** code -> index currently sounding */
  const held = useRef(new Map<string, number>());

  const releaseAll = useCallback(() => {
    if (held.current.size === 0) return;
    const indices = [...held.current.values()];
    held.current.clear();
    for (const i of indices) opts.current.onNoteOff(i);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const map = new Map<string, number>((layout === 'notes' ? NOTE_KEYS : DRUM_KEYS).map((k) => [k.code, k.index]));

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (layout === 'notes' && (e.code === OCTAVE_KEYS.down.code || e.code === OCTAVE_KEYS.up.code)) {
        e.preventDefault();
        if (e.repeat) return;
        releaseAll();
        opts.current.onOctave?.(e.code === OCTAVE_KEYS.up.code ? 1 : -1);
        return;
      }
      const index = map.get(e.code);
      if (index === undefined) return;
      e.preventDefault();
      if (e.repeat || held.current.has(e.code)) return;
      held.current.set(e.code, index);
      opts.current.onNoteOn(index, e.shiftKey ? KEY_ACCENT_VELOCITY : KEY_VELOCITY);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const index = held.current.get(e.code);
      if (index === undefined) return;
      held.current.delete(e.code);
      opts.current.onNoteOff(index);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') releaseAll();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onVisibility);
      releaseAll();
    };
  }, [enabled, layout, releaseAll]);

  return { releaseAll };
}

/**
 * The user's own key legends (e.g. "Z" where QWERTY has "Y" on a German
 * keyboard) via the Keyboard Map API where available; null otherwise, in
 * which case the QWERTY labels apply.
 */
export function useKeyCapLabels(): ReadonlyMap<string, string> | null {
  const [labels, setLabels] = useState<ReadonlyMap<string, string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const kb = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
    if (!kb?.getLayoutMap) return;
    kb.getLayoutMap()
      .then((m) => {
        if (cancelled) return;
        const out = new Map<string, string>();
        for (const k of [...NOTE_KEYS, ...DRUM_KEYS, OCTAVE_KEYS.down, OCTAVE_KEYS.up]) {
          const v = m.get(k.code);
          if (v) out.set(k.code, v.toUpperCase());
        }
        setLabels(out);
      })
      .catch(() => {
        /* not allowed in this context (e.g. iframe); keep QWERTY labels */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return labels;
}
