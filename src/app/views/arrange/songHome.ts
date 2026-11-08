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
import { mainSection, musicPerBar, regionEnd, sectionAt, songBars, sortSections, spanOf } from '../../../project/arrangement';
import { clipById } from '../../../project/clips';
import type { Id, Project, SongSection, TrackRole } from '../../../project/types';
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
 * or squares in an empty loop), hearing a ready-made song whole (Jump In
 * repeats its main part), a look inside a ready-made song's loop, drums, a
 * bass, chords, a song long enough to be a song, then Share; after Share
 * ('next'), one idea of what to do next, so the line never runs out.
 */
export type TipStep = 'loops' | 'fill' | 'whole' | 'try' | 'beat' | 'bass' | 'chords' | 'longer' | 'share' | 'next';

const BEAT_ROLES: readonly TrackRole[] = ['drums', 'percussion'];
/** Instruments that carry the harmony or a tune (the "chords" step: Keys & chords, a Melody or a Pad). */
const HARMONY_ROLES: readonly TrackRole[] = ['chords', 'lead', 'pad'];

/** What the tip asks for, by instrument ("Add chords: press + Add instrument, then Keys & chords"). */
const ASK_FOR: Partial<Record<TrackRole, string>> = {
  drums: 'Add drums',
  percussion: 'Add a beat',
  bass: 'Add a bass',
  chords: 'Add chords',
  lead: 'Add a melody',
  pad: 'Add a pad',
};

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

/** The song makes a sound: some loop in it has notes or a recording (Share has something to save). */
export function songHasSound(p: Pick<Project, 'tracks' | 'arrangement'>): boolean {
  return soundingTracks(p).length > 0;
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
  /**
   * What a ready-made song repeats while the person has not yet heard it
   * whole (Jump In repeats its main part): the 'whole' step names it.
   */
  repeating?: string | null;
  /** Where LOOPS is: beside the song ('shown', the default), closed, or covered by the Sound panel. */
  loops?: 'shown' | 'closed' | 'sound';
  /** The rows the Song screen shows (what + Add instrument offers is the rest); default: Simple's rows. */
  shown?: readonly Id[];
  /** The song was shared (a music file or the project saved from Share): 'next' ideas follow. */
  shared?: boolean;
  /** Which of the 'next' ideas to offer (counts up; wraps). */
  idea?: number;
}

/**
 * The step for an instrument the song lacks (`roles`, in the order they are
 * suggested): when its row shows with only an empty loop, fill that loop
 * in; else add it with + Add instrument when the picker offers it; when no
 * such instrument can be added at all, null (the tip moves on, never pointing at
 * a choice that is not there).
 */
function addStep(p: Pick<Project, 'tracks' | 'arrangement'>, step: TipStep, roles: readonly TrackRole[], offered: ReadonlySet<TrackRole>): { step: TipStep; text: string } | null {
  const placed = playingIds(p);
  for (const role of roles) {
    // (Its loop is in the song already: it only needs sounds.)
    const t = p.tracks.find((x) => x.role === role && placed.has(x.id));
    if (t) return { step, text: `Click the empty ${instrumentName(t.name, t.role)} loop to add sounds to it` };
    if (offered.has(role)) return { step, text: `${ASK_FOR[role]}: press + Add instrument, then ${INSTRUMENT_KINDS[role].name}` };
  }
  return null;
}

/** What to do once the song is shared: a few plain ideas, in turn (`idea` picks one). */
export function nextIdeas(offered: ReadonlySet<TrackRole>): string[] {
  return [
    ...(offered.has('lead') ? ['Add a melody: press + Add instrument, then Melody'] : []),
    'Try another sound: click an instrument’s name, then Change sound',
    'Make a loop sound new: click it, then Make it different',
    'Keep your project to work on later: press Share, then The project, to keep working',
    ...(offered.size > 0 ? ['Add another instrument: press + Add instrument'] : []),
    'Make your song longer: press Make it longer',
  ];
}

/**
 * The one next step the tip line offers, from the song as it is, in the
 * order a song is built: no music → pick a beat; only empty loops (Make a
 * beat from scratch) → fill one in (the editor's grid when it is open); a
 * ready-made song still repeating its main part → hear it whole; untouched
 * (Jump In) → click a loop to change it; then a beat, a bass, chords (or a
 * melody or pad), each while the song has none and + Add instrument offers
 * one (else its empty loop, else on to the next step); then make it longer
 * until it lasts SHARE_SONG_S; and only then, with SHARE_INSTRUMENTS
 * instruments or more playing, share it. Once shared, ideas of what next.
 */
