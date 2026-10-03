/**
 * The "Try this" steps, in two tracks: the basics (one next action at a
 * time, in plain words) and the song, which becomes current when the Song
 * view first opens. The song steps teach the GarageBand way: drag a scene or
 * a loop in, stretch a loop by its right edge, move one, click the ruler,
 * press Play, export. Each step keeps its words and the test that it was done
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
import { regionEnd } from '../../../project/arrangement';
import type { Project, SongRegion, Track } from '../../../project/types';
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
  /** The pads play (live), so Play is Pause for now. Absent: no. */
  padsPlaying?: boolean;
  /** The song has loops (an empty song has nothing to play, stretch or move). Absent: yes. */
  hasRegions?: boolean;
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
const SONG: HintGo = { label: 'Open Song', view: 'arrange' };
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

/** How many loops the song has and how many bars they fill (all parts together). */
function songTotals(p: Project): { count: number; bars: number } {
  let bars = 0;
  for (const r of p.arrangement.regions) bars += r.bars;
  return { count: p.arrangement.regions.length, bars };
}

/** Song loops changed in place: the same loop (by id) before and after, on the same part. */
function changedRegions(c: HintChange): { now: SongRegion; was: SongRegion }[] {
  if (c.source !== 'project') return [];
  const now = c.project.arrangement.regions;
  const before = c.prevProject.arrangement.regions;
  if (now === before) return [];
  const was = new Map(before.map((r) => [r.id, r]));
  const out: { now: SongRegion; was: SongRegion }[] = [];
  for (const r of now) {
    const b = was.get(r.id);
    if (b && b !== r && b.trackId === r.trackId) out.push({ now: r, was: b });
  }
  return out;
}

