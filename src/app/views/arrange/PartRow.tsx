/**
 * A part's row in the song: a sticky header at the left and the lane its
 * regions sit on.
 *
 *  ┃1 Drums  Tight Circuit        [🔈][🎧][⋯]
 *  ┃  [▮▮▮▮▮▮▯▯ −2.0 dB] (◔)
 *
 * The header: the part's number, name and instrument (or Muted / Solo / Not
 * soloed in words while that is so), its volume slider and pan dial (the
 * same level and pan as its Mix strip, with a thin meter of what it plays),
 * its Mute and Solo keys, and ⋯ (also a right-click, the menu key or F2):
 * Rename part…, Change instrument… (the sound browser), Edit sound
 * settings, Keep pattern. Mute and Solo call the same session commands as
 * Play and Mix, so all three stay in step (Undo covers them).
 *
 * Simple mode: the instrument's picture and name instead of the number (a
 * click opens its Sound panel on the right), the volume without the pan
 * dial, and Mute, Solo and ⋯ only while the pointer is over the header or a
 * key has focus (always while it is muted or soloed).
 *
 * While Record writes into the song on this part (runtime songRecording),
 * a coral "Recording…" region grows on the row from the bar the take began,
 * above the loops there, until the take ends and becomes loops.
 *
 * The row re-renders only when its own regions or clips change (immer keeps
 * the objects of what an edit did not touch), and each region only when it
 * or its clip changes.
 */
import { memo, useCallback, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Icon, Tooltip } from '../../../ui/components';
import { clipById } from '../../../project/clips';
import type { Clip, Id, Project, SongRegion } from '../../../project/types';
import { selectTrack } from '../../../state/uiStore';
import { session, useProject, useUi } from '../../instance';
import { useRuntime } from '../../runtime';
import { useStore } from '../../../state/store';
import { MoreIcon, anchorFromContextEvent, anchorFromElement, isMenuKey, noteKeyboardMenu, type MenuAnchor } from '../ClipMenu';
import { SoundBrowser } from '../SoundBrowser';
import { TrackMenu } from '../TrackMenu';
import { PartControls } from './PartControls';
import { openSound, sidePanelStore } from './sidePanelStore';
import { INSTRUMENT_KINDS } from './songHome';
import { RegionView } from './RegionView';
import { barsText, partStatus, type RowView } from './songModel';
import styles from './SongView.module.css';

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a === b || (a.length === b.length && a.every((x, i) => x === b[i]));
}

const EMPTY: readonly SongRegion[] = [];

/** A part's regions (the same array while none of them changed). */
function useRowRegions(trackId: Id): readonly SongRegion[] {
  const select = useCallback((p: Project) => {
    const out = p.arrangement.regions.filter((r) => r.trackId === trackId);
    return out.length ? out : EMPTY;
  }, [trackId]);
  return useProject(select, sameList);
}

const NO_CLIPS: readonly (Clip | null)[] = [];

/** The clips a part's regions can play: its pads and its song loops (the same arrays while they did not change). */
function useRowClips(trackId: Id): { clips: readonly (Clip | null)[]; songClips: readonly Clip[] | undefined } {
  const selectPads = useCallback((p: Project) => p.tracks.find((t) => t.id === trackId)?.clips ?? NO_CLIPS, [trackId]);
  const selectSong = useCallback((p: Project) => p.tracks.find((t) => t.id === trackId)?.songClips, [trackId]);
  return { clips: useProject(selectPads), songClips: useProject(selectSong) };
}

function useRowKind(trackId: Id): 'notes' | 'drums' {
  const select = useCallback((p: Project) => (p.tracks.find((t) => t.id === trackId)?.instrument.kind === 'drums' ? 'drums' : 'notes'), [trackId]);
  return useProject(select);
}

/** Header keys: Mute, Solo and ⋯ (one Tab stop for all headers; arrow keys move between them, see partKeysNav). */
export type HeadCol = 0 | 1 | 2;
const HEAD_COLS = 3;

type HeadMenu = { anchor: MenuAnchor; returnFocus: HTMLElement | null; rename: boolean; viaMore: boolean };

/**
 * The header: number, name and instrument (or the part's state in words),
 * its volume and pan, and its keys (icons, named for screen readers and in
 * their tooltips).
 */
