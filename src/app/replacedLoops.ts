/**
 * What an edit that puts a loop on a part's row (a take recorded into the
 * song, a library loop added with Enter) took away from that row: loops it
 * covered up, whole or in part. Said with the edit's own message, so
 * nothing is lost silently ("It replaced Bell Hook 2 (bars 10–11)."). Pure:
 * it compares the project before and after the edit.
 */
import { clipById } from '../project/clips';
import type { Id, Project } from '../project/types';

function barsWords(start: number, bars: number): string {
  return bars <= 1 ? `bar ${start + 1}` : `bars ${start + 1}–${start + bars}`;
}

/**
 * "It replaced Bell Hook 2 (bars 10–11)." / "It replaced Rolling (bars 9–12)
 * and part of Bounce." for the regions of part `trackId` that the edit
 * removed or shortened; '' when it covered nothing.
 */
export function replacedLoopsText(before: Project, after: Project, trackId: Id): string {
  const track = before.tracks.find((t) => t.id === trackId);
  if (!track) return '';
  const now = new Map(after.arrangement.regions.map((r) => [r.id, r]));
  const words: string[] = [];
  for (const r of [...before.arrangement.regions].filter((x) => x.trackId === trackId).sort((a, b) => a.start - b.start)) {
    const n = now.get(r.id);
    if (n && n.start === r.start && n.bars === r.bars && n.offset === r.offset && n.clipId === r.clipId) continue;
    const name = clipById(track, r.clipId)?.name || 'a loop';
    words.push(n ? `part of ${name}` : `${name} (${barsWords(r.start, r.bars)})`);
  }
  if (words.length === 0) return '';
  const shown = words.length > 3 ? [...words.slice(0, 2), `${words.length - 2} more loops`] : words;
  const list = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return `It replaced ${list}.`;
}
