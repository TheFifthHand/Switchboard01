/**
 * Toggles that are on stay on-looking under the pointer, held down (the real
 * mouse button) and with keyboard focus, and their words stay readable (4.5:1 against every stop of their
 * background): Mute All, a part's Mute and Solo (pads, part panel, Mix),
 * Lock, Loop, Follow and the metronome (its key's lamp and its switch), with
 * the real pointer over them in the running app.
 *
 * Mute and Solo never move anything: the pads, the part panel and the
 * transport keep every box where it was when they are switched (1366 x 768,
 * 1920 x 1080 and 960 x 540 = 200 % zoom). A scene button says how many parts
 * it plays in Arrange's words ("4 parts"). The selected pad's name has room
 * beside its '⋯' ("Bell / Hook", not "Bell H…").
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { App } from '../../src/app/App';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import type { BootInfo } from '../../src/app/session';
import { deleteDb } from '../../src/persistence/db';
import { setLocked, setSettings } from '../../src/state/commands';
import { selectSlot, selectTrack, setGuideDone, setKeyboardCollapsed, setPadMode, setTipsEnabled, setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, mount, nextFrame, wait } from './ui-harness';

let boot: BootInfo;
const realPressClip = session.pressClip;

beforeEach(async () => {
  await deleteDb();
  act(() => {
    setGuideDone(true);
    setTipsEnabled(true);
    setUiMode('simple');
    setView('play');
    setPadMode('loops');
    setKeyboardCollapsed(false);
    patchRuntime({ playing: false, paused: false, recording: 'off', notice: null, tracks: {}, muteAll: false, songLoop: null });
  });
  session.pressClip = async () => {};
  boot = await session.boot();
});

afterEach(async () => {
  cleanup();
  session.pressClip = realPressClip;
  act(() => {
    setView('play');
    patchRuntime({ playing: false, paused: false, tracks: {}, muteAll: false, songLoop: null });
  });
  await session.autosaver?.flush();
  await deleteDb();
});

async function settle(ms = 60) {
  await Promise.all(['400 13px "Inter Variable"', '600 13px "Inter Variable"', '650 15px "Inter Variable"', '400 12px "IBM Plex Mono"'].map((f) => document.fonts.load(f)));
  await document.fonts.ready;
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await wait(ms);
  });
}

async function openApp(w: number, hh: number) {
  await page.viewport(w, hh);
  window.scrollTo(0, 0);
  const m = mount(h(App, { boot }));
  m.container.style.width = '';
  m.container.style.padding = '0';
  const look = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Just look around');
  await act(async () => {
    look?.click();
    await wait(20);
  });
  await act(async () => {
    await session.newFromStarter('house');
  });
  // No audio here: what is drawn is the point.
  act(() => patchRuntime({ playing: false, paused: false, tracks: {} }));
  await settle();
}

/** Trusted pointer input goes through the browser outside React's act(). */
async function real(fn: () => Promise<unknown>): Promise<void> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await fn();
    await nextFrame();
    await nextFrame();
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
}

const named = (name: string | RegExp, root: ParentNode = document): HTMLElement | null =>
  [...root.querySelectorAll<HTMLElement>('button, [role="switch"]')].find((b) => {
    const n = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    return typeof name === 'string' ? n === name : name.test(n);
  }) ?? null;

/* ------------------------------------------------------------------ */
/* Colour                                                              */
/* ------------------------------------------------------------------ */

type RGBA = [number, number, number, number];

/** Every colour in a computed value: rgb()/rgba() and color(srgb …). */
function colorsIn(value: string): RGBA[] {
  const out: RGBA[] = [];
  for (const m of value.matchAll(/rgba?\(([^)]+)\)/g)) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    out.push([p[0], p[1], p[2], p[3] ?? 1]);
  }
  for (const m of value.matchAll(/color\(srgb ([^)]+)\)/g)) {
    const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
    out.push([p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]);
  }
  return out;
}

function over(top: RGBA, under: RGBA): RGBA {
  const a = top[3] + under[3] * (1 - top[3]);
  if (a === 0) return [0, 0, 0, 0];
  const c = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
  return [c(0), c(1), c(2), a];
}

