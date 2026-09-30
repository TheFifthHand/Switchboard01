/**
 * Cable panel model: pure functions that turn the patch into what the panel
 * draws — module blocks laid out left to right in signal order, labelled
 * sockets, cable geometry (sagging cubic curves with plugs at both ends),
 * edge stubs for cables that leave the visible modules, readable names, and
 * the repair used by "Restore Connection".
 *
 * Nothing here touches the DOM, React or audio; it runs on plain patch data.
 */
import { MASTER_ID, moduleId as mid } from '../../../project/factory';
import { validateConnection } from '../../../project/graph';
import { MODULE_DEFS, type PortDef } from '../../../project/modules';
import type { Connection, Id, ModuleType, Patch, PortKind, PortRef } from '../../../project/types';

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/** The routing-relevant part of a patch module (params excluded, so knob moves do not re-layout). */
export interface ModuleInfo {
  id: Id;
  type: ModuleType;
  trackId?: Id;
  label?: string;
  bypass: boolean;
}

export interface TrackInfo {
  id: Id;
  name: string;
}

export function moduleInfos(patch: Patch): ModuleInfo[] {
  return patch.modules.map((m) => ({ id: m.id, type: m.type, trackId: m.trackId, label: m.label, bypass: m.bypass }));
}

export function sameModuleInfos(a: readonly ModuleInfo[], b: readonly ModuleInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.type !== y.type || x.trackId !== y.trackId || x.label !== y.label || x.bypass !== y.bypass) return false;
  }
  return true;
}

