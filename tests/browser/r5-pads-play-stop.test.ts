/**
 * Play, stop and pause are obvious on the Loops pads. The whole app in real
 * Chromium with the real audio engine (the House starter playing through Jump
 * In), driven by trusted mouse and keyboard input:
 * - a clip pad says what a click does on hover and on keyboard focus: "▶ Play"
 *   on a waiting clip, "■ Stop" on the playing one, in its bottom-right
 *   corner; nothing on an empty pad or while a clip is carried;
 * - a click on the playing pad stops it at the next bar ("Stops at bar N")
 *   and never starts it again; a second click keeps it playing; once it has
 *   stopped, a click plays it at the next bar;
 * - the part key reads "▶ Play", "■ Stop", "✕ Cancel" in words with the same
 *   names as before, and fits its header from 1024 to 1920 px (the word shows
 *   in every column or in none);
 * - "❚❚ Pause" beside Stop all pauses the transport (every clip holds its
 *   place in its loop) and "▶ Continue" carries on in time; Space still
 *   pauses; a pad tapped while paused follows the rule it always had;
 * - scene buttons are "Play row …"; the playing row shows ■ and stops its
 *   parts at the next bar without starting them again; paused, the row that
 *   held continues.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { TICKS_PER_BAR, TICKS_PER_BEAT, type Id } from '../../src/project/types';
import { setBpm } from '../../src/state/commands';
import { button, clickEl, clipsOf, described, grid, openApp, pad, press, project, setUp, tearDown, until } from './r4-play-helpers';
import { centre, contrast, mouse, settleFrames } from './r4-uikit-input';
import { wait } from './ui-harness';

beforeEach(setUp);
afterEach(async () => {
  // Never leave the mouse button held for the next test.
  await mouse('mouseReleased', { x: 2, y: 2 }).catch(() => {});
  await tearDown();
});

const rt = (id: Id) => runtimeStore.getState().tracks[id];
const tick = () => session.transport!.getPosition().tick;
const phase = (id: Id) => session.transport!.clipPhase(id);

/** The pad's corner key ("▶ Play" / "■ Stop"), when it shows. */
function action(el: Element): HTMLElement | null {
  const a = el.querySelector<HTMLElement>('[data-pad-action]');
  return a && getComputedStyle(a).display !== 'none' && a.getBoundingClientRect().width > 0 ? a : null;
}
const actionText = (el: Element) => action(el)?.textContent ?? null;

/** The pointer rests away from the grid (the window's top-left corner). */
async function away(): Promise<void> {
  await mouse('mouseMoved', { x: 2, y: 2 });
  await settleFrames();
}

async function hover(el: Element): Promise<void> {
  await mouse('mouseMoved', centre(el));
  await settleFrames();
}

/**
 * The app playing (Jump In) at 60 BPM: a bar lasts 4 s, so a few clicks and checks fit before the
 * next bar line even on a busy machine.
 */
async function openPlaying(w: number, hh: number): Promise<void> {
  await openApp(w, hh, { play: true });
  act(() => void setBpm(session.store, 60));
}

/** Wait until the playhead is early in a bar, so a click lands well before the next bar line. */
async function earlyInBar(): Promise<void> {
  await until(() => {
    const t = tick() % TICKS_PER_BAR;
    return t > TICKS_PER_BEAT * 0.25 && t < TICKS_PER_BEAT * 1.5;
  }, 'early in a bar');
}

/** A slot of `trackId` with a clip, other than `not`. */
function otherClip(trackId: Id, not: number): number {
  const i = clipsOf(trackId).findIndex((c, s) => !!c && s !== not);
  if (i < 0) throw new Error(`no other clip on ${trackId}`);
  return i;
}

/** The part key of the part in column `i` (its id in the header's roving keys). */
const partKey = (i: number) => document.getElementById(`part-head-${i * 5 + 3}`) as HTMLButtonElement;
/** The word on a part key, when it shows (it can drop below the key where the column is too narrow). */
function keyWord(key: HTMLElement): string | null {
  const w = key.querySelector<HTMLElement>(':scope > span');
  if (!w) return null;
  const a = w.getBoundingClientRect();
  const b = key.getBoundingClientRect();
  return a.width > 0 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5 ? w.textContent : null;
}
const keyIcon = (key: HTMLElement) => key.querySelector('svg')?.getAttribute('data-icon');

