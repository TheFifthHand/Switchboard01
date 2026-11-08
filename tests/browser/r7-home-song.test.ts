/**
 * Round 7: the Song screen as the home (Simple mode), in the running app with
 * a real mouse: the header ("Your song · 1:04", Repeat this part, Make it
 * longer, + Add instrument), rows only for instruments with music, a click
 * on a loop opening the editor, a row's name opening its Sound panel, the
 * tip line, and an edge drag over other music saying what it replaced.
 * Advanced keeps 2.4's header and every row.
 */
import type { AxeResults } from 'axe-core';
import axeSource from 'axe-core/axe.min.js?raw';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { browserTabStore } from '../../src/app/views/arrange/LoopBrowser';
import { editorStore } from '../../src/app/views/arrange/editorStore';
import { libraryQueryStore } from '../../src/app/views/arrange/library/LibraryPanel';
import { closeSound, sidePanelStore } from '../../src/app/views/arrange/sidePanelStore';
import { songClock } from '../../src/app/views/arrange/songHome';
import { regionEnd, sectionAt } from '../../src/project/arrangement';
import { setTipsEnabled, setUiMode } from '../../src/state/uiStore';
import {
  centre,
  clickAt,
  clipOf,
  dragTo,
  edge,
  menuItem,
  on,
  openSong,
  project,
  region,
  regions,
  resetSong,
  rt,
  sections,
  setSong,
  settle,
  teardownSong,
  trackId,
  undoCount,
} from './r5-song-helpers';

const SHOTS = '/tmp/claude-0/r7/shots-songhome';

