# Acceptance checklist — Omni Song 2.1

_Formerly SWITCHBOARD / 01._ Every requirement of `PRODUCT_BRIEF.md`, section by section, with where
it lives and how it is checked, followed by the Omni Song 2.0 and 2.1 additions. Status: ✅ met and checked · ⚠️ met with a stated limit · ❌ not met.
Evidence kinds: **unit** (Node logic tests), **browser** (Vitest in real Chromium, incl. offline
audio renders through the real engine), **e2e** (Playwright against the production build),
**code** (verified by reading the code in the final audit; no dedicated test).

The Milestone 5 audit (five area auditors, each finding re-checked by an independent reviewer)
confirmed 45 gaps. All were fixed, each fix reviewed independently with tests; rows touched by those
fixes are marked *(M5)*. For 2.0, a correctness review (5 defects) and a hands-on usability and
accessibility review of the real app (13 problems) were also fixed, each with regression tests.
What remains is listed under "Limits" at the end.

## §1 The first minute

| Requirement | Status | Evidence |
|---|---|---|
| Real instrument visible behind a prominent Jump In with "Start with a beat. Make it yours." | ✅ | `Welcome.tsx`; e2e `journey` |
| Jump In is the gesture that enables audio and starts a coherent groove at a comfortable level | ✅ | `session.jumpIn/startAudio`; e2e `journey` (RMS > 0.01, peak ≤ −1 dBFS); browser `starters` (groove −26…−10 dBFS RMS) |
| Several pads lit, with text states saying which parts play | ✅ | `Pad.tsx`, `LoopsGrid.tsx`; e2e `journey` (4 pads "Playing.") |
| Another Bass/Chords variation joins on the next bar, in time | ✅ | unit `sequencer`; e2e `journey` (switch on tick % 384 = 0) |
| Tone / Space audibly change the selected part | ✅ | browser `realEngine` (centroid ×1.5, tail ×10); e2e `journey` |
| Keyboard / note pads with Musical Assist on by default | ✅ | e2e `journey` (out-of-key key → in-key note) |
| Record Performance, stop, keep something to listen to | ✅ | e2e `journey` (take → WAV) |
| Optional, skippable three-step guide | ✅ | `Guide.tsx`; browser `guide` |
| Existing project preserved before a starter loads; reopen offers the last project next to Jump In | ✅ | `library.createFromStarter`; e2e `persistence` (Continue), e2e `complete` |
| *(M5)* The "Just look around" preview is stored on its first change (no false "Saved"); a starter never silently replaces edits that could not be saved | ✅ | `session.ts`, `Library.tsx`; browser `library`; e2e `persistence` |
| *(M5)* Jump In always lands on the lit Loops pads | ✅ | `session.jumpIn`; browser `wp1-session` |
| Progressive disclosure: selected part reveals its controls; Steps, Shape and cables open in the same workspace | ✅ | `PlayView.tsx`, `CablesDrawer.tsx`, `ShapeView.tsx` |

## §2 Visual and interaction direction

| Requirement | Status | Evidence |
|---|---|---|
| Console look: warm shell, cool surfaces, graphite text, restrained depth; silicone pads with light pools | ✅ | `theme.css`, screenshots in `docs/screenshots/` |
| Amber / teal / coral with fixed meanings, always paired with text or icon | ✅ | `theme.css` header; pads/buttons carry text states |
| Knobs: drawn position, label, value | ✅ | `Knob.tsx`; browser `knob` |
| Transport: Play/Stop, tempo, swing, record status, master volume, always reachable Mute All | ✅ | `TransportBar.tsx`; *(M5)* stays on screen when the narrow layout scrolls (e2e `a11y`, 200 % zoom); fits every width 1024–1920 px (browser `wp1-transport`); 2.0 adds Pause, with Export and Stop labelled at 1366 px (browser `omni-play-layout`) |
| Fits 1366×768 without hiding transport; reviewed at 1920×1080 and 200 % zoom; reflows below 1024 px | ✅ | screenshots `02-…-1366`, `10-…-1920`, `21-play-zoom200` |
| DOM/CSS/SVG; meters and waveforms show real audio/transport state | ✅ | `Meter.tsx` reads AnalyserNodes; playheads follow the transport |
| Knob: vertical drag + pointer capture, Shift fine, double-click default, arrows with name/range/unit, numeric entry, no accidental wheel changes, smoothed in the engine | ✅ | `Knob.tsx`; browser `knob`; engine `PARAM_SMOOTHING`; *(M5)* each knob's tip names its gestures and its default |
| Tips: visible, remembered, plain words first, detail second, keyboard focus, never blocks playing | ✅ | `Tooltip.tsx`, `uiStore`; browser `arp` (Tips switch) |

