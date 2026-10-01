# SWITCHBOARD / 01 — Architecture

A self-contained TypeScript + React + Vite web app. Every sound is synthesized or decoded on the
user's device with the Web Audio API. There is no server, no account, no telemetry and no runtime
download.

## Layers (dependency direction: top may import from below, never the reverse)

| # | Layer | Folder | Knows about |
|---|-------|--------|-------------|
| 5 | UI controls & visualization | `src/ui/`, `src/app/` | everything below |
| 4 | Commands, undo/redo, automation, recording | `src/state/` | project, music, content |
| 6 | Persistence, imports, offline rendering | `src/persistence/`, `src/render/` | project, audio, time |
| 2 | Musical time & event scheduling | `src/time/` | project, music |
| 3 | Audio graph, voices, modulation, effects | `src/audio/` | project (types/params/resolve) |
| 1 | Serializable, versioned project data | `src/project/`, `src/content/`, `src/music/` | nothing (pure data + pure functions) |

Rules:

- `src/project`, `src/music`, `src/content`, `src/time/clock.ts`, `src/time/sequencer.ts` are **pure TypeScript**:
  no DOM, no Web Audio, no React. They run in Node unit tests.
- `src/audio` never imports React, stores, or UI. It is driven by `setProject()` and timed calls.
- Audio nodes, class instances and functions never enter the Project. The Project is JSON.
- The **audio clock is the timing authority**. Notes are scheduled with `AudioContext.currentTime`
  look-ahead. React renders, `requestAnimationFrame` and UI timeouts never time notes.
- Meters, playheads and knob drags update the DOM directly (refs + rAF / pointer events), not via
  full React re-renders.

## Spine files (shared contracts — change only deliberately)

- `src/project/types.ts` — the Project schema (v1). Ticks: PPQ 96, step 24, bar 384.
- `src/project/params.ts` — parameter registry (ranges, defaults, units, curves, tips) + helpers.
- `src/project/modules.ts` — patch module catalogue: ports (audio / mod), limits.
- `src/project/factory.ts` — ids, default tracks (always 8), default patch, default macro maps.
- `src/project/resolve.ts` — macro resolution → effective params per module.
- `src/content/catalog.ts` — ids and names of kits, synth presets, built-in samples.
- `src/audio/contracts.ts` — `InstrumentEngine`, `VoiceHandle`, `AudioEngineApi`, meters, ceiling.
- `src/time/contracts.ts` — `SeqEvent`, play modes, launch state; the timing model in prose.
- `src/ui/theme.css` — design tokens and colour semantics.

## Project model summary

- Always 8 tracks (`t1`..`t8`) with roles Drums, Percussion, Bass, Chords, Lead, Pad, Texture, Sampler.
  Tracks can be renamed and their instrument changed; the count is fixed.
- Each track has 4 clip slots. **Scene = clip row.** Launching scene *i* launches slot *i* on every
  track and stops tracks whose slot *i* is empty. Scene length (bars) = longest clip in the row.
- Instruments: `drums` (16-voice kit), `bass` (mono synth), `poly` (poly synth), `sampler`.
  Params are flat numeric maps interpreted through the registry.
- Patch: modules + connections. Default per-track chain
  `inst → drive → filter → channel → master`, channel `sendA → fx:reverb`, `sendB → fx:delay`,
  `lfo → filter.cutoff (mod)`. Shared `fx:reverb`, `fx:delay`, protected `master`.
  The effects rack and the cable panel both edit this same patch.
- Macros (Tone, Space, Echo, Motion, Drive, Pump) are stored per track as values (0..1) plus a
  mapping (`macroMap`) of `{module, param, min, max, curve, macroFrom, macroTo}` targets.
  A mapped param is controlled by its macro. Pump is a tempo-synchronized ducking envelope — not
  an audio sidechain.
