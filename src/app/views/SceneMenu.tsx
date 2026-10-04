/**
 * Scene menu for the side buttons of the Loops grid ('⋯', right-click, the
 * menu key or F2): rename the scene, launch it, move the row up or down (its
 * clips move with it), insert an empty scene above or below, duplicate it
 * (its clips are copied, the copy named like "Groove 2"), make a new scene
 * from the clips playing now, add it to the end of the song (a loop for each
 * of its parts, under a section named after it), export it as a WAV loop, or
 * delete it. A project has 1 to 8 scenes. Deleting a scene the song plays
 * asks first, saying how many of the song's loops play its clips (they leave
 * the song with it). While a performance take records, the rows that would
 * edit say so and do nothing (Launch and Export stay).
 */
import { useEffect, useState } from 'react';
import { MAX_SCENES, MIN_SCENES, type Id } from '../../project/types';
import { songBars } from '../../project/arrangement';
import { addSceneToSong, captureScene, deleteScene, duplicateScene, insertScene, renameScene, sceneUse } from '../../state/commands';
import { shallowEqual } from '../../state/store';
import { session, useProject } from '../instance';
import { notify, runtimeStore, useRuntime } from '../runtime';
import { LOCKED_REASON, LOCKED_TEXT, MenuHeader, MenuItem, MenuSeparator, Popover, RenameForm, useEditLocked, type MenuAnchor } from './ClipMenu';
import styles from './SceneMenu.module.css';

export interface SceneMenuProps {
  row: number;
  anchor: MenuAnchor;
  returnFocus?: HTMLElement | null;
  ignore?: Element | null;
  startInRename?: boolean;
  onClose(): void;
}

const FULL_REASON = `${MAX_SCENES} scenes is the most`;

/** "1 loop", "3 loops" (of the song). */
function loopsText(n: number): string {
  return n === 1 ? '1 loop' : `${n} loops`;
}

/** What each part plays now (its sounding or armed clip), for "New scene from what's playing". */
function playingSlots(): Record<Id, number | null> {
  const out: Record<Id, number | null> = {};
  for (const [id, t] of Object.entries(runtimeStore.getState().tracks)) out[id] = t?.playingSlot ?? null;
  return out;
}

