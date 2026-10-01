/**
 * The Loops grid in real Chromium with the app's styles: labelled Mute and
 * Solo toggles (and M / S) that change the project, dimmed columns that say
 * Muted / Not soloed, a play/stop key per part, quiet empty pads; moving and
 * copying clips by drag (6 px threshold, Ctrl/Alt copies, Esc cancels,
 * refused across drum and melodic parts with an explanation) and by keyboard
 * (Move…, arrows, Enter); scene rows reordered by drag and Alt+arrows; the
 * selected pad's action bar and its right-click menu. Every move or copy is
 * one undo step.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { Session, type BootInfo } from '../../src/app/session';
import { LoopsGrid } from '../../src/app/views/LoopsGrid';
import { getStarter } from '../../src/content/starters';
import type { Clip, Id } from '../../src/project/types';
import { addBlock } from '../../src/state/commands';
import { selectSlot, selectTrack, setGuideDone, setPadMode, setUiMode, setView, uiStore } from '../../src/state/uiStore';
import { cleanup, fire, key, mount, pointer, pointIn, wait } from './ui-harness';

const real = { pressClip: session.pressClip, launchScene: session.launchScene };
let presses: string[] = [];

beforeEach(async () => {
  // Pointer targets are found by position: the whole grid must be on screen.
  await page.viewport(1366, 900);
  presses = [];
  session.pressClip = async (trackId, slot) => void presses.push(`clip ${trackId} ${slot}`);
  session.launchScene = async (row) => void presses.push(`scene ${row}`);
  session.store.replace(getStarter('house')!.build(), { resetHistory: true });
  act(() => {
    patchRuntime({ held: {}, notice: null, recording: 'off', recordTarget: null, playing: false, paused: false });
    // Other test files share this browser's remembered UI state: start from the Play view's Loops pads.
    setView('play');
    setPadMode('loops');
    setUiMode('simple');
    selectTrack('t3');
    selectSlot('t3', 0);
  });
});

afterEach(() => {
  cleanup();
  session.pressClip = real.pressClip;
  session.launchScene = real.launchScene;
});

async function fonts() {
  await Promise.all(['400 13px "Inter Variable"', '600 13px "Inter Variable"', '650 15px "Inter Variable"'].map((f) => document.fonts.load(f)));
}

function grid() {
  return mount(h('div', { style: { width: '1000px', height: '620px', display: 'flex', flexDirection: 'column' } }, h(LoopsGrid)), { width: 1040 });
}

const project = () => session.store.getState();
const clips = (trackId: Id): (Clip | null)[] => project().tracks.find((t) => t.id === trackId)!.clips;
const names = (trackId: Id) => clips(trackId).map((c) => c?.name ?? null);
const pad = (trackId: Id, slot: number) => document.getElementById(`pad-${trackId}-${slot}`) as HTMLButtonElement;
const cell = (trackId: Id, slot: number) => pad(trackId, slot).closest<HTMLElement>('[data-pad-cell]')!;
const button = (name: string | RegExp, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => {
    const n = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    return typeof name === 'string' ? n === name : name.test(n);
  }) ?? null;
const notice = () => runtimeStore.getState().notice?.text ?? '';
function click(el: Element) {
  fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

/** A real-looking drag: down on `from`, moves in steps to `to`, up there (modifiers on the last move and the release). */
async function drag(from: Element, to: Element, opts: { ctrl?: boolean; release?: boolean } = {}) {
  const a = pointIn(from);
  const b = pointIn(to);
  pointer(from, 'pointerdown', a);
  for (let i = 1; i <= 6; i++) {
    const x = a.clientX + ((b.clientX - a.clientX) * i) / 6;
    const y = a.clientY + ((b.clientY - a.clientY) * i) / 6;
    pointer(from, 'pointermove', { clientX: x, clientY: y, ctrlKey: !!opts.ctrl && i === 6 });
  }
  await act(async () => {
    await wait(0);
  });
  if (opts.release !== false) pointer(from, 'pointerup', { ...b, ctrlKey: !!opts.ctrl });
}

/** House starter: t1 Drums, t2 Percussion (kits); t3 Bass, t4 Chords ... (melodic). */
function emptyAndFull(trackId: Id) {
  const c = clips(trackId);
  return { full: c.findIndex((x) => x !== null), empty: c.findIndex((x) => x === null) };
}

