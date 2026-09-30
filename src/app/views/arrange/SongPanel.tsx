/**
 * Song: the arrangement as a lane of scene blocks.
 *
 *   [ SONG · Playback follows: …        Length · Tail · Play song · Stop · Export ]
 *   [ ruler 1   5   9 …                                                          ]
 *   [ [Intro 8 bars][Groove 16 bars      ][Lift …]              ← playhead       ]
 *   [ SCENES  [Intro +] [Groove +] [Lift +] [Break +]                   hints     ]
 *
 * - Block width is proportional to its length (scene bars × repeats); tiny
 *   blocks are widened to stay usable and the ruler follows the same geometry.
 * - Reorder by dragging (an insertion marker shows where it lands) or with
 *   Alt+Left/Right on a focused block; the block menu has Move left/right too.
 * - Drag a scene from the palette into the lane, or press its + to append.
 * - The playhead and the current block follow the plan that is playing
 *   (captured when the song started), read from the transport in a rAF loop.
 */
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, Icon, Led, NumberField, Tooltip, useElementSize, useRafLoop } from '../../../ui/components';
import { TICKS_PER_BAR, type Id } from '../../../project/types';
import { clampBpm, ticksToSeconds } from '../../../time/clock';
import { sceneBars, songLengthTicks } from '../../../time/sequencer';
import * as cmd from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { selectSlot, selectTrack, setPadMode, setView } from '../../../state/uiStore';
import { session, useProject } from '../../instance';
import { notify, useRuntime } from '../../runtime';
import { formatSeconds } from '../../session';
import { barsLabel } from '../../labels';
import { MenuHeader, MenuItem, MenuSeparator, Popover, anchorFromElement, isMenuKey, noteKeyboardMenu, type MenuAnchor } from '../ClipMenu';
import { BLOCK_GAP, gapAt, gapX, layoutSong, moveTarget, rulerMarks, type SongLayout } from './songLayout';
import { getSongPlan, planSignature, projectSongSignature, startSong, useSongPlan } from './songPlan';
import styles from './SongPanel.module.css';

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

interface SceneSummary {
  id: Id;
  row: number;
  name: string;
  bars: number;
  parts: number;
}

function useSceneSummaries(): SceneSummary[] {
  const scenes = useProject((p) => p.scenes);
  const bars = useProject((p) => p.scenes.map((_, r) => sceneBars(p, r)), shallowEqual);
  const parts = useProject((p) => p.scenes.map((_, r) => p.tracks.reduce((n, t) => n + (t.clips[r] ? 1 : 0), 0)), shallowEqual);
  return useMemo(() => scenes.map((s, row) => ({ id: s.id, row, name: s.name, bars: bars[row] ?? 1, parts: parts[row] ?? 0 })), [scenes, bars, parts]);
}

interface BlockView {
  id: Id;
  index: number;
  sceneId: Id;
  /** Scene row, or -1 when the scene no longer exists (the song skips the block). */
  row: number;
  name: string;
  bars: number;
  repeats: number;
}

function partsText(n: number): string {
  return n === 0 ? 'no clips' : n === 1 ? '1 part' : `${n} parts`;
}

/** Show a scene row's clips in the Play view (Loops), with the row's first clip selected. */
export function editSceneClips(row: number): void {
  const p = session.store.getState();
  setPadMode('loops');
  for (const t of p.tracks) if (t.clips[row]) selectSlot(t.id, row);
  const first = p.tracks.find((t) => t.clips[row]);
  if (first) selectTrack(first.id);
  setView('play');
  const scene = p.scenes[row];
  notify(`Showing the ${scene?.name ?? 'scene'} row: its clips are the pads in row ${row + 1}. Open a pad's menu or Steps to edit them.`);
  // Put keyboard focus on the row's first pad once the Play view is on screen.
  requestAnimationFrame(() => {
    if (first) document.getElementById(`pad-${first.id}-${row}`)?.focus({ preventScroll: true });
  });
}

function removeBlockWithUndo(block: BlockView): boolean {
  if (!session.accepted(cmd.removeBlock(session.store, block.id))) return false;
  notify(`Removed ${block.name} (block ${block.index + 1}) from the song.`, 'info', 'undo');
  return true;
}

/** pendingFocus value meaning "the song is now empty: focus Add all scenes". */
const EMPTY_FOCUS = '\u0000empty';

