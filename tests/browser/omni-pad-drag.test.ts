/**
 * Clip pads and scene rows carried with REAL input (Chrome DevTools Protocol
 * mouse, keyboard and touch events, so pointer capture, implicit touch capture
 * and modifier keys behave as they do for people):
 * - the lifted copy of the pad (its name, length and state) follows the
 *   pointer exactly; its own pad stays as a faint placeholder; moving within
 *   one pad touches nothing in the grid;
 * - a swap settles both clips in their final pads (FLIP: they start where they
 *   were drawn and glide in), one undo step;
 * - Esc, a release away from the pads and a refused drop glide the pad home
 *   and change nothing (the refusal and take-lock messages are unchanged);
 * - Ctrl switches copy on and off mid-drag (the label and the target say so);
 * - a scene row lifts, the others slide apart to open its slot, the drop
 *   reorders (one undo step) and settles; Alt+arrows and the pad's Move… get
 *   the same settle;
 * - reduce motion: nothing animates, everything lands at once;
 * - touch: a finger drag works (the pad's implicit capture is handed over
 *   without cancelling), a second finger is ignored while carrying;
 * - pointercancel, lost capture of the grid (not a child's), window blur and
 *   unmounting mid-drag cancel cleanly; taps still launch (6 px), right-click
 *   opens the actions without playing.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cdp, page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { LoopsGrid } from '../../src/app/views/LoopsGrid';
import { getStarter } from '../../src/content/starters';
import type { Clip, Id } from '../../src/project/types';
import { addSceneToSong } from '../../src/state/commands';
import { selectSlot, selectTrack, setPadMode, setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, mount, wait, type Mounted } from './ui-harness';

const real = { pressClip: session.pressClip, launchScene: session.launchScene };
let presses: string[] = [];
let mounted: Mounted | null = null;

beforeEach(async () => {
  await page.viewport(1366, 900);
  presses = [];
  session.pressClip = async (trackId, slot) => void presses.push(`clip ${trackId} ${slot}`);
  session.launchScene = async (row) => void presses.push(`scene ${row}`);
  session.store.replace(getStarter('house')!.build(), { resetHistory: true });
  act(() => {
    patchRuntime({ held: {}, notice: null, recording: 'off', recordTarget: null, playing: false, paused: false });
    setView('play');
    setPadMode('loops');
    setUiMode('simple');
    selectTrack('t3');
    selectSlot('t3', 0);
  });
});

afterEach(async () => {
  // Never leave a button held or touch emulation on for the next test file.
  await cdp().send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
  await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
  await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }).catch(() => {});
  session.store.setLock(null);
  cleanup();
  mounted = null;
  session.pressClip = real.pressClip;
  session.launchScene = real.launchScene;
});

function grid(): Mounted {
  mounted = mount(h('div', { style: { width: '1000px', height: '620px', display: 'flex', flexDirection: 'column' } }, h(LoopsGrid)), { width: 1040 });
  return mounted;
}

/* ---------------- real input ---------------- */

type Pt = { x: number; y: number };
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

