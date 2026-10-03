/**
 * More scenes (only-four-scenes, scene-cards-silent): the SCENES palette
 * lists every scene, up to 8, with Add scene; a block's menu makes a scene
 * from that block (its parts as they sound there) with a toast naming it;
 * a card's ⋯ (or a right-click) offers Rename scene, Edit clips in Play and
 * Add at the end of the song. Real clicks and keys, the running app at
 * 1366 × 768, 1920 × 1080 and 200 % (960 × 540).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { MAX_SCENES } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { uiStore } from '../../src/state/uiStore';
import { blockEl, blockIds, blocks, card, centre, clickAt, menuItem, notice, openApp, openBlockMenu, press, project, resetArrange, rightClickAt, settle, teardownArrange } from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

const cards = () => [...document.querySelectorAll<HTMLElement>('[role="list"][aria-label="Scenes you can add to the song"] > [role="listitem"]')];
const addScene = () => document.querySelector<HTMLButtonElement>('button[aria-label="Add scene"]')!;
const names = () => cards().map((c) => c.querySelector('[class*="cardName"]')?.textContent);

/** Bring a card into view (the palette scrolls sideways when the cards do not fit) and press its ⋯. */
async function cardMenu(name: string) {
  const c = card(name);
  c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  await settle(40);
  await clickAt(centre(c.querySelector<HTMLElement>('[data-card-menu]')!));
  await settle(60);
  const m = document.querySelector<HTMLElement>('[role="menu"]');
  expect(m?.getAttribute('aria-label')).toBe(`Scene ${name}`);
}

describe('the scenes palette', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`${w} x ${hh}: lists every scene up to ${MAX_SCENES}; Add scene adds an empty one and is unavailable at ${MAX_SCENES}`, async () => {
      await openApp(w, hh);
      expect(names()).toEqual(['Intro', 'Groove', 'Lift', 'Break']);
      addScene().scrollIntoView({ block: 'nearest', inline: 'nearest' });
      await settle(30);
      await clickAt(centre(addScene()));
      await settle(60);
      expect(project().scenes.length).toBe(5);
      const fifth = project().scenes[4].name;
      expect(names()[4]).toBe(fifth);
      expect(notice()?.text).toContain(`Added the scene “${fifth}”`);
      // An empty scene: its ▶ says why it has nothing to play.
      const hear = card(fifth).querySelector<HTMLElement>('[data-testid="scene-audition"]')!;
      expect(hear.getAttribute('aria-disabled')).toBe('true');
      for (let i = 5; i < MAX_SCENES; i++) {
        addScene().scrollIntoView({ block: 'nearest', inline: 'nearest' });
        await settle(30);
        await clickAt(centre(addScene()));
        await settle(40);
      }
      expect(project().scenes.length).toBe(MAX_SCENES);
      expect(cards().length).toBe(MAX_SCENES);
      expect(addScene().getAttribute('aria-disabled')).toBe('true');
      // One more press does nothing.
      await clickAt(centre(addScene()));
      expect(project().scenes.length).toBe(MAX_SCENES);
      // Every card can be reached and pressed: in view after scrolling the palette, 32 px keys, no overlap.
      const boxes = cards().map((c) => c.getBoundingClientRect());
      for (let i = 1; i < boxes.length; i++) expect(boxes[i].left).toBeGreaterThanOrEqual(boxes[i - 1].right);
      for (const c of cards()) {
        c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        await settle(10);
        const r = c.getBoundingClientRect();
        expect(r.left).toBeGreaterThanOrEqual(0);
        expect(r.right).toBeLessThanOrEqual(window.innerWidth);
        for (const b of c.querySelectorAll<HTMLElement>('button')) {
          expect(b.getBoundingClientRect().width).toBeGreaterThanOrEqual(28);
          expect(b.getBoundingClientRect().height).toBeGreaterThanOrEqual(28);
        }
      }
      // The page never scrolls sideways.
      expect(document.scrollingElement!.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    });
  }

  it('“Make a scene from this block” makes a scene of what the block plays; the block plays it, sounding the same', async () => {
    await openApp(1366, 768);
    const ids = blockIds();
    // Groove with Intro layered into its silent parts, and Bass switched off.
    const groove = blocks()[1];
    const intro = project().scenes[0].id;
    const bass = project().tracks.find((t) => t.name === 'Bass')!.id;
    const pad = project().tracks.find((t) => t.name === 'Pad')!.id;
    act(() => {
      cmd.setBlockPart(session.store, groove.id, bass, null);
      cmd.setBlockPart(session.store, groove.id, pad, intro);
    });
    await settle(60);
    await openBlockMenu(ids[1]);
    act(() => menuItem('Scenes and clips').click());
    await settle(60);
    expect(menuItem('Make a scene from this block').textContent).toContain('keeps its parts');
    act(() => menuItem('Make a scene from this block').click());
    await settle(100);
    const made = project().scenes[4];
    expect(made.name).toBe('Groove 2');
    expect(notice()?.text).toContain('Made the scene “Groove 2” from block 2');
    expect(blocks()[1].sceneId).toBe(made.id);
    expect(blocks()[1].parts ?? {}).toEqual({});
    // Its clips: Groove's own, Intro's pad, no bass.
    const clipAt = (name: string) => project().tracks.find((t) => t.name === name)!.clips[4];
    expect(clipAt('Bass')).toBeNull();
    expect(clipAt('Pad')?.name).toBe(project().tracks.find((t) => t.name === 'Pad')!.clips[0]!.name);
    expect(clipAt('Drums')?.name).toBe(project().tracks.find((t) => t.name === 'Drums')!.clips[1]!.name);
    // A card for it, and the block is named after it.
    expect(names()).toContain('Groove 2');
    expect(blockEl(ids[1]).querySelector('[class*="name"]')!.textContent).toBe('Groove 2');
    // One Undo takes it all back.
    act(() => session.undo());
    expect(project().scenes.length).toBe(4);
    expect(blocks()[1].sceneId).toBe(groove.sceneId);
  });

  it('a card’s ⋯ and a right-click open Rename scene, Edit clips in Play and Add at the end of the song', async () => {
    await openApp(1366, 768);
    const n = blocks().length;
    // ⋯ → Rename scene…: the name is typed in place.
    await cardMenu('Lift');
    expect([...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((x) => x.textContent?.replace(/\d+ ×|×\s*\d+|\s+\d+ times?$/g, '').trim())).toEqual(
      expect.arrayContaining([expect.stringContaining('Rename scene'), expect.stringContaining('Edit clips in Play'), expect.stringContaining('Add at the end of the song')]),
    );
    act(() => menuItem('Rename scene').click());
    await settle(60);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Name of the scene Lift"]')!;
    expect(document.activeElement).toBe(input);
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'Rise');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press('Enter');
    await settle(60);
    expect(project().scenes[2].name).toBe('Rise');
    expect(names()[2]).toBe('Rise');
    expect(blockEl(blockIds()[2]).querySelector('[class*="name"]')!.textContent).toBe('Rise');
    // Right-click on a card: Add at the end of the song.
    await rightClickAt(centre(card('Break').querySelector<HTMLElement>('[class*="cardText"]')!));
    await settle(40);
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Scene Break');
    act(() => menuItem('Add at the end of the song').click());
    await settle(60);
    expect(blocks().length).toBe(n + 1);
    expect(blocks()[n].sceneId).toBe(project().scenes[3].id);
    // Edit clips in Play: the Play view, on that scene's row.
    await cardMenu('Groove');
    act(() => menuItem('Edit clips in Play').click());
    await settle(200);
    expect(uiStore.getState().view).toBe('play');
  });
});
