/**
 * Arrange view in real Chromium: the song lane (keyboard and pointer
 * reordering, repeats, adding from the palette by click and by drag,
 * removing with undo, changing a block's scene, the length readout, the
 * playback-mode label and the empty state) and recorded performances
 * (rename, delete with undo, the event list and deleting events, notes as a
 * press/release pair, "Show more"). Everything is checked on the project in
 * session.store — the same data playback and export use.
 */
import '../../src/ui/theme.css';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { formatSeconds } from '../../src/app/session';
import { ArrangeView } from '../../src/app/views/arrange/ArrangeView';
import { EVENT_MORE, EVENT_PAGE } from '../../src/app/views/arrange/PerformancesPanel';
import { formatPosition, performanceRows } from '../../src/app/views/arrange/perfEvents';
import { BLOCK_GAP, MIN_BLOCK_WIDTH, SCROLL_MAX_PX_PER_BAR, gapAt, layoutSong, moveTarget, rulerMarks } from '../../src/app/views/arrange/songLayout';
import { getStarter } from '../../src/content/starters';
import type { Id, Performance, PerformanceEvent } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { setView, uiStore, slotFor } from '../../src/state/uiStore';
import { clampBpm, ticksToSeconds } from '../../src/time/clock';
import { songLengthTicks } from '../../src/time/sequencer';
import { makeSnapshot } from '../../src/time/snapshot';
import { actFrame, cleanup, fire, key, mount, pointer, wait } from './ui-harness';

beforeEach(() => {
  session.store.replace(getStarter('house')!.build(), { resetHistory: true });
  act(() => {
    patchRuntime({ held: {}, notice: null, recording: 'off', playing: false, mode: 'live', songBlock: null, replayId: null });
    setView('arrange');
  });
});

