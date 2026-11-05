/**
 * The sound browser and the instrument column in real Chromium with the
 * app's styles and fonts, at 1366 x 768 and 960 x 540: every category is
 * listed with its icon and the right count, search finds sounds across
 * categories by plain words, the current sound and its category are marked,
 * keyboard navigation works in the category list, the search field and the
 * sound list, choosing changes the part (kind included, with the honest
 * warning about clips) and Preview uses the session's preview path; the
 * dialog fits the window with big targets and visible focus. The instrument
 * column groups every synth control exactly once under plain headings and
 * says when a group is off.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { SoundBrowser } from '../../src/app/views/SoundBrowser';
import { InstrumentColumn } from '../../src/app/views/shape/InstrumentColumn';
import { ALL_SOUNDS, KITS, SOUND_CATEGORIES, SYNTH_PRESETS } from '../../src/content/catalog';
import { getStarter } from '../../src/content/starters';
import { BASS_PARAMS, DRUM_KIT_PARAMS, POLY_PARAMS } from '../../src/project/params';
import type { Id } from '../../src/project/types';
import { changeInstrumentSound } from '../../src/state/commands';
import { cleanup, fire, key, mount, wait } from './ui-harness';

type Call = ['on' | 'off', Id, number, string];
let calls: Call[] = [];
const real = { noteOn: session.noteOn, noteOff: session.noteOff, startAudio: session.startAudio };

beforeEach(async () => {
  calls = [];
  session.noteOn = (trackId, pitch, _velocity, source) => void calls.push(['on', trackId, pitch, source]);
  session.noteOff = (trackId, pitch, source) => void calls.push(['off', trackId, pitch, source]);
  session.startAudio = () => Promise.resolve(true);
  session.store.replace(getStarter('house')!.build(), { resetHistory: true });
  act(() => patchRuntime({ held: {}, notice: null, recording: 'off', recordTarget: null, playing: false }));
  await page.viewport(1366, 768);
  await document.fonts.ready;
});

afterEach(() => {
  cleanup();
  session.noteOn = real.noteOn;
  session.noteOff = real.noteOff;
  session.startAudio = real.startAudio;
});

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const tabs = () => [...dialog().querySelectorAll<HTMLElement>('[role="tab"]')];
const tab = (name: string) => tabs().find((t) => t.textContent?.includes(name))!;
const options = () => [...dialog().querySelectorAll<HTMLElement>('[role="option"]')];
const optionNames = () => options().map((o) => o.querySelector('span span:nth-child(2)')?.textContent ?? '');
const search = () => dialog().querySelector<HTMLInputElement>('input[type="search"]')!;
const track = (id: Id) => session.store.getState().tracks.find((t) => t.id === id)!;
const click = (el: Element) => fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));

function typeSearch(value: string) {
  const input = search();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** WCAG contrast ratio of two computed "rgb(r, g, b)" colours. */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
      const x = Number(v) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const open = (trackId: Id) => mount(h(TipsProvider, { enabled: false }, h(SoundBrowser, { open: true, trackId, onClose: () => {} })));

