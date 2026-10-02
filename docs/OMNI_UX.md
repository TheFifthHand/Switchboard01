# Omni Song — interface direction

The product is **Omni Song** (version 2.0 of what was SWITCHBOARD / 01). This document is the
shared rulebook for its interface. When in doubt, choose the option a first-time user would
understand without reading anything. User-facing text says "Omni Song"; mention the old name only
where it helps someone coming from 1.0 (the Welcome card's one-time note, START HERE, project-file
import).

## Principles

1. **One obvious way** to do the common things: play / pause / stop, mute / solo a part, change a
   part's instrument, move or copy a clip, record, export.
2. **Simple by default, depth on request.** `uiStore.uiMode` is `'simple'` (default, remembered) or
   `'advanced'`. Simple hides detail; it never removes capability. A switch labelled
   **Simple · Advanced** sits in the transport (Advanced shows every control that exists today).
3. **Words, not abbreviations.** Knobs show full words (labels may wrap to two lines). Icons on
   primary actions always come with a text label. No jargon where a plain phrase exists
   ("Echo Amount", not "Send B").
4. **Big targets.** Primary controls at least 40 × 40 px; nothing clickable smaller than 32 × 32 px
   (the 22 × 20 px M/S buttons go away).
5. **State is visible** in text as well as colour: Playing / Paused / Stopped; a muted part is
   dimmed and says **Muted**; a soloed part says **Solo**.
6. **Direct manipulation.** Drag clips between pads, drag scene rows, drag song blocks. Every drag
   has a keyboard alternative.
7. **Everything is undoable**, and the toast says what happened, with Undo.
8. Colour meanings stay: amber = sound playing / signal, teal = selection / focus / modulation,
   coral = recording / muted / attention. Tokens from `src/ui/theme.css`.
9. **An engaged toggle keeps its on-look** under the pointer, while pressed and with keyboard focus
   (Mute All, Mute, Solo, Lock, Loop, Follow, the metronome): hover and press only change keys that
   are off. Its words read at 4.5:1 or better on every stop of its background (an engaged coral
   key uses `--coral-key` with a white legend; an engaged amber key `--amber-hi` with amber ink).
10. **State changes never move the layout.** Words that come and go (Muted / Not soloed / Solo,
    Saving… / Saved) live in boxes that keep their size, so switching Mute or Solo moves nothing.

## Transport (top bar)

Left to right, in clear groups with space between them:

| Group | Contents |
|---|---|
| Views | **Play · Shape · Arrange · Mix** (segmented, large) |
| Playback | **Play / Pause** (one button: ▶ Play when stopped or paused, ❚❚ Pause while playing), **Stop** (■), position (bar.beat), state word (Playing / Paused / Stopped / Song / Replay) |
| Tempo | Tempo; Swing (Advanced only) |
| Record | **Notes**, **Performance**, recording options |
| Output | Master volume + meter, **Mute All** |
| Right | **Simple · Advanced** switch, save status, **Undo** / **Redo**, Projects, **Export** (narrow widths keep using the More menu) |

What the strip shows by width (Simple; Advanced, whose Swing takes room, gives way earlier):
the save state, **Undo**, **Redo** and More are on it at every width from 1024 to 1920 px. Undo and
Redo show icon and word from 1600 px, the icon alone (still named "Undo …" / "Redo …", with a
tooltip naming the step) below. Stop shows its word from 1280 px; the **Simple · Advanced** switch
and Export (with its word) from 1366 px (narrower, the switch is "Show every control (Advanced)"
in More); Projects and the offline state from 1440 px; a waiting Update key from 1600 px
(narrower, a coral dot on More, whose first row is Update); the save word from 1700 px; the
project's name from 1800 px. Everything else is one press away in **More**. The strip fits one row
at every width from 1024 to 1920 px (two rows only in Advanced below 1180 px). Things that come and
go take room from the least important first: a waiting Update or a failed save from Projects and
the words of Undo and Redo; the MIDI & audio key from the offline state and, at 1366–1439 px, the
bar.beat readout. Never the save state, Undo, Redo, Export or Stop, nor the switch from 1366 px.
Unavailable, Undo and Redo stay focusable and their tip says why ("Nothing to undo yet.");
available, it names the step ("Undo: Move block").

