/**
 * The sampler's waveform display with draggable Start and End trim handles.
 *
 * - Drawn on a canvas at the device pixel ratio (crisp on any display and
 *   zoom level) from the recording's min/max overview.
 * - The region that plays is drawn in amber (audio signal) and shaped by the
 *   edge fades exactly as the engine applies them; the rest of the file is
 *   grey and hatched. Fade ramps are drawn at the region edges.
 * - Handles (teal = selection) are real sliders: drag them (Shift = fine),
 *   press anywhere on the waveform to move the nearest one there, use the
 *   arrow keys (Shift = fine, PageUp/PageDown = 10%, Home/End), or
 *   double-click to reset. End always stays after Start (5 ms minimum).
 * - Every change goes through session.setInstrumentParam with one gesture id
 *   per drag / key burst, so a trim is one undo step and Record Performance
 *   captures it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Tooltip, newGestureId, useElementSize } from '../../../ui/components';
import type { Id } from '../../../project/types';
import { session, useProject } from '../../instance';
import type { OverviewStatus, SampleOverview } from './sampleOverview';
import { clamp, clampTrim, edgeFades, edgeGain, formatTime, rootRate, type EdgeFades } from './samplerMath';
import { readSamplerValues, useSamplerController, useSamplerValues } from './samplerValues';
import styles from './WaveformTrim.module.css';

type Handle = 'start' | 'end';

const WAVE_IDS = ['start', 'end', 'fadeIn', 'fadeOut', 'mode', 'pitch', 'fine', 'sync', 'originalBpm', 'rootNote'] as const;
const TRIM_IDS = ['start', 'end'] as const;

/** Arrow-key steps as fractions of the file. */
const KEY_STEP = 0.01;
const KEY_FINE_STEP = 0.001;
const KEY_PAGE_STEP = 0.1;
const BURST_IDLE_MS = 700;
/** Shift-drag moves the handle this much slower. */
const FINE_DRAG = 0.1;
/** Below this region width (CSS px) the End flag sits at the bottom so it never covers the Start flag. */
const NARROW_REGION_PX = 40;

export interface WaveformTrimProps {
  trackId: Id;
  /** Recording name (for the accessible description). */
  name: string;
  overview: SampleOverview | null;
  status: OverviewStatus;
  /** File length in seconds (from the overview or the recording's metadata). */
  duration: number;
}

interface DragState {
  pointerId: number;
  which: Handle;
  value: number;
  lastX: number;
  gesture: string;
  pending: number | null;
  raf: number;
}

function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    const listen = () => {
      mq?.removeEventListener('change', onChange);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener('change', onChange);
    };
    function onChange() {
      setDpr(window.devicePixelRatio || 1);
      listen();
    }
    listen();
    return () => mq?.removeEventListener('change', onChange);
  }, []);
  return dpr;
}

interface Palette {
  signal: string;
  signalEdge: string;
  ghost: string;
  idle: string;
  grid: string;
  window: string;
  ramp: string;
}

function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    signal: v('--wave-signal', '#e39b2f'),
    signalEdge: v('--wave-signal-edge', '#b86f0f'),
    ghost: v('--wave-ghost', 'rgba(227, 155, 47, 0.28)'),
    idle: v('--wave-idle', 'rgba(108, 115, 123, 0.5)'),
    grid: v('--wave-grid', 'rgba(38, 41, 45, 0.08)'),
    window: v('--wave-window', 'rgba(255, 255, 255, 0.5)'),
    ramp: v('--wave-ramp', 'rgba(38, 41, 45, 0.6)'),
  };
}

/** A time grid step that gives 4-12 lines across the file. */
function gridStep(duration: number): number {
  for (const s of [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30]) if (duration / s <= 12) return s;
  return 60;
}

interface DrawInput {
  width: number;
  height: number;
  dpr: number;
  overview: SampleOverview | null;
  lo: number;
  hi: number;
  fades: EdgeFades;
}