const pauseKey = () => document.querySelector<HTMLButtonElement>('[data-pause-key]');
const sceneBtn = (row: number) => document.querySelector<HTMLButtonElement>(`[data-scene-row="${row}"] button[data-scene]`)!;
const sceneName = (row: number) => project().scenes[row].name;

describe('Clip pads say what a click does', () => {
  it('on hover and keyboard focus: ▶ Play on a waiting clip, ■ Stop on the playing one, in the pad’s corner', async () => {
    await openApp(1366, 768, { play: true });
    const row = rt('t3')!.playingSlot!;
    const playing = pad('t3', row);
    const waiting = pad('t3', otherClip('t3', row));
    const emptySlot = clipsOf('t3').findIndex((c) => !c);
    await away();
    expect(action(playing)).toBeNull();
    expect(action(waiting)).toBeNull();

    await hover(playing);
    expect(actionText(playing)).toBe('Stop');
    const a = action(playing)!;
    expect(a.querySelector('svg')?.getAttribute('data-icon')).toBe('stop');
    // In the pad's bottom-right corner, inside it.
    const ar = a.getBoundingClientRect();
    const pr = playing.getBoundingClientRect();
    expect(ar.right).toBeLessThanOrEqual(pr.right);
    expect(pr.right - ar.right).toBeLessThan(10);
    expect(ar.bottom).toBeLessThanOrEqual(pr.bottom);
    expect(pr.bottom - ar.bottom).toBeLessThan(12);
    // A dark key with readable words.
    const cs = getComputedStyle(a);
    expect(contrast(cs.color, cs.backgroundColor)).toBeGreaterThanOrEqual(4.5);
    // The playing pad keeps its amber light, and screen readers keep its state words.
    expect(playing.dataset.state).toBe('playing');
    expect(playing.getAttribute('aria-label')).toContain('Playing.');
    // Its tooltip says the same in words.
    expect(described(playing)).toContain('Tap to stop it at the next bar');

    await hover(waiting);
    expect(actionText(waiting)).toBe('Play');
    expect(action(waiting)!.querySelector('svg')?.getAttribute('data-icon')).toBe('play');
    expect(action(playing)).toBeNull();
    // Where there is room, its state word stays beside it.
    const ready = [...waiting.querySelectorAll<HTMLElement>('span')].find((s) => s.textContent === 'Ready' && s.children.length === 0)!;
    const rr = ready.getBoundingClientRect();
    expect(rr.width).toBeGreaterThan(0);
    expect(rr.bottom).toBeLessThanOrEqual(waiting.getBoundingClientRect().bottom);
    expect(rr.right).toBeLessThanOrEqual(action(waiting)!.getBoundingClientRect().left);
    expect(described(waiting)).toContain('Tap to play this clip from the next bar');

    // An empty pad has no such key (it offers Add clip).
    if (emptySlot >= 0) {
      await hover(pad('t3', emptySlot));
      expect(action(pad('t3', emptySlot))).toBeNull();
    }

    // Keyboard focus shows it too, with the pointer away from the pads.
    await away();
    act(() => pad('t2', otherClip('t3', row)).focus());
    await press('{ArrowRight}');
    expect(document.activeElement).toBe(waiting);
    expect(actionText(waiting)).toBe('Play');
  });

  it('while a clip is carried, no pad says Play or Stop (a drop is not a tap)', async () => {
    await openApp(1366, 768, { play: true });
    const row = rt('t3')!.playingSlot!;
    const playing = pad('t3', row);
    const waiting = pad('t3', otherClip('t3', row));
    const before = clipsOf('t3').map((c) => c?.id ?? null);
    const a = centre(waiting);
    const b = centre(playing);
    await mouse('mouseMoved', a);
    await mouse('mousePressed', a);
    for (let i = 1; i <= 8; i++) {
      await mouse('mouseMoved', { x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8 }, { buttons: 1 });
      await new Promise((r) => requestAnimationFrame(r));
    }
    await settleFrames();
    expect(grid().dataset.dragging).toBe('pad');
    expect(action(playing)).toBeNull();
    // Esc puts it back; nothing moved.
    await press('{Escape}');
    await mouse('mouseReleased', b);
    await settleFrames();
    expect(clipsOf('t3').map((c) => c?.id ?? null)).toEqual(before);
  });
});

