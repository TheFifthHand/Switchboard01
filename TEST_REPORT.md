# TEST REPORT — SWITCHBOARD / 01

_Status: draft, updated at each milestone. Final numbers are filled in at handoff._

## What kinds of evidence exist

| Kind | What it is | Where |
|------|------------|-------|
| Automated signal checks | Offline renders through the **real** engine (same code path as WAV export), measured numerically: onsets, spectra, RMS, peaks, tails | `tests/browser/realEngine.test.ts`, `tests/browser/starters.test.ts`, `tests/browser/effects.test.ts`, `engine*.test.ts`, `drumKit.test.ts`, `synths.test.ts`, `sampler.test.ts`, `offline.test.ts` |
| Logic checks | Sequencer timing, swing, tempo, launch quantization, arrangement, replay, graph validation, undo/redo, validation, persistence, bundles, WAV encoding, DSP | `tests/unit/*.test.ts` (Node) |
| Browser interaction checks | Playwright driving the production build in Chromium: pointer, keyboard, downloads, storage, offline, fresh profiles | `e2e/*.spec.ts` |
| Listening review | **None.** The cloud environment has no speakers; nothing here claims musical quality or low physical latency from sample values alone. | — |
| Local hardware checks | Still to be done on the user's Windows PC (see bottom). | — |

## Acceptance checklist (PRODUCT_BRIEF §11)

| # | Requirement | Status | Evidence |
|---|-------------|--------|----------|
| 1 | Fresh session reaches an audible starter groove through Jump In | ✅ | `e2e/journey.spec.ts` (fresh profile, Jump In, master RMS > 0.01, ≤ ceiling) |
| 2 | First session needs no cables, imports or theory | ✅ | Jump In loads the House starter with a complete default patch and plays its Groove scene; nothing else is required (`journey.spec.ts`) |
| 3 | All 8 starters load; scene transitions aligned; useful controls assigned | ✅ | `tests/unit/starters.test.ts`; every scene rendered by the real engine (`tests/browser/starters.test.ts`); launch alignment in `tests/unit/sequencer.test.ts`; macros assigned + measurable (`realEngine.test.ts`) |
| 4 | Queued clip switches at the documented boundary; never overlaps on its track | ✅ | `tests/unit/sequencer.test.ts` (exact bar ticks, no overlap incl. tempo change); `journey.spec.ts` (live switch lands on tick % 384 = 0, UI told within 1/8 note after) |
| 5 | Step editing, note recording, swing and tempo alter scheduled events | ✅ | `tests/unit/sequencer.test.ts`, `tests/unit/commands.test.ts`; swing onsets measured in `realEngine.test.ts` |
| 6 | Notes stop after blur, cancellation, Stop, Mute All | ✅ | `e2e/notes.spec.ts` |
| 7 | Cable rewire changes the rendered signal; undo restores; invalid/cyclic rejected | ✅ | `realEngine.test.ts` (disconnect silences, undo restores bit-exactly; direct patch changes RMS; cycle + incompatible refused, graph + render unchanged); `tests/unit/graph.test.ts` |
| 8 | Effects and macros produce measurable changes in a controlled fixture | ✅ | `realEngine.test.ts` (Tone centroid ×1.5, Space tail ×10, Echo ×5, Motion centroid variance, Drive HF ratio ×1.5, Pump beat ducking); `effects.test.ts` per effect |
| 9 | Recorded notes, scene launches, knob changes replay in performance and WAV | ✅ | `tests/unit/replay.test.ts`, `offline.test.ts`, `realEngine.test.ts` (timed mute), `journey.spec.ts` (take with notes + scene exported) |
| 10 | Exported WAVs: format, duration, finite, non-silent, within ceiling | ✅ | `journey.spec.ts` (48 kHz / 16-bit / stereo, duration = plan ± 10 ms, peak ≤ −1 dBFS); `tests/unit/wav.test.ts` |
| 11 | Impulse/timing fixture: rendered onset positions over multiple bars | ✅ | `realEngine.test.ts`: 16 rim hits over 4 bars within 0.5 ms of schedule (+ constant engine latency), jitter < 0.2 ms |
| 12 | Custom-sample project survives export → fresh-profile import → second render | ✅ | `e2e/persistence.spec.ts` (musical state identical, render RMS within 1 %) |
| 13 | Autosave errors and unsupported imports show recovery paths | ✅ (autosave) / ⏳ (import UI) | `e2e/persistence.spec.ts` (quota error → "Not saved", Try again, Export project file); import messages in `tests/unit/audioImport.test.ts` |
| 14 | Cached build reopens and plays offline | ✅ | `e2e/resilience.spec.ts` |
| 15 | Repeated Play/Stop and minutes of playback: no accumulation, runaway gain, errors or drift | ✅ | `e2e/resilience.spec.ts` (25× Play/Stop; 3 min playback: position tracks the audio clock to < 2 ticks, voices bounded, peak ≤ ceiling, no page errors) |
| 16 | Mouse and keyboard reach essential controls; readable labels and focus | ⏳ | M5 accessibility pass |
| 17 | Screenshots at target sizes incl. Play, Steps, cable panel | ⏳ | `docs/screenshots/` (M5) |

