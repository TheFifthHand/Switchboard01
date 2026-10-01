import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import {
  PRESETS,
  PRESET_OWNED_MODULE_PARAMS,
  TONE_RANGE,
  applyKitToProject,
  applyPresetToProject,
  applySamplerToProject,
  slotModuleId,
  type TrackSlot,
} from '../../src/content/presets';
import { BUILTIN_SAMPLES, KITS, SYNTH_PRESETS, kitInfo } from '../../src/content/catalog';
import { BLANK } from '../../src/content/starters/blank';
import { HOUSE } from '../../src/content/starters/house';
import { createProject, defaultMacroMap, defaultDrumVoices, moduleId } from '../../src/project/factory';
import { DRUM_KIT_PARAMS, INSTRUMENT_PARAMS, MODULE_PARAMS, SAMPLER_PARAMS, clampParam, defaultParams, specById, toNormalized, type ParamSpec } from '../../src/project/params';
import { resolveAllParams, specsForModule } from '../../src/project/resolve';
import { validateProject } from '../../src/project/validate';
import { MACRO_IDS, type ModuleType, type Project } from '../../src/project/types';

const SLOT_TYPE: Record<Exclude<TrackSlot, 'inst'>, ModuleType> = { drive: 'drive', filter: 'filter', lfo: 'lfo', ch: 'channel' };
const BASS_TRACK = 't3';
const CHORD_TRACK = 't4';

function specsForSlot(kind: 'bass' | 'poly', slot: TrackSlot): readonly ParamSpec[] {
  return slot === 'inst' ? INSTRUMENT_PARAMS[kind] : MODULE_PARAMS[SLOT_TYPE[slot]];
}

function expectInRange(spec: ParamSpec, v: number, what: string) {
  expect(Number.isFinite(v), what).toBe(true);
  expect(clampParam(spec, v), `${what} = ${v} is outside ${spec.min}..${spec.max}`).toBe(v);
}

function fresh(): Project {
  // Make the user's mix recognisable so we can check a preset leaves it alone.
  const p = createProject({ now: 1 });
  for (const t of p.tracks) {
    t.macros.space = 0.4;
    t.macros.echo = 0.3;
    t.macros.pump = 0.2;
    const ch = p.patch.modules.find((m) => m.id === moduleId.channel(t.id))!;
    ch.params.level = -7;
    ch.params.pan = 0.25;
  }
  return p;
}

function withMacros(p: Project, trackId: string, values: Partial<Record<(typeof MACRO_IDS)[number], number>>): Project {
  return produce(p, (d) => {
    Object.assign(d.tracks.find((t) => t.id === trackId)!.macros, values);
  });
}

