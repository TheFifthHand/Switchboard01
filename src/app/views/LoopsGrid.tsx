/**
 * Loops mode: eight part columns x four clip rows. A pad starts or stops a
 * clip for its part (at the next bar); the side buttons launch a whole row
 * as a scene. State is shown with light AND text: Empty, Ready, Next bar
 * (queued), Playing, Stopping, Recording.
 *
 * Management: part headers, clip pads and scene buttons each have a menu
 * (the '⋯' key, right-click, the menu key / Shift+F10, or F2 to rename).
 * On a focused pad: Delete removes the clip (with Undo), Ctrl+C / Ctrl+V
 * copy and paste clips (also into empty slots).
 */
import { memo, useCallback, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { IconButton, Meter, Pad, Tooltip, type PadState } from '../../ui/components';
import { SCENE_ROWS, type Clip, type Id, type Project, type Scene } from '../../project/types';
import { selectSlot, selectTrack, slotFor } from '../../state/uiStore';
import { setSolo } from '../../state/commands';
import { session, useProject, useUi } from '../instance';
import { useRuntime, type TrackRuntime } from '../runtime';
import { barsLabel, soundName } from '../labels';
import { readMeterFrame } from './TransportBar';
import {
  ClipMenu,
  MOD_KEY,
  MoreIcon,
  anchorFromContextEvent,
  anchorFromElement,
  clipActions,
  isEchoOfKeyboardMenu,
  isMenuKey,
  noteKeyboardMenu,
  type MenuAnchor,
} from './ClipMenu';
import { TrackMenu } from './TrackMenu';
import { SceneMenu } from './SceneMenu';
import { SoundBrowser } from './SoundBrowser';
import styles from './LoopsGrid.module.css';

interface ColumnSummary {
  id: Id;
  name: string;
  sound: string;
  mute: boolean;
  solo: boolean;
  clips: readonly (Clip | null)[];
}

function summarize(p: Project): ColumnSummary[] {
  return p.tracks.map((t) => ({ id: t.id, name: t.name, sound: soundName(p, t.instrument), mute: t.mute, solo: t.solo, clips: t.clips }));
}

function sameColumns(a: ColumnSummary[], b: ColumnSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.name !== y.name || x.sound !== y.sound || x.mute !== y.mute || x.solo !== y.solo || x.clips !== y.clips) return false;
  }
  return true;
}

function padState(clip: Clip | null, slot: number, rt: TrackRuntime | undefined, playing: boolean, recording: boolean): { state: PadState; caption?: string } {
  if (!clip) return { state: 'empty' };
  if (recording) return { state: 'recording' };
  const playingSlot = rt?.playingSlot ?? null;
  const queued = rt?.queued ?? null;
  if (!playing) return playingSlot === slot ? { state: 'queued', caption: 'Plays on ▶' } : { state: 'ready' };
  if (playingSlot === slot) {
    if (queued && queued.slot !== slot) return { state: 'stopping', caption: queued.slot === null ? 'Stops next bar' : 'Ends next bar' };
    return { state: 'playing' };
  }
  if (queued && queued.slot === slot) return { state: 'queued' };
  return { state: 'ready' };
}

/* ------------------------------------------------------------------ */
/* Menus                                                               */
/* ------------------------------------------------------------------ */

interface MenuBase {
  anchor: MenuAnchor;
  /** Focus returns here when the menu closes. */
  returnFocus: HTMLElement | null;
  /** The trigger: pressing it again toggles instead of counting as an outside press. */
  ignore?: Element | null;
  /** Open straight into the rename field. */
  rename?: boolean;
}
type MenuRequest = MenuBase & ({ kind: 'clip'; trackId: Id; slot: number } | { kind: 'track'; trackId: Id } | { kind: 'scene'; row: number });
type OpenMenu = (req: MenuRequest | null) => void;

function onContextMenuOpen(e: ReactMouseEvent<HTMLElement>, open: (anchor: MenuAnchor) => void) {
  e.preventDefault();
  if (isEchoOfKeyboardMenu(e.target)) return;
  open(anchorFromContextEvent(e, e.currentTarget));
}

/* ------------------------------------------------------------------ */
/* Pads, headers, scenes                                               */
/* ------------------------------------------------------------------ */

