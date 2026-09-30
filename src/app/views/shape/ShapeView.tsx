/**
 * Shape: detailed sound design for the selected part, in the same workspace.
 *
 *   [ part selector: 8 parts, selected = teal                         ]
 *   [ MACROS | INSTRUMENT | EFFECTS (chain, channel, returns, LFOs)   ]
 *   [ CABLES (collapsible, resizable split)                           ]
 *
 * Everything edits the real project through the session and commands, so
 * the effects rack and the cable panel always show the same routing.
 */
import { memo, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Button, Icon } from '../../../ui/components';
import { useElementSize } from '../../../ui/hooks/useElementSize';
import type { Id, InstrumentKind } from '../../../project/types';
import { selectTrack, setCablesOpen } from '../../../state/uiStore';
import { shallowEqual } from '../../../state/store';
import { useProject, useUi } from '../../instance';
import { INSTRUMENT_LABEL, soundName } from '../../labels';
import { useRuntime } from '../../runtime';
import { CablePanelFrame } from '../cables/CablePanel';
import { EffectsRack } from './EffectsRack';
import { InstrumentColumn } from './InstrumentColumn';
import { MacroColumn } from './MacroColumn';
import { sameItems } from './paramState';
import styles from './ShapeView.module.css';

/* ------------------------------------------------------------------ */
/* Part selector                                                       */
/* ------------------------------------------------------------------ */

interface PartInfo {
  name: string;
  sound: string;
  kind: InstrumentKind;
  mute: boolean;
}

const PartButton = memo(function PartButton(props: { id: Id; index: number; selected: boolean; onKey(e: KeyboardEvent<HTMLButtonElement>): void }) {
  const { id, index, selected, onKey } = props;
  const info = useProject<PartInfo | null>((p) => {
    const t = p.tracks.find((x) => x.id === id);
    return t ? { name: t.name, sound: soundName(p, t.instrument), kind: t.instrument.kind, mute: t.mute } : null;
  }, shallowEqual);
  const playing = useRuntime((s) => s.playing && (s.tracks[id]?.playingSlot ?? null) !== null);
  if (!info) return null;
  const states = [selected ? 'selected' : null, playing ? 'playing' : null, info.mute ? 'muted' : null].filter(Boolean).join(', ');
  return (
    <button
      type="button"
      role="radio"
      id={`shape-part-${id}`}
      aria-checked={selected}
      aria-label={`${index + 1} ${info.name}, ${info.sound} (${INSTRUMENT_LABEL[info.kind]})${states ? `, ${states}` : ''}`}
      tabIndex={selected ? 0 : -1}
      className={styles.part}
      data-selected={selected || undefined}
      onClick={() => selectTrack(id)}
      onKeyDown={onKey}
    >
      <span className={`${styles.partNum} mono`}>{index + 1}</span>
      <span className={styles.partText}>
        <span className={styles.partName}>{info.name}</span>
        <span className={styles.partSound}>{info.sound}</span>
      </span>
      <span className={styles.partState} aria-hidden="true">
        {info.mute && <span className={styles.muted}>M</span>}
        {playing ? (
          <span className={styles.playing}>
            <Icon name="play" size={9} />
          </span>
        ) : (
          <span className={styles.lamp} />
        )}
      </span>
    </button>
  );
});

