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
import { LFO_PARAMS, clampParam, readParam, specById } from '../../../project/params';
import { macroTargetValue } from '../../../project/resolve';
import { MACRO_IDS, type Connection, type Id, type MacroId, type ModuleType, type Patch, type PortKind, type PortRef, type Project } from '../../../project/types';

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
  /** Number of horizontal gaps between the columns (for squeezing a slightly too wide layout). */
  hGaps: number;
  /** Measurements the layout was made with. */
  geom: Geometry;
}

/** Block and row measurements (px). The compact set fits patch areas down to ~190 px tall. */
export interface Geometry {
  compact: boolean;
  padX: number;
  /** Band above the main row for stub labels. */
  top: number;
  rowH: number;
  gapX: number;
  modGap: number;
  lfoH: number;
  lfoGap: number;
  bottom: number;
  returnTop: number;
  returnH: number;
  returnGap: number;
  returnSockY: number;
  audioY: number;
  channelOut: Record<string, number>;
  /** Channel mod inputs (x as a fraction of the width), kept clear of the Send B label. */
  channelModX: [number, number];
  masterInY: number;
  lfoSockY: number;
  stripTop: number;
  stripRowH: number;
  stripGap: number;
  stripRows: number;
  widths: Record<BlockVariant, number>;
  socketR: number;
  plugLen: number;
}

const WIDTHS: Record<BlockVariant, number> = { source: 170, effect: 136, channel: 160, return: 212, master: 150, lfo: 208, other: 176 };

/**
 * Spare height in the patch area widens the gap above the LFO row by up to
 * this much, so cables into the modulation inputs run through the gap instead
 * of across the LFO blocks.
 */
export const MAX_EXTRA_MOD_GAP = 30;

export const GEOM: Geometry = {
  compact: false,
  padX: 24,
  top: 24,
  rowH: 132,
  gapX: 58,
  modGap: 28,
  lfoH: 52,
  lfoGap: 28,
  bottom: 8,
  returnTop: 56,
  returnH: 58,
  returnGap: 14,
  returnSockY: 42,
  audioY: 72,
  channelOut: { out: 38, sendA: 72, sendB: 98 },
  channelModX: [0.27, 0.69],
  masterInY: 38,
  lfoSockY: 38,
  stripTop: 24,
  stripRowH: 28,
  stripGap: 4,
  stripRows: 7,
  widths: WIDTHS,
  socketR: 9,
  plugLen: 17,
};

export const GEOM_COMPACT: Geometry = {
  ...GEOM,
  compact: true,
  top: 14,
  rowH: 112,
  modGap: 22,
  lfoH: 42,
  bottom: 2,
  returnTop: 44,
  returnH: 50,
  returnGap: 10,
  returnSockY: 36,
  audioY: 60,
  channelOut: { out: 32, sendA: 56, sendB: 79 },
  channelModX: [0.19, 0.58],
  masterInY: 32,
  lfoSockY: 32,
  stripTop: 20,
  stripRowH: 28,
  stripGap: 4,
  stripRows: 4,
  widths: { ...WIDTHS, channel: 172 },
};

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

function blockSockets(g: Geometry, m: ModuleInfo, variant: BlockVariant, x: number, y: number, w: number, h: number): SocketGeom[] {
  const ports = MODULE_DEFS[m.type].ports;
  const out: SocketGeom[] = [];
  const add = (p: PortDef, side: Side, rx: number, ry: number) =>
    out.push({ key: socketKey(m.id, p.id, p.direction), module: m.id, port: p.id, dir: p.direction, kind: p.kind, side, x: x + rx, y: y + ry, rx, ry, label: socketLabel(p), tip: p.tip, variant, strip: false });

  const audioIns = ports.filter((p) => p.direction === 'in' && p.kind === 'audio');
  const modIns = ports.filter((p) => p.direction === 'in' && p.kind === 'mod');
  const outs = ports.filter((p) => p.direction === 'out');

  const rowY = variant === 'return' ? g.returnSockY : variant === 'lfo' ? g.lfoSockY : variant === 'master' ? g.masterInY : g.audioY;
  audioIns.forEach((p, i) => add(p, 'left', 0, audioIns.length === 1 ? rowY : rowY + i * 30));
  outs.forEach((p, i) => {
    let ry = rowY + i * 30;
    if (variant === 'channel' && g.channelOut[p.id] !== undefined) ry = g.channelOut[p.id];
    add(p, 'right', w, ry);
  });
  const xs = variant === 'channel' && modIns.length === 2 ? g.channelModX.map((f) => Math.round(w * f)) : spread(modIns.length, w);
  modIns.forEach((p, i) => add(p, 'bottom', xs[i], h));
  return out;
}

