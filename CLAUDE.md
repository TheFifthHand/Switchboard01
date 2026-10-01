# Omni Song — project instructions

Browser-based electronic music app **Omni Song** (version 2.0 of what was SWITCHBOARD / 01;
TypeScript, React 19, Vite 8, Web Audio). Full brief: `PRODUCT_BRIEF.md`. Interface rulebook:
`docs/OMNI_UX.md`. Architecture and contracts: `docs/ARCHITECTURE.md`. Progress: `BUILD_STATUS.md`.
Plans (not promises): `docs/ROADMAP.md`.

## Commands

```bash
npm install            # dependencies (lockfile committed)
npm run dev            # dev server on http://127.0.0.1:5173
npm run typecheck      # tsc --noEmit
npm test               # Vitest unit tests (Node)
npm run build          # typecheck + production build into dist/
npm run serve          # serve dist/ on http://127.0.0.1:4173 (loopback only)
npm run test:browser   # Vitest in real headless Chromium (audio rendering tests)
npm run test:e2e       # Playwright (Chromium) against dist/ — run `npm run build` first
npm run package        # build, then release/omni-song-<version>.zip (app + launcher + START HERE + source/)
```

Cloud container: Chromium 141 lives in /opt/pw-browsers and matches the pinned `@playwright/test`
1.56.1. Never run `playwright install` there. Locally: `npx playwright install chromium` once.

## Lasting product rules

- Self-contained: no AI features, accounts, telemetry, paid services, cloud storage or runtime
  downloads. Fonts, sounds and presets ship with the app. Built-in sounds are original synthesis.
- The first minute must work with no theory, patching, import or tutorial: Jump In → audible
  starter groove at a comfortable level. Preserve an existing project before loading a starter.
- The audio clock is the timing authority. Never time notes with React renders or UI timers.
- Every visible control must change the actual sound or routing. No fake meters or activity.
- Colour is information: amber = playing/signal, teal = selection/focus/modulation,
  coral = recording/mute/attention. Always pair colour with text or an icon.
- Knobs: vertical drag with pointer capture, Shift = fine, double-click = default, arrow keys,
  accessible name/range/unit, numeric entry where precision helps, no wheel changes by accident.
- Audio parameter changes are smoothed; rewiring uses short ramps. Output passes a real look-ahead
  limiter with a −1 dBFS ceiling. Mute All silences voices and effect tails.
- Patch validation rejects incompatible, duplicate and cyclic connections without touching the
  working graph. Patch editing is locked while a performance is being recorded.
- Project data is JSON with stable ids and a schema version; validate and migrate on import.
- The product name users see is **Omni Song**. Identifiers existing data depends on keep the first
  name: IndexedDB `switchboard01`, localStorage `switchboard01.*`, schema id `switchboard01.project`,
  the `window.__switchboard` test hook, and the PWA's identity (start_url/scope, no manifest id).
  New project files are `.omnisong.zip`; `.sb01.zip` files must keep importing.
- "Try this" hints (`src/app/views/hints/`) detect steps from real state; when a hinted control
  changes, update its step text and detection together.
- Keep architecture layers separate (see docs/ARCHITECTURE.md). Pure layers stay DOM/audio-free.
- Musical Assist starts on. Imported recordings keep their pitch unless the user changes it.
  Sampler tempo sync changes speed and pitch together — say so in the UI.
- Pump is a tempo-synchronized ducking envelope; never describe it as sidechain detection.
- Do not add unfinished or placeholder controls. Remove a control rather than ship it inert.

## Conventions

- TypeScript strict. CSS Modules for components (`*.module.css`), tokens from `src/ui/theme.css`.
- Tests check user outcomes and audio behaviour, not implementation trivia.
- Commits: coherent checkpoints per milestone; update `BUILD_STATUS.md` with each.
- Do not include model identifiers in commits, PRs or code.