function PartStrip(props: { ids: readonly Id[]; selected: Id }) {
  const { ids, selected } = props;
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = ids.indexOf(selected);
    let next = -1;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (i + 1) % ids.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (i - 1 + ids.length) % ids.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = ids.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    selectTrack(ids[next]);
    requestAnimationFrame(() => document.getElementById(`shape-part-${ids[next]}`)?.focus());
  };
  return (
    <div className={styles.strip} role="radiogroup" aria-label="Part to shape">
      {ids.map((id, i) => (
        <PartButton key={id} id={id} index={i} selected={id === selected} onKey={onKey} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cable dock (collapsible, resizable split)                           */
/* ------------------------------------------------------------------ */

const DOCK_MIN = 200;
const DOCK_DEFAULT_MIN = 280;
const DOCK_DEFAULT_MAX = 320;
/** Room the columns keep above an open cable panel. */
const COLUMNS_MIN = 170;
/** Part strip + gaps + splitter above an open cable panel (the view height excludes its padding). */
const CHROME = 44 + 10 * 2 + 10;

function CableDock(props: { trackId: Id; viewHeight: number }) {
  const { trackId, viewHeight } = props;
  const open = useUi((s) => s.cablesOpen);
  const partName = useProject((p) => p.tracks.find((t) => t.id === trackId)?.name ?? '');
  const [userHeight, setUserHeight] = useState<number | null>(null);
  const drag = useRef<{ pointerId: number; startY: number; startH: number } | null>(null);
  const panelId = useId();
  const showId = `${panelId}-show`;
  const hideId = `${panelId}-hide`;

  const max = Math.max(DOCK_MIN, viewHeight - CHROME - COLUMNS_MIN);
  const preferred = Math.min(DOCK_DEFAULT_MAX, Math.max(DOCK_DEFAULT_MIN, Math.round(viewHeight * 0.4)));
  const height = Math.round(Math.min(max, Math.max(DOCK_MIN, userHeight ?? preferred)));
  const setClamped = (h: number) => setUserHeight(Math.min(max, Math.max(DOCK_MIN, Math.round(h))));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    drag.current = { pointerId: e.pointerId, startY: e.clientY, startH: height };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    setClamped(d.startH + (d.startY - e.clientY));
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === e.pointerId) drag.current = null;
  };
  const onSplitKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    switch (e.key) {
      case 'ArrowUp':
        setClamped(height + step);
        break;
      case 'ArrowDown':
        setClamped(height - step);
        break;
      case 'Home':
        setClamped(DOCK_MIN);
        break;
      case 'End':
        setClamped(max);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const toggle = (next: boolean) => {
    setCablesOpen(next);
    // The toggle moves between the folded bar and the panel's toolbar: keep keyboard focus on it.
    requestAnimationFrame(() => document.getElementById(next ? hideId : showId)?.focus());
  };

  if (!open) {
    return (
      <section className={styles.dock} aria-label="Cable panel">
        <div className={styles.dockBar}>
          <Icon name="cable" size={16} className={styles.dockIcon} />
          <h2 className={styles.dockTitle}>Cables</h2>
          <span className={styles.dockSub}>Patch the real audio and modulation routing of {partName || 'this part'}. The effects rack above edits the same cables.</span>
          <span className={styles.dockRule} aria-hidden="true" />
          <Button id={showId} size="sm" icon="chevronUp" aria-expanded={false} onClick={() => toggle(true)} tip="Open the cable panel: drag cables between sockets to reroute this part.">
            Show cables
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.dock} data-open aria-label="Cable panel">
      <div
        className={styles.splitter}
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-controls={panelId}
        aria-label="Resize cable panel"
        aria-valuemin={DOCK_MIN}
        aria-valuemax={max}
        aria-valuenow={height}
        aria-valuetext={`Cable panel ${height} pixels tall`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={onSplitKey}
      >
        <span className={styles.grip} aria-hidden="true" />
      </div>
      <div id={panelId} className={styles.dockBody}>
        <CablePanelFrame
          trackId={trackId}
          height={height}
          headerStart={
            <Button
              id={hideId}
              size="sm"
              variant="ghost"
              icon="chevronDown"
              aria-expanded
              aria-controls={panelId}
              onClick={() => toggle(false)}
              tip="Fold the cable panel away to give the knobs more room. Drag the grip above it to resize instead."
            >
              Hide
            </Button>
          }
        />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function ShapeView() {
  const rootRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(rootRef);
  const ids = useProject<Id[]>((p) => p.tracks.map((t) => t.id), sameItems);
  const chosen = useUi((s) => s.selectedTrackId);
  const trackId = ids.includes(chosen) ? chosen : (ids[0] ?? 't1');
  return (
    <div ref={rootRef} className={styles.view}>
      <PartStrip ids={ids} selected={trackId} />
      <div className={styles.columns}>
        <MacroColumn key={`m-${trackId}`} trackId={trackId} className={styles.col} />
        <InstrumentColumn key={`i-${trackId}`} trackId={trackId} className={styles.col} />
        <EffectsRack key={`e-${trackId}`} trackId={trackId} className={styles.col} />
      </div>
      <CableDock trackId={trackId} viewHeight={size.height} />
    </div>
  );
}
