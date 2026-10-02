/**
 * The Help sheet's walkthroughs (docs/GUIDE.md's three tours as short
 * steps) and the "What's new" notes shown once after an update. Pure data:
 * when the guide or a control's name changes, change it here too.
 */

export interface Walkthrough {
  id: string;
  title: string;
  /** About how long it takes. */
  time: string;
  steps: readonly string[];
}

export const WALKTHROUGHS: readonly Walkthrough[] = [
  {
    id: 'loop',
    title: 'Make your first loop',
    time: 'about three minutes',
    steps: [
      'Press Jump In (or Start a new groove). A House groove plays, and the lit pads say Playing.',
      'Tap another pad in the Bass column. It says Next bar and takes over on the next bar line, in time.',
      'Press Mute on Drums: the column dims and the drums go silent. Press it again to bring them back. Solo plays one part on its own.',
      'Select a part, press Change instrument and pick a sound. Undo (Ctrl+Z) brings the old one back.',
      'Turn the big knobs: Tone, Space, Echo, Motion, Drive and Pump. Drag up or down; double-click resets.',
      'Drag a clip onto another pad to move it; hold Ctrl while you drop to copy it.',
      'Press Pause (or Space) to hold the music where it is; Stop (Shift+Space) goes back to the start.',
    ],
  },
  {
    id: 'song',
    title: 'Build a song',
    time: 'about three minutes',
    steps: [
      'Open Arrange. The song plays its blocks left to right; each block is a scene played a number of times.',
      'Press Play (or Space): in Arrange it plays the song. ▶ on a block, or a click on the bar numbers, starts from there.',
      'Drag a block to move it. Hold Ctrl while dragging to drop a copy.',
      'Drag a block’s right edge to play it more times, or fewer. With the keyboard, + and − do the same.',
      'Click a part in a block to switch it off there; click again to bring it back.',
      'Drag a scene card onto a block to layer it in, or between two blocks to add it as a new block.',
      'Open a block’s ⋯ → Shape this block… for Build up, Strip down or Breakdown, each one Undo.',
    ],
  },
  {
    id: 'export',
    title: 'Record and export',
    time: 'about three minutes',
    steps: [
      'With music playing, press Performance to record what you do. Press it again to stop; the take appears in Arrange.',
      'Notes records what you play into the selected clip. One Undo removes the whole pass.',
      'Open Mix and try a mastering preset and a loudness target. Compare A/B lets you hear the mix without mastering.',
      'Press Export (or ⋯ → Export WAV…), choose the song, a scene or a performance, then Export WAV.',
      'For a portable copy, open Projects → Export this project. The .omnisong.zip file opens in any browser.',
    ],
  },
];

export interface ReleaseNotes {
  version: string;
  notes: readonly string[];
}

/** What changed in this version, newest first (only the first entry is shown). */
export const WHATS_NEW: readonly ReleaseNotes[] = [
  {
    version: '2.1.0',
    notes: [
      'Help: every keyboard shortcut in one place (press ?), these walkthroughs, and the version.',
      'A project open in two tabs is saved by one of them only: the other says so and offers Take over or Open a copy.',
      'Ctrl+S saves at once, and a failed save says so once, with Export project file.',
      '“Try this” hints now also teach the song: playing it, making a block longer, switching a part off, exporting.',
      'Coming back, Continue opens your song; Start a new groove keeps it in My projects.',
    ],
  },
];

/** localStorage key holding the last version whose notes were seen (or that was first run). */
export const SEEN_VERSION_KEY = 'switchboard01.seenVersion';

/**
 * Should "What's new" open by itself? Only after an update: a first run (no
 * version stored yet) just records the version. Returns the notes to show,
 * or null.
 */
export function notesToShow(current: string, seen: string | null, notes: readonly ReleaseNotes[] = WHATS_NEW): ReleaseNotes | null {
  if (!seen || seen === current) return null;
  return notes.find((n) => n.version === current) ?? null;
}
