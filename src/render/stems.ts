/**
 * "Parts as separate files" (stems), pure: which parts get a file, the
 * project each one is rendered from, and the .zip that holds them.
 *
 * A part gets a file when the song lets you hear it (not muted, soloed when
 * any part is) and it plays at least one note over what is exported. Each
 * file is that part on its own: the project with only that part soloed, so
 * it keeps its own effects and its share of the shared Reverb and Echo, and
 * the song's moves. Stems are rendered without the mastering (the output
 * limiter still keeps peaks under −1 dBTP): they are for mixing elsewhere,
 * where the mastering is done on the sum.
 */
import { zipSync, type Zippable } from 'fflate';
import type { Id, Project } from '../project/types';
import { exportNotes, type NoteSource } from './midi';

export interface StemPart {
  trackId: Id;
  name: string;
}

/** The parts that get a file, in part order. */
export function stemParts(project: Project, source: NoteSource): StemPart[] {
  return exportNotes(project, source)
    .filter((p) => p.notes.length > 0)
    .map((p) => ({ trackId: p.trackId, name: p.name }));
}

/** The project with only `trackId` heard (soloed, unmuted; every other part un-soloed). */
export function soloPart(project: Project, trackId: Id): Project {
  return { ...project, tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, mute: false, solo: true } : t.solo ? { ...t, solo: false } : t)) };
}

const UNSAFE = /[\\/:*?"<>|]+/g;

/** "01 Drums.wav": the part's number keeps the files in part order; names repeat safely ("03 Lead (2).wav"). */
export function stemFileNames(parts: readonly { name: string; index: number }[], ext: string): string[] {
  const used = new Set<string>();
  return parts.map((p) => {
    const base = `${String(p.index + 1).padStart(2, '0')} ${p.name.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim() || 'Part'}`;
    let name = `${base}.${ext}`;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base} (${k}).${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** A .zip of the files, stored without compression (audio hardly compresses, and storing is instant). */
export function zipFiles(files: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const z: Zippable = {};
  for (const f of files) z[f.name] = [f.data, { level: 0 }];
  return zipSync(z);
}
