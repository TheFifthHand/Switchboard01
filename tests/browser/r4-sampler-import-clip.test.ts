/**
 * shape-05 (UI): an import makes a new clip that plays the file as
 * recorded. The whole app (House starter), files handed to the real file
 * input through the browser (Playwright's file chooser path), outcomes
 * checked on the project and in offline renders of the Vocal part:
 * - a 2-bar 100 BPM loop imported onto Vocal lands in a new clip, which plays
 *   it at root pitch 60 (its own pitch); "Oh Chops" and "Long Oh" still play
 *   Vocal "Oh" exactly as before; the editor selects the new clip and shows
 *   its recording; the toast carries the session's message, with Undo;
 * - with no empty pad the sound browser explains the refusal and nothing is
 *   decoded or stored;
 * - onto a synth part with clips it asks first and offers the sampler part.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import * as db from '../../src/persistence/db';
import type { SamplerInstrument } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { selectTrack, uiStore } from '../../src/state/uiStore';
import { button, clickEl, difference, loopWav, openApp, press, project, renderPart, setUp, shapeOn, strongestSemitone, tearDown, track, until } from './r4-sampler-helpers';
import { settleFrames } from './r4-uikit-input';

/** Hand `file` to a file input as the browser's file chooser does (trusted, through Playwright). */
async function chooseFile(input: HTMLInputElement | null, file: File): Promise<void> {
  if (!input) throw new Error('no file input');
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await userEvent.upload(input, file);
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = true;
  }
  await settleFrames();
}

const editor = () => document.querySelector<HTMLElement>('[aria-label^="Waveform of"]')?.closest<HTMLElement>('section')?.parentElement ?? null;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');

beforeEach(async () => {
  await setUp();
});
afterEach(async () => {
  await tearDown();
});

