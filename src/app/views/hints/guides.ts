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
      'Drag a loop onto another pad to move it; hold Ctrl while you drop to copy it.',
      'Press Pause (or Space) to hold the music where it is; Stop (Shift+Space) goes back to the start.',
    ],
  },
  {
    id: 'song',
    title: 'Build a song',
    time: 'about three minutes',
    steps: [
      'Open Song. Each part has its own row, like the tracks in GarageBand; the ruler counts the bars.',
      'Press Add loops (top right) and drag a scene onto the rows: each of its parts gets a loop. Or drag one part’s loop onto its own row.',
      'Drag a loop’s right edge to make it play longer: it snaps to the bars and repeats to fill them.',
      'Drag a loop to move it; hold Alt (or Ctrl) as you let go to drop a copy. Double-click an empty spot to pick a loop for it.',
      'Double-click a loop to edit its notes in the editor under the song (E opens it, Esc closes it).',
      'Click a bar number to move the playhead, then press Play (or Space). Drag along the bar numbers to loop part of the song.',
      'Right-click a section (Intro, Drop …) for fades, a filter rise, Build up or Breakdown, each one Undo. Shape the song… adds an intro or an ending.',
    ],
  },
  {
    id: 'export',
    title: 'Record and export',
    time: 'about three minutes',
    steps: [
      'With music playing, press Performance to record what you do. Press it again to stop; the take appears in Song.',
      'Notes records what you play into the selected loop. One Undo removes the whole pass.',
      'Open Mix, try a mastering preset in Finish, then Make it as loud as streaming songs.',
      'Press Export (or ⋯ → Export…). The whole song is chosen for you: pick a format, then press Export.',
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
    version: '2.4.0',
    notes: [
      'Make a beat from scratch (on the first screen): a drum grid that plays while you click, and Start from a beat… with 52 ready beats in many styles.',
      'A loop library in Song (+ Add loops → Library): 164 loops for every part, in your song’s key. Press ▶ to hear one, drag it onto a row.',
      'Press ● Record in Song to record straight into the song from the playhead. Double-click a loop (or press E) to edit it under the song; Make this one different gives one place its own copy.',
      'Song rows have volume and pan; right-click the bar numbers to insert or remove bars; drag a section to reorder the song without cutting anything.',
      'Export the whole song as loud as streaming songs, as WAV, a smaller file for sharing, separate parts or a MIDI file.',
      'Five new starters (Trap, Lo-fi Hip Hop, Pop, Afrobeats, Boom Bap), new sounds, and simpler Mix and Shape in Simple mode. Clips are now called loops everywhere.',
    ],
  },
  {
    version: '2.3.0',
    notes: [
      'Song works like GarageBand: every part has its own row. Press Add loops and drag loops and scenes in, move them along their row, and drag a loop’s right edge to make it repeat longer. Everything snaps to the bars.',
      'Click the ruler to move the playhead; drag along it to loop a stretch. Alt-drag copies a loop; right-click one for Split, Duplicate and more. Name parts of the song (Intro, Drop…) in the Sections strip.',
      'With Musical Assist on, the keyboard shows only the notes in your key, as even keys: every key plays its own note.',
      'The pads say what a click does (▶ Play / ■ Stop), the part buttons have words, and Pause sits next to the pads.',
      'A new version opens by itself, and the launcher no longer opens an older copy that is still running.',
      'Songs from earlier versions open as they were, on the new rows.',
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
