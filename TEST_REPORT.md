# TEST REPORT — Omni Song 2.1

_Formerly SWITCHBOARD / 01. Test results and evidence for the 2.1 build (2.0 plus the song
timeline). Every requirement of the original brief, and the 2.0 and 2.1 additions, is listed with
its evidence in [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)._

## How to reproduce

```bash
npm install
npm run typecheck
npm test                              # unit (Node)
npm run test:browser                  # real Chromium, incl. offline renders through the real engine
npm run build && npm run test:e2e     # Playwright against the production build
node scripts/evidence.mjs             # screenshots + WAV examples (needs `npm run serve` running)
npm run package                       # build, then release/omni-song-<version>.zip
```

## Results

Run in the cloud container (Linux, 4 CPUs, Chromium 141 via Playwright 1.56.1, Node 22) on the
2.1 handoff commit:

| Suite | Files | Tests | Result |
|-------|-------|-------|--------|
| Typecheck (`tsc --noEmit`, app + tests) | — | — | clean |
| Unit (`tests/unit`, Node) | 49 | 1106 | all pass |
| Browser (`tests/browser`, real Chromium) | 85 | 1085 | all pass, none skipped |
| End-to-end (`e2e`, production build) | 8 | 25 | all pass |

Two timing-sensitive tests (`omni-input-audio` early stop, `variation` "stays fast") each failed
once while the machine was saturated by parallel runs and pass on their own and in the full runs
above; they compare against wall-clock time, which the audio clock can lag under heavy load. In
the 2.1 work, `omni-fix-space-keys` failed in one full run because a view remembered in
localStorage by an earlier test file opened Shape instead of Play; the test now sets its starting
view (an isolation fix in the test, not an app change).

## What kinds of evidence exist

| Kind | What it is | Where |
|------|------------|-------|
| Automated signal checks | Offline renders through the **real** engine (the same code path as WAV export), measured numerically: onsets, spectra, RMS, peaks, tails, loudness (LUFS), stereo correlation | `tests/browser/realEngine`, `starters`, `presets`, `effects`, `fx-*`, `reverb`, `engine*`, `drumKit`, `synths`, `sampler`, `offline`, `omni-fx-*`, `omni-mastering-*`, `omni-sounds-*` |
| Logic checks | Sequencer timing, swing, tempo, launch quantization, pause/resume, arrangement, replay, graph validation, undo/redo, undo groups and entry ids, validation, schema v1→v2 migration, persistence, bundles (incl. old `.sb01.zip`), WAV encoding, import limits, loudness maths, MIDI, sample edits, launcher, package | `tests/unit/*.test.ts` |
| Browser interaction checks | Components and the whole app in real Chromium (pointer, keyboard, layout at 1024–1920 px and 960×540); Playwright driving the production build: fresh profiles, downloads, storage failures, offline, stalls, 3-minute runs, keyboard-only use, axe-core audits, MIDI with a fake MIDIAccess, audio input from a generated stream | `tests/browser/*`, `e2e/*.spec.ts` |
| Independent reviews | Before handoff, five area audits of every brief requirement (45 gaps, all fixed), then a correctness review (5 defects, reproduced, fixed with regression tests) and a hands-on usability/accessibility review of the real app (13 problems, fixed) | `docs/ACCEPTANCE.md`, git history |
| Launcher smoke test | The 2.1 release zip extracted to a path with spaces, served by `launcher/serve.ps1` (PowerShell 7) as `Start Omni Song.bat` does; loopback binding, traversal refusal, reuse of a running copy, Jump In playing from the package, a song block dragged with the mouse and undone | `evidence/launcher-smoke.txt` |
| Listening review | **None.** The cloud environment has no speakers. Nothing here claims musical quality or low physical latency from sample values. | — |
| Local hardware checks | Still to be done on the user's Windows PC (see the end). | — |

## Acceptance evidence (PRODUCT_BRIEF §11)