describe('Column headers', () => {
  it('Mute and Solo are labelled toggles of at least 32 px that change the part; a muted or non-soloed column dims and says so', async () => {
    await fonts();
    grid();
    const mute = button('Mute Bass')!;
    const solo = button('Solo Bass')!;
    expect(mute.textContent).toBe('Mute');
    expect(solo.textContent).toBe('Solo');
    for (const b of [mute, solo]) {
      const r = b.getBoundingClientRect();
      expect(r.width).toBeGreaterThanOrEqual(32);
      expect(r.height).toBeGreaterThanOrEqual(32);
      expect(b.querySelector('svg')).not.toBeNull();
    }
    click(mute);
    expect(project().tracks[2].mute).toBe(true);
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    const header = mute.closest<HTMLElement>('[data-dim]')!;
    expect(header.textContent).toContain('Muted');
    expect(cell('t3', 0).hasAttribute('data-dim')).toBe(true);
    await act(async () => {
      await wait(250);
    });
    expect(Number(getComputedStyle(cell('t3', 0)).opacity)).toBeLessThan(0.7);
    click(mute);
    expect(project().tracks[2].mute).toBe(false);

    click(button('Solo Chords')!);
    expect(project().tracks[3].solo).toBe(true);
    expect(button('Solo Chords')!.closest('[class]')!.parentElement!.textContent).toContain('Solo');
    expect(button(/^Select Bass/)!.getAttribute('aria-label')).toContain('Not soloed');
    expect(cell('t3', 0).hasAttribute('data-dim')).toBe(true);
    expect(cell('t4', 0).hasAttribute('data-dim')).toBe(false);
    act(() => session.undo());
    expect(project().tracks[3].solo).toBe(false);
  });

  it('the part key starts the selected clip, or says the part has none', async () => {
    grid();
    act(() => selectSlot('t4', 2));
    const play = button(/^Play Chords: /)!;
    expect(play.getBoundingClientRect().height).toBeGreaterThanOrEqual(32);
    click(play);
    expect(presses).toEqual(['clip t4 2']);
    // A part with no clips at all.
    const empty = project().tracks.findIndex((t) => t.clips.every((c) => !c));
    if (empty >= 0) {
      const name = project().tracks[empty].name;
      expect(button(`${name} has no clips`)!.disabled).toBe(true);
    }
  });

  it('M mutes the selected part anywhere outside text fields; S always plays its note and never solos', async () => {
    const boot: BootInfo = { lastProject: null, warnings: [], storageError: null };
    act(() => setGuideDone(true));
    const m = mount(h(App, { boot }));
    m.container.style.width = '';
    m.container.style.padding = '0';
    const look = button('Just look around');
    if (look) click(look);
    act(() => selectTrack('t3'));
    key(document.body, 'keydown', { key: 'm', code: 'KeyM' });
    expect(project().tracks[2].mute).toBe(true);
    key(document.body, 'keydown', { key: 'm', code: 'KeyM' });
    expect(project().tracks[2].mute).toBe(false);
    // M also works with a pad focused; S is a note key everywhere, so it never solos.
    act(() => pad('t3', 0).focus());
    key(pad('t3', 0), 'keydown', { key: 'm', code: 'KeyM' });
    expect(project().tracks[2].mute).toBe(true);
    key(pad('t3', 0), 'keydown', { key: 'm', code: 'KeyM' });
    expect(project().tracks[2].mute).toBe(false);
    key(document.body, 'keydown', { key: 's', code: 'KeyS' });
    key(document.body, 'keyup', { key: 's', code: 'KeyS' });
    key(pad('t3', 0), 'keydown', { key: 's', code: 'KeyS' });
    key(pad('t3', 0), 'keyup', { key: 's', code: 'KeyS' });
    expect(project().tracks[2].solo).toBe(false);
    // Not while typing.
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => input.focus());
    key(input, 'keydown', { key: 'm', code: 'KeyM' });
    expect(project().tracks[2].mute).toBe(false);
    input.remove();
  });
});

