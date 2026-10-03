/**
 * The sampler's waveform display with draggable Start and End trim handles.
 *
 * - Drawn on a canvas at the device pixel ratio (crisp on any display and
 *   zoom level): from the recording's min/max overview, and close up from
 *   its decoded audio (sampleDetail.ts).
 * - The region that plays is drawn in amber (audio signal) and shaped by the
 *   edge fades exactly as the engine applies them; the rest of the file is
 *   grey and hatched. Fade ramps are drawn at the region edges; in Loop
 *   mode a crossfade mark shows where the loop's end blends into its start.
 * - Zoom (shape-14): Ctrl/⌘+wheel and a two-finger pinch zoom around the
 *   pointer, − and + zoom around the handle used last; a sideways wheel
 *   (or Shift+wheel) scrolls a zoomed view. The overview strip beside the
 *   zoom keys shows the whole recording with the visible window, which
 *   drags (or moves with the arrow keys) to scroll. A plain wheel never
 *   changes anything.
 * - Handles (teal = selection) are real sliders with 32 px targets: drag
 *   them (Shift = snap to the nearest hit; with Tempo Sync on, to whole
 *   beats from the other handle; Alt = fine), press anywhere on the
 *   waveform to move the nearest one there (a handle beyond a zoomed view
 *   waits at that edge, and comes to the pointer when pressed), use the arrow keys (Shift =
 *   fine, PageUp/PageDown = 10% of the view, Home/End), or double-click to
 *   reset. End always stays after Start (5 ms minimum).
 * - It trims the editor's target (samplerTarget.ts): the selected clip's
 *   own recording region (cmd.setClipSampleRegion), or the part's Start and
 *   End through session.setInstrumentParam (recordable by Record
 *   Performance), with one gesture id per drag / key burst, so a trim is
 *   one undo step.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { IconButton, Tooltip, newGestureId, useElementSize } from '../../../ui/components';
import type { Id } from '../../../project/types';
import { session, useProject } from '../../instance';
import type { OverviewStatus, SampleOverview } from './sampleOverview';
import { useSampleDetail, type SampleDetail } from './sampleDetail';
import {
  FULL_VIEW,
  clamp,
  clampTrim,
  edgeFades,
  edgeGain,
  formatTime,
  minViewSpan,
  nearestWithin,
  panView,
  placeView,
  revealInView,
  rootRate,
  snapToGrid,
  zoomView,
  type EdgeFades,
  type WaveView,
} from './samplerMath';
import { readTargetValues, setTargetValue, useTargetController, useTargetValues, type SamplerTarget } from './samplerTarget';
import styles from './WaveformTrim.module.css';

type Handle = 'start' | 'end';

const WAVE_IDS = ['start', 'end', 'fadeIn', 'fadeOut', 'mode', 'pitch', 'fine', 'sync', 'originalBpm', 'rootNote'] as const;
const TRIM_IDS = ['start', 'end'] as const;

/** Arrow-key steps as fractions of the visible window. */
const KEY_STEP = 0.01;
const KEY_FINE_STEP = 0.001;
const KEY_PAGE_STEP = 0.1;
const BURST_IDLE_MS = 700;
/** Alt-drag moves the handle this much slower. */
const FINE_DRAG = 0.1;
/** Below this region width (CSS px) the End flag sits at the bottom so it never covers the Start flag. */
const NARROW_REGION_PX = 40;
/** Shift-drag snaps to a hit this near the pointer (CSS px). */
const SNAP_PX = 40;
/** One press of − or +. */
const ZOOM_STEP = 2;
/** Wheel distance (px) for doubling the zoom. */
const WHEEL_PER_DOUBLING = 240;

export interface WaveformTrimProps {
  /** What is trimmed: the selected clip's own recording, or the part's. */
  target: Pick<SamplerTarget, 'trackId' | 'slot' | 'kind'>;
  /** The recording drawn (for its close-up audio and hits). */
  sampleId: Id;
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
  /** Where the pointer has taken the handle (unsnapped). */
  value: number;
  /** The handle's position when the drag began (a pinch puts it back). */
  from: number;
  lastX: number;
  gesture: string;
  pending: number | null;
  raf: number;
}

