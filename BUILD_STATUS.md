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
reviewed as a pull request from the development branch. (This lane of blocks shipped in 2.1–2.2; 2.3
replaced it with the Song view, see below.)

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

## Omni Song 2.3: songs like GarageBand (round 5)

Asked for after 2.2, by a music maker who compares Omni Song with GarageBand: songs that snap
together and are easy to move and lengthen, a keyboard where every key can be pressed, part buttons
that do not just restart the parts, a Pause, and "Nothing feels obvious or intuitive at all." Built in
six slices on `r5-int` (from the 2.2 release, `3464535`); this round ships as **version 2.3.0**.
Contract for the song: schema v4 (regions per part on an absolute timeline, sections). Interface
rules: `docs/OMNI_UX.md`; contracts: `docs/ARCHITECTURE.md`; checks: `docs/ACCEPTANCE.md`.

| Slice | Final commit | What it delivered | Key measurements (from the slice reports) |
|------|------|------|------|
| spine | `73fda99` (on the integrator's types and pure rules, `802e210`) | Schema v4: the song is loops (regions) on a row per part on one timeline of whole bars, plus named sections carrying the song moves; `src/project/arrangement.ts` holds the rules (placed wins: what a loop lands on is cut short, started later in phase, split or removed). Migration v3→v4 (each block a section, what each part played a loop, joined where it plays on in phase; deterministic). Validation of loops and sections in plain words (4000 loops, 256 sections, 512 bars). Song commands rewritten, each one undo step in the user's words ("Move Four Floor"). The song follows clip edits in the same undo step (`keepSongWithClips`). Starters built by the migration's rule; library and version lines speak of sections | Song fuzz: 3000 random steps (6 seeds × 500) on House, the song valid after every step, undo / redo exact. Every 2.2 starter song (and an edited one) migrates to the same clip at the same bar and phase, bar by bar |
| engine | `c2f6f7f` | Song mode plays the loops on an absolute timeline through passes; a loop range in bars that repeats seamlessly; edits while playing or paused act from the edit point, in phase, and never move the playhead; song moves from sections; session API (`playSong`, `seekSong`, `setSongCursor`, `setSongLoop`, `togglePlay({song})`), Stop puts the cursor back where playback started; `src/app/songPlayback.ts`; Record Notes into the loop under the playhead; Song and Loop export sources; the tab reads "Song"; relaunching a playing clip keeps it in phase | 4000-loop song: `process()` 0.04 ms median; `songPlayChanged` 0.003 ms; replan with regeneration 1.7 ms median, 3.4 ms p95. Live-edit fuzz: 60 seeds, and 60 with loops |
| lane | `be57649` | The Song view like GarageBand's Tracks area: one header row (length, Loop, − Fit +, Follow, Loops), the ruler (playhead, loop range), the Sections strip with its menu (moves, Build up / Strip down / Breakdown), a row per part with Mute and Solo, loops drawn with their notes; move, copy, stretch and trim snapping to bars with the drop's result shown while dragging; marquee, keys and menus; the loop browser (scenes, loops by part, audition); one button for an empty song; "Put in the song" for takes; Song hints and Help keys | 150 loops on screen at 1366 × 768, 2 s drags: p50 16.7 ms, p95 16.7–16.8 ms, max 16.8 ms, 0 frames over 20 ms; 0 DOM mutations to other loops |
| keys | `ed65caf` | With Musical Assist on, a scale keyboard: only the key's notes as one row of even keys, every key its own note, spelled by the key, roots by octave and a teal underline, A–' and Q–] computer keys; on the piano the black keys are centred (60 % wide, 55 % tall); keys are buttons named by their note; a held key is released when the layout changes | At 1366 px: Simple 20 keys of 45.2 px, Advanced 16 of 44.8 px; 34.2 px of every white key below the black keys |
| pads | `abe33e3` | Pads say what a click does (▶ Play / ■ Stop) on hover and focus; "Stops at bar N"; the part key in words (Play / Stop / Cancel / Skip); ❚❚ Pause / ▶ Continue above Stop all; scene buttons Play row / Stop row / Continue row; the playing pad is never started again by a click | The part key's words show in every column or none from 1024 to 1920 px (icon only around 1180 px) |
| update | `3927e85` | A new version opens by itself in every page not in use (`public/sw-takeover.js`, `src/app/pwa.ts`); a page in use is never reloaded and offers Update; a refresh opens a waiting version; the launchers name another version running at the usual address, wait for it, then start this one there; the Welcome card names the version | Takeover e2e: 6 of 6, twice, including the real 2.2.0 release |

