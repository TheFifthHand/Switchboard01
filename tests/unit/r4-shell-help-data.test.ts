/**
 * Help's data (shell-12): one shortcuts table (unique ids, no view-switching
 * key that belongs to the browser, ⌘ on a Mac), the three walkthroughs, and
 * "What's new" shown once after an update only.
 */
import { describe, expect, it } from 'vitest';
import { SHORTCUT_GROUPS, keysFor, shortcut, showKeys } from '../../src/app/views/hints/shortcuts';
import { SEEN_VERSION_KEY, WALKTHROUGHS, WHATS_NEW, notesToShow } from '../../src/app/views/hints/guides';
import pkg from '../../package.json';

describe('the shortcuts table', () => {
  it('has unique ids, words for every key, and none of the browser’s own view keys', () => {
    const ids = SHORTCUT_GROUPS.flatMap((g) => g.items.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of SHORTCUT_GROUPS) {
      expect(g.items.length).toBeGreaterThan(0);
      for (const s of g.items) {
        expect(s.keys.length).toBeGreaterThan(0);
        expect(s.does).toMatch(/\.$/);
      }
    }
    const all = SHORTCUT_GROUPS.flatMap((g) => g.items.flatMap((s) => s.keys)).join(' ');
    expect(all).not.toMatch(/F6|Ctrl\+[0-9]|Alt\+[0-9]/);
    // The keys the shell itself handles are listed.
    for (const id of ['play', 'stop', 'undo', 'redo', 'save', 'mute', 'help']) expect(shortcut(id), id).toBeDefined();
    expect(shortcut('help')!.keys).toEqual(['?']);
  });

  it('writes keys for this computer', () => {
    expect(keysFor('redo')).toBe('Ctrl+Shift+Z or Ctrl+Y');
    expect(keysFor('redo', true)).toBe('⌘Shift+Z or ⌘Y');
    expect(showKeys('Ctrl+S', true)).toBe('⌘S');
    expect(keysFor('no-such-key')).toBe('');
  });
});

describe('walkthroughs and what is new', () => {
  it('three walkthroughs of short steps', () => {
    expect(WALKTHROUGHS.map((w) => w.title)).toEqual(['Make your first loop', 'Build a song', 'Record and export']);
    for (const w of WALKTHROUGHS) {
      expect(w.steps.length).toBeGreaterThanOrEqual(4);
      for (const s of w.steps) expect(s.length).toBeLessThan(200);
    }
  });

  it('notes for this version exist, and show only after an update', () => {
    expect(WHATS_NEW[0].version).toBe(pkg.version);
    expect(SEEN_VERSION_KEY).toBe('switchboard01.seenVersion');
    // First run: nothing (the version is only recorded).
    expect(notesToShow(pkg.version, null)).toBeNull();
    // Same version: nothing.
    expect(notesToShow(pkg.version, pkg.version)).toBeNull();
    // After an update: this version's notes.
    expect(notesToShow(pkg.version, '2.0.0')).toBe(WHATS_NEW[0]);
    // A version with no notes: nothing.
    expect(notesToShow('9.9.9', '2.0.0')).toBeNull();
  });
});
