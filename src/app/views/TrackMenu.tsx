/**
 * Part menu for a Loops column header ('⋯', right-click, the menu key or
 * F2): rename the part, change its instrument, lock it against Variation and
 * open its full sound settings. Every change is an undoable project command.
 */
import { useState } from 'react';
import type { Id } from '../../project/types';
import { setLocked, renameTrack } from '../../state/commands';
import { selectTrack, setView } from '../../state/uiStore';
import { shallowEqual } from '../../state/store';
import { session, useProject } from '../instance';
import { notify } from '../runtime';
import { INSTRUMENT_LABEL, soundName } from '../labels';
import { MenuHeader, MenuItem, MenuSeparator, Popover, RenameForm, type MenuAnchor } from './ClipMenu';
import styles from './TrackMenu.module.css';

export interface TrackMenuProps {
  trackId: Id;
  anchor: MenuAnchor;
  returnFocus?: HTMLElement | null;
  ignore?: Element | null;
  startInRename?: boolean;
  onClose(): void;
  /** Open the sound browser for this part (the menu closes first). */
  onChangeSound(trackId: Id): void;
}

export function TrackMenu({ trackId, anchor, returnFocus, ignore, startInRename, onClose, onChangeSound }: TrackMenuProps) {
  const info = useProject(
    (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      return t
        ? { name: t.name, index: p.tracks.indexOf(t), sound: soundName(p, t.instrument), kind: INSTRUMENT_LABEL[t.instrument.kind], locked: t.locked }
        : null;
    },
    shallowEqual,
  );
  const [renaming, setRenaming] = useState(!!startInRename);
  if (!info) return null;
  const eyebrow = `Part ${info.index + 1} · ${info.kind}`;

  if (renaming) {
    return (
      <Popover anchor={anchor} label={`Rename part ${info.name}`} role="dialog" onClose={onClose} returnFocus={returnFocus} ignore={ignore}>
        <MenuHeader eyebrow={eyebrow} title="Rename part" />
        <RenameForm
          label="Part name"
          initial={info.name}
          maxLength={60}
          onSubmit={(name) => {
            if (!session.accepted(renameTrack(session.store, trackId, name))) return false;
            onClose();
            return true;
          }}
          onCancel={onClose}
        />
      </Popover>
    );
  }

  return (
    <Popover anchor={anchor} label={`Part ${info.name}`} onClose={onClose} returnFocus={returnFocus} ignore={ignore}>
      <MenuHeader eyebrow={eyebrow} title={info.name}>
        <div className={styles.sound}>{info.sound}</div>
      </MenuHeader>
      <MenuItem hint="F2" keyShortcut="F2" onSelect={() => setRenaming(true)}>
        Rename part…
      </MenuItem>
      <MenuItem
        icon="wave"
        onSelect={() => {
          selectTrack(trackId);
          onClose();
          onChangeSound(trackId);
        }}
      >
        Change instrument…
      </MenuItem>
      <MenuItem
        icon="settings"
        hint="Shape view"
        onSelect={() => {
          selectTrack(trackId);
          setView('shape');
          onClose();
        }}
      >
        Edit sound settings
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={info.locked ? 'lock' : 'unlock'}
        role="menuitemcheckbox"
        checked={info.locked}
        hint={info.locked ? 'Locked' : 'Unlocked'}
        onSelect={() => {
          const lock = !info.locked;
          if (session.accepted(setLocked(session.store, trackId, lock))) {
            notify(lock ? `${info.name} is locked: Variation leaves its patterns alone.` : `${info.name} is unlocked: Variation can change it again.`);
          }
          onClose();
        }}
      >
        Lock against Variation
      </MenuItem>
    </Popover>
  );
}
