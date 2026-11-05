# SWITCHBOARD / 01

## Build assignment

Build a complete, polished, playable electronic music instrument in this repository. Working title: SWITCHBOARD / 01.

I want a slim, sleek, minimalist retro-modern music console with illuminated pale gray and white pads, satisfying knobs, labeled switches, a small keyboard, and cables I can drag between sockets. It should invite someone with no music knowledge to explore and make something enjoyable immediately, while giving a curious musician substantial depth.

The first version is self-contained. Audio generation, playback, effects, sample handling, project storage, and export run on the user's device in the browser. There is no AI feature in this version. Do not add an AI tab, account system, paid service, telemetry, required cloud storage, or unfinished integration controls.

You are implementing the instrument, including its sound design, interface, persistence, tests, and handoff. Start with a concise implementation plan, save the project instructions, and proceed through the milestones below. Make reasonable implementation decisions independently. Complete the working product instead of stopping after planning, scaffolding, or an attractive demonstration screen.

The intended development environment is Claude Code in the cloud, connected to a private GitHub repository. The main playback target is a current Windows desktop browser, initially Chrome and Edge. Choose tooling compatible with the cloud environment. The project must also be straightforward to download and run locally.

Use the model and effort selected for this session. Do not change them or enable paid services. Work toward the finite acceptance criteria below; do not keep consuming time after completing them.

## 1. The experience to protect

The first minute should feel like this:

1. I see the actual instrument and a prominent Jump In button, with a short explanation: "Start with a beat. Make it yours."
2. I click Jump In. That deliberate gesture enables browser audio and begins a musically coherent starter groove at a comfortable level.
3. Several pads are lit. Their text and state make it understandable which parts are playing.
4. I tap another Bass or Chords variation. It joins on the next bar, staying in time.
5. I turn Tone and hear the selected part get brighter or darker. I turn Space and hear its ambience change.
6. I play the little keyboard or note pads. Musical Assist keeps those notes within the project scale by default.
7. I press Record Performance, play for a while, stop, and save something I can listen to.

No tutorial, empty timeline, external download, MIDI controller, patching knowledge, or music theory should be required for that experience. An optional, skippable three-step guide can point out Play, pads, and sound controls.

Jump In is an entry mode into the real editor. Its clips, instruments, and routing remain editable when I explore more. Preserve an existing project before loading a starter; reopening the app should offer the last project alongside a new Jump In session.

Use progressive disclosure. The main surface remains spacious. Selecting a part reveals its relevant controls. Detailed synthesis, step editing, and the cable panel open within the same workspace.

## 2. Visual and interaction direction

Create an original instrument design with a coherent industrial design language:

- A low-profile console, warm off-white shell, cool light-gray working surfaces, graphite text, fine panel lines, and restrained depth.
- Pale gray and white silicone-like pads with small, controlled pools of light when active. Use color as information.
- Subtle amber, teal, and coral accents, with consistent meanings. Text and icons must also distinguish states.
- Precisely drawn rotary controls with a visible position, useful label, and value. Use believable motion and restrained shadows.
- Legible typography at real laptop sizes. Small technical numerals can complement ordinary, readable labels.
- A compact transport strip with Play/Stop, tempo, swing, recording status, master volume, and an always reachable Mute All control.
- Fine alignment, consistent spacing, short animations, generous click targets, and strong focus indicators.

The main instrument should fit a 1366 by 768 desktop viewport without hiding transport controls. Also review at 1920 by 1080 and at 200% browser zoom. At smaller widths, reorganize panels and keep controls usable; avoid shrinking every label into illegibility. Phone-specific performance layouts are outside the first release.

Use DOM, CSS, and SVG for a crisp tactile interface. A complex 3D scene is unnecessary. Meter and waveform movement must represent actual audio or transport state. Do not add fake activity displays.

Knob behavior:

- Vertical dragging changes values; pointer capture continues the drag outside the control.
- Shift provides fine adjustment; double-click resets to the documented default.
- Focused arrow keys adjust values, with accessible names, ranges, and units.
- Offer direct numeric entry where precision helps.
- Avoid accidental changes while someone scrolls the page.
- Smooth changes in the audio engine to prevent clicks.

Optional Tips is a visible, remembered setting. Tooltips explain audible results in plain language, for example "Space adds a room around this sound." Reveal technical detail second. Tips work on keyboard focus as well as hover and never block a performance.