**Play in Arrange plays the song.** In the Arrange view (with blocks in the song) the Play key
reads **Play song** (the word "song" under "Play", same key width; its name and tip say "Play
song") and Space does the same: the song from the loop when one is set, else from the first block.
A pause resumes whatever was playing. In every other view Play and Space play the pads. Stop ends
the song, and Export opens with the song chosen when it is pressed in Arrange.

**Pause semantics.** Pause holds the musical position (bar, beat and every playing clip's phase);
Play continues from exactly there, in time. Stop ends playback and returns to the start (bar 1),
leaving the pads that were playing armed as Ready. Space = Play/Pause; Shift+Space = Stop. In song
mode Pause/Play continues the song from the same block and bar. While a performance take records,
Pause is unavailable (the take format has no pause) and its tooltip says why; Stop ends the take.
Record Notes: Pause stops the recording pass (one undo step) and pauses playback.

## Play view

**Loops grid**
- Column header per part: number, name, instrument (sound) name; a **part play/stop button**
  (▶ starts the part's selected clip at the next bar / ■ stops the part at the next bar; it shows
  which); **Mute** and **Solo** as labelled toggles with icons (speaker / headphones), ≥ 32 px; a
  real level meter.
- A muted column is dimmed (pads and header) and shows **Muted**; with any solo active, non-soloed
  columns dim and show "Not soloed".
- Keyboard: **M** mutes / unmutes the selected part (not while typing). Solo has no letter key on
  purpose: S plays a note on the computer keyboard, and one key must never do two things.
- Empty pads are quiet: a faint outline and "+" only (no "Empty" text); hover/focus shows
  "Add clip". Clip pads: name large, length small, state word (Ready / Next bar / Playing /
  Stopping / Rec) as today.
- **Drag and drop**: drag a clip pad onto another pad to **move** it (onto an occupied pad: the two
  swap); hold **Ctrl** (or Alt) while dropping to **copy** (onto an occupied pad: replace, with
  Undo). 6 px movement threshold so taps still launch; valid targets highlight; Esc cancels; a drop
  across parts of a different instrument kind (drum steps ↔ melodic notes) is refused with an
  explanation. Keyboard alternative: the pad's **Move…** action, then arrow keys and Enter, Esc to
  cancel. One undo step per move/copy.
  - Feel (same motion as the song lane, `src/ui/motion.ts`): a copy of the pad lifts and follows
    the pointer exactly, with a **Move** / **Copy** label that switches live with Ctrl/Alt/⌘; its
    own pad becomes a dashed placeholder. The target previews the result: a landing outline on an
    empty pad, **Swap** (its clip leans toward the origin) or **Replace** (copy) on an occupied one,
    **Can't go here** with the reason on a refused one (the reason sits on the lifted pad, never
    over the target). The drop springs into place in 200 ms and a swapped clip glides into the old
    pad at the same time; Esc, a refused drop or a release away from the pads glide it home.
    Reduced motion: no motion, everything lands at once. A second finger is ignored mid-drag.
- Mute and Solo move nothing: the status word under a column ("Muted", "Not soloed", "Solo")
  takes turns with the meter in one box of fixed height; the part panel keeps an (empty) status
  line under the name.
- A **scene button** says how many parts it plays in the words Arrange's scene cards use
  ("4 parts", "1 part", "no clips"), its tooltip saying the rest.
- The selected clip pad's name has room beside its "⋯": a long name uses two lines ("Bell / Hook",
  never "Bell H…"); then the length moves out (it is in the pad actions below the grid).
- **Scene rows** can be reordered by dragging the scene button (or Alt+↑/↓ on it); the clips of
  every part move with the row. Song blocks keep pointing at the same scenes. While dragging, the
  row's label lifts with a faint copy of its pads and the other rows slide apart to open the slot
  where it will land; it springs in on drop.
- **Pad actions where the pad is**: the selected clip pad shows a small action bar (Edit steps ·
  Duplicate · Move… · Rename · Delete). Right-click (or the context-menu key / Shift+F10) opens the
  same actions as a menu. The "⋯" menu remains for everything else.

**Part panel (right)**
- Header: part name, **Mute**, **Solo**, **Volume** (big), Pan (Advanced).
- **Instrument card**: an icon for the instrument type, type name ("Drum kit", "Bass synth",
  "Synth", "Sampler") and sound name, and a prominent **Change instrument** button that opens the
  sound browser.
