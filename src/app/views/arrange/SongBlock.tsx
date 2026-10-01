/**
 * One block of the song lane: a column with a header (name, length, play
 * from here, actions) over one cell per part, edge to edge with its
 * neighbours. Its position and width are written by the lane (LaneGestures),
 * never by React, so dragging never re-renders it.
 *
 *   ┌───────────────────────┐
 *   │ Groove        ▶  ⋯    │  name · 16 bars (4 × 4) · Playing
 *   ├───────────┊───────────┤  ┊ = pass divider (hover: scissors splits there)
 *   │▌Four on th┊e floor    │  part plays (clip name)
 *   │ Off       ┊           │  switched off here (coral)
 *   │⧉ from Lift┊           │  layered from another scene
 *   └───────────┴──────────╢  ╢ = right-edge handle (drag = passes)
 */
import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon, Tooltip } from '../../../ui/components';
import type { Id } from '../../../project/types';
import { MAX_BLOCK_LABEL } from '../../../project/types';
import { LaneIcon } from './laneIcons';
import { barsText, blockLabel, cellLabel, cellOn, cellState, type BlockView, type CellView, type LayerPreview } from './songModel';
import styles from './SongPanel.module.css';

export interface BlockHandlers {
  register(id: Id, el: HTMLElement | null): void;
  onPointerDown(e: ReactPointerEvent<HTMLElement>, id: Id): void;
  onEdgePointerDown(e: ReactPointerEvent<HTMLElement>, id: Id): void;
  onClick(e: ReactMouseEvent<HTMLElement>, id: Id): void;
  onKeyDown(e: KeyboardEvent<HTMLElement>, id: Id): void;
  onContextMenu(e: ReactMouseEvent<HTMLElement>, id: Id): void;
  onFocus(id: Id): void;
  onCellClick(e: ReactMouseEvent<HTMLButtonElement>, id: Id, trackId: Id): void;
  onCellKeyDown(e: KeyboardEvent<HTMLButtonElement>, id: Id, trackId: Id): void;
  onPicker(trigger: HTMLElement, id: Id, trackId: Id): void;
  onPlay(id: Id): void;
  onMenu(trigger: HTMLElement, id: Id): void;
  onSplit(id: Id, afterPass: number): void;
  onRename(id: Id, label: string | null): void;
  onStartRename(id: Id): void;
}

export interface SongBlockProps {
  block: BlockView;
  count: number;
  current: boolean;
  selected: boolean;
  tabbable: boolean;
  /** Carried by a move drag: the lifted copy shows it, this one keeps its slot invisibly. */
  hidden: boolean;
  /** Its right edge is being dragged. */
  resizing: boolean;
  advanced: boolean;
  renaming: boolean;
  menuOpen: boolean;
  /** A scene card hovers over this block: what layering it would change. */
  layer: LayerPreview | null;
  helpId: string;
  h: BlockHandlers;
}

function CellContent({ cell, preview }: { cell: CellView; preview: string | null }) {
  if (preview !== null)
    return (
      <>
        <LaneIcon name="layers" size={10} />
        <span className={styles.cellText}>from {preview}</span>
      </>
    );
  switch (cell.kind) {
    case 'scene':
      return <span className={styles.cellText}>{cell.clipName}</span>;
    case 'layer':
      return (
        <>
          <LaneIcon name="layers" size={10} />
          <span className={styles.cellText}>from {cell.fromScene}</span>
        </>
      );
    case 'off':
      return <span className={styles.cellText}>Off</span>;
    case 'empty':
      return null;
  }
}

