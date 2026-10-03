/**
 * Project library dialog in real Chromium with real IndexedDB: the starter
 * list, starting a starter (the previous project stays in the library),
 * rename / duplicate / delete / restore / delete forever, the open project's
 * delete guard, import errors and export; a project whose edits could not be
 * saved is never replaced without asking; the first-launch preview becomes a
 * stored project on its first change; reopen warnings reach the Welcome card;
 * the recovery export reports its outcome.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { Library, type LibraryProps, type LibraryTab } from '../../src/app/views/Library';
import { RENAME_NOTE_KEY } from '../../src/app/views/Welcome';
import { BLANK_STARTER, STARTERS } from '../../src/content/starters';
import { strToU8, zipSync } from 'fflate';
import { exportBundle } from '../../src/persistence/bundle';
import { closeDb, deleteDb, putSample, saveProject } from '../../src/persistence/db';
import * as library from '../../src/persistence/library';
import { createProject } from '../../src/project/factory';
import { PROJECT_VERSION, type Project } from '../../src/project/types';
import { setGuideDone, setView, uiStore } from '../../src/state/uiStore';
import { cleanup, key, mount, wait } from './ui-harness';

/** Make every IndexedDB write fail as if browser storage were full; returns the undo. */
function failWrites(): () => void {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  };
  return () => {
    IDBObjectStore.prototype.put = put;
  };
}

let loaded: string[] = [];
let closed = 0;
let guides = 0;

function project(name: string, updatedAt: number): Project {
  const p = createProject({ name });
  p.updatedAt = updatedAt;
  return p;
}

