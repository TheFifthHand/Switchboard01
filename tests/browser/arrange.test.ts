/**
 * Arrange view in real Chromium: the song lane (blocks edge to edge with a
 * cell per part, keyboard and pointer reordering, passes, adding from the
 * palette by click and by drag, removing with undo, changing a block's scene,
 * the length readout, the mode box (what plays, the loop, how to play), the
 * current block while the song plays, one Play per screen (no Play song,
 * Stop or Export song in the song header) and the empty state) and recorded
 * performances (a one-line bar with no takes, rename, delete with undo, the
 * event list and deleting events, notes as a press/release pair, "Show
 * more"). Everything is checked on the project in session.store —
 * the same data playback and export use. The lane's gestures in depth (copy,
 * multi-select, edge drag, split/join, parts, layering, clipboard, keyboard)
 * are in song-lane.test.ts.
 */
import '../../src/ui/theme.css';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { formatSeconds } from '../../src/app/session';
import { ArrangeView } from '../../src/app/views/arrange/ArrangeView';
import { EVENT_MORE, EVENT_PAGE } from '../../src/app/views/arrange/PerformancesPanel';
import { formatPosition, parsePosition, performanceRows } from '../../src/app/views/arrange/perfEvents';
import { FULL_HEADER_WIDTH } from '../../src/app/views/arrange/songLayout';
import { getStarter } from '../../src/content/starters';
import type { Id, Performance, PerformanceEvent } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { setView, uiStore, slotFor } from '../../src/state/uiStore';
import { clampBpm, ticksToSeconds } from '../../src/time/clock';
import { songLengthTicks } from '../../src/time/sequencer';
import { makeSnapshot } from '../../src/time/snapshot';
import { actFrame, cleanup, fire, key, mount, pointer, wait } from './ui-harness';

beforeEach(() => {
  // The lane's remembered settings (Follow, the Performances panel open or folded) start fresh.
  localStorage.removeItem('switchboard01.songLane');
  session.store.replace(getStarter('house')!.build(), { resetHistory: true });
  act(() => {
    patchRuntime({ held: {}, notice: null, recording: 'off', playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null, replayId: null });
    setView('arrange');
  });
});

afterEach(() => {
  // Tests that play for real leave nothing running for the next one.
  if (session.playing) act(() => session.stop());
  cleanup();
  act(() => patchRuntime({ playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null, replayId: null }));
  // The view is remembered in localStorage, shared with the other test files: leave the default.
  act(() => setView('play'));
});

/** Poll (letting React and the audio clock run) until `cond` holds. */
async function waitFor(cond: () => boolean, what: string, timeout = 8000): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await act(async () => {
      await wait(30);
    });
  }
}

/** The element whose accessible label is exactly `label`. */
function byExactLabel<T extends HTMLElement = HTMLButtonElement>(label: string, root: ParentNode = document): T {
  const el = [...root.querySelectorAll<T>('[aria-label]')].find((x) => x.getAttribute('aria-label') === label);
  if (!el) throw new Error(`No element labelled "${label}"`);
  return el;
}

const rt = () => runtimeStore.getState();

async function setup(width = 1320) {
  const m = mount(h('div', { style: { width: `${width}px`, height: '680px', display: 'flex', flexDirection: 'column' } }, h(ArrangeView)), { width: width + 40 });
  // Let the lane measure itself (ResizeObserver) so block geometry is final.
  await actFrame();
  await actFrame();
  // …and let the short slide transitions finish before measuring rectangles.
  await act(async () => {
    await wait(260);
  });
  return m;
}

/** Let slide transitions finish. */
async function settle(ms = 360) {
  await act(async () => {
    await wait(ms);
  });
}

