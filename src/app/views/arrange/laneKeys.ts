/**
 * The Song view's keys (pure: no DOM, no React), when the timeline has
 * keyboard focus. Space (play / pause the song), Shift+Space and Undo / Redo
 * are the app's own keys and are not handled here. Ctrl means ⌘ on a Mac.
 *
 * Delete / Backspace       remove the selected loops
 * Ctrl+C / Ctrl+X / Ctrl+V copy, cut, paste at the playhead (same parts)
 * Ctrl+D                   duplicate (after the selection)
 * Ctrl+A                   select every loop
 * Ctrl+E (and Ctrl+T)      split the selection at the playhead
 * ← / →                    move the selection a bar (Shift: 4 bars)
 * Alt+← / Alt+→            shorten / lengthen it a bar (Shift: 4 bars)
 * ↑ / ↓                    the loop on the part above / below
 * Ctrl+← / Ctrl+→          the previous / next loop on the same part
 * Enter or Home            playhead to bar 1
 * Shift+F10 or the menu key the loop's actions
 * Esc                      clear the selection
 *
 * Ctrl+T is the split key GarageBand people know; browsers keep it for a new
 * tab, so Ctrl+E is the one Help lists.
 */

export type LaneKey =
  | { kind: 'delete' }
  | { kind: 'copy' }
  | { kind: 'cut' }
  | { kind: 'paste' }
  | { kind: 'duplicate' }
  | { kind: 'selectAll' }
  | { kind: 'split' }
  | { kind: 'move'; bars: number }
  | { kind: 'length'; bars: number }
  | { kind: 'focus'; dir: 'up' | 'down' | 'prev' | 'next'; extend: boolean }
  | { kind: 'home' }
  | { kind: 'menu' }
  | { kind: 'escape' };

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** The lane action for a key press, or null (the key is not the lane's). `mac`: ⌘ is the command key. */
export function laneKey(e: KeyInput, mac = false): LaneKey | null {
  const mod = mac ? e.metaKey : e.ctrlKey;
  // The other platform's command key is not ours (Ctrl+click on a Mac is the context menu).
  const otherMod = mac ? e.ctrlKey : e.metaKey;
  if (otherMod) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey) {
    if (e.shiftKey) return null;
    switch (k) {
      case 'c':
        return { kind: 'copy' };
      case 'x':
        return { kind: 'cut' };
      case 'v':
        return { kind: 'paste' };
      case 'd':
        return { kind: 'duplicate' };
      case 'a':
        return { kind: 'selectAll' };
      case 'e':
      case 't':
        return { kind: 'split' };
      case 'ArrowLeft':
        return { kind: 'focus', dir: 'prev', extend: false };
      case 'ArrowRight':
        return { kind: 'focus', dir: 'next', extend: false };
      default:
        return null;
    }
  }
  if (mod) return null;
  const step = e.shiftKey ? 4 : 1;
  if (e.altKey) {
    if (k === 'ArrowLeft') return { kind: 'length', bars: -step };
    if (k === 'ArrowRight') return { kind: 'length', bars: step };
    return null;
  }
  switch (k) {
    case 'Delete':
    case 'Backspace':
      return e.shiftKey ? null : { kind: 'delete' };
    case 'ArrowLeft':
      return { kind: 'move', bars: -step };
    case 'ArrowRight':
      return { kind: 'move', bars: step };
    case 'ArrowUp':
      return { kind: 'focus', dir: 'up', extend: e.shiftKey };
    case 'ArrowDown':
      return { kind: 'focus', dir: 'down', extend: e.shiftKey };
    case 'Enter':
    case 'Home':
      return e.shiftKey ? null : { kind: 'home' };
    case 'ContextMenu':
      return { kind: 'menu' };
    case 'F10':
      return e.shiftKey ? { kind: 'menu' } : null;
    case 'Escape':
      return { kind: 'escape' };
    default:
      return null;
  }
}