function luminance([r, g, b]: RGBA): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a: RGBA, b: RGBA): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** What one element paints behind its content: each gradient stop over its background colour, or that colour. */
function ownBackground(el: Element): RGBA[] {
  const cs = getComputedStyle(el);
  const color = colorsIn(cs.backgroundColor)[0];
  const stops = cs.backgroundImage.includes('gradient') ? colorsIn(cs.backgroundImage) : [];
  if (stops.length) return stops.map((s) => (color && color[3] > 0 ? over(s, color) : s));
  return color && color[3] > 0 ? [color] : [];
}

/** Every colour the text of `el` can sit on: its background composited over its ancestors' (white at the bottom). */
function backgroundsOf(el: Element): RGBA[] {
  const layers: RGBA[][] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    const layer = ownBackground(n);
    if (!layer.length) continue;
    layers.push(layer);
    if (layer.every((c) => c[3] >= 0.999)) break;
  }
  let under: RGBA[] = [[255, 255, 255, 1]];
  for (const layer of layers.reverse()) under = under.flatMap((u) => layer.map((c) => over(c, u)));
  return under;
}

/** The lowest contrast between the text colour of `el` and any colour behind it. */
function worstContrast(el: Element): number {
  const text = colorsIn(getComputedStyle(el).color)[0];
  return Math.min(...backgroundsOf(el).map((b) => contrast(over(text, b), b)));
}

/** What says "on": the key's own background, words and outline (and its lamp, if it has one); for a lamp key, its lamp. */
function lookOf(el: Element, lampOnly = false): string {
  const cs = getComputedStyle(el);
  const lamp = el.querySelector('[class*="led"], [class*="lamp"]');
  const lit = lamp ? [getComputedStyle(lamp).backgroundColor, getComputedStyle(lamp).boxShadow] : null;
  return JSON.stringify(lampOnly ? lit : [cs.backgroundImage, cs.backgroundColor, cs.color, cs.borderColor, lit]);
}

/** A spot far from every control, where the pointer rests between checks. */
async function pointerAway() {
  await real(() => userEvent.hover(document.querySelector('main')!, { position: { x: 2, y: 2 }, force: true }));
  await wait(150);
}

async function hover(el: Element) {
  await real(() => userEvent.hover(el, { force: true }));
  // Past every transition.
  await wait(200);
}

type MouseType = 'mouseMoved' | 'mousePressed' | 'mouseReleased';
/** A trusted mouse event at a window point (the real button, not a synthetic event). */
async function mouse(type: MouseType, x: number, y: number) {
  await real(() =>
    (cdp().send as (m: string, p: Record<string, unknown>) => Promise<unknown>)('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: type === 'mouseMoved' ? 0 : 1,
    }),
  );
}

/**
 * Holds the real mouse button down on `el` (it is :active), runs `check`, and
 * lets go without the click reaching the app (the toggle stays as it was).
 */
async function whilePressed(el: Element, check: () => void) {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y);
  const swallow = (e: Event) => {
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  window.addEventListener('click', swallow, { capture: true });
  try {
    await wait(200);
    check();
  } finally {
    await mouse('mouseReleased', x, y);
    window.removeEventListener('click', swallow, { capture: true });
  }
}

/** Checks one engaged toggle: same look under the pointer and with keyboard focus; its words readable throughout. */
async function expectOnLookHolds(label: string, el: HTMLElement | null, opts: { text?: boolean; lampOnly?: boolean } = {}) {
  expect(el, `${label}: on screen`).toBeTruthy();
  el!.scrollIntoView({ block: 'center' });
  await pointerAway();
  const look = (e: Element) => lookOf(e, opts.lampOnly);
  const rest = look(el!);
  const text = opts.text !== false;
  if (text) expect(worstContrast(el!), `${label}: words at rest`).toBeGreaterThanOrEqual(4.5);
  await hover(el!);
  expect(el!.matches(':hover'), `${label}: hovered`).toBe(true);
  expect(look(el!), `${label}: the on-look under the pointer`).toBe(rest);
  if (text) expect(worstContrast(el!), `${label}: words under the pointer`).toBeGreaterThanOrEqual(4.5);
  // Pressed (the button held down): still the on-look, still readable.
  const pressed = el!.getAttribute('aria-pressed') ?? el!.getAttribute('aria-checked');
  await whilePressed(el!, () => {
    expect(el!.matches(':active'), `${label}: held down`).toBe(true);
    expect(look(el!), `${label}: the on-look while pressed`).toBe(rest);
    if (text) expect(worstContrast(el!), `${label}: words while pressed`).toBeGreaterThanOrEqual(4.5);
  });
  expect(el!.getAttribute('aria-pressed') ?? el!.getAttribute('aria-checked'), `${label}: unchanged by the swallowed click`).toBe(pressed);
  await pointerAway();
  act(() => el!.focus({ focusVisible: true } as FocusOptions));
  await wait(200);
  expect(look(el!), `${label}: the on-look with keyboard focus`).toBe(rest);
  if (text) expect(worstContrast(el!), `${label}: words with keyboard focus`).toBeGreaterThanOrEqual(4.5);
  act(() => el!.blur());
}

