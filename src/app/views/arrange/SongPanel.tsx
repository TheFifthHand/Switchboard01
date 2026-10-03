/**
 * Song: the arrangement as a magnetic, part-aware timeline.
 *
 *   [ SONG · Now playing: …                         Length · Echo tail · Loop ]
 *   [ Parts │ ruler, blocks edge to edge, one cell per part, playhead           ]
 *   [ SCENES  [Intro +] [Groove +] [Lift +] [Break +]                   hints     ]
 *
 * One Play per screen: the transport's Play (and Space) plays the song here,
 * and its Export starts from the song; ▶ on a block and a click on the bar
 * numbers play from there. The mode box says what plays and how to play;
 * while the pads play (say, straight after Jump In) it offers an amber
 * "▶ Play the song" key, so the song is one press away without changing what
 * Space and the transport do. While Record Notes writes into a clip it says
 * which ("Recording notes into Chords · Stabs (Groove)"), and when the block
 * playing does not play that clip, says so.
 *
 * The lane itself (blocks, gestures, keyboard, menus, the Loop button) is
 * SongLane. Edits apply live while the song plays or is paused: playback
 * re-plans from the block playing now (see Sequencer.replanSong), so the lane
 * is always what plays.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { loopName, loopSpan } from './laneLoop';
import { SongLane } from './SongLane';
import { blockView, viewKey, type BlockView } from './songModel';
import { getSongPlan, startSong, useSongPlan } from '../../songPlayback';
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
  const look = useCallback(() => {
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
  }, []);
  // At once when a block that plays goes away (before the next paint: the next block says Next in the same frame),
  // then every frame until the bar line hands over.
  useLayoutEffect(() => {
    if (watch) look();
  }, [watch, plan, ids, look]);
  useRafLoop(look, watch);
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

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * What plays now, in plain words ("Now playing: the song"), where it is, the
 * loop ("looping Groove (block 2)" only while playback is inside the loop and
 * will repeat it, else "loop set: …"), and a line on how to play.
 */
/** The clip Record Notes writes into, in words: "Chords · Stabs (Groove)". */
function recordTargetWords(p: Project, target: { trackId: Id; slot: number } | null): string {
  if (!target) return '';
  const t = p.tracks.find((x) => x.id === target.trackId);
  const clip = t?.clips[target.slot];
  const scene = p.scenes[target.slot]?.name ?? `row ${target.slot + 1}`;
  return `${t?.name ?? 'a part'} · ${clip?.name ?? 'a new clip'} (${scene})`;
}

/** Switch from the pads to the song (one press; Space and the transport keep their meaning). */
function playTheSong(): void {
  void startSong().then(() => {
    if (session.store.getState().arrangement.blocks.length) notify('Switched to the song');
  });
}

