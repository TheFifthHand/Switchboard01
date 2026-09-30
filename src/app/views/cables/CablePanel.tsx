/**
 * The cable panel: the selected part's patch as hardware module blocks in
 * signal order (Instrument → effects → Channel → shared Reverb/Delay →
 * Master Out, LFOs below), with draggable cables.
 *
 * Patching (all through the patch commands, so the engine rewires with
 * short ramps and every edit is one undo step):
 * - drag from a socket to a highlighted socket (incompatible ones dim);
 * - drag a plug to another socket to move that end, or into empty panel to
 *   unplug it;
 * - click a socket, then another (Escape cancels);
 * - keyboard: Tab to the sockets, arrow keys move between them, Enter opens
 *   a list of what the socket can connect to and its cables;
 * - select a modulation cable to set its amount.
 * Refusals (feedback loops, wrong socket kinds, duplicates) are explained
 * next to the socket and the old route stays. Editing is locked while a
 * performance take is recording.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Button, Dialog, Icon, IconButton, Notice, NumberField } from '../../../ui/components';
import { isTypingTarget } from '../../../ui/hooks/useComputerKeyboard';
import { compatibleSources, compatibleTargets, describePathProblem } from '../../../project/graph';
import type { Connection, Id, PortKind, PortRef, Project } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { useStore } from '../../../state/store';
import { session, useProject, useUi } from '../../instance';
import { notify } from '../../runtime';
import { CableArtLayer, CableHitLayer, LiveCable, StubLabels, type CableLayerHandlers, type LiveRefs, type PlugGrab } from './CableLayer';
import { ConnectionPicker } from './ConnectionPicker';
import { ModuleBlock, type SocketHandlers, type SocketUi } from './ModuleBlock';
import {
  GEOM,
  SIDE_ANGLE,
  cableName,
  cablePath,
  computeCables,
  computeLayout,
  connectionKindOf,
  endpointName,
  livePath,
  moduleInfos,
  moduleName,
  plugBack,
  repairPlan,
  sameModuleInfos,
  sameTracks,
  socketInDirection,
  socketKey,
  type Point,
  type SocketDir,
  type SocketGeom,
} from './model';
import styles from './CablePanel.module.css';

export interface CablePanelProps {
  /** Part whose patch is shown. */
  trackId: string;
  /** Total height in px (default: fill the parent). */
  height?: number;
}

export interface CablePanelFrameProps extends CablePanelProps {
  /** Extra control at the start of the toolbar (the drawer's collapse button). */
  headerStart?: ReactNode;
}

/** Cable panel for one part (Shape view). */
export function CablePanel({ trackId, height }: CablePanelProps) {
  return <CablePanelFrame trackId={trackId} height={height} />;
}

const DRAG_THRESHOLD_PX = 4;
const SNAP_RADIUS_PX = 22;
const REFUSAL_MS = 6000;
const DEFAULT_HINT = 'Drag from a socket to a highlighted socket, or click one socket and then another.';

const selectModules = (p: Project) => moduleInfos(p.patch);
const selectConnections = (p: Project) => p.patch.connections;
const selectTracks = (p: Project) => p.tracks.map((t) => ({ id: t.id, name: t.name }));

interface FixedEnd {
  socket: SocketGeom | null;
  /** Plug back (cable attach) point when the fixed end is a socket; the stub anchor otherwise. */
  point: Point;
  angle: number;
}

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  /** Socket pressed (new cable) or plug grabbed (move). */
  key: string;
  grab: PlugGrab | null;
  fixed: FixedEnd;
  /** Direction of the socket that completes the cable. */
  want: SocketDir;
  kind: PortKind;
  compat: Set<string>;
  hover: string | null;
  last: Point;
  started: boolean;
  el: Element;
  cleanup: () => void;
}

interface DragView {
  fixed: FixedEnd;
  kind: PortKind;
  movingId: Id | null;
  compat: Set<string>;
  anchorKey: string | null;
}

interface Refusal {
  key: string;
  text: string;
  n: number;
}

const refOf = (s: Pick<SocketGeom, 'module' | 'port'>): PortRef => ({ module: s.module, port: s.port });

function compatKeys(refs: PortRef[], dir: SocketDir): Set<string> {
  return new Set(refs.map((r) => socketKey(r.module, r.port, dir)));
}

