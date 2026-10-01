# TEST REPORT — Omni Song 2.0

_Formerly SWITCHBOARD / 01. Test results and evidence for the 2.0 build. Every requirement of the
original brief, and the 2.0 additions, is listed with its evidence in
[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)._

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
2.0 handoff commit:

| Suite | Files | Tests | Result |
|-------|-------|-------|--------|
| Typecheck (`tsc --noEmit`, app + tests) | — | — | clean |
| Unit (`tests/unit`, Node) | 40 | 909 | all pass |
| Browser (`tests/browser`, real Chromium) | 65 | 925 | all pass, none skipped |
| End-to-end (`e2e`, production build) | 8 | 25 | all pass |

Two timing-sensitive tests (`omni-input-audio` early stop, `variation` "stays fast") each failed
once while the machine was saturated by parallel runs and pass on their own and in the full runs
above; they compare against wall-clock time, which the audio clock can lag under heavy load.

## What kinds of evidence exist

| Kind | What it is | Where |
|------|------------|-------|
| Automated signal checks | Offline renders through the **real** engine (the same code path as WAV export), measured numerically: onsets, spectra, RMS, peaks, tails, loudness (LUFS), stereo correlation | `tests/browser/realEngine`, `starters`, `presets`, `effects`, `fx-*`, `reverb`, `engine*`, `drumKit`, `synths`, `sampler`, `offline`, `omni-fx-*`, `omni-mastering-*`, `omni-sounds-*` |
| Logic checks | Sequencer timing, swing, tempo, launch quantization, pause/resume, arrangement, replay, graph validation, undo/redo, undo groups and entry ids, validation, schema v1→v2 migration, persistence, bundles (incl. old `.sb01.zip`), WAV encoding, import limits, loudness maths, MIDI, sample edits, launcher, package | `tests/unit/*.test.ts` |
| Browser interaction checks | Components and the whole app in real Chromium (pointer, keyboard, layout at 1024–1920 px and 960×540); Playwright driving the production build: fresh profiles, downloads, storage failures, offline, stalls, 3-minute runs, keyboard-only use, axe-core audits, MIDI with a fake MIDIAccess, audio input from a generated stream | `tests/browser/*`, `e2e/*.spec.ts` |
| Independent reviews | Before handoff, five area audits of every brief requirement (45 gaps, all fixed), then a correctness review (5 defects, reproduced, fixed with regression tests) and a hands-on usability/accessibility review of the real app (13 problems, fixed) | `docs/ACCEPTANCE.md`, git history |
| Launcher smoke test | The 2.0 release zip extracted to a path with spaces, served by `launcher/serve.ps1` (PowerShell 7) as `Start Omni Song.bat` does; loopback binding, traversal refusal, reuse of a running copy, Jump In playing from the package | `evidence/launcher-smoke.txt` |
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
| 1366 × 768 | `01-welcome`, `02-play-loops`, `03-play-queued`, `04-play-drums`, `04-play-notes`, `04-play-steps`, `05-shape-cables`, `06-arrange`, `07-play-cables-drawer`, `08-shape-cable-panel`, `09-shape-sampler`, `13-sound-browser`, `14-project-library`, `16-shape-simple`, `17-mix`, `18-mix-mastering-warm` |
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

## Remaining local hardware checks (cannot be done in the cloud)

- Listen through real speakers or headphones: starter balance, the new sounds, effects and
  mastering presets, click-free transitions.
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