const ClipPad = memo(function ClipPad(props: { trackId: Id; trackName: string; slot: number; clip: Clip | null; sceneName: string; onMenu: OpenMenu; menuOpen: boolean }) {
  const { trackId, trackName, slot, clip, sceneName, onMenu, menuOpen } = props;
  const rt = useRuntime((s) => s.tracks[trackId]);
  const playing = useRuntime((s) => s.playing);
  const recording = useRuntime((s) => s.recording === 'notes' && s.recordTarget?.trackId === trackId && s.recordTarget.slot === slot);
  const selected = useUi((s) => s.selectedTrackId === trackId && slotFor(s, trackId) === slot);
  const { state, caption } = padState(clip, slot, rt, playing, recording);
  const onPress = useCallback(() => {
    selectTrack(trackId);
    selectSlot(trackId, slot);
    if (clip) void session.pressClip(trackId, slot);
  }, [trackId, slot, clip]);
  const open = (anchor: MenuAnchor, returnFocus: HTMLElement | null, ignore?: Element | null) => {
    selectTrack(trackId);
    selectSlot(trackId, slot);
    onMenu({ kind: 'clip', trackId, slot, anchor, returnFocus, ignore });
  };
  const padId = `pad-${trackId}-${slot}`;
  const stateWord = caption ?? { empty: 'Empty', ready: 'Ready', queued: 'Starts next bar', playing: 'Playing', recording: 'Recording', stopping: 'Stopping' }[state];
  const what = clip ? `clip ${clip.name}` : 'empty slot';
  return (
    <div className={styles.cell} onContextMenu={(e) => onContextMenuOpen(e, (a) => open(a, document.getElementById(padId)))}>
      <Pad
        state={state}
        selected={selected}
        label={clip ? clip.name : 'Empty'}
        sublabel={clip ? barsLabel(clip.bars) : undefined}
        caption={caption}
        onPress={onPress}
        ariaLabel={`${trackName}, ${sceneName}: ${clip ? clip.name : 'empty slot'}. ${stateWord}.`}
        id={padId}
      />
      {selected && (
        <Tooltip name={clip ? 'Clip options' : 'New clip or paste'} tip={clip ? 'Rename, length, duplicate, copy, paste, clear or delete this clip.' : 'Make a new clip here, or paste a copied one.'} detail={`Right-click any pad for the same menu. Keys on a pad: Delete, ${MOD_KEY}C, ${MOD_KEY}V, F2.`}>
          <button
            type="button"
            className={styles.more}
            aria-label={`Options for ${what} (${trackName}, ${sceneName})`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => (menuOpen ? onMenu(null) : open(anchorFromElement(e.currentTarget), e.currentTarget, e.currentTarget))}
          >
            <MoreIcon />
          </button>
        </Tooltip>
      )}
    </div>
  );
});

