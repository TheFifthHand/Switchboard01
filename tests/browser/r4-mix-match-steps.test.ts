/**
 * How Match target steps (MIX-17), in real Chromium with the Mix view and the session's meter read
 * replaced by readings that follow Loudness drive the way a limiter does (it swallows part of each
 * push), so every step is known:
 * - A first reading within 0.5 dB of the target changes nothing: "Already on the … target".
 * - One pass moves Loudness drive at most 6 dB; the next pass is scaled by how far the last one
 *   actually moved the reading (a secant step), so it lands in two passes where a plain
 *   dB-for-dB step would need three. All passes of one press are one undo step and one toast.
 * - Readings that are not of the music being matched (quieter than −40 LUFS, or more than 12 dB
 *   from the last one) are skipped; after 8 s without a usable one Match stops, drive unchanged.
 *   A reading that went the other way after a pass (the song got quieter by itself) stops it too.
 * - The A/B comparison and Mute All stop it (with words); Mute All also keeps it from starting.
 * - "Match target in Mix" (the export report) brings Match into view and focuses it, whether Mix
 *   is already open or opens for it.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import type { MeterFrame } from '../../src/audio/contracts';
import { TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { MixView } from '../../src/app/views/mix/MixView';
import { STOPPED_COMPARE, STOPPED_MUTE_ALL, STOPPED_QUIET, STOPPED_UNSTEADY, matchState, requestMatchFocus, resetLoudnessWatch } from '../../src/app/views/mix/loudnessMatch';
import { resetMixFrame } from '../../src/app/views/mix/mixMeters';
import { setLoudnessTarget } from '../../src/app/views/mix/mixPrefs';
import { createProject } from '../../src/project/factory';
import { MASTERING_PARAMS, readParam } from '../../src/project/params';
import { setUiMode, setView } from '../../src/state/uiStore';
import { cleanup, mount, wait } from './ui-harness';
import { settleFrames } from './r4-uikit-input';

const drive = () => readParam(MASTERING_PARAMS, session.store.getState().mastering.params, 'loudness');

/** The loudness the fake output reads: `base` at drive 0, `slope` dB of reading per dB of drive. */
let response = { base: -16, slope: 0.6, integrated: -16 as number | null };
/** Override: what every reading says, whatever the drive (silence, a jump). */
let forced: number | null = null;

function fakeMeters() {
  const out: MeterFrame = { masterPeakL: 0.5, masterPeakR: 0.5, masterRms: 0.2, limiterReductionDb: 1, tracks: [] };
  return vi.spyOn(session, 'readMetersShared').mockImplementation(() => {
    const v = forced ?? response.base + response.slope * drive();
    out.tracks = session.store.getState().tracks.map((t) => ({ trackId: t.id, peak: 0.3, rms: 0.1 }));
    out.loudness = { momentary: v, shortTerm: v, integrated: forced ?? response.integrated ?? v, truePeakDb: -1.2 };
    return out;
  });
}

let root: HTMLElement;
const matchKey = () => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^Match target|^Matching…/.test(b.querySelector('[data-shown]')?.textContent ?? ''))!;
const result = () => root.querySelector<HTMLElement>('[data-testid="match-result"]')!.textContent ?? '';
const press = (el: HTMLElement) => act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (test()) return true;
    await act(async () => wait(100));
  }
  return test();
}

async function setup(target: 'streaming' | 'loud' = 'loud', size: [number, number] = [1366, 768], beforeMount?: () => void) {
  const [w, hh] = size;
  await page.viewport(w, hh);
  setLoudnessTarget(target);
  act(() => {
    session.store.replace(createProject({ name: 'Match steps', now: 1 }), { resetHistory: true });
    setUiMode('simple');
    setView('mix');
  });
  resetMixFrame();
  fakeMeters();
  resetLoudnessWatch();
  // The music plays (the readings count as fresh music from here).
  act(() => patchRuntime({ playing: true, paused: false }));
  beforeMount?.();
  const m = mount(h(TipsProvider, { enabled: false }, h(MixView)), { width: w });
  m.container.style.padding = '0';
  // The workspace between the transport and the keyboard bar (collapsed in Mix).
  m.container.style.height = `${hh - 102}px`;
  root = m.container;
  await settleFrames(3);
  // Ready once the panel has a reading to match from (the key is no longer blocked).
  expect(await until(() => !!matchKey() && matchKey().getAttribute('aria-disabled') === null, 4000)).toBe(true);
  return m;
}