describe('preset library contents', () => {
  it('has a designed preset for every catalog entry and nothing else', () => {
    expect(Object.keys(PRESETS).sort()).toEqual(SYNTH_PRESETS.map((p) => p.id).sort());
    expect(SYNTH_PRESETS.length).toBeGreaterThanOrEqual(16);
  });

  for (const info of SYNTH_PRESETS) {
    it(`${info.name}: every value is a real parameter within its range`, () => {
      const data = PRESETS[info.id];
      const specs = INSTRUMENT_PARAMS[info.kind];
      // A complete design: every instrument parameter is chosen, none left to chance.
      expect(Object.keys(data.params).sort()).toEqual(specs.map((s) => s.id).sort());
      for (const [k, v] of Object.entries(data.params)) expectInRange(specById(specs, k)!, v, `${info.id}.${k}`);

      for (const macro of Object.keys(data.macroMap ?? {})) {
        expect(MACRO_IDS).toContain(macro);
        for (const t of data.macroMap![macro as (typeof MACRO_IDS)[number]]!) {
          const spec = specById(specsForSlot(info.kind, t.slot), t.param);
          expect(spec, `${info.id} ${macro} -> ${t.slot}.${t.param}`).toBeDefined();
          expectInRange(spec!, t.min, `${info.id} ${macro} min`);
          expectInRange(spec!, t.max, `${info.id} ${macro} max`);
          if (t.curve === 'exp') expect(t.min > 0 && t.max > 0).toBe(true);
          for (const r of [t.macroFrom, t.macroTo]) if (r !== undefined) expect(r >= 0 && r <= 1).toBe(true);
        }
      }

      for (const [slot, values] of Object.entries(data.modules ?? {})) {
        // Presets shape the sound; the channel (level, pan, sends) is the user's mix.
        expect(['lfo', 'filter', 'drive']).toContain(slot);
        for (const [k, v] of Object.entries(values!)) expectInRange(specById(specsForSlot(info.kind, slot as TrackSlot), k)!, v, `${info.id}.${slot}.${k}`);
      }

      for (const [m, v] of Object.entries(data.macros ?? {})) {
        expect(['tone', 'motion', 'drive']).toContain(m);
        expect(v >= 0 && v <= 1).toBe(true);
      }
    });
  }

  it('keeps level trims in a sane window: basses loud, the melodic categories lower (measured in tests/browser/presets.test.ts)', () => {
    const level = (id: string) => PRESETS[id].params.level;
    for (const p of SYNTH_PRESETS) {
      expect(level(p.id), p.id).toBeGreaterThanOrEqual(-14);
      expect(level(p.id), p.id).toBeLessThanOrEqual(2);
    }
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const basses = med(SYNTH_PRESETS.filter((p) => p.category === 'bass').map((p) => level(p.id)));
    const pads = med(SYNTH_PRESETS.filter((p) => p.category === 'pads').map((p) => level(p.id)));
    const keys = med(SYNTH_PRESETS.filter((p) => p.category === 'keys').map((p) => level(p.id)));
    expect(basses).toBeGreaterThan(keys);
    // Sustained pads need the most trim for the same loudness.
    expect(pads).toBeLessThanOrEqual(keys);
  });

  it('makes every preset sonically distinct from every other of its kind', () => {
    for (const kind of ['bass', 'poly'] as const) {
      const specs = INSTRUMENT_PARAMS[kind];
      const list = SYNTH_PRESETS.filter((p) => p.kind === kind);
      const vec = (id: string) => specs.filter((s) => s.id !== 'level').map((s) => toNormalized(s, PRESETS[id].params[s.id]));
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = vec(list[i].id);
          const b = vec(list[j].id);
          const distance = a.reduce((s, v, k) => s + Math.abs(v - b[k]), 0);
          // Summed over ~15 normalised controls: at least one full knob sweep of difference.
          expect(distance, `${list[i].name} vs ${list[j].name}`).toBeGreaterThan(1.5);
        }
        // And each one is a design, not the registry default.
        const def = defaultParams(specs);
        expect(specs.some((s) => s.id !== 'level' && PRESETS[list[i].id].params[s.id] !== def[s.id])).toBe(true);
      }
    }
  });

  it('matches the catalog descriptions where they are measurable', () => {
    const p = (id: string) => PRESETS[id].params;
    const SAW = 0, SQUARE = 1, TRIANGLE = 2, SINE = 3;
    expect([SINE, TRIANGLE]).toContain(p('bass-round-sub').wave);
    expect(p('bass-round-sub').cutoff).toBeLessThanOrEqual(500);
    expect(p('bass-acid-line').wave).toBe(SAW);
    expect(p('bass-acid-line').resonance).toBeGreaterThanOrEqual(0.65);
    expect(p('bass-acid-line').glide).toBeGreaterThan(0.05);
    expect(p('bass-rubber-pluck').wave).toBe(SQUARE);
    expect(p('bass-dub-pressure').release).toBeGreaterThan(p('bass-round-sub').release * 3);
    expect(p('poly-house-stab').sustain).toBe(0);
    expect(p('poly-short-pluck').sustain).toBe(0);
    expect(p('poly-mallet-bell').osc2Semi).toBe(19);
    expect(p('poly-night-choir').osc2Semi).toBe(7);
    expect(p('poly-tape-shimmer').osc2Semi).toBe(24);
    expect(p('poly-halo-pad').attack).toBeGreaterThanOrEqual(1.2);
    expect(p('poly-halo-pad').release).toBeGreaterThanOrEqual(2);
    expect(p('poly-halo-pad').cutoff).toBeLessThan(p('poly-lumen-chords').cutoff);
    expect(p('poly-air-grain').noise).toBeGreaterThanOrEqual(0.8);
    expect(p('poly-soft-whistle').osc1Wave).toBe(SINE);
    expect(p('poly-lumen-chords').detune).toBeGreaterThanOrEqual(10);
    for (const id of ['poly-halo-pad', 'poly-warm-drift', 'poly-night-choir', 'poly-tape-shimmer', 'poly-air-grain']) {
      expect(p(id).attack, id).toBeGreaterThan(0.5);
    }
    // The extended library: what each description promises is in the design.
    expect(p('bass-808-boom').subWave).toBe(1);
    expect(p('bass-808-boom').pitchEnv).toBeGreaterThan(0);
    expect(p('bass-808-boom').decay).toBeGreaterThan(1);
    expect(p('bass-reese').unisonDetune).toBeGreaterThanOrEqual(10);
    expect(p('bass-pure-sub').subWave).toBe(1);
    expect(p('bass-pure-sub').wave).toBe(SINE);
    expect(p('bass-zap').pitchEnv).toBeGreaterThanOrEqual(12);
    for (const id of ['bass-fm-slap', 'bass-growl', 'poly-tine-piano', 'poly-crystal-ep', 'poly-glass-pad', 'poly-fm-lead', 'poly-tubular-bell', 'poly-metal-clang', 'poly-kalimba']) expect(p(id).fmAmount, id).toBeGreaterThan(0.1);
    expect(p('poly-crystal-ep').fmRatio).toBeGreaterThan(10);
    expect(Number.isInteger(p('poly-tine-piano').fmRatio)).toBe(true);
    expect(Number.isInteger(p('poly-tubular-bell').fmRatio)).toBe(false);
    expect(Number.isInteger(p('poly-metal-clang').fmRatio)).toBe(false);
    expect(p('poly-supersaw-pad').unison).toBe(7);
    expect(p('poly-supersaw-lead').unison).toBeGreaterThanOrEqual(5);
    for (const id of ['poly-string-ensemble', 'poly-cinematic-strings', 'poly-choir-ooh', 'poly-wooden-flute', 'poly-drawbar-organ']) expect(p(id).vibrato, id).toBeGreaterThan(0);
    expect(p('poly-drawbar-organ').sustain).toBe(1);
    expect(p('poly-drawbar-organ').velocity).toBe(0);
    expect(p('poly-analog-pad').drift).toBeGreaterThanOrEqual(0.5);
    expect(p('poly-warped-tape').drift).toBeGreaterThanOrEqual(0.5);
    expect(p('poly-sweep-riser').pitchEnv).toBeLessThan(0);
    expect(p('poly-sweep-riser').attack).toBeGreaterThanOrEqual(3);
    expect(p('poly-downlifter').pitchEnv).toBeGreaterThan(0);
    expect(p('poly-laser-zap').pitchEnv).toBeGreaterThan(0);
    expect(p('poly-laser-zap').sustain).toBe(0);
    expect(p('poly-ocean-wash').noise).toBe(1);
    expect(p('poly-ocean-wash').noiseColor).toBeLessThan(0.5);
    expect(p('poly-breath-pad').noiseColor).toBeGreaterThan(0.5);
    expect(p('poly-synth-brass').pitchEnv).toBeLessThan(0);
    for (const id of ['poly-kalimba', 'poly-marimba', 'poly-vibraphone', 'poly-tubular-bell', 'poly-glockenspiel', 'poly-music-box', 'poly-harp', 'poly-steel-drum', 'poly-koto-pluck', 'poly-harpsichord']) expect(p(id).sustain, id).toBe(0);
  });

  it('the shipped presets use none of the new synth features, so they (and the starters) sound exactly as before', () => {
    const shipped = ['bass-round-sub', 'bass-rubber-pluck', 'bass-acid-line', 'bass-velvet-saw', 'bass-organ-short', 'bass-dub-pressure', 'poly-glass-keys', 'poly-lumen-chords', 'poly-house-stab', 'poly-short-pluck', 'poly-neon-lead', 'poly-soft-whistle', 'poly-mallet-bell', 'poly-halo-pad', 'poly-warm-drift', 'poly-air-grain', 'poly-night-choir', 'poly-tape-shimmer'];
    const features = ['subWave', 'unison', 'unisonDetune', 'fmAmount', 'fmRatio', 'fmDecay', 'noiseColor', 'pitchEnv', 'pitchDecay', 'vibrato', 'vibratoRate', 'drift'];
    for (const id of shipped) {
      const info = SYNTH_PRESETS.find((x) => x.id === id)!;
      const specs = INSTRUMENT_PARAMS[info.kind];
      for (const f of features) {
        const spec = specById(specs, f);
        if (spec) expect(PRESETS[id].params[f], `${id}.${f}`).toBe(spec.default);
      }
    }
  });

  it('only resets module params that some preset designs', () => {
    expect(PRESET_OWNED_MODULE_PARAMS.lfo).toEqual(expect.arrayContaining(['wave', 'division']));
    expect(Object.keys(PRESET_OWNED_MODULE_PARAMS)).not.toContain('ch');
  });
});