## 3. One instrument, several useful views

Keep transport, project state, and the selected part consistent across views.

### Play

The default surface contains the pad matrix, selected-part sound controls, a small keyboard, and compact track controls.

Use eight sound parts with sensible starter roles: Drums, Percussion, Bass, Chords, Lead, Pad, Texture, and Sampler. Tracks can be renamed and their instruments changed. Eight simultaneous tracks is the initial product limit.

The central pad surface has clearly labeled modes:

| Mode | Behavior |
| --- | --- |
| Loops | Eight track columns and four clip rows. A pad starts or stops a clip for that track; a side button launches a whole row as a scene. |
| Drums | A 4 by 4 performance pad layout for the selected drum kit, with sound names and optional computer-key labels. |
| Notes | A 4 by 4 scale-aware note layout for the selected melodic instrument, including octave controls. |
| Steps | A clearly numbered 16-step editor for the selected sound or melodic part, with pages for up to four bars. |

Changing the pad view must not reset playback or alter the project.

Loops has explicit Empty, Ready, Queued, Playing, and Recording states. Only one clip per track plays at a time. Default launches occur at the next bar; show the queue immediately and the actual launch when it happens. Provide visible stop-track and stop-all options.

Name scenes musically, such as Intro, Groove, Lift, and Break. A scene records a complete set of clip selections and stopped parts, so its behavior is predictable.

The keyboard has approximately two octaves, mouse/touch input, octave shifting, and a discoverable computer-key mapping. Release notes on pointer cancellation, window blur, input changes, and stop events. Do not intercept typing while focus is in a text field.

Musical Assist starts on. It constrains built-in note pads, arpeggios, and assisted note recording to the selected root and scale. Explain the behavior visibly. Offer a normal chromatic keyboard mode. Imported recordings keep their existing pitches unless the user explicitly changes playback pitch.

### Shape

Show six useful macros for the selected part: Tone, Space, Echo, Motion, Drive, and Pump.

Every macro must have a defined, audible mapping. Store mappings with the instrument or preset and let users inspect the underlying controls. Pump can use a tempo-synchronized ducking envelope; describe it accurately instead of claiming audio sidechain detection when that is not implemented.

Include a compact effects rack and a genuine cable panel. The user can explore routing without leaving the instrument.

### Arrange

Provide a simple scene sequence: drag Intro, Groove, Lift, and Break blocks into order, choose their repeat counts, and play the resulting song.

Show scene names, bar counts, a playhead, and an estimated duration. Scene blocks remain connected to their editable clips. This view should be understandable without learning a full professional audio workstation.

Support saving a live performance as an editable sequence of launch, note, and parameter events. Make it clear whether playback follows the arrangement or live pad control.

_Note added with Omni Song 2.3 (not part of the original brief): this view is now the **Song** view. The song is no longer a sequence of scene blocks with repeat counts; every part has its own row, scenes and loops are dragged onto the rows and stretched to play longer, and named sections (Intro, Drop …) label stretches of it. See `docs/OMNI_UX.md` › Song view and `docs/ACCEPTANCE.md`._

## 4. Musical building blocks

Implement the following core instruments with real sound:

- A 16-voice drum kit using well-designed synthesis and/or bundled original samples. Include kicks, snares, claps, closed/open hats, toms, rim/click, percussion, and a few useful accents. Open and closed hats should choke appropriately.
- A mono bass synth with useful envelope, filter, glide, waveform, and saturation controls.
- A polyphonic synth for chords, leads, plucks, and pads, with bounded voice allocation and clean note releases.
- A sampler for locally imported recordings, with a waveform, start/end trim, gain, pitch/rate, one-shot/loop selection, and fade edges.

Sound design matters. Use thoughtful envelopes, spectral balance, velocity response, tuned percussion, filtered noise, controlled detuning, and level matching. Presets should sound distinct and musically usable. Avoid filling the product with identical oscillator sounds under different labels.

Add an arpeggiator with On/Off, rhythmic division, Up/Down/As Played, octave range, and latch. Its timing follows the same transport as clips.

Step editing supports note placement, velocity, gate length, copy, clear, duplicate, and undo. For drums, select a voice before editing its steps. For melodic parts, show a comprehensible pitch lane or note list. Start with 4/4 and 1-4 bar clips.

