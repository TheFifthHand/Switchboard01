/**
 * Mix view in real Chromium with the app's session and store: channel strips
 * (fader, meter, Mute, Solo, Pan; Advanced: Reverb/Echo amounts and effects
 * that open Shape), the master strip, and mastering (On/Off, presets,
 * loudness target + Match, readouts, spectrum, A/B, every control grouped).
 * Meters and spectrum are driven by fakes of the session's readers here; the
 * real engine is exercised in omni-mix-session.test.ts. Layout is checked
 * with the real theme at 1366×768, 1920×1080 and 960×540 (200 % zoom).
 */
import type { AxeResults } from 'axe-core';
// The audit script as text (a script tag), so the test needs no dependency pre-bundling.
import axeSource from 'axe-core/axe.min.js?raw';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { FADER_BURST_IDLE_MS, KNOB_BURST_IDLE_MS, TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { patchRuntime, runtimeStore } from '../../src/app/runtime';
import { TAKE_LOCK_MESSAGE } from '../../src/app/session';
import { MixView } from '../../src/app/views/mix/MixView';
import { SOLO_LOCKED_MESSAGE } from '../../src/app/views/mix/ChannelStrip';
import { compareState } from '../../src/app/views/mix/compare';
import { resetMixFrame } from '../../src/app/views/mix/mixMeters';
import { MIX_PREFS_KEY, setLoudnessTarget } from '../../src/app/views/mix/mixPrefs';
import { MASTERING_PRESETS } from '../../src/content/mastering';
import { createProject } from '../../src/project/factory';
import { MASTERING_PARAMS, readParam } from '../../src/project/params';
import type { Project } from '../../src/project/types';
import { MASTERING_LOCKED_MESSAGE } from '../../src/state/commands';
import { selectModule, selectTrack, setUiMode, setView, uiStore, type UiMode } from '../../src/state/uiStore';
import { actFrame, cleanup, fire, frames, key, mount, pointer, pointIn, wait } from './ui-harness';

const project = (): Project => session.store.getState();
const track = (id: string) => project().tracks.find((t) => t.id === id)!;
const level = (trackId: string) => project().patch.modules.find((m) => m.id === `${trackId}:ch`)!.params.level ?? 0;
const mastering = (id: string) => readParam(MASTERING_PARAMS, project().mastering.params, id);
const notice = () => runtimeStore.getState().notice?.text ?? '';

function setup(mode: UiMode = 'simple', size: { width: number; height: number | 'auto' } = { width: 1366, height: 610 }) {
  act(() => {
    session.store.replace(createProject({ name: 'Mix test', now: 1 }));
    setUiMode(mode);
    setView('mix');
    selectTrack('t1');
    selectModule(null);
  });
  resetMixFrame();
  const m = mount(h(TipsProvider, { enabled: false }, h(MixView)), { width: size.width });
  m.container.style.padding = '0';
  m.container.style.height = size.height === 'auto' ? 'auto' : `${size.height}px`;
  return m;
}

function strip(root: Element, id: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-testid="strip-${id}"]`);
  if (!el) throw new Error(`No strip ${id}`);
  return el;
}

function slider(root: Element, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[role="slider"][aria-label="${name}"]`);
  if (!el) throw new Error(`No slider "${name}"`);
  return el;
}

function button(root: Element, name: string | RegExp): HTMLButtonElement {
  const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => {
    const label = x.getAttribute('aria-label') ?? x.textContent ?? '';
    return typeof name === 'string' ? label === name : name.test(label);
  });
  if (!b) throw new Error(`No button "${String(name)}"`);
  return b;
}

function section(root: Element, title: string): HTMLElement {
  const heading = [...root.querySelectorAll('h2, h3, h4')].find((x) => x.textContent === title);
  if (!heading) throw new Error(`No section "${title}"`);
  return heading.closest('section')!;
}

const click = (el: HTMLElement) => fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
const keyClick = (el: HTMLElement) => fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
const press = (el: HTMLElement) => {
  pointer(el, 'pointerdown', pointIn(el));
  pointer(el, 'pointerup', pointIn(el));
  click(el);
};
const endBurst = (ms = Math.max(FADER_BURST_IDLE_MS, KNOB_BURST_IDLE_MS)) => act(async () => wait(ms + 120));
/** Let the rAF readouts (throttled to ~5 per second) catch up. */
const settle = (ms = 320) => act(async () => wait(ms));

