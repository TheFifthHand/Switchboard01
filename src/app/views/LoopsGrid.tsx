/**
 * Loops mode: eight part columns x four clip rows. A pad starts or stops a
 * clip for its part (at the next bar); the side buttons launch a whole row
 * as a scene. State is shown with light AND text: Ready, Next bar (queued),
 * Playing, Stopping, Paused, Rec; an empty pad is a quiet "+" (Add clip).
 *
 * Each column header has the part's name and sound, a play/stop key for the
 * part, labelled Mute and Solo toggles and a level meter; a muted part's
 * column dims and says Muted, and with any solo on the others say Not soloed.
 * M and S (with a pad or part focused; M anywhere) mute and solo the selected
 * part.
 *
 * Moving things: drag a clip pad onto another pad to move it (onto a clip:
 * the two swap); hold Ctrl or Alt while dropping to copy (onto a clip: it is
 * replaced). A press that moves less than 6 px is a tap and launches. Esc
 * cancels a drag. Drum and melodic parts do not swap clips (the drop is
 * refused and says why). Keyboard: the pad's Move… action, then arrow keys,
 * Enter (Ctrl+Enter copies), Esc. Scene rows reorder by dragging the scene
 * button, or Alt+Up / Alt+Down on it; the clips of every part move with them.
 *
 * The selected pad's actions are in the bar under the grid (Edit steps ·
 * Duplicate · Move… · Rename · Delete); right-click, the menu key, Shift+F10
 * or "." open them as a menu at the pad without playing it (the pad's tooltip
 * and description say so), and the '⋯' key in the selected pad's top-right
 * corner too. On a focused pad: Delete removes the clip (with Undo), Ctrl+C /
 * Ctrl+V copy and paste clips, F2 renames.
 */
import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, DRUM_KEYS, Icon, IconButton, Meter, NOTE_KEYS, OCTAVE_KEYS, Pad, Tooltip, type PadState } from '../../ui/components';
import { TAP_SLOP_PX } from '../../ui/components/Pad';
import { SCENE_ROWS, type Clip, type Id, type Project, type Scene } from '../../project/types';
import { clipDropProblem } from '../../state/commands';
import { selectSlot, selectTrack, slotFor } from '../../state/uiStore';
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
  drums: boolean;
  clips: readonly (Clip | null)[];
}

function summarize(p: Project): ColumnSummary[] {
  return p.tracks.map((t) => ({ id: t.id, name: t.name, sound: soundName(p, t.instrument), mute: t.mute, solo: t.solo, drums: t.instrument.kind === 'drums', clips: t.clips }));
}

function sameColumns(a: ColumnSummary[], b: ColumnSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.name !== y.name || x.sound !== y.sound || x.mute !== y.mute || x.solo !== y.solo || x.drums !== y.drums || x.clips !== y.clips) return false;
  }
  return true;
}

type Transport = 'playing' | 'paused' | 'stopped';

function padState(clip: Clip | null, slot: number, rt: TrackRuntime | undefined, transport: Transport, recording: boolean): { state: PadState; caption?: string; paused?: boolean } {
  if (!clip) return { state: 'empty' };
  if (recording) return { state: 'recording' };
  const playingSlot = rt?.playingSlot ?? null;
  const queued = rt?.queued ?? null;
  if (transport === 'stopped') return playingSlot === slot ? { state: 'queued', caption: 'Plays on ▶' } : { state: 'ready' };
  if (playingSlot === slot) {
    if (queued && queued.slot !== slot) return { state: 'stopping', caption: queued.slot === null ? 'Stops next bar' : 'Ends next bar' };
    if (transport === 'paused') return { state: 'queued', caption: 'Paused', paused: true };
    return { state: 'playing' };
  }
  if (queued && queued.slot === slot) return { state: 'queued' };
  return { state: 'ready' };
}

/** What a clip pad does when tapped, and how to reach its actions without playing it (its tooltip and description). */
const PAD_TIP = 'Tap to start this clip, in time with the others; tap it again to stop it.';
const EMPTY_PAD_TIP = 'Tap to add a clip here: a new one, or paste a copied clip.';
const PAD_ACTIONS_HINT = 'Right-click or Shift+F10 for actions without playing it (on a focused pad the . key works too). Drag it onto another pad to move it.';
/** Keys on a focused pad (see onGridKey). */
const PAD_SHORTCUTS = 'Shift+F10 ContextMenu . F2';
const CLIP_PAD_SHORTCUTS = `${PAD_SHORTCUTS} Delete`;