Tempo range: 40-220 BPM. Swing must have a clear value and consistent timing. A metronome and one-bar record count-in are optional controls, initially off except when explicitly chosen for recording.

Add a bounded Variation button that modifies the selected musical pattern and offers immediate undo. Preserve locked parts. This is deterministic musical pattern generation, not AI. Store its seed so saved projects and exports reproduce the same result.

## 5. Starter material is part of the product

Ship eight curated starter projects:

1. House - 124 BPM, solid four-on-the-floor groove.
2. Synthwave - 100 BPM, rounded bass and luminous chords.
3. Ambient - 72 BPM, spacious evolving layers.
4. Techno - 128 BPM, rhythmic modulation and focused low end.
5. Breakbeat - 132 BPM, syncopated drums and bass.
6. Drum and Bass - 174 BPM, fast percussion with musical restraint.
7. Downtempo - 84 BPM, relaxed rhythm and warm textures.
8. Garage - 136 BPM, shuffled percussion and short chord sounds.

Treat these as compositional briefs, not rigid genre claims. All patterns and melodies must be original. Each starter has a compatible root/scale, appropriate sounds, balanced levels, and four useful scenes. Scene variations should change rhythm, instrumentation, or harmony intentionally.

Across the product provide at least four distinct drum kits and sixteen useful synth presets. Give them descriptive names. Include a blank project for users who want one.

Generate or bundle the core assets in the repository. The built-in experience cannot depend on downloading sounds at runtime. Keep an asset provenance file for any external material and use material with clear redistribution permission. Prefer original synthesized content.

A starter is acceptable only when it works as a coherent arrangement, all assigned controls do something useful, and changing scenes stays in time.

## 6. Cables and effects that really work

The cable panel is a central creative feature. Make it visible and discoverable while keeping it collapsed during the initial Jump In experience.

Use draggable SVG cables with distinct plugs and clearly labeled sockets. Highlight compatible destinations when a plug is picked up. Also support click-source/click-destination and a keyboard-accessible connection picker.

Support moving and disconnecting a connection, bypassing an effect, restoring a default patch, and undo/redo. Patching changes the real audio graph. The effects rack and cable panel operate on the same underlying routing state.

Initial module families:

- Instrument/track outputs and mixer inputs.
- Low-pass/high-pass filtering with controlled resonance.
- Tempo-synchronized delay with bounded feedback.
- Reverb with wet/dry control.
- Drive/saturation.
- Chorus or phaser.
- Bit reduction/sample-rate reduction.
- Track gain/pan and the protected master output.
- A tempo-synchronized LFO with selectable waveform, rate, and depth.

Use separate, labeled Audio and Modulation port types. Modulation can target explicitly supported parameters such as filter cutoff, pitch, or effect amount. Do not pretend every port can connect to every other one.

Validate connections before changing the engine. Prevent graph cycles in version one; delay modules may contain their own bounded internal feedback. Reject incompatible and duplicate connections without losing the old working route. Use short ramps or crossfades when rewiring.

Presets open with complete, sensible patches. A user should never have to guess why a fresh project is silent. If a route has been intentionally disconnected, offer a helpful "This part has no path to the output" explanation and Restore Connection.

Keep master headroom, finite parameter limits, and a real limiter or equivalent bounded output protection. Do not label an ordinary compressor a brick-wall limiter without implementing and checking that behavior. Mute All must silence sustained notes and effect tails predictably.

## 7. Import, capture, projects, and export

Import browser-decodable WAV and MP3 audio from the user's device. Decode locally and show actionable errors for unsupported files. Display reasonable size/duration limits before importing and preserve the current project if an import fails.

Imported loops can be trimmed and assigned an original tempo or bar length manually. Version one may change playback speed and pitch together; label that behavior. Independent pitch-preserving time stretching, automatic stem separation, vocal cloning, and full-song AI covers are outside this release.

Offer two clearly distinct recording actions:

- Record Notes: record keyboard/drum playing into the selected clip, with visible quantization controls.
- Record Performance: capture launched scenes/clips, played notes, and supported knob movements so the performance can be replayed and exported.

A recorded performance must preserve enough initial project state, timing, parameter changes, and random seeds to replay faithfully. Either record patch changes too or lock patch editing during a take with an explanation. Do not produce a recording that silently omits audible actions.

Provide:

