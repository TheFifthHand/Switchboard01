/**
 * Song: the arrangement as a magnetic, part-aware timeline.
 *
 *   [ SONG · Playback follows: …        Length · Tail · Play song · Stop · Export ]
 *   [ Parts │ ruler, blocks edge to edge, one cell per part, playhead           ]
 *   [ SCENES  [Intro +] [Groove +] [Lift +] [Break +]                   hints     ]
 *
 * The lane itself (blocks, gestures, keyboard, menus) is SongLane. Edits apply
 * live while the song plays or is paused: playback re-plans from the block
 * playing now (see Sequencer.replanSong), so the lane is always what plays.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { Button, Led, NumberField, Tooltip, useRafLoop } from '../../../ui/components';
import { TICKS_PER_BAR, type ArrangementBlock, type Id, type Project } from '../../../project/types';
import { clampBpm, ticksToSeconds } from '../../../time/clock';
import { sceneBars, songLengthTicks } from '../../../time/sequencer';
import * as cmd from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { selectSlot, selectTrack, setPadMode, setView } from '../../../state/uiStore';
import { session, useProject } from '../../instance';
import { notify, useRuntime } from '../../runtime';
import { formatSeconds } from '../../session';
import { barsLabel } from '../../labels';
import type { SceneSummary } from './BlockMenu';
import { LaneIcon } from './laneIcons';
import { loopName, loopSpan } from './laneLoop';
import { SongLane, type LaneControls } from './SongLane';
import { blockView, viewKey, type BlockView } from './songModel';
import { getSongPlan, startSong, useSongPlan } from './songPlan';
import styles from './SongPanel.module.css';

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

// Stable selectors: the store keeps their last selection between renders.
const selectScenes = (p: Project) => p.scenes;
const selectSceneBars = (p: Project) => p.scenes.map((_, r) => sceneBars(p, r));
const selectSceneParts = (p: Project) => p.scenes.map((_, r) => p.tracks.reduce((n, t) => n + (t.clips[r] ? 1 : 0), 0));

function useSceneSummaries(): SceneSummary[] {
  const scenes = useProject(selectScenes);
  const bars = useProject(selectSceneBars, shallowEqual);
  const parts = useProject(selectSceneParts, shallowEqual);
  return useMemo(() => scenes.map((s, row) => ({ id: s.id, row, name: s.name, bars: bars[row] ?? 1, parts: parts[row] ?? 0 })), [scenes, bars, parts]);
}

interface CachedView {
  /** What the view was made from: the block (immer keeps an unchanged block's object), its place, and the scenes and parts it reads. */
  block: ArrangementBlock;
  index: number;
  scenes: Project['scenes'];
  tracks: Project['tracks'];
  key: string;
  view: BlockView;
}

/**
 * The lane's blocks. A view object keeps its identity while what it shows is
 * unchanged, so a knob turned elsewhere re-renders no block, and an edit to
 * one block re-renders only that block. A block whose object, place, scenes
 * and parts are the ones its view was made from is not even looked at again
 * (a move rebuilds only the blocks whose position changed).
 */
function useBlockViews(): readonly BlockView[] {
  const cache = useRef(new Map<Id, CachedView>());
  const last = useRef<readonly BlockView[]>([]);
  // Stable, so the store keeps its memo of the last selection between renders.
  const select = useCallback((p: Project): readonly BlockView[] => {
    const next = p.arrangement.blocks.map((b, index) => {
      const hit = cache.current.get(b.id);
      if (hit && hit.block === b && hit.index === index && hit.scenes === p.scenes && hit.tracks === p.tracks) return hit.view;
      const v = blockView(p, b, index);
      const key = viewKey(v);
      const view = hit && hit.key === key ? hit.view : v;
      cache.current.set(b.id, { block: b, index, scenes: p.scenes, tracks: p.tracks, key, view });
      return view;
    });
    if (cache.current.size > next.length * 2 + 16) {
      const keep = new Set(next.map((v) => v.id));
      for (const id of cache.current.keys()) if (!keep.has(id)) cache.current.delete(id);
    }
    if (next.length === last.current.length && next.every((v, i) => v === last.current[i])) return last.current;
    last.current = next;
    return next;
  }, []);
  return useProject(select);
}

/**
 * A block removed from the lane while it plays sounds on to the next bar
 * line, then the block after it takes over. While that is so, this says
 * which block was removed and which one takes over (null when nothing
 * follows), from the song as it plays: the plan keeps the removed block until
 * it hands over, and the transport says whether the playhead is still in it.
 * Without a transport position, a runtime block that is no longer on the lane
 * counts as that removed block.
 */
