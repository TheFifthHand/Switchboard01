/**
 * Offline drum synthesis: turns a kit recipe (src/audio/instruments/kits.ts)
 * into a mono Float32Array at any sample rate. Pure TypeScript, no Web
 * Audio, deterministic (every noise source is seeded from
 * hashString(kitId + slot)).
 *
 * Pipeline per voice:
 *   model synthesis (layers normalised, then mixed at recipe levels)
 *   -> kit character (saturation, rate/bit reduction, shelf, low/high-pass)
 *   -> tail trim (-70 dB) -> raised-cosine fade-out to exact silence
 *   -> fade-in only where the recipe asks (sample 0 is always 0)
 *   -> peak normalisation to the voice's role target (level matching).
 *
 * `decayMul` (clamped to 0.25..4) scales envelope lengths; pitch sweeps and
 * attack shapes stay as designed so the character of a drum survives.
 */
import { Rng, hashString } from '../../project/rng';
import {
  AhdEnvelope,
  Biquad,
  DcBlocker,
  ExpDecay,
  Oscillator,
  addDampedSine,
  addSquareWaveSpan,
  asymSaturateBuffer,
  bitReduce,
  fadeIn,
  fadeOut,
  normalizePeak,
  rateReduce,
  rms,
  sanitize,
  softClipBuffer,
  trimTail,
  type BiquadType,
} from '../dsp';
import {
  clampSlot,
  getVoiceRecipe,
  resolveKitId,
  voiceCharacter,
  type ClapModel,
  type CowbellModel,
  type DrumModel,
  type GuiroModel,
  type JingleModel,
  type KickModel,
  type KitCharacter,
  type MembraneModel,
  type MetalModel,
  type ModalModel,
  type ShakerModel,
  type SnapModel,
  type SnareModel,
  type VoiceRecipe,
  type ZapModel,
} from './kits';

export const DRUM_DECAY_MIN = 0.25;
export const DRUM_DECAY_MAX = 4;
/** Decay quantisation used for caching: 12 steps per doubling (~6%, below what the ear notices on a decay). */
export const DRUM_DECAY_STEPS_PER_OCTAVE = 12;
/** Hard cap on a rendered voice. */
const MAX_VOICE_SECONDS = 12;
/** Tail below this (relative to the peak) is trimmed before the fade-out. */
const TRIM_DB = -70;
const FADE_OUT_SECONDS = 0.012;
/** Minimum fade-in: a few samples guarantee sample 0 is silent without touching the transient. */
const MICRO_FADE_SAMPLES = 4;

const TAU = 2 * Math.PI;

type Buf = Float32Array<ArrayBuffer>;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function clampSampleRate(sr: number): number {
  if (!Number.isFinite(sr)) return 48000;
  return Math.min(384000, Math.max(3000, Math.round(sr)));
}

function clampDecay(d: number): number {
  if (!Number.isFinite(d)) return 1;
  return Math.min(DRUM_DECAY_MAX, Math.max(DRUM_DECAY_MIN, d));
}

function frames(seconds: number, sr: number): number {
  return Math.max(1, Math.min(Math.ceil(MAX_VOICE_SECONDS * sr), Math.ceil(Math.max(0, seconds) * sr)));
}

/** Scale to unit RMS (stationary layers are normalised before mixing so recipe levels are predictable). */
function unitRms(buf: Float32Array): void {
  const r = rms(buf);
  if (r < 1e-12) return;
  const g = 1 / r;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
}

interface Section {
  type: BiquadType;
  freq: number;
  q?: number;
  gainDb?: number;
}

/* ------------------------------------------------------------------ */
/* Steps: a voice renders as a sequence of short steps                 */
/* ------------------------------------------------------------------ */

/**
 * Samples per step of a per-sample loop. Rendering is written as a
 * generator that yields between steps (each a few ms at most even for the
 * heaviest models), so idle-time preparation can spread one long voice over
 * several slices (drumVoiceJob). Step boundaries depend only on sample
 * counts, so a voice comes out the same however its steps are scheduled.
 */
export const DRUM_STEP_FRAMES = 16384;

type Steps<T = void> = Generator<void, T, void>;

/** Run `body(from, to)` over 0..n in DRUM_STEP_FRAMES spans, yielding after each. */
function* spans(n: number, body: (from: number, to: number) => void): Steps {
  for (let a = 0; a < n; a += DRUM_STEP_FRAMES) {
    body(a, Math.min(n, a + DRUM_STEP_FRAMES));
    yield;
  }
}

