/**
 * The sound browser never takes over edits made elsewhere (review fixes).
 * The whole app (House starter), real clicks and keys, the "microphone" a
 * stream from the session's own AudioContext:
 * - an audio take that lands while the browser is open stays its own undo
 *   step ("Record audio"); Cancel neither absorbs nor undoes it (M1);
 * - a pending import question stays in sight on every category, Cancel keeps
 *   working, and closing the dialog drops the question (M2);
 * - Cancel's "as you had it" stays put after an import put on another part,
 *   and a failed import leaves no step behind (minors 1 and 2);
 * - the last import's message does not come back when the dialog reopens (minor 4).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { session } from '../../src/app/instance';
import { runtimeStore } from '../../src/app/runtime';
import { audioInput } from '../../src/app/views/devices';
import { importStore } from '../../src/app/views/sampler/importState';
import type { SamplerInstrument } from '../../src/project/types';
import { selectTrack } from '../../src/state/uiStore';
import { button, clickEl, loopWav, openApp, press, project, setUp, shapeOn, tearDown, track, until } from './r4-sampler-helpers';
import { settleFrames } from './r4-uikit-input';

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
const card = (name: string) => [...(dialog()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find((o) => o.textContent?.includes(name)) ?? null;
const tab = (name: string) => [...(dialog()?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].find((t) => t.textContent?.includes(name)) ?? null;
const question = () => [...(dialog()?.querySelectorAll<HTMLElement>('[role="group"]') ?? [])].find((g) => g.textContent?.startsWith('Import “')) ?? null;
const cancelKey = () => [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Cancel (back to')) ?? null;

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

/** The Play view's Change instrument key for the selected part. */
async function openFromPlay(trackId: string): Promise<void> {
  act(() => selectTrack(trackId));
  await settleFrames();
  await clickEl([...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Change instrument"]')].find((b) => b.offsetParent !== null) ?? null);
  await until(() => !!dialog(), 'the sound browser');
}

function fakeMic(): void {
  const ctx = session.ctx as AudioContext;
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 1;
  const osc = new OscillatorNode(ctx, { frequency: 440 });
  osc.connect(new GainNode(ctx, { gain: 0.4 })).connect(dest);
  osc.start();
  vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async () => new MediaStream(dest.stream.getAudioTracks().map((t) => t.clone())));
  vi.spyOn(navigator.mediaDevices, 'enumerateDevices').mockResolvedValue([{ deviceId: 'mic-1', groupId: 'g', kind: 'audioinput', label: 'Test microphone', toJSON: () => ({}) } as MediaDeviceInfo]);
}

/** Shape → Vocal, 4 bars (time to browse before it lands), no count-in, Record audio pressed, then Change sound opened at once. */
async function takeWhileBrowsing(): Promise<void> {
  await openApp(1366, 768);
  expect(await session.startAudio()).toBe(true);
  fakeMic();
  await shapeOn('t8');
  act(() => {
    audioInput.setBars(4);
    audioInput.setCountIn(false);
  });
  await clickEl(button('Record audio'));
  await clickEl(document.querySelector<HTMLButtonElement>('button[aria-label^="Sound: "][aria-label$="Change sound"]'));
  await until(() => !!dialog(), 'the sound browser');
  expect(track('t8').clips.some((c) => c?.name === 'Recording 1'), 'the take has not landed yet').toBe(false);
}

beforeEach(async () => {
  await setUp();
});
afterEach(async () => {
  if (audioInput.state.getState().take) audioInput.stopTake('button');
  audioInput.close();
  vi.restoreAllMocks();
  await tearDown();
});

describe('The sound browser and edits made elsewhere (M1)', () => {
  it('a take that lands while the browser is open stays its own step; Cancel leaves it alone and offers no Undo', { timeout: 120_000 }, async () => {
    await takeWhileBrowsing();
    await until(() => track('t8').clips.some((c) => c?.name === 'Recording 1'), 'the take to land', 40000);
    act(() => session.stop());
    expect(session.store.undoLabel()).toBe('Record audio');
    const withTake = project();
    await clickEl(cancelKey());
    await until(() => !dialog(), 'the dialog to close');
    // Nothing to put back: no step, no Undo offered, the take untouched.
    expect(project()).toBe(withTake);
    expect(session.store.undoLabel()).toBe('Record audio');
    expect(runtimeStore.getState().notice?.action).toBeUndefined();
    // Undo now undoes the take (and only that).
    act(() => session.undo());
    expect(track('t8').clips.some((c) => c?.name === 'Recording 1')).toBe(false);
  });

  it('a sound chosen before the take lands: Cancel puts the sound back as its own step, and the take stays', { timeout: 120_000 }, async () => {
    await takeWhileBrowsing();
    await clickEl(card('Bell Hit'));
    await until(() => (track('t8').instrument as SamplerInstrument).sampleId === 'builtin:bell-hit', 'Bell Hit on Vocal');
    await until(() => track('t8').clips.some((c) => c?.name === 'Recording 1'), 'the take to land', 40000);
    act(() => session.stop());
    expect(session.store.undoLabel()).toBe('Record audio');
    expect(cancelKey()?.getAttribute('aria-label')).toBe('Cancel (back to Vocal "Oh" as you had it)');
    await clickEl(cancelKey());
    await until(() => !dialog(), 'the dialog to close');
    expect((track('t8').instrument as SamplerInstrument).sampleId).toBe('builtin:vocal-oh');
    const take = track('t8').clips.find((c) => c?.name === 'Recording 1');
    expect(take?.sample?.id).toBeTruthy();
    expect(project().samples.some((s) => s.id === take!.sample!.id)).toBe(true);
    // The steps, newest first: Cancel's, the take, the choice. Each undoes only itself.
    expect(session.store.undoLabel()).toBe('Back to Vocal "Oh"');
    expect(runtimeStore.getState().notice?.action).toBe('undo');
    act(() => session.undo());
    expect((track('t8').instrument as SamplerInstrument).sampleId).toBe('builtin:bell-hit');
    expect(session.store.undoLabel()).toBe('Record audio');
    act(() => session.undo());
    expect(track('t8').clips.some((c) => c?.name === 'Recording 1')).toBe(false);
    expect(session.store.undoLabel()).toBe('Change sound');
  });
});

describe('A pending import question (M2) and import results', () => {
  it('stays in sight on every category; Cancel works; closing drops it and reopening starts clean', async () => {
    await openApp(1366, 768);
    const chords = track('t4');
    await openFromPlay('t4');
    await clickEl(tab('Recordings'));
    await chooseFile(dialog()!.querySelector<HTMLInputElement>('input[type="file"]'), loopWav('Ask.wav'));
    await until(() => !!dialog()!.textContent?.includes('Import “Ask.wav” onto Chords?'), 'the question');
    // Another category: the question is still there, and so is the import's file input's state.
    await clickEl(tab('Bass'));
    expect(dialog()!.textContent).toContain('Import “Ask.wav” onto Chords?');
    expect(dialog()!.querySelector('[role="tabpanel"] h3')?.textContent).toBe('Bass');
    // The whole dialog still fits the window.
    const r = dialog()!.getBoundingClientRect();
    expect(r.bottom).toBeLessThanOrEqual(768 + 0.5);
    // Cancel is never held up by it.
    expect(cancelKey()!.disabled).toBe(false);
    await press('{Escape}');
    await until(() => !dialog(), 'Escape to close');
    // Closing dropped the question: nothing waits, nothing was imported.
    expect(importStore.getState().t4?.phase ?? 'idle').toBe('idle');
    expect(track('t4')).toBe(chords);
    await openFromPlay('t4');
    expect(dialog()!.textContent).not.toContain('onto Chords?');
    expect(cancelKey()!.disabled).toBe(false);
    await clickEl(cancelKey());
    await until(() => !dialog(), 'Cancel to close');
  });

  it('the last import’s message (a refusal here) does not come back when the dialog opens again', async () => {
    await openApp(1366, 768);
    // Vocal full: every row has a clip.
    act(() => {
      for (const slot of [0, 1]) session.store.apply('clip:Create clip', (d) => void (d.tracks.find((t) => t.id === 't8')!.clips[slot] = { id: `fill${slot}`, name: `Fill ${slot}`, bars: 1, notes: [] }));
    });
    await openFromPlay('t8');
    await chooseFile(dialog()!.querySelector<HTMLInputElement>('input[type="file"]'), loopWav('Full.wav'));
    await until(() => !!dialog()!.querySelector('[role="alert"]'), 'the refusal');
    await clickEl(button('Done', dialog()!));
    await until(() => !dialog(), 'Done to close');
    await openFromPlay('t8');
    expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
    expect(dialog()!.textContent).not.toContain('has no empty pad');
  });

  it('an import put on another part leaves Cancel’s "as you had it" where it was (minor 1)', async () => {
    await openApp(1366, 768);
    await openFromPlay('t4');
    await clickEl(tab('Keys'));
    await clickEl(card('Tine Piano'));
    await until(() => (track('t4').instrument as { presetId?: string }).presetId === 'poly-tine-piano', 'Tine Piano');
    await clickEl(tab('Recordings'));
    await chooseFile(dialog()!.querySelector<HTMLInputElement>('input[type="file"]'), loopWav('Elsewhere.wav'));
    await until(() => !!question(), 'the question');
    await clickEl(button('Put it on Vocal instead', question()!));
    await until(() => track('t8').clips.some((c) => c?.name === 'Elsewhere'), 'the clip on Vocal', 15000);
    expect(cancelKey()?.getAttribute('aria-label')).toBe('Cancel (back to House Stab as you had it)');
    await clickEl(cancelKey());
    await until(() => !dialog(), 'Cancel to close');
    expect((track('t4').instrument as { presetId?: string }).presetId).toBe('poly-house-stab');
    // The import onto Vocal stays.
    expect(track('t8').clips.some((c) => c?.name === 'Elsewhere')).toBe(true);
  });

  it('a file that does not decode, mid-browse, leaves the browse one step and Cancel no step (minor 2)', async () => {
    await openApp(1366, 768);
    act(() => session.setMacro('t4', 'tone', 0.7));
    const before = track('t4');
    const broken = () => new File([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 5, 6, 7, 8])], 'broken.wav', { type: 'audio/wav' });
    const browseWithFailedImport = async () => {
      await openFromPlay('t4');
      await clickEl(card('Tine Piano'));
      await clickEl(tab('Recordings'));
      // Not a WAV the browser can read: refused once decoding fails.
      await chooseFile(dialog()!.querySelector<HTMLInputElement>('input[type="file"]'), broken());
      // Chords has clips: it asks first; onto Chords anyway, then the file fails to decode.
      await until(() => !!question(), 'the question');
      await clickEl(button('Import onto Chords anyway', question()!));
      await until(() => !!dialog()!.querySelector('[role="alert"]'), 'the decode error');
      await clickEl(tab('Keys'));
      await clickEl(card('Glass Keys'));
      expect(session.store.undoLabel()).toBe('Change sound');
    };
    // Cancel: back to House Stab with Tone 0.7, no step left, no Undo offered.
    await browseWithFailedImport();
    await clickEl(cancelKey());
    await until(() => !dialog(), 'Cancel to close');
    expect(track('t4')).toEqual(before);
    expect(session.store.undoLabel()).toBe('Change Tone');
    expect(runtimeStore.getState().notice?.action).toBeUndefined();
    // Done: one step for the whole browse, failed import and all.
    await browseWithFailedImport();
    await clickEl(button('Done', dialog()!));
    await until(() => !dialog(), 'Done to close');
    expect((track('t4').instrument as { presetId?: string }).presetId).toBe('poly-glass-keys');
    act(() => session.undo());
    expect(track('t4')).toEqual(before);
    expect(session.store.undoLabel()).toBe('Change Tone');
  });
});