- Local autosave with a visible saved/saving/error indicator.
- A project library with rename, duplicate, open, and delete with recovery/confirmation.
- Undo/redo for meaningful editing operations, including patching and parameter gestures.
- An explicit project-file export/import that includes custom samples and all musical state.
- A stereo PCM WAV export of an arrangement or recorded performance, including effects and the chosen tail duration.
- A small export dialog with duration, filename, sample rate, progress, and cancellation where feasible.

Use IndexedDB or another appropriate browser store for projects and sample blobs. Version the schema, handle quota failures, and validate imported data. Browser storage is convenient working storage; exported project bundles are the portable backup. Explain this briefly in the project library.

Render WAV using the same synthesis, routing, timing, and automation definitions as playback. Ensure replay/export are deterministic for the same saved project. A WAV export is not a microphone recording of system audio.

A project bundle must reopen in a fresh browser profile with its sounds, sample assets, patterns, scenes, routing, macros, arrangement, and recorded events intact.

## 8. Engineering choices and reliability

Use a maintainable TypeScript web application. React and Vite are a suitable starting point; check compatible maintained package versions before installing and commit a lockfile. Choose a mature Web Audio scheduling/instrument library such as Tone.js if it improves reliability, while keeping the audio engine independent of the UI.

Architecture should clearly separate:

1. Serializable, versioned project data.
2. Musical time and event scheduling.
3. Audio graph, voices, modulation, and effects.
4. Commands, undo/redo, and automation.
5. UI controls and visualization.
6. Persistence, imports, and offline rendering.

The browser audio clock is the timing authority. Do not schedule beats by React renders or a chain of UI timeouts. A main-thread timer may feed an audio-clock look-ahead scheduler, but note timing must be scheduled against the audio timeline. Use AudioWorklet where processing or timing requirements justify it.

Create/resume audio only after a user gesture. Handle suspended contexts, output interruptions, repeated Play/Stop, and device changes without duplicating the graph. Explain recovery with a small Resume Audio control when needed.

Define tempo changes, swing, clip boundaries, queued launches, arrangement playback, and recording timestamps consistently. Cancel stale scheduled events when state changes. Repeated playback must not accumulate voices, audio nodes, listeners, or timers.

Give every track, clip, note, module, connection, and automation target a stable identity. Keep audio node objects out of the serialized UI state.

Limit polyphony and active effects sensibly. Dispose of resources. Avoid full app rerenders for audio meters, knob drags, and playhead animation. UI animation must never be the audio clock.

Background-tab behavior must be explicit and tested. If reliable playback cannot continue under browser throttling, pause coherently and provide a Resume action; do not silently drift or resume a backlog of notes.

Serve all runtime dependencies, fonts, preset data, and sound assets with the application. Core playback and saved projects must work without an internet connection once the application is available locally or fully cached.

Prepare an installable web-app manifest and offline caching with visible readiness/update states. Preserve project compatibility when updating. Do not force-reload during a performance. Installation is a convenience; the browser app must work without it.

## 9. Cloud build and local handoff

The cloud environment can build, run automated browser tests, and render audio evidence. It does not establish how the app feels through the user's speakers, headphones, or physical input devices.

Keep the repository usable from a clean clone. Provide documented commands for dependency installation, development, production build, tests, and local serving.

Produce a production build and a downloadable source/build package. Include a simple Windows launch route and a clear START HERE guide. A small launcher may serve the built files on localhost and open the browser; document any required runtime and stop procedure. Bind only to loopback and serve only the packaged build directory.

Do not assume double-clicking an HTML file supports module loading, storage, and service-worker behavior. If the cloud environment cannot test a Windows launcher, report that precisely and provide the tested browser-serving route as well.

A cloud coding session is not permanent application hosting. Do not claim an internal cloud localhost address is accessible to the user. Provide a working preview only if the environment supports one; otherwise deliver the build and exact local launch instructions.

Keep this work on the assigned repository branch. Do not publish the app publicly, create paid hosting, or change repository visibility. Document a future AI connection as a possible extension only if useful; do not spend implementation time building it now.

## 10. Milestones and autonomous working method

Before implementation, save this brief as PRODUCT_BRIEF.md, create a concise CLAUDE.md with the lasting product rules and commands, and create BUILD_STATUS.md with the milestones and next action. If repository instructions already exist, preserve them and integrate carefully.

Follow these milestones in order:

### Milestone 1: A complete playable slice

