/**
 * Meter — an LED bar meter for a real signal.
 *
 * It never re-renders React per frame: it polls `read()` (linear peak,
 * 0..1+, e.g. from the engine's meter frame) in its own requestAnimationFrame
 * loop and writes segment states straight to the DOM, only when they change.
 * Fast attack, ~24 dB/s release, a peak-hold segment, and a clip lamp that
 * latches for 1.5 s when the signal reaches ~0 dBFS. The loop stops on
 * unmount (and naturally pauses in background tabs).
 */
import { useEffect, useRef, type CSSProperties } from 'react';
import styles from './Meter.module.css';

export interface MeterProps {
  /** Returns the current linear peak (0..1, may exceed 1). */
  read: () => number;
  /** Accessible name, e.g. "Master level". */
  label: string;
  orientation?: 'horizontal' | 'vertical';
  segments?: number;
  /** Level at the bottom of the scale (default -48 dB). */
  floorDb?: number;
  peakHoldMs?: number;
  /** Show the clip lamp (default true). */
  showClip?: boolean;
  /** Length along the meter axis (CSS length; default fills the container). */
  length?: number | string;
  /** Thickness across the axis in px (default 8). */
  thickness?: number;
  className?: string;
}

export const METER_CLIP_LEVEL = 0.99;
const RELEASE_DB_PER_S = 24;
const PEAK_FALL_DB_PER_S = 30;
const CLIP_LATCH_MS = 1500;
const ARIA_INTERVAL_MS = 250;

/** Which colour band a segment belongs to (by its top edge in dB). */
function bandFor(topDb: number): 'lo' | 'mid' | 'hi' {
  if (topDb > -3) return 'hi';
  if (topDb > -12) return 'mid';
  return 'lo';
}

export function Meter({
  read,
  label,
  orientation = 'horizontal',
  segments = orientation === 'vertical' ? 14 : 20,
  floorDb = -48,
  peakHoldMs = 1200,
  showClip = true,
  length,
  thickness = 8,
  className,
}: MeterProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const segRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const clipRef = useRef<HTMLSpanElement>(null);
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let levelDb = -Infinity;
    let holdDb = -Infinity;
    let holdAt = 0;
    let clipUntil = 0;
    let shownLit = -1;
    let shownPeak = -2;
    let shownClip = false;
    let ariaAt = 0;
    const span = -floorDb;

    const segFor = (db: number) => {
      if (!(db > floorDb)) return 0;
      return Math.min(segments, Math.ceil(((db - floorDb) / span) * segments));
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
      last = now;
      let peak = Number(readRef.current());
      if (!Number.isFinite(peak) || peak < 0) peak = 0;
      const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;

      levelDb = db >= levelDb ? db : Math.max(db, levelDb - RELEASE_DB_PER_S * dt);
      if (db >= holdDb) {
        holdDb = db;
        holdAt = now;
      } else if (now - holdAt > peakHoldMs) {
        holdDb = Math.max(db, holdDb - PEAK_FALL_DB_PER_S * dt);
      }
      if (peak >= METER_CLIP_LEVEL) clipUntil = now + CLIP_LATCH_MS;

      const lit = segFor(levelDb);
      const peakSeg = holdDb > floorDb ? segFor(holdDb) - 1 : -1;
      if (lit !== shownLit || peakSeg !== shownPeak) {
        for (let i = 0; i < segments; i++) {
          const el = segRefs.current[i];
          if (!el) continue;
          const on = i < lit || i === peakSeg;
          if ((el.dataset.on === '1') !== on) el.dataset.on = on ? '1' : '0';
        }
        shownLit = lit;
        shownPeak = peakSeg;
      }
      const clip = now < clipUntil;
      if (clip !== shownClip && clipRef.current) {
        clipRef.current.dataset.on = clip ? '1' : '0';
        shownClip = clip;
      }
      if (now - ariaAt > ARIA_INTERVAL_MS && rootRef.current) {
        ariaAt = now;
        const v = levelDb > floorDb ? Math.round(levelDb) : floorDb;
        rootRef.current.setAttribute('aria-valuenow', String(v));
        rootRef.current.setAttribute('aria-valuetext', levelDb > floorDb ? `${v} dB${clip ? ', clipping' : ''}` : 'Silent');
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [segments, floorDb, peakHoldMs]);

  const segs = [];
  for (let i = 0; i < segments; i++) {
    const topDb = floorDb + ((i + 1) / segments) * -floorDb;
    segs.push(
      <span
        key={i}
        ref={(el) => {
          segRefs.current[i] = el;
        }}
        className={styles.seg}
        data-band={bandFor(topDb)}
        data-on="0"
      />,
    );
  }

  const style: CSSProperties = {
    ['--thickness' as string]: `${thickness}px`,
    ...(length !== undefined ? (orientation === 'vertical' ? { height: length } : { width: length }) : {}),
  };

  return (
    <div
      ref={rootRef}
      className={[styles.meter, className].filter(Boolean).join(' ')}
      data-orientation={orientation}
      role="meter"
      aria-label={label}
      aria-valuemin={floorDb}
      aria-valuemax={0}
      aria-valuenow={floorDb}
      aria-valuetext="Silent"
      style={style}
    >
      <span className={styles.track}>{segs}</span>
      {showClip && (
        <span ref={clipRef} className={styles.clip} data-on="0" title="Clip: the signal reached full scale">
          <span className={styles.clipText}>Clip</span>
        </span>
      )}
    </div>
  );
}