- The six macros (large, with a one-line caption under each), **Variation**, **Lock**.

**Bottom**: keyboard (collapsible), Musical Assist switch with "Key: G Dorian" summary in Simple;
the key/scale pickers and the arpeggiator strip appear in Advanced. The cables drawer appears in
Advanced only.

## Shape view

- **Simple**: the six macros large; the instrument card with Change instrument; the part's effects
  as cards (name, on/off switch, one main knob, a sentence of what it does); **Add effect** grouped
  by purpose: *Tone* (EQ, Filter) · *Dynamics* (Compressor, Gate) · *Space* (Reverb, Echo) ·
  *Movement* (Chorus, Phaser, Flanger, Auto Pan) · *Colour* (Drive, Tape, Bit Crusher) · *Stereo*
  (Stereo Width). "Show every setting (Advanced)" switches to Advanced, with a toast that offers
  "Back to Simple"; Advanced shows "Show fewer settings (Simple)".
- **Advanced**: today's full layout (macros with mappings, instrument panel, effects rack, cable
  dock) with full-word labels, clearer group headings and more breathing room.

## Mix view (new)

- One **channel strip per part**: name + instrument, vertical **fader** (dB) with the part's live
  meter, **Mute**, **Solo**, **Pan**; Advanced adds Reverb Amount, Echo Amount and the list of the
  part's effects (click → that part in Shape).
- **Master strip**: master volume fader + meter, **Mute All**.
- **Mastering**: On/Off; preset chips (Clean, Warm, Punchy, Bright, Wide, Loud …); a **loudness
  target** selector (Streaming −14 LUFS, Gentle −18, Loud −9) with live LUFS (momentary,
  short-term, integrated), true peak, and **Match target** (adjusts the Loudness control by the
  measured difference); a **spectrum** display of the output. Advanced shows every mastering
  control grouped: Clean-up (Low Cut), EQ (Lows, Mids, Highs, Air), Glue (Glue, Punch),
  Colour (Warmth), Stereo (Width, Mono Bass), Loudness. **A/B**: hold or toggle to hear the mix
  without mastering.

## Arrange (song lane)

The song is one continuous strip of **blocks** (a scene played a number of times, its *repeats*),
edge to edge, joined by a thin seam, widths proportional to their length. Code:
`src/app/views/arrange/` (SongPanel, SongLane, SongBlock, BlockMenu, LaneRuler; pure logic in
songLayout, songDrag, songModel, laneLoop; pointer gestures in laneGestures; motion constants in
laneMotion; the song helpers are commands in `src/state/commands/arrangement.ts`).

