/**
 * The "Try this" steps, in two tracks: the basics (one next action at a
 * time, in plain words) and the song, which becomes current when Arrange
 * first opens. Each step keeps its words and the test that it was done
 * together here (CLAUDE.md: when a hinted control changes, update its text
 * and its detection together):
 *
 * - `text` / `more` follow the state (Mute pressed once, a take recording,
 *   the Mix view open);
 * - `detect` reads one change of the real state (the project, its undo
 *   history, the runtime, the view, a finished export; see tracker.ts) and
 *   says whether it was this step's action. Never a timer, never a click on
 *   the hint itself; switching to another project counts as nothing.
 *
 * A step that needs another view offers a button that goes there.
 */
import type { ArrangementBlock, Project, Track } from '../../../project/types';
import type { HistoryInfo } from '../../../state/projectStore';
import type { PadMode, View } from '../../../state/uiStore';
import type { RuntimeState } from '../../runtime';
import type { HintId } from './hintsState';

export interface HintContext {
  view: View;
  padMode: PadMode;
  /** Name of the part the pad and mute steps point at (null when the project has none). */
  bassName: string | null;
  drumsName: string | null;
  drumsMuted: boolean;
  recording: boolean;
  /** Some part has a clip (a Blank project has none: nothing to tap or drag yet). Absent: yes. */
  hasClips?: boolean;
  /** The part the pad step points at has a clip to launch. Absent: yes. */
  bassHasClips?: boolean;
  /** Where Export is at this width: on the strip, or in its ⋯ menu. Absent: the strip. */
  exportAt?: 'strip' | 'menu';
}

export interface HintGo {
  /** Button text, e.g. "Show the pads". */
  label: string;
  view: View;
  padMode?: PadMode;
}

/** One change of the real state, with what it was before. */
export interface HintChange {
  /** Which source changed. */
  source: 'project' | 'history' | 'runtime' | 'view' | 'export';
  project: Project;
  prevProject: Project;
  history: HistoryInfo;
  prevHistory: HistoryInfo;
  runtime: RuntimeState;
  prevRuntime: RuntimeState;
  view: View;
  prevView: View;
}

/** What a step remembers between changes (set again when another project opens). */
export type HintMemo = Record<string, boolean | number | undefined>;

export type HintTrack = 'basics' | 'song';

export interface HintStep {
  id: HintId;
  track: HintTrack;
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
  /** What the step remembers when a project opens (default: nothing). */
  init?(p: Project): HintMemo;
  /** Was this change the step's action? */
  detect(c: HintChange, memo: HintMemo): boolean;
}

const PADS: HintGo = { label: 'Show the pads', view: 'play', padMode: 'loops' };
const ARRANGE: HintGo = { label: 'Open Arrange', view: 'arrange' };
const onPads = (c: HintContext) => c.view === 'play' && c.padMode === 'loops';

/** The part a step points at: the first part with that role, else the first of that instrument kind. */
export function bassPart(p: Project): Track | null {
  return p.tracks.find((t) => t.role === 'bass') ?? p.tracks.find((t) => t.instrument.kind === 'bass') ?? p.tracks.find((t) => t.instrument.kind !== 'drums') ?? null;
}

export function drumsPart(p: Project): Track | null {
  return p.tracks.find((t) => t.role === 'drums') ?? p.tracks.find((t) => t.instrument.kind === 'drums') ?? p.tracks[0] ?? null;
}

const trackHasClip = (t: Track | null | undefined) => !!t && t.clips.some((c) => c !== null);
/** Some part has a clip. */
export function projectHasClips(p: Project): boolean {
  return p.tracks.some(trackHasClip);
}
/** The bass part (see bassPart) has a clip to tap. */
export function bassHasClips(p: Project): boolean {
  return trackHasClip(bassPart(p));
}

/** Undo labels of the clip drag-and-drop edits. */
const CLIP_DROP_LABELS: ReadonlySet<string> = new Set(['Move clip', 'Swap clips', 'Copy clip']);

function soundKey(t: Track): string {
  const i = t.instrument;
  switch (i.kind) {
    case 'drums':
      return `drums:${i.kitId}`;
    case 'sampler':
      return `sampler:${i.sampleId ?? ''}`;
    default:
      return `${i.kind}:${i.presetId}`;
  }
}

const newSound = (now: Track, was: Track) => was.instrument !== now.instrument && soundKey(was) !== soundKey(now);

