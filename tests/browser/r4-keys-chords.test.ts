/**
 * Chord pads and "Write a progression…" in the running app with real input (PLAY-12,
 * capability-03):
 * - the Chords switch in the Notes side panel turns each pad into the chord on its scale degree,
 *   named in the key (G Dorian: Gm Am B♭ C Dm E° F), its degree small; a press sends the chord's
 *   3 notes through session.noteOn with the 'chord' source (no Musical Assist); 7ths and
 *   inversions change the notes; two pads sharing a note sound it once until both let go;
 * - Record Notes captures a chord pad (real audio, real recording);
 * - the progression dialog writes an in-key clip into the selected clip, and a sampler part is
 *   refused with the command's reason (drums too).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { progressionRefusal } from '../../src/app/views/ProgressionDialog';
import { isInScale } from '../../src/music/scales';
import { setAssist } from '../../src/state/commands';
import { selectTrack, setPadMode, slotFor, uiStore } from '../../src/state/uiStore';
import { clickEl, notice, openApp, press, project, setUp, tearDown, track, until } from './r4-play-helpers';
import { centre, click, mouse, settleFrames, touch } from './r4-uikit-input';
import { recordPlayed, resetKeyboardFold } from './r4-keys-helpers';
import { wait } from './ui-harness';

beforeEach(async () => {
  await setUp();
  resetKeyboardFold();
});
afterEach(async () => {
  await tearDown();
  // Leave the keyboard unfolded everywhere for the next test file (the fold is remembered in storage).
  resetKeyboardFold();
});

const pad = (i: number) => document.getElementById(`note-pad-${i}`) as HTMLButtonElement;
const notesOf = (i: number) => pad(i).parentElement!.dataset.notes!.split(',').map(Number);
const chordsSwitch = () => [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((s) => s.textContent?.includes('Chords'))!;
const radio = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => r.textContent?.trim() === name)!;
const inversion = () => document.querySelector<HTMLSelectElement>('[role="group"][aria-label^="Note pads for"] select')!;
async function chooseInversion(value: string): Promise<void> {
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await userEvent.selectOptions(inversion(), value);
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
  await settleFrames(2);
}
const panel = () => document.querySelector<HTMLElement>('[role="group"][aria-label^="Note pads for"]')!;
const buttonText = (text: string | RegExp) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')))!;

/** Chords part, Notes pads, chord pads on. */
async function openChords(opts: { play?: boolean } = {}): Promise<void> {
  await openApp(1366, 768, opts);
  act(() => {
    selectTrack('t4');
    setPadMode('notes');
  });
  await settleFrames(2);
  await clickEl(chordsSwitch());
  expect(uiStore.getState().notesChords.on).toBe(true);
}

