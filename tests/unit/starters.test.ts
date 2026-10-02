import { describe, expect, it } from 'vitest';
import { BUILTIN_DURATIONS } from '../../src/audio/instruments/builtinSamples';
import { BUILTIN_SAMPLES, KITS, SYNTH_PRESETS } from '../../src/content/catalog';
import { clip, drums, line, midi, parseGrid, seq, stabs, strum } from '../../src/content/starters/dsl';
import { BLANK_STARTER, JUMP_IN_SCENE_ROW, JUMP_IN_STARTER_ID, STARTERS, getStarter } from '../../src/content/starters/index';
import { ROLE_DEFAULT_SOUND, moduleId } from '../../src/project/factory';
import { MACRO_IDS, TICKS_PER_BAR, TICKS_PER_BEAT, TICKS_PER_STEP, type Clip, type Project, type ScaleId, type Track, type TrackRole } from '../../src/project/types';
import { validateProject } from '../../src/project/validate';
import type { SeqEvent } from '../../src/time/contracts';
import { Sequencer } from '../../src/time/sequencer';

/* Independent reference data (deliberately not imported from the code under test). */

const SCALE_STEPS: Record<ScaleId, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

const KEY_PC: Record<string, number> = { C: 0, 'C#': 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };

/** Product brief section 5, in order. */
const BRIEF = [
  { id: 'house', name: 'House', bpm: 124 },
  { id: 'synthwave', name: 'Synthwave', bpm: 100 },
  { id: 'ambient', name: 'Ambient', bpm: 72 },
  { id: 'techno', name: 'Techno', bpm: 128 },
  { id: 'breakbeat', name: 'Breakbeat', bpm: 132 },
  { id: 'drumAndBass', name: 'Drum and Bass', bpm: 174 },
  { id: 'downtempo', name: 'Downtempo', bpm: 84 },
  { id: 'garage', name: 'Garage', bpm: 136 },
] as const;

/** Playable ranges per role (MIDI), from the starter content brief. */
const RANGES: Partial<Record<TrackRole, readonly [number, number]>> = {
  bass: [28, 52],
  chords: [48, 76],
  lead: [60, 88],
  pad: [45, 76],
};

/**
 * Pitch classes a sampler note produces relative to its note, from the built-in
 * sample designs: the glass chord is a minor-seventh chord, the tape swell open
 * fifths, the bell a prime with minor-third and fifth partials.
 */
const SAMPLE_PITCH_CLASSES: Record<string, readonly number[]> = {
  'builtin:glass-chord': [0, 3, 7, 10],
  'builtin:tape-swell': [0, 7],
  'builtin:bell-hit': [0, 3, 7],
  'builtin:vocal-oh': [0],
};

const INTRO = 0;
const GROOVE = 1;
const LIFT = 2;
const BREAK = 3;

/* Helpers */

const byRole = (p: Project, role: TrackRole): Track => {
  const t = p.tracks.find((x) => x.role === role);
  if (!t) throw new Error(`no ${role} track`);
  return t;
};

const rolesInRow = (p: Project, row: number): TrackRole[] => p.tracks.filter((t) => t.clips[row]).map((t) => t.role);

const noteContent = (t: Track, row: number) => t.clips[row]?.notes.map(({ id: _id, ...n }) => n) ?? null;

/** What a scene row sounds like, independent of ids. */
const rowSignature = (p: Project, row: number): string =>
  JSON.stringify(p.tracks.map((t) => (t.clips[row] ? { role: t.role, bars: t.clips[row]!.bars, notes: noteContent(t, row) } : null)));

/** The project with every random id and timestamp removed; ids that link things are replaced by indices. */
function musicalContent(p: Project) {
  const sceneIndex = new Map(p.scenes.map((s, i) => [s.id, i]));
  return {
    name: p.name,
    starterId: p.starterId,
    bpm: p.bpm,
    swing: p.swing,
    root: p.root,
    scale: p.scale,
    assist: p.assist,
    masterVolumeDb: p.masterVolumeDb,
    seed: p.seed,
    settings: p.settings,
    scenes: p.scenes.map((s) => s.name),
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => (c ? { name: c.name, bars: c.bars, notes: c.notes.map(({ id: _id, ...n }) => n) } : null)),
    })),
    patch: { modules: p.patch.modules, connections: p.patch.connections.map(({ id: _id, ...c }) => c) },
    arrangement: { blocks: p.arrangement.blocks.map((b) => ({ scene: sceneIndex.get(b.sceneId), repeats: b.repeats })), tailSeconds: p.arrangement.tailSeconds },
  };
}

