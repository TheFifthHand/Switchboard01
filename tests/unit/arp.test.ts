import { describe, expect, it } from 'vitest';
import type { ArpSettings, Project } from '../../src/project/types';
import type { SeqEvent } from '../../src/time/contracts';
import { EMPTY_LATCH, arpDivisionTicks, arpGateTicks, arpInput, arpNoteAt, arpPattern, arpSteps, updateLatch } from '../../src/time/arp';
import { Sequencer } from '../../src/time/sequencer';
import { makeProject, notesOf, runTo, sec } from './sequencer-fixtures';
import { DEFAULT_LOOKAHEAD as LOOKAHEAD } from '../../src/time/transport';

const base: ArpSettings = { enabled: true, division: '1/16', mode: 'up', octaves: 1, latch: false, gate: 0.5 };

describe('arp patterns', () => {
  const held = [64, 60, 67]; // played order: E, C, G

  it('orders notes per mode', () => {
    expect(arpPattern(held, { mode: 'up', octaves: 1 })).toEqual([60, 64, 67]);
    expect(arpPattern(held, { mode: 'down', octaves: 1 })).toEqual([67, 64, 60]);
    expect(arpPattern(held, { mode: 'updown', octaves: 1 })).toEqual([60, 64, 67, 64]);
    expect(arpPattern(held, { mode: 'played', octaves: 1 })).toEqual([64, 60, 67]);
  });

  it('spans 1-3 octaves', () => {
    expect(arpPattern(held, { mode: 'up', octaves: 2 })).toEqual([60, 64, 67, 72, 76, 79]);
    expect(arpPattern(held, { mode: 'down', octaves: 2 })).toEqual([79, 76, 72, 67, 64, 60]);
    expect(arpPattern(held, { mode: 'updown', octaves: 2 })).toEqual([60, 64, 67, 72, 76, 79, 76, 72, 67, 64]);
    expect(arpPattern(held, { mode: 'played', octaves: 3 })).toEqual([64, 60, 67, 76, 72, 79, 88, 84, 91]);
    // Out-of-range octave counts are clamped, notes above MIDI 127 dropped.
    expect(arpPattern([120], { mode: 'up', octaves: 5 as 3 })).toEqual([120]);
  });

  it('handles single notes, duplicates and empty input', () => {
    expect(arpPattern([60], { mode: 'updown', octaves: 1 })).toEqual([60]);
    expect(arpPattern([60, 72], { mode: 'updown', octaves: 1 })).toEqual([60, 72]);
    expect(arpPattern([60, 60, 64], { mode: 'played', octaves: 1 })).toEqual([60, 64]);
    expect(arpPattern([], { mode: 'up', octaves: 2 })).toEqual([]);
    expect(arpNoteAt([], base, 3)).toBeNull();
  });

  it('cycles through the pattern step by step', () => {
    const steps = Array.from({ length: 9 }, (_, i) => arpNoteAt(held, { mode: 'updown', octaves: 1 }, i));
    expect(steps).toEqual([60, 64, 67, 64, 60, 64, 67, 64, 60]);
  });

  it('maps divisions to grid lengths and gate to note length', () => {
    expect(['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'].map((d) => arpDivisionTicks(d as ArpSettings['division']))).toEqual([96, 48, 32, 24, 16, 12]);
    expect(arpGateTicks({ division: '1/16', gate: 0.5 })).toBe(12);
    expect(arpGateTicks({ division: '1/4', gate: 1 })).toBe(96);
    expect(arpGateTicks({ division: '1/8', gate: 0 })).toBeCloseTo(4.8, 12); // gate floor 0.1
  });

  it('places steps on the division grid from the origin', () => {
    const steps = arpSteps([60, 64], { ...base, division: '1/8T' }, 32, 0, 192);
    expect(steps.map((s) => [s.tick, s.step, s.pitch])).toEqual([
      [32, 0, 60],
      [64, 1, 64],
      [96, 2, 60],
      [128, 3, 64],
      [160, 4, 60],
    ]);
    expect(steps[0].durationTicks).toBe(16);
  });
});

describe('arp latch', () => {
  it('keeps the latched set after release until a new press after a full release', () => {
    let s = updateLatch(EMPTY_LATCH, [60]);
    expect(s).toEqual({ held: [60], latched: [60] });
    s = updateLatch(s, [60, 64]);
    expect(s.latched).toEqual([60, 64]);
    s = updateLatch(s, [64]); // one key lifted while another is down: still one gesture
    expect(s).toEqual({ held: [64], latched: [60, 64] });
    s = updateLatch(s, [64, 67]);
    expect(s.latched).toEqual([60, 64, 67]);
    s = updateLatch(s, []);
    expect(s).toEqual({ held: [], latched: [60, 64, 67] });
    expect(arpInput(s, true)).toEqual([60, 64, 67]);
    expect(arpInput(s, false)).toEqual([]);
    s = updateLatch(s, [72]); // new press after a full release replaces the set
    expect(s).toEqual({ held: [72], latched: [72] });
  });
});