## §3 Views

| Requirement | Status | Evidence |
|---|---|---|
| Transport, project and selected part consistent across views | ✅ | single `ProjectStore` + `uiStore` |
| Eight parts (Drums … Sampler), renamable, instrument changeable, 8-track limit | ✅ | `factory.ts`, `TrackMenu.tsx`, `SoundBrowser.tsx`; browser `parts` |
| Pad modes Loops / Drums / Notes / Steps as specified | ✅ | browser `pad`, `drumpads`, `notespads`, `steps` |
| Changing pad view never resets playback or edits the project | ✅ | `PlayView.tsx` (UI state only) |
| Loops states Empty / Ready / Queued / Playing / Recording; one clip per track; next-bar launch shown immediately and when it happens; stop-track and stop-all | ✅ | unit `sequencer`; e2e `journey`; *(M5)* a single part's queued launch can be cancelled (browser `parts`) |
| Musically named scenes recording full clip selections and stopped parts | ✅ | starters; `sequencer` scene launch |
| ~2-octave keyboard, mouse/touch, octave shift, computer-key map; notes released on cancel, blur, input change, stop; no capture in text fields | ✅ | `MiniKeyboard.tsx`, `useComputerKeyboard.ts`; e2e `notes`; *(M5)* a key held while the part, octave or arpeggiator changes releases its own note (e2e `notes`, browser `wp2-notes-recording`); drum parts show one key per kit sound |
| Musical Assist on by default, explained, chromatic mode; recordings keep their pitch | ✅ | `session.noteOn`; browser `arp`, `samplerui`; *(M5)* sampler parts play the key pressed (browser `wp2-notes-recording`) |
| Shape: six macros with defined, audible, inspectable mappings stored with the sound; Pump described as tempo-synced ducking (no sidechain claim) | ✅ | `MacroColumn.tsx`, `presets.ts`; browser `realEngine`, `shape`, `presets`; *(M5)* Play-view macro tips list the live mappings |
| Shape: compact effects rack and a genuine cable panel | ✅ | `EffectsRack.tsx`, `CablePanel.tsx`; browser `cables`, `shape` |
| Arrange: drag blocks, repeats, play song, names, bar counts, playhead, duration, linked to clips | ✅ | `SongPanel.tsx`; browser `arrange`; unit `song` |
| Performances saved as editable launch / note / parameter events; clear "follows arrangement / live pads / replay" indicator | ✅ | `PerformancesPanel.tsx`; browser `arrange`; *(M5)* takes can be trimmed and recorded values edited, each undoable (unit `wp4-performances`, browser `arrange`) |

## §4 Musical building blocks

| Requirement | Status | Evidence |
|---|---|---|
| 16-voice drum kits with kicks, snares, claps, hats, toms, rim, percussion, accents; open/closed hat choke | ✅ | `kits.ts`, `drumKit.ts`; browser `drumKit`; unit `drumSynth`; *(M5)* choke groups per kit (no shaker choking the open hat); kit levels matched when a part switches to a kit (browser `wp3-kitlevel`) |
| Mono bass with envelope, filter, glide, waveform, saturation | ✅ | `bassSynth`, `InstrumentColumn.tsx`; browser `synths` |
| Poly synth with bounded voices and clean releases | ✅ | `polySynth.ts` (12 voices); browser `synths` |
| Sampler: waveform, trim, gain, pitch/rate, one-shot/loop, fades | ✅ | `SamplerEditor.tsx`, `sampler.ts`; browser `sampler`, `samplerui`; *(M5)* One-shot plays the whole region; Loop crossfades its end into the lead-in, so repeats never click and keep their attack; Audition plays the root key exactly |
| Distinct, usable presets; velocity response; level matching | ✅ | unit `presets` (parameter distance, level groups) |
| Arpeggiator: on/off, division, Up/Down/As played, octaves, latch, same transport | ✅ | `arp.ts`, `ArpPanel.tsx`; unit `arp`; browser `arp` |
| Step editing: placement, velocity, gate, copy, clear, duplicate, undo; drums pick a voice; melodic pitch lane; 4/4, 1–4 bars | ✅ | browser `steps` |
| Tempo 40–220 BPM, swing with a clear value; metronome and count-in optional, off by default | ✅ | `params.ts`, `clock.ts`; browser `realEngine` (swing onsets); *(M5)* notes played during the count-in are not recorded |
| Bounded, deterministic, seeded Variation with undo, respecting locks | ✅ | unit `variation`; e2e `complete` |

