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

## Audio engine

`AudioEngine` (src/audio/engine.ts) implements `AudioEngineApi`:

- One engine per context. The live app creates it once after the Jump In / Play gesture; the
  offline renderer creates a fresh one on an `OfflineAudioContext`.
- `setProject()` diffs by stable id: creates/destroys module nodes, adds/removes connections with
  ~20 ms gain ramps, applies resolved params with smoothing (`setTargetAtTime`), swaps instrument
  engines when the instrument kind changes.
- Every connection is `source output → connection GainNode → target input`. Mod inputs are GainNodes
  internally wired to the right AudioParams with the port's range.
- Master: sum → master volume → Mute All gain → look-ahead peak limiter (AudioWorklet, ceiling
  −1 dBFS) → final safety clipper (WaveShaper bounded to the ceiling) → destination.
- Tempo-synced modules (delay, LFO, pump) follow `tempoChanged()`; LFO phase aligns on
  `transportStarted()`.
- Deterministic: noise, impulse responses, random LFO steps and drum synthesis are seeded. Renders of
  the same project match to within float rounding (Chromium sums a node's inputs in an unspecified
  order, so the last bits can differ, ~1e-7 ≈ −140 dBFS).
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
- `renderOffline()` (src/render/offline.ts) drives the same Sequencer + AudioEngine on an
  `OfflineAudioContext`, in chunks via `suspend()` for progress and cancellation.

## State, commands, undo

- `ProjectStore` (src/state/) holds the current Project immutably. Every edit is a named command
  run through immer `produceWithPatches`; history stores patches + inverse patches.
- Continuous gestures (knob drags) pass a gesture id so one drag = one undo step.
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
