/**
 * Spectrum of the final output: how much of the music sits in the lows, the
 * mids and the highs, from the engine's readSpectrum (log-spaced bands,
 * 20 Hz–20 kHz, in dB). Drawn on a canvas from the meters' shared loop at
 * most 30 times a second, only when the picture changed; the region readouts
 * (Lows / Mids / Highs in dB) are written to the DOM a few times a second.
 * Nothing here re-renders React per frame.
 *
 * Cheap when nothing moves: once the output is silent and the curve has
 * fallen away (the transport stopped), it stops reading the engine and the
 * shared loop can sleep; it also stops while it is scrolled out of view
 * (IntersectionObserver). The canvas's backing store is capped at 1.5 device
 * pixels per CSS pixel.
 *
 * When the engine has no spectrum yet (audio not started, or an engine
 * without it) or the output is silent, the display says what to do instead
 * of drawing anything made up.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { meterWake, useElementSize } from '../../../ui/components';
import { session } from '../../instance';
import { runtimeStore } from '../../runtime';
import { mixFrameLive, readMixFrame } from './mixMeters';
import { useMixTask } from './useMixTask';
import styles from './Spectrum.module.css';

export const SPECTRUM_BANDS = 96;
const F_MIN = 20;
const F_MAX = 20000;
/** Display range in dB (bottom, top). */
const FLOOR_DB = -100;
const TOP_DB = -10;
/** Below this everywhere, the output counts as silent. */
const SILENT_DB = -110;
const FALL_DB_PER_S = 36;
const TEXT_INTERVAL_MS = 300;
/** Backing-store pixels per CSS pixel, at most (a sharper picture costs more to draw and composite). */
export const SPECTRUM_MAX_DPR = 1.5;

export type SpectrumState = 'off' | 'unavailable' | 'silent' | 'live';

/** What the display says instead of a picture. */
export function overlayText(state: SpectrumState, playing: boolean): string {
  switch (state) {
    case 'off':
      return 'Start playback to see the spectrum.';
    case 'unavailable':
      return 'The spectrum is not available.';
    case 'silent':
      return playing ? 'Silent: nothing is sounding right now.' : 'Silent. Start playback to see the spectrum.';
    default:
      return '';
  }
}

export interface SpectrumRegion {
  id: 'lows' | 'mids' | 'highs';
  name: string;
  from: number;
  to: number;
  description: string;
}

export const SPECTRUM_REGIONS: readonly SpectrumRegion[] = [
  { id: 'lows', name: 'Lows', from: F_MIN, to: 250, description: 'kick, bass and weight' },
  { id: 'mids', name: 'Mids', from: 250, to: 4000, description: 'chords, voices, leads and body' },
  { id: 'highs', name: 'Highs', from: 4000, to: F_MAX, description: 'hats, air and sparkle' },
];

const FREQ_LABELS: readonly [number, string][] = [
  [50, '50'],
  [100, '100'],
  [200, '200'],
  [500, '500'],
  [1000, '1k'],
  [2000, '2k'],
  [5000, '5k'],
  [10000, '10k'],
];

/** Horizontal position (0..1) of a frequency on the log axis. */
export function freqX(f: number): number {
  return Math.log(Math.min(F_MAX, Math.max(F_MIN, f)) / F_MIN) / Math.log(F_MAX / F_MIN);
}

