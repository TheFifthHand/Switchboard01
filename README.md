# Omni Song

Make electronic music in your browser, without learning anything first. Press **Jump In** and a
beat plays; tap pads to change it, swap instruments, mix it, record what you play and save it as a
WAV file. Everything runs on your own device: no account, no uploads, no internet needed once it is
loaded. All sounds are synthesized by the app itself.

Omni Song is version 2.0 of the app that was called **SWITCHBOARD / 01**. Projects, settings and
project files from 1.0 carry over (see [Coming from SWITCHBOARD / 01](#coming-from-switchboard--01)).

## What it does

- **Play** — eight parts (Drums, Bass, Chords …) by up to eight rows of loops (scenes), each clip
  1 to 8 bars. Tap a pad to switch a part to another loop; it joins on the next bar, in time, and
  every playing pad shows where it is in its loop. **Play / Pause** keeps your place, **Stop** goes
  back to the start. Each part has labelled **Mute** and **Solo** keys. **Drag a clip** onto another
  pad to move it (hold Ctrl to copy). **Variation** tries new takes on a pattern (Subtle, Bold, Back
  to original).
- **Play along** — a keyboard (or your computer keys, each letter shown on its key) with **Musical
  Assist** keeping every note in the song's key; one key per drum sound on a kit. **Chord pads**
  play whole chords of the key, **Write a progression…** writes one into a clip, and changing the
  key can move the whole song with it.
- **Steps** — edit a clip note by note: select, drag (across bars), copy and paste notes, finer and
  triplet grids, **Tighten timing** and **Loosen**; paint drum steps with a drag, fill or shift a
  sound.
- **Change instrument** — a sound browser with 15 drum kits, more than 60 synth sounds and your own
  recordings, sorted into Drums & Percussion, Bass, Keys, Pads & Strings, Leads, Plucks & Bells,
  Textures & FX and Recordings. Try sounds freely; **Cancel** puts the part back as you had it. Six
  big knobs shape the selected part: Tone, Space, Echo, Motion, Drive and Pump.
- **Shape** — the selected part in detail: friendly **Sound** knobs (or a **Drum mix**), the six big
  knobs, and its effects as cards whose knob always changes the sound (EQ, filter, compressor with
  **Squeeze**, gate, reverb, echo, chorus, phaser, flanger, auto pan, drive, tape, bit crusher, stereo
  width). Give any knob to a big knob, copy effects to another part. In Advanced, every setting and
  the real cable routing.
- **Arrange** — put scenes in order as a song of blocks, to scale; layer and switch parts per block,
  loop a section, add fades, a filter rise or an echo throw, add an intro or an ending, and turn a
  recorded performance into song blocks.
- **Mix** — a channel strip per part, Reverb and Echo return strips, a **Channel** drawer for a
  part's effects, and the master, with **mastering**: presets (Clean, Gentle, Warm, Punchy, Bright,
  Wide, Loud, Lo-fi), a loudness target (Streaming −14 LUFS, Gentle −18, Loud −9) with live readings
  and **Match target**, a spectrum, and a level-matched A/B to hear the mix without mastering.
- **Record and export** — **Performance** records everything you do and replays it exactly;
  **Notes** records what you play into a clip; recorded audio takes and imported loops each get their
  own clip. **Export** renders a WAV (the song, a loop, a row, the clips playing now or a
  performance) with the same engine you hear, starting exactly on the first beat, with or without
  mastering, and reports its loudness.
- **Keep it** — saves by itself in this browser (Ctrl+S saves at once), keeps versions you can
  restore, recovers the last edits after a reload, lets only one tab save a project, and exports a
  portable project file (drop it on the window to open it again).

### Simple and Advanced

Omni Song starts in **Simple**: the essentials, large, in plain words. The **Simple · Advanced**
switch at the top (or **Show every setting** in Shape) shows every control that exists: swing, key
and scale pickers, the arpeggiator, pan, every instrument and effect setting, macro mappings and the
cable panel. Switching never changes your music, and it is remembered.

### Help while you play

After **Jump In**, a three-step **quick guide** points at Play / Pause, the pads with Mute and Solo,
and Change instrument with the big knobs. Then small **"Try this"** hints suggest one next thing at a
time and move on when you do it; once you open Arrange they also teach the song. They never block
anything. **Help** (press **?**, or ⋯ → Help…) lists every keyboard shortcut, has short
walkthroughs and the version, and can start the guide and the hints again. Pointing at any control
explains it; **Tips** in the More menu turns explanations and hints on or off.

Knobs: drag up or down (hold Shift for fine steps), double-click to reset (in Shape: to where the
sound had it), or click the value and type (`2.5k`, `-6`); in Shape, right-click a knob to give it
to a big knob. Arrow keys, Page Up/Down and Home/End work once a knob has focus. Space plays and
pauses, Shift+Space stops, M mutes the selected part, Ctrl+Z undoes, Ctrl+S saves, ? opens Help.

### New in 2.1: build a song by moving blocks

**Arrange** shows the song as one strip of blocks (a scene played a number of passes), with a row
per part under each block. Drag a block and the others slide aside to make room; let go and it
clicks into place. Drag a block's right edge to make it longer or shorter, hold Ctrl (or Alt) while
dragging to copy it, and click a pass line to split it. Click a part in a block to switch it off or
on just there, or drop a scene card onto a block to layer that scene's parts in. Click the ruler to
play from any bar. Everything can be undone, works with the keyboard too, and changes what you hear
right away, even while the song plays. The Loops pads and scene rows move the same smooth way.
Step-by-step: "Build a song" in [`docs/GUIDE.md`](docs/GUIDE.md).

### New in 2.0: MIDI keyboards and audio input

- **Play from a MIDI keyboard or controller.** Connect it in the **MIDI & audio** dialog (More →
  *MIDI & audio…*; once something is connected, a MIDI & audio key also shows at the top). Notes
  play the selected part (or a part you choose), in key with Musical Assist, and record like the
  computer keyboard; knobs and faders can be learned to the big knobs, volumes or tempo.
- **Record your voice or a guitar.** Choose the input in the same dialog, then record onto a sampler
  part (the Vocal part in every starter), in time with the music, and edit the take afterwards.

Both use your browser's own MIDI and microphone access (Chrome or Edge); the browser asks for
permission first, and nothing leaves your computer. See the **MIDI & audio** dialog for what your
browser and devices support. Step-by-step: [`docs/GUIDE.md`](docs/GUIDE.md).

Target browsers: current Chrome and Edge on Windows desktop (Chromium-based browsers generally).
New here? [`docs/GUIDE.md`](docs/GUIDE.md) walks through a first loop, recording and export.

## Run it

Downloaded release zip (Windows): extract it and double-click **Start Omni Song.bat** — see
`START HERE.txt` inside the zip (source: `launcher/START-HERE.txt`).

From source:

```bash
npm install
npm run dev          # development server: http://127.0.0.1:5173
npm run build        # production build into dist/
npm run serve        # serve dist/ at http://127.0.0.1:4173 (loopback only)
npm run package      # build, then release/omni-song-<version>.zip (app + launcher + source)
```

The browser keeps projects and the offline copy per address, and the port is part of the address.
So the launchers (`launcher/serve.mjs`, and `launcher/serve.ps1` behind the .bat) stay on port
4173: if Omni Song (or an older SWITCHBOARD / 01) already answers there they open it and exit; if
another program holds the port they say that projects saved at the usual address will not appear,
and how to free it, before using the next free port. With `--strict-port` (for scripts and tests),
`serve.mjs` stops instead.

The release zip holds `Start Omni Song.bat`, `START HERE.txt`, `app/` (the production build),
`launcher/`, `ASSETS.md` and `source/`: the repository files git lists (committed, or new and not
ignored), without release zips, `evidence/wav/`, `docs/screenshots/` and large media. Run on its
own, `node scripts/package-release.mjs` refuses a build older than the source.

Requires Node.js 20.19+ for building. The built app is static files; any local static server works
(`python -m http.server 4173 --bind 127.0.0.1 --directory dist`). Opening `index.html` directly
from disk is not supported (browsers block modules, storage and offline caching on `file://`).

## Coming from SWITCHBOARD / 01

- **Your projects are still there.** Omni Song opens at the same address
  (`http://127.0.0.1:4173/`) and uses the same browser storage, so My projects shows everything you
  saved. Projects are upgraded to the current format when opened (mastering starts neutral, so they
  sound exactly as before). A project saved by this version will not open in an older one.
- **Project files:** new ones are saved as `.omnisong.zip`; your `.sb01.zip` files still open with
  **Import project file…**.
- **Windows launcher:** `Start SWITCHBOARD.bat` is now `Start Omni Song.bat`. If an older copy is
  still running, the new launcher says so and opens it; close the old window to switch.
- **Installed app:** an installed SWITCHBOARD / 01 updates itself to Omni Song; press **Update**
  when the app offers it.

Some internal names keep the first name on purpose (the browser database, saved settings, the
project format id `switchboard01.project`), so that nothing anyone saved is lost.

## Tests

```bash
npm run typecheck
npm test             # unit tests (Node)
npm run test:browser # UI and audio rendering tests in headless Chromium
npm run build && npm run test:e2e   # end-to-end tests against the production build
```

Local test runs need Playwright's Chromium once: `npx playwright install chromium`.

## Documentation

- [`docs/GUIDE.md`](docs/GUIDE.md) — make your first loop; chords and keys; editing notes and drum
  steps; shaping sounds; building a song; mixing, mastering and export; keeping your work safe; MIDI
  keyboards; recording your voice or a guitar.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — where Omni Song is going (plans, not promises).
- `docs/OMNI_UX.md` — the interface rulebook. `docs/ARCHITECTURE.md` — layers, contracts, timing.
- `PRODUCT_BRIEF.md` — the original product brief. `BUILD_STATUS.md` — progress.
  `TEST_REPORT.md` — test results and evidence. `docs/ACCEPTANCE.md` — requirements and checks.
- `ASSETS.md` — asset provenance (all sounds are original synthesis).
