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
 *   │▏Off       ┊           │  switched off here (a coral tick, grey word)
 *   │⧉ from Lift┊           │  layered from another scene
 *   └───────────┴──────────╢  ╢ = right-edge handle (always shown, faint; drag = how many times it plays)
 *
 * A block narrower than a full header (FULL_HEADER_WIDTH) has a compact
 * header: its name, with ▶ and ⋯ shown on hover, focus or while its menu is
 * open (the menu is also on right-click and Enter). The block playing now has
 * no ▶ (it plays already), so its Playing tag always has room for its word.
 * While its right edge is dragged the header shows the length the drop will
 * give. Song moves (fades, a filter rise, an echo throw) are drawn as thin
 * teal ramp lines over the cells and named in the header and the block's
 * accessible name. A part that is muted (or not soloed) is dimmed in every
 * block, and its cells say so; while Record Notes writes into a clip, the
 * cells that play that clip show a coral Rec.
 */
import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon, Tooltip } from '../../../ui/components';
import type { BlockMoveKind, Id } from '../../../project/types';
import { MAX_BLOCK_LABEL } from '../../../project/types';
import { BLOCK_MOVE_NAMES } from '../../../state/commands/arrangement';
import { LaneIcon } from './laneIcons';
import { barsText, blockLabel, cellLabel, compactName, cellOn, cellState, cellToggle, layerText, movesText, timesText, type BlockView, type CellView, type LayerPreview } from './songModel';
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

/** The clip Record Notes writes into: a part and the scene row of its slot. */
export interface RecTarget {
  trackId: Id;
  slot: number;
}

/** Whether a cell plays the clip Record Notes writes into. */
export function cellRecords(c: CellView, rec: RecTarget | null): boolean {
  return !!rec && c.trackId === rec.trackId && c.clipRow === rec.slot;
}

export interface SongBlockProps {
  block: BlockView;
  count: number;
  current: boolean;
  /** The block playing now was removed: this one takes over at the next bar. */
  next: boolean;
  selected: boolean;
  tabbable: boolean;
  /** Carried by a move drag: the lifted copy shows it, this one keeps its slot invisibly. */
  hidden: boolean;
  /** Its right edge is being dragged. */
  resizing: boolean;
  advanced: boolean;
  renaming: boolean;
  menuOpen: boolean;
  /** The part whose picker is open on this block, or null. */
  pickerTrack: Id | null;
  /** A scene card hovers over this block: what layering it would change. */
  layer: LayerPreview | null;
  /** Record Notes writes into this clip (a part and its scene row): the cells that play it say Rec. */
  rec: RecTarget | null;
  helpId: string;
  h: BlockHandlers;
}

/**
 * The header in full (its tooltip, for when a narrow block drops words, and
 * for a compact block, which shows only its name): "Groove · Playing · 8
 * bars: 4 bars, 2 times".
 */
export function metaTitle(block: Pick<BlockView, 'name' | 'totalBars' | 'passBars' | 'repeats' | 'label' | 'sceneName'> & { moves?: readonly BlockMoveKind[] }, current: boolean, next: boolean): string {
  const now = current ? 'Playing · ' : next ? 'Plays next · ' : '';
  const scene = block.label ? ` · scene ${block.sceneName}` : '';
  const moves = block.moves?.length ? ` · ${movesText(block.moves)}` : '';
  return `${block.name} · ${now}${barsText(block.totalBars)}: ${barsText(block.passBars)}, ${timesText(block.repeats)}${scene}${moves}`;
}

/**
 * The song moves as thin teal lines over the cells (decorative: the header and
 * the block's name say them in words). Drawn in a 1000 × 100 box stretched over
 * the cells: the fades as a straight rise or fall across the block, the filter
 * rise dashed, the echo throw as a short rise over the block's last beat.
 */