/** "." opens a focused pad's actions, unless that physical key plays notes or drum pads on this keyboard layout. */
const PLAYED_KEY_CODES: ReadonlySet<string> = new Set([...NOTE_KEYS, ...DRUM_KEYS, OCTAVE_KEYS.down, OCTAVE_KEYS.up].map((k) => k.code));
function isActionsKey(e: KeyboardEvent<HTMLElement>): boolean {
  if (isMenuKey(e)) return true;
  return e.key === '.' && !e.ctrlKey && !e.metaKey && !e.altKey && !PLAYED_KEY_CODES.has(e.code);
}

const STATE_SPOKEN: Record<PadState, string> = { empty: 'Empty', ready: 'Ready', queued: 'Starts next bar', playing: 'Playing', recording: 'Recording', stopping: 'Stopping' };

/* ------------------------------------------------------------------ */
/* Moving clips: drag and keyboard                                     */
/* ------------------------------------------------------------------ */

interface PadRef {
  trackId: Id;
  slot: number;
}

/** A clip being moved: by pointer (`over` is the pad under it) or by keyboard (the focused pad is the target). */
interface MoveState {
  from: PadRef;
  clipName: string;
  how: 'drag' | 'keys';
  over: PadRef | null;
  copy: boolean;
}

const padId = (trackId: Id, slot: number) => `pad-${trackId}-${slot}`;

function padAt(x: number, y: number): PadRef | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-pad-cell]');
  if (!el) return null;
  return { trackId: el.dataset.track!, slot: Number(el.dataset.slot) };
}

