import { useRef, useState } from 'react';
import { Button, IconButton, Knob, Meter, NumberField, SegmentedControl, Switch, Tooltip, useRafLoop } from '../../ui/components';
import { BPM_SPEC, MASTER_VOLUME_SPEC, SWING_SPEC } from '../../project/params';
import { setTipsEnabled, setView, type View } from '../../state/uiStore';
import { session, useAutosave, useHistory, useProject, useUi } from '../instance';
import { useRuntime } from '../runtime';
import type { MeterFrame } from '../../audio/contracts';
import { RecordOptions, recordOptionsCaption } from './RecordOptions';
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
        <button type="button" className={`${styles.save} ${tone}`} aria-live="polite" aria-label={`Autosave: ${text}`} onClick={() => setOpen(save.status === 'error' ? !open : false)}>
          <span className={styles.saveDot} aria-hidden />
          <span className={styles.saveText}>{text}</span>
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

/** Record Notes, Record Performance and their options, with the recording status as the caption. */
function RecordGroup() {
  const recording = useRuntime((s) => s.recording);
  const countingIn = useRuntime((s) => s.countingIn);
  const targetId = useRuntime((s) => s.recordTarget?.trackId ?? null);
  const targetName = useProject((p) => (targetId ? (p.tracks.find((t) => t.id === targetId)?.name ?? '') : ''));
  const options = useProject((p) => recordOptionsCaption(p.settings));
  const caption =
    recording === 'notes'
      ? countingIn
        ? `Count-in · then ${targetName}`
        : `Recording notes · ${targetName}`
      : recording === 'performance'
        ? 'Recording performance'
        : options
          ? `Record · ${options}`
          : 'Record';
  return (
    <div className={`${styles.group} ${styles.recGroup}`} role="group" aria-label="Recording">
      <span className={styles.recCaption} data-live={recording !== 'off' || undefined} aria-live="polite">
        {recording !== 'off' && <span className={styles.recDot} aria-hidden="true" />}
        {caption}
      </span>
      <div className={styles.recButtons}>
        <Button
          variant="secondary"
          size="sm"
          tone="coral"
          pressed={recording === 'notes'}
          aria-pressed={undefined}
          onClick={() => void session.toggleRecordNotes()}
          aria-label={recording === 'notes' ? 'Stop recording notes' : 'Record Notes'}
          tip={recording === 'notes' ? 'Stop recording notes. Undo removes the whole take.' : 'Record what you play on the keyboard or drum pads into the selected clip.'}
          detail="Timing, metronome and count-in are in Recording options (the metronome button)."
          className={recording === 'notes' ? styles.recActive : undefined}
        >
          Notes
        </Button>
        <Button
          variant="secondary"
          size="sm"
          tone="coral"
          pressed={recording === 'performance'}
          aria-pressed={undefined}
          onClick={() => void session.togglePerformance()}
          aria-label={recording === 'performance' ? 'Stop recording performance' : 'Record Performance'}
          tip={recording === 'performance' ? 'Stop and keep this performance. Replay or export it in Arrange.' : 'Capture everything you do — launches, notes, knob moves — as a replayable performance.'}
          detail="Cables and sound choices are locked while recording so the take replays exactly."
          className={recording === 'performance' ? styles.recActive : undefined}
        >
          Performance
        </Button>
        <RecordOptions />
      </div>
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
  const muteAll = useRuntime((s) => s.muteAll);
  const tipsEnabled = useUi((s) => s.tipsEnabled);
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

      <RecordGroup />

      <div className={styles.group}>
        <Knob spec={MASTER_VOLUME_SPEC} value={masterDb} size="sm" onChange={(v, info) => session.setMasterVolume(v, info.gesture)} label="Master" />
        <div className={styles.meters}>
          <Meter read={() => readMeterFrame().masterPeakL} label="Master left level" orientation="vertical" length={36} thickness={5} />
          <Meter read={() => readMeterFrame().masterPeakR} label="Master right level" orientation="vertical" length={36} thickness={5} />
        </div>
        <Button
          variant={muteAll ? 'danger' : 'secondary'}
          size="sm"
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
        <Switch
          label="Tips"
          hideLabel
          onText="Tips"
          offText="Tips"
          size="sm"
          tone="teal"
          checked={tipsEnabled}
          onChange={(on) => setTipsEnabled(on)}
          tip="Explanations like this one appear when you point at or tab to a control."
          detail="Remembered in this browser. Icon buttons still show their names when Tips are off."
          className={styles.tips}
        />
        <Button
          variant="ghost"
          size="sm"
          icon="folder"
          onClick={props.onOpenLibrary}
          tip={`Projects: open, rename, duplicate, import and export. Open now: ${projectName}.`}
          aria-label={`Projects (open: ${projectName})`}
          className={styles.project}
        >
          <span className={styles.projectName}>{projectName}</span>
        </Button>
        <Button variant="primary" size="sm" icon="download" onClick={props.onOpenExport} tip="Export a WAV file: your song, a scene or a recorded performance." className={styles.export}>
          <span className={styles.exportText}>Export</span>
        </Button>
      </div>
    </header>
  );
}