afterEach(() => {
  // Tests that play for real leave nothing running for the next one.
  if (session.playing) act(() => session.stop());
  cleanup();
  act(() => patchRuntime({ playing: false, mode: 'live', songBlock: null, replayId: null }));
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
  // …and let the short position/width transitions finish before measuring rectangles.
  await act(async () => {
    await wait(260);
  });
  return m;
}

const project = () => session.store.getState();
const blockIds = () => project().arrangement.blocks.map((b) => b.id);
const sceneIdByName = (name: string) => project().scenes.find((s) => s.name === name)!.id;
const blockEl = (id: Id) => document.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
const lengthText = () => document.querySelector('[data-testid="song-length"]')!.textContent!.replace(/\s+/g, ' ').trim();

function click(el: Element) {
  fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

function byLabel<T extends HTMLElement = HTMLButtonElement>(start: string, root: ParentNode = document): T {
  const el = [...root.querySelectorAll<T>('[aria-label]')].find((x) => x.getAttribute('aria-label')!.startsWith(start));
  if (!el) throw new Error(`No element labelled "${start}…"`);
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

/** Drag from an element to a point with real pointer events (down, past the threshold, over the target, up). */
function drag(from: HTMLElement, to: { x: number; y: number }, opts: { release?: boolean } = {}) {
  const r = from.getBoundingClientRect();
  const start = { clientX: r.left + 18, clientY: r.top + r.height / 2 };
  pointer(from, 'pointerdown', start);
  pointer(document.body, 'pointermove', { clientX: start.clientX + 8, clientY: start.clientY + 2 });
  pointer(document.body, 'pointermove', { clientX: to.x, clientY: to.y });
  if (opts.release !== false) pointer(document.body, 'pointerup', { clientX: to.x, clientY: to.y });
}

describe('Song lane geometry', () => {
  it('fits the lane, keeps widths proportional and never narrower than the minimum', () => {
    const l = layoutSong(
      [
        { id: 'a', bars: 4, repeats: 2 },
        { id: 'b', bars: 4, repeats: 4 },
        { id: 'c', bars: 1, repeats: 1 },
      ],
      1000,
    );
    expect(l.totalBars).toBe(25);
    expect(l.contentWidth).toBeLessThanOrEqual(1000);
    expect(l.blocks[2].width).toBe(MIN_BLOCK_WIDTH);
    expect(l.blocks[1].width / l.blocks[0].width).toBeCloseTo(2, 1);
    expect(l.blocks[1].x).toBe(l.blocks[0].width + BLOCK_GAP);
    // Every block start is numbered on the ruler, with its song bar.
    const starts = rulerMarks(l).filter((m) => m.blockStart);
    expect(starts.map((m) => m.bar)).toEqual([0, 8, 24]);
    expect(starts.every((m) => m.label)).toBe(true);
  });

  it('a song longer than the lane scrolls and keeps every block in true proportion', () => {
    // 14 blocks, 140 bars: at the minimum width they cannot all fit in 1290 px.
    const bars = [16, 16, 12, 8, 16, 8, 8, 8, 8, 8, 8, 8, 8, 8];
    const l = layoutSong(
      bars.map((b, i) => ({ id: String(i), bars: b, repeats: 1 })),
      1290,
    );
    expect(l.contentWidth).toBeGreaterThan(1290);
    expect(l.pxPerBar).toBeLessThanOrEqual(SCROLL_MAX_PX_PER_BAR);
    // The shortest block gets exactly the minimum width; the others follow its scale.
    expect(Math.min(...l.blocks.map((b) => b.width))).toBe(MIN_BLOCK_WIDTH);
    for (const b of l.blocks) expect(b.width).toBe(Math.floor(b.totalBars * l.pxPerBar));
    expect(l.blocks[0].width / l.blocks[3].width).toBeCloseTo(2, 2);
    // The ruler stays readable: numbers are not crowded to every bar.
    const labelled = rulerMarks(l).filter((m) => m.label && !m.blockStart);
    expect(labelled.every((m) => m.bar % 4 === 0)).toBe(true);
  });

  it('maps a drop position to an insertion gap and a move destination', () => {
    const l = layoutSong(
      [
        { id: 'a', bars: 4, repeats: 2 },
        { id: 'b', bars: 4, repeats: 2 },
        { id: 'c', bars: 4, repeats: 2 },
      ],
      900,
    );
    expect(gapAt(l, 1)).toBe(0);
    expect(gapAt(l, l.blocks[1].x + 5)).toBe(1);
    expect(gapAt(l, l.contentWidth + 20)).toBe(3);
    expect(moveTarget(0, 3)).toBe(2);
    expect(moveTarget(2, 0)).toBe(0);
    expect(moveTarget(1, 1)).toBeNull();
    expect(moveTarget(1, 2)).toBeNull();
  });
});

describe('Song lane', () => {
  it('shows every block with its scene name, length and repeats, and the song length', async () => {
    // Wide enough that no block needs the minimum width: widths are then exactly proportional.
    await setup(1560);
    const p = project();
    const items = [...document.querySelectorAll<HTMLElement>('[data-block-id]')];
    expect(items.map((e) => e.dataset.blockId)).toEqual(blockIds());
    const first = p.arrangement.blocks[0];
    const scene = p.scenes.find((s) => s.id === first.sceneId)!;
    expect(items[0].getAttribute('aria-label')).toContain(scene.name);
    expect(items[0].textContent).toContain(`×${first.repeats}`);
    expect(lengthText()).toBe(expectedLength());
    // Widths follow the length: a 16-bar block is twice as wide as an 8-bar one.
    const w = (i: number) => parseFloat(items[i].style.width);
    expect(w(0)).toBeGreaterThan(MIN_BLOCK_WIDTH);
    expect(w(1) / w(0)).toBeCloseTo(2, 1);
    expect(items[1].getBoundingClientRect().width / items[0].getBoundingClientRect().width).toBeCloseTo(2, 1);
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

  it('reorders by pointer drag with an insertion marker', async () => {
    await setup();
    const before = blockIds();
    const target = blockEl(before[1]).getBoundingClientRect();
    drag(blockEl(before[3]), { x: target.left + 10, y: target.top + target.height / 2 }, { release: false });
    const marker = document.querySelector<HTMLElement>('[data-testid="insert-marker"]');
    expect(marker).not.toBeNull();
    // The marker sits in the gap before block 2.
    const mx = marker!.getBoundingClientRect().left + marker!.getBoundingClientRect().width / 2;
    expect(Math.abs(mx - (target.left - 3))).toBeLessThan(6);
    expect(blockIds()).toEqual(before);
    pointer(document.body, 'pointerup', { clientX: target.left + 10, clientY: target.top + target.height / 2 });
    expect(blockIds()).toEqual([before[0], before[3], before[1], before[2], before[4], before[5]]);
    expect(document.querySelector('[data-testid="insert-marker"]')).toBeNull();
  });

  it('a drag released away from the lane or cancelled with Escape changes nothing', async () => {
    await setup();
    const before = blockIds();
    drag(blockEl(before[0]), { x: 600, y: 660 });
    expect(blockIds()).toEqual(before);
    const target = blockEl(before[4]).getBoundingClientRect();
    drag(blockEl(before[0]), { x: target.right - 5, y: target.top + 20 }, { release: false });
    key(window, 'keydown', { key: 'Escape' });
    pointer(document.body, 'pointerup', { clientX: target.right - 5, clientY: target.top + 20 });
    expect(blockIds()).toEqual(before);
  });

  it('changes repeats with the stepper and the +/- keys; the length updates', async () => {
    await setup();
    const id = blockIds()[0];
    const repeats = () => project().arrangement.blocks.find((b) => b.id === id)!.repeats;
    const start = repeats();
    const lenBefore = lengthText();
    click(byLabel('More repeats of', blockEl(id)));
    expect(repeats()).toBe(start + 1);
    expect(lengthText()).toBe(expectedLength());
    expect(lengthText()).not.toBe(lenBefore);
    const el = blockEl(id);
    act(() => el.focus());
    key(el, 'keydown', { key: '-' });
    key(el, 'keydown', { key: '-' });
    expect(repeats()).toBe(start - 1);
    // Bounded 1..8: extra presses at the limit do nothing.
    for (let i = 0; i < 10; i++) click(byLabel('Fewer repeats of', blockEl(id)));
    expect(repeats()).toBe(1);
    expect(byLabel('Fewer repeats of', blockEl(id)).getAttribute('aria-disabled')).toBe('true');
    for (let i = 0; i < 10; i++) click(byLabel('More repeats of', blockEl(id)));
    expect(repeats()).toBe(8);
    expect(lengthText()).toBe(expectedLength());
  });

  it('adds scenes from the palette (+ appends, drag inserts) and removes blocks with undo', async () => {
    await setup();
    const n = blockIds().length;
    click(byLabel('Add Break to the end of the song'));
    const after = project().arrangement.blocks;
    expect(after.length).toBe(n + 1);
    expect(after[n].sceneId).toBe(sceneIdByName('Break'));
    expect(lengthText()).toBe(expectedLength());

    // Drag the Groove card to the very start of the lane.
    const first = blockEl(blockIds()[0]).getBoundingClientRect();
    const card = byLabel<HTMLElement>('Scene Groove');
    drag(card, { x: first.left + 6, y: first.top + first.height / 2 });
    expect(project().arrangement.blocks.length).toBe(n + 2);
    expect(project().arrangement.blocks[0].sceneId).toBe(sceneIdByName('Groove'));

    // Remove with the trash key (focus moves to the next block), then Undo brings it back.
    const removeId = blockIds()[2];
    const following = blockIds()[3];
    click(byLabel('Remove block 3', blockEl(removeId)));
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
    click(byLabel('Intro: block options', blockEl(id)));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    const breakItem = [...menu.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find((x) => x.textContent!.startsWith('Break'))!;
    click(breakItem);
    expect(project().arrangement.blocks[0].sceneId).toBe(sceneIdByName('Break'));
    expect(document.querySelector('[role="menu"]')).toBeNull();

    // Edit clips switches to Play (Loops) with that scene row's clips selected.
    click(byLabel('Break: block options', blockEl(id)));
    const edit = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((x) => x.textContent!.includes('Edit clips'))!;
    click(edit);
    const ui = uiStore.getState();
    expect(ui.view).toBe('play');
    expect(ui.padMode).toBe('loops');
    const row = project().scenes.findIndex((s) => s.name === 'Break');
    for (const t of project().tracks) if (t.clips[row]) expect(slotFor(ui, t.id)).toBe(row);
    const withClip = project().tracks.find((t) => t.clips[row])!;
    expect(ui.selectedTrackId).toBe(withClip.id);
  });

  it('changes the export tail with the field', async () => {
    await setup();
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
    expect(byLabel('Play song').hasAttribute('disabled')).toBe(true);
    const addAll = [...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Add all'))!;
    act(() => addAll.focus());
    click(addAll);
    expect(project().arrangement.blocks.map((b) => b.sceneId)).toEqual(project().scenes.map((s) => s.id));
    expect(lengthText()).toBe(expectedLength());
    // The button went away with the empty state: keyboard focus lands on the first new block.
    expect(document.activeElement).toBe(blockEl(blockIds()[0]));
  });

  it('says whether playback follows the arrangement or the pads, and marks the current block', async () => {
    await setup();
    const mode = () => document.querySelector('[data-testid="playback-mode"]')!.textContent!;
    expect(mode()).toContain('Live pads');
    expect(mode()).toContain('Stopped');
    // While a take records, the song and takes are locked (the take lock refuses their edits): say so.
    act(() => patchRuntime({ playing: true, mode: 'live', recording: 'performance' }));
    expect(mode()).toContain('recording a take');
    expect(mode()).toContain('cannot be edited until you stop recording');
    act(() => patchRuntime({ playing: false, recording: 'off' }));
    act(() => patchRuntime({ playing: true, mode: 'song', songBlock: 2 }));
    expect(mode()).toContain('Arrangement');
    expect(mode()).toContain('Block 3 of 6');
    expect(mode()).toContain('a tapped clip joins at the next bar');
    const current = blockEl(blockIds()[2]);
    expect(current.dataset.current).toBeDefined();
    expect(current.textContent).toContain('Playing');
    // Moving the playing block keeps it marked (the plan follows block ids).
    act(() => current.focus());
    key(current, 'keydown', { key: 'ArrowLeft', altKey: true });
    expect(blockEl(blockIds()[1]).dataset.current).toBeDefined();
    expect(document.body.textContent).toContain('You changed the song while it plays');
    act(() => patchRuntime({ playing: false, mode: 'live', songBlock: null }));
    expect(mode()).toContain('Live pads');
    expect(document.querySelector('[data-current]')).toBeNull();
  });

  it('Play song, a block play icon and Stop drive the real transport; the playhead and current block follow it', async () => {
    await setup();
    const ids = blockIds();
    const mode = () => document.querySelector('[data-testid="playback-mode"]')!.textContent!;
    const head = () => document.querySelector<HTMLElement>('[data-testid="playhead"]')!;

    click(byExactLabel('Play song'));
    await waitFor(() => rt().playing && rt().mode === 'song' && !!session.transport?.playing, 'song playback');
    expect(rt().songBlock).toBe(0);
    expect(mode()).toContain('Arrangement');
    expect(byExactLabel('Play song from the start (playing now)').getAttribute('aria-pressed')).toBe('true');

    // Start from block 3: the transport jumps to its first bar (after Intro 8 + Groove 16 bars).
    click(byLabel('Play song from block 3', blockEl(ids[2])));
    await waitFor(() => rt().songBlock === 2 && (session.transport?.getPosition().tick ?? 0) >= 24 * 384, 'block 3');
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

    // Stop hands playback back to the pads.
    click([...document.querySelectorAll('section[aria-labelledby="song-title"] button')].find((b) => b.textContent === 'Stop')!);
    expect(rt().playing).toBe(false);
    expect(session.transport!.playing).toBe(false);
    expect(mode()).toContain('Live pads');
    expect(document.querySelector('[data-current]')).toBeNull();
  });

  it('while a real take records, song edits are refused as the mode box says', async () => {
    await setup();
    const id = blockIds()[0];
    const repeats = () => project().arrangement.blocks.find((b) => b.id === id)!.repeats;
    const before = repeats();
    await act(async () => {
      await session.togglePerformance();
    });
    expect(rt().recording).toBe('performance');
    expect(document.querySelector('[data-testid="playback-mode"]')!.textContent).toContain('recording a take');
    click(byLabel('More repeats of', blockEl(id)));
    expect(repeats()).toBe(before);
    expect(rt().notice?.tone).toBe('warn');
    await act(async () => {
      await session.togglePerformance();
    });
    expect(rt().recording).toBe('off');
    click(byLabel('More repeats of', blockEl(id)));
    expect(repeats()).toBe(before + 1);
  });

  it('Export song opens the export dialog preset to the song', async () => {
    await setup();
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('sb:open-export', on);
    click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Export song')!);
    window.removeEventListener('sb:open-export', on);
    expect(seen).toEqual([{ source: 'song' }]);
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
  it('explains recordings and guides an empty list', async () => {
    await setup();
    expect(document.body.textContent).toContain('captures clip launches, notes and knob moves, and replays them exactly');
    expect(document.body.textContent).toContain('saved with the project');
    expect(document.body.textContent).toContain('No performances yet');
  });

  it('lists a take with its length and event counts, renames it inline, deletes it with undo', async () => {
    const id = addTake(sampleEvents(), { name: 'Take 1' });
    await setup();
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
    expect(panel.textContent).toContain('No performances yet');
    act(() => session.undo());
    expect(perfById(id)?.name).toBe('Big Finish');
    expect(panel.textContent).toContain('Big Finish');
  });

  it('Replay plays the take on the real transport, the row shows it, and Stop ends it; Export targets the take', async () => {
    const id = addTake(sampleEvents());
    await setup();
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
    expect(document.querySelector('[data-testid="playback-mode"]')!.textContent).toContain('Performance');
    click(byExactLabel('Stop replaying Take 1'));
    expect(rt().playing).toBe(false);
    expect(rt().replayId).toBeNull();
    expect(byExactLabel('Replay Take 1')).toBeTruthy();
    expect(panel.textContent).not.toContain('Replaying');
  });

  it('refuses an empty take name and keeps the old one', async () => {
    const id = addTake(sampleEvents(), { name: 'Keeper' });
    await setup();
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
    click(byLabel('Show the events of Take 1'));
    const table = document.querySelector<HTMLElement>('[role="table"]')!;
    const rows = () => [...table.querySelectorAll<HTMLElement>('[role="rowgroup"] [role="row"]')];
    // The noteOff is folded into its note: 4 rows for 5 events.
    expect(rows().length).toBe(4);
    const text = rows().map((r) => r.textContent);
    expect(text[0]).toContain(formatPosition(10));
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

  it('caps long takes and shows more on request', async () => {
    const start = 0;
    const events: PerformanceEvent[] = [];
    for (let i = 0; i < 250; i++) events.push({ t: start + i * 6, type: 'macro', trackId: 't1', macro: 'space', value: (i % 100) / 100 });
    const id = addTake(events, { startTick: start, endTick: start + 8 * 384 });
    await setup();
    click(byLabel('Show the events of Take 1'));
    const rows = () => document.querySelectorAll('[role="table"] [role="rowgroup"] [role="row"]').length;
    expect(rows()).toBe(EVENT_PAGE);
    expect(document.body.textContent).toContain(`Showing ${EVENT_PAGE} of 250 events`);
    click([...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('Show') && b.textContent!.includes('more'))!);
    expect(rows()).toBe(EVENT_PAGE + EVENT_MORE);
    expect(performanceRows(perfById(id)!).length).toBe(250);
  });
});
