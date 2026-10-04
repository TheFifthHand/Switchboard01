/**
 * Play / Pause, the keyboard's part and the pads read clearly everywhere. The
 * whole app in real Chromium with the real audio engine (the House starter,
 * through the real Jump In where it plays), driven by trusted mouse and
 * keyboard input:
 * - in the Song view, Space and the transport's Play play the song: with the
 *   pads paused (paused in Play) they stop and the song plays from its
 *   cursor, and the key says "Play song" beforehand; a paused song continues;
 *   back in Play, Space continues the paused song where it held;
 * - paused, the transport's key reads "▶ Continue" (the Scenes column's word)
 *   no wider than Pause (nothing moves); a part whose clip holds at the pause
 *   says "❚❚ Paused" in its header at every width, its key never offers
 *   "■ Stop", and its ▶ continues in time;
 * - the keyboard strip says which part it plays ("Keys play Bass") in Play,
 *   Song, Shape and Mix, and follows the selected part;
 * - scene buttons say what a press does on hover and keyboard focus ("▶ Play
 *   row", "■ Stop row") in the count's place, and the playing row's ■ says the
 *   transport keeps running; nothing while a pad is carried;
 * - the Drums tab goes straight to the drum pads of a drum part when the
 *   selected part is not a kit (Notes back to the melodic part it left);
 * - a second click on a stopping pad leaves no queued change past the bar
 *   line, and the clip keeps its phase;
 * - the pad tooltip is short (right-click, drag; the focused-pad keys stay
 *   in its keyboard shortcuts), and a name too long for its pad ends in "…"
 *   with the whole name in the tooltip.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { songBars } from '../../src/project/arrangement';
import { TICKS_PER_BAR, TICKS_PER_BEAT, type Id } from '../../src/project/types';
import { setBpm } from '../../src/state/commands';
import { uiStore } from '../../src/state/uiStore';
import { clickEl, clipsOf, described, grid, openApp, pad, press, project, setUp, tearDown, until } from './r4-play-helpers';
import { centre, mouse, settleFrames } from './r4-uikit-input';
import { resetKeyboardFold } from './r4-keys-helpers';
import { wait } from './ui-harness';

beforeEach(async () => {
  await setUp();
  resetKeyboardFold();
});
afterEach(async () => {
  // Never leave the mouse button held for the next test.
  await mouse('mouseReleased', { x: 2, y: 2 }).catch(() => {});
  await tearDown();
  resetKeyboardFold();
});

const rt = () => runtimeStore.getState();
const trackRt = (id: Id) => rt().tracks[id];
const tick = () => session.transport!.getPosition().tick;
const phase = (id: Id) => session.transport!.clipPhase(id);
const selected = () => uiStore.getState().selectedTrackId;

const tab = (list: 'View' | 'Pad mode', name: string) =>
  [...document.querySelectorAll<HTMLElement>(`[role="tablist"][aria-label="${list}"] [role="tab"]`)].find((t) => t.textContent?.trim() === name)!;
const playKey = () => document.querySelector<HTMLButtonElement>('header[aria-label="Transport"] button[aria-keyshortcuts="Space"]')!;
const keyText = (b: HTMLElement) => b.textContent?.replace(/\s+/g, ' ').trim();
const strip = () => document.querySelector<HTMLElement>('section[aria-label="Keyboard"]')!;
const keysPart = () => strip().querySelector<HTMLElement>('[data-keys-part]');
/** The part key of the part in column `i` (its id in the header's roving keys). */
const partKey = (i: number) => document.getElementById(`part-head-${i * 5 + 3}`) as HTMLButtonElement;
const headerMain = (i: number) => document.getElementById(`part-head-${i * 5}`) as HTMLButtonElement;
/** The status word in the meter's place of column `i` (Muted, Not soloed, Paused), when it shows. */
const statusOf = (i: number) => headerMain(i).closest<HTMLElement>('[data-grid-head] > div')!.querySelector<HTMLElement>('[data-status]');
const statusWord = (i: number) => keyText(statusOf(i) ?? document.createElement('span')) || null;
const sceneBtn = (row: number) => document.querySelector<HTMLButtonElement>(`[data-scene-row="${row}"] button[data-scene]`)!;
const shown = (el: Element | null) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
const sceneWord = (row: number) => {
  const w = sceneBtn(row).querySelector<HTMLElement>('[data-scene-word]');
  return shown(w) ? keyText(w!) : null;
};
const sceneCountShown = (row: number) => shown(sceneBtn(row).querySelector('[class*="sceneCount"]'));
/** The song's first pass starts at this bar (from 0). */
const songStartBar = () => session.sequencer!.songPasses()![0].from / TICKS_PER_BAR;

