/**
 * The song block's actions menu and the per-part picker.
 *
 * Every lane action has an entry here, so the whole lane works from the
 * keyboard (Enter, ".", the menu key or Shift+F10 on a focused block opens
 * it). The first level is short, with the actions used most on top (play from
 * here, rename, duplicate, split, join, one more time / one fewer, remove);
 * the rest are grouped in lists that open in place with a Back item: the
 * parts of the block, scenes and clips (change, layer, replace, edit clips),
 * the song helpers, the loop, and copy / cut / paste / move. Pairs of opposite
 * actions share a row. Every list keeps the menu's size and place (a longer
 * list scrolls inside it), so opening one never makes the menu jump, and the
 * menu fits a laptop screen above or below its button.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Id, Project } from '../../../project/types';
import { joinProblemDetail, shapeProblem, type LayerMode, type ShapeKind, type ShapeProblem } from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { useProject } from '../../instance';
import { useRuntime } from '../../runtime';
import { MOD_KEY, MenuHeader, MenuItem, MenuSeparator, Popover, type MenuAnchor } from '../ClipMenu';
import menuStyles from '../ClipMenu.module.css';
import { LaneIcon, type LaneIconName } from './laneIcons';
import { loopSpan, loopTarget, sameSpan } from './laneLoop';
import { barsText, cellOn, cellState, lengthDetail, partChoices, type BlockView } from './songModel';
import styles from './SongPanel.module.css';

export interface SceneSummary {
  id: Id;
  row: number;
  name: string;
  bars: number;
  parts: number;
}

export function partsText(n: number): string {
  return n === 0 ? 'no clips' : n === 1 ? '1 part' : `${n} parts`;
}

export interface BlockMenuActions {
  play(id: Id): void;
  editClips(id: Id): void;
  rename(id: Id): void;
  togglePart(id: Id, trackId: Id): void;
  resetParts(id: Id): void;
  changeScene(id: Id, sceneId: Id): void;
  layerScene(id: Id, sceneId: Id, mode: LayerMode): void;
  lengthen(ids: Id[], delta: 1 | -1): void;
  splitHalf(id: Id): void;
  join(id: Id): void;
  duplicate(ids: Id[]): void;
  copy(ids: Id[]): void;
  cut(ids: Id[]): void;
  paste(): void;
  move(ids: Id[], dir: -1 | 1): void;
  remove(ids: Id[]): void;
  /** Loop these blocks (first to last) while the song plays. */
  loop(ids: Id[]): void;
  stopLoop(): void;
  /** A song helper on one block: build up, strip down or breakdown (one undo step). */
  shape(id: Id, kind: ShapeKind): void;
}

export type BlockMenuView = 'main' | 'parts' | 'scenes' | 'scene' | 'layer' | 'replace' | 'shape' | 'loop' | 'clipboard';

/** The list a Back item returns to. */
const PARENT: Record<BlockMenuView, BlockMenuView> = { main: 'main', parts: 'main', scenes: 'main', scene: 'scenes', layer: 'scenes', replace: 'scenes', shape: 'main', loop: 'main', clipboard: 'main' };

/** A menu row with one of the lane's own icons (same look and keys as MenuItem). */
function LaneMenuItem(props: { icon: LaneIconName; children: ReactNode; hint?: string; disabled?: boolean; disabledReason?: string; onSelect(): void }) {
  const { icon, children, hint, disabled, disabledReason, onSelect } = props;
  const shown = disabled && disabledReason ? disabledReason : hint;
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={menuStyles.item}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onSelect();
      }}
    >
      <span className={menuStyles.itemIcon} aria-hidden="true">
        <LaneIcon name={icon} size={14} />
      </span>
      <span className={menuStyles.itemText}>{children}</span>
      {shown && <span className={menuStyles.itemHint}>{shown}</span>}
    </button>
  );
}

/** Two opposite actions side by side in one row. */
function MenuPair({ children }: { children: ReactNode }) {
  return (
    <div className={styles.menuPair} role="none">
      {children}
    </div>
  );
}

const SHAPES: { kind: ShapeKind; icon: LaneIconName; name: string; what: string }[] = [
  { kind: 'build', icon: 'buildUp', name: 'Build up', what: 'Parts come in one at a time, each time the block plays: pads and textures first, the drums last.' },
  { kind: 'strip', icon: 'stripDown', name: 'Strip down', what: 'Every part first, then they drop out one at a time: the drums first.' },
  { kind: 'breakdown', icon: 'breakdown', name: 'Breakdown', what: 'The drums, percussion and bass switch off in this block.' },
];

function sameProblem(a: ShapeProblem | null, b: ShapeProblem | null): boolean {
  return a === b || (!!a && !!b && a.short === b.short && a.text === b.text);
}