function useHandover(views: readonly BlockView[], songOn: boolean, playingId: Id | null): { removed: Id; next: BlockView | null } | null {
  const plan = useSongPlan();
  const ids = useMemo(() => new Set(views.map((v) => v.id)), [views]);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const [sounding, setSounding] = useState<Id | null>(null);
  const soundingRef = useRef<Id | null>(null);
  const watch = songOn && !!plan && plan.some((b) => !ids.has(b.blockId));
  useRafLoop(() => {
    const t = session.transport;
    const p = getSongPlan();
    let found: Id | null = null;
    if (t && p) {
      const tick = t.getPosition().tick;
      const e = p.find((b) => tick < b.endTick);
      if (e && !idsRef.current.has(e.blockId)) found = e.blockId;
    }
    if (found !== soundingRef.current) {
      soundingRef.current = found;
      setSounding(found);
    }
  }, watch);
  const removed = (watch ? sounding : null) ?? (songOn && playingId && !ids.has(playingId) ? playingId : null);
  if (!removed || !plan) return null;
  const i = plan.findIndex((b) => b.blockId === removed);
  const byId = new Map(views.map((v) => [v.id, v]));
  for (const b of i >= 0 ? plan.slice(i + 1) : []) {
    const v = byId.get(b.blockId);
    if (v) return { removed, next: v };
  }
  return { removed, next: null };
}

