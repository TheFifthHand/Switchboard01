# Omni Song — Architecture

_Formerly SWITCHBOARD / 01; identifiers that stored data depends on keep that name (see CLAUDE.md)._

A self-contained TypeScript + React + Vite web app. Every sound is synthesized or decoded on the
user's device with the Web Audio API. There is no server, no account, no telemetry and no runtime
download.

## Layers (dependency direction: top may import from below, never the reverse)

| # | Layer | Folder | Knows about |
|---|-------|--------|-------------|
| 5 | UI controls & visualization, views, session | `src/ui/`, `src/app/` | everything below |
| 6 | Persistence, imports, offline rendering | `src/persistence/`, `src/render/` | project, time, audio; persistence reads only the store's types from `src/state` and the WAV encoder from `src/render` |
| 4 | Commands, undo/redo, UI store | `src/state/` | project, music, content |
| 2 | Musical time & event scheduling | `src/time/` | project; the engine contract's types (`src/audio/contracts.ts`) |
| 3 | Audio graph, voices, modulation, effects | `src/audio/` | project (types/params/resolve), content (kit and sample catalogue) |
| 1 | Serializable, versioned project data | `src/project/`, `src/content/`, `src/music/` | each other only (pure data + pure functions) |

Rules:

- `src/project` (including the song's timeline rules, `arrangement.ts`), `src/music`,
  `src/content`, `src/time/clock.ts`, `src/time/sequencer.ts`, `src/time/moves.ts`,
  `src/time/recordWindow.ts`, `src/time/songLoop.ts`, `src/audio/spectrum.ts` and view helpers such
  as the Song view's `arrange/songLayout.ts`, `songModel.ts`, `laneSelection.ts`,
  `laneGestures.ts`, `laneLoop.ts` and `laneKeys.ts`, `steps/model.ts` and Shape's `macroAssign`,
  `cardKnob`, `squeeze`, `paramState`, `drumMix` and `bigKnobReach` are **pure TypeScript**: no
  DOM, no Web Audio, no React. They run in Node unit tests.
- `src/audio` never imports React, stores, or UI. It is driven by `setProject()` and timed calls.
- Audio nodes, class instances and functions never enter the Project. The Project is JSON.
- The **audio clock is the timing authority**. Notes, song moves and audition stops are scheduled
  with `AudioContext.currentTime` look-ahead. React renders, `requestAnimationFrame` and UI timeouts
  never time notes; display loops only read the audio clock.
- Meters, playheads, loop progress and knob drags update the DOM directly (refs, canvas, Web
  Animations, pointer events), not via React re-renders.

## Spine files (shared contracts — change only deliberately)

- `src/project/types.ts` — the Project schema (**v4**, `PROJECT_VERSION = 4`, schema id
  `switchboard01.project`). Ticks: PPQ 96, step 24, bar 384.
- `src/project/arrangement.ts` — the song timeline's rules (placing, carving, moving, resizing,
  splitting, time inserted or removed, sections, tidying). Every reader and writer of the song uses
  them.
- `src/project/params.ts` — parameter registry (ranges, defaults, units, curves, tips, `short`
  labels, `negate` for controls that read as a cut such as Gate Depth) + helpers.
- `src/project/modules.ts` — patch module catalogue: ports (audio / mod), `PATCH_LIMITS`.
- `src/project/factory.ts` — ids, default tracks (always 8), default patch, default macro maps.
- `src/project/resolve.ts` — macro resolution → effective params per module.
- `src/content/catalog.ts` — ids and names of kits, synth presets, built-in samples.
- `src/audio/contracts.ts` — `InstrumentEngine`, `VoiceHandle`, `AudioEngineApi`, meters, ceiling.
- `src/time/contracts.ts` — `SeqEvent`, play modes, launch state, `ClipPhase`; the timing model.
- `src/ui/theme.css` — design tokens, colour semantics, type roles (`.t-eyebrow`, `.t-label`,
  `.t-panel-title`, `.t-caption`, `.t-value`, `.t-readout`), knob and key sizes, and the live layout
  measures `--transport-h` and `--keyboard-h`.

## Project model summary

- Always 8 tracks (`t1`..`t8`) with roles Drums, Percussion, Bass, Chords, Lead, Pad, Texture, Sampler.
  Tracks can be renamed and their instrument changed; the count is fixed.
- **Scenes:** a project has `MIN_SCENES` (1) to `MAX_SCENES` (8) scenes; new projects have 4. Every
  track has exactly one clip slot per scene (`clips.length === scenes.length`; read the count with
  `sceneCount(p)`; `SCENE_ROWS` is deprecated). **Scene = clip row.** Launching scene *i* launches
  slot *i* on every track and stops tracks whose slot *i* is empty. Scene length = longest clip in
  the row.
- **Clips** are 1 to `MAX_CLIP_BARS` (8) bars (`ClipBars` 1–8; menus offer `CLIP_BAR_CHOICES`
  1, 2, 3, 4, 8). A sampler clip may carry its own recording, `Clip.sample: {id, start, end,
  rootNote}` (a take or an import placed in its own clip); the part's other sampler settings (mode,
  pitch, tempo sync, fades, level) still apply. On other instrument kinds it is kept but ignored.
- Instruments: `drums` (16-voice kit), `bass` (mono synth), `poly` (poly synth), `sampler`.
  Params are flat numeric maps interpreted through the registry.
- Patch: modules + connections. Default per-track chain
  `inst → drive → filter → channel → master`, channel `sendA → fx:reverb`, `sendB → fx:delay`,
  `lfo → filter.cutoff (mod)`. Shared `fx:reverb`, `fx:delay`, protected `master`. The effects
  rack, the Mix Channel drawer and the cable panel all edit this same patch. `PATCH_LIMITS`: 8
  insert effects per part (counting its default Drive and Filter), 3 extra LFOs per part, 131
  modules, 160 cables.
- Macros (Tone, Space, Echo, Motion, Drive, Pump) are stored per track as values (0..1) plus a
  mapping (`macroMap`) of `{module, param, min, max, curve, macroFrom, macroTo}` targets. A mapped
  param is controlled by its macro. `Track.macroHome` (v3, optional) holds the positions the sound
  or starter was designed with: where double-click returns a big knob (`macroHomeFor`). Pump is a
  tempo-synchronized ducking envelope — not an audio sidechain.
