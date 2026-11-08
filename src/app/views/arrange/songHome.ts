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
import { mainSection, musicPerBar, regionEnd, songBars, sortSections, spanOf } from '../../../project/arrangement';
import { clipById } from '../../../project/clips';
import type { Id, Project, TrackRole } from '../../../project/types';
import type { IconName } from '../../../ui/components';
import { INSTRUMENT_WORDS, simpleTrackName } from '../../labels';
import { clockText } from './songModel';

/* ------------------------------------------------------------------ */
/* Kinds of instrument                                                 */
/* ------------------------------------------------------------------ */

/** What a beginner calls each kind of instrument (the picker's words, INSTRUMENT_WORDS), and its picture. */
export const INSTRUMENT_KINDS: Readonly<Record<TrackRole, { name: string; icon: IconName }>> = {
  drums: { name: INSTRUMENT_WORDS.drums, icon: 'drum' },
  percussion: { name: INSTRUMENT_WORDS.percussion, icon: 'bell' },
  bass: { name: INSTRUMENT_WORDS.bass, icon: 'wave' },
  chords: { name: INSTRUMENT_WORDS.chords, icon: 'keys' },
  lead: { name: INSTRUMENT_WORDS.lead, icon: 'sparkle' },
  pad: { name: INSTRUMENT_WORDS.pad, icon: 'layers' },
  texture: { name: INSTRUMENT_WORDS.texture, icon: 'spectrum' },
  sampler: { name: INSTRUMENT_WORDS.sampler, icon: 'mic' },
};

/**
 * The name Simple shows for an instrument: the picker's word when the instrument still has 2.4's default
 * name and was never renamed ("Lead" → "Melody", "Chords" → "Keys & chords", "Sampler" → "Recording"),
 * else the name it was given (simpleTrackName). Display only: the project keeps its names.
 */
export function instrumentName(name: string, role: TrackRole, renamed?: boolean): string {
  return simpleTrackName({ name, role, renamed: renamed ? true : undefined });
}

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
      name: simpleTrackName(t),
      kind: INSTRUMENT_KINDS[t.role].name,
      icon: INSTRUMENT_KINDS[t.role].icon,
    }));
  return out.sort((a, b) => INSTRUMENT_ORDER.indexOf(a.role) - INSTRUMENT_ORDER.indexOf(b.role));
}

/**
 * Where "+ Add instrument" puts a new instrument's loop (pure): over the
 * song's main parts (from the first to the last section that plays as much
 * music as the main one, mainSection; an intro and an ending, which have
 * less, are left as they are), else over all of the music, else from `bar`.
 */