function MoveRamps({ moves, totalBars }: { moves: readonly BlockMoveKind[]; totalBars: number }) {
  // The last beat, at least 2 % of the block so it stays visible on a long one.
  const beat = Math.max(20, 1000 / Math.max(1, totalBars * 4));
  // With both fades the song rises over the first half and falls over the second (as it plays).
  const both = moves.includes('fadeIn') && moves.includes('fadeOut');
  return (
    <svg className={styles.ramps} viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true" focusable="false" data-moves={moves.join(' ')}>
      {moves.map((k) => {
        switch (k) {
          case 'fadeIn':
            return <path key={k} data-move={k} d={both ? 'M0 96 L500 6' : 'M0 96 L1000 6'} />;
          case 'fadeOut':
            return <path key={k} data-move={k} d={both ? 'M500 6 L1000 96' : 'M0 6 L1000 96'} />;
          case 'filterRise':
            return <path key={k} data-move={k} d="M0 86 L1000 16" strokeDasharray="7 5" />;
          case 'echoThrow':
            return <path key={k} data-move={k} d={`M${1000 - beat} 92 L1000 10`} />;
        }
      })}
    </svg>
  );
}

/** The moves in the header, short ("Fade in", "2 moves"): the block's tooltip and name say them all. */
function movesTag(moves: readonly BlockMoveKind[]): string {
  return moves.length === 1 ? BLOCK_MOVE_NAMES[moves[0]] : `${moves.length} moves`;
}

/** A layered part: the layers icon, the scene it comes from and its clip ("Lift: Bell Hook"); the clip name gives way first. */
function LayerContent({ scene, clip }: { scene: string; clip: string | null }) {
  return (
    <>
      <LaneIcon name="layers" size={10} />
      <span className={styles.cellFrom}>{clip ? `${scene}:` : `from ${scene}`}</span>
      {clip && <span className={styles.cellText}>{clip}</span>}
    </>
  );
}

