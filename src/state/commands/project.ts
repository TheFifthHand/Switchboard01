/** Project-wide edits: name, tempo, swing, key (and moving the song to a new key), Musical Assist, master volume, settings. */
import { keyLabel, keyRootName, moveToKey, pitchClass, type MusicalKey } from '../../music/scales';
import { BPM_SPEC, MASTER_VOLUME_SPEC, SWING_SPEC } from '../../project/params';
import type { Id, Note, ProjectSettings, ScaleId } from '../../project/types';
import { QUANTIZE_GRIDS, SCALE_IDS } from '../../project/validate';
import type { ProjectStore } from '../projectStore';
import { clamp, cleanName, findTrack, isFiniteNumber, refuse, run, type CommandResult } from './common';
import { pitchRangeFor } from './notes';

export function renameProject(store: ProjectStore, name: string): CommandResult {
  const n = cleanName(name, 80);
  if (!n) return refuse('invalid', 'A project needs a name.');
  return run(store, 'project:Rename project', (d) => {
    d.name = n;
  });
}

/** Tempo in BPM, clamped to 40–220. */
export function setBpm(store: ProjectStore, bpm: number, gesture?: string): CommandResult {
  if (!isFiniteNumber(bpm)) return refuse('invalid', 'Tempo must be a number.');
  const v = Math.round(clamp(bpm, BPM_SPEC.min, BPM_SPEC.max) * 100) / 100;
  return run(store, 'project:Change tempo', (d) => {
    d.bpm = v;
  }, gesture);
}

/** Swing 0 (straight) .. 1 (triplet shuffle). */
export function setSwing(store: ProjectStore, swing: number, gesture?: string): CommandResult {
  if (!isFiniteNumber(swing)) return refuse('invalid', 'Swing must be a number.');
  const v = clamp(swing, SWING_SPEC.min, SWING_SPEC.max);
  return run(store, 'project:Change swing', (d) => {
    d.swing = v;
  }, gesture);
}

/** Key root as a pitch class (any integer, wrapped to 0..11) and scale. */
export function setKey(store: ProjectStore, root: number, scale: ScaleId): CommandResult {
  if (!isFiniteNumber(root) || !SCALE_IDS.includes(scale)) return refuse('invalid', 'Unknown key or scale.');
  const r = ((Math.round(root) % 12) + 12) % 12;
  return run(store, 'project:Change key', (d) => {
    d.root = r;
    d.scale = scale;
  });
}

export interface SongMoveResult extends CommandResult {
  /** Clips whose notes moved. */
  clips: number;
  /** Notes whose pitch changed. */
  notes: number;
  /** Notes that would have left the part's range and were folded back an octave. */
  clamped: number;
  /**
   * Recorded performance takes left in the key they were played in. A take
   * replays from its own snapshot (its clips, key and Musical Assist), so it
   * stays in tune with itself; moving its notes alone would make it clash with
   * that snapshot. The toast can say "Recorded performances keep their key."
   */
  takesKept: number;
}

/** The words for a key in "Move the song to …": 'A Dorian', 'D chromatic'. */
function songKeyWords(root: number, scale: ScaleId): string {
  return scale === 'chromatic' ? `${keyRootName(root, scale)} chromatic` : keyLabel(root, scale);
}

/**
 * Change the key and move the song with it, in one undo step that Undo calls
 * "Move the song to A Dorian". Every clip of a bass or synth part moves by
 * the shortest interval between the roots (-5..+6 semitones); when the scale
 * changes too, each scale degree maps to the new scale's degree (moveToKey in
 * music/scales), and notes outside the old key move by the interval only.
 * Drum parts never move. Sampler parts play recordings, which keep their
 * pitch, so they move only when listed in `samplerParts`. Notes folded back
 * into the part's range are counted in `clamped`. Recorded performance takes
 * keep their own key (`takesKept`). Refused during a performance take like
 * every key change. Undo names it "Move the song to A Dorian" ("… to D
 * chromatic" for the chromatic scale).
 */
