/**
 * The song header and the state it shows: ▶ Play the song while the pads
 * play (pads-playing-on-arrival), the playing block's word (playing-word),
 * Shape the song… with an intro and an ending (song-shapes), Record Notes
 * shown on the cells and in the mode box (notes-recording-invisible), the
 * hint contract (hint-covers-status), no tooltip popping up on an emptied
 * song (empty-tooltip), and the design details (design-04/08/10/14/15).
 * The running app with the real transport, real clicks and keys.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { FULL_HEADER_WIDTH } from '../../src/app/views/arrange/songLayout';
import { TICKS_PER_BAR } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { selectSlot, selectTrack, setTipsEnabled } from '../../src/state/uiStore';
import {
  blockEl,
  blockIds,
  blocks,
  cellEl,
  centre,
  clickAt,
  menuItem,
  mouse,
  notice,
  openApp,
  openBlockMenu,
  press,
  project,
  resetArrange,
  rt,
  sceneTake,
  settle,
  teardownArrange,
  trackId,
} from './r4-arrange-helpers';

beforeEach(resetArrange);
afterEach(teardownArrange);

const caption = () => document.querySelector<HTMLElement>('[data-testid="mode-caption"]')!;
const playTheSong = () => document.querySelector<HTMLButtonElement>('[data-testid="play-the-song"]');
const colour = (token: string) => {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
};
async function waitFor(ok: () => boolean, ms = 3000) {
  for (let t = 0; t < ms && !ok(); t += 50) await settle(50);
}

describe('the song header and what it shows', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`${w} x ${hh}: with the pads playing, an amber 40 px ▶ Play the song switches to the song`, async () => {
      await openApp(w, hh);
      expect(playTheSong()).toBeNull();
      await act(async () => {
        await session.launchScene(1);
      });
      await waitFor(() => rt().playing);
      await settle(100);
      const b = playTheSong()!;
      expect(b).not.toBeNull();
      expect(b.textContent).toContain('Play the song');
      expect(Math.round(b.getBoundingClientRect().height)).toBe(40);
      expect(getComputedStyle(b).borderTopColor).toBe(colour('--amber'));
      expect(b.querySelector('[data-icon="play"]')).not.toBeNull();
      expect(caption().textContent).toContain('Your Loops pads decide what plays. ▶ Play the song switches to the song');
      b.scrollIntoView({ block: 'nearest' });
      await clickAt(centre(b));
      await waitFor(() => rt().mode === 'song');
      expect(rt().mode).toBe('song');
      expect(rt().playing).toBe(true);
      expect(notice()?.text).toBe('Switched to the song');
      await settle(60);
      expect(playTheSong()).toBeNull();
    });
  }

  it('the playing block has no ▶ (it plays already) and its Playing tag shows its whole word, on a 112 px block too', async () => {
    await openApp(1366, 768);
    const ids = blockIds();
    const intro = blockEl(ids[0]);
    expect(intro.getBoundingClientRect().width).toBeGreaterThanOrEqual(FULL_HEADER_WIDTH - 1);
    expect(intro.getBoundingClientRect().width).toBeLessThan(140);
    expect(intro.querySelector('[data-play]')).not.toBeNull();
    await act(async () => {
      await session.playSong(0);
    });
    await waitFor(() => rt().songBlockId === ids[0]);
    await settle(150);
    expect(intro.querySelector('[data-play]')).toBeNull();
    const word = intro.querySelector<HTMLElement>('[class*="tagText"]')!;
    expect(word.textContent).toBe('Playing');
    expect(word.scrollWidth).toBeLessThanOrEqual(word.clientWidth + 0.5);
    expect(word.getBoundingClientRect().right).toBeLessThanOrEqual(intro.getBoundingClientRect().right);
    // Its menu still offers Play song from here; the next block still has its ▶.
    expect(blockEl(ids[1]).querySelector('[data-play]')).not.toBeNull();
  });

  it('Shape the song… adds an intro (a build-up of the first scene) and an ending (a strip-down with an echo tail), one Undo each', async () => {
    await openApp(1366, 768);
    act(() => void cmd.setTailSeconds(session.store, 0));
    const n = blocks().length;
    const first = blocks()[0].sceneId;
    const last = blocks()[n - 1].sceneId;
    const open = async () => {
      await clickAt(centre(document.querySelector<HTMLElement>('[data-testid="shape-song"]')!));
      await settle(60);
      expect(document.querySelector('[role="menu"]')!.getAttribute('aria-label')).toBe('Shape the song');
    };
    await open();
    expect(menuItem('Add an intro').parentElement!.textContent).toContain('its parts come in one at a time');
    await clickAt(centre(menuItem('Add an intro')));
    await settle(200);
    const added = blocks().length - n;
    expect(added).toBeGreaterThanOrEqual(2);
    expect(blocks().slice(0, added).every((b) => b.sceneId === first)).toBe(true);
    expect(notice()!.text).toMatch(/^Added an intro: .+ builds up over \d blocks at the start/);
    for (const b of blocks().slice(0, added)) expect(blockEl(b.id).hasAttribute('data-selected')).toBe(true);
    await open();
    await clickAt(centre(menuItem('Add an ending')));
    await settle(200);
    const ending = blocks().length - n - added;
    expect(ending).toBeGreaterThanOrEqual(2);
    expect(blocks().slice(-ending).every((b) => b.sceneId === last)).toBe(true);
    expect(notice()!.text).toContain(`with a ${cmd.ENDING_TAIL_SECONDS} s echo tail`);
    expect(project().arrangement.tailSeconds).toBe(cmd.ENDING_TAIL_SECONDS);
    act(() => session.undo());
    act(() => session.undo());
    expect(blocks().length).toBe(n);
  });

  it('Record Notes into a clip the song plays: its cells say Rec (coral), the mode box names the clip, and says when the block playing does not play it', async () => {
    await openApp(1366, 768);
    act(() => void cmd.setBpm(session.store, 240));
    const ids = blockIds();
    const chords = trackId('Chords');
    // The song from Groove's last bar: Chords plays Stabs (Groove's row) there; Lift, next, plays Stabs Up.
    await act(async () => {
      await session.playSong(1, { fromBar: 23 });
    });
    await waitFor(() => rt().songBlockId === ids[1]);
    act(() => {
      selectTrack(chords);
      selectSlot(chords, 1);
    });
    await act(async () => {
      await session.toggleRecordNotes();
    });
    await settle(150);
    expect(rt().recording).toBe('notes');
    expect(rt().recordTarget).toEqual({ trackId: chords, slot: 1 });
    const into = document.querySelector<HTMLElement>('[data-testid="recording-into"]')!;
    expect(into.textContent).toBe('Chords · Stabs (Groove)');
    expect(getComputedStyle(into).color).toBe(colour('--coral-ink'));
    // Every Groove block's Chords cell says Rec; Lift's does not.
    for (const i of [1, 5]) {
      const c = cellEl(ids[i], chords);
      expect(c.hasAttribute('data-rec')).toBe(true);
      expect(c.textContent).toContain('Rec');
      expect(c.getAttribute('aria-label')).toContain('recording notes into this clip');
    }
    expect(cellEl(ids[2], chords).hasAttribute('data-rec')).toBe(false);
    // On into Lift (one bar later at 240 BPM): it does not play Stabs, and the mode box says so.
    await waitFor(() => rt().songBlockId === ids[2], 4000);
    await waitFor(() => rt().recordTargetAudible === false, 1500);
    expect(rt().recordTargetAudible).toBe(false);
    await settle(60);
    expect(caption().textContent).toMatch(/^This block does not play it\./);
    act(() => session.stop());
    await settle(60);
    expect(document.querySelector('[data-testid="recording-into"]')).toBeNull();
    expect(cellEl(ids[1], chords).hasAttribute('data-rec')).toBe(false);
    expect(project().arrangement.blocks.length).toBe(ids.length);
    expect(TICKS_PER_BAR).toBeGreaterThan(0);
  });

  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`${w} x ${hh}: a hint home beside the scenes, clear of the cards and controls; the status and takes are marked to avoid`, async () => {
      await openApp(w, hh);
      sceneTake([[0, 4]]);
      await settle(200);
      const home = document.querySelector<HTMLElement>('[data-hint-home]')!;
      expect(home).not.toBeNull();
      const r = home.getBoundingClientRect();
      expect(r.width).toBeGreaterThanOrEqual(160);
      expect(r.height).toBeGreaterThanOrEqual(28);
      // Clear of every scene card, Add scene and the lane.
      const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      for (const el of document.querySelectorAll<HTMLElement>('[role="listitem"][aria-label^="Scene "], button[aria-label="Add scene"], [data-testid="lane-scroller"]')) {
        expect(overlaps(r, el.getBoundingClientRect()), el.getAttribute('aria-label') ?? el.className).toBe(false);
      }
      expect(caption().hasAttribute('data-hint-avoid')).toBe(true);
      // The take list (open) and the folded bar's newest take are marked too.
      const bar = document.querySelector<HTMLElement>('[data-testid="takes-open"]');
      if (bar) {
        expect(document.querySelector('[data-testid="performances"] [data-hint-avoid]')).not.toBeNull();
        bar.scrollIntoView({ block: 'center' });
        await clickAt(centre(bar));
        await settle(120);
      }
      expect(document.querySelector<HTMLElement>('[data-testid="take-list"]')!.closest('[data-hint-avoid]')).not.toBeNull();
    });
  }

  it('Ctrl+A and Delete empty the song without a tooltip popping up; the empty song’s tip shows above its button', async () => {
    await openApp(1366, 768);
    // Tips on (as they are by default), so tooltips have something to show.
    act(() => setTipsEnabled(true));
    const ids = blockIds();
    await clickAt(centre(blockEl(ids[0]).querySelector<HTMLElement>('[class*="name"]')!));
    await mouse('mouseMoved', { x: 2, y: 2 });
    await press('a', 2);
    expect(document.querySelectorAll('[data-block-id][data-selected]').length).toBe(ids.length);
    await press('Delete');
    await settle(900);
    expect(blocks().length).toBe(0);
    // Focus moved to Add all scenes: no tooltip unless the user points at it or moves to it with the keys.
    const add = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="song-lane"] button')].find((b) => b.textContent?.startsWith('Add all'))!;
    expect(document.activeElement).toBe(add);
    expect(document.querySelectorAll('[data-side][data-ready]').length).toBe(0);
    // Pointed at: its tip shows above it.
    await mouse('mouseMoved', { x: centre(add).x - 4, y: centre(add).y });
    await mouse('mouseMoved', centre(add));
    await settle(700);
    const bubble = document.querySelector<HTMLElement>('[data-side][data-ready="true"]')!;
    expect(bubble).not.toBeNull();
    expect(bubble.getAttribute('data-side')).toBe('top');
    expect(bubble.getBoundingClientRect().bottom).toBeLessThanOrEqual(add.getBoundingClientRect().top);
  });

  it('design: menu icons say what they do; 32 px header keys on full headers; lengths in Inter; Length labelled like Echo tail; long names fade and have a title', async () => {
    await openApp(1366, 768);
    const ids = blockIds();
    // design-15: the block menu's icons.
    await openBlockMenu(ids[1]);
    const iconOf = (text: string) => menuItem(text).querySelector('[data-icon]')?.getAttribute('data-icon');
    expect(iconOf('Rename')).toBe('pencil');
    expect(iconOf('Split in half')).toBe('scissors');
    expect(iconOf('Join with next')).toBe('join');
    expect(iconOf('Remove from song')).toBe('trash');
    expect(iconOf('Scenes and clips')).toBe('scene');
    act(() => menuItem('Scenes and clips').click());
    await settle(60);
    expect(iconOf('Layer a scene in')).toBe('layers');
    expect(iconOf('Replace parts with a scene')).toBe('layers');
    await press('Escape');
    await openBlockMenu(ids[1]);
    act(() => menuItem('Copy, cut, move').click());
    await settle(60);
    expect(iconOf('Cut')).toBe('scissors');
    // Trash only for deleting.
    const trash = [...document.querySelectorAll('[role="menu"] [data-icon="trash"]')];
    expect(trash.every((t) => /Remove|Delete/.test(t.closest('[role^="menuitem"]')!.textContent ?? ''))).toBe(true);
    await press('Escape');
    // design-10: full headers have 32 px ▶ and ⋯.
    for (const id of ids) {
      const el = blockEl(id);
      if (el.getBoundingClientRect().width < FULL_HEADER_WIDTH) continue;
      for (const b of el.querySelectorAll<HTMLElement>('[data-play], [aria-haspopup="menu"][aria-label*="block actions"]')) {
        expect(Math.round(b.getBoundingClientRect().width)).toBeGreaterThanOrEqual(32);
        expect(Math.round(b.getBoundingClientRect().height)).toBeGreaterThanOrEqual(32);
      }
    }
    // design-14: block lengths in Inter.
    expect(getComputedStyle(blockEl(ids[1]).querySelector<HTMLElement>('[data-testid="block-length"]')!).fontFamily).toMatch(/Inter/);
    // design-04: "Length" looks like "Echo tail".
    const length = [...document.querySelectorAll<HTMLElement>('[class*="readoutLabel"]')].find((x) => x.textContent === 'Length')!;
    const echo = [...document.querySelectorAll<HTMLElement>('label, span, div')].find((x) => x.childElementCount === 0 && x.textContent === 'Echo tail')!;
    for (const prop of ['fontSize', 'fontWeight', 'color', 'textTransform', 'letterSpacing', 'fontFamily'] as const) {
      expect(getComputedStyle(length)[prop], prop).toBe(getComputedStyle(echo)[prop]);
    }
    // design-08: a long name on the last block fades out (a mask) and the block's title has it whole.
    act(() => void cmd.renameBlock(session.store, ids[ids.length - 1], 'A very long name for the last block'));
    await settle(100);
    const last = blockEl(ids[ids.length - 1]);
    const name = last.querySelector<HTMLElement>('[class*="name"]')!;
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    const cs = getComputedStyle(name) as CSSStyleDeclaration & { webkitMaskImage?: string };
    expect(cs.maskImage || cs.webkitMaskImage).toMatch(/gradient/);
    expect(last.querySelector('[title]')!.getAttribute('title')).toContain('A very long name for the last block');
  });
});