function ModeIndicator(props: { current: BlockView | null; next: BlockView | null; removed: boolean; blockCount: number; loop: string | null }) {
  const { current, next, removed, blockCount, loop } = props;
  const mode = useRuntime((s) => s.mode);
  const playing = useRuntime((s) => s.playing);
  const paused = useRuntime((s) => s.paused);
  const replayId = useRuntime((s) => s.replayId);
  const songLooping = useRuntime((s) => s.songLooping);
  const recordingTake = useRuntime((s) => s.recording === 'performance');
  const recordTarget = useRuntime((s) => (s.recording === 'notes' ? s.recordTarget : null));
  const targetAudible = useRuntime((s) => s.recordTargetAudible !== false);
  const recordingInto = useProject((p) => recordTargetWords(p, recordTarget));
  const replayName = useProject((p) => (replayId ? (p.performances.find((x) => x.id === replayId)?.name ?? 'a take') : ''));
  const songOn = (playing || paused) && mode === 'song';
  const loopText = loop ? (songOn && songLooping ? `looping ${loop}` : `loop set: ${loop}`) : '';
  let label = 'Now playing:';
  let value: string;
  let where = '';
  let caption: string;
  if (recordingTake) {
    // A take records live pad playing; the project is locked except for what it records.
    value = 'your pads';
    where = 'recording a take';
    caption = 'The song and your takes cannot be edited until you stop recording. Playing the song or a take ends the recording first.';
  } else if (songOn) {
    if (paused) label = 'Paused:';
    value = 'the song';
    where = current
      ? `${paused ? 'Paused in block' : 'Block'} ${current.index + 1} of ${blockCount} · ${current.name}`
      : removed
        ? next
          ? `Removed block ends at the bar · next: ${next.name} (block ${next.index + 1})`
          : 'Removed block ends at the bar · then the song ends'
        : '';
    if (loopText) where = where ? `${where} · ${loopText}` : capitalize(loopText);
    caption = 'Edits play right away: move, lengthen or change blocks while the song plays. Pads still work: a tapped clip joins at the next bar until the next block starts.';
  } else if (playing && mode === 'replay') {
    value = 'a recorded take';
    where = `“${replayName}”`;
    caption = 'The take plays back exactly as recorded. Pads and keys are ignored until you stop it.';
  } else if (playing || paused) {
    if (paused) label = 'Paused:';
    value = 'your pads';
    where = capitalize(loopText);
    caption = paused
      ? 'Play goes on with your pads from where they paused. Stop first, and Play (or Space) plays the song.'
      : 'Your Loops pads decide what plays. ▶ on a block, or a click on the bar numbers, plays the song from there; your pads come back when it stops.';
  } else {
    label = '';
    value = 'Stopped';
    where = capitalize(loopText);
    caption = blockCount
      ? `Play (or Space) plays the song from ${loop ? 'the loop' : 'the first block'}. ▶ on a block, or a click on the bar numbers, plays it from there.`
      : 'Add scenes below to build a song, then press Play.';
  }
  // Record Notes writes into a clip: say which (and, in the song, whether the block playing plays it).
  const notesIn = !!recordTarget && !recordingTake;
  let recLine: string | null = null;
  if (notesIn) {
    recLine = `Recording notes into ${recordingInto}`;
    if (songOn && !targetAudible) caption = `This block does not play it. ${caption}`;
  }
  // The pads play in Arrange: one press switches to the song (Space and the transport key are unchanged).
  const offerSong = !recordingTake && !notesIn && (playing || paused) && mode === 'live' && blockCount > 0;
  if (offerSong) caption = 'Your Loops pads decide what plays. ▶ Play the song switches to the song; ▶ on a block, or a click on the bar numbers, plays it from there.';
  const on = playing || paused;
  return (
    <div className={styles.mode} data-mode={on ? mode : 'stopped'} data-recording={recordingTake || notesIn || undefined} role="status" aria-live="polite" data-testid="playback-mode">
      <div className={styles.modeText}>
        <div className={styles.modeLine}>
          <Led on={playing || recordingTake || notesIn} tone={recordingTake || notesIn ? 'coral' : playing ? 'amber' : 'neutral'} label={recordingTake || notesIn ? 'Recording' : playing ? 'Playing' : paused ? 'Paused' : 'Stopped'} hideLabel size="sm" />
          {recLine ? (
            <>
              <span className={styles.modeLabel}>Recording notes into</span>
              <strong className={`${styles.modeValue} ${styles.modeRec}`} data-testid="recording-into">
                {recordingInto}
              </strong>
            </>
          ) : (
            <>
              {label && <span className={styles.modeLabel}>{label}</span>}
              <strong className={styles.modeValue}>{value}</strong>
            </>
          )}
          {where && <span className={styles.modeWhere}>{where}</span>}
        </div>
        <p className={styles.modeCaption} data-hint-avoid="" data-testid="mode-caption">
          {caption}
        </p>
      </div>
      {offerSong && (
        <Button className={styles.playSong} variant="secondary" icon="play" onClick={playTheSong} data-testid="play-the-song" tip="Switch from your pads to the song: it plays from the loop, or from the first block." detail="Space and the transport’s Play still pause and resume what plays now.">
          Play the song
        </Button>
      )}
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
      <Tooltip tip="How long the song plays: every block's length, added up." detail={`Estimated at ${Math.round(bpm)} BPM. Exports add the echo tail on top so echoes and reverb can ring out.`}>
        <div className={styles.readout} tabIndex={0} role="group" aria-label={`Song length: ${barsLabel(bars)}, about ${formatSeconds(secs)} at ${Math.round(bpm)} BPM`}>
          <span className={styles.readoutLabel}>Length</span>
          <span className={styles.readoutValue} data-testid="song-length">
            {barsLabel(bars)} · {formatSeconds(secs)}
          </span>
        </div>
      </Tooltip>
      <NumberField
        label="Echo tail"
        value={tail}
        min={0}
        max={10}
        step={0.5}
        unit="s"
        chars={3}
        size="sm"
        onChange={(v, info) => session.accepted(cmd.setTailSeconds(session.store, v, info.gesture))}
        tip="Extra seconds after the last block when you export the song, so echoes and reverb can ring out."
        detail="Saved with the project. The export dialog starts from this value."
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function SongPanel(props: { folded?: boolean; onUnfold?(): void } = {}) {
  const { folded = false, onUnfold } = props;
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
  // The loop (playback state), as the lane draws it: ignored when its blocks are gone.
  const songLoop = useRuntime((s) => s.songLoop);
  const loop = useMemo(() => loopSpan(views.map((v) => v.id), songLoop), [views, songLoop]);
  const looped = loop ? loopName(views.map((v) => v.name), loop) : null;
  // The lane renders the Loop button here (it knows what the button acts on).
  const [loopSlot, setLoopSlot] = useState<HTMLDivElement | null>(null);

  return (
    <section className={styles.panel} aria-labelledby="song-title" data-folded={folded || undefined}>
      <header className={styles.head}>
        <div className={styles.titleBlock}>
          <h2 id="song-title" className={styles.title}>
            Song
          </h2>
          <ModeIndicator current={current} next={next} removed={removed} blockCount={views.length} loop={looped} />
        </div>
        <div className={styles.headRight}>
          <SongTotals />
          <div ref={setLoopSlot} className={styles.buttons} />
          {folded && (
            <Button variant="secondary" icon="chevronDown" onClick={onUnfold} data-testid="show-song" tip="Close the take’s events and show the song lane again.">
              Show the song
            </Button>
          )}
        </div>
      </header>

      <SongLane views={views} scenes={scenes} currentId={currentId} nextId={next?.id ?? null} songActive={songOn} songPlaying={songPlaying} editClips={editSceneClips} loopSlot={loopSlot} />
    </section>
  );
}
