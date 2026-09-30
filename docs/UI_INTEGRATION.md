# UI integration guide (for view/feature code in `src/app/`)

## Where state lives

| Need | Use |
|------|-----|
| The Project (undoable data) | `useProject(selector, equality?)` from `src/app/instance.ts`; `session.store.getState()` outside React |
| UI-only selection/view state | `useUi(selector)` + setters from `src/state/uiStore.ts` (`selectTrack`, `selectSlot`, `setPadMode`, `setStepPage`, `selectDrumVoice`, `shiftNotesOctave`, `setCablesOpen`, `setClipboard`, `selectModule`, …) |
| What the audio side is doing now | `useRuntime(selector)` from `src/app/runtime.ts` (`playing`, `mode`, `tracks[trackId].playingSlot/queued`, `recording`, `recordTarget`, `held[trackId]`, `muteAll`, …) and `notify(text, tone, action?)` for toasts |
| Undo state | `useHistory()` |
| Autosave state | `useAutosave()` |

**Selectors must be narrow.** Knob drags change the project ~60×/s; a component that selects
`p.tracks` or `p` re-renders on every drag frame. Select the exact values you render, and pass an
equality function (e.g. `shallowEqual` from `src/state/store.ts`) when you build objects/arrays.
Clip objects and arrays keep their identity when unchanged (immer structural sharing).

## Doing things

- **Recordable actions go through `session`** (so Record Performance captures them):
  `session.pressClip(trackId, slot)`, `launchScene(row)`, `stopTrack`, `stopAllClips`,
  `setMacro(trackId, macro, v, gesture)`, `setModuleParam(moduleId, param, v, gesture)`,
  `setInstrumentParam(trackId, param, v, gesture)`, `setMute`, `setBpm`, `setSwing`, `setMasterVolume`,
  `noteOn(trackId, pitch, velocity, 'pad' | 'keyboard' | 'computer')` / `noteOff(...)`,
  `play/stop/togglePlay/playSong(fromBlock)`, `toggleRecordNotes`, `togglePerformance`,
  `replayPerformance(id)`, `importSample(file, trackId)`, `renderWav(opts)`, `renderPlan(...)`,
  `newFromStarter(id)`, `openProject(id)`, `importProjectFile(file)`, `exportProjectFile()`,
  `undo()`, `redo()`.
- **Every other edit** is a command from `src/state/commands` called with `session.store`, wrapped in
  `session.accepted(result)` — that shows refusals (e.g. the performance-take lock, invalid input) as a
  toast and returns `true` when the edit happened. Example:
  `session.accepted(cmd.renameClip(session.store, trackId, slot, name))`.
- Pass the `gesture` id from `Knob`/`NumberField` `onChange(value, info)` (`info.gesture`) so a drag
  is one undo step.
- `downloadBlob(blob, filename)` from `src/app/download.ts` saves files.

## Components & design

- Use the kit in `src/ui/components` (Knob, Pad, Button, IconButton, Switch, SegmentedControl, Select,
  NumberField, Meter, Led, Panel, Dialog, Tooltip, Toast/Notice, MiniKeyboard, Icon) and CSS Modules
  with tokens from `src/ui/theme.css`. See `?gallery` (src/ui/gallery/Gallery.tsx) for every state.
- Colour is information: **amber** = playing/signal/on, **teal** = selection/focus/modulation,
  **coral** = recording/mute/attention/destructive. Always pair colour with text or an icon.
- Legible type (≥ 11 px, labels 12–13 px), click targets ≥ 32 px (28 px for dense secondary tools),
  visible focus (the global `:focus-visible` ring), short animations, generous spacing.
- Tooltips (`tip` = plain-language audible result first, `detail` = technical second) on every
  control whose effect is not obvious. Tips can be switched off by the user.
- Every control must do something real. Never show a control that has no effect.
- Meters/playheads: read `session.transport?.getPosition()` / meters inside `useRafLoop` and write
  to DOM refs — never `setState` per frame, and never use animation frames to time audio.
- Accessibility: real buttons/inputs, `aria-label`s that include state words, roving focus with
  arrow keys in grids, Escape closes popovers/dialogs, no keyboard traps.
- Layout must fit the 1366×768 viewport (the main workspace between the 58 px transport and the
  100 px keyboard strip is ~610 px tall) and still work at 1920×1080 and 200 % zoom.

## Seeing your work

```bash
npx vite --port <your unique port> --strictPort   # dev server (run in background, kill when done)
```

Drive it with Playwright (`playwright` package, Chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`): open `http://127.0.0.1:<port>/`, click
**Just look around** (no audio) or **Jump In** (starts audio + House starter), navigate, screenshot
at 1366×768, and LOOK at the PNG (Read tool). Test hooks: `window.__switchboard`
(`session`, `runtime`, `ui`, `project()`, `stats()`, `meters()`, `position()`).
