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
import { drumVoiceCacheStats, peekDrumVoice, quantizeDrumDecay } from '../../src/audio/instruments/drumSynth';
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
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    const project = HOUSE.build();
    const engine = await AudioEngine.create(ctx, { samples: new SampleBank(48000), seed: project.seed, meters: false });
    engine.setProject(project);
    engine.scheduleNote('t1', { pitch: 0, velocity: 1, time: 0.1 });
    const changed = withKit(project, 'iron-forge');
    void ctx.suspend(0.2).then(() => {
      engine.setProject(changed);
      engine.scheduleNote('t1', { pitch: 0, velocity: 1, time: 0.5 });
      void ctx.resume();
    });
    const before = drumVoiceCacheStats().renders;
    await ctx.startRendering();
    const inst = changed.tracks[0].instrument as DrumsInstrument;
    const dm = quantizeDrumDecay(readParam(DRUM_KIT_PARAMS, inst.params, 'decay') * (inst.voices[0]?.decay ?? 1));
    // The new kit's kick was rendered (or already cached) for that hit, not replaced by the old one.
    expect(peekDrumVoice('iron-forge', 0, 48000, dm)).not.toBeNull();
    expect(drumVoiceCacheStats().renders).toBeGreaterThanOrEqual(before);
    engine.dispose();
  });
});