function PartHeader({ row, anySolo, tab, onFocusKey }: { row: RowView; anySolo: boolean; tab: HeadCol | null; onFocusKey(row: number, col: HeadCol): void }) {
  const status = partStatus(row, anySolo);
  const simple = useUi((s) => s.uiMode !== 'advanced');
  // The part the keyboard strip plays (chosen here, in Play or in Shape): a teal mark and a keys icon.
  // Simple has no keyboard strip: the mark is on the instrument whose Sound panel is open.
  const playsKeys = useUi((s) => s.selectedTrackId === row.id);
  const soundOpenHere = useStore(sidePanelStore, (s) => s.kind === 'sound' && s.trackId === row.id);
  const current = simple ? soundOpenHere : playsKeys;
  const kind = INSTRUMENT_KINDS[row.role] ?? INSTRUMENT_KINDS.lead;
  const [menu, setMenu] = useState<HeadMenu | null>(null);
  const [soundOpen, setSoundOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const openMenu = (anchor: MenuAnchor, returnFocus: HTMLElement | null, opts: { rename?: boolean; viaMore?: boolean } = {}) => {
    selectTrack(row.id);
    setMenu({ anchor, returnFocus, rename: !!opts.rename, viaMore: !!opts.viaMore });
  };
  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('input')) return;
    e.preventDefault();
    e.stopPropagation();
    openMenu(anchorFromContextEvent(e, e.currentTarget), moreRef.current);
  };
  const onKeysKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (isMenuKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      noteKeyboardMenu(e.currentTarget);
      openMenu(anchorFromElement(moreRef.current), e.currentTarget as HTMLElement);
    } else if (e.key === 'F2') {
      e.preventDefault();
      e.stopPropagation();
      openMenu(anchorFromElement(moreRef.current), e.currentTarget as HTMLElement, { rename: true });
    }
  };
  return (
    // A click on the header (not its keys) selects the part: the keyboard strip plays it.
    <div
      className={styles.partHead}
      data-part-head=""
      data-status={status === 'Muted' ? 'muted' : status === 'Solo' ? 'solo' : status ? 'quiet' : undefined}
      data-current={current || undefined}
      data-simple={simple || undefined}
      onClick={(e) => !(e.target as Element).closest('button, input') && selectTrack(row.id)}
      onContextMenu={onContextMenu}
    >
      {!simple && (
        <span className={styles.partNum} aria-hidden="true">
          {row.number}
        </span>
      )}
      <span className={styles.partBody}>
        <span className={styles.partNameLine}>
          {simple ? (
            // The instrument's picture and name: a click opens its Sound panel on the right.
            <Tooltip name={`${row.name}: sound`} tip={`Open ${row.name}’s sound: change it, its volume and how it feels.`}>
              <button
                type="button"
                className={styles.partNameKey}
                data-testid="row-name"
                aria-label={`${row.name} (${kind.name}): open its sound`}
                aria-pressed={soundOpenHere}
                onClick={() => {
                  selectTrack(row.id);
                  openSound(row.id);
                }}
              >
                <span className={styles.partIcon} aria-hidden="true">
                  <Icon name={kind.icon} size={13} />
                </span>
                <span className={styles.partName}>{row.name}</span>
              </button>
            </Tooltip>
          ) : (
            <span className={styles.partName} title={row.name}>
              {row.name}
            </span>
          )}
          {!simple && current && (
            <span className={styles.partCurrent} title="The keyboard plays this part">
              <Icon name="keys" size={11} />
              <span className={styles.srOnly}>(the keyboard plays this part)</span>
            </span>
          )}
          <span className={styles.partSound} title={status ?? row.sound}>
            {status ?? row.sound}
          </span>
        </span>
        <PartControls trackId={row.id} name={row.name} pan={!simple} />
      </span>
      <span className={styles.partKeys}>
        <Tooltip name={row.mute ? `Unmute ${row.name}` : `Mute ${row.name}`} tip={row.mute ? `Hear ${row.name} again.` : `Silence ${row.name} in the song (it keeps its place).`}>
          <button
            type="button"
            className={styles.partKey}
            data-kind="mute"
            data-row={row.index}
            data-col={0}
            tabIndex={tab === 0 ? 0 : -1}
            aria-pressed={row.mute}
            aria-label={`Mute ${row.name}`}
            aria-keyshortcuts="Shift+F10 F2"
            onFocus={() => onFocusKey(row.index, 0)}
            onKeyDown={onKeysKeyDown}
            onClick={() => session.setMute(row.id, !row.mute)}
          >
            <Icon name="speaker" size={14} />
          </button>
        </Tooltip>
        <Tooltip name={row.solo ? `Stop soloing ${row.name}` : `Solo ${row.name}`} tip={simple ? (row.solo ? 'Hear every instrument again.' : `Hear ${row.name} alone.`) : row.solo ? `Hear every part again.` : `Hear only ${row.name} (and any other soloed part).`}>
          <button
            type="button"
            className={styles.partKey}
            data-kind="solo"
            data-row={row.index}
            data-col={1}
            tabIndex={tab === 1 ? 0 : -1}
            aria-pressed={row.solo}
            aria-label={`Solo ${row.name}`}
            aria-keyshortcuts="Shift+F10 F2"
            onFocus={() => onFocusKey(row.index, 1)}
            onKeyDown={onKeysKeyDown}
            onClick={() => session.setSolo(row.id, !row.solo)}
          >
            <Icon name="headphones" size={14} />
          </button>
        </Tooltip>
        <Tooltip name={`${row.name}: more`} tip={`Rename ${row.name}, change its instrument or open its sound settings.`}>
          <button
            ref={moreRef}
            type="button"
            className={styles.partKey}
            data-kind="more"
            data-row={row.index}
            data-col={2}
            tabIndex={tab === 2 ? 0 : -1}
            aria-label={`Actions for ${row.name}`}
            aria-haspopup="menu"
            aria-expanded={menu?.viaMore || undefined}
            aria-keyshortcuts="Shift+F10 F2"
            onFocus={() => onFocusKey(row.index, 2)}
            onKeyDown={onKeysKeyDown}
            onClick={(e) => (menu?.viaMore ? setMenu(null) : openMenu(anchorFromElement(e.currentTarget), e.currentTarget, { viaMore: true }))}
          >
            <MoreIcon size={14} />
          </button>
        </Tooltip>
      </span>
      {menu && (
        <TrackMenu
          trackId={row.id}
          anchor={menu.anchor}
          returnFocus={menu.returnFocus}
          ignore={menu.viaMore ? moreRef.current : null}
          startInRename={menu.rename}
          onClose={() => setMenu(null)}
          onChangeSound={() => setSoundOpen(true)}
        />
      )}
      {soundOpen && <SoundBrowser open trackId={row.id} onClose={() => setSoundOpen(false)} />}
    </div>
  );
}