async function hover(el: Element): Promise<void> {
  await mouse('mouseMoved', centre(el));
  await settleFrames();
}

async function away(): Promise<void> {
  await mouse('mouseMoved', { x: 2, y: 2 });
  await settleFrames();
}

/** The app playing (Jump In) at 60 BPM: a bar lasts 4 s, so clicks and checks fit before the next bar line. */
async function openPlaying(w = 1366, hh = 768): Promise<void> {
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

describe('Play and Space in the Song view play the song', () => {
  it('pads playing in Play, paused there: in Song the key says Play song, and Space plays the song from its cursor', async () => {
    await openPlaying();
    expect(songBars(project())).toBeGreaterThan(0);
    await until(() => tick() > TICKS_PER_BAR + TICKS_PER_BEAT, 'into the second bar');
    // Pause in Play with the real Space key.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await press(' ');
    expect(rt()).toMatchObject({ playing: false, paused: true, mode: 'live' });
    expect(keyText(playKey())).toBe('Continue');

    await clickEl(tab('View', 'Song'));
    expect(uiStore.getState().view).toBe('arrange');
    // What Space will do, said before it is pressed: the song, not the paused pads.
    expect(playKey().getAttribute('aria-label')).toBe('Play song');
    expect(keyText(playKey())).toBe('Play song');
    expect(described(playKey())).toContain('The paused pads stop');
    const cursor = rt().songCursor;

    // Space (focus is on the Song tab just clicked: Space still plays) plays the song from its cursor.
    await press(' ');
    await until(() => rt().playing && rt().mode === 'song', 'the song to play');
    expect(rt().paused).toBe(false);
    expect(songStartBar()).toBe(cursor);

    // Space pauses the song, and Space continues it where it held (the song, not the pads).
    await until(() => tick() > cursor * TICKS_PER_BAR + TICKS_PER_BEAT, 'the song to move on');
    await press(' ');
    expect(rt()).toMatchObject({ playing: false, paused: true, mode: 'song' });
    expect(keyText(playKey())).toBe('Continue');
    const held = tick();
    await press(' ');
    expect(rt()).toMatchObject({ playing: true, paused: false, mode: 'song' });
    expect(Math.abs(tick() - held)).toBeLessThan(TICKS_PER_BEAT);
  });

  it('the transport’s Play key in Song does the same: the paused pads stop and the song plays', async () => {
    await openPlaying();
    await until(() => tick() > TICKS_PER_BEAT, 'playback');
    await clickEl(playKey());
    expect(rt()).toMatchObject({ paused: true, mode: 'live' });
    await clickEl(tab('View', 'Song'));
    await clickEl(playKey());
    await until(() => rt().playing && rt().mode === 'song', 'the song to play');
    expect(songStartBar()).toBe(rt().songCursor);
    // Stop goes back to where the song started; the pads that were paused are armed again (lit, from the top on Play in Play).
    await clickEl(document.querySelector('header[aria-label="Transport"] button[aria-keyshortcuts="Shift+Space"]'));
    expect(rt()).toMatchObject({ playing: false, paused: false, mode: 'live' });
  });

  it('the reverse: a song paused in Song continues in Play with Space, where it held', async () => {
    await openApp(1366, 768);
    act(() => void setBpm(session.store, 60));
    await clickEl(tab('View', 'Song'));
    await press(' ');
    await until(() => rt().playing && rt().mode === 'song', 'the song to play');
    await until(() => tick() > TICKS_PER_BAR + TICKS_PER_BEAT, 'into the second bar');
    await press(' ');
    expect(rt()).toMatchObject({ playing: false, paused: true, mode: 'song' });
    const held = tick();

    await clickEl(tab('View', 'Play'));
    expect(uiStore.getState().view).toBe('play');
    // In Play the key continues what holds: the song.
    expect(keyText(playKey())).toBe('Continue');
    expect(described(playKey())).toContain('Continue the song from where you paused');
    await press(' ');
    expect(rt()).toMatchObject({ playing: true, paused: false, mode: 'song' });
    expect(Math.abs(tick() - held)).toBeLessThan(TICKS_PER_BEAT);
  });
});

describe('Paused reads paused', () => {
  it('the transport key says Continue, no wider than Pause; a held part says Paused, not Stop, and pressing it continues in time', async () => {
    await openPlaying();
    const pauseWidth = playKey().getBoundingClientRect().width;
    expect(keyText(playKey())).toBe('Pause');
    const row = trackRt('t3')!.playingSlot!;
    await until(() => tick() > TICKS_PER_BAR + TICKS_PER_BEAT && phase('t3') !== null, 'into the second bar');
    const start = phase('t3')!.startTick;
    // Bass (column 3) plays: its key offers Stop.
    expect(partKey(2).dataset.partKey).toBe('stop');

    await clickEl(playKey());
    expect(rt()).toMatchObject({ playing: false, paused: true });
    const key = playKey();
    expect(keyText(key)).toBe('Continue');
    expect(key.querySelector('svg')?.getAttribute('data-icon')).toBe('play');
    // No wider than Pause: Stop, beside it, does not move.
    expect(key.getBoundingClientRect().width).toBeLessThanOrEqual(pauseWidth + 0.5);
    const word = [...key.querySelectorAll('span')].find((x) => x.textContent === 'Continue') ?? key;
    expect(word.scrollWidth).toBeLessThanOrEqual(key.clientWidth);
    // The same word as the key above the scenes.
    expect(document.querySelector('[data-pause-key]')?.textContent).toBe('Continue');

    // Bass holds at the pause: its header says Paused (with the pause sign) and its key does not offer Stop:
    // ▶ carries on from the pause.
    const bass = partKey(2);
    expect(bass.dataset.partKey).toBe('continue');
    expect(keyText(bass)).toBe('Play');
    expect(bass.querySelector('svg')?.getAttribute('data-icon')).toBe('play');
    expect(bass.disabled).toBe(false);
    expect(bass.getAttribute('aria-label')).toBe('Play Bass: continue from the pause');
    expect(described(bass)).toContain('Bass is paused in');
    expect(described(bass)).toContain('carry on from the pause');
    expect(statusWord(2)).toBe('Paused');
    expect(statusOf(2)!.querySelector('svg')?.getAttribute('data-icon')).toBe('pause');
    // A part that plays nothing still offers Play (from the next bar after the pause), and is not "Paused".
    expect(partKey(4).dataset.partKey).toBe('play');
    expect(statusWord(4)).toBeNull();
    // No part key in the grid says Stop while paused; every part that holds says Paused, at every width.
    const held = [0, 1, 2, 3];
    for (const [w, hh] of [
      [1024, 768],
      [1180, 800],
      [1280, 720],
      [1366, 768],
      [1920, 1080],
    ] as const) {
      await page.viewport(w, hh);
      await settleFrames(4);
      for (let i = 0; i < 8; i++) {
        expect(partKey(i).dataset.partKey, `${w} px, column ${i + 1}`).not.toBe('stop');
        if (!held.includes(i)) continue;
        const s = statusOf(i)!;
        expect(statusWord(i), `${w} px, column ${i + 1}`).toBe('Paused');
        // The whole word shows, inside its header.
        expect(s.scrollWidth, `${w} px, column ${i + 1}`).toBeLessThanOrEqual(s.clientWidth + 0.5);
        const hr = s.closest<HTMLElement>('[data-grid-head] > div')!.getBoundingClientRect();
        expect(s.getBoundingClientRect().right).toBeLessThanOrEqual(hr.right + 0.5);
      }
    }
    await page.viewport(1366, 768);
    await settleFrames(4);

    // Pressing it continues from the pause, in time: the same clip, the same loop start, nothing queued.
    await clickEl(bass);
    expect(rt()).toMatchObject({ playing: true, paused: false });
    expect(trackRt('t3')).toMatchObject({ playingSlot: row, queued: null });
    expect(phase('t3')!.startTick).toBe(start);
    expect(partKey(2).dataset.partKey).toBe('stop');
    expect(statusWord(2)).toBeNull();
    expect(keyText(playKey())).toBe('Pause');

    // Stopped, the key reads Play again (no wider than Pause).
    act(() => session.stop());
    await settleFrames();
    expect(keyText(playKey())).toBe('Play');
    expect(playKey().getBoundingClientRect().width).toBeLessThanOrEqual(pauseWidth + 0.5);
  });
});

describe('The keyboard names the part it plays', () => {
  it('"Keys play …" in Play, Song, Shape and Mix, following the selected part (a kit too)', async () => {
    await openApp(1366, 768);
    // A real click on the Bass column's header selects Bass.
    await clickEl(headerMain(2));
    expect(selected()).toBe('t3');
    expect(keyText(keysPart()!)).toBe('Keys play Bass');
    // The name is whole and sits in the strip's left block, above the octave keys.
    const name = keysPart()!;
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth + 0.5);
    const octave = strip().querySelector<HTMLElement>('button[aria-label^="Octave down"]')!;
    expect(name.getBoundingClientRect().bottom).toBeLessThanOrEqual(octave.getBoundingClientRect().top + 0.5);
    const sr = strip().getBoundingClientRect();
    expect(name.getBoundingClientRect().top).toBeGreaterThanOrEqual(sr.top);
    expect(strip().querySelector('[role="group"][aria-label^="Keyboard playing"]')!.getBoundingClientRect().left).toBeGreaterThanOrEqual(name.getBoundingClientRect().right);

    for (const view of ['Song', 'Shape']) {
      await clickEl(tab('View', view));
      expect(keyText(keysPart()!), view).toBe('Keys play Bass');
    }
    // Mix starts with the keyboard folded: the slim bar names the part.
    await clickEl(tab('View', 'Mix'));
    expect(strip().hasAttribute('data-collapsed')).toBe(true);
    expect(strip().textContent).toContain('Computer keys play Bass.');

    // Back in Play, a kit part: the strip says so above its sound keys.
    await clickEl(tab('View', 'Play'));
    await clickEl(headerMain(1));
    expect(selected()).toBe('t2');
    expect(keyText(keysPart()!)).toBe('Keys play Percussion');
    expect(keysPart()!.scrollWidth).toBeLessThanOrEqual(keysPart()!.clientWidth + 0.5);
    expect(strip().textContent).toContain('16 sounds');
    expect(strip().textContent).toContain('Each key plays one kit sound.');
  });
});

