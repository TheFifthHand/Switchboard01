/**
 * The scale keyboard in the running app, with real clicks and real keys (round 5: "you can't press
 * all the keys, they are combined with the black keys"). With Musical Assist on, a part with notes
 * shows only the notes of the project's key, as one row of equal keys with no black keys: each key
 * a different note, named as the key writes it (B♭ in F major, not A#), its root keys marked with
 * their octave and a divider before them, and its computer letter (A–' for the first 11 keys, Q–]
 * for keys 12–23). A click plays exactly that key and it sounds as that note (nothing snaps, so
 * nothing doubles up). The octave buttons, Z and X move it by an octave; the reset returns to the
 * root at or below C4. Assist off (or the Chromatic scale) brings the piano back; a kit keeps its
 * 16 sound keys. Switching Assist or the key under a held key releases it; a MIDI note is still
 * moved into the key and lights the key that sounds.
 */
import type { AxeResults } from 'axe-core';
import axeSource from 'axe-core/axe.min.js?raw';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { isInScale, scaleKeyboardNotes, snapToScale } from '../../src/music/scales';
import { setAssist, setKey } from '../../src/state/commands';
import { selectTrack, setKeyboardOctave, setUiMode, uiStore } from '../../src/state/uiStore';
import { button, described, openApp, press, project, setUp, tearDown, until } from './r4-play-helpers';
import { centre, click, drag, mouse, settleFrames } from './r4-uikit-input';
import { keyboard, recordPlayed, resetKeyboardFold, strip } from './r4-keys-helpers';

beforeEach(async () => {
  await setUp();
  resetKeyboardFold();
  act(() => setKeyboardOctave(4));
});
afterEach(async () => {
  await tearDown();
  // Leave the keyboard unfolded everywhere, on C4's octave, for the next test (both are remembered in storage).
  resetKeyboardFold();
  act(() => setKeyboardOctave(4));
});

const keys = () => [...keyboard().querySelectorAll<HTMLElement>('[data-midi]')];
const midis = () => keys().map((k) => Number(k.dataset.midi));
const names = () => keys().map((k) => k.getAttribute('aria-label') ?? '');
const letters = () => keys().map((k) => k.querySelector('[class*="keycap"]')?.textContent ?? '');
const assistSwitch = () => [...strip().querySelectorAll<HTMLElement>('[role="switch"]')].find((s) => s.textContent?.includes('Musical Assist'))!;
const line = () => [...strip().querySelectorAll<HTMLElement>('p[aria-live="polite"]')].at(-1)!.textContent;
const lowest = () => strip().querySelector('[class*="octValue"]')!.textContent;
const reset = () => strip().querySelector<HTMLButtonElement>('button[aria-label^="Reset octave"]')!;
const isPiano = () => keyboard().querySelector('[class*="black"]') !== null;
const setProjectKey = (root: number, scale: Parameters<typeof setKey>[2]) => act(() => void session.accepted(setKey(session.store, root, scale)));
const assist = (on: boolean) => act(() => void session.accepted(setAssist(session.store, on)));

async function bass(w = 1366, h = 768): Promise<void> {
  await openApp(w, h);
  act(() => selectTrack('t3'));
  await settleFrames(3);
}