describe('applyPresetToProject', () => {
  for (const info of SYNTH_PRESETS) {
    for (const trackId of [BASS_TRACK, CHORD_TRACK]) {
      it(`${info.name} on ${trackId}: a valid project with the designed sound and working macros`, () => {
        const before = fresh();
        const after = produce(before, (d) => applyPresetToProject(d, trackId, info.id));
        const track = after.tracks.find((t) => t.id === trackId)!;
        const data = PRESETS[info.id];

        // Instrument
        expect(track.instrument.kind).toBe(info.kind);
        expect(track.instrument.kind !== 'drums' && track.instrument.kind !== 'sampler' && track.instrument.presetId).toBe(info.id);
        expect(track.instrument.params).toEqual({ ...defaultParams(INSTRUMENT_PARAMS[info.kind]), ...data.params });

        // Every macro target points at a real module and parameter, inside its range.
        const ids = new Set(after.patch.modules.map((m) => m.id));
        for (const macro of MACRO_IDS) {
          for (const t of track.macroMap[macro]) {
            expect(ids.has(t.module), `${macro} -> ${t.module}`).toBe(true);
            const spec = specById(specsForModule(after, t.module), t.param);
            expect(spec, `${macro} -> ${t.module}.${t.param}`).toBeDefined();
            expectInRange(spec!, t.min, `${macro} min`);
            expectInRange(spec!, t.max, `${macro} max`);
          }
          expect(track.macroMap[macro].length).toBeGreaterThan(0);
        }

        // Tone 0.5 is exactly the designed cutoff; the ends move it by up to TONE_RANGE in either direction.
        const inst = `${trackId}:inst`;
        const at = (macro: 'tone' | 'motion', v: number) => resolveAllParams(withMacros(after, trackId, { [macro]: v }));
        expect(track.macros.tone).toBe(data.macros?.tone ?? 0.5);
        expect(at('tone', 0.5).get(inst)!.cutoff).toBeCloseTo(data.params.cutoff, 6);
        const dark = at('tone', 0).get(inst)!.cutoff;
        const bright = at('tone', 1).get(inst)!.cutoff;
        expect(dark).toBeLessThan(data.params.cutoff);
        expect(bright).toBeGreaterThan(data.params.cutoff);
        expect(bright / dark).toBeGreaterThan(6);
        expect(bright / dark).toBeLessThanOrEqual(TONE_RANGE * TONE_RANGE + 1e-6);
        expect(at('tone', 0.5).get(`${trackId}:filter`)!.bright).toBe(0);
        // Every other instrument control Tone moves is also exactly as designed at 0.5, and moves toward the ends.
        for (const t of track.macroMap.tone.filter((x) => x.module === inst && x.param !== 'cutoff')) {
          expect(at('tone', 0.5).get(inst)![t.param], `${info.id} ${t.param}`).toBeCloseTo(data.params[t.param], 6);
          expect(at('tone', 0).get(inst)![t.param]).not.toBeCloseTo(at('tone', 1).get(inst)![t.param], 2);
        }

        // Motion: still at 0; at 1 the LFO moves a filter set where this sound has energy.
        const still = at('motion', 0);
        expect(still.get(`${trackId}:lfo`)!.depth).toBe(0);
        expect(still.get(`${trackId}:filter`)!.cutoff).toBe(20000);
        const moving = at('motion', 1);
        expect(moving.get(`${trackId}:lfo`)!.depth).toBeGreaterThan(0.3);
        expect(moving.get(`${trackId}:filter`)!.cutoff).toBeLessThan(8000);

        // The user's mix and the routing are untouched.
        expect(after.patch.connections).toEqual(before.patch.connections);
        const touched = new Set([`${trackId}:lfo`, `${trackId}:filter`, `${trackId}:drive`]);
        after.patch.modules.forEach((m, i) => {
          const b = before.patch.modules[i];
          expect(m.id).toBe(b.id);
          if (!touched.has(m.id)) expect(m).toEqual(b);
          else expect(m.bypass).toBe(b.bypass);
        });
        expect(track.macros.space).toBe(0.4);
        expect(track.macros.echo).toBe(0.3);
        expect(track.macros.pump).toBe(0.2);
        expect(track.clips).toEqual(before.tracks.find((t) => t.id === trackId)!.clips);

        // Preset module settings are in place.
        for (const [slot, values] of Object.entries(data.modules ?? {})) {
          const mod = after.patch.modules.find((m) => m.id === slotModuleId(trackId, slot as TrackSlot))!;
          for (const [k, v] of Object.entries(values!)) expect(mod.params[k]).toBe(v);
        }

        // Other tracks are unaffected, and the whole project passes validation cleanly.
        after.tracks.forEach((t, i) => {
          if (t.id !== trackId) expect(t).toEqual(before.tracks[i]);
        });
        const v = validateProject(JSON.parse(JSON.stringify(after)));
        expect(v.ok && v.warnings).toEqual([]);
      });
    }
  }

  it('leaves no trace of the previous preset', () => {
    const direct = produce(fresh(), (d) => applyPresetToProject(d, CHORD_TRACK, 'poly-glass-keys'));
    let chained = fresh();
    for (const id of ['poly-night-choir', 'bass-acid-line', 'poly-halo-pad', 'poly-glass-keys']) {
      chained = produce(chained, (d) => applyPresetToProject(d, CHORD_TRACK, id));
    }
    expect(chained.tracks).toEqual(direct.tracks);
    // (Connection ids differ between two fresh projects; the modules must match exactly.)
    expect(chained.patch.modules).toEqual(direct.patch.modules);
  });

  it('sets the preset’s suggested Motion/Drive and resets Tone to the designed sound', () => {
    let p = withMacros(fresh(), CHORD_TRACK, { tone: 0.9, motion: 0.7, drive: 0.6 });
    p = produce(p, (d) => applyPresetToProject(d, CHORD_TRACK, 'poly-halo-pad'));
    const t = p.tracks.find((x) => x.id === CHORD_TRACK)!;
    expect(t.macros.tone).toBe(0.5);
    expect(t.macros.motion).toBe(PRESETS['poly-halo-pad'].macros!.motion);
    expect(t.macros.drive).toBe(0);
  });

  it('drops mappings to a module the user removed', () => {
    const p = produce(fresh(), (d) => {
      d.patch.modules = d.patch.modules.filter((m) => m.id !== `${CHORD_TRACK}:filter`);
      d.patch.connections = d.patch.connections.filter((c) => c.from.module !== `${CHORD_TRACK}:filter` && c.to.module !== `${CHORD_TRACK}:filter`);
      applyPresetToProject(d, CHORD_TRACK, 'poly-lumen-chords');
    });
    const t = p.tracks.find((x) => x.id === CHORD_TRACK)!;
    for (const m of MACRO_IDS) for (const x of t.macroMap[m]) expect(x.module).not.toBe(`${CHORD_TRACK}:filter`);
    expect(t.macroMap.tone.some((x) => x.module === `${CHORD_TRACK}:inst`)).toBe(true);
  });

  it('rejects unknown presets and parts with a clear error', () => {
    const p = fresh();
    expect(() => applyPresetToProject(p, CHORD_TRACK, 'poly-does-not-exist')).toThrow(/Unknown synth preset "poly-does-not-exist"/);
    expect(() => applyPresetToProject(p, 't99', 'poly-glass-keys')).toThrow(/no part/);
  });
});