describe('chord pads', () => {
  it('are named by their chord in the key with the degree small, and one press sends its 3 notes as a chord', async () => {
    await openChords();
    expect(project().root).toBe(7);
    expect(project().scale).toBe('dorian');
    const names = Array.from({ length: 8 }, (_, i) => pad(i).textContent);
    expect(names).toEqual(['Gm', 'Am', 'B♭', 'C', 'Dm', 'E°', 'F', 'Gm']);
    expect(pad(0).parentElement!.textContent).toContain('1');
    // Spelled in the key (B♭, never A#), low to high in the smooth voicing.
    expect(pad(2).getAttribute('aria-label')).toMatch(/^B♭ chord, degree 3: ([A-G]♭?\d, ){2}[A-G]♭?\d$/);
    expect(pad(2).getAttribute('aria-label')).toContain('B♭');
    // The second Gm is an octave up.
    expect(notesOf(7)).toEqual(notesOf(0).map((n) => n + 12));
    const rec = recordPlayed();
    try {
      await mouse('mouseMoved', centre(pad(0)));
      await mouse('mousePressed', centre(pad(0)));
      await wait(60);
      await mouse('mouseReleased', centre(pad(0)));
      await settleFrames();
      const ons = rec.ons();
      expect(ons).toHaveLength(3);
      expect(ons.every((p) => p.trackId === 't4' && p.source === 'chord')).toBe(true);
      expect(ons.map((p) => p.pitch)).toEqual(notesOf(0));
      expect(ons.map((p) => ((p.pitch % 12) + 12) % 12).sort((a, b) => a - b)).toEqual([2, 7, 10]); // D, G, B♭
      expect(rec.played.filter((p) => !p.on).map((p) => p.pitch)).toEqual(notesOf(0));
    } finally {
      rec.restore();
    }
  });

  it('7ths and inversions change the chords; two pads sharing notes sound each note once until both let go (two fingers)', async () => {
    await openChords();
    await clickEl(radio('7ths'));
    expect(pad(0).textContent).toBe('Gm7');
    expect(notesOf(0)).toHaveLength(4);
    await clickEl(radio('Triads'));
    await chooseInversion('1');
    // First inversion: the third (B♭) at the bottom.
    expect(notesOf(0)[0] % 12).toBe(10);
    await chooseInversion('0');
    expect(notesOf(0)[0] % 12).toBe(7);
    // Gm (G B♭ D) and B♭ (B♭ D F) share B♭ and D.
    const shared = notesOf(0).filter((n) => notesOf(2).includes(n));
    expect(shared.length).toBeGreaterThan(0);
    const rec = recordPlayed();
    try {
      const a = centre(pad(0));
      const b = centre(pad(2));
      await touch('touchStart', [a]);
      await touch('touchStart', [a, b]);
      await settleFrames();
      for (const n of shared) expect(rec.ons().filter((p) => p.pitch === n), `note ${n}`).toHaveLength(1);
      // The first finger lifts: the shared notes keep sounding for the second pad.
      await touch('touchEnd', [b]);
      await settleFrames();
      const offs = () => rec.played.filter((p) => !p.on).map((p) => p.pitch);
      for (const n of shared) expect(offs()).not.toContain(n);
      await touch('touchEnd', []);
      await settleFrames();
      for (const n of [...notesOf(0), ...notesOf(2)]) expect(offs()).toContain(n);
    } finally {
      rec.restore();
    }
  });

  it('after Stop releases every note, a held pad does not keep the next chord’s shared notes silent (two fingers, Shift+Space)', async () => {
    await openChords();
    const gm = notesOf(0);
    const bb = notesOf(2);
    const shared = gm.filter((n) => bb.includes(n));
    expect(shared.length).toBeGreaterThan(0);
    const rec = recordPlayed();
    try {
      const a = centre(pad(0));
      const b = centre(pad(2));
      await touch('touchStart', [a]);
      await settleFrames();
      // Stop (Shift+Space) releases every note while the finger is still down.
      await press('{Shift>} {/Shift}');
      rec.played.length = 0;
      await touch('touchStart', [a, b]);
      await settleFrames();
      expect(rec.ons().map((p) => p.pitch)).toEqual(bb);
      // The first finger lifts: its release (from before the Stop) ends nothing of the new chord.
      await touch('touchEnd', [b]);
      await settleFrames();
      expect(rec.played.filter((p) => !p.on)).toEqual([]);
      await touch('touchEnd', []);
      await settleFrames();
      expect(rec.played.filter((p) => !p.on).map((p) => p.pitch)).toEqual(bb);
    } finally {
      rec.restore();
    }
  });

  it('Record Notes captures a chord pad: its 3 notes land together in the clip', async () => {
    await openChords({ play: true });
    const slot = slotFor(uiStore.getState(), 't4');
    const before = new Set(track('t4').clips[slot]!.notes.map((n) => n.id));
    const chord = notesOf(4);
    const rec = [...document.querySelectorAll<HTMLButtonElement>('header[aria-label="Transport"] button')].find((b) => b.textContent?.trim() === 'Notes')!;
    await clickEl(rec);
    await until(() => runtimeStore.getState().recording === 'notes' && runtimeStore.getState().recordStartsAtTick == null, 'recording to start', 10000);
    await mouse('mouseMoved', centre(pad(4)));
    await mouse('mousePressed', centre(pad(4)));
    await wait(250);
    await mouse('mouseReleased', centre(pad(4)));
    await wait(120);
    await clickEl(rec);
    await until(() => runtimeStore.getState().recording === 'off', 'recording to stop');
    const added = track('t4').clips[slot]!.notes.filter((n) => !before.has(n.id));
    expect(added.map((n) => n.pitch).sort((x, y) => x - y)).toEqual(chord);
    expect(new Set(added.map((n) => n.tick)).size).toBe(1);
  });
});

