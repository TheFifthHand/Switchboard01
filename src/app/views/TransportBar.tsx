import { useRef, useState } from 'react';
import { Button, IconButton, Knob, Meter, NumberField, SegmentedControl, Tooltip, useRafLoop } from '../../ui/components';
import { BPM_SPEC, MASTER_VOLUME_SPEC, SWING_SPEC } from '../../project/params';
import { setView, type View } from '../../state/uiStore';
import { session, useAutosave, useHistory, useProject, useUi } from '../instance';
import { useRuntime } from '../runtime';
import type { MeterFrame } from '../../audio/contracts';
import styles from './TransportBar.module.css';

const VIEW_OPTIONS = [
  { value: 'play', label: 'Play' },
  { value: 'shape', label: 'Shape' },
  { value: 'arrange', label: 'Arrange' },
] as const;

const meterFrame: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
let meterFrameAt = 0;
/** One engine read per animation frame, shared by every meter. */
export function readMeterFrame(): MeterFrame {
  const now = performance.now();
  if (now - meterFrameAt > 12) {
    meterFrameAt = now;
    if (!session.readMeters(meterFrame)) {
      meterFrame.masterPeakL = meterFrame.masterPeakR = meterFrame.masterRms = 0;
      meterFrame.tracks = [];
    }
  }
  return meterFrame;
}

function Position() {
  const ref = useRef<HTMLSpanElement>(null);
  const playing = useRuntime((s) => s.playing);
  const last = useRef('');
  useRafLoop(() => {
    const t = session.transport;
    if (!ref.current || !t) return;
    const p = t.getPosition();
    const text = p.tick < 0 ? 'Count' : `${p.bar + 1}.${p.beat + 1}`;
    if (text !== last.current) {
      last.current = text;
      ref.current.textContent = text;
    }
  }, playing);
  return (
    <div className={styles.position} role="timer" aria-label="Bar and beat">
      <span className={styles.posLabel}>BAR.BEAT</span>
      <span ref={ref} className={`${styles.posValue} mono`}>
        {playing ? '' : '1.1'}
      </span>
    </div>
  );
}