/**
 * Order of the part's audio modules: the instrument first, the channel last,
 * effects at their place in the signal path, so a linear chain reads left to
 * right and branches stay in signal order.
 *
 * An effect's place is its distance from the instrument (longest path). An
 * effect the instrument no longer reaches keeps its place by its distance to
 * the channel instead, so pulling one cable out of a chain does not reshuffle
 * the blocks. Ties keep the patch's module order. Effects with no cables at
 * all sit just before the channel.
 */
function mainOrder(mods: readonly ModuleInfo[], connections: readonly Connection[], trackId: Id): ModuleInfo[] {
  const inst = mods.find((m) => m.id === mid.inst(trackId) && m.type === 'instrument');
  const ch = mods.find((m) => m.id === mid.channel(trackId) && m.type === 'channel');
  const ids = new Set(mods.map((m) => m.id));
  const preds = new Map<Id, Id[]>();
  const succs = new Map<Id, Id[]>();
  /** Modules with an audio cable leaving the part (to the Master Out, a return or another part). */
  const exits = new Set<Id>();
  for (const c of connections) {
    if (!ids.has(c.from.module) || c.from.module === c.to.module) continue;
    const fromM = mods.find((m) => m.id === c.from.module);
    if (portOf(fromM, c.from.port, 'out')?.kind !== 'audio') continue;
    if (!ids.has(c.to.module)) {
      exits.add(c.from.module);
      continue;
    }
    (preds.get(c.to.module) ?? preds.set(c.to.module, []).get(c.to.module)!).push(c.from.module);
    (succs.get(c.from.module) ?? succs.set(c.from.module, []).get(c.from.module)!).push(c.to.module);
  }
  // Longest distance from the instrument / to the channel (or out of the part); undefined when not connected that way.
  const memo = (walk: (id: Id, self: (id: Id) => number | undefined) => number | undefined) => {
    const known = new Map<Id, number | undefined>();
    const self = (id: Id): number | undefined => {
      if (known.has(id)) return known.get(id);
      known.set(id, undefined); // defensive: patches are acyclic
      const v = walk(id, self);
      known.set(id, v);
      return v;
    };
    return self;
  };
  const maxOf = (vals: (number | undefined)[]) => vals.reduce<number | undefined>((a, v) => (v === undefined ? a : a === undefined ? v : Math.max(a, v)), undefined);
  const fwd = memo((id, self) => {
    if (id === inst?.id) return 0;
    const d = maxOf((preds.get(id) ?? []).filter((p) => p !== ch?.id).map(self));
    return d === undefined ? undefined : d + 1;
  });
  const back = memo((id, self) => {
    if (id === ch?.id) return 0;
    const d = maxOf([...(succs.get(id) ?? []).filter((s) => s !== inst?.id).map(self), exits.has(id) ? 0 : undefined]);
    return d === undefined ? undefined : d + 1;
  });

  const effects = mods.filter((m) => m !== inst && m !== ch);
  const chPos = (maxOf(effects.flatMap((m) => [fwd(m.id), back(m.id)])) ?? 0) + 1;
  const pos = (id: Id): number => {
    const f = fwd(id);
    if (f !== undefined) return f;
    const b = back(id);
    return b !== undefined ? chPos - b : chPos - 0.5;
  };
  const index = new Map(mods.map((m, i) => [m.id, i]));
  const sorted = [...effects].sort((a, b) => pos(a.id) - pos(b.id) || index.get(a.id)! - index.get(b.id)!);
  return [...(inst ? [inst] : []), ...sorted, ...(ch ? [ch] : [])];
}