const project = () => session.store.getState();
const blockIds = () => project().arrangement.blocks.map((b) => b.id);
const sceneIdByName = (name: string) => project().scenes.find((s) => s.name === name)!.id;
const blockEl = (id: Id) => document.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
const lengthText = () => document.querySelector('[data-testid="song-length"]')!.textContent!.replace(/\s+/g, ' ').trim();
/** The x the lane last placed a block at (its transform), in lane pixels. */
const placedX = (id: Id) => Number(/translate3d\((-?[\d.]+)px/.exec(blockEl(id).style.transform)?.[1] ?? NaN);

function click(el: Element, init: MouseEventInit = {}) {
  fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
}

function byLabel<T extends HTMLElement = HTMLButtonElement>(start: string, root: ParentNode = document): T {
  const el = [...root.querySelectorAll<T>('[aria-label]')].find((x) => x.getAttribute('aria-label')!.startsWith(start));
  if (!el) throw new Error(`No element labelled "${start}…"`);
  return el;
}

function menuItem(text: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find((x) => x.textContent!.trim().startsWith(text));
  if (!el) throw new Error(`No menu item "${text}…"`);
  return el;
}

function expectedLength(): string {
  const p = project();
  const ticks = songLengthTicks(p);
  return `${ticks / 384 === 1 ? '1 bar' : `${ticks / 384} bars`} · ${formatSeconds(ticksToSeconds(ticks, clampBpm(p.bpm)))}`;
}

function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Press on a block's header and drag it by dx (real pointer events past the threshold), optionally releasing. */
function dragBlock(id: Id, dx: number, opts: { dy?: number; release?: boolean; ctrlKey?: boolean } = {}) {
  const r = blockEl(id).getBoundingClientRect();
  const start = { clientX: r.left + 20, clientY: r.top + 12 };
  pointer(blockEl(id), 'pointerdown', start);
  pointer(document.body, 'pointermove', { clientX: start.clientX + 6, clientY: start.clientY + 1, ctrlKey: opts.ctrlKey });
  const end = { clientX: start.clientX + dx, clientY: start.clientY + (opts.dy ?? 2), ctrlKey: opts.ctrlKey };
  pointer(document.body, 'pointermove', end);
  if (opts.release !== false) pointer(document.body, 'pointerup', end);
  return end;
}

/** Drag from an element to a point (used for scene cards). */
function drag(from: HTMLElement, to: { x: number; y: number }, opts: { release?: boolean } = {}) {
  const r = from.getBoundingClientRect();
  const start = { clientX: r.left + 18, clientY: r.top + r.height / 2 };
  pointer(from, 'pointerdown', start);
  pointer(document.body, 'pointermove', { clientX: start.clientX + 8, clientY: start.clientY + 2 });
  pointer(document.body, 'pointermove', { clientX: to.x, clientY: to.y });
  if (opts.release !== false) pointer(document.body, 'pointerup', { clientX: to.x, clientY: to.y });
}

describe('Song lane', () => {
  it('shows every block edge to edge with its name, length and a cell per part, and the song length', async () => {
    // Wide enough that no block needs the minimum width: widths are then exactly proportional.
    await setup(1560);
    const p = project();
    const items = [...document.querySelectorAll<HTMLElement>('[data-block-id]')];
    expect(items.map((e) => e.dataset.blockId)).toEqual(blockIds());
    const first = p.arrangement.blocks[0];
    const scene = p.scenes.find((s) => s.id === first.sceneId)!;
    expect(items[0].getAttribute('aria-label')).toContain(scene.name);
    expect(items[0].textContent).toContain('8 bars');
    expect(lengthText()).toBe(expectedLength());
    // Widths follow the length: a 16-bar block is twice as wide as an 8-bar one, and blocks touch.
    const rect = (i: number) => items[i].getBoundingClientRect();
    expect(rect(0).width).toBeGreaterThanOrEqual(FULL_HEADER_WIDTH);
    expect(rect(1).width / rect(0).width).toBeCloseTo(2, 1);
    for (let i = 1; i < items.length; i++) expect(Math.abs(rect(i).left - rect(i - 1).right)).toBeLessThan(1.5);
    // One cell per part, named for the part and what it plays.
    const cells = [...items[1].querySelectorAll<HTMLElement>('[data-cell]')];
    expect(cells.length).toBe(p.tracks.length);
    const drums = p.tracks[0];
    const clip = drums.clips[p.scenes.findIndex((s) => s.id === p.arrangement.blocks[1].sceneId)]!;
    expect(cells[0].getAttribute('aria-label')).toBe(`${drums.name} in Groove (block 2): plays “${clip.name}”`);
    expect(cells[0].getAttribute('aria-pressed')).toBe('true');
    // The part names sit beside the lane, one per row.
    const names = document.querySelector('[data-testid="song-lane"]')!.textContent!;
    for (const t of p.tracks) expect(names).toContain(t.name);
  });

  it('reorders with Alt+Arrow keys on a focused block and keeps focus on it', async () => {
    await setup();
    const before = blockIds();
    const el = blockEl(before[0]);
    act(() => el.focus());
    key(el, 'keydown', { key: 'ArrowRight', altKey: true });
    expect(blockIds()).toEqual([before[1], before[0], ...before.slice(2)]);
    expect(document.activeElement).toBe(blockEl(before[0]));
    key(document.activeElement!, 'keydown', { key: 'ArrowRight', altKey: true });
    expect(blockIds().indexOf(before[0])).toBe(2);
    key(document.activeElement!, 'keydown', { key: 'ArrowLeft', altKey: true });
    key(document.activeElement!, 'keydown', { key: 'ArrowLeft', altKey: true });
    expect(blockIds()).toEqual(before);
    // Plain arrows move focus between blocks without changing the song.
    key(document.activeElement!, 'keydown', { key: 'ArrowRight' });
    expect(document.activeElement).toBe(blockEl(before[1]));
    expect(blockIds()).toEqual(before);
    // One undo step per move.
    act(() => session.undo());
    expect(blockIds()).toEqual([before[1], before[0], ...before.slice(2)]);
  });

  it('reorders by pointer drag: the other blocks slide aside live, the drop commits exactly that order', async () => {
    await setup();
    const before = blockIds();
    const xs = before.map((id) => placedX(id));
    const moved = before[3];
    const w = blockEl(moved).getBoundingClientRect().width;
    // Carry block 4 so its left edge sits on block 2's left edge.
    dragBlock(moved, xs[1] - xs[3], { release: false });
    expect(document.querySelector('[data-testid="lane-clone"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="song-lane"]')!.getAttribute('data-carry')).toBe('move');
    expect(document.querySelector('[data-testid="lane-clone"]')!.textContent).toContain('Move to position 2');
    // Blocks 2 and 3 made room: each moved right by the dragged block's width. Nothing committed yet.
    expect(placedX(before[1])).toBeCloseTo(xs[1] + w, 0);
    expect(placedX(before[2])).toBeCloseTo(xs[2] + w, 0);
    expect(placedX(before[0])).toBe(xs[0]);
    expect(blockIds()).toEqual(before);
    const undoBefore = session.store.historySize().undo;
    const r = blockEl(moved).getBoundingClientRect();
    pointer(document.body, 'pointerup', { clientX: r.left + 20 + (xs[1] - xs[3]), clientY: r.top + 14 });
    expect(blockIds()).toEqual([before[0], before[3], before[1], before[2], before[4], before[5]]);
    expect(session.store.historySize().undo).toBe(undoBefore + 1);
    expect(document.querySelector('[data-testid="lane-clone"]')).toBeNull();
    expect(document.querySelector('[data-testid="song-lane"]')!.hasAttribute('data-carry')).toBe(false);
    // The moved block is selected; the polite status says where it went.
    expect(blockEl(moved).hasAttribute('data-selected')).toBe(true);
    expect(document.querySelector('[data-testid="lane-status"]')!.textContent).toContain('to position 2');
    await settle();
    expect(placedX(moved)).toBe(xs[1]);
    act(() => session.undo());
    expect(blockIds()).toEqual(before);
  });

  it('a drag released away from the lane or cancelled with Escape changes nothing', async () => {
    await setup();
    const before = blockIds();
    const xs = before.map((id) => placedX(id));
    const undoBefore = session.store.historySize().undo;
    // Released well below the lane.
    dragBlock(before[0], 300, { dy: 400 });
    expect(blockIds()).toEqual(before);
    // Escape mid-drag puts everything back; the release that follows does nothing.
    dragBlock(before[0], xs[4] - xs[0], { release: false });
    expect(placedX(before[1])).not.toBe(xs[1]);
    key(window, 'keydown', { key: 'Escape' });
    expect(document.querySelector('[data-testid="lane-clone"]')).toBeNull();
    pointer(document.body, 'pointerup', { clientX: 900, clientY: 300 });
    expect(blockIds()).toEqual(before);
    expect(session.store.historySize().undo).toBe(undoBefore);
    await settle();
    expect(before.map((id) => placedX(id))).toEqual(xs);
  });

  it('changes passes with the +/- keys and the menu (1 to 16); the length updates', async () => {
    await setup();
    const id = blockIds()[0];
    const repeats = () => project().arrangement.blocks.find((b) => b.id === id)!.repeats;
    const start = repeats();
    const lenBefore = lengthText();
    const el = blockEl(id);
    act(() => el.focus());
    key(el, 'keydown', { key: '+' });
    expect(repeats()).toBe(start + 1);
    expect(lengthText()).toBe(expectedLength());
    expect(lengthText()).not.toBe(lenBefore);
    key(blockEl(id), 'keydown', { key: '-' });
    key(blockEl(id), 'keydown', { key: '-' });
    expect(repeats()).toBe(start - 1);
    // Bounded 1..16: extra presses at the limit do nothing.
    for (let i = 0; i < 20; i++) key(blockEl(id), 'keydown', { key: '-' });
    expect(repeats()).toBe(1);
    for (let i = 0; i < 20; i++) key(blockEl(id), 'keydown', { key: '+' });
    expect(repeats()).toBe(16);
    expect(lengthText()).toBe(expectedLength());
    // The actions menu has the same: one time fewer.
    act(() => blockEl(id).focus());
    key(blockEl(id), 'keydown', { key: 'Enter' });
    click(menuItem('One time fewer'));
    expect(repeats()).toBe(15);
  });

  it('adds scenes from the palette (+ appends, drag inserts) and removes blocks with undo', async () => {
    await setup();
    const n = blockIds().length;
    click(byLabel('Add Break to the end of the song'));
    const after = project().arrangement.blocks;
    expect(after.length).toBe(n + 1);
    expect(after[n].sceneId).toBe(sceneIdByName('Break'));
    expect(lengthText()).toBe(expectedLength());

    // Drag the Groove card to the very start of the lane (the left end of the first block).
    const first = blockEl(blockIds()[0]).getBoundingClientRect();
    const card = byLabel<HTMLElement>('Scene Groove');
    drag(card, { x: first.left + 6, y: first.top + first.height / 2 });
    expect(project().arrangement.blocks.length).toBe(n + 2);
    expect(project().arrangement.blocks[0].sceneId).toBe(sceneIdByName('Groove'));

    // Remove from the block's menu (focus moves to the next block), then Undo brings it back.
    const removeId = blockIds()[2];
    const following = blockIds()[3];
    act(() => blockEl(removeId).focus());
    key(blockEl(removeId), 'keydown', { key: 'Enter' });
    click(menuItem('Remove from song'));
    expect(blockIds()).not.toContain(removeId);
    expect(document.activeElement).toBe(blockEl(following));
    expect(runtimeStore.getState().notice?.action).toBe('undo');
    act(() => session.undo());
    expect(blockIds()[2]).toBe(removeId);

    // Delete on a focused block removes it too and moves focus to its neighbour.
    const el = blockEl(removeId);
    const next = blockIds()[3];
    act(() => el.focus());
    key(el, 'keydown', { key: 'Delete' });
    expect(blockIds()).not.toContain(removeId);
    expect(document.activeElement).toBe(blockEl(next));
  });

  it("changes a block's scene from its menu and opens its clips in Play", async () => {
    await setup();
    const id = blockIds()[0];
    click(byLabel('Intro: block actions', blockEl(id)));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    click(menuItem('Scenes and clips'));
    click(menuItem('Change scene'));
    const breakItem = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitemcheckbox"]')].find((x) => x.textContent!.startsWith('Break'))!;
    click(breakItem);
    expect(project().arrangement.blocks[0].sceneId).toBe(sceneIdByName('Break'));
    expect(document.querySelector('[role="menu"]')).toBeNull();

    // Edit clips switches to Play (Loops) with that scene row's clips selected.
    click(byLabel('Break: block actions', blockEl(id)));
    click(menuItem('Scenes and clips'));
    click(menuItem('Edit clips'));
    const ui = uiStore.getState();
    expect(ui.view).toBe('play');
    expect(ui.padMode).toBe('loops');
    const row = project().scenes.findIndex((s) => s.name === 'Break');
    for (const t of project().tracks) if (t.clips[row]) expect(slotFor(ui, t.id)).toBe(row);
    const withClip = project().tracks.find((t) => t.clips[row])!;
    expect(ui.selectedTrackId).toBe(withClip.id);
  });

  it('changes the echo tail (added to song exports) with the field', async () => {
    await setup();
    expect(document.querySelector('section[aria-labelledby="song-title"]')!.textContent).toContain('Echo tail');
    expect(document.querySelector('section[aria-labelledby="song-title"]')!.textContent).not.toContain('Export tail');
    const before = project().arrangement.tailSeconds;
    const field = document.querySelector<HTMLInputElement>('section[aria-labelledby="song-title"] input[role="spinbutton"]')!;
    act(() => field.focus());
    key(field, 'keydown', { key: 'ArrowUp' });
    expect(project().arrangement.tailSeconds).toBe(before + 0.5);
  });

  it('deleting the last block leaves focus on Add all scenes', async () => {
    const one = getStarter('house')!.build();
    one.arrangement = { blocks: [one.arrangement.blocks[0]], tailSeconds: 3 };
    session.store.replace(one, { resetHistory: true });
    await setup();
    const el = blockEl(blockIds()[0]);
    act(() => el.focus());
    key(el, 'keydown', { key: 'Delete' });
    expect(blockIds()).toEqual([]);
    expect(document.activeElement?.textContent).toContain('Add all');
    act(() => session.undo());
    expect(blockIds().length).toBe(1);
  });

  it('guides an empty song: Add all scenes fills the lane in order', async () => {
    session.store.replace({ ...getStarter('house')!.build(), arrangement: { blocks: [], tailSeconds: 3 } }, { resetHistory: true });
    await setup();
    expect(document.body.textContent).toContain('Your song is empty');
    expect(document.querySelector<HTMLButtonElement>('[data-testid="loop-toggle"]')!.disabled).toBe(true);
    expect(document.querySelector('[data-testid="playback-mode"]')!.textContent).toContain('Add scenes below to build a song');
    const addAll = [...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Add all'))!;
    act(() => addAll.focus());
    click(addAll);
    expect(project().arrangement.blocks.map((b) => b.sceneId)).toEqual(project().scenes.map((s) => s.id));
    expect(lengthText()).toBe(expectedLength());
    // The button went away with the empty state: keyboard focus lands on the first new block.
    expect(document.activeElement).toBe(blockEl(blockIds()[0]));
    // Adding every scene is one undo step.
    act(() => session.undo());
    expect(blockIds()).toEqual([]);
  });

  it('says in plain words what plays (your pads, the song, a take) and how to play, and marks the playing block by id while edits apply live', async () => {
    await setup();
    const mode = () => document.querySelector('[data-testid="playback-mode"]')!.textContent!;
    expect(mode()).toContain('Stopped');
    expect(mode()).toContain('Play (or Space) plays the song from the first block');
    expect(mode()).toContain('▶ on a block, or a click on the bar numbers, plays it from there');
    expect(mode()).not.toContain('Playback follows');
    act(() => patchRuntime({ playing: true, mode: 'live' }));
    expect(mode()).toContain('Now playing:your pads');
    act(() => patchRuntime({ playing: false }));
    // While a take records, the song and takes are locked (the take lock refuses their edits): say so.
    act(() => patchRuntime({ playing: true, mode: 'live', recording: 'performance' }));
    expect(mode()).toContain('recording a take');
    expect(mode()).toContain('cannot be edited until you stop recording');
    act(() => patchRuntime({ playing: false, recording: 'off' }));
    const ids = blockIds();
    act(() => patchRuntime({ playing: true, mode: 'song', songBlock: 2, songBlockId: ids[2] }));
    expect(mode()).toContain('Now playing:the song');
    expect(mode()).toContain('Block 3 of 6');
    expect(mode()).toContain('Edits play right away');
    const current = blockEl(ids[2]);
    expect(current.dataset.current).toBeDefined();
    expect(current.textContent).toContain('Playing');
    expect(current.getAttribute('aria-label')).toContain('playing now');
    // Moving the playing block keeps it marked (the runtime follows block ids); edits apply live, so there is no "restart" banner.
    act(() => current.focus());
    key(current, 'keydown', { key: 'ArrowLeft', altKey: true });
    expect(blockIds()[1]).toBe(ids[2]);
    expect(blockEl(ids[2]).dataset.current).toBeDefined();
    expect(document.querySelectorAll('[data-current]').length).toBe(1);
    expect(document.body.textContent).not.toContain('You changed the song while it plays');
    expect(document.body.textContent).not.toContain('Restart from block');
    // Paused: still the arrangement, and it says so.
    act(() => patchRuntime({ playing: false, paused: true }));
    expect(mode()).toContain('Paused in block');
    act(() => patchRuntime({ playing: false, paused: false, mode: 'live', songBlock: null, songBlockId: null }));
    expect(mode()).toContain('Stopped');
    expect(document.querySelector('[data-current]')).toBeNull();
  });

  it('the mode box says "looping" only while playback is inside the loop and repeats it, else "loop set"', async () => {
    await setup();
    const ids = blockIds();
    const mode = () => document.querySelector('[data-testid="playback-mode"]')!.textContent!;
    act(() => patchRuntime({ songLoop: { fromBlockId: ids[1], toBlockId: ids[1] }, songLooping: false }));
    // Stopped with a loop: Play starts there.
    expect(mode()).toContain('Loop set: Groove (block 2)');
    expect(mode()).toContain('plays the song from the loop');
    // Playing outside the loop (block 4): the loop is set, not looping.
    act(() => patchRuntime({ playing: true, mode: 'song', songBlock: 3, songBlockId: ids[3] }));
    expect(mode()).toContain('Block 4 of 6');
    expect(mode()).toContain('loop set: Groove (block 2)');
    expect(mode()).not.toContain('looping');
    // Inside the loop, repeating it: looping.
    act(() => patchRuntime({ songBlock: 1, songBlockId: ids[1], songLooping: true }));
    expect(mode()).toContain('looping Groove (block 2)');
    expect(mode()).not.toContain('loop set');
    act(() => patchRuntime({ playing: false, mode: 'live', songBlock: null, songBlockId: null, songLoop: null, songLooping: false }));
  });

  it('▶ on a block drives the real transport; the playhead and current block follow it; Stop hands back to the pads', async () => {
    await setup();
    const ids = blockIds();
    const mode = () => document.querySelector('[data-testid="playback-mode"]')!.textContent!;
    const head = () => document.querySelector<HTMLElement>('[data-testid="playhead"]')!;

    click(byLabel('Play song from block 1', blockEl(ids[0])));
    await waitFor(() => rt().playing && rt().mode === 'song' && !!session.transport?.playing, 'song playback');
    expect(rt().songBlockId).toBe(ids[0]);
    expect(mode()).toContain('the song');

    // Start from block 3: the transport jumps to its first bar (after Intro 8 + Groove 16 bars).
    click(byLabel('Play song from block 3', blockEl(ids[2])));
    await waitFor(() => rt().songBlockId === ids[2] && (session.transport?.getPosition().tick ?? 0) >= 24 * 384, 'block 3');
    await actFrame();
    await actFrame();
    expect(mode()).toContain('Block 3 of 6');
    expect(blockEl(ids[2]).dataset.current).toBeDefined();
    expect(document.querySelectorAll('[data-current]').length).toBe(1);
    // The playhead is drawn from the transport position: at the left of block 3, then moving right.
    const r = blockEl(ids[2]).getBoundingClientRect();
    const x0 = head().getBoundingClientRect().left + 1;
    expect(getComputedStyle(head()).opacity).toBe('1');
    expect(x0).toBeGreaterThanOrEqual(r.left - 2);
    expect(x0).toBeLessThan(r.left + 40);
    await act(async () => {
      await wait(700);
    });
    await actFrame();
    expect(head().getBoundingClientRect().left + 1).toBeGreaterThan(x0);

    // Blocks before the playhead move (Intro goes after Lift): it glides to its new place (about 150 ms) instead of jumping.
    const contentLeft = () => document.querySelector<HTMLElement>('[data-testid="song-lane"] > div:nth-child(2) > div')!.getBoundingClientRect().left;
    const into = head().getBoundingClientRect().left - (contentLeft() + placedX(ids[2]));
    const shift = blockEl(ids[0]).getBoundingClientRect().width;
    act(() => blockEl(ids[0]).focus());
    key(blockEl(ids[0]), 'keydown', { key: 'ArrowRight', altKey: true });
    key(document.activeElement!, 'keydown', { key: 'ArrowRight', altKey: true });
    expect(blockIds().indexOf(ids[2])).toBe(1);
    expect(rt().songBlockId).toBe(ids[2]);
    const target = () => contentLeft() + placedX(ids[2]) + into;
    // It passes through places in between (a glide, not a jump), whatever the frame timing.
    const seen: number[] = [];
    const times: number[] = [performance.now()];
    for (let i = 0; i < 8; i++) {
      await actFrame();
      seen.push(head().getBoundingClientRect().left - target());
      times.push(performance.now());
    }
    // (A machine so busy that one frame takes as long as the whole glide cannot show a place in between.)
    const starved = times.some((t, i) => i > 0 && t - times[i - 1] > 120);
    expect(starved || seen.some((d) => d > 6 && d < shift - 6), JSON.stringify({ seen, shift, into, times })).toBe(true);
    await act(async () => {
      await wait(260);
    });
    await actFrame();
    expect(Math.abs(head().getBoundingClientRect().left - target())).toBeLessThan(25);

    // Stop (the transport's) hands playback back to the pads.
    act(() => session.stop());
    expect(rt().playing).toBe(false);
    expect(session.transport!.playing).toBe(false);
    expect(mode()).toContain('Stopped');
    expect(document.querySelector('[data-current]')).toBeNull();
  });

  it('deleting the block that plays: it sounds to the bar line while the next block says Next, then that block plays (real transport)', async () => {
    await setup();
    const ids = blockIds();
    click(byLabel('Play song from block 2', blockEl(ids[1])));
    await waitFor(() => rt().playing && rt().mode === 'song' && rt().songBlockId === ids[1] && !!session.transport?.playing, 'block 2 playing');
    // Delete it early in a bar, so the hand-over is still ahead.
    await waitFor(() => (session.transport!.getPosition().tick % 384) / 384 < 0.3 && (session.transport!.getPosition().tick % 384) / 384 > 0.02, 'early in a bar');
    const lane = document.querySelector<HTMLElement>('[data-testid="song-lane"]')!;
    act(() => blockEl(ids[1]).focus());
    key(blockEl(ids[1]), 'keydown', { key: 'Delete' });
    expect(blockIds()).not.toContain(ids[1]);
    await actFrame();
    await actFrame();
    const barEnd = Math.ceil(session.transport!.getPosition().tick / 384) * 384;
    expect(blockEl(ids[2]).dataset.next).toBeDefined();
    expect(blockEl(ids[2]).textContent).toContain('Next');
    expect(lane.querySelector('[data-current]')).toBeNull();
    expect(lane.textContent).not.toContain('Playing');
    expect(document.querySelector('[data-testid="playback-mode"]')!.textContent).toMatch(/Removed block ends at the bar · next: Lift \(block 2\)/);
    // The bar line passes: Lift plays.
    await waitFor(() => session.transport!.getPosition().tick > barEnd + 40, 'the bar line');
    await actFrame();
    await actFrame();
    expect(blockEl(ids[2]).dataset.current).toBeDefined();
    expect(blockEl(ids[2]).dataset.next).toBeUndefined();
    expect(blockEl(ids[2]).textContent).toContain('Playing');
    act(() => session.stop());
  });

  it('while a real take records, the lane shows it is locked and refuses edits quietly (no lifted block, no half-done drag, no long toast)', async () => {
    await setup();
    const ids = blockIds();
    const id = ids[0];
    const repeats = () => project().arrangement.blocks.find((b) => b.id === id)!.repeats;
    const before = repeats();
    await act(async () => {
      await session.togglePerformance();
    });
    expect(rt().recording).toBe('performance');
    expect(document.querySelector('[data-testid="playback-mode"]')!.textContent).toContain('recording a take');
    const lockLine = () => document.querySelector<HTMLElement>('[data-testid="lane-lock"]');
    expect(lockLine()!.textContent).toContain('The song is locked while a take records.');
    act(() => patchRuntime({ notice: null }));
    act(() => blockEl(id).focus());
    key(blockEl(id), 'keydown', { key: '+' });
    expect(repeats()).toBe(before);
    // Refused with the line on the lane (it nudges, the status says it), not the long lock toast.
    expect(rt().notice).toBeNull();
    expect(lockLine()!.querySelector('[data-pulse]')).not.toBeNull();
    expect(document.querySelector('[data-testid="lane-status"]')!.textContent).toBe('The song is locked while a take records.');
    // A drag is refused at once: nothing lifts, nothing moves.
    dragBlock(ids[0], 400, { release: false });
    expect(document.querySelector('[data-testid="lane-clone"]')).toBeNull();
    expect(rt().notice).toBeNull();
    pointer(document.body, 'pointerup', { clientX: 600, clientY: 300 });
    expect(blockIds()).toEqual(ids);
    await act(async () => {
      await session.togglePerformance();
    });
    expect(rt().recording).toBe('off');
    act(() => blockEl(id).focus());
    key(blockEl(id), 'keydown', { key: '+' });
    expect(repeats()).toBe(before + 1);
  });

  it('one Play per screen: the song header has no Play song, Stop or Export song (the transport plays and exports the song here)', async () => {
    await setup();
    const header = document.querySelector<HTMLElement>('section[aria-labelledby="song-title"] header')!;
    const names = [...header.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent!.trim());
    expect(names.some((n) => /^Play song/.test(n))).toBe(false);
    expect(names.some((n) => /^(Stop|Export song)$/.test(n))).toBe(false);
    // What stays: the length, the echo tail and Loop.
    expect(header.querySelector('[data-testid="song-length"]')).not.toBeNull();
    expect(header.querySelector('input[role="spinbutton"]')).not.toBeNull();
    expect(header.querySelector('[data-testid="loop-toggle"]')).not.toBeNull();
    // The ways to play are said where they are: ▶ on each block, the ruler, the mode box.
    expect(byLabel('Play song from block 2', blockEl(blockIds()[1])).closest('[data-block-id]')).not.toBeNull();
    expect(document.querySelector('[data-testid="song-ruler"]')!.getAttribute('aria-label')).toContain('Enter plays the song from it');
    expect(document.querySelector('[data-testid="playback-mode"]')!.textContent).toContain('Play (or Space) plays the song');
  });
});

/* ------------------------------------------------------------------ */
/* Performances                                                        */
/* ------------------------------------------------------------------ */

function addTake(events: PerformanceEvent[], opts: { name?: string; startTick?: number; endTick?: number } = {}): Id {
  const p = project();
  const startTick = opts.startTick ?? 768;
  const perf: Performance = {
    id: `perf-${Math.random().toString(36).slice(2, 8)}`,
    name: opts.name ?? 'Take 1',
    createdAt: Date.now(),
    startTick,
    endTick: opts.endTick ?? startTick + 4 * 384,
    snapshot: makeSnapshot(p, p.tracks.map((t) => ({ trackId: t.id, playing: null })), startTick),
    events,
  };
  const r = cmd.addPerformance(session.store, perf);
  expect(r.changed).toBe(true);
  return r.performanceId!;
}

const perfById = (id: Id) => project().performances.find((x) => x.id === id);

/** Open the Performances panel when it is folded to its one-line bar ("2 takes ▸"). */
function openTakes() {
  const open = document.querySelector<HTMLButtonElement>('[data-testid="takes-open"]');
  if (open) click(open);
}

function sampleEvents(start = 768): PerformanceEvent[] {
  return [
    { t: start + 10, type: 'launch', trackId: 't3', slot: 1, atTick: start + 384 },
    { t: start + 96, type: 'noteOn', trackId: 't5', pitch: 60, velocity: 0.8, key: 'KeyA' },
    { t: start + 192, type: 'macro', trackId: 't3', macro: 'tone', value: 0.62 },
    { t: start + 200, type: 'noteOff', trackId: 't5', pitch: 60, key: 'KeyA' },
    { t: start + 300, type: 'param', module: 't4:filter', param: 'cutoff', value: 1200 },
  ];
}

describe('Performances', () => {
  it('with no takes it is a one-line bar (the song gets the room); a click opens how to record one', async () => {
    await setup();
    const panel = document.querySelector<HTMLElement>('section[aria-labelledby="perf-title"]')!;
    expect(panel.hasAttribute('data-collapsed')).toBe(true);
    expect(panel.getBoundingClientRect().height).toBeLessThanOrEqual(52);
    expect(panel.textContent).toContain('No takes yet');
    const open = panel.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
    click(open);
    expect(panel.hasAttribute('data-collapsed')).toBe(false);
    expect(panel.textContent).toContain('captures clip launches, notes and knob moves, and replays them exactly');
    expect(panel.textContent).toContain('saved with the project');
    expect(panel.textContent).toContain('No performances yet');
    // Hide folds it back into one line.
    click(panel.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!);
    expect(panel.hasAttribute('data-collapsed')).toBe(true);
  });

  it('lists a take with its length and event counts, renames it inline, deletes it with undo', async () => {
    const id = addTake(sampleEvents(), { name: 'Take 1' });
    await setup();
    openTakes();
    const panel = document.querySelector<HTMLElement>('section[aria-labelledby="perf-title"]')!;
    expect(panel.textContent).toContain('Take 1');
    // 4 bars at the snapshot tempo.
    const secs = ticksToSeconds(4 * 384, project().bpm);
    expect(panel.textContent).toContain(`${secs.toFixed(1)} s`);
    expect(panel.textContent).toContain('1 launch · 1 note · 1 macro move · 1 knob move');

    click(byLabel('Take 1. Rename', panel));
    const input = panel.querySelector<HTMLInputElement>('input')!;
    expect(document.activeElement).toBe(input);
    typeInto(input, 'Big Finish');
    key(input, 'keydown', { key: 'Enter' });
    expect(perfById(id)!.name).toBe('Big Finish');
    expect(panel.querySelector('input')).toBeNull();

    // Escape cancels a rename.
    click(byLabel('Big Finish. Rename', panel));
    typeInto(panel.querySelector<HTMLInputElement>('input')!, 'Nope');
    key(panel.querySelector('input')!, 'keydown', { key: 'Escape' });
    expect(perfById(id)!.name).toBe('Big Finish');

    click(byLabel('Delete Big Finish', panel));
    expect(perfById(id)).toBeUndefined();
    expect(runtimeStore.getState().notice?.action).toBe('undo');
    // The last take gone: one line again.
    expect(panel.textContent).toContain('No takes yet');
    expect(panel.hasAttribute('data-collapsed')).toBe(true);
    act(() => session.undo());
    expect(perfById(id)?.name).toBe('Big Finish');
    expect(panel.textContent).toContain('Big Finish');
  });

  it('Replay plays the take on the real transport, the row shows it, and Stop ends it; Export targets the take', async () => {
    const id = addTake(sampleEvents());
    await setup();
    openTakes();
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('sb:open-export', on);
    click(byLabel('Export Take 1 as WAV'));
    window.removeEventListener('sb:open-export', on);
    expect(seen).toEqual([{ source: `perf:${id}` }]);

    const panel = document.querySelector<HTMLElement>('section[aria-labelledby="perf-title"]')!;
    click(byExactLabel('Replay Take 1'));
    await waitFor(() => rt().playing && rt().mode === 'replay' && rt().replayId === id && !!session.transport?.playing, 'replay');
    // The replay starts at the take's first tick and its row says so, with the elapsed time.
    expect(session.transport!.getPosition().tick).toBeGreaterThanOrEqual(768);
    expect(panel.textContent).toContain('Replaying');
    expect(panel.textContent).toMatch(/\d\.\d s \/ \d\.\d s/);
    expect(document.querySelector('[data-testid="playback-mode"]')!.textContent).toContain('Now playing:a recorded take');
    click(byExactLabel('Stop replaying Take 1'));
    expect(rt().playing).toBe(false);
    expect(rt().replayId).toBeNull();
    expect(byExactLabel('Replay Take 1')).toBeTruthy();
    expect(panel.textContent).not.toContain('Replaying');
  });

  it('refuses an empty take name and keeps the old one', async () => {
    const id = addTake(sampleEvents(), { name: 'Keeper' });
    await setup();
    openTakes();
    const panel = document.querySelector<HTMLElement>('section[aria-labelledby="perf-title"]')!;
    const name = byLabel('Keeper. Rename', panel);
    act(() => name.focus());
    key(name, 'keydown', { key: 'F2' });
    const input = panel.querySelector<HTMLInputElement>('input')!;
    typeInto(input, '   ');
    key(input, 'keydown', { key: 'Enter' });
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain('Type a name');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(perfById(id)!.name).toBe('Keeper');
    key(input, 'keydown', { key: 'Escape' });
    expect(panel.querySelector('input')).toBeNull();
    expect(perfById(id)!.name).toBe('Keeper');
  });

  it('describes what replay will do: arpeggiator input, a note cut by the next press, a launch queued past the end', () => {
    const p = project();
    const lead = p.tracks.find((t) => t.instrument.kind !== 'drums')!;
    const snapshotProject = { ...p, tracks: p.tracks.map((t) => (t.id === lead.id ? { ...t, arp: { ...t.arp, enabled: true } } : t)) };
    const start = 0;
    const perf: Performance = {
      id: 'perf-words',
      name: 'Words',
      createdAt: Date.now(),
      startTick: start,
      endTick: start + 2 * 384,
      snapshot: makeSnapshot(snapshotProject, p.tracks.map((t) => ({ trackId: t.id, playing: null })), start),
      events: [
        { t: 10, type: 'noteOn', trackId: lead.id, pitch: 64, velocity: 1, key: 'KeyD' },
        { t: 100, type: 'noteOff', trackId: lead.id, pitch: 64, key: 'KeyD' },
        { t: 200, type: 'noteOn', trackId: 't1', pitch: 0, velocity: 1, key: 'pad0' },
        { t: 296, type: 'noteOn', trackId: 't1', pitch: 0, velocity: 1, key: 'pad0' },
        { t: 380, type: 'noteOff', trackId: 't1', pitch: 0, key: 'pad0' },
        { t: 700, type: 'launch', trackId: 't3', slot: 1, atTick: 768 },
      ],
    };
    const rows = performanceRows(perf);
    expect(rows[0].detail).toContain('into the arpeggiator');
    // The first pad hit has no release of its own: replay ends it at the next press of that pad.
    expect(rows[1].detail).toContain('until the next press');
    expect(rows[1].pairIndex).toBeUndefined();
    expect(rows[2].pairIndex).toBe(4);
    expect(rows[3].detail).toContain('after the take ends');
  });

  it('shows the events in words and deletes them; a note goes as a pair; undo restores', async () => {
    const start = 768;
    const id = addTake(sampleEvents(start));
    await setup();
    openTakes();
    click(byLabel('Show the events of Take 1'));
    const table = document.querySelector<HTMLElement>('[role="table"]')!;
    const rows = () => [...table.querySelectorAll<HTMLElement>('[role="rowgroup"] [role="row"]')];
    // The noteOff is folded into its note: 4 rows for 5 events.
    expect(rows().length).toBe(4);
    const text = rows().map((r) => r.textContent);
    // Times are the music's bar.beat.step (where the transport was), not counted from the take's start.
    expect(text[0]).toContain(formatPosition(start + 10));
    expect(text[0]).toContain('Launch');
    expect(text[0]).toContain('→');
    expect(text[1]).toContain('Note');
    expect(text[1]).toContain('C4 note, 0.5 s');
    expect(text[2]).toContain('Tone 62%');
    expect(text[3]).toContain('Knob');
    expect(text[3]).toContain('Cutoff');

    // Delete the note: both its press and release go.
    click(byLabel('Delete note at', table));
    let ev = perfById(id)!.events;
    expect(ev.length).toBe(3);
    expect(ev.some((e) => e.type === 'noteOn' || e.type === 'noteOff')).toBe(false);
    expect(runtimeStore.getState().notice?.text).toContain('press and release');
    expect(rows().length).toBe(3);

    // Delete the macro move with the Delete key on its focused button.
    const macroBtn = byLabel('Delete macro at', table);
    act(() => macroBtn.focus());
    key(macroBtn, 'keydown', { key: 'Delete' });
    ev = perfById(id)!.events;
    expect(ev.map((e) => e.type)).toEqual(['launch', 'param']);

    act(() => session.undo());
    act(() => session.undo());
    expect(perfById(id)!.events.length).toBe(5);
    expect(rows().length).toBe(4);
  });

  it('changes a recorded macro or tempo value in place (typed in the units shown); undo restores it', async () => {
    const start = 768;
    const id = addTake([...sampleEvents(start), { t: start + 400, type: 'tempo', bpm: 124 }]);
    await setup();
    openTakes();
    click(byLabel('Show the events of Take 1'));
    const table = document.querySelector<HTMLElement>('[role="table"]')!;
    const valueButtons = () => [...table.querySelectorAll<HTMLButtonElement>('button[aria-label^="Change the value"]')];
    // Knob, macro and tempo changes carry a value; launches and notes do not.
    expect(valueButtons().map((b) => b.textContent)).toEqual(['Bass · Tone 62%', expect.stringContaining('Cutoff'), 'Tempo 124 BPM']);

    click(valueButtons()[0]);
    let input = table.querySelector<HTMLInputElement>('input')!;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('62%');
    typeInto(input, '40');
    key(input, 'keydown', { key: 'Enter' });
    expect(perfById(id)!.events[2]).toMatchObject({ t: start + 192, type: 'macro', value: 0.4 });
    expect(table.querySelector('input')).toBeNull();
    expect(valueButtons()[0].textContent).toBe('Bass · Tone 40%');
    expect(document.activeElement).toBe(valueButtons()[0]);
    expect(runtimeStore.getState().notice).toMatchObject({ action: 'undo' });
    expect(runtimeStore.getState().notice!.text).toContain('to 40%');

    // Text that is not a value keeps the field open with the range; units may be typed.
    click(valueButtons()[2]);
    input = table.querySelector<HTMLInputElement>('input')!;
    typeInto(input, 'faster');
    key(input, 'keydown', { key: 'Enter' });
    expect(table.querySelector('[role="alert"]')!.textContent).toBe('Type a value from 40 BPM to 220 BPM.');
    expect(perfById(id)!.events[5]).toMatchObject({ bpm: 124 });
    typeInto(input, '132 bpm');
    key(input, 'keydown', { key: 'Enter' });
    expect(perfById(id)!.events[5]).toMatchObject({ t: start + 400, type: 'tempo', bpm: 132 });
    // Escape leaves the value as it was.
    click(valueButtons()[2]);
    typeInto(table.querySelector<HTMLInputElement>('input')!, '90');
    key(table.querySelector('input')!, 'keydown', { key: 'Escape' });
    expect(perfById(id)!.events[5]).toMatchObject({ bpm: 132 });

    act(() => session.undo());
    act(() => session.undo());
    expect(perfById(id)!.events).toEqual([...sampleEvents(start), { t: start + 400, type: 'tempo', bpm: 124 }]);
  });

  it('a long recorded value stays in its column at a narrow width, and its focus ring is not cut off', async () => {
    act(() => void cmd.renameTrack(session.store, 't3', 'Deep rolling sub bass line under it all'));
    addTake(sampleEvents(768));
    await setup(560);
    openTakes();
    click(byLabel('Show the events of Take 1'));
    const table = document.querySelector<HTMLElement>('[role="table"]')!;
    const value = table.querySelector<HTMLButtonElement>('button[aria-label^="Change the value: Deep rolling"]')!;
    const cell = value.closest<HTMLElement>('[role="cell"]')!;
    const actions = value.closest<HTMLElement>('[role="row"]')!.querySelector<HTMLElement>('[data-evcol="end"]')!;
    // Truncated inside its own column: it never runs under the row's buttons.
    expect(value.scrollWidth).toBeGreaterThan(value.clientWidth);
    expect(value.getBoundingClientRect().right).toBeLessThanOrEqual(cell.getBoundingClientRect().right + 0.5);
    expect(value.getBoundingClientRect().right).toBeLessThan(actions.getBoundingClientRect().left);
    // The cell does not clip the focus ring drawn around the button.
    expect(getComputedStyle(cell).overflow).toBe('visible');
  });

  it('ends a take at a row or at a typed position: later actions go, the length shrinks, undo restores', async () => {
    const start = 768;
    const id = addTake(sampleEvents(start));
    const bpm = perfById(id)!.snapshot.bpm;
    await setup();
    openTakes();
    const panel = document.querySelector<HTMLElement>('section[aria-labelledby="perf-title"]')!;
    click(byLabel('Show the events of Take 1'));
    const table = () => document.querySelector<HTMLElement>('[role="table"]')!;
    const rows = () => [...table().querySelectorAll<HTMLElement>('[role="rowgroup"] [role="row"]')];
    // The take's bounds read in the music's bars (it was recorded from bar 3).
    expect(panel.textContent).toContain(`Starts at ${formatPosition(start)}`);
    expect(panel.textContent).toContain(`Ends at ${formatPosition(start + 4 * 384)}`);

    // End at the macro move (3.3.1): it and the knob move after it go; the launch and the note before it stay.
    click(byLabel(`End Take 1 at ${formatPosition(start + 192)}`, table()));
    expect(perfById(id)!.endTick).toBe(start + 192);
    expect(perfById(id)!.events.map((e) => e.type)).toEqual(['launch', 'noteOn']);
    expect(rows().length).toBe(2);
    expect(byLabel('Length', panel).textContent).toBe(`${ticksToSeconds(192, bpm).toFixed(1)} s`);
    expect(runtimeStore.getState().notice!.text).toBe(`Take 1 now ends at ${formatPosition(start + 192)}; 2 recorded actions from there on removed.`);
    expect(runtimeStore.getState().notice!.action).toBe('undo');
    act(() => session.undo());
    expect(perfById(id)!.endTick).toBe(start + 4 * 384);
    expect(perfById(id)!.events.length).toBe(5);
    expect(rows().length).toBe(4);

    // Typed end: a position past the end is refused with the allowed range; a valid one trims.
    click([...panel.querySelectorAll('button')].find((b) => b.textContent === 'End earlier…')!);
    const input = panel.querySelector<HTMLInputElement>('input[aria-label^="New end of Take 1"]')!;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(formatPosition(start + 4 * 384));
    typeInto(input, '9.1.1');
    key(input, 'keydown', { key: 'Enter' });
    expect(panel.querySelector('[role="alert"]')!.textContent).toBe(`Type a bar.beat.step after ${formatPosition(start)} and before ${formatPosition(start + 4 * 384)}.`);
    expect(perfById(id)!.endTick).toBe(start + 4 * 384);
    typeInto(input, '3.4');
    key(input, 'keydown', { key: 'Enter' });
    expect(perfById(id)!.endTick).toBe(start + 288);
    // The knob move (tick 300) is after the new end (tick 288); the note's release (tick 200) is kept.
    expect(perfById(id)!.events.map((e) => e.type)).toEqual(['launch', 'noteOn', 'macro', 'noteOff']);
    expect(panel.textContent).toContain('Ends at 3.4.1');
    expect(panel.querySelector('input')).toBeNull();

    // Ending at the first action leaves none: keyboard focus stays in the take, on its end control.
    click(byLabel(`End Take 1 at ${formatPosition(start + 10)}`, table()));
    expect(perfById(id)!.events).toEqual([]);
    expect(perfById(id)!.endTick).toBe(start + 10);
    expect(document.activeElement?.textContent).toBe('End earlier…');
  });

  it('reads typed positions as bar.beat.step', () => {
    expect(parsePosition('5')).toBe(4 * 384);
    expect(parsePosition('1.4')).toBe(288);
    expect(parsePosition(' 2.2.3 ')).toBe(384 + 96 + 48);
    expect(parsePosition('2.5')).toBeNull();
    expect(parsePosition('0.1.1')).toBeNull();
    expect(parsePosition('soon')).toBeNull();
    for (const t of [0, 96, 384 + 24, 7 * 384 + 3 * 96 + 72]) expect(parsePosition(formatPosition(t))).toBe(t);
  });

  it('caps long takes and shows more on request', async () => {
    const start = 0;
    const events: PerformanceEvent[] = [];
    for (let i = 0; i < 250; i++) events.push({ t: start + i * 6, type: 'macro', trackId: 't1', macro: 'space', value: (i % 100) / 100 });
    const id = addTake(events, { startTick: start, endTick: start + 8 * 384 });
    await setup();
    openTakes();
    click(byLabel('Show the events of Take 1'));
    const rows = () => document.querySelectorAll('[role="table"] [role="rowgroup"] [role="row"]').length;
    expect(rows()).toBe(EVENT_PAGE);
    expect(document.body.textContent).toContain(`Showing ${EVENT_PAGE} of 250 events`);
    click([...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Show') && b.textContent!.includes('more'))!);
    expect(rows()).toBe(EVENT_PAGE + EVENT_MORE);
    expect(performanceRows(perfById(id)!).length).toBe(250);
  });
});