function SaveStatus() {
  const save = useAutosave();
  const [open, setOpen] = useState(false);
  const text = save.status === 'error' ? 'Not saved' : save.status === 'saving' || save.dirty ? 'Saving…' : save.status === 'saved' ? 'Saved' : 'Saved';
  const tone = save.status === 'error' ? styles.saveError : save.status === 'saving' || save.dirty ? styles.saveBusy : styles.saveOk;
  return (
    <div className={styles.saveWrap}>
      <Tooltip tip={save.status === 'error' ? save.lastError?.message : 'Your project saves automatically in this browser.'} detail="Browser storage is working storage. Export a project file for a portable backup.">
        <button type="button" className={`${styles.save} ${tone}`} aria-live="polite" onClick={() => setOpen(save.status === 'error' ? !open : false)}>
          <span className={styles.saveDot} aria-hidden />
          {text}
        </button>
      </Tooltip>
      {save.status === 'error' && open && (
        <div className={styles.savePopover} role="alertdialog" aria-label="Saving failed">
          <p>{save.lastError?.message}</p>
          <div className={styles.saveActions}>
            <Button size="sm" onClick={() => void session.autosaver?.retry()}>
              Try again
            </Button>
            <Button size="sm" variant="secondary" onClick={() => window.dispatchEvent(new CustomEvent('sb:export-project'))}>
              Export project file
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function TransportBar(props: { onOpenLibrary(): void; onOpenExport(): void }) {
  const view = useUi((s) => s.view);
  const bpm = useProject((p) => p.bpm);
  const swing = useProject((p) => p.swing);
  const masterDb = useProject((p) => p.masterVolumeDb);
  const projectName = useProject((p) => p.name);
  const playing = useRuntime((s) => s.playing);
  const mode = useRuntime((s) => s.mode);
  const recording = useRuntime((s) => s.recording);
  const countingIn = useRuntime((s) => s.countingIn);
  const muteAll = useRuntime((s) => s.muteAll);
  const history = useHistory();

  return (
    <header className={styles.bar} aria-label="Transport">
      <div className={styles.brand} aria-label="SWITCHBOARD / 01">
        <span className={styles.brandName}>SWITCHBOARD</span>
        <span className={`${styles.brandNum} mono`}>/ 01</span>
      </div>

      <SegmentedControl<View> label="View" kind="tabs" options={VIEW_OPTIONS} value={view} onChange={(v) => setView(v)} size="sm" className={styles.views} />

      <div className={styles.group}>
        <Button
          variant="transport"
          icon={playing ? 'stop' : 'play'}
          pressed={playing}
          onClick={() => void session.togglePlay()}
          tip={playing ? 'Stop playback. Clips stay selected for next time.' : 'Start playback of the lit clips.'}
          detail="Space bar also plays and stops."
          aria-keyshortcuts="Space"
          className={styles.play}
        >
          {playing ? 'Stop' : 'Play'}
        </Button>
        <Position />
        {mode !== 'live' && playing && <span className={styles.mode}>{mode === 'song' ? 'SONG' : 'REPLAY'}</span>}
      </div>

      <div className={styles.group}>
        <NumberField
          label="Tempo"
          layout="stacked"
          value={bpm}
          min={BPM_SPEC.min}
          max={BPM_SPEC.max}
          step={1}
          fineStep={0.1}
          unit="BPM"
          size="sm"
          chars={5}
          tip={BPM_SPEC.tip}
          onChange={(v, info) => session.setBpm(v, info.gesture)}
        />
        <NumberField
          label="Swing"
          layout="stacked"
          value={Math.round(swing * 100)}
          min={0}
          max={100}
          step={1}
          unit="%"
          size="sm"
          chars={3}
          tip={SWING_SPEC.tip}
          detail={SWING_SPEC.detail}
          onChange={(v, info) => session.setSwing(v / 100, info.gesture)}
        />
      </div>

      <div className={styles.group} role="group" aria-label="Recording">
        <Button
          variant="secondary"
          tone="coral"
          icon="record"
          pressed={recording === 'notes'}
          onClick={() => void session.toggleRecordNotes()}
          tip="Record what you play on the keyboard or drum pads into the selected clip."
          detail="Uses the quantize setting of the part. Undo removes the whole take."
          className={recording === 'notes' ? styles.recActive : undefined}
        >
          {recording === 'notes' ? (countingIn ? 'Count-in…' : 'Recording notes') : 'Record Notes'}
        </Button>
        <Button
          variant="secondary"
          tone="coral"
          icon="recordPerformance"
          pressed={recording === 'performance'}
          onClick={() => void session.togglePerformance()}
          tip="Capture everything you do — launches, notes, knob moves — as a replayable performance."
          detail="Cables and sound choices are locked while recording so the take replays exactly."
          className={recording === 'performance' ? styles.recActive : undefined}
        >
          {recording === 'performance' ? 'Stop recording' : 'Record Performance'}
        </Button>
      </div>

      <div className={styles.group}>
        <Knob spec={MASTER_VOLUME_SPEC} value={masterDb} size="sm" onChange={(v, info) => session.setMasterVolume(v, info.gesture)} label="Master" />
        <div className={styles.meters}>
          <Meter read={() => readMeterFrame().masterPeakL} label="Master left level" orientation="vertical" length={36} thickness={5} />
          <Meter read={() => readMeterFrame().masterPeakR} label="Master right level" orientation="vertical" length={36} thickness={5} />
        </div>
        <Button
          variant={muteAll ? 'danger' : 'secondary'}
          icon="mute"
          pressed={muteAll}
          onClick={() => session.toggleMuteAll()}
          tip={muteAll ? 'Everything is silenced. Press to hear sound again.' : 'Silence everything at once, including echoes and held notes.'}
          aria-keyshortcuts="Escape"
          className={styles.muteAll}
        >
          {muteAll ? 'MUTED' : 'Mute All'}
        </Button>
      </div>

      <div className={styles.right}>
        <SaveStatus />
        <IconButton icon="undo" label={history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo'} disabled={!history.canUndo} onClick={() => session.undo()} size="sm" variant="ghost" aria-keyshortcuts="Control+Z" />
        <IconButton icon="redo" label={history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo'} disabled={!history.canRedo} onClick={() => session.redo()} size="sm" variant="ghost" aria-keyshortcuts="Control+Shift+Z" />
        <Button variant="ghost" size="sm" icon="folder" onClick={props.onOpenLibrary} tip="Projects: open, rename, duplicate, import and export." className={styles.project}>
          <span className={styles.projectName}>{projectName}</span>
        </Button>
        <Button variant="primary" size="sm" icon="download" onClick={props.onOpenExport} tip="Save your song or a recorded performance as a WAV file.">
          Export
        </Button>
      </div>
    </header>
  );
}