## §5 Starter material

| Requirement | Status | Evidence |
|---|---|---|
| Eight starters at the specified tempos, compatible keys, four useful scenes, balanced levels | ✅ | unit + browser `starters` (every scene rendered and measured); TEST_REPORT levels table |
| ≥ 4 drum kits, ≥ 16 synth presets, descriptive names; blank project | ✅ | 2.0: 15 kits, 67 presets in eight categories (`catalog.ts`; unit `omni-sounds-catalog`); `blank.ts` |
| Core assets generated in the repository; no runtime downloads; provenance | ✅ | `builtinSamples.ts`, `ASSETS.md`; e2e `resilience` (offline) |

## §6 Cables and effects

| Requirement | Status | Evidence |
|---|---|---|
| Cable panel visible and discoverable, collapsed during Jump In | ✅ | `CablesDrawer.tsx` (closed by default) |
| SVG cables, distinct plugs, labelled sockets, compatible destinations highlighted, click-click, keyboard picker | ✅ | `CablePanel.tsx`, `ConnectionPicker.tsx`; browser `cables`; e2e `complete` |
| Move, disconnect, bypass, restore default patch, undo/redo; rack and cables share one routing state | ✅ | `commands/patch.ts`; browser `cables`, `shape` |
| Patching changes the real audio graph | ✅ | browser `realEngine` (disconnect silences, undo restores bit-exactly); e2e `complete` (audible) |
| Module families: LP/HP filter, synced delay with bounded feedback, reverb wet/dry, drive, chorus + phaser, bit/rate reduction, gain/pan, protected master, synced LFO | ✅ | `src/audio/modules/*`; browser `effects`, `fx-*`, `reverb`, `engine-modulation`; *(M5)* switching an LFO Off stops its movement |
| Labelled Audio vs Modulation ports; modulation only to supported targets | ✅ | `modules.ts`; unit `graph` |
| Validation first; no cycles; incompatible/duplicate refused keeping the old route; ramps when rewiring | ✅ | unit `graph`; browser `realEngine` |
| Complete default patches; "This part has no path to the output" + Restore Connection | ✅ | unit `graph`; browser `cables`, `shape`; e2e `complete`; *(M5)* Restore Connection re-plugs the one missing cable in both the rack and the cable panel, and asks before anything larger |
| Headroom, finite limits, real limiter (−1 dBFS) honestly labelled; Mute All silences notes and tails | ✅ | browser `engine-limiter`, `realEngine` (+18 dB push stays ≤ ceiling); e2e `notes` |

## §7 Import, capture, projects, export

