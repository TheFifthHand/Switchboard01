/**
 * Meter — an LED bar meter for a real signal.
 *
 * It never re-renders React per frame. Every meter on screen shares one animation-frame loop
 * (meterScheduler): the loop polls each meter's `read()` (linear peak, 0..1+, e.g. from the
 * engine's meter frame) and draws at most 30 times a second, only when what is shown changed.
 *
 * Each meter draws its segments into one small canvas (no element per segment, no glow), inside a
 * CSS-contained box. A canvas redraw changes nothing in the page's paint or layer tree. (Measured
 * in the Mix view at 4x CPU: moving DOM layers with transforms, or resizing DOM rectangles, made
 * the browser re-layerize the whole page at every meter update, which cost about as much as the
 * old per-segment spans; redrawing a canvas does not.)
 *
 * Fast attack, ~24 dB/s release, a peak-hold segment, and a clip lamp that latches for 1.5 s when
 * the signal reaches ~0 dBFS (clipping is said in aria-valuetext too). The shared loop sleeps once
 * every meter is silent (see `meterWake`) and stops on unmount.
 *
 * `scale` maps dBFS to a position (0 = bottom, 1 = top), so a meter can share a fader's marks;
 * the default is linear in dB from `floorDb` to 0 dBFS. `peakHold` adds the highest peak as a
 * number under (or after) the meter: coral above −1 dBFS, a click resets it.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import { addMeterTask, meterWake } from './meterScheduler';
import styles from './Meter.module.css';

export { meterWake } from './meterScheduler';

export interface MeterProps {
  /** Returns the current linear peak (0..1, may exceed 1). */
  read: () => number;
  /** Accessible name, e.g. "Master level". */
  label: string;
  orientation?: 'horizontal' | 'vertical';
  segments?: number;
  /** Level at the bottom of the scale (default -48 dB). */
  floorDb?: number;
  /**
   * Position of a level on the meter (dBFS -> 0..1, 0 = bottom). Default: linear in dB from
   * `floorDb` to 0 dBFS. A Mix strip can pass the fader's taper so the meter lines up with its marks.
   */
  scale?: (db: number) => number;
  peakHoldMs?: number;
  /** Show the clip lamp (default true). */
  showClip?: boolean;
  /** Show the highest peak as a number (coral above −1 dBFS); a click resets it. */
  peakHold?: boolean;
  /** Length along the meter axis (CSS length; default fills the container). */
  length?: number | string;
  /** Thickness across the axis in px (default 8). */
  thickness?: number;
  className?: string;
}

export const METER_CLIP_LEVEL = 0.99;
/** The peak-hold number turns coral above this level (the output limiter's ceiling). */
export const METER_HOT_DB = -1;
const RELEASE_DB_PER_S = 24;
const PEAK_FALL_DB_PER_S = 30;
const CLIP_LATCH_MS = 1500;
const ARIA_INTERVAL_MS = 250;
/** Gap between segments, CSS px. */
const GAP_PX = 2;
const MINUS = '−';
const DASH = '—';

const clamp01 = (n: number) => (n > 1 ? 1 : n < 0 ? 0 : n);

/** The default scale: linear in dB from `floorDb` (0) to 0 dBFS (1). */
export function linearDbScale(floorDb: number): (db: number) => number {
  return (db) => clamp01((db - floorDb) / -floorDb);
}

/** First segment of each colour band: amber up to −12 dBFS, light amber up to −3, coral above (by each segment's top edge). */
function bandStarts(scale: (db: number) => number, segments: number): { mid: number; hi: number } {
  const at = (db: number) => Math.min(segments, Math.max(0, Math.floor(clamp01(scale(db)) * segments + 1e-9)));
  return { mid: at(-12), hi: at(-3) };
}

/** Lit segments for a level (0 at or below the floor). */
function litSegments(db: number, floorDb: number, scale: (db: number) => number, segments: number): number {
  if (!(db > floorDb)) return 0;
  return Math.min(segments, Math.max(1, Math.ceil(clamp01(scale(db)) * segments - 1e-9)));
}

/** "−6.2", "+0.4", "0.0" */
function peakText(db: number): string {
  const r = Math.round(db * 10) / 10;
  return `${r < 0 ? MINUS : r > 0 ? '+' : ''}${Math.abs(r).toFixed(1)}`;
}

interface Palette {
  off: string;
  lo: string;
  mid: string;
  hi: string;
}

/** The theme's colours for the segments, read from CSS (with the token values as fallbacks). */
function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return { off: v('--seg-off', '#b6bcc2'), lo: v('--amber', '#e39b2f'), mid: v('--amber-hi', '#f6c56b'), hi: v('--coral', '#dc5f47') };
}

/**
 * Draw `segments` LED segments into the canvas (device pixels): the first `lit` in their band's
 * colour, the `peak` segment lit too, the rest unlit. Gaps stay transparent (the meter's own
 * colour shows through).
 */
