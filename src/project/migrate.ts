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
import { PROJECT_SCHEMA, PROJECT_VERSION } from './types';

export interface MigrationStep {
  /** Version this step upgrades from; it produces `from + 1`. */
  from: number;
  /** Short description, for diagnostics. */
  description: string;
  migrate(data: any): any;
}

/**
 * Ordered migration steps. Version 1 is the first released schema, so there
 * are no steps yet. When version 2 is introduced, add
 * `{ from: 1, description: '...', migrate: (d) => ... }` here and bump
 * PROJECT_VERSION in types.ts.
 */
export const MIGRATIONS: readonly MigrationStep[] = [];

export type MigrateResult = { ok: true; data: any; migrated: boolean } | { ok: false; error: string };

export const NEWER_VERSION_MESSAGE = 'This project was made with a newer version of SWITCHBOARD.';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Run `steps` from `data.version` up to `target`. Exposed separately so the
 * framework can be tested with synthetic steps.
 */
export function runMigrations(raw: any, steps: readonly MigrationStep[], target: number, schema: string = PROJECT_SCHEMA): MigrateResult {
  try {
    if (!isPlainObject(raw)) return { ok: false, error: 'This file does not contain a SWITCHBOARD project.' };
    if (raw.schema !== schema) return { ok: false, error: 'This file is not a SWITCHBOARD project (unknown format).' };
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
      if (!step) return { ok: false, error: `This project uses an old format (version ${v}) that this version of SWITCHBOARD cannot upgrade.` };
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
