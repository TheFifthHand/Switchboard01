/**
 * The Shape view's pure rules (no DOM): what a Simple effect card's knobs
 * are, where a knob's reset goes, the range a new big-knob assignment
 * sweeps, the Squeeze law, and the words for mappings and removals.
 */
import { describe, expect, it } from 'vitest';
import { chooseMainKnob, resonanceInRange, RESONANCE_BELOW_HZ } from '../../src/app/views/shape/cardKnob';
import { assignRange, curveWord, mappingWords, rangeWords } from '../../src/app/views/shape/macroAssign';
import { bigKnobReach, offCaption, offSentence } from '../../src/app/views/shape/bigKnobReach';
import { drumMixGroups, drumTuneVoice, groupLevels, playedSlots } from '../../src/app/views/shape/drumMix';
import { STARTERS } from '../../src/content/starters';
import { homeNote, knobHome, partKey } from '../../src/app/views/shape/paramState';
import { removedEffectNotice } from '../../src/app/views/shape/shared';
import { SQUEEZE_DEFAULT, squeezeOf, squeezeParams } from '../../src/app/views/shape/squeeze';
import { macroHomeNote, macroSpecFor } from '../../src/app/macros';
import { HOUSE } from '../../src/content/starters/house';
import { COMPRESSOR_PARAMS, FILTER_PARAMS, INSTRUMENT_PARAMS, MODULE_PARAMS, clampParam, fromNormalized, specById, toNormalized } from '../../src/project/params';
import { macroTargetValue } from '../../src/project/resolve';
import * as cmd from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';

const spec = (list: readonly import('../../src/project/params').ParamSpec[], id: string) => specById(list, id)!;

describe('Simple effect cards: the knob is the first main setting, or the big knob that sets it', () => {
  const p = HOUSE.build();
  it('every House part: Drive card → the Drive big knob; Filter card → the big knob that sets its cutoff (Tone or Motion)', () => {
    for (const t of p.tracks) {
      const drive = chooseMainKnob(p, `${t.id}:drive`, 'drive', t.id);
      expect(drive.macro, t.name).toEqual({ trackId: t.id, macro: 'drive' });
      expect(drive.by).toBe('Drive');
      expect(drive.param).toBe('amount');
      const filter = chooseMainKnob(p, `${t.id}:filter`, 'filter', t.id);
      expect(['tone', 'motion'], t.name).toContain(filter.macro?.macro);
      expect(filter.param).toBe('cutoff');
    }
  });

  it('Resonance is offered only while the cutoff is in the audible band', () => {
    const extra = (id: string) => chooseMainKnob(p, `${id}:filter`, 'filter', id).extra;
    expect(extra('t4')).toBeNull(); // Motion 0: 20 kHz
    expect(extra('t6')).toBe('resonance'); // Pad: Motion 25 %
    expect(extra('t7')).toBe('resonance'); // Texture: Motion 50 %
    expect(resonanceInRange({ mode: 0, cutoff: RESONANCE_BELOW_HZ - 1 })).toBe(true);
    expect(resonanceInRange({ mode: 0, cutoff: RESONANCE_BELOW_HZ })).toBe(false);
    expect(resonanceInRange({ mode: 1, cutoff: 40 })).toBe(false);
    expect(resonanceInRange({ mode: 1, cutoff: 400 })).toBe(true);
    expect(resonanceInRange({ mode: 2, cutoff: 20000 })).toBe(true);
  });

  it('a Filter card without Resonance says why: wide open, a high-pass at the bottom, or a big knob sets it', () => {
    const store = new ProjectStore(HOUSE.build());
    const note = () => chooseMainKnob(store.getState(), 't4:filter', 'filter', 't4').extraNote;
    expect(note()).toBe('Resonance appears once the filter closes below 12 kHz.');
    cmd.setModuleParam(store, 't4:filter', 'mode', 1);
    cmd.removeMacroTarget(store, 't4', 'motion', store.getState().tracks.find((t) => t.id === 't4')!.macroMap.motion.findIndex((x) => x.module === 't4:filter' && x.param === 'cutoff'));
    cmd.removeMacroTarget(store, 't4', 'tone', store.getState().tracks.find((t) => t.id === 't4')!.macroMap.tone.findIndex((x) => x.module === 't4:filter' && x.param === 'cutoff'));
    cmd.setModuleParam(store, 't4:filter', 'cutoff', 20);
    expect(note()).toBe('Resonance appears once the filter cuts above 60 Hz.');
    cmd.setModuleParam(store, 't4:filter', 'cutoff', 400);
    expect(chooseMainKnob(store.getState(), 't4:filter', 'filter', 't4')).toMatchObject({ extra: 'resonance', extraNote: null });
    cmd.setMacroTarget(store, 't4', 'motion', store.getState().tracks.find((t) => t.id === 't4')!.macroMap.motion.length, { module: 't4:filter', param: 'resonance', min: 0.1, max: 0.6, curve: 'lin' });
    expect(chooseMainKnob(store.getState(), 't4:filter', 'filter', 't4')).toMatchObject({ extra: null, extraNote: 'Resonance is set by the Motion big knob.' });
  });

  it('an added effect no big knob touches: its own first setting; the Compressor: Squeeze', () => {
    const store = new ProjectStore(HOUSE.build());
    cmd.insertEffect(store, 't4', 'reverb');
    cmd.insertEffect(store, 't4', 'compressor');
    const q = store.getState();
    expect(chooseMainKnob(q, 't4:reverb', 'reverb', 't4')).toMatchObject({ param: 'mix', macro: null, by: null });
    expect(chooseMainKnob(q, 't4:compressor', 'compressor', 't4')).toMatchObject({ param: 'squeeze', macro: null });
  });
});

