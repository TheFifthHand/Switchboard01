/**
 * Mastering commands: on/off, controls (clamped, one undo step per gesture,
 * preset forgotten once the settings differ), presets (every control, one
 * step), Match target (Loudness moved by the measured difference within
 * 0–15 dB), the A/B comparison (no undo step) and the take lock.
 */
import { describe, expect, it } from 'vitest';
import { MASTERING_PRESETS } from '../../src/content/mastering';
import { createProject } from '../../src/project/factory';
import { MASTERING_PARAMS, neutralMasteringParams, readParam } from '../../src/project/params';
import { ProjectStore } from '../../src/state/projectStore';
import {
  MASTERING_LABEL_PREFIX,
  applyMasteringPreset,
  masteringDiverges,
  matchLoudnessTarget,
  presetSettings,
  setMasteringEnabled,
  setMasteringParam,
} from '../../src/state/commands';

const fresh = () => new ProjectStore(createProject({ now: 0 }));
const param = (s: ProjectStore, id: string) => readParam(MASTERING_PARAMS, s.getState().mastering.params, id);

describe('setMasteringEnabled', () => {
  it('switches the chain on and off, one undo step each', () => {
    const s = fresh();
    expect(s.getState().mastering.enabled).toBe(true);
    expect(setMasteringEnabled(s, false).changed).toBe(true);
    expect(s.getState().mastering.enabled).toBe(false);
    expect(s.undoLabel()).toBe('Turn mastering off');
    // Already off: nothing to record.
    expect(setMasteringEnabled(s, false).changed).toBe(false);
    s.undo();
    expect(s.getState().mastering.enabled).toBe(true);
  });
});

describe('setMasteringParam', () => {
  it('clamps through the registry and refuses unknown controls and non-numbers', () => {
    const s = fresh();
    expect(setMasteringParam(s, 'glue', 5).changed).toBe(true);
    expect(param(s, 'glue')).toBe(1);
    expect(setMasteringParam(s, 'loudness', 40).changed).toBe(true);
    expect(param(s, 'loudness')).toBe(15);
    // Already at the maximum: no change, no step.
    const steps = s.historySize().undo;
    expect(setMasteringParam(s, 'loudness', 99).changed).toBe(false);
    expect(s.historySize().undo).toBe(steps);
    expect(setMasteringParam(s, 'nope', 1)).toMatchObject({ changed: false, reason: 'invalid' });
    expect(setMasteringParam(s, 'air', Number.NaN)).toMatchObject({ changed: false, reason: 'invalid' });
  });

  it('a drag (one gesture id) is one undo step labelled with the control', () => {
    const s = fresh();
    const before = s.historySize().undo;
    for (const v of [0.1, 0.2, 0.35]) setMasteringParam(s, 'saturation', v, 'drag-1');
    expect(s.historySize().undo).toBe(before + 1);
    expect(s.undoLabel()).toBe('Change Warmth');
    s.undo();
    expect(param(s, 'saturation')).toBe(0);
  });

  it('forgets the preset once a control differs from it', () => {
    const s = fresh();
    expect(s.getState().mastering.presetId).toBe('clean');
    // Setting the preset's own value keeps it.
    setMasteringParam(s, 'width', 1);
    expect(s.getState().mastering.presetId).toBe('clean');
    setMasteringParam(s, 'lowGain', 1.5);
    expect(s.getState().mastering.presetId).toBeUndefined();
    // Undo brings the preset back with the value.
    s.undo();
    expect(s.getState().mastering.presetId).toBe('clean');
  });
});

