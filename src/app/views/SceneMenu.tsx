/**
 * Scene menu for the side buttons of the Loops grid ('⋯', right-click, the
 * menu key or F2): rename the scene, launch it, add it to the arrangement or
 * export it as a WAV loop.
 */
import { useState } from 'react';
import type { Id } from '../../project/types';
import { DEFAULT_BLOCK_REPEATS, addBlock, renameScene } from '../../state/commands';
import { shallowEqual } from '../../state/store';
import { session, useProject } from '../instance';
import { notify } from '../runtime';
import { MenuHeader, MenuItem, MenuSeparator, Popover, RenameForm, type MenuAnchor } from './ClipMenu';
import styles from './SceneMenu.module.css';

export interface SceneMenuProps {
  row: number;
  anchor: MenuAnchor;
  returnFocus?: HTMLElement | null;
  ignore?: Element | null;
  startInRename?: boolean;
  onClose(): void;
}

export function SceneMenu({ row, anchor, returnFocus, ignore, startInRename, onClose }: SceneMenuProps) {
  const info = useProject(
    (p) => {
      const scene = p.scenes[row];
      if (!scene) return null;
      const parts = p.tracks.filter((t) => t.clips[row]).length;
      const bars = p.tracks.reduce((m, t) => Math.max(m, t.clips[row]?.bars ?? 0), 0);
      const inSong = p.arrangement.blocks.filter((b) => b.sceneId === scene.id).length;
      return { id: scene.id as Id, name: scene.name, parts, bars, inSong };
    },
    shallowEqual,
  );
  const [renaming, setRenaming] = useState(!!startInRename);
  if (!info) return null;
  const eyebrow = `Scene ${row + 1}`;

  if (renaming) {
    return (
      <Popover anchor={anchor} label={`Rename scene ${info.name}`} role="dialog" onClose={onClose} returnFocus={returnFocus} ignore={ignore}>
        <MenuHeader eyebrow={eyebrow} title="Rename scene" />
        <RenameForm
          label="Scene name"
          initial={info.name}
          maxLength={40}
          onSubmit={(name) => {
            if (!session.accepted(renameScene(session.store, info.id, name))) return false;
            onClose();
            return true;
          }}
          onCancel={onClose}
        />
      </Popover>
    );
  }

  return (
    <Popover anchor={anchor} label={`Scene ${info.name}`} onClose={onClose} returnFocus={returnFocus} ignore={ignore}>
      <MenuHeader eyebrow={eyebrow} title={info.name}>
        <div className={styles.meta}>
          {info.parts} of 8 parts{info.bars ? ` · ${info.bars} bar${info.bars === 1 ? '' : 's'} long` : ''}
          {info.inSong ? ` · ${info.inSong}× in the song` : ''}
        </div>
      </MenuHeader>
      <MenuItem hint="F2" keyShortcut="F2" onSelect={() => setRenaming(true)}>
        Rename scene…
      </MenuItem>
      <MenuItem
        icon="play"
        hint={info.parts === 0 ? 'stops all parts' : 'next bar'}
        onSelect={() => {
          void session.launchScene(row);
          onClose();
        }}
      >
        Launch scene
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon="plus"
        hint={info.parts === 0 ? 'a silent section' : `${DEFAULT_BLOCK_REPEATS}× at the end`}
        onSelect={() => {
          if (session.accepted(addBlock(session.store, info.id))) notify(`Added ${info.name} (${DEFAULT_BLOCK_REPEATS}×) to the end of the song. Arrange it in the Arrange view.`, 'info', 'undo');
          onClose();
        }}
      >
        Add to song
      </MenuItem>
      <MenuItem
        icon="download"
        disabled={info.parts === 0}
        disabledReason="No clips in this row"
        onSelect={() => {
          onClose();
          window.dispatchEvent(new CustomEvent('sb:open-export', { detail: { source: `scene:${row}` } }));
        }}
      >
        Export as WAV…
      </MenuItem>
    </Popover>
  );
}
