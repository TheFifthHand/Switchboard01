/**
 * SVG cable layers of the cable panel.
 *
 * - `CableHitLayer` sits *under* the module blocks: wide invisible strokes
 *   that select a cable where it crosses empty panel, without covering the
 *   blocks' switches and sockets.
 * - `CableArtLayer` sits *above* the blocks: the hanging cables themselves
 *   (shadow, casing, core, sheen), the plugs at both ends (grab a plug to
 *   move or unplug that end) and the live cable while dragging. The live
 *   cable is updated through refs, never through React state.
 * - `StubLabels` are the HTML labels where a cable leaves the panel.
 */
import { memo, type PointerEvent as ReactPointerEvent, type Ref } from 'react';
import type { Id, PortKind } from '../../../project/types';
import { GEOM, type CableGeom, type CableSet, type PanelLayout, type SocketGeom } from './model';
import styles from './CablePanel.module.css';

const deg = (a: number) => (a * 180) / Math.PI;

export interface PlugGrab {
  connectionId: Id;
  end: 'from' | 'to';
  socketKey: string;
}

export interface CableLayerHandlers {
  plugDown(e: ReactPointerEvent<SVGGElement>, grab: PlugGrab): void;
  cableDown(e: ReactPointerEvent<SVGPathElement>, connectionId: Id): void;
}

function amountOpacity(kind: PortKind, amount: number): number {
  return kind === 'mod' ? 0.42 + 0.58 * Math.min(1, Math.abs(amount)) : 1;
}

export function Plug(props: { socket: Pick<SocketGeom, 'x' | 'y' | 'key'>; angle: number; kind: PortKind; grab?: PlugGrab; handlers?: CableLayerHandlers; selected?: boolean; gRef?: Ref<SVGGElement> }) {
  const { socket, angle, kind, grab, handlers, selected, gRef } = props;
  return (
    <g
      ref={gRef}
      className={styles.plug}
      data-kind={kind}
      data-selected={selected || undefined}
      data-grab={grab ? 'yes' : undefined}
      data-socket-key={socket.key}
      data-plug={grab ? `${grab.connectionId}:${grab.end}` : undefined}
      transform={`translate(${socket.x} ${socket.y}) rotate(${deg(angle).toFixed(1)})`}
      onPointerDown={grab && handlers ? (e) => handlers.plugDown(e, grab) : undefined}
    >
      <rect className={styles.plugHit} x={-3} y={-9} width={GEOM.plugLen + 7} height={18} rx={5} />
      <circle className={styles.plugTip} cx={0} cy={0} r={4.4} />
      <rect className={styles.plugBody} x={2.5} y={-5.6} width={11.5} height={11.2} rx={3.2} />
      <rect className={styles.plugGrip} x={5.5} y={-5.6} width={1.2} height={11.2} />
      <rect className={styles.plugGrip} x={8.5} y={-5.6} width={1.2} height={11.2} />
      <rect className={styles.plugBoot} x={12.5} y={-3.9} width={GEOM.plugLen - 12} height={7.8} rx={2.2} />
    </g>
  );
}

function CableBody(props: { d: string; kind: PortKind; opacity: number; selected?: boolean; faint?: boolean }) {
  const { d, kind, opacity, selected, faint } = props;
  return (
    <g className={styles.cable} data-kind={kind} data-selected={selected || undefined} data-faint={faint || undefined} style={{ opacity }}>
      <path className={styles.cableCasing} d={d} />
      <path className={styles.cableCore} d={d} />
      <path className={styles.cableSheen} d={d} />
    </g>
  );
}

export interface ArtProps {
  layout: PanelLayout;
  set: CableSet;
  selectedId: Id | null;
  /** Cable being moved (drawn live instead). */
  hiddenId: Id | null;
  handlers: CableLayerHandlers;
  editable: boolean;
}

