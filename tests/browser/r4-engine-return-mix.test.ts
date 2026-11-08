/**
 * Send returns (Mix view return strips): a Reverb or Echo fed only by
 * channel sends has no dry path, so its Mix is the return level — the
 * return's output rises with Mix and is silent at 0, and turning a return
 * down never makes the mix louder (it used to pass (1 − Mix) of the dry
 * sends). Patched inline (an insert) the dry sound still passes at
 * 1 − Mix. Patching a direct cable in or out while it plays glides, a
 * switched-off return (Mute: Bypass) is silent, and the live engine reads a
 * return at Mix 0 as silence too.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import type { MeterFrame } from '../../src/audio/contracts';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { HOUSE } from '../../src/content/starters/house';
import { DELAY_ID, REVERB_ID, conn, createModule, moduleId } from '../../src/project/factory';
import type { Project } from '../../src/project/types';
import { LATENCY, SR, baseProject, clone, coreProject, harness, pitchForHz, toneAmp } from './engine-harness';

const HZ = 440;
const TONE = pitchForHz(HZ);
const VEL = 0.25;

/** Track t3 sends its tone to both returns at full Space / Echo; `returnOnly` unpatches its direct output. */
function sendProject(reverbMix: number, delayMix: number, opts: { returnOnly?: boolean; bypassReverb?: boolean } = {}): Project {
  const p = baseProject();
  const t3 = p.tracks[2];
  t3.macros = { ...t3.macros, space: 1, echo: 1 };
  for (const m of p.patch.modules) {
    if (m.id === REVERB_ID) {
      m.params = { ...m.params, mix: reverbMix };
      if (opts.bypassReverb) m.bypass = true;
    }
    if (m.id === DELAY_ID) m.params = { ...m.params, mix: delayMix };
  }
  if (opts.returnOnly) p.patch.connections = p.patch.connections.filter((c) => !(c.from.module === moduleId.channel('t3') && c.from.port === 'out'));
  return p;
}

async function renderRms(p: Project, seconds = 2.5): Promise<{ rms: number; L: Float32Array }> {
  const h = await harness(seconds, p);
  h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.05, duration: seconds - 0.3 });
  const { L, R } = await h.render();
  let s = 0;
  const a = Math.round(0.8 * SR);
  const b = Math.round((seconds - 0.4) * SR);
  for (let i = a; i < b; i++) s += L[i] * L[i] + R[i] * R[i];
  return { rms: Math.sqrt(s / (2 * (b - a))), L };
}

/** Largest change of the tone's envelope between consecutive half cycles in [t0, t1) (dB): a click shows as a jump. */
function maxStepDb(d: Float32Array, t0: number, t1: number, hz: number): number {
  const half = Math.round(SR / hz / 2);
  let prev = -1;
  let worst = 0;
  for (let s = Math.round(t0 * SR); s + half <= Math.round(t1 * SR); s += half) {
    let pk = 0;
    for (let i = s; i < s + half; i++) pk = Math.max(pk, Math.abs(d[i]));
    if (prev > 1e-5 && pk > 1e-5) worst = Math.max(worst, Math.abs(20 * Math.log10(pk / prev)));
    prev = pk;
  }
  return worst;
}

