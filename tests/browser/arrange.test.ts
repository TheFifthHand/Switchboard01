/**
 * The Song view's recorded performances in real Chromium: a one-line bar with
 * no takes, rename, delete with undo, replay and export, the event list and
 * deleting events, notes as a press/release pair, "Show more", and putting a
 * take's launches into the song. Everything is checked on the project in
 * session.store, the same data playback and export use. The song timeline
 * itself is tested in the r5-song-*.test.ts files.
 */
import '../../src/ui/theme.css';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { ArrangeView } from '../../src/app/views/arrange/ArrangeView';
import { EVENT_MORE, EVENT_PAGE } from '../../src/app/views/arrange/PerformancesPanel';
import { formatPosition, parsePosition, performanceRows } from '../../src/app/views/arrange/perfEvents';
import { getStarter } from '../../src/content/starters';
import type { Id, Performance, PerformanceEvent } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { setView } from '../../src/state/uiStore';
import { ticksToSeconds } from '../../src/time/clock';
import { makeSnapshot } from '../../src/time/snapshot';
import { songBars } from '../../src/project/arrangement';
import { actFrame, cleanup, fire, key, mount, wait } from './ui-harness';

beforeEach(() => {
  // The lane's remembered settings (Follow, the Performances panel open or folded) start fresh.
  localStorage.removeItem('switchboard01.songLane');
  session.store.replace(getStarter('house')!.build(), { resetHistory: true });
  act(() => {
    patchRuntime({ held: {}, notice: null, recording: 'off', playing: false, paused: false, mode: 'live', replayId: null });
    setView('arrange');
  });
});

afterEach(() => {
  // Tests that play for real leave nothing running for the next one.
  if (session.playing) act(() => session.stop());
  cleanup();
  act(() => patchRuntime({ playing: false, paused: false, mode: 'live', replayId: null }));
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

const project = () => session.store.getState();

function click(el: Element, init: MouseEventInit = {}) {
  fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
}

function byLabel<T extends HTMLElement = HTMLButtonElement>(start: string, root: ParentNode = document): T {
  const el = [...root.querySelectorAll<T>('[aria-label]')].find((x) => x.getAttribute('aria-label')!.startsWith(start));
  if (!el) throw new Error(`No element labelled "${start}…"`);
  return el;
}

function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

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

  it('Put in the song: what the take launched becomes loops after the song’s end, one undo step', async () => {
    addTake(sampleEvents(), { name: 'Take 1' });
    await setup();
    openTakes();
    const before = project().arrangement.regions.length;
    const end = songBars(project());
    const undo = session.store.historySize().undo;
    click(byLabel('Put Take 1 in the song'));
    const added = project().arrangement.regions.filter((r) => r.start >= end);
    expect(added.length).toBeGreaterThan(0);
    expect(project().arrangement.regions.length).toBe(before + added.length);
    expect(session.store.historySize().undo).toBe(undo + 1);
    act(() => session.undo());
    expect(project().arrangement.regions.length).toBe(before);
  });
});
