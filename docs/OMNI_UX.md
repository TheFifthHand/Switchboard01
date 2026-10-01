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

## Transport (top bar)

Left to right, in clear groups with space between them:

| Group | Contents |
|---|---|
| Views | **Play · Shape · Arrange · Mix** (segmented, large) |
| Playback | **Play / Pause** (one button: ▶ Play when stopped or paused, ❚❚ Pause while playing), **Stop** (■), position (bar.beat), state word (Playing / Paused / Stopped / Song / Replay) |
| Tempo | Tempo; Swing (Advanced only) |
| Record | **Notes**, **Performance**, recording options |
| Output | Master volume + meter, **Mute All** |
| Right | **Simple · Advanced** switch, save status, Undo / Redo, Projects, Export (narrow widths keep using the More menu) |

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

The song is one continuous strip of **blocks** (a scene played a number of passes), edge to edge,
joined by a thin seam, widths proportional to their length. Code: `src/app/views/arrange/`
(SongPanel, SongLane, SongBlock, BlockMenu, LaneRuler; pure logic in songLayout, songDrag,
songModel, laneLoop; pointer gestures in laneGestures; motion constants in laneMotion; the song
helpers are commands in `src/state/commands/arrangement.ts`).

**Layout.** Part names in a column on the left (they do not scroll); to their right the lane
scrolls sideways (never the page): the ruler (a row for the loop band over the bar numbers), then
the blocks. A block is a header (name — its label, or the scene name; with a label the scene name
is shown small — then **Playing** / **Next**, length, ▶ play from here, ⋯ actions; 32 px buttons
where the block has room) over one cell per part. The header's second line keeps whole words: a
narrow block drops the pass detail and scene first, then the length (its tooltip has it all), never
half a word; **Playing** stays. Part rows grow with the window's height: 15 px at 768 high, up to
24 px at 1080. Faint lines mark its passes. Below the lane: the **SCENES** palette (name, bars,
parts, **+**), the gesture hint (in touch words on a touch screen), and the lane's view tools:
**Follow** (follow the playhead), zoom **−** / **+** and **Fit song**. The song header has **Loop**
(loop icon and the word; pressed while a loop is on) next to Play song and Stop.

**Scale.** When Arrange opens, the scale is the largest zoom step at which the song fits. After
that, edits never change it: a longer song scrolls, so nothing shrinks under the pointer. The
scale changes only with a window resize (fit again), **Fit song**, the zoom buttons or Ctrl/⌘+wheel
over the lane; the blocks then glide (200 ms) and the spot under the pointer (zoom) or the left
edge (fit) stays where it is. A plain wheel only ever scrolls.

**Cells.** A filled bar with the clip name = the part plays its scene's clip; striped with a layers
icon and **Lift: Bell Hook** = it plays another scene's clip there (layered in; the clip name gives
way first when space is short); coral outline with **Off** = switched off in this block; a faint
empty outline = the scene has no clip for it (silent). Colour is never alone: there is always text
or an icon. Hovering a cell says what a click does ("Click: switch Drums off in this block").