describe('send returns: Mix is the return level', () => {
  it('a return’s output rises with Mix and is silent at 0 (Reverb and Echo)', async () => {
    const mixes = [0, 0.25, 0.5, 0.75, 1];
    for (const which of ['reverb', 'delay'] as const) {
      const levels: number[] = [];
      for (const m of mixes) {
        const p = which === 'reverb' ? sendProject(m, 0, { returnOnly: true }) : sendProject(0, m, { returnOnly: true });
        // Only this return is heard: the other gets no send.
        p.tracks[2].macros = { ...p.tracks[2].macros, space: which === 'reverb' ? 1 : 0, echo: which === 'delay' ? 1 : 0 };
        levels.push((await renderRms(p)).rms);
      }
      console.info(`[return-mix] ${which} output at Mix ${mixes.join('/')}: ${levels.map((v) => v.toExponential(2)).join(' / ')}`);
      expect(levels[0]).toBeLessThan(1e-6);
      for (let k = 1; k < levels.length; k++) expect(levels[k], `${which} Mix ${mixes[k]}`).toBeGreaterThan(levels[k - 1] * 1.2);
      // The return level is Mix itself (a linear fader on the wet sound).
      expect(levels[2] / levels[4]).toBeCloseTo(0.5, 1);
    }
  });

  it('turning a return down never makes the mix louder', async () => {
    const master: number[] = [];
    for (const m of [1, 0.5, 0]) master.push((await renderRms(sendProject(m, m))).rms);
    console.info(`[return-mix] master RMS with both returns at Mix 1 / 0.5 / 0: ${master.map((v) => v.toFixed(4)).join(' / ')}`);
    expect(master[1]).toBeLessThan(master[0]);
    expect(master[2]).toBeLessThan(master[1]);
    // At Mix 0 only the part's own sound is left: as if it sent nothing.
    const noSends = sendProject(1, 1);
    noSends.tracks[2].macros = { ...noSends.tracks[2].macros, space: 0, echo: 0 };
    const dry = await renderRms(noSends);
    expect(Math.abs(20 * Math.log10(master[2] / dry.rms))).toBeLessThan(0.05);
  });

  it('a switched-off return (Mute: Bypass) is silent', async () => {
    const off = await renderRms(sendProject(1, 0, { returnOnly: true, bypassReverb: true }));
    expect(off.rms).toBeLessThan(1e-6);
  });

  it('an inline Reverb (an insert) still passes the dry sound at 1 − Mix', async () => {
    const insert = (mix: number | null): Project => {
      const p = coreProject();
      if (mix === null) return p;
      const rv = 't3:rv';
      const inst = moduleId.inst('t3');
      const ch = moduleId.channel('t3');
      p.patch.modules.push({ ...createModule(rv, 'reverb', 't3'), params: { ...createModule(rv, 'reverb', 't3').params, mix, predelay: 150 } });
      p.patch.connections = p.patch.connections.filter((c) => !(c.from.module === inst && c.to.module === ch));
      p.patch.connections.push(conn(inst, 'out', rv, 'in'), conn(rv, 'out', ch, 'in'));
      return p;
    };
    const render = async (p: Project) => {
      const h = await harness(1.2, p);
      h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.05, duration: 1 });
      return (await h.render()).L;
    };
    const plain = await render(insert(null));
    const mix0 = await render(insert(0));
    const half = await render(insert(0.5));
    // Mix 0: exactly the dry sound.
    let diff = 0;
    for (let i = 0; i < plain.length; i++) diff = Math.max(diff, Math.abs(plain[i] - mix0[i]));
    expect(diff).toBeLessThan(1e-6);
    // Mix 0.5, before the 150 ms pre-delay brings the room in: half the dry sound.
    const a = 0.08 + LATENCY;
    const b = 0.18 + LATENCY;
    const ratio = toneAmp(half, HZ, a, b) / toneAmp(plain, HZ, a, b);
    console.info(`[return-mix] inline Reverb at Mix 0.5: dry share ${ratio.toFixed(4)}`);
    expect(ratio).toBeCloseTo(0.5, 2);
  });

  it('patching a direct cable into a return and out again while it plays glides (no click)', async () => {
    const p = sendProject(0.5, 0);
    p.tracks[2].macros = { ...p.tracks[2].macros, echo: 0 };
    const withInsert = clone(p);
    withInsert.patch.connections.push(conn(moduleId.filter('t3'), 'out', REVERB_ID, 'in'));
    const h = await harness(3.0, p);
    h.engine.scheduleNote('t3', { pitch: TONE, velocity: VEL, time: 0.05, duration: 2.8 });
    h.at(1.0, () => h.engine.setProject(withInsert));
    h.at(2.0, () => h.engine.setProject(p));
    const { L } = await h.render();
    const steady = maxStepDb(L, 0.5 + LATENCY, 0.95 + LATENCY, HZ);
    const patched = maxStepDb(L, 0.98 + LATENCY, 1.15 + LATENCY, HZ);
    const unpatched = maxStepDb(L, 1.98 + LATENCY, 2.15 + LATENCY, HZ);
    console.info(`[return-mix] largest half-cycle step: steady ${steady.toFixed(2)} dB, patching in ${patched.toFixed(2)} dB, out ${unpatched.toFixed(2)} dB`);
    expect(patched).toBeLessThan(1.5);
    expect(unpatched).toBeLessThan(1.5);
    // While patched the dry sound passes the Reverb too (at 1 − Mix): louder than before.
    expect(toneAmp(L, HZ, 1.5 + LATENCY, 1.9 + LATENCY)).toBeGreaterThan(toneAmp(L, HZ, 0.6 + LATENCY, 0.9 + LATENCY) * 1.2);
  });

  it('the live engine reads a return at Mix 0 as silence while parts send to it', async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const project = HOUSE.build();
    const t4 = project.tracks.find((t) => t.id === 't4')!;
    t4.macros = { ...t4.macros, space: 0.8, echo: 0 };
    const at = (mix: number): Project => ({ ...project, patch: { ...project.patch, modules: project.patch.modules.map((m) => (m.id === REVERB_ID ? { ...m, params: { ...m.params, mix } } : m)) } });
    const engine = await AudioEngine.create(ctx, { samples: new SampleBank(ctx.sampleRate), seed: project.seed, meters: true });
    const f: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
    // Largest return reading over `seconds` of audio time.
    const reading = async (seconds: number): Promise<number> => {
      let best = 0;
      const end = ctx.currentTime + seconds;
      while (ctx.currentTime < end) {
        engine.readMeters(f);
        best = Math.max(best, f.returns?.reverb.rms ?? 0);
        await new Promise((r) => setTimeout(r, 15));
      }
      return best;
    };
    try {
      engine.setProject(at(0));
      for (const [k, p] of [60, 64, 67].entries()) engine.liveNoteOn('t4', p, 0.9, `A${k}`);
      const silent = await reading(0.6);
      engine.setProject(at(1));
      const full = await reading(0.6);
      console.info(`[return-mix] live reverb return reading at Mix 0: ${silent.toExponential(2)}, Mix 1: ${full.toFixed(4)}`);
      expect(silent).toBeLessThan(1e-5);
      expect(full).toBeGreaterThan(0.002);
      engine.releaseLive();
    } finally {
      engine.dispose();
      await ctx.close();
    }
  }, 30_000);
});
