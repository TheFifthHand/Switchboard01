/**
 * The SCENES palette under the song lane: every scene of the project (1 to 8)
 * as a card, and Add scene.
 *
 *   [▶ Intro       + ⋯] [▶ Groove      + ⋯] …  [+ Add scene]
 *      4 bars · 4 parts
 *
 * - Drag a card onto the lane: between blocks inserts it, onto a block layers
 *   its clips in (LaneGestures). + adds it at the end of the song. A drag may
 *   start anywhere on the card, its keys too (a mouse or pen: once the press
 *   travels; a finger: once it is held); the click that ends one does nothing.
 *   The dotted grip at its left edge says it can be picked up.
 * - ▶ auditions the scene. While nothing plays it launches the scene on the
 *   live pads and stops after one pass: the stop is queued for the bar line
 *   where the pass ends (the sequencer times it on the audio clock), even if
 *   the user goes to another view meanwhile; a second press stops at once. While the pads play, ▶ starts the scene on them at
 *   the next bar, as a scene button in Play does. While the song plays (or a
 *   take replays, or playback is paused) it is unavailable and says why.
 * - Right-click (or the context-menu key) on a card, or its ⋯, opens Rename
 *   scene, Edit clips in Play and Add at the end of the song.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon, Tooltip } from '../../../ui/components';
import { MAX_SCENES, TICKS_PER_BAR, type Id } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { DEFAULT_BLOCK_REPEATS, MAX_SCENE_NAME } from '../../../state/commands';
import { session } from '../../instance';
import { notify, runtimeStore, useRuntime } from '../../runtime';
import { MenuHeader, MenuItem, MenuSeparator, Popover, anchorFromContextEvent, anchorFromElement, isMenuKey, type MenuAnchor } from '../ClipMenu';
import { partsText, type SceneSummary } from './BlockMenu';
import { LaneIcon } from './laneIcons';
import * as act from './songActions';
import { barsText, timesText } from './songModel';
import styles from './SongPanel.module.css';

/* ------------------------------------------------------------------ */
/* Audition                                                            */
/* ------------------------------------------------------------------ */

/** A scene heard from its card: the pass it plays ends at `endTick` (a bar line). */
interface Audition {
  sceneId: Id;
  row: number;
  endTick: number;
  /** The stop at `endTick` has been queued. */
  stopQueued: boolean;
}

/** How often the audition looks at the transport to queue its stop and tidy up (ms; it times nothing itself). */
const AUDITION_POLL_MS = 60;

let audition: Audition | null = null;
const listeners = new Set<() => void>();
function setAudition(a: Audition | null): void {
  audition = a;
  for (const l of listeners) l();
}

/** The scene being auditioned now (for tests and the cards). */
export function auditionedScene(): Id | null {
  return audition?.sceneId ?? null;
}

function useAudition(): Audition | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return audition;
}

/** Stop an audition now (a second press). */
function stopAudition(): void {
  if (!audition) return;
  setAudition(null);
  session.stop();
}

/**
 * Hear scene `row` from its card. Stopped: it plays from the top on the live
 * pads, one pass, then stops. With the pads playing: it takes over at the
 * next bar (and keeps playing, as a scene button in Play does).
 */
async function startAudition(s: SceneSummary): Promise<void> {
  const rt = runtimeStore.getState();
  if (rt.playing) {
    await session.launchScene(s.row);
    notify(`${s.name} plays on your pads from the next bar.`);
    return;
  }
  await session.launchScene(s.row);
  const after = runtimeStore.getState();
  if (!after.playing || after.mode !== 'live') return;
  // Stopped, the scene starts at the top (tick 0): its pass ends `bars` bars later.
  setAudition({ sceneId: s.id, row: s.row, endTick: Math.max(1, s.bars) * TICKS_PER_BAR, stopQueued: false });
  watchAudition();
}

let watchTimer = 0;

/**
 * Watches the audition wherever the user is (it is not tied to the palette
 * being on screen: switching views mid-pass still ends it at the pass's end,
 * and coming back never stops anything else): in its last bar it queues Stop
 * All for the bar line where the pass ends (the sequencer places it on the
 * audio clock), and once the pass is over it stops the transport. Anything
 * else taking over (Stop, the song, a pad launched by hand) ends the
 * audition and leaves playback alone.
 */