describe('Scene buttons say what a press does', () => {
  it('on hover: ▶ Play row, or ■ Stop row on the playing row (whose tip says the transport keeps running); on keyboard focus too; not while a pad is carried', async () => {
    await openPlaying();
    const row = trackRt('t1')!.playingSlot!;
    const other = row === 0 ? 1 : 0;
    await away();
    expect(sceneWord(row)).toBeNull();
    expect(sceneWord(other)).toBeNull();
    expect(sceneCountShown(other)).toBe(true);

    await hover(sceneBtn(other));
    expect(sceneWord(other)).toBe('Play row');
    expect(sceneBtn(other).querySelector('[data-scene-word] svg')?.getAttribute('data-icon')).toBe('play');
    // In the count's place, inside the button, and the button does not change size.
    expect(sceneCountShown(other)).toBe(false);
    const word = sceneBtn(other).querySelector<HTMLElement>('[data-scene-word]')!.getBoundingClientRect();
    const br = sceneBtn(other).getBoundingClientRect();
    expect(word.left).toBeGreaterThanOrEqual(br.left);
    expect(word.right).toBeLessThanOrEqual(br.right);
    expect(word.bottom).toBeLessThanOrEqual(br.bottom);

    const before = sceneBtn(row).getBoundingClientRect().height;
    await hover(sceneBtn(row));
    expect(sceneWord(row)).toBe('Stop row');
    expect(sceneBtn(row).querySelector('[data-scene-word] svg')?.getAttribute('data-icon')).toBe('stop');
    expect(sceneWord(other)).toBeNull();
    expect(sceneBtn(row).getBoundingClientRect().height).toBeCloseTo(before, 1);
    expect(described(sceneBtn(row))).toContain('Stop row');
    expect(described(sceneBtn(row))).toContain('The transport keeps running');
    // The tooltip shows the same words on hover.
    await act(async () => {
      await wait(500);
    });
    const bubble = [...document.querySelectorAll<HTMLElement>('body > div[aria-hidden="true"]')].find((d) => d.textContent?.includes('The transport keeps running'));
    expect(bubble, 'tooltip').toBeTruthy();

    // Keyboard focus: from the row's last pad, ArrowRight goes to its scene button, which shows its word.
    await away();
    act(() => pad('t8', other).focus());
    await press('{ArrowRight}');
    expect(document.activeElement).toBe(sceneBtn(other));
    expect(sceneWord(other)).toBe('Play row');

    // While a pad is carried over the scenes, no scene says Play or Stop (a drop is not a press).
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    const from = pad('t3', clipsOf('t3').findIndex((c, s) => !!c && s !== trackRt('t3')!.playingSlot));
    const a = centre(from);
    const b = centre(sceneBtn(other));
    await mouse('mouseMoved', a);
    await mouse('mousePressed', a);
    for (let i = 1; i <= 8; i++) {
      await mouse('mouseMoved', { x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8 }, { buttons: 1 });
      await new Promise((r) => requestAnimationFrame(r));
    }
    await settleFrames();
    expect(grid().dataset.dragging).toBe('pad');
    expect(sceneWord(other)).toBeNull();
    await press('{Escape}');
    await mouse('mouseReleased', b);
    await settleFrames();
  });
});

