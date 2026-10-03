/**
 * The part names beside the song lane (they do not scroll with it).
 *
 *   Drums      🔈 🎧      ← name (opens the part's song actions), Mute, Solo
 *   Muted                 ← the state in words, as Play and Mix say it
 *
 * Each row says whether its part is heard: Muted, Solo, or Not soloed (while
 * another part is soloed), and the lane dims that part's cells in every block
 * (the blocks keep their colours). The compact Mute and Solo keys show their
 * icon, and their word on hover or keyboard focus; they call the same session
 * commands as Play and Mix, so all three stay in sync (and Undo covers them).
 * The name opens the part's song actions (Off in selected blocks, Off
 * everywhere, Back on everywhere), which the lane renders.
 */
import { memo } from 'react';
import { Icon } from '../../../ui/components';
import { blockPart, sceneRow } from '../../../project/arrangement';
import type { Id, Project } from '../../../project/types';
import { session, useProject } from '../../instance';
import { MenuHeader, MenuItem, MenuSeparator, Popover, type MenuAnchor } from '../ClipMenu';
import { partStatus } from './songModel';
import styles from './SongPanel.module.css';

export interface PartRow {
  id: Id;
  name: string;
  mute: boolean;
  solo: boolean;
}

const selectRows = (p: Project): PartRow[] => p.tracks.map((t) => ({ id: t.id, name: t.name, mute: t.mute, solo: t.solo }));
const sameRows = (a: readonly PartRow[], b: readonly PartRow[]) =>
  a.length === b.length && a.every((x, i) => x.id === b[i].id && x.name === b[i].name && x.mute === b[i].mute && x.solo === b[i].solo);

/** The parts in song-lane order with their Mute / Solo state (the same array while nothing changed). */
export function usePartRows(): readonly PartRow[] {
  return useProject(selectRows, sameRows);
}

export const PartNames = memo(function PartNames(props: { menuTrack: Id | null; onMenu(trackId: Id, trigger: HTMLElement): void }) {
  const { menuTrack, onMenu } = props;
  const rows = usePartRows();
  const anySolo = rows.some((r) => r.solo);
  return (
    <div className={styles.names} role="group" aria-label="Parts: mute, solo and song actions per part" data-testid="part-names">
      {rows.map((r) => {
        const status = partStatus(r, anySolo);
        const statusKey = status === 'Muted' ? 'muted' : status === 'Solo' ? 'solo' : status ? 'quiet' : undefined;
        return (
          <div key={r.id} className={styles.nameRow} data-name-row="" data-track={r.id} data-status={statusKey}>
            <button
              type="button"
              className={styles.partName}
              aria-haspopup="menu"
              aria-expanded={menuTrack === r.id}
              aria-label={`${r.name}${status ? ` (${status.toLowerCase()})` : ''}: song actions for this part`}
              title={r.name}
              onClick={(e) => onMenu(r.id, e.currentTarget)}
            >
              <span className={styles.partNameText}>{r.name}</span>
              {/* Muted / Solo / Not soloed: a box that keeps its place, so switching moves nothing. */}
              <span className={styles.partStatus} data-status={statusKey} data-testid="part-status">
                {status ?? ''}
              </span>
            </button>
            <button
              type="button"
              className={styles.rowToggle}
              data-kind="mute"
              aria-pressed={r.mute}
              aria-label={`Mute ${r.name}`}
              onClick={() => session.setMute(r.id, !r.mute)}
            >
              <Icon name="speaker" size={13} />
              <span className={styles.toggleWord} aria-hidden="true">
                {r.mute ? 'Unmute' : 'Mute'}
              </span>
            </button>
            <button
              type="button"
              className={styles.rowToggle}
              data-kind="solo"
              aria-pressed={r.solo}
              aria-label={`Solo ${r.name}`}
              onClick={() => session.setSolo(r.id, !r.solo)}
            >
              <Icon name="headphones" size={13} />
              <span className={styles.toggleWord} aria-hidden="true">
                {r.solo ? 'Stop solo' : 'Solo'}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
});

/** Where a part sounds in the song: the blocks it plays in and those it is switched off in (in song order). */
function partUse(p: Project, trackId: Id): { plays: Id[]; off: Id[] } {
  const track = p.tracks.find((t) => t.id === trackId);
  const plays: Id[] = [];
  const off: Id[] = [];
  if (!track) return { plays, off };
  for (const b of p.arrangement.blocks) {
    if (b.parts && Object.prototype.hasOwnProperty.call(b.parts, trackId) && b.parts[trackId] === null) off.push(b.id);
    else if (sceneRow(p, b.sceneId) >= 0 && blockPart(p, b, track).clip) plays.push(b.id);
  }
  return { plays, off };
}

const blocksWord = (n: number) => (n === 1 ? '1 block' : `${n} blocks`);

export interface PartMenuActions {
  /** One part in the given blocks: off (null) or back on (undefined). */
  setInBlocks(ids: Id[], trackId: Id, choice: null | undefined): void;
  everywhere(trackId: Id, on: boolean): void;
}

/**
 * A part's song actions (from its name beside the lane): switch it off, or
 * back on, in the selected blocks or in every block. Each is one Undo step.
 */
export function PartMenu(props: { trackId: Id; selected: readonly Id[]; anchor: MenuAnchor; returnFocus: HTMLElement | null; onClose(): void; actions: PartMenuActions }) {
  const { trackId, selected, anchor, returnFocus, onClose, actions } = props;
  const name = useProject((p) => p.tracks.find((t) => t.id === trackId)?.name ?? 'Part');
  const use = useProject(
    (p) => partUse(p, trackId),
    (a, b) => a.plays.join() === b.plays.join() && a.off.join() === b.off.join(),
  );
  const n = selected.length;
  const selPlays = selected.filter((id) => use.plays.includes(id)).length;
  const selOff = selected.filter((id) => use.off.includes(id)).length;
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Popover anchor={anchor} label={`${name} in the song`} onClose={onClose} returnFocus={returnFocus}>
      <MenuHeader eyebrow={`Part · plays in ${blocksWord(use.plays.length)}${use.off.length ? ` · off in ${use.off.length}` : ''}`} title={`${name} in the song`} />
      <MenuItem
        icon="minus"
        disabled={!n || !selPlays}
        disabledReason={!n ? 'Select blocks first' : 'Not playing there'}
        hint={n ? `${blocksWord(n)} selected` : undefined}
        onSelect={run(() => actions.setInBlocks([...selected], trackId, null))}
      >
        Off in selected blocks
      </MenuItem>
      <MenuItem
        icon="plus"
        disabled={!n || !selOff}
        disabledReason={!n ? 'Select blocks first' : 'Not off there'}
        hint={n ? `${blocksWord(n)} selected` : undefined}
        onSelect={run(() => actions.setInBlocks([...selected], trackId, undefined))}
      >
        Back on in selected blocks
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon="minus" disabled={!use.plays.length} disabledReason="Plays nowhere" hint={use.plays.length ? blocksWord(use.plays.length) : undefined} onSelect={run(() => actions.everywhere(trackId, false))}>
        Off everywhere
      </MenuItem>
      <MenuItem icon="undo" disabled={!use.off.length} disabledReason="Not off anywhere" hint={use.off.length ? blocksWord(use.off.length) : undefined} onSelect={run(() => actions.everywhere(trackId, true))}>
        Back on everywhere
      </MenuItem>
      <div className={styles.menuNote} role="presentation">
        Mute and Solo (beside the name) silence the part everywhere at once; these switch it in the song’s blocks.
      </div>
    </Popover>
  );
}