export function BlockMenu(props: {
  block: BlockView;
  count: number;
  /** The blocks group actions apply to (the selection when this block is in it). */
  targets: Id[];
  canPaste: boolean;
  scenes: SceneSummary[];
  anchor: MenuAnchor;
  returnFocus: HTMLElement | null;
  initialView?: BlockMenuView;
  onClose(): void;
  actions: BlockMenuActions;
}) {
  const { block, count, targets, canPaste, scenes, anchor, returnFocus, onClose, actions } = props;
  const [view, setView] = useState<BlockMenuView>(props.initialView ?? 'main');
  const join = useProject((p) => joinProblemDetail(p, block.id), (a, b) => a === b || (!!a && !!b && shallowEqual(a, b)));
  // The loop: what this menu would loop (its blocks, first to last) and whether that is looping now.
  const order = useProject((p) => p.arrangement.blocks.map((b) => b.id), shallowEqual);
  const songLoop = useRuntime((s) => s.songLoop);
  const looping = loopSpan(order, songLoop);
  const loopsThese = sameSpan(looping, loopTarget(order, targets, null));
  const problems = useProject(
    (p) => SHAPES.map((x) => shapeProblem(p, block.id, x.kind)),
    (a, b) => a.length === b.length && a.every((x, i) => sameProblem(x, b[i])),
  );
  const many = targets.length > 1;
  const what = many ? `${targets.length} blocks` : 'block';
  const first = useProject((p) => p.arrangement.blocks.findIndex((b) => targets.includes(b.id)));
  const last = useProject((p) => {
    let i = -1;
    p.arrangement.blocks.forEach((b, j) => {
      if (targets.includes(b.id)) i = j;
    });
    return i;
  });

  /*
   * Every list keeps the size the first level has, so the menu never moves when one opens (its
   * place is chosen for that size): a shorter list leaves room, a longer one scrolls inside.
   */
  const bodyRef = useRef<HTMLDivElement>(null);
  const size = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    // Exactly (not rounded): a list a fraction of a pixel taller would be placed again.
    if (view === 'main' && el && size.current === null) size.current = el.getBoundingClientRect().height;
  });
  // A list that opens (or Back) puts focus on its first item, as the menu did when it opened.
  const shown = useRef(view);
  useLayoutEffect(() => {
    if (shown.current === view) return;
    shown.current = view;
    const el = bodyRef.current;
    const menu = el?.closest<HTMLElement>('[role="menu"]');
    if (!el || !menu) return;
    const active = document.activeElement;
    if (active && active !== document.body && !menu.contains(active)) return;
    el.querySelector<HTMLElement>('[role^="menuitem"]')?.focus({ preventScroll: true });
    el.scrollTop = 0;
  }, [view]);
  const open = (v: BlockMenuView) => () => setView(v);

  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const header = <MenuHeader eyebrow={`Block ${block.index + 1} of ${count} · ${block.missing ? 'skipped' : lengthDetail(block)}${many ? ` · ${targets.length} selected` : ''}`} title={block.name} />;
  const back = (
    <MenuItem icon="chevronLeft" onSelect={() => setView(PARENT[view])}>
      Back
    </MenuItem>
  );
  // (The menu has one width for every list: see .blockMenu.) Once measured, the first level keeps that height too.
  const fixed = size.current !== null ? { height: size.current } : undefined;

  let label = `Block ${block.index + 1}: ${block.name}`;
  let body: ReactNode;
  if (view === 'parts') {
    label = `Parts in ${block.name}`;
    body = (
      <>
        {back}
        <MenuSeparator />
        <div className={styles.menuLabel} role="presentation">
          Parts in this block (checked = plays)
        </div>
        {block.cells.map((c) => (
          <MenuItem key={c.trackId} role="menuitemcheckbox" checked={cellOn(c)} icon={cellOn(c) ? 'check' : undefined} hint={cellState(c)} onSelect={() => actions.togglePart(block.id, c.trackId)}>
            {c.partName}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon="undo" disabled={block.changes === 0} disabledReason="No changes" onSelect={act(() => actions.resetParts(block.id))}>
          Reset all parts to the scene
        </MenuItem>
      </>
    );
  } else if (view === 'scenes') {
    label = `Scenes and clips of ${block.name}`;
    body = (
      <>
        {back}
        <MenuSeparator />
        <MenuItem icon="copy" hint={block.sceneName} onSelect={open('scene')}>
          Change scene…
        </MenuItem>
        <MenuItem icon="plus" disabled={block.missing} disabledReason="Scene missing" onSelect={open('layer')}>
          Layer a scene in…
        </MenuItem>
        <MenuItem icon="copy" disabled={block.missing} disabledReason="Scene missing" onSelect={open('replace')}>
          Replace parts with a scene…
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon="link" disabled={block.missing} disabledReason="Scene missing" onSelect={act(() => actions.editClips(block.id))}>
          Edit clips in Play
        </MenuItem>
      </>
    );
  } else if (view === 'scene' || view === 'layer' || view === 'replace') {
    const layer = view !== 'scene';
    label = view === 'layer' ? `Layer a scene into ${block.name}` : view === 'replace' ? `Replace parts of ${block.name}` : `Scene for ${block.name}`;
    const note =
      view === 'layer'
        ? 'Parts that are silent in this block play that scene’s clips'
        : view === 'replace'
          ? 'Every part with a clip in that scene plays it here'
          : 'Scene this block plays';
    body = (
      <>
        {back}
        <MenuSeparator />
        <div className={styles.menuLabel} role="presentation">
          {note}
        </div>
        {scenes.map((sc) => (
          <MenuItem
            key={sc.id}
            role="menuitemcheckbox"
            checked={!layer && sc.id === block.sceneId}
            icon={!layer && sc.id === block.sceneId ? 'check' : undefined}
            hint={`${barsText(sc.bars)} · ${partsText(sc.parts)}`}
            disabled={layer && sc.id === block.sceneId}
            disabledReason="Its own scene"
            onSelect={act(() => (layer ? actions.layerScene(block.id, sc.id, view === 'replace' ? 'replace' : 'fill') : sc.id !== block.sceneId && actions.changeScene(block.id, sc.id)))}
          >
            {sc.name}
          </MenuItem>
        ))}
      </>
    );
  } else if (view === 'shape') {
    label = `Shape ${block.name}`;
    body = (
      <>
        {back}
        <MenuSeparator />
        <div className={styles.menuLabel} role="presentation">
          Shape this block (one Undo each)
        </div>
        {SHAPES.map((x, i) => (
          <div key={x.kind} role="none" className={styles.shapeItem}>
            <LaneMenuItem icon={x.icon} disabled={!!problems[i]} disabledReason={problems[i]?.short} onSelect={act(() => actions.shape(block.id, x.kind))}>
              {x.name}
            </LaneMenuItem>
            <div className={styles.menuNote} role="presentation">
              {problems[i]?.text ?? x.what}
            </div>
          </div>
        ))}
      </>
    );
  } else if (view === 'loop') {
    label = `Loop ${block.name}`;
    body = (
      <>
        {back}
        <MenuSeparator />
        <div className={styles.menuLabel} role="presentation">
          The looped blocks repeat while the song plays
        </div>
        <LaneMenuItem icon="loop" disabled={loopsThese || (!many && block.missing)} disabledReason={loopsThese ? 'Loop is on' : 'Scene missing'} onSelect={act(() => actions.loop(targets))}>
          {many ? 'Loop selected blocks' : 'Loop this block'}
        </LaneMenuItem>
        <MenuItem icon="stop" disabled={!looping} disabledReason="No loop" onSelect={act(() => actions.stopLoop())}>
          Stop looping
        </MenuItem>
      </>
    );
  } else if (view === 'clipboard') {
    label = `Copy, cut or move ${block.name}`;
    body = (
      <>
        {back}
        <MenuSeparator />
        <MenuPair>
          <MenuItem icon="copy" hint={`${MOD_KEY}C`} keyShortcut="Control+C" onSelect={act(() => actions.copy(targets))}>
            Copy {what}
          </MenuItem>
          <MenuItem icon="trash" hint={`${MOD_KEY}X`} keyShortcut="Control+X" onSelect={act(() => actions.cut(targets))}>
            Cut {what}
          </MenuItem>
        </MenuPair>
        <MenuItem icon="paste" hint={`${MOD_KEY}V`} keyShortcut="Control+V" disabled={!canPaste} disabledReason="Copy first" onSelect={act(() => actions.paste())}>
          Paste after
        </MenuItem>
        <MenuSeparator />
        <MenuPair>
          <MenuItem icon="chevronLeft" hint="Alt+←" keyShortcut="Alt+ArrowLeft" disabled={first <= 0} disabledReason="First" onSelect={act(() => actions.move(targets, -1))}>
            Move earlier
          </MenuItem>
          <MenuItem icon="chevronRight" hint="Alt+→" keyShortcut="Alt+ArrowRight" disabled={last < 0 || last >= count - 1} disabledReason="Last" onSelect={act(() => actions.move(targets, 1))}>
            Move later
          </MenuItem>
        </MenuPair>
      </>
    );
  } else {
    body = (
      <>
        <MenuItem icon="play" disabled={block.missing} disabledReason="Scene missing" onSelect={act(() => actions.play(block.id))}>
          Play song from here
        </MenuItem>
        <MenuItem icon="settings" hint="F2" keyShortcut="F2" onSelect={act(() => actions.rename(block.id))}>
          Rename…
        </MenuItem>
        <MenuItem icon="duplicate" hint={`${MOD_KEY}D`} keyShortcut="Control+D" onSelect={act(() => actions.duplicate(targets))}>
          Duplicate {what}
        </MenuItem>
        <MenuItem icon="duplicate" disabled={block.repeats < 2} disabledReason="Plays once" onSelect={act(() => actions.splitHalf(block.id))}>
          Split in half
        </MenuItem>
        <MenuItem icon="link" disabled={join !== null} disabledReason={join?.short} onSelect={act(() => actions.join(block.id))}>
          Join with next
        </MenuItem>
        {join !== null && <JoinReason text={join.text} />}
        <MenuPair>
          <MenuItem icon="plus" hint="+" keyShortcut="+" disabled={block.repeats >= 16 || block.missing} disabledReason={block.missing ? 'Scene missing' : 'Max 16'} onSelect={() => actions.lengthen(targets, 1)}>
            One more time
          </MenuItem>
          <MenuItem icon="minus" hint="−" keyShortcut="-" disabled={block.repeats <= 1} disabledReason="Plays once" onSelect={() => actions.lengthen(targets, -1)}>
            One time fewer
          </MenuItem>
        </MenuPair>
        <MenuSeparator />
        <MenuItem icon="sliders" hint={block.changes ? `${block.changes} changed` : undefined} disabled={block.missing} disabledReason="Scene missing" onSelect={open('parts')}>
          Parts in this block…
        </MenuItem>
        <MenuItem icon="copy" hint={block.sceneName} onSelect={open('scenes')}>
          Scenes and clips…
        </MenuItem>
        <LaneMenuItem icon="buildUp" hint="Build up, strip down" disabled={block.missing} disabledReason="Scene missing" onSelect={open('shape')}>
          Shape this block…
        </LaneMenuItem>
        <LaneMenuItem icon="loop" hint={loopsThese ? 'Loop is on' : looping ? 'Loop elsewhere' : undefined} onSelect={open('loop')}>
          Loop…
        </LaneMenuItem>
        <MenuItem icon="copy" hint={`${MOD_KEY}C, ${MOD_KEY}V`} onSelect={open('clipboard')}>
          Copy, cut, move…
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon="trash" tone="danger" hint="Del" keyShortcut="Delete" onSelect={act(() => actions.remove(targets))}>
          Remove {many ? `${targets.length} blocks` : 'from song'}
        </MenuItem>
      </>
    );
  }

  return (
    <Popover anchor={anchor} label={label} onClose={onClose} returnFocus={returnFocus} className={styles.blockMenu}>
      {header}
      <div ref={bodyRef} role="none" className={styles.menuBody} data-view={view} style={fixed}>
        {body}
      </div>
    </Popover>
  );
}

/** Why Join is unavailable, in full (the item's hint is short). */
function JoinReason({ text }: { text: string }) {
  return (
    <div className={styles.menuNote} role="presentation">
      {text}
    </div>
  );
}

/** The part picker: what one part plays in one block. */
export function PartPicker(props: { block: BlockView; trackId: Id; anchor: MenuAnchor; returnFocus: HTMLElement | null; onClose(): void; onChoose(choice: Id | null | undefined): void }) {
  const { block, trackId, anchor, returnFocus, onClose, onChoose } = props;
  const choices = useProject((p: Project) => {
    const b = p.arrangement.blocks.find((x) => x.id === block.id);
    return b ? partChoices(p, b, trackId) : [];
  }, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  const cell = block.cells.find((c) => c.trackId === trackId);
  const part = cell?.partName ?? 'Part';
  return (
    <Popover anchor={anchor} label={`What ${part} plays in ${block.name}`} onClose={onClose} returnFocus={returnFocus}>
      <MenuHeader eyebrow={`${part} · block ${block.index + 1}`} title={`What ${part} plays in ${block.name}`} />
      {choices.map((c) => (
        <MenuItem
          key={c.key}
          role="menuitemcheckbox"
          checked={c.checked}
          icon={c.checked ? 'check' : undefined}
          hint={c.hint}
          onSelect={() => {
            onClose();
            onChoose(c.choice);
          }}
        >
          {c.label}
        </MenuItem>
      ))}
      {choices.length <= 2 && (
        <div className={styles.menuNote} role="presentation">
          No other scene has a clip for {part}. Add one in Play to layer it here.
        </div>
      )}
    </Popover>
  );
}