describe('The Drums tab goes straight to drum pads', () => {
  it('with Chords selected, Drums opens the Drums part’s pads (no chooser); Notes comes back to Chords; Steps keeps the part', async () => {
    await openPlaying();
    await clickEl(headerMain(3));
    expect(selected()).toBe('t4');

    await clickEl(tab('Pad mode', 'Drums'));
    expect(uiStore.getState().padMode).toBe('drums');
    expect(selected()).toBe('t1');
    const surface = document.getElementById('pad-surface')!;
    expect(surface.textContent).not.toContain('These pads play a drum kit');
    expect(surface.querySelector('[data-pad-grid][aria-label*="for Drums"]')).not.toBeNull();
    expect(keyText(keysPart()!)).toBe('Keys play Drums');
    // A real click on a drum pad plays it.
    const kick = surface.querySelector<HTMLElement>('[data-pad-grid] button')!;
    await clickEl(kick);
    expect(document.getElementById('pad-surface')!.textContent).not.toContain('None yet');

    // Notes: back to the melodic part Drums took over from.
    await clickEl(tab('Pad mode', 'Notes'));
    expect(selected()).toBe('t4');
    expect(document.getElementById('pad-surface')!.textContent).not.toContain('These pads play notes on a melodic part');
    // Drums again: the Drums part, without a chooser.
    await clickEl(tab('Pad mode', 'Drums'));
    expect(selected()).toBe('t1');
    // Steps edits any part: the selection stays.
    await clickEl(tab('Pad mode', 'Steps'));
    expect(selected()).toBe('t1');
    // A kit already selected stays selected (Percussion is a kit too).
    await clickEl(tab('Pad mode', 'Loops'));
    await clickEl(headerMain(1));
    await clickEl(tab('Pad mode', 'Drums'));
    expect(selected()).toBe('t2');
    // Playback was never touched.
    expect(rt().playing).toBe(true);
  });
});