describe('Assist on: only the notes of the key, one key each', () => {
  it('G Dorian: one row of equal keys, no black keys, each a different in-key note spelled by the key', async () => {
    await bass();
    expect(project().assist).toBe(true);
    expect(isPiano()).toBe(false);
    const ks = keys();
    const ms = midis();
    // As many as fit at 44 px or more (two octaves and more at 1366 px), the notes of G Dorian from G3 up.
    expect(ks.length).toBeGreaterThanOrEqual(15);
    expect(ks.length).toBeLessThanOrEqual(22);
    expect(ms).toEqual(scaleKeyboardNotes(7, 'dorian', 60, ks.length));
    expect(new Set(ms).size).toBe(ms.length);
    for (const m of ms) expect(isInScale(m, 7, 'dorian')).toBe(true);
    const first = ks[0].getBoundingClientRect();
    for (const k of ks) {
      const r = k.getBoundingClientRect();
      expect(r.width, k.dataset.note).toBeGreaterThanOrEqual(44);
      expect(Math.abs(r.width - first.width)).toBeLessThan(1);
      expect(Math.abs(r.top - first.top)).toBeLessThan(0.5);
      expect(Math.abs(r.height - first.height)).toBeLessThan(0.5);
      expect(r.height).toBeGreaterThanOrEqual(80);
    }
    // Edge to edge, left to right, and filling the keys' space.
    for (let i = 1; i < ks.length; i++) expect(Math.abs(ks[i].getBoundingClientRect().left - ks[i - 1].getBoundingClientRect().right)).toBeLessThan(0.6);
    expect(keyboard().getBoundingClientRect().width).toBeGreaterThan(760);
    // Named the way G Dorian writes them: B♭, never A#; the roots say so.
    expect(names().slice(0, 9)).toEqual(['G3 (root)', 'A3', 'B♭3', 'C4', 'D4', 'E4', 'F4', 'G4 (root)', 'A4']);
    expect(names().join(' ')).not.toContain('#');
    for (const k of ks) expect(k.getAttribute('role')).toBe('button');
    // A key shows its name; a root also its octave (not colour alone), over a teal underline, with a divider before it.
    const nameOf = (k: HTMLElement) => k.querySelector('[class*="stepName"]')!;
    expect(nameOf(ks[2]).textContent).toBe('B♭');
    expect(nameOf(ks[0]).textContent).toBe('G3');
    expect(nameOf(ks[7]).textContent).toBe('G4');
    expect(getComputedStyle(nameOf(ks[7]), '::after').height).toBe('3px');
    expect(getComputedStyle(nameOf(ks[2]), '::after').content).toBe('none');
    expect(ks.filter((k) => k.hasAttribute('data-octave')).map((k) => k.dataset.note)).toEqual(ks.filter((k, i) => i > 0 && k.hasAttribute('data-root')).map((k) => k.dataset.note));
    expect(getComputedStyle(ks[7], '::before').width).toBe('2px');
    expect(getComputedStyle(ks[0], '::before').content).toBe('none');
    // The strip says what is happening.
    expect(line()).toBe('Only G Dorian notes are shown.');
    expect(described(assistSwitch().closest('[aria-describedby]')!)).toMatch(/shows only the notes of G Dorian, so every key plays a different note/);
    expect(lowest()).toBe('G3');
    expect(reset().textContent?.replace(/\s+/g, ' ').trim()).toBe('↺ G3');
    expect(reset().getAttribute('aria-label')).toBe('Reset octave to G3, just below C4');
    expect(strip().scrollWidth).toBeLessThanOrEqual(strip().clientWidth + 1);
  });

  it('spelled in every key: F major has B♭, E major has sharps, A blues has E♭; pentatonic and blues show 5 and 6 notes an octave', async () => {
    await bass();
    setProjectKey(5, 'major');
    await settleFrames(2);
    expect(names()).toContain('B♭3');
    expect(names()[0]).toBe('F3 (root)');
    expect(names().join(' ')).not.toContain('#');
    setProjectKey(4, 'major');
    await settleFrames(2);
    expect(names().slice(0, 8)).toEqual(['E3 (root)', 'F#3', 'G#3', 'A3', 'B3', 'C#4', 'D#4', 'E4 (root)']);
    expect(names().join(' ')).not.toContain('♭');
    setProjectKey(9, 'minorPentatonic');
    await settleFrames(2);
    expect(names().slice(0, 6)).toEqual(['A3 (root)', 'C4', 'D4', 'E4', 'G4', 'A4 (root)']);
    expect(keys().length).toBeGreaterThanOrEqual(11);
    expect(keys().length).toBeLessThanOrEqual(16);
    setProjectKey(9, 'blues');
    await settleFrames(2);
    expect(names().slice(0, 7)).toEqual(['A3 (root)', 'C4', 'D4', 'E♭4', 'E4', 'G4', 'A4 (root)']);
    expect(line()).toBe('Only A blues notes are shown.');
    expect(new Set(midis()).size).toBe(keys().length);
  });

  it('a sampler part gets the scale keyboard too; a kit keeps its 16 sound keys', async () => {
    await bass();
    const sampler = project().tracks.find((t) => t.instrument.kind === 'sampler')!;
    act(() => selectTrack(sampler.id));
    await settleFrames(2);
    expect(isPiano()).toBe(false);
    expect(line()).toBe('Only G Dorian notes are shown.');
    act(() => selectTrack('t1'));
    await settleFrames(2);
    expect(keys()).toHaveLength(16);
    expect(assistSwitch()).toBeUndefined();
  });
});