/** A cascade of fresh biquad sections over a whole buffer, in steps. */
function* biquads(buf: Float32Array, sr: number, sections: readonly Section[]): Steps {
  for (const s of sections) {
    const bq = new Biquad(s.type, s.freq, s.q ?? Math.SQRT1_2, sr, s.gainDb ?? 0);
    yield* spans(buf.length, (a, b) => bq.processBuffer(buf, a, b));
  }
}

/** addSquareWave over a whole buffer, in steps (the phase carries on exactly). */
function* squareWave(out: Float32Array, freq: number, sr: number, phase: number): Steps {
  let t = ((phase % 1) + 1) % 1;
  yield* spans(out.length, (a, b) => {
    t = addSquareWaveSpan(out, freq, sr, t, 1, a, b);
  });
}

/** A stateless sample-wise process (saturation, quantisation) over a whole buffer, in steps. */
function* perSample(buf: Float32Array, fn: (part: Float32Array) => void): Steps {
  yield* spans(buf.length, (a, b) => fn(buf.subarray(a, b)));
}

/** Seeded white noise through a filter cascade, normalised to unit RMS. */
function* noiseLayer(n: number, sr: number, rng: Rng, sections: readonly Section[]): Steps<Buf> {
  const out = new Float32Array(n);
  yield* spans(n, (a, b) => {
    for (let i = a; i < b; i++) out[i] = rng.noise();
  });
  yield* biquads(out, sr, sections);
  unitRms(out);
  return out;
}