describe('applyKitToProject', () => {
  it('turns a synth part into a drum part with default voices and macros', () => {
    const before = produce(fresh(), (d) => applyPresetToProject(d, BASS_TRACK, 'bass-acid-line'));
    const after = produce(before, (d) => applyKitToProject(d, BASS_TRACK, 'tight-circuit'));
    const t = after.tracks.find((x) => x.id === BASS_TRACK)!;
    // Kit Level starts at the kit's matched level, not at 0 dB (10+ dB hotter than the synths).
    expect(t.instrument).toEqual({ kind: 'drums', kitId: 'tight-circuit', params: { ...defaultParams(DRUM_KIT_PARAMS), level: -11 }, voices: defaultDrumVoices() });
    expect(t.macroMap).toEqual(defaultMacroMap(BASS_TRACK));
    expect(after.patch).toEqual(before.patch);
    const v = validateProject(JSON.parse(JSON.stringify(after)));
    expect(v.ok && v.warnings).toEqual([]);
  });

  it('keeps the kit level when swapping one kit for another', () => {
    let p = produce(fresh(), (d) => {
      const inst = d.tracks[0].instrument;
      if (inst.kind === 'drums') {
        inst.params.level = -6;
        inst.voices[2].tune = 5;
      }
    });
    p = produce(p, (d) => applyKitToProject(d, 't1', 'dust-tape'));
    const inst = p.tracks[0].instrument;
    expect(inst.kind === 'drums' && inst.kitId).toBe('dust-tape');
    expect(inst.params.level).toBe(-6);
    expect(inst.kind === 'drums' && inst.voices).toEqual(defaultDrumVoices());
  });

  it('a synth part switched to a kit plays at the level of the project\'s own kits', () => {
    const blank = BLANK.build();
    const level = (p: Project, id: string) => p.tracks.find((t) => t.id === id)!.instrument.params.level;
    const drums = blank.tracks.find((t) => t.role === 'drums')!;
    const perc = blank.tracks.find((t) => t.role === 'percussion')!;
    const lead = blank.tracks.find((t) => t.role === 'lead')!;
    expect(level(blank, drums.id)).toBe(kitInfo('round-machine')!.level);
    expect(level(blank, perc.id)).toBe(kitInfo('hand-percussion')!.level);
    for (const k of KITS) {
      const p = produce(blank, (d) => applyKitToProject(d, lead.id, k.id));
      expect(level(p, lead.id), k.id).toBe(k.level);
    }
    // The shipped kits keep their matched levels (saved projects and starters rely on them); hand percussion
    // needs less trim. Every kit's level is measured against them in tests/browser/omni-sounds-kits.test.ts.
    for (const id of ['round-machine', 'tight-circuit', 'dust-tape', 'bright-steel']) expect(kitInfo(id)!.level, id).toBe(-11);
    expect(kitInfo('hand-percussion')!.level).toBe(-4.5);
    for (const k of KITS) {
      expect(k.level, k.id).toBeGreaterThanOrEqual(-14);
      expect(k.level, k.id).toBeLessThanOrEqual(-3);
    }
  });

  it('keeps the user\'s trim relative to the matched level when changing between kit families', () => {
    const house = HOUSE.build();
    const perc = house.tracks.find((t) => t.instrument.kind === 'drums' && t.instrument.kitId === 'hand-percussion')!;
    const trim = (perc.instrument.params.level as number) - kitInfo('hand-percussion')!.level;
    const p = produce(house, (d) => applyKitToProject(d, perc.id, 'round-machine'));
    expect(p.tracks.find((t) => t.id === perc.id)!.instrument.params.level).toBeCloseTo(kitInfo('round-machine')!.level + trim, 9);
    // Stays within the Level range (-24 - 4.5 dB of trim would be below it).
    const quiet = produce(house, (d) => {
      d.tracks.find((t) => t.id === perc.id)!.instrument.params.level = -24;
    });
    const q = produce(quiet, (d) => applyKitToProject(d, perc.id, 'round-machine'));
    expect(q.tracks.find((t) => t.id === perc.id)!.instrument.params.level).toBe(-24);
  });

  it('accepts every catalog kit and rejects unknown ones', () => {
    for (const k of KITS) expect(() => applyKitToProject(fresh(), 't1', k.id)).not.toThrow();
    expect(() => applyKitToProject(fresh(), 't1', 'no-such-kit')).toThrow(/Unknown drum kit/);
  });
});