function watchAudition(): void {
  if (watchTimer) return;
  watchTimer = window.setInterval(() => {
    const cur = audition;
    const end = () => {
      window.clearInterval(watchTimer);
      watchTimer = 0;
    };
    if (!cur) {
      end();
      return;
    }
    const rt = runtimeStore.getState();
    const t = session.transport;
    if (!t || !rt.playing || rt.mode !== 'live') {
      setAudition(null);
      end();
      return;
    }
    // A part launched by hand to something else: the user has taken over.
    const takenOver = Object.values(rt.tracks).some((tr) => (tr.playingSlot !== null && tr.playingSlot !== cur.row) || (tr.queued && tr.queued.slot !== null && tr.queued.slot !== cur.row));
    if (takenOver) {
      setAudition(null);
      end();
      return;
    }
    const tick = t.getPosition().tick;
    if (!cur.stopQueued && tick >= 0 && tick >= cur.endTick - TICKS_PER_BAR) {
      cur.stopQueued = true;
      // Queued for the next bar line after now: the end of the pass.
      session.stopAllClips();
    }
    if (cur.stopQueued && tick >= cur.endTick) {
      setAudition(null);
      end();
      session.stop();
    }
  }, AUDITION_POLL_MS);
}

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

export interface ScenePaletteProps {
  scenes: SceneSummary[];
  /** The scene card being dragged, or null. */
  lifted: Id | null;
  onPress(e: ReactPointerEvent<HTMLElement>, sceneId: Id): void;
  /** Add the scene at the end of the song. */
  onAdd(s: SceneSummary): void;
  editClips(row: number): void;
  /** True for the click that ends a drag (a card dragged from one of its keys): that click does nothing. */
  dragClick(): boolean;
}

