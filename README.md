# Omni Song

Make electronic music in your browser, without learning anything first. Press **Jump In** and a
beat plays; tap pads to change it, swap instruments, mix it, record what you play and save it as a
WAV file. Everything runs on your own device: no account, no uploads, no internet needed once it is
loaded. All sounds are synthesized by the app itself.

Omni Song is version 2.0 of the app that was called **SWITCHBOARD / 01**. Projects, settings and
project files from 1.0 carry over (see [Coming from SWITCHBOARD / 01](#coming-from-switchboard--01)).

## What it does

- **Play** — eight parts (Drums, Bass, Chords …) by four rows of loops. Tap a pad to switch a part
  to another loop; it joins on the next bar, in time. **Play / Pause** keeps your place, **Stop**
  goes back to the start. Each part has labelled **Mute** and **Solo** keys. **Drag a clip** onto
  another pad to move it (hold Ctrl to copy). A small keyboard (or your computer keys) plays along,
  and **Musical Assist** keeps every note in the song's key.
- **Change instrument** — a sound browser with 15 drum kits, more than 60 synth sounds and your own
  recordings, sorted into Drums & Percussion, Bass, Keys, Pads & Strings, Leads, Plucks & Bells,
  Textures & FX and Recordings. Six big knobs shape the selected part: Tone, Space, Echo, Motion,
  Drive and Pump.
- **Shape** — the selected part in detail: the six knobs, its instrument and its effects as cards
  (EQ, filter, compressor, gate, reverb, delay, chorus, phaser, flanger, auto pan, drive, tape,
  bit crusher, stereo width). In Advanced, every setting and the real cable routing.
- **Arrange** — put rows (scenes) in order as a song; replay, trim and export recorded performances.
- **Mix** — a channel strip per part (fader, meter, Mute, Solo, Pan) and the master, with
  **mastering**: presets (Clean, Gentle, Warm, Punchy, Bright, Wide, Loud, Lo-fi), a loudness
  target (Streaming −14 LUFS, Gentle −18, Loud −9) with live loudness readings and **Match target**,
  a spectrum display, and A/B to hear the mix without mastering.
- **Record and export** — **Performance** records everything you do and replays it exactly;
  **Notes** records what you play into a clip. **Export** renders a WAV (the song, a row, the clips
  playing now or a performance) with the same engine you hear.

### Simple and Advanced

Omni Song starts in **Simple**: the essentials, large, in plain words. The **Simple · Advanced**
switch at the top (or **Show every setting** in Shape) shows every control that exists: swing, key
and scale pickers, the arpeggiator, pan, every instrument and effect setting, macro mappings and the
cable panel. Switching never changes your music, and it is remembered.

### Help while you play

After **Jump In**, a three-step **quick guide** points at Play / Pause, the pads with Mute and Solo,
and Change instrument with the big knobs. Then small **"Try this"** hints suggest one next thing at a
time (tap a pad in the Bass column, press Mute on Drums, drag a clip, turn Tone, change the
instrument, try a mastering preset, record a performance) and move on when you do it. They never
block anything; **Hide hints** closes them, and **Show hints again** in the Project library brings
them back. Pointing at any control explains it; **Tips** in the More menu turns explanations and
hints on or off.

Knobs: drag up or down (hold Shift for fine steps), double-click to go back to the default, or click
a knob and type a value such as `2.5k` or `-6`. Arrow keys, Page Up/Down and Home/End work once a
knob has focus. Space plays and pauses, Shift+Space stops, M mutes the selected part, Ctrl+Z undoes.

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
  saved. Projects are upgraded to the 2.0 format when opened (mastering starts neutral, so they
  sound exactly as before).
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

- [`docs/GUIDE.md`](docs/GUIDE.md) — make your first loop; record and export; MIDI keyboards;
  recording your voice or a guitar.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — where Omni Song is going (plans, not promises).
- `docs/OMNI_UX.md` — the interface rulebook. `docs/ARCHITECTURE.md` — layers, contracts, timing.
- `PRODUCT_BRIEF.md` — the original product brief. `BUILD_STATUS.md` — progress.
  `TEST_REPORT.md` — test results and evidence. `docs/ACCEPTANCE.md` — requirements and checks.
- `ASSETS.md` — asset provenance (all sounds are original synthesis).