/** Power average (in dB) of the bands whose centres fall in [from, to). */
export function regionLevel(bands: Float32Array, from: number, to: number): number {
  const n = bands.length;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const f = F_MIN * Math.pow(F_MAX / F_MIN, (i + 0.5) / n);
    if (f < from || f >= to) continue;
    const v = bands[i];
    sum += Number.isFinite(v) ? Math.pow(10, v / 10) : 0;
    count++;
  }
  return count && sum > 0 ? 10 * Math.log10(sum / count) : -Infinity;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function Spectrum() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLParagraphElement>(null);
  const regionRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const size = useElementSize(wrapRef);
  const [onScreen, setOnScreen] = useState(true);
  const state = useRef({
    raw: new Float32Array(SPECTRUM_BANDS),
    shown: new Float32Array(SPECTRUM_BANDS).fill(-Infinity),
    textAt: -Infinity,
    playing: false,
    status: 'off' as SpectrumState,
    overlayShown: false,
    dirty: true,
    colors: null as { line: string; fill: string; grid: string; tint: string } | null,
  });

  // Canvas backing store follows the element size and the screen's pixel ratio (at most 1.5).
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || size.width === 0 || size.height === 0) return;
    const dpr = Math.min(SPECTRUM_MAX_DPR, window.devicePixelRatio || 1);
    c.width = Math.round(size.width * dpr);
    c.height = Math.round(size.height * dpr);
    state.current.dirty = true;
    state.current.textAt = -Infinity;
    meterWake();
  }, [size.width, size.height]);

  // Scrolled out of view (200 % zoom, the Advanced column), it does nothing.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) setOnScreen(e.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (onScreen) state.current.dirty = true;
  }, [onScreen]);

  useMixTask(
    {
      frame(_now, dtMs) {
        const s = state.current;
        const c = canvasRef.current;
        if (!c || c.width === 0) return false;
        const ok = session.readSpectrum(s.raw);
        let max = -Infinity;
        if (ok) for (let i = 0; i < s.raw.length; i++) if (s.raw[i] > max) max = s.raw[i];
        // Audio not started, an engine without a spectrum, silence, or a live picture.
        readMixFrame();
        const status: SpectrumState = !ok ? (mixFrameLive() ? 'unavailable' : 'off') : !(max > SILENT_DB) ? 'silent' : 'live';
        const fall = FALL_DB_PER_S * Math.min(0.25, dtMs / 1000);
        let moved = s.dirty;
        let showing = false;
        for (let i = 0; i < SPECTRUM_BANDS; i++) {
          const v = status === 'live' && Number.isFinite(s.raw[i]) ? s.raw[i] : -Infinity;
          const cur = s.shown[i];
          const next = v >= cur ? v : Math.max(v, cur - fall);
          if (next !== cur && !(next < FLOOR_DB - 20 && cur < FLOOR_DB - 20)) moved = true;
          s.shown[i] = next < FLOOR_DB - 20 ? -Infinity : next;
          if (s.shown[i] > -Infinity) showing = true;
        }
        const playing = runtimeStore.getState().playing;
        if (status !== s.status || playing !== s.playing || !s.overlayShown) {
          s.status = status;
          s.playing = playing;
          const el = overlayRef.current;
          if (el) {
            el.dataset.state = status;
            const text = overlayText(status, playing);
            if (el.textContent !== text) el.textContent = text;
            s.overlayShown = true;
          }
        }
        if (moved) {
          s.dirty = false;
          draw(c, s.shown, (s.colors ??= {
            line: cssVar('--amber', '#e39b2f'),
            fill: cssVar('--amber-wash', 'rgba(242,166,52,0.16)'),
            grid: cssVar('--line', '#c4c8cc'),
            tint: cssVar('--surface-lo', '#d2d6da'),
          }));
        }
        const now = performance.now();
        let textBusy = false;
        if (now - s.textAt > TEXT_INTERVAL_MS) {
          s.textAt = now;
          SPECTRUM_REGIONS.forEach((r, i) => {
            const el = regionRefs.current[i];
            if (!el) return;
            const db = status === 'live' ? regionLevel(s.raw, r.from, r.to) : -Infinity;
            const rounded = Math.round(db);
            const text = Number.isFinite(db) && db > SILENT_DB ? `${rounded < 0 ? '−' : ''}${Math.abs(rounded)} dB` : '—';
            if (el.textContent !== text) {
              el.textContent = text;
              textBusy = true;
            }
          });
        }
        // Busy while there is sound or a curve still falling away; once both are gone the loop may sleep.
        return status === 'live' || showing || moved || textBusy;
      },
    },
    onScreen,
  );

  return (
    <div className={styles.spectrum}>
      <div className={styles.regions} role="group" aria-label="Level of the lows, mids and highs" data-hint-avoid="">
        {SPECTRUM_REGIONS.map((r, i) => (
          <span key={r.id} className={styles.region} style={{ '--x0': freqX(r.from), '--x1': freqX(r.to) } as CSSProperties}>
            <span className={styles.regionName}>{r.name}</span>
            <span
              className={`${styles.regionLevel} mono`}
              ref={(el) => {
                regionRefs.current[i] = el;
              }}
            >
              {'—'}
            </span>
          </span>
        ))}
      </div>
      <div ref={wrapRef} className={styles.plot}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          role="img"
          aria-label="Spectrum of the output: lows on the left (kick, bass), mids in the middle (chords, voices, leads), highs on the right (hats, air). Taller means more of that range."
        />
        {SPECTRUM_REGIONS.slice(1).map((r) => (
          <span key={r.id} className={styles.divider} style={{ '--x': freqX(r.from) } as CSSProperties} aria-hidden="true" />
        ))}
        <p ref={overlayRef} className={styles.overlay} data-state="off" data-testid="spectrum-overlay">
          {overlayText('off', false)}
        </p>
      </div>
      <div className={styles.axis} aria-hidden="true" data-hint-avoid="">
        {FREQ_LABELS.map(([f, t]) => (
          <span key={f} className={`${styles.freq} mono`} style={{ '--x': freqX(f) } as CSSProperties}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function draw(c: HTMLCanvasElement, bands: Float32Array, colors: { line: string; fill: string; grid: string; tint: string }): void {
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const w = c.width;
  const h = c.height;
  const dpr = w / Math.max(1, c.clientWidth || w);
  ctx.clearRect(0, 0, w, h);
  // The Mids region is tinted so the three regions read at a glance.
  ctx.fillStyle = colors.tint;
  ctx.globalAlpha = 0.45;
  ctx.fillRect(freqX(250) * w, 0, (freqX(4000) - freqX(250)) * w, h);
  ctx.globalAlpha = 1;
  // Frequency grid.
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = dpr;
  ctx.beginPath();
  for (const [f] of FREQ_LABELS) {
    const x = Math.round(freqX(f) * w) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  ctx.stroke();
  // Level curve.
  const n = bands.length;
  const y = (db: number) => {
    if (!Number.isFinite(db)) return h;
    const t = (db - FLOOR_DB) / (TOP_DB - FLOOR_DB);
    return h - Math.min(1, Math.max(0, t)) * h;
  };
  let any = false;
  for (let i = 0; i < n; i++) if (Number.isFinite(bands[i]) && bands[i] > FLOOR_DB) any = true;
  if (!any) return;
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i < n; i++) ctx.lineTo(((i + 0.5) / n) * w, y(bands[i]));
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = colors.fill;
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = ((i + 0.5) / n) * w;
    if (i === 0) ctx.moveTo(x, y(bands[i]));
    else ctx.lineTo(x, y(bands[i]));
  }
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 2 * dpr;
  ctx.lineJoin = 'round';
  ctx.stroke();
}