/** The cable panel with an optional leading toolbar control (used by the Play view drawer). */
export function CablePanelFrame({ trackId, height, headerStart }: CablePanelFrameProps) {
  const modules = useProject(selectModules, sameModuleInfos);
  const connections = useProject(selectConnections);
  const tracks = useProject(selectTracks, sameTracks);
  const lock = useStore(session.store.info, (s) => s.lock);
  const selectedModuleId = useUi((s) => s.selectedModuleId);
  const repair = useProject(
    useCallback((p: Project) => (describePathProblem(p.patch, trackId) ? repairPlan(p.patch, trackId).kind : null), [trackId]),
  );
  const locked = lock !== null;
  const partIndex = tracks.findIndex((t) => t.id === trackId);
  const partName = tracks[partIndex]?.name ?? 'This part';

  const [otherParts, setOtherParts] = useState(false);
  const [arm, setArm] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragView | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<Id | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [status, setStatus] = useState('');
  const [picker, setPicker] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const refusalN = useRef(0);
  const shadowRef = useRef<SVGPathElement>(null);
  const casingRef = useRef<SVGPathElement>(null);
  const coreRef = useRef<SVGPathElement>(null);
  const freePlugRef = useRef<SVGGElement>(null);
  const liveRefs = useMemo<LiveRefs>(() => ({ shadow: shadowRef, casing: casingRef, core: coreRef, freePlug: freePlugRef }), []);
  const hintId = useId();
  const listId = useId();

  const layout = useMemo(() => computeLayout({ modules, connections, trackId, tracks, otherParts }), [modules, connections, trackId, tracks, otherParts]);
  const cableSet = useMemo(() => computeCables({ layout, connections, modules, tracks, trackId }), [layout, connections, modules, tracks, trackId]);

  // Selection and armed sockets that no longer exist are dropped.
  const selected = selectedId ? (connections.find((c) => c.id === selectedId) ?? null) : null;
  const armSocket = arm ? (layout.sockets.get(arm) ?? null) : null;
  const armCompat = useMemo(() => {
    if (!armSocket) return null;
    const patch = session.store.getState().patch;
    return armSocket.dir === 'out' ? compatKeys(compatibleTargets(patch, refOf(armSocket)), 'in') : compatKeys(compatibleSources(patch, refOf(armSocket)), 'out');
    // connections: recompute when the patch's cables change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armSocket, connections]);

  // A new part, or locking for a take, clears transient interaction state.
  useEffect(() => {
    setArm(null);
    setSelectedId(null);
    setPicker(null);
    setRefusal(null);
    setStatus('');
  }, [trackId]);
  useEffect(() => {
    if (!locked) return;
    gesture.current?.cleanup();
    gesture.current = null;
    setDrag(null);
    setHoverKey(null);
    setArm(null);
    setPicker(null);
  }, [locked]);

  useEffect(() => {
    if (!refusal) return;
    const t = window.setTimeout(() => setRefusal((r) => (r && r.n === refusal.n ? null : r)), REFUSAL_MS);
    return () => window.clearTimeout(t);
  }, [refusal]);

  // Keep the roving tab stop on an existing socket.
  const tabKey = focusKey && layout.sockets.has(focusKey) ? focusKey : (layout.order[0] ?? null);

  /* ---------------------------------------------------------------- */
  /* Names and messages                                                */
  /* ---------------------------------------------------------------- */

  const nameOf = useCallback((c: Pick<Connection, 'from' | 'to'>) => cableName(modules, c, tracks, trackId), [modules, tracks, trackId]);

  const refuse = useCallback((key: string, text: string) => {
    refusalN.current += 1;
    setRefusal({ key, text, n: refusalN.current });
    setStatus(text);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Edits                                                             */
  /* ---------------------------------------------------------------- */

  const connectRefs = useCallback(
    (from: PortRef, to: PortRef, messageAt: string | null): string | null => {
      const r = cmd.connect(session.store, from, to);
      if (!r.ok) {
        if (messageAt) refuse(messageAt, r.message);
        else setStatus(r.message);
        return r.message;
      }
      setStatus(`Connected ${nameOf({ from, to })}.`);
      return null;
    },
    [nameOf, refuse],
  );

  const disconnectId = useCallback(
    (id: Id) => {
      const c = session.store.getState().patch.connections.find((x) => x.id === id);
      if (!c) return;
      const name = nameOf(c);
      if (session.accepted(cmd.disconnect(session.store, id))) {
        setStatus(`Unplugged ${name}. Ctrl+Z puts it back.`);
        setSelectedId((s) => (s === id ? null : s));
      }
    },
    [nameOf],
  );

  const setAmount = useCallback((id: Id, amount: number, gestureId: string) => {
    session.accepted(cmd.setConnectionAmount(session.store, id, amount, gestureId));
  }, []);

  const restoreConnection = () => {
    const plan = repairPlan(session.store.getState().patch, trackId);
    if (plan.kind === 'connect') {
      const r = cmd.connect(session.store, plan.from, plan.to);
      if (r.ok) setStatus(`Restored ${nameOf(plan)}. Ctrl+Z undoes it.`);
      else notify(r.message, 'warn');
      return;
    }
    if (session.accepted(cmd.restoreTrackPatch(session.store, trackId))) setStatus(`Restored ${partName}'s default cables. Ctrl+Z undoes it.`);
  };

  const restorePart = () => {
    setRestoreOpen(false);
    const r = cmd.restoreTrackPatch(session.store, trackId);
    if (session.accepted(r)) setStatus(`Restored ${partName}'s default cables. Ctrl+Z undoes it.`);
    else if (!r.refused && !r.message) setStatus(`${partName}'s cables already match the default.`);
  };

  const restoreAll = () => {
    setRestoreOpen(false);
    const r = cmd.restoreDefaultPatch(session.store);
    if (session.accepted(r)) setStatus('Restored every part’s default cables. Ctrl+Z undoes it.');
    else if (!r.refused && !r.message) setStatus('All cables already match the default.');
  };

  /* ---------------------------------------------------------------- */
  /* Pointer gestures                                                  */
  /* ---------------------------------------------------------------- */

  const stagePoint = (clientX: number, clientY: number): Point => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  const socketAt = (clientX: number, clientY: number, p: Point, exclude: string | null): string | null => {
    const el = document.elementFromPoint(clientX, clientY);
    const hit = el?.closest?.('[data-socket-key]');
    const k = hit?.getAttribute('data-socket-key');
    if (k && k !== exclude && layout.sockets.has(k) && stageRef.current?.contains(hit!)) return k;
    let best: string | null = null;
    let bd = SNAP_RADIUS_PX;
    for (const s of layout.sockets.values()) {
      if (s.key === exclude) continue;
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < bd) {
        bd = d;
        best = s.key;
      }
    }
    return best;
  };

  const drawLive = (g: Gesture) => {
    const hover = g.hover ? layout.sockets.get(g.hover) : undefined;
    let d: string;
    let fx: number;
    let fy: number;
    let fa: number;
    if (hover) {
      fa = SIDE_ANGLE[hover.side];
      d = cablePath(g.fixed.point, g.fixed.angle, plugBack(hover, fa), fa);
      fx = hover.x;
      fy = hover.y;
    } else {
      const p = g.last;
      if (g.fixed.socket) d = livePath(g.fixed.socket, g.fixed.angle, p);
      else d = cablePath(g.fixed.point, g.fixed.angle, p, Math.atan2(g.fixed.point.y - p.y, g.fixed.point.x - p.x));
      fa = Math.atan2(g.fixed.point.y - p.y, g.fixed.point.x - p.x);
      fx = p.x - Math.cos(fa) * 0;
      fy = p.y;
    }
    shadowRef.current?.setAttribute('d', d);
    casingRef.current?.setAttribute('d', d);
    coreRef.current?.setAttribute('d', d);
    freePlugRef.current?.setAttribute('transform', `translate(${fx.toFixed(1)} ${fy.toFixed(1)}) rotate(${((fa * 180) / Math.PI).toFixed(1)})`);
  };

  const autoScroll = (clientX: number) => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const r = sc.getBoundingClientRect();
    if (clientX < r.left + 36) sc.scrollLeft -= 14;
    else if (clientX > r.right - 36) sc.scrollLeft += 14;
  };

  const endGesture = () => {
    const g = gesture.current;
    if (!g) return;
    g.cleanup();
    gesture.current = null;
    setDrag(null);
    setHoverKey(null);
  };

  const dropCable = (g: Gesture) => {
    const target = g.hover ? layout.sockets.get(g.hover) : undefined;
    if (g.grab) {
      const c = session.store.getState().patch.connections.find((x) => x.id === g.grab!.connectionId);
      if (!c) return;
      if (!target) {
        disconnectId(c.id);
        return;
      }
      const ends = g.grab.end === 'to' ? { to: refOf(target) } : { from: refOf(target) };
      const r = cmd.moveConnection(session.store, c.id, ends);
      if (!r.ok) {
        refuse(target.key, r.message);
        return;
      }
      const moved = session.store.getState().patch.connections.find((x) => x.id === c.id);
      if (moved && (moved.from.module !== c.from.module || moved.from.port !== c.from.port || moved.to.module !== c.to.module || moved.to.port !== c.to.port)) {
        setStatus(`Moved the cable: ${nameOf(moved)}.`);
      }
      return;
    }
    const origin = layout.sockets.get(g.key);
    if (!origin) return;
    if (!target) {
      setStatus('No cable added. Drop the plug on a highlighted socket to connect.');
      return;
    }
    const [from, to] = origin.dir === 'out' ? [refOf(origin), refOf(target)] : [refOf(target), refOf(origin)];
    connectRefs(from, to, target.key);
  };

  const clickSocket = (key: string) => {
    const s = layout.sockets.get(key);
    if (!s) return;
    if (armSocket) {
      if (armSocket.key === key) {
        setArm(null);
        setStatus('Cancelled.');
        return;
      }
      if (armSocket.dir !== s.dir) {
        const [from, to] = armSocket.dir === 'out' ? [refOf(armSocket), refOf(s)] : [refOf(s), refOf(armSocket)];
        if (connectRefs(from, to, key) === null) setArm(null);
        return;
      }
    }
    setRefusal(null);
    setSelectedId(null);
    setArm(key);
  };

  const beginGesture = (e: ReactPointerEvent<Element>, key: string, grab: PlugGrab | null) => {
    if (e.button !== 0 || !e.isPrimary) return;
    if (locked) {
      setStatus(lock ?? 'Patching is locked.');
      return;
    }
    endGesture();
    const patch = session.store.getState().patch;
    let fixed: FixedEnd;
    let want: SocketDir;
    let kind: PortKind;
    let compat: Set<string>;
    if (grab) {
      const c = patch.connections.find((x) => x.id === grab.connectionId);
      if (!c) return;
      kind = connectionKindOf(modules, c);
      const ends = cableSet.ends.get(c.id) ?? {};
      const otherKey = grab.end === 'to' ? ends.from : ends.to;
      const other = otherKey ? layout.sockets.get(otherKey) : undefined;
      if (other) {
        const geom = cableSet.cables.find((x) => x.id === c.id);
        const angle = (grab.end === 'to' ? geom?.from?.angle : geom?.to?.angle) ?? SIDE_ANGLE[other.side];
        fixed = { socket: other, point: plugBack(other, angle), angle };
      } else {
        const stub = cableSet.stubs.find((s) => s.connectionIds.includes(c.id));
        const a = stub?.anchor ?? { x: 0, y: 0 };
        fixed = { socket: null, point: a, angle: stub?.align === 'center' ? (a.y < layout.midY ? Math.PI / 2 : -Math.PI / 2) : Math.PI };
      }
      if (grab.end === 'to') {
        want = 'in';
        compat = compatKeys(compatibleTargets(patch, c.from, { ignoreConnectionId: c.id }), 'in');
      } else {
        want = 'out';
        compat = compatKeys(compatibleSources(patch, c.to, { ignoreConnectionId: c.id }), 'out');
      }
    } else {
      const s = layout.sockets.get(key);
      if (!s) return;
      kind = s.kind;
      const angle = SIDE_ANGLE[s.side];
      fixed = { socket: s, point: plugBack(s, angle), angle };
      want = s.dir === 'out' ? 'in' : 'out';
      compat = s.dir === 'out' ? compatKeys(compatibleTargets(patch, refOf(s)), 'in') : compatKeys(compatibleSources(patch, refOf(s)), 'out');
    }
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer: window listeners below still follow it */
    }
    const pointerId = e.pointerId;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const g = gesture.current;
      if (!g) return;
      if (!g.started) {
        if (Math.hypot(ev.clientX - g.startX, ev.clientY - g.startY) < DRAG_THRESHOLD_PX) return;
        g.started = true;
        setArm(null);
        setRefusal(null);
        setPicker(null);
        setDrag({ fixed: g.fixed, kind: g.kind, movingId: g.grab?.connectionId ?? null, compat: g.compat, anchorKey: g.grab ? null : g.key });
        setStatus(g.grab ? 'Drop on a highlighted socket to move the cable, or on empty panel to unplug it.' : 'Drop on a highlighted socket to connect. Esc cancels.');
      }
      ev.preventDefault();
      const p = stagePoint(ev.clientX, ev.clientY);
      g.last = p;
      const hover = socketAt(ev.clientX, ev.clientY, p, g.grab ? null : g.key);
      if (hover !== g.hover) {
        g.hover = hover;
        setHoverKey(hover);
      }
      drawLive(g);
      autoScroll(ev.clientX);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const g = gesture.current;
      if (!g) return;
      if (g.started) {
        const p = stagePoint(ev.clientX, ev.clientY);
        g.last = p;
        g.hover = socketAt(ev.clientX, ev.clientY, p, g.grab ? null : g.key);
      }
      endGesture();
      if (g.started) dropCable(g);
      else if (g.grab) {
        setArm(null);
        setSelectedId(g.grab.connectionId);
        setStatus(`Selected ${nameOf(session.store.getState().patch.connections.find((c) => c.id === g.grab!.connectionId) ?? { from: { module: '', port: '' }, to: { module: '', port: '' } })}.`);
      } else clickSocket(g.key);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      endGesture();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    gesture.current = {
      pointerId,
      startX: e.clientX,
      startY: e.clientY,
      key,
      grab,
      fixed,
      want,
      kind,
      compat,
      hover: null,
      last: stagePoint(e.clientX, e.clientY),
      started: false,
      el,
      cleanup: () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        try {
          if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
        } catch {
          /* already released */
        }
      },
    };
  };

  // Draw the live cable as soon as its SVG exists.
  useLayoutEffect(() => {
    if (drag && gesture.current) drawLive(gesture.current);
  });

  useEffect(() => () => gesture.current?.cleanup(), []);

  const focusSocket = (key: string) => {
    setFocusKey(key);
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-socket-key="${CSS.escape(key)}"]`);
    el?.focus();
  };

  const cancelAll = (): boolean => {
    if (gesture.current) {
      endGesture();
      setStatus('Cancelled.');
      return true;
    }
    if (arm) {
      setArm(null);
      setStatus('Cancelled.');
      return true;
    }
    if (refusal) {
      setRefusal(null);
      return true;
    }
    if (selectedId) {
      setSelectedId(null);
      return true;
    }
    return false;
  };

  const socketKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, key: string) => {
    const arrows: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    if (arrows[e.key]) {
      e.preventDefault();
      const next = socketInDirection(layout, key, arrows[e.key]);
      if (next) focusSocket(next);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const k = e.key === 'Home' ? layout.order[0] : layout.order[layout.order.length - 1];
      if (k) focusSocket(k);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (locked) {
        setStatus(lock ?? 'Patching is locked.');
        return;
      }
      const s = layout.sockets.get(key);
      if (s && armSocket && armSocket.key !== key && armSocket.dir !== s.dir) {
        clickSocket(key);
        return;
      }
      setArm(null);
      setPicker(key);
    }
  };

  // Stable handler objects for memoised children; they call the latest closures.
  const api = useRef({ beginGesture, socketKeyDown, setFocusKey, setSelectedId, setArm, setStatus, nameOf });
  useLayoutEffect(() => {
    api.current = { beginGesture, socketKeyDown, setFocusKey, setSelectedId, setArm, setStatus, nameOf };
  });
  const socketHandlers = useMemo<SocketHandlers>(
    () => ({
      down: (e, key) => api.current.beginGesture(e, key, null),
      keyDown: (e, key) => api.current.socketKeyDown(e, key),
      focus: (key) => api.current.setFocusKey(key),
    }),
    [],
  );
  const cableHandlers = useMemo<CableLayerHandlers>(
    () => ({
      plugDown: (e, grab) => {
        e.stopPropagation();
        api.current.beginGesture(e, grab.socketKey, grab);
      },
      cableDown: (e, id) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const c = session.store.getState().patch.connections.find((x) => x.id === id);
        api.current.setArm(null);
        api.current.setSelectedId(id);
        if (c) api.current.setStatus(`Selected ${api.current.nameOf(c)}.`);
      },
    }),
    [],
  );

  // Escape anywhere cancels a drag or an armed socket.
  useEffect(() => {
    if (!arm && !drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (gesture.current) {
        endGesture();
        setStatus('Cancelled.');
      } else setArm(null);
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arm, drag]);

  const onRootKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (cancelAll()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !isTypingTarget(e.target) && !locked) {
      e.preventDefault();
      disconnectId(selected.id);
    }
  };

  const onStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = e.target as Element;
    if (t.closest('button, [data-plug], [data-cable], [role="switch"]')) return;
    setRefusal(null);
    if (arm) {
      setArm(null);
      setStatus('Cancelled.');
    }
    setSelectedId(null);
  };

  // Show the Other parts column when it opens.
  useEffect(() => {
    if (!otherParts || !layout.strip) return;
    const sc = scrollerRef.current;
    if (!sc) return;
    const stageLeft = stageRef.current?.offsetLeft ?? 0;
    const right = stageLeft + layout.strip.x + layout.strip.w + GEOM.padX;
    if (right > sc.scrollLeft + sc.clientWidth) sc.scrollTo({ left: right - sc.clientWidth, behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otherParts]);

  /* ---------------------------------------------------------------- */
  /* Derived view data                                                 */
  /* ---------------------------------------------------------------- */

  const compat = drag ? drag.compat : armCompat;
  const ui = useMemo<SocketUi>(
    () => ({ anchorKey: drag ? drag.anchorKey : arm, armed: !drag && !!arm, compat, hoverKey, focusKey: tabKey, locked }),
    [drag, arm, compat, hoverKey, tabKey, locked],
  );

  const { socketAria, socketCount } = useMemo(() => {
    const aria: Record<string, string> = {};
    const count: Record<string, number> = {};
    for (const s of layout.sockets.values()) {
      const mine = connections.filter((c) => (s.dir === 'out' ? c.from.module === s.module && c.from.port === s.port : c.to.module === s.module && c.to.port === s.port));
      count[s.key] = mine.length;
      const name = endpointName(modules, refOf(s), s.dir, tracks, trackId);
      const what = `${s.kind === 'audio' ? 'audio' : 'modulation'} ${s.dir === 'in' ? 'input' : 'output'}`;
      let cables: string;
      if (mine.length === 0) cables = 'not connected';
      else if (mine.length <= 2) cables = mine.map((c) => (s.dir === 'out' ? `to ${endpointName(modules, c.to, 'in', tracks, trackId)}` : `from ${endpointName(modules, c.from, 'out', tracks, trackId)}`)).join(' and ');
      else cables = `${mine.length} cables`;
      aria[s.key] = `${name}, ${what}, ${cables}`;
    }
    return { socketAria: aria, socketCount: count };
  }, [layout, connections, modules, tracks, trackId]);

  const blockNames = useMemo(() => {
    const out: Record<string, string> = {};
    for (const b of layout.blocks) out[b.id] = moduleName(modules.find((m) => m.id === b.id), tracks, b.variant === 'other' ? null : trackId);
    return out;
  }, [layout, modules, tracks, trackId]);

  const textList = useMemo(() => {
    const lines: { key: string; text: string }[] = cableSet.cables.map((c) => ({ key: c.id, text: `${c.name}${c.kind === 'mod' ? `, amount ${Math.round(c.amount * 100)}%` : ''}` }));
    for (const s of cableSet.stubs) {
      const sock = layout.sockets.get(s.socketKey)!;
      const here = endpointName(modules, refOf(sock), sock.dir, tracks, trackId);
      if (s.connectionIds.length === 1) {
        const c = connections.find((x) => x.id === s.connectionIds[0]);
        if (c) lines.push({ key: c.id, text: nameOf(c) });
      } else lines.push({ key: s.socketKey, text: sock.dir === 'in' ? `${s.label} → ${here}` : `${here} → ${s.label.replace(/^To /, '')}` });
    }
    return lines;
  }, [cableSet, layout, connections, modules, tracks, trackId, nameOf]);

  const refusalSocket = refusal ? layout.sockets.get(refusal.key) : undefined;
  const selectedKind = selected ? connectionKindOf(modules, selected) : null;

  let hint: string | null = null;
  if (drag) hint = drag.movingId ? 'Drop on a highlighted socket to move the cable, or on empty panel to unplug it.' : 'Drop on a highlighted socket to connect. Esc cancels.';
  else if (armSocket) {
    const n = endpointName(modules, refOf(armSocket), armSocket.dir, tracks, trackId);
    hint = armSocket.dir === 'out' ? `Choose a destination for ${n}: click a highlighted socket. Esc cancels.` : `Choose a source for ${n}: click a highlighted socket. Esc cancels.`;
  }

  const pickerAnchor = picker ? (rootRef.current?.querySelector<HTMLElement>(`[data-socket-key="${CSS.escape(picker)}"]`) ?? null) : null;
  const closePicker = useCallback(
    (refocus: boolean) => {
      const key = picker;
      setPicker(null);
      if (refocus && key) requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-socket-key="${CSS.escape(key)}"]`)?.focus());
    },
    [picker],
  );
  const pickerConnect = useCallback((from: PortRef, to: PortRef) => connectRefs(from, to, null), [connectRefs]);

  const otherCount = tracks.length - 1;

  return (
    <div
      ref={rootRef}
      className={styles.panel}
      style={height !== undefined ? { height } : undefined}
      data-locked={locked || undefined}
      data-armed={arm ? true : undefined}
      data-dragging={drag ? true : undefined}
      onKeyDown={onRootKeyDown}
      role="region"
      aria-label={`Cables for ${partName}`}
    >
      <div className={styles.toolbar}>
        {headerStart}
        <div className={styles.title}>
          <span className={styles.legendTitle}>Cables</span>
          {partIndex >= 0 && <span className={`${styles.partNum} mono`}>{partIndex + 1}</span>}
          <span className={styles.partName}>{partName}</span>
        </div>
        {selected && selectedKind ? (
          <div className={styles.inspector} role="group" aria-label="Selected cable">
            <span className={styles.kindPill} data-kind={selectedKind}>
              {selectedKind === 'mod' ? 'Mod' : 'Audio'}
            </span>
            <span className={styles.inspectorName} title={nameOf(selected)}>
              {nameOf(selected)}
            </span>
            {selectedKind === 'mod' && (
              <NumberField
                label="Amount"
                layout="inline"
                size="sm"
                chars={4}
                min={-100}
                max={100}
                step={1}
                unit="%"
                value={Math.round((selected.amount ?? 1) * 100)}
                disabled={locked}
                tip="How strongly this cable moves its target. Negative values move it the other way; 0% does nothing."
                onChange={(v, info) => setAmount(selected.id, v / 100, info.gesture)}
              />
            )}
            <Button size="sm" variant="ghost" icon="close" disabled={locked} onClick={() => disconnectId(selected.id)} tip="Unplug this cable. Ctrl+Z puts it back." aria-keyshortcuts="Delete">
              Unplug
            </Button>
            <IconButton icon="check" size="sm" label="Done with this cable" onClick={() => setSelectedId(null)} />
          </div>
        ) : (
          <p className={styles.status} data-tone={hint ? 'teal' : refusal ? 'coral' : undefined} id={hintId}>
            {hint ?? (status || DEFAULT_HINT)}
          </p>
        )}
        <div className={styles.tools}>
          <Button
            size="sm"
            variant="ghost"
            iconRight={otherParts ? 'chevronLeft' : 'chevronRight'}
            aria-expanded={otherParts}
            aria-controls={`${listId}-stage`}
            onClick={() => setOtherParts((v) => !v)}
            tip={otherParts ? 'Hide the other parts’ channel inputs.' : 'Show every other part’s Channel In, to send this part’s sound through another part’s mixer.'}
          >
            Other parts{otherCount > 0 ? ` (${otherCount})` : ''}
          </Button>
          <Button size="sm" icon="undo" disabled={locked} onClick={() => setRestoreOpen(true)} tip="Put the default cables back for this part or for every part. Asks first.">
            Restore…
          </Button>
        </div>
      </div>

      {locked && (
        <Notice tone="warning" className={styles.notice}>
          {lock}
        </Notice>
      )}
      {!locked && repair && (
        <Notice
          tone="warning"
          className={styles.notice}
          action={{ label: 'Restore Connection', onAction: restoreConnection }}
        >
          <strong>This part has no path to the output.</strong>{' '}
          {repair === 'connect' ? `${partName}'s Channel is not plugged into the Master Out, so you won't hear it.` : `${partName}'s sound never reaches the Master Out, so you won't hear it. Restore Connection puts its default cables back.`}
        </Notice>
      )}

      <div className={styles.viewport} ref={scrollerRef}>
        <div
          id={`${listId}-stage`}
          ref={stageRef}
          className={styles.stage}
          style={{ width: layout.width, height: layout.height }}
          onPointerDown={onStagePointerDown}
          aria-describedby={hintId}
        >
          <CableHitLayer layout={layout} set={cableSet} hiddenId={drag?.movingId ?? null} handlers={cableHandlers} />
          {layout.strip && (
            <span className={styles.stripTitle} style={{ left: layout.strip.x, top: layout.strip.y - 22 }} aria-hidden="true">
              Other parts · Channel In
            </span>
          )}
          {layout.blocks.map((b) => {
            const m = modules.find((x) => x.id === b.id);
            const t = b.variant === 'other' ? tracks.findIndex((x) => x.id === b.trackId) : -1;
            return (
              <ModuleBlock
                key={`${b.variant}:${b.id}`}
                geom={b}
                name={blockNames[b.id]}
                partLabel={t >= 0 ? `${t + 1} ${tracks[t].name}` : undefined}
                bypass={m?.bypass ?? false}
                selected={selectedModuleId === b.id}
                ui={ui}
                handlers={socketHandlers}
                socketAria={socketAria}
                socketCount={socketCount}
              />
            );
          })}
          <CableArtLayer layout={layout} set={cableSet} selectedId={selectedId} hiddenId={drag?.movingId ?? null} handlers={cableHandlers} editable={!locked} />
          <StubLabels set={cableSet} />
          {drag && <LiveCable layout={layout} kind={drag.kind} fixed={{ socket: drag.fixed.socket, angle: drag.fixed.angle }} refs={liveRefs} />}
          {refusal && refusalSocket && (
            <div
              className={styles.refusal}
              role="alert"
              data-below={refusalSocket.y < 90 || undefined}
              style={{ left: Math.max(130, Math.min(layout.width - 130, refusalSocket.x)), top: refusalSocket.y }}
            >
              <Icon name="warning" size={14} />
              <span>{refusal.text}</span>
            </div>
          )}
        </div>
      </div>

      <div className="visually-hidden">
        <h3 id={`${listId}-h`}>Cables of {partName}</h3>
        <ul aria-labelledby={`${listId}-h`}>
          {textList.length ? textList.map((l) => <li key={l.key}>{l.text}</li>) : <li>No cables.</li>}
        </ul>
        <p aria-live="polite">{status}</p>
      </div>

      {picker && (
        <ConnectionPicker
          socketKey={picker}
          anchor={pickerAnchor}
          trackId={trackId}
          modules={modules}
          tracks={tracks}
          locked={locked}
          onClose={closePicker}
          onConnect={pickerConnect}
          onDisconnect={disconnectId}
          onAmount={setAmount}
        />
      )}

      <Dialog
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        title="Restore default cables?"
        description="Puts the factory cables back. Knob settings on the modules are kept, and Ctrl+Z undoes it."
        actions={
          <Button variant="ghost" onClick={() => setRestoreOpen(false)}>
            Cancel
          </Button>
        }
      >
        <div className={styles.restoreChoices}>
          <div className={styles.restoreChoice}>
            <Button variant="primary" icon="undo" onClick={restorePart}>
              Restore {partName}’s cables
            </Button>
            <p>Instrument → Drive → Filter → Channel → Master Out, Send A to the Reverb, Send B to the Delay, and the LFO to the filter. Effects and LFOs you added to {partName} are removed.</p>
          </div>
          <div className={styles.restoreChoice}>
            <Button variant="danger" icon="undo" onClick={restoreAll}>
              Restore all parts
            </Button>
            <p>Every part and the shared Reverb, Delay and Master Out get their default modules and cables back.</p>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