- Arrangement: ordered blocks `{sceneId, repeats}`; song length = Σ scene bars × repeats.
- Performances: a snapshot of the musical state + timestamped events (launch, scene, notes, macro,
  param, mute, tempo, swing, master). During a take the store is locked to an allow-list: only the
  edits the take records (knob/param moves, macros, mutes, tempo, swing, master volume) go through;
  routing, clips/steps, sound choices, drum voices, arp and macro assignments are refused with an
  explanation, because replay uses the take's snapshot and could not reproduce them. A replayed
  noteOn pairs with the next noteOff of the same track and key.
  - Undo/redo during a take go through only when the step changes nothing but recordable values
    (`ProjectStore.setLock(reason, allows, paths)`); the resulting value changes are recorded as take
    events, so replay matches what was heard.
  - What already sounds when a take starts (held keys, a latched arpeggio) is written at the take's
    first tick (latched-only notes use keys `take:<trackId>:<pitch>`). Known limit: a latched pattern
    already running restarts from its first step in the replay, so its first notes can come in a
    different order than live.
  - Mute All ends a take (the notice says so), and a take cannot start while Mute All is on.
  - Editor previews and auditions (`NoteSource 'preview'`) play the exact pitch, skip Musical Assist
    and the arpeggiator, are never recorded, and are blocked while a take records or replays.
  - MIDI pitch bend is not recorded into performance takes: a replay plays its notes unbent.
- Musical Assist snaps melodic notes into the key; drums, sampler parts (recordings keep their
  pitch) and previews play the key as pressed.

## Audio engine

`AudioEngine` (src/audio/engine.ts) implements `AudioEngineApi`:

- One engine per context. The live app creates it once after the Jump In / Play gesture; the
  offline renderer creates a fresh one on an `OfflineAudioContext`.
- `setProject()` diffs by stable id: creates/destroys module nodes, adds/removes connections with
  ~20 ms gain ramps, applies resolved params with smoothing (`setTargetAtTime`), swaps instrument
  engines when the instrument kind changes.
- Every connection is `source output → connection GainNode → target input`. Mod inputs are GainNodes
  internally wired to the right AudioParams with the port's range.
- Master: sum → master volume → **mastering chain** (`Project.mastering`: low cut → EQ lows / mids /
  highs / air → Glue bus compressor → Warmth saturation → width + mono bass → Loudness drive; no
  added latency; neutral or off is bit-identical to no chain; `setMasteringBypass` is a
  listening-only A/B that never touches the project or exports) → Mute All gain → look-ahead peak
  limiter (AudioWorklet, ceiling −1 dBFS) → final safety clipper (WaveShaper bounded to the
  ceiling) → destination.
- Meters: per-part and master peak/RMS (AnalyserNodes); a loudness AudioWorklet on the final output
  (ITU-R BS.1770 / EBU R128: momentary, short-term, gated integrated, 4× true peak; restarted every time
  playback starts — live, song or replay — and by `resetLoudness()`, but not on resume from Pause); `readSpectrum()` (log-spaced band energy
  20 Hz–20 kHz); the Glue's gain reduction.
- Insert effects: filter, drive, delay, reverb, chorus, phaser, bit crusher, EQ, compressor, gate,
  auto pan, stereo width, flanger, tape. Worklets (limiter, crusher, dynamics, fx, mastering,
  loudness) load once per context from Blob URLs. Mute All clears every tail sample-accurately.
- `setPitchBend(trackId, cents, time)` bends a part's playing and future notes (MIDI pitch wheel).
- Tempo-synced modules (delay, LFO, pump) follow `tempoChanged()`; LFO phase aligns on
  `transportStarted()`. An LFO switched Off keeps its phase but its cables glide to 0 (it moves
  nothing); a shared return switched Off mutes its output.
- Drum kits define their own choke groups (open hat choked by the closed hat, and by the pedal hat
  where the kit has one). Sampler One-shot plays the whole trimmed region whatever the note length
  (Stop, Mute All, steals and released previews end it); Loop bakes an end-of-loop crossfade into
  the audio leading into the region start, so every repeat keeps the region's own attack.
- Deterministic: noise, impulse responses, random LFO steps, drum synthesis, tape hiss and synth
  drift are seeded. Renders of the same project match to within float rounding: Chromium sums a
  node's inputs in an unspecified order, so the last bits can differ — up to ~5e-5 for a full
  starter, and ~5e-4 (−66 dBFS) when a loud mastering preset drives the limiter hard; single-voice
  paths render bit-identically.
