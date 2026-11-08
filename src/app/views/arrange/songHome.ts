/**
 * The Song screen as the home in Simple mode, in words and numbers (pure: no
 * DOM, no React, no audio):
 *
 * - which instruments get a row (those with music in the song; the others
 *   wait behind "+ Add instrument"),
 * - what each kind of instrument is called and drawn as in the picker,
 * - the song's length in minutes and seconds ("Your song · 1:04"),
 * - the one next step the tip line offers, read from the real song.
 */
import { songBars } from '../../../project/arrangement';
import { clipById } from '../../../project/clips';
import type { Id, Project, TrackRole } from '../../../project/types';
import type { IconName } from '../../../ui/components';
import { clockText } from './songModel';

/* ------------------------------------------------------------------ */
/* Kinds of instrument                                                 */
/* ------------------------------------------------------------------ */

/** What a beginner calls each kind of instrument, and its picture. */
export const INSTRUMENT_KINDS: Readonly<Record<TrackRole, { name: string; icon: IconName }>> = {
  drums: { name: 'Drums', icon: 'drum' },
  percussion: { name: 'Percussion', icon: 'bell' },
  bass: { name: 'Bass', icon: 'wave' },
  chords: { name: 'Keys & chords', icon: 'keys' },
  lead: { name: 'Melody', icon: 'sparkle' },
  pad: { name: 'Pad', icon: 'layers' },
  texture: { name: 'Texture', icon: 'spectrum' },
  sampler: { name: 'Recording', icon: 'mic' },
};

/** The picker's order: the order a song is usually built in (beat, bass, harmony, tune, then colour). */
export const INSTRUMENT_ORDER: readonly TrackRole[] = ['drums', 'percussion', 'bass', 'chords', 'lead', 'pad', 'texture', 'sampler'];

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

/** The instruments that have at least one loop in the song. */
export function playingIds(p: Pick<Project, 'arrangement'>): Set<Id> {
  return new Set(p.arrangement.regions.map((r) => r.trackId));
}

/**
 * The rows Simple shows, in track order: instruments with music in the song,
 * and `keep` (one the person added, one being recorded into, one open in the
 * editor or the Sound panel). With no music at all, or while a loop is
 * carried in from LOOPS (`all`), every instrument shows, so there is a row to
 * drop it on.
 */
export function simpleRowIds(p: Pick<Project, 'tracks' | 'arrangement'>, keep: ReadonlySet<Id>, all = false): Id[] {
  const playing = playingIds(p);
  if (all || playing.size === 0) return p.tracks.map((t) => t.id);
  return p.tracks.filter((t) => playing.has(t.id) || keep.has(t.id)).map((t) => t.id);
}

/** The instruments "+ Add instrument" offers: those without a row now, in picker order (then track order). */
export function hiddenInstruments(
  p: Pick<Project, 'tracks'>,
  shown: readonly Id[],
): {
  trackId: Id;
  role: TrackRole;
  name: string;
  kind: string;
  icon: IconName;
}[] {
  const out = p.tracks
    .filter((t) => !shown.includes(t.id))
    .map((t) => ({
      trackId: t.id,
      role: t.role,
      name: t.name,
      kind: INSTRUMENT_KINDS[t.role].name,
      icon: INSTRUMENT_KINDS[t.role].icon,
    }));
  return out.sort((a, b) => INSTRUMENT_ORDER.indexOf(a.role) - INSTRUMENT_ORDER.indexOf(b.role));
}

/* ------------------------------------------------------------------ */
/* Length                                                              */
/* ------------------------------------------------------------------ */

/** How long the song plays, in seconds (to the end of its last loop). */
export function songSeconds(p: Pick<Project, 'arrangement' | 'bpm'>): number {
  return (songBars(p) * 4 * 60) / Math.max(1, p.bpm);
}

/** "1:04" (the header reads "Your song · 1:04"). */
export function songClock(p: Pick<Project, 'arrangement' | 'bpm'>): string {
  return clockText(songSeconds(p));
}

/** "1 minute 4 seconds", for screen readers. */
export function secondsWords(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const sec = `${s} ${s === 1 ? 'second' : 'seconds'}`;
  if (!m) return sec;
  return `${m} ${m === 1 ? 'minute' : 'minutes'}${s ? ` ${sec}` : ''}`;
}

/* ------------------------------------------------------------------ */
/* The tip line                                                        */
/* ------------------------------------------------------------------ */

/** A song shorter than this (seconds) is offered "Make it longer". */
export const SHORT_SONG_S = 30;

export type TipStep = 'loops' | 'fill' | 'bass' | 'longer' | 'share';

const BEAT_ROLES: readonly TrackRole[] = ['drums', 'percussion'];

/** True when some loop in the song has notes or its own recording (an empty new loop plays nothing). */
function songMakesSound(p: Pick<Project, 'tracks' | 'arrangement'>): boolean {
  return p.arrangement.regions.some((r) => {
    const t = p.tracks.find((x) => x.id === r.trackId);
    const clip = t ? clipById(t, r.clipId) : null;
    return !!clip && (clip.notes.length > 0 || !!clip.sample);
  });
}

/**
 * The one next step the tip line offers, from the song as it is:
 * no music → pick a beat; only empty loops (Make a beat from scratch) → fill
 * one in (the editor's grid when it is open); only drums → add a bass; under
 * SHORT_SONG_S → make it longer; else share it.
 */
export function songTip(
  p: Pick<Project, 'tracks' | 'arrangement' | 'bpm'>,
  editorOpen = false,
): {
  step: TipStep;
  text: string;
} {
  const playing = playingIds(p);
  if (playing.size === 0) return { step: 'loops', text: 'Pick a beat from LOOPS on the right' };
  if (!songMakesSound(p))
    return { step: 'fill', text: editorOpen ? 'Click squares in the grid below to add sounds to your loop' : 'Click your loop to add sounds to it' };
  const roles = p.tracks.filter((t) => playing.has(t.id)).map((t) => t.role);
  if (roles.every((r) => BEAT_ROLES.includes(r))) return { step: 'bass', text: 'Add a bass: + Add instrument' };
  if (songSeconds(p) < SHORT_SONG_S) return { step: 'longer', text: 'Make it longer' };
  return { step: 'share', text: 'Share your song' };
}