interface PinchState {
  ids: [number, number];
  startDist: number;
  startSpan: number;
  /** The point of the file under the fingers' midpoint when the pinch began. */
  anchor: number;
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
  hit: string;
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
    hit: v('--wave-hit', 'rgba(13, 120, 112, 0.8)'),
  };
}

/** A time grid step that gives 4-12 lines across `seconds`. */
function gridStep(seconds: number): number {
  for (const s of [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30]) if (seconds / s <= 12) return s;
  return 60;
}

interface DrawInput {
  width: number;
  height: number;
  dpr: number;
  overview: SampleOverview | null;
  detail: SampleDetail | null;
  view: WaveView;
  lo: number;
  hi: number;
  fades: EdgeFades;
  /** Hits to mark (seconds), while a Shift-drag snaps to them. */
  hits: readonly number[] | null;
}

/**
 * Min/max of every device-pixel column of the visible window: from the
 * overview while it has at least one point per column, else from the
 * decoded audio (close up), else the overview stretched.
 */
function columnPeaks(cols: number, view: WaveView, overview: SampleOverview, detail: SampleDetail | null): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(cols);
  const max = new Float32Array(cols);
  const span = view.b - view.a;
  const n = Math.floor(overview.peaks.length / 2);
  if (detail && detail.channels.length && span * n < cols) {
    const chans = detail.channels;
    const len = chans[0].length;
    for (let c = 0; c < cols; c++) {
      const i0 = Math.floor((view.a + (c / cols) * span) * len);
      const i1 = Math.max(i0 + 1, Math.ceil((view.a + ((c + 1) / cols) * span) * len));
      let mn = Infinity;
      let mx = -Infinity;
      // One sample more on each side keeps the outline joined when a column holds under one sample.
      for (let i = Math.max(0, i0 - 1); i < Math.min(len, i1 + 1); i++) {
        for (const ch of chans) {
          const x = ch[i];
          if (x < mn) mn = x;
          if (x > mx) mx = x;
        }
      }
      min[c] = mn === Infinity ? 0 : mn;
      max[c] = mx === -Infinity ? 0 : mx;
    }
    return { min, max };
  }
  // Each column also takes in its neighbouring bins, so a bin that holds only part of a cycle never shows
  // as a stripe: the outline stays continuous.
  const peaks = overview.peaks;
  for (let c = 0; c < cols; c++) {
    const a = Math.max(0, Math.floor((view.a + (c / cols) * span) * n) - 1);
    const b = Math.min(n, Math.ceil((view.a + ((c + 1) / cols) * span) * n) + 1);
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = a; i < b; i++) {
      if (peaks[2 * i] < mn) mn = peaks[2 * i];
      if (peaks[2 * i + 1] > mx) mx = peaks[2 * i + 1];
    }
    min[c] = mn === Infinity ? 0 : mn;
    max[c] = mx === -Infinity ? 0 : mx;
  }
  return { min, max };
}

