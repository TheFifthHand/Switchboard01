/**
 * Making a file of the song: what Share (Simple) and Export (Advanced) have
 * in common. Every audio file is rendered offline by the session's engine
 * (the same sounds, effects and timing as playback) from a copy of the
 * project: a Sound preset or "as loud as streaming songs" changes that copy,
 * never the project, and never adds an undo step.
 *
 * Loud: the copy is rendered and measured, and when it is more than
 * LOUD_TOLERANCE_DB from the target it is rendered again with the
 * mastering's Loudness drive moved (scaled by what the last correction did,
 * as Match in Mix does), at most LOUD_PASSES times. The output limiter stays,
 * so nothing clips.
 */
import { measureLoudness } from '../../../render/loudness';
import { encodeWav } from '../../../render/wav';
import { songMidi, type NoteSource } from '../../../render/midi';
import { soloPart, stemFileNames, stemParts, zipFiles } from '../../../render/stems';
import { loudnessDriveAfter, masteringDiverges, presetSettings } from '../../../state/commands';
import { MASTERING_PARAMS, neutralMasteringParams, readParam } from '../../../project/params';
import type { Project } from '../../../project/types';
import type { UiMode } from '../../../state/uiStore';
import { trackNameIn } from '../../labels';

export type FileFormat = 'wav' | 'opus' | 'stems' | 'midi';

/** File extension per format: the small file is Opus in an Ogg file, which players know as .ogg. */
export const FILE_EXT: Record<FileFormat, string> = { wav: 'wav', opus: 'ogg', stems: 'zip', midi: 'mid' };
export const FILE_MIME: Record<FileFormat, string> = { wav: 'audio/wav', opus: 'audio/ogg', stems: 'application/zip', midi: 'audio/midi' };

/** Loud: a render this close to the target (dB) is kept as it is. */
export const LOUD_TOLERANCE_DB = 0.5;
/** Loud: at most this many corrections (each one renders the song again). */
export const LOUD_PASSES = 2;
/** Quieter than this (LUFS) is not music to match: silence, or everything muted. */
export const LOUD_FLOOR_LUFS = -40;

