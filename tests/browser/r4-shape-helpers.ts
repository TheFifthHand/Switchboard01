/**
 * Shared set-up for the round-4 Shape tests: the Shape view (with the app's
 * theme, tips and toasts) on the House starter at a given window size, real
 * pointer and keyboard input sent through the browser (CDP), and offline
 * renders of one part soloed, measured.
 */
import { act, createElement as h } from 'react';
import { page, userEvent } from 'vitest/browser';
import '../../src/ui/theme.css';
import { TipsProvider, ToastProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { ShapeView } from '../../src/app/views/shape/ShapeView';
import { forgetScrolls, setAdvancedTab } from '../../src/app/views/shape/shapeLayout';
import { AudioEngine } from '../../src/audio/engine';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { HOUSE } from '../../src/content/starters/house';
import type { Id, Project } from '../../src/project/types';
import { renderOffline } from '../../src/render/offline';
import { spectralCentroid } from '../../src/render/analysis';
import { selectModule, selectTrack, setCablesOpen, setEffectClipboard, setUiMode, setView, type UiMode } from '../../src/state/uiStore';
import { centre, mouse, settleFrames, type Pt } from './r4-uikit-input';
import { cleanup, mount, type Mounted } from './ui-harness';

export const SR = 48000;

export const project = (): Project => session.store.getState();
export const track = (id: Id) => project().tracks.find((t) => t.id === id)!;
export const mod = (id: Id) => project().patch.modules.find((m) => m.id === id);
export const notice = () => runtimeStore.getState().notice?.text ?? '';

/** The Shape view alone (with tips off unless asked, toasts on) at `w` x `hh`, on `p` (default: the House starter). */
export async function openShape(opts: { w?: number; hh?: number; mode?: UiMode; trackId?: Id; project?: Project; tips?: boolean } = {}): Promise<Mounted> {
  const w = opts.w ?? 1366;
  const hh = opts.hh ?? 768;
  await page.viewport(w, hh);
  window.scrollTo(0, 0);
  act(() => {
    session.store.setLock(null);
    session.store.replace(opts.project ?? HOUSE.build());
    selectTrack(opts.trackId ?? 't4');
    setCablesOpen(false);
    selectModule(null);
    setEffectClipboard(null);
    setAdvancedTab('macros');
    setView('shape');
    setUiMode(opts.mode ?? 'simple');
    patchRuntime({ notice: null });
  });
  forgetScrolls();
  const m = mount(h(TipsProvider, { enabled: opts.tips ?? false }, h(ToastProvider, null, h(ShapeView))), { width: w });
  m.container.style.padding = '0';
  m.container.style.width = `${w}px`;
  // The view fills the window below where the app's transport would be (the keyboard strip is not part of this view).
  m.container.style.height = `${hh - 160}px`;
  await act(async () => {
    await document.fonts.ready;
  });
  await settleFrames(3);
  return m;
}

export function closeShape(): void {
  cleanup();
  session.store.setLock(null);
  act(() => {
    setUiMode('simple');
    setCablesOpen(false);
    patchRuntime({ notice: null });
  });
}

/** Trusted input runs outside React's act(). */
async function real<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    return await fn();
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
}

/** Real keys (Playwright's keyboard) to whatever has focus. */
export async function press(keys: string): Promise<void> {
  await real(() => userEvent.keyboard(keys));
  await settleFrames();
}

/** Focus an element (scrolled into view) and press real keys on it. */
export async function keysOn(el: Element, keys: string): Promise<void> {
  (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' });
  act(() => (el as HTMLElement).focus());
  await press(keys);
}

/** A real mouse click in the middle of `el` (scrolled into view first). */
export async function clickEl(el: Element | null, opts: { at?: Pt; button?: 'left' | 'right'; clickCount?: number; modifiers?: number } = {}): Promise<void> {
  if (!el) throw new Error('nothing to click');
  (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' });
  await settleFrames();
  const p = opts.at ?? centre(el);
  if (opts.button === 'right') {
    const { send, toPage } = await import('./r4-uikit-input');
    const q = toPage(p);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: q.x, y: q.y, button: 'none', buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: q.x, y: q.y, button: 'right', buttons: 2, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: q.x, y: q.y, button: 'right', buttons: 0, clickCount: 1 });
  } else {
    const n = opts.clickCount ?? 1;
    await mouse('mouseMoved', p);
    for (let i = 1; i <= n; i++) {
      await mouse('mousePressed', p, { clickCount: i, modifiers: opts.modifiers });
      await mouse('mouseReleased', p, { clickCount: i, modifiers: opts.modifiers });
    }
  }
  await settleFrames();
}

/** A real vertical mouse drag on a knob: `dy` px upwards (negative: down), in steps a frame apart. */
export async function dragKnob(el: Element, dy: number, steps = 8): Promise<void> {
  (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' });
  await settleFrames();
  const a = centre(el, 0.5, 0.3);
  await mouse('mouseMoved', a);
  await mouse('mousePressed', a);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', { x: a.x, y: a.y - (dy * i) / steps }, { buttons: 1 });
    await new Promise((r) => requestAnimationFrame(r));
  }
  await mouse('mouseReleased', { x: a.x, y: a.y - dy });
  await settleFrames();
}

