/**
 * Round 7 fix 2b, the whole app in real Chromium (Simple, House starter):
 * one name per instrument everywhere. The Melody instrument (stored as 2.4's
 * "Lead") is "Melody" on its row, in the Sound panel, on ● Record, in ⋯ ›
 * Every setting, and in the Jam pads, Mixer and Every setting sheets; never
 * "Lead". Renaming it to "Lead" works and shows. Advanced keeps "Lead".
 */
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { ToastProvider } from '../../src/ui/components';
import { ShareDialog } from '../../src/app/views/share/ShareDialog';
import { getStarter } from '../../src/content/starters';
import { cleanup, mount, wait } from './ui-harness';
import { session } from '../../src/app/instance';
import { closeLoopEditor } from '../../src/app/views/arrange/editorStore';
import { closeSound, openSound } from '../../src/app/views/arrange/sidePanelStore';
import { renameTrack } from '../../src/state/commands';
import { selectTrack, setUiMode, setView } from '../../src/state/uiStore';
import { button, click, closeShell, keys, openShell, settle, transport, until } from './r4-shell-harness';

afterEach(async () => {
  act(() => {
    closeLoopEditor();
    closeSound();
  });
  await closeShell();
});

async function home(): Promise<string> {
  await openShell({ mode: 'simple' });
  await keys('{Escape}');
  const lead = session.store.getState().tracks.find((t) => t.role === 'lead')!;
  expect(lead.name).toBe('Lead');
  act(() => selectTrack(lead.id));
  await settle(100);
  return lead.id;
}

const menuItem = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find((el) => el.textContent?.trim().startsWith(name));
/** The visible words of the page, plus accessible names (what a screen reader says). */
const words = (root: ParentNode = document) =>
  [(root as HTMLElement).textContent ?? '', ...[...root.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label') ?? '')].join(' | ');

describe('one name per instrument in Simple', () => {
  it('Melody on the row, Sound panel, Record, ⋯ and in every sheet; never Lead', async () => {
    const id = await home();
    // Row and ● Record.
    expect(document.querySelector('[data-testid="song-timeline"]')?.textContent).toContain('Melody');
    expect(button('Record Melody into the song', transport())).not.toBeNull();
    // Sound panel.
    act(() => openSound(id));
    const panel = await until(() => document.querySelector<HTMLElement>('[data-testid="sound-panel"]'), 'Sound panel');
    await settle(60);
    expect(panel.textContent).toContain('Melody');
    expect(words(panel)).not.toMatch(/\bLead\b/);
    act(() => closeSound());
    // ⋯ › Every setting names the selected instrument.
    await click(button(/^More/, transport())!);
    const every = await until(() => menuItem('Every setting'), '⋯ › Every setting');
    expect(every.textContent).toContain('Melody');
    await keys('{Escape}');
    // The sheets.
    for (const view of ['play', 'mix', 'shape'] as const) {
      act(() => setView(view));
      await settle(400);
      const sheet = await until(() => document.querySelector<HTMLElement>(`[data-sheet="${view}"]`), `${view} sheet`);
      expect(words(sheet), view).toContain('Melody');
      expect(words(sheet), view).not.toMatch(/\bLead\b/);
      act(() => setView('arrange'));
      await settle(150);
    }
  });

  it('renaming it "Lead" (2.4’s old default) shows "Lead" everywhere; Undo brings Melody back', async () => {
    const id = await home();
    act(() => {
      session.accepted(renameTrack(session.store, id, 'Lead'));
    });
    await settle(100);
    expect(button('Record Lead into the song', transport())).not.toBeNull();
    expect(document.querySelector('[data-testid="song-timeline"]')?.textContent).toContain('Lead');
    act(() => {
      session.store.undo();
    });
    await settle(100);
    expect(button('Record Melody into the song', transport())).not.toBeNull();
  });

  it('Advanced keeps the stored name (Lead)', async () => {
    await home();
    act(() => setUiMode('advanced'));
    await settle(300);
    act(() => setView('mix'));
    await settle(400);
    expect(words(document.body)).toMatch(/\bLead\b/);
    expect(document.body.textContent).not.toContain('Melody');
    act(() => setUiMode('simple'));
  });
});

describe('Share: the file is named after the song, and the name can become the song’s', () => {
  it('a typed name offers “Call my song … too”: one press renames the song (one undo step), the field shows it', async () => {
    act(() => {
      session.store.replace(getStarter('house')!.build(), { resetHistory: true });
      setUiMode('simple');
    });
    const was = session.store.getState().name;
    mount(h(ToastProvider, null, h(ShareDialog, { onClose: () => {} })), { width: 1366 });
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    const field = dialog().querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(field.placeholder).toBe(was);
    expect(dialog().querySelector('[data-testid="share-rename"]')).toBeNull();
    await userEvent.type(field, 'Песня 歌');
    await act(async () => wait(30));
    const offer = dialog().querySelector<HTMLButtonElement>('[data-testid="share-rename"]')!;
    expect(offer.textContent).toContain('Call my song “Песня 歌” too');
    await userEvent.click(offer);
    await act(async () => wait(30));
    expect(session.store.getState().name).toBe('Песня 歌');
    expect(field.value).toBe('');
    expect(field.placeholder).toBe('Песня 歌');
    expect(dialog().querySelector('[data-testid="share-rename"]')).toBeNull();
    act(() => {
      session.store.undo();
    });
    expect(session.store.getState().name).toBe(was);
    cleanup();
  });
});