describe('Import a loop as a new clip (shape-05)', () => {
  it('a 2-bar 100 BPM WAV onto Vocal: a new clip plays it at root 60; Oh Chops and Long Oh still play Vocal "Oh"; the editor shows the new clip; the toast says it, with Undo', { timeout: 240_000 }, async () => {
    await openApp(1366, 768);
    const before = project();
    const t8 = before.tracks.find((t) => t.id === 't8')!;
    expect(t8.instrument).toMatchObject({ kind: 'sampler', sampleId: 'builtin:vocal-oh' });
    expect(t8.clips.map((c) => c?.name ?? null)).toEqual([null, null, 'Oh Chops', 'Long Oh']);
    const lift = await renderPart(before, 't8', 2);
    const brk = await renderPart(before, 't8', 3);

    await shapeOn('t8');
    const ed = editor();
    expect(ed, 'the sampler editor').not.toBeNull();
    const input = [...ed!.querySelectorAll<HTMLInputElement>('input[type="file"]')][0] ?? null;
    await chooseFile(input, loopWav('Loop 100.wav', { bars: 2, bpm: 100, hz: 440 }));
    await until(() => project().samples.length === before.samples.length + 1, 'the recording in the project', 15000);

    const p = project();
    const meta = p.samples.find((s) => s.name === 'Loop 100')!;
    expect(meta.duration).toBeCloseTo(4.8, 2);
    const vocal = p.tracks.find((t) => t.id === 't8')!;
    // A new clip on the first empty pad, playing the file itself, once, at root 60: 4.8 s is 2 bars at 124 BPM.
    const slot = vocal.clips.findIndex((c) => c?.sample?.id === meta.id);
    expect(slot).toBe(0);
    const clip = vocal.clips[slot]!;
    expect(clip.name).toBe('Loop 100');
    expect(clip.bars).toBe(2);
    expect(clip.sample).toEqual({ id: meta.id, start: 0, end: 1, rootNote: 60 });
    expect(clip.notes).toEqual([expect.objectContaining({ tick: 0, pitch: 60, duration: 768 })]);
    // The part and its other clips are untouched.
    expect((vocal.instrument as SamplerInstrument).sampleId).toBe('builtin:vocal-oh');
    expect(vocal.clips[2]).toBe(t8.clips[2]);
    expect(vocal.clips[3]).toBe(t8.clips[3]);
    expect(vocal.clips[2]?.sample).toBeUndefined();
    expect(vocal.clips[3]?.sample).toBeUndefined();
    expect(await db.getSample(meta.id)).toBeTruthy();

    // The editor selects the new clip and shows its recording.
    expect(uiStore.getState().selectedSlot.t8).toBe(slot);
    await until(() => (editor()?.textContent ?? '').includes('Loop 100 — plays in Vocal · Intro'), 'the editor on the new clip');
    expect(document.querySelector<HTMLSelectElement>('#sampler-recording-t8')?.value).toBe(meta.id);
    expect(document.querySelector('[aria-label="Waveform of Loop 100. Drag Start and End to trim."]')).not.toBeNull();
    // Vocal plays its clips in Loop mode: the editor says what that does to the new recording.
    expect(editor()!.textContent).toContain('Vocal’s settings change how this recording sounds: Loop mode (it repeats while its note lasts, and stops with it).');
    // The toast carries the session's message, tied to the import's undo step.
    const notice = runtimeStore.getState().notice!;
    expect(notice.text).toMatch(/^Imported “Loop 100” as a new clip on Vocal · Intro\. /);
    expect(notice.action).toBe('undo');
    expect(notice.entry).toBe(session.store.undoEntryId());

    // What is heard: the new clip plays the loop at its own pitch (440 Hz, not 2-7 semitones up as before).
    const loop = await renderPart(p, 't8', slot);
    expect(strongestSemitone(loop, 440)).toBe(0);
    // Oh Chops and Long Oh sound exactly as before.
    expect(difference(await renderPart(p, 't8', 2), lift)).toBeLessThan(1e-3);
    expect(difference(await renderPart(p, 't8', 3), brk)).toBeLessThan(1e-3);

    // One Undo takes the clip and the recording away again.
    act(() => session.undo());
    expect(project().tracks.find((t) => t.id === 't8')!.clips[slot]).toBeNull();
    expect(project().samples.some((s) => s.id === meta.id)).toBe(false);
  });

  it('no empty pad: the sound browser explains the refusal; nothing is decoded, stored or changed', async () => {
    await openApp(1366, 768);
    act(() => {
      cmd.createClip(session.store, 't8', 0, 1, 'Fill A');
      cmd.createClip(session.store, 't8', 1, 1, 'Fill B');
      selectTrack('t8');
    });
    await settleFrames();
    const before = project();
    const stored = new Set(await db.listSampleIds());
    await clickEl([...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Change instrument"]')].find((b) => b.offsetParent !== null) ?? null);
    await until(() => !!dialog(), 'the sound browser');
    // Vocal plays a recording: the browser opens on Recordings, with the import key.
    expect(dialog()!.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Recordings');
    await chooseFile(dialog()!.querySelector<HTMLInputElement>('input[type="file"]'), loopWav('Full.wav'));
    await until(() => !!dialog()!.querySelector('[role="alert"]'), 'the refusal');
    const alert = dialog()!.querySelector('[role="alert"]')!.textContent ?? '';
    expect(alert).toContain('Vocal has no empty pad: all 4 of its rows hold clips, and an import makes a new clip.');
    expect(alert).toContain('Delete or move a clip on Vocal, or add a scene in Play for a new row, then import again.');
    expect(project()).toBe(before);
    await new Promise((r) => setTimeout(r, 50));
    expect(new Set(await db.listSampleIds())).toEqual(stored);
    // The message goes away when dismissed; the dialog stays.
    await clickEl(button('Dismiss import message', dialog()!));
    expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
  });

  it('onto a synth part with clips the sound browser asks first, and puts the file on the sampler part instead when asked', async () => {
    await openApp(1366, 768);
    const chords = track('t4');
    expect(chords.instrument.kind).toBe('poly');
    const vocalBefore = track('t8');
    act(() => selectTrack('t4'));
    await settleFrames();
    await clickEl([...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Change instrument"]')].find((b) => b.offsetParent !== null) ?? null);
    await until(() => !!dialog(), 'the sound browser');
    await clickEl([...dialog()!.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.includes('Recordings')) ?? null);
    await chooseFile(dialog()!.querySelector<HTMLInputElement>('input[type="file"]'), loopWav('Keys loop.wav'));
    await until(() => !!dialog()!.textContent?.includes('Import “Keys loop.wav” onto Chords?'), 'the question');
    const ask = [...dialog()!.querySelectorAll<HTMLElement>('[role="group"]')].find((g) => g.textContent?.includes('Import “Keys loop.wav” onto Chords?'))!;
    expect(ask.textContent).toContain('Chords plays the synth House Stab. An import makes Chords a sampler, and its');
    expect(ask.textContent).toContain('your recording at their notes’ pitches');
    // Nothing has changed yet, and the choice has the keyboard.
    expect(track('t4')).toBe(chords);
    expect(document.activeElement).toBe(button('Put it on Vocal instead', ask));
    await clickEl(button('Put it on Vocal instead', ask));
    await until(() => track('t8').clips.some((c) => c?.name === 'Keys loop'), 'the clip on Vocal', 15000);
    expect(track('t4')).toBe(chords);
    expect((track('t8').instrument as SamplerInstrument).sampleId).toBe((vocalBefore.instrument as SamplerInstrument).sampleId);
    // The dialog stays on Chords and says where the file went.
    expect(dialog()!.querySelector('h2')?.textContent).toBe('Change instrument: Chords');
    await until(() => !!dialog()!.textContent?.includes('Put on Vocal instead. Imported “Keys loop”'), 'where it went');
  });

  it('onto a synth part with clips, "Import onto Chords anyway" makes it a sampler with the new clip (one Undo brings House Stab back); Cancel imports nothing', async () => {
    await openApp(1366, 768);
    const chords = track('t4');
    act(() => selectTrack('t4'));
    await settleFrames();
    await clickEl([...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Change instrument"]')].find((b) => b.offsetParent !== null) ?? null);
    await until(() => !!dialog(), 'the sound browser');
    await clickEl([...dialog()!.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.includes('Recordings')) ?? null);
    const input = () => dialog()!.querySelector<HTMLInputElement>('input[type="file"]');
    const group = () => [...dialog()!.querySelectorAll<HTMLElement>('[role="group"]')].find((g) => g.textContent?.includes('onto Chords?')) ?? null;
    // A sound tried first: a question answered with Cancel leaves the browse as it was.
    const tab = (name: string) => [...dialog()!.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.includes(name)) ?? null;
    await clickEl(tab('Keys'));
    await clickEl([...dialog()!.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes('Glass Keys')) ?? null);
    await until(() => track('t4').instrument.kind === 'poly' && (track('t4').instrument as { presetId?: string }).presetId === 'poly-glass-keys', 'Glass Keys on Chords');
    await clickEl(tab('Recordings'));
    await chooseFile(input(), loopWav('Nope.wav'));
    await until(() => !!group(), 'the question');
    await clickEl(button('Cancel', group()!));
    expect(group()).toBeNull();
    expect(button('Cancel (back to House Stab as you had it)', dialog()!)).not.toBeNull();
    await clickEl(button('Cancel (back to House Stab as you had it)', dialog()!));
    await until(() => !dialog(), 'the dialog to close');
    expect(track('t4')).toEqual(chords);
    await clickEl([...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Change instrument"]')].find((b) => b.offsetParent !== null) ?? null);
    await until(() => !!dialog(), 'the sound browser again');
    await clickEl([...dialog()!.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.includes('Recordings')) ?? null);
    await chooseFile(input(), loopWav('Here.wav'));
    await until(() => !!group(), 'the question again');
    // From the keyboard: the question has focus on its first key; Tab to the next, Enter.
    expect(document.activeElement).toBe(button('Put it on Vocal instead', group()!));
    await press('{Tab}');
    expect(document.activeElement).toBe(button('Import onto Chords anyway', group()!));
    await press('{Enter}');
    await until(() => track('t4').instrument.kind === 'sampler', 'Chords to be a sampler', 15000);
    expect(track('t4').clips.find((c) => c?.sample)?.name).toBe('Here');
    // The dialog says what happened (no toast over its keys).
    await until(() => !!dialog()!.textContent?.includes('Chords plays recordings now, so its other clips play this one at their notes’ pitches.'), 'the result in the dialog');
    await clickEl(button('Done', dialog()!));
    act(() => session.undo());
    expect(track('t4').instrument).toEqual(chords.instrument);
    expect(track('t4').clips).toEqual(chords.clips);
    // The question, the cancelled browse and the import left one step: the import's.
    expect(session.store.undoLabel()).not.toBe('Change sound');
  });
});