| # | Requirement | Status | Evidence |
|---|-------------|--------|----------|
| 1 | Fresh session reaches an audible starter groove through Jump In | ✅ | `e2e/journey.spec.ts` (fresh profile, Jump In, master RMS > 0.01, peak ≤ −1 dBFS) |
| 2 | First session needs no cables, imports or theory | ✅ | Jump In loads House with a complete default patch and plays its Groove scene (`journey.spec.ts`); nothing else is required |
| 3 | All 8 starters load; scene transitions aligned; useful controls assigned | ✅ | `tests/unit/starters.test.ts`; every scene of every starter rendered and measured (`tests/browser/starters.test.ts`); launch alignment (`tests/unit/sequencer.test.ts`); macros assigned and measurable (`realEngine.test.ts`) |
| 4 | Queued clip switches at the documented boundary; never overlaps on its track | ✅ | `tests/unit/sequencer.test.ts` (exact bar ticks, no overlap incl. tempo change); `journey.spec.ts` (live switch on tick % 384 = 0, UI told within 1/8 note) |
| 5 | Step editing, note recording, swing and tempo alter scheduled events | ✅ | `tests/unit/sequencer.test.ts`, `commands.test.ts`; `tests/browser/steps.test.ts`, `arp.test.ts`, `wp2-notes-recording.test.ts` (Record Notes into the selected clip, arpeggiator output, count-in); swing onsets measured in `realEngine.test.ts` |
| 6 | Notes stop after blur, cancellation, Stop, Mute All | ✅ | `e2e/notes.spec.ts` (incl. a key held while the part, octave or arpeggiator changes) |
| 7 | Cable rewire changes the rendered signal; undo restores; invalid/cyclic rejected | ✅ | `realEngine.test.ts` (disconnect silences, undo restores bit-exactly; direct patch changes RMS; cycle + incompatible refused, graph and render unchanged); `tests/unit/graph.test.ts`; `e2e/complete.spec.ts` (unplugging in the UI silences the soloed part, Restore Connection brings it back) |
| 8 | Effects and macros produce measurable changes in a controlled fixture | ✅ | `realEngine.test.ts` (Tone centroid ×1.5, Space tail ×10, Echo ×5, Motion centroid variance, Drive HF ×1.5, Pump beat ducking); `effects.test.ts` per effect; `engine-modulation.test.ts` (LFO Off stops modulation); `presets.test.ts` (Tone moves every preset's centroid by > ×1.8) |
| 9 | Recorded notes, scene launches, knob changes replay in performance and WAV | ✅ | `tests/unit/replay.test.ts`, `offline.test.ts`, `realEngine.test.ts` (timed mute); `journey.spec.ts` (take with notes + scene exported); `wp2-notes-recording.test.ts` (undo/redo during a take recorded and replayed; held keys and a latched arpeggio at the take start are in it; Mute All ends a take) |
| 10 | Exported WAVs: format, duration, finite, non-silent, within ceiling | ✅ | `journey.spec.ts` (48 kHz / 16-bit / stereo, duration = plan ± 10 ms, peak ≤ −1 dBFS); `tests/unit/wav.test.ts` |
| 11 | Impulse/timing fixture: rendered onset positions over multiple bars | ✅ | `realEngine.test.ts`: 16 rim hits over 4 bars within 0.5 ms of schedule (+ the constant engine latency), jitter < 0.2 ms |
| 12 | Custom-sample project survives export → fresh-profile import → second render | ✅ | `e2e/persistence.spec.ts` (musical state identical, render RMS within 1 %) |
| 13 | Autosave errors and unsupported imports show recovery paths | ✅ | `e2e/persistence.spec.ts` (quota error → "Not saved", Try again, Export project file); `tests/browser/library.test.ts` (a starter never silently replaces unsaved edits; recovery export reports success/failure); `tests/unit/audioImport.test.ts` (type, size, length refused before decoding, with actionable messages) |
| 14 | Cached build reopens and plays offline | ✅ | `e2e/resilience.spec.ts` (service worker, network off, starter plays; "Offline ready" shown in the transport) |
| 15 | Repeated Play/Stop and minutes of playback: no accumulation, runaway gain, errors or drift | ✅ | `e2e/resilience.spec.ts` (25× Play/Stop; 3 min playback: position tracks the audio clock to < 2 ticks, voices bounded, peak ≤ ceiling, no page errors) |
| 16 | Mouse and keyboard reach essential controls; readable labels and focus | ✅ | `e2e/a11y.spec.ts`: keyboard-only journey; Tab tours of Play, Shape and Arrange (every stop named, visible focus ring checked by screenshot diff); axe-core (WCAG 2.1 A/AA) with no serious/critical violations on Welcome, Play (4 modes), Shape, Arrange; 200 % zoom keeps Mute All on screen |
| 17 | Screenshots at target sizes incl. Play, Steps, cable panel | ✅ | `docs/screenshots/` — see below |
| — | Definition of done (§12): launch, play a starter, change sounds, Variation, a working cable connection, record, export, reopen the editable project | ✅ | `e2e/journey.spec.ts` + `e2e/complete.spec.ts` (sound change, Variation + undo, audible cable edit, reload → Continue → still editable) |

## Omni Song 2.0 additions

| Feature | Status | Evidence |
|---|---|---|
| Pause / Resume (holds bar, beat and every clip's phase; no backlog), Stop to bar 1, Space / Shift+Space after any click | ✅ | unit `sequencer` (incl. resume exactness); browser `omni-play-pause`, `omni-fix-space-keys`; e2e `a11y` |
| Simple / Advanced modes; the strip fits 1024–1920 px; Export and Stop labelled at 1366 | ✅ | browser `wp1-transport`, `omni-play-layout` |
| Labelled Mute / Solo, dimmed "Muted" columns, part play/stop, M key | ✅ | browser `omni-play-loops`, `omni-fix-play-pads`; e2e `omni`, `notes` |
| Drag clips (move, swap, Ctrl copy), drag scene rows, keyboard Move…, pad action bar and menu | ✅ | unit `commands` (moveClip, copyClipTo, moveScene); browser `omni-play-loops` |
| 67 synth presets in categories, 15 drum kits; FM, unison, pitch sweep, drift, vibrato; starters unchanged (≤ 0.05 dB) | ✅ | browser `presets`, `omni-sounds-engines`, `omni-sounds-kits`, `starters`; unit `omni-sounds-catalog` |
| Sound browser with categories, search, preview | ✅ | browser `omni-sounds-ui`, `parts` |
| Seven insert effects (EQ, Compressor, Gate, Auto Pan, Stereo Width, Flanger, Tape) measured on the real engine | ✅ | browser `omni-fx-inserts`, `omni-fx-engine` |
| Mastering chain; neutral = bit-identical; presets do what they say; −1 dBFS never exceeded (Loudness +15 on hot material) | ✅ | browser `omni-mastering-chain` |
| EBU R128 loudness (momentary, short-term, integrated, true peak) within 0.1 LU of reference sequences; spectrum | ✅ | unit `omni-fx-loudness`; browser `omni-mastering-chain` |
| Mix view: faders, meters, Mute / Solo / Pan, mastering presets, loudness target + Match, listening-only A/B | ✅ | browser `omni-mix-view`, `omni-mix-session` (A/B ≥ 4 dB on the real output, project untouched), `omni-fix-mix-layout`; unit `omni-mix-mastering` |
| Simple Shape (big knobs, instrument card, effect cards whose knob always changes the sound, grouped Add effect); Advanced rack with drag reorder | ✅ | browser `omni-shape-simple`, `omni-shape-advanced`, `omni-fix-shape-cards`, `shape` |
| MIDI keyboards (velocity, sustain, pitch bend, mod wheel, learn, GM drum map; no stuck notes) | ✅ | browser `omni-input-midi` (fake MIDIAccess, real session); unit `omni-fix-midi-*` |
| Record audio (count-in, bars on the audio clock, latency compensation, one undo step) and recording edits (Normalize, Reverse, Crop, Fades, Gain) | ✅ | browser `omni-input-audio` (beats within one sample), `omni-input-ui`, `omni-fix-audio-take`; unit `omni-input-edits`, `omni-fix-gain-clip` |
| Rename to Omni Song with old projects, settings and `.sb01.zip` files still working | ✅ | unit `omni-rename-*`, `bundle`, `validate` (v1 → v2); browser `library`; e2e `omni` |
| "Try this" hints that follow real actions, never cover controls; updated quick guide | ✅ | browser `omni-hints-*`, `omni-fix-play-hints`, `guide`; e2e `omni` |
| Undo toasts tied to their own step; "Undid / Redid" feedback | ✅ | browser `omni-fix-undo-toast`; unit `omni-fix-history-ids` |

## Omni Song 2.1 additions: the song timeline

| Feature | Status | Evidence |
|---|---|---|
| Song blocks with names and per-part changes (a part layered in from another scene, or switched off, in one block); 1–16 passes; validation drops dangling changes | ✅ | unit `song-blocks` (commands, validation, plan lengths) |
| Group commands, each one undo step: move, duplicate, paste, remove, split, join, layer (fill or replace), reset parts, rename | ✅ | unit `song-blocks`, `song-lane` |
| Per-part changes play, live and in exports (same sequencer) | ✅ | unit `song-live`; browser `song-live` (offline render energy per block) |
| Edits apply while the song plays or is paused, re-planned from the playing block; splits/joins change nothing audible; deleting the playing block hands over at the next bar; changes to the playing block's parts apply at once, in phase | ✅ | unit `song-live`, `song-live-edits`, `song-live-fuzz` (seeded random edit sequences: launches on bar lines or edit points, one clip per part, no doubled notes, exactly one end, lane playhead inside the lane and monotonic); browser `song-live`, `song-live-edits` (real session) |
| Play from a bar; transport readout and lane playhead follow the song timeline | ✅ | unit `song-live`; browser `song-live` |
| Song lane: drag with live slot opening and a settle, Ctrl/Alt copy, edge drag for passes, split/join, multi-select, clipboard, rename, part cells and picker, scene cards layer or insert, ruler play-from-bar, Follow, zoom/Fit song, locked during a take | ✅ | unit `song-lane` (pure gesture logic); browser `song-lane` (real pointer input), `song-lane-touch` (real touch and pen input via CDP), `song-lane-layout` (1366×768, 1920×1080, 960×540 at 2×, long song, reduced motion, axe), `arrange` |
| Loops pads and scene rows: lifted pad follows the pointer, swap/replace/refusal previews, settle, scene-row slot | ✅ | browser `omni-pad-drag` (real mouse, keyboard and touch via CDP), `omni-pad-drag-layout`, `omni-pad-drag-motion`, `omni-play-loops` |
| Independent reviews | ✅ | hands-on UX review with frame timing in Chromium (P1/P2 findings fixed; see below); adversarial correctness review (5 defects reproduced with failing tests, fixed, regression-tested) |

Frame timing of drags (headless Chromium without a GPU, so paint costs are pessimistic; "late" =
frame over 20 ms). Song lane, 6 blocks, 2 s drag: 4 late of 314 frames, no long frames at normal
speed. 24 blocks with edge auto-scroll at 4× CPU slowdown: 30.5 % / 11.2 % late frames before the
fix round, 6.8 % / 9.3 % after (two back-to-back rounds; main-thread CPU per drag −19 %). Pad drag at
normal speed: 13 late of 1208 frames before, 0 of 1110 after. The drop of a block still costs one
long frame of about 90–140 ms at 4× (React commit + style/layout); at normal speed it stays under
about 70 ms. These are machine measurements, not a listening or feel test.

### Rounds 2 and 3 (still 2.1, before merging)

| Feature | Status | Evidence |
|---|---|---|
| Loop a section: Loop button (names its target), a band on the ruler (drag across the bar numbers, drag its ends), block-menu items; seamless repeats; Play song starts at the loop; edits, pause/resume and undo/redo keep the loop right; "looping" is said only while it repeats | ✅ | unit `song-loop`, `song-loop-history`, `song-live-fuzz` (random loop set/clear among live edits); browser `song-loop`, `song-lane-loop`, `song-live-session` |
| Build up / Strip down / Breakdown, one undo step each, never changing the song's length (refused with a reason when clips would not line up); on the playing block they play what the lane shows | ✅ | unit `song-blocks`, `song-live-helpers`; browser `song-lane-loop`, `song-lane-polish` |
| Touch: rest a finger to pick up a block or scene card, swipe to scroll | ✅ | browser `song-lane-touch` (real touch via CDP) |
| One Play per screen: in Arrange the transport Play/Space, Stop and Export act on the song; export of the looped section; playback carries on through an export | ✅ | browser `omni-play-song-key`, `export-dialog`, `export-range`, `export-while-playing`; unit/browser `offline` (range render sample-exact against the full song) |
| No empty undo steps from gestures that end where they started; no Undo offered for them | ✅ | unit `store`; browser `song-lane-polish` |
| Lane polish: Fit song never zooms in, compact headers for long songs, rows that use the free height, collapsed empty Performances, Follow that never turns the page under the pointer, edge drags that scroll only past the lane edge, focus kept after undo, calmer "Off" cells, visible edge grips and loop grips, plain words | ✅ | unit `song-lane`, `song-lane-loop`; browser `song-lane-polish`, `song-lane-layout`, `arrange` |
| App polish: toggles keep their "on" look under the pointer (≥ 4.5:1 text), menus never cover their trigger (a second click closes, no double-click activation, Ctrl+Z works in menus), tooltips wait for pointer movement, Undo/Redo always on the top bar, Simple · Advanced on the bar from 1366 px, readable pad names, no layout shift from Mute/Solo, scene buttons say "4 parts" | ✅ | browser `omni-fix-toggles`, `clipmenu-popover`, `tooltip-still-pointer`, `wp1-transport`, `wp1-transport-history`, `omni-fix-play-pads`, `ui` |

Drop of a song block, 24 blocks, 4× CPU slowdown, built app (machine measurement, not a feel test):
the long frame went from 90–140 ms (first version) to a median of 57–75 ms; release to drop drawn
from ~150 ms to 72–107 ms. A replan deferred past the paint was tried and measured worse overall,
so the replan stays in the edit's own task.

## Audio measurements (automated, not listening)

### Timing
- 4 bars of rim hits at 120 BPM: every onset = scheduled time + a constant **7.65 ms** (367 frames at
  48 kHz), identical for every hit (spread < 0.2 ms). The constant is the master limiter's 5 ms
  look-ahead plus the Drive stage's 2× oversampling delay. It is the same live and in exports, so
  it never changes the timing between sounds; Record Notes compensates for it.
- Swing 100 %: off-beat 16ths land exactly one third of a step late; on-beats unchanged.

### Starter levels (4 bars per scene, 44.1 kHz, as shipped)

| Starter | BPM | Key | Scene 1 | Scene 2 (core groove) | Scene 3 | Scene 4 |
|---------|-----|-----|---------|------------------------|---------|---------|
| House | 124 | G dorian | Intro −30.7 / −13.3 | Groove −19.3 / −5.7 | Lift −18.0 / −1.3 | Break −25.2 / −9.5 |
| Synthwave | 100 | D minor | Intro −30.3 / −14.3 | Cruise −20.6 / −5.5 | Chorus −19.3 / −3.7 | Breakdown −23.0 / −9.1 |
| Ambient | 72 | E lydian | Float −26.9 / −8.4 | Pulse −21.6 / −6.2 | Bloom −20.2 / −4.0 | Drift −22.6 / −6.9 |
| Techno | 128 | F phrygian | Intro −30.1 / −5.9 | Groove −18.7 / −3.5 | Peak −16.9 / −2.3 | Breakdown −20.2 / −5.8 |
| Breakbeat | 132 | B minor | Intro −27.9 / −8.1 | Groove −19.7 / −3.8 | Drop −17.8 / −2.1 | Break −22.9 / −9.1 |
| Drum and Bass | 174 | C# minor | Intro −28.8 / −10.7 | Roll −20.0 / −4.3 | Drop −18.5 / −3.3 | Float −22.6 / −9.2 |
| Downtempo | 84 | Eb major | Intro −31.9 / −13.1 | Sway −21.3 / −4.5 | Lift −20.2 / −4.0 | Haze −23.6 / −10.0 |
| Garage | 136 | A minor | Intro −30.3 / −11.4 | Two-Step −20.5 / −1.6 | Lift −18.5 / −1.0 | Break −24.3 / −6.0 |

Values are RMS (steady part, after the first bar) / sample peak, in dBFS. Core grooves sit between
−18.7 and −21.6 dBFS RMS; the limiter (ceiling −1 dBFS) only touches the loudest peaks of the
fullest scenes (< 1 % of samples, asserted for every scene in `tests/browser/starters.test.ts`).
Intros are deliberately sparse and quieter. The Milestone 5 sound fixes (kit level matching, choke
groups, one-shot playback) moved no scene by more than 0.06 dB.

### Determinism
Two renders of the same project differ by at most ~1e-6 (below −100 dBFS): Chromium sums a node's
inputs in an unspecified order, so float rounding can differ in the last bits. Single-voice paths
render bit-identically (cable undo test).

## Screenshots (`docs/screenshots/`, production build, real audio running)

| Size | Files |
|------|-------|
| 1366 × 768 | `01-welcome`, `02-play-loops`, `03-play-queued`, `04-play-drums`, `04-play-notes`, `04-play-steps`, `05-shape-cables`, `06-arrange`, `07-play-cables-drawer`, `08-shape-cable-panel`, `09-shape-sampler`, `13-sound-browser`, `14-project-library`, `16-shape-simple`, `17-mix`, `18-mix-mastering-warm`, `22-arrange-song-playing` (Drums off in block 2), `23-arrange-drag` (a block mid-drag, the others making room), `24-play-pad-drag` (a pad mid-drag over a swap) |
| 1920 × 1080 | `10-play`, `11-steps`, `12-shape`, `15-shape-cable-panel` |
| 200 % zoom (960 × 540 CSS px at 2×) | `20-welcome-zoom200`, `21-play-zoom200` |

## WAV examples (`evidence/wav/`, rendered by the app's own export path)

| File | Format | Length | Peak | RMS |
|------|--------|--------|------|-----|
| `house-groove-4bars.wav` | stereo, 44.1 kHz, 16-bit PCM | 9.25 s | −5.7 dBFS | −19.9 dBFS |
| `synthwave-lift-4bars.wav` | stereo, 44.1 kHz, 16-bit PCM | 11.11 s | −3.7 dBFS | −19.2 dBFS |
| `ambient-groove-4bars.wav` | stereo, 44.1 kHz, 16-bit PCM | 14.84 s | −6.2 dBFS | −21.3 dBFS |
| `drum-and-bass-groove-4bars.wav` | stereo, 44.1 kHz, 16-bit PCM | 7.02 s | −4.3 dBFS | −20.6 dBFS |

Each is 4 bars of a starter scene plus a 1.5 s tail, identical in level to the 1.0 renders (neutral
mastering changes nothing). Short, synthesized material only: no user recordings are kept here.

## Known limits

- No listening review (see above).
- Recorded audio takes are at most 4 bars (clips are 1–4 bars).
- MIDI pitch bend is heard live but not recorded into performance takes.
- A performance started while a latched arpeggio already runs replays that pattern from its first
  step (same notes and rhythm; the first notes can come in a different order).
- Sampler tempo sync changes speed and pitch together (labelled); no pitch-preserving stretch.
- Input monitoring goes through its own limiter, not through the mastering chain.
- On a window blur, live sampler one-shots are cut (held notes are released on blur); a replay or
  export of a take plays them through.
- Song lane touch was tested with real touch events sent to Chromium, not on a physical device
  (rest a finger to pick up; a swipe scrolls).
- Exporting while playing: playback is scheduled further ahead while the export starts; a very busy
  computer (over about 2 s of blocking) can still stop playback, and the message then says so.
- In Advanced at 1366 px a narrow playing block's header can shorten "Playing" to "Play…".
- After a split or join in a block whose clips have lengths that do not divide each other (e.g. 3
  bars), the continued block keeps the loop phases that were sounding (nothing audible changes);
  playing that block again from its start can sound slightly different until the next block.

## Remaining local hardware checks (cannot be done in the cloud)

- Listen through real speakers or headphones: starter balance, the new sounds, effects and
  mastering presets, click-free transitions, and song edits made while the song plays.
- Feel of the song lane and pad drags with your own mouse, touchpad or touch screen.
- Physical latency of keyboard, pad and MIDI playing, and the recording offset, on the user's audio
  device and MIDI keyboard.
- A real microphone / audio interface (tests used a generated stream).
- The Windows launcher: double-click `Start Omni Song.bat` (PowerShell 5.1 on Windows 10/11) from a
  folder whose path has spaces; double-click again (it should reuse the running copy); run it while
  another program holds port 4173 (it should explain, then use 4174). Here the same `serve.ps1` ran
  under PowerShell 7 on Linux (`evidence/launcher-smoke.txt`).
- Chrome and Edge on Windows (tests ran in Chromium 141 on Linux), including the Web MIDI
  permission prompt.
- Real background-tab throttling on the user's machine (the stall path is tested by simulation).
