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

- `src/project`, `src/music`, `src/content`, `src/time/clock.ts`, `src/time/sequencer.ts`,
  `src/time/moves.ts`, `src/time/recordWindow.ts`, `src/time/songLoop.ts`, `src/audio/spectrum.ts`
  and view helpers such as `arrange/songLayout.ts`, `songModel.ts`, `songDrag.ts`,
  `steps/model.ts` and Shape's `macroAssign`, `cardKnob`, `squeeze` and `paramState` are **pure
  TypeScript**: no DOM, no Web Audio, no React. They run in Node unit tests.
- `src/audio` never imports React, stores, or UI. It is driven by `setProject()` and timed calls.
- Audio nodes, class instances and functions never enter the Project. The Project is JSON.
- The **audio clock is the timing authority**. Notes, song moves and audition stops are scheduled
  with `AudioContext.currentTime` look-ahead. React renders, `requestAnimationFrame` and UI timeouts
  never time notes; display loops only read the audio clock.
- Meters, playheads, loop progress and knob drags update the DOM directly (refs, canvas, Web
  Animations, pointer events), not via React re-renders.

## Spine files (shared contracts — change only deliberately)

- `src/project/types.ts` — the Project schema (**v3**, `PROJECT_VERSION = 3`, schema id
  `switchboard01.project`). Ticks: PPQ 96, step 24, bar 384.
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
- Arrangement: ordered blocks `{sceneId, repeats, label?, parts?, moves?}`; `parts` changes single
  parts in that block only (another scene's clip, or `null` = silent). `moves` (v3) holds at most
  one **song move** of each kind: `fadeIn`, `fadeOut` (the song gain across the block),
  `filterRise` (Tone of the listed parts, default every melodic part, from 0.15 to its own value),
  `echoThrow` (Echo to 0.85 over the block's last beat, back a bar later). One pass = the longest
  clip the block plays (`blockBars`); song length = Σ pass × repeats.
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
- Musical Assist snaps melodic notes into the key; drums, sampler parts (recordings keep their
  pitch), chord pads and previews play as pressed.
- Schema migration: v1→v2 adds neutral mastering; **v2→v3 changes nothing** (every v3 addition is
  optional or a wider range). The bump exists so older builds refuse v3 projects (which may hold 5–8
  scenes, 5–8-bar clips, per-clip recordings, song moves and macro homes) with "This project was made
  with a newer version of Omni Song." instead of silently dropping data.

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
  change outside the history), for listeners that keep state per step (the song loop).
- An undo group (`beginGroup(label)` / `endGroup()`) merges every recorded edit into one step; a
  Record Notes pass uses it, and so do Reset big knobs and a diagonal in-key note drag (skipped
  while Record Notes has its own group open). `endGroup()` drops a group step whose edits ended
  where it began and returns `{step}`.
- Commands return `{changed, reason?, message?}`; invalid input changes nothing. `session.accepted(r)`
  shows refusals as a toast.
- UI-only state (selected part and slot per part, view, pad mode, octaves, tips, Steps grid and
  Follow, chord pads, keyboard folded per view, the lane's zoom and scroll per project) lives in
  `uiStore`, never in the Project. Some of it is remembered in `localStorage`.

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
- Scenes: `insertScene`, `duplicateScene`, `deleteScene` (asks first when blocks use it;
  `removeBlocks` takes them too), `captureScene`, `sceneFromBlock`. Clips: lengths 1–8,
  `repeatClipToBars`, `setClipNotes`. Arrangement: block moves, `setBlocksPart` across a selection,
  `setPartEverywhere`, `makeSongFromTake`, `addIntro` / `addEnding` (`ENDING_TAIL_SECONDS` = 2).
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
  to the present (`Sequencer.skipTo`: launches, song blocks and loop phases carry on in time); a
  `'skipped'` event fires only when notes were dropped, a performance take carries on, and the
  session shows `SKIP_NOTICE` at most once a minute. Only a **hidden tab or a suspended audio
  device** stops playback (`STALL_THRESHOLD` 0.25 s), coherently and without a backlog;
  `STALL_MESSAGE` says "… Press Play to continue." and the banner's Play calls
  `session.resumeAfterStall()`, which restarts what was playing (song from its block, a replay from
  its start, else the live pads).
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
  `runtime.recordStartsAtTick` is set while waiting. Recording into a clip the playing song block
  does not play still records where its loop would be (`runtime.recordTargetAudible` false, one
  notice).
- **Song moves** (`src/time/moves.ts`): fades become song-gain ramps, Filter rise and Echo throw
  become Tone and Echo macro ramps, all as sequencer events. Seek, pause/resume, loops, edits and
  regenerations resume mid-ramp at the value reached there; offline renders get the same moves, so
  exports match live playback. A start fades in from silence with `scheduleSongGain(0, t)` then a
  ramp from `t`; the transport sets a fade's start value 5 ms before its time (`MOVE_GLIDE`).
- Export while playing: while an export prepares and renders, live playback is scheduled 2 s ahead
  (`RealtimeTransport.holdAhead`). Edits, launches, Pause and Stop still act at once.
- Pause / Resume: Pause records the musical position (tick, each playing clip's phase, queued
  launches, song block, replay position), releases held notes and stops scheduling; Play restarts
  the sequencer at that tick with the same launcher state (`relocateSlots` / `relocateSongRows`), so
  playback continues in time with no backlog. Stop returns to bar 1 with the previously playing
  clips armed. Pause is unavailable while a performance take records; during Record Notes it ends
  the pass first.
- `RealtimeTransport` emits `arpNote` when the audio clock reaches an arpeggiator note that was not
  cancelled; Record Notes records those (at their real grid tick and gate) on arp parts.
- Scene rows inserted, copied or deleted remap the playing and queued slots, the song plan and each
  part's chosen slot (as a scene move does); undo and redo bring the chosen slots back.

## Song playback

- Song playback is what the Arrange lane shows. `start()` lays out every block's part choices as
  'song' transitions (a layered part plays the other scene's slot, an off part stops at the block
  start); `playSong(i, {fromBar})` starts at that lane bar, the block containing it in phase;
  `playSong()` (neither given) starts at the song loop's first block, else at the first block.
  `Session.togglePlay({ song })` (Space / the transport's Play; `song` in Arrange): Pause while
  playing; otherwise a pause continues whatever was paused (pads, song or replay); a start plays the
  song (from the loop's first block when a loop is set), or the pads when no block can play.
- Edits while a song plays or is paused (undo/redo included): when `songSignature()` changes, the
  session calls `transport.replanSong()` → `Sequencer.replanSong(now + 10 ms)` in the edit's own
  task, so no reader (the lane playhead, the song plan store, the next transport action) ever sees
  a plan the edit made stale. It is cheap: for a lane drop while the House starter's song plays
  (headless Chromium), the replan's own work in the drop task is 0.8 ms median (2.5 ms p90), 2.8 ms
  (8.9 ms p90) at 4× CPU slowdown, against a drop frame of ~20 ms (~90 ms at 4×) that is React's
  commit and layout. Running it after the next paint instead was measured and dropped: it saved
  about that much in the drop frame but made the frame after it longer (a second React commit for
  the new plan: +3 ms median, +29 ms at 4×). The **edit point**
  is the playhead at that time (the pause point while paused), rounded up to a whole tick; nothing
  before it changes. The anchor is the plan block under the playhead. It **has started** when its
  start lies before the playhead's floor (the start, pause or resume point; right after Resume the
  playhead waits there) or its time has passed. The rules, in order:
  1. Anchor not started yet (right after Play, or paused/resumed on its first tick): it starts as
     edited; deleted, the first block that followed it and still exists starts in its place.
  2. The anchor (found by id) still covers the playhead at its new length: it keeps its start;
     parts whose clip in it changed (its scene, a part switched off or on, a layered part, the clip
     in that slot) switch **at the edit point**, in phase with the block start. A part switched off
     stops there (its sounding notes are cut); one switched on joins mid-loop, and its notes that
     would have started before the edit point are not played late.
  3. Otherwise, where the playhead lies on the edited lane: the new order laid out from the
     anchor's start or, deleted, from the start of the nearest block before it still in the song
     (with none, from the anchor's start beginning with the block that followed it). If the block
     there plays the same clip on every part as what sounds now (a split while a later pass plays,
     a join while the second block plays, undoing either, a deleted block whose neighbour plays the
     same), playback continues in that block: no switch, every clip keeps its loop phase, the lane
     playhead does not move.
  3b. Otherwise, when the block there plays the anchor's scene and this edit made or changed it (new,
     or another length or other part choices than in the plan played: Build up, Strip down,
     Breakdown on the playing block, or undoing / redoing one), playback continues in that block from
     its start on the lane (a pass line of the block that played, so every later block stays on the
     phrase grid); its parts that differ from what sounds switch at the edit point, in phase with that
     start. The lane playhead does not jump back and nothing plays a pass late or is skipped.
  4. Otherwise the anchor (shortened below the playhead, or deleted) sounds on to the **next bar
     line**: shortened, with its changed parts switched at the edit point; deleted, as it was. There
     the block after it takes over (for a deleted block: the first block that followed it and still
     exists, at its place in the new order), or the song ends.
  Everything after the anchor follows the project (order, scenes, parts, repeats, lengths, the end);
  the end never lies behind the playhead (nor before the next bar line once the anchor has started).
  Song transitions from the edit point on are replaced in `pending` and in `history` (a rewind
  cannot bring stale ones back), then the transport invalidates. An Undo is an edit like any other:
  the part switches back at its edit point, in phase (undone in the same moment, the switch never
  happens). A note an edit already cut stays cut (its voice's release is scheduled), so a held chord
  comes back with its next start. Song transitions sort before a pad launch at the same tick (the
  pad wins); pad launches stay on the next bar line. Scene reorders are followed first by
  `relocateSongRows`. In song mode the session leaves a clip that left its part (deleted, or dragged
  to another part) to the replan: its slot is empty, so the part is silent at once, and the replan
  makes that a switch (Undo switches it back on); no live stop is queued and the slot is not
  relocated to "stopped".
- **Song loop** (`runtime.songLoop`, set only through `Session.setSongLoop`; runtime only, never
  saved, not in undo history): the blocks from `fromBlockId` to `toBlockId`, inclusive, either way
  round, in the current order. After the loop's last block the plan goes on with its first block,
  again and again: one pass is kept as a template (`SongState.cycle`) and laid out a bar ahead of
  the generation cursor (`extendSong`), with the blocks' own ids and every pass starting its clips at
  its own start, as the song plays them there; entries that played more than `HISTORY_TICKS` ago are
  dropped (`pruneSong`), so a long loop never grows the plan. No 'end' while it loops.
  - Play song with a loop: from its first block. From a block or bar before the loop's end it plays
    into the loop; after it, to the song's end (the loop never engages).
  - Set or changed while playing or paused (`Sequencer.setSongLoop`): the block the lane shows at
    the playhead lies in the loop → it plays on and loops at the loop's end; outside → playback
    continues at the loop's first block at the next bar line (`jumpAt`; at once when that block has
    not sounded yet; while paused, after Resume). Setting never changes the block under the
    playhead. Cleared: the song plays on to its end; a waiting jump is dropped. Resume after a
    stall restarts inside the loop (at its first block when the music stopped outside it).
  - Edits never jump. A replan wraps after the loop's last block (for the block that follows and
    for the playhead's place on the edited lane, rules 2–4 above); a waiting jump is kept.
  - The session keeps the loop valid on every project change, before the replan
    (`songLoopAfterEdit`, src/time/songLoop.ts): both end blocks still there → unchanged (blocks
    moved between them join it); the loop's last block itself changed (another length or other
    parts) and new blocks of its scene follow right after it (Split, Build up, Strip down,
    Breakdown, undoing a join, or redoing any of them) → those join it, the last of them becomes the
    loop's last block (a block of the same scene pasted or duplicated after an unchanged last block
    stays outside); an end block joined into the block before it → that block; otherwise a deleted
    end block shrinks the loop to the first (last) block of its old span still there; nothing left,
    or another project → cleared.
  - Undo and redo (`SongLoopHistory`, src/time/songLoop.ts): an edit that changed the loop is
    remembered by its undo step id (`ProjectStore.lastChange()` tells the store's listeners whether
    a change was an edit, an undo or a redo, and of which step). Undoing that step brings the loop
    back as it was before the edit (an end block deleted, the loop shrunk or cleared: the old loop
    returns with its blocks), redoing it as it was after, as long as the loop was not changed since
    and its end blocks are in the song; otherwise the rules above apply. An undo or redo that
    changed the loop by those rules (undoing the step that made a block the loop ends on) is
    remembered the same way, so redoing that step restores the loop.
  - Runtime `songLooping` (`Sequencer.songLoopingAt`): true exactly while the block the lane shows
    at the playhead is one of the loop's blocks the plan repeats (also paused there); false while
    the song plays towards the loop or a jump to it waits, when it plays on to its end (no loop,
    cleared, or started after the loop), and when the song is not on. The session updates it on
    start, block events, replans after edits, loop changes, pause, resume, stop and stalls.
  - Every pass sends its 'block' events (runtime `songBlock`/`songBlockId` follow); the lane maps a
    repeat by its id, so the lane playhead and the readout go back to the loop's start.
    `songTimelineBar` reads the sequencer's live plan (`songLaneTickAt`), never a stale copy.
    Replay and live pads ignore the loop; exports render the song through, or (Export "Loop
    (blocks a–b)") the loop's blocks once: render source `songRange` plays the song from block a to
    the end of block b (every part as the song plays it there), then the tail.
- An 'end' is always handed out where the driver gets it: never before the resume point or before
  the floor of a rewind, so the transport stops even if the end came to lie behind music already
  handed out.
- A tempo change never takes effect before the start or resume point (the playhead waits there). A
  transition that leaves the same pad playing still ends what another clip sounds on that part (a
  clip replaced in its pad just after a block start, re-applied by a rewind).
- Right after an edit made just before a block (or loop pass) starts, the playhead lies a moment
  before the block the edit point found; `songBlockAt` and the lane count it as that block's start.
- `Sequencer.songPlan()` (absolute ticks; blocks before the playing one laid out in the current
  order; a deleted block has index -1 while it sounds on to the next bar line) feeds
  `views/arrange/songPlan.ts`. `songLaneTick(plan, lane, tick)` (pure, in the sequencer module) and
  `songTimelineBar(tick)` map the playhead onto the lane for the lane playhead and the transport
  readout: the lane start of the plan block playing plus the distance into it, never past that
  block's lane length (a block shortened below the playhead: the playhead waits at its end); while a
  deleted block sounds on, the playhead waits where the block taking over starts (the end of the
  block before it), or at the end of the song. Between edits it only moves forward.
  `Sequencer.songBlockAt(tick)` is the block the lane shows there (the block taking over while a
  deleted one sounds on); the session's runtime `songBlock`/`songBlockId` follow it after every
  edit, since a block continued after a split or join gets no 'block' event.

## Offline rendering and export

- `renderOffline()` (src/render/offline.ts) drives the same Sequencer + AudioEngine on an
  `OfflineAudioContext`, in chunks via `suspend()` for progress and cancellation. At the end of the
  music it calls `transportStopped()` like the live transport, then renders the tail. Sources: the
  song, part of it (`songRange`), a performance, a scene or the launcher state. The Export dialog
  offers the song first when it is opened in Arrange or while the song plays or is paused.
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
- **Versions** (`versions.ts`): kept automatically after about ten minutes of active editing,
  before bulk edits (the session calls `snapshotBefore` before Variation, Clear, Delete clip or
  scene, Replace, Build up / Strip down / Breakdown, Make song blocks, Make a scene from a block, a
  kit, sound or recording change, an import or Move the song: at most once per kind of edit every 2 minutes in the session,
  every 3 minutes per project in persistence, never for undo or redo) and on request (Save version…,
  optionally named). **Thinning** runs before a new version is written: named versions stay until
  deleted; unnamed ones keep everything from the last hour, then the newest of each hour for a day,
  then the newest of each day, at most 30 per project (10 when storage is full), the hourly and daily
  ones first, so a burst never pushes older history out. After a quota error versions pause for 10
  minutes; saving the project itself is never held up. Restoring always makes a new project.
- Garbage collection keeps every recording a project, a version or a clip (`Clip.sample`) uses.
- Names are picked inside the write transaction, so two projects stored at the same moment get
  different names ("House Starter", "House Starter 2").
- `library.createFromStarter` returns `{project, replaced}`; the session reports the replaced
  project through `runtime.starterReplaced` so the shell can offer to open it again.
- Project bundle: a zip (`.omnisong.zip`; `.sb01.zip` still imports) with `project.json` +
  `samples/<id>.<ext>`; validated and migrated on import. Bundles are the portable backup; browser
  storage is working storage.

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
- `runtime.ts`: what the audio side is doing now (`playing`, `tracks`, `recording`,
  `recordStartsAtTick`, `recordTargetAudible`, `starterReplaced`, `stalled`, …) and `notify()`.
- `App.tsx`: banners (audio, stall, another tab), the shell's own toasts, global keys (?, Ctrl+S),
  drop-to-import, the leave warning, the document title. The view tab changes at once and the view
  follows in a deferred render (`useDeferredValue`). App counts finished exports by wrapping
  `renderWav` / `renderWavWithReport` (the song hints read it). `__APP_VERSION__` comes from a Vite
  define (package.json).

## UI kit (`src/ui/`)

- **Meters** draw into one canvas each and share one animation-frame loop
  (`components/meterScheduler.ts`): reads at most ~70 times a second, draws at most 30, only what
  changed. The loop **sleeps** once every meter shows its floor and nothing called `meterWake()` for
  500 ms; it wakes on `meterWake()` (playback start, previews, notes, audio input), on any key or
  pointer press, on the tab becoming visible, and from a slow 125 ms probe while asleep. A stopped,
  silent app runs no meter frames. Mix readouts and the spectrum ride on the same loop (`useMixTask`).
  `useRafLoop(cb, active, {fps})` caps other loops.
- **Toast placement** (`components/Toast.tsx` and its CSS): top centre under `--transport-h`
  (written by the TransportBar on `document.documentElement`, strip plus banners); below an open
  menu (`body[data-popover-open]`, counted by Popover); action keys hidden under
  `body[data-modal-open]` (set by Dialog); slides clear of controls under its band into the widest
  clear stretch (≥ 300 px), placed again on scroll and resize. `--keyboard-h` (written by the
  KeyboardStrip; 0 when folded or not docked) remains for other overlays.
- **Touch rule** (`components/touchDrag.ts`): `TOUCH_HOLD_MS` 250, `TOUCH_SLOP_PX` 8,
  `TOUCH_HIT_PX` 44 for Knob and Fader.
- Knob sizes sm/md/lg/xl (`--knob-dial-*`), `macroRange`, clickable value key (`--knob-value-h`
  sets its line height; style it there, not through the slider). Fader `formatShort`, typed entry
  through `valueInput.ts` (honours `ParamSpec.negate`). NumberField `blurOnCommit`, `dragStep`. Pad
  `sketch` (ClipSketch) and `--loop-progress`. MiniKeyboard `noteNames` ('legend' | 'above' |
  'none'), `fit`, `variant: 'kit'` with `kitLayout`. Type tokens `--fs-*`, `--fw-*`, `--type-*` and
  the role classes; `--teal-key` for white-on-teal badges.

## Views (`src/app/views/`)

- **Play:** `LoopsGrid` reads `clipPhase`, `queuedAt` and `audibleTick` a few times a second
  (8 checks a second, `ProgressAnimator`): each progress bar is one looping Web Animation of its
  fill, stepped per sixteenth (per beat with reduced motion) and re-anchored only when it drifts
  more than 30 ms from the audio clock, so nothing is written per frame; the beat countdown
  re-renders a queued pad only when its number changes. Column meters read `readMetersShared`.
  `Popover` (in ClipMenu) counts `data-popover-open` and consumes an outside press (pointer only).
- **Keyboard and pads:** `KeyboardStrip` writes `--keyboard-h` and folds per view
  (`keyboardCollapsedFor`); one kit key table shared with the Drums pads (`kitKeyLabels`). Chord
  pads count shared notes so a note sounds once until every pad holding it is released (the counts
  reset when the app releases every note). `ProgressionDialog` previews by running
  `createProgressionClip` on a scratch `ProjectStore`.
- **Steps:** session-only `noteSelection` / `noteClipboard` stores (`steps/shared.ts`); the roll draws
  a drag from pure previews (`steps/model.ts`, tested against `moveNotes` / `transposeNotes`) and
  commits on the drop; a diagonal in-key drag joins `moveNotes` and `transposeNotes` in one undo
  group. `usePlayhead(…, {cellTicks, follow})` lights the heard step from `clipPhase` +
  `audibleTick`.
- **Shape:** pure, unit-tested helpers `macroAssign`, `cardKnob`, `squeeze`, `paramState`;
  `knobExtras` adds Alt+double-click and the knob menu with native listeners; `GrMeter` reads
  `moduleReductionDb` through the shared meter loop; `shapeLayout` keeps the Advanced tab and each
  column's scroll per part; columns are memoised and follow a part switch in a deferred render (never
  remounted, never made inert); `resetBigKnobs` is one undo group.
- **Sound browser and sampler:** a browse takes `snapshotTrackSound` and makes every choice (and
  Cancel) with one gesture id, so back-to-back choices are one step and Cancel
  (`restoreTrackSound`) leaves none; outside edits stay their own steps. `importState` checks an
  import before decoding. `samplerTarget.ts` decides whether the editor edits the clip's or the
  part's recording; `sampleDetail.ts` decodes close-up waveforms; `clipAudition.ts` plays a clip's
  own recording through `engine.scheduleNote` via the part's chain and the limiter (the session's
  preview cannot pass a recording yet).