**One Play per screen.** The transport's Play (and Space) plays the song in Arrange, its Stop stops
it and its Export starts from the song; the Song header has no buttons of its own for them. It
keeps **Length**, **Echo tail** (seconds added after the last block when the song is exported, so
echoes and reverb ring out; its tooltip says so) and **Loop**. The mode box says what plays ("Now
playing: the song", "Stopped") and how to play it.

**Layout.** Part names in a column on the left (they do not scroll); to their right the lane
scrolls sideways (never the page): the ruler (a row for the loop band over the bar numbers), then
the blocks. A block is a header (name — its label, or the scene name; with a label the scene name
is shown small — then **Playing** / **Next**, length, ▶ play from here, ⋯ actions; 32 px buttons
where the block has room) over one cell per part. The header's second line keeps whole words: a
narrow block drops the repeat detail and scene first, then the length, never half a word;
**Playing** stays; the header's tooltip has it all ("Groove · 16 bars: 4 bars, 4 times"). Faint
lines mark its repeats. Part rows grow to fill the free height (18 to 32 px; the Arrange view
shares the height out, `fitLaneHeight`); what they cannot use on a tall window is lane room under
the blocks, so 1920 × 1080 has no empty band under the song. Below the lane: the **SCENES**
palette (name, bars, parts, **+**), the gesture hint (in touch words on a touch screen), and the
lane's view tools: **Follow** (follow the playhead), zoom **−** / **+** and **Fit song**. With no
takes, **Performances** is a one-line bar (a click opens how to record one), so the song gets the
room; with takes it keeps about two takes' height and the rows give way (never under 18 px).

**Scale.** When Arrange opens, the scale is the largest readable zoom step at which the whole song
(and one block width of room after it) fits; a song of 10 blocks or more that only fits at an
overview step opens there (compact blocks, below); any other song that does not fit opens
scrolling at a readable step. After that, edits never change it: a longer song scrolls, so nothing shrinks under the
pointer. The scale changes only with a window resize (fit again), **Fit song**, the zoom buttons or
Ctrl/⌘+wheel over the lane; the blocks then glide (200 ms) and the spot under the pointer (zoom) or
the left edge (fit) stays where it is. A plain wheel only ever scrolls. **Fit song** shows the
whole song at the largest step where it fits; it never makes a song that is cut off bigger: one too
long to show whole goes to the smallest step and says so ("The song is too long to show whole…").
Below 10 px per bar (overview steps, e.g. 24 blocks at 1366 px) blocks may be as narrow as 44 px and
are **compact**: the header is the name only (▶ and ⋯ appear on hover, keyboard focus and while
the menu is open; the tooltip has the length), cells show no clip names (a filled bar plays, Off
keeps its word, a layered part its icon) and a cell's hover tip says what it plays ("Bass plays
“Rolling”. Click: switch it off in this block").

**Cells.** A filled bar with the clip name = the part plays its scene's clip; striped with a layers
icon and **Lift: Bell Hook** = it plays another scene's clip there (layered in; the clip name gives
way first when space is short); **Off** in muted ink with a thin coral edge on its left = switched
off in this block (calm, so a build-up full of Off cells does not look like errors); a faint empty
outline = the scene has no clip for it (silent). Colour is never alone: there is always text or an
icon. Hovering a cell says what a click does ("Click: switch Drums off in this block").