describe('where a knob’s reset goes', () => {
  const p = HOUSE.build();
  it('instrument settings: the preset’s own value; the kit Level: its matched level', () => {
    expect(knobHome(p, 't3:inst', 'resonance', spec(INSTRUMENT_PARAMS.bass, 'resonance'))).toEqual({ home: 0.38, kind: 'sound' });
    expect(knobHome(p, 't3:inst', 'attack', spec(INSTRUMENT_PARAMS.bass, 'attack'))).toEqual({ home: 0.002, kind: 'sound' });
    expect(knobHome(p, 't1:inst', 'level', spec(INSTRUMENT_PARAMS.drums, 'level'))).toEqual({ home: -11, kind: 'sound' });
    expect(homeNote(spec(INSTRUMENT_PARAMS.bass, 'resonance'), { home: 0.38, kind: 'sound' })).toBe('Double-click returns it to this sound’s 38%; Alt+double-click to the plain default, 25%.');
  });

  it('an added effect: where Add effect starts it; a shared return: the plain default', () => {
    const store = new ProjectStore(HOUSE.build());
    cmd.insertEffect(store, 't4', 'drive');
    const q = store.getState();
    const added = q.patch.modules.find((m) => m.trackId === 't4' && m.type === 'drive' && m.id !== 't4:drive')!;
    expect(knobHome(q, added.id, 'amount', spec(MODULE_PARAMS.drive, 'amount'))).toEqual({ home: 0.35, kind: 'effect' });
    expect(knobHome(q, 'fx:reverb', 'mix', spec(MODULE_PARAMS.reverb, 'mix')).kind).toBe('plain');
    expect(homeNote(spec(MODULE_PARAMS.drive, 'amount'), { home: 0.35, kind: 'effect' })).toBe('Double-click returns it to 35%, where this effect starts; Alt+double-click to the plain default, 0%.');
  });

  it('big knobs: the starter’s positions (Chords: Space 28 %, Pump 45 %)', () => {
    const chords = p.tracks.find((t) => t.id === 't4')!;
    expect(macroSpecFor(chords, 'space').default).toBe(0.28);
    expect(macroSpecFor(chords, 'pump').default).toBe(0.45);
    expect(macroSpecFor(chords, 'tone').default).toBe(0.5);
    expect(macroHomeNote('space', 0.28)).toBe('Double-click returns it to this sound’s 28%; Alt+double-click to the plain default, 15%.');
    expect(macroHomeNote('tone', 0.5)).toBe('');
  });
});