type InputMethod = 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.dispatchTouchEvent';
async function send(method: InputMethod, params: Record<string, unknown>) {
  await act(async () => {
    await (cdp().send as (m: InputMethod, p: Record<string, unknown>) => Promise<unknown>)(method, params);
  });
}
const mouse = (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', p: Pt, o: { buttons?: number; modifiers?: number; button?: 'left' | 'right' | 'none' } = {}) =>
  send('Input.dispatchMouseEvent', {
    type,
    x: p.x,
    y: p.y,
    button: o.button ?? (type === 'mouseMoved' && !o.buttons ? 'none' : 'left'),
    buttons: o.buttons ?? (type === 'mousePressed' ? 1 : 0),
    clickCount: type === 'mouseMoved' ? 0 : 1,
    modifiers: o.modifiers ?? 0,
  });
async function press(p: Pt, modifiers = 0) {
  await mouse('mouseMoved', p);
  await mouse('mousePressed', p, { modifiers });
}
/** Move with the left button held, in `steps` from `a` to `b`. */
async function moveTo(a: Pt, b: Pt, steps = 8, modifiers = 0) {
  for (let i = 1; i <= steps; i++) await mouse('mouseMoved', { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }, { buttons: 1, modifiers });
}
const release = (p: Pt, modifiers = 0) => mouse('mouseReleased', p, { modifiers });
async function click(p: Pt) {
  await press(p);
  await release(p);
}
const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Escape: { code: 'Escape', vk: 27 },
  Control: { code: 'ControlLeft', vk: 17 },
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
};
async function keyDown(key: string, modifiers = 0) {
  const k = KEYS[key];
  await send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', key, code: k.code, windowsVirtualKeyCode: k.vk, text: k.text, modifiers });
}
async function keyUp(key: string, modifiers = 0) {
  const k = KEYS[key];
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers });
}
async function tap(key: string, modifiers = 0) {
  await keyDown(key, modifiers);
  await keyUp(key, modifiers);
}
const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: (Pt & { id: number })[]) => send('Input.dispatchTouchEvent', { type, touchPoints: points });
async function frames(n = 2) {
  await act(async () => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
  });
}
async function settle(ms = 320) {
  await act(async () => {
    await wait(ms);
  });
}

/* ---------------- the grid ---------------- */

const project = () => session.store.getState();
const clips = (trackId: Id): (Clip | null)[] => project().tracks.find((t) => t.id === trackId)!.clips;
const names = (trackId: Id) => clips(trackId).map((c) => c?.name ?? null);
const pad = (trackId: Id, slot: number) => document.getElementById(`pad-${trackId}-${slot}`) as HTMLButtonElement;
const cell = (trackId: Id, slot: number) => pad(trackId, slot).closest<HTMLElement>('[data-pad-cell]')!;
const gridEl = () => document.querySelector<HTMLElement>('[aria-label="Clip pads: eight parts by four scenes"]')!;
const lift = () => document.querySelector<HTMLElement>('[data-testid="pad-lift"]');
const rowLift = () => document.querySelector<HTMLElement>('[data-testid="row-lift"]');
const label = () => (lift() ?? rowLift())?.querySelector<HTMLElement>('[class*="liftText"]')?.textContent ?? null;
const word = () => {
  const w = document.querySelector<HTMLElement>('[data-testid="pad-target-word"]');
  return w && w.hasAttribute('data-on') ? w.textContent : null;
};
const notice = () => runtimeStore.getState().notice?.text ?? '';
const undoCount = () => session.store.historySize().undo;
const centre = (el: Element, dx = 0, dy = 0): Pt => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2 + dx, y: r.top + r.height / 2 + dy };
};
const rect = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};
const moving = (el: Element) => el.getAnimations().filter((a) => a.playState === 'running').length > 0;
const allCells = () => [...document.querySelectorAll<HTMLElement>('[data-pad-cell], [data-scene-row]')];
const sceneBtn = (row: number) => document.querySelector<HTMLButtonElement>(`[data-scene-row="${row}"] button[data-scene]`)!;

/** House starter, Bass (t3): [empty, Bounce, Rolling, Held Roots]; Chords (t4) has a clip in row 1; Drums (t1) is a kit part. */
function bass() {
  const c = clips('t3');
  return { empty: c.findIndex((x) => !x), a: 1, b: 2, nameA: c[1]!.name, nameB: c[2]!.name };
}