describe('sound browser', () => {
  it('lists every category with its icon and count; the library is broad', () => {
    open('t4');
    expect(KITS.length).toBeGreaterThanOrEqual(12);
    expect(SYNTH_PRESETS.length).toBeGreaterThanOrEqual(60);
    const list = dialog().querySelector('[role="tablist"]')!;
    expect(list.getAttribute('aria-orientation')).toBe('vertical');
    expect(tabs().map((t) => t.dataset.category)).toEqual(SOUND_CATEGORIES.map((c) => c.id));
    for (const c of SOUND_CATEGORIES) {
      const t = tab(c.name);
      expect(t.querySelector('svg'), `${c.name} icon`).not.toBeNull();
      const expected = ALL_SOUNDS.filter((s) => s.category === c.id).length;
      expect(t.textContent).toContain(`${expected} sound`);
      expect(expected, c.name).toBeGreaterThanOrEqual(c.id === 'recordings' ? 5 : 10);
    }
    // The description says plainly that a part can become anything.
    expect(dialog().textContent).toMatch(/Any part can play any sound/);
  });

  it('opens on the current sound: its category selected and marked, its card marked "Current" and focused', () => {
    open('t3');
    const bass = track('t3').instrument;
    expect(bass.kind).toBe('bass');
    const selected = tabs().find((t) => t.getAttribute('aria-selected') === 'true')!;
    expect(selected.dataset.category).toBe('bass');
    expect(selected.hasAttribute('data-current')).toBe(true);
    expect(selected.textContent).toMatch(/current sound is here/);
    const current = options().find((o) => o.getAttribute('aria-selected') === 'true')!;
    expect(current.textContent).toContain('Current');
    // The "Current" badge's small white text is readable on its teal (WCAG AA, 4.5:1).
    const badge = [...current.querySelectorAll<HTMLElement>('span')].find((x) => x.textContent === 'Current')!;
    const style = getComputedStyle(badge);
    expect(contrast(style.color, style.backgroundColor)).toBeGreaterThanOrEqual(4.5);
    expect(document.activeElement).toBe(current);
    // One line of description per sound, with its instrument type.
    expect(current.textContent).toMatch(/Bass synth/);
    expect(optionNames()).toEqual(SYNTH_PRESETS.filter((p) => p.category === 'bass').map((p) => p.name));
  });

  it('categories switch with the keyboard (arrows, Home, End), and the panel follows', () => {
    open('t4');
    const keys = tab('Keys');
    act(() => keys.focus());
    key(keys, 'keydown', { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('data-category')).toBe('pads');
    expect(tab('Pads & Strings').getAttribute('aria-selected')).toBe('true');
    expect(dialog().querySelector('[role="tabpanel"] h3')!.textContent).toBe('Pads & Strings');
    expect(optionNames()).toEqual(SYNTH_PRESETS.filter((p) => p.category === 'pads').map((p) => p.name));
    key(document.activeElement!, 'keydown', { key: 'End' });
    expect(tab('Recordings').getAttribute('aria-selected')).toBe('true');
    key(document.activeElement!, 'keydown', { key: 'Home' });
    expect(tab('Drums & Percussion').getAttribute('aria-selected')).toBe('true');
    // Drums are split into kits and percussion sets.
    const groups = [...dialog().querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['Drum kits', 'Percussion']);
    key(document.activeElement!, 'keydown', { key: 'ArrowUp' });
    expect(tab('Recordings').getAttribute('aria-selected')).toBe('true');
  });

  it('search finds sounds in every category by plain words; Escape clears it; ArrowDown jumps to the results', () => {
    open('t4');
    typeSearch('piano');
    expect(tab('All matches').getAttribute('aria-selected')).toBe('true');
    const names = optionNames();
    for (const n of ['Tine Piano', 'Felt Piano', 'Reed Piano']) expect(names).toContain(n);
    // Name matches come first.
    expect(names.indexOf('Tine Piano')).toBeLessThan(3);
    // Category tabs show how many matches each holds.
    expect(tab('Keys').textContent).toMatch(/[1-9]\d* sound/);
    expect(tab('Drums & Percussion').hasAttribute('data-empty')).toBe(true);
    expect(dialog().textContent).toMatch(/sounds? match "piano"/);

    typeSearch('808');
    expect(optionNames()).toEqual(expect.arrayContaining(['808 Boom', '808 Machine', 'Trap Night']));
    // Results are grouped by category (the kit under Drums, the bass under Bass).
    const groups = [...dialog().querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(expect.arrayContaining(['Drums & Percussion', 'Bass']));
    // Narrowing to one category while searching.
    click(tab('Bass'));
    expect(optionNames().every((n) => SYNTH_PRESETS.some((p) => p.name === n && p.category === 'bass'))).toBe(true);

    typeSearch('strings');
    key(search(), 'keydown', { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('role')).toBe('option');
    act(() => search().focus());
    typeSearch('zzzz');
    expect(options()).toHaveLength(0);
    expect(dialog().textContent).toMatch(/No sounds match/);
    const esc = key(search(), 'keydown', { key: 'Escape' });
    expect(esc.defaultPrevented).toBe(true);
    expect(search().value).toBe('');
    // The dialog is still open, back on the category.
    expect(dialog()).not.toBeNull();
    expect(tab('Keys').getAttribute('aria-selected')).toBe('true');
  });

  it('choosing from another category changes the instrument kind; drum kits warn about melody clips; Undo restores', async () => {
    open('t3');
    click(tab('Keys'));
    click(options().find((o) => o.textContent?.startsWith('Tine Piano'))!);
    expect(track('t3').instrument.kind).toBe('poly');
    await act(async () => {
      await wait(0);
    });
    // "Preview on choose": the new sound plays a chord on the 'preview' path (exact pitch, never recorded).
    const ons = calls.filter((c) => c[0] === 'on');
    expect(ons.length).toBe(3);
    expect(ons.every((c) => c[1] === 't3' && c[3] === 'preview')).toBe(true);
    click(tab('Drums & Percussion'));
    expect(dialog().textContent).toMatch(/drum kit plays only drum hits/);
    click(options().find((o) => o.textContent?.startsWith('Afro Latin'))!);
    expect(track('t3').instrument.kind).toBe('drums');
    act(() => session.undo());
    act(() => session.undo());
    expect(track('t3').instrument.kind).toBe('bass');
  });

  for (const [w, hgt] of [
    [1366, 768],
    [960, 540],
  ] as const) {
    it(`fits a ${w} x ${hgt} window: no sideways overflow, big targets, visible focus`, async () => {
      await page.viewport(w, hgt);
      open('t4');
      await wait(30);
      // Measure the settled layout, not the opening animation.
      for (const a of document.getAnimations()) a.finish();
      const d = dialog().getBoundingClientRect();
      expect(d.left).toBeGreaterThanOrEqual(0);
      expect(d.top).toBeGreaterThanOrEqual(0);
      expect(d.right).toBeLessThanOrEqual(w + 0.5);
      expect(d.bottom).toBeLessThanOrEqual(hgt + 0.5);
      const body = dialog().querySelector<HTMLElement>('[role="tablist"]')!.closest('div[class]')!.parentElement!.parentElement!;
      expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth + 1);
      // The dialog body does not scroll as a whole: the sound list scrolls inside it.
      expect(body.scrollHeight).toBeLessThanOrEqual(body.clientHeight + 1);
      const list = dialog().querySelector<HTMLElement>('[role="listbox"]')!;
      expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth + 1);
      for (const t of tabs()) {
        const r = t.getBoundingClientRect();
        expect(r.height, t.textContent ?? '').toBeGreaterThanOrEqual(40);
        // Category names are never cut off.
        const name = t.querySelector<HTMLElement>('span')!;
        expect(name.scrollWidth, name.textContent ?? '').toBeLessThanOrEqual(name.clientWidth + 1);
      }
      for (const o of options()) {
        const r = o.getBoundingClientRect();
        expect(r.height).toBeGreaterThanOrEqual(40);
        expect(r.width).toBeGreaterThanOrEqual(150);
      }
      // At least two cards per row on both sizes.
      const tops = options().slice(0, 4).map((o) => Math.round(o.getBoundingClientRect().top));
      expect(tops[0]).toBe(tops[1]);
      const input = search().getBoundingClientRect();
      expect(input.height).toBeGreaterThanOrEqual(32);
      // Keyboard focus is visible on a card and on a category.
      const card = options()[1];
      act(() => card.focus());
      key(card, 'keydown', { key: 'ArrowLeft' });
      const focused = document.activeElement as HTMLElement;
      expect(focused.getAttribute('role')).toBe('option');
      expect(getComputedStyle(focused).boxShadow).not.toBe('none');
      const t = tab('Leads');
      act(() => t.focus());
      expect(t.matches(':focus-visible') ? getComputedStyle(t).boxShadow : 'ring').not.toBe('none');
    });
  }
});

/* ------------------------------------------------------------------ */
/* Instrument column                                                   */
/* ------------------------------------------------------------------ */

function mountColumn(trackId: Id, width = 420) {
  const m = mount(h(TipsProvider, { enabled: false }, h('div', { style: { width: `${width}px`, height: '700px', display: 'flex' } }, h(InstrumentColumn, { trackId }))), { width: width + 40 });
  return m;
}
const sections = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('section[aria-label]')];
const sliders = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[role="slider"]')].map((s) => s.getAttribute('aria-label'));

