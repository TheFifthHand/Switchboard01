/**
 * Every keyboard shortcut, in one table: the Help sheet's Shortcuts tab is
 * generated from it, and the transport's tooltips take their key lines from
 * it, so the two can never disagree. Pure data (no DOM): when a view's keys
 * change, change them here too.
 *
 * Keys are written with "Ctrl+" and turned into "⌘" on a Mac by
 * `keysFor(..., mac)`. View switching has no key on purpose: F6 and
 * Ctrl/Alt+digits belong to the browser.
 */

export interface Shortcut {
  /** Stable id (tooltips look a shortcut up by it). */
  id: string;
  /** The keys, one way per entry ("Ctrl+Shift+Z", "Ctrl+Y"). */
  keys: readonly string[];
  /** What it does, in plain words. */
  does: string;
}

export interface ShortcutGroup {
  id: string;
  title: string;
  /** Where these keys work, one short sentence (optional). */
  where?: string;
  items: readonly Shortcut[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    id: 'everywhere',
    title: 'Everywhere',
    where: 'Not while you type in a field, and not behind an open dialog.',
    items: [
      { id: 'play', keys: ['Space'], does: 'Play or pause. In Song it plays the song from the playhead.' },
      { id: 'stop', keys: ['Shift+Space'], does: 'Stop and go back to the start.' },
      { id: 'undo', keys: ['Ctrl+Z'], does: 'Undo the last change.' },
      { id: 'redo', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], does: 'Redo what you undid.' },
      { id: 'save', keys: ['Ctrl+S'], does: 'Save now in this browser (it also saves by itself).' },
      { id: 'mute', keys: ['M'], does: 'Mute or unmute the selected part.' },
      { id: 'help', keys: ['?'], does: 'Open this Help.' },
      { id: 'escape', keys: ['Esc'], does: 'Close a menu or dialog, cancel a drag, or skip the quick guide.' },
    ],
  },
  {
    id: 'notes',
    title: 'Playing notes',
    where: 'With a melodic part selected (Bass, Chords, Lead …).',
    items: [
      { id: 'scale-keys', keys: ['A S D F G H J K L ; \''], does: 'Musical Assist on (only notes in the key): the first 11 keys, left to right.' },
      { id: 'scale-keys-high', keys: ['Q W E R T Y U I O P [ ]'], does: 'Musical Assist on: keys 12 to 23, left to right.' },
      { id: 'white-keys', keys: ['A S D F G H J K L ; \''], does: 'Musical Assist off (the piano): white keys, from C.' },
      { id: 'black-keys', keys: ['W E T Y U O P'], does: 'Musical Assist off: black keys.' },
      { id: 'octave', keys: ['Z', 'X'], does: 'Octave down, octave up.' },
    ],
  },
  {
    id: 'drums',
    title: 'Playing drums',
    where: 'With a drum part selected: the keys sit like the 4 × 4 pads.',
    items: [
      { id: 'drum-pads', keys: ['1 2 3 4', 'Q W E R', 'A S D F', 'Z X C V'], does: 'The pads, top row to bottom row.' },
    ],
  },
  {
    id: 'pads',
    title: 'Clip pads (Play)',
    where: 'With keyboard focus on a pad.',
    items: [
      { id: 'pad-move', keys: ['← → ↑ ↓'], does: 'Move between pads.' },
      { id: 'pad-actions', keys: ['.', 'Shift+F10'], does: 'Open the pad’s actions without playing it.' },
      { id: 'scene-menu', keys: ['Shift+F10', 'F2'], does: 'On a scene button: its menu (rename, insert, duplicate, delete).' },
      { id: 'pad-rename', keys: ['F2'], does: 'Rename the clip.' },
      { id: 'pad-delete', keys: ['Delete'], does: 'Delete the clip (Undo brings it back).' },
      { id: 'pad-copy', keys: ['Ctrl+C', 'Ctrl+V'], does: 'Copy a clip, paste it on another pad.' },
      { id: 'scene-move', keys: ['Alt+↑', 'Alt+↓'], does: 'On a scene button: move the whole row up or down.' },
    ],
  },
  {
    id: 'song',
    title: 'Song',
    where: 'In the Song view, on what is selected (unless you are typing a name).',
    items: [
      { id: 'song-select', keys: ['↑ ↓', 'Ctrl+← →'], does: 'The loop on the part above or below; the previous or next loop on the same part.' },
      { id: 'song-move', keys: ['← →', 'Shift+← →'], does: 'Move the selected loops a bar (Shift: 4 bars).' },
      { id: 'song-length', keys: ['Alt+← →', 'Alt+Shift+← →'], does: 'Make them shorter or longer by a bar (Shift: 4 bars).' },
      { id: 'song-edit', keys: ['Ctrl+C', 'Ctrl+X', 'Ctrl+V'], does: 'Copy, cut, and paste at the playhead (on the same parts).' },
      { id: 'song-duplicate', keys: ['Ctrl+D'], does: 'Duplicate the selected loops right after them.' },
      { id: 'song-split', keys: ['Ctrl+E'], does: 'Split the selected loops at the playhead.' },
      { id: 'song-delete', keys: ['Delete', 'Backspace'], does: 'Remove the selected loops (and selected section names) from the song.' },
      { id: 'song-all', keys: ['Ctrl+A'], does: 'Select every loop and section in the song.' },
      { id: 'song-home', keys: ['Enter', 'Home'], does: 'Playhead back to bar 1.' },
      { id: 'song-menu', keys: ['Shift+F10'], does: 'The loop’s actions (also a right-click).' },
      { id: 'song-mouse', keys: ['Alt+drag', 'Ctrl+drag'], does: 'Drop a copy of the loops you drag.' },
      { id: 'song-zoom', keys: ['Ctrl+wheel'], does: 'Zoom the song around the pointer (the wheel alone scrolls it).' },
    ],
  },
  {
    id: 'controls',
    title: 'Knobs and number fields',
    items: [
      { id: 'knob-step', keys: ['↑ ↓'], does: 'Change the value. Shift moves in fine steps.' },
      { id: 'knob-page', keys: ['Page Up', 'Page Down'], does: 'Bigger steps.' },
      { id: 'knob-ends', keys: ['Home', 'End'], does: 'The lowest, the highest value.' },
      { id: 'knob-reset', keys: ['Delete'], does: 'Back to the default (so does a double-click).' },
      { id: 'knob-type', keys: ['Enter'], does: 'Type a value (on a knob); on a field, keep what you typed.' },
    ],
  },
];

/** The shortcut with this id, or undefined. */
export function shortcut(id: string): Shortcut | undefined {
  for (const g of SHORTCUT_GROUPS) {
    const s = g.items.find((x) => x.id === id);
    if (s) return s;
  }
  return undefined;
}

/** One key combination as shown on this computer ("Ctrl+Z", or "⌘Z" on a Mac). */
export function showKeys(keys: string, mac: boolean): string {
  return mac ? keys.replace(/Ctrl\+/g, '⌘') : keys;
}

/** The keys of a shortcut, joined for a tooltip line ("Ctrl+Shift+Z or Ctrl+Y"); '' when unknown. */
export function keysFor(id: string, mac = false): string {
  const s = shortcut(id);
  return s ? s.keys.map((k) => showKeys(k, mac)).join(' or ') : '';
}

/** True on Apple keyboards (⌘ instead of Ctrl). */
export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