/** Characters a file name cannot hold on common systems. */
const UNSAFE = /[\\/:*?"<>|]+/g;

/** Control characters (tabs, line breaks and the invisible ones): never in a file name. */
const CONTROL = /\p{Cc}+/gu;

/**
 * A file name without the characters file systems refuse, spaces collapsed ("My: song / test?" → "My song test").
 * Letters of every script stay ("歌" → "歌"); control characters go, and so do dots and spaces at the end
 * ("name." → "name", so the file is never "name..wav").
 */
export function safeName(s: string): string {
  const out = Array.from(s.normalize('NFC').replace(UNSAFE, ' ').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim())
    .slice(0, 80)
    .join('')
    .replace(/[.\s]+$/, '');
  return out || 'omni-song';
}

/** True when `safeName` would leave characters out of what was typed (other than spaces it tidies). */
export function nameLosesCharacters(s: string): boolean {
  return /[\\/:*?"<>|\p{Cc}]/u.test(s) || /\.\s*$/.test(s);
}

/**
 * "about 40 s left" from how far the render is and how long it has taken (null while too early to say).
 * `passesAfter`: renders still to come after this one, each about as long (the loudness pass of a loud file).
 */
export function timeLeftText(fraction: number, elapsedMs: number, passesAfter = 0): string | null {
  if (!(fraction > 0.02) || elapsedMs < 1000 || fraction >= 1) return null;
  const left = ((elapsedMs / fraction) * (1 - fraction + passesAfter)) / 1000;
  if (left < 8) return 'a few seconds left';
  if (left < 60) return `about ${Math.max(10, Math.round(left / 5) * 5)} s left`;
  const min = Math.round(left / 60);
  return `about ${min} min left`;
}

/** "2:19" (minutes and seconds, as a music player shows a length). */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function abortIfAsked(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
}

export const stereo = (b: AudioBuffer) => [b.getChannelData(0), b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)];

/** What a progress line shows while a file is made. */
export interface Busy {
  /** "Exporting", "Checking loudness", "Part 2 of 5 (Bass)" … */
  phase: string;
  fraction: number;
  left: string | null;
}

/** A progress callback for one phase that also tells the time left once it can (`passesAfter`: renders still to come). */
export function progressTracker(set: (b: Busy) => void, phase: string, passesAfter = 0): (fraction: number) => void {
  const started = performance.now();
  let shownAt = 0;
  let left: string | null = null;
  set({ phase, fraction: 0, left: null });
  return (f: number) => {
    const now = performance.now();
    // The estimate settles if it is not redrawn on every chunk.
    if (now - shownAt >= 500) {
      shownAt = now;
      left = timeLeftText(f, now - started, passesAfter);
    }
    set({ phase, fraction: f, left });
  };
}

/* ------------------------------------------------------------------ */
/* Copies of the project (never stored)                                */
/* ------------------------------------------------------------------ */

/** The project as it would sound with a mastering preset (mastering on). Unknown preset: the project as it is. */
export function withPreset(p: Project, presetId: string): Project {
  const params = presetSettings(presetId);
  if (!params) return p;
  return { ...p, mastering: { ...p.mastering, enabled: true, params, presetId } };
}

/** The project with its mastering on: with neutral settings (which sound exactly like no mastering) when it was off. */
export function withMasteringOn(p: Project): Project {
  return p.mastering.enabled ? p : { ...p, mastering: { enabled: true, params: neutralMasteringParams() } };
}

/** The project with the mastering's Loudness drive at `v`. */
export function withDrive(p: Project, v: number): Project {
  return { ...p, mastering: { ...p.mastering, params: { ...p.mastering.params, loudness: v } } };
}

/* ------------------------------------------------------------------ */
/* Share's Sound chips                                                 */
/* ------------------------------------------------------------------ */

/** The Sound chip that renders the project's mastering as it is (when its settings are no preset's). */
export const AS_IT_IS = 'now';

/**
 * The Sound chip the project sounds like now: its mastering preset while the
 * settings are still that preset's (mastering off sounds like Clean), else
 * AS_IT_IS (settings of its own).
 */
export function currentSound(p: Pick<Project, 'mastering'>): string {
  const m = p.mastering;
  if (!m.enabled) return 'clean';
  return m.presetId !== undefined && !masteringDiverges(m.params, m.presetId) ? m.presetId : AS_IT_IS;
}

/** The copy a music file is rendered from: the chosen Sound, mastering on when it is to be made loud. Never stored. */
export function shareProject(p: Project, sound: string, loud: boolean): Project {
  const base = sound === currentSound(p) || sound === AS_IT_IS ? p : withPreset(p, sound);
  return loud ? withMasteringOn(base) : base;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export type LoudPhase = 'plain' | 'measure' | 'louder' | 'quieter';

/** Render `project` (with its mastering); `passesAfter`: renders likely still to come after this one. */
export type RenderFn = (project: Project, opts: { phase: LoudPhase; passesAfter: number }) => Promise<AudioBuffer>;

export interface LoudFile {
  buffer: AudioBuffer;
  /** Loudness drive of the copy before and after the match (equal when nothing moved). */
  first: number;
  drive: number;
  /** The file's integrated loudness (LUFS) as last measured (NaN when loud was off). */
  reading: number;
  /** Within LOUD_TOLERANCE_DB of the target. */
  reached: boolean;
  /** Why it stopped short: too quiet to measure, or Loudness drive at its highest. */
  stop?: 'quiet' | 'max';
}

export const integratedLufs = (b: AudioBuffer) => measureLoudness(b.getChannelData(0), b.numberOfChannels > 1 ? b.getChannelData(1) : null, b.sampleRate, { truePeak: false }).integrated;

/**
 * Render `base` and, with `loud`, measure and render again with Loudness
 * drive moved toward `targetLufs` (see the header). `base` must have its
 * mastering on for loud to move anything (withMasteringOn).
 */
export async function renderLoud(opts: { base: Project; loud: boolean; targetLufs: number; signal: AbortSignal; render: RenderFn }): Promise<LoudFile> {
  const { base, loud, targetLufs, signal, render } = opts;
  const first = readParam(MASTERING_PARAMS, base.mastering.params, 'loudness');
  // A loud file usually renders twice (measure, then at the new drive): its time left counts both.
  let buffer = await render(base, { phase: loud ? 'measure' : 'plain', passesAfter: loud ? 1 : 0 });
  if (!loud) return { buffer, first, drive: first, reading: NaN, reached: false };
  let reading = integratedLufs(buffer);
  let drive = first;
  let slope = 1;
  let stop: LoudFile['stop'];
  for (let pass = 0; pass < LOUD_PASSES && !(Math.abs(reading - targetLufs) <= LOUD_TOLERANCE_DB); pass++) {
    if (!Number.isFinite(reading) || reading < LOUD_FLOOR_LUFS) {
      stop = 'quiet';
      break;
    }
    abortIfAsked(signal);
    const before = drive;
    const { after, limit } = loudnessDriveAfter(before, (targetLufs - reading) / slope);
    if (Math.abs(after - before) < 0.05) {
      if (limit === 'max') stop = 'max';
      break;
    }
    drive = after;
    buffer = await render(withDrive(base, after), { phase: after > before ? 'louder' : 'quieter', passesAfter: 0 });
    const next = integratedLufs(buffer);
    const moved = after - before;
    if (Math.abs(moved) > 0.05 && Number.isFinite(next)) slope = Math.min(1.2, Math.max(0.25, (next - reading) / moved));
    reading = next;
  }
  return { buffer, first, drive, reading, reached: Math.abs(reading - targetLufs) <= LOUD_TOLERANCE_DB, stop };
}

/**
 * The project with every instrument named as `mode` shows it (Simple: "Melody", not "Lead"), for the
 * names inside files: the per-instrument files ("04 Melody.wav") and the MIDI file's track names. A
 * copy, used only to make the file: the project keeps its names. The same project when nothing differs.
 */
export function withShownNames(project: Project, mode: UiMode): Project {
  if (project.tracks.every((t) => trackNameIn(t, mode) === t.name)) return project;
  return { ...project, tracks: project.tracks.map((t) => ({ ...t, name: trackNameIn(t, mode) })) };
}

/** One WAV per instrument that plays notes in `source`, each alone with its effects, without the mastering, zipped. */
export async function renderStemsZip(opts: {
  project: Project;
  source: NoteSource;
  depth: 16 | 24;
  signal: AbortSignal;
  /** The error's words when no instrument plays there. */
  nothing?: string;
  /** Render one instrument alone (called once per file, in order). */
  render(project: Project, index: number, count: number, name: string): Promise<AudioBuffer>;
}): Promise<{ zip: Uint8Array; names: string[] }> {
  const { project, source, depth, signal, render } = opts;
  const parts = stemParts(project, source);
  if (!parts.length) throw new Error(opts.nothing ?? 'No instrument plays notes here, so there is nothing to save.');
  const names = stemFileNames(
    parts.map((p) => ({ name: p.name, index: project.tracks.findIndex((t) => t.id === p.trackId) })),
    'wav',
  );
  const files: { name: string; data: Uint8Array }[] = [];
  for (let i = 0; i < parts.length; i++) {
    abortIfAsked(signal);
    const b = await render(soloPart(project, parts[i].trackId), i, parts.length, parts[i].name);
    files.push({ name: names[i], data: new Uint8Array(encodeWav(stereo(b), b.sampleRate, depth)) });
  }
  return { zip: zipFiles(files), names: parts.map((p) => p.name) };
}

/** The notes as a MIDI file, and how many instruments it holds. Throws when nothing plays notes there. */
export function makeMidi(project: Project, source: NoteSource, nothing = 'No instrument plays notes here, so there is nothing to write.'): { bytes: Uint8Array; tracks: number } {
  const bytes = songMidi(project, source);
  if (!bytes) throw new Error(nothing);
  // The header's track count, less the tempo track.
  return { bytes, tracks: ((bytes[10] << 8) | bytes[11]) - 1 };
}
