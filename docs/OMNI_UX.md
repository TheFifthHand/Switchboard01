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
- **Scene rows** can be reordered by dragging the scene button (or Alt+↑/↓ on it); the clips of
  every part move with the row. Song blocks keep pointing at the same scenes.
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
  by purpose: *Tone* (EQ, Filter) · *Dynamics* (Compressor, Gate) · *Space* (Reverb, Delay) ·
  *Movement* (Chorus, Phaser, Flanger, Auto Pan) · *Colour* (Drive, Tape, Bit Crusher) · *Stereo*
  (Stereo Width). "Show every setting" switches to Advanced.
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

## Quality bar for every change

- Real Chromium tests for the user outcome (`tests/browser/*`), plus unit tests for pure logic.
- Layout checked at 1366 × 768, 1920 × 1080 and 200 % zoom; nothing overflows; focus visible.
- All existing tests keep passing (update ones that rely on renamed labels to the new words).
