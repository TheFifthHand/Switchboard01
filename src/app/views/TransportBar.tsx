import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Button, Icon, IconButton, Knob, Meter, NumberField, SegmentedControl, Switch, Tooltip, useRafLoop } from '../../ui/components';
import { BPM_SPEC, MASTER_VOLUME_SPEC, SWING_SPEC } from '../../project/params';
import { setTipsEnabled, setView, type View } from '../../state/uiStore';
import { session, useAutosave, useHistory, useProject, useUi } from '../instance';
import { useOffline, useRuntime } from '../runtime';
import type { MeterFrame } from '../../audio/contracts';
import { OfflineMenuItems, OfflineStatus } from './OfflineStatus';
import { RecordOptions, quantizeCaption, recordOptionsCaption } from './RecordOptions';
import { MOD_ARIA, MOD_KEY, MenuItem, MenuSeparator, MoreIcon, Popover, anchorFromElement } from './ClipMenu';
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
  const mode = useRuntime((s) => s.mode);
  // The label says what drives playback: live pads, the arrangement (SONG) or a take (REPLAY).
  const label = playing && mode === 'song' ? 'SONG' : playing && mode === 'replay' ? 'REPLAY' : 'BAR.BEAT';
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
    <div className={styles.position} role="timer" aria-label={label === 'BAR.BEAT' ? 'Bar and beat' : `Bar and beat, playing the ${label === 'SONG' ? 'song' : 'recorded performance'}`}>
      <span className={`${styles.posLabel} ${label !== 'BAR.BEAT' ? styles.posMode : ''}`}>{label}</span>
      <span ref={ref} className={`${styles.posValue} mono`}>
        {playing ? '' : '1.1'}
      </span>
    </div>
  );
}

/**
 * "Saving failed" with its recovery actions. It stays while Try again or the
 * export is writing, so keyboard focus stays on the pressed button; when
 * saving works again it goes, and focus inside it returns to the save status.
 */
function SaveFailedPopover(props: { message?: string; returnFocus: RefObject<HTMLButtonElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  const { returnFocus } = props;
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (el?.contains(document.activeElement)) returnFocus.current?.focus();
    };
  }, [returnFocus]);
  return (
    <div ref={ref} className={styles.savePopover} role="alertdialog" aria-label="Saving failed">
      <p>{props.message}</p>
      <div className={styles.saveActions}>
        <Button size="sm" onClick={() => void session.autosaver?.retry()}>
          Try again
        </Button>
        <Button size="sm" variant="secondary" onClick={() => window.dispatchEvent(new CustomEvent('sb:export-project'))}>
          Export project file
        </Button>
      </div>
    </div>
  );
}

/** Saved / Saving… / Not saved, or Preview for the untouched first-launch starter (stored on its first change). */
function SaveStatus() {
  const save = useAutosave();
  const preview = useRuntime((s) => s.preview);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Set from a failed save until a save succeeds (also while Try again or the export is writing).
  const failing = save.lastError !== null;
  // Saving works again: the popover closes, and a later failure does not reopen it by itself.
  useEffect(() => {
    if (!failing) setOpen(false);
  }, [failing]);
  const error = save.status === 'error';
  const busy = !error && (save.status === 'saving' || save.dirty);
  const idlePreview = preview && !error && !busy;
  const text = error ? 'Not saved' : busy ? 'Saving…' : idlePreview ? 'Preview' : 'Saved';
  const tone = error ? styles.saveError : busy ? styles.saveBusy : idlePreview ? styles.savePreview : styles.saveOk;
  const tip = error
    ? save.lastError?.message
    : idlePreview
      ? 'This starter is a preview and is not stored yet. Your first change adds it to My projects; from then on it saves automatically in this browser.'
      : 'Your project saves automatically in this browser.';
  return (
    <div className={styles.saveWrap}>
      <Tooltip tip={tip} detail="Browser storage is working storage. Export a project file for a portable backup.">
        <button
          ref={btnRef}
          type="button"
          className={`${styles.save} ${tone}`}
          aria-live="polite"
          aria-label={idlePreview ? 'Autosave: Preview, not stored until you change it' : `Autosave: ${text}`}
          onClick={() => setOpen(error ? !open : false)}
        >
          {error ? <Icon name="warning" size={13} /> : <span className={styles.saveDot} aria-hidden />}
          <span className={styles.saveText}>{text}</span>
        </button>
      </Tooltip>
      {failing && open && <SaveFailedPopover message={save.lastError?.message} returnFocus={btnRef} />}
    </div>
  );
}