describe('carrying a clip pad', () => {
  it('lifts a real copy of the pad that follows the pointer exactly; its own pad stays as a faint placeholder', async () => {
    grid();
    const { a, empty, nameA } = bass();
    const src = pad('t3', a);
    const box = rect(src);
    const start = { x: box.left + box.width * 0.3, y: box.top + box.height * 0.35 };
    await press(start);
    // Under 6 px it is still a tap: nothing lifts.
    await moveTo(start, { x: start.x + 3, y: start.y + 2 }, 2);
    expect(lift()).toBeNull();
    expect(cell('t3', a).dataset.drop).toBeUndefined();
    const to = centre(pad('t3', empty), 9, -7);
    await moveTo({ x: start.x + 3, y: start.y + 2 }, to, 10);
    const l = lift()!;
    expect(l).not.toBeNull();
    // A real copy: the clip's name, length and state light.
    const face = l.querySelector<HTMLElement>('button[data-state]')!;
    expect(face.textContent).toContain(nameA);
    expect(face.textContent).toContain('2 bars');
    expect(face.dataset.state).toBe(src.dataset.state);
    // The point it was picked up by stays under the pointer (whatever the lift's scale is doing).
    const grabX = start.x - box.left;
    const grabY = start.y - box.top;
    for (const p of [to, centre(pad('t4', a), -12, 5), centre(pad('t5', 3), 20, 10)]) {
      await mouse('mouseMoved', p, { buttons: 1 });
      const r = l.getBoundingClientRect();
      const s = r.width / box.width;
      expect(Math.abs(r.left + grabX * s - p.x), 'x follows').toBeLessThan(1);
      expect(Math.abs(r.top + grabY * s - p.y), 'y follows').toBeLessThan(1);
    }
    // Its own pad: a faint, dashed placeholder.
    expect(cell('t3', a).dataset.drop).toBe('source');
    expect(Number(getComputedStyle(src).opacity)).toBeLessThan(0.5);
    // Moving within one pad changes nothing in the grid (no re-render, no layout work per move).
    const target = pad('t5', 3);
    await mouse('mouseMoved', centre(target), { buttons: 1 });
    // (The part meters rewrite their aria values every frame on their own; they are not the grid's business here.)
    const changes: MutationRecord[] = [];
    const mo = new MutationObserver((m) => changes.push(...m.filter((x) => !(x.target as Element).closest?.('[role="meter"]'))));
    mo.observe(gridEl(), { attributes: true, childList: true, subtree: true, characterData: true });
    for (const d of [3, 6, 9, -4, -8]) await mouse('mouseMoved', centre(target, d, d / 2), { buttons: 1 });
    await frames(1);
    mo.disconnect();
    expect(changes).toHaveLength(0);
    await tap('Escape');
    await release(centre(target));
    expect(lift()).toBeNull();
  });

  it('onto a clip: the other clip leans toward the carried one, and on release both settle into their final pads (one undo step)', async () => {
    grid();
    const { a, b, nameA, nameB } = bass();
    const rA = rect(cell('t3', a));
    const rB = rect(cell('t3', b));
    const before = undoCount();
    await press(centre(pad('t3', a)));
    const over = centre(pad('t3', b), 10, 6);
    await moveTo(centre(pad('t3', a)), over, 10);
    expect(cell('t3', b).dataset.target).toBe('swap');
    expect(word()).toBe('Swap');
    expect(label()).toBe('Move');
    // The clip that would be swapped leans toward the carried clip's pad (up: row a is above row b).
    await settle(220);
    const leaned = pad('t3', b).getBoundingClientRect();
    expect(leaned.top).toBeLessThan(rB.top - 4);
    await release(over);
    // Committed at once: one undo step.
    expect(names('t3')[a]).toBe(nameB);
    expect(names('t3')[b]).toBe(nameA);
    expect(undoCount()).toBe(before + 1);
    expect(session.store.undoLabel()).toBe('Swap clips');
    // Both clips are travelling: the carried one from where it was let go, the other from its pad toward the old place.
    expect(moving(cell('t3', b))).toBe(true);
    expect(moving(cell('t3', a))).toBe(true);
    const midB = cell('t3', b).getBoundingClientRect();
    const midA = cell('t3', a).getBoundingClientRect();
    expect(Math.hypot(midB.left - rB.left, midB.top - rB.top)).toBeGreaterThan(4);
    expect(midA.top).toBeGreaterThan(rA.top + 20);
    expect(lift()).toBeNull();
    // 180–220 ms later both are in their final pads.
    await settle(300);
    expect(moving(cell('t3', b)) || moving(cell('t3', a))).toBe(false);
    for (const [el, r] of [[cell('t3', a), rA], [cell('t3', b), rB]] as const) {
      const now = el.getBoundingClientRect();
      expect(Math.abs(now.left - r.left) + Math.abs(now.top - r.top)).toBeLessThan(0.5);
    }
    expect(pad('t3', b).textContent).toContain(nameA);
    expect(pad('t3', a).textContent).toContain(nameB);
    expect(presses).toEqual([]);
    act(() => session.undo());
    expect(names('t3')[a]).toBe(nameA);
  });

  it('Esc, a release away from the pads and a refused drop put the pad back: nothing changes and nothing plays', async () => {
    grid();
    const { a, empty } = bass();
    const home = rect(cell('t3', a));
    // Esc mid-drag, then the release (on a valid pad) does nothing.
    let p0 = project();
    await press(centre(pad('t3', a)));
    await moveTo(centre(pad('t3', a)), centre(pad('t3', empty)), 8);
    expect(cell('t3', empty).dataset.target).toBe('land');
    await tap('Escape');
    expect(lift()).toBeNull();
    expect(cell('t3', empty).dataset.target).toBeUndefined();
    expect(cell('t3', a).dataset.drop).toBeUndefined();
    expect(moving(cell('t3', a)), 'glides home').toBe(true);
    await moveTo(centre(pad('t3', empty)), centre(pad('t3', empty), 20, 0), 3);
    expect(lift(), 'the rest of the press stays cancelled').toBeNull();
    await release(centre(pad('t3', empty)));
    expect(project()).toBe(p0);
    expect(presses).toEqual([]);
    await settle();
    expect(Math.abs(cell('t3', a).getBoundingClientRect().top - home.top)).toBeLessThan(0.5);

    // Released away from the pads (over the scene column and beyond).
    const away = { x: gridEl().getBoundingClientRect().right + 80, y: home.top + 20 };
    await press(centre(pad('t3', a)));
    await moveTo(centre(pad('t3', a)), away, 10);
    expect(label()).toBe('Release to cancel');
    expect(lift()!.dataset.kind).toBe('none');
    await release(away);
    expect(project()).toBe(p0);
    expect(moving(cell('t3', a))).toBe(true);
    await settle();

    // Refused: a melodic clip onto a drum part. The label on the lifted pad says why; the target says so in words.
    const drum = clips('t1').findIndex((c) => !c) >= 0 ? clips('t1').findIndex((c) => !c) : 0;
    await press(centre(pad('t3', a)));
    await moveTo(centre(pad('t3', a)), centre(pad('t1', drum)), 10);
    expect(label()).toBe('Melodic clips go to melodic parts');
    expect(lift()!.dataset.kind).toBe('no');
    expect(cell('t1', drum).dataset.target).toBe('no');
    expect(word()).toBe('Can’t go here');
    expect(gridEl().hasAttribute('data-refused')).toBe(true);
    // The label sits above the lifted pad and the word on the target's lower edge: neither covers the other.
    const lab = lift()!.querySelector('[class*="liftLabel"]')!.getBoundingClientRect();
    const w = document.querySelector('[data-testid="pad-target-word"]')!.getBoundingClientRect();
    expect(lab.bottom <= w.top || w.bottom <= lab.top || lab.right <= w.left || w.right <= lab.left).toBe(true);
    await release(centre(pad('t1', drum)));
    expect(project()).toBe(p0);
    // The full explanation is the same as before.
    expect(notice()).toMatch(/plays melodic notes and .* plays drum steps/);
    expect(moving(cell('t3', a))).toBe(true);
    await settle();

    // While a performance take records, the lifted pad says Locked (no pad is a target) and the drop changes nothing,
    // without a new notice: the label already said why.
    session.store.setLock('Recording a performance', () => false);
    p0 = project();
    const noticeBefore = runtimeStore.getState().notice;
    await press(centre(pad('t3', a)));
    await moveTo(centre(pad('t3', a)), centre(pad('t3', empty)), 8);
    expect(label()).toBe('Locked');
    expect(lift()!.dataset.kind).toBe('no');
    expect(cell('t3', empty).dataset.target).toBeUndefined();
    await release(centre(pad('t3', empty)));
    expect(project()).toBe(p0);
    expect(runtimeStore.getState().notice).toBe(noticeBefore);
    expect(presses).toEqual([]);
  });

  it('Ctrl switches copy on and off mid-drag (the label and the target say so); dropping with it held copies (one undo step)', async () => {
    grid();
    const { a, nameA } = bass();
    const chords = clips('t4')[a]!.name;
    const at = centre(pad('t4', a));
    await press(centre(pad('t3', a)));
    await moveTo(centre(pad('t3', a)), at, 10);
    expect(label()).toBe('Move');
    expect(lift()!.hasAttribute('data-copy')).toBe(false);
    expect(cell('t4', a).dataset.target).toBe('swap');
    // Ctrl down, without moving.
    await keyDown('Control', MOD.ctrl);
    expect(label()).toBe('Copy');
    expect(lift()!.hasAttribute('data-copy')).toBe(true);
    expect(cell('t4', a).dataset.target).toBe('replace');
    expect(word()).toBe('Replace');
    // Copying: the original stays (not a faint placeholder).
    expect(Number(getComputedStyle(pad('t3', a)).opacity)).toBeGreaterThan(0.7);
    await keyUp('Control');
    expect(label()).toBe('Move');
    expect(word()).toBe('Swap');
    // Held again for the drop.
    await keyDown('Control', MOD.ctrl);
    const before = undoCount();
    await release(at, MOD.ctrl);
    await keyUp('Control');
    expect(names('t4')[a]).toBe(nameA);
    expect(names('t3')[a]).toBe(nameA);
    expect(clips('t4')[a]!.id).not.toBe(clips('t3')[a]!.id);
    expect(notice()).toContain(`replacing “${chords}”`);
    expect(session.store.undoLabel()).toBe('Copy clip');
    expect(undoCount()).toBe(before + 1);
    expect(moving(cell('t4', a))).toBe(true);
  });

  it('with reduce motion nothing animates: no lift-in, no lean, the drop lands at once', async () => {
    await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    grid();
    const { a, b, nameA } = bass();
    const rB = rect(pad('t3', b));
    await press(centre(pad('t3', a)));
    await moveTo(centre(pad('t3', a)), centre(pad('t3', b), 6, 4), 8);
    // (The theme's reduce-motion rule leaves 0.001 s on every transition.)
    expect(getComputedStyle(lift()!).transitionDuration.split(',').every((d) => parseFloat(d) <= 0.001)).toBe(true);
    expect(word()).toBe('Swap');
    await settle(200);
    expect(Math.abs(pad('t3', b).getBoundingClientRect().top - rB.top), 'no lean').toBeLessThan(0.5);
    await release(centre(pad('t3', b), 6, 4));
    expect(names('t3')[b]).toBe(nameA);
    expect(allCells().some((el) => el.getAnimations().length > 0)).toBe(false);
    expect(Math.abs(cell('t3', b).getBoundingClientRect().top - rect(cell('t3', a)).top - (rB.top - rect(pad('t3', a)).top))).toBeLessThan(0.5);
    // Cancelling is instant too.
    await press(centre(pad('t3', a)));
    await moveTo(centre(pad('t3', a)), centre(pad('t3', 3)), 6);
    await tap('Escape');
    await release(centre(pad('t3', 3)));
    expect(allCells().some((el) => el.getAnimations().length > 0)).toBe(false);
  });
});