describe('engaged toggles keep their on-look', () => {
  it('under the pointer and with keyboard focus, with readable words, in Play, Song and Mix', async () => {
    await openApp(1366, 768);
    const p = session.store.getState();
    const drums = p.tracks[0];
    const bass = p.tracks[2];
    act(() => {
      session.setMute(drums.id, true);
      session.setSolo(bass.id, true);
      session.accepted(setLocked(session.store, drums.id, true));
      session.accepted(setSettings(session.store, { metronome: true }));
      patchRuntime({ muteAll: true });
      selectTrack(drums.id);
      selectSlot(drums.id, 0);
    });
    await settle();
    const bar = document.querySelector<HTMLElement>('header[aria-label="Transport"]')!;
    const panel = document.querySelector<HTMLElement>('section[aria-labelledby="part-title"]')!;
    const grid = document.querySelector<HTMLElement>('[aria-label^="Clip pads"]')!;

    // Mute All, engaged: the deep coral key with its white MUTED.
    const muteAll = named(/^(Mute All|MUTED)$/, bar);
    expect(muteAll?.getAttribute('aria-pressed')).toBe('true');
    await expectOnLookHolds('Mute All', muteAll);

    // The part's Mute and Solo on the pads' column headers, and in the part panel.
    await expectOnLookHolds('Mute (pads)', named(`Mute ${drums.name}`, grid));
    await expectOnLookHolds('Solo (pads)', named(`Solo ${bass.name}`, grid));
    const panelMute = panel.querySelector<HTMLElement>('button[data-kind="mute"]');
    expect(panelMute?.getAttribute('aria-pressed')).toBe('true');
    await expectOnLookHolds('Mute (part panel)', panelMute);
    await expectOnLookHolds('Keep pattern (part panel)', named('Pattern kept', panel));
    act(() => selectTrack(bass.id));
    await settle();
    const panelSolo = panel.querySelector<HTMLElement>('button[data-kind="solo"]');
    expect(panelSolo?.getAttribute('aria-pressed')).toBe('true');
    await expectOnLookHolds('Solo (part panel)', panelSolo);

    // The metronome: the recording options key keeps its lit lamp (its outline may answer the pointer); the switch inside keeps "On".
    const metronomeKey = bar.querySelector<HTMLElement>('button[aria-label^="Recording options"]');
    expect(metronomeKey?.hasAttribute('data-on')).toBe(true);
    await expectOnLookHolds('Metronome key', metronomeKey, { text: false, lampOnly: true });
    await real(() => userEvent.click(metronomeKey!));
    await settle();
    const metronome = [...document.querySelectorAll<HTMLElement>('[role="switch"]')].find((s) => s.textContent?.includes('Metronome'));
    expect(metronome?.getAttribute('aria-checked')).toBe('true');
    await expectOnLookHolds('Metronome switch', metronome!, { text: false, lampOnly: true });
    const state = [...metronome!.querySelectorAll('span')].find((s) => s.textContent === 'On')!;
    expect(worstContrast(state), 'Metronome switch: "On"').toBeGreaterThanOrEqual(4.5);
    await real(() => userEvent.keyboard('{Escape}'));

    // Song: Loop (teal, pressed while the song loops) and Follow.
    act(() => setView('arrange'));
    await settle(150);
    act(() => {
      (session as unknown as { setSongLoop(l: { fromBar: number; toBar: number }): boolean }).setSongLoop({ fromBar: 0, toBar: 8 });
    });
    await settle();
    const loop = document.querySelector<HTMLElement>('[data-testid="loop-toggle"]');
    expect(loop?.getAttribute('aria-pressed')).toBe('true');
    await expectOnLookHolds('Loop', loop);
    let follow = named('Follow');
    if (follow?.getAttribute('aria-pressed') !== 'true') {
      await real(() => userEvent.click(follow!));
      follow = named('Follow');
    }
    expect(follow?.getAttribute('aria-pressed')).toBe('true');
    await expectOnLookHolds('Follow', follow);

    // Mix: the strips' Mute and Solo.
    act(() => setView('mix'));
    await settle(150);
    const mixMute = [...document.querySelectorAll<HTMLElement>('main button[aria-pressed="true"]')].find((b) => /Mute/.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
    const mixSolo = [...document.querySelectorAll<HTMLElement>('main button[aria-pressed="true"]')].find((b) => /Solo/.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
    await expectOnLookHolds('Mute (Mix)', mixMute ?? null);
    await expectOnLookHolds('Solo (Mix)', mixSolo ?? null);
  });
});

/* ------------------------------------------------------------------ */
/* Layout stability, scene counts, the selected pad's name             */
/* ------------------------------------------------------------------ */

/** Page positions of every pad, the part panel's controls and the transport's keys. */
function boxes(): Map<string, string> {
  const out = new Map<string, string>();
  const sel = ['[data-pad-cell]', '[aria-label^="Clip pads"] button', 'section[aria-labelledby="part-title"] button', 'section[aria-labelledby="part-title"] [role="slider"]', 'header[aria-label="Transport"] button'];
  let i = 0;
  for (const s of sel) {
    for (const el of document.querySelectorAll<HTMLElement>(s)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      // The transport stays at the top while a zoomed page scrolls; everything else in page coordinates.
      const sticky = !!el.closest('header[aria-label="Transport"]');
      const y = sticky ? r.top : r.top + window.scrollY;
      // Keyed by place in the page (names change with the state: "…, Muted", "Undo Mute Drums").
      out.set(`${s} #${i++}`, `${[r.left, y, r.width, r.height].map((v) => v.toFixed(1)).join(',')} ${el.getAttribute('aria-label') ?? el.textContent?.slice(0, 20)}`);
    }
  }
  return out;
}

function moved(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = [];
  const box = (v: string | undefined) => v?.split(' ')[0];
  for (const [k, v] of a) if (box(b.get(k)) !== box(v)) out.push(`${k}: ${v} -> ${b.get(k)}`);
  return out;
}

describe('Mute and Solo never move anything', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
    [960, 540],
  ] as const) {
    it(`at ${w} x ${hh}: pads, part panel and transport keep every box`, async () => {
      await openApp(w, hh);
      const tracks = session.store.getState().tracks;
      act(() => {
        selectTrack(tracks[3].id);
        selectSlot(tracks[3].id, 1);
      });
      await settle();
      const flip = async (fn: () => void) => {
        act(fn);
        // Autosave runs after an edit: "Saving…" must not move the keys beside it either.
        await settle(120);
      };
      const before = boxes();
      // Mute a part, then solo another (every other column says "Not soloed"), then the selected part's own Mute.
      await flip(() => session.setMute(tracks[0].id, true));
      expect(moved(before, boxes()), 'Mute').toEqual([]);
      await flip(() => session.setSolo(tracks[2].id, true));
      expect(moved(before, boxes()), 'Solo').toEqual([]);
      await flip(() => session.setMute(tracks[3].id, true));
      expect(moved(before, boxes()), 'Mute on the selected part').toEqual([]);
      await flip(() => {
        session.setMute(tracks[0].id, false);
        session.setSolo(tracks[2].id, false);
        session.setMute(tracks[3].id, false);
      });
      expect(moved(before, boxes()), 'back').toEqual([]);
      // The words are there.
      await flip(() => session.setSolo(tracks[2].id, true));
      const panel = document.querySelector<HTMLElement>('section[aria-labelledby="part-title"]')!;
      expect(panel.textContent).toContain('Not soloed');
      await flip(() => session.setSolo(tracks[2].id, false));
    });
  }
});