function drawSegments(ctx: CanvasRenderingContext2D, width: number, height: number, vertical: boolean, segments: number, lit: number, peak: number, bands: { mid: number; hi: number }, palette: Palette, dpr: number): void {
  ctx.clearRect(0, 0, width, height);
  const length = vertical ? height : width;
  // 2 px gaps while segments keep at least 1.5 px; a meter too short for them (the transport's)
  // gets 1-device-pixel gaps, then none.
  const room = length / segments;
  const gap = room >= (GAP_PX + 1.5) * dpr ? Math.max(1, Math.round(GAP_PX * dpr)) : room >= 3 ? 1 : 0;
  // Every segment the same pitch; the gap after the last one falls outside the canvas.
  const pitch = (length + gap) / segments;
  // Segments with softly rounded corners when there is room for them.
  const radius = gap > 1 && pitch - gap >= 3 * dpr ? dpr : 0;
  for (let i = 0; i < segments; i++) {
    const on = i < lit || i === peak;
    ctx.fillStyle = on ? (i >= bands.hi ? palette.hi : i >= bands.mid ? palette.mid : palette.lo) : palette.off;
    const a = Math.round(i * pitch);
    const b = Math.max(a + 1, Math.round((i + 1) * pitch) - gap);
    const [x, y, w, h] = vertical ? [0, height - b, width, b - a] : [a, 0, b - a, height];
    if (radius) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.fill();
    } else ctx.fillRect(x, y, w, h);
  }
}

