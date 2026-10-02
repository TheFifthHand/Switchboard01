/**
 * The Library's version history in real Chromium with real IndexedDB and
 * real input (trusted clicks and keys): Versions… opens the list (time,
 * name or reason, "blocks · length"), Save version… with a name, Restore
 * as a copy (a new project in My projects, Open it), Delete with a
 * confirmation, Escape closes the panel; the rows' song facts and the
 * storage-use line; no layout overflow at 1366 × 768. Also the Blank
 * project's own first hint (shell-08) and unique starter names.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { Library, type LibraryTab } from '../../src/app/views/Library';
import { getStarter } from '../../src/content/starters';
import { deleteDb, saveProject } from '../../src/persistence/db';
import * as library from '../../src/persistence/library';
import { formatClock, projectShape } from '../../src/persistence/summary';
import { reasonBefore } from '../../src/persistence/versions';
import type { Project } from '../../src/project/types';
import { cleanup, mount, nextFrame, wait } from './ui-harness';

/** Trusted input goes through the browser outside React's act(). */
async function real(fn: () => Promise<unknown>): Promise<void> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await fn();
    await nextFrame();
    await nextFrame();
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
}

async function until<T>(fn: () => T | null | undefined | false, what: string, ms = 5000): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    await act(async () => {
      await wait(15);
    });
    const v = fn();
    if (v) return v;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
}

function dialog(): HTMLElement {
  const d = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
  if (!d) throw new Error('library dialog not open');
  return d;
}

function buttonNamed(name: string | RegExp, root: ParentNode = document): HTMLButtonElement | null {
  for (const b of root.querySelectorAll<HTMLButtonElement>('button')) {
    const n = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    if (typeof name === 'string' ? n === name : name.test(n)) return b;
  }
  return null;
}

const click = (el: Element | null, what: string) => {
  if (!el) throw new Error(`${what} not found`);
  return real(() => userEvent.click(el));
};

let loaded: string[] = [];

function open(tab: LibraryTab) {
  return mount(h(Library, { open: true, initialTab: tab, onClose: () => undefined, onLoaded: (how) => void loaded.push(how), onShowGuide: () => undefined }));
}

const at = (h: number, m: number) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

beforeEach(async () => {
  await page.viewport(1366, 768);
  loaded = [];
  await deleteDb();
});

afterEach(async () => {
  cleanup();
  await deleteDb();
});