function drawWave(canvas: HTMLCanvasElement, input: DrawInput, pal: Palette): void {
  const { width: w, height: h, dpr, overview, detail, view, lo, hi, fades, hits } = input;
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
  const span = Math.max(1e-9, view.b - view.a);
  const xOf = (f: number) => ((f - view.a) / span) * w;
  const sx = clamp(xOf(lo), 0, w);
  const ex = clamp(xOf(hi), 0, w);

  // The region that plays: a lighter window.
  g.fillStyle = pal.window;
  g.fillRect(sx, 0, Math.max(0, ex - sx), h);

  if (!overview || overview.peaks.length < 2 || !(overview.duration > 0)) return;
  const duration = overview.duration;
  const fileX = (seconds: number) => xOf(seconds / duration);

  // Time grid (in steps that suit the visible length) and centre line.
  g.strokeStyle = pal.grid;
  g.lineWidth = px;
  g.beginPath();
  const step = gridStep(span * duration);
  for (let t = Math.ceil((view.a * duration) / step + 1e-9) * step; t < view.b * duration - step * 0.05; t += step) {
    if (t <= 0) continue;
    const x = crisp(fileX(t));
    g.moveTo(x, 0);
    g.lineTo(x, h);
  }
  const mid = h / 2;
  g.moveTo(0, crisp(mid));
  g.lineTo(w, crisp(mid));
  g.stroke();

  const cols = Math.max(2, Math.round(w * dpr));
  const { min: colMin, max: colMax } = columnPeaks(cols, view, overview, detail);
  const pad = 6;
  const amp = Math.max(1, h / 2 - pad);
  const regionStart = lo * duration;
  const colSeconds = (c: number) => (view.a + ((c + 0.5) / cols) * span) * duration;
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
        const m = (top + bot) / 2;
        top = m - px / 2;
        bot = m + px / 2;
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
  if (ex > sx) {
    g.save();
    g.beginPath();
    g.rect(sx, 0, ex - sx, h);
    g.clip();
    if (fades.fadeIn > 0 || fades.fadeOut > 0) {
      trace(null);
      g.fillStyle = pal.ghost;
      g.fill();
    }
    trace((c) => edgeGain(colSeconds(c) - regionStart, fades));
    // Deeper amber at the extremes, brighter at the centre line: reads as a lit signal, not a flat block.
    const fill = g.createLinearGradient(0, mid - amp, 0, mid + amp);
    fill.addColorStop(0, pal.signalEdge);
    fill.addColorStop(0.5, pal.signal);
    fill.addColorStop(1, pal.signalEdge);
    g.fillStyle = fill;
    g.fill();
    g.restore();
  }

  // Fade ramps at the region edges.
  const toX = (seconds: number) => fileX(regionStart + seconds);
  const startX = xOf(lo);
  g.strokeStyle = pal.ramp;
  g.lineWidth = 1.25;
  g.lineJoin = 'round';
  g.beginPath();
  if (toX(fades.fadeIn) - startX >= 1.5) {
    g.moveTo(startX, h - 2);
    g.lineTo(toX(fades.fadeIn), 2);
  }
  if (fades.fadeOut > 0 && toX(fades.zeroAt) - toX(fades.zeroAt - fades.fadeOut) >= 1.5) {
    g.moveTo(toX(fades.zeroAt - fades.fadeOut), 2);
    g.lineTo(toX(fades.zeroAt), h - 2);
  }
  // Loop: a crossfade mark where the end of the loop blends into its start.
  if (fades.seam > 0) {
    const x1 = toX(fades.zeroAt);
    const x0 = Math.min(x1 - 3, toX(fades.zeroAt - fades.seam));
    g.moveTo(x0, 2);
    g.lineTo(x1, h - 2);
    g.moveTo(x0, h - 2);
    g.lineTo(x1, 2);
  }
  g.stroke();

  // While a Shift-drag snaps: the hits it snaps to, as ticks top and bottom.
  if (hits?.length) {
    g.strokeStyle = pal.hit;
    g.lineWidth = 2;
    g.beginPath();
    for (const t of hits) {
      const x = fileX(t);
      if (x < -2 || x > w + 2) continue;
      g.moveTo(x, 0);
      g.lineTo(x, 9);
      g.moveTo(x, h - 9);
      g.lineTo(x, h);
    }
    g.stroke();
  }
}

/** The whole recording, small, for the overview strip (amber where it plays). */
function drawOverview(canvas: HTMLCanvasElement, width: number, height: number, dpr: number, overview: SampleOverview | null, lo: number, hi: number, pal: Palette): void {
  const W = Math.max(1, Math.round(width * dpr));
  const H = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);
  if (!overview || overview.peaks.length < 2 || width < 4) return;
  const cols = Math.max(2, Math.round(width * dpr));
  const { min, max } = columnPeaks(cols, FULL_VIEW, overview, null);
  const mid = height / 2;
  const amp = Math.max(1, height / 2 - 4);
  for (let c = 0; c < cols; c++) {
    const f = (c + 0.5) / cols;
    g.fillStyle = f >= lo && f <= hi ? pal.signalEdge : pal.idle;
    const top = mid - max[c] * amp;
    const bot = mid - min[c] * amp;
    g.fillRect(c / dpr, top, 1 / dpr, Math.max(1 / dpr, bot - top));
  }
}