describe('a new big-knob assignment', () => {
  const RES = spec(FILTER_PARAMS, 'resonance');
  const CUT = spec(FILTER_PARAMS, 'cutoff');
  it('keeps the value where it is at the big knob’s position (no jump), for any position', () => {
    for (const s of [RES, CUT, spec(COMPRESSOR_PARAMS, 'threshold')]) {
      for (const v of [s.min, fromNormalized(s, 0.2), fromNormalized(s, 0.5), fromNormalized(s, 0.8), s.max]) {
        for (const m of [0, 0.3, 0.5, 1]) {
          const r = assignRange(s, v, m);
          const at = macroTargetValue({ module: 'x', param: s.id, ...r }, m);
          expect(toNormalized(s, at), `${s.id} ${v} at ${m}`).toBeCloseTo(toNormalized(s, v), 6);
          // And it moves the setting by a real amount over the big knob's travel.
          const sweep = Math.abs(toNormalized(s, macroTargetValue({ module: 'x', param: s.id, ...r }, 1)) - toNormalized(s, macroTargetValue({ module: 'x', param: s.id, ...r }, 0)));
          expect(sweep, `${s.id} ${v} ${m}`).toBeGreaterThan(0.04);
        }
      }
    }
  });

  it('an option control (mode, wave, on/off) keeps its option at the big knob’s position, then steps to the far option', () => {
    const optionSpecs = [...Object.values(INSTRUMENT_PARAMS), ...Object.values(MODULE_PARAMS)].flat().filter((s) => s.curve === 'enum' || s.curve === 'bool');
    expect(optionSpecs.length).toBeGreaterThan(5);
    for (const s of optionSpecs) {
      for (let v = s.min; v <= s.max; v++) {
        for (const m of [0, 0.28, 0.5, 1]) {
          const r = assignRange(s, v, m);
          const at = (x: number) => clampParam(s, macroTargetValue({ module: 'x', param: s.id, ...r }, x));
          expect(at(m), `${s.id} = ${v} at ${m}`).toBe(v);
          // It still changes the option somewhere along the big knob's travel.
          expect(at(0) !== v || at(1) !== v, `${s.id} = ${v} at ${m}: moves`).toBe(true);
          // Below the big knob's position nothing moves (with the big knob at the top, the far option waits at the bottom).
          if (m < 1) for (const x of [0, m / 2]) expect(at(x), `${s.id} = ${v} at ${m}, big knob ${x}`).toBe(v);
        }
      }
    }
    // Filter Mode at Low-pass, Space at 28 %: stays Low-pass until Space passes 28 %, Band-pass at the top.
    const mode = spec(FILTER_PARAMS, 'mode');
    expect(assignRange(mode, 0, 0.28)).toEqual({ min: 0, max: 2, curve: 'lin', macroFrom: 0.28, macroTo: 1 });
    expect(assignRange(mode, 2, 1)).toEqual({ min: 0, max: 2, curve: 'lin' });
  });

  it('sweeps half the travel, upwards from the lower half; frequencies on a gentle (exponential) curve', () => {
    const r = assignRange(RES, 0.1, 0);
    expect(r).toEqual({ min: 0.1, max: 0.6, curve: 'lin' });
    const c = assignRange(CUT, 20000, 0);
    expect(c.curve).toBe('exp');
    expect(c.min).toBe(20000);
    expect(toNormalized(CUT, c.max)).toBeCloseTo(0.5, 5);
  });

  it('words: “curve: gentle / even”, “over Tone 60–100%”, “from 0.0 dB to +5.0 dB”', () => {
    expect(curveWord('exp')).toBe('gentle');
    expect(curveWord('lin')).toBe('even');
    const t = { module: 't4:filter', param: 'bright', min: 0, max: 5, curve: 'lin' as const, macroFrom: 0.6, macroTo: 1 };
    expect(mappingWords('Tone', t, '0.0 dB')).toEqual({ curve: 'curve: even', over: 'over Tone 60–100%', now: 'now 0.0 dB' });
    expect(mappingWords('Tone', { ...t, macroFrom: 0 }, 'x').over).toBeNull();
    expect(rangeWords(spec(FILTER_PARAMS, 'bright'), t)).toBe('from 0.0 dB to +5.0 dB');
  });
});

