# Omni Song — interface rulebook

The product is **Omni Song** (version 2 of what was SWITCHBOARD / 01). This is the shared rulebook
for its interface. When in doubt, choose what a first-time user would understand without reading
anything. User-facing text says "Omni Song"; the old name appears only where it helps someone
coming from 1.0 (the Welcome card's one-time note, START HERE, project-file import).

## Principles

1. **One obvious way** to do the common things: play / pause / stop, mute / solo a part, change a
   part's instrument, move or copy a clip, record, export.
2. **Simple by default, depth on request.** `uiStore.uiMode` is `'simple'` (default, remembered) or
   `'advanced'`. Simple hides detail; it never removes capability. **Simple · Advanced** sits in the
   transport.
3. **Words, not abbreviations.** Knobs show full words (labels may wrap to two lines). Icons on
   primary actions come with a text label. No jargon where a plain phrase exists.
4. **Big targets.** Primary controls at least 40 × 40 px; nothing clickable smaller than 32 × 32 px
   (menu keys included). A finger gets at least 44 px around a knob's dial or a fader's cap.
5. **State is visible** in text as well as colour: Playing / Paused / Stopped; a muted part is
   dimmed and says **Muted**; a soloed part says **Solo**.
6. **Direct manipulation, with a keyboard path.** Drag clips, scene rows, song blocks, notes and
   drum steps; every drag has a keyboard alternative.
7. **Everything is undoable**, and the toast says what happened, with Undo. Undo steps are named in
   the user's words, naming the part where it helps ("Bass level", "Mute Lead", "Move 2 notes").
8. **Colour is information:** amber = sound playing / signal, teal = selection / focus /
   modulation, coral = recording / muted / attention. Tokens from `src/ui/theme.css`. Colour is
   always paired with text or an icon.
9. **An engaged toggle keeps its on-look** under the pointer, while pressed and with keyboard focus
   (Mute All, Mute, Solo, Keep pattern, Loop, Follow, the metronome): hover and press only change
   keys that are off. Its words read at 4.5:1 or better on every stop of its background.
10. **State changes never move the layout.** Words that come and go (Muted / Not soloed / Solo,
    Saving… / Saved, Compare's two labels) live in boxes that keep their size.
11. **Every control does something real.** A control that would move nothing is dimmed or
    unavailable and says why ("Moves nothing here", "Set this band's gain first"); nothing is
    shown that has no effect.
12. **The playing music is never interrupted by the interface.** View switches, dialogs and menus
    never stop or delay playback; a busy moment skips ahead rather than stopping (see Transport).

## Shell

### Welcome

- First visit: the real instrument behind a small card, "Start with a beat. Make it yours.", and
  **Jump In** (focused). Jump In enables audio and starts the House starter; the view paints first,
  then the sound starts.
- Coming back: **Continue "<name>"** is the main, focused key; **Start a new groove** is second.
  Starting a new groove keeps the earlier project and says so: "Started a new House. Your earlier
  "…" is in My projects." with **Open it**.
- "Other starters & projects" opens the Project library; **Just look around** (or Esc) closes the
  card. The card traps Tab. After Jump In, focus goes to the quick guide's Next, else to Play.
- When a reload or a closed tab came right after an edit, the card says the last edits were
  recovered (the rescue copy).

### Transport (top bar)

Left to right, in clear groups:

| Group | Contents |
|---|---|
| Views | **Play · Shape · Arrange · Mix** (segmented, large). The tab changes at once; the view renders right after. No keyboard shortcut (F6 and Ctrl/Alt+digits belong to the browser). |
| Playback | **Play / Pause** (one key), **Stop**, position (bar.beat) and state word (Playing / Paused / Stopped / Song / Replay; "Nothing to play yet" when playing with no clip sounding) |
| Tempo | Tempo; Swing (Advanced) |
| Record | **Notes**, **Performance**, recording options. While Record Notes waits for its downbeat the caption counts down in coral: "Recording in 3…" |
| Output | Master volume + meter, **Mute All** |
| Right | **Simple · Advanced**, save state, **Undo** / **Redo**, Projects, **Export**, MIDI & audio (once connected), **⋯ More** |

What the strip shows by width (the views, Play, Stop, Tempo, Record, Master, Mute All, the save
state, Undo, Redo and More are always on it):

| Width | Adds |
|---|---|
| below 1024 px | two balanced rows (Master and Mute All on the second), at most 81 px tall at 960 × 540 |
| 1024–1279 | Stop as its square; the switch, Export and Projects are in More (Advanced, with Swing: two rows below 1180 px) |
| 1280–1365 | the word "Stop" (Simple) |
| 1366–1439 | the Simple · Advanced switch, Export with its word, "Stop" in Advanced too |
| 1440–1599 | Projects, the offline state, "Not saved" in words |
| 1600 up | the words of Undo and Redo, a waiting Update key, roomier spacing |
| 1700 up | the save word; from 1800 the project's name |

- The right-hand group is the same width in Simple and Advanced, so the switch never moves when
  pressed. Advanced takes Swing's room from the bar.beat readout at 1366–1799 px; at 1366–1439 px
  (1440–1599 beside the MIDI & audio key) Swing is a narrow field.
- Things that come and go take room from the least important first: a waiting Update or a failed
  save from Projects and the words of Undo and Redo; the MIDI & audio key from the offline state.
  Never the save state, Undo, Redo, Export or Stop, nor the switch from 1366 px.
- Unavailable, Undo and Redo stay focusable and their tip says why ("Nothing to undo yet.");
  available, they name the step ("Undo: Move block").
- **Tempo and Swing**: Enter commits and hands the keys back to the app (Space plays); dragging
  Tempo moves in whole BPM.
- The transport writes its height, including any banner under it, to `--transport-h`.

**Play in Arrange plays the song.** In Arrange (with blocks in the song) the Play key reads **Play
song** and Space does the same: from the loop when one is set, else from the first block. A pause
resumes whatever was playing. In every other view Play and Space play the pads. Stop ends the song;
Export opens with the song chosen when pressed in Arrange.

**Pause semantics.** Pause holds the musical position (bar, beat, every clip's phase); Play
continues from exactly there. Stop returns to bar 1, leaving the pads that were playing armed.
Space = Play/Pause; Shift+Space = Stop. While a performance take records, Pause is unavailable and
its tip says why; Stop ends the take. During Record Notes, Pause ends the pass (one undo step).

**Busy moments.** A visible tab that falls behind skips ahead and keeps time; at most once a minute
a quiet notice says "Omni Song was busy for a moment, so a few notes were skipped to stay in time."
Only a background tab or a paused audio device stops playback; the banner says "Playback stopped
because the tab was in the background or the audio device paused. Press Play to continue." with a
**Play** key.

**Save state.** An icon in neutral ink with a label: a check (Saved), a turning arc (Saving…), a
hollow ring (Preview: a first-launch starter not stored yet), a coral warning (**Not saved**).
Clicking it opens the Project library, except while it shows an error (then it explains and
offers **Try again** and **Export project file**). A run of failed saves raises one toast, with
Export project file.

**Title and headings.** The browser tab reads "<project> — Omni Song", with ▶ while playing. Each
view has one hidden h1 naming it and the project.

### Banners under the transport

- **Two tabs:** "This project is open in another tab. Changes here are not saved." with **Take
  over** and **Open a copy**. When another tab saved the project after this one opened it: the
  project changed in another tab, with **Open the latest** and **Open a copy**.
- **Audio** (suspended, failed) and **playback stopped** (see Busy moments).

### More menu (⋯)

Order: **Update** first when one waits (a coral dot on ⋯ below 1600 px); Undo, Redo; Show every
control (Advanced), Tips; **New project…**, **Projects…**, **Export WAV…**, **MIDI & audio…**,
**Help…** (?). The offline state is its last line, plain text that cannot be focused.

### Help

**Help** opens from ⋯ → Help… or the **?** key (not while typing). Tabs:
- **Shortcuts**, generated from the one table in `src/app/views/hints/shortcuts.ts` (the
  transport's tooltips take their key lines from it too, so they never disagree).
- **Guides**: the three walkthroughs of the user guide as short steps, **Show the quick guide
  again** and **Show hints again**.
- **About**: the version (from `package.json`) and what is new. After an update a one-time toast
  offers **What's new**, which opens this tab.

### Keys and leaving

- **Ctrl/⌘+S** saves now (also from a field) and says "Saved in this browser." with Export project
  file; the browser never saves the page.
- The browser asks before leaving only while a performance or audio take records, an export
  renders, or edits could not be saved. Never merely for playing.
- A project file (`.omnisong.zip`, `.sb01.zip`) dropped anywhere on the window opens it. Sampler
  drop zones keep their own handling; other files are refused with a message.
- A drag or swipe that runs past the window edge never triggers the browser's Back/Forward swipe.

## Play view

### Loops grid

- **1 to 8 scene rows** (`project.scenes.length`). Rows scroll under a sticky head row (the part
  headers and Stop all), pads at least 64 px tall. **Add scene** sits under the scene column beside
  the pad actions until there are 8. A short window shows a fade at the foot while rows are below.
- **One selected clip.** Every control acts on the ringed pad of the selected part
  (`src/app/selection.ts`): the pad actions, the part's ▶, Variation, Record Notes and Steps. A part
  with no chosen slot gets one when selected: the clip it plays, else its first clip, else the
  first slot. A part never selected uses its first clip for ▶, the same slot it gets when selected.
- **Column headers:** number badge (white on `--teal-key`), part name (one size down under 110 px),
  sound name on up to two lines, full names in a tooltip while cut. A **part ▶/■** (starts the
  chosen clip at the next bar / stops the part at the next bar); **Mute** and **Solo** as labelled
  toggles (≥ 32 px); a real level meter.
- **Mute and Solo:** a muted column dims and says **Muted**; with any solo on, others dim and say
  **Not soloed**; those words take the meter's place in a box of fixed height. A soloed part keeps
  its meter and shows a small **Solo** tag. **M** mutes the selected part. Solo has no letter key
  (S plays a note) and no `aria-keyshortcuts`.
- **Pads:** empty pads are a quiet outline with "+" (hover/focus: Add clip). Clip pads: name large,
  length small, state word (Ready / Next bar / Playing / Stopping / Paused / Rec). A playing pad is
  an even amber wash. Where a pad is at least 100 px tall it shows a sketch of its notes. A long
  name fades at its end (no ellipsis) and the pad then carries the whole name as its title.
  - Stopped: a pad that will start says **Starts on Play**, and its part's ■ key reads "Skip <part>
    when Play starts".
  - **Loop progress:** a 3 px bar along the bottom of each sounding pad and of the playing scene
    button shows its place in the loop, moving once a sixteenth (once a beat with reduced motion),
    timed from the audio clock. A queued pad counts down: "Next bar · 3".
- **Scene buttons** say how many parts they play ("4 parts", "1 part", "no clips"), in Inter.
- **Keyboard:** the pads with the scene buttons are one Tab stop and the part headers another;
  arrows move, Home/End go to the row's ends, Ctrl+Home/End to the grid's corners. Focus scrolls
  clear of the sticky head. On a focused pad: "." or Shift+F10 opens its actions without playing
  it, F2 renames, Delete removes (with Undo), Ctrl+C / Ctrl+V copy and paste clips. On a scene
  button: Alt+↑/↓ moves the row; Shift+F10, F2 or the menu key open the scene menu.

### Moving clips and rows

- **Drag a clip pad** onto another pad to **move** it (onto a clip: the two **swap**); hold
  **Ctrl** (or Alt) while dropping to **copy** (onto a clip: **Replace**, with Undo). A press that
  moves less than 6 px is a tap and launches. The pad lifts and follows the pointer with a **Move**
  / **Copy** label; its own place is a dashed placeholder; the target previews Swap, Replace or
  **Can't go here** with the reason on the lifted pad. Drops settle in 200 ms; Esc, a refused drop
  or a release away glide it home. Drum and melodic parts never swap clips. Keyboard: **Move…**,
  then arrows and Enter (Ctrl+Enter copies), Esc cancels. One undo step per move or copy.
- **Scene rows** reorder by dragging the scene button (or Alt+↑/↓): the row lifts, the others
  slide apart, every part's clips move with it; song blocks keep pointing at the same scenes.

### Pad actions and menus

- The selected pad's **action bar** under the grid: Edit steps · Duplicate · Move… · Rename ·
  Delete (New clip on an empty pad, which offers the lengths). Right-click, Shift+F10, the menu key,
  "." or the pad's ⋯ open the same actions as a menu at the pad, without playing it.
- **Clip menu:** Length and New clip offer **1, 2, 3, 4 and 8 bars**; **Double (repeat)** and
  **Repeat to 8 bars** fill new bars with the pattern (the Length tip says a plain lengthening
  leaves new bars empty). Duplicate and Move… reach every row. After a new clip from the menu, focus
  moves to Edit steps and the toast offers **Edit steps**.
- **Scene menu:** Rename scene…, Launch scene, Move up / down, **Insert scene above / below**,
  **Duplicate scene** (copies its clips), **New scene from what's playing** (a new last row of
  copies of the playing clips; unavailable when nothing plays), Add to song, Export as WAV…,
  **Delete scene**. Delete asks first when the song uses the scene ("2 song blocks play it… Undo
  brings it all back") and offers to delete those blocks too; the only scene cannot be deleted.
  Each edit is one undo step and every part stays on its clip.

### Take lock

While a performance take records, the grid stays playable (pad taps and scene launches are
recorded) and says what is locked: a dragged pad lifts with **Locked** and no target lights up; a
drop or a row drag changes nothing; the action bar becomes one coral line, "Locked while a
performance records…"; Variation, its menu, Keep pattern, the new-clip keys, Add scene and the
editing items of the clip, scene and part menus are unavailable with the reason in their tooltip.

### Part panel (right)

- Header: part name with a fixed status line, **Mute**, **Solo**, **Volume** (big), Pan (Advanced).
- **Instrument card**: type icon and name ("Drum kit", "Bass synth", "Synth", "Sampler"), sound
  name, **Change instrument**.
- The six **big knobs** with a one-line caption each ("Moves nothing yet" when a big knob has no
  mappings; their tip lists what they really move); double-click here returns to the plain default
  (Shape returns to the sound's own position). On a big panel they grow to xl, and a picture of the
  selected clip shows where there is room. A panel too short for everything shows a fade at
  its foot while more is below.
- **Variation** is a split key. The main press makes a subtle variation of the selected clip; its
  menu (**More Variation choices**) offers **Subtle variation**, **Bold variation** and **Back to
  original**. Each press varies the clip's original notes (kept for the session from before the
  first press), so pressing again explores rather than piling changes up; any other edit makes the
  new notes the original. A press that finds nothing new says so. One press stays within ±30 % of
  the original note count.
- **Keep pattern** (reads **Pattern kept** when on; "Keep pattern (no Variation)" in the part menu)
  stops Variation changing the part.

### Cables drawer (Advanced)

A splitter resizes it; at its tallest the pads keep two whole rows. Edge shadows and "Scroll the
patch left/right" arrows reach Master Out.

## Bottom bar: keyboard and pads

### Keyboard strip

- Two octaves; three on a wide strip (from 22 white keys of at least 46 px). Keys widen to fill the
  strip, white keys up to 60 px.
- Every key the computer plays shows its letter (A and K included); C4, C5 and the root sit on a
  rail above the keys, spelled by the key. The octave reset reads **↺ C4** ("Reset octave to C4").
- **Musical Assist** (IN KEY / CHROMATIC) with a sentence saying what it does. Simple shows the key
  as a summary ("Key: G Dorian"); Advanced adds the key and scale pickers and the arpeggiator.
- The strip folds to a slim bar, remembered **per view**; Mix starts folded. Computer keys still
  play when folded. The strip writes the height it covers to `--keyboard-h` (0 when folded or when
  the page scrolls).
- **Kit keys:** with a drum kit selected the strip shows **KIT · 16 sounds** and 16 named keys with
  their letters, in one row of four groups (Z–V, A–F, Q–R, 1–4), two rows of eight on a narrow
  strip, short names when even those are narrow. One key always plays one kit sound, in every pad
  mode, from the same table as the Drums pads. No octave keys; the Assist switch is hidden.
- **Changing the key moves the song (Advanced).** A Key or Scale change asks once, in a small
  popover: "Move the song to A Dorian too? Bass, Chords, Lead and Pad move up 2; drums stay."
  Sampler parts are listed as opt-in checkboxes. **Move the song** transposes every melodic clip in
  one undo step (scale degrees are mapped, notes leaving the range fold back an octave, recorded
  takes keep their own key); **Only what I play** changes the key alone. Escape or a press elsewhere
  keeps the old key. Arrow keys on the picker keep changing the key and the question follows; focus
  stays on the picker.

### Notes pads

- 16 pads: consecutive in-key notes with Assist on, chromatic with it off (out-of-key notes
  shaded). Root pads carry a bold **Root** label and a dotted outline (not teal).
- **Chords** switch: pad n plays the chord on degree n of the key, **Triads / 7ths**, inversions
  **Smooth / Root / 1st / 2nd** (/ 3rd for sevenths; kept for the session only). Pads are named by
  their chord spelled in the key ("B♭", "E°", "Gm7") with the degree small. Chord notes skip Assist
  (they are already in key) but are recorded and arpeggiated; two pads sharing a note sound it once
  until both are released.
- **Write a progression…** writes a progression into the selected clip: eight plain names (Pop, Sad
  pop, Classic, Jazz turn, Epic, Moody, Anthem, Uplift) each shown with its chords in the key;
  Held / Stabs / Off-beats; Triads / 7ths; 1, 2, 3, 4 or 8 bars; a picture of the exact clip, whose
  chords sound when pressed. One undo step, with a toast. Drum and sampler parts are refused with
  the reason. Keys with too few notes for full chords (pentatonic, blues, chromatic) use their
  parent scale, and the toast says so.

### Drums pads

The kit overview is a clickable grid (see Steps, drum parts); the pad lane below it plays and paints
the chosen sound.

## Steps

The editor for the selected part's selected clip, one bar per page; clips are 1–8 bars.

**Header.** Part and clip pickers (one key per scene row), Length (1, 2, 3, 4, 8; 5–7 shown when
Double makes one), a **bar strip** of up to 8 bar keys (at least 32 px) under a sketch of the whole
clip (pressing the overview shows that bar), **Follow** (the shown bar turns with the heard bar
while the clip plays; a pointer held in the editor holds it back), the grid, and the tools: copy,
paste, copy to next bar, clear, Double, Transpose and **Timing…**. Tools fold into a ⋯ menu when
they do not fit; the header keeps two rows at 1366 × 768. The key chip is 32 px tall, shows "G
Dorian" where it fits, else "G Dor", with the full name in its tooltip. An empty slot offers a 1,
2, 4 or 8 bar clip.

**Melodic parts (piano roll).**
- Grid menu: **1/16, 1/32, 1/8T, 1/16T**; columns, ruler, velocity lane and playhead follow it.
  Snapping follows the grid; **Alt** places freely. Rows are in-key only with Assist on; rows,
  notes and announcements are spelled by the key (B♭).
- **Selection:** click a note to select it; Shift- or Ctrl-click toggles; a click on an empty cell
  adds a note and selects it. **Shift-drag** draws a teal selection box. Double-click or
  Delete/Backspace removes the selected notes ("Deleted 2 notes." with Undo).
- **Moving:** dragging moves the whole selection, across bars: held past the left or right edge the
  page turns after 400 ms, then one bar every 0.7 s. The roll shows the move while dragging and
  commits on the drop as one undo step; a drop on other notes replaces them ("Replaced 2 notes").
  A chord dragged in key moves each voice by scale steps.
- **Keys:** arrows move by the grid step; Alt+←/→ nudges 4 ticks; ↑/↓ one row (a scale step under
  Assist); Shift+↑/↓ an octave; Ctrl+A / C / X / V / D; Escape clears the selection or cancels a
  drag. Key moves never delete notes: they stop at the first neighbour or edge and say which ("The
  move stopped at the end of the clip").
- **Velocity lane:** one bar per chord voice. With a selection it edits only the selected notes
  (the others dimmed, "2 notes selected" in words); with none, every note on the step.
- **Transpose:** under Assist, ± moves a scale step and Shift an octave; Advanced adds "−
  Semitone +"; with Assist off the keys are semitones. Each press toasts ("Stabs moved up one
  step.") with Undo.
- **Timing…:** **Tighten timing…** (grid 1/4 to 1/16T, strength 25–100 %, a count of the notes it
  will move, toast "8 notes moved to the 1/16 grid.") and **Loosen (humanize)…** (timing in ms,
  level in %, a new roll per press, stored in the notes so playback and exports match). Notes that
  merge are named in the preview and the toast.
- **Touch:** the roll scrolls vertically (`touch-action: pan-y`). A tap adds or removes a note; a
  300 ms hold, or a sideways start, draws, moves or resizes; up/down first scrolls. Note names sound
  on a tap only.
- The playhead lights the step that is heard (output latency taken off).

**Drum parts.** A 16-step grid of the kit's 16 sounds, one ARIA grid with one Tab stop.
- A click on a cell toggles that hit and selects the sound. A drag along a row **paints** the new
  state of the first cell onto every step it crosses (or erases, from a lit cell), as one undo
  step; on an empty slot it creates a clip that grows with the drag. The large pad lane below paints
  the same way.
- Arrows move (↑/↓ also choose the sound); Space or Enter toggles the focused step.
- **Sound menu** (right-click a sound's name, Shift+F10, or the ⋯ by the selected sound): **Clear
  this sound**, **Fill every beat / 8th / 16th**, **Shift left / right** (wrapping), each with an
  Undo toast.
- Touch: a tap toggles; a sideways drag paints; an up-or-down swipe scrolls.
- Rows at least 20 px tall, 24 px on windows 900 px tall or more. Label column 140 px at 1600 px
  wide and more, 108 px at 1180 and less (shared with the piano roll).

## Shape view

Header: "← Back to Play", "Shaping: 4 Chords — House Stab", **Show every setting (Advanced)** (a
toast offers "Back to Simple"); a part selector.

### Simple

- **Instrument card:** type, sound, **Change instrument**, and a **Sound** row of friendly knobs
  with **Edit sound** (opens the Advanced instrument column for this part):
  - bass synth: **Soft start**, **Length**, **Octave**, **Character**;
  - poly synth: Soft start, Length, Character, **Thickness** (unison);
  - drum kit: a **Drum mix** of Kick, Snare and Hats levels plus Kick tune (Hats keeps the
    closed/open balance; locked during a take);
  - sampler: Start (keeps the length), Length, Pitch, and a small waveform.
- **Big knobs:** the six macros, large, with a caption; xl in a 3 × 2 grid where the panel has room.
  A big knob that reaches nothing audible is unavailable and reads **Moves nothing here**. **Reset
  big knobs** gives each one back what the sound is designed to move (one undo step; positions
  stay).
- **Effect cards**, in signal order: name, on/off switch, one knob that always changes the sound —
  the effect's first setting, or the big knob that sets it, with a line saying which (the Drive
  card shows the Drive big knob; the Filter card shows Tone or Motion). The Filter card offers
  Resonance only while the filter is in the audible band (low-pass below 12 kHz, high-pass above
  60 Hz), else: "Resonance appears once the filter closes below 12 kHz." The Compressor card's knob
  is **Squeeze** (half way = the compressor's own default; full = −36 dB, 7:1, faster attack, auto
  make-up). Compressor and Gate show a gain-reduction bar from the engine ("—" when there is none).
- **Effects header:** "N effects (up to 8)", **Copy effects** / **Paste effects** (after or instead
  of the part's effects, one undo step), **Add effect** grouped by purpose: Tone (EQ, Filter) ·
  Dynamics (Compressor, Gate) · Space (Reverb, Echo) · Movement (Chorus, Phaser, Flanger, Auto Pan)
  · Colour (Drive, Tape, Bit Crusher) · Stereo (Stereo Width).
- Removing an effect names the big knobs it leaves idle ("Removed Filter. The Motion big knob now
  moves nothing." with Undo); adding it back says which big knobs move it again.

### Knob extras (every Shape knob)

- **Double-click** returns to the sound's own value (the preset or kit value, the starter's
  big-knob position, or where an added effect starts); **Alt+double-click** to the plain default.
  The tooltip says both ("this sound's 28%").
- **Assign to big knob:** right-click, a 650 ms long press, or Shift+F10 / the menu key. A new
  assignment sweeps half the knob's travel around its current value, so the sound does not jump; a
  setting already assigned offers to stop that big knob moving it. Refused during a take, and the
  rows say so.
- Knobs that currently do nothing are dimmed with the reason in their tooltip: Unison and Vibrato
  settings until their amount is raised, FM settings at FM Amount 0, the Drive card's Character,
  Fizz and Mix while Drive is 0, an EQ band at 0 dB ("Set this band's gain first").

### Advanced

- Three columns: **Macros** (with mappings) | **Instrument** | **Effects** (chain, channel,
  returns, LFOs). Below 850 px of window height (from 1024 px wide) they become tabs, Instrument
  first. Each column keeps its scroll position per part.
- Mapping rows say what they do in words: "curve: gentle" / "curve: even" (a toggle) and "over Tone
  [60]–[100] %" (fields with arrow keys and typing); each change is one undo step. **Reset
  mappings** restores the design's mappings and the LFO cable to the filter, in one step.
- **Cables** open as a full-height overlay over the columns with a resizable splitter. The LFO
  block's name is never cut short.
- A part switch never remounts the columns; they follow in a deferred render.

## Sound browser

- Titled **Change instrument: <part>**. Categories with icons and counts (Drums & Percussion, Bass,
  Keys, Pads & Strings, Leads, Plucks & Bells, Textures & FX, Recordings), search, Preview, a
  "Current" marker and a one-line description per sound.
- Choosing a sound applies it at once and keeps the dialog open to compare. **Done**, × and Escape
  keep the choice; the toast says "Chords now plays X. Undo brings back House Stab as you had it."
  **Cancel (back to House Stab as you had it)** restores the sound exactly (knobs and effects
  included) and leaves no undo step. A whole browse is one undo step.
- Imports are checked before decoding. A part with no empty pad is refused in the dialog with what
  to do. A drum or synth part with clips asks first: **Put it on <sampler part> instead**,
  **Import onto <part> anyway** or **Cancel**. An import is its own undo step.

## Sampler editor (Shape, sampler parts)

- It edits the selected clip's own recording when the clip has one, else the part's; the header
  says which ("Recording 2 — plays in Vocal · Groove"). Start, End and Root belong to the clip's
  recording; mode, level, pitch, fades and tempo are the part's. When the part's settings change
  how a clip's recording sounds, the editor says so.
- The recording picker sets the selected clip's recording (or the part's when no clip is
  selected); "Vocal's recording (…)" gives a clip the part's recording back.
- **Waveform:** Ctrl/⌘+wheel or a two-finger pinch zooms at the pointer; − and + zoom around the
  handle used last; a sideways wheel scrolls; a plain wheel changes nothing. An overview strip shows
  the visible window, draggable and keyboard-operable. Handles are 32 px targets: **Shift-drag**
  snaps to the nearest hit (with Tempo Sync on, to whole beats from the other handle), **Alt-drag**
  is fine. A handle outside the view waits at that edge (‹S / E›) and comes to the pointer when
  pressed.
- **Tempo:** the bars helper suggests 1, 2, 4 or 8 bars (70–180 BPM, nearest the project tempo; an
  Original BPM that already gives whole bars is kept); arrow keys step 0.5, 1, 2, 4, 8.
  Tempo Sync changes speed and pitch together, and says so.
- **Record audio:** count-in and 1, 2, 4 or 8 bars; each take goes into its own clip.
- **Imports** make a new clip on an empty pad that plays the file at its own pitch: "Imported "X"
  as a new clip on Vocal · Groove. It plays at its recorded pitch."

## Arrange (song lane)

The song is one strip of **blocks** (a scene played a number of times, its *repeats*), edge to
edge, to scale. Code: `src/app/views/arrange/` (pure logic in songLayout, songDrag, songModel,
laneLoop; gestures in laneGestures; commands in `src/state/commands/arrangement.ts`).

**One Play per screen.** The transport's Play (and Space) plays the song in Arrange, its Stop stops
it and its Export starts from the song. The Song header keeps **Length**, **Echo tail** (seconds
added after the last block when exported), **Loop**, the loop chip and **Shape the song…**. The
mode box says what plays and how to play it. While the pads play (straight after Jump In) it shows
an amber 40 px **▶ Play the song** key ("Switched to the song"). While Record Notes writes into a
clip it says "Recording notes into Chords · Stabs (Groove)", adding "This block does not play it."
when that is so; cells that play the target show a coral **Rec**.

**Layout.**
- Left: the part names column (does not scroll) with compact **Mute** and **Solo** keys (the word
  shows on hover or focus) and the state in words (Muted / Solo / Not soloed); those parts' cells dim
  in every block. A part's name opens Off in selected blocks, Back on in selected blocks, Off
  everywhere and Back on everywhere. Above it, the lane's view tools: **−**, the zoom level (**Fit**
  when fitted, else a percentage; a press fits the song), **+**, **Follow**.
- Right: the lane scrolls sideways (never the page): the ruler (a loop row over the bar numbers),
  then the blocks. A block is a header (name, Playing / Next, length, ▶, ⋯; 32 px keys where there
  is room) over one cell per part. The playing block has no ▶ and keeps its whole **Playing** word.
- Part rows grow with the free height, 18 to 48 px (13 px names on tall windows); the lane adds at
  most 80 px of room under the blocks, so a tall window has no empty band.
- Below: the **SCENES** palette (every scene, up to 8, and **Add scene**) and the gesture hint.
  **Performances** folds to one line ("1 take ▸", with the newest take and its Replay); the choice
  is remembered, and until it is made the panel opens by itself only on tall windows.

**Scale.** Widths are proportional to bars; the only minimum is 44 px. Blocks narrower than 112 px
are **compact**: the header is the name only (▶ and ⋯ on hover, focus and while the menu is open),
cells show no clip names, and a cell's tip says what it plays. Ruler numbers are evenly spaced and
the playhead moves the same px per bar in every block. When Arrange opens, the scale is the largest
readable step at which the whole song fits (a song of 10 blocks or more that only fits at an
overview step opens there); after that edits never change it: a longer song scrolls. Zoom and
scroll are remembered per project for the session (a lane never zoomed is remembered as "fit" and
re-fits to the window); opening Arrange measures once. The scale changes with a window resize, the
zoom keys (two ladder steps a press), Ctrl/⌘+wheel (one step) or the zoom level key; blocks glide
200 ms. A **plain wheel** scrolls the lane sideways once nothing around it can scroll that way, and
counts as the user's own scroll (Follow waits). Fit never makes a cut-off song bigger.

**Cells.** A filled bar with the clip name = the part plays its scene's clip; striped with a layers
icon and **Lift: Bell Hook** = it plays another scene's clip there; **Off** in muted ink with a thin
coral edge = switched off in this block; a faint empty outline = the scene has no clip for it.
Hovering a cell says what a click does.

**Colour.** Amber = the block playing now (outline, **Playing**) and the block about to take over
(dashed, **Next**). Teal = selection, focus, drop targets, the loop band, and move ramps. Coral =
Off (a thin edge), Rec and the take lock.

**Gestures** (mouse or pen: a press becomes a drag after 4 px):
- **Touch:** a finger rests 300 ms on a block or scene card to pick it up; a finger that moves
  first scrolls. Held and released in place, a block opens its actions. On the **ruler** a swipe
  scrolls the lane; a 200 ms rest, then a drag, sets a loop.
- **Select:** click a header (teal); Shift+click a range; Ctrl/⌘+click toggles; a click on empty
  lane or Esc clears; Ctrl+A selects all. **Select blocks named "Lift"** (block menu) selects every
  block of that name.
- **Move:** drag a block; the others slide aside (170 ms) to open the slot; the drop commits what
  you see (one Undo). Esc, a release above or below the lane, a cancelled pointer or a window switch
  put everything back. Near the lane's ends it scrolls.
- **Copy:** hold Ctrl, Alt or ⌘ while dragging (**+ Copy**). Ctrl+D duplicates after itself.
- **Length:** drag a block's right edge (a 12 px grip inside the block; the hovered block rises
  above a selected neighbour). Whole repeats, 1–16; a bubble says "3 times · 12 bars". Keyboard + and
  −; quick presses are one undo step.
- **Split / join:** scissors under each repeat line on hover; **Join** under a seam of two blocks
  that play the same. Split keys appear on hover or focus only.
- **Parts:** click a cell to switch that part off in this block, again to bring it back ("Drums off
  in Groove", Undo). With several blocks selected, a cell click switches the part in all of them
  ("Drums off in 4 blocks"). A cell with nothing to switch opens the part picker.
- **Combine:** drag a scene card onto the middle of a block to **layer** it (fills the silent
  parts; Shift **replaces**). On a boundary the insertion slot opens only after the card rests there
  250 ms (any move over 3 px, or faster than 0.1 px/ms, restarts the wait); carrying on the way it
  came closes it again. Drop in the open slot to **insert** a block.
- **Clipboard:** Ctrl+C / X / V; right after a Cut, Paste puts the blocks back where they were.
  Delete or Backspace removes the selection (toast with Undo).
- **Ruler:** click a bar (or Enter on the focused ruler) to play from there.

**Loop.** The looped blocks repeat while the song plays (playback state, not saved; Play starts at
the loop). **Loop** names what it acts on and is pressed only when it names the loop that is on;
otherwise it offers to move it ("Move loop to Groove (block 2)"). A chip shows the loop ("Loop: Groove",
"Loop: Groove–Lift") with ✕ to stop it. A drag across the ruler sets a loop snapped to block edges, with a
toast offering **Stop looping**; each end of the band has a grip. The menu's **Loop…** has Loop this
block / selected blocks and Stop looping. Edits keep the loop (see ARCHITECTURE).

**Block menu.** Play song from here, Rename…, Duplicate, Split in half, Join with next, One more time
/ One time fewer; then lists that open in place with **Back**: **Parts in this block…** ("Parts in 4
blocks" with a selection), **Scenes and clips…** (change scene, layer, replace, **Make a scene from
this block**, edit clips in Play), **Shape this block…**, **Loop…**, **Copy, cut, move…**; and
**Remove from song**. Icons say what items do (pencil, scissors, join, layers, scene; trash only for
delete). Toggles inside a menu that stays open show their result by the check mark and a
screen-reader announcement, not a toast.

**Shape this block…**
- Song helpers, each one Undo and never changing the song's length: **Build up** (parts come in one
  at a time: texture, pad, chords, lead, sampler, percussion, bass, drums), **Strip down** (the
  reverse), **Breakdown** (drums, percussion and bass off). Unavailable with a short reason ("Plays
  once", "One part", "Uneven clips"…).
- **Moves**, checkable, each with a one-line explanation: **Fade in**, **Fade out** (the whole song's
  level across the block), **Filter rise** (melodic parts' Tone opens across the block),
  **Echo throw** (Echo rises over the block's last beat and returns a bar later). Blocks draw them
  as thin teal ramps (both fades: up then down, as heard) and name them in the header.

**Shape the song…** (Song header): **Add an intro** (a build-up of the first scene before the song)
and **Add an ending** (a strip-down of the last scene after it; an Echo tail of 0 s becomes 2 s).
One Undo each.

**Scenes palette.** Each card: ▶ **audition** (one pass on the live pads, stopping at the bar line
where the pass ends, timed on the audio clock; a second press stops at once; while the pads play it
switches at the next bar; while the song plays it is unavailable: "Stop the song to audition"), +
(add at the end) and ⋯ / right-click (Rename scene, Edit clips in Play, Add at the end of the song).

**Performances.** A take's events open in a tall side drawer with a header that stays put (Replay,
Export, **Make song blocks**, close); the song folds to its header meanwhile. Event times are the
music's bar.beat.step. **Start later…** sits beside **End earlier…**. **Make song blocks** turns the
take's scene and pad launches into blocks after the song (one Undo); the toast says what was rounded
and that played notes and knob moves are not carried over. An empty song with takes offers "Make
song blocks from <newest take>".

**Following the playhead.** While the song plays, the lane glides a page on when the playhead nears
its right edge. It never turns the page while the pointer moves over the lane, while a menu is open,
while a key was just pressed in the lane, or while something is carried; it waits 8 s after a scroll
or edit. **Follow** turns it off (remembered, `switchboard01.songLane`).

**Keyboard** (the blocks are one Tab stop): ←/→, Home/End; Shift extends; Alt+←/→ moves the
selection; ↓ enters the part cells (Enter switches, "." picker, Esc back); Enter, ".", the menu key
or Shift+F10 open the menu; F2 renames. Undo and Redo keep the lane's selection and focus.

**Feedback.** Edits get one short toast with Undo that names the block ("Moved Groove to position
3", "Groove: plays 3 times, 12 bars"); a gesture shows one, replacing the one before; an edit that
left no undo step of its own gets a toast without Undo. A polite status line says the same for
screen readers.

**Motion and speed.** Only transform and opacity animate (a zoom also glides widths); slides are Web
Animations started from where each block is; the lane scrolls on the compositor and never reads
layout while a pointer moves or it auto-scrolls; a drop re-renders only the blocks that changed.
Glides are timed from the current time, so a long edit never makes them finish before their first
frame. With reduced motion blocks jump to their places and the lane jumps to the playhead.

**Playing and locks.** Edits apply while the song plays or is paused; a deleted playing block sounds
to the next bar line. While a take records the lane says "The song is locked while a take records."
and refuses edits quietly.

**Simple vs Advanced.** Simple hides the "4 × 4" repeat detail and the cells' ▾; everything else
stays.

## Mix view

`[ strips per part · Reverb · Echo · Master ] [ Mastering ]` — Mastering sits beside the mixer from
1280 px wide, under it (its header in sight) below that. The strips paint first; the mastering
panel follows a frame later.

- **Part strips:** name on two lines, number and state word, a fader (every dB mark at the same
  height on all strips) with the part's meter on the fader's own scale (a level lines up with its
  mark), a
  peak-hold number (click resets; coral above −1 dBFS), **Mute**, **Solo**, **Pan**. Knobs are named
  "Drums pan", "Drums reverb"; fader undo steps read "Bass level". Double-click returns a fader to
  0 dB. The fader's value is a key for typed entry; at the bottom it reads **Silent** ("−60.0 dB,
  silent"). A touch swipe on a fader lane
  scrolls the page; only the cap or a 250 ms hold takes the finger.
- **Return strips** (between the parts and the master): **Reverb** and **Echo**, the shared returns
  every part sends to. A one-line caption, Size / Tone or Time / Feedback, **Mute** (switches the
  return off for every part, keeping its settings; refused during a take), a level fader (the
  return's Mix in dB; 0 dB is all the way up) and a meter of what the return adds to the mix.
- **Master strip:** master fader (double-click: 0 dB), meters with a −1 dBFS ceiling line, **Mute
  All**.
- **Sends & effects** row (Advanced): each part's **Reverb (Space)** and **Echo** big knobs, and its
  effect chips ("Drive (off)" when an effect does nothing). Hidden by default on windows under 1000
  px tall; the choice is remembered.
- **Channel drawer:** **Channel** in the Mixer header (Simple and Advanced), or an effect chip,
  opens the selected part's effects rack in a drawer that takes the mastering's place, the view
  staying Mix: **Add EQ**, **Add Compressor** (unavailable at the
  limit, during a take or with custom routing, the reason shown), **Open in Shape**. Opening it ends
  an A/B comparison.

**Mastering.**
- On/Off; preset chips (Clean, Gentle, Warm, Punchy, Bright, Wide, Loud, Lo-fi) with what each does;
  Advanced shows every control grouped (Clean-up, EQ, Glue, Colour, Stereo, **Loudness drive**).
- **Loudness target** (Streaming −14, Gentle −18, Loud −9) with Momentary, Short-term, Integrated
  and True peak (amber above −1.5 dBTP, where the limiter's −1 dBTP ceiling is catching peaks, which
  is normal; red above 0 dBTP).
- The readings follow what is heard now: after a change to mastering or master volume they restart,
  and until 3 s at the new setting have played the line reads "Measuring the new setting…".
- **Match target** moves Loudness drive by the difference, then, while the music plays, corrects
  again after each fresh 3 s reading until within 0.5 dB or after 3 passes ("Matching… 2/3"); at
  most 6 dB a pass; one undo step and one toast. It stops, with a message, on any change it did not
  make (a fader, Solo, Mute, Mute All, a setting), on Stop, another target, A/B or leaving the view.
- **Compare A/B** is level-matched: "Level-matched (+6.1 dB)", or "Not level-matched: play a few
  seconds first". The key keeps the width of its longer label.
- A **spectrum** of the output.

## Export dialog

- **What to export** (clips playing now, a scene, the song, the loop, a performance), **Output**
  (**Mix** or **Mix without mastering**, back to Mix each time the dialog opens), Length (bars, for
  the clips playing now or a scene), **Echo tail**, **Sample rate**, **Bit depth** (**24-bit** default; 16-bit is dithered),
  **File name** (characters file systems refuse are dropped and a hint says so). One close pattern:
  × and one primary key.
- While it renders the dialog cannot be dismissed (only **Cancel export** stops it) and shows time
  left ("about 55 s left"). Music playing on carries on.
- After a render a report line: "Integrated −17.9 LUFS · true peak −5.2 dBTP (Streaming target −14)",
  with **Match target in Mix** when more than 1 dB off (mastered output only). Changing a setting
  clears it. "Saved …" and "Export cancelled. Nothing was saved." also come as toasts when the
  dialog closes, so a toast never covers its keys.

## Project library

- **Starters** (eight, plus **Blank project**, which says "Tap a pad to make a clip, then press Edit
  steps."). Starting one keeps the open project in My projects. New names never clash ("House
  Starter 2").
- **My projects:** each row shows tempo, scenes, song length, origin and last edit; Open, Rename,
  Duplicate, **Versions…**, Delete (to Recently deleted). A line says how much browser storage is
  used.
- **Versions…** opens the project's history in its row: when each version was kept, its name or why
  ("Autosaved while editing", "Saved by you", "Before Variation"), a one-line summary, **Restore as a
  copy** and Delete. **Save version…** keeps the project now, optionally named (named versions are
  kept until deleted).
- **A tab that does not save the open project** (open in another tab): Rename is refused,
  Duplicate copies what is on screen, opening another project asks first and can keep the changes
  as a copy. A project open in another tab cannot be renamed or deleted here; the message says why.
- Import / export of the project file; Show the quick guide again; Show hints again.

## Help for newcomers

- **Quick guide** (offered once after the first Jump In; replayable from Help and the Project
  library): three coach marks — Play / Pause; the pads with Mute and Solo; Change instrument with
  the big knobs. Non-modal; it never covers the transport.
- **"Try this" hints** (`src/app/views/hints/`): a chip suggests one next action at a time and moves
  on when the real state shows it was done (never a timer or a click on the hint). Two tracks: the
  basics (tap a pad in the Bass column, Mute on Drums, drag a clip, Tone, Change instrument, a
  mastering preset, record a Performance) and the **song** (play the song, a block's repeats, a part
  switched off in a block, an export), which becomes current when Arrange opens. Any first project
  starts them; on a Blank project, steps with nothing to tap or drag are passed over.
  - Placement: after the view has painted, in idle time; never while a pointer is pressed or a
    modal is open. It prefers the view's hint home (`[data-hint-home]`), keeps clear of
    `[data-hint-avoid]` (readouts, take lists), never covers the transport, pads or keyboard, then
    avoids controls, headings and status lines. It moves only when something appears under it.
  - A step that belongs to another view collapses to one line, "Next, in Play: …" (or the pad
    tab's name), with a button that goes there.
  - Shown only while Tips are on; **Hide hints** says Help (?) shows them again.

## Cross-cutting rules

**Knobs.** Vertical drag with pointer capture (200 px = full travel), Shift = fine, double-click (or
Delete) = default, arrows / Page Up/Down / Home/End once focused, Enter or a digit opens typed
entry ("2.5k", "-6", "220 ms"). A click on a number knob's value opens the entry; option knobs are
turned, not typed. The wheel acts only once the knob has keyboard focus. A knob set by a big knob is
read-only: a teal chain mark beside the dial, a teal outer arc over the span the big knob sweeps,
"set by <big knob>" in its spoken value. Sizes sm, md, lg, xl (xl on big screens; its value key
keeps 32 px). Gate Depth reads negative ("−60.0 dB"); typed values convert back.

**Faders.** The value readout is a key for typed entry; a level set by a big knob names it
instead. Short form in narrow strips, never spilling over.

**Touch.** A finger swipe scrolls; it changes a value only when it starts on the grip (a knob's
dial, a fader's cap, at least 44 px around) or after resting still 250 ms. Lists and lanes follow
the same idea: drum grid (tap toggles, sideways drag paints), piano roll (tap; 300 ms hold edits),
song lane (300 ms hold picks up), ruler (200 ms hold sets a loop), Shape knobs (650 ms long press
opens the knob menu), sampler waveform (two-finger pinch zooms).

**Toasts.** At the top centre, just under the transport and any banner (`--transport-h`), where
every view keeps headers rather than anything played. Below an open menu; action keys hidden under
a modal dialog. When a control (a tab, key, pad, field) lies under the centred stack, it slides
into the widest clear stretch of its band nearest the centre (narrowing to fit, never under 300
px), placed again after a scroll or resize. Durations: Undid / Redid 3 s; a failed save once per
run of failures; errors stay until dismissed. Tone is shown by icon and words; coral only for
warnings and errors.

**Menus** (`Popover` in `src/app/views/ClipMenu.tsx`): below the trigger when they fit, else above,
else beside it, never on top of the key that opened them. A second click on the trigger closes the
menu. A pointer press outside a menu closes it and is consumed: nothing under it starts (except
another menu's trigger, which opens its menu). For 300 ms after opening, a click without pointer
movement chooses nothing. A row lights under the pointer only once the pointer moves. Keys are at
least 32 px; hints are Inter in `--ink-3`; shortcuts are drawn as key caps; Rename uses the pencil.
Ctrl/⌘+Z, Ctrl+Shift+Z and Ctrl+Y close the menu and undo or redo. `body[data-popover-open]` is
counted across popovers. Panels (`role="dialog"`: arpeggiator, record options, key change) are not
modal and let the computer keyboard play.

**Tooltips** open after the hover delay only when the pointer has moved over a control, or at once
when keyboard focus arrived by a navigation key (Tab, arrows, Home/End, Page Up/Down). Focus the app
moves by itself (after Delete, a dialog closing, a drop) opens nothing. With Tips off, icon-only
keys still show their name.

**Meters.** Real engine levels, drawn on canvas: amber, light amber from −12 dBFS, coral from −3
dBFS; a held peak keeps its segment. Strip meters may use the fader's taper.

**Reduced motion.** No slides or springs (blocks, pads and the lane jump to their places); loop
progress moves once a beat; the record dot is a steady coral and its ring steady; spinners are
hidden and their words ("Loading…", "Saving…") stay; the MIDI & audio light and cable-panel pulses
hold still.

**Keyboard.** Ctrl/⌘+A with focus on the page (not a field or a list that selects with it) does
nothing. Letter keys belong to the instrument; app shortcuts never take a playing key. Every
shortcut is listed in Help.

**Units** are written as spoken: ms, s, dB, Hz, %, bars in lower case; BPM in capitals.

## Words to use

| Instead of | Say |
|---|---|
| Osc 1 / Osc 2 | Tone 1 / Tone 2 |
| Env Amount, Filter Env | Filter Envelope |
| Send A / Send B (as amounts) | Reverb Amount / Echo Amount; in Mix "Reverb (Space)", "Echo" |
| Pump Rate | Pump Speed |
| Downsample | Lo-fi Rate |
| DTN, FDEC, PRATE, CHAR, BRT … | the full word |
| Delay (the effect) | Echo (the stored module type stays `delay`) |
| Drive tone | Fizz |
| Echo width | Ping-pong |
| Macros (in Simple) | Big knobs ("Macros (big knobs)" in Advanced) |
| Lock (a part) | Keep pattern / Pattern kept |
| Sound for … (dialog) | Change instrument: <part> |
| Compressor amount | Squeeze |
| Attack / Release (Simple) | Soft start / Length |
| Wave (Simple) | Character |
| Unison (Simple) | Thickness |
| Mastering loudness | Loudness drive; the goal is the Loudness target |
| Export tail | Echo tail |
| Humanize / Quantize (menus) | Loosen (humanize)… / Tighten timing… |
| Sidechain | never: Pump is a tempo-synced ducking envelope |

Other fixed words: **Starts on Play**, **Next bar · 3**, **Moves nothing here**, **Drum mix**,
"curve: gentle / even", "over Tone 60–100%", "as you had it", **Level-matched**, **Make song
blocks**, **Shape the song…**, **Play the song**, **Write a progression…**. Flats are written ♭ and
spelled by key (B♭ in G Dorian); sharps stay #.

## Quality bar for every change

- Real Chromium tests for the user outcome (`tests/browser/*`), unit tests for pure logic.
- Layout checked at 1366 × 768, 1920 × 1080 and 200 % zoom (960 × 540); nothing overflows; focus
  visible; axe-core clean on open menus and dialogs.
- Existing tests keep passing; tests that rely on renamed labels move to the new words.