beforeEach(() => {
  response = { base: -16, slope: 0.6, integrated: -16 };
  forced = null;
  runtimeStore.setState((s) => ({ ...s, notice: null, recording: 'off', muteAll: false, playing: false }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  act(() => patchRuntime({ playing: false, muteAll: false }));
  resetMixFrame();
  resetLoudnessWatch();
  setLoudnessTarget('streaming');
});

describe('Match target steps', () => {
  it('a first reading within 0.5 dB of the target changes nothing and says so', async () => {
    response = { base: -14.3, slope: 1, integrated: -14.3 };
    await setup('streaming');
    await press(matchKey());
    expect(drive()).toBe(0);
    expect(matchState().matching).toBeNull();
    expect(result()).toBe('Already on the Streaming target: integrated −14.3 LUFS (within 0.5 dB).');
    expect(runtimeStore.getState().notice).toBeNull();
    expect(session.store.undoLabel()).toBeNull();
  });

  it('one pass moves drive 6 dB at most; the next is scaled by what the last did; all passes are one undo step and one toast', async () => {
    await setup('loud');
    // −16 LUFS against −9: 7 dB short, but one pass moves 6 dB.
    await press(matchKey());
    expect(drive()).toBe(6);
    expect(matchState().matching).toEqual({ applied: 1 });
    const first = runtimeStore.getState().notice!;
    expect(first.text).toMatch(/^Matching the Loud target: Loudness drive 0\.0 dB → \+6\.0 dB \(the integrated reading was −16\.0 LUFS\)\. Checking again/);
    // The reading moved 3.6 dB for 6 dB of drive (0.6 per dB): the second pass asks for 3.4 / 0.6 dB.
    expect(await until(() => (matchState().matching?.applied ?? 0) >= 2 || matchState().matching === null, 6000)).toBe(true);
    expect(drive()).toBeCloseTo(11.7, 5);
    // −16 + 0.6 × 11.7 = −8.98: on the target after two passes.
    expect(await until(() => matchState().matching === null, 6000)).toBe(true);
    expect(drive()).toBeCloseTo(11.7, 5);
    expect(result()).toBe('On the Loud target: short-term −9.0 LUFS after 2 passes.');
    // One toast for the press, about the same undo step all along, now summing up.
    const last = runtimeStore.getState().notice!;
    expect(last.text).toBe('Loudness drive 0.0 dB → +11.7 dB. On the Loud target: short-term −9.0 LUFS after 2 passes.');
    expect(last.action).toBe('undo');
    expect(last.entry).toBe(first.entry);
    // One undo step takes both passes back.
    expect(session.store.undoLabel()).toMatch(/Match loudness target/);
    act(() => session.undo());
    expect(drive()).toBe(0);
    expect(session.store.undoLabel()).toBeNull();
  }, 20_000);

  it('skips readings of silence or of a jump no pass could make; after 8 s without a usable one it stops, drive unchanged', async () => {
    await setup('loud');
    await press(matchKey());
    expect(drive()).toBe(6);
    // Silence (everything muted elsewhere, a gap in the song): not a reading of the music.
    forced = -70;
    await act(async () => wait(4500));
    expect(drive()).toBe(6);
    expect(matchState().matching).toEqual({ applied: 1 });
    // A jump of 15 dB from the last reading: something else changed the output.
    forced = -1;
    expect(await until(() => matchState().matching === null, 9000)).toBe(true);
    expect(result()).toBe(STOPPED_QUIET);
    expect(drive()).toBe(6);
    await act(async () => wait(600));
    expect(drive()).toBe(6);
  }, 25_000);

  it('a reading that went the other way after a pass stops it (the song changed by itself), drive unchanged', async () => {
    await setup('loud');
    await press(matchKey());
    expect(drive()).toBe(6);
    // A breakdown: 2 dB quieter than before the push, although drive went up 6 dB.
    forced = -18;
    expect(await until(() => matchState().matching === null, 6000)).toBe(true);
    expect(result()).toBe(STOPPED_UNSTEADY);
    expect(drive()).toBe(6);
  }, 15_000);

  it('the A/B comparison and Mute All stop it, with words; Mute All keeps it from starting', async () => {
    await setup('loud');
    await press(matchKey());
    expect(matchState().matching).not.toBeNull();
    const ab = [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^Compare A\/B/.test(b.getAttribute('aria-label') ?? ''))!;
    act(() => {
      ab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    });
    expect(ab.getAttribute('aria-pressed')).toBe('true');
    expect(matchState().matching).toBeNull();
    expect(result()).toBe(STOPPED_COMPARE);
    act(() => {
      ab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    });
    expect(ab.getAttribute('aria-pressed')).toBe('false');
    // Fresh readings of the mastered sound, then Match again, then Mute All.
    await act(async () => wait(3400));
    const before = drive();
    await press(matchKey());
    expect(matchState().matching).not.toBeNull();
    const moved = drive();
    expect(moved).toBeGreaterThan(before);
    act(() => session.toggleMuteAll());
    expect(matchState().matching).toBeNull();
    expect(result()).toBe(STOPPED_MUTE_ALL);
    await act(async () => wait(3500));
    expect(drive()).toBe(moved);
    // While Mute All is on, Match does not start.
    await press(matchKey());
    expect(drive()).toBe(moved);
    expect(result()).toBe('Mute All is on: turn it off so Match can hear your song.');
    act(() => session.toggleMuteAll());
  }, 20_000);
});

describe('"Match target in Mix" from the export report', () => {
  const focused = () => document.activeElement === matchKey();
  /** Match target is inside the Mix view's visible part (narrower than 1280 px it starts below it). */
  const inView = () => {
    const view = root.querySelector<HTMLElement>('[role="region"][aria-label="Mix view"]')!.getBoundingClientRect();
    const r = matchKey().getBoundingClientRect();
    return r.top >= view.top && r.bottom <= view.bottom;
  };

  it('Mix opening for it: Match target is focused and scrolled into view', async () => {
    await setup('streaming', [1100, 700], () => requestMatchFocus());
    expect(await until(focused, 2000)).toBe(true);
    expect(inView()).toBe(true);
  });

  it('Mix already open: Match target is focused and scrolled into view', async () => {
    await setup('streaming', [1100, 700]);
    expect(focused()).toBe(false);
    expect(inView()).toBe(false);
    act(() => requestMatchFocus());
    expect(await until(focused, 2000)).toBe(true);
    expect(inView()).toBe(true);
  });
});