export interface LayoutInput {
  modules: readonly ModuleInfo[];
  connections: readonly Connection[];
  trackId: Id;
  tracks: readonly TrackInfo[];
  otherParts: boolean;
  /** Use the compact measurements (short patch areas). */
  compact?: boolean;
  /** Height of the patch area: spare room (if any) widens the gap above the LFO row. */
  fitHeight?: number;
  /** Horizontal gap between columns (default: the geometry's). */
  gapX?: number;
}

/** Narrowest column gap: two plugs (17 px each) plus a short visible cable. */
export const MIN_GAP_X = 44;

export function computeLayout({ modules, connections, trackId, tracks, otherParts, compact = false, fitHeight = 0, gapX }: LayoutInput): PanelLayout {
  const base = compact ? GEOM_COMPACT : GEOM;
  const g: Geometry = gapX === undefined ? base : { ...base, gapX };
  let hGaps = 0;
  const own = modules.filter((m) => m.trackId === trackId);
  const lfos = own.filter((m) => m.type === 'lfo');
  const main = mainOrder(own.filter((m) => m.type !== 'lfo'), connections, trackId);
  const shared = modules.filter((m) => !m.trackId && m.type !== 'master');
  const master = modules.find((m) => m.type === 'master' && !m.trackId) ?? modules.find((m) => m.id === MASTER_ID);

  const blocks: BlockGeom[] = [];
  const place = (m: ModuleInfo, variant: BlockVariant, x: number, y: number, w: number, h: number) => {
    blocks.push({ id: m.id, type: m.type, variant, trackId: m.trackId, x, y, w, h, sockets: blockSockets(g, m, variant, x, y, w, h) });
  };

  const rowTop = g.top;
  let x: number = g.padX;
  for (const m of main) {
    const v = variantOf(m, trackId);
    const w = g.widths[v];
    place(m, v, x, rowTop, w, g.rowH);
    x += w + g.gapX;
    hGaps++;
  }

  // LFO row under the chain, left aligned.
  const lfoTop = rowTop + g.rowH + g.modGap;
  let lx: number = g.padX;
  for (const m of lfos) {
    place(m, 'lfo', lx, lfoTop, g.widths.lfo, g.lfoH);
    lx += g.widths.lfo + g.lfoGap;
  }
  const lfoRight = lfos.length ? lx - g.lfoGap : 0;

  // Shared returns stacked in a column, below the Channel → Master line.
  let returnsBottom = 0;
  if (shared.length) {
    const colBottom = rowTop + g.returnTop + shared.length * (g.returnH + g.returnGap) - g.returnGap;
    // Keep the column clear of the LFO row when the two would overlap.
    if (colBottom > lfoTop && lfoRight > 0) x = Math.max(x, lfoRight + g.gapX);
    let ry: number = rowTop + g.returnTop;
    for (const m of shared) {
      place(m, 'return', x, ry, g.widths.return, g.returnH);
      ry += g.returnH + g.returnGap;
    }
    returnsBottom = ry - g.returnGap;
    x += g.widths.return + g.gapX;
    hGaps++;
  }
  if (master) {
    place(master, 'master', x, rowTop, g.widths.master, g.rowH);
    x += g.widths.master + g.gapX;
    hGaps++;
  }

  let strip: PanelLayout['strip'] = null;
  let stripBottom = 0;
  if (otherParts) {
    const w = g.widths.other;
    const others = tracks.filter((t) => t.id !== trackId && modules.some((m) => m.id === mid.channel(t.id) && m.type === 'channel'));
    const x0 = x;
    others.forEach((t, i) => {
      const col = Math.floor(i / g.stripRows);
      const row = i % g.stripRows;
      const bx = x0 + col * (w + 16);
      const by = g.stripTop + row * (g.stripRowH + g.stripGap);
      const chId = mid.channel(t.id);
      const ry = Math.round(g.stripRowH / 2);
      blocks.push({
        id: chId,
        type: 'channel',
        variant: 'other',
        trackId: t.id,
        x: bx,
        y: by,
        w,
        h: g.stripRowH,
        sockets: [{ key: socketKey(chId, 'in', 'in'), module: chId, port: 'in', dir: 'in', kind: 'audio', side: 'left', x: bx, y: by + ry, rx: 0, ry, label: 'Channel In', tip: `${t.name}'s mixer input. Sound patched here is heard through ${t.name}'s channel.`, variant: 'other', strip: true }],
      });
      stripBottom = Math.max(stripBottom, by + g.stripRowH);
    });
    const cols = Math.max(1, Math.ceil(others.length / g.stripRows));
    const stripW = cols * w + (cols - 1) * 16;
    strip = { x: x0, y: g.stripTop, w: stripW };
    x += stripW + g.gapX;
    hGaps++;
  }

  const width = Math.max(x - g.gapX + g.padX, g.padX * 2);
  const lowest = Math.max(rowTop + g.rowH, lfos.length ? lfoTop + g.lfoH : 0, returnsBottom, stripBottom);
  let height = lowest + g.bottom + (lfos.length ? 0 : 12);

  // Use spare height for a wider modulation gap: move the LFO row down.
  let lfoRowTop = lfoTop;
  if (lfos.length && fitHeight > height) {
    const lfoBottom = lfoTop + g.lfoH;
    // Keep a little air under the LFO row so it never looks cut off at the edge.
    const reserve = Math.max(0, 8 - g.bottom);
    const extra = Math.min(MAX_EXTRA_MOD_GAP, fitHeight - height - reserve + Math.max(0, lowest - lfoBottom));
    if (extra > 0) {
      lfoRowTop = lfoTop + extra;
      for (const b of blocks) {
        if (b.variant !== 'lfo') continue;
        b.y += extra;
        for (const s of b.sockets) s.y += extra;
      }
      height = Math.max(lowest, lfoBottom + extra) + g.bottom;
    }
  }

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
    stubTopY: compact ? 0 : 4,
    stubBottomY: height - (compact ? 0 : 4),
    strip,
    midY: rowTop + g.rowH / 2 + 10,
    lfoTop: lfoRowTop,
    hGaps: Math.max(0, hGaps - 1),
    geom: g,
  };
}

