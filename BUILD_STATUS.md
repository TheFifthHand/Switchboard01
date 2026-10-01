# BUILD STATUS — Omni Song (formerly SWITCHBOARD / 01)

Branch: `claude/switchboard-music-instrument-f96j6m`

## Plan (concise)

1. **Spine first** — versioned Project schema, parameter registry, module/port catalogue, default
   patch & macro maps, audio + time contracts, design tokens. (done)
2. **Foundation modules in parallel** against the spine: drum synthesis & kits, mono/poly synths &
   sampler, audio engine & effects & limiter, sequencer & transport & offline render & WAV,
   project store/commands/graph validation/persistence, scales/variation/presets, starters,
   UI component kit.
3. **Milestone 1 slice** — integrate session (audio context on gesture), transport strip, Loops pad
   surface, part panel with macros, keyboard, Jump In, short WAV export; verify the journey in
   Chromium and by offline render.
4. **Milestones 2–5** as in PRODUCT_BRIEF.md §10, each ending with checks, a checkpoint commit and
   an update here.

Key decisions:
- Custom Web Audio engine (no Tone.js): one engine class runs on AudioContext and
  OfflineAudioContext, so WAV export uses identical synthesis, routing, timing and automation.
- Drum kits and built-in samples are synthesized by pure-TypeScript DSP (seeded, deterministic),
  rendered into AudioBuffers on the device. No binary sound assets.
- Scene = clip row; always 8 tracks × 4 slots.
- Look-ahead scheduler fed by a Worker ticker; stall → coherent stop + Resume.
- Look-ahead limiter AudioWorklet + bounded safety clipper at −1 dBFS.

## Milestones

| Milestone | State | Notes |
|-----------|-------|-------|
| 0. Plan, brief, instructions, spine | done | PRODUCT_BRIEF.md, CLAUDE.md, docs/ARCHITECTURE.md, contracts |
| 1. Complete playable slice | done | Jump In → groove → pads → Tone/Space → keyboard → record → WAV verified in e2e |
| 2. Approachable instrument | done | Drums/Notes/Steps modes, keyboard + Assist, clip/part/scene management, sound browser, arp, record options, library + starters, quick guide, tips |
| 3. Sound shaping and patching | done | Shape view (macros with editable mappings, instrument panel, effects rack add/move/bypass/remove), SVG cable panel + Play-view cables drawer (drag, click-click, keyboard picker, validation, restore connection), real-engine signal tests for macros/cables/ceiling |
| 4. Making and keeping music | done | Arrange view (scene blocks, repeats, reorder, song playback + export), performances panel (replay, edit events, export), sampler editor (import, trim, fades, pitch/rate, loop, tempo sync), Record Notes latency compensation, recording lock with allow-list |
| 5. Product finish and handoff | done | review at 1366×768 / 1920×1080 / 200 % zoom; keyboard-only and axe-core passes in Play, Shape, Arrange; acceptance audit of every brief requirement (45 gaps found and fixed, each independently reviewed); evidence (screenshots, WAV examples, launcher smoke test); release package with source (1.0) |

## Omni Song 2.0

Asked for after 1.0: a much easier interface, a real Pause, clear mute and moving of clips, many
more instruments and effects, mastering, MIDI keyboards and plugged-in instruments, and the new
name Omni Song. Interface rules: `docs/OMNI_UX.md`. Later ideas: `docs/ROADMAP.md`.

| Step | State | Notes |
|------|-------|-------|
| Spine | done | schema v2 (`Project.mastering`, v1→v2 migration), new effect and mastering parameters, contracts for loudness, spectrum, pitch bend and listening bypass |
| Wave 1 | done | Pause/Resume, transport redesign with Simple · Advanced, labelled Mute/Solo, drag clips and scene rows, pad action bar; 67 synth presets and 15 kits with new synthesis; seven insert effects; mastering chain with EBU R128 meters and spectrum; Mix view; Simple Shape |
| Wave 2 | done | Web MIDI (velocity, sustain, bend, mod wheel, learn, GM drums), audio recording with latency compensation and recording edits, rename to Omni Song (old projects and files still open), "Try this" hints, rewritten guide, roadmap |
| Reviews | done | correctness review (5 defects: gain clipping, MIDI undo flooding, take lost to a recording lock, loudness not restarted, early stop dropping audio) and hands-on usability/accessibility review (13 problems), all fixed with regression tests |
| Handoff | done | full test run, screenshots and WAVs recaptured, launcher smoke test of the 2.0 zip, TEST_REPORT and ACCEPTANCE updated |

## State at handoff

- Release package: `release/omni-song-2.0.0.zip` (production build in `app/`, `Start Omni
  Song.bat`, `START HERE.txt`, `launcher/`, `ASSETS.md`, and the repository source in `source/`).
  Rebuild with `npm run package`. The 1.0 zip was removed from the branch (it stays in git history).
- Evidence: `TEST_REPORT.md` (results and measurements), `docs/ACCEPTANCE.md` (every requirement of
  the brief with its evidence), `docs/screenshots/`, `evidence/wav/`, `evidence/launcher-smoke.txt`.
- Guides: `docs/GUIDE.md` (first loop; record, mix, master and export; MIDI keyboard; recording
  your voice or guitar).
- No failing checks: typecheck clean; unit 909, browser 925, e2e 25 tests pass.
- Remaining work is local only: listening, physical latency, a real MIDI keyboard and microphone,
  the Windows launcher on Windows, Chrome/Edge on Windows, real background-tab throttling (see
  TEST_REPORT.md).

## Next action

None required. For local verification: extract `release/omni-song-2.0.0.zip` on Windows,
double-click `Start Omni Song.bat`, press Jump In, then follow `docs/GUIDE.md`. Possible next
steps are in `docs/ROADMAP.md` (local music-generator bridge, webcam movement control, WebXR).

## Known limitations / environment notes

- Cloud container: 4 CPUs, Chromium 141 (Playwright 1.56.1) preinstalled; no Windows host, so
  the Windows launcher was exercised under PowerShell 7 on Linux only (`evidence/launcher-smoke.txt`).
- No listening test is possible in the cloud; audio is verified by offline renders and signal
  measurements only.