describe('Write a progression…', () => {
  it('writes an in-key clip (Sad pop, stabs, 2 bars) into the selected clip, with an Undo toast', async () => {
    await openChords();
    const slot = slotFor(uiStore.getState(), 't4');
    await clickEl(buttonText('Write a progression…'));
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!;
    await until(() => !!dialog(), 'the dialog');
    // Progressions in plain words, with their chords in the key.
    const sad = [...dialog().querySelectorAll('label')].find((l) => l.textContent?.startsWith('Sad pop'))!;
    expect(sad.textContent).toMatch(/Sad pop.+[A-G]/);
    await click(centre(sad));
    await click(centre(radio('Stabs')));
    await click(centre(radio('2')));
    // The preview shows the chords to hear.
    const chips = [...dialog().querySelectorAll<HTMLButtonElement>('button[aria-label^="Hear "]')];
    expect(chips.length).toBe(4);
    const write = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith('Write into'))!;
    await click(centre(write));
    await until(() => !dialog(), 'the dialog to close');
    const c = track('t4').clips[slot]!;
    expect(c.bars).toBe(2);
    expect(c.notes.length).toBeGreaterThan(12);
    for (const n of c.notes) expect(isInScale(n.pitch, 7, 'dorian'), `note ${n.pitch}`).toBe(true);
    expect(notice()).toMatch(/^Wrote the Sad pop progression \(.+\) into Chords · /);
    expect(session.store.undoLabel()).toBe('Write the Sad pop progression');
  });

  it('a sampler part is refused with a reason (and a drum part, in the command’s words)', async () => {
    await openApp(1366, 768);
    act(() => {
      selectTrack('t8');
      setPadMode('notes');
    });
    await settleFrames(2);
    expect(track('t8').instrument.kind).toBe('sampler');
    const write = buttonText('Write a progression…');
    expect(write.disabled).toBe(true);
    const why = document.getElementById(write.getAttribute('aria-describedby')!.split(' ').find((id) => id.startsWith('write-why'))!)!;
    expect(why.textContent).toMatch(/^Sampler parts play a recording/);
    expect(progressionRefusal(project(), 't1')).toMatch(/^Drum parts play sounds, not chords/);
    expect(progressionRefusal(project(), 't4')).toBeNull();
  });
});

describe('the Notes side panel fits at 1366 x 768', () => {
  for (const mode of ['notes', 'chords', 'chromatic'] as const) {
    it(`${mode}: everything shows without scrolling, nothing sticks out sideways`, async () => {
      await openApp(1366, 768);
      act(() => {
        selectTrack('t4');
        setPadMode('notes');
        uiStore.setState((st) => ({ ...st, notesChords: { on: mode === 'chords', size: 3 } }));
      });
      if (mode === 'chromatic') act(() => void session.accepted(setAssist(session.store, false)));
      await settleFrames(3);
      const p = panel();
      expect(p.scrollHeight, 'scroll height').toBeLessThanOrEqual(p.clientHeight + 1);
      const box = p.getBoundingClientRect();
      for (const el of p.querySelectorAll<HTMLElement>('button, select, [role="switch"], p, h3')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        expect(r.right, el.textContent ?? '').toBeLessThanOrEqual(box.right + 0.5);
        expect(r.bottom, el.textContent ?? '').toBeLessThanOrEqual(box.bottom + 0.5);
      }
      expect(p.textContent).toContain(mode === 'chords' ? 'Last chord' : 'Last note');
      expect(p.textContent).toContain('Strike lower on a pad to play louder.');
      if (mode === 'chromatic') expect(p.textContent).toContain('Shaded pads are outside G Dorian.');
    });
  }
});