describe('pressing the keys', () => {
  it('a click plays exactly the key under the mouse; a glide plays each key once, in order', async () => {
    await bass();
    const rec = recordPlayed();
    try {
      for (const k of keys()) await click(centre(k, 0.5, 0.6));
      expect(rec.ons().map((p) => p.pitch)).toEqual(midis());
      expect(rec.ons().every((p) => p.trackId === 't3' && p.source === 'keyboard')).toBe(true);
      expect(rec.played.filter((p) => !p.on)).toHaveLength(keys().length);
      // What the session plays for each: the key itself (in key already, so Assist moves nothing).
      for (const p of rec.ons()) expect(snapToScale(p.pitch, 7, 'dorian')).toBe(p.pitch);
      rec.played.length = 0;
      const ks = keys();
      await drag(centre(ks[0], 0.5, 0.7), centre(ks[ks.length - 1], 0.5, 0.7), ks.length * 3);
      expect(rec.ons().map((p) => p.pitch)).toEqual(midis());
    } finally {
      rec.restore();
    }
  });

  it('each key sounds as its own note through the session (real audio), and a MIDI note is still moved into the key', async () => {
    await openApp(1366, 768, { play: true });
    act(() => session.stop());
    act(() => selectTrack('t3'));
    await settleFrames(3);
    const heldOn = () => [...(runtimeStore.getState().held.t3 ?? [])];
    for (const k of keys()) {
      const p = centre(k, 0.5, 0.6);
      await mouse('mouseMoved', p);
      await mouse('mousePressed', p);
      await until(() => heldOn().length === 1, `${k.dataset.note} held`);
      expect(heldOn(), k.getAttribute('aria-label') ?? '').toEqual([Number(k.dataset.midi)]);
      expect(k.hasAttribute('data-pressed')).toBe(true);
      await mouse('mouseReleased', p);
      await until(() => heldOn().length === 0, `${k.dataset.note} released`);
    }
    // A MIDI keyboard plays every key: C#4 is not in G Dorian, so Assist moves it to a neighbour, whose key lights.
    act(() => session.noteOn('t3', 61, 0.8, 'midi'));
    await until(() => heldOn().length === 1, 'the MIDI note');
    const sounding = heldOn()[0];
    expect(sounding).toBe(snapToScale(61, 7, 'dorian'));
    expect(sounding).not.toBe(61);
    await settleFrames(2);
    expect(keyboard().querySelector(`[data-midi="${sounding}"]`)!.hasAttribute('data-lit')).toBe(true);
    act(() => session.noteOff('t3', 61, 'midi'));
    await until(() => heldOn().length === 0, 'the MIDI note released');
  });

  it("computer letters run left to right, A–' then Q–]; real keys play those keys; a key past the last one plays nothing", async () => {
    await bass(1920, 1080);
    const n = keys().length;
    expect(n).toBe(22);
    expect(letters().join('')).toBe("ASDFGHJKL;'QWERTYUIOP[");
    (document.activeElement as HTMLElement | null)?.blur();
    const rec = recordPlayed();
    try {
      for (const k of ['a', ';', "'", 'q', 'i', 'p', '[BracketLeft]', '[BracketRight]']) await press(k);
      const ms = midis();
      expect(rec.ons().map((p) => p.pitch)).toEqual([ms[0], ms[9], ms[10], ms[11], ms[18], ms[20], ms[21]]);
      expect(rec.ons().every((p) => p.source === 'computer' && p.trackId === 't3')).toBe(true);
      expect(rec.played.filter((p) => !p.on)).toHaveLength(7);
    } finally {
      rec.restore();
    }
  });

  it('folded, the computer keys play all three octaves (up to [ on a seven-note key)', async () => {
    await bass();
    expect(keys()).toHaveLength(20);
    await click(centre(button('Hide the keyboard', strip())!));
    (document.activeElement as HTMLElement | null)?.blur();
    const rec = recordPlayed();
    try {
      await press('p');
      await press('[BracketLeft]');
      await press('[BracketRight]');
      // G Dorian from G3: key 21 is F6, key 22 G6; there is no key 23.
      expect(rec.ons().map((p) => p.pitch)).toEqual([89, 91]);
    } finally {
      rec.restore();
    }
  });

  it('on a narrow strip (1024 px) the keys still fill it: two octaves of the scale, a letter on each key a computer key plays', async () => {
    await bass(1024, 768);
    expect(keys()).toHaveLength(15);
    expect(letters()).toEqual(['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'", 'Q', 'W', 'E', 'R']);
    for (const k of keys()) expect(k.getBoundingClientRect().width).toBeGreaterThan(34);
    (document.activeElement as HTMLElement | null)?.blur();
    const rec = recordPlayed();
    try {
      await press('r');
      await press('t');
      expect(rec.ons().map((p) => p.pitch)).toEqual([midis()[14]]);
    } finally {
      rec.restore();
    }
    // Advanced puts the key pickers and the arpeggiator beside the keys: fewer keys, still at least 34 px wide.
    act(() => setUiMode('advanced'));
    await settleFrames(3);
    expect(keys().length).toBeGreaterThanOrEqual(8);
    expect(keys().length).toBeLessThan(15);
    for (const k of keys()) expect(k.getBoundingClientRect().width).toBeGreaterThanOrEqual(34);
    expect(letters().slice(0, 8)).toEqual(['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K']);
    expect(midis()).toEqual(scaleKeyboardNotes(7, 'dorian', 60, keys().length));
  });
});

describe('octaves', () => {
  it('the octave buttons, X and Z move the keys by an octave; the reset puts the lowest key back on G3', async () => {
    await bass();
    const start = midis();
    await click(centre(button('Octave up (X)', strip())!));
    expect(midis()).toEqual(start.map((m) => m + 12));
    expect(lowest()).toBe('G4');
    await click(centre(button('Octave down (Z)', strip())!));
    await click(centre(button('Octave down (Z)', strip())!));
    expect(midis()).toEqual(start.map((m) => m - 12));
    expect(lowest()).toBe('G2');
    await click(centre(reset()));
    expect(midis()).toEqual(start);
    expect(uiStore.getState().keyboardOctave).toBe(4);
    (document.activeElement as HTMLElement | null)?.blur();
    await press('x');
    expect(lowest()).toBe('G4');
    await press('z');
    expect(lowest()).toBe('G3');
    // At the top the keys stop at MIDI 127.
    act(() => setKeyboardOctave(7));
    await settleFrames(2);
    expect(Math.max(...midis())).toBeLessThanOrEqual(127);
    expect(lowest()).toBe('G6');
  });

  it('in C major the lowest key is C4 itself and the reset reads ↺ C4', async () => {
    await bass();
    setProjectKey(0, 'major');
    await settleFrames(2);
    expect(lowest()).toBe('C4');
    expect(reset().getAttribute('aria-label')).toBe('Reset octave to C4');
    expect(names()[0]).toBe('C4 (root)');
  });
});

describe('Assist off, or the Chromatic scale: the piano', () => {
  it('a click on the switch brings the piano back (every key its own note), and again the scale keyboard', async () => {
    await bass();
    await click(centre(assistSwitch()));
    expect(project().assist).toBe(false);
    expect(isPiano()).toBe(true);
    expect(keys()).toHaveLength(25);
    expect(midis()).toEqual(Array.from({ length: 25 }, (_, i) => 60 + i));
    expect(line()).toBe('All 12 notes, like a piano.');
    expect(lowest()).toBe('C4');
    expect(reset().getAttribute('aria-label')).toBe('Reset octave to C4');
    await click(centre(assistSwitch()));
    expect(project().assist).toBe(true);
    expect(isPiano()).toBe(false);
    expect(line()).toBe('Only G Dorian notes are shown.');
  });

  it('the Chromatic scale has every note: the piano, with Assist still on', async () => {
    await bass();
    setProjectKey(7, 'chromatic');
    await settleFrames(2);
    expect(project().assist).toBe(true);
    expect(isPiano()).toBe(true);
    expect(line()).toBe('All 12 notes, like a piano.');
  });
});

describe('held keys when the layout changes', () => {
  it('switching Assist or the key under a held computer key releases it at once', async () => {
    await bass();
    (document.activeElement as HTMLElement | null)?.blur();
    const rec = recordPlayed();
    try {
      await press('{a>}');
      expect(rec.played).toEqual([expect.objectContaining({ on: true, pitch: 55 })]);
      assist(false);
      await settleFrames(2);
      expect(rec.played.map((p) => [p.on, p.pitch])).toEqual([
        [true, 55],
        [false, 55],
      ]);
      await press('{/a}');
      expect(rec.played).toHaveLength(2);

      assist(true);
      await settleFrames(2);
      rec.played.length = 0;
      await press('{s>}');
      setProjectKey(9, 'minor');
      await settleFrames(2);
      expect(rec.played.map((p) => [p.on, p.pitch])).toEqual([
        [true, 57],
        [false, 57],
      ]);
      await press('{/s}');
      expect(rec.played).toHaveLength(2);
    } finally {
      rec.restore();
    }
  });

  it('switching Assist under a held mouse key releases it at once', async () => {
    await bass();
    const rec = recordPlayed();
    try {
      const p = centre(keys()[3], 0.5, 0.6);
      await mouse('mouseMoved', p);
      await mouse('mousePressed', p);
      expect(rec.ons().map((x) => x.pitch)).toEqual([60]);
      assist(false);
      await settleFrames(2);
      expect(rec.played.map((x) => [x.on, x.pitch])).toEqual([
        [true, 60],
        [false, 60],
      ]);
      await mouse('mouseReleased', p);
      await settleFrames(2);
      expect(rec.played).toHaveLength(2);
    } finally {
      rec.restore();
    }
  });
});

describe('accessibility', () => {
  /** Serious and critical axe-core findings in the keyboard strip. */
  async function audit(): Promise<string[]> {
    const w = window as unknown as { axe?: { run(context: Element, options: Record<string, unknown>): Promise<AxeResults> } };
    if (!w.axe) {
      const script = document.createElement('script');
      script.textContent = axeSource;
      document.head.appendChild(script);
    }
    const r = await w.axe!.run(strip(), { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }

  it('the keys are buttons named by their note, not Tab stops; the strip passes axe-core with the scale keyboard and the piano', async () => {
    await bass();
    for (const k of keys()) {
      expect(k.getAttribute('role')).toBe('button');
      expect(k.tabIndex).toBe(-1);
      expect(k.hasAttribute('tabindex')).toBe(false);
    }
    expect(await audit()).toEqual([]);
    assist(false);
    await settleFrames(2);
    expect(names().slice(0, 3)).toEqual(['C4', 'D♭4', 'D4']);
    expect(names()).toContain('G4 (root)');
    expect(await audit()).toEqual([]);
  });
});