function arpProject(arp: Partial<ArpSettings>): Project {
  const p = makeProject(120);
  // t5 = lead (poly synth)
  p.tracks[4].arp = { ...base, ...arp };
  return p;
}

describe('Sequencer arpeggiator', () => {
  it('plays the held notes on the transport grid in mode order with the gate length', () => {
    const p = arpProject({ mode: 'up', division: '1/16', gate: 0.5 });
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0);
    seq.setArpHeld('t5', [64, 60], 0);
    const notes = notesOf(seq.process(1), 't5');
    expect(notes.map((n) => [n.tick, n.pitch])).toEqual(Array.from({ length: 8 }, (_, i) => [i * 24, i % 2 ? 64 : 60]));
    for (const n of notes) {
      expect(n.source).toBe('arp');
      expect(n.durationTicks).toBe(12);
      expect(n.time).toBeCloseTo(sec(n.tick), 9);
      expect(n.duration).toBeCloseTo(sec(12), 9);
    }
  });

  it('follows division, octaves and down / as-played modes', () => {
    const cases: [Partial<ArpSettings>, number, number[]][] = [
      [{ division: '1/8T', mode: 'up', octaves: 2 }, 32, [60, 64, 72, 76, 60, 64]],
      [{ division: '1/4', mode: 'down', octaves: 1 }, 96, [67, 64, 60, 67]],
      [{ division: '1/32', mode: 'played', octaves: 1 }, 12, [67, 60, 64, 67, 60, 64]],
      [{ division: '1/8', mode: 'updown', octaves: 1 }, 48, [60, 64, 67, 64, 60, 64]],
    ];
    for (const [arp, grid, pitches] of cases) {
      const p = arpProject(arp);
      const seq = new Sequencer({ getProject: () => p });
      seq.start(0);
      seq.setArpHeld('t5', arp.mode === 'up' ? [60, 64] : [67, 60, 64], 0);
      const notes = notesOf(seq.process(sec(grid * pitches.length) - 1e-6), 't5');
      expect(notes.map((n) => n.pitch)).toEqual(pitches);
      expect(notes.map((n) => n.tick)).toEqual(pitches.map((_, i) => i * grid));
    }
  });

  it('starts a new press on the next grid step, swung like the clips', () => {
    const p = arpProject({ division: '1/16' });
    p.swing = 1;
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0);
    seq.process(0.1);
    seq.setArpHeld('t5', [60, 67], sec(30)); // between steps 1 and 2
    const notes = notesOf(seq.process(0.5), 't5');
    expect(notes.map((n) => [n.tick, n.pitch])).toEqual([
      [48, 60],
      [72, 67],
    ]);
    expect(notes[1].time).toBeCloseTo(sec(72 + 8), 9);
  });

  it('stops after release unless latched; Stop releases a latched arpeggio', () => {
    const p = arpProject({ division: '1/8', latch: false });
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0);
    seq.setArpHeld('t5', [60], 0);
    seq.process(0.4);
    seq.setArpHeld('t5', [], 0.4);
    expect(notesOf(seq.process(2), 't5')).toHaveLength(0);

    const q = arpProject({ division: '1/8', latch: true });
    const s2 = new Sequencer({ getProject: () => q });
    s2.start(0);
    s2.setArpHeld('t5', [60, 64], 0);
    s2.process(0.4);
    s2.setArpHeld('t5', [], 0.4);
    // The latched arp keeps its step count: steps 2..7 on the 8th-note grid.
    const later = notesOf(s2.process(2), 't5');
    expect(later.map((n) => [n.tick, n.pitch])).toEqual([
      [96, 60],
      [144, 64],
      [192, 60],
      [240, 64],
      [288, 60],
      [336, 64],
    ]);
    s2.stop(2);
    expect(notesOf(s2.process(4), 't5')).toHaveLength(0);
    expect(s2.idleActive).toBe(false);
  });

  it('runs on a free clock anchored at the first press while the transport is stopped', () => {
    const p = arpProject({ division: '1/16', mode: 'up' });
    const seq = new Sequencer({ getProject: () => p });
    seq.setArpHeld('t5', [62, 65], 5.01);
    expect(seq.idleActive).toBe(true);
    const events = runTo(seq, 5, 5.5);
    const notes = notesOf(events, 't5');
    expect(notes.map((n) => n.pitch)).toEqual([62, 65, 62, 65]);
    notes.forEach((n, i) => expect(n.time).toBeCloseTo(5.01 + sec(24 * i), 9));
    // Releasing the keys ends it and retires the idle clock.
    seq.setArpHeld('t5', [], 5.5);
    expect(notesOf(runTo(seq, 5.5, 6), 't5')).toHaveLength(0);
    expect(seq.idleActive).toBe(false);
  });

  it('changes input inside the generated window: every grid step exactly once, the new notes from the change on', () => {
    const p = arpProject({ division: '1/16', mode: 'up', gate: 0.5 });
    p.swing = 0.5;
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0);
    seq.setArpHeld('t5', [60], 0);
    const kept: SeqEvent[] = [];
    let generated = seq.process(LOOKAHEAD);
    // Each key change lands 10 ms ahead of "now", inside the look-ahead already generated (as the transport does it).
    const changes: [number, number[]][] = [
      [0.31, [60, 67]],
      [0.64, [60, 64, 67]],
      [0.9, [64]],
    ];
    let now = 0;
    for (const [at, held] of changes) {
      for (; now + 0.025 < at - 0.01; now += 0.025) generated.push(...seq.process(now + 0.025 + LOOKAHEAD));
      seq.setArpHeld('t5', held, at);
      seq.invalidate(at);
      kept.push(...generated.filter((e) => e.time < at));
      generated = [];
    }
    for (; now < 1.5; now += 0.025) generated.push(...seq.process(now + 0.025 + LOOKAHEAD));
    kept.push(...generated);
    const notes = notesOf(kept, 't5').filter((n) => n.time < 1.5);
    // One note per 16th, no gaps or doubles across the rewinds.
    expect(notes.map((n) => n.tick)).toEqual(notes.map((_, i) => i * 24));
    const heldAt = (time: number): number[] => [...changes].reverse().find(([at]) => at <= time)?.[1] ?? [60];
    for (const n of notes) {
      // Swung like the clips; the pitch always comes from the keys held at that step.
      expect(n.time).toBeCloseTo(sec(n.tick + (n.tick % 48 === 24 ? 4 : 0)), 9);
      expect(heldAt(sec(n.tick))).toContain(n.pitch);
    }
  });

  it('ignores held notes when the track arp is off', () => {
    const p = arpProject({ enabled: false });
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0);
    seq.setArpHeld('t5', [60], 0);
    expect(notesOf(seq.process(1))).toHaveLength(0);
  });

  it('letting go of one key keeps the velocity the pattern was played with', () => {
    const p = arpProject({ division: '1/16' });
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0);
    seq.setArpHeld('t5', [60, 64], 0, 0.3);
    seq.process(0.2);
    seq.setArpHeld('t5', [64], 0.2); // a release: no velocity of its own
    const later = notesOf(seq.process(0.6), 't5');
    expect(later.length).toBeGreaterThan(2);
    expect(later.every((n) => n.pitch === 64 && n.velocity === 0.3)).toBe(true);
    expect(seq.getArpInput('t5')).toEqual({ held: [64], latched: [64], velocity: 0.3 });
  });

  it('Latch keeps notes only while it is on: switching Latch on later brings back nothing', () => {
    const p = arpProject({ division: '1/8', latch: false });
    let project = p;
    const seq = new Sequencer({ getProject: () => project });
    seq.start(0);
    seq.setArpHeld('t5', [60, 64], 0);
    seq.process(0.4);
    seq.setArpHeld('t5', [], 0.4);
    expect(seq.getArpInput('t5')).toMatchObject({ held: [], latched: [] });
    project = { ...p, tracks: p.tracks.map((t) => (t.id === 't5' ? { ...t, arp: { ...t.arp, latch: true } } : t)) };
    seq.invalidate(0.4);
    expect(notesOf(seq.process(2), 't5')).toHaveLength(0);
  });

  it('clearArpLatch ends a latched pattern (the arp or its Latch was switched off); keys still held play on', () => {
    const p = arpProject({ division: '1/8', latch: true });
    const seq = new Sequencer({ getProject: () => p });
    seq.start(0);
    seq.setArpHeld('t5', [60, 64], 0);
    seq.process(0.4);
    seq.setArpHeld('t5', [], 0.4);
    expect(notesOf(seq.process(0.8), 't5').length).toBeGreaterThan(0); // latched: still playing
    expect(seq.clearArpLatch('t5', 0.8)).toBe(true);
    seq.invalidate(0.8);
    expect(notesOf(seq.process(2), 't5')).toHaveLength(0);
    expect(seq.clearArpLatch('t5', 2)).toBe(false); // nothing left to drop

    seq.setArpHeld('t5', [67], 2);
    seq.setArpHeld('t5', [67, 72], 2.1);
    seq.setArpHeld('t5', [72], 2.2);
    expect(seq.getArpInput('t5')).toMatchObject({ held: [72], latched: [67, 72] });
    expect(seq.clearArpLatch('t5', 2.2)).toBe(true);
    seq.invalidate(2.2);
    const held = notesOf(seq.process(3), 't5').filter((n) => n.time >= 2.2);
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((n) => n.pitch === 72)).toBe(true);
  });
});