describe('scene buttons count parts as Arrange does', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1024, 768],
    [960, 540],
  ] as const) {
    it(`at ${w} x ${hh}: "4 parts", "1 part", never "4/8", whole on screen; the tip says "4 of 8 parts"`, async () => {
      await openApp(w, hh);
      const p = session.store.getState();
      const scenes = [...document.querySelectorAll<HTMLElement>('button[data-scene]')];
      expect(scenes.length).toBe(4);
      scenes.forEach((b, row) => {
        const n = p.tracks.filter((t) => !!t.clips[row]).length;
        const words = n === 1 ? '1 part' : `${n} parts`;
        expect(b.textContent).toContain(words);
        expect(b.textContent).not.toMatch(/\d\/8/);
        const count = [...b.querySelectorAll<HTMLElement>('span')].find((s) => s.textContent === words)!;
        expect(count.scrollWidth, `${w}: "${words}" cut`).toBeLessThanOrEqual(count.clientWidth + 0.5);
        expect(count.getBoundingClientRect().right, `${w}: "${words}" inside its button`).toBeLessThanOrEqual(b.getBoundingClientRect().right + 0.5);
        // The full meaning is in the tip (read out as its description).
        const tip = (b.getAttribute('aria-describedby') ?? '')
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
        expect(tip).toContain(`${n} of ${p.tracks.length} parts`);
      });
    });
  }
});