- **Arrange:** `PartNames`, `ScenePalette` (audition: the stop is queued for the pass's end bar on
  the audio clock), `songDrag.Dwell` (the insertion slot opens after a 250 ms rest),
  `LANE_EXTRA_MAX_PX`, lane glides timed from the current time (not the frame's start).
- **Mix:** `loudnessMatch.ts` (fresh readings and iterating Match; watches from app load),
  `mixMeters` reads `readMetersShared`; the mastering panel mounts in a transition after the strips'
  first frame. Export uses `renderWavWithReport`.
- **Hints:** placed after the view has painted, in idle time, never while a pointer is pressed or a
  modal is open, with a coarse-then-fine search and cached sizes; prefer `[data-hint-home]`, avoid
  `[data-hint-avoid]`. Steps keep their words and detection together in `hints/steps.ts`; Help's
  shortcuts and walkthroughs are pure data in `hints/shortcuts.ts` and `hints/guides.ts`.

## Testing

- `npm test` — Vitest (Node): timing math, sequencer events (clip phase, skips, record window, song
  moves, 8 scenes), graph validation, commands/undo (note, scene, arrangement, sound commands), music
  theory (spelling, chords, progressions, key moves), variation bounds, WAV encoding and dither,
  validation/migration (v1→v2→v3), persistence (locks, rescue, versions, read-only), bundles, DSP
  sanity, spectrum bands, view logic (`r4-*-model`, `r4-shape-logic`, `r4-shell-steps`).
- `npm run test:browser` — Vitest in real Chromium: components and the whole app with real CDP
  mouse, keyboard and touch input at 1366 × 768, 1920 × 1080 and 960 × 540 at 2×; offline renders
  through the real engine (latency, true peak, returns, ramps, levels).
- `npm run test:e2e` — Playwright + Chromium against the production build: journeys, persistence
  across profiles and reloads, two tabs, offline mode, stalls under CPU slowdown, resource
  stability, keyboard-only use and axe-core.
- `window.__switchboard` exposes test hooks (render fixtures, engine stats, `audiblePosition`) in
  every build; it contains no network or storage side effects of its own.