Integration changes on `r5-int` (outside any slice): the v4 types and the pure timeline rules with
their tests went in first (`802e210`); the song playback store moved to `src/app/songPlayback.ts`
(`fc5857d`); the Loops pads count a queued change's bar on the song's timeline (`5db6374`); pads
tests follow loops, not blocks (`0d7f5ef`); relaunching the playing clip shows no queued change
(`9a11870`); the resilience e2e follows the song's bar after a stall, the update e2e takes an
absolute `E2E_DIST`, the versions test keeps its versions minutes apart, and summaries say sections
(`9229b1d`); version 2.3.0 with What's new and START HERE (`1089b52`).

**Reviews and fix rounds.** Two independent reviews ran on the merged build (`09d8b1f`):
- A GarageBand user's review with real mouse and keyboard (1 blocker, 6 major, 13 minor, polish).
  Fixed in the lane fix round (`a1a5e30`) and a shell fix round (`facfcbb`): deleting every loop
  leaves an empty song (Ctrl+A selects loops and sections; the song now ends with its last loop,
  `songBars` vs `timelineBars`, `3cc3e69`); Song shortcuts act on the selection after any click;
  Delete stops after one press; the hint chip stays readable; Ctrl+drag copies exactly what it drags;
  no pick-up or drop hitches (168 loops: longest frame 16.7 ms, was up to 200 ms); bigger hit areas;
  sticky names; zoom around the playhead; Stop brings the cursor into view; paused reads as paused;
  **Shape the song…** (Add an intro / Add an ending) is back; "Loops" became **Add loops**; a click on
  a part's header or loop makes it the part the keys play, and the keyboard strip names it ("Keys
  play Bass"); in Song, Play/Space plays the song even when paused pads were waiting; scene buttons
  say Play row / Stop row on hover; the Drums and Notes tabs go straight to a part's pads.
- A playback-correctness review (160 random songs, about 19,000 live edits, 600 loop/tempo/swing
  runs, 40 exports, 379,075 migrated notes, all matching). Fixed in the engine fix round (`b5ba28d`):
  **note chase** (a held synth or bass note sounds from wherever playback enters: Play, a seek, each
  loop pass, Resume, a loop-range export; never drums or samplers; not under a 16th), exact loop
  seams in whole ticks, a song shortened under a sounding note releases it at the new end on the
  audio clock, notes freed from a removed seam sound again from that bar line, exact-instant pause
  and loop boundaries, pad state read at the playhead. Spine fix round (`5a72a08`): truthful repair
  words; a refused song edit names no loops.

