/**
 * Project schema migration.
 *
 * Saved projects carry `schema` and `version`. Loading runs every migration
 * step from the stored version up to PROJECT_VERSION, in order, on a copy of
 * the data. Each step upgrades exactly one version. Projects from a newer
 * version are rejected (they may contain data this build would silently lose).
 *
 * Migration steps receive loosely-typed JSON and must never throw on
 * unexpected shapes; validation (validate.ts) runs afterwards and does the
 * strict checking.
 */
import { mergeTouching } from './arrangement';
import { neutralMasteringParams } from './params';
import { MAX_SECTION_NAME, PROJECT_SCHEMA, PROJECT_VERSION, type Id, type Project, type SongRegion, type SongSection } from './types';

export interface MigrationStep {
  /** Version this step upgrades from; it produces `from + 1`. */
  from: number;
  /** Short description, for diagnostics. */
  description: string;
  migrate(data: any): any;
}

/**
 * Ordered migration steps, one per version. To add version N+1, append
 * `{ from: N, description: '...', migrate: (d) => ... }` and bump
 * PROJECT_VERSION in types.ts.
 */
export const MIGRATIONS: readonly MigrationStep[] = [
  {
    from: 1,
    description: 'Add the mastering chain (neutral, so the project sounds exactly as before).',
    migrate: (d) => {
      if (!isPlainObject(d)) return d;
      if (!isPlainObject(d.mastering)) d.mastering = { enabled: true, params: neutralMasteringParams(), presetId: 'clean' };
      return d;
    },
  },
  {
    from: 2,
    // Every addition of version 3 is optional or a wider range, so a version-2
    // project is already a valid version-3 project and plays exactly as before.
    // The bump exists so that older builds refuse version-3 projects (which may
    // hold 5 to 8 scenes, clips of 5 to 8 bars, per-clip recordings, song moves
    // and designed macro positions) instead of silently dropping that data.
    description: 'Allow up to 8 scenes, clips of up to 8 bars, per-clip recordings, song moves and designed macro positions (all optional: nothing changes).',
    migrate: (d) => d,
  },
  {
    from: 3,
    // The song of blocks (a scene played N times, with per-part changes) becomes
    // loops on each part's row plus named sections, playing exactly as before:
    // the same clip at the same bar and in the same phase, bar by bar.
    description: 'Turn the song’s blocks into loops on each part’s row and named sections (the song plays exactly as before).',
    migrate: (d) => {
      if (!isPlainObject(d) || !isPlainObject(d.arrangement)) return d;
      const a = d.arrangement;
      const next: Record<string, unknown> = { tailSeconds: a.tailSeconds };
      // A damaged block list leaves the song out, so validation resets it and says so.
      if (Array.isArray(a.blocks)) Object.assign(next, songFromBlocks(d, a.blocks));
      d.arrangement = next;
      return d;
    },
  },
];

/* ------------------------------------------------------------------ */
/* Version 3 → 4: song blocks → regions and sections                   */
/* ------------------------------------------------------------------ */

/** Most times one block of a version-3 song could play (its MAX_BLOCK_REPEATS). */
const OLD_MAX_REPEATS = 16;

/** Ids for what a block becomes (default: the block's own id for its section, `<block id>:<part id>` for its loops). */
export interface BlockSongIds {
  section(blockId: string, index: number): Id;
  region(blockId: string, trackId: Id): Id;
}

const BLOCK_IDS: BlockSongIds = {
  section: (blockId) => blockId,
  region: (blockId, trackId) => `${blockId}:${trackId}`,
};

function wholeNumber(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
}

function plainName(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_SECTION_NAME).trimEnd() : '';
}

/**
 * The song a list of version-3 blocks played, as regions and sections
 * (loosely typed input; never throws). Blocks are laid out in order from bar
 * 0, as version 3 played them; a block whose scene is missing is skipped.
 *
 * - A block's length is the longest clip it actually plays (at least one bar;
 *   per-part changes and layered clips count) times its repeats (1 to 16).
 * - Each block becomes a section over its bars, named by its label or else
 *   its scene, carrying its song moves.
 * - Each part that plays something in the block (the scene row's clip, the
 *   clip of a scene layered in; nothing when switched off or empty) gets a
 *   region of that clip over the whole block, from the clip's start: every
 *   block launched its clips afresh at its first bar.
 * - Touching regions of a part that play on as one (the same clip, still in
 *   phase) are then joined.
 *
 * Positions are not limited here: a song longer than MAX_SONG_BARS is cut
 * by validation, which says so. Same input, same output: ids come from the
 * blocks (see BlockSongIds).
 */
