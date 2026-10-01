/**
 * The "Try this" steps, in order: one next action at a time, in plain words.
 * Each step is done when the real state says so (see tracker.ts), and its
 * text follows the state (Mute pressed once, a take recording, the Mix view
 * open). A step that needs another view offers a button that goes there.
 */
import type { Project, Track } from '../../../project/types';
import type { PadMode, View } from '../../../state/uiStore';
import type { HintId } from './hintsState';

export interface HintContext {
  view: View;
  padMode: PadMode;
  /** Name of the part the pad and mute steps point at (null when the project has none). */
  bassName: string | null;
  drumsName: string | null;
  drumsMuted: boolean;
  recording: boolean;
}

export interface HintGo {
  /** Button text, e.g. "Show the pads". */
  label: string;
  view: View;
  padMode?: PadMode;
}

export interface HintStep {
  id: HintId;
  /** The suggestion: one short sentence. */
  text(ctx: HintContext): string;
  /** A second, smaller sentence (how, or what happens). */
  more?(ctx: HintContext): string | null;
  /** Can it be done where the person is now? */
  here(ctx: HintContext): boolean;
  /** Where to go when it cannot be done here. */
  go?: HintGo;
  /** False when this project has nothing to do it with (the step is passed over). */
  available?(ctx: HintContext): boolean;
}

const PADS: HintGo = { label: 'Show the pads', view: 'play', padMode: 'loops' };
const onPads = (c: HintContext) => c.view === 'play' && c.padMode === 'loops';

export const HINT_STEPS: readonly HintStep[] = [
  {
    id: 'pad',
    text: (c) => `Tap a pad in the ${c.bassName} column.`,
    more: () => 'It takes over at the next bar, in time.',
    here: onPads,
    go: PADS,
    available: (c) => c.bassName !== null,
  },
  {
    id: 'mute',
    text: (c) => (c.drumsMuted ? `The ${c.drumsName} part is muted. Press Mute again to bring it back.` : `Press Mute on ${c.drumsName}.`),
    more: (c) => (c.drumsMuted ? null : 'Solo, next to it, plays a part on its own.'),
    here: (c) => onPads(c) || c.view === 'mix',
    go: PADS,
    available: (c) => c.drumsName !== null,
  },
  {
    id: 'drag',
    text: () => 'Drag a clip onto another pad.',
    more: () => 'Hold Ctrl to copy it instead. Undo puts it back.',
    here: onPads,
    go: PADS,
  },
  {
    id: 'tone',
    text: () => 'Turn the Tone knob.',
    more: () => 'Drag up for brighter, down for darker.',
    here: (c) => c.view === 'play' || c.view === 'shape',
    go: { label: 'Show Play', view: 'play' },
  },
  {
    id: 'instrument',
    text: () => 'Press Change instrument and pick a new sound.',
    more: () => 'Undo brings the old one back.',
    here: (c) => c.view === 'play' || c.view === 'shape',
    go: { label: 'Show Play', view: 'play' },
  },
  {
    id: 'master',
    text: (c) => (c.view === 'mix' ? 'Pick a mastering preset, like Warm or Punchy.' : 'Open Mix and try a mastering preset.'),
    more: () => 'Mastering polishes the whole song at once.',
    here: (c) => c.view === 'mix',
    go: { label: 'Open Mix', view: 'mix' },
  },
  {
    id: 'record',
    text: (c) => (c.recording ? 'Recording. Play a little, then press Performance again to stop.' : 'Press Performance to record what you play.'),
    more: (c) => (c.recording ? null : 'Your take appears in Arrange, ready to export.'),
    here: () => true,
  },
];

/** The closing message once every step is done. */
export const HINTS_FINISHED_TEXT = 'You have tried the basics. Export, at the top right, saves your music as a WAV file.';

/** The part a step points at: the first part with that role, else the first of that instrument kind. */
export function bassPart(p: Project): Track | null {
  return p.tracks.find((t) => t.role === 'bass') ?? p.tracks.find((t) => t.instrument.kind === 'bass') ?? p.tracks.find((t) => t.instrument.kind !== 'drums') ?? null;
}

export function drumsPart(p: Project): Track | null {
  return p.tracks.find((t) => t.role === 'drums') ?? p.tracks.find((t) => t.instrument.kind === 'drums') ?? p.tracks[0] ?? null;
}

/** The first step that is neither done nor impossible here, with its position, or null when all are done. */
export function currentHint(done: readonly HintId[], ctx: HintContext): { step: HintStep; index: number } | null {
  for (let i = 0; i < HINT_STEPS.length; i++) {
    const step = HINT_STEPS[i];
    if (done.includes(step.id)) continue;
    if (step.available && !step.available(ctx)) continue;
    return { step, index: i };
  }
  return null;
}