/** Record Notes, Record Performance and their options, with the recording status as the caption. */
function RecordGroup() {
  const recording = useRuntime((s) => s.recording);
  const countingIn = useRuntime((s) => s.countingIn);
  const targetId = useRuntime((s) => s.recordTarget?.trackId ?? null);
  // The clip to record into was chosen while another one played: it (and recording) starts at the next bar.
  const waiting = useRuntime((s) => s.recordTarget !== null && s.playing && (s.tracks[s.recordTarget.trackId]?.playingSlot ?? null) !== s.recordTarget.slot);
  const targetName = useProject((p) => (targetId ? (p.tracks.find((t) => t.id === targetId)?.name ?? '') : ''));
  const options = useProject((p) => recordOptionsCaption(p.settings));
  const quantize = useProject((p) => p.settings.recordQuantize);
  // With the part's arpeggiator on, the notes it plays are recorded on its own grid (Record Notes timing does not apply).
  const arpGrid = useProject((p) => {
    const t = targetId ? p.tracks.find((x) => x.id === targetId) : undefined;
    return t && t.arp.enabled && t.instrument.kind !== 'drums' ? t.arp.division : null;
  });
  // Short enough to fit above the buttons with the grid: the pressed Notes key says what records.
  const caption =
    recording === 'notes'
      ? countingIn
        ? `Count-in · ${targetName}`
        : waiting
          ? `Next bar · ${targetName}`
          : `Recording · ${targetName}`
      : recording === 'performance'
        ? 'Recording performance'
        : options
          ? `Record · ${options}`
          : 'Record';
  // The grid notes land on is always in view while notes record (Record Notes timing, set in Recording
  // options, or the arpeggiator's rate), and otherwise once the timing differs from the usual 1/16.
  // It never gets cut off: the text before it does.
  const snap =
    recording === 'notes' && arpGrid
      ? `Arp ${arpGrid}`
      : recording === 'notes' || (recording === 'off' && quantize !== '1/16')
        ? quantizeCaption(quantize)
        : null;
  return (
    <div className={`${styles.group} ${styles.recGroup}`} role="group" aria-label="Recording">
      <span className={styles.recCaption} data-live={recording !== 'off' || undefined} aria-live="polite">
        {recording !== 'off' && <span className={styles.recDot} aria-hidden="true" />}
        <span className={styles.recText}>{caption}</span>
        {/* The leading space keeps the words apart for screen readers; on screen the gap does. */}
        {snap && <span className={styles.recSnap}>{` · ${snap}`}</span>}
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
          tip={recording === 'notes' ? 'Stop recording notes. Undo then removes the whole pass in one step.' : 'Record what you play on the keyboard or drum pads into the selected clip.'}
          detail="Timing, metronome and count-in are in Recording options (the metronome button). With the part's arpeggiator on, the notes it plays are recorded."
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
          detail="Cables and sound choices are locked while recording so the take replays exactly. Mute All ends the recording."
          className={recording === 'performance' ? styles.recActive : undefined}
        >
          Performance
        </Button>
        <RecordOptions />
      </div>
    </div>
  );
}

/**
 * Narrow screens (below 1320 px, e.g. 200 % zoom): Undo, Redo, Tips,
 * Projects and Export move into this menu so every control stays reachable
 * without squeezing the always-visible transport controls. It also lists the
 * offline state and, when a new version waits, the Update action (marked on
 * the key itself), for widths where the strip has no room for them.
 */