function CellContent({ cell, preview }: { cell: CellView; preview: { scene: string; clip: string } | null }) {
  if (preview !== null) return <LayerContent scene={preview.scene} clip={preview.clip} />;
  switch (cell.kind) {
    case 'scene':
      return <span className={styles.cellText}>{cell.clipName}</span>;
    case 'layer':
      return <LayerContent scene={cell.fromScene ?? 'another scene'} clip={cell.clipName} />;
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
  const { block, count, current, next, selected, tabbable, hidden, resizing, advanced, renaming, menuOpen, pickerTrack, layer, rec, helpId, h } = props;
  const id = block.id;
  const inner = -1;
  const layerSays = layer ? layerText(layer, block.name) : null;
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
      data-next={(next && !current) || undefined}
      data-selected={selected || undefined}
      data-hidden={hidden || undefined}
      data-resizing={resizing || undefined}
      data-missing={block.missing || undefined}
      data-layer-target={layerSays ? (layerSays.changes ? 'on' : 'none') : undefined}
      data-moves={block.moves.length ? block.moves.join(' ') : undefined}
      tabIndex={tabbable ? 0 : -1}
      aria-label={blockLabel(block, count, { current, next, selected })}
      aria-describedby={helpId}
      onKeyDown={(e) => h.onKeyDown(e, id)}
      onPointerDown={(e) => h.onPointerDown(e, id)}
      onClick={(e) => h.onClick(e, id)}
      onContextMenu={(e) => h.onContextMenu(e, id)}
      onFocus={() => h.onFocus(id)}
    >
      <div className={styles.bhead}>
        <div className={styles.titles} title={layerSays || block.missing || renaming ? undefined : metaTitle(block, current, next)} onDoubleClick={() => !block.missing && h.onStartRename(id)}>
          {renaming ? (
            <RenameField block={block} onDone={(label) => h.onRename(id, label)} />
          ) : (
            // A compact header shows a helper block's step first ("1/4 Lift": data-short).
            <span className={styles.name} data-short={compactName(block.name) ?? undefined}>
              <span className={styles.titleFull}>{block.name}</span>
            </span>
          )}
          {/* One line; an item that does not fit wraps onto a hidden second line, so words are
              dropped whole (pass detail and scene first, then the length), never cut. */}
          <span className={styles.meta}>
            {layerSays ? (
              <span className={styles.layerTag} data-none={!layerSays.changes || undefined}>
                <LaneIcon name="layers" size={10} />
                {layerSays.title}
              </span>
            ) : block.missing ? (
              <span className={styles.skipped}>Scene missing: skipped</span>
            ) : (
              <>
                {current ? (
                  <span className={styles.nowTag}>
                    <Icon name="play" size={8} />
                    <span className={styles.tagText}>Playing</span>
                  </span>
                ) : (
                  next && (
                    <span className={styles.nextTag}>
                      <Icon name="chevronRight" size={9} />
                      <span className={styles.tagText}>Next</span>
                    </span>
                  )
                )}
                <span className={styles.len} data-testid="block-length">
                  {barsText(block.totalBars)}
                </span>
                {/* While the right edge is dragged: the length the drop gives (written by the lane; React leaves it empty). */}
                <span className={styles.liveLen} data-live-len="" aria-hidden="true" />
                {block.moves.length > 0 && (
                  <span className={styles.moveTag} data-testid="block-moves">
                    <LaneIcon name="ramp" size={10} />
                    {movesTag(block.moves)}
                  </span>
                )}
                {advanced && (
                  <span className={styles.calc}>
                    {block.passBars} × {block.repeats}
                  </span>
                )}
                {block.label && <span className={styles.sceneTag}>{block.sceneName}</span>}
              </>
            )}
          </span>
        </div>
        {/* The block playing now has no ▶: it plays already (its menu still has Play song from here). */}
        {!current && (
          <Tooltip name={`Play from block ${block.index + 1}`} tip="Start the song here." disabled={block.missing}>
            <button type="button" className={styles.hbtn} data-play="" data-drag-ok="" tabIndex={inner} aria-label={`Play song from block ${block.index + 1} (${block.name})`} disabled={block.missing} onClick={() => h.onPlay(id)}>
              <Icon name="play" size={11} />
            </button>
          </Tooltip>
        )}
        <button
          type="button"
          className={styles.hbtn}
          data-drag-ok=""
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
          <div className={styles.rows}>
            {block.cells.map((c) => {
              const clip = layer?.changes.get(c.trackId);
              const preview = layer && clip !== undefined ? { scene: layer.sceneName, clip } : null;
              const toggle = cellToggle(c);
              const recording = cellRecords(c, rec);
              return (
                <div key={c.trackId} className={styles.cellRow} data-silenced={c.silenced ?? undefined}>
                  <button
                    type="button"
                    className={styles.cell}
                    data-cell=""
                    data-track={c.trackId}
                    data-kind={c.kind}
                    data-preview={preview !== null || undefined}
                    data-rec={recording || undefined}
                    tabIndex={inner}
                    aria-pressed={cellOn(c)}
                    aria-label={cellLabel(block, c, recording)}
                    aria-describedby={`${helpId}-${toggle === 'picker' ? 'pick' : toggle.choice === null ? 'off' : 'on'}`}
                    onClick={(e) => h.onCellClick(e, id, c.trackId)}
                    onKeyDown={(e) => h.onCellKeyDown(e, id, c.trackId)}
                  >
                    <CellContent cell={c} preview={preview} />
                    {recording && (
                      <span className={styles.recTag} aria-hidden="true">
                        Rec
                      </span>
                    )}
                  </button>
                  {advanced && (
                    <button
                      type="button"
                      className={styles.pick}
                      tabIndex={inner}
                      data-no-drag=""
                      aria-haspopup="menu"
                      aria-expanded={pickerTrack === c.trackId}
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
          </div>
          {block.moves.length > 0 && <MoveRamps moves={block.moves} totalBars={block.totalBars} />}
          {Array.from({ length: block.repeats - 1 }, (_, i) => (
            <div key={i} className={styles.divider} style={{ left: `${((i + 1) / block.repeats) * 100}%` }}>
              <button
                type="button"
                className={styles.split}
                tabIndex={inner}
                data-no-drag=""
                aria-label={`Split ${block.name} in two after it plays ${timesText(i + 1)} (of ${block.repeats})`}
                onClick={(e) => {
                  e.stopPropagation();
                  h.onSplit(id, i + 1);
                }}
              >
                <span className={styles.splitChip}>
                  <LaneIcon name="scissors" size={11} />
                </span>
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
            <span className={styles.len}>{block.missing ? 'Scene missing' : barsText(block.totalBars)}</span>
            {advanced && !block.missing && (
              <span className={styles.calc}>
                {block.passBars} × {block.repeats}
              </span>
            )}
          </span>
        </div>
      </div>
      {!block.missing && (
        <div className={styles.cells}>
          {block.cells.map((c) => (
            <div key={c.trackId} className={styles.cellRow} data-silenced={c.silenced ?? undefined}>
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
