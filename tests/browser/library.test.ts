/**
 * Project library dialog in real Chromium with real IndexedDB: the starter
 * list, starting a starter (the previous project stays in the library),
 * rename / duplicate / delete / restore / delete forever, the open project's
 * delete guard, import errors and export.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { Library, type LibraryProps, type LibraryTab } from '../../src/app/views/Library';
import { BLANK_STARTER, STARTERS } from '../../src/content/starters';
import { deleteDb, saveProject } from '../../src/persistence/db';
import * as library from '../../src/persistence/library';
import { createProject } from '../../src/project/factory';
import type { Project } from '../../src/project/types';
import { cleanup, mount, wait } from './ui-harness';

let loaded: string[] = [];
let closed = 0;
let guides = 0;

function project(name: string, updatedAt: number): Project {
  const p = createProject({ name });
  p.updatedAt = updatedAt;
  return p;
}

beforeEach(async () => {
  loaded = [];
  closed = 0;
  guides = 0;
  await deleteDb();
});

afterEach(async () => {
  cleanup();
  await deleteDb();
});

function open(tab: LibraryTab) {
  const props: LibraryProps = {
    open: true,
    initialTab: tab,
    onClose: () => {
      closed += 1;
    },
    onLoaded: (how) => {
      loaded.push(how);
    },
    onShowGuide: () => {
      guides += 1;
    },
  };
  return mount(h(Library, props));
}

function dialog(): HTMLElement {
  const d = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
  if (!d) throw new Error('library dialog not open');
  return d;
}

/** Wait (flushing React) until `fn` returns something truthy. */
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

function buttonNamed(name: string | RegExp, root: ParentNode = document): HTMLButtonElement | null {
  for (const b of root.querySelectorAll<HTMLButtonElement>('button')) {
    const n = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    if (typeof name === 'string' ? n === name : name.test(n)) return b;
  }
  return null;
}

async function click(el: HTMLElement | null, what = 'element') {
  if (!el) throw new Error(`${what} not found`);
  await act(async () => {
    el.click();
  });
}

