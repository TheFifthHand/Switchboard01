/**
 * Dropping a project file on the window opens it (shell-16):
 * .omnisong.zip and .sb01.zip open through the session's import; another
 * file is refused with a word (and never opened by the browser in place of
 * the app); a drop on a sampler's own drop zone keeps that zone's handling.
 *
 * Files cannot be dragged from the desktop in a headless browser, so the
 * drag events carry a DataTransfer built in the page (the same objects the
 * browser hands over for a desktop drag).
 */
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { session } from '../../src/app/instance';
import { ImportSampleButton } from '../../src/app/views/sampler/ImportSampleButton';
import { getStarter } from '../../src/content/starters';
import { exportBundle } from '../../src/persistence/bundle';
import { mount } from './ui-harness';
import { button, closeShell, openShell, settle, toasts, until } from './r4-shell-harness';

afterEach(async () => {
  vi.restoreAllMocks();
  await closeShell();
});

async function projectFile(name: string, fileName: string): Promise<File> {
  const p = getStarter('techno')!.build();
  p.name = name;
  return new File([await exportBundle(p, async () => null)], fileName, { type: 'application/zip' });
}

/** Drag `files` over `target` and drop them there; returns whether each event was default-prevented. */
function drop(target: Element, files: File[]): { over: boolean; dropped: boolean } {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  const r = target.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  let over = false;
  let dropped = false;
  act(() => {
    const o = new DragEvent('dragover', { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...at });
    target.dispatchEvent(o);
    over = o.defaultPrevented;
    const d = new DragEvent('drop', { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...at });
    target.dispatchEvent(d);
    dropped = d.defaultPrevented;
  });
  return { over, dropped };
}

describe('drop a project file on the window', () => {
  it('.omnisong.zip and .sb01.zip open; another file is refused and never opened by the browser', async () => {
    await openShell();
    await act(async () => {
      button('Just look around')!.click();
    });
    const main = document.querySelector('main')!;
    const r1 = drop(main, [await projectFile('Dropped Song', 'Dropped Song.omnisong.zip')]);
    expect(r1).toEqual({ over: true, dropped: true });
    await until(() => session.store.getState().name === 'Dropped Song', 'the project');
    await until(() => toasts().some((t) => t.includes('Opened "Dropped Song"')), 'the message');
    // A project file from SWITCHBOARD / 01.
    drop(document.querySelector('main')!, [await projectFile('Old Song', 'Old Song.sb01.zip')]);
    await until(() => session.store.getState().name === 'Old Song', 'the older project file');
    // Anything else: refused with a word, and the browser does not open it in place of the app.
    const before = session.store.getState();
    const r3 = drop(document.querySelector('main')!, [new File(['hello'], 'notes.txt', { type: 'text/plain' })]);
    expect(r3.dropped).toBe(true);
    await until(() => toasts().some((t) => t.startsWith('Only Omni Song project files')), 'the refusal');
    expect(session.store.getState()).toBe(before);
  });

  it('a drop on a sampler’s drop zone is the zone’s own', async () => {
    await openShell();
    await act(async () => {
      button('Just look around')!.click();
    });
    const imp = vi.spyOn(session, 'importProjectFile');
    const zoneHost = mount(h(ImportSampleButton, { trackId: 't8', variant: 'dropzone' }));
    const zone = zoneHost.container.firstElementChild!;
    const r = drop(zone, [await projectFile('Not Here', 'Not Here.omnisong.zip')]);
    expect(r.dropped).toBe(true);
    await settle(300);
    expect(imp).not.toHaveBeenCalled();
    expect(session.store.getState().name).not.toBe('Not Here');
  });
});