/** The song cursor (where Play starts in the Song view), read from the runtime. */
function songCursor(rt: RuntimeState): number | undefined {
  return (rt as RuntimeState & { songCursor?: number }).songCursor;
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
    more: (c) => (c.recording ? null : 'Your take appears in Song, ready to export.'),
    here: () => true,
    // A performance take recorded and stopped (recording notes does not count).
    detect: (c) => c.source === 'runtime' && c.prevRuntime.recording === 'performance' && c.runtime.recording !== 'performance',
  },
  {
    id: 'song-add',
    track: 'song',
    available: (c) => c.hasClips !== false,
    text: () => 'Drag a scene or a loop into the song.',
    more: () => 'From the Loops panel on the right, onto a part’s row.',
    here: (c) => c.view === 'arrange',
    go: SONG,
    // Loops were added: more of them, filling more bars (a split makes more loops but no more bars).
    detect: (c) => {
      if (c.source !== 'project' || c.project.arrangement.regions === c.prevProject.arrangement.regions) return false;
      const now = songTotals(c.project);
      const was = songTotals(c.prevProject);
      return now.count > was.count && now.bars > was.bars;
    },
  },
  {
    id: 'song-stretch',
    track: 'song',
    available: (c) => c.hasRegions !== false,
    text: () => 'Drag a loop’s right edge to make it play longer.',
    more: () => 'It snaps to the bars, and the loop repeats to fill it.',
    here: (c) => c.view === 'arrange',
    go: SONG,
    // A loop got longer at its end (it starts where it did).
    detect: (c) => changedRegions(c).some(({ now, was }) => now.start === was.start && regionEnd(now) > regionEnd(was)),
  },
  {
    id: 'song-move',
    track: 'song',
    available: (c) => c.hasRegions !== false,
    text: () => 'Drag a loop to another bar.',
    more: () => 'Hold Alt (or Ctrl) as you let go to drop a copy.',
    here: (c) => c.view === 'arrange',
    go: SONG,
    // A loop moved along its row: the same length, another start.
    detect: (c) => changedRegions(c).some(({ now, was }) => now.bars === was.bars && now.start !== was.start),
  },
  {
    id: 'song-ruler',
    track: 'song',
    available: (c) => c.hasRegions !== false,
    text: () => 'Click a bar number on the ruler.',
    more: () => 'The playhead moves there, and Play starts from it.',
    here: (c) => c.view === 'arrange',
    go: SONG,
    // The song cursor moved by itself: a click on the ruler (stopped), or a jump there while the song plays. Play and
    // Stop also set the cursor (where playback starts, and back to it), so a change as playback starts or ends is not it.
    detect: (c) =>
      c.source === 'runtime' &&
      songCursor(c.runtime) !== undefined &&
      songCursor(c.runtime) !== songCursor(c.prevRuntime) &&
      c.runtime.playing === c.prevRuntime.playing &&
      c.runtime.paused === c.prevRuntime.paused &&
      c.runtime.mode === c.prevRuntime.mode,
  },
  {
    id: 'song-play',
    track: 'song',
    available: (c) => c.hasRegions !== false,
    // While the pads play, Play is Pause: the song starts from "Play the song" (or after a Pause).
    text: (c) => (c.padsPlaying ? 'Press Play the song, at the top, to hear your song.' : 'Press Play to hear your song.'),
    more: (c) => (c.padsPlaying ? 'Your pads stop, and the song plays from the playhead.' : 'In Song, Play (or Space) plays from the playhead.'),
    here: (c) => c.view === 'arrange',
    go: SONG,
    // The song plays (runtime mode 'song') while the Song view is open.
    detect: (c) => (c.source === 'runtime' || c.source === 'view') && c.view === 'arrange' && c.runtime.playing && c.runtime.mode === 'song',
  },
  {
    id: 'song-export',
    track: 'song',
    text: (c) => (c.exportAt === 'menu' ? 'Export your song: ⋯ at the top right, then Export WAV….' : 'Press Export, at the top right, to save your song as a WAV file.'),
    more: () => 'In Song it starts from the song.',
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
export const VIEW_NAMES: Readonly<Record<View, string>> = { play: 'Play', shape: 'Shape', arrange: 'Song', mix: 'Mix' };
/** Pad tab names (Play's Loops · Drums · Notes · Steps), for "Next, in Loops: …". */
export const PAD_MODE_NAMES: Readonly<Record<PadMode, string>> = { loops: 'Loops', drums: 'Drums', notes: 'Notes', steps: 'Steps' };

/** Where a step that is done elsewhere is done: the view, or the pad tab when the view is already open ("Next, in Loops:"). */
export function hintWhere(go: HintGo, ctx: Pick<HintContext, 'view'>): string {
  const place = go.view === ctx.view && go.padMode ? PAD_MODE_NAMES[go.padMode] : VIEW_NAMES[go.view];
  return `Next, in ${place}:`;
}

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
 * steps come first and the basics follow; but where the song's step cannot
 * be done in the view on screen (it is about the Song view), the first basics step
 * that can be done there comes first, so the song track never crowds out
 * the view on screen.
 */
export function currentHint(done: readonly HintId[], ctx: HintContext, opts: { song?: boolean } = {}): CurrentHint | null {
  const steps = (track: HintTrack) => HINT_STEPS.filter((s) => s.track === track && (!s.available || s.available(ctx)));
  const at = (list: HintStep[], i: number): CurrentHint => ({ step: list[i], index: HINT_STEPS.indexOf(list[i]), position: i + 1, total: list.length });
  const basics = steps('basics');
  const nextBasics = basics.findIndex((s) => !done.includes(s.id));
  if (opts.song) {
    const song = steps('song');
    const i = song.findIndex((s) => !done.includes(s.id));
    if (i >= 0) {
      if (song[i].here(ctx)) return at(song, i);
      const here = basics.findIndex((s) => !done.includes(s.id) && s.here(ctx));
      return here >= 0 ? at(basics, here) : at(song, i);
    }
  }
  return nextBasics >= 0 ? at(basics, nextBasics) : null;
}