/** Sum of the values of several AHD envelopes started at different times (clap bursts, jingle clashes). */
function* multiOnsetEnvelope(n: number, sr: number, onsets: readonly { t: number; amp: number }[], attack: number, t60: number): Steps<Float64Array> {
  const env = new Float64Array(n);
  for (const o of onsets) {
    const start = Math.max(0, Math.round(o.t * sr));
    const e = new AhdEnvelope(attack, 0, t60, sr);
    let done = false;
    yield* spans(n - start, (a, b) => {
      if (done) return;
      for (let i = start + a; i < start + b; i++) {
        const v = e.next() * o.amp;
        env[i] += v;
        if (v < 1e-6 && i - start > attack * sr) {
          done = true;
          break;
        }
      }
    });
  }
  return env;
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

function* synthKick(m: KickModel, sr: number, dm: number, rng: Rng): Steps<Buf> {
  const hold = m.hold * dm;
  const decay = m.decay * dm;
  const n = frames(hold + decay + 0.01, sr);
  const out = new Float32Array(n);
  const clickN = Math.min(n, frames(0.03, sr));
  const click = yield* noiseLayer(clickN, sr, rng, [
    { type: 'bandpass', freq: m.clickHz, q: 0.8 },
    { type: 'highpass', freq: 600 },
  ]);
  const clickEnv = new AhdEnvelope(0.0003, 0, 0.012, sr);
  const env = new AhdEnvelope(0, hold, decay, sr);
  const sweepC = Math.exp(-1 / (Math.max(1e-4, m.sweep) * sr));
  const punchC = Math.exp(-1 / (Math.max(1e-4, m.punchTime) * sr));
  const span = m.startHz - m.endHz;
  let sw = 1;
  let pu = 1;
  let phase = 0;
  yield* spans(n, (a, b) => {
    let s = sw;
    let u = pu;
    let ph = phase;
    for (let i = a; i < b; i++) {
      const f = m.endHz + span * s + m.punchHz * u;
      s *= sweepC;
      u *= punchC;
      let x = Math.sin(TAU * ph) * env.next();
      ph += f / sr;
      if (ph >= 1) ph -= 1;
      if (i < clickN) x += click[i] * clickEnv.next() * m.click;
      out[i] = x;
    }
    sw = s;
    pu = u;
    phase = ph;
  });
  yield* perSample(out, (part) => softClipBuffer(part, m.drive));
  if (m.tone > 0) yield* biquads(out, sr, [{ type: 'lowpass', freq: m.tone, q: Math.SQRT1_2 }]);
  return out;
}

function* synthSnare(m: SnareModel, sr: number, dm: number, rng: Rng): Steps<Buf> {
  const bodyDecay = m.bodyDecay * dm;
  const noiseDecay = m.noiseDecay * dm;
  const n = frames(Math.max(bodyDecay, noiseDecay) + 0.01, sr);
  const out = new Float32Array(n);
  const wires = yield* noiseLayer(n, sr, rng, [
    { type: 'highpass', freq: m.noiseLow },
    { type: 'lowpass', freq: m.noiseHigh },
    { type: 'peaking', freq: m.presenceHz, q: 1, gainDb: m.presenceDb },
  ]);
  const snapN = Math.min(n, frames(0.02, sr));
  const snap = yield* noiseLayer(snapN, sr, rng, [{ type: 'highpass', freq: 3500 }]);
  const envA = new ExpDecay(bodyDecay, sr);
  const envB = new ExpDecay(bodyDecay * 0.7, sr);
  const wireEnv = new AhdEnvelope(0.0006, 0.003, noiseDecay, sr);
  const snapEnv = new AhdEnvelope(0.0002, 0, 0.01, sr);
  const bendC = Math.exp(-1 / (Math.max(1e-4, m.bendTime) * sr));
  const [fa, fb] = m.bodyHz;
  const [la, lb] = m.bodyLevel;
  let bend = 1;
  let pa = 0;
  let pb = 0;
  yield* spans(n, (a, b) => {
    let bd = bend;
    let qa = pa;
    let qb = pb;
    for (let i = a; i < b; i++) {
      const k = 1 + m.bend * bd;
      bd *= bendC;
      let x = Math.sin(TAU * qa) * la * envA.next() + Math.sin(TAU * qb) * lb * envB.next();
      qa += (fa * k) / sr;
      qb += (fb * k) / sr;
      if (qa >= 1) qa -= 1;
      if (qb >= 1) qb -= 1;
      x += wires[i] * m.noise * wireEnv.next();
      if (i < snapN) x += snap[i] * m.snap * snapEnv.next();
      out[i] = x;
    }
    bend = bd;
    pa = qa;
    pb = qb;
  });
  yield* perSample(out, (part) => softClipBuffer(part, m.drive));
  return out;
}

function* synthClap(m: ClapModel, sr: number, dm: number, rng: Rng): Steps<Buf> {
  const count = Math.max(1, Math.min(8, Math.round(m.bursts)));
  const onsets: { t: number; amp: number }[] = [];
  let t = 0;
  for (let b = 0; b < count; b++) {
    if (b > 0) t += m.spacing * (1 + 0.12 * rng.noise());
    onsets.push({ t, amp: (0.85 + 0.05 * b) * (0.92 + 0.16 * rng.float()) });
  }
  const tLast = t;
  const tailDecay = m.tailDecay * dm;
  const n = frames(tLast + Math.max(tailDecay, m.burstDecay) + 0.01, sr);
  const bursts = yield* noiseLayer(n, sr, rng, [
    { type: 'bandpass', freq: m.bandHz, q: m.q },
    { type: 'highpass', freq: m.highpass },
  ]);
  const tail = yield* noiseLayer(n, sr, rng, [
    { type: 'bandpass', freq: m.bandHz * 0.85, q: m.q * 0.6 },
    { type: 'highpass', freq: m.highpass },
  ]);
  const burstEnv = yield* multiOnsetEnvelope(n, sr, onsets, 0.0003, m.burstDecay);
  const tailEnv = yield* multiOnsetEnvelope(n, sr, [{ t: tLast, amp: m.tail }], 0.004, tailDecay);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = bursts[i] * burstEnv[i] + tail[i] * tailEnv[i];
  yield;
  yield* perSample(out, (part) => softClipBuffer(part, m.drive));
  return out;
}

function* synthMetal(m: MetalModel, sr: number, dm: number, rng: Rng): Steps<Buf> {
  const decay = m.decay * dm;
  const splashDecay = m.splash ? m.splash.decay * dm : 0;
  const bellDecay = m.bell ? m.bell.decay * dm : 0;
  const n = frames(m.attack + Math.max(decay, splashDecay, bellDecay) + 0.01, sr);

  // Metallic cluster: inharmonic band-limited squares, then band + 4th-order high-pass.
  const metal = new Float32Array(n);
  for (const f of m.freqs) if (f > 0 && f < sr * 0.45) yield* squareWave(metal, f, sr, rng.float());
  yield* biquads(metal, sr, [
    { type: 'bandpass', freq: m.band, q: m.bandQ },
    { type: 'highpass', freq: m.highpass },
    { type: 'highpass', freq: m.highpass },
  ]);
  unitRms(metal);
  const sizzle = yield* noiseLayer(n, sr, rng, [
    { type: 'highpass', freq: m.highpass },
    { type: 'highpass', freq: m.highpass },
    { type: 'lowpass', freq: Math.min(m.band * 1.8, sr * 0.45) },
  ]);

  const out = new Float32Array(n);
  const noiseMix = Math.min(1, Math.max(0, m.noise));
  const splashLevel = m.splash ? Math.min(1, Math.max(0, m.splash.level)) : 0;
  const slow = new AhdEnvelope(m.attack, 0, decay, sr);
  const fast = new AhdEnvelope(m.attack, 0, Math.max(1e-3, splashDecay), sr);
  yield* spans(n, (a, b) => {
    for (let i = a; i < b; i++) {
      const e = (1 - splashLevel) * slow.next() + splashLevel * fast.next();
      out[i] = (metal[i] * (1 - noiseMix) + sizzle[i] * noiseMix) * e;
    }
  });

  // Wash darkening: a low-pass that closes from `from` to `to` (updated every 32 samples).
  if (m.darken) {
    const d = m.darken;
    const lp = new Biquad('lowpass', d.from, Math.SQRT1_2, sr);
    const tc = Math.max(1e-3, d.time * dm);
    yield* spans(n, (a, b) => {
      for (let i = a; i < b; i++) {
        if ((i & 31) === 0) lp.tune(d.to + (d.from - d.to) * Math.exp(-i / sr / tc), Math.SQRT1_2);
        out[i] = lp.process(out[i]);
      }
    });
  }

  // Ride bell ping.
  if (m.bell && m.bell.level > 0) {
    const b = m.bell;
    const partials = b.partials.filter(([r]) => b.hz * r < sr * 0.45);
    // Higher bell partials fade sooner.
    for (const [ratio, level] of partials) {
      addDampedSine(out, b.hz * ratio, bellDecay / Math.sqrt(ratio), sr, level * b.level * 0.6);
      yield;
    }
  }

  // Stick click.
  if (m.stick && m.stick > 0) {
    const cn = Math.min(n, frames(0.015, sr));
    const click = yield* noiseLayer(cn, sr, rng, [{ type: 'highpass', freq: 2500 }]);
    const env = new AhdEnvelope(0.0002, 0, 0.006, sr);
    for (let i = 0; i < cn; i++) out[i] += click[i] * env.next() * m.stick;
  }
  return out;
}

function* synthMembrane(m: MembraneModel, sr: number, dm: number, rng: Rng): Steps<Buf> {
  const decay = m.decay * dm;
  const noiseDecay = m.noiseDecay * dm;
  const modes = m.modes.filter(([r]) => m.hz * r * (1 + m.bend) < sr * 0.45);
  const n = frames(Math.max(decay, noiseDecay) + 0.01, sr);
  const out = new Float32Array(n);
  const env0 = new ExpDecay(decay, sr);
  const modeEnv = modes.map(([, , s]) => new ExpDecay(decay * s, sr));
  const modePhase = modes.map(() => 0);
  const bendC = Math.exp(-1 / (Math.max(1e-4, m.bendTime) * sr));
  const noiseN = m.noise > 0 ? Math.min(n, frames(noiseDecay + 0.01, sr)) : 0;
  const slap = noiseN > 0 ? yield* noiseLayer(noiseN, sr, rng, [{ type: 'bandpass', freq: m.noiseHz, q: m.noiseQ }]) : null;
  const slapEnv = new AhdEnvelope(0.0003, 0, Math.max(1e-3, noiseDecay), sr);
  const clickN = m.click > 0 ? Math.min(n, frames(0.012, sr)) : 0;
  const click = clickN > 0 ? yield* noiseLayer(clickN, sr, rng, [{ type: 'highpass', freq: 2000 }]) : null;
  const clickEnv = new AhdEnvelope(0.0002, 0, 0.005, sr);
  let bend = 1;
  let p0 = 0;
  yield* spans(n, (a, b) => {
    let bd = bend;
    let q0 = p0;
    for (let i = a; i < b; i++) {
      const f = m.hz * (1 + m.bend * bd);
      bd *= bendC;
      let x = Math.sin(TAU * q0) * env0.next();
      q0 += f / sr;
      if (q0 >= 1) q0 -= 1;
      for (let k = 0; k < modes.length; k++) {
        x += Math.sin(TAU * modePhase[k]) * modes[k][1] * modeEnv[k].next();
        let p = modePhase[k] + (f * modes[k][0]) / sr;
        if (p >= 1) p -= Math.floor(p);
        modePhase[k] = p;
      }
      if (slap && i < noiseN) x += slap[i] * m.noise * slapEnv.next();
      if (click && i < clickN) x += click[i] * m.click * clickEnv.next();
      out[i] = x;
    }
    bend = bd;
    p0 = q0;
  });
  yield* perSample(out, (part) => softClipBuffer(part, m.drive));
  return out;
}

function* synthModal(m: ModalModel, sr: number, dm: number, rng: Rng): Steps<Buf> {
  const partials = m.partials.filter(([r]) => m.hz * r < sr * 0.45);
  let longest = m.noiseDecay * dm;
  for (const [, , t60] of partials) longest = Math.max(longest, t60 * dm);
  const n = frames(longest + 0.01, sr);
  const out = new Float32Array(n);
  for (const [ratio, level, t60] of partials) {
    addDampedSine(out, m.hz * ratio, t60 * dm, sr, level);
    yield;
  }
  if (m.noise > 0) {
    const nn = Math.min(n, frames(m.noiseDecay * dm + 0.01, sr));
    const strike = yield* noiseLayer(nn, sr, rng, [{ type: 'bandpass', freq: m.noiseHz, q: m.noiseQ }]);
    const env = new AhdEnvelope(0.0002, 0, Math.max(1e-3, m.noiseDecay * dm), sr);
    for (let i = 0; i < nn; i++) out[i] += strike[i] * env.next() * m.noise;
  }
  if (m.highpass > 0) yield* biquads(out, sr, [{ type: 'highpass', freq: m.highpass }]);
  return out;
}

function* synthCowbell(m: CowbellModel, sr: number, dm: number, rng: Rng): Steps<Buf> {
  const decay = m.decay * dm;
  const fastDecay = m.fastDecay * dm;
  const n = frames(Math.max(decay, fastDecay) + 0.01, sr);
  const tone = new Float32Array(n);
  yield* squareWave(tone, m.hz[0], sr, rng.float());
  yield* squareWave(tone, m.hz[1], sr, rng.float());
  const sections: Section[] = [{ type: 'bandpass', freq: m.band, q: m.bandQ }];
  if (m.lowpass > 0) sections.push({ type: 'lowpass', freq: m.lowpass });
  yield* biquads(tone, sr, sections);
  unitRms(tone);
  const fastShare = Math.min(1, Math.max(0, m.fast));
  const slow = new AhdEnvelope(0.0003, 0, decay, sr);
  const quick = new AhdEnvelope(0.0003, 0, Math.max(1e-3, fastDecay), sr);
  for (let i = 0; i < n; i++) tone[i] *= (1 - fastShare) * slow.next() + fastShare * quick.next();
  return tone;
}

function* synthShaker(m: ShakerModel, sr: number, dm: number, rng: Rng): Steps<Buf> {
  const decay = m.decay * dm;
  const n = frames(m.attack + decay + 0.01, sr);
  const out = new Float32Array(n);
  const grain = Math.min(1, Math.max(0, m.grain));
  const beadRate = Math.max(0, m.density) / sr;
  const beadTau = 0.0006;
  const beadC = Math.exp(-1 / (beadTau * sr));
  // Mean bead envelope ~ density * mean amplitude * tau; normalise so the grain modulation averages ~1.
  const beadNorm = 1 / Math.max(1e-3, m.density * 0.7 * beadTau);
  const env = new AhdEnvelope(m.attack, 0, decay, sr);
  let bead = 0;
  yield* spans(n, (a, b) => {
    let bd = bead;
    for (let i = a; i < b; i++) {
      if (rng.float() < beadRate) bd += 0.4 + 0.6 * rng.float();
      bd *= beadC;
      const g = 1 - grain + grain * Math.min(4, bd * beadNorm);
      out[i] = rng.noise() * g * env.next();
    }
    bead = bd;
  });
  yield* biquads(out, sr, [
    { type: 'highpass', freq: m.highpass },
    { type: 'bandpass', freq: m.band, q: m.bandQ },
  ]);
  return out;
}

function* synthJingle(m: JingleModel, sr: number, dm: number, rng: Rng): Steps<Buf> {
  const decay = m.decay * dm;
  const noiseDecay = m.noiseDecay * dm;
  const hits = Math.max(1, Math.min(8, Math.round(m.hits)));
  const onsets: { t: number; amp: number }[] = [];
  for (let h = 0; h < hits; h++) {
    const x = hits > 1 ? h / (hits - 1) : 0;
    const t = h === 0 ? 0 : m.spread * Math.pow(x, 1.2) * (1 + 0.2 * rng.noise());
    onsets.push({ t: Math.max(0, t), amp: Math.pow(0.72, h) * (0.85 + 0.3 * rng.float()) });
  }
  const tLast = Math.max(...onsets.map((o) => o.t));
  const n = frames(tLast + Math.max(decay, noiseDecay) + 0.01, sr);

  // Jingle ring: each nominal partial doubled with a slightly detuned twin (pairs of jingles beat).
  const ring = new Float32Array(n);
  for (const f of m.freqs) {
    for (const detune of [0, 0.012 * rng.noise()]) {
      const hz = f * (1 + detune);
      if (hz >= sr * 0.45) continue;
      addDampedSine(ring, hz, 0, sr, 1, rng.float());
      yield;
    }
  }
  yield* biquads(ring, sr, [{ type: 'highpass', freq: m.highpass }]);
  unitRms(ring);
  const sizzle = yield* noiseLayer(n, sr, rng, [
    { type: 'highpass', freq: m.highpass },
    { type: 'highpass', freq: m.highpass },
  ]);
  const ringEnv = yield* multiOnsetEnvelope(n, sr, onsets, 0.0003, decay);
  const noiseEnv = yield* multiOnsetEnvelope(n, sr, onsets, 0.0002, Math.max(1e-3, noiseDecay));
  const noiseMix = Math.min(1, Math.max(0, m.noise));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ring[i] * ringEnv[i] * (1 - noiseMix) + sizzle[i] * noiseEnv[i] * noiseMix;
  if (m.skin > 0) addDampedSine(out, m.skinHz, 0.08 * dm, sr, m.skin);
  return out;
}

function* synthZap(m: ZapModel, sr: number, dm: number, _rng: Rng): Steps<Buf> {
  const decay = m.decay * dm;
  const n = frames(decay + 0.01, sr);
  const out = new Float32Array(n);
  // Triangle starts a quarter cycle in so it rises out of zero like the sine.
  const osc = new Oscillator(m.wave, sr, m.wave === 'triangle' ? 0.25 : 0);
  const env = new ExpDecay(decay, sr);
  const c = Math.exp(-1 / (Math.max(1e-4, m.sweep) * sr));
  let sw = 1;
  yield* spans(n, (a, b) => {
    for (let i = a; i < b; i++) {
      const f = m.endHz + (m.startHz - m.endHz) * sw;
      sw *= c;
      out[i] = osc.next(f) * env.next();
    }
  });
  yield* perSample(out, (part) => softClipBuffer(part, m.drive));
  return out;
}

function* synthSnap(m: SnapModel, sr: number, dm: number, rng: Rng): Steps<Buf> {
  const decay = m.decay * dm;
  const toneDecay = m.toneDecay * dm;
  const n = frames(Math.max(decay, toneDecay) + 0.01, sr);
  const crack = yield* noiseLayer(n, sr, rng, [
    { type: 'bandpass', freq: m.band, q: m.q },
    { type: 'highpass', freq: 700 },
  ]);
  const env = new AhdEnvelope(0.0003, 0.0015, decay, sr);
  for (let i = 0; i < n; i++) crack[i] *= env.next();
  addDampedSine(crack, m.tone, toneDecay, sr, m.toneLevel);
  return crack;
}

function* synthGuiro(m: GuiroModel, sr: number, dm: number, rng: Rng): Steps<Buf> {
  // The scrape gesture stretches gently with decay; the ridges keep their spacing character.
  const stretch = Math.sqrt(dm);
  const duration = m.duration * stretch;
  const tickDecay = m.tickDecay * stretch;
  const ticks = Math.max(2, Math.min(64, Math.round(m.ticks)));
  const n = frames(duration + tickDecay * 2 + 0.03, sr);
  const exc = new Float32Array(n);
  const burstN = frames(tickDecay * 1.5, sr);
  for (let k = 0; k < ticks; k++) {
    const x = k / (ticks - 1);
    const jitter = k > 0 && k < ticks - 1 ? (0.25 * rng.noise()) / (ticks - 1) : 0;
    const t = duration * Math.pow(Math.min(1, Math.max(0, x + jitter)), m.accel);
    // Scrape dynamics: quick rise, gentle fall.
    const amp = Math.pow(Math.sin(Math.PI * (0.12 + 0.8 * x)), 0.6) * (0.75 + 0.25 * rng.float());
    const start = Math.round(t * sr);
    const env = new AhdEnvelope(0.0001, 0, tickDecay, sr);
    for (let i = 0; i < burstN && start + i < n; i++) exc[start + i] += rng.noise() * env.next() * amp;
  }
  yield;
  const body = exc.slice();
  yield* biquads(exc, sr, [{ type: 'bandpass', freq: m.band, q: m.q }]);
  yield* biquads(body, sr, [{ type: 'bandpass', freq: m.band * 2.1, q: m.q * 0.8 }]);
  for (let i = 0; i < n; i++) exc[i] += body[i] * 0.5;
  return exc;
}

function synthesize(model: DrumModel, sr: number, dm: number, rng: Rng): Steps<Buf> {
  switch (model.model) {
    case 'kick':
      return synthKick(model, sr, dm, rng);
    case 'snare':
      return synthSnare(model, sr, dm, rng);
    case 'clap':
      return synthClap(model, sr, dm, rng);
    case 'metal':
      return synthMetal(model, sr, dm, rng);
    case 'membrane':
      return synthMembrane(model, sr, dm, rng);
    case 'modal':
      return synthModal(model, sr, dm, rng);
    case 'cowbell':
      return synthCowbell(model, sr, dm, rng);
    case 'shaker':
      return synthShaker(model, sr, dm, rng);
    case 'jingle':
      return synthJingle(model, sr, dm, rng);
    case 'zap':
      return synthZap(model, sr, dm, rng);
    case 'snap':
      return synthSnap(model, sr, dm, rng);
    case 'guiro':
      return synthGuiro(model, sr, dm, rng);
  }
}

/* ------------------------------------------------------------------ */
/* Kit character, trimming, level matching                             */
/* ------------------------------------------------------------------ */

function* applyCharacter(buf: Buf, ch: KitCharacter, sr: number): Steps {
  if (ch.drive > 1e-3) {
    if (Math.abs(ch.asym) > 1e-4) yield* perSample(buf, (part) => asymSaturateBuffer(part, ch.drive, ch.asym));
    else yield* perSample(buf, (part) => softClipBuffer(part, ch.drive));
  }
  if (ch.rate > 0) {
    rateReduce(buf, sr, ch.rate);
    yield;
  }
  if (ch.bits < 24) yield* perSample(buf, (part) => bitReduce(part, ch.bits));
  const sections: Section[] = [];
  if (ch.shelfDb !== 0) sections.push({ type: 'highshelf', freq: 6000, q: Math.SQRT1_2, gainDb: ch.shelfDb });
  if (ch.lowpass < 20000 && ch.lowpass < sr * 0.45) sections.push({ type: 'lowpass', freq: ch.lowpass });
  if (ch.highpass > 0) sections.push({ type: 'highpass', freq: ch.highpass });
  yield* biquads(buf, sr, sections);
  // The high-pass already removes DC; without one, block DC explicitly (asymmetric saturation adds some).
  if (!(ch.highpass > 0)) {
    const dc = new DcBlocker(8, sr);
    yield* spans(buf.length, (a, b) => dc.processBuffer(buf.subarray(a, b)));
  }
}

function* finish(raw: Buf, recipe: VoiceRecipe, ch: KitCharacter, sr: number): Steps<Buf> {
  sanitize(raw, 1e3);
  normalizePeak(raw, 1);
  yield;
  yield* applyCharacter(raw, ch, sr);
  sanitize(raw, 1e3);
  // Pad past the last audible sample by the fade length so the fade only touches sub-threshold tail.
  const out = trimTail(raw, TRIM_DB, (FADE_OUT_SECONDS + 0.004) * sr, frames(0.02, sr));
  yield;
  fadeOut(out, Math.min(Math.round(FADE_OUT_SECONDS * sr), Math.floor(out.length * 0.25)));
  fadeIn(out, Math.max(MICRO_FADE_SAMPLES, Math.round((recipe.fadeInMs / 1000) * sr)));
  normalizePeak(out, recipe.peak);
  sanitize(out, 1);
  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Seed of a voice: hashString(kitId + slot). Unknown kits use the fallback kit's id. */
export function drumVoiceSeed(kitId: string, slot: number): number {
  return hashString(resolveKitId(kitId) + String(clampSlot(slot)));
}

/** renderDrumVoice as a sequence of steps (see DRUM_STEP_FRAMES); the generator returns the voice. */
function* renderDrumVoiceSteps(kitId: string, slot: number, sampleRate: number, decayMul: number): Steps<Buf> {
  const id = resolveKitId(kitId);
  const s = clampSlot(slot);
  const sr = clampSampleRate(sampleRate);
  const dm = clampDecay(decayMul);
  const recipe = getVoiceRecipe(id, s);
  const rng = new Rng(drumVoiceSeed(id, s));
  const raw = yield* synthesize(recipe.model, sr, dm, rng);
  return yield* finish(raw, recipe, voiceCharacter(id, s), sr);
}

/**
 * Render one drum voice (mono, deterministic). `slot` is clamped to 0..15,
 * `decayMul` to 0.25..4, `sampleRate` to 3 kHz..384 kHz. Unknown kits render
 * the default kit. The result peaks at the voice's role target, starts and
 * ends at exactly 0.
 */
export function renderDrumVoice(kitId: string, slot: number, sampleRate: number, decayMul: number): Float32Array<ArrayBuffer> {
  const steps = renderDrumVoiceSteps(kitId, slot, sampleRate, decayMul);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Snap a decay multiplier to the cache grid (12 steps per doubling within 0.25..4). */
export function quantizeDrumDecay(decayMul: number): number {
  const d = clampDecay(decayMul);
  const q = Math.pow(2, Math.round(Math.log2(d) * DRUM_DECAY_STEPS_PER_OCTAVE) / DRUM_DECAY_STEPS_PER_OCTAVE);
  return clampDecay(q);
}

/** Cache key for a rendered voice (decay quantised). */
export function drumVoiceKey(kitId: string, slot: number, sampleRate: number, decayMul: number): string {
  return `${resolveKitId(kitId)}|${clampSlot(slot)}|${clampSampleRate(sampleRate)}|${quantizeDrumDecay(decayMul).toFixed(6)}`;
}

/** Memory budget for cached voices (bytes of sample data). */
const CACHE_BUDGET_BYTES = 48 * 1024 * 1024;
const cache = new Map<string, Buf>();
let cacheBytes = 0;
/** Voices rendered so far (cache misses), for tests and diagnostics. */
let renders = 0;

/**
 * Cached `renderDrumVoice` with the decay snapped by `quantizeDrumDecay`.
 * Least-recently-used entries are evicted beyond a fixed memory budget.
 * The returned array is shared: treat it as read-only.
 */
export function getDrumVoice(kitId: string, slot: number, sampleRate: number, decayMul: number): Float32Array<ArrayBuffer> {
  const key = drumVoiceKey(kitId, slot, sampleRate, decayMul);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  return remember(key, renderDrumVoice(kitId, slot, sampleRate, quantizeDrumDecay(decayMul)));
}

function remember(key: string, data: Buf): Buf {
  renders++;
  cache.set(key, data);
  cacheBytes += data.byteLength;
  for (const [k, old] of cache) {
    if (cacheBytes <= CACHE_BUDGET_BYTES || k === key) break;
    cache.delete(k);
    cacheBytes -= old.byteLength;
  }
  return data;
}

/** A voice rendered a step at a time into the shared cache (idle-time preparation). */
export interface DrumVoiceJob {
  /** Cache key of the voice (drumVoiceKey). */
  readonly key: string;
  /** Run one step (a few ms at most); true while more remains. When it returns false the voice is in the cache. */
  step(): boolean;
}

/**
 * Render the voice getDrumVoice would return, one short step per call, so
 * a long voice (a ride, a deep tom) spreads over several idle slices. The
 * result is identical to getDrumVoice's; a voice already cached (or cached
 * meanwhile) finishes at once.
 */
export function drumVoiceJob(kitId: string, slot: number, sampleRate: number, decayMul: number): DrumVoiceJob {
  const key = drumVoiceKey(kitId, slot, sampleRate, decayMul);
  let steps: Steps<Buf> | null = null;
  let done = false;
  return {
    key,
    step(): boolean {
      if (done) return false;
      if (cache.has(key)) {
        done = true;
        return false;
      }
      steps ??= renderDrumVoiceSteps(kitId, slot, sampleRate, quantizeDrumDecay(decayMul));
      const r = steps.next();
      if (!r.done) return true;
      done = true;
      remember(key, r.value);
      return false;
    },
  };
}

/** The cached voice for these settings, or null when it would have to be rendered (never renders). */
export function peekDrumVoice(kitId: string, slot: number, sampleRate: number, decayMul: number): Float32Array<ArrayBuffer> | null {
  return cache.get(drumVoiceKey(kitId, slot, sampleRate, decayMul)) ?? null;
}

export function clearDrumVoiceCache(): void {
  cache.clear();
  cacheBytes = 0;
}

/** Cached voices, their bytes, and how many voices were rendered since the page loaded. */
export function drumVoiceCacheStats(): { entries: number; bytes: number; renders: number } {
  return { entries: cache.size, bytes: cacheBytes, renders };
}