## Audio measurements (automated, not listening)

### Timing
- 4 bars of rim hits at 120 BPM: every onset = scheduled time + a constant **7.65 ms** (367 frames at
  48 kHz), identical for every hit (spread < 0.2 ms). The constant is the master limiter's 5 ms
  look-ahead plus the Drive stage's 2× oversampling delay. It is the same live and in exports, so
  it never changes the timing between sounds; Record Notes compensates for it.
- Swing 100 %: off-beat 16ths land exactly one third of a step late; on-beats unchanged.

### Starter levels (4 bars per scene, 44.1 kHz, before the +4 dB starter trim)

| Starter | BPM | Key | Scene 1 | Scene 2 (Groove) | Scene 3 | Scene 4 |
|---------|-----|-----|---------|------------------|---------|---------|
| House | 124 | G dorian | Intro −34.7 / −17.3 | Groove −23.3 / −9.7 | Lift −22.0 / −5.3 | Break −29.2 / −13.5 |
| Synthwave | 100 | D minor | Intro −34.3 / −18.3 | Cruise −24.6 / −9.5 | Chorus −23.3 / −7.7 | Breakdown −27.0 / −13.1 |
| Ambient | 72 | E lydian | Float −30.9 / −12.4 | Pulse −25.6 / −10.2 | Bloom −24.2 / −8.0 | Drift −26.6 / −10.9 |
| Techno | 128 | F phrygian | Intro −34.1 / −9.9 | Groove −22.7 / −7.5 | Peak −20.9 / −6.3 | Breakdown −24.2 / −9.8 |
| Breakbeat | 132 | B minor | Intro −31.9 / −12.1 | Groove −23.7 / −7.8 | Drop −21.8 / −6.1 | Break −26.9 / −13.1 |
| Drum and Bass | 174 | C# minor | Intro −32.8 / −14.7 | Roll −24.0 / −8.3 | Drop −22.5 / −7.3 | Float −26.6 / −13.2 |
| Downtempo | 84 | Eb major | Intro −35.9 / −17.1 | Sway −25.3 / −8.5 | Lift −24.2 / −8.0 | Haze −27.6 / −14.0 |
| Garage | 136 | A minor | Intro −34.3 / −15.4 | Two-Step −24.5 / −5.6 | Lift −22.5 / −4.6 | Break −28.3 / −10.0 |

Values are RMS / sample peak in dBFS. All starters were then raised by 4 dB together
(`STARTER_OUTPUT_TRIM_DB`) so grooves play near −20 dBFS RMS; the limiter (ceiling −1 dBFS) only
touches the loudest peaks (< 1 % of samples, asserted per scene).

### Determinism
Two renders of the same project differ by at most ~1e-6 (below −100 dBFS): Chromium sums a node's
inputs in an unspecified order, so float rounding can differ in the last bits. Single-voice paths
render bit-identically (cable undo test).

## Remaining local hardware checks (cannot be done in the cloud)
- Listen through real speakers/headphones: starter balance, sound quality, click-free transitions.
- Physical latency of keyboard/pad playing on the user's Windows audio device.
- The Windows launcher (`Start SWITCHBOARD.bat` → PowerShell 5.1) on Windows 10/11 — the same script
  was exercised with PowerShell 7 on Linux here.
- Chrome and Edge on Windows (tests ran in Chromium 141 on Linux).
- Real background-tab throttling on the user's machine (the stall path is tested by simulation).