Implement the real audio engine, one good drum kit, bass/chord sounds, one starter scene, Play/Stop, a functioning pad surface, and audible sound controls. Establish the visual design at the same time. Verify one complete journey from Jump In to exported short audio before expanding.

### Milestone 2: The approachable instrument

Finish the four pad modes, mini keyboard, Musical Assist, clip editing, eight tracks, preset browser, curated starters, scene launching, and optional tips. Verify that the first-time journey remains simple.

### Milestone 3: Sound shaping and patching

Finish effects, macro mappings, cable interactions, modulation, graph validation, live rewiring, and patch undo. Confirm that each visible control changes the actual sound or routing.

### Milestone 4: Making and keeping music

Finish arrangement, imported samples, note recording, performance recording, automation, autosave, portable project bundles, and full WAV export.

### Milestone 5: Product finish and handoff

Review the interface at target sizes, test accessibility and resource cleanup, verify offline behavior, prepare local launch/download instructions, and deliver evidence.

At each milestone, run the relevant checks, fix problems, make a coherent checkpoint commit, update BUILD_STATUS.md, and continue. These are progress checkpoints, not routine requests for permission.

Use tools to inspect the actual running app. Review screenshots and interactions, then fix crowding, weak hierarchy, misleading controls, and broken paths. Do not repeatedly rewrite the architecture after it is working.

If a capability is blocked by the environment, finish the independent work, record the exact limitation, and leave a concrete continuation step. Do not silently remove an acceptance requirement or claim an unrun check passed.

If interrupted or nearing the session limit, save a runnable checkpoint. Record the current commit, completed requirements, failing checks, and the exact next command/task. Resume from these files instead of starting over.

## 11. Acceptance criteria and evidence

Create an acceptance checklist based on these requirements. Use tests that check user outcomes, audio behavior, and persistence; avoid tests that merely restate implementation details.

Required evidence:

- A fresh browser session reaches an audible starter groove through Jump In.
- The first session requires no cable connections, imports, or music-theory choices.
- All eight starter projects load; scene transitions remain aligned and useful controls are assigned.
- A queued clip switches at the documented musical boundary and cannot overlap another clip on its own track.
- Step editing, note recording, swing, and tempo changes alter the scheduled musical events as intended.
- Keyboard/drum notes stop correctly after blur, cancellation, Stop, and Mute All.
- At least one real audio cable rewire changes the rendered signal. Undo restores the route. Invalid and cyclic connections are rejected without corrupting the graph.
- Effects and macros produce measurable changes in a controlled audio fixture.
- Recorded notes, scene launches, and knob changes replay in the saved performance and exported WAV.
- Exported WAVs have the requested format and duration, contain finite non-silent audio for audible fixtures, and stay within the intended output ceiling.
- Include an impulse/timing fixture that checks actual rendered onset positions and looping over multiple bars; a blinking UI alone is not timing verification.
- A saved project containing a custom sample survives export, import into a fresh profile, and a second audio render.
- Autosave errors and unsupported imports show understandable recovery paths.
- A cached/local production build can reopen and play a built-in starter with network access unavailable.
- Repeated Play/Stop and several minutes of playback do not show accumulating resources, runaway gain, unhandled errors, or obvious scheduling drift.
- Mouse and keyboard use can reach the essential controls, with readable labels and focus states.
- Screenshots at the target desktop sizes show the actual working instrument, including Play, Steps, and the cable panel.

Save a compact TEST_REPORT.md, screenshots, and a few short rendered WAV examples. Keep large or sensitive user recordings out of repository evidence. Distinguish automated signal checks, browser interaction checks, any actual listening review, and remaining local hardware checks.

Do not infer musical quality or low physical playback latency solely from nonzero audio samples. If you cannot listen or measure the user's hardware, say so and provide the evidence that is available.

## 12. Final delivery

Return:

1. A plain-language description of the finished instrument.
2. The exact way to launch it and reach Jump In.
3. The source branch/commit and downloadable build location.
4. The completed acceptance checklist and important remaining limits.
5. A short "make your first loop" guide and a short "record and export" guide.

The product is complete when a beginner can launch it, play a coherent starter, change its sounds, create a variation, explore a working cable connection, record a short piece, export audio, and reopen the editable project.

Begin by inspecting the repository and available environment, recording a concise plan, and implementing Milestone 1. Continue through all five milestones.
