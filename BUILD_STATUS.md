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
- Scene = clip row; always 8 tracks, one clip slot per scene (4 scenes until round 4; 1–8 since).
- Look-ahead scheduler fed by a Worker ticker. Until round 4 a stall stopped playback coherently
  (Resume); since round 4 a busy visible tab skips ahead in time and only a hidden tab or a
  suspended audio device stops (the banner's Play resumes).
- Look-ahead limiter AudioWorklet + bounded safety clipper at −1 dBFS (true-peak detection,
  −1 dBTP, since round 4).

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

## Song timeline (after 2.0, on a pull request into `main`)

Asked for: "the movement of song bits so sleek and smooth and so easy to edit and extend and
combine … perfect and reliable … clicking together." `main` holds the shipped 2.0; this work is
reviewed as a pull request from the development branch.

| Step | State | Notes |
|------|-------|-------|
| Spine | done | block labels and per-part changes (layer another scene's part, or switch a part off, in one block), 16 passes per block, group commands (move, duplicate, paste, remove, split, join, layer, rename), validation |
| Playback | done | per-part changes play; edits apply live while the song plays or is paused, re-planned from the block playing now; play from a bar; readout follows the song timeline |
| Song lane | done | edge-to-edge blocks with a row per part; drag with live slot opening and a settle; Ctrl/Alt copy; edge drag for passes; split/join; multi-select; clipboard; scene cards layer or insert; keyboard path for everything; Follow, zoom, Fit song |
| Pads | done | Loops pads and scene rows lift, preview the result, and settle like the lane (shared `src/ui/motion.ts`) |
| Reviews | done | hands-on UX review with frame timing (touch drags, re-fit on drop, follow snap-back, slow-PC stutter, layer semantics … fixed) and adversarial correctness review (5 defects reproduced and fixed with regression tests; a seeded fuzz of random live edits guards the rest) |
| Round 2 | done | loop a section (Loop button, ruler band, block menu; seamless repeats; edits keep working inside it); Build up / Strip down / Breakdown; touch press-and-hold to pick up, swipe to scroll; a drop does about a third less work; gestures that end where they started leave no undo step |
| Round 3 | done | a first-time-user review and a correctness review: one Play per screen (in Arrange the transport Play, Space, Stop and Export act on the song); export the looped section; playing on through an export; helpers on the playing block play what the lane shows; loops survive undo/redo; Fit song never zooms in, compact headers for long songs; taller part rows; calmer "Off" cells; menus never cover their button; tooltips wait for the pointer; toggles keep their "on" look under the pointer; Undo/Redo always on the top bar; plain words ("times", "Echo tail") |

## Omni Song 2.2: the whole-app upgrade (round 4)

An audit of every view found performance, design, Play, Mix, Shape, shell and capability problems
(finding ids such as PLAY-01, MIX-01, shape-01, perf-01). They were built in 14 slices, each with
its own tests, most followed by an independent review and a fix round, and merged into `r4-int`.
This round ships as **version 2.2.0**. Interface rules: `docs/OMNI_UX.md`; contracts:
`docs/ARCHITECTURE.md`; checks: `docs/ACCEPTANCE.md`.

| Slice | Final commit | What it delivered | Key measurements (from the slice and review reports) |
|------|------|------|------|
| model-spine | `d1e26a4` | Schema v3 (1–8 scenes, clips up to 8 bars, per-clip recordings, song moves, designed big-knob positions; v2→v3 changes nothing, older builds refuse v3); undo steps in the user's words (`display`); a group that ends where it began leaves no step; 8 effects per part; scene, clip, sample, sound and arrangement commands | — |
| persist | `abd5fc1` | IndexedDB v2 (`versions` + `versionData`); one tab per project (Web Locks, BroadcastChannel fallback) with read-only and conflict states; rescue copies on reload or close; versions (auto, before bulk edits, named, restore as a copy, thinning); library writes refused for a project open elsewhere | — |
| uikit | `02e779b` | Canvas meters on one shared loop that sleeps; `meterWake`; toast placement contract; the touch rule (250 ms, 8 px, 44 px); xl knobs and clickable value keys; MiniKeyboard rail, fit and kit keys; pad sketches and loop progress; type and colour tokens | Mix at 4× CPU slowdown: paint 413 → 83 ms/s; Play 280 → 20 ms/s. Review: 0 animation frames idle in Play; main thread busy 8–9 % (was 15–16) in Play, 22–24 % (was 32–42) in Mix |
| engine | `46fa7fb` + `ae2be9a` | True-peak limiter (−1 dBTP); known output latency; song gain and macro ramps, Stop ends song automation; level-matched Drive and equal-power Chorus / Phaser / Flanger; returns with no dry path; level-matched A/B; idle drum preparation; spectrum by band integration; 16-bit TPDF dither; Compressor / Gate gain reduction; sample preload with a loader | House engine build 408 → 125 ms live, 474 → 52 ms export; true peak ≤ −1.00 dBTP; latency 383 frames at 48 kHz; Drive level within ±0.5 dB; 8 idle Drives build in 865 ms (base 3228); worst modulation effect −0.97 dB (Phaser on Pad); idle drum steps ≤ 3.7 ms; ramp sidebands −75.9 dB; pink-noise spread 1.66 dB (base 5.46); Techno, Breakbeat and Downtempo starter levels re-baselined |
| core | `fcd74a1` | 0.3 s look-ahead and brace; skip instead of stop in a visible tab; Jump In paints before the engine is built; shared meter reads; audible position, clip phase and queued tick; Record Notes early window; aligned exports, export without mastering and the loudness report; per-clip recordings and the sample loader; imports as clips; song moves played and exported; 1–8 scenes; versions before bulk edits; re-voicing after sound edits | 4× CPU slowdown with real tab clicks: 927 notes, 0 later than 20 ms, 0 stops (`r4-int` before: 11 late, worst 105 ms, 1 stop); review at 6×: 0 late, 0 stops. Jump In longest frame 152–250 ms (base 349–492). Exports aligned to frame 0–1; report within 0.001 |
| notes | `4723d85` | Note selection commands (move, delete, velocity, transpose, duplicate, copy / paste; moves never delete by accident); quantize and humanize; paint, fill and shift drum steps; move the song to a key; chords and 8 progressions; spelling by key; Variation from the original within ±30 % | Variation: a test presses every starter clip at every strength (over 3000 presses) within ±30 %; an uncommitted probe found 0 of 12,096 presses out of bounds |
| play | `4a90b35` | One selected clip; take lock in the grid; 1–8 rows and the scene menu; clip lengths 1–8 with Double and Repeat to 8 bars; pad sketches and loop progress; Variation split key; Keep pattern; roving keyboard; Solo keeps its meter; menus that consume an outside press | Review M1: loop bars cost 7× the base main-thread time per frame; fixed with stepped Web Animations: ≈ 1.09–1.29× base, 55–60 fps. Tab reaches the part panel in 11 stops |
| mix-export | `81fd875` | Fresh loudness readings (P1, MIX-01); iterating Match with guards; level-matched A/B; meters on the fader scale with peak hold; Reverb and Echo return strips; Channel drawer; Export Output, report and 24-bit default; "Silent" faders; mastering beside the mixer from 1280 px; readouts on the sleeping loop | A/B trim 6.1 dB against 6.08 measured; report within 0.03 LUFS; 0 animation frames once stopped |
| pads-keys | `6a1c447` | Clickable, paintable drum grid with a sound menu; one key, one kit sound; key letters and a name rail; wider keys and a third octave; `--keyboard-h`; folding per view; the key-change question; chord pads and Write a progression; Root marking | Keyboard 1320 px wide at 1920 × 1080 |
| steps | `2f66fb8` | Note selection, drag across bars, keys and clipboard; 1/16, 1/32 and triplet grids; Tighten timing and Loosen; per-note velocity; transpose in key; bar strip with overview; Follow; touch; heard-step playhead; key chip | Header back to two rows at 1366 × 768 (80 px, 18.6 rows of notes; 16.1 at 1280) |
| sound-sampler | `a5994fc` | Sound browser Cancel and one undo step; imports checked first and made into clips (asking on drum or synth parts); per-clip recordings in the editor; tempo helper; waveform zoom, overview and snap; Record audio up to 8 bars; reduced motion | — |
| shape | `21c99b8` | Simple cards whose knob always changes the sound (P1, shape-01); big knobs that reach nothing say so, Reset big knobs (P1, shape-02); "Drive is off" for a big knob waiting on a switched-off effect; resets to the sound's own values; Assign to big knob (options and end-of-travel values hold until the big knob passes); Sound row and a Drum mix of the groups a part plays; one-row big knobs on short windows; Advanced tabs and cables overlay; Squeeze (full: −28 dB, 5:1, make-up ≤ 8 dB) and gain-reduction bars; copy / paste effects; dimmed knobs with reasons; knob drags end on a part switch; "Showing <part>…"; Open in Shape in the Play cables drawer; the rack embedded in Mix's drawer with part-named undo steps | Part switch medians: 1366 × 768 Simple 308 ms / Advanced 128 ms; 1920 × 1080 Simple 200 ms / Advanced 112 ms. Full Squeeze keeps every starter part at or under −4.4 dBFS peak. Advanced columns catching up with a note instead of dimming: median switch 56 ms (104 ms dimmed) |
| shell | `c0f6c89` | Two-tab banners; returning Welcome; leave warning (not for Record Notes); Tempo / Swing keys; transport widths (Projects from 1600 px, Undo / Redo words from 1800 px, Advanced loses bar.beat only at 1366–1439 px); save-state icons that open My projects; title and headings; one failure toast per run; Help and the ? key; song hints; a hint chip that never covers a control, ignores toasts, waits off screen when there is no room and slides in without a fade; drop-to-import; Ctrl+S; record count-in; Space on the guide's Play step; start toasts after the guide; `--transport-h` as the visible bottom of strip and banners; `session.exportsFinished` | Two-row strip at most 81 px (15 %) at 960 × 540 at 2×. Play / Pause in Mix re-renders 28 components (was 174). Final serial e2e run at load about 2: 51 of 51 |
| arrange | `a4d17a6` | A card dropped mid-block layers instead of inserting (P1); scene cards drag from anywhere, with a grip, and lift on a touch hold; slot direction from net travel; true scale with "1/4 Lift" compact headers and a "Min" zoom level; ▶ Play the song; a names column (108 px, one Tab stop, widening on hover) with Mute / Solo there and in the part menu; Loop button and chip; plain wheel scrolls; taller rows; take drawer; part switches across a selection; song moves; scenes palette with audition that runs to its pass end anywhere; Make song blocks (naming launches left out); Shape the song; Rec cells; edge grip; zoom memory | Review: 485 of 488 drops correct (3 wrong on stalled runs; base: 17 of 36 wrong). Arrange browser tests, serial: 221 of 221 |

Integration changes on `r4-int` (outside any slice): Jump In keeps the library's project result;
typed entry reads `ParamSpec.negate`; return Mix tooltips; views name undo steps in their own
words; toasts at the top centre under the transport, moving to the nearest spot clear of controls
(narrower if need be); the Channel drawer shows the rack embedded; chord symbols take each degree's own letter in seven-note keys; no browser Back/Forward swipe from
a drag; xl knobs keep a 32 px value key; starter cards spell keys like the app (E♭ major).
Integration perf check (1366 × 768, Play, playing, load about 4): main-thread task time 91–123 ms/s
on `r4-int` against 135–175 ms/s for the shipped 2.1 build, 60 fps in both.

**Deferred** (by the briefs): stem export, drum rolls, per-card preview in the sound browser,
sampler slicing, ADSR and filter types, the per-voice drum strip, a voice-source picker, user
presets, hash routing. **Not done**: the progression dialog plays single chords, not the whole
progression on the audio clock (no session API for a timed phrase); the chord inversion is kept for
the session only; a clip's own recording is auditioned through the engine directly (the session's
preview cannot pass a recording yet).

**Test runs.** Slice runs were on a shared, heavily loaded machine (load averages 7 to 57 on 4
CPUs). Timing tests (`drumSynth`, `r4-engine-idle`, `validate`, `variation`, the e2e keyboard tours
and Jump In timings) failed under load in several runs, and on the base under the same load. On a
quiet machine (load about 2) the shell slice's final serial e2e run passed 51 of 51. The final
full-suite numbers are in `TEST_REPORT.md`.

## State at handoff

- Release package: `npm run package` builds `release/omni-song-2.2.0.zip` (production build in
  `app/`, `Start Omni Song.bat`, `START HERE.txt`, `launcher/`, `ASSETS.md`, and the repository
  source in `source/`). Until it is rebuilt, the zip in the repository is
  `release/omni-song-2.1.0.zip`. Older zips stay in git history (2.0 is on `main`).
- Evidence: `TEST_REPORT.md` (results and measurements), `docs/ACCEPTANCE.md` (every requirement of
  the brief with its evidence), `docs/screenshots/`, `evidence/wav/`, `evidence/launcher-smoke.txt`.
- Guides: `docs/GUIDE.md` (first loop; record, mix, master and export; MIDI keyboard; recording
  your voice or guitar).
- At the 2.1 handoff: typecheck clean; unit 1106, browser 1085, e2e 25 tests pass. The 2.2
  results are in `TEST_REPORT.md`.
- Remaining work is local only: listening, physical latency, a real MIDI keyboard and microphone,
  the Windows launcher on Windows, Chrome/Edge on Windows, real background-tab throttling (see
  TEST_REPORT.md).

## Next action

Run the full suites on a quiet machine and build the 2.2 release zip. For local verification:
extract `release/omni-song-2.2.0.zip` on Windows, double-click `Start Omni Song.bat`, press Jump In,
then follow `docs/GUIDE.md`. Possible next steps are in `docs/ROADMAP.md` (local music-generator
bridge, webcam movement control, WebXR, and the items round 4 deferred).

## Known limitations / environment notes

- Cloud container: 4 CPUs, Chromium 141 (Playwright 1.56.1) preinstalled; no Windows host, so
  the Windows launcher was exercised under PowerShell 7 on Linux only (`evidence/launcher-smoke.txt`).
- No listening test is possible in the cloud; audio is verified by offline renders and signal
  measurements only.