function RenameField(props: { block: BlockView; onDone(label: string | null): void }) {
  const { block, onDone } = props;
  const [value, setValue] = useState(block.label ?? '');
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  const finish = (label: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(label);
  };
  return (
    <input
      ref={ref}
      className={styles.renameInput}
      value={value}
      maxLength={MAX_BLOCK_LABEL}
      placeholder={block.sceneName}
      spellCheck={false}
      autoComplete="off"
      aria-label={`Name of block ${block.index + 1} (empty: show the scene name, ${block.sceneName})`}
      data-no-drag=""
      onChange={(e) => setValue(e.currentTarget.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => finish(value)}
    />
  );
}

export const SongBlock = memo(function SongBlock(props: SongBlockProps) {
  const { block, count, current, selected, tabbable, hidden, resizing, advanced, renaming, menuOpen, layer, helpId, h } = props;
  const id = block.id;
  const inner = -1;
  const layerCount = layer ? layer.changes.size : 0;
  return (
    <div
      ref={(el) => h.register(id, el)}
      role="listitem"
      id={`song-block-${id}`}
      data-block-id={id}
      className={styles.block}
      data-first={block.index === 0 || undefined}
      data-last={block.index === count - 1 || undefined}
      data-current={current || undefined}
      data-selected={selected || undefined}
      data-hidden={hidden || undefined}
      data-resizing={resizing || undefined}
      data-missing={block.missing || undefined}
      data-layer-target={layer ? (layerCount ? 'on' : 'none') : undefined}
      tabIndex={tabbable ? 0 : -1}
      aria-label={blockLabel(block, count, { current, selected })}
      aria-describedby={helpId}
      onKeyDown={(e) => h.onKeyDown(e, id)}
      onPointerDown={(e) => h.onPointerDown(e, id)}
      onClick={(e) => h.onClick(e, id)}
      onContextMenu={(e) => h.onContextMenu(e, id)}
      onFocus={() => h.onFocus(id)}
    >
      <div className={styles.bhead}>
        <div className={styles.titles} onDoubleClick={() => !block.missing && h.onStartRename(id)}>
          {renaming ? (
            <RenameField block={block} onDone={(label) => h.onRename(id, label)} />
          ) : (
            <span className={styles.name}>{block.name}</span>
          )}
          <span className={styles.meta}>
            {layer ? (
              <span className={styles.layerTag}>
                <LaneIcon name="layers" size={10} />
                {layerCount ? `Layer ${layer.sceneName} into ${block.name}` : `${layer.sceneName} adds nothing new`}
              </span>
            ) : block.missing ? (
              <span className={styles.skipped}>Scene missing: skipped</span>
            ) : (
              <>
                {current && (
                  <span className={styles.nowTag}>
                    <Icon name="play" size={8} /> Playing
                  </span>
                )}
                <span className={`${styles.len} mono`}>{barsText(block.totalBars)}</span>
                {advanced && (
                  <span className={`${styles.calc} mono`}>
                    {block.passBars} × {block.repeats}
                  </span>
                )}
                {block.label && <span className={styles.sceneTag}>{block.sceneName}</span>}
              </>
            )}
          </span>
        </div>
        <Tooltip name={`Play from block ${block.index + 1}`} tip="Start the song here." disabled={block.missing}>
          <button type="button" className={styles.hbtn} data-play="" tabIndex={inner} aria-label={`Play song from block ${block.index + 1} (${block.name})`} disabled={block.missing} onClick={() => h.onPlay(id)}>
            <Icon name="play" size={11} />
          </button>
        </Tooltip>
        <button
          type="button"
          className={styles.hbtn}
          tabIndex={inner}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`${block.name}: block actions (parts, split, join, rename, scene, copy, remove)`}
          onClick={(e) => h.onMenu(e.currentTarget, id)}
        >
          <LaneIcon name="more" size={13} />
        </button>
      </div>
      {block.missing ? (
        <div className={styles.cellsMissing} aria-hidden="true">
          The scene this block played was deleted. Change its scene from the actions menu, or remove it.
        </div>
      ) : (
        <div className={styles.cells}>
          {block.cells.map((c) => {
            const preview = layer?.changes.has(c.trackId) ? layer.sceneName : null;
            return (
              <div key={c.trackId} className={styles.cellRow}>
                <button
                  type="button"
                  className={styles.cell}
                  data-cell=""
                  data-track={c.trackId}
                  data-kind={c.kind}
                  data-preview={preview !== null || undefined}
                  tabIndex={inner}
                  aria-pressed={cellOn(c)}
                  aria-label={cellLabel(block, c)}
                  onClick={(e) => h.onCellClick(e, id, c.trackId)}
                  onKeyDown={(e) => h.onCellKeyDown(e, id, c.trackId)}
                >
                  <CellContent cell={c} preview={preview} />
                </button>
                {advanced && (
                  <button
                    type="button"
                    className={styles.pick}
                    tabIndex={inner}
                    data-no-drag=""
                    aria-haspopup="menu"
                    aria-label={`Choose what ${c.partName} plays in ${block.name} (block ${block.index + 1}); now ${cellState(c)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      h.onPicker(e.currentTarget, id, c.trackId);
                    }}
                  >
                    <Icon name="chevronDown" size={9} />
                  </button>
                )}
              </div>
            );
          })}
          {Array.from({ length: block.repeats - 1 }, (_, i) => (
            <div key={i} className={styles.divider} style={{ left: `${((i + 1) / block.repeats) * 100}%` }}>
              <button
                type="button"
                className={styles.split}
                tabIndex={inner}
                data-no-drag=""
                aria-label={`Split ${block.name} after pass ${i + 1} of ${block.repeats}`}
                onClick={(e) => {
                  e.stopPropagation();
                  h.onSplit(id, i + 1);
                }}
              >
                <LaneIcon name="scissors" size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      {!block.missing && <div className={styles.edge} aria-hidden="true" data-no-drag="" data-edge="" onPointerDown={(e) => {
            // The block's own press (a move) must not see this one.
            e.stopPropagation();
            h.onEdgePointerDown(e, id);
          }}
        />}
    </div>
  );
});

/** A static picture of a block, for the lifted copy that follows the pointer. */
export function BlockFace({ block, width, advanced, copy }: { block: BlockView; width: number; advanced: boolean; copy: boolean }) {
  return (
    <div className={styles.face} style={{ width, ['--passes' as string]: block.repeats }} data-copy={copy || undefined}>
      <div className={styles.bhead}>
        <div className={styles.titles}>
          <span className={styles.name}>{block.name}</span>
          <span className={styles.meta}>
            <span className={`${styles.len} mono`}>{block.missing ? 'Scene missing' : barsText(block.totalBars)}</span>
            {advanced && !block.missing && (
              <span className={`${styles.calc} mono`}>
                {block.passBars} × {block.repeats}
              </span>
            )}
          </span>
        </div>
      </div>
      {!block.missing && (
        <div className={styles.cells}>
          {block.cells.map((c) => (
            <div key={c.trackId} className={styles.cellRow}>
              <span className={styles.cell} data-kind={c.kind}>
                <CellContent cell={c} preview={null} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