describe('Squeeze', () => {
  it('half way is the compressor’s own default; none is no compression; full is −28 dB, 5:1, 8 dB makeup at most, 0.5 ms', () => {
    expect(SQUEEZE_DEFAULT).toBe(0.5);
    expect(squeezeParams(0.5)).toEqual({ threshold: -18, ratio: 4, makeup: 0, attack: 10 });
    expect(squeezeParams(0)).toEqual({ threshold: 0, ratio: 1, makeup: 0, attack: 10 });
    expect(squeezeParams(1)).toEqual({ threshold: -28, ratio: 5, makeup: 8, attack: 0.5 });
  });

  it('turning it up never loosens anything, makeup never passes 8 dB, and the knob reads back the amount from the threshold', () => {
    let prev = squeezeParams(0);
    for (let s = 0.05; s <= 1.0001; s += 0.05) {
      const q = squeezeParams(s);
      expect(q.threshold).toBeLessThanOrEqual(prev.threshold);
      expect(q.ratio).toBeGreaterThanOrEqual(prev.ratio);
      expect(q.makeup).toBeGreaterThanOrEqual(prev.makeup);
      expect(q.makeup).toBeLessThanOrEqual(8);
      expect(q.attack).toBeLessThanOrEqual(prev.attack);
      expect(squeezeOf(q)).toBeCloseTo(Math.min(1, s), 5);
      prev = q;
    }
  });
});

describe('words', () => {
  it('the remove toast names the big knobs it leaves with nothing to move', () => {
    expect(removedEffectNotice('Filter', false, ['motion'])).toBe('Removed Filter. The Motion big knob now moves nothing.');
    expect(removedEffectNotice('Filter', false, ['tone', 'motion'])).toBe('Removed Filter. The Tone and Motion big knobs now move nothing.');
    expect(removedEffectNotice('Chorus', false, [])).toBe('Removed Chorus. The sound now flows straight past it.');
  });

  it('a part-independent key for a part’s module', () => {
    expect(partKey('t3:drive')).toBe('drive');
    expect(partKey('t4:eq-2')).toBe('eq-2');
    expect(partKey('fx:reverb')).toBe('reverb');
  });
});