interface AxeApi {
  run(context: Element, options: Record<string, unknown>): Promise<AxeResults>;
}
async function audit(root: Element): Promise<string[]> {
  const w = window as unknown as { axe?: AxeApi };
  if (!w.axe) {
    const script = document.createElement('script');
    script.textContent = axeSource;
    document.head.appendChild(script);
  }
  const r = await w.axe!.run(root, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const rowIds = () => [...document.querySelectorAll<HTMLElement>('[data-lane-row]')].map((el) => el.dataset.laneRow!);
const notice = () => rt().notice?.text ?? '';

/** A song with music on Drums and Percussion only (sections Intro 0–8, Groove 8–16). */
function drumsOnly(): void {
  const drums = trackId('Drums');
  const perc = trackId('Percussion');
  setSong(
    [region('d1', drums, clipOf(0, 0).id, 0, 8), region('d2', drums, clipOf(0, 1).id, 8, 8), region('p1', perc, clipOf(1, 1).id, 8, 8)],
    [
      { id: 'sIntro', name: 'Intro', start: 0, bars: 8 },
      { id: 'sGroove', name: 'Groove', start: 8, bars: 8 },
    ],
  );
}

beforeEach(async () => {
  await resetSong('simple');
  act(() => closeSound());
});
afterEach(async () => {
  act(() => {
    closeSound();
    editorStore.setState(null);
    libraryQueryStore.setState(null);
    browserTabStore.setState(null);
  });
  await teardownSong();
});

describe('the header', () => {
  it('says how long the song is in minutes and seconds, and repeats the part under the playhead', async () => {
    await openSong(1366, 768);
    const len = byTestId('song-length')!;
    expect(document.getElementById('song-title')!.textContent).toBe('Your song');
    expect(len.textContent).toBe(`· ${songClock(project())}`);
    expect(len.getAttribute('aria-label')).toMatch(/^Your song is \d+ (minute|second)/);
    // No bars, no BPM in Simple's header.
    expect(document.querySelector('header[data-simple]')!.textContent).not.toMatch(/bars|BPM/);

    // The playhead in Groove (bar 9): Repeat this section names it and repeats exactly it.
    act(() => session.setSongCursor(10));
    await settle();
    const repeat = byTestId('repeat-part')!;
    expect(repeat.textContent).toBe('Repeat this section: Groove');
    await clickAt(centre(repeat));
    const g = sectionAt(sections(), 10)!;
    expect(rt().songLoop).toEqual({ fromBar: g.start, toBar: regionEnd(g) });
    expect(repeat.getAttribute('aria-pressed')).toBe('true');
    expect(repeat.textContent).toBe('Repeating: Groove');
    // Pressed again: off.
    await clickAt(centre(repeat));
    expect(rt().songLoop).toBeNull();
    expect(repeat.textContent).toBe('Repeat this section: Groove');
  });

  it('keeps 2.4’s header in Advanced', async () => {
    await openSong(1366, 768);
    act(() => setUiMode('advanced'));
    await settle();
    expect(document.getElementById('song-title')!.textContent).toBe('Song');
    expect(byTestId('song-length')!.textContent).toMatch(/^\d+ bars · \d+:\d\d$/);
    for (const id of ['loop-toggle', 'follow', 'shape-song', 'loops-toggle']) expect(byTestId(id), id).not.toBeNull();
    expect(byTestId('repeat-part')).toBeNull();
    expect(byTestId('make-longer')).toBeNull();
    expect(byTestId('add-instrument')).toBeNull();
    expect(byTestId('song-tip')).toBeNull();
  });
});

describe('Make it longer', () => {
  it('adds parts with plain names, each one undo step, by repeating the music', async () => {
    await openSong(1366, 768, (p) => p);
    drumsOnly();
    act(() => session.setSongCursor(9));
    await settle();
    const before = project().arrangement.regions.length;
    const steps = undoCount();
    const names: string[] = [];
    for (let i = 0; i < 4; i++) {
      await clickAt(centre(byTestId('make-longer')!));
      await clickAt(centre(menuItem('Add a section after')));
      const made = sections().filter((s) => !['sIntro', 'sGroove'].includes(s.id)).map((s) => s.name);
      names.push(made.find((n) => !names.includes(n))!);
      expect(undoCount()).toBe(steps + i + 1);
      // Each new part plays Groove's music (the main part) and goes after the last of them, so the names run in order.
      expect(notice()).toMatch(/^Added (Verse|Chorus|Bridge)( 2)? after (Groove|Verse|Chorus|Bridge): it plays the music of Groove/);
    }
    expect(names).toEqual(['Verse', 'Chorus', 'Bridge', 'Verse 2']);
    // Each new part plays the same music as Groove (2 loops, 8 bars each).
    expect(regions().length).toBe(before + 2 * 4);
    expect(songClock(project())).not.toBe('0:15');

    await clickAt(centre(byTestId('make-longer')!));
    await clickAt(centre(menuItem('Repeat Groove again')));
    expect(sections().filter((s) => s.name === 'Groove').length).toBe(2);
    await clickAt(centre(byTestId('make-longer')!));
    await clickAt(centre(menuItem('Add an intro')));
    await clickAt(centre(byTestId('make-longer')!));
    await clickAt(centre(menuItem('Add an intro')));
    // Never two new intros with the same name.
    expect(sections().map((s) => s.name).filter((n) => n.startsWith('Intro'))).toEqual(['Intro 3', 'Intro 2', 'Intro']);
    // Undo takes back exactly the last step.
    const n = sections().length;
    act(() => session.undo());
    expect(sections().length).toBe(n - 1);
  });
});

describe('rows', () => {
  it('shows only instruments with music in Simple, every part in Advanced', async () => {
    await openSong(1366, 768);
    drumsOnly();
    await settle();
    expect(rowIds()).toEqual([trackId('Drums'), trackId('Percussion')]);
    act(() => setUiMode('advanced'));
    await settle();
    expect(rowIds().length).toBe(8);
    act(() => setUiMode('simple'));
    await settle();
    expect(rowIds().length).toBe(2);
    // Mute and Solo are there for the keyboard and the pointer (shown on hover / focus).
    expect(document.querySelectorAll('[data-lane-row] [data-kind="mute"]').length).toBe(2);
  });

  it('+ Add instrument offers the hidden ones by name and plays the first loop of that kind at once', async () => {
    await openSong(1366, 768);
    drumsOnly();
    act(() => session.setSongCursor(9));
    await settle();
    await clickAt(centre(byTestId('add-instrument')!));
    const offered = [...document.querySelectorAll('[role="menu"] [role="menuitem"] [class*="itemText"]')].map((x) => x.textContent);
    expect(offered).toEqual(['Bass', 'Keys & chords', 'Melody', 'Pad', 'Texture', 'Recording']);
    const steps = undoCount();
    await clickAt(centre(menuItem('Bass')));
    await settle(200);
    const bass = trackId('Bass');
    const added = regions().filter((r) => r.trackId === bass);
    // Over the whole of Groove (bars 9–16), one undo step, said with Undo.
    expect(added.length).toBe(1);
    expect([added[0].start, added[0].bars]).toEqual([8, 8]);
    expect(undoCount()).toBe(steps + 1);
    expect(rt().notice?.action).toBe('undo');
    expect(notice()).toMatch(/^Added Bass: it plays “.+” in Groove\. Try other bass loops in Loops\.$/);
    expect(rowIds()).toContain(bass);
    // LOOPS shows bass loops; the song plays from where it went.
    expect(libraryQueryStore.getState()?.role).toBe('bass');
    expect(browserTabStore.getState()?.tab).toBe('library');
    expect(rt().mode).toBe('song');
    expect(rt().playing).toBe(true);
    act(() => session.stop());
    // The tip moved on: there is more than drums now.
    act(() => session.undo());
    await settle();
    expect(regions().some((r) => r.trackId === bass)).toBe(false);
    expect(rowIds()).not.toContain(bass);
  });
});

describe('loops and sounds', () => {
  it('opens the editor on a single click in Simple (a drag still moves; Advanced keeps double-click)', async () => {
    await openSong(1366, 768);
    drumsOnly();
    await settle();
    await clickAt(on('d2'));
    expect(editorStore.getState()?.regionId).toBe('d2');
    act(() => editorStore.setState(null));
    await settle();
    // A drag moves it and opens nothing.
    const r = document.querySelector<HTMLElement>('[data-region-id="p1"]')!.getBoundingClientRect();
    await dragTo(on('p1'), { x: r.left + r.width / 2 + 4 * (r.width / 8), y: r.top + r.height * 0.6 });
    expect(regions().find((x) => x.id === 'p1')!.start).toBe(12);
    expect(editorStore.getState()).toBeNull();
    act(() => setUiMode('advanced'));
    await settle();
    await clickAt(on('d2'));
    expect(editorStore.getState()).toBeNull();
  });

  it('a row’s name opens its Sound panel in place of LOOPS', async () => {
    await openSong(1366, 768);
    drumsOnly();
    await settle();
    expect(byTestId('loop-browser')).not.toBeNull();
    const names = document.querySelectorAll<HTMLElement>('[data-testid="row-name"]');
    expect(names.length).toBe(2);
    expect(names[0].getAttribute('aria-label')).toBe('Drums (Drums): open its sound');
    await clickAt(centre(names[0]));
    expect(sidePanelStore.getState()).toEqual({ kind: 'sound', trackId: trackId('Drums') });
    expect(names[0].getAttribute('aria-pressed')).toBe('true');
    expect(byTestId('loop-browser')).toBeNull();
    act(() => closeSound());
    await settle();
    expect(byTestId('loop-browser')).not.toBeNull();
  });

  it('an edge drag over other music says what it replaced, with Undo', async () => {
    await openSong(1366, 768);
    drumsOnly();
    await settle();
    // Drums: d1 (bars 1–8) then d2 (9–16). Drag d1's end over all of d2.
    const end = edge('d1', 'end');
    const r = document.querySelector<HTMLElement>('[data-region-id="d2"]')!.getBoundingClientRect();
    await dragTo(end, { x: r.right + 2, y: end.y });
    expect(regions().some((x) => x.id === 'd2')).toBe(false);
    expect(notice()).toMatch(/grew over other music\. It replaced .+\.$/);
    expect(notice()).not.toMatch(/bar/);
    expect(rt().notice?.action).toBe('undo');
  });
});

describe('the tip line', () => {
  it('offers one next step from the real song, and hides', async () => {
    await openSong(1366, 768);
    act(() => setTipsEnabled(true));
    const full = { regions: regions(), sections: sections() };
    drumsOnly();
    await settle();
    const tip = () => byTestId('song-tip');
    // The ready-made song as it opened: try a loop first. The editor opened on one moves the tip on.
    await settle();
    expect(tip()!.textContent).toContain('Next: Click any loop in your song to change its notes');
    await clickAt(on(regions()[0].id));
    await settle();
    act(() => editorStore.setState(null));
    await settle();
    expect(tip()!.textContent).toContain('Next: Add a bass: press + Add instrument, then Bass');
    setSong([]);
    await settle();
    expect(tip()!.textContent).toContain('Next: Pick a beat from Loops on the right');
    // A short song with a bass: chords next, then make it longer.
    const drums = trackId('Drums');
    const bass = trackId('Bass');
    setSong([region('d', drums, clipOf(0, 1).id, 0, 4), region('b', bass, clipOf(2, 1).id, 0, 4)]);
    await settle();
    expect(tip()!.textContent).toContain('Next: Add chords: press + Add instrument, then Keys & chords');
    setSong([...regions(), region('c', trackId('Chords'), clipOf(3, 1).id, 0, 4)]);
    await settle();
    expect(tip()!.textContent).toContain('Next: Make your song longer: press Make it longer');
    setSong(full.regions, full.sections);
    await settle();
    expect(tip()!.dataset.step).toBe('share');
    expect(tip()!.textContent).toContain('Next: Share your song: press Share');
    await clickAt(centre(byTestId('hide-tips')!));
    expect(tip()).toBeNull();
  });
});

describe('fit', () => {
  for (const [w, hh] of [
    [1366, 768],
    [1920, 1080],
  ] as const) {
    it(`five rows and the editor fit at ${w}×${hh} without page scroll`, async () => {
      await openSong(w, hh);
      act(() => setTipsEnabled(true));
      const keep = ['Drums', 'Bass', 'Chords', 'Lead', 'Pad'].map(trackId);
      setSong(project().arrangement.regions.filter((r) => keep.includes(r.trackId)), project().arrangement.sections);
      await settle(200);
      await page.screenshot({ path: `${SHOTS}/home-${w}.png` });
      expect(rowIds().length).toBe(5);
      await clickAt(on(regions().find((r) => r.trackId === keep[0])!.id));
      await settle(300);
      await page.screenshot({ path: `${SHOTS}/home-editor-${w}.png` });
      expect(document.scrollingElement!.scrollHeight).toBeLessThanOrEqual(hh + 1);
      const rows = [...document.querySelectorAll<HTMLElement>('[data-lane-row]')];
      const scroller = document.querySelector<HTMLElement>('[data-testid="lane-scroller"]')!.getBoundingClientRect();
      // Every row is in view, none cut off by the editor.
      for (const r of rows) expect(r.getBoundingClientRect().bottom).toBeLessThanOrEqual(scroller.bottom + 1);
    });
  }
});

describe('accessibility and screenshots', () => {
  it('the home, Make it longer and + Add instrument pass axe-core', async () => {
    await openSong(1366, 768);
    act(() => setTipsEnabled(true));
    drumsOnly();
    act(() => session.setSongCursor(9));
    await settle(200);
    const view = document.querySelector('section[aria-labelledby="song-title"]')!;
    expect(await audit(view)).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/drums-only-1366.png` });
    await clickAt(centre(byTestId('make-longer')!));
    await settle(150);
    await page.screenshot({ path: `${SHOTS}/make-longer-1366.png` });
    expect(await audit(document.querySelector('[role="menu"]')!)).toEqual([]);
    await clickAt(centre(byTestId('make-longer')!));
    await clickAt(centre(byTestId('add-instrument')!));
    await settle(150);
    await page.screenshot({ path: `${SHOTS}/add-instrument-1366.png` });
    expect(await audit(document.querySelector('[role="menu"]')!)).toEqual([]);
  });
});

describe('measure', () => {
  it('counts the controls and jargon words on the Song screen in Simple at 1366×768', async () => {
    await openSong(1366, 768);
    act(() => setTipsEnabled(true));
    await settle(200);
    const view = document.querySelector<HTMLElement>('section[aria-labelledby="song-title"]')!.parentElement!;
    const shown = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
      for (let e: HTMLElement | null = el; e; e = e.parentElement) if (getComputedStyle(e).opacity === '0' || getComputedStyle(e).visibility === 'hidden') return false;
      return true;
    };
    const controls = [...view.querySelectorAll<HTMLElement>('button, input, select, [role="button"], [role="slider"], [role="tab"]')].filter(shown);
    const browser = view.querySelector<HTMLElement>('[data-testid="loop-browser"]');
    const text = view.innerText.replace(browser?.innerText ?? '', ' ');
    const libText = browser?.innerText ?? '';
    const JARGON = ['bar', 'bars', 'BPM', 'scene', 'pad', 'part', 'step', 'clip', 'macro', 'master', 'mix', 'LUFS', 'quantize', 'MIDI', 'velocity', 'arpeggiator'];
    const count = (t: string) => JARGON.map((w) => [w, (t.match(new RegExp(`\\b${w}s?\\b`, 'gi')) ?? []).length] as const).filter(([, n]) => n > 0);
    const words = JARGON.map((w) => [w, (text.match(new RegExp(`\\b${w}s?\\b`, 'gi')) ?? []).length] as const).filter(([, n]) => n > 0);
    await commands.writeFile('.vitest/r7-home-measure.txt', `controls=${controls.length} (regions ${controls.filter((c) => c.dataset.regionId).length}) jargon (outside LOOPS)=${JSON.stringify(words)} jargon in LOOPS=${JSON.stringify(count(libText))} LOOPS controls=${controls.filter((c) => browser?.contains(c)).length}\n${controls.map((c) => c.getAttribute('aria-label') || c.textContent?.trim().slice(0, 30)).join(' | ')}\n`);
    expect(controls.length).toBeLessThan(137);
  });
});