export function instrumentRange(p: Pick<Project, 'arrangement'>, bar: number): { start: number; bars: number | null; name: string | null } {
  const main = mainSection(p);
  if (main) {
    const full = musicPerBar(p.arrangement.regions, main);
    const body = sortSections(p.arrangement.sections).filter((s) => !s.moves?.some((m) => m.kind === 'fadeOut') && musicPerBar(p.arrangement.regions, s) >= full - 1e-9);
    const from = Math.min(main.start, ...body.map((s) => s.start));
    const to = Math.max(regionEnd(main), ...body.map((s) => regionEnd(s)));
    const one = body.length <= 1 || (from === main.start && to === regionEnd(main));
    return { start: from, bars: to - from, name: one ? main.name : null };
  }
  const span = spanOf(p.arrangement.regions);
  if (span) return { start: span[0], bars: span[1] - span[0], name: null };
  return { start: Math.max(0, Math.floor(bar)), bars: null, name: null };
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

/** A song shorter than this (seconds) is offered "Make it longer"; Share waits for it. */
export const SHARE_SONG_S = 45;

/** Share waits for this many instruments that make sound. */
export const SHARE_INSTRUMENTS = 3;

/**
 * The first session the tip line walks through, in order: a beat (from LOOPS,
 * or squares in an empty loop), a look inside a ready-made song's loop, drums,
 * a bass, chords, a song long enough to be a song, then Share.
 */
export type TipStep = 'loops' | 'fill' | 'try' | 'beat' | 'bass' | 'chords' | 'longer' | 'share';

const BEAT_ROLES: readonly TrackRole[] = ['drums', 'percussion'];
/** Instruments that carry the harmony or a tune (the "chords" step: Keys & chords, a Melody or a Pad). */
const HARMONY_ROLES: readonly TrackRole[] = ['chords', 'lead', 'pad'];

/** The instruments with a loop in the song that has notes or its own recording (an empty new loop plays nothing). */
function soundingTracks(p: Pick<Project, 'tracks' | 'arrangement'>): Pick<Project['tracks'][number], 'id' | 'role'>[] {
  const ids = new Set<Id>();
  for (const r of p.arrangement.regions) {
    const t = p.tracks.find((x) => x.id === r.trackId);
    const clip = t ? clipById(t, r.clipId) : null;
    if (clip && (clip.notes.length > 0 || !!clip.sample)) ids.add(r.trackId);
  }
  return p.tracks.filter((t) => ids.has(t.id));
}

/** A ready-made song nobody has changed yet: built from a starter (not the blank one) and never edited since. */
export function isUntouchedStarter(p: Pick<Project, 'starterId' | 'createdAt' | 'updatedAt'>): boolean {
  return !!p.starterId && p.starterId !== 'blank' && p.updatedAt === p.createdAt;
}

export interface TipState {
  /** The loop editor is open (the "fill" step points at its grid). */
  editorOpen?: boolean;
  /** A ready-made song nobody has changed or opened a loop of yet (Jump In): suggest something to try in it. */
  fresh?: boolean;
}

/**
 * The one next step the tip line offers, from the song as it is, in the
 * order a song is built: no music → pick a beat; only empty loops (Make a
 * beat from scratch) → fill one in (the editor's grid when it is open); a
 * ready-made song untouched (Jump In) → click a loop to change it; then a
 * beat, a bass, chords (or a melody or pad), each while the song has none;
 * then make it longer until it lasts SHARE_SONG_S; and only then, with
 * SHARE_INSTRUMENTS instruments or more playing, share it.
 */
export function songTip(p: Pick<Project, 'tracks' | 'arrangement' | 'bpm'>, state: TipState | boolean = {}): { step: TipStep; text: string } {
  const { editorOpen = false, fresh = false } = typeof state === 'boolean' ? { editorOpen: state } : state;
  if (playingIds(p).size === 0) return { step: 'loops', text: 'Pick a beat from Loops on the right' };
  const sounding = soundingTracks(p);
  if (!sounding.length)
    return { step: 'fill', text: editorOpen ? 'Click squares in the grid below to add sounds to your loop' : 'Click your loop to add sounds to it' };
  if (fresh && !editorOpen) return { step: 'try', text: 'Click any loop in your song to change its notes' };
  const roles = new Set(sounding.map((t) => t.role));
  const has = (list: readonly TrackRole[]) => list.some((r) => roles.has(r));
  if (!has(BEAT_ROLES)) return { step: 'beat', text: 'Add drums: press + Add instrument, then Drums' };
  if (!roles.has('bass')) return { step: 'bass', text: 'Add a bass: press + Add instrument, then Bass' };
  if (!has(HARMONY_ROLES)) return { step: 'chords', text: 'Add chords: press + Add instrument, then Keys & chords' };
  if (songSeconds(p) < SHARE_SONG_S) return { step: 'longer', text: 'Make your song longer: press Make it longer' };
  if (sounding.length < SHARE_INSTRUMENTS) return { step: 'chords', text: 'Add another instrument: press + Add instrument' };
  return { step: 'share', text: 'Share your song: press Share at the top right' };
}

/* ------------------------------------------------------------------ */
/* Plain words for places and lengths                                  */
/* ------------------------------------------------------------------ */

/** Where bar `bar` (0-based) starts, as a clock time ("0:15"). */
export function timeAt(bar: number, bpm: number): string {
  return clockText((Math.max(0, bar) * 4 * 60) / Math.max(1, bpm));
}

/** How long `bars` bars last, in words ("8 seconds", "1 minute 4 seconds"); under 10 s with one decimal ("3.9 seconds"). */
export function lastsText(bars: number, bpm: number): string {
  const s = (bars * 4 * 60) / Math.max(1, bpm);
  if (s < 10) {
    const t = Math.round(s * 10) / 10;
    return `${t} ${t === 1 ? 'second' : 'seconds'}`;
  }
  return secondsWords(s);
}

/** A loop's length as a beginner hears it: "Short" (up to 2 bars) or "Long". */
export function shortOrLong(bars: number): 'Short' | 'Long' {
  return bars <= 2 ? 'Short' : 'Long';
}

/**
 * What a repeat range is called in Simple: the whole song, the section it covers
 * exactly ("Groove"), a run of whole sections ("Verse to Chorus": the repeat
 * follows edits section by section, followSongLoop), else "the marked stretch"
 * (a range marked on the ruler).
 */
export function repeatName(sections: readonly { id: Id; name: string; start: number; bars: number }[], range: { fromBar: number; toBar: number }, length: number): string {
  if (range.fromBar === 0 && range.toBar >= length) return 'the whole song';
  const first = sections.find((x) => x.start === range.fromBar);
  const last = sections.find((x) => x.start + x.bars === range.toBar);
  if (first && last && first.start <= last.start) return first.id === last.id ? first.name : `${first.name} to ${last.name}`;
  return 'the marked stretch';
}