describe('Clicking the playing pad', () => {
  it('stops it at the next bar and never starts it again; a second click keeps it playing; once stopped, a click plays it', async () => {
    await openPlaying(1366, 768);
    const row = rt('t3')!.playingSlot!;
    const p = pad('t3', row);
    await until(() => phase('t3') !== null, 'the bass to sound');
    const start = phase('t3')!.startTick;

    await earlyInBar();
    const clickedIn = Math.floor(tick() / TICKS_PER_BAR) + 1;
    await clickEl(p);
    // A stop at the next bar line: not a new start of the clip.
    const q = rt('t3')!.queued!;
    expect(q.slot).toBeNull();
    expect(rt('t3')!.playingSlot).toBe(row);
    expect(phase('t3')!.startTick).toBe(start);
    const bar = Math.floor(q.atTick / TICKS_PER_BAR) + 1;
    expect(bar).toBe(clickedIn + 1);
    expect(p.dataset.state).toBe('stopping');
    expect(p.textContent).toContain(`Stops at bar ${bar}`);
    expect(p.getAttribute('aria-label')).toContain(`Stops at bar ${bar}.`);
    // The pointer is still over it: it now offers to keep it playing.
    expect(actionText(p)).toBe('Play');

    // A second click before the bar line: it keeps playing past it.
    await clickEl(p);
    expect(rt('t3')!.queued?.slot).toBe(row);
    expect(p.dataset.state).toBe('playing');
    expect(actionText(p)).toBe('Stop');
    await until(() => tick() > q.atTick + TICKS_PER_BEAT, 'the bar line');
    expect(rt('t3')).toMatchObject({ playingSlot: row, queued: null });

    // Stop it again and let it stop.
    await earlyInBar();
    await clickEl(p);
    const q2 = rt('t3')!.queued!;
    expect(q2.slot).toBeNull();
    await until(() => rt('t3')!.playingSlot === null, 'the bass to stop');
    expect(session.transport!.playing).toBe(true);
    expect(p.dataset.state).toBe('ready');
    expect(actionText(p)).toBe('Play');

    // A click plays it from the next bar.
    await earlyInBar();
    await clickEl(p);
    expect(rt('t3')!.queued?.slot).toBe(row);
    await until(() => rt('t3')!.playingSlot === row && rt('t3')!.queued === null, 'the bass to play again');
    expect(p.dataset.state).toBe('playing');
  });
});

describe('The part key, in words', () => {
  it('▶ Play, ■ Stop and ✕ Cancel with the same names as before; a part that plays never shows ▶', async () => {
    await openPlaying(1920, 1080);
    // Bass (column 3) plays; Lead (column 5) does not.
    const bass = partKey(2);
    const lead = partKey(4);
    expect(keyWord(bass)).toBe('Stop');
    expect(keyIcon(bass)).toBe('stop');
    expect(bass.getAttribute('aria-label')).toBe('Stop Bass at the next bar');
    expect(described(bass)).toContain('Stops only this part, at the next bar');
    expect(keyWord(lead)).toBe('Play');
    expect(keyIcon(lead)).toBe('play');
    expect(lead.getAttribute('aria-label')).toMatch(/^Play Lead: /);

    // Lead waits for the bar line: its key cancels that start.
    await earlyInBar();
    await clickEl(lead);
    expect(rt('t5')!.queued?.slot).not.toBeNull();
    expect(keyWord(lead)).toBe('Cancel');
    expect(keyIcon(lead)).toBe('close');
    expect(lead.getAttribute('aria-label')).toBe('Cancel the start of Lead');
    await clickEl(lead);
    expect(rt('t5')).toMatchObject({ playingSlot: null, queued: null });
    expect(keyWord(lead)).toBe('Play');

    // Bass stops at the next bar: its key dims and says so, and does not offer ▶ (that would start it again).
    await earlyInBar();
    const start = phase('t3')!.startTick;
    await clickEl(bass);
    expect(rt('t3')!.queued?.slot).toBeNull();
    expect(phase('t3')!.startTick).toBe(start);
    expect(bass.disabled).toBe(true);
    expect(keyWord(bass)).toBe('Stop');
    expect(bass.getAttribute('aria-label')).toBe('Bass stops at the next bar');
    await until(() => rt('t3')!.playingSlot === null, 'the bass to stop');
    expect(keyWord(bass)).toBe('Play');
    expect(bass.disabled).toBe(false);
  });

  it('fits its header from 1024 to 1920 px: the word shows in every column or in none, and the name never changes', async () => {
    await openApp(1920, 1080, { play: true });
    const names = [...Array(8).keys()].map((i) => partKey(i).getAttribute('aria-label'));
    const shown: Record<number, boolean> = {};
    for (const [w, hh] of [
      [1024, 768],
      [1180, 800],
      [1280, 720],
      [1366, 768],
      [1440, 900],
      [1600, 900],
      [1920, 1080],
    ] as const) {
      await page.viewport(w, hh);
      window.scrollTo(0, 0);
      await settleFrames(4);
      const words = new Set<boolean>();
      for (let i = 0; i < 8; i++) {
        const key = partKey(i);
        expect(key.getAttribute('aria-label')).toBe(names[i]);
        const header = key.closest<HTMLElement>('[data-grid-head] > div')!;
        const k = key.getBoundingClientRect();
        const hr = header.getBoundingClientRect();
        expect(k.height).toBeGreaterThanOrEqual(32);
        expect(k.width).toBeGreaterThanOrEqual(32);
        expect(k.left).toBeGreaterThanOrEqual(hr.left);
        expect(k.right).toBeLessThanOrEqual(hr.right);
        // The part's '⋯' (where it shows) sits beside the key, never over it.
        const more = header.querySelector<HTMLElement>('button[aria-label^="Options for part"]');
        if (more && more.offsetParent) {
          const m = more.getBoundingClientRect();
          expect(m.left >= k.right || m.top >= k.bottom || m.bottom <= k.top).toBe(true);
        }
        words.add(keyWord(key) !== null);
      }
      // Every column shows its word, or none does.
      expect(words.size, `${w} px`).toBe(1);
      shown[w] = [...words][0];
    }
    // The words show from 1024 px except where the columns are narrowest beside the '⋯' (about 1180 px).
    expect(shown).toMatchObject({ 1024: true, 1280: true, 1366: true, 1440: true, 1600: true, 1920: true });
  });
});