export function transposeSong(store: ProjectStore, to: MusicalKey, opts: { samplerParts?: readonly Id[] } = {}): SongMoveResult {
  const none = { clips: 0, notes: 0, clamped: 0, takesKept: 0 };
  if (!to || !isFiniteNumber(to.root) || !SCALE_IDS.includes(to.scale)) return { ...refuse('invalid', 'Unknown key or scale.'), ...none };
  const p = store.getState();
  const listed = opts.samplerParts ?? [];
  if (!Array.isArray(listed)) return { ...refuse('invalid', 'The sampler parts to move could not be read.'), ...none };
  if (listed.some((id) => !findTrack(p, id))) return { ...refuse('not-found', 'One of the chosen parts no longer exists.'), ...none };
  const samplers = new Set(listed);
  const root = pitchClass(to.root);
  const from: MusicalKey = { root: p.root, scale: p.scale };
  const dest: MusicalKey = { root, scale: to.scale };
  if (root === p.root && to.scale === p.scale) return { changed: false, ...none };

  // Work out every moved clip first, so the recipe only writes results.
  const moves = new Map<string, Note[]>();
  let notes = 0;
  let clamped = 0;
  for (const t of p.tracks) {
    const kind = t.instrument.kind;
    if (kind === 'drums' || (kind === 'sampler' && !samplers.has(t.id))) continue;
    const [lo, hi] = pitchRangeFor(kind);
    t.clips.forEach((clip, slot) => {
      if (!clip) return;
      let changed = 0;
      const seen = new Map<string, number>();
      const out: Note[] = [];
      for (const n of clip.notes) {
        let q = moveToKey(n.pitch, from, dest);
        if (q < lo || q > hi) {
          while (q > hi) q -= 12;
          while (q < lo) q += 12;
          clamped++;
        }
        if (q !== n.pitch) changed++;
        // Two notes that land on one tick and pitch (a scale with fewer notes) become one, the louder.
        const k = `${n.tick}|${q}`;
        const at = seen.get(k);
        const moved = q === n.pitch ? n : { ...n, pitch: q };
        if (at === undefined) {
          seen.set(k, out.length);
          out.push(moved);
        } else if (moved.velocity > out[at].velocity) {
          out[at] = moved;
        }
      }
      if (changed === 0 && out.length === clip.notes.length) return;
      notes += changed;
      moves.set(`${t.id}|${slot}`, out);
    });
  }
  const r = run(store, 'project:Move the song', (d) => {
    d.root = root;
    d.scale = to.scale;
    for (const t of d.tracks) {
      t.clips.forEach((c, slot) => {
        const next = c ? moves.get(`${t.id}|${slot}`) : undefined;
        if (c && next) c.notes = next;
      });
    }
  }, undefined, { display: `Move the song to ${songKeyWords(root, to.scale)}` });
  const takesKept = p.performances.filter((perf) => perf.snapshot.root !== root || perf.snapshot.scale !== to.scale).length;
  return r.changed ? { ...r, clips: moves.size, notes, clamped, takesKept } : { ...r, ...none };
}

export function setAssist(store: ProjectStore, on: boolean): CommandResult {
  return run(store, on ? 'project:Turn on Musical Assist' : 'project:Turn off Musical Assist', (d) => {
    d.assist = !!on;
  });
}

export function setMasterVolume(store: ProjectStore, db: number, gesture?: string): CommandResult {
  if (!isFiniteNumber(db)) return refuse('invalid', 'Volume must be a number.');
  const v = clamp(db, MASTER_VOLUME_SPEC.min, MASTER_VOLUME_SPEC.max);
  return run(store, 'project:Change master volume', (d) => {
    d.masterVolumeDb = v;
  }, gesture);
}

export function setSettings(store: ProjectStore, partial: Partial<ProjectSettings>): CommandResult {
  const next: Partial<ProjectSettings> = {};
  if (partial.metronome !== undefined) next.metronome = !!partial.metronome;
  if (partial.countIn !== undefined) next.countIn = !!partial.countIn;
  if (partial.recordQuantize !== undefined) {
    if (!QUANTIZE_GRIDS.includes(partial.recordQuantize)) return refuse('invalid', 'Unknown quantize setting.');
    next.recordQuantize = partial.recordQuantize;
  }
  return run(store, 'project:Change settings', (d) => {
    Object.assign(d.settings, next);
  });
}