describe('Pads', () => {
  it('empty pads are quiet: a "+" and "Add clip" only on hover or focus; clip pads show the name large and the length small', async () => {
    await fonts();
    grid();
    const { empty, full } = emptyAndFull('t3');
    const e = pad('t3', empty);
    expect(e.textContent).not.toContain('Empty');
    expect(e.getAttribute('aria-label')).toContain('Add clip');
    const label = [...e.querySelectorAll<HTMLElement>('span')].filter((s) => s.textContent === 'Add clip').at(-1)!;
    expect(getComputedStyle(label).opacity).toBe('0');
    const f = pad('t3', full);
    const leaves = [...f.querySelectorAll<HTMLElement>('span')].filter((s) => s.children.length === 0);
    const name = leaves.find((s) => s.textContent === clips('t3')[full]!.name)!;
    const length = leaves.find((s) => /^\d bars?$/.test(s.textContent ?? ''))!;
    expect(parseFloat(getComputedStyle(name).fontSize)).toBeGreaterThan(parseFloat(getComputedStyle(length).fontSize));
  });

  it('tapping an empty pad ("+") offers a new clip right there', async () => {
    grid();
    const { empty } = emptyAndFull('t3');
    const p = pad('t3', empty);
    pointer(p, 'pointerdown', pointIn(p));
    pointer(p, 'pointerup', pointIn(p));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.textContent).toContain('Empty slot');
    click([...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((b) => b.getAttribute('aria-label') === 'New clip, 2 bars')!);
    expect(clips('t3')[empty]).toMatchObject({ bars: 2 });
    expect(presses).toEqual([]);
    expect(uiStore.getState().selectedSlot.t3).toBe(empty);
  });

  it('a tap (less than 6 px of movement) launches the clip; a drag never does', async () => {
    grid();
    const { full } = emptyAndFull('t3');
    const p = pad('t3', full);
    const at = pointIn(p);
    pointer(p, 'pointerdown', at);
    pointer(p, 'pointermove', { clientX: at.clientX + 3, clientY: at.clientY + 2 });
    pointer(p, 'pointerup', { clientX: at.clientX + 3, clientY: at.clientY + 2 });
    expect(presses).toEqual([`clip t3 ${full}`]);
    presses = [];
    await drag(p, pad('t3', emptyAndFull('t3').empty), { release: false });
    pointer(p, 'pointerup', pointIn(p));
    expect(presses).toEqual([]);
  });
});

describe('Drag and drop', () => {
  it('drops a clip on an empty pad to move it (one undo step, with a notice); valid pads light up while dragging', async () => {
    grid();
    const { full, empty } = emptyAndFull('t3');
    const before = names('t3');
    const name = before[full]!;
    const id = clips('t3')[full]!.id;
    await drag(pad('t3', full), pad('t3', empty), { release: false });
    expect(cell('t3', full).dataset.drop).toBe('source');
    expect(cell('t3', empty).dataset.drop).toBe('ok');
    expect(cell('t3', empty).hasAttribute('data-over')).toBe(true);
    // Drum parts cannot take a melodic clip.
    expect(cell('t1', 0).dataset.drop).toBe('no');
    pointer(pad('t3', full), 'pointerup', pointIn(pad('t3', empty)));
    expect(clips('t3')[empty]!.id).toBe(id);
    expect(clips('t3')[full]).toBeNull();
    expect(notice()).toContain(`Moved “${name}”`);
    expect(presses).toEqual([]);
    expect(session.store.undoLabel()).toBe('Move clip');
    act(() => session.undo());
    expect(names('t3')).toEqual(before);
    // Selection follows the clip.
    expect(uiStore.getState().selectedSlot.t3).toBe(empty);
  });

  it('onto another clip the two swap; with Ctrl held the drop copies and replaces (Undo restores)', async () => {
    grid();
    const c = clips('t4');
    const a = c.findIndex((x) => !!x);
    const b = c.findIndex((x, i) => !!x && i !== a);
    const before = names('t4');
    await drag(pad('t4', a), pad('t4', b));
    expect(names('t4')[a]).toBe(before[b]);
    expect(names('t4')[b]).toBe(before[a]);
    expect(session.store.undoLabel()).toBe('Swap clips');
    act(() => session.undo());
    expect(names('t4')).toEqual(before);
    await drag(pad('t4', a), pad('t4', b), { ctrl: true });
    expect(names('t4')[b]).toBe(before[a]);
    expect(names('t4')[a]).toBe(before[a]);
    expect(clips('t4')[b]!.id).not.toBe(clips('t4')[a]!.id);
    expect(notice()).toContain('replacing');
    expect(session.store.undoLabel()).toBe('Copy clip');
    act(() => session.undo());
    expect(names('t4')).toEqual(before);
  });

  it('a drop across drum and melodic parts is refused with an explanation and changes nothing', async () => {
    grid();
    const before = project();
    await drag(pad('t3', emptyAndFull('t3').full), pad('t1', emptyAndFull('t1').empty >= 0 ? emptyAndFull('t1').empty : 0));
    expect(project()).toBe(before);
    expect(notice()).toMatch(/plays melodic notes and .* plays drum steps/);
  });

  it('Esc cancels a drag: nothing moves and the release does not launch', async () => {
    grid();
    const { full, empty } = emptyAndFull('t3');
    const before = project();
    await drag(pad('t3', full), pad('t3', empty), { release: false });
    key(window, 'keydown', { key: 'Escape' });
    expect(cell('t3', empty).dataset.drop).toBeUndefined();
    pointer(pad('t3', full), 'pointerup', pointIn(pad('t3', empty)));
    expect(project()).toBe(before);
    expect(presses).toEqual([]);
  });
});

