/**
 * Band map for the output spectrum (AudioEngine.readSpectrum): log-spaced
 * bands from SPECTRUM_LOW_HZ to SPECTRUM_HIGH_HZ, each the energy of the FFT
 * bins it contains. Pure (no Web Audio), so it runs in Node unit tests.
 *
 * A band's energy is the integral over the band of the spectrum's power
 * density, linearly interpolated between bin centres: every bin gets a
 * weight (its share of the band), so a wide band is the sum of its bins
 * (with the edge bins counted for the part inside the band) and a band
 * narrower than a bin reads its own slice of the density. This reads pink
 * noise flat down to 20 Hz at any FFT size; the previous computation (whole
 * bins inside the band, or an interpolated point for narrower bands) read
 * some bands below about 100 Hz up to 5 dB high, depending on where the bin
 * centres fell.
 *
 * The map is computed once per (FFT size, sample rate, band count). Reading
 * a frame is then one exp per bin in use (dB to power with the calibration
 * folded into a constant) and a weighted sum per band.
 */

/** Lowest and highest edge of the bands. */
export const SPECTRUM_LOW_HZ = 20;
export const SPECTRUM_HIGH_HZ = 20000;
/** Floor and ceiling of a band reading (dB). */
export const SPECTRUM_FLOOR_DB = -140;
export const SPECTRUM_CEIL_DB = 20;
/**
 * Bands show the energy they contain (the sum of their bins' power), so pink
 * noise reads flat and a sine reads its own level. The AnalyserNode scales by
 * 1/N and applies a Blackman window (mean square 0.3046): the bins of a sine
 * of amplitude A sum to A²/4 · 0.3046, i.e. −11.2 dB for A = 1. This offset
 * makes a full-scale sine read 0 dB.
 */
export const SPECTRUM_CAL_DB = 10 * Math.log10(4 / 0.30458);

export interface SpectrumBandMap {
  fftSize: number;
  sampleRate: number;
  bands: number;
  /** Lowest and highest bin any band reads (inclusive). */
  firstBin: number;
  lastBin: number;
  /** Per band: its terms are start[b] .. start[b + 1] − 1 of `bin` / `weight`. */
  start: Int32Array;
  bin: Int32Array;
  weight: Float64Array;
}

const maps = new Map<string, SpectrumBandMap>();

/** The (cached) band map for an FFT size, sample rate and band count. */
export function spectrumBandMap(fftSize: number, sampleRate: number, bands: number): SpectrumBandMap {
  const key = `${fftSize}|${sampleRate}|${bands}`;
  let map = maps.get(key);
  if (!map) {
    map = buildBandMap(fftSize, sampleRate, bands);
    maps.set(key, map);
  }
  return map;
}

function buildBandMap(fftSize: number, sampleRate: number, bands: number): SpectrumBandMap {
  const binHz = sampleRate / fftSize;
  const lastValid = fftSize / 2 - 1;
  const ratio = SPECTRUM_HIGH_HZ / SPECTRUM_LOW_HZ;
  const start = new Int32Array(bands + 1);
  const bins: number[] = [];
  const weights: number[] = [];
  for (let b = 0; b < bands; b++) {
    start[b] = bins.length;
    // Band edges in bin units (bin k is centred on k).
    const lo = Math.min(lastValid, (SPECTRUM_LOW_HZ * Math.pow(ratio, b / bands)) / binHz);
    const hi = Math.min(lastValid, (SPECTRUM_LOW_HZ * Math.pow(ratio, (b + 1) / bands)) / binHz);
    const w = new Map<number, number>();
    const add = (k: number, v: number) => {
      if (v > 0) w.set(k, (w.get(k) ?? 0) + v);
    };
    // ∫ over [lo, hi] of the density, linear between bin centres k and k + 1.
    for (let k = Math.floor(lo); k < hi && k < lastValid; k++) {
      const a = Math.max(lo, k) - k;
      const c = Math.min(hi, k + 1) - k;
      if (c <= a) continue;
      const half = (c * c - a * a) / 2;
      add(k, c - a - half);
      add(k + 1, half);
    }
    for (const [k, v] of [...w.entries()].sort((x, y) => x[0] - y[0])) {
      bins.push(k);
      weights.push(v);
    }
  }
  start[bands] = bins.length;
  let firstBin = lastValid;
  let lastBin = 0;
  for (const k of bins) {
    if (k < firstBin) firstBin = k;
    if (k > lastBin) lastBin = k;
  }
  return {
    fftSize,
    sampleRate,
    bands,
    firstBin: bins.length ? firstBin : 0,
    lastBin: bins.length ? lastBin : -1,
    start,
    bin: Int32Array.from(bins),
    weight: Float64Array.from(weights),
  };
}

const LN10_10 = Math.LN10 / 10;
const CAL_POWER = Math.pow(10, SPECTRUM_CAL_DB / 10);

/**
 * Bands from one frame of AnalyserNode.getFloatFrequencyData output (dB per
 * bin). `power` is scratch space of at least fftSize / 2 entries. Writes
 * map.bands values into `out` (clamped to −140..+20 dB; silence −140).
 */
export function spectrumBands(map: SpectrumBandMap, binsDb: Float32Array, out: Float32Array, power: Float64Array): void {
  for (let k = map.firstBin; k <= map.lastBin; k++) {
    const db = binsDb[k];
    // −Infinity (silence) and NaN read as no power.
    power[k] = db > -1000 && db < 1000 ? CAL_POWER * Math.exp(db * LN10_10) : 0;
  }
  const n = Math.min(out.length, map.bands);
  for (let b = 0; b < n; b++) {
    let p = 0;
    for (let t = map.start[b]; t < map.start[b + 1]; t++) p += power[map.bin[t]] * map.weight[t];
    const db = p > 0 ? 10 * Math.log10(p) : SPECTRUM_FLOOR_DB;
    out[b] = db < SPECTRUM_FLOOR_DB ? SPECTRUM_FLOOR_DB : db > SPECTRUM_CEIL_DB ? SPECTRUM_CEIL_DB : db;
  }
}