/** Pitches of a clip sounding at `tick`, with the clip looping from `startTick`. */
const soundingAt = (c: Clip, tick: number, startTick = 0, minDuration = 0): number[] => {
  const length = c.bars * TICKS_PER_BAR;
  const local = (((tick - startTick) % length) + length) % length;
  return c.notes.filter((n) => n.duration >= minDuration && n.tick <= local && local < n.tick + n.duration).map((n) => n.pitch);
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number) => (a * b) / gcd(a, b);

/**
 * Share of the time the bass sounds during which the other part sounds a
 * minor ninth above a bass note — the harshest clash a bass can make with a
 * chord or melody. Sampled per 16th over a full cycle of both loops, with the
 * bass clip starting `bassOffsetBars` bars after the other clip (a clip tapped
 * during playback joins on the next bar line, so it can start on any bar of
 * the other part's loop).
 */
function minorNinthShare(bass: Clip, upper: Clip, pitchClasses: readonly number[] = [0], bassOffsetBars = 0): number {
  const cycle = lcm(bass.bars, upper.bars);
  const bars = cycle * Math.ceil(16 / cycle);
  let bassSteps = 0;
  let clashSteps = 0;
  for (let step = 0; step < bars * 16; step++) {
    const tick = step * TICKS_PER_STEP;
    const low = soundingAt(bass, tick, bassOffsetBars * TICKS_PER_BAR);
    if (low.length === 0) continue;
    bassSteps++;
    const high = soundingAt(upper, tick);
    if (low.some((b) => high.some((u) => pitchClasses.some((pc) => (((u + pc - b) % 12) + 12) % 12 === 1)))) clashSteps++;
  }
  return bassSteps ? clashSteps / bassSteps : 0;
}

/** Ordered semitone rubs (lower pitch class > upper pitch class) where `hi` sits a minor second or minor ninth above `lo`. */
const rubs = (lo: readonly number[], hi: readonly number[]): string[] => {
  const out: string[] = [];
  for (const x of lo) for (const y of hi) if (y > x && (y - x) % 12 === 1) out.push(`${x % 12}>${y % 12}`);
  return out;
};

/** Parts that carry the harmony; a line (bass, lead) may pass through a semitone briefly, a chord may not. */
const HARMONY_ROLES: ReadonlySet<TrackRole> = new Set(['chords', 'pad', 'texture', 'sampler']);

/**
 * Share of a scene (sampled per 16th while both parts sound) in which layering
 * two parts creates a minor second or minor ninth that neither part voices by
 * itself. A part's own close voicing (a minor-ninth chord with its ninth under
 * the third) is a deliberate colour; the same rub arising between two
 * instruments is an accident. Between harmony parts every note counts (a stab
 * repeatedly striking a semitone against a held pad is heard); when a bass or
 * lead line is involved only notes held for three steps or more count, so
 * short passing tones are allowed.
 */
function layeredRubShare(a: Track, b: Track, row: number): number {
  const pa = trackPitchClasses(a);
  const pb = trackPitchClasses(b);
  const ca = a.clips[row];
  const cb = b.clips[row];
  if (!pa || !pb || !ca || !cb) return 0;
  const minDuration = HARMONY_ROLES.has(a.role) && HARMONY_ROLES.has(b.role) ? 0 : 3 * TICKS_PER_STEP;
  const held = (c: Clip, pcs: readonly number[], tick: number) => soundingAt(c, tick, 0, minDuration).flatMap((p) => pcs.map((o) => p + o));
  let both = 0;
  let rubbing = 0;
  for (let step = 0; step < lcm(ca.bars, cb.bars) * 16; step++) {
    const tick = step * TICKS_PER_STEP;
    const na = held(ca, pa, tick);
    const nb = held(cb, pb, tick);
    if (!na.length || !nb.length) continue;
    both++;
    const own = new Set([...rubs(na, na), ...rubs(nb, nb)]);
    if ([...rubs(na, nb), ...rubs(nb, na)].some((r) => !own.has(r))) rubbing++;
  }
  return both ? rubbing / both : 0;
}

