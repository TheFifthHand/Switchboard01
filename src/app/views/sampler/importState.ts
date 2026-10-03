/**
 * Import progress per part, shared by every import control of that part
 * (the sampler editor's button and drop zone, the sound browser).
 *
 * Kept outside the components so the status survives the editor switching
 * from its drop zone (part without a recording) to the full sampler editor
 * the moment an import turns the part into a sampler, and so a second import
 * cannot start on a part while one is still decoding.
 *
 * An import makes a new clip that plays the file (shape-05; see
 * session.importSample). Before anything is decoded a chosen file is
 * checked (checkImport):
 * - a part with no empty pad is refused at once, with what to do instead;
 * - a drum or synth part with clips asks first (phase 'confirm'): the part
 *   becomes a sampler and those clips would play the recording at their
 *   notes' pitches, so it offers a sampler part with room instead.
 * A finished import's message also goes to the toast, with Undo.
 */
import { createStore } from '../../../state/store';
import { MAX_SCENES, type Id, type Project } from '../../../project/types';
import { session } from '../../instance';
import { INSTRUMENT_LABEL, soundName } from '../../labels';
import { notify } from '../../runtime';

/** Another part the file could go on instead. */
export interface ImportAlternative {
  trackId: Id;
  name: string;
}

export type ImportStatus =
  | { phase: 'idle' }
  /** A drum or synth part with clips: the file waits for a choice (onto this part anyway, onto `alternative`, or not at all). */
  | { phase: 'confirm'; file: File; fileName: string; message: string; alternative: ImportAlternative | null; toast: boolean }
  | { phase: 'decoding'; fileName: string }
  /** `at`: performance.now() when the import finished. */
  | { phase: 'done'; ok: boolean; message: string; fileName: string; at: number };

const IDLE: ImportStatus = { phase: 'idle' };

export const importStore = createStore<Record<Id, ImportStatus>>({});

// Results belong to the project they happened in: opening another project clears them.
session.store.subscribe((p, prev) => {
  if (p.id !== prev.id && Object.keys(importStore.getState()).length > 0) importStore.setState({});
});

export function importStatusOf(state: Record<Id, ImportStatus>, trackId: Id): ImportStatus {
  return state[trackId] ?? IDLE;
}

function setStatus(trackId: Id, status: ImportStatus): void {
  importStore.setState((s) => ({ ...s, [trackId]: status }));
}

/** Forget a finished result (the message is dismissed). */
export function clearImportStatus(trackId: Id): void {
  const cur = importStore.getState()[trackId];
  if (cur && cur.phase === 'done') setStatus(trackId, IDLE);
}

/* ------------------------------------------------------------------ */
/* Checks before decoding                                              */
/* ------------------------------------------------------------------ */

export type ImportCheck =
  | { kind: 'ok' }
  /** Nothing can be imported onto this part now (no empty pad). */
  | { kind: 'refused'; message: string }
  /** The part becomes a sampler and its clips with notes would play the recording at their pitches. */
  | { kind: 'converts'; message: string; alternative: ImportAlternative | null };

/** True when the part has an empty pad for a new clip. */
function hasEmptyPad(p: Project, trackId: Id): boolean {
  return p.tracks.find((t) => t.id === trackId)?.clips.some((c) => !c) ?? false;
}

/** A sampler part (other than `trackId`) with an empty pad, Sampler-role parts first. */
export function samplerWithRoom(p: Project, trackId: Id): ImportAlternative | null {
  const fits = p.tracks.filter((t) => t.id !== trackId && t.instrument.kind === 'sampler' && t.clips.some((c) => !c));
  const best = fits.find((t) => t.role === 'sampler') ?? fits[0];
  return best ? { trackId: best.id, name: best.name } : null;
}

/** Why a part cannot take an import, in words (it has no empty pad). */
export function noPadMessage(p: Project, trackId: Id): string {
  const t = p.tracks.find((x) => x.id === trackId);
  const name = t?.name ?? 'This part';
  const rows = t?.clips.length ?? 0;
  const more = p.scenes.length < MAX_SCENES ? ', or add a scene in Play for a new row' : '';
  return `${name} has no empty pad: all ${rows} of its rows hold clips, and an import makes a new clip. Delete or move a clip on ${name}${more}, then import again.`;
}

/** What importing onto `trackId` would do, before any file is decoded. */
export function checkImport(p: Project, trackId: Id): ImportCheck {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return { kind: 'refused', message: 'That part is not in this project.' };
  if (!hasEmptyPad(p, trackId)) return { kind: 'refused', message: noPadMessage(p, trackId) };
  if (t.instrument.kind === 'sampler') return { kind: 'ok' };
  // The new clip goes on an empty pad: every clip there now would play the recording.
  const used = t.clips.filter((c): c is NonNullable<typeof c> => !!c && c.notes.length > 0);
  if (!used.length) return { kind: 'ok' };
  const what = `the ${INSTRUMENT_LABEL[t.instrument.kind].toLowerCase()} ${soundName(p, t.instrument)}`;
  const clips = used.length === 1 ? `its clip “${used[0].name}” would then play` : `its ${used.length} clips (${used.map((c) => `“${c.name}”`).join(', ')}) would then play`;
  const low = t.instrument.kind === 'drums' ? ' (drum hits become very low notes)' : '';
  return {
    kind: 'converts',
    message: `${t.name} plays ${what}. An import makes ${t.name} a sampler, and ${clips} your recording at their notes’ pitches${low}. Undo brings ${soundName(p, t.instrument)} back.`,
    alternative: samplerWithRoom(p, trackId),
  };
}