describe('Versions in My projects', () => {
  async function songWithVersions(): Promise<Project> {
    const song = getStarter('house')!.build();
    song.name = 'Club Night';
    await saveProject(song);
    await library.setLastProject(song.id);
    session.store.replace(song, { resetHistory: true });
    const other = getStarter('techno')!.build();
    await saveProject(other);
    // Earlier today: an automatic version, a named one, and one kept before a bulk edit.
    await library.saveVersion({ ...song, bpm: 118, updatedAt: song.updatedAt - 3000 }, { reason: 'auto', now: Math.min(Date.now() - 60_000, at(9, 15)) });
    await library.saveVersion({ ...song, bpm: 120, updatedAt: song.updatedAt - 2000 }, { name: 'Before mixing', now: Math.min(Date.now() - 40_000, at(10, 42)) });
    await library.saveVersion({ ...song, bpm: 122, updatedAt: song.updatedAt - 1000 }, { reason: reasonBefore('Variation'), now: Date.now() - 20_000 });
    return song;
  }

  it('lists, saves, restores as a copy and deletes versions with real clicks and keys, without overflow at 1366', async () => {
    const song = await songWithVersions();
    open('projects');
    const versionsButton = await until(() => buttonNamed('Versions of Club Night'), 'Versions… button');
    // The row says how long the song is and how many scenes it has.
    const row = versionsButton.closest('li')!;
    const shape = projectShape(song);
    expect(row.textContent).toContain(`${song.scenes.length} scenes, song ${formatClock(shape.songSeconds)}`);
    expect(versionsButton.getAttribute('aria-expanded')).toBe('false');
    // Storage use is shown.
    expect((await until(() => dialog().querySelector('[data-testid="library-storage-use"]'), 'storage line')).textContent).toMatch(/^Browser storage used: .+ of about .+ available\.$/);

    await click(versionsButton, 'Versions…');
    expect(versionsButton.getAttribute('aria-expanded')).toBe('true');
    const panel = await until(() => document.getElementById(`lib-versions-panel-${song.id}`), 'versions panel');
    const list = await until(() => panel.querySelector<HTMLElement>(`ul[aria-label="Versions of Club Night"]`), 'version list');
    const items = () => [...list.querySelectorAll(':scope > li')].map((li) => li.textContent ?? '');
    expect(items()).toHaveLength(3);
    expect(items()[0]).toContain('Before Variation');
    expect(items()[1]).toContain('Before mixing');
    expect(items()[2]).toContain('Autosaved while editing');
    for (const text of items()) {
      expect(text).toMatch(/Today \d\d:\d\d/);
      expect(text).toMatch(/\d+ blocks · \d+:\d\d/);
    }

    // Nothing spills out sideways at 1366 × 768.
    const tabpanel = dialog().querySelector<HTMLElement>('[role="tabpanel"]')!;
    expect(tabpanel.scrollWidth).toBeLessThanOrEqual(tabpanel.clientWidth + 1);
    const box = panel.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(rowBox.left - 0.5);
    expect(box.right).toBeLessThanOrEqual(rowBox.right + 0.5);
    for (const b of panel.querySelectorAll<HTMLElement>('button')) {
      const r = b.getBoundingClientRect();
      expect(r.right, b.textContent ?? '').toBeLessThanOrEqual(box.right + 0.5);
      expect(r.height).toBeGreaterThanOrEqual(28);
    }
    for (const b of row.querySelectorAll<HTMLElement>(':scope > div button')) expect(b.getBoundingClientRect().right).toBeLessThanOrEqual(rowBox.right + 0.5);

    // Save version… with a name, typed and confirmed with Enter.
    await click(buttonNamed('Save version…', panel), 'Save version…');
    const field = panel.querySelector<HTMLInputElement>('form input')!;
    expect(document.activeElement).toBe(field);
    await real(() => userEvent.keyboard('Chorus idea{Enter}'));
    await until(() => items()[0]?.includes('Chorus idea'), 'new named version');
    expect(items()).toHaveLength(4);
    expect(dialog().textContent).toContain('Saved the version “Chorus idea” of “Club Night”.');
    expect((await library.listVersions(song.id))[0]).toMatchObject({ name: 'Chorus idea', reason: 'manual' });

    // Restore as a copy: a new project, the original untouched.
    const mixing = (await library.listVersions(song.id)).find((v) => v.name === 'Before mixing')!;
    const when = library.versionWhen(mixing.createdAt);
    await click(buttonNamed(`Restore the version from ${when} as a copy`, panel), 'Restore as a copy');
    const copyName = `Club Night (${when.replace('Today ', '')})`;
    await until(() => dialog().textContent?.includes(`Restored as a new project: “${copyName}”.`), 'restored message');
    const projects = await library.listProjects();
    const copy = projects.find((p) => p.name === copyName)!;
    expect(copy).toBeTruthy();
    expect(copy.bpm).toBe(120);
    expect(projects.find((p) => p.id === song.id)!.bpm).toBe(song.bpm);
    await until(() => buttonNamed(`Open ${copyName}`), 'restored row');

    // Delete asks first; Delete removes it.
    await click(buttonNamed(`Delete the version from ${when}`, panel), 'Delete version');
    const confirm = await until(() => panel.querySelector<HTMLElement>(`[role="group"][aria-label="Delete the version from ${when}?"]`), 'confirmation');
    expect(document.activeElement?.textContent).toBe('Keep it');
    await click(buttonNamed('Delete', confirm), 'confirm Delete');
    await until(() => items().length === 3 && !items().some((t) => t.includes('Before mixing')), 'version deleted');
    expect((await library.listVersions(song.id)).map((v) => v.name ?? v.reason)).not.toContain('Before mixing');

    // Open it from the message opens the restored copy.
    await click(buttonNamed(`Restore the version from ${library.versionWhen((await library.listVersions(song.id))[0].createdAt)} as a copy`, panel), 'Restore again');
    await until(() => buttonNamed('Open it'), 'Open it');
    await click(buttonNamed('Open it'), 'Open it');
    await until(() => loaded.length > 0, 'opened');
    expect(session.store.getState().name).toMatch(/^Club Night \(\d\d:\d\d\)/);
  });

  it('Escape closes the panel and gives focus back to Versions…', async () => {
    const song = await songWithVersions();
    open('projects');
    const versionsButton = await until(() => buttonNamed('Versions of Club Night'), 'Versions… button');
    await click(versionsButton, 'Versions…');
    await until(() => document.getElementById(`lib-versions-panel-${song.id}`), 'panel');
    await click(buttonNamed('Save version…'), 'Save version…');
    // Escape in the name field closes only the field.
    await real(() => userEvent.keyboard('{Escape}'));
    expect(document.getElementById(`lib-versions-panel-${song.id}`)).not.toBeNull();
    expect(document.activeElement?.textContent).toContain('Save version…');
    await real(() => userEvent.keyboard('{Escape}'));
    expect(document.getElementById(`lib-versions-panel-${song.id}`)).toBeNull();
    expect(document.activeElement).toBe(versionsButton);
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
  });

  it('a project with no versions says how they are made', async () => {
    const p = getStarter('garage')!.build();
    await saveProject(p);
    session.store.replace(p, { resetHistory: true });
    open('projects');
    await click(await until(() => buttonNamed(`Versions of ${p.name}`), 'Versions…'), 'Versions…');
    await until(() => document.getElementById(`lib-versions-panel-${p.id}`)?.textContent?.includes('No versions yet.'), 'empty text');
  });
});

describe('Starting starters from the Library', () => {
  it('a Blank project says how to begin, and starters get names that can be told apart', async () => {
    const first = getStarter('house')!.build();
    first.name = 'House Starter';
    await saveProject(first);
    session.store.replace(first, { resetHistory: true });
    const m = open('starters');
    await click(await until(() => buttonNamed(/^Start House /), 'House card'), 'House card');
    await until(() => loaded.length === 1, 'House loaded');
    expect(session.store.getState().name).toBe('House Starter 2');
    expect(runtimeStore.getState().notice?.text).toBe('Started “House Starter 2”. “House Starter” is still in My projects. Tap a pad or a scene to hear it.');
    m.unmount();

    open('starters');
    await click(await until(() => buttonNamed(/^Start Blank project/), 'Blank card'), 'Blank card');
    await until(() => loaded.length === 2, 'Blank loaded');
    const name = session.store.getState().name;
    expect(runtimeStore.getState().notice?.text).toBe(`Started “${name}”. “House Starter 2” is still in My projects. Tap a pad to make a clip, then press Edit steps.`);
  });
});