describe('scene rows', () => {
  it('a carried row lifts, the other rows slide apart to open its slot, and the drop reorders (one undo step) and settles', async () => {
    act(() => void addSceneToSong(session.store, 0, 0));
    const regions = project().arrangement.regions;
    expect(regions.length).toBeGreaterThan(0);
    grid();
    const scenes = project().scenes.map((s) => s.id);
    const row0 = project().tracks.map((t) => t.clips[0]?.id ?? null);
    const tops = [0, 1, 2, 3].map((r) => sceneBtn(r).closest('[data-scene-row]')!.getBoundingClientRect().top);
    const pitch = tops[1] - tops[0];
    const from = centre(sceneBtn(0));
    const to = centre(sceneBtn(2), -6, 3);
    await press(from);
    await moveTo(from, to, 12);
    await settle(250);
    const l = rowLift()!;
    expect(l).not.toBeNull();
    expect(l.textContent).toContain(project().scenes[0].name);
    // A faint copy of its pads, with their clip names.
    const firstClip = project().tracks.map((t) => t.clips[0]).find((c) => !!c)!;
    expect(l.textContent).toContain(firstClip.name);
    expect(label()).toBe('Move to row 3');
    // Rows 1 and 2 slid up one row; the carried row's own cells are the open slot at row 2.
    expect(Math.abs(cell('t3', 1).getBoundingClientRect().top - tops[0])).toBeLessThan(1);
    expect(Math.abs(sceneBtn(2).closest('[data-scene-row]')!.getBoundingClientRect().top - tops[1])).toBeLessThan(1);
    expect(cell('t1', 0).dataset.rowDrag).toBe('source');
    expect(Math.abs(cell('t1', 0).getBoundingClientRect().top - tops[2])).toBeLessThan(1);
    // The lifted row follows the pointer up and down.
    const lr = l.getBoundingClientRect();
    expect(Math.abs(lr.top - (tops[0] + (to.y - from.y)))).toBeLessThan(1);
    const before = undoCount();
    await release(to);
    expect(project().scenes.map((s) => s.id)).toEqual([scenes[1], scenes[2], scenes[0], scenes[3]]);
    expect(project().tracks.map((t) => t.clips[2]?.id ?? null)).toEqual(row0);
    expect(project().arrangement.regions).toBe(regions);
    expect(undoCount()).toBe(before + 1);
    expect(session.store.undoLabel()).toBe('Move scene');
    expect(rowLift()).toBeNull();
    // The moved row springs from where it was let go into row 3; the others are already in place.
    expect(moving(sceneBtn(2).closest('[data-scene-row]')!)).toBe(true);
    expect(moving(sceneBtn(0).closest('[data-scene-row]')!)).toBe(false);
    await settle();
    expect(allCells().some(moving)).toBe(false);
    expect(Math.abs(sceneBtn(2).closest('[data-scene-row]')!.getBoundingClientRect().top - tops[2])).toBeLessThan(0.5);
    expect(pitch).toBeGreaterThan(40);
    // The click that ended the drag launched nothing; a real click later does.
    expect(presses).toEqual([]);
    await settle(20);
    await click(centre(sceneBtn(2)));
    expect(presses).toEqual(['scene 2']);
    act(() => session.undo());
    expect(project().scenes.map((s) => s.id)).toEqual(scenes);
  });

  it('a row released far above or below the pads goes back; Esc does too', async () => {
    grid();
    const p0 = project();
    const from = centre(sceneBtn(1));
    const far = { x: from.x, y: gridEl().getBoundingClientRect().bottom + 120 };
    await press(from);
    await moveTo(from, far, 10);
    expect(label()).toBe('Release to cancel');
    await release(far);
    expect(project()).toBe(p0);
    await settle();
    await press(from);
    await moveTo(from, centre(sceneBtn(3)), 8);
    await tap('Escape');
    expect(rowLift()).toBeNull();
    await release(centre(sceneBtn(3)));
    expect(project()).toBe(p0);
    expect(presses).toEqual([]);
  });
});

