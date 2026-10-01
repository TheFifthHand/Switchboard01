/**
 * The sound catalogue as the browser uses it: every sound in exactly one
 * category, a broad library (at least 12 kits and 60 synth presets), unique
 * ids and names, one-line descriptions, plain lower-case search tags, a
 * recipe for every kit and a design for every preset; and search that finds
 * sounds by name, tag, category and description words.
 */
import { describe, expect, it } from 'vitest';
import { KIT_RECIPES, getKitVoiceNames } from '../../src/audio/instruments/kits';
import {
  ALL_SOUNDS,
  BUILTIN_SAMPLES,
  KITS,
  SOUND_CATEGORIES,
  SYNTH_PRESETS,
  categoryOfSound,
  soundMatchScore,
  type CatalogSound,
} from '../../src/content/catalog';
import { PRESETS } from '../../src/content/presets';
import { createProject } from '../../src/project/factory';
import { validateProject } from '../../src/project/validate';
import { produce } from 'immer';
import { applyKitToProject } from '../../src/content/presets';

const search = (q: string): CatalogSound[] =>
  ALL_SOUNDS.map((s) => ({ s, score: soundMatchScore(s, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);
const names = (xs: CatalogSound[]) => xs.map((s) => s.name);

describe('sound catalogue', () => {
  it('is broad: at least 12 drum kits and 60 synth presets across every category', () => {
    expect(KITS.length).toBeGreaterThanOrEqual(12);
    expect(SYNTH_PRESETS.length).toBeGreaterThanOrEqual(60);
    expect(SOUND_CATEGORIES.map((c) => c.name)).toEqual(['Drums & Percussion', 'Bass', 'Keys', 'Pads & Strings', 'Leads', 'Plucks & Bells', 'Textures & FX', 'Recordings']);
    for (const c of SOUND_CATEGORIES) {
      const n = ALL_SOUNDS.filter((s) => s.category === c.id).length;
      expect(n, c.name).toBeGreaterThanOrEqual(c.id === 'recordings' ? BUILTIN_SAMPLES.length : 10);
    }
    expect(ALL_SOUNDS).toHaveLength(KITS.length + SYNTH_PRESETS.length + BUILTIN_SAMPLES.length);
  });

  it('has unique ids and names, one-line descriptions and plain tags', () => {
    const ids = ALL_SOUNDS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const nm = ALL_SOUNDS.map((s) => s.name.toLowerCase());
    expect(new Set(nm).size).toBe(nm.length);
    for (const s of ALL_SOUNDS) {
      expect(s.description.length, s.id).toBeGreaterThan(15);
      expect(s.description.length, s.id).toBeLessThanOrEqual(110);
      expect(s.description, s.id).not.toMatch(/\n/);
      expect(s.tags.length, s.id).toBeGreaterThanOrEqual(2);
      for (const t of s.tags) expect(t, `${s.id} tag`).toMatch(/^[a-z0-9][a-z0-9 -]*$/);
    }
  });

  it('every kit has a 16-voice recipe and every preset a design; new kits validate in a project', () => {
    for (const k of KITS) {
      expect(KIT_RECIPES[k.id], k.id).toBeDefined();
      expect(getKitVoiceNames(k.id)).toHaveLength(16);
      const p = produce(createProject({ now: 1 }), (d) => applyKitToProject(d, 't1', k.id));
      const v = validateProject(JSON.parse(JSON.stringify(p)));
      expect(v.ok && v.warnings, k.id).toEqual([]);
    }
    for (const p of SYNTH_PRESETS) expect(PRESETS[p.id], p.id).toBeDefined();
  });

  it('knows the category of a part’s sound', () => {
    expect(categoryOfSound('drums', 'boom-808')).toBe('drums');
    expect(categoryOfSound('sampler', null)).toBe('recordings');
    expect(categoryOfSound('poly', 'poly-tine-piano')).toBe('keys');
    expect(categoryOfSound('bass', 'bass-reese')).toBe('bass');
    expect(categoryOfSound('poly', 'poly-unknown')).toBeUndefined();
  });
});

describe('sound search', () => {
  it('finds by name, word starts, tags, category and description; names rank first', () => {
    expect(names(search('piano')).slice(0, 3)).toEqual(expect.arrayContaining(['Tine Piano']));
    expect(names(search('pian'))).toContain('Felt Piano');
    expect(names(search('808'))).toEqual(expect.arrayContaining(['808 Boom', '808 Machine', 'Trap Night']));
    expect(names(search('808')).slice(0, 2).sort()).toEqual(['808 Boom', '808 Machine']);
    expect(names(search('strings'))).toEqual(expect.arrayContaining(['String Ensemble', 'Cinematic Strings', 'Harp']));
    expect(names(search('riser'))).toEqual(expect.arrayContaining(['Sweep Riser', 'Noise Riser']));
    expect(names(search('electric piano'))).toEqual(expect.arrayContaining(['Tine Piano', 'Crystal EP', 'Reed Piano']));
    expect(names(search('Plucks'))).toEqual(expect.arrayContaining(['Kalimba', 'Harp']));
    // Instrument words in a category name search as instruments: "bell" finds bells, not every pluck.
    expect(names(search('bell'))).toEqual(expect.arrayContaining(['Mallet Bell', 'Tubular Bell', 'Glockenspiel']));
    expect(names(search('bell'))).not.toContain('Koto Pluck');
    expect(names(search('strings'))).not.toContain('Halo Pad');
    expect(names(search('pads'))).toContain('Halo Pad');
    expect(names(search('  KALIMBA  '))).toEqual(['Kalimba']);
    // Every word must match.
    expect(search('piano drums')).toEqual([]);
    expect(search('zzz')).toEqual([]);
    // "bass" finds basses, not the drum & bass kits.
    expect(search('bass').every((s) => s.category === 'bass' || /\bbass/i.test(s.name + s.description))).toBe(true);
  });

  it('an empty query matches everything (the browser then shows categories)', () => {
    for (const s of ALL_SOUNDS) expect(soundMatchScore(s, '   ')).toBeGreaterThan(0);
  });
});
