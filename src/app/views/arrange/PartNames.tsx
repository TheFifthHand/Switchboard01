/**
 * The part names beside the song lane (they do not scroll with it).
 *
 *   Drums                 ← name (opens the part's song actions)
 *   Muted                 ← the state in words, as Play and Mix say it
 *
 * Each row says whether its part is heard: Muted, Solo, or Not soloed (while
 * another part is soloed), and the lane dims that part's cells in every block
 * (the blocks keep their colours). The column is narrow (the names, whole);
 * hovered or with keyboard focus it widens over the lane's edge and the row
 * under the pointer (or with focus) shows its Mute and Solo keys: the icon,
 * the word on hover or focus, a 32 x 32 hit area whatever the row height.
 * They call the same session commands as Play and Mix, so all three stay in
 * sync (and Undo covers them); the part's menu has them too. The name opens
 * the part's song actions (Mute, Solo, Off in selected blocks, Off
 * everywhere, Back on everywhere), which the lane renders. The column is one
 * Tab stop: arrow keys move between the parts and their Mute and Solo keys.
 */
import { memo, useId, useRef, useState, type KeyboardEvent } from 'react';
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

/** The keys of a row, left to right: the name (song actions), Mute, Solo. */
type Col = 0 | 1 | 2;

export const PartNames = memo(function PartNames(props: { menuTrack: Id | null; onMenu(trackId: Id, trigger: HTMLElement): void }) {
  const { menuTrack, onMenu } = props;
  const rows = usePartRows();
  const anySolo = rows.some((r) => r.solo);
  // One Tab stop for the whole column (the key last used): arrows move between parts (up, down) and
  // between a part's name, Mute and Solo (left, right); Home and End go to the first and last part.
  const [active, setActive] = useState<{ row: number; col: Col }>({ row: 0, col: 0 });
  const at = { row: Math.min(active.row, Math.max(0, rows.length - 1)), col: active.col };
  const groupRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const keyAt = (row: number, col: Col) => groupRef.current?.querySelector<HTMLButtonElement>(`[data-row="${row}"][data-col="${col}"]`) ?? null;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement;
    const row = Number(t.dataset.row);
    const col = Number(t.dataset.col) as Col;
    if (!Number.isFinite(row) || !Number.isFinite(col)) return;
    let next: { row: number; col: Col } | null = null;
    if (e.key === 'ArrowDown') next = { row: Math.min(rows.length - 1, row + 1), col };
    else if (e.key === 'ArrowUp') next = { row: Math.max(0, row - 1), col };
    else if (e.key === 'ArrowRight') next = { row, col: Math.min(2, col + 1) as Col };
    else if (e.key === 'ArrowLeft') next = { row, col: Math.max(0, col - 1) as Col };
    else if (e.key === 'Home') next = { row: 0, col };
    else if (e.key === 'End') next = { row: rows.length - 1, col };
    if (!next) return;
    e.preventDefault();
    setActive(next);
    // The row's keys show while it has focus: shown already as focus moves there (data-keys, until it leaves).
    showKeys(next.row);
    keyAt(next.row, next.col)?.focus();
  };
  const showKeys = (row: number | null) => {
    for (const el of groupRef.current?.querySelectorAll<HTMLElement>('[data-name-row]') ?? []) {
      if (Number(el.dataset.index) === row) el.dataset.keys = '';
      else delete el.dataset.keys;
    }
  };
  const tab = (row: number, col: Col) => (row === at.row && col === at.col ? 0 : -1);
  const focusIn = (row: number, col: Col) => () => {
    if (row !== active.row || col !== active.col) setActive({ row, col });
  };
  return (
    <div className={styles.namesSlot}>
    <div
      ref={groupRef}
      className={styles.names}
      role="group"
      aria-label="Parts: mute, solo and song actions per part"
      aria-describedby={`${helpId}`}
      data-testid="part-names"
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) showKeys(null);
      }}
    >
      <span id={helpId} hidden>
        Arrow keys move between the parts and their Mute and Solo keys.
      </span>
      {rows.map((r, i) => {
        const status = partStatus(r, anySolo);
        const statusKey = status === 'Muted' ? 'muted' : status === 'Solo' ? 'solo' : status ? 'quiet' : undefined;
        return (
          <div key={r.id} className={styles.nameRow} data-name-row="" data-index={i} data-track={r.id} data-status={statusKey}>
            <button
              type="button"
              className={styles.partName}
              aria-haspopup="menu"
              aria-expanded={menuTrack === r.id}
              aria-label={`${r.name}${status ? ` (${status.toLowerCase()})` : ''}: song actions for this part`}
              title={r.name}
              data-row={i}
              data-col={0}
              tabIndex={tab(i, 0)}
              onFocus={focusIn(i, 0)}
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
              data-row={i}
              data-col={1}
              tabIndex={tab(i, 1)}
              onFocus={focusIn(i, 1)}
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
              data-row={i}
              data-col={2}
              tabIndex={tab(i, 2)}
              onFocus={focusIn(i, 2)}
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
  const mute = useProject((p) => !!p.tracks.find((t) => t.id === trackId)?.mute);
  const solo = useProject((p) => !!p.tracks.find((t) => t.id === trackId)?.solo);
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
      {/* The same Mute and Solo as beside the name (and in Play and Mix): within a tap on a touch screen. */}
      <MenuItem icon="speaker" role="menuitemcheckbox" checked={mute} hint={mute ? 'On' : undefined} onSelect={run(() => session.setMute(trackId, !mute))}>
        Mute
      </MenuItem>
      <MenuItem icon="headphones" role="menuitemcheckbox" checked={solo} hint={solo ? 'On' : undefined} onSelect={run(() => session.setSolo(trackId, !solo))}>
        Solo
      </MenuItem>
      <MenuSeparator />
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
        Mute and Solo silence the part everywhere at once; the others switch it in the song’s blocks.
      </div>
    </Popover>
  );
}