function MoreMenu(props: { onOpenLibrary(): void; onOpenExport(): void; projectName: string }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const history = useHistory();
  const tipsEnabled = useUi((s) => s.tipsEnabled);
  const updateReady = useOffline().state === 'update-ready';
  const close = () => setOpen(false);
  return (
    <>
      <Tooltip name="More" tip={updateReady ? 'A new version is ready: Update is in this menu. Also Undo, Redo, Tips, your projects and WAV export.' : 'Undo, Redo, Tips, your projects and WAV export.'}>
        <button
          ref={btnRef}
          type="button"
          className={`${styles.more} ${styles.narrowOnly}`}
          aria-label={updateReady ? 'More: update ready, undo, redo, tips, projects and export' : 'More: undo, redo, tips, projects and export'}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <MoreIcon size={16} />
          {updateReady && <span className={styles.moreBadge} aria-hidden="true" />}
        </button>
      </Tooltip>
      {open && (
        <Popover anchor={anchorFromElement(btnRef.current)} label="More" align="end" onClose={close} returnFocus={btnRef.current} ignore={btnRef.current}>
          <OfflineMenuItems onDone={close} />
          <MenuItem
            icon="undo"
            hint={`${MOD_KEY}Z`}
            keyShortcut={`${MOD_ARIA}+Z`}
            disabled={!history.canUndo}
            disabledReason="Nothing to undo"
            onSelect={() => {
              session.undo();
              close();
            }}
          >
            {history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo'}
          </MenuItem>
          <MenuItem
            icon="redo"
            hint={`${MOD_KEY}Shift+Z`}
            keyShortcut={`${MOD_ARIA}+Shift+Z`}
            disabled={!history.canRedo}
            disabledReason="Nothing to redo"
            onSelect={() => {
              session.redo();
              close();
            }}
          >
            {history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon="info"
            role="menuitemcheckbox"
            checked={tipsEnabled}
            hint={tipsEnabled ? 'On' : 'Off'}
            onSelect={() => {
              setTipsEnabled(!tipsEnabled);
              close();
            }}
          >
            Tips
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon="folder"
            hint={props.projectName}
            onSelect={() => {
              close();
              props.onOpenLibrary();
            }}
          >
            Projects…
          </MenuItem>
          <MenuItem
            icon="download"
            onSelect={() => {
              close();
              props.onOpenExport();
            }}
          >
            Export WAV…
          </MenuItem>
        </Popover>
      )}
    </>
  );
}

export function TransportBar(props: { onOpenLibrary(): void; onOpenExport(): void }) {
  const view = useUi((s) => s.view);
  const bpm = useProject((p) => p.bpm);
  const swing = useProject((p) => p.swing);
  const masterDb = useProject((p) => p.masterVolumeDb);
  const projectName = useProject((p) => p.name);
  const playing = useRuntime((s) => s.playing);
  const muteAll = useRuntime((s) => s.muteAll);
  const takeRecording = useRuntime((s) => s.recording === 'performance');
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
        <Knob spec={MASTER_VOLUME_SPEC} value={masterDb} size="sm" onChange={(v, info) => session.setMasterVolume(v, info.gesture)} label="Master" className={styles.master} />
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
          tip={
            muteAll
              ? 'Everything is silenced. Press to hear sound again.'
              : takeRecording
                ? 'Silence everything at once, including echoes and held notes. This also ends the performance recording, keeping what came before.'
                : 'Silence everything at once, including echoes and held notes.'
          }
          className={styles.muteAll}
        >
          {muteAll ? 'MUTED' : 'Mute All'}
        </Button>
      </div>

      <div className={styles.right}>
        <SaveStatus />
        <IconButton
          icon="undo"
          label={history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo'}
          disabled={!history.canUndo}
          onClick={() => session.undo()}
          size="sm"
          variant="ghost"
          aria-keyshortcuts="Control+Z"
          className={styles.wideOnly}
        />
        <IconButton
          icon="redo"
          label={history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo'}
          disabled={!history.canRedo}
          onClick={() => session.redo()}
          size="sm"
          variant="ghost"
          aria-keyshortcuts="Control+Shift+Z"
          className={styles.wideOnly}
        />
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
          className={`${styles.tips} ${styles.wideOnly}`}
        />
        <Button
          variant="ghost"
          size="sm"
          icon="folder"
          onClick={props.onOpenLibrary}
          tip={`Projects: open, rename, duplicate, import and export. Open now: ${projectName}.`}
          aria-label={`Projects (open: ${projectName})`}
          className={`${styles.project} ${styles.wideOnly}`}
        >
          <span className={styles.projectName}>{projectName}</span>
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon="download"
          onClick={props.onOpenExport}
          tip="Export a WAV file: your song, a scene or a recorded performance."
          className={`${styles.export} ${styles.wideOnly}`}
        >
          <span className={styles.exportText}>Export</span>
        </Button>
        <MoreMenu onOpenLibrary={props.onOpenLibrary} onOpenExport={props.onOpenExport} projectName={projectName} />
        {/* The app's own state (offline copy, waiting update) closes the strip. */}
        <OfflineStatus statusClassName={styles.offline} updateClassName={styles.update} />
      </div>
    </header>
  );
}