/** Show a scene row's clips in the Play view (Loops), with the row's first clip (or first pad, when it has none) selected. */
export function editSceneClips(row: number): void {
  const p = session.store.getState();
  setPadMode('loops');
  for (const t of p.tracks) if (t.clips[row]) selectSlot(t.id, row);
  const first = p.tracks.find((t) => t.clips[row]);
  const target = first ?? p.tracks[0];
  if (target) {
    selectTrack(target.id);
    selectSlot(target.id, row);
  }
  setView('play');
  const scene = p.scenes[row]?.name ?? 'scene';
  notify(
    first
      ? `Showing the ${scene} row: its clips are the pads in row ${row + 1}. Open a pad's menu or Steps to edit them.`
      : `The ${scene} row has no clips yet, so this block plays silence. Add clips to the pads in row ${row + 1}.`,
  );
  // Put keyboard focus on that pad once the Play view is on screen.
  requestAnimationFrame(() => {
    if (target) document.getElementById(`pad-${target.id}-${row}`)?.focus({ preventScroll: true });
  });
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

function ModeIndicator(props: { current: BlockView | null; next: BlockView | null; removed: boolean; blockCount: number; looping: string | null }) {
  const { current, next, removed, blockCount, looping } = props;
  const mode = useRuntime((s) => s.mode);
  const playing = useRuntime((s) => s.playing);
  const paused = useRuntime((s) => s.paused);
  const replayId = useRuntime((s) => s.replayId);
  const recordingTake = useRuntime((s) => s.recording === 'performance');
  const replayName = useProject((p) => (replayId ? (p.performances.find((x) => x.id === replayId)?.name ?? 'a take') : ''));
  let follows: string;
  let where = '';
  let caption: string;
  if (recordingTake) {
    // A take records live pad playing; the project is locked except for what it records.
    follows = 'Live pads';
    where = 'recording a take';
    caption = 'The song and your takes cannot be edited until you stop recording. Play song or Replay ends the take first.';
  } else if ((playing || paused) && mode === 'song') {
    follows = 'Arrangement';
    where = current
      ? `${paused ? 'Paused in block' : 'Block'} ${current.index + 1} of ${blockCount} · ${current.name}`
      : removed
        ? next
          ? `Removed block ends at the bar · next: ${next.name} (block ${next.index + 1})`
          : 'Removed block ends at the bar · then the song ends'
        : '';
    if (looping) where = where ? `${where} · looping ${looping}` : `Looping ${looping}`;
    caption = 'Edits play right away: move, lengthen or change blocks while the song plays. Pads still work: a tapped clip joins at the next bar until the next block starts.';
  } else if (playing && mode === 'replay') {
    follows = 'Performance';
    where = `“${replayName}”`;
    caption = 'The take plays back exactly as recorded. Pads and keys are ignored until you stop it.';
  } else {
    follows = 'Live pads';
    caption = playing
      ? 'The Loops pads decide what plays. Play song hands playback to the blocks below; your pads come back when it stops.'
      : 'Stopped. Play song plays the blocks below in order; Play in the transport plays your pads.';
  }
  const on = playing || paused;
  return (
    <div className={styles.mode} data-mode={on ? mode : 'stopped'} data-recording={recordingTake || undefined} role="status" aria-live="polite" data-testid="playback-mode">
      <div className={styles.modeLine}>
        <Led on={playing || recordingTake} tone={recordingTake ? 'coral' : playing ? 'amber' : 'neutral'} label={recordingTake ? 'Recording' : playing ? 'Playing' : paused ? 'Paused' : 'Stopped'} hideLabel size="sm" />
        <span className={styles.modeLabel}>Playback follows:</span>
        <strong className={styles.modeValue}>{follows}</strong>
        {where && <span className={styles.modeWhere}>{where}</span>}
      </div>
      <p className={styles.modeCaption}>{caption}</p>
    </div>
  );
}

const selectSongTicks = (p: Project) => songLengthTicks(p);
const selectBpm = (p: Project) => clampBpm(p.bpm);
const selectTail = (p: Project) => p.arrangement.tailSeconds;

function SongTotals() {
  const ticks = useProject(selectSongTicks);
  const bpm = useProject(selectBpm);
  const tail = useProject(selectTail);
  const bars = Math.round(ticks / TICKS_PER_BAR);
  const secs = ticksToSeconds(ticks, bpm);
  return (
    <div className={styles.totals}>
      <Tooltip tip="How long the song plays: every block's pass length times its passes." detail={`Estimated at ${Math.round(bpm)} BPM. Exports add the tail on top so echoes and reverb can ring out.`}>
        <div className={styles.readout} tabIndex={0} role="group" aria-label={`Song length: ${barsLabel(bars)}, about ${formatSeconds(secs)} at ${Math.round(bpm)} BPM`}>
          <span className={styles.readoutLabel}>LENGTH</span>
          <span className={`${styles.readoutValue} mono`} data-testid="song-length">
            {barsLabel(bars)} · {formatSeconds(secs)}
          </span>
        </div>
      </Tooltip>
      <NumberField
        label="Export tail"
        value={tail}
        min={0}
        max={10}
        step={0.5}
        unit="s"
        chars={3}
        size="sm"
        onChange={(v, info) => session.accepted(cmd.setTailSeconds(session.store, v, info.gesture))}
        tip="Extra seconds after the last block in song exports, so echoes and reverb can ring out."
        detail="Saved with the project. The export dialog starts from this value."
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function SongPanel() {
  const views = useBlockViews();
  const scenes = useSceneSummaries();
  const mode = useRuntime((s) => s.mode);
  const playing = useRuntime((s) => s.playing);
  const paused = useRuntime((s) => s.paused);
  const songBlockId = useRuntime((s) => s.songBlockId);
  const songBlock = useRuntime((s) => s.songBlock);
  const songOn = (playing || paused) && mode === 'song';
  const songPlaying = playing && mode === 'song';

  // What is playing now, by block id (stable across edits made while the song plays).
  const playingId = songOn ? (songBlockId ?? (songBlock !== null ? (views[songBlock]?.id ?? null) : null)) : null;
  // The block playing now was removed: it plays to the next bar, then the block after it takes over.
  // Until then nothing on the lane says Playing; the block taking over says Next.
  const handover = useHandover(views, songOn, playingId);
  const removed = !!handover;
  const next = handover?.next ?? null;
  const current = !handover && playingId ? (views.find((v) => v.id === playingId) ?? null) : null;
  const currentId = current?.id ?? null;
  const empty = views.length === 0;
  // The loop (playback state), as the lane draws it: ignored when its blocks are gone.
  const songLoop = useRuntime((s) => s.songLoop);
  const loop = useMemo(() => loopSpan(views.map((v) => v.id), songLoop), [views, songLoop]);
  const looping = loop ? loopName(views.map((v) => v.name), loop) : null;
  const lane = useRef<LaneControls | null>(null);

  return (
    <section className={styles.panel} aria-labelledby="song-title">
      <header className={styles.head}>
        <div className={styles.titleBlock}>
          <h2 id="song-title" className={styles.title}>
            Song
          </h2>
          <ModeIndicator current={current} next={next} removed={removed} blockCount={views.length} looping={looping} />
        </div>
        <div className={styles.headRight}>
          <SongTotals />
          <div className={styles.buttons}>
            <Button
              variant="primary"
              icon="play"
              pressed={songPlaying}
              onClick={() => void startSong()}
              disabled={empty}
              aria-label={songPlaying ? 'Play song from the start (playing now)' : 'Play song'}
              tip={empty ? 'Add scene blocks first.' : loop ? `Play the song from the loop (${looping}).` : 'Play the blocks in order from the first one. Pressing it while the song plays starts it again from the top.'}
              detail="Starting the song ends a performance recording in progress."
            >
              Play song
            </Button>
            <Button icon="stop" onClick={() => session.stop()} disabled={!playing && !paused} tip="Stop playback (song, replay or pads).">
              Stop
            </Button>
            <Button
              className={styles.loopButton}
              pressed={!!loop}
              tone="teal"
              onClick={() => lane.current?.toggleLoop()}
              disabled={empty}
              aria-label="Loop"
              data-testid="loop-toggle"
              tip={empty ? 'Add scene blocks first.' : loop ? `Looping ${looping}. Press to play the song through again.` : 'Repeat part of the song while it plays: the selected blocks, else the block playing now, else the first block.'}
              detail="Or drag across the bar numbers above the blocks; drag the ends of the Loop band to change it."
            >
              <LaneIcon name="loop" size={16} />
              Loop
            </Button>
            <Button
              icon="download"
              onClick={() => window.dispatchEvent(new CustomEvent('sb:open-export', { detail: { source: 'song' } }))}
              disabled={empty}
              tip={empty ? 'Add scene blocks first.' : 'Render the whole song to a WAV file.'}
              detail="Same sounds, effects and timing as playback, plus the export tail."
            >
              Export song
            </Button>
          </div>
        </div>
      </header>

      <SongLane views={views} scenes={scenes} currentId={currentId} nextId={next?.id ?? null} songActive={songOn} songPlaying={songPlaying} editClips={editSceneClips} controls={lane} />
    </section>
  );
}