- **Arrangement (v4): the song is an absolute timeline of whole bars**, `{ regions, sections,
  tailSeconds }`, like GarageBand's Tracks area (see Song commands and Song playback below).
  - `SongRegion {id, trackId, clipId, start, bars, offset}`: a loop on a part's row. It plays its
    clip (by id, one of its own part's clips) from bar `start` for `bars` bars, the clip repeating
    to fill it; `offset` (0 ≤ offset < the clip's bars) is how far into the clip it begins. A part's
    regions never overlap; silence between them is allowed.
  - `SongSection {id, name, start, bars, moves?}`: a named label over a bar range (Intro, Drop …,
    at most `MAX_SECTION_NAME` 40 characters). Sections never overlap and own no regions; moving or
    copying "a section" moves the regions that start inside it.
  - Song moves live on sections (`SongMove {id, kind, parts?}`, at most one of each kind):
    `fadeIn`, `fadeOut` (the song gain across the section), `filterRise` (Tone of the listed parts,
    default every melodic part, from 0.15 to its own value), `echoThrow` (Echo to 0.85 over the
    section's last beat, back a bar later).
  - Song length (`songBars`) = the end of the last region or section, at most `MAX_SONG_BARS`
    (512). `tailSeconds` (0–10) is the export tail's default.
- Performances: a snapshot of the musical state + timestamped events (launch, scene, notes, macro,
  param, mute, tempo, swing, master). During a take the store is locked to an allow-list: only the
  edits the take records (knob/param moves, macros, mutes, tempo, swing, master volume) go through;
  routing, clips/steps, sound choices, drum voices, arp, macro assignments, scene edits and every
  `notes:`, `project:` and `variation:` command are refused with an explanation, because replay
  uses the take's snapshot and could not reproduce them. A replayed noteOn pairs with the next
  noteOff of the same track and key. A take replays from its own snapshot (its scenes, clips and
  key), whatever the project has become.
  - Undo/redo during a take go through only when the step changes nothing but recordable values
    (`ProjectStore.setLock(reason, allows, paths)`); the resulting value changes are recorded as take
    events, so replay matches what was heard.
  - What already sounds when a take starts (held keys, a latched arpeggio) is written at the take's
    first tick (latched-only notes use keys `take:<trackId>:<pitch>`). Known limit: a latched pattern
    already running restarts from its first step in the replay.
  - Mute All ends a take (the notice says so), and a take cannot start while Mute All is on.
  - Editor previews and auditions (`NoteSource 'preview'`) play the exact pitch, skip Musical Assist
    and the arpeggiator, are never recorded, and are blocked while a take records or replays.
  - Chord pads use `NoteSource 'chord'`: they skip Musical Assist (the chord is already in the key,
    or, in pentatonic and blues keys, in its parent scale) but are recorded and arpeggiated.
  - MIDI pitch bend is not recorded into performance takes: a replay plays its notes unbent.
- Musical Assist snaps melodic notes into the key in the session (`snapToScale` in `noteOn`); drums,
  sampler parts (recordings keep their pitch), chord pads and previews play as pressed. Since 2.3
  the on-screen keyboard under Assist offers only in-key notes (the scale keyboard), so the snap
  matters for MIDI keyboards; no two on-screen keys play the same note.
- Schema migration (`src/project/migrate.ts`, one step per version, on a copy; validation runs
  after): v1→v2 adds neutral mastering; **v2→v3 changes nothing** (every v3 addition is optional or
  a wider range; the bump makes older builds refuse v3 projects with "This project was made with a
  newer version of Omni Song." instead of silently dropping data); **v3→v4 turns the song's blocks
  into regions and sections** (`songFromBlocks`) that play exactly as before:
  - blocks are laid out in order from bar 0; a block whose scene is missing is skipped (no gap);
  - a block lasts (the longest clip it actually played, at least 1 bar; per-part changes and
    layered clips count) × repeats (1–16);
  - each block becomes a section (id = the block's id; named by its label, else its scene) carrying
    its moves;
  - each part that played something in it (the scene row's clip, a layered scene's clip; nothing
    when switched off or empty) gets a region `<block id>:<part id>` over the whole block from the
    clip's start;
  - touching regions of a part that play on in phase are then joined (`mergeTouching`).
  It is deterministic; a song longer than 512 bars is cut there by validation, which says so. The
  starters' `[row, repeats]` songs are laid out by the same function (`content/starters/dsl.ts`).
- Validation (`validate.ts`) checks and repairs the song in plain words ("Fixed 2 overlapping loops
  in the song."): regions with unique ids on an existing part and one of its clips, in whole bars
  inside the song, offsets inside the clip, never overlapping (`tidyRegions`), in time order;
  sections named, in whole bars, never overlapping (`tidySections`), moves of known kinds, one per
  kind, on parts that exist. Limits: `maxRegions` 4000, `maxSections` 256. A valid song comes back
  exactly as it went in.

## State, commands, undo

- `ProjectStore` (src/state/) holds the current Project immutably. Every edit is a named command
  run through immer `produceWithPatches`; history stores patches + inverse patches.
- **Labels and display words.** A step's label names the *kind* of edit with fixed words and an
  area prefix (`"track:Mute part"`, `"notes:Move notes"`): the edit lock and the take's allow-list
  match on it, so it never carries data. The words Undo and Redo show come from `ApplyOptions.display`
  ("Mute Lead", "Bass level", "Move 2 notes"), else from the label without its prefix
  (`displayLabel`). Inside an undo group the group's label names the step; a gesture keeps the words
  of its first edit. Views can pass their own words (`{display}`) to `setMacro`, `setModuleParam`
  and `setBypass` (and the session's `setMacro` / `setModuleParam`).
- Continuous gestures (knob drags, a paint drag, one sound-browser session, the passes of one Match
  press) pass a gesture id so they are one undo step. A gesture that comes back to where it started
  leaves no step; `apply()` then returns `noStep: true`, so a message about it offers no Undo.
- `lastChange()` says what the latest change was (an edit, an undo or a redo of which step, or a
  change outside the history), for listeners that keep state per step (versions before bulk edits,
  each part's selected clip across scene-row edits).
- An undo group (`beginGroup(label)` / `endGroup()`) merges every recorded edit into one step; a
  Record Notes pass uses it, and so do Reset big knobs and a diagonal in-key note drag (skipped
  while Record Notes has its own group open). `endGroup()` drops a group step whose edits ended
  where it began and returns `{step}`.
- Commands return `{changed, reason?, message?}`; invalid input changes nothing. `session.accepted(r)`
  shows refusals as a toast.
- UI-only state (selected part and slot per part, view, pad mode, octaves, tips, Steps grid and
  Follow, chord pads, keyboard folded per view) lives in `uiStore`, never in the Project. Some of it
  is remembered in `localStorage`. The Song view keeps its own (`arrange/laneStore.ts`,
  `laneSettings.ts`; see Views). `uiStore.laneView` / `setLaneView` are left over from 2.2 and
  unused.

### Note, clip and music commands (round 4)

- `src/state/commands/notes.ts`: `moveNotes` (across the whole clip; nudge `NUDGE_TICKS` = 4),
  `deleteNotes`, `setNotesVelocity`, `transposeNotes` (semitones or `inScale` steps), `duplicateNotes`,
  `copyNotes` (pure) / `pasteNotes`, `quantizeClip` (grid, strength, ends), `humanizeClip` (seeded
  with `subSeed(project.seed, 'humanize:<clipId>:<seed>')` and stored in the notes, so live play and
  exports match), `paintSteps` (a gesture id joins a drag; painting on an empty slot creates a clip
  that grows with the drag), `fillSound`, `shiftSound`, `clearNotesForPitch`, `transposeClipInScale`,
  `createProgressionClip`. `GRID_TICKS` is keyed by the uiStore step grid.
- Collisions: `moveNotes` and `transposeNotes` default to `collide: 'refuse'` (a move never deletes a
  note by accident; arrow keys stop at the first neighbour); views pass `'replace'` for an aimed
  drop. `pasteNotes` and `duplicateNotes` default to `'replace'`. All return `replaced`, and one
  Undo brings replaced notes back. A move that is shortened says which limit stopped it.
- Every note command checks the slot against the part (`isSlot`) and is refused during a take.
- `transposeSong` (project.ts): maps scale degrees to the new key, takes the shortest way, folds
  notes that would leave the range back an octave (counted as `clamped`), never moves drums, moves
  sampler parts only when listed, leaves performance takes in their key (`takesKept`), one undo step
  ("Move the song to A Dorian").
- `applyVariation(…, intensity?, {from?})`: `INTENSITY = {subtle: 0.35, bold: 0.85}`; with `from`
  (the view's session-kept original) each press varies the original. One press stays strictly within
  ±30 % of the notes it varies (`VARIATION_MAX_COUNT_CHANGE`; clips of 3 notes or fewer keep their
  count). Variation originals live in the Play view for the session and are never saved.
- Scenes: `insertScene`, `duplicateScene`, `deleteScene(store, row)` (its clips' song regions
  leave in the same step; the result's `regions` counts them, and `sceneUse(p, id).regions` is what
  the delete confirmation says first), `captureScene`. Clips: lengths 1–8, `repeatClipToBars`,
  `setClipNotes`. The song commands are below.
- Sound: `snapshotTrackSound` / `restoreTrackSound` (instrument, big knobs and maps, effect
  settings), `copyEffectChain` / `pasteEffectChain`, `macroReach` (what a big knob can still move),
  clip-recording commands (`setClipSampleRegion`, `importRecordingAsClip`).
- `src/music/scales.ts`: `noteName(midi, key?)` spells by key (flats as ♭, sharps as ASCII #; the
  leading tone of minor-type keys as a raised seventh; the blues ♭5 as a flat; only single
  accidentals), `keyLabel`, `keyRootName`, `keyShortName` (at most 11 characters, "G Dor"),
  `moveToKey`, `keyInterval`, `stepsPerOctave`, `relativeMajorRoot`. `src/music/chords.ts`:
  `chordAt`, `chordName` (each degree's own letter in seven-note keys), `PROGRESSIONS` (8),
  `resolveProgression` (anchored on the key's root or its relative major/minor; pentatonic, blues
  and chromatic keys use their parent scale), `voiceLeadLoop` (triads move at most 7 semitones per
  change).

### Song commands (`src/state/commands/arrangement.ts`, schema v4)

The rules are pure (`src/project/arrangement.ts`): **placed wins** — `placeRegions` lets a placed,
moved, resized or pasted region carve its part's regions where it lands (`carve`: cut short, start
later in phase, split in two, or removed); `moveRegions`, `resizeRegions` ('end' changes the length,
the clip repeating to fill it; 'start' keeps the music in time, changing `offset`), `splitRegions`,
`duplicateRegions` (right after the selection), `insertTime` / `removeTime` (a region crossing the
point is split, or joined again when its pieces play on as one, `mergeTouching(at)`), `sceneRegions`
(a scene row as regions, as long as the row), `placeSection`, `sectionRegions` (the regions that
start inside a section), `tidyRegions` / `tidySections`. They return new arrays, so the Song view's
drag preview, the commands, playback and export use one set of rules: what the lane draws is what
plays.

Commands, each one undo step labelled `arrange:<Words>` with `display` words that name the clip,
part or section ("Move Four Floor", "Lengthen Bounce", "Delete 3 loops", "Build up Drop"); a
`gesture` id merges a drag into one step; bad input is refused with nothing changed and no step,
and an edit that changes nothing leaves none. Ids come from `uid('rg')` and `uid('sec')`. Results
(`SongEditResult`) carry `ids` (what was made, moved or copied), `trimmed` and `removed`.
- Loops: `addRegions(drafts)`, `addClipToSong(trackId, clipId, start, bars?)`,
  `addSceneToSong(row, start, {bars?, section?})` (also a section named after the scene where none
  overlaps), `fillSongFromScenes()` (an empty song only: every scene row with clips, in order, each
  twice its length, with a section each: "Make a song from my scenes"), `moveRegions(ids, delta,
  {copy?, gesture?})`, `resizeRegions(ids, edge, delta, gesture?)`, `splitRegions(ids, atBar)`,
  `removeRegions(ids, {cut?})`, `duplicateRegions(ids)`, `copyRegions(p, ids)` (pure, a
  `RegionClipboard`) / `pasteRegions(clip, atBar)` (a clip deleted since is skipped, one moved to
  another part follows it), `setRegionClip(id, clipId)` (same part only).
- Time: `insertBars(at, bars)`, `removeBars(from, to)`.
- Sections: `addSection(start, bars, name?)` ("Section N"), `renameSection`,
  `resizeSection(id, edge, delta)` (the label only; it stops at its neighbours), `moveSection(id,
  delta, {copy?})` (with the regions that start in it, which win where they land),
  `duplicateSection(id)` (its length inserted after it and filled with what plays in it, in phase),
  `removeSection(id, {withMusic?})` (with music: `removeTime` over its bars),
  `toggleSectionMove(id, kind, parts?)`, `setSectionMoves`.
- Helpers: `shapeSection(id, 'build' | 'strip' | 'breakdown')` cuts only regions inside the section,
  at clip boundaries, so everything stays in phase and the song keeps its length (build: part *i*
  of *k*, in `BUILD_ORDER` texture, pad, chords, lead, sampler, percussion, bass, drums, comes in
  near `from + i·L/k` where its clip starts; strip: the reverse; breakdown: `BREAKDOWN_ROLES` drums,
  percussion, bass leave). `shapeProblem(p, id, kind)` says in plain words why one would do nothing.
  `addIntro()` / `addEnding()` (4–8 bars from the first / last section's clips, built up / stripped
  down; the ending carries a fade-out and lifts a 0 s tail to `ENDING_TAIL_SECONDS` = 2) and
  `setTailSeconds` exist and are tested, but the 2.3 Song view offers no control for them (nor for
  `insertBars` / `removeBars` directly).
- Takes: `takeToRegions(p, takeId)` (pure: each launch plays until the part's next launch or stop,
  in whole bars from the take's start; what played when the take began carries on in its phase;
  clips found by id; `rounded`, `missing`) and `songFromTake(takeId, {at?})` (placed from the song's
  end by default).
- **The song follows the clips** (`common.ts`: every command's `run()` calls `keepSongWithClips`, in
  the same undo step): deleting a clip, clearing a part or deleting a scene row takes their regions
  out; a new clip length keeps the regions' bars and wraps their offsets; a clip moved to another
  part takes its regions to that row (they win there; a swap swaps them); a clip pasted over one the
  song plays takes over its regions; copies never add regions. Scene rows moved, inserted or copied
  change nothing (regions name clips by id).

## Audio engine

`AudioEngine` (src/audio/engine.ts) implements `AudioEngineApi`:

- One engine per context. The live app creates it once after the Jump In / Play gesture; the
  offline renderer creates a fresh one on an `OfflineAudioContext`. Building is quick (House: about
  125 ms live and about 50 ms for an export engine in the round-4 measurement): it uses no
  IIRFilterNode, and a rebuild reuses the reverb rooms it already made.
- `setProject()` diffs by stable id: creates/destroys module nodes, adds/removes connections with
  ~20 ms gain ramps (offline too), applies resolved params with smoothing, swaps instrument engines
  when the instrument kind changes.
- `prepareInstruments({incremental})` renders drum voices ahead in idle-time slices of at most 8 ms
  (`src/audio/idle.ts`), so neither Jump In nor a kit change holds the main thread; the parts in use
  are prepared first. `preloadSamples(ids)` loads recordings through the sample provider
  (`SampleBank.setLoader`: the session reads a recording from browser storage and decodes it, never
  twice). A sampler note whose recording is not loaded yet is skipped and counted
  (`EngineStats.skippedSampleNotes`), never thrown.
- Every connection is `source output → connection GainNode → target input`. Mod inputs are GainNodes
  internally wired to the right AudioParams with the port's range.
- **Output chain:** sum → master volume → **song gain** (song automation; unity and
  bit-transparent unless used) → **mastering chain** (`Project.mastering`; neutral or off is
  bit-identical to no chain) → Mute All gain → **true-peak look-ahead limiter** (AudioWorklet,
  ceiling −1 dBTP: windowed-sinc interpolation finds peaks between samples, live and offline) →
  final safety clipper (WaveShaper bounded to −1 dBFS) → destination.
- **Latency:** the limiter's 5 ms look-ahead plus 16 frames for its true-peak interpolators, plus
  128 frames for a Drive in a part's path (its oversampled shaper; dry and wet stay aligned, so it
  is the same at every setting). `engineLatencyFrames(sr)` is the default patch's figure (383 frames
  at 48 kHz); `outputLatencyFrames()` gives the current project's: the limiter plus the least module
  latency on any audible part's way to the master. Identical live and in exports.
- **Returns:** a Reverb or Echo fed only by channel sends (`setSendReturn`) has no dry path: its
  output is the wet sound × Mix, so Mix is the return level and turning it down never makes the mix
  louder. Used as an insert, it still passes the dry sound at 1 − Mix. A return switched off
  (Bypass) that only sends feed is silenced with a glide; one with a direct input passes that on.
- **Level-matched effects:** Drive keeps its loudness (an RMS trim per character plus a block-wise
  level match against the part's own sound, ±6 dB); at Drive 0 with nothing patched into its
  Amount the driven path is disconnected and costs nothing. Chorus, Phaser and Flanger mix dry and
  wet with equal power (Flanger adds a slow 2 s level match, ±6 dB). The low-pass filter trims its
  resonance only where the peak is audible (below about 8 kHz full, above about 16 kHz none).
- **Song automation** (optional API): `scheduleSongGain(value, time, rampEndTime?)` and
  `scheduleMacroRamp(trackId, macro, from, to, t0, t1)`. Linear maps ramp exactly; other curves move
  linearly between points at most 10 ms apart; a target not at the ramp's start value rejoins
  within 20 ms. A ramp owns its params until it ends. `cancelScheduledAutomation(t)` holds what a
  ramp has reached. **Stop ends song automation**: modules' `endAutomation(time)` hooks drop it and
  the project's values are applied again (15 ms smoothing); song gain holds after Stop or Pause until
  the next start or a live note.
- **Meters** (`readMeters(out)`): per-part and master peak/RMS; the loudness worklet (ITU-R BS.1770
  / EBU R128: momentary, short-term, gated integrated, 4× true peak), plus `preMasteringShortTerm`
  while mastering is on; `returns` (what Reverb and Echo add); `moduleReductionDb` (every Compressor
  and Gate, about 30 times a second; a Gate reads 0 below −90 dBFS input); the Glue's reduction;
  `compareTrimDb`. `readSpectrum()`: log-spaced bands integrated over the bins' power density (an
  8192-point analysis, 16384 below 160 Hz), so pink noise reads flat.
- **A/B:** `setMasteringBypass(on, {matchLevels})` plays the un-mastered sound at the mastered
  sound's short-term loudness (measured once from the last 3 s, ±12 dB, the trim in place as the
  comparison fades in). Listening only; exports are unaffected.
- Insert effects: filter, drive, delay, reverb, chorus, phaser, bit crusher, EQ, compressor, gate,
  auto pan, stereo width, flanger, tape. Worklets load once per context from Blob URLs. Mute All
  clears every tail sample-accurately. Modules can implement `endAutomation`, `setModulated` (patched
  inputs) and `setSendReturn`.
- `setPitchBend(trackId, cents, time)` bends a part's playing and future notes (MIDI pitch wheel).
- Tempo-synced modules (delay, LFO, pump) follow `tempoChanged()`; LFO phase aligns on
  `transportStarted()`.
- Drum kits define their own choke groups. Sampler One-shot plays the whole trimmed region; Loop
  bakes an end-of-loop crossfade into the lead-in. A note carrying `sample` plays that recording
  from its own root and region.
- Deterministic: noise, impulse responses, random LFO steps, drum synthesis, tape hiss, synth drift
  and the 16-bit dither are seeded. Renders of the same project match to within float rounding.

## Scheduling

- `Sequencer` (src/time/sequencer.ts) is a pure class: transport anchor, swing warp, launcher state
  machine (queue at next bar, one clip per track), scenes (1–8 rows), arrangement (song mode, song
  moves), performance replay, arpeggiator, beat events. `process(untilTime)` returns `SeqEvent[]`
  (including `songGain` and `macroRamp` events, and notes with a clip's `sample`).
- Notes already handed to the engine can be shortened by a **cut** (`Sequencer.takeCuts()`): a clip
  switch, a mono overlap or a tempo increase releases the voice early. Every driver applies cuts.
- `RealtimeTransport` (src/time/transport.ts) drives it from a Web Worker ticker (25 ms) with a
  **0.3 s look-ahead** (`DEFAULT_LOOKAHEAD`), dispatches events to the engine, keeps handles of
  voices that have not started so `invalidate()` can cancel and regenerate them, and emits UI
  events when their audio time arrives.
- **Brace.** When heavy main-thread work is coming or has just happened, the transport schedules
  1 s ahead for 3 s (`BRACE_AHEAD`, `BRACE_MS`): on audio start, opening a project, a gap between
  ticks over 60 ms, an animation frame over 80 ms, and any change of view, pad mode,
  Simple/Advanced or the cables panel (the session watches `uiStore`). The brace is separate from
  an export's `holdAhead` and takes the larger margin.
- **Skip vs stop.** A note whose start passed more than 10 ms ago (`LATE_TOLERANCE`) is dropped,
  never played late; note-offs still run. A visible tab whose audio runs and falls behind **skips**
  to the present (`Sequencer.skipTo`: launches, song passes and loop phases carry on in time); a
  `'skipped'` event fires only when notes were dropped, a performance take carries on, and the
  session shows `SKIP_NOTICE` at most once a minute. Only a **hidden tab or a suspended audio
  device** stops playback (`STALL_THRESHOLD` 0.25 s), coherently and without a backlog;
  `STALL_MESSAGE` says "… Press Play to continue." and the banner's Play calls
  `session.resumeAfterStall()`, which restarts what was playing (the song from the bar where the
  music stopped, into the loop when that bar lies before the loop's end; the `stalled` event carries
  `songBar`; a replay from its start, else the live pads).
- **Sound edits while playing:** `transport.revoice(trackIds)` re-voices a part's not-yet-started
  notes after an instrument, drum voice, kit, preset, sampler or recording change (a kit change
  renders the new voices in short tasks first); pump, mappings and the metronome `invalidate()`.
  Drags reschedule at most every 80 ms (the first at once, the last always applied).
- **Audible position:** `getAudiblePosition()`, `audibleTick()`, `audibleTime()`, `outputDelay()`;
  `outputDelaySeconds(ctx, engine)` (device output latency + base latency + the engine's own) is
  shared by Record Notes, audio input and every playhead. `clipPhase(trackId, out?)` and
  `queuedAt(trackId)` (over `Sequencer.clipPhaseAt` / `queuedAtTick`) read what is heard without
  allocating; the Loops progress bars, the Steps playhead and the queued countdown use them.
- **Record window** (`src/time/recordWindow.ts`): Record Notes keeps notes played up to an eighth
  note early (`RECORD_EARLY_TICKS` = 48) and puts them on the downbeat, keeping their held length;
  `runtime.recordStartsAtTick` is set while waiting. **In the song**, Record Notes writes each note
  into the clip of the selected part's region under the playhead, in phase with that region, and
  follows the song from region to region (`runtime.recordTarget` follows; nothing is launched or
  reselected). Where the part has no region nothing is recorded, `runtime.recordTargetAudible` turns
  false and one notice says so; starting with no region under the playhead does not start ("Nothing
  to record into: …").
- **Song moves** (`src/time/moves.ts`): fades become song-gain ramps, Filter rise and Echo throw
  become Tone and Echo macro ramps, all as sequencer events. Seek, pause/resume, loops, edits and
  regenerations resume mid-ramp at the value reached there; offline renders get the same moves, so
  exports match live playback. A start fades in from silence with `scheduleSongGain(0, t)` then a
  ramp from `t`; the transport sets a fade's start value 5 ms before its time (`MOVE_GLIDE`).
- Export while playing: while an export prepares and renders, live playback is scheduled 2 s ahead
  (`RealtimeTransport.holdAhead`). Edits, launches, Pause and Stop still act at once.
- Pause / Resume: Pause holds the musical position (the tick, each playing clip's phase, queued
  launches, the song's passes, the replay position), releases held notes and stops scheduling;
  Resume plays the paused tick `START_OFFSET` from now with the same state, so playback continues in
  time with no backlog. `RealtimeTransport.cue(opts)` holds paused at a new start position (a ruler
  click while the song is paused). Stop returns to bar 1 with the previously playing clips armed
  (in song mode the session puts the song cursor back where that playback started). Pause is
  unavailable while a performance take records; during Record Notes it ends the pass first.
- `RealtimeTransport` emits `arpNote` when the audio clock reaches an arpeggiator note that was not
  cancelled; Record Notes records those (at their real grid tick and gate) on arp parts.
- Scene rows inserted, copied or deleted remap the playing and queued slots (`relocateSlots`) and
  each part's chosen slot (as a scene move does); undo and redo bring the chosen slots back. Song
  transitions name their clip by id and resolve its slot when applied, so the song needs no remap.
- **Launching the clip a part plays** keeps it playing in phase (`Sequencer.request`): a stop or
  switch queued for the part is called off (also one the look-ahead had already applied), "Play row"
  on a row that partly plays leaves what already plays it alone, and in the song a pad of the
  playing clip holds it over the song's change on that bar line. The runtime then shows no queued
  change.

## Song playback

The song plays its regions on an **absolute song timeline** (schema v4); the model for this section
is the timing notes in `src/time/contracts.ts` and the header of `src/time/sequencer.ts`.

- **Passes.** The transport tick keeps running; `SongPass {at, from, to}` maps it onto the song: a
  pass plays song ticks [from, to) from transport tick `at` on. The first pass starts at the start
  bar (`PlayMode {kind: 'song', fromBar}`; transport tick = song tick there). Without a loop it runs
  to the song's end, which sends 'end'. With a loop, a new pass of [loop.fromBar, loop.toBar)
  follows each time the playhead reaches the loop's end, so beats, swing and the arpeggiator run on
  through every seam with nothing doubled or restarted. Passes are laid lazily (`extendSong`, a bar
  ahead of the generation cursor) and old ones pruned (`pruneSong`), so a long loop never grows the
  plan.
- **Regions → transitions.** Each part's regions become 'song' transitions in its launcher: at a
  region's (mapped) start the part plays the region's clip with a loop start chosen so the clip's
  phase is `offset` at `start` (`Transition.loopStart`, one canonical value per phase); at its end it
  stops, unless the part's next region starts there. Two touching regions that carry on in the
  same clip play as one (a held note rings on); one that starts its clip again relaunches it. A part
  switches clips exactly on the region boundary: the old note is cut there and two clips never
  sound at once. A part with no region is silent. Transitions carry the clip **id**; the slot is
  resolved when applied, so scene reorders and clip moves need no song bookkeeping. Song changes
  sort before a pad launch at the same tick (the pad wins): a pad tapped during the song wins until
  the song next changes that part.
- **Live edits** (`Session.followSongEdits`): when a project change touches what the song plays
  (`songPlayChanged(p, prev)`, compared structurally: a region's part, clip, place, length or
  offset, a clip's slot or length, or the song's length; renames and sounds do not count), the
  session calls `transport.replanSong()` → `Sequencer.replanSong(now + 10 ms)` in the edit's own
  task, undo and redo included. The **edit
  point** is the playhead at that time (the pause point while paused), rounded up to a whole tick;
  nothing before it changes and the playhead never moves (time is absolute). What each part played
  just before the edit point is compared with the new regions there: a part whose music changed
  switches at the edit point, in phase with its region (notes sounding across it end there; a part
  joining mid-loop does not play what it missed); everything later follows the new regions; an edit
  that changes nothing heard (a split under the playhead, an edit behind it) changes nothing and
  regenerates nothing. Two edits at one pause point both apply. A song cut shorter than the
  playhead ends at the next bar line, once. Replan plus regeneration on a 4000-region song: about
  1.7 ms median (engine slice report). Section moves edited while the song plays are re-sent from
  now by a regeneration (`movesChanged` in the session), not a replan.
- **Song loop** (`runtime.songLoop: SongLoop {fromBar, toBar}`, whole bars, half-open; set only
  through `Session.setSongLoop`, which returns false for a bad range; runtime only, never saved, not
  in undo, never moved by edits; `cleanSongLoop` in `src/time/songLoop.ts`).
  `Sequencer.setSongLoop(loop, time)`: with the playhead inside the new loop the pass playing runs
  on to the loop's end, then loops; outside it, playback continues at the loop's start at the next
  bar line (at once when nothing of that bar has sounded yet: right after Play, or paused on a bar
  line); cleared, the pass playing runs on to the song's end. A start before the loop's end plays
  into the loop; a start after it plays to the song's end. Replay and the live pads ignore it.
  `runtime.songLooping` (`Sequencer.songLoopingAt`) is true while the playhead is inside the loop
  and will repeat it (also paused there); the session syncs it on start, pause, resume, loop
  changes, edits and every beat (so it can be up to a beat late after a jump).
- **Song moves** come from sections (`src/time/moves.ts`, `sectionMoveSegments` /
  `timelineSegments` over `SectionSpan`s mapped through the passes): a section's moves act wherever
  a pass plays it (every pass of a loop). Targets rest (song gain 1, a big knob at the part's own
  value) where a pass or section starts and where a section ends with more song after it; a pass
  that starts inside a fade begins at the value the fade has there; a fade-out that ends the song
  stays faded through the export tail.
- **Session API** (the Song view codes against it):
  - `playSong({fromBar?})` plays from `fromBar`, else from `runtime.songCursor` (from the loop's
    start when a loop is on and the cursor lies outside it; from bar 0 when the cursor is at or past
    the end outside a loop: `songPlayFrom`); restarts there when the song already plays; an empty
    song says "The song is empty. Drag a scene or a loop onto its rows first."
  - `seekSong(bar)`: playing, a restart at that bar (the usual 50 ms start offset, so every bar line
    stays on the transport's beat grid); paused, it stays paused there (`transport.cue`); stopped,
    it sets the cursor. A seek also becomes where Stop returns to.
  - `setSongCursor(bar)` (whole bars, ≥ 0) and `setSongLoop(loop | null)`.
  - `togglePlay({song})` (Space and the transport's Play; `song` in the Song view): Pause while
    playing; a pause continues whatever was paused (pads, song or replay); otherwise it plays the
    song, or the pads when the song is empty.
  - **Stop in song mode puts the cursor back where that playback started** (or the last seek);
    Pause keeps the position.
  - Runtime: `songCursor`, `songLoop`, `songLooping` (the 2.2 `songBlock` / `songBlockId` are gone).
- **`src/app/songPlayback.ts`** reads the song's position for views: `songPlayheadBar()` (the
  fractional song bar heard now, output delay taken off, while the song plays or is paused; null
  otherwise; cheap enough for every animation frame), `songBarAt(tick)` (the song bar a transport
  tick plays: the Loops pads count "Stops at bar N" with it) and `useSongPlaying()` (song mode
  playing or paused). The transport readout shows the song's bar and beat heard, or, stopped in the
  Song view, the cursor.
- An 'end' is always handed out where the driver gets it: never before the resume point or before
  the floor of a rewind, so the transport stops even if the end came to lie behind music already
  handed out.
- A tempo change never takes effect before the start or resume point (the playhead waits there).

## Offline rendering and export

- `renderOffline()` (src/render/offline.ts) drives the same Sequencer + AudioEngine on an
  `OfflineAudioContext`, in chunks via `suspend()` for progress and cancellation. At the end of the
  music it calls `transportStopped()` like the live transport, then renders the tail. Sources:
  `{kind: 'song'}` (bar 1 to the song's end), `{kind: 'songRange', fromBar, toBar}` (the loop range
  once), a performance, a scene or the launcher state; plus the tail. The song plays through the
  same sequencer code path as live playback (same regions, passes and moves), so an export equals
  playback. The Export dialog offers "Song (32 bars)" and "Loop (bars 9–16)", and chooses the song
  when it is opened in the Song view or while the song plays or is paused.
- **Aligned exports** (`RenderRequest.align`, which session exports always set): the start offset
  and the engine's output latency are cut from the start and rendered extra at the end, so musical
  time 0 is sample 0 and the file is exactly the music plus the tail (`RenderPlan.fileSeconds`); a
  one-bar loop repeats cleanly elsewhere.
- **Mastering option** (`ExportOptions.mastering`, default true): false renders with the project's
  mastering off; the limiter and its ceiling stay. The project is not changed.
- **Report:** `session.renderWavWithReport(opts)` returns the WAV and an `ExportReport`
  (integrated loudness, true peak, sample peak, length) measured on the rendered audio
  (`measureExport`); `renderWav` is unchanged.
- WAV: stereo PCM at 44.1 or 48 kHz, 24-bit by default; 16-bit files get seeded TPDF dither (the
  same audio always gives the same bytes); 24-bit is rounded without dither.

## Persistence

- IndexedDB database `switchboard01`, **version 2**: `projects` (Project JSON), `samples` (original
  file bytes + metadata), `meta` (last project id, `dbId`, the database's identity), `trash`
  (recoverable deletes, carrying their versions), `versions` (summaries: what lists show) and
  `versionData` (the saved project of each version, read only to restore one or to collect
  garbage). A version-1 database upgrades in place.
- **One tab per project** (`tabLock.ts`): a tab writes a project only while it holds its lock —
  Web Locks `switchboard01.project.<id>` ({ifAvailable}; Take over uses {steal}), or without Web
  Locks a `BroadcastChannel('switchboard01')` heartbeat with take-over epochs. Another tab is
  read-only for that project (`AutosaveState.readonly: 'other-tab'`). Library writes check the lock
  too (`StorageErrorKind 'open-elsewhere'`: a project open elsewhere cannot be renamed or deleted).
  A save refused because another tab saved after this tab loaded the project
  (`storedIsNewer` / `setEditorBase`, kind `'conflict'`) makes the tab read-only `'conflict'`.
- **Autosave** (`autosave.ts`): debounced, coalesced, never loses the latest state. Status adds
  `readonly`, `failures` (failed writes in a row) and `firstFailureAt`, so the UI tells once per run
  of failures. `takeOver()`, `retry()`, `snapshotBefore(project, reason)`.
- **Rescue copy** (`rescue.ts`): when the page is hidden or unloaded with edits pending, the newest
  pending project is written synchronously to localStorage (`switchboard01.rescue`, at most ~2 MB,
  tagged with the tab and `dbId`). `library.openLast` / `openProject` take it back when it is newer
  than the stored project (`RESCUE_WARNING` "Recovered your last edits."); it is cleared once the
  project saves. If storage is full the project still opens with the edits, flagged unsaved.
- **Versions** (`versions.ts`): kept automatically after about ten minutes of active editing, before
  bulk edits (the session calls `snapshotBefore` before Variation, Clear, Delete clip or scene,
  Replace, Build up / Strip down / Breakdown, Make a song from my scenes, Make song from a take,
  Remove bars, Delete a section and its music, a kit, sound or recording change, an import or Move
  the song (`BULK_EDIT`, matched on the undo words): at most once per kind of edit every 2
  minutes in the session, every 3 minutes per project in persistence, never for undo or redo) and on
  request (Save version…, optionally named). **Thinning** runs before a new version is written:
  named versions stay until deleted; unnamed ones keep everything from the last hour, then the
  newest of each hour for a day, then the newest of each day, at most 30 per project (10 when
  storage is full), the hourly and daily ones first, so a burst never pushes older history out.
  After a quota error versions pause for 10 minutes; saving the project itself is never held up.
  Restoring always makes a new project.
- Garbage collection keeps every recording a project, a version or a clip (`Clip.sample`) uses.
- Names are picked inside the write transaction, so two projects stored at the same moment get
  different names ("House Starter", "House Starter 2").
- `library.createFromStarter` returns `{project, replaced}`; the session reports the replaced
  project through `runtime.starterReplaced` so the shell can offer to open it again.
- Project bundle: a zip (`.omnisong.zip`; `.sb01.zip` still imports) with `project.json` +
  `samples/<id>.<ext>`; validated and migrated on import. Bundles are the portable backup; browser
  storage is working storage.
- Lists read the song from its loops and sections (`summary.ts` `projectShape`): the length is
  `songBars`; a version's line reads "4 sections · 2:19", "Song · 0:31" (no sections) or "No song
  yet". `ProjectSummary.blockCount` keeps its name and now holds the number of loops.

## App layer (`src/app/`)

- `session.ts` owns the store, autosaver, audio context, engine, sequencer and transport. Besides
  the recordable actions it provides `brace()`, `readMetersShared()` (one engine read per animation
  frame, keyed on the frame's time, shared by every meter and readout), `renderWavWithReport`,
  `resumeAfterStall`, and the import path (`importSample` stores the file and makes a new clip that
  plays it, selected; the message says when the part's sampler settings change how it sounds). It
  loads clip recordings ahead on load and whenever new ones appear. After Jump In the view paints for
  a frame before the engine is built; the parts in use warm up first.
- `selection.ts`: one selected clip per part (see OMNI_UX). Registered on first import (PlayView
  imports it; the app loads PlayView eagerly).
- `runtime.ts`: what the audio side is doing now (`playing`, `paused`, `mode`, `tracks`,
  `recording`, `recordTarget`, `recordStartsAtTick`, `recordTargetAudible`, `songCursor`,
  `songLoop`, `songLooping`, `starterReplaced`, `stalled`, …), `offlineStore` and `notify()`.
- `songPlayback.ts`: the song's position for views (see Song playback).
- `pwa.ts` + `public/sw-takeover.js`: **a new version opens by itself unless a page is in use.**
  The build (`vite.config.ts`, generateSW with `registerType: 'prompt'`, unchanged sw.js name,
  manifest, start_url/scope and no manifest id) imports `sw-takeover.js?v=<hash>` into the
  generated service worker and keeps it out of the precache; a small plugin writes `<meta
  name="omni-song-version" content="X.Y.Z">` into index.html.
  - Installing over an earlier version, the worker asks every window `"omni:busy?"` over a
    MessageChannel (700 ms). `pwa.ts` answers from load on, before boot finishes: "busy" once a key
    or the pointer was pressed in the page, while it plays or is paused, records, counts in or
    exports (`session.exporting`); else "idle". No window busy: `skipWaiting()`. A page that loads
    while a version waits posts `OMNI_TAKE_OVER_IF_IDLE`, which runs the same check.
  - Activating, it lists the windows the earlier version controlled, `clients.claim()`s, and asks
    them again (2 s). A window that does not answer (2.2 and older cannot) is navigated to its own
    URL; the navigation is deliberately not awaited inside `waitUntil` (the page's request waits for
    the activation, so awaiting it deadlocks).
  - In the page, `controllerchange` over an earlier controller reloads when this page asked for the
    update or is not in use; otherwise `offlineStore` becomes `'update-ready'` and the More menu
    offers Update (`OfflineStatus`: unavailable while playing or recording, saves first). The
    registration's `onNeedReload` does nothing, so a busy page is never reloaded by itself. The
    workbox `SKIP_WAITING` path is unchanged.
- `App.tsx`: banners (audio, stall, another tab), the shell's own toasts (start toasts wait until
  the quick guide is closed), global keys (?, Ctrl+S), drop-to-import, the leave warning (not for
  Record Notes) and the document title. The title and the leave guard are leaf components with
  narrow selectors, so Play / Pause and saves do not re-render the app. The view tab changes at once
  and the view follows in a deferred render (`useDeferredValue`). `session.exportsFinished` (a store
  counting finished exports) is what the song hints read. `__APP_VERSION__` comes from a Vite define
  (package.json).

## UI kit (`src/ui/`)

- **Meters** draw into one canvas each and share one animation-frame loop
  (`components/meterScheduler.ts`): reads at most ~70 times a second, draws at most 30, only what
  changed. The loop **sleeps** once every meter shows its floor and nothing called `meterWake()` for
  500 ms; it wakes on `meterWake()` (playback start, previews, notes, audio input), on any key or
  pointer press, on the tab becoming visible, and from a slow 125 ms probe while asleep. A stopped,
  silent app runs no meter frames. Mix readouts and the spectrum ride on the same loop (`useMixTask`).
  `useRafLoop(cb, active, {fps})` caps other loops.
- **Toast placement** (`components/Toast.tsx` and its CSS): top centre under `--transport-h`
  (written by the TransportBar on `document.documentElement`: the visible bottom of the strip, or
  of the banners under it, kept current on wrap, banners and scroll); below an open menu
  (`body[data-popover-open]`, counted by Popover); action keys hidden under `body[data-modal-open]`
  (set by Dialog). `placeClearOfControls`: when a control (a button, tab, field, a field's frame,
  a loop in the Song view, which is `role="button"`; the `[data-block-id]` selector is a 2.2
  leftover; nothing wider than 60 % of the window) lies under the centred
  stack (at most 520 px wide), it hit-tests a coarse grid of the band once and takes the nearest
  spot that covers none, trying narrower stacks (440, then 360 px) and measuring the height each
  width really takes; with none it stays centred. Placed each time the stack changes and again
  after a scroll or resize. `--keyboard-h` (written by the KeyboardStrip; 0 when folded or not
  docked) remains for other overlays.
- **Touch rule** (`components/touchDrag.ts`): `TOUCH_HOLD_MS` 250, `TOUCH_SLOP_PX` 8,
  `TOUCH_HIT_PX` 44 for Knob and Fader.
- Knob sizes sm/md/lg/xl (`--knob-dial-*`), `macroRange`, clickable value key (`--knob-value-h`
  sets its line height; style it there, not through the slider). Fader `formatShort`, typed entry
  through `valueInput.ts` (honours `ParamSpec.negate`). NumberField `blurOnCommit`, `dragStep`. Pad
  `sketch` (ClipSketch), `--loop-progress` and `action` (`{icon, text}`: the ▶ Play / ■ Stop key in
  its corner on hover and focus; `null` keeps the same layout with nothing to say). ClipSketch
  `span` / `offset` draw a clip repeated over a longer stretch from a point inside it (a song
  loop). MiniKeyboard `noteNames` ('legend' | 'above' | 'none'), `fit`, `variant: 'kit'` with
  `kitLayout`, and `notes` (a scale keyboard: one equal key per listed note, its own hit test,
  releasing a held key when the notes change). Every note key is `role="button"` named by its note
  (not a Tab stop); a click with no pointer press plays it for 300 ms. Black keys are centred on
  the line between their white keys (60 % wide, `BLACK_KEY_HEIGHT` 0.55). Type tokens `--fs-*`,
  `--fw-*`, `--type-*` and the role classes; `--teal-key` for white-on-teal badges.

## Views (`src/app/views/`)

- **Play:** `LoopsGrid` reads `clipPhase`, `queuedAt` and `audibleTick` a few times a second
  (8 checks a second, `ProgressAnimator`): each progress bar is one looping Web Animation of its
  fill, stepped per sixteenth (per beat with reduced motion) and re-anchored only when it drifts
  more than 30 ms from the audio clock, so nothing is written per frame; the beat countdown
  re-renders a queued pad only when its number changes. Column meters read `readMetersShared`.
  `Popover` (in ClipMenu) counts `data-popover-open` and consumes an outside press (pointer only).
- **Keyboard and pads:** `KeyboardStrip` writes `--keyboard-h` and folds per view
  (`keyboardCollapsedFor`); one kit key table shared with the Drums pads (`kitKeyLabels`). With
  Musical Assist on, a melodic or sampler part and a scale other than Chromatic it shows the **scale
  keyboard**: `scaleKeyboardNotes(root, scale, from, count)` (`src/music/scales.ts`, from
  `rootAtOrBelow`) gives as many in-key notes as fit at 44 px (two octaves down to 34 px on a narrow
  strip, at least one octave, at most three plus the root, never past MIDI 127), and a local
  `useScaleComputerKeys` hook (`SCALE_KEYS`: A–' keys 1–11, Q–] keys 12–23, by physical position;
  Z / X octaves; the same safety rules as `useComputerKeyboard`) plays them; it releases a held key
  when its layout changes. Off, or Chromatic: the piano. MIDI still plays every key, moved into the
  key by the session under Assist. Chord
  pads count shared notes so a note sounds once until every pad holding it is released (the counts
  reset when the app releases every note). `ProgressionDialog` previews by running
  `createProgressionClip` on a scratch `ProjectStore`.
- **Steps:** session-only `noteSelection` / `noteClipboard` stores (`steps/shared.ts`); the roll draws
  a drag from pure previews (`steps/model.ts`, tested against `moveNotes` / `transposeNotes`) and
  commits on the drop; a diagonal in-key drag joins `moveNotes` and `transposeNotes` in one undo
  group. `usePlayhead(…, {cellTicks, follow})` lights the heard step from `clipPhase` +
  `audibleTick`.
- **Shape:** pure, unit-tested helpers `macroAssign` (a new assignment never jumps the sound; an
  option control or a value at an end of its travel waits for the big knob to pass), `cardKnob`,
  `squeeze`, `paramState`, `drumMix` (the Drum mix's groups from the voices a part plays) and
  `bigKnobReach` (heard, waiting for a switched-off effect, or moving nothing); `knobExtras` adds
  Alt+double-click and the knob menu with native listeners; `partSwitch.endKnobDrags` ends every
  knob drag (as a cancelled pointer) when the selected part changes, before React renders the new
  part (Shape and the Play part panel); `GrMeter` reads `moduleReductionDb` through the shared meter
  loop; `shapeLayout` keeps the Advanced tab and each column's scroll per part; columns are memoised
  and follow a part switch in a deferred render, swallowing input until they catch up (never
  remounted, made inert or dimmed; "Showing <part>…" after 120 ms); `resetBigKnobs` is one undo
  group. `EffectsRack({embedded})` is the rack outside Shape (Mix's Channel drawer): undo steps name
  the part through `PartWordsContext`, and the host shows the take-lock note.
- **Sound browser and sampler:** a browse takes `snapshotTrackSound` and makes every choice (and
  Cancel) with one gesture id, so back-to-back choices are one step and Cancel
  (`restoreTrackSound`) leaves none; outside edits stay their own steps. `importState` checks an
  import before decoding. `samplerTarget.ts` decides whether the editor edits the clip's or the
  part's recording; `sampleDetail.ts` decodes close-up waveforms; `clipAudition.ts` plays a clip's
  own recording through `engine.scheduleNote` via the part's chain and the limiter (the session's
  preview cannot pass a recording yet).
- **Song** (`arrange/`; the view value stays `'arrange'`): `ArrangeView` lays out `SongHeader`
  (length, Loop, zoom, Follow, Loops), `SongTimeline` and `LoopBrowser` above `PerformancesPanel`.
  - Pure rules (Node-tested): `songLayout` (bars ↔ pixels, snapping, the 4–128 px-per-bar zoom
    ladder and Fit, ruler marks, Follow's page turn, row heights 40–84 px, the 8 px edge grip),
    `songModel` (part hues away from amber, teal and coral; words: lengths, "plays 4×", badges,
    region and section names, scene cards and loop chips), `laneSelection` (click, Shift/Ctrl,
    marquee, keyboard neighbours), `laneGestures` (drag previews worked out with
    `project/arrangement.ts` on a draft: move, copy, resize, browser drops, section moves, the loop
    range, the snapped-together touches), `laneLoop` (the Loop key's range), `laneKeys` (key → action).
  - `LaneController` (a plain class) owns every pointer gesture on the timeline and drags in from
    the loop browser: it reads geometry cached when the gesture began (no layout reads while the
    pointer moves), publishes to the drag store only when the shown result changes (a new bar, the
    copy key, leaving the row), writes nothing to the project until the drop (one command, one undo
    step), cancels on Esc, and follows the touch rule (a 250 ms rest picks up; a non-passive
    touchmove guard on the scroller keeps the page from panning under a carried loop).
  - Small stores outside React (`laneStore`: selection, the loop range shown on the ruler, the drag
    view, the carried item, zoom, hover) are subscribed per region, so selecting one region
    re-renders that one and a drag re-renders only `DragOverlay`, which hides the regions a drop
    would change with one `<style>` rule by id and draws them as they would end up. Geometry is CSS
    custom properties (`--ppb`, `--row-h`, and `--s`, `--b`, `--cb`, `--o` per region), so a zoom
    re-renders nothing but the ruler. The lane's slice measured 60 fps (p95 16.8 ms, 0 frames over
    20 ms) dragging with 150 regions on screen at 1366 × 768, and 0 DOM mutations to other regions.
  - The playhead line is moved from `songPlayheadBar()` in a frame loop that also marks the regions
    under it (`data-playing`) and the one Record Notes writes into (`data-recording`) with attribute
    writes, never React state per frame, and turns Follow's page.
  - `songActions` runs each command through the session (selection of what it made, toasts for key
    and menu edits, the loop clipboard, the take lock); `laneSettings` remembers Follow, the
    browser and Performances panels and each project's zoom (`localStorage`
    `switchboard01.songLane`, the 30 most recent projects); `SongMenus` holds the loop and section
    menus and the loop picker.
  - `LoopBrowser` audition: the stop is queued for the pass's end bar on the audio clock, by a
    module-level watcher that outlives the view.
- **Mix:** `loudnessMatch.ts` (fresh readings and iterating Match; watches from app load),
  `mixMeters` reads `readMetersShared`; the mastering panel mounts in a transition after the strips'
  first frame. Export uses `renderWavWithReport`.
- **Hints:** placed after the view has painted, in idle time, never while a pointer is pressed or a
  modal is open, with a coarse-then-fine search and cached sizes; prefer `[data-hint-home]`, avoid
  `[data-hint-avoid]`. `placeOk` refuses any spot over a hard obstacle (the transport and the
  banners, the pads, the keyboard, controls, `[data-hint-avoid]`); toasts and tooltips pass above
  and are ignored; with no acceptable spot the chip waits off screen and tries again after 1.5 s.
  Steps keep their words and detection together in `hints/steps.ts`; Help's shortcuts and
  walkthroughs are pure data in `hints/shortcuts.ts` and `hints/guides.ts`.

## Release package and launchers

- `npm run package` builds, then `scripts/package-release.mjs` writes
  `release/omni-song-<version>.zip`: `app/` (the production build), `Start Omni Song.bat`,
  `START HERE.txt`, `launcher/`, `ASSETS.md` and `source/`.
- The launchers (`launcher/serve.mjs`; `launcher/serve.ps1` behind the .bat, same wording) serve only
  the app folder, on 127.0.0.1 only, and stay on port 4173, because the browser keeps projects and
  the offline copy per address.
- **Version check.** When Omni Song already answers on the port, the version its page names (the
  `omni-song-version` meta; a page from 2.2 or earlier names none and counts as "an older version";
  SWITCHBOARD / 01 is told apart by its title) decides (`decide`): the same version is opened and
  the launcher exits; any other version is named (`waitMessage`: "Another copy of Omni Song
  (version 2.2.0) is running in another window … This is version 2.3.0. Close the other small black
  Omni Song window …") and the launcher checks the port about once a second, then starts this
  version on the same port once that copy has stopped ("The other copy has stopped."). If this
  same version starts meanwhile (a second double-click), the waiting launcher opens it and exits;
  Ctrl+C stops a waiting launcher. The Windows title names the version ("Omni Song 2.3.0", "…
  - waiting"). Another program on the port: it says what that means for saved projects, then uses
  the next free port (or stops, with `--strict-port`). `serve.mjs` exports its checks (`appIn`,
  `versionIn`, `pageInfo`, `decide`, `waitMessage`) and starts nothing when imported.

## Testing

- `npm test` — Vitest (Node): timing math, sequencer events (clip phase, skips, record window, song
  moves, 8 scenes, song regions, loops and live edits with seeded fuzzes), graph validation,
  commands/undo (note, scene, song, sound commands; a song fuzz of random edits with undo and redo),
  music theory (spelling, chords, progressions, key moves, scale keyboards), variation bounds, WAV
  encoding and dither, validation/migration (v1→v2→v3→v4, every 2.2 starter song checked bar by
  bar), persistence (locks, rescue, versions, read-only), bundles, launchers, DSP sanity, spectrum
  bands, view logic (`r4-*-model`, `r4-shape-logic`, `r4-shell-steps`, `r5-lane-*`).
- `npm run test:browser` — Vitest in real Chromium: components and the whole app with real CDP
  mouse, keyboard and touch input at 1366 × 768, 1920 × 1080 and 960 × 540 at 2×; offline renders
  through the real engine (latency, true peak, returns, ramps, levels).
- `npm run test:e2e` — Playwright + Chromium against the production build: journeys, persistence
  across profiles and reloads, two tabs, offline mode, a new version taking over
  (`r5-update-takeover`: idle pages, a busy page, refresh, pages that cannot answer, and the real
  2.2.0 release when `release/omni-song-2.2.0.zip` is present), stalls under CPU slowdown, resource
  stability, keyboard-only use and axe-core.
- The PowerShell launcher test (`r5-update-launcher-ps1`) runs only where PowerShell is found
  (`pwsh` on PATH, or `OMNI_PWSH=<path>`); elsewhere it reports its tests as skipped.
- `window.__switchboard` exposes test hooks (render fixtures, engine stats, `audiblePosition`) in
  every build; it contains no network or storage side effects of its own.