export function Meter({
  read,
  label,
  orientation = 'horizontal',
  segments = orientation === 'vertical' ? 14 : 20,
  floorDb = -48,
  scale,
  peakHoldMs = 1200,
  showClip = true,
  peakHold = false,
  length,
  thickness = 8,
  className,
}: MeterProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clipRef = useRef<HTMLSpanElement>(null);
  const holdRef = useRef<HTMLButtonElement>(null);
  const holdTextRef = useRef<HTMLSpanElement>(null);
  const readRef = useRef(read);
  const scaleFn = useMemo(() => scale ?? linearDbScale(floorDb), [scale, floorDb]);
  const bands = useMemo(() => bandStarts(scaleFn, segments), [scaleFn, segments]);
  const vertical = orientation === 'vertical';
  const config = useRef({ scale: scaleFn, segments, floorDb, peakHoldMs, bands, label, vertical });
  /** Set when the configuration or the canvas size changed: the next write redraws everything. */
  const dirty = useRef(true);
  /** A click on the peak number asks the loop to forget the highest peak. */
  const resetHold = useRef(false);

  useEffect(() => {
    readRef.current = read;
    const c = config.current;
    if (c.scale !== scaleFn || c.segments !== segments || c.floorDb !== floorDb || c.label !== label || c.vertical !== vertical) dirty.current = true;
    config.current = { scale: scaleFn, segments, floorDb, peakHoldMs, bands, label, vertical };
  });

  // The canvas follows its box in device pixels (window size, zoom, the screen's pixel ratio).
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = devicePixelRatio || 1;
      const W = Math.max(1, Math.round(r.width * dpr));
      const H = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width === W && canvas.height === H) return;
      canvas.width = W;
      canvas.height = H;
      dirty.current = true;
      meterWake();
    };
    fit();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    ro?.observe(canvas);
    // A zoom or a move to another screen changes the pixel ratio without resizing the box.
    let mq: MediaQueryList | null = null;
    const onRatio = () => {
      fit();
      watchRatio();
    };
    const watchRatio = () => {
      mq?.removeEventListener('change', onRatio);
      mq = typeof matchMedia === 'undefined' ? null : matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
      mq?.addEventListener('change', onRatio);
    };
    watchRatio();
    return () => {
      ro?.disconnect();
      mq?.removeEventListener('change', onRatio);
    };
  }, []);

  useEffect(() => {
    let levelDb = -Infinity;
    let holdDb = -Infinity;
    let holdAt = 0;
    let clipUntil = 0;
    let maxDb = -Infinity;
    let shownLit = -1;
    let shownPeak = -2;
    let shownClip = false;
    let shownHold = '';
    let ariaAt = -Infinity;
    let ariaText = '';
    let ariaNow = '';
    let ctx: CanvasRenderingContext2D | null = null;
    let palette: Palette | null = null;

    const sample = (): number => {
      const peak = Number(readRef.current());
      return Number.isFinite(peak) && peak > 0 ? peak : 0;
    };

    const write = (now: number) => {
      const { scale: toPos, segments: n, floorDb: floor, bands: b, label: name, vertical: vert } = config.current;
      const canvas = canvasRef.current;
      if (dirty.current) {
        dirty.current = false;
        shownLit = -1;
        shownPeak = -2;
        shownHold = '';
        ariaAt = -Infinity;
        ariaText = '';
        ariaNow = '';
        palette = rootRef.current ? readPalette(rootRef.current) : null;
      }
      // Whole segments light, as on an LED meter, plus the held peak's segment.
      const lit = litSegments(levelDb, floor, toPos, n);
      const peakSeg = litSegments(holdDb, floor, toPos, n) - 1;
      if ((lit !== shownLit || peakSeg !== shownPeak) && canvas) {
        ctx ??= canvas.getContext('2d', { alpha: true });
        if (ctx && palette) drawSegments(ctx, canvas.width, canvas.height, vert, n, lit, peakSeg, b, palette, devicePixelRatio || 1);
        shownLit = lit;
        shownPeak = peakSeg;
      }
      const clip = now < clipUntil;
      if (clip !== shownClip && clipRef.current) {
        clipRef.current.dataset.on = clip ? '1' : '0';
        shownClip = clip;
      }
      const hold = holdRef.current;
      if (hold && holdTextRef.current) {
        const has = maxDb > floor;
        const text = has ? peakText(maxDb) : DASH;
        if (text !== shownHold) {
          shownHold = text;
          holdTextRef.current.textContent = text;
          hold.toggleAttribute('data-hot', has && maxDb > METER_HOT_DB);
          hold.setAttribute('aria-label', has ? `${name} peak: ${text} dB. Press to reset.` : `${name} peak: none yet.`);
        }
      }
      if (now - ariaAt >= ARIA_INTERVAL_MS && rootRef.current) {
        ariaAt = now;
        const above = levelDb > floor;
        const v = String(above ? Math.round(levelDb) : floor);
        const text = above ? `${v} dB${clip ? ', clipping' : ''}` : clip ? 'Silent, clipped a moment ago' : 'Silent';
        if (v !== ariaNow) {
          ariaNow = v;
          rootRef.current.setAttribute('aria-valuenow', v);
        }
        if (text !== ariaText) {
          ariaText = text;
          rootRef.current.setAttribute('aria-valuetext', text);
        }
      }
    };

    return addMeterTask({
      frame(now, dt, doWrite) {
        const { floorDb: floor, peakHoldMs: holdMs } = config.current;
        const peak = sample();
        const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
        levelDb = db >= levelDb ? db : Math.max(db, levelDb - RELEASE_DB_PER_S * dt);
        if (db >= holdDb) {
          holdDb = db;
          holdAt = now;
        } else if (now - holdAt > holdMs) {
          holdDb = Math.max(db, holdDb - PEAK_FALL_DB_PER_S * dt);
        }
        if (peak >= METER_CLIP_LEVEL) clipUntil = now + CLIP_LATCH_MS;
        if (resetHold.current) {
          resetHold.current = false;
          maxDb = -Infinity;
        }
        if (db > maxDb) maxDb = db;
        if (doWrite) write(now);
        // Busy while anything is above the floor, or the screen does not show the floor yet.
        const signal = levelDb > floor || holdDb > floor || now < clipUntil;
        const settled = !dirty.current && shownLit === 0 && shownPeak === -1 && !shownClip && ariaText === 'Silent';
        return signal || !settled;
      },
      probe() {
        const peak = sample();
        return peak > 0 && 20 * Math.log10(peak) > config.current.floorDb;
      },
    });
  }, []);

  const style: CSSProperties = { ['--thickness' as string]: `${thickness}px` };
  const sized: CSSProperties = length !== undefined ? (vertical ? { height: length } : { width: length }) : {};

  const meter = (
    <div
      ref={rootRef}
      className={[styles.meter, peakHold ? undefined : className].filter(Boolean).join(' ')}
      data-orientation={orientation}
      role="meter"
      aria-label={label}
      aria-valuemin={floorDb}
      aria-valuemax={0}
      aria-valuenow={floorDb}
      aria-valuetext="Silent"
      style={peakHold ? style : { ...style, ...sized }}
    >
      <canvas ref={canvasRef} className={styles.bar} data-meter-bar="" data-segments={segments} aria-hidden="true" />
      {showClip && <span ref={clipRef} className={styles.clip} data-meter-clip="" data-on="0" title="Clip: the signal reached full scale" aria-hidden="true" />}
    </div>
  );

  if (!peakHold) return meter;
  return (
    <div className={[styles.withPeak, className].filter(Boolean).join(' ')} data-orientation={orientation} style={sized}>
      {meter}
      <button
        ref={holdRef}
        type="button"
        className={styles.peakValue}
        data-meter-hold=""
        aria-label={`${label} peak: none yet.`}
        onClick={() => {
          resetHold.current = true;
          meterWake();
        }}
      >
        <span ref={holdTextRef} className={styles.peakText}>
          {DASH}
        </span>
      </button>
    </div>
  );
}