/** Pitch classes each note of a melodic track produces (null for unpitched parts). */
function trackPitchClasses(t: Track): readonly number[] | null {
  if (t.instrument.kind === 'drums') return null;
  if (t.instrument.kind === 'sampler') return SAMPLE_PITCH_CLASSES[t.instrument.sampleId ?? ''] ?? null;
  return [0];
}

const channelParam = (p: Project, trackId: string, param: string): number => {
  const ch = p.patch.modules.find((m) => m.id === moduleId.channel(trackId));
  if (!ch) throw new Error('missing channel');
  return ch.params[param];
};

/* Tests */

describe('starter list', () => {
  it('ships the eight starters of the brief, in order, with their tempos', () => {
    expect(STARTERS.map((s) => ({ id: s.id, name: s.name, bpm: s.bpm }))).toEqual(BRIEF.map((b) => ({ ...b })));
    for (const s of STARTERS) {
      expect(s.description.length).toBeGreaterThan(20);
      expect(s.description.endsWith('.')).toBe(true);
    }
  });

  it('Jump In loads House and launches its Groove row', () => {
    expect(JUMP_IN_STARTER_ID).toBe('house');
    expect(JUMP_IN_SCENE_ROW).toBe(1);
    expect(getStarter(JUMP_IN_STARTER_ID)).toBe(STARTERS[0]);
  });

  it('looks starters up by id, including the blank project', () => {
    for (const s of STARTERS) expect(getStarter(s.id)).toBe(s);
    expect(getStarter('blank')).toBe(BLANK_STARTER);
    expect(getStarter('polka')).toBeUndefined();
  });

  it('varies keys across starters', () => {
    const roots = new Set(STARTERS.map((s) => s.build().root));
    expect(roots.size).toBeGreaterThanOrEqual(6);
  });
});