describe('keyboard alternatives get the same settle', () => {
  it('Alt+Down on a scene button moves the row with motion and keeps focus on it', async () => {
    grid();
    const scenes = project().scenes.map((s) => s.id);
    // A real click first, so the test frame has keyboard focus (the scene header is inert text).
    await click(centre(document.querySelector('[class*="sceneHeaderText"]')!));
    act(() => sceneBtn(0).focus());
    await keyDown('ArrowDown', MOD.alt);
    await keyUp('ArrowDown', MOD.alt);
    expect(project().scenes.map((s) => s.id)).toEqual([scenes[1], scenes[0], scenes[2], scenes[3]]);
    expect(moving(sceneBtn(1).closest('[data-scene-row]')!)).toBe(true);
    expect(moving(sceneBtn(0).closest('[data-scene-row]')!)).toBe(true);
    expect(document.activeElement).toBe(sceneBtn(1));
    await settle();
    expect(allCells().some(moving)).toBe(false);
  });

  it('the pad’s Move…, arrow keys and Enter swap with motion; Esc cancels', async () => {
    grid();
    const { a, b, nameA, nameB } = bass();
    act(() => selectSlot('t3', a));
    const bar = document.querySelector<HTMLElement>('[data-pad-actions]')!;
    const moveBtn = [...bar.querySelectorAll('button')].find((x) => x.textContent === 'Move…')!;
    await click(centre(moveBtn));
    await frames(2);
    expect(document.activeElement).toBe(pad('t3', a));
    await tap('ArrowDown');
    expect(document.activeElement).toBe(pad('t3', b));
    expect(cell('t3', b).dataset.target).toBe('swap');
    expect(cell('t3', b).dataset.chip).toBe('Swap');
    await tap('Enter');
    expect(names('t3')[b]).toBe(nameA);
    expect(names('t3')[a]).toBe(nameB);
    expect(moving(cell('t3', b))).toBe(true);
    expect(moving(cell('t3', a))).toBe(true);
    expect(document.activeElement).toBe(pad('t3', b));
    expect(presses).toEqual([]);
    await settle();
    // Esc cancels a keyboard move.
    act(() => selectSlot('t3', b));
    await click(centre([...document.querySelector<HTMLElement>('[data-pad-actions]')!.querySelectorAll('button')].find((x) => x.textContent === 'Move…')!));
    await frames(2);
    const p0 = project();
    await tap('ArrowUp');
    await tap('Escape');
    expect(project()).toBe(p0);
    expect(document.body.textContent).not.toContain('arrow keys choose a pad');
  });
});

