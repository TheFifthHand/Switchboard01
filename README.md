# SWITCHBOARD / 01

A slim, retro-modern electronic music console that runs entirely in your browser. Illuminated pads,
knobs, a small keyboard and patch cables — press **Jump In** and a starter groove plays; change its
sounds, play along in key, record a performance and export a WAV. Everything is synthesized and
stored on your own device: no account, no uploads, no internet needed once it is loaded.

- **Play** — 8 parts × 4 clip rows (scenes), Loops / Drums / Notes / Steps pad modes, a 2-octave
  keyboard with Musical Assist, arpeggiator, Variation.
- **Shape** — six macros per part (Tone, Space, Echo, Motion, Drive, Pump), an effects rack and a
  real cable panel (audio and modulation), all editing the same routing.
- **Arrange** — order scenes into a song, record and replay live performances, export WAV.

Knobs: drag up or down (hold Shift for fine steps), double-click to go back to the default (each
knob's tip names it), or click a knob and type a value such as `2.5k` or `-6` for an exact
setting. Arrow keys, Page Up/Down and Home/End work once a knob has focus.

Target browsers: current Chrome and Edge on Windows desktop (Chromium-based browsers generally).

## Run it

Downloaded release zip (Windows): extract it and double-click **Start SWITCHBOARD.bat** — see
`START HERE.txt` inside the zip (source: `launcher/START-HERE.txt`).

From source:

```bash
npm install
npm run dev          # development server: http://127.0.0.1:5173
npm run build        # production build into dist/
npm run serve        # serve dist/ at http://127.0.0.1:4173 (loopback only)
npm run package      # build, then release/switchboard01-<version>.zip (app + launcher + source)
```

The browser keeps projects and the offline copy per address, and the port is part of the address.
So the launchers (`launcher/serve.mjs`, and `launcher/serve.ps1` behind the .bat) stay on port
4173: if SWITCHBOARD already answers there they open it and exit; if another program holds the
port they say that projects saved at the usual address will not appear, and how to free it, before
using the next free port. With `--strict-port` (for scripts and tests), `serve.mjs` stops instead.

The release zip holds `Start SWITCHBOARD.bat`, `START HERE.txt`, `app/` (the production build),
`launcher/`, `ASSETS.md` and `source/`: the repository files git lists (committed, or new and not
ignored), without release zips, `evidence/wav/`, `docs/screenshots/` and large media. Run on its
own, `node scripts/package-release.mjs` refuses a build older than the source.

Requires Node.js 20.19+ for building. The built app is static files; any local static server works
(`python -m http.server 4173 --bind 127.0.0.1 --directory dist`). Opening `index.html` directly
from disk is not supported (browsers block modules, storage and offline caching on `file://`).

## Tests

```bash
npm run typecheck
npm test             # unit tests (Node)
npm run test:browser # audio rendering tests in headless Chromium
npm run build && npm run test:e2e   # end-to-end tests against the production build
```

Local test runs need Playwright's Chromium once: `npx playwright install chromium`.

## Documentation

- `PRODUCT_BRIEF.md` — the product brief.
- `docs/ARCHITECTURE.md` — layers, contracts, timing model.
- `BUILD_STATUS.md` — milestone progress. `TEST_REPORT.md` — evidence.
- `ASSETS.md` — asset provenance (all sounds are original synthesis).
