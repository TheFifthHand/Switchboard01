/**
 * Drum kits never render inside the scheduler (perf-06 / perf-08). The House
 * groove plays through the real transport on a live context while three
 * kits are picked in turn: every scheduleNote call comes before its note's
 * time (none late), no drum voice is synthesised inside scheduleNote, the
 * first hit after each change sounds (the slot's previous voice until the
 * new one is ready), and the new kit's voices are rendered in idle slices
 * within moments, the clips' slots first.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import type { MeterFrame, NoteTrigger, VoiceHandle } from '../../src/audio/contracts';
import { SampleBank } from '../../src/audio/instruments/sampleBank';
import { clearDrumVoiceCache, drumVoiceCacheStats, peekDrumVoice, quantizeDrumDecay } from '../../src/audio/instruments/drumSynth';
import { HOUSE } from '../../src/content/starters/house';
import { DRUM_KIT_PARAMS, readParam } from '../../src/project/params';
import type { DrumsInstrument, Project } from '../../src/project/types';
import { Sequencer } from '../../src/time/sequencer';
import { RealtimeTransport } from '../../src/time/transport';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withKit(p: Project, kitId: string): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === 't1' ? { ...t, instrument: { ...(t.instrument as DrumsInstrument), kitId } } : t)) };
}

describe('drum kit changes while the groove plays', () => {
  it('no late notes, no synthesis in scheduleNote, the first hit after each change sounds', async () => {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.resume();
    let project = HOUSE.build();
    const engine = await AudioEngine.create(ctx, { samples: new SampleBank(ctx.sampleRate), seed: project.seed, meters: true });
    engine.setProject(project);
    // Jump In: the starter's voices in idle slices, the ones its clips play first.
    await engine.prepareInstruments({ incremental: true });

    const late: number[] = [];
    let rendersInSchedule = 0;
    let watchFirst = false;
    const firstHits: (VoiceHandle | null)[] = [];
    let calls = 0;
    const schedule = engine.scheduleNote.bind(engine);
    engine.scheduleNote = (trackId: string, note: NoteTrigger) => {
      calls++;
      const now = ctx.currentTime;
      if (note.time < now) late.push(now - note.time);
      const before = drumVoiceCacheStats().renders;
      const handle = schedule(trackId, note);
      rendersInSchedule += drumVoiceCacheStats().renders - before;
      if (trackId === 't1' && watchFirst) {
        watchFirst = false;
        firstHits.push(handle);
      }
      return handle;
    };

    const sequencer = new Sequencer({ getProject: () => project });
    const transport = new RealtimeTransport({ ctx, engine, sequencer, lookahead: 0.3 });
    const groove = project.tracks.filter((t) => t.clips[1]).map((t) => ({ trackId: t.id, playing: { slot: 1, startTick: 0 } }));
    transport.start({ launcher: groove });
    const frame: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
    const drumsPeakFor = async (ms: number): Promise<number> => {
      let best = 0;
      const end = performance.now() + ms;
      while (performance.now() < end) {
        engine.readMeters(frame);
        best = Math.max(best, frame.tracks.find((t) => t.trackId === 't1')?.peak ?? 0);
        await sleep(15);
      }
      return best;
    };

    try {
      await sleep(1200);
      const kits = ['boom-808', 'studio-acoustic', 'iron-forge'];
      const peaks: number[] = [];
      for (const kit of kits) {
        project = withKit(project, kit);
        watchFirst = true;
        engine.setProject(project);
        peaks.push(await drumsPeakFor(500));
        await sleep(1000);
      }
      transport.stop();

      console.info(`[drumkit] notes ${calls}, late notes ${late.length}, voices rendered inside scheduleNote ${rendersInSchedule}, drum peaks after each change ${peaks.map((p) => p.toFixed(3)).join(', ')}`);
      expect(late).toEqual([]);
      expect(rendersInSchedule).toBe(0);
      expect(firstHits).toHaveLength(kits.length);
      for (const h of firstHits) expect(h).not.toBeNull();
      for (const p of peaks) expect(p).toBeGreaterThan(0.01);

      // Each new kit's voices for the slots the groove plays were rendered (in idle time).
      const drums = project.tracks.find((t) => t.id === 't1')!;
      const inst = drums.instrument as DrumsInstrument;
      const kitDecay = readParam(DRUM_KIT_PARAMS, inst.params, 'decay');
      const used = new Set(drums.clips[1]!.notes.map((n) => n.pitch));
      for (const kit of kits) {
        for (const slot of used) {
          const dm = quantizeDrumDecay(kitDecay * (inst.voices[slot]?.decay ?? 1));
          expect(peekDrumVoice(kit, slot, ctx.sampleRate, dm), `${kit} slot ${slot}`).not.toBeNull();
        }
      }
    } finally {
      transport.dispose();
      engine.dispose();
      await ctx.close();
    }
  }, 60_000);

  it('offline (export) a kit change renders in place: the new kit plays from its first hit', async () => {
    // Nothing cached: the new kit's kick has to be rendered during the render, at the change.
    clearDrumVoiceCache();
    const base = HOUSE.build();
    // The drums alone, no mastering: the hits mix linearly.
    const solo: Project = { ...base, mastering: { enabled: false, params: base.mastering?.params ?? {} }, tracks: base.tracks.map((t) => ({ ...t, solo: t.id === 't1' })) };
    const render = async (startKit: string, hits: [time: number, kit: string | null][]): Promise<Float32Array> => {
      const ctx = new OfflineAudioContext(2, 2 * 48000, 48000);
      const engine = await AudioEngine.create(ctx, { samples: new SampleBank(48000), seed: solo.seed, meters: false });
      engine.setProject(withKit(solo, startKit));
      for (const [time, kit] of hits) {
        const at = Math.round((time - 0.2) * 48000 / 128) * 128 / 48000;
        void ctx.suspend(at).then(() => {
          if (kit) engine.setProject(withKit(solo, kit));
          engine.scheduleNote('t1', { pitch: 0, velocity: 0.6, time });
          void ctx.resume();
        });
      }
      const buf = await ctx.startRendering();
      engine.dispose();
      return buf.getChannelData(0).slice();
    };
    const before = drumVoiceCacheStats().renders;
    // The House kit's kick at 0.3 s, then the kit changes to Iron Forge and the kick plays at 1.1 s.
    const changed = await render('round-machine', [
      [0.3, null],
      [1.1, 'iron-forge'],
    ]);
    const rendered = drumVoiceCacheStats().renders - before;
    // References: Iron Forge's kick alone at 1.1 s, and the old kit's kick alone at 1.1 s.
    const fresh = await render('iron-forge', [[1.1, null]]);
    const old = await render('round-machine', [[1.1, null]]);
    const corr = (a: Float32Array, b: Float32Array) => {
      let ab = 0;
      let aa = 0;
      let bb = 0;
      for (let i = Math.round(1.1 * 48000); i < Math.round(1.6 * 48000); i++) {
        ab += a[i] * b[i];
        aa += a[i] * a[i];
        bb += b[i] * b[i];
      }
      return ab / Math.sqrt(aa * bb + 1e-30);
    };
    console.info(`[drumkit] offline change: voices rendered during the render ${rendered}; the hit after the change vs the new kit's kick ${corr(changed, fresh).toFixed(4)}, vs the old kit's ${corr(changed, old).toFixed(4)}`);
    expect(rendered).toBeGreaterThanOrEqual(1);
    // The hit after the change is the new kit's kick (the old one has long decayed by 1.1 s).
    expect(corr(changed, fresh)).toBeGreaterThan(0.99);
    expect(corr(changed, old)).toBeLessThan(0.9);
  });
});