function RenameCard(props: { scene: SceneSummary; onDone(): void }) {
  const { scene, onDone } = props;
  const [value, setValue] = useState(scene.name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const v = value.replace(/\s+/g, ' ').trim();
    if (save && v && v !== scene.name && session.accepted(cmd.renameScene(session.store, scene.id, v))) notify(`The scene is now called “${v}”.`, 'info', 'undo');
    onDone();
  };
  return (
    <input
      ref={ref}
      className={styles.cardRename}
      value={value}
      maxLength={MAX_SCENE_NAME}
      spellCheck={false}
      autoComplete="off"
      aria-label={`Name of the scene ${scene.name}`}
      onChange={(e) => setValue(e.currentTarget.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

export const ScenePalette = memo(function ScenePalette(props: ScenePaletteProps) {
  const { scenes, lifted, onPress, onAdd, editClips, dragClick } = props;
  const a = useAudition();
  const songOn = useRuntime((s) => s.mode === 'song' && (s.playing || s.paused));
  const replaying = useRuntime((s) => s.mode === 'replay' && s.playing);
  const paused = useRuntime((s) => s.paused);
  const padsPlaying = useRuntime((s) => s.playing && s.mode === 'live');
  const recordingTake = useRuntime((s) => s.recording === 'performance');
  const [menu, setMenu] = useState<{ sceneId: Id; anchor: MenuAnchor; returnFocus: HTMLElement | null } | null>(null);
  const [renaming, setRenaming] = useState<Id | null>(null);
  // An audition ends when its scene goes away.
  useEffect(() => {
    if (a && !scenes.some((s) => s.id === a.sceneId)) setAudition(null);
  }, [a, scenes]);

  const full = scenes.length >= MAX_SCENES;
  const menuScene = menu ? scenes.find((s) => s.id === menu.sceneId) : undefined;
  const openMenu = (sceneId: Id, anchor: MenuAnchor, returnFocus: HTMLElement | null) => setMenu((m) => (m && m.sceneId === sceneId ? null : { sceneId, anchor, returnFocus }));

  return (
    <>
      <div className={styles.cards} role="list" aria-label="Scenes you can add to the song" data-count={scenes.length}>
        {scenes.map((s) => {
          const hearing = a?.sceneId === s.id;
          const why = songOn
            ? 'Stop the song to audition'
            : replaying
              ? 'Stop the replay to audition'
              : paused
                ? 'Stop playback to audition'
                : recordingTake && !padsPlaying
                  ? 'Recording a take'
                  : s.parts === 0
                    ? 'No clips to hear'
                    : null;
          // Why it is unavailable is its name (shown even with Tips off), not a tip.
          const tip = why ? undefined : hearing ? `Stop hearing ${s.name}.` : padsPlaying ? `Play ${s.name} on your pads from the next bar.` : `Hear ${s.name} once (${barsText(s.bars)}) on the pads, then stop.`;
          return (
            <div
              key={s.id}
              role="listitem"
              className={styles.card}
              data-scene-id={s.id}
              data-lifted={lifted === s.id || undefined}
              data-hearing={hearing || undefined}
              onPointerDown={(e) => {
                if (renaming === s.id) return;
                onPress(e, s.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(s.id, anchorFromContextEvent(e, e.currentTarget), e.currentTarget.querySelector<HTMLElement>('[data-card-menu]'));
              }}
              onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
                if (!isMenuKey(e)) return;
                e.preventDefault();
                const trigger = e.currentTarget.querySelector<HTMLElement>('[data-card-menu]');
                openMenu(s.id, anchorFromElement(trigger ?? e.currentTarget), trigger);
              }}
              aria-label={`Scene ${s.name}: ${barsText(s.bars)}, ${partsText(s.parts)}${hearing ? ', playing once' : ''}`}
            >
              <Tooltip name={why ?? (hearing ? `Stop ${s.name}` : `Hear ${s.name}`)} tip={tip}>
                <button
                  type="button"
                  className={styles.cardPlay}
                  data-hearing={hearing || undefined}
                  aria-pressed={hearing}
                  aria-label={hearing ? `Stop hearing ${s.name}` : `Hear ${s.name}`}
                  aria-disabled={why !== null || undefined}
                  data-testid="scene-audition"
                  data-drag-ok=""
                  onClick={() => {
                    if (dragClick()) return;
                    if (hearing) stopAudition();
                    else if (!why) void startAudition(s);
                  }}
                >
                  <Icon name={hearing ? 'stop' : 'play'} size={hearing ? 11 : 12} />
                </button>
              </Tooltip>
              <span className={styles.cardText}>
                {renaming === s.id ? <RenameCard scene={s} onDone={() => setRenaming(null)} /> : <span className={styles.cardName}>{s.name}</span>}
                <span className={styles.cardMeta}>
                  {hearing ? 'Playing once' : `${barsText(s.bars)} · ${partsText(s.parts)}`}
                </span>
              </span>
              <Tooltip
                name={`Add ${s.name}`}
                tip={`Add this scene at the end of the song (it plays ${timesText(DEFAULT_BLOCK_REPEATS)}). Or drag the card (a finger: hold it first): between blocks inserts it, onto a block fills that block’s silent parts with its clips (hold Shift to replace the parts instead).`}
              >
                <button type="button" className={styles.cardAdd} aria-label={`Add ${s.name} to the end of the song`} data-drag-ok="" onClick={() => !dragClick() && onAdd(s)}>
                  <Icon name="plus" size={14} />
                </button>
              </Tooltip>
              <button
                type="button"
                className={styles.cardMore}
                data-card-menu=""
                data-drag-ok=""
                aria-haspopup="menu"
                aria-expanded={menu?.sceneId === s.id}
                aria-label={`${s.name}: scene actions (rename, edit clips, add at end)`}
                onClick={(e) => !dragClick() && openMenu(s.id, anchorFromElement(e.currentTarget), e.currentTarget)}
              >
                <LaneIcon name="more" size={13} />
              </button>
            </div>
          );
        })}
      </div>
      <Tooltip name={full ? `A project has at most ${MAX_SCENES} scenes` : 'Add scene'} tip={full ? undefined : 'A new empty scene row: add clips to its pads in Play, or make a scene from a block (its ⋯ menu).'}>
        <button type="button" className={styles.addScene} aria-label="Add scene" aria-disabled={full || undefined} onClick={() => !full && act.addSceneRow()}>
          <Icon name="plus" size={14} />
          <span>Add scene</span>
        </button>
      </Tooltip>
      {menu && menuScene && (
        <Popover anchor={menu.anchor} label={`Scene ${menuScene.name}`} onClose={() => setMenu(null)} returnFocus={menu.returnFocus}>
          <MenuHeader eyebrow={`Scene · row ${menuScene.row + 1} · ${barsText(menuScene.bars)} · ${partsText(menuScene.parts)}`} title={menuScene.name} />
          <MenuItem
            icon="pencil"
            onSelect={() => {
              setMenu(null);
              setRenaming(menuScene.id);
            }}
          >
            Rename scene…
          </MenuItem>
          <MenuItem
            icon="link"
            onSelect={() => {
              setMenu(null);
              editClips(menuScene.row);
            }}
          >
            Edit clips in Play
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon="plus"
            hint={timesText(DEFAULT_BLOCK_REPEATS)}
            onSelect={() => {
              setMenu(null);
              onAdd(menuScene);
            }}
          >
            Add at the end of the song
          </MenuItem>
        </Popover>
      )}
    </>
  );
});