describe.each(STARTERS.map((s) => [s.name, s] as const))('%s starter', (_name, starter) => {
  const project = starter.build();

  it('builds a complete, valid 8-part project', () => {
    expect(project.tracks).toHaveLength(8);
    expect(project.scenes).toHaveLength(4);
    expect(project.name).toBe(`${starter.name} Starter`);
    expect(project.starterId).toBe(starter.id);
    expect(project.bpm).toBe(starter.bpm);
    for (const s of project.scenes) expect(s.name.trim().length).toBeGreaterThan(0);
    expect(new Set(project.scenes.map((s) => s.name)).size).toBe(4);
    // The project validator repairs anything out of range; a starter must need no repair at all.
    const result = validateProject(JSON.parse(JSON.stringify(project)));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([]);
      expect(result.project).toEqual(project);
    }
  });

  it('states its key as the project root and scale', () => {
    const [tonic, ...rest] = starter.key.split(' ');
    expect(KEY_PC[tonic]).toBe(project.root);
    expect(rest.join(' ').replace(' ', '').toLowerCase()).toBe(project.scale.toLowerCase());
  });

  it('assigns catalogue sounds that suit each part', () => {
    for (const t of project.tracks) {
      const inst = t.instrument;
      if (t.role === 'drums' || t.role === 'percussion') {
        expect(inst.kind).toBe('drums');
        if (inst.kind === 'drums') expect(KITS.map((k) => k.id)).toContain(inst.kitId);
      } else if (t.role === 'sampler') {
        expect(inst.kind).toBe('sampler');
        if (inst.kind === 'sampler') expect(BUILTIN_SAMPLES.map((b) => b.id)).toContain(inst.sampleId);
      } else {
        expect(inst.kind === 'bass' || inst.kind === 'poly').toBe(true);
        if (inst.kind === 'bass' || inst.kind === 'poly') {
          const preset = SYNTH_PRESETS.find((p) => p.id === inst.presetId);
          expect(preset, `${t.role} preset`).toBeDefined();
          expect(preset!.kind).toBe(inst.kind);
        }
      }
    }
    expect(byRole(project, 'drums').instrument).not.toEqual(byRole(project, 'percussion').instrument);
  });

  it('keeps every clip 1 to 4 bars with its notes inside', () => {
    for (const t of project.tracks) {
      for (const c of t.clips) {
        if (!c) continue;
        expect([1, 2, 3, 4]).toContain(c.bars);
        expect(c.notes.length).toBeGreaterThan(0);
        const length = c.bars * TICKS_PER_BAR;
        for (const n of c.notes) {
          expect(n.tick).toBeGreaterThanOrEqual(0);
          expect(n.tick + n.duration).toBeLessThanOrEqual(length);
          expect(n.duration).toBeGreaterThan(0);
          expect(n.velocity).toBeGreaterThan(0);
          expect(n.velocity).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('plays each sampler note as the part’s mode means it: a Loop part’s notes never outlast one pass', () => {
    // Loop parts are the gated ones (chops, stabs): a note lasts as long as it is held, and no
    // note may be held past the end of the pitched region, or it would start repeating.
    for (const t of project.tracks) {
      const inst = t.instrument;
      if (inst.kind !== 'sampler' || !inst.sampleId || inst.params.mode !== 1) continue;
      const p = inst.params;
      const region = BUILTIN_DURATIONS[inst.sampleId] * Math.abs((p.end ?? 1) - (p.start ?? 0));
      for (const c of t.clips) {
        for (const n of c?.notes ?? []) {
          const rate = Math.pow(2, (n.pitch - (p.rootNote ?? 60) + (p.pitch ?? 0) + (p.fine ?? 0) / 100) / 12);
          const held = (n.duration / TICKS_PER_BEAT) * (60 / project.bpm);
          expect(held, `${t.name} ${c!.name} note ${n.pitch}`).toBeLessThan(region / rate);
        }
      }
    }
  });

  it('keeps melodic notes in the project scale and in each part’s range', () => {
    const allowed = new Set(SCALE_STEPS[project.scale].map((s) => (s + project.root) % 12));
    for (const t of project.tracks) {
      if (t.instrument.kind === 'drums') {
        for (const c of t.clips) for (const n of c?.notes ?? []) expect(n.pitch >= 0 && n.pitch <= 15).toBe(true);
        continue;
      }
      const range = RANGES[t.role];
      for (const c of t.clips) {
        for (const n of c?.notes ?? []) {
          expect(allowed.has(n.pitch % 12), `${t.role} "${c!.name}" pitch ${n.pitch}`).toBe(true);
          if (range) {
            expect(n.pitch, `${t.role} "${c!.name}" pitch ${n.pitch}`).toBeGreaterThanOrEqual(range[0]);
            expect(n.pitch, `${t.role} "${c!.name}" pitch ${n.pitch}`).toBeLessThanOrEqual(range[1]);
          }
        }
      }
    }
  });

  it('has four distinct scenes that each play at least two parts', () => {
    const signatures = new Set<string>();
    for (let row = 0; row < 4; row++) {
      expect(rolesInRow(project, row).length, `row ${row}`).toBeGreaterThanOrEqual(2);
      signatures.add(rowSignature(project, row));
    }
    expect(signatures.size).toBe(4);
  });

  it('shapes its scenes: sparse intro, groove core, lift with a new bass and chord, break without drums', () => {
    const drumsTrack = byRole(project, 'drums');
    // Intro: no bass and no kick drum.
    expect(byRole(project, 'bass').clips[INTRO]).toBeNull();
    for (const n of drumsTrack.clips[INTRO]?.notes ?? []) expect(n.pitch).not.toBe(0);
    // Groove: drums and bass carry the loop.
    expect(rolesInRow(project, GROOVE)).toEqual(expect.arrayContaining(['drums', 'bass', 'chords']));
    // Lift: adds the lead and swaps in different bass and chord clips.
    expect(rolesInRow(project, LIFT)).toContain('lead');
    for (const role of ['bass', 'chords'] as const) {
      const t = byRole(project, role);
      expect(t.clips[LIFT]).not.toBeNull();
      expect(noteContent(t, LIFT)).not.toEqual(noteContent(t, GROOVE));
    }
    // Break: strips the drums and features pad and chords.
    expect(drumsTrack.clips[BREAK]).toBeNull();
    expect(rolesInRow(project, BREAK)).toEqual(expect.arrayContaining(['pad', 'chords']));
  });

  it('keeps each scene free of sustained clashes against its bass', () => {
    const bass = byRole(project, 'bass');
    for (let row = 0; row < 4; row++) {
      const low = bass.clips[row];
      if (!low) continue;
      for (const t of project.tracks) {
        const pcs = trackPitchClasses(t);
        const upper = t.clips[row];
        if (t === bass || !pcs || !upper) continue;
        expect(minorNinthShare(low, upper, pcs), `row ${row} ${t.role} "${upper.name}" over "${low.name}"`).toBeLessThanOrEqual(0.05);
      }
    }
  });

  it('lets any bass clip join under any chord or pad clip on any bar (tapping a variation stays musical)', () => {
    const bass = byRole(project, 'bass');
    for (const role of ['chords', 'pad'] as const) {
      for (const low of bass.clips) {
        for (const upper of byRole(project, role).clips) {
          if (!low || !upper) continue;
          // A tapped clip starts on the next bar line, so every whole-bar phase between the loops happens.
          for (let offset = 0; offset < lcm(low.bars, upper.bars); offset++) {
            expect(minorNinthShare(low, upper, [0], offset), `${role} "${upper.name}" over "${low.name}" joining ${offset} bar(s) in`).toBeLessThanOrEqual(0.05);
          }
        }
      }
    }
  });

  it('layers the parts of each scene without semitone rubs between them', () => {
    for (let row = 0; row < 4; row++) {
      const parts = project.tracks.filter((t) => t.clips[row] && trackPitchClasses(t));
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          const [a, b] = [parts[i], parts[j]];
          expect(layeredRubShare(a, b, row), `${project.scenes[row].name}: ${a.role} "${a.clips[row]!.name}" with ${b.role} "${b.clips[row]!.name}"`).toBeLessThanOrEqual(0.05);
        }
      }
    }
  });

  it('fills enough slots that every part has alternatives to tap', () => {
    for (const t of project.tracks) {
      const filled = t.clips.filter(Boolean).length;
      const min = t.role === 'texture' || t.role === 'sampler' ? 1 : t.role === 'bass' || t.role === 'chords' ? 3 : 2;
      expect(filled, `${t.role}`).toBeGreaterThanOrEqual(min);
    }
  });

  it('opens with the master at 0 dB and every fader in -24..+6 dB, with the percussion fader under the drums', () => {
    // The starter's overall level sits on the faders (MIX-12), so the master has room above it.
    expect(project.masterVolumeDb).toBe(0);
    for (const t of project.tracks) {
      const level = channelParam(project, t.id, 'level');
      expect(level, t.role).toBeGreaterThanOrEqual(-24);
      expect(level, t.role).toBeLessThanOrEqual(6);
    }
    const level = (role: TrackRole) => channelParam(project, byRole(project, role).id, 'level');
    expect(level('percussion')).toBeLessThan(level('drums'));
    // The drums are the reference the others are balanced against: their fader sits near unity.
    expect(level('drums')).toBeGreaterThanOrEqual(-6);
  });

  it('sets musical macro positions: ambience on the pad, echo on a melodic part', () => {
    const pad = byRole(project, 'pad');
    expect(pad.macros.space).toBeGreaterThanOrEqual(0.4);
    const echo = Math.max(byRole(project, 'lead').macros.echo, byRole(project, 'chords').macros.echo);
    expect(echo).toBeGreaterThan(0.1);
    for (const t of project.tracks) for (const m of MACRO_IDS) expect(t.macros[m]).toBeGreaterThanOrEqual(0);
    // The low end stays dry.
    expect(byRole(project, 'bass').macros.space).toBeLessThanOrEqual(0.05);
  });

  it('arranges a song from its scenes', () => {
    const { blocks, tailSeconds } = project.arrangement;
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    const sceneIds = new Set(project.scenes.map((s) => s.id));
    for (const b of blocks) {
      expect(sceneIds.has(b.sceneId)).toBe(true);
      expect(b.repeats).toBeGreaterThanOrEqual(1);
      expect(b.repeats).toBeLessThanOrEqual(8);
    }
    // Every scene is used, and the song starts with the intro.
    expect(new Set(blocks.map((b) => b.sceneId)).size).toBe(4);
    expect(blocks[0].sceneId).toBe(project.scenes[INTRO].id);
    expect(tailSeconds).toBeGreaterThanOrEqual(3);
    expect(tailSeconds).toBeLessThanOrEqual(5);
    // A song of roughly one to four minutes.
    const sceneBars = (row: number) => Math.max(...project.tracks.map((t) => t.clips[row]?.bars ?? 0));
    const bars = blocks.reduce((sum, b) => sum + sceneBars(project.scenes.findIndex((s) => s.id === b.sceneId)) * b.repeats, 0);
    const seconds = (bars * 4 * 60) / project.bpm;
    expect(seconds).toBeGreaterThan(60);
    expect(seconds).toBeLessThan(240);
  });

  it('builds the same music every time, with fresh ids', () => {
    const again = starter.build();
    expect(musicalContent(again)).toEqual(musicalContent(project));
    expect(again.id).not.toBe(project.id);
    expect(again.tracks[0].clips.find(Boolean)!.id).not.toBe(project.tracks[0].clips.find(Boolean)!.id);
  });

  it('survives a JSON round trip unchanged', () => {
    expect(JSON.parse(JSON.stringify(project))).toEqual(project);
  });
});

describe('House (the Jump In groove)', () => {
  const house = getStarter('house')!.build();

  it('plays drums, percussion, bass and chords in the Groove row, and nothing else', () => {
    expect(rolesInRow(house, JUMP_IN_SCENE_ROW).sort()).toEqual(['bass', 'chords', 'drums', 'percussion']);
  });

  it('has a solid four-on-the-floor kick in the Groove', () => {
    const groove = byRole(house, 'drums').clips[JUMP_IN_SCENE_ROW]!;
    const kicks = groove.notes.filter((n) => n.pitch === 0).map((n) => n.tick);
    const beats = Array.from({ length: groove.bars * 4 }, (_, i) => i * TICKS_PER_BEAT);
    expect(kicks).toEqual(beats);
    for (const n of groove.notes.filter((x) => x.pitch === 0)) expect(n.velocity).toBeGreaterThanOrEqual(0.9);
  });

  it('pumps its chords and pad with the beat', () => {
    expect(byRole(house, 'chords').macros.pump).toBeGreaterThan(0.2);
    expect(byRole(house, 'pad').macros.pump).toBeGreaterThan(0.2);
  });
});

describe('House played by the sequencer (the Jump In journey)', () => {
  const house = getStarter(JUMP_IN_STARTER_ID)!.build();
  const roleOf = (trackId: string) => house.tracks.find((t) => t.id === trackId)!.role;
  const beat = 60 / house.bpm;
  const start = () => {
    const seq = new Sequencer({ getProject: () => house });
    seq.start(0, {
      launcher: house.tracks.map((t) => ({ trackId: t.id, playing: t.clips[JUMP_IN_SCENE_ROW] ? { slot: JUMP_IN_SCENE_ROW, startTick: 0 } : null })),
    });
    return seq;
  };
  const notes = (events: SeqEvent[]) => events.filter((e): e is Extract<SeqEvent, { kind: 'note' }> => e.kind === 'note');

  it('sounds drums, percussion, bass and chords from the first bar, with a kick on every beat', () => {
    const seq = start();
    const events = notes(seq.process(beat * 16 - 0.001));
    expect([...new Set(events.map((e) => roleOf(e.trackId)))].sort()).toEqual(['bass', 'chords', 'drums', 'percussion']);
    // Every part is heard within the first bar.
    const firstBar = events.filter((e) => e.time < beat * 4);
    expect(new Set(firstBar.map((e) => roleOf(e.trackId))).size).toBe(4);
    const kicks = events.filter((e) => roleOf(e.trackId) === 'drums' && e.pitch === 0).map((e) => e.time);
    expect(kicks).toHaveLength(16);
    kicks.forEach((t, i) => expect(t).toBeCloseTo(i * beat, 6));
  });

  it('switches to the Lift together on the next bar line, bringing in the lead', () => {
    const seq = start();
    seq.process(beat * 5.5);
    // Tap the Lift scene halfway through bar two.
    seq.launchScene(LIFT, beat * 5.5);
    const events = notes(seq.process(beat * 16));
    const barThree = beat * 8;
    const lead = events.filter((e) => roleOf(e.trackId) === 'lead');
    expect(lead.length).toBeGreaterThan(0);
    expect(Math.min(...lead.map((e) => e.time))).toBeCloseTo(barThree, 6);
    // From bar three on, bass and chords play their Lift clips.
    for (const role of ['bass', 'chords'] as const) {
      const liftClip = byRole(house, role).clips[LIFT]!;
      const after = events.filter((e) => roleOf(e.trackId) === role && e.time >= barThree - 1e-9);
      expect(after.length).toBeGreaterThan(0);
      for (const e of after) expect(e.clipId).toBe(liftClip.id);
    }
  });
});

describe('genre character', () => {
  it('shuffles Garage with swing between 0.35 and 0.55', () => {
    const g = getStarter('garage')!.build();
    expect(g.swing).toBeGreaterThanOrEqual(0.35);
    expect(g.swing).toBeLessThanOrEqual(0.55);
  });

  it('uses Pump on pads or chords in House, Techno and Garage', () => {
    for (const id of ['house', 'techno', 'garage']) {
      const p = getStarter(id)!.build();
      expect(Math.max(byRole(p, 'pad').macros.pump, byRole(p, 'chords').macros.pump), id).toBeGreaterThan(0.2);
    }
  });

  it('keeps Drum and Bass restrained: long chords and a slow-moving sub', () => {
    const p = getStarter('drumAndBass')!.build();
    const groove = byRole(p, 'chords').clips[GROOVE]!;
    const shortest = Math.min(...groove.notes.map((n) => n.duration));
    expect(shortest).toBeGreaterThanOrEqual(3 * TICKS_PER_STEP);
    const bassNotesPerBar = byRole(p, 'bass').clips[GROOVE]!.notes.length / byRole(p, 'bass').clips[GROOVE]!.bars;
    expect(bassNotesPerBar).toBeLessThanOrEqual(3);
  });
});

describe('Blank project', () => {
  const blank = BLANK_STARTER.build();

  it('is an empty 120 BPM C minor project with default sounds', () => {
    expect(blank.name).toBe('Blank project');
    expect(blank.masterVolumeDb).toBe(0);
    expect(blank.starterId).toBe('blank');
    expect(blank.bpm).toBe(120);
    expect(blank.root).toBe(0);
    expect(blank.scale).toBe('minor');
    expect(blank.tracks).toHaveLength(8);
    for (const t of blank.tracks) {
      expect(t.clips.every((c) => c === null)).toBe(true);
      const inst = t.instrument;
      const sound = inst.kind === 'drums' ? inst.kitId : inst.kind === 'sampler' ? inst.sampleId : inst.presetId;
      expect(sound).toBe(ROLE_DEFAULT_SOUND[t.role]);
    }
    expect(blank.arrangement.blocks).toEqual([]);
    const result = validateProject(JSON.parse(JSON.stringify(blank)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
  });

  it('is mixed like the starters, so newly written parts balance without re-mixing', () => {
    // The starters' faders and kit trims were set from rendered loudness. The synthesized kits play
    // far hotter than the synths, so an untrimmed kit would bury every part a user writes. Every
    // project carries its overall level on its faders, so the balance is each part against the drums.
    const gain = (p: Project, role: TrackRole) => {
      const t = byRole(p, role);
      const kitTrim = t.instrument.kind === 'drums' ? t.instrument.params.level : 0;
      return channelParam(p, t.id, 'level') + kitTrim + p.masterVolumeDb;
    };
    const balance = (p: Project, role: TrackRole) => gain(p, role) - gain(p, 'drums');
    const starters = STARTERS.map((s) => s.build());
    for (const role of ['percussion', 'bass', 'chords', 'lead', 'pad', 'texture', 'sampler'] as const) {
      const used = starters.map((p) => balance(p, role));
      expect(balance(blank, role), role).toBeGreaterThanOrEqual(Math.min(...used) - 2);
      expect(balance(blank, role), role).toBeLessThanOrEqual(Math.max(...used) + 2);
    }
  });
});

describe('starter DSL', () => {
  it('reads note names with C4 = 60', () => {
    expect(midi('C4')).toBe(60);
    expect(midi('A4')).toBe(69);
    expect(midi('Bb1')).toBe(34);
    expect(midi('F#2')).toBe(42);
    expect(midi('E1')).toBe(28);
    expect(() => midi('H2')).toThrow();
  });

  it('reads drum grids with accents, ghosts, ties and bar separators', () => {
    const { hits, steps } = parseGrid('X.o-|3...');
    expect(steps).toBe(8);
    expect(hits).toEqual([
      { step: 0, len: 1, velocity: 1 },
      { step: 2, len: 2, velocity: 0.42 },
      { step: 4, len: 1, velocity: 0.3 },
    ]);
    expect(() => parseGrid('x.?.')).toThrow();
  });

  it('tiles a short grid across longer drum clips and rejects one that does not fit', () => {
    const notes = drums(2, { kick: 'x...', hat: '..x...x...x...x.' });
    expect(notes.filter((n) => n.pitch === 0).map((n) => n.tick / TICKS_PER_STEP)).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
    expect(notes.filter((n) => n.pitch === 4)).toHaveLength(8);
    expect(() => drums(1, { kick: 'x....' })).toThrow();
  });

  it('writes lines with ties, chords, accents and bass slides', () => {
    const notes = seq('A2 - . C3+E3! B2~ A2?', { gate: 0.5 });
    expect(notes.map((n) => [n.tick / TICKS_PER_STEP, n.pitch, n.velocity])).toEqual([
      [0, 45, 0.8],
      [3, 48, 1],
      [3, 52, 1],
      [4, 47, 0.8],
      [5, 45, 0.5],
    ]);
    // The tie doubles the written length; the gate halves it.
    expect(notes[0].duration).toBe(2 * TICKS_PER_STEP * 0.5);
    // A slide overlaps the next note so a mono bass glides into it.
    expect(notes[3].tick + notes[3].duration).toBeGreaterThan(notes[4].tick);
    expect(() => line(1, 'A2 . .')).toThrow();
  });

  it('repeats chord voicings per bar on a rhythm and rolls strummed chords', () => {
    const hits = stabs(2, 'x.......x.......', ['C4 E4 G4', 'D4 F4 A4']);
    expect(hits.filter((n) => n.tick < TICKS_PER_BAR).map((n) => n.pitch)).toEqual([60, 64, 67, 60, 64, 67]);
    expect(hits.filter((n) => n.tick >= TICKS_PER_BAR).map((n) => n.pitch)).toEqual([62, 65, 69, 62, 65, 69]);
    const roll = strum('C4 E4 G4', 0, 8, 1);
    expect(roll.map((n) => n.tick)).toEqual([0, 24, 48]);
    expect(roll.map((n) => n.tick + n.duration)).toEqual([192, 192, 192]);
  });

  it('keeps clip notes inside the clip and rejects notes that start outside it', () => {
    const c = clip('Test', 1, [
      { tick: 300, pitch: 64, velocity: 0.9, duration: 500 },
      { tick: 0, pitch: 60, velocity: 0.5, duration: 96 },
      { tick: 0, pitch: 60, velocity: 0.7, duration: 96 },
    ]);
    // Sorted by time, duplicate hits merged (louder wins), tails trimmed at the clip end.
    expect(c.notes.map((n) => [n.tick, n.pitch, n.velocity, n.duration])).toEqual([
      [0, 60, 0.7, 96],
      [300, 64, 0.9, TICKS_PER_BAR - 300],
    ]);
    expect(() => clip('Bad', 1, [{ tick: TICKS_PER_BAR, pitch: 60, velocity: 1, duration: 10 }])).toThrow();
    expect(() => clip('Bad', 9, [])).toThrow();
    expect(clip('Long', 8, []).bars).toBe(8);
  });
});