export function WaveformTrim({ target, sampleId, name, overview, status, duration }: WaveformTrimProps) {
  const v = useTargetValues(target, WAVE_IDS);
  const bpm = useProject((p) => p.bpm);
  const startCtl = useTargetController(target, 'start');
  const endCtl = useTargetController(target, 'end');
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLDivElement>(null);
  const miniCanvasRef = useRef<HTMLCanvasElement>(null);
  const handleRefs = useRef<Record<Handle, HTMLDivElement | null>>({ start: null, end: null });
  const drag = useRef<DragState | null>(null);
  const pinch = useRef<PinchState | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const miniDrag = useRef<{ pointerId: number; grab: number } | null>(null);
  const burst = useRef<{ which: Handle; gesture: string; at: number } | null>(null);
  const lastHandle = useRef<Handle>('start');
  const [dragging, setDragging] = useState<Handle | null>(null);
  const [snapping, setSnapping] = useState(false);
  const [viewState, setViewState] = useState<{ key: string; view: WaveView }>({ key: sampleId, view: FULL_VIEW });
  // A zoom belongs to its recording: another recording opens whole.
  const view = viewState.key === sampleId ? viewState.view : FULL_VIEW;
  const viewRef = useRef(view);
  viewRef.current = view;
  const setView = (next: WaveView) => {
    viewRef.current = next;
    setViewState({ key: sampleId, view: next });
  };
  const span = view.b - view.a;
  const zoomed = span < 0.999;
  // Close-up audio and hits: once zoomed in, or for a snap.
  const [wantDetail, setWantDetail] = useState(false);
  const detail = useSampleDetail(sampleId, wantDetail || zoomed);
  const size = useElementSize(boxRef);
  const miniSize = useElementSize(miniRef);
  const dpr = useDevicePixelRatio();

  const lo = Math.min(v.start, v.end);
  const hi = Math.max(v.start, v.end);
  const loop = v.mode === 1;
  const sync = v.sync === 1;
  const regionLen = (hi - lo) * duration;
  const fades = edgeFades(regionLen, v.fadeIn, v.fadeOut, rootRate(v, bpm), loop);
  const controller: Record<Handle, string | null> = { start: startCtl, end: endCtl };
  const usable = duration > 0;
  const canZoomIn = usable && span > minViewSpan(duration) * 1.001;
  const canZoomOut = usable && zoomed;
  const xPct = (f: number) => ((f - view.a) / span) * 100;
  // Flags are 17 px wide: in a region narrower than two flags the End flag moves to the bottom, so both stay grabbable.
  const narrow = ((hi - lo) / span) * size.width < NARROW_REGION_PX;
  const zoomText = `${span > 0 ? Math.round(1 / span) : 1}×`;
  const hitsShown = snapping && !sync && detail ? detail.onsets : null;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    drawWave(canvas, { width: size.width, height: size.height, dpr, overview, detail, view, lo, hi, fades, hits: hitsShown }, readPalette(box));
    // fades is derived from the values listed here.
  }, [overview, detail, size.width, size.height, dpr, view.a, view.b, lo, hi, fades.fadeIn, fades.fadeOut, fades.zeroAt, fades.seam, hitsShown]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const canvas = miniCanvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    drawOverview(canvas, miniSize.width, miniSize.height, dpr, overview, lo, hi, readPalette(box));
  }, [overview, miniSize.width, miniSize.height, dpr, lo, hi]);

  // Never leave a drag frame pending after unmount.
  useEffect(
    () => () => {
      const d = drag.current;
      if (d?.raf) cancelAnimationFrame(d.raf);
      drag.current = null;
    },
    [],
  );

  // Ctrl/⌘+wheel (and a trackpad pinch, which arrives as one) zooms at the pointer; a sideways wheel
  // scrolls a zoomed view. Not a passive listener: the page must not zoom or scroll instead.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !usable) return;
    const onWheel = (e: WheelEvent) => {
      const rect = box.getBoundingClientRect();
      if (rect.width <= 0) return;
      const cur = viewRef.current;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.width : 1;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const at = cur.a + clamp((e.clientX - rect.left) / rect.width, 0, 1) * (cur.b - cur.a);
        const next = zoomView(cur, 2 ** (-(e.deltaY * unit) / WHEEL_PER_DOUBLING), at, duration);
        viewRef.current = next;
        setViewState({ key: sampleId, view: next });
        return;
      }
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (!sideways || cur.b - cur.a >= 0.999) return;
      e.preventDefault();
      const next = panView(cur, ((sideways * unit) / rect.width) * (cur.b - cur.a));
      viewRef.current = next;
      setViewState({ key: sampleId, view: next });
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [usable, sampleId, duration]);

  /** Apply a trim position, keeping end > start (reads the latest project, not render-time props). */
  const commit = (which: Handle, value: number, gesture: string) => {
    const cur = readTargetValues(session.store.getState(), target, TRIM_IDS);
    const next = clampTrim(which, value, which === 'start' ? cur.end : cur.start, duration);
    if (Math.abs(next - cur[which]) < 1e-7) return;
    setTargetValue(target, which, next, gesture);
  };

  /** Shift-drag: the nearest hit within reach (or, with Tempo Sync on, whole beats from the other handle). */
  const snapped = (which: Handle, value: number): number => {
    if (!(duration > 0)) return value;
    const cur = readTargetValues(session.store.getState(), target, ['start', 'end', 'originalBpm', 'sync'] as const);
    if (cur.sync === 1) {
      const beat = 60 / cur.originalBpm / duration;
      const anchor = which === 'start' ? cur.end : cur.start;
      const s = snapToGrid(value, anchor, beat);
      // At least one beat between the handles.
      return which === 'start' ? Math.min(s, anchor - beat) : Math.max(s, anchor + beat);
    }
    if (!detail) return value;
    const width = boxRef.current?.getBoundingClientRect().width ?? 0;
    const tol = width > 0 ? (SNAP_PX / width) * (viewRef.current.b - viewRef.current.a) : 0.02;
    return nearestWithin(value, detail.onsets.map((t) => t / duration), tol) ?? value;
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

  /** Pointer x → a point of the file. */
  const fracAt = (clientX: number): number | null => {
    const box = boxRef.current;
    if (!box) return null;
    const rect = box.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const cur = viewRef.current;
    return clamp(cur.a + ((clientX - rect.left) / rect.width) * (cur.b - cur.a), 0, 1);
  };

  const endHandleDrag = (el: HTMLElement | null, pointerId: number, revert: boolean) => {
    const d = drag.current;
    if (!d || d.pointerId !== pointerId) return;
    if (revert) {
      // A second finger: this was the start of a pinch, not a trim. Back where it was (the step goes away).
      if (d.raf) cancelAnimationFrame(d.raf);
      d.pending = null;
      d.raf = 0;
      commit(d.which, d.from, d.gesture);
    } else flush(d);
    drag.current = null;
    setDragging(null);
    setSnapping(false);
    // A finger that goes on into a pinch stays captured, so the pinch follows it anywhere.
    if (revert) return;
    try {
      if (el?.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!usable) return;
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size === 2) {
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic pointer */
        }
        const d = drag.current;
        if (d) endHandleDrag(e.currentTarget, d.pointerId, true);
        const [p1, p2] = [...touches.current.values()];
        const at = fracAt((p1.x + p2.x) / 2);
        const ids = [...touches.current.keys()] as [number, number];
        pinch.current = { ids, startDist: Math.max(8, Math.hypot(p1.x - p2.x, p1.y - p2.y)), startSpan: viewRef.current.b - viewRef.current.a, anchor: at ?? 0.5 };
        e.preventDefault();
        return;
      }
      if (touches.current.size > 2 || pinch.current) return;
    }
    if (e.button !== 0) return;
    const frac = fracAt(e.clientX);
    if (frac === null) return;
    const onHandle = (e.target as Element).closest<HTMLElement>('[data-handle]');
    const cur = readTargetValues(session.store.getState(), target, TRIM_IDS);
    let which: Handle;
    if (onHandle) which = onHandle.dataset.handle === 'end' ? 'end' : 'start';
    else if (frac <= Math.min(cur.start, cur.end)) which = 'start';
    else if (frac >= Math.max(cur.start, cur.end)) which = 'end';
    else which = Math.abs(frac - cur.start) <= Math.abs(frac - cur.end) ? 'start' : 'end';
    e.preventDefault();
    lastHandle.current = which;
    handleRefs.current[which]?.focus({ preventScroll: true });
    if (controller[which]) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    burst.current = null;
    // The hits a Shift-drag snaps to (at once when the live sample bank has the audio).
    setWantDetail(true);
    // A handle waiting at the edge of a zoomed view (it lies beyond it) comes to the pointer, as a press on the waveform does.
    const cv = viewRef.current;
    const offView = cur[which] < cv.a - 1e-9 || cur[which] > cv.b + 1e-9;
    const jump = !onHandle || offView;
    const d: DragState = { pointerId: e.pointerId, which, value: jump ? frac : cur[which], from: cur[which], lastX: e.clientX, gesture: newGestureId('trim'), pending: null, raf: 0 };
    drag.current = d;
    setDragging(which);
    if (jump) commit(which, e.shiftKey ? snapped(which, frac) : frac, d.gesture);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pz = pinch.current;
      if (pz) {
        const p1 = touches.current.get(pz.ids[0]);
        const p2 = touches.current.get(pz.ids[1]);
        const box = boxRef.current;
        if (!p1 || !p2 || !box) return;
        const rect = box.getBoundingClientRect();
        if (rect.width <= 0) return;
        const dist = Math.max(8, Math.hypot(p1.x - p2.x, p1.y - p2.y));
        const where = clamp(((p1.x + p2.x) / 2 - rect.left) / rect.width, 0, 1);
        // The point that was under the fingers stays under them: spreading zooms, moving both scrolls.
        setView(placeView(pz.startSpan / (dist / pz.startDist), pz.anchor, where, duration));
        return;
      }
    }
    const d = drag.current;
    const box = boxRef.current;
    if (!d || !box || e.pointerId !== d.pointerId) return;
    const width = box.getBoundingClientRect().width;
    if (width <= 0) return;
    const dx = e.clientX - d.lastX;
    d.lastX = e.clientX;
    d.value = clamp(d.value + (dx / width) * (viewRef.current.b - viewRef.current.a) * (e.altKey ? FINE_DRAG : 1), 0, 1);
    if (e.shiftKey !== snapping) setSnapping(e.shiftKey);
    d.pending = e.shiftKey ? snapped(d.which, d.value) : d.value;
    if (!d.raf) {
      d.raf = requestAnimationFrame(() => {
        d.raf = 0;
        if (drag.current === d) flush(d);
      });
    }
  };

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
      touches.current.delete(e.pointerId);
      const pz = pinch.current;
      if (pz) {
        // The pinch ends with its last finger; nothing is trimmed meanwhile.
        if (touches.current.size === 0) pinch.current = null;
        return;
      }
    }
    endHandleDrag(e.currentTarget, e.pointerId, false);
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
    const cur = readTargetValues(session.store.getState(), target, TRIM_IDS)[which];
    const s = viewRef.current.b - viewRef.current.a;
    let to: number;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        to = cur - (e.shiftKey ? KEY_FINE_STEP : KEY_STEP) * s;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        to = cur + (e.shiftKey ? KEY_FINE_STEP : KEY_STEP) * s;
        break;
      case 'PageDown':
        to = cur - KEY_PAGE_STEP * s;
        break;
      case 'PageUp':
        to = cur + KEY_PAGE_STEP * s;
        break;
      case 'Home':
        to = 0;
        break;
      case 'End':
        to = 1;
        break;
      case 'Delete':
      case 'Backspace':
        to = which === 'start' ? 0 : 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    lastHandle.current = which;
    commit(which, to, keyGesture(which));
    // The handle stays in sight.
    const now = readTargetValues(session.store.getState(), target, TRIM_IDS)[which];
    const shown = revealInView(viewRef.current, now);
    if (shown !== viewRef.current) setView(shown);
  };

  const reset = (which: Handle) => {
    if (!usable || controller[which]) return;
    commit(which, which === 'start' ? 0 : 1, newGestureId('trim-reset'));
  };

  /** − / +: around the handle used last (when in sight), else the middle of the view. */
  const zoomBy = (factor: number) => {
    const cur = viewRef.current;
    const pos = readTargetValues(session.store.getState(), target, TRIM_IDS)[lastHandle.current];
    const at = pos >= cur.a && pos <= cur.b ? pos : (cur.a + cur.b) / 2;
    setView(zoomView(cur, factor, at, duration));
  };

  /* Overview strip: drag the window to scroll; a press outside it centres it there. */
  const miniFrac = (clientX: number): number | null => {
    const el = miniRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 ? clamp((clientX - r.left) / r.width, 0, 1) : null;
  };
  const onMiniDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!usable || e.button !== 0 || !zoomed) return;
    const f = miniFrac(e.clientX);
    if (f === null) return;
    e.preventDefault();
    const cur = viewRef.current;
    let grab = f - cur.a;
    if (f < cur.a || f > cur.b) {
      const next = placeView(cur.b - cur.a, f, 0.5, duration);
      setView(next);
      grab = f - next.a;
    }
    miniDrag.current = { pointerId: e.pointerId, grab };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    e.currentTarget.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true });
  };
  const onMiniMove = (e: PointerEvent<HTMLDivElement>) => {
    const m = miniDrag.current;
    if (!m || m.pointerId !== e.pointerId) return;
    const f = miniFrac(e.clientX);
    if (f === null) return;
    const cur = viewRef.current;
    setView(panView(cur, f - m.grab - cur.a));
  };
  const onMiniEnd = (e: PointerEvent<HTMLDivElement>) => {
    const m = miniDrag.current;
    if (!m || m.pointerId !== e.pointerId) return;
    miniDrag.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };
  const onMiniKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = viewRef.current;
    const s = cur.b - cur.a;
    let next: WaveView | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = panView(cur, -s * (e.shiftKey ? 0.02 : 0.1));
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = panView(cur, s * (e.shiftKey ? 0.02 : 0.1));
    else if (e.key === 'PageDown') next = panView(cur, -s);
    else if (e.key === 'PageUp') next = panView(cur, s);
    else if (e.key === 'Home') next = panView(cur, -1);
    else if (e.key === 'End') next = panView(cur, 1);
    else if (e.key === '+' || e.key === '=') next = zoomView(cur, ZOOM_STEP, (cur.a + cur.b) / 2, duration);
    else if (e.key === '-' || e.key === '_') next = zoomView(cur, 1 / ZOOM_STEP, (cur.a + cur.b) / 2, duration);
    if (!next) return;
    e.preventDefault();
    setView(next);
  };

  const handle = (which: Handle) => {
    const pos = which === 'start' ? v.start : v.end;
    // A handle outside the zoomed view waits at the edge it lies beyond (still draggable and focusable).
    const off = pos < view.a - 1e-9 ? 'left' : pos > view.b + 1e-9 ? 'right' : undefined;
    const ctl = controller[which];
    const label = which === 'start' ? 'Trim start' : 'Trim end';
    const valueText = usable ? `${formatTime(pos * duration, duration)} (${Math.round(pos * 100)}% of the recording)${ctl ? `, set by ${ctl}` : ''}` : 'No recording';
    const snapWords = sync ? 'Shift while dragging snaps to whole beats from the other handle (Tempo Sync is on)' : 'Shift while dragging snaps to the nearest hit';
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
        detail={`${snapWords}; Alt drags finely. Arrow keys nudge (Shift = fine), Page Up/Down move 10% of the view, double-click resets.`}
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
          data-snapping={(dragging === which && snapping) || undefined}
          data-readonly={ctl ? true : undefined}
          data-offview={off}
          className={styles.handle}
          style={{ left: `${clamp(xPct(pos), 0, 100)}%` }}
          onKeyDown={onHandleKey(which)}
          onDoubleClick={() => reset(which)}
        >
          <span className={styles.line} aria-hidden="true" />
          <span className={styles.flag} aria-hidden="true">
            {off === 'left' ? '‹' : ''}
            {which === 'start' ? 'S' : 'E'}
            {off === 'right' ? '›' : ''}
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
  const shadeL = clamp(xPct(lo), 0, 100);
  const shadeR = clamp(xPct(hi), 0, 100);

  return (
    <div className={styles.frame}>
      <div
        ref={boxRef}
        className={styles.wave}
        role="group"
        aria-label={`Waveform of ${name}. Drag Start and End to trim.`}
        data-dragging={dragging ?? undefined}
        data-empty={!usable || undefined}
        data-narrow={narrow || undefined}
        data-zoomed={zoomed || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
      >
        <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
        {shadeL > 0 && <div className={styles.shade} data-side="left" style={{ left: 0, width: `${shadeL}%` }} aria-hidden="true" />}
        {shadeR < 100 && <div className={styles.shade} data-side="right" style={{ left: `${shadeR}%`, right: 0 }} aria-hidden="true" />}
        {loop && usable && shadeR > shadeL && (
          <div className={styles.loop} style={{ left: `${shadeL}%`, width: `${shadeR - shadeL}%` }} aria-hidden="true">
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
      {usable && (
        <div className={styles.zoomRow}>
          <IconButton
            icon="minus"
            size="sm"
            variant="ghost"
            label="Zoom out"
            disabled={!canZoomOut}
            tip="Shows more of the recording. Ctrl+wheel (⌘+wheel) or a pinch on the waveform zooms too."
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          />
          <IconButton
            icon="plus"
            size="sm"
            variant="ghost"
            label="Zoom in"
            disabled={!canZoomIn}
            tip="Shows the recording closer, around the handle you used last, for exact trims. Ctrl+wheel (⌘+wheel) or a pinch on the waveform zooms too."
            onClick={() => zoomBy(ZOOM_STEP)}
          />
          <div
            ref={miniRef}
            className={styles.mini}
            data-overview
            data-zoomed={zoomed || undefined}
            onPointerDown={onMiniDown}
            onPointerMove={onMiniMove}
            onPointerUp={onMiniEnd}
            onPointerCancel={onMiniEnd}
            onLostPointerCapture={onMiniEnd}
          >
            <canvas ref={miniCanvasRef} className={styles.miniCanvas} aria-hidden="true" />
            <Tooltip name="Visible part" tip={zoomed ? 'Drag to see another part of the recording, or press beside it.' : 'Zoom in to choose which part of the recording the waveform shows.'} detail="Arrow keys scroll, + and − zoom.">
              <div
                role="slider"
                tabIndex={zoomed ? 0 : -1}
                aria-label="Visible part of the recording"
                aria-orientation="horizontal"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(view.a * 1000) / 10}
                aria-valuetext={`${formatTime(view.a * duration, duration)} to ${formatTime(view.b * duration, duration)} of ${formatTime(duration, duration)}`}
                aria-disabled={!zoomed || undefined}
                className={styles.viewport}
                style={{ left: `${view.a * 100}%`, width: `${span * 100}%` }}
                onKeyDown={onMiniKey}
              />
            </Tooltip>
          </div>
          <span className={styles.zoomText} data-zoom-level>
            <span className="visually-hidden">Zoom </span>
            {zoomText}
          </span>
        </div>
      )}
    </div>
  );
}