/**
 * The layout for a patch area of the given size: compact measurements when
 * the regular ones are too tall, and slightly narrower column gaps when the
 * patch is just a little too wide (so no scrollbar appears for a few pixels).
 * A patch that is still wider scrolls sideways.
 */
export function fitLayout(input: Omit<LayoutInput, 'compact' | 'fitHeight' | 'gapX'>, fit: { width: number; height: number }): PanelLayout {
  const make = (compact: boolean, gapX?: number) => computeLayout({ ...input, compact, fitHeight: fit.height, gapX });
  let layout = make(false);
  const compact = fit.height > 0 && fit.height < layout.height;
  if (compact) layout = make(true);
  if (fit.width > 0 && layout.width > fit.width && layout.hGaps > 0) {
    const gapX = layout.geom.gapX - Math.ceil((layout.width - fit.width) / layout.hGaps);
    if (gapX >= MIN_GAP_X) layout = make(compact, gapX);
  }
  return layout;
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

/** A single plug's direction: the socket's edge normal, bent a little toward where its cable goes. */
export function bentAngle(s: Pick<SocketGeom, 'x' | 'y' | 'side'>, toward: Point): number {
  return fanAngles(SIDE_ANGLE[s.side], [Math.atan2(toward.y - s.y, toward.x - s.x)])[0];
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

export function samePlan(a: RepairPlan | null, b: RepairPlan | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'restore' || b.kind === 'restore') return true;
  return a.from.module === b.from.module && a.from.port === b.from.port && a.to.module === b.to.module && a.to.port === b.to.port;
}

/**
 * The smallest fix that makes a silent part heard again: one cable from
 * where the part's sound stops to where the rest of its chain still reaches
 * the Master Out (a broken link anywhere in the chain is plugged back, and
 * everything else the user patched stays). Only the part's own Channel may
 * go straight to the Master Out, so a fix never skips the part's mixer.
 * When no single cable can do it, the part's default cables are restored.
 *
 * Like `hasPathToMaster`, only primary ("out") audio outputs count: a part
 * heard only through a send is still reported as silent.
 */
export function repairPlan(patch: Patch, trackId: Id): RepairPlan {
  const inst = mid.inst(trackId);
  const ch = mid.channel(trackId);
  const byId = new Map(patch.modules.map((m) => [m.id, m]));
  const port = (id: Id, portId: string, dir: SocketDir) => portOf(byId.get(id), portId, dir);
  const hasOut = (id: Id) => port(id, 'out', 'out')?.kind === 'audio';
  const hasIn = (id: Id) => port(id, 'in', 'in')?.kind === 'audio';
  const links = patch.connections.filter((c) => c.from.port === 'out' && hasOut(c.from.module) && port(c.to.module, c.to.port, 'in')?.kind === 'audio');

  // How far the sound gets from the instrument, and what still reaches the Master Out (with distance).
  const depth = new Map<Id, number>([[inst, 0]]);
  for (const queue = [inst]; queue.length; ) {
    const cur = queue.shift()!;
    for (const c of links) {
      if (c.from.module !== cur || depth.has(c.to.module)) continue;
      depth.set(c.to.module, depth.get(cur)! + 1);
      queue.push(c.to.module);
    }
  }
  const toMaster = new Map<Id, number>([[MASTER_ID, 0]]);
  for (const queue = [MASTER_ID as Id]; queue.length; ) {
    const cur = queue.shift()!;
    for (const c of links) {
      if (c.to.module !== cur || toMaster.has(c.from.module)) continue;
      toMaster.set(c.from.module, toMaster.get(cur)! + 1);
      queue.push(c.from.module);
    }
  }
  const own = (id: Id) => byId.get(id)?.trackId === trackId;
  const feeds = (id: Id) => links.some((c) => c.from.module === id);
  const fed = (id: Id) => links.some((c) => c.to.module === id);

  // Sources: where the sound currently stops first (dead ends), deepest first.
  const froms = [...depth.keys()].filter((id) => own(id) && hasOut(id)).sort((a, b) => Number(feeds(a)) - Number(feeds(b)) || depth.get(b)! - depth.get(a)!);
  // Destinations: the part's modules that still reach the Master Out; unfed inputs first, earliest in the chain first.
  const tos = [...toMaster.keys()].filter((id) => id !== inst && own(id) && hasIn(id)).sort((a, b) => Number(fed(a)) - Number(fed(b)) || toMaster.get(b)! - toMaster.get(a)!);

  for (const fromId of froms) {
    const targets = fromId === ch ? [...tos, MASTER_ID] : tos;
    for (const toId of targets) {
      if (toId === fromId) continue;
      const from = { module: fromId, port: 'out' };
      const to = { module: toId, port: 'in' };
      if (validateConnection(patch, from, to).ok) return { kind: 'connect', from, to };
    }
  }
  return { kind: 'restore' };
}

/* ------------------------------------------------------------------ */
/* LFO depth                                                           */
/* ------------------------------------------------------------------ */

const LFO_DEPTH = specById(LFO_PARAMS, 'depth')!;

/**
 * The depth an LFO really runs at (after macros) and the macro that sets it,
 * if any. A cable from an LFO at depth 0 moves nothing, so the panel says so.
 */
export function lfoDepth(p: Project, moduleIdStr: Id): { depth: number; macro: MacroId | null; trackId: Id | null } | null {
  const m = p.patch.modules.find((x) => x.id === moduleIdStr);
  if (!m || m.type !== 'lfo') return null;
  let depth = readParam(LFO_PARAMS, m.params, 'depth');
  let macro: MacroId | null = null;
  let owner: Id | null = null;
  // Same order as the engine's macro resolution: the last mapping wins.
  for (const t of p.tracks) {
    for (const id of MACRO_IDS) {
      for (const target of t.macroMap[id] ?? []) {
        if (target.module !== moduleIdStr || target.param !== 'depth') continue;
        depth = clampParam(LFO_DEPTH, macroTargetValue(target, t.macros[id]));
        macro = id;
        owner = t.id;
      }
    }
  }
  return { depth, macro, trackId: owner };
}

/** Number of cables that touch a part's own modules. */
export function partCableCount(patch: Patch, trackId: Id): number {
  const own = new Set(patch.modules.filter((m) => m.trackId === trackId).map((m) => m.id));
  let n = 0;
  for (const c of patch.connections) if (own.has(c.from.module) || own.has(c.to.module)) n++;
  return n;
}