| Requirement | Status | Evidence |
|---|---|---|
| WAV/MP3 import decoded locally, limits shown before import, actionable errors, project preserved on failure | ✅ | `audioImport.ts`, `ImportSampleButton.tsx`; unit `audioImport`; *(M5)* over-long files are refused from their headers before decoding |
| Trim, manual original tempo / bar length; speed+pitch change labelled | ✅ | `SamplerEditor.tsx`; browser `samplerui` |
| Record Notes into the selected clip with visible quantize | ✅ | *(M5)* records into the clip selected on the part; the caption shows the grid (or the arpeggiator's rate); records what the arpeggiator plays; one pass is one undo step (browser `wp2-notes-recording`, `arp`; unit `store`) |
| Record Performance: launches, notes, knob moves; replayable and exportable; patch editing locked with explanation | ✅ | unit `replay`; browser `offline`, `arrange`; e2e `journey`; *(M5)* nothing audible is left out: undo/redo during a take, held keys and a latched arpeggio at its start, Mute All (ends the take); previews are blocked during a take (browser `wp2-notes-recording`) |
| Autosave with saved / saving / error indicator | ✅ | `autosave.ts`, `TransportBar.tsx`; e2e `persistence` |
| Library: rename, duplicate, open, delete with recovery; explains browser storage vs project files | ✅ | `Library.tsx`, `db.ts`; browser `library` |
| Undo/redo incl. patching and parameter gestures | ✅ | unit `store`, `commands` |
| Project file export/import with samples and all state; fresh profile reopen | ✅ | unit `bundle`; e2e `persistence` (fresh profile, second render within 1 %) |
| Stereo PCM WAV of arrangement or performance with effects and tail; dialog with duration, filename, sample rate, progress, cancel | ✅ | `ExportDialog.tsx`, `wav.ts`; unit `wav`; e2e `journey`; *(M5)* export stops the transport at the end of the music exactly like live playback (browser `offline`) |
| IndexedDB, versioned schema, quota handling, import validation | ✅ | `db.ts`, `migrate.ts`, `validate.ts`; unit `persistence`, `validate` |
| Same engine for render; deterministic | ✅ | browser `realEngine` (two renders within float rounding), `offline` |

## §8 Engineering and reliability

| Requirement | Status | Evidence |
|---|---|---|
| Layered TypeScript app (project data, time, audio, commands, UI, persistence/render) | ✅ | `docs/ARCHITECTURE.md` |
| Audio clock is the timing authority (worker ticker + look-ahead) | ✅ | `transport.ts`; e2e `resilience` (3 min, no drift) |
| Audio only after a gesture; suspended / interrupted handled with Resume Audio; no duplicated graph | ✅ | `session.startAudio`; e2e `resilience`; *(M5)* a failed audio start does not leave contexts behind (browser `wp1-session`) |
| Stale events cancelled; no accumulation of voices, nodes, listeners, timers | ✅ | e2e `resilience` (25× Play/Stop, 3 min) |
| Stable ids; no audio objects in project state | ✅ | `factory.ts`, `types.ts` |
| Background-tab stall → coherent stop + Resume, no backlog | ✅ | e2e `resilience` (simulated stall); *(M5)* Resume restarts what was playing: song, replay or live pads (browser `wp1-session`) |
| All dependencies, fonts, presets and sounds served locally; offline play | ✅ | e2e `resilience` (offline reopen + play) |
| Installable manifest, offline caching with visible ready / update states, never force-reload | ✅ | `pwa.ts`, *(M5)* `OfflineStatus.tsx` now shown in the transport; Update is disabled while playing or recording and never reloads with unsaved edits (browser `wp1-transport`; e2e `resilience`) |

## §9 Cloud build and local handoff

| Requirement | Status | Evidence |
|---|---|---|
| Clean-clone commands documented | ✅ | `README.md`, `CLAUDE.md` |
| Production build + downloadable source/build package | ✅ | `release/omni-song-2.1.0.zip` (`npm run package`: builds first; app + Windows launcher + START HERE + `source/`); unit `wp5-package`, `omni-rename-package` |
| Windows launch route + START HERE; loopback only; serves only the build folder | ⚠️ | `launcher/`, `Start Omni Song.bat`; unit `wp5-launcher`; the packaged launchers ran under PowerShell 7 and Node on Linux (`evidence/launcher-smoke.txt`: 127.0.0.1 only, traversal refused, a second start reuses the running copy, Jump In plays); not run on Windows here |
| No claim that a cloud localhost address is reachable | ✅ | README / START HERE |

## Omni Song 2.0 additions

Asked for after 1.0: an easier interface, Pause, many more instruments and effects, mastering,
MIDI keyboards and recording from a microphone or instrument, and the new name. Nothing from the
brief was removed; the self-contained rules still hold (no AI feature, account, telemetry, paid
service or runtime download).

| Requirement | Status | Evidence |
|---|---|---|
| Pause that holds bar, beat and every clip's phase; Play continues in time; Stop returns to bar 1; Space = Play/Pause and Shift+Space = Stop, also after clicking a button | ✅ | `sequencer.ts`, `transport.ts`, `TransportBar.tsx`; unit `sequencer`; browser `omni-play-pause`, `omni-fix-space-keys`; e2e `a11y` |
| Simple mode by default, Advanced on request, without changing the music | ✅ | `uiStore`; browser `wp1-transport`, `omni-play-layout`, `omni-shape-simple` |
| Clear Mute / Solo (labelled, ≥ 32 px, dimmed "Muted" columns), part play/stop, M key | ✅ | `LoopsGrid.tsx`, `PartPanel.tsx`; browser `omni-play-loops`, `omni-fix-play-pads`; e2e `omni` |
| Move things around: drag clips (move, swap, Ctrl copy), drag scene rows, keyboard Move…, pad actions without launching | ✅ | `commands/clips.ts`; unit `commands`; browser `omni-play-loops`, `omni-fix-play-pads` |
| Many instruments, chosen in one obvious place: sound browser with categories, search, Preview, Current | ✅ | `SoundBrowser.tsx`; browser `omni-sounds-ui`, `parts` |
| New synthesis (FM, unison, pitch sweep, noise colour, drift, vibrato, sub shape); 1.0 starters unchanged in level | ✅ | `src/audio/instruments/*`; browser `omni-sounds-engines`, `omni-sounds-kits`, `presets`, `starters` |
| Seven new effects: EQ, Compressor, Gate, Auto Pan, Stereo Width, Flanger, Tape; grouped by purpose in Add effect | ✅ | `src/audio/modules/*`, worklets; browser `omni-fx-inserts`, `omni-fx-engine`, `omni-shape-simple` |
| Mastering: low cut, three-band EQ, air, glue, punch, warmth, width, mono bass, loudness; eight presets; output still through the −1 dBFS limiter; neutral = bit-identical | ✅ | `modules/mastering.ts`, `content/mastering.ts`; browser `omni-mastering-chain` (Loudness +15 on hot material never exceeds −1 dBFS) |
| Loudness meters (EBU R128 momentary, short-term, integrated, true peak), loudness targets, Match target, spectrum, listening-only Compare A/B | ✅ | `loudness` worklet, `MasteringPanel.tsx`, `Spectrum.tsx`; unit `omni-fx-loudness` (within 0.1 LU of reference); browser `omni-mix-session` (A/B ≥ 4 dB on the real output, project untouched), `omni-mix-view` |
| Mix view: one strip per part (fader, meter, Mute, Solo, Pan; sends in Advanced), master strip with Mute All | ✅ | `src/app/views/mix/*`; browser `omni-mix-view`, `omni-fix-mix-layout` |
| Schema v2 with mastering; v1 projects migrate on open and import | ✅ | `migrate.ts`, `validate.ts`; unit `validate`, `bundle` |
| MIDI keyboards: notes with velocity, sustain, pitch bend, mod wheel, learn for big knobs / volumes / tempo, GM drum map, no hanging notes on unplug | ⚠️ | `src/app/midi.ts`; browser `omni-input-midi` (fake MIDIAccess, real session); unit `omni-fix-midi-*`; no physical MIDI device here |
| Record audio from a microphone or interface: count-in, 1/2/4 bars on the audio clock, latency offset, one undo step; edits Normalize, Reverse, Crop, Fades, Gain (what plays = what is stored) | ⚠️ | `src/app/audioInput.ts`, `sampleVersions.ts`; browser `omni-input-audio`, `omni-input-ui`, `omni-fix-audio-take`; unit `omni-input-edits`, `omni-fix-gain-clip`; tested with a generated stream, not a real microphone |
| Rename to Omni Song; 1.0 projects, settings and `.sb01.zip` files keep working | ✅ | unit `omni-rename-*`, `bundle`; browser `library`; e2e `omni` |
| Help that gets out of the way: updated quick guide and "Try this" hints that follow real actions and never cover controls | ✅ | `src/app/views/hints/*`, `Guide.tsx`; browser `omni-hints-*`, `omni-fix-play-hints`, `guide`; e2e `omni` |
| Undo toasts tied to their own step; "Undid / Redid" feedback | ✅ | `projectStore.ts`; browser `omni-fix-undo-toast`; unit `omni-fix-history-ids` |
| Later, not in 2.0 (by agreement): a bridge to a local music generator (YuE2), webcam body tracking, VR/AR headsets | — | `docs/ROADMAP.md` |

## Omni Song 2.1 additions: the song timeline

Asked for after 2.0: "the movement of song bits so sleek and smooth and so easy to edit and extend
and combine … perfect and reliable … clicking together." Built and reviewed on a pull request into
`main` (which holds 2.0).

| Requirement | Status | Evidence |
|---|---|---|
| Move song sections smoothly: blocks sit edge to edge, the others slide aside while dragging, the block settles into its slot; one undo step | ✅ | `SongLane.tsx`, `laneGestures.ts`, `songDrag.ts`; unit `song-lane`; browser `song-lane`, `song-lane-touch`; screenshot `23-arrange-drag-1366` |
| Extend: drag a block's edge (whole passes, 1–16), the rest ripples; keyboard + and − | ✅ | browser `song-lane`; unit `song-blocks` |
| Edit: copy (Ctrl/Alt-drag, Ctrl+D), multi-select, clipboard, split at a pass line, join, rename, delete with Undo; keyboard path for every action | ✅ | browser `song-lane`, `arrange`; unit `song-blocks`, `song-lane` |
| Combine: per block, switch a part off or play another scene's part in it; drop a scene card onto a block to layer it (fills silent parts; Shift replaces) | ✅ | `src/project/arrangement.ts`, `layerScene`; unit `song-blocks`; browser `song-lane`; screenshot `22-arrange-song-playing-1366` |
| What the lane shows is what plays, also while the song plays or is paused (live re-planning from the playing block); exports match | ✅ | `Sequencer.replanSong`; unit `song-live`, `song-live-edits`, `song-live-fuzz`; browser `song-live`, `song-live-edits` |
| Play from any bar; readout and playhead follow the song timeline | ✅ | browser `song-live`, `song-lane` |
| Reliable gestures: Esc, release outside, lost pointer, window switch or unmount cancel with no edit; a second finger is ignored; refused clearly while a take records | ✅ | browser `song-lane`, `song-lane-touch`, `omni-pad-drag` |
| Loops pads and scene rows move as smoothly (lifted pad, previews, settle, scene-row slot) | ✅ | `LoopsGrid.tsx`, `src/ui/motion.ts`; browser `omni-pad-drag*`; screenshot `24-play-pad-drag-1366` |
| Smooth on a modest PC | ⚠️ | measured, not felt: 60 fps drags at normal speed; at 4× CPU slowdown some late frames remain during long auto-scroll drags and the drop costs one long frame (TEST_REPORT.md) |
| Layout at 1366×768, 1920×1080 and 200 % zoom; axe-core | ✅ | browser `song-lane-layout`, `omni-pad-drag-layout` |
| Hear a section over and over while shaping it: loop a set of blocks (button, ruler band, menu), seamless, live edits keep working | ✅ | unit `song-loop`, `song-loop-history`, `song-live-fuzz`; browser `song-loop`, `song-lane-loop` |
| Extend and combine in one click: Build up, Strip down, Breakdown (one undo step, song length kept) | ✅ | unit `song-blocks`, `song-live-helpers`; browser `song-lane-loop` |
| One obvious Play: in Arrange the transport Play/Space, Stop and Export act on the song; export the loop | ✅ | browser `omni-play-song-key`, `export-dialog`, `export-range`, `export-while-playing` |
| Newcomer review findings (state visible under the pointer, menus not covering their trigger, steady tooltips, visible Undo/Redo, readable pads, no layout shift, plain words) | ✅ | browser `omni-fix-toggles`, `clipmenu-popover`, `tooltip-still-pointer`, `wp1-transport*`, `omni-fix-play-pads`, `song-lane-polish` |

## Limits (not hidden)

- No listening review: nothing here claims musical quality or physical latency from sample values.
- Windows launcher, Chrome/Edge on Windows, real audio devices and real background-tab throttling
  remain local checks (see TEST_REPORT.md).
- A performance started while a latched arpeggio already runs replays that pattern from its first
  step (same notes and rhythm; the first notes can come in a different order).
- Sampler tempo sync changes speed and pitch together (labelled); no pitch-preserving stretch.
- Recorded audio takes are at most 4 bars; MIDI pitch bend is heard live but not recorded into
  performance takes; input monitoring has its own limiter and does not pass through mastering.
- MIDI keyboards and microphones were tested with simulated devices only.
- Song lane and pad drags were tested with real mouse, keyboard, touch and pen input sent to
  Chromium, not on a physical touch screen; a horizontal finger swipe on a block drags it.