export function sameTracks(a: readonly TrackInfo[], b: readonly TrackInfo[]): boolean {
  return a === b || (a.length === b.length && a.every((t, i) => t.id === b[i].id && t.name === b[i].name));
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

export type SocketDir = 'in' | 'out';

export function socketKey(module: Id, port: string, dir: SocketDir): string {
  return `${dir}|${module}|${port}`;
}

export function refOfKey(key: string): { ref: PortRef; dir: SocketDir } {
  const [dir, module, port] = key.split('|');
  return { ref: { module, port }, dir: dir as SocketDir };
}

/** "Drive", "Drive 2", "LFO 3", "Master Out" (without a part prefix). */
export function baseModuleName(m: Pick<ModuleInfo, 'id' | 'type' | 'label'>): string {
  if (m.label) return m.label;
  const base = m.type === 'instrument' ? 'Instrument' : MODULE_DEFS[m.type].label;
  const n = /-(\d+)$/.exec(m.id);
  return n ? `${base} ${n[1]}` : base;
}

/** Module name as seen from `viewTrackId`'s panel: other parts' modules get their part name first ("Bass Filter"). */
export function moduleName(m: ModuleInfo | undefined, tracks: readonly TrackInfo[], viewTrackId: Id | null): string {
  if (!m) return 'Missing module';
  const base = baseModuleName(m);
  if (m.trackId && m.trackId !== viewTrackId) {
    const t = tracks.find((x) => x.id === m.trackId);
    return t ? `${t.name} ${base}` : base;
  }
  return base;
}

/** Visible socket label: "In", "Send A", "Cutoff mod", "Mod Out". */
export function socketLabel(port: PortDef): string {
  return port.kind === 'mod' && port.direction === 'in' ? `${port.label} mod` : port.label;
}

export function portOf(m: ModuleInfo | undefined, port: string, dir: SocketDir): PortDef | undefined {
  return m ? MODULE_DEFS[m.type].ports.find((p) => p.id === port && p.direction === dir) : undefined;
}

/** "Filter Out", "Channel Send A", "Bass Channel In", "Master Out". */
export function endpointName(modules: readonly ModuleInfo[], ref: PortRef, dir: SocketDir, tracks: readonly TrackInfo[], viewTrackId: Id | null): string {
  const m = modules.find((x) => x.id === ref.module);
  if (m?.type === 'master') return moduleName(m, tracks, viewTrackId);
  const p = portOf(m, ref.port, dir);
  return `${moduleName(m, tracks, viewTrackId)} ${p ? socketLabel(p) : ref.port}`;
}

/** "Filter Out → Channel In". */
export function cableName(modules: readonly ModuleInfo[], c: Pick<Connection, 'from' | 'to'>, tracks: readonly TrackInfo[], viewTrackId: Id | null): string {
  return `${endpointName(modules, c.from, 'out', tracks, viewTrackId)} → ${endpointName(modules, c.to, 'in', tracks, viewTrackId)}`;
}

export function connectionKindOf(modules: readonly ModuleInfo[], c: Pick<Connection, 'from'>): PortKind {
  const m = modules.find((x) => x.id === c.from.module);
  return portOf(m, c.from.port, 'out')?.kind ?? 'audio';
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

export type Side = 'left' | 'right' | 'bottom';
export type BlockVariant = 'source' | 'effect' | 'channel' | 'return' | 'master' | 'lfo' | 'other';

export interface SocketGeom {
  key: string;
  module: Id;
  port: string;
  dir: SocketDir;
  kind: PortKind;
  side: Side;
  /** Centre in stage coordinates. */
  x: number;
  y: number;
  /** Centre relative to its block. */
  rx: number;
  ry: number;
  label: string;
  tip: string;
  /** Kind of block the socket sits on. */
  variant: BlockVariant;
  /** A socket in the "Other parts" strip (another part's Channel In). */
  strip: boolean;
}

export interface BlockGeom {
  id: Id;
  type: ModuleType;
  variant: BlockVariant;
  trackId?: Id;
  x: number;
  y: number;
  w: number;
  h: number;
  sockets: SocketGeom[];
}

export interface PanelLayout {
  width: number;
  height: number;
  blocks: BlockGeom[];
  sockets: Map<string, SocketGeom>;
  /** Socket keys in reading order (for Home/End and a stable first tab stop). */
  order: string[];
  /** Where stub labels sit: above the main row and below the lowest block. */
  stubTopY: number;
  stubBottomY: number;
  /** Other parts column (when expanded). */
  strip: { x: number; y: number; w: number } | null;
  /** Vertical middle used to decide whether a stub leaves through the top or the bottom edge. */
  midY: number;
  /** Top of the LFO row. */
  lfoTop: number;
}

export const GEOM = {
  padX: 32,
  top: 24,
  rowH: 132,
  gapX: 62,
  modGap: 28,
  lfoH: 52,
  lfoGap: 28,
  bottom: 8,
  returnTop: 56,
  returnH: 58,
  returnGap: 14,
  returnSockY: 42,
  audioY: 72,
  channelOut: { out: 38, sendA: 72, sendB: 98 } as Record<string, number>,
  masterInY: 38,
  lfoSockY: 38,
  stripRowH: 28,
  stripGap: 4,
  widths: { source: 170, effect: 136, channel: 160, return: 212, master: 150, lfo: 176, other: 176 } as Record<BlockVariant, number>,
  socketR: 9,
  plugLen: 17,
} as const;

function variantOf(m: ModuleInfo, viewTrackId: Id): BlockVariant {
  if (m.type === 'master') return 'master';
  if (m.trackId !== viewTrackId) return 'return';
  if (m.type === 'instrument') return 'source';
  if (m.type === 'channel') return 'channel';
  if (m.type === 'lfo') return 'lfo';
  return 'effect';
}

function spread(n: number, w: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [Math.round(w / 2)];
  if (n === 2) return [Math.round(w * 0.27), Math.round(w * 0.69)];
  return Array.from({ length: n }, (_, i) => Math.round((w * (i + 1)) / (n + 1)));
}

function blockSockets(m: ModuleInfo, variant: BlockVariant, x: number, y: number, w: number, h: number): SocketGeom[] {
  const ports = MODULE_DEFS[m.type].ports;
  const out: SocketGeom[] = [];
  const add = (p: PortDef, side: Side, rx: number, ry: number) =>
    out.push({ key: socketKey(m.id, p.id, p.direction), module: m.id, port: p.id, dir: p.direction, kind: p.kind, side, x: x + rx, y: y + ry, rx, ry, label: socketLabel(p), tip: p.tip, variant, strip: false });

  const audioIns = ports.filter((p) => p.direction === 'in' && p.kind === 'audio');
  const modIns = ports.filter((p) => p.direction === 'in' && p.kind === 'mod');
  const outs = ports.filter((p) => p.direction === 'out');

  const rowY = variant === 'return' ? GEOM.returnSockY : variant === 'lfo' ? GEOM.lfoSockY : variant === 'master' ? GEOM.masterInY : GEOM.audioY;
  audioIns.forEach((p, i) => add(p, 'left', 0, audioIns.length === 1 ? rowY : rowY + i * 30));
  outs.forEach((p, i) => {
    let ry = rowY + i * 30;
    if (variant === 'channel' && GEOM.channelOut[p.id] !== undefined) ry = GEOM.channelOut[p.id];
    add(p, 'right', w, ry);
  });
  const xs = spread(modIns.length, w);
  modIns.forEach((p, i) => add(p, 'bottom', xs[i], h));
  return out;
}

/**
 * Order of the part's audio modules: the instrument first, the channel last,
 * effects by their depth along the audio connections (longest path), so a
 * linear chain reads left to right and branches stay in signal order.
 * Effects that nothing feeds and that feed nothing sit just before the channel.
 */
function mainOrder(mods: readonly ModuleInfo[], connections: readonly Connection[], trackId: Id): ModuleInfo[] {
  const inst = mods.find((m) => m.id === mid.inst(trackId) && m.type === 'instrument');
  const ch = mods.find((m) => m.id === mid.channel(trackId) && m.type === 'channel');
  const ids = new Set(mods.map((m) => m.id));
  const byId = new Map(mods.map((m) => [m.id, m]));
  const preds = new Map<Id, Id[]>();
  const succs = new Map<Id, Id[]>();
  for (const c of connections) {
    if (!ids.has(c.from.module) || !ids.has(c.to.module) || c.from.module === c.to.module) continue;
    const fromM = byId.get(c.from.module)!;
    if (portOf(fromM, c.from.port, 'out')?.kind !== 'audio') continue;
    (preds.get(c.to.module) ?? preds.set(c.to.module, []).get(c.to.module)!).push(c.from.module);
    (succs.get(c.from.module) ?? succs.set(c.from.module, []).get(c.from.module)!).push(c.to.module);
  }
  const depth = new Map<Id, number>();
  const visiting = new Set<Id>();
  const depthOf = (id: Id): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // defensive: patches are acyclic
    visiting.add(id);
    const ps = (preds.get(id) ?? []).filter((p) => p !== ch?.id);
    let d: number;
    if (id === inst?.id) d = 0;
    else if (ps.length) d = Math.max(...ps.map(depthOf)) + 1;
    else d = (succs.get(id)?.length ?? 0) > 0 ? 0.5 : Number.POSITIVE_INFINITY;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  const effects = mods.filter((m) => m !== inst && m !== ch);
  const index = new Map(mods.map((m, i) => [m.id, i]));
  const sorted = [...effects].sort((a, b) => depthOf(a.id) - depthOf(b.id) || index.get(a.id)! - index.get(b.id)!);
  return [...(inst ? [inst] : []), ...sorted, ...(ch ? [ch] : [])];
}

export interface LayoutInput {
  modules: readonly ModuleInfo[];
  connections: readonly Connection[];
  trackId: Id;
  tracks: readonly TrackInfo[];
  otherParts: boolean;
}

export function computeLayout({ modules, connections, trackId, tracks, otherParts }: LayoutInput): PanelLayout {
  const own = modules.filter((m) => m.trackId === trackId);
  const lfos = own.filter((m) => m.type === 'lfo');
  const main = mainOrder(own.filter((m) => m.type !== 'lfo'), connections, trackId);
  const shared = modules.filter((m) => !m.trackId && m.type !== 'master');
  const master = modules.find((m) => m.type === 'master' && !m.trackId) ?? modules.find((m) => m.id === MASTER_ID);

  const blocks: BlockGeom[] = [];
  const place = (m: ModuleInfo, variant: BlockVariant, x: number, y: number, w: number, h: number) => {
    blocks.push({ id: m.id, type: m.type, variant, trackId: m.trackId, x, y, w, h, sockets: blockSockets(m, variant, x, y, w, h) });
  };

  const rowTop = GEOM.top;
  let x: number = GEOM.padX;
  for (const m of main) {
    const v = variantOf(m, trackId);
    const w = GEOM.widths[v];
    place(m, v, x, rowTop, w, GEOM.rowH);
    x += w + GEOM.gapX;
  }

  // LFO row under the chain, left aligned.
  const lfoTop = rowTop + GEOM.rowH + GEOM.modGap;
  let lx: number = GEOM.padX;
  for (const m of lfos) {
    place(m, 'lfo', lx, lfoTop, GEOM.widths.lfo, GEOM.lfoH);
    lx += GEOM.widths.lfo + GEOM.lfoGap;
  }
  const lfoRight = lfos.length ? lx - GEOM.lfoGap : 0;

  // Shared returns stacked in a column, below the Channel → Master line.
  let returnsBottom = 0;
  if (shared.length) {
    const colBottom = rowTop + GEOM.returnTop + shared.length * (GEOM.returnH + GEOM.returnGap) - GEOM.returnGap;
    // Keep the column clear of the LFO row when the two would overlap.
    if (colBottom > lfoTop && lfoRight > 0) x = Math.max(x, lfoRight + GEOM.gapX);
    let ry: number = rowTop + GEOM.returnTop;
    for (const m of shared) {
      place(m, 'return', x, ry, GEOM.widths.return, GEOM.returnH);
      ry += GEOM.returnH + GEOM.returnGap;
    }
    returnsBottom = ry - GEOM.returnGap;
    x += GEOM.widths.return + GEOM.gapX;
  }
  if (master) {
    place(master, 'master', x, rowTop, GEOM.widths.master, GEOM.rowH);
    x += GEOM.widths.master + GEOM.gapX;
  }

  let strip: PanelLayout['strip'] = null;
  let stripBottom = 0;
  if (otherParts) {
    const w = GEOM.widths.other;
    let sy: number = rowTop;
    for (const t of tracks) {
      if (t.id === trackId) continue;
      const ch = modules.find((m) => m.id === mid.channel(t.id) && m.type === 'channel');
      if (!ch) continue;
      const ry = Math.round(GEOM.stripRowH / 2);
      blocks.push({
        id: ch.id,
        type: 'channel',
        variant: 'other',
        trackId: t.id,
        x,
        y: sy,
        w,
        h: GEOM.stripRowH,
        sockets: [{ key: socketKey(ch.id, 'in', 'in'), module: ch.id, port: 'in', dir: 'in', kind: 'audio', side: 'left', x, y: sy + ry, rx: 0, ry, label: 'Channel In', tip: `${t.name}'s mixer input. Sound patched here is heard through ${t.name}'s channel.`, variant: 'other', strip: true }],
      });
      sy += GEOM.stripRowH + GEOM.stripGap;
    }
    strip = { x, y: rowTop, w };
    stripBottom = sy - GEOM.stripGap;
    x += w + GEOM.gapX;
  }

  const width = Math.max(x - GEOM.gapX + GEOM.padX, GEOM.padX * 2);
  const lowest = Math.max(rowTop + GEOM.rowH, lfos.length ? lfoTop + GEOM.lfoH : 0, returnsBottom, stripBottom);
  const height = lowest + GEOM.bottom + (lfos.length ? 0 : 12);

  const sockets = new Map<string, SocketGeom>();
  const order: string[] = [];
  for (const b of blocks) {
    for (const s of b.sockets) {
      sockets.set(s.key, s);
      order.push(s.key);
    }
  }
  return {
    width,
    height,
    blocks,
    sockets,
    order,
    stubTopY: 4,
    stubBottomY: height - 4,
    strip,
    midY: rowTop + GEOM.rowH / 2 + 10,
    lfoTop,
  };
}

/* ------------------------------------------------------------------ */
/* Cables                                                              */
/* ------------------------------------------------------------------ */

export interface Point {
  x: number;
  y: number;
}

/** One end of a drawn cable: where the plug sits and which way it points (away from the socket). */
export interface CableEnd {
  socket: SocketGeom;
  angle: number;
}

export interface CableGeom {
  id: Id;
  kind: PortKind;
  name: string;
  amount: number;
  from: CableEnd | null;
  to: CableEnd | null;
  /** Off-screen end: where the stub leaves the panel. */
  stub: StubGeom | null;
  path: string;
}

export interface StubGeom {
  /** The visible socket the stub is plugged into. */
  socketKey: string;
  /** Point where the stub cable ends (at the label). */
  anchor: Point;
  /** Label placement: centred on the anchor (top/bottom edge) or starting at it (to the right). */
  align: 'center' | 'start';
  label: string;
  /** Every connection this stub stands for (more than one = a bundle, not draggable). */
  connectionIds: Id[];
  kind: PortKind;
  path: string;
  /** Plug direction at the socket. */
  angle: number;
}

export const SIDE_ANGLE: Record<Side, number> = { left: Math.PI, right: 0, bottom: Math.PI / 2 };

const MAX_BEND = (60 * Math.PI) / 180;
const MIN_SEP = (34 * Math.PI) / 180;

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Fan out several plugs on one socket so each stays visible and grabbable:
 * each plug starts bent a little toward its cable, then neighbours closer
 * than MIN_SEP are pushed apart symmetrically (so the fan stays centred on
 * where the cables actually go) within ±MAX_BEND of the socket's edge normal.
 */
export function fanAngles(base: number, desired: readonly number[]): number[] {
  const n = desired.length;
  const rel = desired.map((d) => Math.max(-MAX_BEND, Math.min(MAX_BEND, wrap(d - base) * 0.4)));
  if (n === 1) return [base + rel[0]];
  const order = rel.map((r, i) => ({ r, i })).sort((a, b) => a.r - b.r || a.i - b.i);
  const vals = order.map((o) => o.r);
  if ((n - 1) * MIN_SEP >= 2 * MAX_BEND) {
    const span = (2 * MAX_BEND) / (n - 1);
    for (let i = 0; i < n; i++) vals[i] = -MAX_BEND + i * span;
  } else {
    for (let iter = 0; iter < 24; iter++) {
      let moved = false;
      for (let i = 1; i < n; i++) {
        const gap = vals[i] - vals[i - 1];
        if (gap >= MIN_SEP - 1e-6) continue;
        const push = (MIN_SEP - gap) / 2;
        vals[i - 1] -= push;
        vals[i] += push;
        moved = true;
      }
      const lo = -MAX_BEND - vals[0];
      const hi = vals[n - 1] - MAX_BEND;
      if (lo > 0) for (let i = 0; i < n; i++) vals[i] += lo;
      else if (hi > 0) for (let i = 0; i < n; i++) vals[i] -= hi;
      if (!moved && lo <= 0 && hi <= 0) break;
    }
  }
  const out = new Array<number>(n);
  order.forEach((o, k) => (out[o.i] = base + vals[k]));
  return out;
}

const dirOf = (angle: number): Point => ({ x: Math.cos(angle), y: Math.sin(angle) });

export function plugBack(s: Point, angle: number): Point {
  const d = dirOf(angle);
  return { x: s.x + d.x * GEOM.plugLen, y: s.y + d.y * GEOM.plugLen };
}

const f = (n: number) => (Math.round(n * 10) / 10).toString();

/**
 * A hanging cable between two plug backs: tangents follow the plugs, the
 * control points sag with gravity in proportion to the span.
 */
export function cablePath(a: Point, aAngle: number, b: Point, bAngle: number, sagScale = 1): string {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const k = Math.max(16, Math.min(110, dist * 0.42));
  const sag = Math.max(5, Math.min(22, dist * 0.08)) * sagScale;
  const da = dirOf(aAngle);
  const db = dirOf(bAngle);
  const c1 = { x: a.x + da.x * k, y: a.y + da.y * k + sag };
  const c2 = { x: b.x + db.x * k, y: b.y + db.y * k + sag };
  return `M${f(a.x)} ${f(a.y)} C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(b.x)} ${f(b.y)}`;
}

/** Path from a socket's plug to a free point (dragging); the free end points back along the cable. */
export function livePath(s: SocketGeom, angle: number, p: Point): string {
  const a = plugBack(s, angle);
  const back = Math.atan2(a.y - p.y, a.x - p.x);
  return cablePath(a, angle, p, back);
}

export interface CableInput {
  layout: PanelLayout;
  connections: readonly Connection[];
  modules: readonly ModuleInfo[];
  tracks: readonly TrackInfo[];
  trackId: Id;
}

export interface CableSet {
  cables: CableGeom[];
  stubs: StubGeom[];
  /** Connection id → the socket keys of its visible ends. */
  ends: Map<Id, { from?: string; to?: string }>;
}

function stubAnchor(layout: PanelLayout, s: SocketGeom): { anchor: Point; align: 'center' | 'start'; angle: number } {
  const base = SIDE_ANGLE[s.side];
  if (s.side === 'bottom') return { anchor: { x: s.x + 30, y: Math.min(s.y + 24, layout.lfoTop - 11) }, align: 'start', angle: base };
  if (s.variant === 'lfo') return { anchor: { x: s.x + 34, y: layout.lfoTop - 13 }, align: 'start', angle: base };
  const dx = s.side === 'left' ? -30 : 30;
  const top = s.y <= layout.midY;
  return { anchor: { x: s.x + dx, y: top ? layout.stubTopY + 9 : layout.stubBottomY - 9 }, align: 'center', angle: base };
}

/**
 * Every cable of the visible modules: full cables between two visible
 * sockets, and stubs where the other end is outside the panel. Several
 * off-screen cables on one socket are bundled into one labelled stub.
 * Cables that only touch "Other parts" sockets from off-screen are not drawn.
 */
export function computeCables({ layout, connections, modules, tracks, trackId }: CableInput): CableSet {
  const kindOf = (c: Connection) => connectionKindOf(modules, c);
  type Pending = { c: Connection; from: SocketGeom | undefined; to: SocketGeom | undefined };
  const visible: Pending[] = [];
  const stubGroups = new Map<string, { socket: SocketGeom; conns: Connection[] }>();
  for (const c of connections) {
    const from = layout.sockets.get(socketKey(c.from.module, c.from.port, 'out'));
    const to = layout.sockets.get(socketKey(c.to.module, c.to.port, 'in'));
    if (from && to) {
      visible.push({ c, from, to });
      continue;
    }
    const s = from ?? to;
    if (!s || s.strip) continue;
    const g = stubGroups.get(s.key);
    if (g) g.conns.push(c);
    else stubGroups.set(s.key, { socket: s, conns: [c] });
  }

  // Desired plug directions per socket, then fan them out.
  type EndReq = { socket: SocketGeom; toward: Point; id: string };
  const reqs = new Map<string, EndReq[]>();
  const want = (s: SocketGeom, toward: Point, id: string) => {
    const list = reqs.get(s.key);
    const r = { socket: s, toward, id };
    if (list) list.push(r);
    else reqs.set(s.key, [r]);
  };
  for (const v of visible) {
    want(v.from!, v.to!, `${v.c.id}:from`);
    want(v.to!, v.from!, `${v.c.id}:to`);
  }
  const stubInfo = new Map<string, ReturnType<typeof stubAnchor>>();
  for (const [key, g] of stubGroups) {
    const a = stubAnchor(layout, g.socket);
    stubInfo.set(key, a);
    // A single off-panel cable has its own plug; a bundle is drawn plug-less behind the plugs.
    if (g.conns.length === 1) want(g.socket, a.anchor, `stub:${key}`);
  }
  const angles = new Map<string, number>();
  for (const list of reqs.values()) {
    const s = list[0].socket;
    const base = SIDE_ANGLE[s.side];
    const fanned = fanAngles(
      base,
      list.map((r) => Math.atan2(r.toward.y - s.y, r.toward.x - s.x)),
    );
    list.forEach((r, i) => angles.set(r.id, fanned[i]));
  }

  const nameOf = (c: Connection) => cableName(modules, c, tracks, trackId);
  const ends = new Map<Id, { from?: string; to?: string }>();
  const cables: CableGeom[] = visible.map(({ c, from, to }) => {
    const fa = angles.get(`${c.id}:from`)!;
    const ta = angles.get(`${c.id}:to`)!;
    ends.set(c.id, { from: from!.key, to: to!.key });
    return {
      id: c.id,
      kind: kindOf(c),
      name: nameOf(c),
      amount: c.amount ?? 1,
      from: { socket: from!, angle: fa },
      to: { socket: to!, angle: ta },
      stub: null,
      path: cablePath(plugBack(from!, fa), fa, plugBack(to!, ta), ta),
    };
  });

  const partName = (id: Id | undefined) => tracks.find((t) => t.id === id)?.name ?? 'Another part';
  const stubs: StubGeom[] = [];
  for (const [key, g] of stubGroups) {
    const s = g.socket;
    const info = stubInfo.get(key)!;
    const bundle = g.conns.length > 1;
    const base = SIDE_ANGLE[s.side];
    const angle = bundle ? base + Math.max(-MAX_BEND, Math.min(MAX_BEND, wrap(Math.atan2(info.anchor.y - s.y, info.anchor.x - s.x) - base) * 0.5)) : angles.get(`stub:${key}`)!;
    const far = g.conns.map((c) => (s.dir === 'in' ? c.from.module : c.to.module));
    const farMods = far.map((id) => modules.find((m) => m.id === id));
    const parts = [...new Set(farMods.map((m) => m?.trackId ?? ''))];
    const word = s.dir === 'in' ? 'From' : 'To';
    let label: string;
    if (g.conns.length === 1) {
      const m = farMods[0];
      label = `${word} ${m?.trackId ? `${partName(m.trackId)} · ` : ''}${baseModuleName(m ?? { id: far[0], type: 'channel' })}`;
    } else if (parts.length === 1) label = `${word} ${partName(parts[0] || undefined)} · ${g.conns.length} cables`;
    else label = `${word} ${parts.length} other parts`;
    for (const c of g.conns) {
      const e = ends.get(c.id) ?? {};
      if (s.dir === 'in') e.to = s.key;
      else e.from = s.key;
      ends.set(c.id, e);
    }
    const back = bundle ? { x: s.x + Math.cos(angle) * GEOM.socketR, y: s.y + Math.sin(angle) * GEOM.socketR } : plugBack(s, angle);
    // Tangent at the label end points back along the cable (down from a top label, up from a bottom one).
    const anchorAngle = info.align === 'center' ? (info.anchor.y < s.y ? Math.PI / 2 : -Math.PI / 2) : Math.PI;
    const endPt = info.align === 'center' ? { x: info.anchor.x, y: info.anchor.y + (info.anchor.y < s.y ? 9 : -9) } : info.anchor;
    stubs.push({
      socketKey: key,
      anchor: info.anchor,
      align: info.align,
      label,
      connectionIds: g.conns.map((c) => c.id),
      kind: kindOf(g.conns[0]),
      angle,
      path: cablePath(back, angle, endPt, anchorAngle, 0.6),
    });
  }
  return { cables, stubs, ends };
}

/* ------------------------------------------------------------------ */
/* Keyboard navigation between sockets                                 */
/* ------------------------------------------------------------------ */

/** The nearest socket in an arrow direction, or null at the edge. */
export function socketInDirection(layout: PanelLayout, fromKey: string, dir: 'left' | 'right' | 'up' | 'down'): string | null {
  const s = layout.sockets.get(fromKey);
  if (!s) return layout.order[0] ?? null;
  const v = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } }[dir];
  let best: string | null = null;
  let bestScore = Infinity;
  for (const o of layout.sockets.values()) {
    if (o.key === s.key) continue;
    const dx = o.x - s.x;
    const dy = o.y - s.y;
    const along = dx * v.x + dy * v.y;
    if (along <= 2) continue;
    const across = Math.abs(dx * v.y - dy * v.x);
    if (across > along * 2.5 + 20) continue;
    const score = along + across * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = o.key;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Restore Connection                                                  */
/* ------------------------------------------------------------------ */

export type RepairPlan = { kind: 'connect'; from: PortRef; to: PortRef } | { kind: 'restore' };

/**
 * The smallest fix that makes a silent part heard again: when the sound
 * still reaches the part's Channel, plug the Channel back into the Master
 * Out; otherwise restore the part's default cables.
 */
export function repairPlan(patch: Patch, trackId: Id): RepairPlan {
  const inst = mid.inst(trackId);
  const ch = mid.channel(trackId);
  const audioOut = (c: Connection) => {
    if (c.from.port !== 'out') return false;
    const m = patch.modules.find((x) => x.id === c.from.module);
    const n = patch.modules.find((x) => x.id === c.to.module);
    return !!m && !!n && MODULE_DEFS[m.type].ports.some((p) => p.id === 'out' && p.direction === 'out' && p.kind === 'audio') && MODULE_DEFS[n.type].ports.some((p) => p.id === c.to.port && p.direction === 'in' && p.kind === 'audio');
  };
  const seen = new Set<Id>([inst]);
  const stack = [inst];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of patch.connections) {
      if (c.from.module !== cur || !audioOut(c) || seen.has(c.to.module)) continue;
      seen.add(c.to.module);
      stack.push(c.to.module);
    }
  }
  const from = { module: ch, port: 'out' };
  const to = { module: MASTER_ID, port: 'in' };
  if (seen.has(ch) && validateConnection(patch, from, to).ok) return { kind: 'connect', from, to };
  return { kind: 'restore' };
}

/** Number of cables that touch a part's own modules. */
export function partCableCount(patch: Patch, trackId: Id): number {
  const own = new Set(patch.modules.filter((m) => m.trackId === trackId).map((m) => m.id));
  let n = 0;
  for (const c of patch.connections) if (own.has(c.from.module) || own.has(c.to.module)) n++;
  return n;
}