function drawWave(canvas: HTMLCanvasElement, input: DrawInput, pal: Palette): void {
  const { width: w, height: h, dpr, overview, lo, hi, fades } = input;
  const W = Math.max(1, Math.round(w * dpr));
  const H = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (w < 4 || h < 4) return;
  const px = 1 / dpr;
  const crisp = (x: number) => Math.round(x * dpr) / dpr + px / 2;
  const sx = lo * w;
  const ex = hi * w;

  // The region that plays: a lighter window.
  g.fillStyle = pal.window;
  g.fillRect(sx, 0, Math.max(0, ex - sx), h);

  if (!overview || overview.peaks.length < 2 || !(overview.duration > 0)) return;
  const { peaks, duration } = overview;

  // Time grid and centre line.
  g.strokeStyle = pal.grid;
  g.lineWidth = px;
  g.beginPath();
  const step = gridStep(duration);
  for (let t = step; t < duration - step * 0.05; t += step) {
    const x = crisp((t / duration) * w);
    g.moveTo(x, 0);
    g.lineTo(x, h);
  }
  const mid = h / 2;
  g.moveTo(0, crisp(mid));
  g.lineTo(w, crisp(mid));
  g.stroke();

  // One min/max per device-pixel column. Each column also takes in its neighbouring bins, so a
  // bin that holds only part of a cycle never shows as a stripe: the outline stays continuous.
  const n = Math.floor(peaks.length / 2);
  const cols = Math.max(2, Math.round(w * dpr));
  const colMin = new Float32Array(cols);
  const colMax = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const a = Math.max(0, Math.floor((c * n) / cols) - 1);
    const b = Math.min(n, Math.ceil(((c + 1) * n) / cols) + 1);
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = a; i < b; i++) {
      if (peaks[2 * i] < mn) mn = peaks[2 * i];
      if (peaks[2 * i + 1] > mx) mx = peaks[2 * i + 1];
    }
    colMin[c] = mn === Infinity ? 0 : mn;
    colMax[c] = mx === -Infinity ? 0 : mx;
  }
  const pad = 6;
  const amp = Math.max(1, h / 2 - pad);
  const regionStart = lo * duration;
  const trace = (gain: ((c: number) => number) | null) => {
    g.beginPath();
    const bottom: [number, number][] = [];
    for (let c = 0; c < cols; c++) {
      const x = ((c + 0.5) / cols) * w;
      const k = gain ? gain(c) : 1;
      let top = mid - colMax[c] * amp * k;
      let bot = mid - colMin[c] * amp * k;
      // Keep silence visible as a hairline.
      if (bot - top < px) {
        const c = (top + bot) / 2;
        top = c - px / 2;
        bot = c + px / 2;
      }
      if (c === 0) g.moveTo(0, top);
      g.lineTo(x, top);
      bottom.push([x, bot]);
    }
    g.lineTo(w, bottom[bottom.length - 1][1]);
    for (let i = bottom.length - 1; i >= 0; i--) g.lineTo(bottom[i][0], bottom[i][1]);
    g.lineTo(0, bottom[0][1]);
    g.closePath();
  };

  // Outside the region: grey.
  g.save();
  g.beginPath();
  g.rect(0, 0, sx, h);
  g.rect(ex, 0, w - ex, h);
  g.clip();
  trace(null);
  g.fillStyle = pal.idle;
  g.fill();
  g.restore();

  // Inside: the unfaded ghost, then the signal as it is heard (edge fades applied).
  g.save();
  g.beginPath();
  g.rect(sx, 0, Math.max(0, ex - sx), h);
  g.clip();
  const faded = fades.fadeIn > 0 || fades.fadeOut > 0;
  if (faded) {
    trace(null);
    g.fillStyle = pal.ghost;
    g.fill();
  }
  trace((c) => edgeGain(((c + 0.5) / cols) * duration - regionStart, fades));
  // Deeper amber at the extremes, brighter at the centre line: reads as a lit signal, not a flat block.
  const fill = g.createLinearGradient(0, mid - amp, 0, mid + amp);
  fill.addColorStop(0, pal.signalEdge);
  fill.addColorStop(0.5, pal.signal);
  fill.addColorStop(1, pal.signalEdge);
  g.fillStyle = fill;
  g.fill();
  g.restore();

  // Fade ramps at the region edges.
  const toX = (seconds: number) => ((regionStart + seconds) / duration) * w;
  g.strokeStyle = pal.ramp;
  g.lineWidth = 1.25;
  g.lineJoin = 'round';
  g.beginPath();
  if (toX(fades.fadeIn) - sx >= 1.5) {
    g.moveTo(sx, h - 2);
    g.lineTo(toX(fades.fadeIn), 2);
  }
  if (fades.fadeOut > 0 && toX(fades.zeroAt) - toX(fades.zeroAt - fades.fadeOut) >= 1.5) {
    g.moveTo(toX(fades.zeroAt - fades.fadeOut), 2);
    g.lineTo(toX(fades.zeroAt), h - 2);
  }
  g.stroke();
}

