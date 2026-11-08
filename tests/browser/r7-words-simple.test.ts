/**
 * Round 7 words, in the running app (Simple, 1366×768, real mouse): no avoided word (EASY_SPEC ›
 * Vocabulary: bar, BPM, scene, pad, part, step, clip, mix, MIDI, velocity…, note names, "root",
 * "major/minor") is visible on the Song screen, the editor for drums (Draw and Play) and for a bass and the
 * chords (Draw and Play), LOOPS, Share, the Project ▾ and ⋯ menus, the region menu, and Help. Loop, sound and
 * instrument names are read, not learnt, so they pass. Advanced keeps 2.4's bar numbers.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_SOUNDS, DRUM_SLOTS } from '../../src/content/catalog';
import { LIBRARY_LOOPS } from '../../src/content/loops';
import { closeLoopEditor, openLoopEditor, setEditorMode } from '../../src/app/views/arrange/editorStore';
import { closeSound } from '../../src/app/views/arrange/sidePanelStore';
import { setTipsEnabled, setUiMode } from '../../src/state/uiStore';
import { avoidedWords } from '../unit/r7-words-avoid';
import { centre, clickAt, openSong, project, resetSong, rightClickAt, settle, teardownSong, trackId, waitFor } from './r5-song-helpers';

/** Names that are read, not learnt: loops, sounds, kit sounds, instruments, sections. */
function names(): string[] {
  const p = project();
  const clips = p.tracks.flatMap((t) => [...t.clips, ...(t.songClips ?? [])]).flatMap((c) => (c ? [c.name] : []));
  return [...clips, ...LIBRARY_LOOPS.map((l) => l.name), ...ALL_SOUNDS.map((s) => s.name), ...DRUM_SLOTS.map((d) => d.name), ...p.tracks.map((t) => t.name), ...p.arrangement.sections.map((s) => s.name)].sort((a, b) => b.length - a.length);
}

function visible(el: Element): boolean {
  const he = el as HTMLElement;
  if (he.closest('[inert], .visually-hidden')) return false;
  const s = getComputedStyle(he);
  if (s.visibility === 'hidden' || s.display === 'none') return false;
  const b = he.getBoundingClientRect();
  return b.width > 0 && b.height > 0 && b.bottom > 0 && b.right > 0 && b.top < innerHeight && b.left < innerWidth;
}

/** Every visible text on screen, one string per text node. */
function screenTexts(): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent?.trim();
    if (t && n.parentElement && visible(n.parentElement)) out.push(t);
  }
  return out;
}

/** The avoided words on screen now, with the text each was found in. */
function jargon(): string[] {
  const known = names();
  return screenTexts().flatMap((t) => avoidedWords(t, known).map((w) => `${w} ← “${t}”`));
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const buttonNamed = (re: RegExp) => [...document.querySelectorAll<HTMLElement>('button')].find((b) => visible(b) && re.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()));

async function press(re: RegExp): Promise<void> {
  const b = buttonNamed(re);
  expect(b, `a button ${re}`).toBeTruthy();
  await clickAt(centre(b!));
  await settle();
}

async function escape(): Promise<void> {
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await settle();
}

function openEditor(trackName: string): void {
  const p = project();
  const r = p.arrangement.regions.find((x) => x.trackId === trackId(trackName))!;
  act(() => {
    openLoopEditor(p, r.id);
  });
}

beforeEach(async () => {
  await resetSong('simple');
  act(() => {
    closeSound();
    setTipsEnabled(true);
  });
});

afterEach(async () => {
  act(() => {
    closeLoopEditor();
    setEditorMode('draw');
  });
  await teardownSong();
});

describe('no expert words in Simple', () => {
  it('on the Song screen, LOOPS and the tip line', async () => {
    await openSong(1366, 768);
    await settle(200);
    expect(byTestId('song-tip')).not.toBeNull();
    expect(jargon()).toEqual([]);
    // The ruler counts time, not bars.
    expect(screenTexts()).toContain('0:00');
  });

  it('in the editor: drums, a bass and the chords, Draw and Play', async () => {
    await openSong(1366, 768);
    for (const name of ['Drums', 'Bass', 'Chords']) {
      for (const mode of ['draw', 'play'] as const) {
        act(() => setEditorMode(mode));
        openEditor(name);
        await settle(200);
        expect(document.querySelector('[data-loop-editor]'), `${name} editor`).not.toBeNull();
        expect(jargon(), `${name} ${mode}`).toEqual([]);
      }
    }
  });

  it('in Project ▾, ⋯, a loop’s menu and Make it longer', async () => {
    await openSong(1366, 768);
    await press(/^Project:/);
    expect(jargon(), 'Project ▾').toEqual([]);
    await escape();
    await press(/^More/);
    expect(jargon(), '⋯').toEqual([]);
    await escape();
    await press(/^Make it longer/);
    expect(jargon(), 'Make it longer').toEqual([]);
    await escape();
    const r = project().arrangement.regions.find((x) => x.trackId === trackId('Bass'))!;
    const el = document.querySelector<HTMLElement>(`[data-region-id="${r.id}"]`)!;
    await rightClickAt(centre(el, 0.3, 0.5));
    await waitFor(() => !!document.querySelector('[role="menu"]'), 'the loop menu');
    expect(jargon(), 'loop menu').toEqual([]);
    await escape();
  });

  it('in Share and Help', async () => {
    await openSong(1366, 768);
    await press(/^Share$/);
    await waitFor(() => !!document.querySelector('[role="dialog"]'), 'Share');
    expect(jargon(), 'Share').toEqual([]);
    await escape();
    await press(/^More/);
    const help = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find((m) => m.textContent?.startsWith('Help'))!;
    await clickAt(centre(help));
    await waitFor(() => !!byTestId('help-how'), 'Help › How it works');
    expect(byTestId('help-how')!.textContent).toContain('How Omni Song works');
    expect(buttonNamed(/^Show every control$/)).toBeTruthy();
    expect(jargon(), 'Help').toEqual([]);
    await press(/^Keys$/);
    expect(jargon(), 'Help › Keys').toEqual([]);
    await escape();
  });

  it('Advanced keeps 2.4’s bar numbers on the ruler', async () => {
    await openSong(1366, 768);
    act(() => setUiMode('advanced'));
    await settle(200);
    expect(screenTexts()).toContain('9');
    expect(screenTexts()).not.toContain('0:00');
  });
});