describe('touch and other pointers', () => {
  it('a finger carries a pad (the pressed pad hands its capture over without cancelling); a tap still launches', async () => {
    await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    grid();
    const { a, b, nameA, nameB } = bass();
    const s = centre(pad('t3', a));
    const t = centre(pad('t3', b), 4, 4);
    await touch('touchStart', [{ ...s, id: 1 }]);
    for (let i = 1; i <= 10; i++) await touch('touchMove', [{ x: s.x + ((t.x - s.x) * i) / 10, y: s.y + ((t.y - s.y) * i) / 10, id: 1 }]);
    expect(lift()).not.toBeNull();
    expect(label()).toBe('Move');
    const before = undoCount();
    await touch('touchEnd', []);
    expect(names('t3')[b]).toBe(nameA);
    expect(names('t3')[a]).toBe(nameB);
    expect(undoCount()).toBe(before + 1);
    expect(presses).toEqual([]);
    await settle();
    // A tap (no travel) launches.
    const q = centre(pad('t3', 3));
    await touch('touchStart', [{ ...q, id: 2 }]);
    await touch('touchEnd', []);
    expect(presses).toEqual(['clip t3 3']);
  });

  it('a second finger is ignored while a pad is carried; the first finger’s drop still lands', async () => {
    await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    grid();
    const { a, b, nameA } = bass();
    const s = centre(pad('t3', a));
    const t = centre(pad('t3', b));
    const other = centre(pad('t4', 2));
    await touch('touchStart', [{ ...s, id: 1 }]);
    for (let i = 1; i <= 8; i++) await touch('touchMove', [{ x: s.x + ((t.x - s.x) * i) / 8, y: s.y + ((t.y - s.y) * i) / 8, id: 1 }]);
    expect(lift()).not.toBeNull();
    // Second finger taps another clip pad: no launch, no selection, the drag carries on.
    // (CDP touch: a finger is lifted by leaving it out of the next event; touchEnd lifts them all.)
    await touch('touchStart', [{ ...t, id: 1 }, { ...other, id: 2 }]);
    await touch('touchMove', [{ ...t, id: 1 }]);
    expect(presses).toEqual([]);
    expect(lift()).not.toBeNull();
    await touch('touchEnd', []);
    expect(names('t3')[b]).toBe(nameA);
  });
});