/* ------------------------------------------------------------------ */
/* Importing                                                           */
/* ------------------------------------------------------------------ */

/** How an import reports its result besides its status line. */
export interface ImportOptions {
  /**
   * Also show the result in the toast, tied to its undo step (default true).
   * The sound browser says it in its own status line instead: a toast over a
   * modal dialog would only cover its keys (its Undo is hidden there).
   */
  toast?: boolean;
}

/**
 * A file chosen or dropped for a part: checked first (refused at once when
 * the part has no empty pad; a drum or synth part with clips waits for a
 * choice, phase 'confirm'), else imported. Returns the result, or null while
 * it waits for the choice.
 */
export async function chooseFileForPart(file: File, trackId: Id, opts: ImportOptions = {}): Promise<{ ok: boolean; message: string } | null> {
  const cur = importStore.getState()[trackId];
  if (cur?.phase === 'decoding') return { ok: false, message: `Still decoding "${cur.fileName}". Wait for it to finish, then try again.` };
  const check = checkImport(session.store.getState(), trackId);
  if (check.kind === 'refused') {
    setStatus(trackId, { phase: 'done', ok: false, message: check.message, fileName: file.name, at: performance.now() });
    return { ok: false, message: check.message };
  }
  if (check.kind === 'converts') {
    setStatus(trackId, { phase: 'confirm', file, fileName: file.name, message: check.message, alternative: check.alternative, toast: opts.toast !== false });
    return null;
  }
  return importFileToPart(file, trackId, opts);
}

/**
 * The choice for a file waiting on `trackId`: 'here' imports it onto that
 * part anyway, 'alternative' onto the sampler part offered (which is then
 * selected), 'cancel' drops it. Returns the result (null: cancelled).
 */
export async function resolveImport(trackId: Id, choice: 'here' | 'alternative' | 'cancel'): Promise<{ ok: boolean; message: string } | null> {
  const cur = importStore.getState()[trackId];
  if (cur?.phase !== 'confirm') return null;
  if (choice === 'cancel') {
    setStatus(trackId, IDLE);
    return null;
  }
  if (choice === 'alternative' && cur.alternative) {
    const alt = cur.alternative;
    setStatus(trackId, IDLE);
    const res = await importFileToPart(cur.file, alt.trackId, { toast: cur.toast });
    // This part's controls say where it went too.
    setStatus(trackId, { phase: 'done', ok: res.ok, message: res.ok ? `Put on ${alt.name} instead. ${res.message}` : res.message, fileName: cur.fileName, at: performance.now() });
    return res;
  }
  return importFileToPart(cur.file, trackId, { toast: cur.toast });
}

/**
 * Decode, store and put a file on a part as a new clip through the session
 * (no checks: see chooseFileForPart). The project is untouched when anything
 * fails; the status carries the message, and a finished import's message
 * goes to the toast with Undo.
 */
export async function importFileToPart(file: File, trackId: Id, opts: ImportOptions = {}): Promise<{ ok: boolean; message: string }> {
  const cur = importStore.getState()[trackId];
  if (cur?.phase === 'decoding') return { ok: false, message: `Still decoding "${cur.fileName}". Wait for it to finish, then try again.` };
  setStatus(trackId, { phase: 'decoding', fileName: file.name });
  let res: { ok: boolean; message: string };
  try {
    res = await session.importSample(file, trackId);
  } catch (e) {
    res = { ok: false, message: `The recording could not be imported: ${e instanceof Error ? e.message : String(e)}` };
  }
  // A full part found only now (a clip added while decoding): say what to do, as the check does.
  if (!res.ok && !hasEmptyPad(session.store.getState(), trackId) && /^No empty pad/.test(res.message)) res = { ok: false, message: noPadMessage(session.store.getState(), trackId) };
  setStatus(trackId, { phase: 'done', ok: res.ok, message: res.message, fileName: file.name, at: performance.now() });
  if (res.ok && opts.toast !== false) notify(res.message, 'info', 'undo');
  return res;
}

/** True while a file is being decoded and stored for this part. */
export function importInProgress(trackId: Id): boolean {
  return importStore.getState()[trackId]?.phase === 'decoding';
}

/** True when an import onto this part succeeded within the last `ms` milliseconds. */
export function importedRecently(trackId: Id, ms = 3000): boolean {
  const s = importStore.getState()[trackId];
  return !!s && s.phase === 'done' && s.ok && performance.now() - s.at < ms;
}