**Colour.** Amber = the block playing now (outline, **Playing**, its cells glow) and the block
about to take over (dashed amber outline, **Next**). Teal = selection, focus, drop targets and the
loop (a block selected, the slot a scene card will open, the block it will be layered into, the
**Loop** band with its icon and word, dashed lines down the looped blocks' outer edges). Coral = Off
(a thin edge) and the take lock.

**Gestures** (with a mouse or pen a press becomes a drag after 4 px, so clicks stay clicks):
- **Touch**: a finger rests on a block or scene card for 300 ms (moving under 8 px) to pick it up:
  it darkens a little, then pops up and drags like the mouse. A finger that moves first is a swipe:
  the browser scrolls the lane (or the page) natively and nothing is edited. Held and let go in
  place, a block opens its actions (on a part cell: the part picker), as a long press does. The
  right-edge handle and the ruler take a finger at once. Once a finger has picked something up the
  lane keeps it (no scrolling, no browser menu) until it lets go.
- **Select**: click a header (teal); Shift+click a range; Ctrl/⌘+click toggles; a click on the empty
  lane or Esc clears; Ctrl+A selects all. Actions apply to the selection.
- **Move**: drag a block (header or cells). It is picked up and follows the pointer exactly; the
  others slide aside (170 ms) to open the slot where it will land; what you see is what the drop
  commits (one Undo). The target is the slot nearest the dragged block's centre, with 10 px of
  hysteresis. On release it springs into its slot at once (200 ms). Esc, a release above or below
  the lane, a cancelled pointer or a window switch put everything back with no edit. Near the lane's
  ends it scrolls, faster closer to the edge. The label under the block ("Move to position 3") stays
  inside the visible lane. While something is carried, other pointers (a second finger) are ignored.
- **Copy**: hold Ctrl, Alt or ⌘ while dragging (or press it mid-drag; release to move again). The
  dragged block shows **+ Copy**; the original stays. Ctrl+D duplicates the selection after itself.
- **Length**: drag a block's right edge. Every block shows a subtle grip just inside its right edge
  (stronger on hover, focus and selection, teal while dragged); the handle is 12 px (20 px on
  touch; col-resize cursor; a finger on the seam takes the left block's edge). Whole repeats, 1–16;
  the block is selected, widens live, the blocks after it follow, its header shows the length the
  drop gives ("12 bars") and a bubble says "3 times · 12 bars". The lane scrolls only once the
  pointer reaches the lane's visible edge (faster the further past it; the scrolled distance
  counts), never while it is inside the lane, and there is always one block width of room after the
  last block, so its edge never runs away. One Undo per drag. Keyboard: + and −; quick presses on
  the same blocks (within 1 s) are one Undo step (back where they started: none, and no Undo).
- **Split / join**: hovering a block shows scissors (24 px target) under each repeat line; a click
  splits there. The menu has **Split in half** and **Join with next** (unavailable with its reason,
  said once, when the neighbour plays something else). Neighbours with the same material show
  **Join** (24 px target) under their seam.
- **Parts**: click a cell to switch that part off in this block, click again to bring it back; a
  toast says it ("Drums off in Groove", Undo) and quick clicks on one cell are one Undo step; clicks
  that end where they started leave no step and their toast offers no Undo (it would undo an older
  edit). The change is heard at once. A cell with nothing to switch opens the **part picker**:
  "<scene>: <clip> (default)", any other scene with a clip for that part ("Lift: Hook"), or **Off in
  this block**. Right-click a cell, "." on a focused cell, or ▾ on hover (Advanced, 24 px wide)
  opens it too. **Reset all parts** is in the block menu.
- **Combine**: drag a scene card onto the middle of a block to **layer** it: it fills the parts
  that are silent in that block (parts switched Off stay off). The block is outlined, the cells that
  change read *Lift: Hook* and the header says "Layer Lift into Groove"; the card says how many parts
  it fills and what Shift would do. Hold **Shift** to **replace** instead: "Replace Groove's parts
  with Lift's" (every part Lift has a clip for). A card dropped on a block of its own scene does
  nothing and says so ("Groove already plays Groove"). On a boundary a line shows first and, after a
  short rest, the slot opens: drop to **insert** a new block. Near the window's edge the card's label
  floats on the pointer's other side. The menu has **Layer a scene in…** and **Replace parts with a
  scene…**.
- **Clipboard**: Ctrl+C / Ctrl+X / Ctrl+V. Paste goes after the block it is pasted from (after the
  selection when that block is in it), else after the selection, else at the end; right after a Cut,
  with nothing else done, it puts the blocks back where they were. Cut's Undo step is "Cut block".
  Delete or Backspace removes the selection (toast with Undo).
- **Undo / Redo** keep the lane usable from the keyboard: undoing a lane edit brings back the
  selection it had before (redo: after), and keyboard focus that was in the lane stays there, on the
  block it was on or, when that block went away (an add, duplicate or paste undone, a delete
  redone), on its nearest neighbour.
- **Rename**: F2, a double-click on the name, or **Rename…**: Enter saves, Esc cancels, empty shows
  the scene name again.
- **Ruler**: click a bar (or Enter on the focused ruler, ←/→ to choose) to play the song from there;
  the bar under the pointer is marked "Play from bar 9".
- **Loop**: the looped blocks repeat while the song plays (playback state, not saved; Play starts
  at the loop). **Loop** in the header names what it acts on ("Loop Groove (block 10)", "Loop
  blocks 2–4"; pressed while a loop is on): the blocks the user selected (a click, Shift/Ctrl+click,
  the arrow keys, Ctrl+A), else the loop that is on, else the block playing now, else the first
  block. Pressing it loops them; with a loop on and other blocks selected it **moves** the loop
  there; it turns the loop off only when the selection is the loop or nothing is selected. A
  selection an action left behind (the blocks a drop, paste, duplicate or song helper made) does
  not count. A drag across the ruler (past 4 px; a click still plays) loops every block from the
  one under the press to the one under the pointer: the band follows, snapped to block edges, and
  the loop is set on release (Esc keeps the old one). Each end of the band has a grip (an 8 px
  handle in a 24 px target, in the band's row above the bar numbers) that drags to the nearest block
  edge, never past the other end. The menu's **Loop…** list has **Loop this block** / **Loop
  selected blocks** and **Stop looping**. The status line says "Loop on: Groove to Lift (blocks
  2–4)." / "Loop off: the song plays through."; the mode box says "looping Groove to Lift" only while
  playback is inside the loop and repeats it (runtime `songLooping`), else "loop set: …". The
  session keeps the loop through edits (a looped block that a helper or a split turns into several
  stays looped as a whole, also after Undo and Redo); a loop whose blocks were deleted is ignored.
- **Song helpers** (⋯ → **Shape this block…**, each one Undo, each a set of per-part changes, so the
  cells show it and it plays at once): **Build up** splits the block into its repeats and brings
  its sounding parts in one at a time (repeat i plays the first ⌈(i+1)·k/n⌉ of its k parts), in this
  order by role: texture, pad, chords, lead, sampler (vocal), percussion, bass, drums; neighbouring
  repeats with the same parts are joined again. **Strip down** is the reverse (all parts, then they
  drop out; the last repeat keeps one). **Breakdown** switches off the block's sounding drums,
  percussion and bass. Parts silent in the block stay silent; a repeat keeps its length in bars
  (shorter material plays more times). The song never changes length: when the parts left could not
  fill their bars exactly (a 3-bar clip in 4-bar repeats) the helper is unavailable. Unavailable
  with a short reason (the full one under it): "Plays once", "One part", "No beat or bass",
  "Nothing left", "Uneven clips" ("Its clips have different lengths (3 and 4 bars), so the repeats
  would not line up and the song would change length."), "Scene missing".

**Following the playhead.** While the song plays, the lane glides a page on when the playhead nears
its right edge (the playhead then sits a fifth of the way in). It never turns the page while the
pointer moves over the lane (it waits until the pointer has rested there 2 s), while a menu is open,
while the lane has keyboard focus and a key was pressed there in the last 2 s (Space, the play key,
does not count), or while something is carried; it waits 8 s after you scroll or edit. **Follow**
turns it off (remembered in this browser, `switchboard01.songLane`). When blocks before the
playhead move, it glides (150 ms) to its new place.

**Feedback.** Edits get one short toast with Undo that names the block ("Moved Groove to position
3", "Groove: plays 3 times, 12 bars", "Block 3 is now called Drop"); a gesture shows one, replacing
the one before; an edit that left no undo step of its own gets a toast without Undo. The polite
status line says the same for screen readers.

**Keyboard** (the blocks are one Tab stop, arrow keys move between them): ←/→, Home/End; Shift
extends the selection; Alt+←/→ moves the selection one block; ↓ enters the part cells (↑/↓ rows,
←/→ the same part in the next block, Enter/Space switch, "." picker, Esc back); Enter, ".", the menu
key or Shift+F10 open the actions menu. Letter keys stay with the instrument. A polite status line
says what changed ("Moved Groove to position 3", "Groove: plays 3 times, 12 bars").

**The block menu** lists every action, the most used first: **Play song from here**, **Rename…**,
**Duplicate**, **Split in half**, **Join with next**, **One more time** / **One time fewer** (one
row); then lists that open in place with a **Back** item: **Parts in this block…** (a checkbox per
part, Reset all parts), **Scenes and clips…** (change scene, layer a scene, replace parts, edit
clips in Play), **Shape this block…** (the song helpers, each with what it does or why not),
**Loop…**, **Copy, cut, move…** (copy / cut, paste, earlier / later); and **Remove from song**. It is
about 500 px tall, so at 1366 × 768 it fits wholly below (or above) its ⋯; every list keeps the
menu's size and place (a longer list scrolls inside it), so opening one never makes it jump, and
focus moves to the list's first item.

**Motion and speed.** Only transform and opacity animate (a zoom also glides widths). Slides are
Web Animations started from where each block is on screen, so nothing forces a layout; a block
keeps its own layout (CSS containment) and the part rows of blocks out of view are not rendered;
the lane scrolls on the compositor (its background is opaque); the picked-up copy of carried blocks
floats over the lane, so auto-scrolling under a still pointer moves nothing else; the lane never
reads layout while a pointer moves or it auto-scrolls. A drop re-renders only the blocks whose
content or position changed (block views are cached by block, scenes and parts; the ruler, seams and
scene cards are separate memoised parts), marks the gesture with its own attribute (`data-carry`:
a name shared with other views' universal rules would restyle the whole lane) and gives keyboard
focus back to the landed block after the frame is drawn, so the drop forces no layout. With
*reduce motion* blocks jump to their places, the lane jumps to the playhead and a pick-up does not
pop; everything else is the same.

**Playing and locks.** Edits apply while the song plays or is paused (playback re-plans from the
block playing now), so there is no "restart" notice. Deleting the block that plays lets it sound to
the next bar line; until then the block after it says **Next** (and the mode box "Removed block ends
at the bar · next: Lift"), then it plays. While a performance take records, the song is locked: the
lane says "The song is locked while a take records." in one line right under the blocks, shows no
grab cursor or handles, and an edit or drag is refused quietly (the line nudges) with nothing half
applied.

**Simple vs Advanced.** Simple hides the "4 × 4" repeat detail and the cells' ▾; cells, drag, the
edge handle, split and join stay.

## Sound browser

Categories with icons and counts — Drums & Percussion, Bass, Keys, Pads & Strings, Leads,
Plucks & Bells, Textures & FX, Recordings — plus search, Preview, "Current" marker and a one-line
description per sound. Target: at least 12 drum kits and 60 synth presets that genuinely differ.

## Help for newcomers

- **Quick guide** (offered once, after the first Jump In; replayable from the Project library):
  three coach marks — Play / Pause; the pads with Mute and Solo; Change instrument with the big
  knobs. Non-modal: only the callout takes the pointer, and it never covers the transport.
- **"Try this" hints** (after the guide; `src/app/views/hints/`): a small chip that suggests one
  next action at a time — tap a pad in the Bass column, Mute on Drums (and back), drag a clip, turn
  Tone, Change instrument, a mastering preset in Mix, record a Performance — and moves on when the
  real state shows it was done (never on a timer or a click on the hint itself). A step done early
  is not suggested again; **Next hint** passes one over.
  - Placement: the free spot nearest the top of the workspace; never over the transport, the pads
    or the keyboard; it avoids every control, headings and status lines, then a panel header's
    words (the Song header's "Length" and "Echo tail"), and where it can other text. It tries a
    row, a stacked and finally a narrow column layout (Arrange at 1366 × 768 leaves only the strip
    beside the song's last block). It moves only when something appears under it. It is not a
    dialog, takes no focus and claims no keys.
  - A step that belongs to another view offers a button that goes there (Show the pads, Open Mix).
  - Screen readers hear each new suggestion through a polite status message.
  - Shown only while **Tips** are on; **Hide hints** closes them (remembered in localStorage,
    `omnisong.hints`); **Show hints again** in the Project library starts over and turns Tips on.
- **Welcome**: "Start with a beat. Make it yours." and **Jump In** stay the first thing on screen.

## Menus, tooltips and keys (everywhere)

- **Menus** (`Popover` in `src/app/views/ClipMenu.tsx`, used by the pad, block, scene and More
  menus): below the trigger when they fit, else above, else **beside** it — never on top of the key
  that opened them. A second click on the trigger closes the menu. For 300 ms after a menu opens, a
  pointer click that comes without the pointer moving chooses nothing (the second half of a
  double-click on "⋯" never runs an item); keys always work. A row lights up under the pointer only
  once the pointer moves over the menu, so a menu that opens under a resting pointer never shows
  two lit rows. **Ctrl/⌘+Z**, **Ctrl+Shift+Z** and **Ctrl+Y** with a menu open close it and undo
  or redo.
- **Tooltips** open after the hover delay only when the pointer has moved over a control, or at
  once for keyboard focus — never for a control that comes to lie under a resting pointer (after a
  drop, a dialog or menu closing, a view change).
- **Ctrl/⌘+A** with focus on the page (not in a text field, nor in a list that selects with it,
  such as the song lane) does nothing: it never selects the page's text.

## Words to use

| Instead of | Say |
|---|---|
| Osc 1 / Osc 2 | Tone 1 / Tone 2 |
| Env Amount, Filter Env | Filter Envelope |
| Send A / Send B (as amounts) | Reverb Amount / Echo Amount |
| Pump Rate | Pump Speed |
| Downsample | Lo-fi Rate |
| DTN, FDEC, PRATE, CHAR, BRT … | the full word |
| Delay (the effect) | Echo (the stored module type stays `delay`) |
| Macros (in Simple) | Big knobs ("Macros (big knobs)" in Advanced) |

Pads: the selected clip pad's ⋯ sits in its top-right corner; right-click, Shift+F10, the menu key
or "." on a focused pad opens its actions without playing it.

## Quality bar for every change

- Real Chromium tests for the user outcome (`tests/browser/*`), plus unit tests for pure logic.
- Layout checked at 1366 × 768, 1920 × 1080 and 200 % zoom; nothing overflows; focus visible.
- All existing tests keep passing (update ones that rely on renamed labels to the new words).