function changeRepeats(block: BlockView, repeats: number): void {
  if (repeats < 1 || repeats > 8 || repeats === block.repeats) return;
  session.accepted(cmd.setBlockRepeats(session.store, block.id, repeats));
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

function ModeIndicator(props: { current: BlockView | null; blockCount: number }) {
  const { current, blockCount } = props;
  const mode = useRuntime((s) => s.mode);
  const playing = useRuntime((s) => s.playing);
  const replayId = useRuntime((s) => s.replayId);
  const replayName = useProject((p) => (replayId ? (p.performances.find((x) => x.id === replayId)?.name ?? 'a take') : ''));
  let follows: string;
  let where = '';
  let caption: string;
  if (playing && mode === 'song') {
    follows = 'Arrangement';
    where = current ? `Block ${current.index + 1} of ${blockCount} · ${current.name}` : '';
    caption = 'Pads still work: a tapped clip joins at the next bar and plays until the next block starts. Stop brings back the pads you had before the song.';
  } else if (playing && mode === 'replay') {
    follows = 'Performance';
    where = `“${replayName}”`;
    caption = 'The take plays back exactly as recorded. Pads and keys are ignored until you stop it.';
  } else {
    follows = 'Live pads';
    caption = playing
      ? 'The Loops pads decide what plays. Play song hands playback to the blocks below; your pads come back when it stops.'
      : 'Stopped. Play song plays the blocks below in order; Play in the transport plays your pads.';
  }
  return (
    <div className={styles.mode} data-mode={playing ? mode : 'stopped'} role="status" aria-live="polite" data-testid="playback-mode">
      <div className={styles.modeLine}>
        <Led on={playing} tone={playing ? 'amber' : 'neutral'} label={playing ? 'Playing' : 'Stopped'} hideLabel size="sm" />
        <span className={styles.modeLabel}>Playback follows:</span>
        <strong className={styles.modeValue}>{follows}</strong>
        {where && <span className={styles.modeWhere}>{where}</span>}
      </div>
      <p className={styles.modeCaption}>{caption}</p>
    </div>
  );
}

function SongTotals() {
  const ticks = useProject((p) => songLengthTicks(p));
  const bpm = useProject((p) => clampBpm(p.bpm));
  const tail = useProject((p) => p.arrangement.tailSeconds);
  const bars = Math.round(ticks / TICKS_PER_BAR);
  const secs = ticksToSeconds(ticks, bpm);
  return (
    <div className={styles.totals}>
      <Tooltip tip="How long the song plays: every block's scene length times its repeats." detail={`Estimated at ${Math.round(bpm)} BPM. Exports add the tail on top so echoes and reverb can ring out.`}>
        <div className={styles.readout} tabIndex={0} role="group" aria-label={`Song length: ${barsLabel(bars)}, about ${formatSeconds(secs)} at ${Math.round(bpm)} BPM`}>
          <span className={styles.readoutLabel}>LENGTH</span>
          <span className={`${styles.readoutValue} mono`} data-testid="song-length">
            {barsLabel(bars)} · {formatSeconds(secs)}
          </span>
        </div>
      </Tooltip>
      <NumberField
        label="Export tail"
        value={tail}
        min={0}
        max={10}
        step={0.5}
        unit="s"
        chars={3}
        size="sm"
        onChange={(v, info) => session.accepted(cmd.setTailSeconds(session.store, v, info.gesture))}
        tip="Extra seconds after the last block in song exports, so echoes and reverb can ring out."
        detail="Saved with the project. The export dialog starts from this value."
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Blocks                                                              */
/* ------------------------------------------------------------------ */

interface BlockProps {
  block: BlockView;
  x: number;
  width: number;
  count: number;
  current: boolean;
  tabbable: boolean;
  lifted: boolean;
  menuOpen: boolean;
  onOpenMenu(block: BlockView, trigger: HTMLElement): void;
  onKeyDown(e: KeyboardEvent<HTMLDivElement>, block: BlockView): void;
  onPointerDown(e: ReactPointerEvent<HTMLDivElement>, block: BlockView): void;
  onFocusBlock(id: Id): void;
  onRemove(block: BlockView): void;
  helpId: string;
}

const SongBlock = memo(function SongBlock(props: BlockProps) {
  const { block, x, width, count, current, tabbable, lifted, menuOpen, onOpenMenu, onKeyDown, onPointerDown, onFocusBlock, onRemove, helpId } = props;
  const nameRef = useRef<HTMLButtonElement>(null);
  const total = block.row >= 0 ? block.bars * block.repeats : 0;
  const inner = tabbable ? 0 : -1;
  const missing = block.row < 0;
  const label = missing
    ? `Block ${block.index + 1} of ${count}: its scene no longer exists, so the song skips it`
    : `Block ${block.index + 1} of ${count}: ${block.name}, ${barsLabel(block.bars)} × ${block.repeats} = ${barsLabel(total)}${current ? ', playing now' : ''}`;
  return (
    <div
      role="listitem"
      id={`song-block-${block.id}`}
      data-block-id={block.id}
      className={styles.block}
      data-current={current || undefined}
      data-lifted={lifted || undefined}
      data-missing={missing || undefined}
      style={{ left: x, width }}
      tabIndex={tabbable ? 0 : -1}
      aria-label={label}
      aria-describedby={helpId}
      onKeyDown={(e) => onKeyDown(e, block)}
      onPointerDown={(e) => onPointerDown(e, block)}
      onFocus={() => onFocusBlock(block.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (nameRef.current) onOpenMenu(block, nameRef.current);
      }}
    >
      <div className={styles.blockTop}>
        <span className={styles.grip} aria-hidden="true">
          <Icon name="drag" size={12} />
        </span>
        <button
          ref={nameRef}
          type="button"
          className={styles.blockName}
          tabIndex={inner}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`${block.name}: block options (edit clips, change scene, move, remove)`}
          onClick={(e) => onOpenMenu(block, e.currentTarget)}
        >
          <span className={styles.blockNameText}>{block.name}</span>
          <Icon name="chevronDown" size={12} />
        </button>
        <Tooltip name={`Play from block ${block.index + 1}`} tip="Start the song here.">
          <button type="button" className={styles.blockPlay} tabIndex={inner} aria-label={`Play song from block ${block.index + 1} (${block.name})`} onClick={() => startSong(block.index)} disabled={missing}>
            <Icon name="play" size={12} />
          </button>
        </Tooltip>
      </div>
      <div className={styles.blockMeta}>
        {missing ? (
          <span className={styles.blockSkipped}>Skipped: scene missing</span>
        ) : (
          <>
            <span className={`${styles.blockTotal} mono`}>{barsLabel(total)}</span>
            {current ? (
              <span className={styles.nowTag}>
                <Icon name="play" size={9} /> Playing
              </span>
            ) : (
              <span className={`${styles.blockCalc} mono`}>
                {block.bars} × {block.repeats}
              </span>
            )}
          </>
        )}
      </div>
      <div className={styles.blockBottom}>
        <div className={styles.stepper} role="group" aria-label={`Repeats of ${block.name}`}>
          <button
            type="button"
            className={styles.stepBtn}
            tabIndex={inner}
            aria-label={`Fewer repeats of ${block.name} (now ${block.repeats})`}
            aria-disabled={block.repeats <= 1 || undefined}
            onClick={() => changeRepeats(block, block.repeats - 1)}
          >
            <Icon name="minus" size={12} />
          </button>
          <span className={`${styles.stepValue} mono`} aria-hidden="true">
            ×{block.repeats}
          </span>
          <button
            type="button"
            className={styles.stepBtn}
            tabIndex={inner}
            aria-label={`More repeats of ${block.name} (now ${block.repeats})`}
            aria-disabled={block.repeats >= 8 || undefined}
            onClick={() => changeRepeats(block, block.repeats + 1)}
          >
            <Icon name="plus" size={12} />
          </button>
        </div>
        <Tooltip name="Remove block" tip="Take this block out of the song. Undo brings it back.">
          <button type="button" className={styles.blockRemove} tabIndex={inner} aria-label={`Remove block ${block.index + 1} (${block.name}) from the song`} onClick={() => onRemove(block)}>
            <Icon name="trash" size={13} />
          </button>
        </Tooltip>
      </div>
      {!missing && (
        <div className={styles.repeatStrip} aria-hidden="true">
          {Array.from({ length: block.repeats }, (_, i) => (
            <span key={i} className={styles.repeatCell} />
          ))}
        </div>
      )}
    </div>
  );
});

function BlockMenu(props: {
  block: BlockView;
  count: number;
  scenes: SceneSummary[];
  anchor: MenuAnchor;
  returnFocus: HTMLElement | null;
  onClose(): void;
  onMove(block: BlockView, to: number): void;
  onRemove(block: BlockView): void;
}) {
  const { block, count, scenes, anchor, returnFocus, onClose, onMove, onRemove } = props;
  const total = block.bars * block.repeats;
  return (
    <Popover anchor={anchor} label={`Block ${block.index + 1}: ${block.name}`} onClose={onClose} returnFocus={returnFocus}>
      <MenuHeader eyebrow={`Block ${block.index + 1} of ${count} · ${block.row >= 0 ? barsLabel(total) : 'skipped'}`} title={block.name} />
      <MenuItem
        icon="link"
        disabled={block.row < 0}
        disabledReason="Scene missing"
        onSelect={() => {
          onClose();
          editSceneClips(block.row);
        }}
      >
        Edit clips in Play
      </MenuItem>
      <MenuItem
        icon="play"
        disabled={block.row < 0}
        onSelect={() => {
          onClose();
          startSong(block.index);
        }}
      >
        Play song from here
      </MenuItem>
      <MenuSeparator />
      <div className={styles.menuLabel} role="presentation">
        Scene for this block
      </div>
      {scenes.map((s) => (
        <MenuItem
          key={s.id}
          role="menuitemcheckbox"
          checked={s.id === block.sceneId}
          icon={s.id === block.sceneId ? 'check' : undefined}
          hint={`${barsLabel(s.bars)} · ${partsText(s.parts)}`}
          onSelect={() => {
            if (s.id !== block.sceneId) session.accepted(cmd.setBlockScene(session.store, block.id, s.id));
            onClose();
          }}
        >
          {s.name}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem icon="chevronLeft" hint="Alt+←" disabled={block.index === 0} disabledReason="First" keyShortcut="Alt+ArrowLeft" onSelect={() => onMove(block, block.index - 1)}>
        Move earlier
      </MenuItem>
      <MenuItem icon="chevronRight" hint="Alt+→" disabled={block.index >= count - 1} disabledReason="Last" keyShortcut="Alt+ArrowRight" onSelect={() => onMove(block, block.index + 1)}>
        Move later
      </MenuItem>
      <MenuItem
        icon="trash"
        tone="danger"
        hint="Del"
        keyShortcut="Delete"
        onSelect={() => {
          onClose();
          onRemove(block);
        }}
      >
        Remove from song
      </MenuItem>
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* Drag & drop                                                         */
/* ------------------------------------------------------------------ */

type DragSource = { kind: 'block'; id: Id; from: number; name: string; bars: number } | { kind: 'scene'; sceneId: Id; name: string; bars: number };

interface DragSession {
  source: DragSource;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  started: boolean;
  gap: number | null;
}

const DRAG_THRESHOLD = 4;

function ghostText(source: DragSource, gap: number | null): string {
  if (gap === null) return 'Release here to cancel';
  if (source.kind === 'scene') return `Add as block ${gap + 1}`;
  const to = moveTarget(source.from, gap);
  return to === null ? 'Stays in place' : `Move to position ${to + 1}`;
}
/** How far above/below the lane a drop still counts. */
const DROP_MARGIN = 48;

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function SongPanel() {
  const blocks = useProject((p) => p.arrangement.blocks);
  const scenes = useSceneSummaries();
  const mode = useRuntime((s) => s.mode);
  const playing = useRuntime((s) => s.playing);
  const songBlock = useRuntime((s) => s.songBlock);
  const songMode = playing && mode === 'song';
  const plan = useSongPlan();
  const currentSig = useProject((p) => projectSongSignature(p));
  const helpId = useId();

  const views: BlockView[] = useMemo(
    () =>
      blocks.map((b, index) => {
        const s = scenes.find((x) => x.id === b.sceneId);
        return { id: b.id, index, sceneId: b.sceneId, row: s ? s.row : -1, name: s ? s.name : 'Missing scene', bars: s ? s.bars : 0, repeats: b.repeats };
      }),
    [blocks, scenes],
  );

  // Lane geometry.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollerRef);
  // Blocks appear once the lane has a width, so they do not animate in from a zero-width layout.
  const measured = size.width > 0;
  const layout: SongLayout = useMemo(() => layoutSong(views.map((v) => ({ id: v.id, bars: v.bars, repeats: v.repeats })), Math.max(0, size.width - BLOCK_GAP)), [views, size.width]);
  const marks = useMemo(() => rulerMarks(layout), [layout]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Fade the lane edges when there are more blocks to scroll to.
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);
  useEffect(updateEdges, [layout, size.width, updateEdges]);

  // What is playing now (by block id, so it survives edits made while the song plays).
  const currentId = songMode && plan ? (plan.find((b) => b.index === songBlock)?.blockId ?? null) : null;
  const current = currentId ? (views.find((v) => v.id === currentId) ?? null) : null;
  const stale = songMode && plan !== null && planSignature(plan) !== currentSig;

  // Roving focus between blocks: one tab stop for the lane.
  const [activeId, setActiveId] = useState<Id | null>(null);
  const tabId = views.some((v) => v.id === activeId) ? activeId : (views[0]?.id ?? null);
  const pendingFocus = useRef<Id | null>(null);
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (!id || id === EMPTY_FOCUS) return;
    pendingFocus.current = null;
    document.getElementById(`song-block-${id}`)?.focus({ preventScroll: false });
  });
  const addAllRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (id !== EMPTY_FOCUS) return;
    pendingFocus.current = null;
    addAllRef.current?.focus({ preventScroll: true });
  });
  const focusBlock = (id: Id | undefined) => {
    if (!id) return;
    setActiveId(id);
    pendingFocus.current = id;
  };
  /** Remove a block (with Undo) and keep keyboard focus in the lane: its neighbour, or "Add all scenes" when the song is now empty. */
  const removeAndFocus = useCallback((block: BlockView) => {
    const list = session.store.getState().arrangement.blocks;
    const neighbour = list[block.index + 1] ?? list[block.index - 1];
    if (!removeBlockWithUndo(block)) return;
    if (neighbour) {
      setActiveId(neighbour.id);
      pendingFocus.current = neighbour.id;
    } else {
      pendingFocus.current = EMPTY_FOCUS;
    }
  }, []);

  // Block menu.
  const [menu, setMenu] = useState<{ blockId: Id; anchor: MenuAnchor; returnFocus: HTMLElement | null } | null>(null);
  const onOpenMenu = useCallback((block: BlockView, trigger: HTMLElement) => {
    setActiveId(block.id);
    setMenu((m) => (m && m.blockId === block.id ? null : { blockId: block.id, anchor: anchorFromElement(trigger), returnFocus: document.getElementById(`song-block-${block.id}`) }));
  }, []);
  const menuBlock = menu ? views.find((v) => v.id === menu.blockId) : undefined;

  const move = useCallback((block: BlockView, to: number) => {
    setMenu(null);
    if (to < 0 || to >= session.store.getState().arrangement.blocks.length || to === block.index) return;
    if (session.accepted(cmd.moveBlock(session.store, block.index, to))) {
      setActiveId(block.id);
      pendingFocus.current = block.id;
    }
  }, []);

  const onBlockKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, block: BlockView) => {
      const onBlock = e.target === e.currentTarget;
      const list = session.store.getState().arrangement.blocks;
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        move(block, block.index + (e.key === 'ArrowLeft' ? -1 : 1));
        return;
      }
      if (!onBlock) return;
      if (isMenuKey(e) || e.key === 'Enter') {
        e.preventDefault();
        const trigger = e.currentTarget.querySelector<HTMLElement>('[aria-haspopup="menu"]');
        if (trigger) {
          noteKeyboardMenu(e.currentTarget);
          onOpenMenu(block, trigger);
        }
        return;
      }
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          const next = list[block.index + (e.key === 'ArrowLeft' ? -1 : 1)];
          focusBlock(next?.id);
          break;
        }
        case 'Home':
          e.preventDefault();
          focusBlock(list[0]?.id);
          break;
        case 'End':
          e.preventDefault();
          focusBlock(list[list.length - 1]?.id);
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          removeAndFocus(block);
          break;
        case '+':
        case '=':
          e.preventDefault();
          changeRepeats(block, block.repeats + 1);
          break;
        case '-':
        case '_':
          e.preventDefault();
          changeRepeats(block, block.repeats - 1);
          break;
      }
    },
    [move, onOpenMenu, removeAndFocus],
  );

  /* ---- drag ---- */
  const dragRef = useRef<DragSession | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ source: DragSource; gap: number | null } | null>(null);
  const cleanupDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupDrag.current?.(), []);

  const placeGhost = () => {
    const d = dragRef.current;
    const g = ghostRef.current;
    if (d && g) g.style.transform = `translate(${Math.round(d.x + 12)}px, ${Math.round(d.y + 10)}px)`;
  };
  useLayoutEffect(placeGhost, [drag]);

  const gapFor = (x: number, y: number): number | null => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return null;
    const r = scroller.getBoundingClientRect();
    if (y < r.top - DROP_MARGIN || y > r.bottom + DROP_MARGIN || x < r.left - DROP_MARGIN || x > r.right + DROP_MARGIN) return null;
    const c = content.getBoundingClientRect();
    return gapAt(layoutRef.current, x - c.left);
  };

  const beginDrag = (e: ReactPointerEvent<HTMLElement>, source: DragSource) => {
    if (e.button !== 0 || dragRef.current) return;
    const t = e.target as HTMLElement;
    if (t.closest('button, input, a, [role="menuitem"]')) return;
    dragRef.current = { source, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, started: false, gap: null };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== d.pointerId) return;
      d.x = ev.clientX;
      d.y = ev.clientY;
      let first = false;
      if (!d.started) {
        if (Math.hypot(d.x - d.startX, d.y - d.startY) < DRAG_THRESHOLD) return;
        d.started = true;
        first = true;
        setMenu(null);
      }
      ev.preventDefault();
      // Scroll the lane when the pointer nears its edges.
      const scroller = scrollerRef.current;
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        if (d.y > r.top - DROP_MARGIN && d.y < r.bottom + DROP_MARGIN) {
          if (d.x < r.left + 36) scroller.scrollLeft -= 14;
          else if (d.x > r.right - 36) scroller.scrollLeft += 14;
        }
      }
      const gap = gapFor(d.x, d.y);
      placeGhost();
      if (first || gap !== d.gap) {
        d.gap = gap;
        setDrag({ source: d.source, gap });
      }
    };
    const finish = (ev: PointerEvent | null, cancel: boolean) => {
      const d = dragRef.current;
      if (ev && d && ev.pointerId !== d.pointerId) return;
      cleanupDrag.current?.();
      if (!d || !d.started || cancel) return;
      const gap = d.gap;
      if (gap === null) return;
      if (d.source.kind === 'block') {
        const to = moveTarget(d.source.from, gap);
        if (to !== null && session.accepted(cmd.moveBlock(session.store, d.source.from, to))) {
          setActiveId(d.source.id);
          pendingFocus.current = d.source.id;
        }
      } else {
        const r = cmd.addBlock(session.store, d.source.sceneId, gap);
        if (session.accepted(r) && r.blockId) {
          setActiveId(r.blockId);
          pendingFocus.current = r.blockId;
        }
      }
    };
    const onUp = (ev: PointerEvent) => finish(ev, false);
    const onCancel = (ev: PointerEvent) => finish(ev, true);
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== 'Escape' || !dragRef.current?.started) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(null, true);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    cleanupDrag.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      cleanupDrag.current = null;
      dragRef.current = null;
      setDrag(null);
    };
  };

  const onBlockPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>, block: BlockView) => {
    if (e.button !== 0) return;
    if (!(e.target as HTMLElement).closest('button')) {
      setActiveId(block.id);
      e.currentTarget.focus({ preventScroll: true });
    }
    beginDrag(e, { kind: 'block', id: block.id, from: block.index, name: block.name, bars: block.bars * block.repeats });
    // beginDrag only reads refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- playhead ---- */
  const playheadRef = useRef<HTMLDivElement>(null);
  useRafLoop(() => {
    const el = playheadRef.current;
    const t = session.transport;
    const p = getSongPlan();
    if (!el || !t || !p) return;
    const tick = t.getPosition().tick;
    const pb = p.find((b) => tick >= b.startTick && tick < b.endTick) ?? (tick >= (p[p.length - 1]?.endTick ?? 0) ? p[p.length - 1] : undefined);
    const lb = pb ? layoutRef.current.blocks.find((b) => b.id === pb.blockId) : undefined;
    if (!pb || !lb) {
      el.style.opacity = '0';
      return;
    }
    const f = Math.min(1, Math.max(0, (tick - pb.startTick) / Math.max(1, pb.endTick - pb.startTick)));
    const x = lb.x + f * lb.width;
    el.style.opacity = '1';
    el.style.transform = `translateX(${x.toFixed(1)}px)`;
    // Keep the playhead in view when the song is wider than the lane.
    const scroller = scrollerRef.current;
    if (scroller && !dragRef.current && scroller.scrollWidth > scroller.clientWidth) {
      if (x < scroller.scrollLeft + 8 || x > scroller.scrollLeft + scroller.clientWidth - 24) scroller.scrollLeft = Math.max(0, x - 48);
    }
  }, songMode);

  const addScene = (s: SceneSummary) => {
    const r = cmd.addBlock(session.store, s.id);
    if (session.accepted(r) && r.blockId) {
      setActiveId(r.blockId);
      notify(`Added ${s.name} at the end of the song (block ${session.store.getState().arrangement.blocks.length}).`);
    }
  };
  const addAll = () => {
    for (const s of scenes) session.accepted(cmd.addBlock(session.store, s.id));
    notify(`Added ${scenes.map((s) => s.name).join(', ')} in order. Change repeats or drag blocks to shape the song.`);
  };

  const empty = views.length === 0;
  const markerX = drag && drag.gap !== null && !empty ? gapX(layout, drag.gap) : null;
  const dropEnd = drag && drag.gap !== null && drag.gap >= views.length;
  const endZoneWidth = drag?.source.kind === 'scene' ? 150 : 0;

  return (
    <section className={styles.panel} aria-labelledby="song-title">
      <header className={styles.head}>
        <div className={styles.titleBlock}>
          <h2 id="song-title" className={styles.title}>
            Song
          </h2>
          <ModeIndicator current={current} blockCount={views.length} />
        </div>
        <div className={styles.headRight}>
          <SongTotals />
          <div className={styles.buttons}>
            <Button
              variant="primary"
              icon="play"
              pressed={songMode}
              onClick={() => startSong(0)}
              disabled={empty}
              aria-label={songMode ? 'Play song from the start (playing now)' : 'Play song'}
              tip={empty ? 'Add scene blocks first.' : 'Play the blocks in order from the first one. Pressing it while the song plays starts it again from the top.'}
              detail="Starting the song ends a performance recording in progress."
            >
              Play song
            </Button>
            <Button icon="stop" onClick={() => session.stop()} disabled={!playing} tip="Stop playback (song, replay or pads).">
              Stop
            </Button>
            <Button
              icon="download"
              onClick={() => window.dispatchEvent(new CustomEvent('sb:open-export', { detail: { source: 'song' } }))}
              disabled={empty}
              tip={empty ? 'Add scene blocks first.' : 'Render the whole song to a WAV file.'}
              detail="Same sounds, effects and timing as playback, plus the export tail."
            >
              Export song
            </Button>
          </div>
        </div>
      </header>

      {stale && (
        <div className={styles.stale} role="status">
          <Icon name="info" size={14} />
          <span>You changed the song while it plays. It keeps the order it started with until you play it again.</span>
          <Button size="sm" variant="ghost" icon="play" onClick={() => startSong(current ? current.index : 0)}>
            {current ? `Restart from block ${current.index + 1}` : 'Restart song'}
          </Button>
        </div>
      )}

      <div className={styles.lane} data-dragging={drag ? drag.source.kind : undefined}>
        <div ref={scrollerRef} className={styles.scroller} onScroll={updateEdges} data-fade-left={edges.left || undefined} data-fade-right={edges.right || undefined}>
          <div ref={contentRef} className={styles.content} style={{ width: empty ? '100%' : layout.contentWidth + endZoneWidth + BLOCK_GAP }}>
            {!empty && (
              <div className={styles.ruler} aria-hidden="true">
                {marks.map((m) => (
                  <span key={m.bar} className={styles.mark} data-label={m.label || undefined} data-start={m.blockStart || undefined} style={{ left: m.x }}>
                    {m.label && <span className={`${styles.markNum} mono`}>{m.bar + 1}</span>}
                  </span>
                ))}
                <span className={styles.endMark} style={{ left: layout.contentWidth - 1 }} />
              </div>
            )}
            <div className={styles.track} role={empty ? undefined : 'list'} aria-label={empty ? undefined : `Song: ${views.length} block${views.length === 1 ? '' : 's'} in play order`}>
              {empty ? (
                <div className={styles.empty} data-drop={dropEnd || undefined}>
                  <Icon name="plus" size={20} />
                  <div className={styles.emptyText}>
                    <strong>Your song is empty.</strong>
                    <span>Add scenes in the order they should play: press + on a scene below, or drag it here.</span>
                  </div>
                  <Button ref={addAllRef} size="sm" icon="plus" onClick={addAll} tip="Adds every scene once, in row order, with 2 repeats each.">
                    Add all {scenes.length} scenes
                  </Button>
                </div>
              ) : !measured ? null : (
                views.map((v) => {
                  const lb = layout.blocks[v.index];
                  return (
                    <SongBlock
                      key={v.id}
                      block={v}
                      x={lb?.x ?? 0}
                      width={lb?.width ?? 120}
                      count={views.length}
                      current={v.id === currentId}
                      tabbable={v.id === tabId}
                      lifted={drag?.source.kind === 'block' && drag.source.id === v.id}
                      menuOpen={menu?.blockId === v.id}
                      onOpenMenu={onOpenMenu}
                      onKeyDown={onBlockKeyDown}
                      onPointerDown={onBlockPointerDown}
                      onFocusBlock={setActiveId}
                      onRemove={removeAndFocus}
                      helpId={helpId}
                    />
                  );
                })
              )}
              {drag?.source.kind === 'scene' && !empty && (
                <div className={styles.endZone} data-drop={dropEnd || undefined} style={{ left: layout.contentWidth + BLOCK_GAP, width: endZoneWidth - BLOCK_GAP }} aria-hidden="true">
                  Drop to add at the end
                </div>
              )}
              {markerX !== null && <div className={styles.marker} style={{ left: markerX }} aria-hidden="true" data-testid="insert-marker" />}
            </div>
            {!empty && <div ref={playheadRef} className={styles.playhead} aria-hidden="true" data-on={songMode || undefined} />}
          </div>
        </div>
      </div>

      <div className={styles.palette}>
        <span className={styles.paletteLabel}>SCENES</span>
        <div className={styles.cards} role="list" aria-label="Scenes you can add to the song">
          {scenes.map((s) => (
            <div
              key={s.id}
              role="listitem"
              className={styles.card}
              data-lifted={(drag?.source.kind === 'scene' && drag.source.sceneId === s.id) || undefined}
              onPointerDown={(e) => beginDrag(e, { kind: 'scene', sceneId: s.id, name: s.name, bars: s.bars * 2 })}
              aria-label={`Scene ${s.name}: ${barsLabel(s.bars)}, ${partsText(s.parts)}`}
            >
              <span className={styles.grip} aria-hidden="true">
                <Icon name="drag" size={12} />
              </span>
              <span className={styles.cardText}>
                <span className={styles.cardName}>{s.name}</span>
                <span className={`${styles.cardMeta} mono`}>
                  {barsLabel(s.bars)} · {partsText(s.parts)}
                </span>
              </span>
              <Tooltip name={`Add ${s.name}`} tip="Add this scene at the end of the song (2 repeats). You can also drag the card into the lane.">
                <button type="button" className={styles.cardAdd} aria-label={`Add ${s.name} to the end of the song`} onClick={() => addScene(s)}>
                  <Icon name="plus" size={14} />
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
        <p id={helpId} className={styles.hint}>
          Drag or Alt+←/→ to reorder · Del removes · Enter for options
        </p>
      </div>

      {drag &&
        createPortal(
          <div ref={ghostRef} className={styles.ghost} aria-hidden="true" data-drop={drag.gap !== null || undefined}>
            <span className={styles.ghostName}>{drag.source.name}</span>
            <span className={`${styles.ghostMeta} mono`}>{ghostText(drag.source, drag.gap)}</span>
          </div>,
          document.body,
        )}

      {menu && menuBlock && <BlockMenu block={menuBlock} count={views.length} scenes={scenes} anchor={menu.anchor} returnFocus={menu.returnFocus} onClose={() => setMenu(null)} onMove={move} onRemove={removeAndFocus} />}
    </section>
  );
}