describe('applySamplerToProject', () => {
  it('assigns built-in and imported recordings with default sampler settings', () => {
    for (const s of BUILTIN_SAMPLES) {
      const p = produce(fresh(), (d) => applySamplerToProject(d, CHORD_TRACK, s.id));
      const t = p.tracks.find((x) => x.id === CHORD_TRACK)!;
      expect(t.instrument).toEqual({ kind: 'sampler', sampleId: s.id, params: defaultParams(SAMPLER_PARAMS) });
      expect(t.macroMap).toEqual(defaultMacroMap(CHORD_TRACK));
    }
    const withSample = produce(fresh(), (d) => {
      d.samples.push({ id: 'smp_1', name: 'Loop', mime: 'audio/wav', byteLength: 1000, duration: 1, sampleRate: 48000, channels: 2 });
      applySamplerToProject(d, 't8', 'smp_1');
    });
    expect(withSample.tracks[7].instrument).toMatchObject({ kind: 'sampler', sampleId: 'smp_1' });
    const v = validateProject(JSON.parse(JSON.stringify(withSample)));
    expect(v.ok && v.warnings).toEqual([]);
    const empty = produce(fresh(), (d) => applySamplerToProject(d, 't8', null));
    expect(empty.tracks[7].instrument).toMatchObject({ kind: 'sampler', sampleId: null });
  });

  it('refuses a recording that is not in the project', () => {
    expect(() => applySamplerToProject(fresh(), 't8', 'smp_missing')).toThrow(/Unknown recording/);
    expect(() => applySamplerToProject(fresh(), 't8', 'builtin:nope')).toThrow(/Unknown recording/);
  });
});