function TrackHeader(props: { col: ColumnSummary; index: number; onMenu: OpenMenu; menuOpen: boolean }) {
  const { col, index, onMenu, menuOpen } = props;
  const selected = useUi((s) => s.selectedTrackId === col.id);
  const anySolo = useProject((p) => p.tracks.some((t) => t.solo));
  const headerRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLButtonElement>(null);
  const audible = !col.mute && (!anySolo || col.solo);
  const open = (anchor: MenuAnchor, returnFocus: HTMLElement | null, extra: Partial<MenuBase> = {}) => {
    selectTrack(col.id);
    onMenu({ kind: 'track', trackId: col.id, anchor, returnFocus, ...extra });
  };
  const onMainKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (isMenuKey(e)) {
      e.preventDefault();
      noteKeyboardMenu(e.currentTarget);
      open(anchorFromElement(headerRef.current), e.currentTarget);
    } else if (e.key === 'F2') {
      e.preventDefault();
      open(anchorFromElement(headerRef.current), e.currentTarget, { rename: true });
    }
  };
  return (
    <div ref={headerRef} className={`${styles.header} ${selected ? styles.headerSelected : ''}`} onContextMenu={(e) => onContextMenuOpen(e, (a) => open(a, mainRef.current))}>
      <button
        ref={mainRef}
        type="button"
        className={styles.headerMain}
        onClick={() => selectTrack(col.id)}
        onKeyDown={onMainKey}
        aria-pressed={selected}
        aria-label={`Select ${col.name} (${col.sound})`}
        aria-keyshortcuts="F2 Shift+F10"
      >
        <span className={`${styles.trackNum} mono`}>{index + 1}</span>
        <span className={styles.trackName}>{col.name}</span>
        <span className={styles.trackSound}>{col.sound}</span>
      </button>
      <div className={styles.headerTools}>
        <Tooltip tip={col.mute ? 'Unmute this part.' : 'Silence this part (it keeps playing in time).'}>
          <button type="button" className={`${styles.ms} ${col.mute ? styles.msMute : ''}`} aria-pressed={col.mute} aria-label={`Mute ${col.name}`} onClick={() => session.setMute(col.id, !col.mute)}>
            M
          </button>
        </Tooltip>
        <Tooltip tip={col.solo ? 'Stop soloing.' : 'Hear only soloed parts.'}>
          <button type="button" className={`${styles.ms} ${col.solo ? styles.msSolo : ''}`} aria-pressed={col.solo} aria-label={`Solo ${col.name}`} onClick={() => session.accepted(setSolo(session.store, col.id, !col.solo))}>
            S
          </button>
        </Tooltip>
        <span className={styles.toolSpacer} />
        <Tooltip name="Part options" tip="Rename this part, change its sound, or lock it against Variation." detail="Right-click the header, or press F2 to rename.">
          <button
            type="button"
            className={styles.headerMore}
            aria-label={`Options for part ${col.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => (menuOpen ? onMenu(null) : open(anchorFromElement(e.currentTarget), e.currentTarget, { ignore: e.currentTarget }))}
          >
            <MoreIcon />
          </button>
        </Tooltip>
      </div>
      <div className={`${styles.meter} ${audible ? '' : styles.meterOff}`}>
        <Meter read={() => readMeterFrame().tracks.find((t) => t.trackId === col.id)?.peak ?? 0} label={`${col.name} level`} orientation="horizontal" length="100%" thickness={4} segments={12} />
      </div>
    </div>
  );
}

function SceneButton(props: { row: number; scene: Scene; columns: ColumnSummary[]; onMenu: OpenMenu; menuOpen: boolean }) {
  const { row, scene, columns, onMenu, menuOpen } = props;
  const btnRef = useRef<HTMLButtonElement>(null);
  const cellRef = useRef<HTMLDivElement>(null);
  const lit = useRuntime((s) => {
    if (!s.playing) return false;
    let any = false;
    for (const c of columns) {
      const has = !!c.clips[row];
      const rt = s.tracks[c.id];
      const on = rt?.playingSlot === row;
      if (has && !on) return false;
      if (!has && rt?.playingSlot != null) return false;
      if (on) any = true;
    }
    return any;
  });
  const count = columns.filter((c) => c.clips[row]).length;
  const open = (anchor: MenuAnchor, returnFocus: HTMLElement | null, extra: Partial<MenuBase> = {}) => onMenu({ kind: 'scene', row, anchor, returnFocus, ...extra });
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (isMenuKey(e)) {
      e.preventDefault();
      noteKeyboardMenu(e.currentTarget);
      open(anchorFromElement(cellRef.current), e.currentTarget);
    } else if (e.key === 'F2') {
      e.preventDefault();
      open(anchorFromElement(cellRef.current), e.currentTarget, { rename: true });
    }
  };
  return (
    <div ref={cellRef} className={styles.sceneCell} onContextMenu={(e) => onContextMenuOpen(e, (a) => open(a, btnRef.current))}>
      <Tooltip tip={`Play the ${scene.name} scene: ${count} part${count === 1 ? '' : 's'} with clips in this row start, the others stop.`} detail="Scenes switch on the next bar. Right-click or F2 to rename.">
        <button
          ref={btnRef}
          type="button"
          className={`${styles.scene} ${lit ? styles.sceneLit : ''}`}
          onClick={() => void session.launchScene(row)}
          onKeyDown={onKey}
          aria-label={`Launch scene ${scene.name}${lit ? ' (playing)' : ''}`}
          aria-keyshortcuts="F2 Shift+F10"
        >
          <span className={styles.sceneIcon} aria-hidden>
            ▶
          </span>
          <span className={styles.sceneName}>{scene.name}</span>
          <span className={`${styles.sceneCount} mono`}>{count}/8</span>
        </button>
      </Tooltip>
      <Tooltip name="Scene options" tip="Rename this scene, add it to the song or export it.">
        <button
          type="button"
          className={styles.sceneMore}
          aria-label={`Options for scene ${scene.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => (menuOpen ? onMenu(null) : open(anchorFromElement(e.currentTarget), e.currentTarget, { ignore: e.currentTarget }))}
        >
          <MoreIcon size={13} />
        </button>
      </Tooltip>
    </div>
  );
}

function StopButton(props: { trackId: Id; name: string }) {
  const active = useRuntime((s) => s.tracks[props.trackId]?.playingSlot != null);
  return (
    <IconButton icon="stop" label={`Stop ${props.name} at the next bar`} size="sm" variant="ghost" disabled={!active} onClick={() => session.stopTrack(props.trackId)} className={styles.stop} />
  );
}

