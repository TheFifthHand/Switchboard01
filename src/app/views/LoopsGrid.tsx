/**
 * Loops mode: eight part columns x four clip rows. A pad starts or stops a
 * clip for its part (at the next bar); the side buttons launch a whole row
 * as a scene. State is shown with light AND text: Empty, Ready, Next bar
 * (queued), Playing, Stopping, Recording.
 */
import { memo, useCallback, useRef, type KeyboardEvent } from 'react';
import { IconButton, Meter, Pad, Tooltip, type PadState } from '../../ui/components';
import { SCENE_ROWS, type Clip, type Id, type Project, type Scene } from '../../project/types';
import { selectSlot, selectTrack, slotFor } from '../../state/uiStore';
import { setSolo } from '../../state/commands';
import { session, useProject, useUi } from '../instance';
import { useRuntime, type TrackRuntime } from '../runtime';
import { barsLabel, soundName } from '../labels';
import { readMeterFrame } from './TransportBar';
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

const ClipPad = memo(function ClipPad(props: { trackId: Id; trackName: string; slot: number; clip: Clip | null; sceneName: string }) {
  const { trackId, trackName, slot, clip, sceneName } = props;
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
  const stateWord = caption ?? { empty: 'Empty', ready: 'Ready', queued: 'Starts next bar', playing: 'Playing', recording: 'Recording', stopping: 'Stopping' }[state];
  return (
    <Pad
      state={state}
      selected={selected}
      label={clip ? clip.name : 'Empty'}
      sublabel={clip ? barsLabel(clip.bars) : undefined}
      caption={caption}
      onPress={onPress}
      ariaLabel={`${trackName}, ${sceneName}: ${clip ? clip.name : 'empty slot'}. ${stateWord}.`}
      id={`pad-${trackId}-${slot}`}
    />
  );
});

function TrackHeader(props: { col: ColumnSummary; index: number }) {
  const { col, index } = props;
  const selected = useUi((s) => s.selectedTrackId === col.id);
  const anySolo = useProject((p) => p.tracks.some((t) => t.solo));
  const audible = !col.mute && (!anySolo || col.solo);
  return (
    <div className={`${styles.header} ${selected ? styles.headerSelected : ''}`}>
      <button type="button" className={styles.headerMain} onClick={() => selectTrack(col.id)} aria-pressed={selected} aria-label={`Select ${col.name} (${col.sound})`}>
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
        <div className={`${styles.meter} ${audible ? '' : styles.meterOff}`}>
          <Meter read={() => readMeterFrame().tracks.find((t) => t.trackId === col.id)?.peak ?? 0} label={`${col.name} level`} orientation="horizontal" length="100%" thickness={4} segments={10} />
        </div>
      </div>
    </div>
  );
}

function SceneButton(props: { row: number; scene: Scene; columns: ColumnSummary[] }) {
  const { row, scene, columns } = props;
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
  return (
    <Tooltip tip={`Play the ${scene.name} scene: ${count} part${count === 1 ? '' : 's'} with clips in this row start, the others stop.`} detail="Scenes switch on the next bar.">
      <button type="button" className={`${styles.scene} ${lit ? styles.sceneLit : ''}`} onClick={() => void session.launchScene(row)} aria-label={`Launch scene ${scene.name}${lit ? ' (playing)' : ''}`}>
        <span className={styles.sceneIcon} aria-hidden>
          ▶
        </span>
        <span className={styles.sceneName}>{scene.name}</span>
        <span className={`${styles.sceneCount} mono`}>{count}/8</span>
      </button>
    </Tooltip>
  );
}

function StopButton(props: { trackId: Id; name: string }) {
  const active = useRuntime((s) => s.tracks[props.trackId]?.playingSlot != null);
  return (
    <IconButton icon="stop" label={`Stop ${props.name} at the next bar`} size="sm" variant="ghost" disabled={!active} onClick={() => session.stopTrack(props.trackId)} className={styles.stop} />
  );
}

/** Arrow keys move between pads (roving focus). */
function onGridKey(e: KeyboardEvent<HTMLDivElement>) {
  const id = (e.target as HTMLElement).id;
  const m = /^pad-(t\d+)-(\d)$/.exec(id);
  if (!m) return;
  const col = Number(m[1].slice(1)) - 1;
  const row = Number(m[2]);
  let c = col;
  let r = row;
  if (e.key === 'ArrowRight') c = Math.min(7, col + 1);
  else if (e.key === 'ArrowLeft') c = Math.max(0, col - 1);
  else if (e.key === 'ArrowDown') r = Math.min(SCENE_ROWS - 1, row + 1);
  else if (e.key === 'ArrowUp') r = Math.max(0, row - 1);
  else return;
  e.preventDefault();
  document.getElementById(`pad-t${c + 1}-${r}`)?.focus();
}

export function LoopsGrid() {
  const columns = useProject(summarize, sameColumns);
  const scenes = useProject((p) => p.scenes);
  const gridRef = useRef<HTMLDivElement>(null);
  return (
    <div className={styles.wrap}>
      <div className={styles.grid} ref={gridRef} onKeyDown={onGridKey} role="group" aria-label="Clip pads: eight parts by four scenes">
        {columns.map((c, i) => (
          <TrackHeader key={c.id} col={c} index={i} />
        ))}
        <div className={styles.sceneHeader}>SCENES</div>
        {scenes.slice(0, SCENE_ROWS).map((scene, row) => (
          <div key={scene.id} className={styles.row}>
            {columns.map((c) => (
              <ClipPad key={c.id} trackId={c.id} trackName={c.name} slot={row} clip={c.clips[row]} sceneName={scene.name} />
            ))}
            <SceneButton row={row} scene={scene} columns={columns} />
          </div>
        ))}
        {columns.map((c) => (
          <StopButton key={c.id} trackId={c.id} name={c.name} />
        ))}
        <button type="button" className={styles.stopAll} onClick={() => session.stopAllClips()} aria-label="Stop all parts at the next bar">
          ■ Stop all
        </button>
      </div>
    </div>
  );
}
