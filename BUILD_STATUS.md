# BUILD STATUS — SWITCHBOARD / 01

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
| 3. Sound shaping and patching | in progress | engine + effects + macros verified by signal tests; Shape view and cable panel UI being built |
| 4. Making and keeping music | in progress | recording, replay, autosave, bundles, WAV export done; Arrange view and sampler editor UI being built |
| 5. Product finish and handoff | not started | |

## Next action

Integrate the Shape view, cable panel, Arrange view and sampler editor (workflow in progress), run all
suites, then Milestone 5: responsive layout (200 % zoom), accessibility pass, evidence capture
(`node scripts/evidence.mjs`), release package (`npm run package`), final TEST_REPORT.md.

## Known limitations / environment notes

- Cloud container: 4 CPUs, Chromium 141 (Playwright 1.56.1) preinstalled; no Windows host, so
  the Windows launcher can only be checked statically here (see TEST_REPORT.md when written).
- No listening test is possible in the cloud; audio is verified by offline renders and signal
  measurements only.