function sameParams(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

/** Parts that changed between two states of the same project (paired by id). */
function changedTracks(c: HintChange): { now: Track; was: Track }[] {
  if (c.source !== 'project' || c.project.tracks === c.prevProject.tracks) return [];
  const out: { now: Track; was: Track }[] = [];
  for (const t of c.project.tracks) {
    const was = c.prevProject.tracks.find((x) => x.id === t.id);
    if (was && was !== t) out.push({ now: t, was });
  }
  return out;
}

/** Song blocks changed in place: the same blocks (by id) before and after, so a split, a join or a new block is something else. */
function changedBlocks(c: HintChange): { now: ArrangementBlock; was: ArrangementBlock }[] {
  if (c.source !== 'project') return [];
  const now = c.project.arrangement.blocks;
  const before = c.prevProject.arrangement.blocks;
  if (now === before || now.length !== before.length) return [];
  const out: { now: ArrangementBlock; was: ArrangementBlock }[] = [];
  for (const b of now) {
    const was = before.find((x) => x.id === b.id);
    if (!was) return [];
    if (was !== b) out.push({ now: b, was });
  }
  return out;
}

function sameParts(a: ArrangementBlock['parts'], b: ArrangementBlock['parts']): boolean {
  const pa = a ?? {};
  const pb = b ?? {};
  const ka = Object.keys(pa);
  return ka.length === Object.keys(pb).length && ka.every((k) => k in pb && pa[k] === pb[k]);
}

export const HINT_STEPS: readonly HintStep[] = [
  {
    id: 'pad',
    track: 'basics',
    text: (c) => `Tap a pad in the ${c.bassName} column.`,
    more: () => 'It takes over at the next bar, in time.',
    here: onPads,
    go: PADS,
    // A Blank project has nothing to launch there: an empty pad makes a clip instead.
    available: (c) => c.bassName !== null && c.bassHasClips !== false,
    // A launch queued on the bass part (a pad or scene tap); not the scheduler starting it, not Stop all.
    detect: (c) => {
      if (c.source !== 'runtime') return false;
      const bass = bassPart(c.project);
      if (!bass) return false;
      const now = c.runtime.tracks[bass.id]?.queued ?? null;
      const before = c.prevRuntime.tracks[bass.id]?.queued ?? null;
      return !!now && now.slot !== null && (!before || before.slot !== now.slot || before.atTick !== now.atTick);
    },
  },
  {
    id: 'mute',
    track: 'basics',
    text: (c) => (c.drumsMuted ? `The ${c.drumsName} part is muted. Press Mute again to bring it back.` : `Press Mute on ${c.drumsName}.`),
    more: (c) => (c.drumsMuted ? null : 'Solo, next to it, plays a part on its own.'),
    here: (c) => onPads(c) || c.view === 'mix',
    go: PADS,
    available: (c) => c.drumsName !== null,
    // The drums part muted (Mute pressed once), then unmuted again.
    init: (p) => ({ sawMuted: drumsPart(p)?.mute ?? false }),
    detect: (c, memo) => {
      if (c.source !== 'project') return false;
      const drums = drumsPart(c.project);
      if (!drums) return false;
      if (drums.mute) {
        memo.sawMuted = true;
        return false;
      }
      return !!memo.sawMuted && !!c.prevProject.tracks.find((t) => t.id === drums.id)?.mute;
    },
  },
  {
    id: 'drag',
    track: 'basics',
    text: () => 'Drag a clip onto another pad.',
    more: () => 'Hold Ctrl to copy it instead. Undo puts it back.',
    here: onPads,
    go: PADS,
    // Nothing to drag in a project without clips.
    available: (c) => c.hasClips !== false,
    // A clip moved, swapped or copied onto another pad (the drop's undo step).
    detect: (c) => c.source === 'history' && c.history !== c.prevHistory && c.history.undoLabel !== null && CLIP_DROP_LABELS.has(c.history.undoLabel),
  },
  {
    id: 'tone',
    track: 'basics',
    text: () => 'Turn the Tone knob.',
    more: () => 'Drag up for brighter, down for darker.',
    here: (c) => c.view === 'play' || c.view === 'shape',
    go: { label: 'Show Play', view: 'play' },
    // A part's Tone macro; a new sound bringing its own macro settings is the instrument step, not Tone.
    detect: (c) => changedTracks(c).some(({ now, was }) => !newSound(now, was) && was.macros.tone !== now.macros.tone),
  },
  {
    id: 'instrument',
    track: 'basics',
    text: () => 'Press Change instrument and pick a new sound.',
    more: () => 'Undo brings the old one back.',
    here: (c) => c.view === 'play' || c.view === 'shape',
    go: { label: 'Show Play', view: 'play' },
    // A part's instrument or sound changed.
    detect: (c) => changedTracks(c).some(({ now, was }) => newSound(now, was)),
  },
  {
    id: 'master',
    track: 'basics',
    text: (c) => (c.view === 'mix' ? 'Pick a mastering preset, like Warm or Punchy.' : 'Open Mix and try a mastering preset.'),
    more: () => 'Mastering polishes the whole song at once.',
    here: (c) => c.view === 'mix',
    go: { label: 'Open Mix', view: 'mix' },
    // The mastering preset or a mastering setting; switching mastering off and on alone does not count.
    detect: (c) =>
      c.source === 'project' &&
      c.project.mastering !== c.prevProject.mastering &&
      (c.project.mastering.presetId !== c.prevProject.mastering.presetId || !sameParams(c.project.mastering.params, c.prevProject.mastering.params)),
  },
  {
    id: 'record',
    track: 'basics',
    text: (c) => (c.recording ? 'Recording. Play a little, then press Performance again to stop.' : 'Press Performance to record what you play.'),
    more: (c) => (c.recording ? null : 'Your take appears in Arrange, ready to export.'),
    here: () => true,
    // A performance take recorded and stopped (recording notes does not count).
    detect: (c) => c.source === 'runtime' && c.prevRuntime.recording === 'performance' && c.runtime.recording !== 'performance',
  },
  {
    id: 'song-play',
    track: 'song',
    text: () => 'Press Play to hear your song.',
    more: () => 'In Arrange, Play (or Space) plays the blocks in order.',
    here: (c) => c.view === 'arrange',
    go: ARRANGE,
    // The song plays (runtime mode 'song') while the Arrange view is open.
    detect: (c) => (c.source === 'runtime' || c.source === 'view') && c.view === 'arrange' && c.runtime.playing && c.runtime.mode === 'song',
  },
  {
    id: 'song-repeats',
    track: 'song',
    text: () => 'Drag a block’s right edge to play it more times.',
    more: () => 'With the keyboard, + and − do the same.',
    here: (c) => c.view === 'arrange',
    go: ARRANGE,
    // A block's repeats changed (the same blocks before and after: a split or a join is something else).
    detect: (c) => changedBlocks(c).some(({ now, was }) => now.repeats !== was.repeats),
  },
  {
    id: 'song-part',
    track: 'song',
    text: () => 'Click a part in a block to switch it off there.',
    more: () => 'Click it again to bring it back.',
    here: (c) => c.view === 'arrange',
    go: ARRANGE,
    // A block's parts changed (a part switched off or on, or another scene's clip layered in).
    detect: (c) => changedBlocks(c).some(({ now, was }) => !sameParts(now.parts, was.parts)),
  },
  {
    id: 'song-export',
    track: 'song',
    text: (c) => (c.exportAt === 'menu' ? 'Export your song: ⋯ at the top right, then Export WAV….' : 'Press Export, at the top right, to save your song as a WAV file.'),
    more: () => 'In Arrange it starts from the song.',
    here: () => true,
    // An export finished: a WAV file was made.
    detect: (c) => c.source === 'export',
  },
];

/** The closing message once every step is done, saying where Export is: on the strip at the top right, or in its ⋯ menu (narrower windows). */
export function hintsFinishedText(exportAt: 'strip' | 'menu', song = false): string {
  if (song) return 'You have tried the basics and made a song. Help (the ? key, or ⋯ → Help…) has every shortcut and three short walkthroughs.';
  return exportAt === 'strip'
    ? 'You have tried the basics. Export, at the top right, saves your music as a WAV file.'
    : 'You have tried the basics. Export, in the ⋯ menu at the top right, saves your music as a WAV file.';
}
export const HINTS_FINISHED_TEXT = hintsFinishedText('strip');

/** View names, for "Next, in Play: …". */
export const VIEW_NAMES: Readonly<Record<View, string>> = { play: 'Play', shape: 'Shape', arrange: 'Arrange', mix: 'Mix' };

export interface CurrentHint {
  step: HintStep;
  /** Index in HINT_STEPS. */
  index: number;
  /** 1-based place among the available steps of its track, and how many there are. */
  position: number;
  total: number;
}

/**
 * The first step that is neither done nor impossible in this project, or
 * null when all are done. Once the song track was offered (`song`), its
 * steps come first and the basics follow.
 */
export function currentHint(done: readonly HintId[], ctx: HintContext, opts: { song?: boolean } = {}): CurrentHint | null {
  const tracks: HintTrack[] = opts.song ? ['song', 'basics'] : ['basics'];
  for (const track of tracks) {
    const steps = HINT_STEPS.filter((s) => s.track === track && (!s.available || s.available(ctx)));
    const i = steps.findIndex((s) => !done.includes(s.id));
    if (i >= 0) return { step: steps[i], index: HINT_STEPS.indexOf(steps[i]), position: i + 1, total: steps.length };
  }
  return null;
}