export function WaveformTrim({ trackId, name, overview, status, duration }: WaveformTrimProps) {
  const v = useSamplerValues(trackId, WAVE_IDS);
  const bpm = useProject((p) => p.bpm);
  const startCtl = useSamplerController(trackId, 'start');
  const endCtl = useSamplerController(trackId, 'end');
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRefs = useRef<Record<Handle, HTMLDivElement | null>>({ start: null, end: null });
  const drag = useRef<DragState | null>(null);
  const burst = useRef<{ which: Handle; gesture: string; at: number } | null>(null);
  const [dragging, setDragging] = useState<Handle | null>(null);
  const size = useElementSize(boxRef);
  const dpr = useDevicePixelRatio();

  const lo = Math.min(v.start, v.end);
  const hi = Math.max(v.start, v.end);
  const loop = v.mode === 1;
  const regionLen = (hi - lo) * duration;
  const fades = edgeFades(regionLen, v.fadeIn, v.fadeOut, rootRate(v, bpm), loop);
  const controller: Record<Handle, string | null> = { start: startCtl, end: endCtl };
  const usable = duration > 0;
  // Flags are 17 px wide: in a region narrower than two flags the End flag moves to the bottom, so both stay grabbable.
  const narrow = (hi - lo) * size.width < NARROW_REGION_PX;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    drawWave(canvas, { width: size.width, height: size.height, dpr, overview, lo, hi, fades }, readPalette(box));
    // fades is derived from the values listed here.
  }, [overview, size.width, size.height, dpr, lo, hi, fades.fadeIn, fades.fadeOut, fades.zeroAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Never leave a drag frame pending after unmount.
  useEffect(
    () => () => {
      const d = drag.current;
      if (d?.raf) cancelAnimationFrame(d.raf);
      drag.current = null;
    },
    [],
  );

  /** Apply a trim position, keeping end > start (reads the latest project, not render-time props). */
  const commit = (which: Handle, value: number, gesture: string) => {
    const cur = readSamplerValues(session.store.getState(), trackId, TRIM_IDS);
    const next = clampTrim(which, value, which === 'start' ? cur.end : cur.start, duration);
    if (Math.abs(next - cur[which]) < 1e-7) return;
    session.setInstrumentParam(trackId, which, next, gesture);
  };

  const flush = (d: DragState) => {
    if (d.raf) cancelAnimationFrame(d.raf);
    d.raf = 0;
    if (d.pending !== null) {
      const value = d.pending;
      d.pending = null;
      commit(d.which, value, d.gesture);
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !usable) return;
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    if (rect.width <= 0) return;
    const onHandle = (e.target as Element).closest<HTMLElement>('[data-handle]');
    const frac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const cur = readSamplerValues(session.store.getState(), trackId, TRIM_IDS);
    let which: Handle;
    if (onHandle) which = onHandle.dataset.handle === 'end' ? 'end' : 'start';
    else if (frac <= Math.min(cur.start, cur.end)) which = 'start';
    else if (frac >= Math.max(cur.start, cur.end)) which = 'end';
    else which = Math.abs(frac - cur.start) <= Math.abs(frac - cur.end) ? 'start' : 'end';
    e.preventDefault();
    handleRefs.current[which]?.focus({ preventScroll: true });
    if (controller[which]) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    burst.current = null;
    const d: DragState = { pointerId: e.pointerId, which, value: onHandle ? cur[which] : frac, lastX: e.clientX, gesture: newGestureId('trim'), pending: null, raf: 0 };
    drag.current = d;
    setDragging(which);
    if (!onHandle) commit(which, frac, d.gesture);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const box = boxRef.current;
    if (!d || !box || e.pointerId !== d.pointerId) return;
    const width = box.getBoundingClientRect().width;
    if (width <= 0) return;
    const dx = e.clientX - d.lastX;
    d.lastX = e.clientX;
    d.value = clamp(d.value + (dx / width) * (e.shiftKey ? FINE_DRAG : 1), 0, 1);
    d.pending = d.value;
    if (!d.raf) {
      d.raf = requestAnimationFrame(() => {
        d.raf = 0;
        if (drag.current === d) flush(d);
      });
    }
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    flush(d);
    drag.current = null;
    setDragging(null);
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const keyGesture = (which: Handle): string => {
    const now = performance.now();
    const b = burst.current;
    if (b && b.which === which && now - b.at < BURST_IDLE_MS) {
      b.at = now;
      return b.gesture;
    }
    const gesture = newGestureId('trim-key');
    burst.current = { which, gesture, at: now };
    return gesture;
  };

  const onHandleKey = (which: Handle) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (!usable || controller[which]) return;
    const cur = readSamplerValues(session.store.getState(), trackId, TRIM_IDS)[which];
    let target: number;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        target = cur - (e.shiftKey ? KEY_FINE_STEP : KEY_STEP);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        target = cur + (e.shiftKey ? KEY_FINE_STEP : KEY_STEP);
        break;
      case 'PageDown':
        target = cur - KEY_PAGE_STEP;
        break;
      case 'PageUp':
        target = cur + KEY_PAGE_STEP;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = 1;
        break;
      case 'Delete':
      case 'Backspace':
        target = which === 'start' ? 0 : 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    commit(which, target, keyGesture(which));
  };

  const reset = (which: Handle) => {
    if (!usable || controller[which]) return;
    commit(which, which === 'start' ? 0 : 1, newGestureId('trim-reset'));
  };

  const handle = (which: Handle) => {
    const pos = which === 'start' ? v.start : v.end;
    const ctl = controller[which];
    const label = which === 'start' ? 'Trim start' : 'Trim end';
    const valueText = usable ? `${formatTime(pos * duration, duration)} (${Math.round(pos * 100)}% of the recording)${ctl ? `, set by ${ctl}` : ''}` : 'No recording';
    return (
      <Tooltip
        key={which}
        name={which === 'start' ? 'Start' : 'End'}
        tip={
          ctl
            ? `The ${ctl} macro moves this point. Remove that mapping in Macros to trim by hand.`
            : which === 'start'
              ? 'Where playback begins. Drag it, or press on the waveform to move the nearest handle there.'
              : 'Where playback stops. It always stays after Start.'
        }
        detail="Arrow keys nudge (Shift = fine), Page Up/Down move 10%, double-click resets."
      >
        <div
          ref={(el) => {
            handleRefs.current[which] = el;
          }}
          role="slider"
          tabIndex={0}
          aria-label={label}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pos * 1000) / 10}
          aria-valuetext={valueText}
          aria-readonly={ctl ? true : undefined}
          aria-disabled={!usable || undefined}
          data-handle={which}
          data-dragging={dragging === which || undefined}
          data-readonly={ctl ? true : undefined}
          className={styles.handle}
          style={{ left: `${pos * 100}%` }}
          onKeyDown={onHandleKey(which)}
          onDoubleClick={() => reset(which)}
        >
          <span className={styles.line} aria-hidden="true" />
          <span className={styles.flag} aria-hidden="true">
            {which === 'start' ? 'S' : 'E'}
          </span>
        </div>
      </Tooltip>
    );
  };

  const message =
    status === 'loading'
      ? 'Loading the waveform…'
      : status === 'missing'
        ? 'This recording’s audio is not stored in this browser, so it cannot play or be drawn. Import the project file again to restore it.'
        : null;

  return (
    <div
      ref={boxRef}
      className={styles.wave}
      role="group"
      aria-label={`Waveform of ${name}. Drag Start and End to trim.`}
      data-dragging={dragging ?? undefined}
      data-empty={!usable || undefined}
      data-narrow={narrow || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
    >
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      <div className={styles.shade} style={{ left: 0, width: `${lo * 100}%` }} aria-hidden="true" />
      <div className={styles.shade} style={{ left: `${hi * 100}%`, right: 0 }} aria-hidden="true" />
      {loop && usable && (
        <div className={styles.loop} style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} aria-hidden="true">
          <span className={styles.loopLabel}>Loop</span>
        </div>
      )}
      {message && (
        <p className={styles.message} role="status">
          {message}
        </p>
      )}
      {handle('start')}
      {handle('end')}
    </div>
  );
}