describe('Pause where the pads are', () => {
  it('❚❚ Pause beside Stop all holds the transport and every clip’s place; ▶ Continue carries on in time; Space still pauses', async () => {
    await openPlaying(1366, 768);
    const key = pauseKey()!;
    const stopAll = button('Stop all parts at the next bar')!;
    expect(key.textContent).toBe('Pause');
    expect(key.querySelector('svg')?.getAttribute('data-icon')).toBe('pause');
    // In the Scenes header, right above Stop all.
    const kr = key.getBoundingClientRect();
    const sr = stopAll.getBoundingClientRect();
    expect(Math.abs(kr.left - sr.left)).toBeLessThan(1);
    expect(kr.bottom).toBeLessThanOrEqual(sr.top);
    expect(sr.top - kr.bottom).toBeLessThan(10);
    expect(kr.height).toBeGreaterThanOrEqual(32);

    const row = rt('t3')!.playingSlot!;
    await until(() => tick() > TICKS_PER_BAR + TICKS_PER_BEAT, 'into the second bar');
    const start = phase('t3')!.startTick;
    await clickEl(key);
    expect(runtimeStore.getState()).toMatchObject({ playing: false, paused: true });
    expect(session.transport!.paused).toBe(true);
    const held = tick();
    expect(pauseKey()!.textContent).toBe('Continue');
    expect(pad('t3', row).textContent).toContain('Paused');
    // The position holds while paused.
    await act(async () => {
      await wait(300);
    });
    expect(tick()).toBe(held);
    expect(phase('t3')).toMatchObject({ slot: row, startTick: start });

    await clickEl(pauseKey()!);
    expect(runtimeStore.getState()).toMatchObject({ playing: true, paused: false });
    // In time: from where it paused (not bar 1), the same clip with the same loop start.
    expect(tick()).toBeGreaterThanOrEqual(held);
    expect(tick()).toBeLessThan(held + TICKS_PER_BAR);
    expect(phase('t3')).toMatchObject({ slot: row, startTick: start });
    expect(pauseKey()!.textContent).toBe('Pause');

    // Space pauses and continues as before, and the key follows.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await press(' ');
    expect(runtimeStore.getState()).toMatchObject({ playing: false, paused: true });
    expect(pauseKey()!.textContent).toBe('Continue');
    await press(' ');
    expect(runtimeStore.getState()).toMatchObject({ playing: true, paused: false });
    expect(pauseKey()!.textContent).toBe('Pause');

    // Stopped, there is nothing to pause: the key goes.
    act(() => session.stop());
    await settleFrames();
    expect(pauseKey()).toBeNull();
  });

  it('while paused, tapping the clip that held carries on in time; tapping another clip queues it and playback carries on', async () => {
    await openPlaying(1366, 768);
    const row = rt('t3')!.playingSlot!;
    const other = otherClip('t3', row);
    await until(() => tick() > TICKS_PER_BAR, 'into the second bar');
    const start = phase('t3')!.startTick;
    await clickEl(pauseKey());
    expect(runtimeStore.getState().paused).toBe(true);

    // The pad that holds offers to carry on.
    await hover(pad('t3', row));
    expect(actionText(pad('t3', row))).toBe('Play');
    expect(described(pad('t3', row))).toContain('carry on from the pause');
    await clickEl(pad('t3', row));
    expect(runtimeStore.getState()).toMatchObject({ playing: true, paused: false });
    expect(rt('t3')).toMatchObject({ playingSlot: row, queued: null });
    expect(phase('t3')!.startTick).toBe(start);

    await clickEl(pauseKey());
    expect(runtimeStore.getState().paused).toBe(true);
    await clickEl(pad('t3', other));
    expect(runtimeStore.getState()).toMatchObject({ playing: true, paused: false });
    // It takes over at the next bar line after the pause point (which may come right after the click).
    expect(rt('t3')!.queued?.slot === other || rt('t3')!.playingSlot === other).toBe(true);
    await until(() => rt('t3')!.playingSlot === other, 'the other clip to take over');
  });
});