export const CableArtLayer = memo(function CableArtLayer({ layout, set, selectedId, hiddenId, handlers, editable }: ArtProps) {
  const shown = set.cables.filter((c) => c.id !== hiddenId);
  const stubs = set.stubs.filter((s) => !(hiddenId && s.connectionIds.length === 1 && s.connectionIds[0] === hiddenId));
  return (
    <svg className={styles.art} width={layout.width} height={layout.height} aria-hidden="true">
      <g className={styles.shadows}>
        {stubs.map((s) => (
          <path key={`sh-${s.socketKey}`} d={s.path} className={styles.shadow} data-faint={s.connectionIds.length > 1 || undefined} />
        ))}
        {shown.map((c) => (
          <path key={`sh-${c.id}`} d={c.path} className={styles.shadow} />
        ))}
      </g>
      {stubs.map((s) => (
        <CableBody key={`st-${s.socketKey}`} d={s.path} kind={s.kind} opacity={s.connectionIds.length > 1 ? 0.55 : 0.85} faint={s.connectionIds.length > 1} selected={s.connectionIds.length === 1 && s.connectionIds[0] === selectedId} />
      ))}
      {shown.map((c) => (
        <CableBody key={c.id} d={c.path} kind={c.kind} opacity={amountOpacity(c.kind, c.amount)} selected={c.id === selectedId} />
      ))}
      <g className={styles.plugs} data-editable={editable || undefined}>
        {stubs.map((s) => {
          const sock = layout.sockets.get(s.socketKey)!;
          const single = s.connectionIds.length === 1;
          const grab: PlugGrab | undefined = single ? { connectionId: s.connectionIds[0], end: sock.dir === 'in' ? 'to' : 'from', socketKey: s.socketKey } : undefined;
          return <Plug key={`sp-${s.socketKey}`} socket={sock} angle={s.angle} kind={s.kind} grab={editable ? grab : undefined} handlers={handlers} selected={single && s.connectionIds[0] === selectedId} />;
        })}
        {shown.map((c: CableGeom) => [
          c.from && <Plug key={`${c.id}-f`} socket={c.from.socket} angle={c.from.angle} kind={c.kind} grab={editable ? { connectionId: c.id, end: 'from', socketKey: c.from.socket.key } : undefined} handlers={handlers} selected={c.id === selectedId} />,
          c.to && <Plug key={`${c.id}-t`} socket={c.to.socket} angle={c.to.angle} kind={c.kind} grab={editable ? { connectionId: c.id, end: 'to', socketKey: c.to.socket.key } : undefined} handlers={handlers} selected={c.id === selectedId} />,
        ])}
      </g>
    </svg>
  );
});

export const CableHitLayer = memo(function CableHitLayer(props: { layout: PanelLayout; set: CableSet; hiddenId: Id | null; handlers: CableLayerHandlers }) {
  const { layout, set, hiddenId, handlers } = props;
  return (
    <svg className={styles.hits} width={layout.width} height={layout.height} aria-hidden="true">
      {set.stubs
        .filter((s) => s.connectionIds.length === 1 && s.connectionIds[0] !== hiddenId)
        .map((s) => (
          <path key={s.socketKey} d={s.path} className={styles.hit} data-cable={s.connectionIds[0]} onPointerDown={(e) => handlers.cableDown(e, s.connectionIds[0])} />
        ))}
      {set.cables
        .filter((c) => c.id !== hiddenId)
        .map((c) => (
          <path key={c.id} d={c.path} className={styles.hit} data-cable={c.id} onPointerDown={(e) => handlers.cableDown(e, c.id)} />
        ))}
    </svg>
  );
});

/** Labels at the ends of stubs ("From 7 other parts", "To Bass · Channel"); identical labels at one spot are shown once. */
export const StubLabels = memo(function StubLabels(props: { set: CableSet }) {
  const seen = new Set<string>();
  const shown = props.set.stubs.filter((s) => {
    const k = `${s.label}|${Math.round(s.anchor.x / 24)}|${Math.round(s.anchor.y / 24)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return (
    <>
      {shown.map((s) => (
        <span
          key={s.socketKey}
          className={styles.stubLabel}
          data-kind={s.kind}
          data-align={s.align}
          data-bundle={s.connectionIds.length > 1 || undefined}
          style={{ left: s.anchor.x, top: s.anchor.y }}
          aria-hidden="true"
        >
          {s.label}
        </span>
      ))}
    </>
  );
});

/** Refs the panel writes to while a cable is being dragged. */
export interface LiveRefs {
  shadow: Ref<SVGPathElement>;
  casing: Ref<SVGPathElement>;
  core: Ref<SVGPathElement>;
  freePlug: Ref<SVGGElement>;
}

export function LiveCable(props: { layout: PanelLayout; kind: PortKind; fixed: { socket: SocketGeom | null; angle: number }; refs: LiveRefs }) {
  const { layout, kind, fixed, refs } = props;
  return (
    <svg className={styles.live} width={layout.width} height={layout.height} aria-hidden="true">
      <path ref={refs.shadow} className={styles.shadow} d="" />
      <g className={styles.cable} data-kind={kind} data-live="yes">
        <path ref={refs.casing} className={styles.cableCasing} d="" />
        <path ref={refs.core} className={styles.cableCore} d="" />
      </g>
      {fixed.socket && <Plug socket={fixed.socket} angle={fixed.angle} kind={kind} />}
      <g ref={refs.freePlug} className={styles.freePlug} data-kind={kind}>
        <Plug socket={{ x: 0, y: 0, key: '' }} angle={0} kind={kind} />
      </g>
    </svg>
  );
}