describe('Keyboard move and the pad action bar', () => {
  it('Move… then arrow keys and Enter moves the clip; Esc cancels; Ctrl+Enter copies', async () => {
    grid();
    const { full, empty } = emptyAndFull('t3');
    act(() => selectSlot('t3', full));
    const bar = document.querySelector<HTMLElement>('[data-pad-actions]')!;
    for (const name of ['Edit steps', 'Duplicate', 'Move…', 'Rename', 'Delete']) expect(button(name, bar), name).not.toBeNull();
    click(button('Move…', bar)!);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(document.activeElement).toBe(pad('t3', full));
    expect(document.body.textContent).toContain('arrow keys choose a pad');
    // Esc cancels.
    key(pad('t3', full), 'keydown', { key: 'Escape' });
    expect(document.body.textContent).not.toContain('arrow keys choose a pad');

    click(button('Move…', document.querySelector('[data-pad-actions]')!)!);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    let at = full;
    const dir = empty > full ? 'ArrowDown' : 'ArrowUp';
    while (at !== empty) {
      key(document.activeElement!, 'keydown', { key: dir });
      at += dir === 'ArrowDown' ? 1 : -1;
    }
    expect(document.activeElement).toBe(pad('t3', empty));
    const id = clips('t3')[full]!.id;
    key(document.activeElement!, 'keydown', { key: 'Enter' });
    expect(clips('t3')[empty]!.id).toBe(id);
    expect(presses).toEqual([]);
    expect(session.store.undoLabel()).toBe('Move clip');

    // Copy with Ctrl+Enter, onto the Chords part (both melodic).
    act(() => selectSlot('t3', empty));
    click(button('Move…', document.querySelector('[data-pad-actions]')!)!);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    key(document.activeElement!, 'keydown', { key: 'ArrowRight' });
    key(document.activeElement!, 'keydown', { key: 'Enter', ctrlKey: true });
    expect(clips('t4')[empty]!.name).toBe(clips('t3')[empty]!.name);
    expect(clips('t3')[empty]!.id).toBe(id);
    expect(session.store.undoLabel()).toBe('Copy clip');
  });

  it('the bar renames, duplicates and deletes the selected clip; right-click offers the same actions', async () => {
    grid();
    const { full } = emptyAndFull('t4');
    act(() => {
      selectTrack('t4');
      selectSlot('t4', full);
    });
    const count = () => clips('t4').filter(Boolean).length;
    const n = count();
    click(button('Duplicate', document.querySelector('[data-pad-actions]')!)!);
    if (n < 4) expect(count()).toBe(n + 1);
    act(() => {
      session.undo();
      selectSlot('t4', full);
    });
    click(button('Rename', document.querySelector('[data-pad-actions]')!)!);
    expect(document.querySelector('[role="dialog"] input')).not.toBeNull();
    key(document.querySelector('[role="dialog"] input')!, 'keydown', { key: 'Escape' });
    act(() => selectSlot('t4', full));
    click(button('Delete', document.querySelector('[data-pad-actions]')!)!);
    expect(clips('t4')[full]).toBeNull();
    act(() => session.undo());
    expect(clips('t4')[full]).not.toBeNull();
    const r = pad('t4', full).getBoundingClientRect();
    fire(pad('t4', full), new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 10, clientY: r.top + 10 }));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    for (const text of ['Edit steps', 'Duplicate', 'Move…', 'Rename', 'Delete clip']) expect(menu.textContent).toContain(text);
  });
});