beforeEach(async () => {
  await page.viewport(1366, 768);
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
    // Focus starts on the selected tab.
    expect(document.activeElement?.getAttribute('role')).toBe('tab');
    expect(document.activeElement?.textContent).toContain('Starters');
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
    expect(runtimeStore.getState().notice?.text).toBe(`Started “${now.name}”. “Old Song” is still in My projects. Tap a pad or a scene to hear it.`);
    expect(now.id).not.toBe(old.id);
    const stored = await library.listProjects();
    expect(stored.map((p) => p.id).sort()).toEqual([old.id, now.id].sort());

    m.unmount();
    open('projects');
    expect(document.activeElement?.textContent).toContain('My projects');
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
    expect(alert.textContent).toMatch(/not an Omni Song project file/);
    // It names the file type to choose, and the one earlier versions saved.
    expect(alert.textContent).toContain('.omnisong.zip');
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
    expect(file.name).toBe('Round-Trip.omnisong.zip');
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
    // The original is still in the library, so the imported copy is named apart.
    expect(imported.name).toBe('Round Trip (imported)');
    expect(imported.id).not.toBe(a.id);
    expect(await library.listProjects()).toHaveLength(2);
  });

  it('keeps Escape working after the focused control goes away (message dismissed, row restored)', async () => {
    const a = project('Alpha', Date.now() - 1000);
    const b = project('Beta', Date.now() - 5000);
    await saveProject(a);
    await saveProject(b);
    await library.deleteProject(b.id);
    session.store.replace(a, { resetHistory: true });
    open('projects');
    await until(() => buttonNamed('Restore Beta'), 'trash row');
    await click(buttonNamed('Restore Beta'));
    await until(() => rowNames('Saved projects').includes('Beta'), 'restored');
    expect(dialog().contains(document.activeElement)).toBe(true);
    await click(buttonNamed('Dismiss message'));
    expect(dialog().contains(document.activeElement)).toBe(true);
    // Even with focus lost to the page, Escape closes the library.
    (document.activeElement as HTMLElement).blur();
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(closed).toBe(1);
  });

  it('explains a storage failure and asks before replacing a project it cannot keep', async () => {
    session.store.replace(project('Unsaved Jam', Date.now()), { resetHistory: true });
    // Make IndexedDB unavailable (as in some private windows).
    await closeDb();
    const own = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined });
    try {
      open('starters');
      const notice = await until(() => dialog().querySelector<HTMLElement>('[role="alert"]'), 'storage notice');
      expect(notice.textContent).toContain('Browser storage is not working right now');
      expect(notice.textContent).toContain('not available');
      expect(dialog().textContent).toContain('cannot be kept in this browser right now');

      await click(buttonNamed(/^Start Garage/));
      const confirm = dialog().querySelector<HTMLElement>('[role="group"][aria-label="Start Garage?"]')!;
      expect(confirm.textContent).toContain('will be lost unless you export it first');
      expect(buttonNamed('Export it first', confirm)).not.toBeNull();
      expect(loaded).toEqual([]);
      expect(session.store.getState().name).toBe('Unsaved Jam');

      await click(buttonNamed('Replace it', confirm));
      await until(() => loaded.length > 0, 'starter loaded');
      expect(session.store.getState().starterId).toBe('garage');
      // The message keeps the storage warning and does not claim the old project was kept.
      const toast = runtimeStore.getState().notice!;
      expect(toast.tone).toBe('warn');
      expect(toast.text).toContain('Started “Garage Starter”.');
      expect(toast.text).toContain('Could not save to browser storage');
      expect(toast.text).not.toContain('still in My projects');
    } finally {
      if (own) Object.defineProperty(window, 'indexedDB', own);
      else delete (window as { indexedDB?: unknown }).indexedDB;
    }
    expect(typeof indexedDB).toBe('object');
  });

  it('never replaces a project whose latest edits could not be saved without asking; Cancel keeps it', async () => {
    const jam = project('Jam', Date.now() - 1000);
    await saveProject(jam);
    await library.setLastProject(jam.id);
    await session.boot();
    expect(session.store.getState().id).toBe(jam.id);
    const restore = failWrites();
    try {
      act(() => session.setBpm(101));
      await session.autosaver!.flush();
      expect(session.autosaver!.status.getState().status).toBe('error');
      // The session itself refuses to take such a project off the screen.
      await expect(session.newFromStarter('techno')).rejects.toMatchObject({ name: 'StorageError', kind: 'quota' });
      expect(session.store.getState()).toMatchObject({ id: jam.id, bpm: 101 });

      open('starters');
      await until(() => dialog().textContent?.includes('Starting a project replaces “Jam” on screen, and its latest changes could not be saved in this browser.'), 'intro');
      await click(buttonNamed(/^Start Garage/));
      let confirm = dialog().querySelector<HTMLElement>('[role="group"][aria-label="Start Garage?"]')!;
      expect(confirm.textContent).toContain('Its latest changes could not be saved in this browser. Export it first if you want to keep them.');
      expect(buttonNamed('Export it first', confirm)).not.toBeNull();
      await click(buttonNamed('Cancel', confirm));
      expect(loaded).toEqual([]);
      expect(session.store.getState()).toMatchObject({ id: jam.id, bpm: 101 });

      // Replace it: the user chose to let the unsaved edits go.
      await click(buttonNamed(/^Start Garage/));
      confirm = dialog().querySelector<HTMLElement>('[role="group"][aria-label="Start Garage?"]')!;
      await click(buttonNamed('Replace it', confirm));
      await until(() => loaded.length > 0, 'starter loaded');
      expect(session.store.getState().starterId).toBe('garage');
      const toast = runtimeStore.getState().notice!;
      expect(toast.tone).toBe('warn');
      expect(toast.text).toContain('Could not save to browser storage');
      expect(toast.text).not.toContain('still in My projects');
      // The new project is not stored either, and the save state says so instead of "Saved".
      await until(() => session.autosaver!.status.getState().status === 'error', 'save failure of the new project', 3000);
    } finally {
      restore();
    }
    // Storage works again (Try again): both are stored, and the new project is the one reopened next time.
    await session.autosaver!.retry();
    expect(session.autosaver!.status.getState()).toMatchObject({ status: 'saved', dirty: false });
    const garage = session.store.getState();
    expect((await library.listProjects()).map((p) => p.id).sort()).toEqual([jam.id, garage.id].sort());
    expect((await library.openLast())?.project.id).toBe(garage.id);
  });

  it('replays the quick guide from the dialog', async () => {
    open('starters');
    await click(buttonNamed('Show the quick guide again'));
    expect(guides).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Wiring in the app: Welcome card, transport project button, guide    */
/* ------------------------------------------------------------------ */

function libraryDialog(): HTMLElement | null {
  for (const d of document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')) {
    const title = document.getElementById(d.getAttribute('aria-labelledby') ?? '');
    if (title?.textContent === 'Project library') return d;
  }
  return null;
}

function selectedTab(): string {
  return libraryDialog()?.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? '';
}

function welcomeOpen(): boolean {
  return document.getElementById('welcome-title') !== null;
}

describe('Project library in the app', () => {
  beforeEach(() => {
    act(() => {
      setGuideDone(false);
      setView('play');
    });
  });

  it('opens on Starters from the Welcome card and on My projects from the transport; starting offers the guide once', async () => {
    const boot = await session.boot();
    mount(h(App, { boot }));
    expect(welcomeOpen()).toBe(true);

    // Welcome → "Other starters & projects": the library opens over the Welcome card, on Starters.
    await click(buttonNamed('Other starters & projects'), 'Other starters link');
    expect(libraryDialog()).not.toBeNull();
    expect(selectedTab()).toContain('Starters');
    // Closing it goes back to the Welcome card.
    await click(buttonNamed('Close the project library'));
    expect(libraryDialog()).toBeNull();
    expect(welcomeOpen()).toBe(true);

    // Picking a starter loads it, closes both and offers the quick guide (never finished yet).
    await click(buttonNamed('Other starters & projects'), 'Other starters link');
    await click(buttonNamed(/^Start Techno/), 'Techno card');
    await until(() => !libraryDialog() && !welcomeOpen(), 'library and welcome closed');
    expect(session.store.getState().starterId).toBe('techno');
    const guide = await until(() => document.querySelector<HTMLElement>('[data-guide-step]'), 'quick guide');
    expect(guide.dataset.guideStep).toBe('play');
    await click(buttonNamed('Next', guide));
    expect(document.querySelector<HTMLElement>('[data-guide-step]')?.dataset.guideStep).toBe('pads');

    // The transport's project button opens the library on My projects, with the open project marked.
    await click(buttonNamed(/^Projects \(open: Techno Starter\)$/), 'transport project button');
    expect(selectedTab()).toContain('My projects');
    const openRow = await until(() => libraryDialog()?.querySelector<HTMLElement>('li[aria-current="true"]'), 'open project row');
    expect(openRow.textContent).toContain('Techno Starter');
    expect(openRow.textContent).toContain('Open now');

    // "Show the quick guide again" closes the library and restarts the guide from step 1.
    await click(buttonNamed('Show the quick guide again'));
    expect(libraryDialog()).toBeNull();
    expect(document.querySelector<HTMLElement>('[data-guide-step]')?.dataset.guideStep).toBe('play');
    await click(buttonNamed('Skip guide'));
    expect(uiStore.getState().guideDone).toBe(true);

    // Once done, a starter picked from the Welcome card's library does not bring the guide back.
    cleanup();
    mount(h(App, { boot }));
    await click(buttonNamed('Other starters & projects'), 'Other starters link');
    await click(buttonNamed(/^Start House/), 'House card');
    await until(() => !libraryDialog() && !welcomeOpen(), 'library and welcome closed');
    expect(session.store.getState().starterId).toBe('house');
    await act(async () => {
      await wait(50);
    });
    expect(document.querySelector('[data-guide-step]')).toBeNull();
  });

  it('keeps Space from starting playback behind the open library', async () => {
    const boot = await session.boot();
    mount(h(App, { boot }));
    await click(buttonNamed('Just look around'));
    const realToggle = session.togglePlay;
    let toggles = 0;
    session.togglePlay = async () => {
      toggles += 1;
    };
    try {
      const space = (target: EventTarget) => key(target, 'keydown', { key: ' ', code: 'Space' });
      // Without the library, Space on the page is Play/Stop.
      space(document.body);
      expect(toggles).toBe(1);

      await click(buttonNamed(/^Projects \(open:/), 'transport project button');
      const panel = libraryDialog()!.querySelector<HTMLElement>('[role="tabpanel"]')!;
      panel.focus();
      space(panel);
      (document.activeElement as HTMLElement | null)?.blur();
      space(document.body);
      expect(toggles).toBe(1);
      // A focused control still gets Space (it presses the control, not Play).
      const tab = dialogTab('Starters');
      let reached = 0;
      tab.addEventListener('keydown', () => void (reached += 1));
      tab.focus();
      expect(space(tab).defaultPrevented).toBe(false);
      expect(reached).toBe(1);
      expect(toggles).toBe(1);

      await click(buttonNamed('Close the project library'));
      space(document.body);
      expect(toggles).toBe(2);
    } finally {
      session.togglePlay = realToggle;
    }
  });
});

describe('The first-launch preview and reopening', () => {
  beforeEach(() => {
    act(() => {
      setGuideDone(true);
      setView('play');
    });
  });

  const saveStatus = () => document.querySelector<HTMLButtonElement>('button[aria-label^="Autosave: "]')?.getAttribute('aria-label') ?? '';

  it('an untouched preview is not stored; its first change stores it, and reopening offers it', async () => {
    const boot = await session.boot();
    expect(boot.lastProject).toBeNull();
    mount(h(App, { boot }));
    await click(buttonNamed('Just look around'));
    const preview = session.store.getState();
    expect(saveStatus()).toBe('Autosave: Preview, not stored until you change it');

    // Looking around stores nothing, and My projects says what the preview is.
    await click(buttonNamed(/^Projects \(open:/), 'transport project button');
    await until(() => libraryDialog()?.textContent?.includes('No saved projects yet'), 'empty project list');
    expect(libraryDialog()!.textContent).toContain(`“${preview.name}” on screen is a preview. As soon as you change it, it is added to My projects and saved automatically.`);
    await click(buttonNamed('Close the project library'));
    expect(await library.listProjects()).toEqual([]);

    // The first change makes it a normal project: stored and saved from then on.
    act(() => session.setBpm(97));
    await until(() => saveStatus() === 'Autosave: Saved', 'Saved', 5000);
    expect((await library.listProjects()).map((p) => [p.id, p.bpm])).toEqual([[preview.id, 97]]);
    await click(buttonNamed(/^Projects \(open:/), 'transport project button');
    const openRow = await until(() => libraryDialog()?.querySelector<HTMLElement>('li[aria-current="true"]'), 'open project row');
    expect(openRow.textContent).toContain(preview.name);
    expect(libraryDialog()!.textContent).not.toContain('is a preview');

    // Reopening offers it.
    cleanup();
    const again = await session.boot();
    expect(again.lastProject?.id).toBe(preview.id);
    mount(h(App, { boot: again }));
    expect(buttonNamed(`Continue “${preview.name}”`)).not.toBeNull();
    expect(session.store.getState().bpm).toBe(97);
  });

  it('starting a starter right after editing the preview keeps the edited preview', async () => {
    await session.boot();
    const preview = session.store.getState();
    act(() => session.setBpm(97));
    await session.newFromStarter('techno');
    expect(session.store.getState().starterId).toBe('techno');
    const stored = await library.listProjects();
    expect(stored.find((p) => p.id === preview.id)?.bpm).toBe(97);
    expect(stored.some((p) => p.id === session.store.getState().id)).toBe(true);
  });

  it('opens a project file saved by SWITCHBOARD / 01 (.sb01.zip, older format) from the file picker', async () => {
    const a = project('Keep Me', Date.now());
    await saveProject(a);
    session.store.replace(a, { resetHistory: true });
    open('projects');
    const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
    // The picker offers new and older project files.
    const accept = input.accept.split(',');
    expect(accept).toContain('.omnisong.zip');
    expect(accept).toContain('.sb01.zip');
    const importButton = buttonNamed('Import project file…')!;
    expect(importButton).not.toBeNull();

    // A version-1 project as SWITCHBOARD / 01 saved it: no mastering yet, the old README.
    const old = JSON.parse(JSON.stringify(createProject({ name: 'Old Song' })));
    delete old.mastering;
    old.version = 1;
    const zip = zipSync({ 'project.json': strToU8(JSON.stringify(old)), 'README.txt': strToU8('SWITCHBOARD / 01 project file\n') });
    const dt = new DataTransfer();
    dt.items.add(new File([zip], 'Old-Song.sb01.zip', { type: 'application/zip' }));
    await act(async () => {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => loaded.length > 0, 'import loaded');
    expect(loaded).toEqual(['import']);
    const opened = session.store.getState();
    expect(opened.name).toBe('Old Song');
    expect(opened.schema).toBe('switchboard01.project');
    expect(opened.version).toBe(PROJECT_VERSION);
    expect(opened.mastering).toBeTruthy();
    expect((await library.listProjects()).map((p) => p.name).sort()).toEqual(['Keep Me', 'Old Song']);
  });

  it('"Show hints again" is offered next to the quick guide when the app supports it', async () => {
    open('starters');
    // Without a handler (an embedding that has no hints) there is no button.
    expect(buttonNamed('Show hints again')).toBeNull();
    cleanup();
    let hints = 0;
    mount(h(Library, { open: true, initialTab: 'starters', onClose: () => {}, onLoaded: () => {}, onShowGuide: () => {}, onShowHints: () => void (hints += 1) }));
    const b = buttonNamed('Show hints again');
    expect(b).not.toBeNull();
    expect(buttonNamed('Show the quick guide again')).not.toBeNull();
    await click(b);
    expect(hints).toBe(1);
  });

  it('importing a project file right after editing the preview keeps both, and reopens the import', async () => {
    await session.boot();
    const preview = session.store.getState();
    const song = createProject({ name: 'Imported Song' });
    const file = new File([await exportBundle(song, async () => null)], 'Imported-Song.sb01.zip', { type: 'application/zip' });
    // The edit is still waiting to be saved when the file is imported.
    act(() => session.setBpm(97));
    const res = await session.importProjectFile(file);
    expect(res.ok, res.message).toBe(true);
    const open = session.store.getState();
    expect(open.name).toBe('Imported Song');
    const stored = await library.listProjects();
    expect(stored.find((p) => p.id === preview.id)?.bpm).toBe(97);
    expect(stored.some((p) => p.id === open.id)).toBe(true);
    expect((await library.openLast())?.project.id).toBe(open.id);
  });

  it('the Welcome card says Omni Song; someone coming back from SWITCHBOARD / 01 is told once that it was renamed', async () => {
    localStorage.removeItem(RENAME_NOTE_KEY);
    const before = createProject({ name: 'From Before' });
    await saveProject(before);
    await library.setLastProject(before.id);
    const boot = await session.boot();
    expect(boot.lastProject?.id).toBe(before.id);
    const first = mount(h(App, { boot }));
    const title = document.getElementById('welcome-title')!;
    const card = title.closest('[role="dialog"]')!;
    expect(title.textContent).toBe('Omni Song');
    expect(card.getAttribute('aria-labelledby')).toBe('welcome-title');
    expect(card.textContent).toContain('Start with a beat. Make it yours.');
    // A returning visit offers Continue first and a new groove second (shell-02).
    expect(buttonNamed('Start a new groove')).not.toBeNull();
    expect(buttonNamed('Continue “From Before”')).not.toBeNull();
    expect(card.querySelector('[data-testid="welcome-renamed"]')?.textContent).toBe('SWITCHBOARD / 01 is now called Omni Song. Your projects and settings are all still here.');
    first.unmount();
    // Once is enough.
    mount(h(App, { boot }));
    expect(document.getElementById('welcome-title')!.textContent).toBe('Omni Song');
    expect(document.querySelector('[data-testid="welcome-renamed"]')).toBeNull();
  });

  it('a first visit never mentions the old name, not even when coming back later', async () => {
    localStorage.removeItem(RENAME_NOTE_KEY);
    const boot = await session.boot();
    expect(boot.lastProject).toBeNull();
    const first = mount(h(App, { boot }));
    expect(document.querySelector('[data-testid="welcome-renamed"]')).toBeNull();
    first.unmount();
    const later = createProject({ name: 'Made in 2.0' });
    await saveProject(later);
    await library.setLastProject(later.id);
    mount(h(App, { boot: await session.boot() }));
    expect(buttonNamed('Continue “Made in 2.0”')).not.toBeNull();
    expect(document.querySelector('[data-testid="welcome-renamed"]')).toBeNull();
  });

  it('reopening skips a damaged project and says why on the Welcome card', async () => {
    const good = createProject({ name: 'Good' });
    const broken = createProject({ name: 'Broken' });
    await saveProject(good);
    await saveProject({ ...broken, tracks: broken.tracks.slice(0, 5) });
    await library.setLastProject(broken.id);
    const boot = await session.boot();
    expect(boot.storageError).toBeNull();
    mount(h(App, { boot }));
    expect(buttonNamed('Continue “Good”')).not.toBeNull();
    const card = document.getElementById('welcome-title')!.closest('[role="dialog"]')!;
    const note = [...card.querySelectorAll('[role="status"]')].find((el) => el.textContent?.includes('"Broken" could not be opened'));
    expect(note?.textContent).toContain('so the most recent readable project was opened instead');
  });

  it('when no saved project can be read, the Welcome card says so, and saving still works', async () => {
    const broken = createProject({ name: 'Broken' });
    await saveProject({ ...broken, tracks: broken.tracks.slice(0, 5) });
    const boot = await session.boot();
    expect(boot.storageError).toBeNull();
    mount(h(App, { boot }));
    const card = document.getElementById('welcome-title')!.closest('[role="dialog"]')!;
    expect(card.textContent).toContain('None of the saved projects in this browser could be opened. They are still in the library.');
    expect(card.textContent).not.toContain('Saving is unavailable');
    // Storage works: the preview is stored as soon as it changes.
    await click(buttonNamed('Just look around'));
    act(() => session.setBpm(98));
    await session.autosaver!.flush();
    expect((await library.listProjects()).some((p) => p.id === session.store.getState().id)).toBe(true);
  });

  it('the recovery export offered when saving fails says whether it worked', async () => {
    const boot = await session.boot();
    mount(h(App, { boot }));
    await click(buttonNamed('Just look around'));
    let saved: string | null = null;
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      saved = this.download;
    };
    const restore = failWrites();
    try {
      act(() => session.setBpm(103));
      const status = await until(() => document.querySelector<HTMLButtonElement>('button[aria-label="Autosave: Not saved"]'), 'Not saved', 5000);
      await click(status);
      const pop = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Saving failed"]')!;
      // Pressed from the keyboard: the export tries to save first, and focus stays on the button meanwhile.
      const exportButton = buttonNamed('Export project file', pop)!;
      exportButton.focus();
      await click(exportButton);
      await until(() => saved, 'download');
      expect(saved).toMatch(/\.omnisong\.zip$/);
      await until(() => runtimeStore.getState().notice?.text === `Saved “${saved}” to your downloads. Keep it as your backup.`, 'success message');
      expect(document.activeElement).toBe(exportButton);

      // A recording missing from storage would make the backup incomplete: the user is told instead.
      const meta = { id: 'smp_missing', name: 'Lost take', mime: 'audio/wav', byteLength: 3, duration: 0.1, sampleRate: 44100, channels: 1 };
      act(() => session.store.replace({ ...session.store.getState(), samples: [meta] }));
      await session.autosaver!.flush();
      saved = null;
      const again = await until(() => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Saving failed"]'), 'popover');
      await click(buttonNamed('Export project file', again));
      const notice = await until(() => (runtimeStore.getState().notice?.tone === 'error' ? runtimeStore.getState().notice : null), 'error message');
      expect(notice.text).toBe('Exporting the project file failed: The recording "Lost take" is missing from this browser\'s storage, so the project file would be incomplete.');
      expect(saved).toBeNull();
    } finally {
      restore();
      HTMLAnchorElement.prototype.click = realClick;
    }
    // Storage is back: Try again writes the pending edits, the popover goes and focus returns to the save status.
    await putSample({ id: 'smp_missing', name: 'Lost take', mime: 'audio/wav', byteLength: 3, duration: 0.1, sampleRate: 44100, channels: 1 }, new Blob([new Uint8Array([1, 2, 3])]));
    const tryAgain = buttonNamed('Try again', document.querySelector<HTMLElement>('[role="dialog"][aria-label="Saving failed"]')!)!;
    tryAgain.focus();
    await click(tryAgain);
    await until(() => saveStatus() === 'Autosave: Saved', 'Saved', 5000);
    expect(document.querySelector('[role="dialog"][aria-label="Saving failed"]')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Autosave: Saved');
  });
});

function dialogTab(name: string): HTMLButtonElement {
  const tab = [...(libraryDialog()?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])].find((t) => t.textContent?.includes(name));
  if (!tab) throw new Error(`${name} tab not found`);
  return tab;
}