function fakeMeters(loudness?: { momentary: number; shortTerm: number; integrated: number; truePeakDb: number }, glue?: number) {
  return vi.spyOn(session, 'readMeters').mockImplementation((out) => {
    out.masterPeakL = 0.5;
    out.masterPeakR = 0.5;
    out.masterRms = 0.2;
    out.limiterReductionDb = 0;
    out.tracks = project().tracks.map((t) => ({ trackId: t.id, peak: t.mute ? 0 : 0.3, rms: 0.1 }));
    out.loudness = loudness;
    out.glueReductionDb = glue;
    return true;
  });
}

beforeEach(async () => {
  await page.viewport(1366, 768);
  window.scrollTo(0, 0);
  runtimeStore.setState((s) => ({ ...s, notice: null, recording: 'off', muteAll: false, playing: false }));
  setLoudnessTarget('streaming');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  act(() => {
    session.store.setLock(null);
    patchRuntime({ recording: 'off', muteAll: false, playing: false });
    setUiMode('simple');
  });
  resetMixFrame();
});

/* ------------------------------------------------------------------ */
/* Strips                                                              */
/* ------------------------------------------------------------------ */

describe('Mixer strips', () => {
  it('shows one strip per part with fader, meter, Pan, Mute and Solo, and a master strip', () => {
    const m = setup();
    const tracks = project().tracks;
    expect(tracks).toHaveLength(8);
    tracks.forEach((t, i) => {
      const s = strip(m.container, t.id);
      expect(s.getAttribute('aria-label')).toBe(`${i + 1} ${t.name}`);
      const f = slider(s, `${t.name} level`);
      expect(f.getAttribute('aria-orientation')).toBe('vertical');
      expect(f.getAttribute('aria-valuetext')).toMatch(/dB$/);
      expect(s.querySelector(`[role="meter"][aria-label="${t.name} meter"]`)).not.toBeNull();
      expect(slider(s, 'Pan')).toBeTruthy();
      expect(button(s, `Mute ${t.name}`).getAttribute('aria-pressed')).toBe('false');
      expect(button(s, `Solo ${t.name}`).getAttribute('aria-pressed')).toBe('false');
      // Simple: no send amounts or effects.
      expect(s.querySelector('[role="slider"][aria-label="Reverb Amount"]')).toBeNull();
    });
    const master = strip(m.container, 'master');
    expect(slider(master, 'Master volume').getAttribute('aria-valuetext')).toBe('−3.0 dB');
    expect(button(master, 'Mute All')).toBeTruthy();
    expect(master.querySelectorAll('[role="meter"]')).toHaveLength(2);
  });

  it('dragging a fader sets the part level, as one undo step', () => {
    const m = setup();
    const name = track('t3').name;
    const f = slider(strip(m.container, 't3'), `${name} level`);
    const start = pointIn(f);
    pointer(f, 'pointerdown', start);
    for (let i = 1; i <= 6; i++) pointer(f, 'pointermove', { ...start, clientY: start.clientY + i * 10 });
    pointer(f, 'pointerup', { ...start, clientY: start.clientY + 60 });
    const after = level('t3');
    expect(after).toBeLessThan(-1);
    expect(f.getAttribute('aria-valuenow')).toBe(String(after));
    expect(session.store.undoLabel()).toBe('Change Channel Level');
    act(() => session.undo());
    expect(level('t3')).toBe(0);
  });

  it('keyboard steps are 0.5 dB and one burst is one undo step; double-click returns to 0 dB', async () => {
    const m = setup();
    const f = slider(strip(m.container, 't2'), `${track('t2').name} level`);
    f.focus();
    key(f, 'keydown', { key: 'ArrowDown' });
    key(f, 'keydown', { key: 'ArrowDown' });
    expect(level('t2')).toBe(-1);
    await endBurst();
    fire(f, new MouseEvent('dblclick', { bubbles: true }));
    expect(level('t2')).toBe(0);
    act(() => session.undo());
    expect(level('t2')).toBe(-1);
    act(() => session.undo());
    expect(level('t2')).toBe(0);
  });

  it('Mute and Solo change the parts and say so in words', () => {
    const m = setup();
    const s1 = strip(m.container, 't1');
    const n1 = track('t1').name;
    click(button(s1, `Mute ${n1}`));
    expect(track('t1').mute).toBe(true);
    expect(button(s1, `Mute ${n1}`).getAttribute('aria-pressed')).toBe('true');
    expect(s1.textContent).toContain('Muted');
    expect(s1.hasAttribute('data-dimmed')).toBe(true);
    const n2 = track('t2').name;
    click(button(strip(m.container, 't2'), `Solo ${n2}`));
    expect(track('t2').solo).toBe(true);
    expect(strip(m.container, 't2').textContent).toContain('Solo');
    expect(strip(m.container, 't4').textContent).toContain('Not soloed');
    expect(m.container.textContent).toContain('Solo on: only the soloed part plays');
    act(() => session.undo());
    expect(track('t2').solo).toBe(false);
    expect(strip(m.container, 't4').textContent).not.toContain('Not soloed');
  });

  it('Pan changes the channel pan', () => {
    const m = setup();
    const pan = slider(strip(m.container, 't5'), 'Pan');
    pan.focus();
    key(pan, 'keydown', { key: 'ArrowUp' });
    expect(project().patch.modules.find((x) => x.id === 't5:ch')!.params.pan).toBeCloseTo(0.02, 5);
  });

  it('clicking a strip name selects that part', () => {
    const m = setup();
    click(button(strip(m.container, 't6'), new RegExp(`^Select ${track('t6').name}`)));
    expect(uiStore.getState().selectedTrackId).toBe('t6');
    expect(strip(m.container, 't6').hasAttribute('data-selected')).toBe(true);
  });

  it('master strip: volume fader and Mute All', () => {
    const m = setup();
    const master = strip(m.container, 'master');
    const f = slider(master, 'Master volume');
    f.focus();
    key(f, 'keydown', { key: 'ArrowUp' });
    expect(project().masterVolumeDb).toBe(-2.5);
    click(button(master, 'Mute All'));
    expect(runtimeStore.getState().muteAll).toBe(true);
    expect(button(master, 'Mute All').getAttribute('aria-pressed')).toBe('true');
    expect(master.textContent).toContain('Muted');
    click(button(master, 'Mute All'));
    expect(runtimeStore.getState().muteAll).toBe(false);
  });

  it('meters show the real per-part reading (a muted part reads silent)', async () => {
    fakeMeters();
    const m = setup();
    act(() => session.setMute('t2', true));
    await settle(400);
    const meter = (id: string) => strip(m.container, id).querySelector<HTMLElement>('[role="meter"]')!;
    expect(meter('t1').getAttribute('aria-valuetext')).toMatch(/^-?\d+ dB/);
    expect(meter('t2').getAttribute('aria-valuetext')).toBe('Silent');
  });
});