**Not done, or worth knowing:**
- No control inserts or removes bars on their own (`insertBars`, `removeBars` exist and are tested;
  sections' Duplicate and Delete-with-music use them).
- "Back to Song" after a double-click into a loop's notes is a 20 s toast, not a key in the Steps
  header.
- Ctrl+T also splits, but browsers keep it for a new tab, so Help lists Ctrl+E.
- On non-US keyboard layouts the scale keyboard's I, [ and ] keys show their US legends.
- Paused clip pads keep the amber "queued" look (they say "Paused" in words).
- A seek while the song plays restarts the transport at that bar (the usual 50 ms start offset);
  runtime `songLooping` can be up to a beat late after a jump.
- Toasts that arrive while the Song header is full sit over part of it until they time out.
- Touch was tried with CDP touch events, not on a real tablet; the Windows launcher's version check
  ran under PowerShell 7 on Linux only.

**Test runs.** The slices ran on a shared, loaded machine (load averages 15 to 32 on 4 CPUs);
timing tests (`drumSynth`, `variation`, `r4-notes-variation`, `validate`, live-pad timing in
`wp1-session`, `wp2-notes-recording`, `export-while-playing`) failed under load in some runs and
passed alone. Final test runs: see TEST_REPORT.md.

## Omni Song 2.4: loops of the song's own, a loop library, first steps (round 6)

Asked for after 2.3: "keep improving… make no mistakes. make it more useful and easier to use and
have more features", by a music maker who compares Omni Song with GarageBand. Two audits of the 2.3
build (ease of use, features; real mouse and keyboard at 1366 × 768 and 1920 × 1080) set the work.
Built in slices on `r6-int`; this round ships as **version 2.4.0**. Contract: schema v5
(`Track.songClips`: loops only the song plays, addressed by song slots ≥ 100; v4 files open unchanged).

| Slice | Commit | What it delivered |
|------|------|------|
| spine | `9a3651a`, `44fab8b` | Schema v5 types, `src/project/clips.ts` slot helpers (pads and song), migration step 4→5, the command scaffold |
| clipsmodel | `d5f9f1a` | Song clips: validation, every clip command on song slots (pad-only ones refuse in words), `addLoopToSong`, `makeLoopUnique`, `copyLoopToPad`, `recordTakeIntoSong`, orphan song clips removed in the same undo step |
| clipsengine | `8496f5a`, `71eda33` | Song clips play, chase, export and follow slot shifts; Record in the Song view records into the song (a live "Recording…" region, one undo step "Record <Part>") |
| content | `28ce8ab` | Loop library (164 original loops, 15 styles, realised in the song's key), 52 beat presets, five beat-maker starters (Trap, Lo-fi Hip Hop, Pop, Afrobeats, Boom Bap), four new sounds |
| laneedit | `44e6fba` | Part headers with volume, pan, meter and menu; insert/remove bars from the ruler; sections reorder by drag (ripple), Alt places freely, Ctrl copies; gentler drags; zoom kept per project |
| editor | `100f920` | The loop editor docked under the song (double-click, E, Esc); short loops' bars side by side; bigger targets; Simple drums show the eight main sounds |
| lanelib | `86f3820` | The loop browser's Library tab (search, part and style chips, ▶ hear once in key on the audio clock), drag or Enter a library loop in, Make this one different, Put on a pad, New empty loop, Start from a beat…, Move earlier / later |
| export | `e131f01` | Export: the whole song by default, "Make it as loud as streaming songs", WAV, a smaller file (Opus in Ogg), parts as separate files, MIDI; Simple Mix ("Finish") and Simple Shape trimmed |
| start | `3af8b2e` | Make a beat from scratch, Start from a beat…, tap an empty pad for a loop, ● Record into the song, the project name in the transport, loops named after their part, toasts clear of the guide and hints, mood words for keys and starters |
| glue | `3f6a5d3` | Empty-song card, the scenes → song offer, library carries auto-scroll, takes named "<Part> take N", hand-offs |
| fix1 | `7f34424` | Code review fixes: a take quantized once, a take's region covers only what was recorded, cut/paste keeps song loops, a cancelled loud export changes nothing (loudness matched for the song and performances only), song loops counted everywhere a part's loops are read, MIDI/parts skip notes the kit cannot play |
| fix2 | `3297268` | Hands-on review fixes: Space always plays/pauses (Enter edits a grid), the editor pane takes focus, the recording readout is whole, one toast place clear of working areas, "Used 2×" badges, hints for the visible editor only, "My beat" projects, beat tempo set only for a fresh beat, "clip" → "loop" in 148 UI strings, theory words in Simple, an opened project returns to the last view, a wider keyboard in Steps and Shape |

**Reviews.** A code-correctness review (4 major, 3 minor, each with a failing test) and a hands-on
review as a GarageBand user (3 major, 13 minor) ran on the merged build; every finding was fixed
(fix1, fix2) with regression tests. The r4-play-fixes whole-file failure on newer Chrome was a test
that wrapped `window.scrollTo` in `act()`, which left React's act queue open (`39a1c64`).

**Not done, or worth knowing:**
- No click only while recording (the metronome is one on/off setting); the count-in is on by default.
- Undo history does not survive a reload; starter cards have no preview; Play's pads and the song
  are still two ways to play (the Song view says which one is playing).
- The Steps loop switcher still lists the pad rows by scene name.
- A loud export renders twice when the song is not at the target yet.
- MIDI files leave out arpeggiator output; parts files skip the mastering (the limiter stays).

## Omni Song 3.0 "one song screen" (round 7)

Asked for after 2.4: "make navigation simpler and make it so an idiot could use it." Design Option A:
in Simple (the default) the Song screen is the one home; the other 2.4 views open from it as sheets
("← Back to my song"); Advanced (⋯ › Show every control) keeps 2.4 exactly. Built in slices on `r7-int`;
this round ships as **version 3.0.0**.

| Slice | Commit | What it delivered |
|------|------|------|
| scaffold | `2474834` | Side panel store, Sound panel and Share dialog placeholders |
| share | `120b258` | Share dialog: a music file (Sound chips, "as loud as streaming songs" on the file only, WAV / .ogg / instruments / notes, one section) or the project `.omnisong.zip`; Advanced Export no longer changes the song's loudness |
| editsound | `ba64e09`, `b792ce5` | Editor under the song: Draw \| Play, Record into this loop, Try a ready-made beat / loop…, Shorter / Longer, Make it different, "Plays 2 places · Just here"; the Sound panel (Change sound…, Volume, Mute, Hear it alone, six big knobs, Every setting ▸) |
| songhome | `36d26ad`, `38837cd` | Song screen as the home: "Your song · 2:19", Repeat this part, Make it longer (plain unique part names), + Add instrument, rows only for instruments with music, single click opens a loop, the tip line |
| shell | `f588039` | Simple top bar (Project ▾, Play/Pause, Stop, Record, Undo/Redo, Share, ⋯), sheets with Esc/Back, Project ▾ Speed / Mood / Rename, Jump In repeating the starter's main part, Make a beat opening its empty loop |
| intfix | `f7fb4b4` | Merge fixes: the tip line asks for sounds in an empty loop before suggesting a bass; Simple's home shows only the tip line (no floating "Try this" chip as well); tests re-aimed where the slices' assumptions collided (Simple vs Advanced test helpers) |
| fix1 | `dce9de2` | Beginner re-test fixes: Repeat this part follows the music an edit moves (edits report their time shifts; Undo/Redo too) or goes off with a word; Make it longer builds around the main part (most music per bar), names unsectioned music, fills a 1-bar beat to 8 bars, new parts in order before the ending (3 presses ≈ 1 min); a ready-made loop/beat plays through in the song and names the block; no cross-view buttons or "Try this" chip in Simple's sheets; tip line beat → bass → chords → longer → share (≥ 45 s, 3 instruments), "Click a loop to change it" on an untouched starter; + Add instrument over the main parts; editor and Sound panel follow the instrument |
| fix2a | `f54f78d`, `490c884` | Review + third beginner test, behaviour: a single click opens a loop only after the double-click time (a double-click never edits it; the pane ignores the second press); editor Longer makes the song play the whole loop; Make it longer turns repeat off and moves the playhead to what it added (playing now / next Play, said), offers an intro or ending only while there is none, a second intro reads left to right; Make it shorter (the last section / the one playing); Stop goes to the song's start in Simple; Undo brings back a repeat an edit turned off; a stretch inside a moved section follows it; LOOPS drops snap to section starts (Alt: the bar); + Add instrument unmutes, says a solo, leaves a repeat that hides it, refused while recording; tip line: hear the whole song after Jump In, no dead-end steps, Loops closed said, ideas after Share, What next? with tips hidden, memory per project; Share offers no silent file; Help names E |
| words | `e0cc467`, `96bae32` | Plain words in Simple: times not bars, "section" not "part", instrument names from the picker, mood words, no note names; Help "How it works" and Simple's keys; the tip line is the guide (the "Try this" chip is Advanced's); GUIDE, README and START HERE for 3.0 |
| merge2 | `5e17895` | fix1 merged into the words slice: fix1's behaviour in the words' vocabulary (tip steps "press + Add instrument, then Bass", "Add a section after Verse", repeat names "Verse to Chorus" / "the marked stretch", "What you were repeating is gone…") |
| e2e | `11b29dc` | Playwright specs for 3.0 (57 → 79 tests, all pass against the production build): journey.spec is Simple's beginner journey (Make a beat → squares heard → + Add instrument Bass → Make it longer → Share a WAV, the file checked; Share leaves the song alone; Stop goes to the start); 2.4's pads journey is advanced.spec; the a11y spec tours Simple's home keyboard-only and audits the song screen, editor, Sound panel, Share and sheets with axe, keeping the Advanced checks; persistence, two tabs, toasts, first keys, renders, stall and resilience run in both modes where both apply. App fixes: Enter on a button inside the song timeline (an instrument's name, Mute, Add a section) pressed nothing and moved the playhead home; it now presses the button. A recording imported in Simple, and a loop moved between pads, are said with the instrument's Simple name ("Keys & chords · Intro", as the sampler editor shows it). Browser tests left on 2.4 names by fix 2b pinned to their mode (notespads, samplerui, parts: Simple; r4-core-import-clip: Advanced) |
| fix2b | `7e905cf`, `105c5da` | Review + third beginner test, words: instrument names everywhere in Simple (a renamed instrument keeps its name), plain refusals, version 3.0.0 (What's new, README, START HERE) |
| badge | `d268974` | A loop used in several places says "3 places" on the song (the longer "Plays 3 places" was cut off on short loops); the editor still says "Plays 3 places" |

**How it was checked.** A person new to music software was simulated three times against real
builds (mouse and keyboard, 1366 × 768): on 2.4 they gave up at the second task (about 82 clicks,
10 confusing moments); on the first 3.0 build they finished every task in about 27 clicks with one
confusing moment; on the third, the from-scratch path took about 23 clicks and none. A code review
(4 major, 14 minor) ran on the merged build. Every finding from those runs was fixed in fix1,
fix2a and fix2b, with tests.

**Not done, or worth knowing:**
- In Simple a toast covers the tip line for a few seconds; that toast's button still says
  "Export project file" where Simple's own word is "Save a copy to my computer".
- Simple row labels for Solo read "solo" / "not soloed".
- A few refusals still say "pad" or a stored part name (for example "No empty pad on Sampler…").
- 2.4's remaining items (above) still hold in Advanced.

## State at handoff

- Release package: `npm run package` builds `release/omni-song-<version>.zip` (production
  build in `app/` (3.0.0 now), `Start Omni Song.bat`, `START HERE.txt`, `launcher/`, `ASSETS.md`, and the
  repository source in `source/`). `release/omni-song-2.2.0.zip` is in the repository (the update
  e2e opens it as the real older version); older zips stay in git history (2.0 is on `main`).
- Evidence: `TEST_REPORT.md` (results and measurements), `docs/ACCEPTANCE.md` (every requirement of
  the brief with its evidence), `docs/screenshots/`, `evidence/wav/`, `evidence/launcher-smoke.txt`.
- Guides: `docs/GUIDE.md` (first loop; chords and keys; notes and drum steps; shaping sounds;
  building a song in the Song view; record, mix, master and export; keeping work safe; MIDI
  keyboard; recording your voice or guitar).
- At the 2.1 handoff: typecheck clean; unit 1106, browser 1085, e2e 25 tests pass. The latest
  results (2.3) are in `TEST_REPORT.md`.
- Remaining work is local only: listening, physical latency, a real MIDI keyboard and microphone,
  the Windows launcher on Windows, Chrome/Edge on Windows, real background-tab throttling (see
  TEST_REPORT.md).

## Next action

For local verification: extract `release/omni-song-3.0.0.zip` on Windows, double-click `Start Omni
Song.bat` (with a 2.4 window still open, it should name it and wait), press Jump In or Make a beat,
click a loop to change it, press + Add instrument and Make it longer, then Share, with a mouse or trackpad. Possible next steps are in
`docs/ROADMAP.md` (local music-generator bridge, webcam movement control, WebXR, and the items
rounds 4 and 5 deferred).

## Known limitations / environment notes

- Cloud container: 4 CPUs, Chromium 141 (Playwright 1.56.1) preinstalled; no Windows host, so
  the Windows launcher was exercised under PowerShell 7 on Linux only (`evidence/launcher-smoke.txt`).
- No listening test is possible in the cloud; audio is verified by offline renders and signal
  measurements only.