/** 'self' | 'ok' | why it cannot go there. */
function dropVerdict(move: MoveState, to: PadRef): 'self' | 'ok' | 'no' {
  if (to.trackId === move.from.trackId && to.slot === move.from.slot) return 'self';
  return clipDropProblem(session.store.getState(), move.from.trackId, to.trackId) ? 'no' : 'ok';
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
/* Pads                                                                */
/* ------------------------------------------------------------------ */

interface ClipPadProps {
  col: ColumnSummary;
  slot: number;
  sceneName: string;
  dimmed: boolean;
  onMenu: OpenMenu;
  menuOpen: boolean;
  move: MoveState | null;
  onPointerDownPad(e: ReactPointerEvent<HTMLElement>, from: PadRef): void;
  onDropHere(to: PadRef, copy: boolean): void;
}

const ClipPad = memo(function ClipPad(props: ClipPadProps) {
  const { col, slot, sceneName, dimmed, onMenu, menuOpen, move, onPointerDownPad, onDropHere } = props;
  const trackId = col.id;
  const clip = col.clips[slot];
  const rt = useRuntime((s) => s.tracks[trackId]);
  const transport = useRuntime((s): Transport => (s.playing ? 'playing' : s.paused ? 'paused' : 'stopped'));
  const recording = useRuntime((s) => s.recording === 'notes' && s.recordTarget?.trackId === trackId && s.recordTarget.slot === slot);
  const selected = useUi((s) => s.selectedTrackId === trackId && slotFor(s, trackId) === slot);
  const { state, caption, paused } = padState(clip, slot, rt, transport, recording);
  const id = padId(trackId, slot);
  const onPress = () => {
    if (move) {
      // Choosing where a clip goes (keyboard Move… then a click): drop it here.
      onDropHere({ trackId, slot }, move.copy);
      return;
    }
    selectTrack(trackId);
    selectSlot(trackId, slot);
    if (clip) void session.pressClip(trackId, slot);
    else {
      // "+" (Add clip): the new-clip choices (length, or paste) open at the pad.
      const el = document.getElementById(id);
      onMenu({ kind: 'clip', trackId, slot, anchor: anchorFromElement(el), returnFocus: el });
    }
  };
  const open = (anchor: MenuAnchor, returnFocus: HTMLElement | null, ignore?: Element | null) => {
    selectTrack(trackId);
    selectSlot(trackId, slot);
    onMenu({ kind: 'clip', trackId, slot, anchor, returnFocus, ignore });
  };
  let drop: 'source' | 'ok' | 'no' | undefined;
  if (move) {
    const v = dropVerdict(move, { trackId, slot });
    drop = v === 'self' ? 'source' : v;
  }
  const over = !!move?.over && move.over.trackId === trackId && move.over.slot === slot;
  const stateWord = caption ?? STATE_SPOKEN[state];
  const what = clip ? `clip ${clip.name}` : 'empty slot';
  const label = clip ? `${col.name}, ${sceneName}: ${clip.name}, ${barsLabel(clip.bars)}. ${stateWord}.${selected ? ' Selected.' : ''}` : `${col.name}, ${sceneName}: empty. Add clip.${selected ? ' Selected.' : ''}`;
  return (
    <div
      className={styles.cell}
      data-pad-cell=""
      data-track={trackId}
      data-slot={slot}
      data-drop={drop}
      data-over={over || undefined}
      data-copy={over && move?.copy ? true : undefined}
      data-dim={dimmed || undefined}
      onPointerDown={(e) => clip && onPointerDownPad(e, { trackId, slot })}
      onContextMenu={(e) => onContextMenuOpen(e, (a) => open(a, document.getElementById(id)))}
    >
      {/* Always wrapped (an empty pad has a tip too), so the pad never remounts and keeps focus when a clip lands on it. */}
      <Tooltip tip={clip ? PAD_TIP : EMPTY_PAD_TIP} hint={clip ? PAD_ACTIONS_HINT : undefined}>
        <Pad
          state={state}
          selected={selected}
          label={clip ? clip.name : 'Add clip'}
          sublabel={clip ? barsLabel(clip.bars) : undefined}
          caption={caption}
          captionIcon={paused ? 'pause' : undefined}
          activateOn="release"
          labelSize="lg"
          quietEmpty
          cornerKey={selected && !move}
          shortcuts={clip ? CLIP_PAD_SHORTCUTS : PAD_SHORTCUTS}
          onPress={onPress}
          ariaLabel={move && drop ? `${label} ${drop === 'source' ? 'Moving this clip.' : drop === 'ok' ? 'Press Enter to drop it here.' : 'It cannot go here.'}` : label}
          id={id}
        />
      </Tooltip>
      {drop === 'no' && over && (
        <span className={styles.dropNote} aria-hidden="true">
          Can’t go here
        </span>
      )}
      {selected && !move && (
        <Tooltip name={clip ? 'Clip options' : 'New clip or paste'} tip={clip ? 'Rename, length, duplicate, move, copy, paste, clear or delete this clip.' : 'Make a new clip here, or paste a copied one.'} detail={`Right-click any pad for the same menu (or Shift+F10, or . on a focused pad). Keys on a pad: Delete, ${MOD_KEY}C, ${MOD_KEY}V, F2.`}>
          <button
            type="button"
            className={styles.more}
            aria-label={`Options for ${what} (${col.name}, ${sceneName})`}
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

/* ------------------------------------------------------------------ */
/* Column headers                                                      */
/* ------------------------------------------------------------------ */

/**
 * The part's play/stop key: ▶ starts its selected clip at the next bar, ■
 * stops it at the next bar (or cancels a queued start). Stopped, ■ takes an
 * armed clip off the next Play.
 */
function PartPlayButton({ col }: { col: ColumnSummary }) {
  const transport = useRuntime((s): Transport => (s.playing ? 'playing' : s.paused ? 'paused' : 'stopped'));
  const rt = useRuntime((s) => s.tracks[col.id]);
  const selected = useUi((s) => slotFor(s, col.id));
  const playingSlot = rt?.playingSlot ?? null;
  const queued = rt?.queued ?? null;
  const target = col.clips[selected] ? selected : col.clips.findIndex((c) => !!c);
  const clip = target >= 0 ? col.clips[target] : null;
  if (playingSlot !== null || (queued && queued.slot !== null)) {
    const stopping = playingSlot !== null && queued !== null && queued.slot === null;
    const queuedOnly = playingSlot === null;
    const label =
      transport === 'stopped'
        ? `Don’t play ${col.name} on Play`
        : queuedOnly
          ? `Cancel the start of ${col.name}`
          : stopping
            ? `${col.name} stops at the next bar`
            : `Stop ${col.name} at the next bar`;
    return (
      <IconButton
        icon="stop"
        label={label}
        tip={
          transport === 'stopped'
            ? 'Its lit clip will not start when you press Play.'
            : queuedOnly
              ? `${col.name} is waiting to start at the next bar. This cancels only that start.`
              : 'Stops only this part; the others carry on.'
        }
        size="sm"
        variant="secondary"
        disabled={stopping}
        onClick={() => session.stopTrack(col.id)}
        className={styles.partPlay}
      />
    );
  }
  return (
    <IconButton
      icon="play"
      label={clip ? `Play ${col.name}: ${clip.name}` : `${col.name} has no clips`}
      tip={clip ? `Starts ${clip.name} at the next bar (the clip selected on this part).` : 'Add a clip first: press an empty pad.'}
      size="sm"
      variant="secondary"
      disabled={!clip}
      onClick={() => {
        if (!clip) return;
        selectTrack(col.id);
        void session.pressClip(col.id, target);
      }}
      className={styles.partPlay}
    />
  );
}

function TrackHeader(props: { col: ColumnSummary; index: number; anySolo: boolean; onMenu: OpenMenu; menuOpen: boolean }) {
  const { col, index, anySolo, onMenu, menuOpen } = props;
  const selected = useUi((s) => s.selectedTrackId === col.id);
  const headerRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLButtonElement>(null);
  const audible = !col.mute && (!anySolo || col.solo);
  const status = col.mute ? 'Muted' : anySolo && !col.solo ? 'Not soloed' : col.solo ? 'Solo' : null;
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
    <div
      ref={headerRef}
      className={`${styles.header} ${selected ? styles.headerSelected : ''}`}
      data-dim={!audible || undefined}
      data-muted={col.mute || undefined}
      onContextMenu={(e) => onContextMenuOpen(e, (a) => open(a, mainRef.current))}
    >
      <button
        ref={mainRef}
        type="button"
        className={styles.headerMain}
        onClick={() => selectTrack(col.id)}
        onKeyDown={onMainKey}
        aria-pressed={selected}
        aria-label={`Select ${col.name} (${col.sound})${status ? `, ${status}` : ''}`}
        aria-keyshortcuts="F2 Shift+F10"
      >
        <span className={`${styles.trackNum} mono`}>{index + 1}</span>
        <span className={styles.trackName}>{col.name}</span>
        <span className={styles.trackSound}>{col.sound}</span>
      </button>
      <div className={styles.toggles}>
        <Tooltip tip={col.mute ? `Unmute ${col.name}.` : `Silence ${col.name} (it keeps playing in time).`} detail="M mutes the selected part.">
          <button
            type="button"
            className={styles.toggle}
            data-kind="mute"
            aria-pressed={col.mute}
            aria-label={`Mute ${col.name}`}
            aria-keyshortcuts={selected ? 'M' : undefined}
            onClick={() => session.setMute(col.id, !col.mute)}
          >
            <Icon name="speaker" size={14} />
            <span>Mute</span>
          </button>
        </Tooltip>
        <Tooltip tip={col.solo ? `Stop soloing ${col.name}.` : `Hear only the soloed parts (${col.name} and any others you solo).`} detail="M mutes the selected part from the keyboard.">
          <button
            type="button"
            className={styles.toggle}
            data-kind="solo"
            aria-pressed={col.solo}
            aria-label={`Solo ${col.name}`}
            aria-keyshortcuts={selected ? 'S' : undefined}
            onClick={() => session.setSolo(col.id, !col.solo)}
          >
            <Icon name="headphones" size={14} />
            <span>Solo</span>
          </button>
        </Tooltip>
      </div>
      <div className={styles.headBottom}>
        <PartPlayButton col={col} />
        {status ? (
          <span className={styles.status} data-status={status === 'Solo' ? 'solo' : status === 'Muted' ? 'muted' : 'quiet'}>
            {status}
          </span>
        ) : (
          <div className={styles.meter}>
            <Meter read={() => readMeterFrame().tracks.find((t) => t.trackId === col.id)?.peak ?? 0} label={`${col.name} level`} orientation="horizontal" length="100%" thickness={6} segments={10} />
          </div>
        )}
        <Tooltip name="Part options" tip="Rename this part, change its instrument, or lock it against Variation." detail="Right-click the header, or press F2 to rename.">
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
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scenes                                                              */
/* ------------------------------------------------------------------ */

interface SceneDrag {
  from: number;
  over: number | null;
}

function SceneButton(props: {
  row: number;
  scene: Scene;
  columns: ColumnSummary[];
  onMenu: OpenMenu;
  menuOpen: boolean;
  drag: SceneDrag | null;
  onPointerDownScene(e: ReactPointerEvent<HTMLButtonElement>, row: number): void;
  consumeClick(): boolean;
}) {
  const { row, scene, columns, onMenu, menuOpen, drag, onPointerDownScene, consumeClick } = props;
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
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const to = row + (e.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= SCENE_ROWS) return;
      if (session.moveScene(row, to)) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-scene-row="${to}"] button[data-scene]`)?.focus());
    }
  };
  const dragging = drag?.from === row;
  const over = drag !== null && drag.over === row && drag.from !== row;
  return (
    <div ref={cellRef} className={styles.sceneCell} data-scene-row={row} data-drag={dragging || undefined} data-over={over || undefined} onContextMenu={(e) => onContextMenuOpen(e, (a) => open(a, btnRef.current))}>
      <Tooltip
        tip={`Play the ${scene.name} scene: ${count} part${count === 1 ? '' : 's'} with clips in this row start, the others stop.`}
        detail="Scenes switch on the next bar. Drag the scene (or Alt+Up / Alt+Down) to reorder the rows; the clips move with it. Right-click or F2 to rename."
      >
        <button
          ref={btnRef}
          type="button"
          data-scene=""
          className={`${styles.scene} ${lit ? styles.sceneLit : ''}`}
          onPointerDown={(e) => onPointerDownScene(e, row)}
          onClick={() => {
            if (consumeClick()) return;
            void session.launchScene(row);
          }}
          onKeyDown={onKey}
          aria-label={`Launch scene ${scene.name}${lit ? ' (playing)' : ''}`}
          aria-keyshortcuts="F2 Shift+F10 Alt+ArrowUp Alt+ArrowDown"
        >
          <span className={styles.sceneIcon} aria-hidden>
            <Icon name="play" size={12} />
          </span>
          <span className={styles.sceneName}>{scene.name}</span>
          <span className={`${styles.sceneCount} mono`}>{count}/8</span>
        </button>
      </Tooltip>
      <Tooltip name="Scene options" tip="Rename, move, add to the song or export this scene.">
        <button
          type="button"
          className={styles.sceneMore}
          aria-label={`Options for scene ${scene.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => (menuOpen ? onMenu(null) : open(anchorFromElement(e.currentTarget), e.currentTarget, { ignore: e.currentTarget }))}
        >
          <MoreIcon size={14} />
        </button>
      </Tooltip>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Selected pad actions                                                */
/* ------------------------------------------------------------------ */

function PadActions(props: { move: MoveState | null; onMove(from: PadRef): void; onCancelMove(): void; onRename(at: PadRef): void }) {
  const { move, onMove, onCancelMove, onRename } = props;
  const trackId = useUi((s) => s.selectedTrackId);
  const slot = useUi((s) => slotFor(s, s.selectedTrackId));
  const info = useProject(
    (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      const clip = t?.clips[slot] ?? null;
      return t ? { part: t.name, scene: p.scenes[slot]?.name ?? `Row ${slot + 1}`, name: clip?.name ?? null, bars: clip?.bars ?? 0, full: t.clips.every((c) => !!c) } : null;
    },
    (a, b) => a === b || (!!a && !!b && a.part === b.part && a.scene === b.scene && a.name === b.name && a.bars === b.bars && a.full === b.full),
  );
  if (move) {
    return (
      <div className={styles.actions} role="region" aria-label="Moving a clip" data-moving="">
        <p className={styles.actionsText} aria-live="polite">
          <Icon name="drag" size={14} />
          {move.how === 'keys'
            ? `Moving “${move.clipName}”: arrow keys choose a pad, Enter moves it there (${MOD_KEY}Enter copies), Esc cancels.`
            : `Drop “${move.clipName}” on a pad to ${move.copy ? 'copy' : 'move'} it (hold ${MOD_KEY.replace('+', '')} or Alt to copy). Esc cancels.`}
        </p>
        {move.how === 'keys' && (
          <Button size="sm" variant="secondary" icon="close" onClick={onCancelMove}>
            Cancel
          </Button>
        )}
      </div>
    );
  }
  if (!info) return null;
  if (info.name === null) {
    return (
      <div className={styles.actions} role="region" aria-label="Selected pad">
        <p className={styles.actionsText}>
          <span className={styles.actionsWhat}>{`${info.part} · ${info.scene}`}</span> empty pad: tap it to add a clip.
        </p>
        <Button size="sm" variant="secondary" icon="plus" onClick={() => clipActions.create(trackId, slot, 1)}>
          New clip
        </Button>
      </div>
    );
  }
  const at = { trackId, slot };
  return (
    <div className={styles.actions} role="group" aria-label={`Selected clip ${info.name}`} data-pad-actions="">
      <p className={styles.actionsText}>
        <span className={styles.actionsWhat}>{info.name}</span>
        <span className={styles.actionsWhere}>
          {info.part} · {info.scene} · {barsLabel(info.bars)}
        </span>
      </p>
      <div className={styles.actionKeys}>
        <Button size="sm" variant="secondary" onClick={() => clipActions.editSteps(trackId, slot)} tip="Edit this clip’s steps or notes.">
          Edit steps
        </Button>
        <Button size="sm" variant="secondary" icon="duplicate" disabled={info.full} onClick={() => clipActions.duplicate(trackId, slot)} tip={info.full ? `${info.part} has no empty pad left.` : 'Copy this clip into the next empty pad of the part.'}>
          Duplicate
        </Button>
        <Button size="sm" variant="secondary" icon="drag" onClick={() => onMove(at)} tip="Move this clip to another pad with the arrow keys and Enter. You can also drag it.">
          Move…
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onRename(at)} tip="Rename this clip (F2 on the pad).">
          Rename
        </Button>
        <Button size="sm" variant="danger" icon="trash" onClick={() => clipActions.remove(trackId, slot)} tip="Delete this clip. Undo brings it back.">
          Delete
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Grid                                                                */
/* ------------------------------------------------------------------ */

export function LoopsGrid() {
  const columns = useProject(summarize, sameColumns);
  const scenes = useProject((p) => p.scenes);
  const anySolo = columns.some((c) => c.solo);
  const gridRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<(MenuRequest & { seq: number }) | null>(null);
  const [soundFor, setSoundFor] = useState<Id | null>(null);
  const [move, setMove] = useState<MoveState | null>(null);
  const moveRef = useRef<MoveState | null>(null);
  moveRef.current = move;
  const [sceneDrag, setSceneDrag] = useState<SceneDrag | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const suppressSceneClick = useRef(false);
  const seq = useRef(0);
  const openMenu = useCallback<OpenMenu>((req) => {
    seq.current += 1;
    setMenu(req ? { ...req, seq: seq.current } : null);
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const clipName = (at: PadRef) => session.store.getState().tracks.find((t) => t.id === at.trackId)?.clips[at.slot]?.name ?? '';

  /**
   * Drop the clip being moved (`from`, else the keyboard move's source) onto
   * `to`: move, or copy. One undo step; a refused drop says why.
   */
  const dropOn = useCallback((to: PadRef, copy: boolean, from?: PadRef) => {
    const src = from ?? moveRef.current?.from;
    setMove(null);
    if (!src) return;
    if (to.trackId === src.trackId && to.slot === src.slot) {
      document.getElementById(padId(to.trackId, to.slot))?.focus();
      return;
    }
    session.moveClip(src, to, copy);
    requestAnimationFrame(() => document.getElementById(padId(to.trackId, to.slot))?.focus());
  }, []);

  const startKeyMove = useCallback((from: PadRef) => {
    setMenu(null);
    selectTrack(from.trackId);
    selectSlot(from.trackId, from.slot);
    setMove({ from, clipName: clipName(from), how: 'keys', over: from, copy: false });
    requestAnimationFrame(() => document.getElementById(padId(from.trackId, from.slot))?.focus());
  }, []);

  const cancelMove = useCallback(() => {
    const m = moveRef.current;
    setMove(null);
    if (m) document.getElementById(padId(m.from.trackId, m.from.slot))?.focus();
  }, []);

  /** Pointer drag of a clip pad: a drag starts after TAP_SLOP_PX (a shorter press is a tap that launches). */
  const onPointerDownPad = useCallback(
    (e: ReactPointerEvent<HTMLElement>, from: PadRef) => {
      if (e.button !== 0 || !e.isPrimary || moveRef.current) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;
      let dragging = false;
      const ghost = (x: number, y: number) => {
        const g = ghostRef.current;
        if (g) g.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 10)}px)`;
      };
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < TAP_SLOP_PX) return;
          dragging = true;
          setMenu(null);
          selectTrack(from.trackId);
          selectSlot(from.trackId, from.slot);
        }
        const over = padAt(ev.clientX, ev.clientY);
        const copy = ev.ctrlKey || ev.altKey || ev.metaKey;
        setMove((m) => {
          const next: MoveState = { from, clipName: m?.clipName ?? clipName(from), how: 'drag', over, copy };
          return m && m.how === 'drag' && m.copy === copy && m.over?.trackId === over?.trackId && m.over?.slot === over?.slot ? m : next;
        });
        ghost(ev.clientX, ev.clientY);
      };
      const end = (drop: boolean, ev?: PointerEvent) => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onCancel, true);
        window.removeEventListener('keydown', onKey, true);
        if (!dragging) return;
        const to = drop && ev ? padAt(ev.clientX, ev.clientY) : null;
        if (to && ev) dropOn(to, ev.ctrlKey || ev.altKey || ev.metaKey, from);
        else setMove(null);
      };
      const onUp = (ev: PointerEvent) => ev.pointerId === pointerId && end(true, ev);
      const onCancel = (ev: PointerEvent) => ev.pointerId === pointerId && end(false);
      const onKey = (ev: globalThis.KeyboardEvent) => {
        if (!dragging) return;
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          // Cancelled: the pad's pointerup that follows is no tap either (it moved).
          dragging = false;
          setMove(null);
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('keydown', onKey, true);
        } else if (ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Meta') {
          setMove((m) => (m ? { ...m, copy: true } : m));
        }
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onCancel, true);
      window.addEventListener('keydown', onKey, true);
    },
    [dropOn],
  );

  /** Scene rows: drag the scene button onto another row to reorder (a shorter press launches it). */
  const onPointerDownScene = useCallback((e: ReactPointerEvent<HTMLButtonElement>, row: number) => {
    if (e.button !== 0 || !e.isPrimary) return;
    const startY = e.clientY;
    const startX = e.clientX;
    const pointerId = e.pointerId;
    let dragging = false;
    let over: number | null = null;
    const target = e.currentTarget;
    const rowAt = (x: number, y: number): number | null => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-scene-row]');
      return el ? Number(el.dataset.sceneRow) : null;
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < TAP_SLOP_PX) return;
        dragging = true;
        try {
          target.setPointerCapture(pointerId);
        } catch {
          /* synthetic pointer */
        }
      }
      // Rows are matched by height only, so the pointer may wander sideways.
      const cell = document.querySelector<HTMLElement>(`[data-scene-row="0"]`);
      const x = cell ? cell.getBoundingClientRect().left + 4 : ev.clientX;
      over = rowAt(x, ev.clientY);
      setSceneDrag({ from: row, over });
    };
    const end = (drop: boolean) => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('keydown', onKey, true);
      if (!dragging) return;
      suppressSceneClick.current = true;
      setTimeout(() => (suppressSceneClick.current = false), 0);
      setSceneDrag(null);
      if (drop && over !== null && over !== row) {
        const to = over;
        if (session.moveScene(row, to)) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-scene-row="${to}"] button[data-scene]`)?.focus());
      }
    };
    const onUp = (ev: PointerEvent) => ev.pointerId === pointerId && end(true);
    const onCancel = (ev: PointerEvent) => ev.pointerId === pointerId && end(false);
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (!dragging || ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      over = null;
      end(false);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('keydown', onKey, true);
  }, []);
  const consumeSceneClick = useCallback(() => suppressSceneClick.current, []);

  // A keyboard move ends when the clip it moves goes away (undo, another part's edit) or focus leaves the grid for good.
  useEffect(() => {
    if (!move || move.how !== 'keys') return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t && (gridRef.current?.contains(t) || t.closest('[data-move-bar]'))) return;
      setMove(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [move]);
  useEffect(() => {
    if (move && !columns.find((c) => c.id === move.from.trackId)?.clips[move.from.slot]) setMove(null);
  }, [columns, move]);

  /** Keys while choosing where a clip goes: Enter / Space drop it (Ctrl copies), Esc cancels. */
  const onGridKeyCapture = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const m = moveRef.current;
      if (!m || m.how !== 'keys') return;
      const el = e.target as HTMLElement;
      const at = /^pad-(t\d+)-(\d)$/.exec(el.id);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelMove();
      } else if ((e.key === 'Enter' || e.key === ' ') && at) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) dropOn({ trackId: at[1], slot: Number(at[2]) }, e.ctrlKey || e.metaKey || e.altKey);
      }
    },
    [cancelMove, dropOn],
  );

  /** Pad keys: arrows move focus (roving); menu key, F2, Delete, Ctrl+C / Ctrl+V act on the focused pad. */
  const onGridKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const el = e.target as HTMLElement;
      const m = /^pad-(t\d+)-(\d)$/.exec(el.id);
      if (!m) return;
      const trackId = m[1];
      const row = Number(m[2]);
      const mod = e.ctrlKey || e.metaKey;
      const moving = moveRef.current?.how === 'keys';
      const select = () => {
        selectTrack(trackId);
        selectSlot(trackId, row);
      };
      if (!moving && isActionsKey(e)) {
        e.preventDefault();
        if (e.repeat) return;
        noteKeyboardMenu(el);
        select();
        openMenu({ kind: 'clip', trackId, slot: row, anchor: anchorFromElement(el), returnFocus: el });
        return;
      }
      if (!moving && e.key === 'F2' && !mod) {
        e.preventDefault();
        select();
        const hasClip = !!session.store.getState().tracks.find((t) => t.id === trackId)?.clips[row];
        openMenu({ kind: 'clip', trackId, slot: row, anchor: anchorFromElement(el), returnFocus: el, rename: hasClip });
        return;
      }
      if (!moving && (e.key === 'Delete' || e.key === 'Backspace') && !mod && !e.altKey) {
        e.preventDefault();
        select();
        clipActions.remove(trackId, row);
        return;
      }
      if (!moving && mod && !e.altKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        select();
        clipActions.copy(trackId, row);
        return;
      }
      if (!moving && mod && !e.altKey && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
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
      const next = { trackId: `t${c + 1}`, slot: r };
      if (moving) setMove((mv) => (mv ? { ...mv, over: next } : mv));
      document.getElementById(padId(next.trackId, next.slot))?.focus();
    },
    [openMenu],
  );

  const rename = useCallback(
    (at: PadRef) => {
      const el = document.getElementById(padId(at.trackId, at.slot));
      openMenu({ kind: 'clip', trackId: at.trackId, slot: at.slot, anchor: anchorFromElement(el), returnFocus: el, rename: true });
    },
    [openMenu],
  );

  return (
    <div className={styles.wrap}>
      <div
        className={styles.grid}
        ref={gridRef}
        onKeyDown={onGridKey}
        onKeyDownCapture={onGridKeyCapture}
        role="group"
        aria-label="Clip pads: eight parts by four scenes"
        data-moving={move ? move.how : undefined}
      >
        {columns.map((c, i) => (
          <TrackHeader key={c.id} col={c} index={i} anySolo={anySolo} onMenu={openMenu} menuOpen={menu?.kind === 'track' && menu.trackId === c.id} />
        ))}
        <div className={styles.sceneHeader}>
          <span className={styles.sceneHeaderText}>Scenes</span>
          <Tooltip tip="Stop every part at the next bar (the transport keeps running).">
            <button type="button" className={styles.stopAll} onClick={() => session.stopAllClips()} aria-label="Stop all parts at the next bar">
              <Icon name="stop" size={12} />
              <span>Stop all</span>
            </button>
          </Tooltip>
        </div>
        {scenes.slice(0, SCENE_ROWS).map((scene, row) => (
          <div key={scene.id} className={styles.row}>
            {columns.map((c) => (
              <ClipPad
                key={c.id}
                col={c}
                slot={row}
                sceneName={scene.name}
                dimmed={c.mute || (anySolo && !c.solo)}
                onMenu={openMenu}
                menuOpen={menu?.kind === 'clip' && menu.trackId === c.id && menu.slot === row}
                move={move}
                onPointerDownPad={onPointerDownPad}
                onDropHere={dropOn}
              />
            ))}
            <SceneButton
              row={row}
              scene={scene}
              columns={columns}
              onMenu={openMenu}
              menuOpen={menu?.kind === 'scene' && menu.row === row}
              drag={sceneDrag}
              onPointerDownScene={onPointerDownScene}
              consumeClick={consumeSceneClick}
            />
          </div>
        ))}
      </div>
      <div data-move-bar="">
        <PadActions move={move} onMove={startKeyMove} onCancelMove={cancelMove} onRename={rename} />
      </div>

      {move?.how === 'drag' &&
        createPortal(
          <div ref={ghostRef} className={styles.ghost} data-copy={move.copy || undefined} aria-hidden="true">
            <Icon name={move.copy ? 'copy' : 'drag'} size={14} />
            <span>
              {move.copy ? 'Copy' : 'Move'} “{move.clipName}”
            </span>
          </div>,
          document.body,
        )}
      {menu?.kind === 'clip' && (
        <ClipMenu
          key={menu.seq}
          trackId={menu.trackId}
          slot={menu.slot}
          anchor={menu.anchor}
          returnFocus={menu.returnFocus}
          ignore={menu.ignore}
          startInRename={menu.rename}
          onClose={closeMenu}
          onMove={() => startKeyMove({ trackId: menu.trackId, slot: menu.slot })}
        />
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