describe('Advanced strips', () => {
  it('add Reverb and Echo amounts and the part’s effects, which open Shape on that effect', () => {
    const m = setup('advanced');
    const s3 = strip(m.container, 't3');
    // The default Space and Echo macros set the send amounts: read-only, and named.
    expect(slider(s3, 'Reverb Amount').getAttribute('aria-valuetext')).toMatch(/set by Space/);
    expect(slider(s3, 'Echo Amount').getAttribute('aria-valuetext')).toMatch(/set by Echo/);
    const effects = s3.querySelector('[role="group"][aria-label$="effects"]')!;
    const names = [...effects.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Drive: open in Shape', 'Filter: open in Shape']);
    click(button(effects, 'Filter: open in Shape'));
    const ui = uiStore.getState();
    expect(ui.view).toBe('shape');
    expect(ui.selectedTrackId).toBe('t3');
    expect(ui.selectedModuleId).toBe('t3:filter');
    // The master strip shows what the limiter is doing.
    expect(strip(m.container, 'master').querySelector('[aria-label="Output limiter"]')!.textContent).toContain('Resting');
  });

  it('an unmapped send amount can be changed', () => {
    const m = setup('advanced');
    act(() => {
      session.store.apply('track:Remove macro assignment', (d) => {
        d.tracks[0].macroMap.space = [];
      });
    });
    const knob = slider(strip(m.container, 't1'), 'Reverb Amount');
    expect(knob.getAttribute('aria-readonly')).toBeNull();
    knob.focus();
    key(knob, 'keydown', { key: 'ArrowUp' });
    expect(project().patch.modules.find((x) => x.id === 't1:ch')!.params.sendA).toBeGreaterThan(0);
  });
});

describe('During a performance take', () => {
  function lockAsTake() {
    act(() => {
      session.store.setLock(TAKE_LOCK_MESSAGE, (label) => label.startsWith('module:') || label === 'track:Mute part' || label === 'track:Unmute part');
      patchRuntime({ recording: 'performance' });
    });
  }

  it('faders and Mute still work (the take records them); Solo is refused with a clear reason', () => {
    const m = setup();
    lockAsTake();
    const name = track('t1').name;
    const f = slider(strip(m.container, 't1'), `${name} level`);
    f.focus();
    key(f, 'keydown', { key: 'ArrowDown' });
    expect(level('t1')).toBe(-0.5);
    click(button(strip(m.container, 't1'), `Mute ${name}`));
    expect(track('t1').mute).toBe(true);
    click(button(strip(m.container, 't1'), `Solo ${name}`));
    expect(track('t1').solo).toBe(false);
    expect(notice()).toBe(SOLO_LOCKED_MESSAGE);
  });

  it('mastering is locked and says why', () => {
    const m = setup('advanced');
    lockAsTake();
    const panel = section(m.container, 'Mastering');
    expect(panel.textContent).toContain(MASTERING_LOCKED_MESSAGE);
    expect(panel.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
    for (const chip of section(m.container, 'Presets').querySelectorAll<HTMLButtonElement>('button')) expect(chip.disabled).toBe(true);
    const air = slider(panel, 'Air');
    expect(air.getAttribute('aria-disabled')).toBe('true');
    // Even a direct attempt is refused by the store, with the mastering explanation.
    click(button(panel, /Match target/));
    expect(mastering('loudness')).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Mastering                                                           */
/* ------------------------------------------------------------------ */

describe('Mastering', () => {
  it('the On/Off switch turns the chain off and on (undoable)', () => {
    const m = setup();
    const sw = section(m.container, 'Mastering').querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    click(sw);
    expect(project().mastering.enabled).toBe(false);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    act(() => session.undo());
    expect(project().mastering.enabled).toBe(true);
  });

  it('shows every preset as a chip; choosing one applies it in one undo step, and a change makes the settings custom', async () => {
    const m = setup('advanced');
    const panel = section(m.container, 'Presets');
    const chips = [...panel.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')];
    expect(chips.map((c) => c.textContent)).toEqual(MASTERING_PRESETS.map((p) => p.name));
    expect(chips.find((c) => c.textContent === 'Clean')!.getAttribute('aria-pressed')).toBe('true');
    // Turn a control: the preset no longer describes the settings.
    const air = slider(section(m.container, 'Mastering'), 'Air');
    air.focus();
    key(air, 'keydown', { key: 'ArrowUp' });
    await endBurst();
    expect(mastering('air')).toBeGreaterThan(0);
    expect(project().mastering.presetId).toBeUndefined();
    expect(panel.querySelector('[data-testid="preset-note"]')!.textContent).toMatch(/Custom settings/);
    // Every preset, chosen: its values, remembered, one undo step each.
    for (const preset of MASTERING_PRESETS) {
      const steps = session.store.historySize().undo;
      click([...panel.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((c) => c.textContent === preset.name)!);
      expect(project().mastering.presetId).toBe(preset.id);
      expect(project().mastering.enabled).toBe(true);
      expect(session.store.historySize().undo).toBe(steps + 1);
      expect(panel.querySelector('[data-testid="preset-note"]')!.textContent).toContain(preset.description);
    }
    expect(notice()).toContain('Mastering:');
  });

  it('Advanced shows every mastering control, grouped, with one undo step per knob gesture', async () => {
    const m = setup('advanced');
    const panel = section(m.container, 'Mastering');
    for (const title of ['Clean-up', 'EQ', 'Glue', 'Colour', 'Stereo', 'Loudness']) expect(() => section(panel, title)).not.toThrow();
    for (const spec of MASTERING_PARAMS) expect(slider(panel, spec.label)).toBeTruthy();
    expect(slider(section(panel, 'EQ'), 'Lows')).toBeTruthy();
    expect(slider(section(panel, 'Clean-up'), 'Low Cut')).toBeTruthy();
    const glue = slider(section(panel, 'Glue'), 'Glue');
    glue.focus();
    const before = session.store.historySize().undo;
    key(glue, 'keydown', { key: 'ArrowUp' });
    key(glue, 'keydown', { key: 'ArrowUp' });
    await endBurst();
    expect(mastering('glue')).toBeCloseTo(0.02, 5);
    expect(session.store.historySize().undo).toBe(before + 1);
    act(() => session.undo());
    expect(mastering('glue')).toBe(0);
  });

  it('Simple hides the individual mastering controls', () => {
    const m = setup('simple');
    const panel = section(m.container, 'Mastering');
    expect(panel.querySelector('[role="slider"][aria-label="Air"]')).toBeNull();
    expect(panel.textContent).toContain('Match target');
    expect(panel.querySelector('canvas')).not.toBeNull();
  });

  it('the Glue indicator shows the real gain reduction, or a dash without one', async () => {
    fakeMeters(undefined, 3.2);
    const m = setup('advanced');
    await settle();
    const meter = section(m.container, 'Glue').querySelector<HTMLElement>('[role="meter"]')!;
    expect(meter.textContent).toContain('−3.2 dB');
    expect(meter.getAttribute('aria-valuetext')).toBe('Turning down 3.2 dB');
    vi.restoreAllMocks();
    resetMixFrame();
    await settle(150);
    expect(meter.textContent).toContain('—');
  });
});

describe('Loudness', () => {
  it('without a measurement: dashes, “Start playback to measure”, and Match does nothing', async () => {
    const m = setup();
    await settle();
    const panel = section(m.container, 'Loudness');
    for (const k of ['momentary', 'shortTerm', 'integrated', 'truePeak']) expect(panel.querySelector(`[data-testid="loudness-${k}"]`)!.textContent).toBe('—');
    expect(panel.querySelector('[data-testid="loudness-status"]')!.textContent).toBe('Start playback to measure.');
    const match = button(panel, /Match target/);
    expect(match.getAttribute('aria-disabled')).toBe('true');
    click(match);
    expect(mastering('loudness')).toBe(0);
  });

  it('shows the live readings and how far the target is; Match moves Loudness by the difference (one undo step)', async () => {
    fakeMeters({ momentary: -12.4, shortTerm: -13.1, integrated: -20, truePeakDb: -0.6 });
    const reset = vi.spyOn(session, 'resetLoudness');
    act(() => patchRuntime({ playing: true }));
    const m = setup();
    await settle();
    const panel = section(m.container, 'Loudness');
    const value = (k: string) => panel.querySelector<HTMLElement>(`[data-testid="loudness-${k}"]`)!;
    expect(value('momentary').textContent).toBe('−12.4');
    expect(value('shortTerm').textContent).toBe('−13.1');
    expect(value('integrated').textContent).toBe('−20.0');
    expect(value('truePeak').textContent).toBe('−0.6');
    // Just above the limiter's −1 dB: amber (normal for true peak), explained in words; red only above 0 dBTP.
    expect(value('truePeak').dataset.level).toBe('near');
    expect(panel.querySelector('[data-testid="true-peak-note"]')!.textContent).toMatch(/peaks between samples.*amber is normal, red \(above 0 dBTP\) may distort/);
    expect(panel.querySelector('[data-testid="loudness-status"]')!.textContent).toBe('Integrated: 6.0 dB quieter than the Streaming target, −14 LUFS.');
    const match = button(panel, /Match target/);
    expect(match.getAttribute('aria-disabled')).toBeNull();
    click(match);
    expect(mastering('loudness')).toBe(6);
    expect(reset).toHaveBeenCalled();
    // A second press before a reading at the new setting changes nothing (no double counting).
    click(match);
    expect(mastering('loudness')).toBe(6);
    expect(match.getAttribute('aria-disabled')).toBe('true');
    // What Match did: beside the button and in the toast (with Undo); a plain match needs no extra paragraph.
    expect(panel.querySelector('[data-testid="loudness-control"]')!.textContent).toBe('Loudness 0.0 dB → +6.0 dB');
    expect(panel.querySelector('[data-testid="match-result"]')!.textContent).toBe('');
    expect(session.store.undoLabel()).toBe('Match loudness target');
    expect(notice()).toContain('Loudness 0.0 dB → +6.0 dB to aim for −14 LUFS (the integrated reading was −20.0 LUFS)');
    // Once a fresh reading arrives, Match is available again.
    await settle(900);
    expect(match.getAttribute('aria-disabled')).toBeNull();
    act(() => session.undo());
    expect(mastering('loudness')).toBe(0);
    expect(panel.querySelector('[data-testid="loudness-control"]')!.textContent).toBe('Loudness 0.0 dB');
  });

  it('uses the short-term reading when there is no integrated one yet', async () => {
    fakeMeters({ momentary: -15, shortTerm: -16, integrated: Number.NEGATIVE_INFINITY, truePeakDb: -3 });
    const m = setup();
    await settle();
    const panel = section(m.container, 'Loudness');
    expect(panel.querySelector('[data-testid="loudness-status"]')!.textContent).toMatch(/^Short-term: 2\.0 dB quieter/);
    click(button(panel, /Match target/));
    expect(mastering('loudness')).toBe(2);
    expect(notice()).toContain('the short-term reading was −16.0 LUFS');
  });

  it('the target can be changed (remembered in this browser) and Match aims for it', async () => {
    fakeMeters({ momentary: -15, shortTerm: -15, integrated: -15, truePeakDb: -3 });
    const m = setup();
    await settle();
    const panel = section(m.container, 'Loudness');
    const loud = [...panel.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((r) => r.textContent?.startsWith('Loud'))!;
    click(loud);
    expect(loud.getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem(MIX_PREFS_KEY)).toContain('loud');
    await settle();
    expect(panel.querySelector('[data-testid="loudness-status"]')!.textContent).toBe('Integrated: 6.0 dB quieter than the Loud target, −9 LUFS.');
    click(button(panel, /Match target/));
    expect(mastering('loudness')).toBe(6);
  });

  it('Match explains when Loudness cannot go far enough, and needs mastering on', async () => {
    fakeMeters({ momentary: -8, shortTerm: -8, integrated: -8, truePeakDb: -1 });
    const m = setup();
    await settle();
    const panel = section(m.container, 'Loudness');
    click(button(panel, /Match target/));
    expect(mastering('loudness')).toBe(0);
    expect(panel.querySelector('[data-testid="match-result"]')!.textContent).toMatch(/Lower the master volume/);
    click(section(m.container, 'Mastering').querySelector<HTMLButtonElement>('[role="switch"]')!);
    expect(button(panel, /Match target/).getAttribute('aria-disabled')).toBe('true');
    expect(panel.textContent).toContain('Turn mastering on to match a target.');
  });
});

describe('Spectrum', () => {
  const overlay = (root: Element) => root.querySelector<HTMLElement>('[data-testid="spectrum-overlay"]')!;

  it('says to start playback when audio has not started', async () => {
    const m = setup();
    await settle(100);
    expect(overlay(m.container).dataset.state).toBe('off');
    expect(overlay(m.container).textContent).toBe('Start playback to see the spectrum.');
    expect(section(m.container, 'Spectrum').textContent).toMatch(/Lows.*Mids.*Highs/);
  });

  it('draws the output spectrum and the level of the lows, mids and highs', async () => {
    fakeMeters();
    vi.spyOn(session, 'readSpectrum').mockImplementation((out) => {
      for (let i = 0; i < out.length; i++) out[i] = i < out.length / 3 ? -24 : -60;
      return true;
    });
    const m = setup();
    await settle(400);
    // The canvas takes its size when the act() scope above flushes the resize; it draws on the next frame.
    await frames(2);
    expect(overlay(m.container).dataset.state).toBe('live');
    const regions = section(m.container, 'Spectrum').querySelector('[aria-label="Level of the lows, mids and highs"]')!;
    expect(regions.textContent).toMatch(/Lows\s*[−-]24 dB/);
    expect(regions.textContent).toMatch(/Highs\s*[−-]60 dB/);
    const canvas = section(m.container, 'Spectrum').querySelector('canvas')!;
    const ctx = canvas.getContext('2d')!;
    // The curve is drawn: amber pixels near the top-left (loud lows), none at the top right.
    const px = (x: number, y: number) => ctx.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data;
    let lowCurve = false;
    for (let y = 0.1; y < 0.5; y += 0.01) if (px(0.15, y)[3] > 0 && px(0.15, y)[0] > 150) lowCurve = true;
    expect(lowCurve).toBe(true);
  });

  it('says when the output is silent, or when the engine has no spectrum', async () => {
    fakeMeters();
    const spy = vi.spyOn(session, 'readSpectrum').mockImplementation((out) => {
      out.fill(-140);
      return true;
    });
    const m = setup();
    await settle(150);
    expect(overlay(m.container).dataset.state).toBe('silent');
    spy.mockImplementation(() => false);
    await settle(150);
    expect(overlay(m.container).dataset.state).toBe('unavailable');
  });
});

describe('A/B comparison', () => {
  // The accessible name starts with the visible words (WCAG 2.5.3 label in name).
  const compareButton = (root: Element) => button(root, 'Compare A/B (hear without mastering)');
  const hearingWithout = () => session.masteringListenBypass;

  it('holding plays the mix without mastering, listening only; letting go brings it back', async () => {
    const m = setup();
    const b = compareButton(m.container);
    const steps = session.store.historySize();
    const before = project();
    pointer(b, 'pointerdown', pointIn(b));
    expect(hearingWithout()).toBe(true);
    // The project (and so every save and export) keeps its mastering.
    expect(project()).toBe(before);
    expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(b.textContent).toContain('Hearing: no mastering');
    expect(b.getAttribute('aria-label')).toBe('Hearing: no mastering (Compare A/B)');
    expect(section(m.container, 'Mastering').querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
    await act(async () => wait(400));
    pointer(b, 'pointerup', pointIn(b));
    expect(hearingWithout()).toBe(false);
    expect(project()).toBe(before);
    expect(session.store.historySize()).toEqual(steps);
    expect(b.getAttribute('aria-pressed')).toBe('false');
  });

  it('a quick click keeps it off until the next click; the keyboard toggles it; leaving the view restores it', () => {
    const m = setup();
    const b = compareButton(m.container);
    press(b);
    expect(hearingWithout()).toBe(true);
    expect(compareState().mode).toBe('latched');
    press(b);
    expect(hearingWithout()).toBe(false);
    keyClick(b);
    expect(hearingWithout()).toBe(true);
    m.unmount();
    expect(hearingWithout()).toBe(false);
    expect(compareState().mode).toBe('off');
  });

  it('is unavailable when mastering is off, and the On switch ends it', () => {
    const m = setup();
    const b = compareButton(m.container);
    press(b);
    expect(hearingWithout()).toBe(true);
    click(section(m.container, 'Mastering').querySelector<HTMLButtonElement>('[role="switch"]')!);
    expect(compareState().mode).toBe('off');
    expect(hearingWithout()).toBe(false);
    expect(project().mastering.enabled).toBe(false);
    expect(session.store.undoLabel()).toBe('Turn mastering off');
    expect(b.getAttribute('aria-disabled')).toBe('true');
    press(b);
    expect(hearingWithout()).toBe(false);
    expect(compareState().mode).toBe('off');
  });

  it('works while a performance records, without touching the project', () => {
    const m = setup();
    const b = compareButton(m.container);
    act(() => {
      session.store.setLock(TAKE_LOCK_MESSAGE, (label) => label.startsWith('module:'));
      patchRuntime({ recording: 'performance' });
    });
    const before = project();
    press(b);
    expect(hearingWithout()).toBe(true);
    expect(project()).toBe(before);
    press(b);
    expect(hearingWithout()).toBe(false);
    act(() => {
      session.store.setLock(null);
      patchRuntime({ recording: 'off' });
    });
  });
});

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

describe('Layout with the real theme', () => {
  const cases: { w: number; h: number; mode: UiMode; sideBySide: boolean }[] = [
    { w: 1366, h: 768, mode: 'simple', sideBySide: true },
    { w: 1366, h: 768, mode: 'advanced', sideBySide: false },
    { w: 1920, h: 1080, mode: 'simple', sideBySide: true },
    { w: 1920, h: 1080, mode: 'advanced', sideBySide: true },
    { w: 960, h: 540, mode: 'simple', sideBySide: false },
    { w: 960, h: 540, mode: 'advanced', sideBySide: false },
  ];
  for (const c of cases) {
    it(`${c.w}×${c.h} ${c.mode}: nothing overflows, all 8 strips and the master are on screen, targets are big enough`, async () => {
      await page.viewport(c.w, c.h);
      // The workspace between the transport (58 px) and the keyboard (100 px); below 1024 px the page scrolls.
      const m = setup(c.mode, { width: c.w, height: c.w < 1024 ? 'auto' : c.h - 158 });
      await actFrame();
      const view = m.container.querySelector<HTMLElement>('[role="region"][aria-label="Mix"]')!;
      expect(view.scrollWidth).toBeLessThanOrEqual(view.clientWidth + 1);
      expect(m.container.scrollWidth).toBeLessThanOrEqual(m.container.clientWidth + 1);
      const mixer = section(view, 'Mixer');
      const body = mixer.querySelector<HTMLElement>('[data-testid="strip-t1"]')!.parentElement!.parentElement!;
      const box = body.getBoundingClientRect();
      const strips = [...view.querySelectorAll<HTMLElement>('[data-testid^="strip-"]')];
      expect(strips).toHaveLength(9);
      for (const s of strips) {
        const r = s.getBoundingClientRect();
        expect(r.left).toBeGreaterThanOrEqual(box.left - 1);
        expect(r.right).toBeLessThanOrEqual(box.right + 1);
        const fader = s.querySelector<HTMLElement>('[role="slider"][aria-orientation="vertical"]')!.getBoundingClientRect();
        expect(fader.height).toBeGreaterThanOrEqual(c.w < 1024 ? 110 : 130);
        expect(fader.width).toBeGreaterThanOrEqual(40);
        // The whole fader is in the mixer (nothing cut off at the bottom).
        expect(fader.bottom).toBeLessThanOrEqual(mixer.getBoundingClientRect().bottom);
        for (const b of s.querySelectorAll<HTMLElement>('button[aria-label^="Mute"], button[aria-label^="Solo"]')) {
          const br = b.getBoundingClientRect();
          expect(br.height).toBeGreaterThanOrEqual(40);
          expect(br.width).toBeGreaterThanOrEqual(36);
        }
      }
      if (c.w >= 1024) {
        // The mixer fits the workspace height: every fader is visible without scrolling.
        expect(mixer.getBoundingClientRect().bottom).toBeLessThanOrEqual(view.getBoundingClientRect().top + view.clientHeight + 1);
      }
      const mastering = section(view, 'Mastering');
      const mr = mastering.getBoundingClientRect();
      if (c.sideBySide) {
        expect(mr.left).toBeGreaterThanOrEqual(mixer.getBoundingClientRect().right);
        expect(mr.bottom).toBeLessThanOrEqual(view.getBoundingClientRect().bottom + 1);
      } else {
        expect(mr.top).toBeGreaterThanOrEqual(mixer.getBoundingClientRect().bottom);
      }
      for (const chip of section(view, 'Presets').querySelectorAll<HTMLElement>('button')) expect(chip.getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
      expect(button(view, /Match target/).getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
      if (c.w === 1366 && c.mode === 'simple') {
        // Laptop, Simple: the spectrum is on screen without scrolling the mastering panel.
        const plot = section(view, 'Spectrum').querySelector('canvas')!.getBoundingClientRect();
        expect(plot.height).toBeGreaterThanOrEqual(60);
        expect(plot.bottom).toBeLessThanOrEqual(mr.bottom);
      }
    });
  }
});

interface AxeApi {
  run(context: Element, options: object): Promise<AxeResults>;
}

function loadAxe(): AxeApi {
  const w = window as unknown as { axe?: AxeApi };
  if (!w.axe) {
    const script = document.createElement('script');
    script.textContent = axeSource;
    document.head.appendChild(script);
  }
  return w.axe!;
}

describe('Accessibility audit', () => {
  for (const mode of ['simple', 'advanced'] as const) {
    it(`${mode}: no serious or critical axe-core violations, with live readings`, async () => {
      fakeMeters({ momentary: -12.4, shortTerm: -13.1, integrated: -15.6, truePeakDb: -1.4 }, 2);
      const m = setup(mode);
      await settle();
      const r = await loadAxe().run(m.container, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
      const bad = r.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      expect(bad).toEqual([]);
    });
  }
});