/**
 * The take Record is writing into the song on this part, drawn as it grows:
 * a coral region with the word, over the loops it will replace.
 */
function RecordingRegion({ trackId }: { trackId: Id }) {
  const rec = useRuntime(
    (s) => (s.songRecording && s.songRecording.trackId === trackId ? s.songRecording : null),
    (a, b) => a === b || (!!a && !!b && a.startBar === b.startBar && a.bars === b.bars),
  );
  if (!rec) return null;
  return (
    <div className={styles.recRegion} data-recording-region="" style={{ '--s': rec.startBar, '--b': Math.max(1, rec.bars) } as CSSProperties} role="status" aria-label={`Recording into the song from bar ${rec.startBar + 1}, ${barsText(Math.max(1, rec.bars))} so far`}>
      <span className={styles.recDot} aria-hidden="true" />
      <span className={styles.recText} aria-hidden="true">
        Recording…
      </span>
    </div>
  );
}

export interface PartRowProps {
  row: RowView;
  anySolo: boolean;
  /** Which of this header's keys holds the column's Tab stop (null: another row's). */
  tab: HeadCol | null;
  onFocusKey(row: number, col: HeadCol): void;
}

export const PartRow = memo(function PartRow({ row, anySolo, tab, onFocusKey }: PartRowProps) {
  const regions = useRowRegions(row.id);
  const { clips, songClips } = useRowClips(row.id);
  const kind = useRowKind(row.id);
  const status = partStatus(row, anySolo);
  return (
    <div
      className={styles.row}
      style={{ '--h': row.hue } as CSSProperties}
      data-lane-row={row.id}
      data-row-index={row.index}
      data-quiet={status === 'Muted' || status === 'Not soloed' || undefined}
    >
      <PartHeader row={row} anySolo={anySolo} tab={tab} onFocusKey={onFocusKey} />
      <div className={styles.lane} data-lane={row.id} data-space-plays="" role="group" aria-label={`${row.name}${status ? ` (${status.toLowerCase()})` : ''}: ${regions.length === 1 ? '1 loop' : `${regions.length} loops`}`}>
        {regions.map((r) => (
          <RegionView key={r.id} region={r} clip={clipById({ clips: clips as (Clip | null)[], songClips: songClips as Clip[] | undefined }, r.clipId)} partName={row.name} kind={kind} />
        ))}
        <RecordingRegion trackId={row.id} />
      </div>
    </div>
  );
});

/** Arrow keys between the headers' Mute, Solo and ⋯ keys (↑ ↓ rows, ← → keys); returns true when it moved. */
export function partKeysNav(e: KeyboardEvent<HTMLElement>, rows: number, move: (row: number, col: HeadCol) => void): boolean {
  const t = e.target as HTMLElement;
  const row = Number(t.dataset.row);
  const col = Number(t.dataset.col) as HeadCol;
  if (!t.closest('[data-col]') || !Number.isFinite(row) || e.altKey || e.ctrlKey || e.metaKey) return false;
  let next: [number, HeadCol] | null = null;
  if (e.key === 'ArrowDown') next = [Math.min(rows - 1, row + 1), col];
  else if (e.key === 'ArrowUp') next = [Math.max(0, row - 1), col];
  else if (e.key === 'ArrowRight') next = [row, Math.min(HEAD_COLS - 1, col + 1) as HeadCol];
  else if (e.key === 'ArrowLeft') next = [row, Math.max(0, col - 1) as HeadCol];
  if (!next) return false;
  e.preventDefault();
  e.stopPropagation();
  move(next[0], next[1]);
  return true;
}