- Constant output latency: the master limiter's 5 ms look-ahead plus one 128-frame render quantum
  (`engineLatencyFrames`), identical live and in exports. Record Notes compensates for it together
  with the device's output latency.
- `cancelScheduledAutomation(t)` drops param/macro/mute/master automation, pump ducks and metronome
  clicks at/after `t`; the sequencer regenerates them after an invalidation.

## Scheduling

- `Sequencer` (src/time/sequencer.ts) is a pure class: transport anchor, swing warp, launcher state
  machine (queue at next bar, one clip per track), scenes, arrangement (song mode), performance
  replay, arpeggiator, beat events. `process(untilTime)` returns `SeqEvent[]`.
- Notes already handed to the engine can be shortened by a **cut** (`Sequencer.takeCuts()`): a clip
  switch, a mono overlap or a tempo increase releases the voice early. Every driver applies cuts, which
  is what guarantees two clips never overlap on one track.
- `RealtimeTransport` (src/time/transport.ts) drives it from a Web Worker ticker (25 ms) with a
  120 ms look-ahead against `AudioContext.currentTime`, dispatches events to the engine, keeps
  handles of voices that have not started so `invalidate()` can cancel and regenerate them, and
  emits UI events when their audio time arrives.
- Stall policy: if the ticker falls more than 250 ms behind (background throttling, suspended
  context) the transport stops coherently (no backlog is played) and raises a `stalled` state that
  the UI shows with a Resume button.
- Pause / Resume: Pause records the musical position (tick, each playing clip's phase, queued
  launches, song block, replay position), releases held notes and stops scheduling; Play restarts
  the sequencer at that tick with the same launcher state (`relocateSlots` / `relocateSongRows`), so
  playback continues in time with no backlog. Stop returns to bar 1 with the previously playing
  clips armed. Pause is unavailable while a performance take records; during Record Notes it ends
  the pass first.
- `RealtimeTransport` emits `arpNote` when the audio clock reaches an arpeggiator note that was not
  cancelled; Record Notes records those (at their real grid tick and gate) on arp parts.
- After a stall, Resume restarts what was playing: the song from its block, a replay from its start,
  otherwise the live pads.
- `renderOffline()` (src/render/offline.ts) drives the same Sequencer + AudioEngine on an
  `OfflineAudioContext`, in chunks via `suspend()` for progress and cancellation. At the end of the
  music it calls `transportStopped()` like the live transport (sampler one-shots end, take
  automation hands back), then renders the tail.

## State, commands, undo

- `ProjectStore` (src/state/) holds the current Project immutably. Every edit is a named command
  run through immer `produceWithPatches`; history stores patches + inverse patches.
- Continuous gestures (knob drags) pass a gesture id so one drag = one undo step.
- An undo group (`beginGroup(label)` / `endGroup()`) merges every recorded edit into one step; a
  Record Notes pass uses it, so Undo removes the pass (new clip, notes, knob moves made meanwhile).
- UI-only state (selected track, view, pad mode, octave, tips) lives in a separate UI store and is
  remembered in `localStorage`, never in the Project.

## Persistence

- IndexedDB database `switchboard01`: `projects` (Project JSON), `samples` (original file bytes as
  Blob + metadata), `meta` (last project id), `trash` (recoverable deletes).
- Autosave: debounced after edits; status `saved | saving | error` with a recovery path (retry,
  export bundle).
- Project bundle: a zip (`.sb01.zip`) with `project.json` + `samples/<id>.<ext>`; validated and
  migrated on import. Bundles are the portable backup; browser storage is working storage.
- WAV: 16- or 24-bit stereo PCM at 44.1 or 48 kHz, rendered offline with the same engine.

## Testing

- `npm test` — Vitest (Node): timing math, sequencer events, graph validation, commands/undo,
  variation determinism, scales, WAV encoding, validation/migration, bundle round trip, DSP sanity.
- `npm run test:e2e` — Playwright + Chromium against the production build: Jump In journey, audible
  output, offline renders measured in the browser (onsets, macro/effect deltas, rewire, limiter
  ceiling, determinism), persistence across profiles, offline mode, resource stability.
- `window.__switchboard` exposes test hooks (render fixtures, engine stats) in every build; it
  contains no network or storage side effects of its own.