describe('Drum mix: the voices the part plays, by role', () => {
  const groupsOf = (starter: (typeof STARTERS)[number], trackId: string) => {
    const t = starter.build().tracks.find((x) => x.id === trackId)!;
    if (t.instrument.kind !== 'drums') throw new Error('not drums');
    return drumMixGroups(t.instrument.kitId, playedSlots(t));
  };
  it('House drums (the Jump In groove): Kick, Snare & clap (the groove’s clap), Hats; the tune knob tunes the kick', () => {
    const g = groupsOf(STARTERS.find((s) => s.id === 'house')!, 't1');
    expect(g.map((x) => x.label)).toEqual(['Kick', 'Snare & clap', 'Hats']);
    expect(g[1].slots).toEqual([2, 3]);
    expect(drumTuneVoice('tight-circuit', g)).toEqual({ slot: 0, name: 'Kick' });
  });

  it('every knob of every starter’s drum parts moves at least one voice the part plays', () => {
    for (const s of STARTERS) {
      const p = s.build();
      for (const t of p.tracks) {
        if (t.instrument.kind !== 'drums') continue;
        const played = playedSlots(t);
        const g = drumMixGroups(t.instrument.kitId, played);
        expect(g.length, `${s.id} ${t.name}`).toBeGreaterThanOrEqual(1);
        for (const x of g) expect(x.slots.some((v) => played.has(v)), `${s.id} ${t.name} ${x.label}`).toBe(true);
        expect(played.has(drumTuneVoice(t.instrument.kitId, g).slot), `${s.id} ${t.name} tune`).toBe(true);
      }
    }
    // Techno's percussion plays rims, shaker, perc and ride: no kick, snare or hats knob.
    expect(groupsOf(STARTERS.find((s) => s.id === 'techno')!, 't2').map((x) => x.key)).toEqual(['perc', 'cymbals']);
  });

  it('a part with no notes yet shows the kit’s first three groups', () => {
    expect(drumMixGroups('tight-circuit', new Map()).map((x) => x.label)).toEqual(['Kick', 'Snare & clap', 'Hats']);
    expect(drumMixGroups('hand-percussion', new Map()).map((x) => x.label)).toEqual(['Low drums', 'High drums', 'Shakers']);
  });

  it('a group keeps its balance, also through 0 and past the top', () => {
    const hats = drumMixGroups('tight-circuit', new Map([[4, 10], [5, 2]])).find((x) => x.key === 'hats')!;
    expect(hats.lead).toBe(4);
    let r = groupLevels(hats, [1, 0.6, 1], 0);
    expect(r.levels).toEqual([0, 0, 0]);
    r = groupLevels(hats, r.levels, 0.5, r.memo);
    expect(r.levels[1]).toBeCloseTo(0.3, 9);
    expect(r.levels[2]).toBeCloseTo(0.5, 9);
    r = groupLevels(hats, r.levels, 1.5, r.memo);
    r = groupLevels(hats, r.levels, 1, r.memo);
    expect(r.levels[1]).toBeCloseTo(0.6, 9);
    // Changed elsewhere since (Advanced): the new balance is read from the levels.
    r = groupLevels(hats, [1, 0.2, 1], 0.5, r.memo);
    expect(r.levels[1]).toBeCloseTo(0.1, 9);
  });
});

describe('what a big knob reaches: heard, waiting for a switched-off effect, or nothing', () => {
  it('Chords with its Drive switched off: the Drive big knob waits for it (still set-able); removed, it moves nothing', () => {
    const store = new ProjectStore(HOUSE.build());
    expect(bigKnobReach(store.getState(), 't4', 'drive')).toEqual({ reach: 'audible', off: [] });
    cmd.setBypass(store, 't4:drive', true);
    expect(cmd.macroReach(store.getState(), 't4', 'drive')).toBe('none');
    expect(bigKnobReach(store.getState(), 't4', 'drive')).toEqual({ reach: 'off', off: ['Drive'] });
    expect(offCaption(['Drive'])).toBe('Drive is off');
    expect(offSentence(['Drive'], 'Drive')).toBe('Drive is switched off: turn it on to hear what Drive moves.');
    cmd.removeEffect(store, 't4:drive');
    expect(bigKnobReach(store.getState(), 't4', 'drive').reach).toBe('none');
  });

  it('a switched-off shared Reverb or Echo: Space and Echo reach nothing heard (the engine silences the return), and say why', () => {
    const store = new ProjectStore(HOUSE.build());
    expect(cmd.macroReach(store.getState(), 't4', 'space')).toBe('audible');
    cmd.setBypass(store, 'fx:reverb', true);
    cmd.setBypass(store, 'fx:delay', true);
    expect(cmd.macroReach(store.getState(), 't4', 'space')).toBe('none');
    expect(cmd.macroReach(store.getState(), 't4', 'echo')).toBe('none');
    expect(bigKnobReach(store.getState(), 't4', 'space')).toEqual({ reach: 'off', off: ['Reverb'] });
    expect(bigKnobReach(store.getState(), 't4', 'echo')).toEqual({ reach: 'off', off: ['Echo'] });
  });
});