export function LoopsGrid() {
  const columns = useProject(summarize, sameColumns);
  const scenes = useProject((p) => p.scenes);
  const gridRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<(MenuRequest & { seq: number }) | null>(null);
  const [soundFor, setSoundFor] = useState<Id | null>(null);
  const seq = useRef(0);
  const openMenu = useCallback<OpenMenu>((req) => {
    seq.current += 1;
    setMenu(req ? { ...req, seq: seq.current } : null);
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  /** Pad keys: arrows move focus (roving); menu key, F2, Delete, Ctrl+C / Ctrl+V act on the focused pad. */
  const onGridKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const el = e.target as HTMLElement;
      const m = /^pad-(t\d+)-(\d)$/.exec(el.id);
      if (!m) return;
      const trackId = m[1];
      const row = Number(m[2]);
      const mod = e.ctrlKey || e.metaKey;
      const select = () => {
        selectTrack(trackId);
        selectSlot(trackId, row);
      };
      if (isMenuKey(e)) {
        e.preventDefault();
        noteKeyboardMenu(el);
        select();
        openMenu({ kind: 'clip', trackId, slot: row, anchor: anchorFromElement(el), returnFocus: el });
        return;
      }
      if (e.key === 'F2' && !mod) {
        e.preventDefault();
        select();
        const hasClip = !!session.store.getState().tracks.find((t) => t.id === trackId)?.clips[row];
        openMenu({ kind: 'clip', trackId, slot: row, anchor: anchorFromElement(el), returnFocus: el, rename: hasClip });
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && !e.altKey) {
        e.preventDefault();
        select();
        clipActions.remove(trackId, row);
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        select();
        clipActions.copy(trackId, row);
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        clipActions.paste(trackId, row);
        return;
      }
      const col = Number(trackId.slice(1)) - 1;
      let c = col;
      let r = row;
      if (e.key === 'ArrowRight') c = Math.min(7, col + 1);
      else if (e.key === 'ArrowLeft') c = Math.max(0, col - 1);
      else if (e.key === 'ArrowDown') r = Math.min(SCENE_ROWS - 1, row + 1);
      else if (e.key === 'ArrowUp') r = Math.max(0, row - 1);
      else return;
      e.preventDefault();
      document.getElementById(`pad-t${c + 1}-${r}`)?.focus();
    },
    [openMenu],
  );

  return (
    <div className={styles.wrap}>
      <div className={styles.grid} ref={gridRef} onKeyDown={onGridKey} role="group" aria-label="Clip pads: eight parts by four scenes">
        {columns.map((c, i) => (
          <TrackHeader key={c.id} col={c} index={i} onMenu={openMenu} menuOpen={menu?.kind === 'track' && menu.trackId === c.id} />
        ))}
        <div className={styles.sceneHeader}>SCENES</div>
        {scenes.slice(0, SCENE_ROWS).map((scene, row) => (
          <div key={scene.id} className={styles.row}>
            {columns.map((c) => (
              <ClipPad
                key={c.id}
                trackId={c.id}
                trackName={c.name}
                slot={row}
                clip={c.clips[row]}
                sceneName={scene.name}
                onMenu={openMenu}
                menuOpen={menu?.kind === 'clip' && menu.trackId === c.id && menu.slot === row}
              />
            ))}
            <SceneButton row={row} scene={scene} columns={columns} onMenu={openMenu} menuOpen={menu?.kind === 'scene' && menu.row === row} />
          </div>
        ))}
        {columns.map((c) => (
          <StopButton key={c.id} trackId={c.id} name={c.name} />
        ))}
        <button type="button" className={styles.stopAll} onClick={() => session.stopAllClips()} aria-label="Stop all parts at the next bar">
          ■ Stop all
        </button>
      </div>

      {menu?.kind === 'clip' && (
        <ClipMenu key={menu.seq} trackId={menu.trackId} slot={menu.slot} anchor={menu.anchor} returnFocus={menu.returnFocus} ignore={menu.ignore} startInRename={menu.rename} onClose={closeMenu} />
      )}
      {menu?.kind === 'track' && (
        <TrackMenu
          key={menu.seq}
          trackId={menu.trackId}
          anchor={menu.anchor}
          returnFocus={menu.returnFocus}
          ignore={menu.ignore}
          startInRename={menu.rename}
          onClose={closeMenu}
          onChangeSound={(id) => setSoundFor(id)}
        />
      )}
      {menu?.kind === 'scene' && <SceneMenu key={menu.seq} row={menu.row} anchor={menu.anchor} returnFocus={menu.returnFocus} ignore={menu.ignore} startInRename={menu.rename} onClose={closeMenu} />}
      <SoundBrowser open={soundFor !== null} trackId={soundFor ?? ''} onClose={() => setSoundFor(null)} />
    </div>
  );
}