describe('Scene rows', () => {
  it('dragging a scene button onto another row moves the row with every part’s clip; a click still launches; Alt+arrows move it too', async () => {
    act(() => void addBlock(session.store, project().scenes[0].id));
    const blocks = project().arrangement.blocks;
    grid();
    const scenes = project().scenes.map((s) => s.id);
    const row0 = project().tracks.map((t) => t.clips[0]?.id ?? null);
    const btn = (row: number) => document.querySelector<HTMLButtonElement>(`[data-scene-row="${row}"] button[data-scene]`)!;
    click(btn(1));
    expect(presses).toEqual(['scene 1']);
    presses = [];
    await drag(btn(0), btn(2));
    // The click that follows a drag does not launch; a later one does.
    click(btn(2));
    expect(presses).toEqual([]);
    await act(async () => {
      await wait(5);
    });
    click(btn(2));
    expect(presses).toEqual(['scene 2']);
    expect(project().scenes.map((s) => s.id)).toEqual([scenes[1], scenes[2], scenes[0], scenes[3]]);
    expect(project().tracks.map((t) => t.clips[2]?.id ?? null)).toEqual(row0);
    expect(project().arrangement.blocks).toBe(blocks);
    expect(session.store.undoLabel()).toBe('Move scene');
    act(() => btn(2).focus());
    key(btn(2), 'keydown', { key: 'ArrowUp', altKey: true });
    expect(project().scenes[1].id).toBe(scenes[0]);
    act(() => {
      session.undo();
      session.undo();
    });
    expect(project().scenes.map((s) => s.id)).toEqual(scenes);
  });
});

describe('Playback follows moved clips', () => {
  it('a playing clip moved within its part keeps playing, in phase, from its new pad; moved to another part, its old part stops', async () => {
    const s = new Session(getStarter('house')!.build());
    const rt = () => runtimeStore.getState().tracks;
    try {
      await s.play();
      const end = performance.now() + 4000;
      while (rt().t3?.playingSlot == null || !s.transport!.playing) {
        if (performance.now() > end) throw new Error('the bass did not start');
        await wait(20);
      }
      const slot = rt().t3!.playingSlot!;
      const startTick = s.sequencer!.getTrackState('t3').playing!.startTick;
      const id = s.store.getState().tracks[2].clips[slot]!.id;
      const empty = s.store.getState().tracks[2].clips.findIndex((c) => !c);
      expect(empty).toBeGreaterThanOrEqual(0);
      expect(s.moveClip({ trackId: 't3', slot }, { trackId: 't3', slot: empty })).toBe(true);
      expect(rt().t3!.playingSlot).toBe(empty);
      expect(s.sequencer!.getTrackState('t3').playing).toEqual({ slot: empty, clipId: id, startTick });
      // Undo takes it back, still playing.
      act(() => s.undo());
      expect(rt().t3!.playingSlot).toBe(slot);
      expect(s.sequencer!.getTrackState('t3').playing).toMatchObject({ slot, startTick });

      // To another melodic part with a free pad: Bass stops at once and the clip waits on its new part.
      const other = s.store.getState().tracks.find((t) => t.id !== 't3' && t.instrument.kind !== 'drums' && t.clips.some((c) => !c))!;
      const free = other.clips.findIndex((c) => !c);
      const otherBefore = rt()[other.id]?.playingSlot ?? null;
      expect(s.moveClip({ trackId: 't3', slot }, { trackId: other.id, slot: free })).toBe(true);
      expect(rt().t3!.playingSlot).toBeNull();
      expect(s.sequencer!.getTrackState('t3')).toEqual({ playing: null, queued: null });
      expect(rt()[other.id]?.playingSlot ?? null).toBe(otherBefore);
      expect(runtimeStore.getState().notice?.text).toContain('stopped playing it');
    } finally {
      s.dispose();
      act(() => patchRuntime({ playing: false, paused: false }));
    }
  });
});
