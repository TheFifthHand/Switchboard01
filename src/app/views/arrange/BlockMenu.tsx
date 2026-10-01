/**
 * The song block's actions menu and the per-part picker.
 *
 * Every lane action has an entry here, so the whole lane works from the
 * keyboard (Enter, ".", the menu key or Shift+F10 on a focused block opens
 * it). Lists that would make the menu long (the parts of the block, the scene
 * to play, a scene to layer in) open in place with a Back item.
 */
import { useState } from 'react';
import type { Id, Project } from '../../../project/types';
import { joinProblem } from '../../../state/commands';
import { useProject } from '../../instance';
import { MOD_KEY, MenuHeader, MenuItem, MenuSeparator, Popover, type MenuAnchor } from '../ClipMenu';
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
  layerScene(id: Id, sceneId: Id): void;
  lengthen(ids: Id[], delta: 1 | -1): void;
  splitHalf(id: Id): void;
  join(id: Id): void;
  duplicate(ids: Id[]): void;
  copy(ids: Id[]): void;
  cut(ids: Id[]): void;
  paste(): void;
  move(ids: Id[], dir: -1 | 1): void;
  remove(ids: Id[]): void;
}

type View = 'main' | 'parts' | 'scene' | 'layer';

export function BlockMenu(props: {
  block: BlockView;
  count: number;
  /** The blocks group actions apply to (the selection when this block is in it). */
  targets: Id[];
  canPaste: boolean;
  scenes: SceneSummary[];
  anchor: MenuAnchor;
  returnFocus: HTMLElement | null;
  initialView?: View;
  onClose(): void;
  actions: BlockMenuActions;
}) {
  const { block, count, targets, canPaste, scenes, anchor, returnFocus, onClose, actions } = props;
  const [view, setView] = useState<View>(props.initialView ?? 'main');
  const join = useProject((p) => joinProblem(p, block.id));
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
  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const header = <MenuHeader eyebrow={`Block ${block.index + 1} of ${count} · ${block.missing ? 'skipped' : lengthDetail(block)}${many ? ` · ${targets.length} selected` : ''}`} title={block.name} />;
  const back = (
    <MenuItem icon="chevronLeft" onSelect={() => setView('main')}>
      Back
    </MenuItem>
  );

  if (view === 'parts') {
    return (
      <Popover anchor={anchor} label={`Parts in ${block.name}`} onClose={onClose} returnFocus={returnFocus}>
        {header}
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
      </Popover>
    );
  }

  if (view === 'scene' || view === 'layer') {
    const layer = view === 'layer';
    return (
      <Popover anchor={anchor} label={layer ? `Layer a scene into ${block.name}` : `Scene for ${block.name}`} onClose={onClose} returnFocus={returnFocus}>
        {header}
        {back}
        <MenuSeparator />
        <div className={styles.menuLabel} role="presentation">
          {layer ? 'Each part with a clip in that scene plays it here' : 'Scene this block plays'}
        </div>
        {scenes.map((s) => (
          <MenuItem
            key={s.id}
            role="menuitemcheckbox"
            checked={!layer && s.id === block.sceneId}
            icon={!layer && s.id === block.sceneId ? 'check' : undefined}
            hint={`${barsText(s.bars)} · ${partsText(s.parts)}`}
            disabled={layer && s.id === block.sceneId}
            disabledReason="Its own scene"
            onSelect={act(() => (layer ? actions.layerScene(block.id, s.id) : s.id !== block.sceneId && actions.changeScene(block.id, s.id)))}
          >
            {s.name}
          </MenuItem>
        ))}
      </Popover>
    );
  }

  return (
    <Popover anchor={anchor} label={`Block ${block.index + 1}: ${block.name}`} onClose={onClose} returnFocus={returnFocus}>
      {header}
      <MenuItem icon="play" disabled={block.missing} disabledReason="Scene missing" onSelect={act(() => actions.play(block.id))}>
        Play song from here
      </MenuItem>
      <MenuItem icon="link" disabled={block.missing} disabledReason="Scene missing" onSelect={act(() => actions.editClips(block.id))}>
        Edit clips in Play
      </MenuItem>
      <MenuItem icon="settings" hint="F2" keyShortcut="F2" onSelect={act(() => actions.rename(block.id))}>
        Rename…
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon="sliders" hint={block.changes ? `${block.changes} changed` : undefined} disabled={block.missing} disabledReason="Scene missing" onSelect={() => setView('parts')}>
        Parts in this block…
      </MenuItem>
      <MenuItem icon="copy" hint={block.sceneName} onSelect={() => setView('scene')}>
        Change scene…
      </MenuItem>
      <MenuItem icon="plus" disabled={block.missing} disabledReason="Scene missing" onSelect={() => setView('layer')}>
        Layer a scene in…
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon="plus" hint="+" keyShortcut="+" disabled={block.repeats >= 16 || block.missing} disabledReason={block.missing ? 'Scene missing' : '16 passes'} onSelect={() => actions.lengthen(targets, 1)}>
        One more pass
      </MenuItem>
      <MenuItem icon="minus" hint="−" keyShortcut="-" disabled={block.repeats <= 1} disabledReason="1 pass" onSelect={() => actions.lengthen(targets, -1)}>
        One pass fewer
      </MenuItem>
      <MenuItem icon="duplicate" disabled={block.repeats < 2} disabledReason="Plays once" onSelect={act(() => actions.splitHalf(block.id))}>
        Split in half
      </MenuItem>
      <MenuItem icon="link" disabled={join !== null} disabledReason={join ?? undefined} onSelect={act(() => actions.join(block.id))}>
        Join with next
      </MenuItem>
      {join !== null && <JoinReason text={join} />}
      <MenuSeparator />
      <MenuItem icon="duplicate" hint={`${MOD_KEY}D`} keyShortcut="Control+D" onSelect={act(() => actions.duplicate(targets))}>
        Duplicate {what}
      </MenuItem>
      <MenuItem icon="copy" hint={`${MOD_KEY}C`} keyShortcut="Control+C" onSelect={act(() => actions.copy(targets))}>
        Copy {what}
      </MenuItem>
      <MenuItem icon="trash" hint={`${MOD_KEY}X`} keyShortcut="Control+X" onSelect={act(() => actions.cut(targets))}>
        Cut {what}
      </MenuItem>
      <MenuItem icon="paste" hint={`${MOD_KEY}V`} keyShortcut="Control+V" disabled={!canPaste} disabledReason="Copy first" onSelect={act(() => actions.paste())}>
        Paste after
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon="chevronLeft" hint="Alt+←" keyShortcut="Alt+ArrowLeft" disabled={first <= 0} disabledReason="First" onSelect={act(() => actions.move(targets, -1))}>
        Move earlier
      </MenuItem>
      <MenuItem icon="chevronRight" hint="Alt+→" keyShortcut="Alt+ArrowRight" disabled={last < 0 || last >= count - 1} disabledReason="Last" onSelect={act(() => actions.move(targets, 1))}>
        Move later
      </MenuItem>
      <MenuItem icon="trash" tone="danger" hint="Del" keyShortcut="Delete" onSelect={act(() => actions.remove(targets))}>
        Remove {many ? `${targets.length} blocks` : 'from song'}
      </MenuItem>
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