export function songFromBlocks(data: { tracks?: unknown; scenes?: unknown }, blocks: readonly unknown[], ids: BlockSongIds = BLOCK_IDS): { regions: SongRegion[]; sections: SongSection[] } {
  const scenes = Array.isArray(data.scenes) ? (data.scenes as unknown[]) : [];
  const sceneRow = (id: unknown): number => (typeof id === 'string' ? scenes.findIndex((s) => isPlainObject(s) && s.id === id) : -1);
  // Each part and its clips as far as the song needs them (id and length).
  const tracks: { id: Id; clips: ({ id: Id; bars: number } | null)[] }[] = [];
  for (const t of Array.isArray(data.tracks) ? (data.tracks as unknown[]) : []) {
    if (!isPlainObject(t) || typeof t.id !== 'string' || !Array.isArray(t.clips)) continue;
    tracks.push({
      id: t.id,
      clips: (t.clips as unknown[]).map((c) => (isPlainObject(c) && typeof c.id === 'string' ? { id: c.id, bars: wholeNumber(c.bars, 1, 64, 1) } : null)),
    });
  }
  const regions: SongRegion[] = [];
  const sections: SongSection[] = [];
  let at = 0;
  blocks.forEach((b, index) => {
    if (!isPlainObject(b) || typeof b.id !== 'string') return;
    const row = sceneRow(b.sceneId);
    if (row < 0) return;
    const parts = isPlainObject(b.parts) ? b.parts : null;
    // What each part plays in the block (version 3's blockPart rule).
    const plays = tracks.map((t) => {
      const choice = parts && Object.prototype.hasOwnProperty.call(parts, t.id) ? parts[t.id] : undefined;
      if (choice === null) return null;
      if (choice !== undefined && choice !== b.sceneId) {
        const layer = sceneRow(choice);
        // A layer whose scene was deleted falls back to the block's scene.
        if (layer >= 0) return t.clips[layer] ?? null;
      }
      return t.clips[row] ?? null;
    });
    let pass = 1;
    for (const c of plays) if (c && c.bars > pass) pass = c.bars;
    const bars = pass * wholeNumber(b.repeats, 1, OLD_MAX_REPEATS, 1);
    const scene = scenes[row] as Record<string, unknown>;
    const section: SongSection = { id: ids.section(b.id, index), name: plainName(b.label) || plainName(scene.name) || `Scene ${row + 1}`, start: at, bars };
    // Moves are kept as stored (validation cleans them); an empty list is dropped.
    if (b.moves !== undefined && !(Array.isArray(b.moves) && !b.moves.length)) section.moves = b.moves as SongSection['moves'];
    sections.push(section);
    tracks.forEach((t, i) => {
      const c = plays[i];
      if (c) regions.push({ id: ids.region(b.id as string, t.id), trackId: t.id, clipId: c.id, start: at, bars, offset: 0 });
    });
    at += bars;
  });
  return { regions: mergeTouching({ tracks: tracks as unknown as Project['tracks'] }, regions), sections };
}

export type MigrateResult = { ok: true; data: any; migrated: boolean } | { ok: false; error: string };

export const NEWER_VERSION_MESSAGE = 'This project was made with a newer version of Omni Song.';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Run `steps` from `data.version` up to `target`. Exposed separately so the
 * framework can be tested with synthetic steps.
 */
export function runMigrations(raw: any, steps: readonly MigrationStep[], target: number, schema: string = PROJECT_SCHEMA): MigrateResult {
  try {
    if (!isPlainObject(raw)) return { ok: false, error: 'This file does not contain an Omni Song project.' };
    if (raw.schema !== schema) return { ok: false, error: 'This file is not an Omni Song project (unknown format).' };
    const version = raw.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      return { ok: false, error: 'This project has no valid version number, so it cannot be opened safely.' };
    }
    if (version > target) return { ok: false, error: NEWER_VERSION_MESSAGE };
    if (version === target) return { ok: true, data: raw, migrated: false };

    // Work on a copy so a failed migration never damages the caller's data.
    let data: any = structuredClone(raw);
    for (let v = version; v < target; v++) {
      const step = steps.find((s) => s.from === v);
      if (!step) return { ok: false, error: `This project uses an old format (version ${v}) that this version of Omni Song cannot upgrade.` };
      const next = step.migrate(data);
      if (!isPlainObject(next)) return { ok: false, error: `Upgrading this project from version ${v} failed.` };
      data = next;
      data.version = v + 1;
    }
    return { ok: true, data, migrated: true };
  } catch (e) {
    return { ok: false, error: `This project could not be upgraded: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Upgrade raw project JSON to the current schema version. Never throws. */
export function migrateProject(raw: any): MigrateResult {
  return runMigrations(raw, MIGRATIONS, PROJECT_VERSION);
}