/** Focus a scene's button once the grid has its row (after the menu gives focus back). */
function focusScene(row: number): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-scene-row="${row}"] button[data-scene]`)?.focus());
}

export function SceneMenu({ row, anchor, returnFocus, ignore, startInRename, onClose }: SceneMenuProps) {
  const info = useProject(
    (p) => {
      const scene = p.scenes[row];
      if (!scene) return null;
      const use = sceneUse(p, scene.id);
      return {
        id: scene.id as Id,
        name: scene.name,
        parts: p.tracks.filter((t) => t.clips[row]).length,
        of: p.tracks.length,
        bars: p.tracks.reduce((m, t) => Math.max(m, t.clips[row]?.bars ?? 0), 0),
        rows: p.scenes.length,
        inSong: use.regions,
      };
    },
    shallowEqual,
  );
  // What plays now (or holds at a pause); armed clips while stopped are not "playing".
  const anyPlaying = useRuntime((s) => (s.playing || s.paused) && Object.values(s.tracks).some((t) => t?.playingSlot != null));
  const locked = useEditLocked();
  const [mode, setMode] = useState<'menu' | 'rename' | 'confirmDelete'>(startInRename && !locked ? 'rename' : 'menu');
  // Its scene went (an undo elsewhere, another project): the menu closes, rather than come back if the row does.
  const gone = !info;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (!info) return null;
  const eyebrow = `Scene ${row + 1} of ${info.rows}`;
  const full = info.rows >= MAX_SCENES;
  /** Why an editing row is off: the take lock first, else `other`. */
  const why = (other: string) => (locked ? LOCKED_REASON : other);

  if (mode === 'rename') {
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

  const remove = () => {
    const r = deleteScene(session.store, row);
    onClose();
    if (!session.accepted(r)) return;
    const gone = r.regions ?? 0;
    notify(`Deleted the scene ${info.name} and its clips${gone ? `, and the song’s ${loopsText(gone)} that played them` : ''}.`, 'info', 'undo');
    // Focus goes to the scene that took its place (the one above, when it was the last).
    focusScene(Math.min(row, session.store.getState().scenes.length - 1));
  };

  if (mode === 'confirmDelete') {
    const n = info.inSong;
    return (
      // Its own popover (a fresh mount), so focus lands on its first choice.
      <Popover key="confirm" anchor={anchor} label={`Delete scene ${info.name}?`} onClose={onClose} returnFocus={returnFocus} ignore={ignore}>
        <MenuHeader eyebrow={eyebrow} title={`Delete ${info.name}?`}>
          <p className={styles.warn}>
            {info.name} is in the song: {n === 1 ? '1 loop plays' : `${n} loops play`} its clips. Deleting it takes {n === 1 ? 'that loop' : 'them'} out of the song. Undo brings it all back.
          </p>
        </MenuHeader>
        <MenuItem icon="trash" tone="danger" onSelect={remove}>
          {`Delete scene and ${loopsText(n)}`}
        </MenuItem>
        <MenuItem icon="close" onSelect={() => setMode('menu')}>
          Keep it
        </MenuItem>
      </Popover>
    );
  }

  const insert = (at: number, where: 'above' | 'below') => {
    const r = insertScene(session.store, at);
    onClose();
    if (!session.accepted(r)) return;
    const name = session.store.getState().scenes[r.row ?? at]?.name ?? 'A new scene';
    notify(`Added the empty scene ${name} ${where} ${info.name}.`, 'info', 'undo');
    focusScene(r.row ?? at);
  };

  return (
    <Popover key="menu" anchor={anchor} label={`Scene ${info.name}`} onClose={onClose} returnFocus={returnFocus} ignore={ignore}>
      <MenuHeader eyebrow={eyebrow} title={info.name}>
        <div className={styles.meta}>
          {info.parts} of {info.of} parts{info.bars ? ` · ${info.bars} bar${info.bars === 1 ? '' : 's'} long` : ''}
          {info.inSong ? ` · in the song` : ''}
          {locked ? ` · ${LOCKED_TEXT}` : ''}
        </div>
      </MenuHeader>
      <MenuItem icon="pencil" hint="F2" keyShortcut="F2" disabled={locked} disabledReason={LOCKED_REASON} onSelect={() => setMode('rename')}>
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
        Play row
      </MenuItem>
      <MenuItem
        icon="chevronUp"
        hint="Alt+↑"
        keyShortcut="Alt+ArrowUp"
        disabled={row === 0 || locked}
        disabledReason={why('Already the top row')}
        onSelect={() => {
          onClose();
          session.moveScene(row, row - 1);
        }}
      >
        Move up
      </MenuItem>
      <MenuItem
        icon="chevronDown"
        hint="Alt+↓"
        keyShortcut="Alt+ArrowDown"
        disabled={row === info.rows - 1 || locked}
        disabledReason={why('Already the bottom row')}
        onSelect={() => {
          onClose();
          session.moveScene(row, row + 1);
        }}
      >
        Move down
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon="plus" disabled={full || locked} disabledReason={why(FULL_REASON)} onSelect={() => insert(row, 'above')}>
        Insert scene above
      </MenuItem>
      <MenuItem icon="plus" disabled={full || locked} disabledReason={why(FULL_REASON)} onSelect={() => insert(row + 1, 'below')}>
        Insert scene below
      </MenuItem>
      <MenuItem
        icon="duplicate"
        disabled={full || locked}
        disabledReason={why(FULL_REASON)}
        hint="copies its clips"
        onSelect={() => {
          const r = duplicateScene(session.store, row);
          onClose();
          if (!session.accepted(r)) return;
          const at = r.row ?? row + 1;
          notify(`Duplicated ${info.name} as ${session.store.getState().scenes[at]?.name ?? 'a copy'}, with copies of its clips.`, 'info', 'undo');
          focusScene(at);
        }}
      >
        Duplicate scene
      </MenuItem>
      <MenuItem
        icon="scene"
        disabled={full || !anyPlaying || locked}
        disabledReason={why(full ? FULL_REASON : 'Nothing is playing')}
        hint="a new last row"
        onSelect={() => {
          const r = captureScene(session.store, playingSlots());
          onClose();
          if (!session.accepted(r)) return;
          const p = session.store.getState();
          const at = r.row ?? p.scenes.length - 1;
          const parts = p.tracks.filter((t) => t.clips[at]).length;
          notify(`New scene ${p.scenes[at]?.name ?? ''} from what's playing: copies of ${parts === 1 ? '1 clip' : `${parts} clips`}.`, 'info', 'undo');
          focusScene(at);
        }}
      >
        New scene from what's playing
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon="plus"
        hint={info.parts === 0 ? undefined : 'at the end'}
        disabled={locked || info.parts === 0}
        disabledReason={locked ? LOCKED_REASON : 'No clips in this row'}
        onSelect={() => {
          const at = songBars(session.store.getState());
          if (session.accepted(addSceneToSong(session.store, row, at))) notify(`Added ${info.name} to the end of the song, from bar ${at + 1}. Shape it in the Song view.`, 'info', 'undo');
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
      <MenuSeparator />
      <MenuItem
        icon="trash"
        tone="danger"
        disabled={info.rows <= MIN_SCENES || locked}
        disabledReason={why('The only scene')}
        hint={info.inSong ? 'asks first: in the song' : undefined}
        onSelect={() => {
          if (info.inSong) setMode('confirmDelete');
          else remove();
        }}
      >
        Delete scene
      </MenuItem>
    </Popover>
  );
}