describe('A second click on a stopping pad', () => {
  it('leaves no queued change past the bar line, and the clip keeps its phase', async () => {
    await openPlaying();
    const row = trackRt('t3')!.playingSlot!;
    const p = pad('t3', row);
    await until(() => phase('t3') !== null, 'the bass to sound');
    const start = phase('t3')!.startTick;
    await earlyInBar();
    await clickEl(p);
    const q = trackRt('t3')!.queued!;
    expect(q.slot).toBeNull();
    expect(session.sequencer!.getTrackState('t3').queued).not.toBeNull();
    // Called off before the bar line: nothing is queued in the sequencer or on screen.
    await clickEl(p);
    expect(trackRt('t3')!.queued).toBeNull();
    expect(session.sequencer!.getTrackState('t3').queued).toBeNull();
    await until(() => tick() > q.atTick + TICKS_PER_BEAT, 'past the bar line');
    expect(trackRt('t3')).toMatchObject({ playingSlot: row, queued: null });
    expect(session.sequencer!.getTrackState('t3').queued).toBeNull();
    expect(session.sequencer!.getTrackState('t3').playing?.slot).toBe(row);
    expect(phase('t3')!.startTick).toBe(start);
    expect(p.dataset.state).toBe('playing');
  });
});

describe('Pad words', () => {
  it('the tooltip is short: right-click and drag; the focused-pad keys stay in its keyboard shortcuts', async () => {
    await openApp(1366, 768);
    const p = pad('t3', clipsOf('t3').findIndex((c) => !!c));
    const d = described(p);
    expect(d).toContain('Right-click for its actions');
    expect(d).toContain('Drag it onto another pad to move it.');
    expect(d).not.toContain('Shift+F10');
    expect(d).not.toContain('. key');
    expect(p.getAttribute('aria-keyshortcuts')).toContain('Shift+F10');
  });

  it('a name too long for its pad ends in “…”, and the tooltip and its spoken name give it whole', async () => {
    await openApp(1366, 768);
    const pads = [...document.querySelectorAll<HTMLButtonElement>('[data-pad-cell] button[id^="pad-"]')];
    const cut = pads.find((b) => {
      const n = b.querySelector<HTMLElement>('[data-pad-name]');
      return !!n && n.scrollWidth > n.clientWidth + 0.5;
    });
    expect(cut, 'a pad whose name does not fit (Congas & Bell at 1366 px)').toBeTruthy();
    const nameEl = cut!.querySelector<HTMLElement>('[data-pad-name]')!;
    const full = nameEl.textContent!;
    const cs = getComputedStyle(nameEl);
    expect(cs.textOverflow).toBe('ellipsis');
    expect(cs.maskImage === 'none' || cs.maskImage === '').toBe(true);
    expect(cut!.getAttribute('aria-label')).toContain(full);

    await hover(cut!);
    await act(async () => {
      await wait(500);
    });
    // The tooltip names it whole (no second, native title bubble).
    expect(described(cut!)).toContain(full);
    expect(cut!.hasAttribute('title')).toBe(false);
    const bubble = [...document.querySelectorAll<HTMLElement>('body > div[aria-hidden="true"]')].find((d) => d.textContent?.includes(full));
    expect(bubble, 'tooltip').toBeTruthy();

    // A name that fits is not repeated in its tooltip.
    const whole = pads.find((b) => {
      const n = b.querySelector<HTMLElement>('[data-pad-name]');
      return !!n && b.dataset.state !== 'empty' && n.scrollWidth <= n.clientWidth && n.textContent!.length > 3;
    })!;
    await hover(whole);
    expect(described(whole)).not.toContain(whole.querySelector('[data-pad-name]')!.textContent!);
  });
});