export function songTip(p: Pick<Project, 'tracks' | 'arrangement' | 'bpm'>, state: TipState | boolean = {}): { step: TipStep; text: string } {
  const { editorOpen = false, fresh = false, repeating = null, loops = 'shown', shown, shared = false, idea = 0 } = typeof state === 'boolean' ? { editorOpen: state } : state;
  if (playingIds(p).size === 0) {
    const text = loops === 'shown' ? 'Pick a beat from Loops on the right' : loops === 'sound' ? 'Close the sound panel on the right (✕), then pick a beat from Loops' : 'Press Loops at the top of your song, then pick a beat';
    return { step: 'loops', text };
  }
  const sounding = soundingTracks(p);
  if (!sounding.length)
    return { step: 'fill', text: editorOpen ? 'Click squares in the grid below to add sounds to your loop' : 'Click your loop to add sounds to it' };
  if (repeating) return { step: 'whole', text: `To hear your whole song, press ⟳ Repeating: ${repeating} at the top` };
  if (fresh && !editorOpen) return { step: 'try', text: 'Click any loop in your song to change its notes' };
  const offered = new Set(hiddenInstruments(p, shown ?? simpleRowIds(p, new Set())).map((h) => h.role));
  const roles = new Set(sounding.map((t) => t.role));
  const has = (list: readonly TrackRole[]) => list.some((r) => roles.has(r));
  const lacking: [TipStep, readonly TrackRole[]][] = [
    ['beat', BEAT_ROLES],
    ['bass', ['bass']],
    ['chords', HARMONY_ROLES],
  ];
  for (const [step, list] of lacking) {
    if (has(list)) continue;
    const ask = addStep(p, step, list, offered);
    if (ask) return ask;
  }
  if (songSeconds(p) < SHARE_SONG_S) return { step: 'longer', text: 'Make your song longer: press Make it longer' };
  if (sounding.length < SHARE_INSTRUMENTS && offered.size > 0) return { step: 'chords', text: 'Add another instrument: press + Add instrument' };
  if (!shared) return { step: 'share', text: 'Share your song: press Share at the top right' };
  const ideas = nextIdeas(offered);
  return { step: 'next', text: ideas[((idea % ideas.length) + ideas.length) % ideas.length] };
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

/* ------------------------------------------------------------------ */
/* Make it longer / shorter                                            */
/* ------------------------------------------------------------------ */

/**
 * The song has an intro (its first section is called Intro…) and an ending
 * (its last section is called Ending… or fades out): Make it longer offers
 * Add an intro and Add an ending only while the song has none.
 */
export function songEdges(p: Pick<Project, 'arrangement'>): { intro: boolean; ending: boolean } {
  const sorted = sortSections(p.arrangement.sections);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    intro: !!first && /^intro\b/i.test(first.name.trim()),
    ending: !!last && (/^(ending|outro)\b/i.test(last.name.trim()) || !!last.moves?.some((m) => m.kind === 'fadeOut')),
  };
}

/**
 * What "Make it shorter" can take out (Simple), never the song's only
 * section: its last section, and the section at the playhead (`bar`) when
 * that is another one. Null for each when there is nothing to take out.
 */
export function shorterChoices(p: Pick<Project, 'arrangement'>, bar: number): { last: SongSection | null; here: SongSection | null } {
  const sorted = sortSections(p.arrangement.sections);
  if (sorted.length < 2) return { last: null, here: null };
  const last = sorted[sorted.length - 1];
  const at = sectionAt(sorted, bar);
  return { last, here: at && at.id !== last.id ? at : null };
}

/**
 * Where a loop dropped from LOOPS lands in Simple, at the bar under the
 * pointer (`bar`): the start of the section there, so a repeat of that
 * section never starts with silence; with no section there, right after the
 * section before (no gap after the music); with no sections at all, the start
 * of the song's music (it plays along with what is there).
 */
export function simpleDropBar(p: Pick<Project, 'arrangement'>, bar: number): number {
  const sorted = sortSections(p.arrangement.sections);
  const b = Math.max(0, Math.floor(bar));
  if (!sorted.length) return spanOf(p.arrangement.regions)?.[0] ?? 0;
  const at = sectionAt(sorted, b);
  if (at) return at.start;
  const before = sorted.filter((s) => regionEnd(s) <= b);
  return before.length ? Math.max(...before.map((s) => regionEnd(s))) : sorted[0].start;
}