**Colour.** Amber = the block playing now (outline, **Playing**, its cells glow) and the block
about to take over (dashed amber outline, **Next**). Teal = selection, focus, drop targets and the
loop (a block selected, the slot a scene card will open, the block it will be layered into, the
**Loop** band with its icon and word, dashed lines down the looped blocks' outer edges). Coral = Off
and the take lock.

**Gestures** (with a mouse or pen a press becomes a drag after 4 px, so clicks stay clicks):
- **Touch**: a finger rests on a block or scene card for 300 ms (moving under 8 px) to lift it: it
  darkens a little, then pops up (a short lift) and drags like the mouse. A finger that moves first
  is a swipe: the browser scrolls the lane (or the page) natively and nothing is edited. Held and let
  go in place, a block opens its actions (on a part cell: the part picker), as a long press does. The
  right-edge handle and the ruler take a finger at once. Once a finger has lifted something the lane
  keeps it (no scrolling, no browser menu) until it lets go.
- **Select**: click a header (teal); Shift+click a range; Ctrl/⌘+click toggles; a click on the empty
  lane or Esc clears; Ctrl+A selects all. Actions apply to the selection.
- **Move**: drag a block (header or cells). It lifts and follows the pointer exactly; the others
  slide aside (170 ms) to open the slot where it will land; what you see is what the drop commits
  (one Undo). The target is the slot nearest the dragged block's centre, with 10 px of hysteresis.
  On release it springs into its slot at once (200 ms). Esc, a release above or below the lane, a
  cancelled pointer or a window switch put everything back with no edit. Near the lane's ends it
  scrolls, faster closer to the edge. The label under the block ("Move to position 3") stays inside
  the visible lane. While something is carried, other pointers (a second finger) are ignored.
- **Copy**: hold Ctrl, Alt or ⌘ while dragging (or press it mid-drag; release to move again). The
  dragged block shows **+ Copy**; the original stays. Ctrl+D duplicates the selection after itself.
- **Length**: drag a block's right edge (12 px handle, 20 px on touch; col-resize cursor; shown on
  hover, focus, selection and on touch; a finger on the seam takes the left block's edge). Whole
  passes, 1–16; the block is selected, widens live, the blocks after it follow, a bubble says
  "3 passes · 12 bars". Near the lane's end it scrolls, and the scrolled distance counts. One Undo
  per drag. Keyboard: + and −.
- **Split / join**: hovering a block shows scissors (24 px target) under each pass line; a click
  splits there. The menu has **Split in half** and **Join with next** (unavailable with its reason,
  said once, when the neighbour plays something else). Neighbours with the same material show
  **Join** (24 px target) under their seam.
- **Parts**: click a cell to switch that part off in this block, click again to bring it back; a
  toast says it ("Drums off in Groove", Undo) and quick clicks on one cell are one Undo step. The
  change is heard at once. A cell with nothing to switch opens the **part picker**: "<scene>: <clip>
  (default)", any other scene with a clip for that part ("Lift: Hook"), or **Off in this block**.
  Right-click a cell, "." on a focused cell, or ▾ on hover (Advanced, 24 px wide) opens it too.
  **Reset all parts** is in the block menu.
- **Combine**: drag a scene card onto the middle of a block to **layer** it: it fills the parts
  that are silent in that block (parts switched Off stay off). The block is outlined, the cells that
  change read *Lift: Hook* and the header says "Layer Lift into Groove"; the card says how many parts
  it fills and what Shift would do. Hold **Shift** to **replace** instead: "Replace Groove's parts
  with Lift's" (every part Lift has a clip for). A card dropped on a block of its own scene does
  nothing and says so ("Groove already plays Groove"). On a boundary a line shows first and, after a
  short rest, the slot opens: drop to **insert** a new block. Near the window's edge the card's label
  floats on the pointer's other side. The menu has **Layer a scene in…** and **Replace parts with a
  scene…**.
- **Clipboard**: Ctrl+C / Ctrl+X / Ctrl+V (paste after the selection, else at the end); Delete or
  Backspace removes the selection (toast with Undo).
- **Rename**: F2, a double-click on the name, or **Rename…**: Enter saves, Esc cancels, empty shows
  the scene name again.
- **Ruler**: click a bar (or Enter on the focused ruler, ←/→ to choose) to play the song from there;
  the bar under the pointer is marked.
- **Loop**: the looped blocks repeat while the song plays (playback state, not saved; Play song
  starts at the loop). **Loop** in the header loops the selected blocks (first to last), else the
  block playing now, else the first block; pressed again it plays the song through. A drag across
  the ruler (past 4 px; a click still plays) loops every block from the one under the press to the
  one under the pointer: the band follows, snapped to block edges, and the loop is set on release
  (Esc keeps the old one). Each end of the band has a grip (24 px target) that drags to the nearest
  block edge, never past the other end. The menu has **Loop this block** / **Loop selected blocks**
  and **Stop looping**. The status line says "Looping Groove to Lift (blocks 2–4)."; the mode box
  adds "looping …". A loop whose blocks were deleted is ignored.
- **Song helpers** (⋯ → **Shape this block…**, each one Undo, each a set of per-part changes, so the
  cells show it and it plays at once): **Build up** splits the block into its passes and brings its
  sounding parts in one at a time (pass i plays the first ⌈(i+1)·k/n⌉ of its k parts), in this order
  by role: texture, pad, chords, lead, sampler (vocal), percussion, bass, drums; neighbouring passes
  with the same parts are joined again. **Strip down** is the reverse (all parts, then they drop out;
  the last pass keeps one). **Breakdown** switches off the block's sounding drums, percussion and
  bass. Parts silent in the block stay silent; a pass keeps its length in bars (shorter material
  plays more passes). Unavailable with a short reason: "Plays once", "One part", "No beat or
  bass", "Nothing left", "Scene missing".

**Following the playhead.** While the song plays, the lane glides a page on when the playhead nears
its right edge (the playhead then sits a fifth of the way in). It waits 8 s after you scroll or edit,
never moves while something is carried, and **Follow** turns it off (remembered in this browser,
`switchboard01.songLane`). When blocks before the playhead move, it glides (150 ms) to its new place.

**Feedback.** Edits get one short toast with Undo that names the block ("Moved Groove to position
3", "Groove: 3 passes, 12 bars", "Block 3 is now called Drop"); a gesture shows one, replacing the
one before. The polite status line says the same for screen readers.

**Keyboard** (the blocks are one Tab stop, arrow keys move between them): ←/→, Home/End; Shift
extends the selection; Alt+←/→ moves the selection one block; ↓ enters the part cells (↑/↓ rows,
←/→ the same part in the next block, Enter/Space switch, "." picker, Esc back); Enter, ".", the menu
key or Shift+F10 open the actions menu, which lists every action (play from here, loop / stop
looping, edit clips in Play, rename, parts with a checkbox each, shape this block, change scene,
layer a scene, replace parts, passes, split, join, duplicate, copy, cut, paste, move, remove).
Opposite pairs (one more pass / one fewer, copy / cut, earlier / later) share a row so the menu
fits a 768-high screen without scrolling. Letter keys stay with the instrument. A polite status line
says what changed ("Moved Groove to position 3", "Groove: 3 passes, 12 bars").

**Motion and speed.** Only transform and opacity animate (a zoom also glides widths). Slides are
Web Animations started from where each block is on screen, so nothing forces a layout; a block
keeps its own layout (CSS containment) and the part rows of blocks out of view are not rendered;
the lane scrolls on the compositor (its background is opaque); the lifted copy of carried blocks
floats over the lane, so auto-scrolling under a still pointer moves nothing else; the lane never
reads layout while a pointer moves or it auto-scrolls. A drop re-renders only the blocks whose
content or position changed (block views are cached by block, scenes and parts; the ruler, seams and
scene cards are separate memoised parts), marks the gesture with its own attribute (`data-carry`:
a name shared with other views' universal rules would restyle the whole lane) and gives keyboard
focus back to the landed block after the frame is drawn, so the drop forces no layout. With
*reduce motion* blocks jump to their places, the lane jumps to the playhead and a lift does not
pop; everything else is the same.

**Playing and locks.** Edits apply while the song plays or is paused (playback re-plans from the
block playing now), so there is no "restart" notice. Deleting the block that plays lets it sound to
the next bar line; until then the block after it says **Next** (and the mode box "Removed block ends
at the bar · next: Lift"), then it plays. While a performance take records, the song is locked: the
lane says "The song is locked while a take records." in one line under the blocks, shows no grab
cursor or handles, and an edit or drag is refused quietly (the line nudges) with nothing half
applied.

**Simple vs Advanced.** Simple hides the "4 × 4" pass detail and the cells' ▾; cells, drag, the
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
    or the keyboard; it avoids every control and, where it can, text. It moves only when something
    appears under it. It is not a dialog, takes no focus and claims no keys.
  - A step that belongs to another view offers a button that goes there (Show the pads, Open Mix).
  - Screen readers hear each new suggestion through a polite status message.
  - Shown only while **Tips** are on; **Hide hints** closes them (remembered in localStorage,
    `omnisong.hints`); **Show hints again** in the Project library starts over and turns Tips on.
- **Welcome**: "Start with a beat. Make it yours." and **Jump In** stay the first thing on screen.

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