describe('applyMasteringPreset', () => {
  it('every preset sets every control, remembers itself and switches mastering on (one undo step)', () => {
    expect(MASTERING_PRESETS.length).toBeGreaterThan(0);
    for (const preset of MASTERING_PRESETS) {
      const s = fresh();
      setMasteringParam(s, 'air', 2.5);
      setMasteringEnabled(s, false);
      const steps = s.historySize().undo;
      applyMasteringPreset(s, preset.id);
      const m = s.getState().mastering;
      expect(m.enabled).toBe(true);
      expect(m.presetId).toBe(preset.id);
      for (const spec of MASTERING_PARAMS) expect(readParam(MASTERING_PARAMS, m.params, spec.id)).toBe(presetSettings(preset.id)![spec.id]);
      expect(masteringDiverges(m.params, m.presetId)).toBe(false);
      expect(s.historySize().undo).toBe(steps + 1);
      expect(s.undoLabel()).toBe(`Use ${preset.name} mastering`);
      s.undo();
      expect(s.getState().mastering.enabled).toBe(false);
      expect(param(s, 'air')).toBe(2.5);
    }
  });

  it('the Clean preset is neutral and unknown presets are refused', () => {
    expect(presetSettings('clean')).toEqual(neutralMasteringParams());
    const s = fresh();
    expect(applyMasteringPreset(s, 'no-such-preset')).toMatchObject({ changed: false, reason: 'invalid' });
  });
});

describe('matchLoudnessTarget', () => {
  it('moves Loudness by target − measured and undoes in one step', () => {
    const s = fresh();
    const r = matchLoudnessTarget(s, -14, -20);
    expect(r).toMatchObject({ changed: true, before: 0, after: 6, requested: 6, limit: null });
    expect(param(s, 'loudness')).toBe(6);
    expect(s.getState().mastering.presetId).toBeUndefined();
    expect(s.undoLabel()).toBe('Match loudness target');
    // A second measurement nearer the target adds the remaining difference.
    expect(matchLoudnessTarget(s, -14, -15.5)).toMatchObject({ before: 6, after: 7.5 });
    s.undo();
    expect(param(s, 'loudness')).toBe(6);
    s.undo();
    expect(param(s, 'loudness')).toBe(0);
  });

  it('stops at the ends of the 0–15 dB range and says so', () => {
    const s = fresh();
    expect(matchLoudnessTarget(s, -9, -30)).toMatchObject({ changed: true, after: 15, requested: 21, limit: 'max' });
    setMasteringParam(s, 'loudness', 2);
    expect(matchLoudnessTarget(s, -14, -10)).toMatchObject({ changed: true, before: 2, after: 0, limit: 'min' });
    // Already at 0 and still too loud: nothing Loudness can do.
    expect(matchLoudnessTarget(s, -18, -10)).toMatchObject({ changed: false, before: 0, after: 0, limit: 'min' });
    // Already at the top and still too quiet: the same, at the other end.
    setMasteringParam(s, 'loudness', 15);
    expect(matchLoudnessTarget(s, -9, -20)).toMatchObject({ changed: false, before: 15, after: 15, limit: 'max' });
  });

  it('needs a measurement and mastering switched on', () => {
    const s = fresh();
    expect(matchLoudnessTarget(s, -14, Number.NEGATIVE_INFINITY)).toMatchObject({ changed: false, reason: 'unavailable' });
    expect(matchLoudnessTarget(s, Number.NaN, -20)).toMatchObject({ changed: false, reason: 'invalid' });
    setMasteringEnabled(s, false);
    const r = matchLoudnessTarget(s, -14, -20);
    expect(r).toMatchObject({ changed: false, reason: 'unavailable' });
    expect(r.message).toMatch(/Mastering is off/);
    expect(param(s, 'loudness')).toBe(0);
  });

  it('a difference under 0.05 dB changes nothing', () => {
    const s = fresh();
    setMasteringParam(s, 'loudness', 4);
    const steps = s.historySize().undo;
    expect(matchLoudnessTarget(s, -14, -14.02)).toMatchObject({ changed: false, after: 4 });
    expect(s.historySize().undo).toBe(steps);
  });
});

describe('take lock', () => {
  it('a performance take refuses every mastering edit', () => {
    const s = fresh();
    s.setLock('Recording a performance', (label) => label.startsWith('module:'));
    for (const r of [
      setMasteringEnabled(s, false),
      setMasteringParam(s, 'air', 3),
      applyMasteringPreset(s, 'clean'),
      matchLoudnessTarget(s, -14, -20),
    ]) {
      expect(r.changed).toBe(false);
      expect(r.refused).toBe('Recording a performance');
    }
    expect(s.getState().mastering.enabled).toBe(true);
    expect(param(s, 'air')).toBe(0);
    expect(MASTERING_LABEL_PREFIX).toBe('mastering:');
  });
});