describe('Scene buttons', () => {
  it('say Play row; the playing row shows ■ and stops its parts at the next bar without starting them again; paused, the row that held continues', async () => {
    await openPlaying(1366, 768);
    const row = rt('t1')!.playingSlot!;
    const other = row === 0 ? 1 : 0;
    const inRow = project().tracks.filter((t) => !!t.clips[row]).map((t) => t.id);
    const btn = sceneBtn(row);
    expect(btn.getAttribute('aria-label')).toBe(`Stop row ${sceneName(row)} (playing)`);
    expect(btn.querySelector('svg')?.getAttribute('data-icon')).toBe('stop');
    expect(described(btn)).toContain('Stop row');
    expect(sceneBtn(other).getAttribute('aria-label')).toBe(`Play row ${sceneName(other)}`);
    expect(sceneBtn(other).querySelector('svg')?.getAttribute('data-icon')).toBe('play');
    expect(described(sceneBtn(other))).toContain(`Play the ${sceneName(other)} row`);

    // ■: every part of the row stops at the next bar; none starts again; the transport keeps running.
    await until(() => inRow.every((id) => phase(id) !== null), 'the row to sound');
    const starts = new Map(inRow.map((id) => [id, phase(id)!.startTick]));
    await earlyInBar();
    await clickEl(btn);
    for (const id of inRow) {
      expect(rt(id)).toMatchObject({ playingSlot: row, queued: { slot: null } });
      expect(phase(id)!.startTick).toBe(starts.get(id));
    }
    expect(btn.getAttribute('aria-label')).toBe(`Play row ${sceneName(row)} (stopping)`);
    expect(btn.querySelector('svg')?.getAttribute('data-icon')).toBe('play');
    await until(() => inRow.every((id) => rt(id)!.playingSlot === null), 'the row to stop');
    expect(session.transport!.playing).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe(`Play row ${sceneName(row)}`);

    // ▶ plays it again from the next bar.
    await clickEl(btn);
    await until(() => btn.getAttribute('aria-label') === `Stop row ${sceneName(row)} (playing)`, 'the row to play');

    // Paused, the row that held continues in time.
    await until(() => inRow.every((id) => phase(id) !== null), 'the row to sound again');
    await clickEl(pauseKey());
    expect(btn.getAttribute('aria-label')).toBe(`Continue row ${sceneName(row)} (paused)`);
    const held = new Map(inRow.map((id) => [id, phase(id)!.startTick]));
    await clickEl(btn);
    expect(runtimeStore.getState()).toMatchObject({ playing: true, paused: false });
    for (const id of inRow) {
      expect(rt(id)).toMatchObject({ playingSlot: row, queued: null });
      expect(phase(id)!.startTick).toBe(held.get(id));
    }
  });
});