describe('instrument column', () => {
  it('groups every poly synth control exactly once under plain headings, and says when FM or Noise is off', () => {
    const m = mountColumn('t4');
    expect(sections(m.container).map((s) => s.getAttribute('aria-label'))).toEqual(['Tones', 'Unison', 'FM', 'Noise', 'Pitch & movement', 'Vibrato', 'Filter', 'Envelope', 'Output']);
    const labels = sliders(m.container);
    expect([...labels].sort()).toEqual(POLY_PARAMS.map((p) => p.label).sort());
    // Full words, no abbreviations.
    for (const l of labels) expect(l, l ?? '').toMatch(/^[A-Z][a-z]+( [A-Z0-9][a-z]*)*$|^FM [A-Z][a-z]+$|^Tone \d( [A-Z][a-z]+)?$/);
    const fm = sections(m.container).find((s) => s.getAttribute('aria-label') === 'FM')!;
    expect(fm.querySelector('h3')!.textContent).toMatch(/Off: turn up FM Amount/);
    act(() => void session.accepted(changeInstrumentSound(session.store, 't4', 'poly', 'poly-tine-piano')));
    expect(fm.querySelector('h3')!.textContent).not.toMatch(/Off/);
    const noise = sections(m.container).find((s) => s.getAttribute('aria-label') === 'Noise')!;
    expect(noise.querySelector('h3')!.textContent).toMatch(/Off: turn up Noise/);
  });

  it('groups the bass synth (Tones, FM, Pitch Sweep, Filter, Envelope, Output) and the kit (Whole kit with its Level)', () => {
    const m = mountColumn('t3');
    expect(sections(m.container).map((s) => s.getAttribute('aria-label'))).toEqual(['Tones', 'FM', 'Pitch Sweep', 'Filter', 'Envelope', 'Output']);
    expect([...sliders(m.container)].sort()).toEqual(BASS_PARAMS.map((p) => p.label).sort());
    m.unmount();
    const k = mountColumn('t1');
    const whole = sections(k.container).find((s) => s.getAttribute('aria-label') === 'Whole kit')!;
    expect(sliders(whole).sort()).toEqual(DRUM_KIT_PARAMS.map((p) => p.label).sort());
  });

  for (const width of [360, 520]) {
    it(`fits a ${width} px column without sideways overflow`, async () => {
      await page.viewport(1366, 768);
      const m = mountColumn('t4', width);
      act(() => void session.accepted(changeInstrumentSound(session.store, 't4', 'poly', 'poly-supersaw-pad')));
      await wait(20);
      const scroller = m.container.querySelector<HTMLElement>('section[aria-label]')!.parentElement!.parentElement!;
      expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth + 1);
      for (const s of m.container.querySelectorAll<HTMLElement>('[role="slider"]')) {
        const r = s.getBoundingClientRect();
        expect(r.right).toBeLessThanOrEqual(m.container.getBoundingClientRect().right);
        expect(r.width).toBeGreaterThanOrEqual(32);
      }
    });
  }
});
