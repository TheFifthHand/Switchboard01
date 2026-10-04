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
6. **Direct manipulation, with a keyboard path.** Drag clips, scene rows, loops and sections in the
   song, notes and drum steps; every drag has a keyboard alternative or a menu item.
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
- A quiet last line names the version ("Version 2.3.0", from `package.json`), so the person can see
  which version a download opened.

### Transport (top bar)

Left to right, in clear groups:

| Group | Contents |
|---|---|
| Views | **Play · Shape · Song · Mix** (segmented, large; the Song tab's view value stays `arrange`). The tab changes at once; the view renders right after. No keyboard shortcut (F6 and Ctrl/Alt+digits belong to the browser). |
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
| 1440–1599 | the offline state, "Not saved" in words; in Advanced the bar.beat readout again |
| 1600 up | Projects (the save state and More open your projects too), a waiting Update key, roomier spacing |
| 1700 up | the save word |
| 1800 up | the words of Undo and Redo, the project's name |

- The right-hand group is the same width in Simple and Advanced, so the switch never moves when
  pressed. In Advanced, Swing is a narrow field from 1366 to 1599 px, and at 1366–1439 px only the
  bar.beat readout (with its state word) gives way to it.
- Things that come and go take room from the least important first: a waiting Update or a failed
  save from Projects and the words of Undo and Redo; the MIDI & audio key from the offline state.
  Never the save state, Undo, Redo, Export or Stop, nor the switch from 1366 px.
- Unavailable, Undo and Redo stay focusable and their tip says why ("Nothing to undo yet.");
  available, they name the step ("Undo: Move Four Floor").
- **Tempo and Swing**: Enter commits and hands the keys back to the app (Space plays); dragging
  Tempo moves in whole BPM.
- The transport writes how far down it reaches on screen (the strip's visible bottom, or the bottom
  of the banners under it) to `--transport-h`, and keeps it current as the strip wraps, banners come
  and go and the page scrolls.

**Play in Song plays the song.** In the Song view (with loops in the song) the Play key reads **Play
song** (tip "Play song from bar 9", ", in the loop" when one is on) and Space does the same: from
the song cursor (the playhead when stopped), or from the loop's start when a loop is on and the
cursor lies outside it. A pause resumes whatever was playing. With an empty song, Play and Space
play the pads. In every other view they play the pads. Stopped in the Song view the position
readout shows the cursor ("9.1"); while the song plays, the song's bar and beat as heard. Export
opens with the song chosen when pressed in Song or while the song plays or is paused.

**Pause semantics.** Pause holds the musical position (bar, beat, every clip's phase); Play
continues from exactly there. Stop returns to bar 1, leaving the pads that were playing armed; a
song stops and puts its cursor back where that playback started (or where the ruler last moved
it), so Play plays the same stretch again. Space = Play/Pause; Shift+Space = Stop. While a
performance take records, Pause is unavailable and its tip says why; Stop ends the take. During
Record Notes, Pause ends the pass (one undo step).

**Busy moments.** A visible tab that falls behind skips ahead and keeps time; at most once a minute
a quiet notice says "Omni Song was busy for a moment, so a few notes were skipped to stay in time."
Only a background tab or a paused audio device stops playback; the banner says "Playback stopped
because the tab was in the background or the audio device paused. Press Play to continue." with a
**Play** key.

**Save state.** An icon in neutral ink with a label: a check (Saved), a turning arc (Saving…), a
hollow ring (Preview: a first-launch starter not stored yet), a coral warning (**Not saved**).
Pressing it opens My projects (it says so to screen readers), except while it shows an error (then
it explains and offers **Try again** and **Export project file**). A run of failed saves raises one
toast, with Export project file.

**Title and headings.** The browser tab reads "<project> — Omni Song", with ▶ while playing. Each
view has one hidden h1 naming it and the project.

### Banners under the transport

- **Two tabs:** "This project is open in another tab. Changes here are not saved." with **Take
  over** and **Open a copy**. When another tab saved the project after this one opened it: the
  project changed in another tab, with **Open the latest** and **Open a copy**.
- **Audio** (suspended, failed) and **playback stopped** (see Busy moments).

### More menu (⋯)

Order: **Update to the new version** first when one waits (a coral dot on ⋯ below 1600 px); Undo,
Redo; Show every control (Advanced), Tips; **New project…**, **Projects…**, **Export WAV…**, **MIDI &
audio…**, **Help…** (?). The offline state is its last line, plain text that cannot be focused.
Focus starts on the first item that can be used.

**New versions.** A new version opens by itself in every Omni Song page that is not in use. A page
counts as in use once a key or the pointer was pressed in it since it loaded, while it plays or is
paused, records, counts in or exports. Such a page is never reloaded under the person: it offers
**Update to the new version** (unavailable while it plays or records: "Stop playback first:
updating reloads the page."; it saves first and waits if the latest edits could not be saved), also
after another page took the update. A refresh opens a waiting version once no page is in use.

### Help

**Help** opens from ⋯ → Help… or the **?** key (not while typing). Tabs:
- **Shortcuts**, generated from the one table in `src/app/views/hints/shortcuts.ts` (the
  transport's tooltips take their key lines from it too, so they never disagree); each key is its
  own key cap, and rows of them wrap rather than run into the words.
- **Guides**: the three walkthroughs of the user guide as short steps, **Show the quick guide
  again** and **Show hints again**.
- **About**: the version (from `package.json`) and what is new. After an update a one-time toast
  offers **What's new**, which opens this tab.

### Keys and leaving

- **Ctrl/⌘+S** saves now (also from a field) and says "Saved in this browser." with Export project
  file; the browser never saves the page.
- The browser asks before leaving only while a performance or audio take records, an export
  renders, or edits could not be saved. Never merely for playing, nor for Record Notes (its notes
  are edits, which the save state covers).
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
  with no chosen slot gets one when selected: the clip it plays, else its first clip, else the first
  slot. A part never selected uses its first clip for ▶, the same slot it gets when selected.
- **Column headers:** number badge (white on `--teal-key`), part name (one size down under 110 px),
  sound name on up to two lines, full names in a tooltip while cut. The **part key** says what it
  does in words: **▶ Play** (starts the chosen clip at the next bar), **■ Stop** (stops the part at
  the next bar; dimmed while the part is stopping), **✕ Cancel** (calls off a start still waiting
  for the bar line) and, while stopped, **■ Skip** (takes an armed clip off the next Play). A part
  that plays never shows ▶, so the key never starts a playing clip again. Where a column is too
  narrow for the word, every column shows only the icon (same name and tip); in columns under
  170 px the key fills its line beside the ⋯ and the meter moves to its own line. **Mute** and
  **Solo** as labelled toggles (≥ 32 px); a real level meter.
- **Mute and Solo:** a muted column dims and says **Muted**; with any solo on, others dim and say
  **Not soloed**; those words take the meter's place in a box of fixed height. A soloed part keeps
  its meter and shows a small **Solo** tag. **M** mutes the selected part. Solo has no letter key
  (S plays a note) and no `aria-keyshortcuts`.
- **Pads:** empty pads are a quiet outline with "+" (hover/focus: Add clip). Clip pads: name large,
  length small, state word (Ready / Next bar / Playing / **Stops at bar N** / Paused / Rec; N is
  the bar number the transport shows, counted on the song's timeline while the song plays). A
  playing pad is an even amber wash. Where a pad is at least 100 px tall it shows a sketch of its
  notes. A long name fades at its end (no ellipsis) and the pad then carries the whole name as its
  title.
  - **What a click does:** on hover or keyboard focus a small dark key in the pad's bottom-right
    corner says it: **▶ Play** on a clip that waits, one that is about to stop, and the one holding
    at a pause; **■ Stop** on the playing clip. None on a clip that already starts at the next bar,
    on empty pads, while notes record into the clip, while a performance replays, while a clip is
    carried, or on touch screens. On narrow pads the state word steps out of sight while the key
    shows; nothing else in the pad moves. Each pad's tooltip and description say what a tap does
    now ("Playing. Tap to stop it at the next bar; the other parts carry on.").
  - **No accidental restarts:** tapping the playing pad queues a stop at the next bar and never
    starts it again; tapping it (or ▶ Play on it) while it is about to stop calls the stop off and it
    plays on in phase. The same holds while paused and in the song (a pad of the clip a part plays
    holds it over the song's change on that bar line).
  - Stopped: a pad that will start says **Starts on Play**, and its part key reads **■ Skip**
    ("Skip <part> when Play starts").
  - **Loop progress:** a 3 px bar along the bottom of each sounding pad and of the playing scene
    button shows its place in the loop, moving once a sixteenth (once a beat with reduced motion),
    timed from the audio clock. A queued pad counts down: "Next bar · 3".
- **Scene buttons** say how many parts they play ("4 parts", "1 part", "no clips"), in Inter, and
  are named for what a click does: **Play row <name>**; the row playing as a scene (with no change
  waiting) shows ■ and is named "Stop row <name> (playing)": a click stops its parts at the next bar
  without starting them again; paused, the row that held is "Continue row <name> (paused)" and
  carries on in time.
- **❚❚ Pause / ▶ Continue** sits in the Scenes column header, above Stop all, while the transport
  plays or is paused. It is the transport's Play / Pause command (Space too), and says why while a
  performance take records. A pad pressed while paused follows the usual rule: the clip that held
  carries on in time; another clip queues and playback carries on.
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
  slide apart, every part's clips move with it; the song is untouched (its loops name clips, not
  rows).

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
  copies of the playing clips; unavailable when nothing plays), **Add to song** (the row at the
  song's end, a loop per part with a clip there and a section named after the scene), Export as
  WAV…, **Delete scene**. Delete asks first when the song plays the scene's clips ("Groove is in the
  song: 3 loops play its clips. Deleting it takes them out of the song. Undo brings it all back.");
  those loops leave the song in the same undo step. The only scene cannot be deleted. Each edit is
  one undo step and every part stays on its clip.

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
patch left/right" arrows reach Master Out. **Open in Shape** shows the same cables in Shape, where
the panel can take the whole height.

## Bottom bar: keyboard and pads

### Keyboard strip

- **Every on-screen key is its own note**; nothing snaps. **Musical Assist** (IN KEY / CHROMATIC; it
  starts on) decides which keyboard shows, with a line under its switch saying so; the switch's tip
  says that turning Assist off gives the whole piano.
- **Scale keyboard** (Assist on, a part with notes, any scale but Chromatic; sampler parts too): only
  the notes of the project's key, as one row of equal keys with no black keys. As many as fit at
  44 px or more, up to three octaves plus the root above, never past MIDI 127; a narrow strip keeps
  two octaves while they fit at 34 px, else shows fewer keys (at least one octave). Pentatonic keys
  show 5 notes an octave, blues 6. Each key shows its note spelled by the key (B♭ in G Dorian); the
  roots show their octave ("G3", "G4") over a teal underline, with a thin divider before each root
  after the first, so a root is never shown by colour alone. The lowest key is the root at or below
  the octave's C (G3 for G Dorian; C4 in C major). The line reads "Only G Dorian notes are shown."
  The home row **A S D F G H J K L ; '** plays keys 1–11 and **Q W E R T Y U I O P [ ]** keys 12–23,
  left to right; a key shows a letter only if a computer key plays it. Folded, the computer keys
  play all three octaves.
- **Piano** (Assist off, or the Chromatic scale): two octaves; three on a wide strip (from 22 white
  keys of at least 46 px). Keys widen to fill the strip, white keys up to 60 px. Black keys are
  centred on the line between their white keys, 60 % of a white key wide and 55 % of the keys tall,
  leaving at least 34 px of every white key to press below them. C4, C5 and the root sit on a rail
  above the keys, spelled by the key. A S D F … are the white keys from C, W E T Y U O P the black
  keys. The line reads "All 12 notes, like a piano."
- Every note key is a button named by its note ("G3 (root)", "B♭3"), not a Tab stop; a click with
  no pointer press (a screen reader) plays it for 300 ms. Changing Assist, the key, the scale or the
  octave under a held key releases it at once.
- The octave reset names where it goes: **↺ G3** ("Reset octave to G3, just below C4"); on the piano,
  or when the root is C, **↺ C4**. Z and X still shift the octave.
- A MIDI keyboard still plays every key; Assist moves its notes into the key in the session. Simple
  shows the key as a summary ("Key: G Dorian"); Advanced adds the key and scale pickers and the
  arpeggiator.
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

A 4 × 4 performance layout of the kit, laid out like the computer keys (Z X C V / A S D F / Q W E R
/ 1 2 3 4, bottom row first). A struck pad (or key) plays with a velocity from where it is struck,
lights while held and selects its sound for step editing. A part that is not a kit gets a chooser of
the project's drum parts; a part that cannot be heard (muted, another part soloed) says so and
offers the fix.

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
  - drum kit: a **Drum mix** of the groups the part's clips play most, up to three (standard kits:
    Kick, Snare & clap, Hats, Percussion, Toms, Cymbals; percussion kits: Low drums, High drums,
    Shakers, Percussion; a group the part plays only one voice of takes that voice's name), each
    moving its voices together and keeping their balance (also through 0), and a tune knob for the
    first group's most played voice ("Kick tune"); locked during a take;
  - sampler: Start (keeps the length), Length, Pitch, and a small waveform.
- **Big knobs:** the six macros, large, with a caption; xl in a 3 × 2 grid where the panel has room;
  on a short window, where two rows do not fit under the instrument card, one row of six smaller
  knobs. A big knob that would be heard once a switched-off effect is on says so ("Drive is off")
  and can still be set; one that reaches nothing audible is unavailable and reads **Moves nothing
  here**. **Reset big knobs** gives each one back what the sound is designed to move (one undo
  step; positions stay).
- **Effect cards**, in signal order: name, on/off switch, one knob that always changes the sound —
  the effect's first setting, or the big knob that sets it, with a line saying which (the Drive card
  shows the Drive big knob; the Filter card shows Tone or Motion). The Filter card offers Resonance
  only while the filter is in the audible band (low-pass below 12 kHz, high-pass above 60 Hz, any
  band-pass); otherwise it says why ("Resonance is set by the Motion big knob.", "Resonance appears
  once the filter closes below 12 kHz.", "… cuts above 60 Hz."). The Compressor card's knob is
  **Squeeze** (half way = the compressor's own default, −18 dB and 4:1; full = −28 dB, 5:1, a 0.5 ms
  attack, and make-up gain of at most 8 dB, so a squeezed part stays clear of the ceiling).
  Compressor and Gate show a gain-reduction bar from the engine ("—" when there is none).
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
- **Assign to big knob:** right-click, a 650 ms long press (which ends any drag it started), or
  Shift+F10 / the menu key. A new assignment sweeps half the knob's travel around its current value,
  so the sound does not jump; a value at an end of its travel, and an option control (Filter Mode, a
  wave, on/off), keeps its value until the big knob passes its current position (an option then
  steps towards the far option). A setting already assigned offers to stop that big knob moving it.
  Refused during a take, and the rows say so.
- A **part switch ends a knob drag**: the rest of the drag stays with the part it started on (in
  Shape and in Play's part panel), still one undo step.
- Knobs that currently do nothing are dimmed with the reason in their tooltip: Unison and Vibrato
  settings until their amount is raised, FM settings at FM Amount 0, the Drive card's Character,
  Fizz and Mix while Drive is 0, an EQ band at 0 dB ("Set this band's gain first").

### Advanced

- Three columns: **Macros** (with mappings) | **Instrument** | **Effects** (chain, channel,
  returns, LFOs). Below 850 px of window height (from 1024 px wide) they become tabs, Instrument
  first. Each column keeps its scroll position per part.
- Mapping rows, each on its own line, say what they do in words: "curve: gentle" / "curve: even" (a
  toggle) and "over Tone [60]–[100] %" (fields with arrow keys and typing); each change is one undo
  step. **Reset mappings** restores the design's mappings and the LFO cable to the filter, in one
  step.
- **Cables** open as a full-height overlay over the columns with a resizable splitter. The LFO
  block's name is never cut short.
- A part switch never remounts the columns; they follow in a deferred render. Until they have
  caught up they take no clicks or keys (Tab and Escape still work) and, when that lasts over 120
  ms, show "Showing Lead…" (they are not dimmed).
- While a performance take records, the Macros column's mapping controls and Reset mappings are
  unavailable, with the reason.

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

## Song view

The **Song** tab (its view value stays `arrange`) builds the song the way GarageBand's Tracks area
does: every part has its own row, loops sit on the rows on one timeline of whole bars, and named
sections label stretches of it. Code: `src/app/views/arrange/` (see ARCHITECTURE); the rules are
`src/project/arrangement.ts`, the commands `src/state/commands/arrangement.ts`.

**The song in words.** A **loop** (a region) on a part's row plays one of that part's clips from
its first bar for its length; the clip repeats to fill it, and a loop trimmed at its left edge
starts that many bars into its clip. A part's loops never overlap, and a part with no loop at a bar
is silent there; gaps are allowed. Everything is whole bars. The song lasts to the end of its last
loop or section, at most 512 bars. **Placed wins:** a loop that is dropped, moved, stretched or
pasted carves what it lands on on its own row (the loops there are cut short, start later in
phase, split in two, or go), and a drag shows that result before the drop. Old songs of blocks
(2.1–2.2) open as loops and sections that play the same.

**Layout.**
- **Header**, one row: **Song**, the length ("32 bars · 1:02"), **Loop** (with the range when one
  is set: "Loop · Bars 9–16"), zoom **− Fit +**, **Follow**, **Loops** (shows or hides the loop
  browser). While the pads play, a chip reads "Your pads are playing · **▶ Play the song**". No
  paragraphs of help; the "Try this" chip's home is the header's free middle.
- **Timeline**: one scroller. The ruler (bar numbers from 1, spaced to stay readable at every zoom,
  and the loop range band) and the **Sections** strip stick to the top, the part headers to the
  left. Under them one row per part, in track order, all the same height (40–84 px, sharing the
  free height). The timeline runs on 16 bars past the song's end (at least the view's width), so a
  loop can be dropped or stretched after the last one.
- **Part headers** (184 px; 160 px on a narrow timeline): number, name, and the sound, or the
  part's state in words (**Muted**, **Solo**, **Not soloed**); 32 px **Mute** and **Solo** keys, the
  same commands as in Play and Mix. A muted or not-soloed row fades what its loops show (the names
  stay).
- **Loop browser** at the right, collapsible (**Loops** in the header, or its ✕). It opens by itself
  while the song is shorter than 32 bars, until the person shows or hides it (remembered).
- **Performances** under the song, one line until opened (remembered); a take's events open in a
  tall drawer and the song folds to its header (**Show the song** brings it back).

**Loops.** A rounded rectangle in its part's colour (eight hues kept clear of amber, teal and coral)
with the clip's name at the top, a picture of its notes repeated for each pass, thin notches where
the clip starts again, and a hatched band at its left edge when it starts mid-clip. Names cut off
cleanly and sit above the playhead line; on a very narrow loop the name goes first, then the
picture; the colour always stays. Each loop is a focusable button named like "Four Floor, Drums,
bars 9 to 16, plays 4 times" (", starts 2 bars into its loop" when trimmed).

**Colour.** Amber = playing: the playhead while the song plays or is paused, a 3 px amber bottom
edge on each loop under it, the "Your pads are playing" chip, a scene card being heard, and Solo
(with its word). Teal = selection and focus: the selected loops' outline, the loop range band
(dimmed while looping is off), the marquee, a carried loop's own row, the **+ Copy** badge, the
snapped-together flash. Coral = mute and attention: Mute on (with **Muted**), a loop Record Notes
writes into (a coral edge and the word **Rec**), "Not this part" and "Stays on its own part".

**Playhead and cursor.** One line through the ruler, the sections and the rows, moved each animation
frame from `songPlayheadBar()` (never React state per frame). Amber while the song plays or is
paused; neutral when stopped, where it marks the **song cursor**: where Play starts.
- A **click on the ruler** moves it there. Stopped, that sets the cursor; playing, the song
  continues from that bar at once; paused, it stays paused there and Play continues from it.
- **Play** (and Space) plays the song from the cursor; with a loop on and the cursor outside it,
  from the loop's start; from bar 1 when the cursor lies at or after the song's end. Pause keeps
  the place. **Stop** puts the cursor back where that playback started (or where the ruler last
  moved it), like GarageBand's "return to start position", so Play plays the same stretch again.
- **Enter** or **Home**, with the song focused, takes the playhead to bar 1.
- **Follow** (on until turned off; remembered): the view turns a page when the playhead reaches the
  right edge. Never during a drag, nor for 2.5 s after the person scrolled.

**Loop range** (playback state: never saved, not in undo). A drag along the ruler sets a range of
whole bars and loops it; the band's ends drag to other bar lines; a click on the band turns looping
off and on. While looping is off the range stays, dimmed (this session). **Loop** in the header
switches looping; with no range yet it first sets one: the selected loops' bars, else the section
at the playhead, else the whole song. **Loop this** (loop menu) and **Loop this section** set it
too. Set while the song plays: inside the new loop, playback plays on and repeats at its end;
outside it, playback goes to the loop's start at the next bar line. Cleared: the song plays on to
its end. Edits never move the loop.

**Mouse and pen.** Every position snaps to whole bars; every gesture is one undo step; a press
becomes a drag after 4 px; Esc, a cancelled pointer or leaving the view put everything back;
nothing is written until the drop. Near the left or right edge the view scrolls by itself.
- **Move:** drag a loop's body along its row. It steps bar by bar with an 80 ms slide (transform
  only), so it visibly clicks onto bar lines; a **Bar 9** badge says where it lands, and the loops
  it would carve are drawn exactly as the drop will leave them. **Alt** or **Ctrl** (⌘) held at the
  drop copies (**+ Copy · Bar 9**). A loop stays on its own row: more than a row's height away the
  cursor says not allowed and a coral badge says "Stays on its own part", and the drop still lands
  on its row. Several selected loops move together.
- **Right edge** (an 8 px grip, shown on hover): the length; the clip repeats to fill it ("8 bars ·
  plays 4×", "2½×").
- **Left edge:** trims or extends the start; the music stays where it was in time ("starts at bar
  5").
- **Snapped together:** when a dragged edge meets a neighbour's edge exactly, both flash a thin teal
  line (no sound).
- **Select:** a click selects; Shift- or Ctrl-click adds or removes; a drag on an empty part of a
  row draws a marquee (Shift adds); a click on empty space clears; Ctrl+A selects every loop.
- **Empty spot:** hovering shows a faint **+** at that bar; a double-click opens a picker of that
  part's loops (name, length, picture); choosing one puts it there.
- **Double-click a loop** to edit its notes: Play › Steps opens on its part and clip, with a 20 s
  toast "Editing the notes of Bounce (Bass)." and **Back to Song**.
- **Wheel:** a plain wheel or trackpad scrolls sideways (Shift+wheel too); Ctrl+wheel zooms around
  the pointer, keeping the bar under it in place.

**Touch.** A swipe scrolls the song. A finger that rests 250 ms picks up a loop, an edge or a
section, and from then on the song does not pan under it. On the ruler a swipe scrolls and a rest
then a drag sets the loop range. A tap is a click.

**Zoom.** **−** and **+** step a ladder of 4 to 128 px per bar; **Fit** shows the whole song at the
largest step that holds it. A project opens at the zoom it was left at (remembered for the 30
most recent projects in this browser), else fitted. Zooming re-renders nothing but the ruler.

**Loop menu** (right-click, the ⋯ on a hovered loop, Shift+F10 or the menu key): **Play from here**,
**Loop this**, **Duplicate** (Ctrl+D), **Split at playhead** (Ctrl+E; unavailable with "Playhead not
in this loop"), **Split here** (at the bar right-clicked, inside the loop), **Delete**, **Use another
loop ▸** (the part's other clips, from their start), **Edit notes**, **Make it 2× longer**, and **Name
these bars as a section** when no section covers the loop. With several loops selected it acts on
all of them and leaves out the one-loop items.

**Sections.** Labelled bars in the Sections strip, showing icons for their moves. A click selects
the loops that start in the section (Shift or Ctrl adds them). A double-click, F2 or Enter renames
it in place (at most 40 characters). A drag moves it with the loops that start in it, which win
where they land; Alt or Ctrl copies it (with its moves). Its edges resize the label only and stop
at the neighbouring sections. Hovering a stretch no section covers offers **+ Add section** there.
The sections are one Tab stop (← → between them). Its menu (right-click, the ⋯ at its end under
the pointer, Shift+F10):
- **Play from here**, **Loop this section**, **Rename**, **Duplicate** (its length is inserted right
  after it and filled with what plays in it, in phase), **Delete section (keep the music)**, **Delete
  section and its music** (its bars go and the gap closes).
- The **moves**, as checkboxes (checked when on): **Fade in** and **Fade out** (the whole song's
  level rises from silence, or falls to it, across the section), **Filter rise** (the melodic parts'
  Tone opens from dark to their own value across it) and **Echo throw** (Echo rises to 0.85 over
  the section's last beat and is back a bar later). The section shows their icons; playback and
  exports move the same way, on every pass of a loop.
- **Build up** (parts come in one at a time across the section: texture, pad, chords, lead,
  sampler, percussion, bass, drums, each where its clip starts), **Strip down** (every part first,
  then they drop out one at a time, the drums first) and **Breakdown** (the drums, percussion and
  bass leave the section). Only loops inside the section are cut, at clip boundaries, so everything
  stays in phase and the song keeps its length; one Undo each. When one would do nothing it is
  unavailable and says why ("No part plays here.", "Only one part plays here: there is nothing to
  bring in one at a time.", "The clips here are as long as the section, so the parts cannot come in
  one at a time: make the section longer first.").

**Loop browser.** **Scenes**: a card for each scene that has clips ("Groove · 4 bars · 4 parts", with
a dot in each part's colour) and ▶ to hear it once on the pads (the stop is queued on the audio
clock for the bar line where its pass ends, also if another view opens; a second press stops at
once; while the pads play it joins them at the next bar; while the song, a replay or a pause holds
the transport it is unavailable and says why: "Stop the song to hear a scene"). Dragged onto the
rows, a card shows a ghost of all its loops with what they would carve, and the drop puts a loop of
each part's clip at that bar, as long as the scene, plus a section named after the scene where no
section is. **Loops by part**: each part's clips as chips (name, length, picture). A chip lands only
on its own part's row, which lights teal while it is carried; the other rows say **Not this part**.
Enter on a card or chip adds it at the playhead (the keyboard way).

**Empty song.** Inside the timeline one line, "Drag a scene or a loop here — or", and one button,
**Make a song from my scenes** (every scene with clips, in order, each played twice, with a section
named after each; one Undo). With no clips at all: "Make some loops on the pads in Play, then drag
them here."

**Keys** (the loops are one Tab stop with roving focus; Space, Shift+Space and Undo / Redo are the
app's own): ← / → move the selection a bar (Shift: 4); Alt+← / → shorten or lengthen it (Shift: 4);
↑ / ↓ the loop on the part above or below; Ctrl+← / → the previous or next loop on the same part;
Delete or Backspace delete; Ctrl+C / X / V copy, cut and paste at the playhead on the same parts;
Ctrl+D duplicates after the selection; Ctrl+A selects all; Ctrl+E splits at the playhead (Ctrl+T
too, but browsers keep that for a new tab, so Help lists Ctrl+E); Enter or Home take the playhead to
bar 1; Shift+F10 or the menu key open the loop's menu; Esc clears the selection. Ctrl is ⌘ on a
Mac. Tab stops: the header's keys, the sections (one stop), the part headers' Mute and Solo (one
stop, arrows inside) and the loops (one stop). Every action is on a key or in a menu.

**Feedback.** Edits from a key or a menu get one toast with Undo that names what changed ("Deleted 3
loops", "Split Bounce at bar 9", "Duplicated Drop", "Build up: Drop"); drags say nothing (the
timeline shows the result, and Undo is one key away); key moves are spoken by a polite status line.
Undo steps name the clip or section ("Move Four Floor", "Lengthen Bounce", "Delete 3 loops", "Build
up Drop", "Delete Drop and its music"). Refusals say why in plain words.

**Playing and locks.** Every edit is heard at once, also while the song plays or is paused: a part
whose music changes at the playhead switches there, in phase, and the playhead never jumps. While
Record Notes writes into the song, the selected part's loop under the playhead is marked **Rec** and
gets the notes; where the part has no loop nothing is recorded ("Chords has no loop here in the
song, so there is nothing to record into until its next one."; the transport caption reads "No
loop here · Chords"). While a performance take records the song is locked: edits are refused with
"The song is locked while a performance records. Stop the take to change it."

**Scenes and takes into the song.** A scene's menu in Play has **Add to song** (at the song's end).
In Performances, **Put in the song** ("To song" where narrow) turns what a take launched into loops
after the song's end, each on its part's row for as long as it played, rounded to whole bars (one
Undo); played notes and knob moves stay in the take. It is unavailable, saying why, while a take
records or when the take launched nothing.

## Mix view

`[ strips per part · Reverb · Echo · Master ] [ Mastering ]` — Mastering sits beside the mixer from
1280 px wide, under it (its header in sight) below that. The strips paint first; the mastering
panel follows a frame later.

- **Part strips:** name on two lines, number and state word, a fader (every dB mark at the same
  height on all strips) with the part's meter on the fader's own scale (a level lines up with its
  mark), a peak-hold number (click resets; coral above −1 dBFS), **Mute**, **Solo**, **Pan**. Knobs
  are named "Drums pan", "Drums reverb"; fader undo steps read "Bass level". Double-click returns a
  fader to 0 dB. The fader's value is a key for typed entry; at the bottom it reads **Silent**
  ("−60.0 dB, silent"). A touch swipe on a fader lane scrolls the page; only the cap or a 250 ms
  hold takes the finger.
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
  staying Mix: **Add EQ**, **Add Compressor** (unavailable at the limit, during a take or with
  custom routing, the reason shown), **Open in Shape**. The rack is Shape's own, embedded: its undo
  steps name the part ("Drums filter cutoff", "Turn off Drums drive"; "Reverb size" for a shared
  return), and the drawer, not the rack, says why effects are locked during a take. Opening it ends
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

- **What to export** (clips playing now, a scene, the song "Song (32 bars)", the loop range "Loop
  (bars 9–16)" played once, a performance; opened in Song or while the song plays, the song is
  chosen), **Output**
  (**Mix** or **Mix without mastering**, back to Mix each time the dialog opens), Length (bars, for
  the clips playing now or a scene), **Echo tail**, **Sample rate**, **Bit depth** (**24-bit**
  default; 16-bit is dithered), **File name** (characters file systems refuse are dropped and a
  hint says so). One close pattern: × and one primary key.
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
  the big knobs. Non-modal; it never covers the transport and avoids controls, headings and
  `[data-hint-avoid]` readouts. On its Play step ("Pause it here or with the Space bar") Space plays
  and pauses even with Next focused; Enter presses Next. Outside the Play view it waits as one line
  ("This is on the Play view." with **Show the Play view**) on the view's hint home, or wherever it
  covers least. Toasts about the start (the project a starter replaced, What's new) wait until the
  guide is closed.
- **"Try this" hints** (`src/app/views/hints/`): a chip suggests one next action at a time and moves
  on when the real state shows it was done (never a timer or a click on the hint). Two tracks: the
  basics (tap a pad in the Bass column, Mute on Drums, drag a clip, Tone, Change instrument, a
  mastering preset, record a Performance) and the **song**, which becomes current when the Song view
  first opens and teaches the GarageBand way: drag a scene or a loop into the song (more loops
  filling more bars), drag a loop's right edge to make it play longer (same start, later end), drag
  a loop to another bar (same length, another start), click a bar number on the ruler (the cursor
  moved while play state stayed the same), press Play (the song plays while the Song view is open;
  "Press Play the song, at the top" while the pads play), and export. Song steps about loops wait
  for a song with loops; in another view a basics step that can be done there comes before a
  Song-only one. Any first project starts them; on a Blank project, steps with nothing to tap or
  drag are passed over.
  - Placement: after the view has painted, in idle time; never while a pointer is pressed or a
    modal is open. It prefers the view's hint home (`[data-hint-home]`). It **never** covers the
    transport, the banners under it, the pads, the keyboard, a control or a `[data-hint-avoid]`
    readout; headings and status lines are avoided wherever there is room. With no such spot it
    takes a narrower layout (down to one line) or waits off screen (its words stay with screen
    readers) and looks again after 1.5 s.
  - Toasts and tooltips pass above it: they are never a reason to move. It moves only when
    something it must not cover appears under it, and arrives with a short slide (3 px), never a
    fade.
  - A step that belongs to another view collapses to one line, "Next, in Play: …" ("Next, in
    Song: …", or the pad tab's name), with a button that goes there; its words follow the view on
    screen.
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
the Song view (a 250 ms rest picks up a loop, an edge or a section; on the ruler a rest, then a
drag, sets the loop range), Shape knobs (650 ms long press opens the knob menu), sampler waveform
(two-finger pinch zooms).

**Toasts.** At the top centre, just under the transport and any banner (`--transport-h`), where
every view keeps headers rather than anything played; the stack is at most 520 px wide. Below an
open menu; action keys hidden under a modal dialog. When a control (a tab, key, pad, field, a
field's frame, a loop in the song) lies under the centred stack, it moves to the nearest spot that covers
none, trying narrower stacks (440, then 360 px) and measuring the height each width really takes; if
no spot is clear it stays centred. Very wide elements (over 60 % of the window) do not count as
controls. It is placed each time the stack changes and again after a scroll or resize. Durations:
Undid / Redid 3 s; a failed save once per run of failures; errors stay until dismissed. Tone is
shown by icon and words; coral only for warnings and errors.

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

**Reduced motion.** No slides or springs (pads jump to their places; a dragged loop steps from bar
to bar without its slide, and the snapped-together line does not flash); loop
progress moves once a beat; the record dot is a steady coral and its ring steady; the sampler's
spinners are hidden and their words ("Loading…") stay; the save state's arc, the MIDI & audio light
and the cable-panel pulses hold still.

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

Other fixed words: **Starts on Play**, **Next bar · 3**, **Stops at bar N**, **Play row**, **Moves
nothing here**, **Drum mix**, "curve: gentle / even", "over Tone 60–100%", "as you had it",
**Level-matched**, **Play the song**, **Make a song from my scenes**, **Put in the song**, **Write a
progression…**. In the song say **loop** (not region or block) and **section**. Flats are written ♭
and spelled by key (B♭ in G Dorian); sharps stay #.

## Quality bar for every change

- Real Chromium tests for the user outcome (`tests/browser/*`), unit tests for pure logic.
- Layout checked at 1366 × 768, 1920 × 1080 and 200 % zoom (960 × 540); nothing overflows; focus
  visible; axe-core clean on open menus and dialogs.
- Existing tests keep passing; tests that rely on renamed labels move to the new words.