function rowNames(listLabel: string): string[] {
  const list = dialog().querySelector(`ul[aria-label="${listLabel}"]`);
  if (!list) return [];
  return [...list.querySelectorAll('li')].map((li) => li.querySelector('[id^="lib-"]')?.textContent?.trim() ?? '');
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Project library', () => {
  it('lists the eight starters and a blank project with tempo and key', async () => {
    open('starters');
    const cards = [...dialog().querySelectorAll<HTMLButtonElement>('ul[aria-label="Starter projects"] button')];
    expect(cards).toHaveLength(9);
    const expected = [...STARTERS, BLANK_STARTER];
    cards.forEach((card, i) => {
      const def = expected[i];
      expect(card.getAttribute('aria-label')).toContain(def === BLANK_STARTER ? 'Blank project' : def.name);
      expect(card.textContent).toContain(`${def.bpm} BPM`);
      expect(card.textContent).toContain(def.key);
      expect(card.textContent).toContain(def.description);
    });
    // Storage is explained in the dialog.
    expect(dialog().textContent).toContain(library.LIBRARY_STORAGE_NOTE);
    // Tabs switch to My projects.
    await click(dialog().querySelector<HTMLButtonElement>('[role="tab"]:not([aria-selected="true"])'), 'My projects tab');
    await until(() => dialog().textContent?.includes('No saved projects yet'), 'empty project list');
  });

  it('starting a starter saves the open project, loads the starter and keeps the old one in My projects', async () => {
    const old = project('Old Song', Date.now() - 60_000);
    await saveProject(old);
    session.store.replace(old, { resetHistory: true });

    const m = open('starters');
    await until(() => dialog().textContent?.includes('Your current project “Old Song” stays in My projects'), 'intro naming the current project');
    await click(buttonNamed(/^Start Techno/), 'Techno card');
    await until(() => loaded.length > 0, 'onLoaded');
    expect(loaded).toEqual(['starter']);

    const now = session.store.getState();
    expect(now.starterId).toBe('techno');
    expect(now.id).not.toBe(old.id);
    const stored = await library.listProjects();
    expect(stored.map((p) => p.id).sort()).toEqual([old.id, now.id].sort());

    m.unmount();
    open('projects');
    await until(() => rowNames('Saved projects').length === 2, 'two saved projects');
    const names = rowNames('Saved projects');
    expect(names[0]).toBe(now.name); // the open project comes first
    expect(names).toContain('Old Song');
    const openRow = dialog().querySelector('li[aria-current="true"]')!;
    expect(openRow.textContent).toContain('Open now');
    expect(openRow.textContent).toContain(now.name);
    // Only projects that are not open offer Open.
    expect(buttonNamed(`Open ${now.name}`)).toBeNull();
    expect(buttonNamed('Open Old Song')).not.toBeNull();
  });

  it('opens a stored project from the list', async () => {
    const a = project('Alpha', Date.now() - 1000);
    const b = project('Beta', Date.now() - 5000);
    await saveProject(a);
    await saveProject(b);
    session.store.replace(a, { resetHistory: true });
    open('projects');
    await until(() => buttonNamed('Open Beta'), 'Open Beta');
    await click(buttonNamed('Open Beta'));
    await until(() => loaded.length > 0, 'onLoaded');
    expect(loaded).toEqual(['open']);
    expect(session.store.getState().id).toBe(b.id);
  });

  it('rename, duplicate, delete, restore and delete forever update the lists', async () => {
    const a = project('Alpha', Date.now() - 1000);
    const b = project('Beta', Date.now() - 5000);
    await saveProject(a);
    await saveProject(b);
    session.store.replace(a, { resetHistory: true });
    open('projects');
    await until(() => rowNames('Saved projects').length === 2, 'list');

    // Rename a stored project.
    await click(buttonNamed('Rename Beta'));
    const input = dialog().querySelector<HTMLInputElement>('form input')!;
    expect(document.activeElement).toBe(input);
    typeInto(input, '  Beta   Two ');
    await click(buttonNamed('Save name'));
    await until(() => rowNames('Saved projects').includes('Beta Two'), 'renamed row');
    expect((await library.listProjects()).find((p) => p.id === b.id)?.name).toBe('Beta Two');

    // Rename the open project: the editor's project changes too.
    await click(buttonNamed('Rename Alpha'));
    typeInto(dialog().querySelector<HTMLInputElement>('form input')!, 'Alpha Prime');
    await click(buttonNamed('Save name'));
    await until(() => rowNames('Saved projects').includes('Alpha Prime'), 'renamed open row');
    expect(session.store.getState().name).toBe('Alpha Prime');
    expect((await library.listProjects()).find((p) => p.id === a.id)?.name).toBe('Alpha Prime');

    // Escape cancels a rename without closing the dialog.
    await click(buttonNamed('Rename Beta Two'));
    const field = dialog().querySelector<HTMLInputElement>('form input')!;
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(dialog().querySelector('form input')).toBeNull();
    expect(closed).toBe(0);

    // Duplicate.
    await click(buttonNamed('Duplicate Beta Two'));
    await until(() => rowNames('Saved projects').includes('Beta Two copy'), 'copy row');
    expect(await library.listProjects()).toHaveLength(3);
    expect(dialog().textContent).toContain('Made a copy: “Beta Two copy”');

    // Delete asks first, then moves the project to Recently deleted.
    await click(buttonNamed('Delete Beta Two copy'));
    const confirm = dialog().querySelector<HTMLElement>('[role="group"][aria-label="Delete Beta Two copy?"]')!;
    expect(confirm.textContent).toContain('moves to Recently deleted');
    expect(await library.listProjects()).toHaveLength(3);
    await click(buttonNamed('Delete', confirm));
    await until(() => rowNames('Recently deleted projects').includes('Beta Two copy'), 'trashed row');
    expect(rowNames('Saved projects')).not.toContain('Beta Two copy');
    expect((await library.listTrash()).map((t) => t.name)).toEqual(['Beta Two copy']);

    // Restore brings it back.
    await click(buttonNamed('Restore Beta Two copy'));
    await until(() => rowNames('Saved projects').includes('Beta Two copy'), 'restored row');
    expect(await library.listTrash()).toHaveLength(0);

    // Delete forever also asks first.
    await click(buttonNamed('Delete Beta Two copy'));
    await click(buttonNamed('Delete', dialog().querySelector<HTMLElement>('[role="group"][aria-label="Delete Beta Two copy?"]')!));
    await until(() => buttonNamed('Delete Beta Two copy forever'), 'trash row');
    await click(buttonNamed('Delete Beta Two copy forever'));
    const purge = dialog().querySelector<HTMLElement>('[role="group"][aria-label="Delete Beta Two copy forever?"]')!;
    expect(purge.textContent).toContain('cannot be undone');
    await click(buttonNamed('Delete forever', purge));
    await until(() => rowNames('Recently deleted projects').length === 0 && dialog().textContent?.includes('deleted forever'), 'purged');
    expect(await library.listTrash()).toHaveLength(0);
    expect((await library.listProjects()).map((p) => p.name).sort()).toEqual(['Alpha Prime', 'Beta Two']);
  });

  it('does not delete the open project: it offers to open another one first', async () => {
    const a = project('Alpha', Date.now() - 1000);
    const b = project('Beta', Date.now() - 5000);
    await saveProject(a);
    await saveProject(b);
    session.store.replace(a, { resetHistory: true });
    open('projects');
    await until(() => rowNames('Saved projects').length === 2, 'list');

    await click(buttonNamed('Delete Alpha'));
    const guard = dialog().querySelector<HTMLElement>('[role="group"][aria-label="Alpha is open"]')!;
    expect(guard.textContent).toContain('cannot be deleted right now');
    expect(buttonNamed('Delete', guard)).toBeNull();

    await click(buttonNamed('Open “Beta”', guard));
    // Beta is open now and the dialog asks to delete Alpha.
    const confirm = await until(() => dialog().querySelector<HTMLElement>('[role="group"][aria-label="Delete Alpha?"]'), 'delete confirmation');
    expect(session.store.getState().id).toBe(b.id);
    expect(loaded).toEqual([]);
    await click(buttonNamed('Delete', confirm));
    await until(() => rowNames('Recently deleted projects').includes('Alpha'), 'Alpha in trash');
    expect((await library.listProjects()).map((p) => p.id)).toEqual([b.id]);
  });

  it('shows an actionable message when the imported file is not a project file, and keeps the project', async () => {
    const a = project('Keep Me', Date.now());
    await saveProject(a);
    session.store.replace(a, { resetHistory: true });
    open('projects');
    const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
    const dt = new DataTransfer();
    dt.items.add(new File(['just some notes'], 'notes.txt', { type: 'text/plain' }));
    await act(async () => {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const alert = await until(() => dialog().querySelector<HTMLElement>('[role="alert"]'), 'import error');
    expect(alert.textContent).toMatch(/not a SWITCHBOARD project file/);
    expect(alert.textContent).toContain('.sb01.zip');
    expect(loaded).toEqual([]);
    expect(session.store.getState().id).toBe(a.id);
    expect(await library.listProjects()).toHaveLength(1);
  });

  it('exports the open project as a project file and imports it back as a new project', async () => {
    const a = project('Round Trip', Date.now());
    await saveProject(a);
    session.store.replace(a, { resetHistory: true });
    open('projects');
    await until(() => rowNames('Saved projects').length === 1, 'list');

    // Capture the download instead of letting the browser save it.
    let saved: { name: string; href: string } | null = null;
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      saved = { name: this.download, href: this.href };
    };
    try {
      await click(buttonNamed('Export this project'));
      await until(() => saved, 'download');
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }
    const file = saved as unknown as { name: string; href: string };
    expect(file.name).toMatch(/\.sb01\.zip$/);
    await until(() => dialog().textContent?.includes('to your downloads'), 'export message');

    const blob = await (await fetch(file.href)).blob();
    const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
    const dt = new DataTransfer();
    dt.items.add(new File([blob], file.name, { type: 'application/zip' }));
    await act(async () => {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => loaded.length > 0, 'import loaded');
    expect(loaded).toEqual(['import']);
    const imported = session.store.getState();
    expect(imported.name).toBe('Round Trip');
    expect(imported.id).not.toBe(a.id);
    expect(await library.listProjects()).toHaveLength(2);
  });

  it('replays the quick guide from the dialog', async () => {
    open('starters');
    await click(buttonNamed('Show the quick guide again'));
    expect(guides).toBe(1);
  });
});