/** A slider (knob) by its accessible name, inside `root`. */
export function slider(root: ParentNode, name: string | RegExp): HTMLElement {
  const all = [...root.querySelectorAll<HTMLElement>('[role="slider"]')];
  const el = all.find((x) => {
    const n = x.getAttribute('aria-label') ?? '';
    return typeof name === 'string' ? n === name : name.test(n);
  });
  if (!el) throw new Error(`No slider "${String(name)}" in: ${all.map((x) => x.getAttribute('aria-label')).join(' | ')}`);
  return el;
}

/** A button by its accessible name or text. */
export function button(name: string | RegExp, root: ParentNode = document): HTMLButtonElement {
  const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => {
    const n = (x.getAttribute('aria-label') ?? x.textContent ?? '').trim();
    return typeof name === 'string' ? n === name : name.test(n);
  });
  if (!b) throw new Error(`No button "${String(name)}"`);
  return b;
}

/** A menu row (in the open menu) by its text. */
export function menuItem(text: string | RegExp): HTMLButtonElement {
  const m = document.querySelector<HTMLElement>('[role="menu"]');
  if (!m) throw new Error('no menu open');
  const rows = [...m.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')];
  const found = rows.find((b) => (typeof text === 'string' ? (b.textContent ?? '').includes(text) : text.test(b.textContent ?? '')));
  if (!found) throw new Error(`no menu item ${String(text)} in: ${rows.map((r) => r.textContent).join(' | ')}`);
  return found;
}

/** The words a control's tooltip carries (aria-describedby). */
export function described(el: Element): string {
  return (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .map((id) => (id ? (document.getElementById(id)?.textContent ?? '') : ''))
    .join(' ');
}

export const card = (moduleId: Id) => document.getElementById(`simple-card-${moduleId}`) as HTMLElement;

/* ------------------------------------------------------------------ */
/* Offline renders                                                     */
/* ------------------------------------------------------------------ */

export interface Rendered {
  L: Float32Array;
  R: Float32Array;
}

/** The first scene row where a part has a clip (row 1, the groove, when it has one there). */
export function rowFor(p: Project, trackId: Id): number {
  const t = p.tracks.find((x) => x.id === trackId)!;
  if (t.clips[1]) return 1;
  const i = t.clips.findIndex((c) => !!c);
  return i < 0 ? 0 : i;
}

/** `p` with only `trackId` heard (solo), its scene played for `bars` bars, offline. */
export async function renderSolo(p: Project, trackId: Id, bars = 2): Promise<Rendered> {
  const q: Project = structuredClone(p);
  for (const t of q.tracks) {
    t.solo = t.id === trackId;
    t.mute = false;
  }
  const bank = new SampleBank(SR);
  const buf = await renderOffline({
    project: q,
    source: { kind: 'scene', row: rowFor(q, trackId), bars },
    sampleRate: SR,
    tailSeconds: 0.1,
    createEngine: (ctx) => AudioEngine.create(ctx, { samples: bank, seed: q.seed, meters: false }),
  });
  return { L: buf.getChannelData(0).slice(), R: buf.getChannelData(1).slice() };
}

/** Stereo RMS level in dB from the second half-bar on (the first attacks skipped). */
export function levelDb(x: Rendered): number {
  const from = Math.round(x.L.length / 8);
  let s = 0;
  for (let i = from; i < x.L.length; i++) s += x.L[i] * x.L[i] + x.R[i] * x.R[i];
  return 10 * Math.log10(s / (2 * (x.L.length - from)) + 1e-20);
}

export function mono(x: Rendered): Float32Array {
  const m = new Float32Array(x.L.length);
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * (x.L[i] + x.R[i]);
  return m;
}

export function centroid(x: Rendered): number {
  return spectralCentroid(mono(x), SR);
}

/** Difference of two renders (null test), dB relative to the first: −∞ when identical. */
export function nullDb(a: Rendered, b: Rendered): number {
  let d = 0;
  let s = 0;
  for (let i = 0; i < a.L.length; i++) {
    const x = a.L[i] - b.L[i];
    const y = a.R[i] - b.R[i];
    d += x * x + y * y;
    s += a.L[i] * a.L[i] + a.R[i] * a.R[i];
  }
  return 10 * Math.log10((d + 1e-30) / (s + 1e-30));
}

/** How much a change of `a` → `b` is heard: level change (dB) and spectral centroid change (fraction). */
export function heard(a: Rendered, b: Rendered): { db: number; centroid: number; text: string } {
  const la = levelDb(a);
  const lb = levelDb(b);
  const ca = centroid(a);
  const cb = centroid(b);
  const db = Math.abs(lb - la);
  const c = Math.abs(cb - ca) / Math.max(1, ca);
  return { db, centroid: c, text: `rms ${la.toFixed(1)} → ${lb.toFixed(1)} dB, centroid ${ca.toFixed(0)} → ${cb.toFixed(0)} Hz` };
}
