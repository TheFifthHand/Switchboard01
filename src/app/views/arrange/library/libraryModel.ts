/**
 * The Song view's loop library in words and numbers (pure: no DOM, no
 * React, no audio): which loops a search and the Part and Style chips show,
 * which part a loop goes to when it is added with Enter (or heard with ▶),
 * whether a part can play it (and why not, in plain words), and the notes it
 * gets on that part (in the song's key, on the part's kit).
 */
import { BEATS, beatLoop, getBeat, type BeatDef } from '../../../../content/beats';
import { GENRES, LOOP_ROLES, LOOP_ROLE_NAMES, getLoop, loopFitsKind, realizeLoop, searchLoops, type LibraryLoop, type LoopGenre, type LoopRole, type RealizedLoop } from '../../../../content/loops';
import { trackClips } from '../../../../project/clips';
import type { Id, Project, Track, TrackRole } from '../../../../project/types';

/** Rows the library lists before "Show more" (each press shows this many more). */
export const LIBRARY_PAGE = 30;
/** A project with fewer loops of its own than this opens the browser on the Library tab. */
export const FEW_LOOPS = 4;

export type BrowserTab = 'song' | 'library';

/** The Part chips: each loop role with its plain name ("Beats", "Melody"…). */
export const PART_CHIPS: readonly { role: LoopRole; name: string }[] = LOOP_ROLES.map((role) => ({ role, name: LOOP_ROLE_NAMES[role] }));

export interface LibraryQuery {
  text: string;
  role: LoopRole | null;
  genre: LoopGenre | null;
}

/** The loops a search and the chips show, best match first. */
export function libraryResults(q: LibraryQuery): LibraryLoop[] {
  return searchLoops(q.text, { role: q.role ?? undefined, genre: q.genre ?? undefined });
}

/** The Style chips for a part (styles with at least one loop for it; every style without a part). */
export function styleChips(role: LoopRole | null): readonly { id: LoopGenre; name: string }[] {
  if (!role) return GENRES;
  const used = new Set(searchLoops('', { role }).flatMap((l) => l.genres));
  return GENRES.filter((g) => used.has(g.id));
}

export function styleName(id: LoopGenre): string {
  return GENRES.find((g) => g.id === id)?.name ?? id;
}

/** How many loops the project has of its own (pads and song). */
export function ownLoopCount(p: Pick<Project, 'tracks'>): number {
  let n = 0;
  for (const t of p.tracks) n += trackClips(t).length;
  return n;
}

/** The tab the browser opens on: the library while the project has few loops of its own. */
export function defaultTab(p: Pick<Project, 'tracks'>): BrowserTab {
  return ownLoopCount(p) < FEW_LOOPS ? 'library' : 'song';
}

/** The library's part for a part of the song (null: the sampler, which has no library loops). */
export function loopRoleOf(t: Pick<Track, 'role'>): LoopRole | null {
  return (LOOP_ROLES as readonly TrackRole[]).includes(t.role) ? (t.role as LoopRole) : null;
}

/** A loop by id: a library loop or a beat (beat ids are the drum loops' ids). */
export function libraryLoop(id: string): LibraryLoop | null {
  const l = getLoop(id);
  if (l) return l;
  const b = getBeat(id);
  return b ? beatLoop(b) : null;
}

/** Why `t` cannot play `loop`, in plain words (null: it can). */
export function partProblem(loop: LibraryLoop, t: Pick<Track, 'name' | 'instrument'>): string | null {
  if (loopFitsKind(loop, t.instrument.kind)) return null;
  return loop.part.kind === 'drums'
    ? `“${loop.name}” is a drum loop and ${t.name} plays notes: put it on a drum or percussion part.`
    : `“${loop.name}” plays notes and ${t.name} is a drum kit: put it on a synth or sampler part.`;
}

/** Short words for a part that cannot play a loop (shown at the pointer while it is dragged). */
export function partProblemShort(loop: LibraryLoop): string {
  return loop.part.kind === 'drums' ? 'Needs a drum part' : 'Needs a synth part';
}

/**
 * The part a loop goes to with Enter (and plays on with ▶): the selected
 * part when it is the loop's kind of part, else the first part of that kind
 * (Beats → the drum part, Bass → the bass part); without one, the selected
 * part or the first part that can play it. `problem`: why no part can.
 */
export function loopTarget(p: Pick<Project, 'tracks'>, loop: LibraryLoop, selectedId: Id | null): { trackId: Id } | { problem: string } {
  const fits = p.tracks.filter((t) => loopFitsKind(loop, t.instrument.kind));
  const sameRole = fits.filter((t) => t.role === loop.role);
  const pick = sameRole.find((t) => t.id === selectedId) ?? sameRole[0] ?? fits.find((t) => t.id === selectedId) ?? fits[0];
  if (pick) return { trackId: pick.id };
  return { problem: loop.part.kind === 'drums' ? `This song has no drum part to play “${loop.name}”.` : `This song has no synth or sampler part to play “${loop.name}”.` };
}

/** The register a pitched loop is placed in on a part: the part's own job when it has one, else the loop's. */
function registerRole(loop: LibraryLoop, t: Pick<Track, 'role'>): TrackRole {
  return t.role === 'bass' || t.role === 'chords' || t.role === 'lead' || t.role === 'pad' || t.role === 'texture' ? t.role : loop.role;
}

/** The notes a loop gets on a part: in the song's key and the part's register, or on the part's kit. Null when the part cannot play it. */
export function realizeFor(p: Pick<Project, 'root' | 'scale'>, loop: LibraryLoop, t: Pick<Track, 'role' | 'instrument' | 'name'>): RealizedLoop | null {
  if (partProblem(loop, t)) return null;
  return realizeLoop(loop, {
    root: p.root,
    scale: p.scale,
    kind: t.instrument.kind,
    kitId: t.instrument.kind === 'drums' ? t.instrument.kitId : undefined,
    role: registerRole(loop, t),
  });
}

/** `name`, or "<name> 2", "<name> 3"… when the part already has a loop called that (pads or song). */
export function freshName(t: Track, name: string): string {
  const used = new Set(trackClips(t).map((c) => c.clip.name));
  if (!used.has(name)) return name;
  for (let n = 2; ; n++) if (!used.has(`${name} ${n}`)) return `${name} ${n}`;
}

/* ------------------------------------------------------------------ */
/* Beats ("Start from a beat…")                                        */
/* ------------------------------------------------------------------ */

/** The beats grouped by their main style, in the styles' display order. */
export function beatsByStyle(): { genre: LoopGenre; name: string; beats: BeatDef[] }[] {
  return GENRES.map((g) => ({ genre: g.id, name: g.name, beats: BEATS.filter((b) => b.genre === g.id) })).filter((g) => g.beats.length > 0);
}

/** "1 bar · 92 BPM" for a beat. */
export function beatMeta(b: Pick<BeatDef, 'bars' | 'bpm'>): string {
  return `${b.bars === 1 ? '1 bar' : `${b.bars} bars`} · ${b.bpm} BPM`;
}