describe("the selected pad's name beside its '⋯'", () => {
  for (const [w, hh] of [
    [1366, 768],
    [960, 540],
  ] as const) {
    it(`at ${w} x ${hh} uses two lines instead of cutting a two-word name`, async () => {
      await openApp(w, hh);
      const p = session.store.getState();
      // A two-word name a pad's first line cannot hold beside the '⋯'.
      let at: { trackId: string; slot: number; name: string } | null = null;
      for (const t of p.tracks) t.clips.forEach((c, slot) => !at && c && /^\S+ \S+$/.test(c.name) && c.name.length >= 9 && (at = { trackId: t.id, slot, name: c.name }));
      expect(at, 'a two-word clip name').not.toBeNull();
      const { trackId, slot, name } = at!;
      act(() => {
        selectTrack(trackId);
        selectSlot(trackId, slot);
      });
      await settle();
      const pad = document.getElementById(`pad-${trackId}-${slot}`)!;
      pad.scrollIntoView({ block: 'center' });
      await settle();
      const label = [...pad.querySelectorAll<HTMLElement>('span')].find((s) => s.children.length === 0 && s.textContent === name)!;
      const more = pad.closest('[data-pad-cell]')!.querySelector<HTMLElement>('button[aria-haspopup="menu"]')!;
      // Every word whole: nothing clipped sideways or below the second line.
      expect(label.scrollWidth, 'name cut sideways').toBeLessThanOrEqual(label.clientWidth + 0.5);
      expect(label.scrollHeight, 'name cut below').toBeLessThanOrEqual(label.clientHeight + 0.5);
      const range = document.createRange();
      range.selectNodeContents(label.firstChild!);
      const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
      expect(lines.size, 'two lines').toBe(2);
      // Neither line runs under the '⋯', and the state word below stays clear of the name.
      const m = more.getBoundingClientRect();
      for (const r of range.getClientRects()) expect(r.right <= m.left + 0.5 || r.top >= m.bottom - 0.5, 'a line under the ⋯').toBe(true);
      const caption = [...pad.querySelectorAll<HTMLElement>('span')].find((s) => s.children.length === 0 && /^(Ready|Playing|Next bar)$/.test(s.textContent ?? ''));
      if (caption) expect(caption.getBoundingClientRect().top).toBeGreaterThanOrEqual(label.getBoundingClientRect().bottom - 0.5);
      // A pad that is not selected keeps its name on one line with its length under it.
      act(() => selectSlot(trackId, (slot + 1) % 4));
      await settle();
      expect(pad.textContent).toContain(name);
    });
  }
});