describe('robustness', () => {
  it('pointercancel, lost capture of the grid, window blur and unmounting each cancel cleanly; a child’s lost capture does not', async () => {
    grid();
    const { a, empty } = bass();
    const p0 = project();
    const go = async () => {
      await press(centre(pad('t3', a)));
      await moveTo(centre(pad('t3', a)), centre(pad('t3', empty)), 8);
      expect(lift()).not.toBeNull();
    };
    // A child's lostpointercapture bubbles up to the grid: it is not ours, nothing happens.
    await go();
    act(() => void pad('t3', 3).dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1, pointerType: 'mouse' })));
    expect(lift()).not.toBeNull();
    // The grid's own capture lost: cancelled.
    act(() => gridEl().releasePointerCapture(1));
    await mouse('mouseMoved', centre(pad('t3', empty), 3, 3), { buttons: 1 });
    expect(lift()).toBeNull();
    await release(centre(pad('t3', empty)));
    expect(project()).toBe(p0);
    // Window blur.
    await go();
    act(() => void window.dispatchEvent(new Event('blur')));
    expect(lift()).toBeNull();
    expect(cell('t3', a).dataset.drop).toBeUndefined();
    await release(centre(pad('t3', empty)));
    expect(project()).toBe(p0);
    // A real pointercancel (a finger the browser takes over).
    await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const s = centre(pad('t3', a));
    await touch('touchStart', [{ ...s, id: 3 }]);
    for (let i = 1; i <= 6; i++) await touch('touchMove', [{ x: s.x, y: s.y + i * 12, id: 3 }]);
    expect(lift()).not.toBeNull();
    await touch('touchCancel', []);
    expect(lift()).toBeNull();
    expect(project()).toBe(p0);
    await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: false });
    // Unmounting mid-drag (a view switch): the lifted pad goes with it and later input does nothing.
    await go();
    act(() => mounted!.unmount());
    expect(lift()).toBeNull();
    expect(document.querySelector('[data-testid="pad-target-word"]')).toBeNull();
    await mouse('mouseMoved', { x: 300, y: 300 }, { buttons: 1 });
    await release({ x: 300, y: 300 });
    expect(project()).toBe(p0);
    // A fresh grid drags normally again.
    grid();
    await go();
    await release(centre(pad('t3', empty)));
    expect(clips('t3')[empty]).not.toBeNull();
  });

  it('a tap (under 6 px) launches; right-click opens the actions without playing', async () => {
    grid();
    const { a } = bass();
    const p = centre(pad('t3', a));
    await press(p);
    await mouse('mouseMoved', { x: p.x + 3, y: p.y + 2 }, { buttons: 1 });
    await release({ x: p.x + 3, y: p.y + 2 });
    expect(presses).toEqual([`clip t3 ${a}`]);
    presses = [];
    // 7 px: a drag (back home: nothing happens, nothing plays).
    await press(p);
    await moveTo(p, { x: p.x + 7, y: p.y }, 2);
    expect(lift()).not.toBeNull();
    await release({ x: p.x + 7, y: p.y });
    expect(presses).toEqual([]);
    // Right button.
    await mouse('mouseMoved', p);
    await mouse('mousePressed', p, { button: 'right', buttons: 2 });
    await mouse('mouseReleased', p, { button: 'right', buttons: 0 });
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain('Rename');
    expect(presses).toEqual([]);
    expect(lift()).toBeNull();
  });
});
