/**
 * The transport strip, left to right in clear groups (docs/OMNI_UX.md):
 * views · Play/Pause, Stop and the position with its state word · tempo
 * (Swing in Advanced) · recording · master volume, meter and Mute All · the
 * Simple · Advanced switch, save state, Undo/Redo, Projects, Export and the
 * More menu. On narrower windows secondary controls move into the More menu
 * (it always holds Tips), so every control stays one press away without
 * squeezing the always-visible ones.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Button, Icon, IconButton, Knob, Meter, NumberField, SegmentedControl, Tooltip, useRafLoop } from '../../ui/components';
import { BPM_SPEC, MASTER_VOLUME_SPEC, SWING_SPEC } from '../../project/params';
import { setTipsEnabled, setUiMode, setView, type UiMode, type View } from '../../state/uiStore';
import { session, useAutosave, useHistory, useProject, useUi } from '../instance';
import { notify, transportWord, useOffline, useRuntime } from '../runtime';
import { PAUSE_UNAVAILABLE_MESSAGE } from '../session';
import type { MeterFrame } from '../../audio/contracts';
import { OfflineMenuItems, OfflineStatus } from './OfflineStatus';
import { RecordOptions, quantizeCaption, recordOptionsCaption } from './RecordOptions';
import { MOD_ARIA, MOD_KEY, MenuItem, MenuSeparator, MoreIcon, Popover, anchorFromElement } from './ClipMenu';
import { DevicesDialog, DevicesKey, midi } from './devices';
import { songTimelineBar, useSongPlan } from './arrange/songPlan';
import styles from './TransportBar.module.css';

const VIEW_OPTIONS = [
  { value: 'play', label: 'Play', tip: 'Play: the pads, the selected part’s sound and the keyboard.' },
  { value: 'shape', label: 'Shape', tip: 'Shape: the selected part’s sound in detail, its effects and cables.' },
  { value: 'arrange', label: 'Arrange', tip: 'Arrange: put scenes in order as a song, and replay recorded performances.' },
  { value: 'mix', label: 'Mix', tip: 'Mix: a channel strip per part, the master and mastering.' },
] as const;

const MODE_OPTIONS = [
  { value: 'simple', label: 'Simple', tip: 'Simple: the essentials, large. Nothing is lost: Advanced shows every control again.' },
  { value: 'advanced', label: 'Advanced', tip: 'Advanced: every control (swing, key and scale, arpeggiator, cables, pan …). Your music does not change.' },
] as const;

/** What the master meter's colours mean: red at the top is "near the ceiling", not a fault. */
export const MASTER_METER_TIP = 'What you hear, left and right. Amber is a healthy level. The red light at the top means the song is close to as loud as it can go, which is normal with a loud mastering preset.';
export const MASTER_METER_DETAIL = 'Red lights within about 3 dB of full scale. The output limiter still keeps every peak below −1 dBFS, so red does not mean distortion.';

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

/** "3.2" (bar.beat, from 1), or "Count" during a count-in. */
function positionText(tick: number, bar: number, beat: number): string {
  return tick < 0 ? 'Count' : `${bar + 1}.${beat + 1}`;
}

/** The transport's position; in song mode on the song timeline as the Arrange lane draws it. */
function transportPositionText(t: NonNullable<typeof session.transport>): string {
  const p = t.getPosition();
  const song = p.tick < 0 ? null : songTimelineBar(p.tick);
  if (song === null) return positionText(p.tick, p.bar, p.beat);
  const bar = Math.floor(song + 1e-9);
  return positionText(p.tick, bar, Math.min(3, Math.floor((song - bar) * 4 + 1e-9)));
}

/** The current position: Stopped at 1.1, the paused position, or the playhead while playing. */
function heldPositionText(): string {
  const t = session.transport;
  if (!t || !t.paused) return '1.1';
  return transportPositionText(t);
}

/** Bar.beat with the transport's state word above it (Playing / Paused / Stopped / Song / Replay). */
function Position() {
  const ref = useRef<HTMLSpanElement>(null);
  const playing = useRuntime((s) => s.playing);
  const paused = useRuntime((s) => s.paused);
  const mode = useRuntime((s) => s.mode);
  const word = transportWord({ playing, paused, mode });
  // A song edited while paused moves the paused position on the timeline: show it again.
  useSongPlan();
  const last = useRef('');
  useRafLoop(() => {
    const t = session.transport;
    if (!ref.current || !t) return;
    const text = transportPositionText(t);
    if (text !== last.current) {
      last.current = text;
      ref.current.textContent = text;
    }
  }, playing);
  if (!playing) last.current = '';
  return (
    <div className={styles.position} data-state={word.toLowerCase()} role="group" aria-label="Position">
      <span className={styles.posWord} role="status">
        {word}
      </span>
      <span ref={ref} className={`${styles.posValue} mono`} role="timer" aria-label="Bar and beat">
        {playing ? '' : heldPositionText()}
      </span>
    </div>
  );
}

/** One key: ▶ Play when stopped or paused, ❚❚ Pause while playing. */
function PlayPauseButton() {
  const playing = useRuntime((s) => s.playing);
  const paused = useRuntime((s) => s.paused);
  const mode = useRuntime((s) => s.mode);
  const take = useRuntime((s) => s.recording === 'performance');
  const blocked = playing && take;
  const tip = blocked
    ? PAUSE_UNAVAILABLE_MESSAGE
    : playing
      ? `Pause: hold the position${mode === 'song' ? ' in the song' : ''}. Play continues from exactly here, in time.`
      : paused
        ? 'Continue from where you paused, in time.'
        : 'Start the lit clips from bar 1.';
  return (
    <Button
      variant="transport"
      icon={playing ? 'pause' : 'play'}
      lit={playing}
      aria-disabled={blocked || undefined}
      onClick={() => (blocked ? notify(PAUSE_UNAVAILABLE_MESSAGE, 'warn') : void session.togglePlay())}
      tip={tip}
      detail="Space plays and pauses. Shift+Space stops."
      aria-keyshortcuts="Space"
      className={styles.play}
    >
      {playing ? 'Pause' : 'Play'}
    </Button>
  );
}

function StopButton() {
  const playing = useRuntime((s) => s.playing);
  const paused = useRuntime((s) => s.paused);
  const take = useRuntime((s) => s.recording === 'performance');
  const idle = !playing && !paused;
  return (
    <Button
      variant="transport"
      icon="stop"
      disabled={idle}
      onClick={() => session.stop()}
      tip={
        idle
          ? 'Stopped at bar 1.'
          : take
            ? 'Stop playback and the performance recording (the take is kept). Back to bar 1.'
            : 'Stop and go back to bar 1. The clips that were playing stay lit and start again from the top on Play.'
      }
      detail="Shift+Space also stops."
      aria-keyshortcuts="Shift+Space"
      className={styles.stop}
    >
      <span className={styles.stopText}>Stop</span>
    </Button>
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
          detail="Timing, metronome and count-in are in Recording options (the metronome button). With the part's arpeggiator on, the notes it plays are recorded. Pause also ends the pass."
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
          detail="Cables and sound choices are locked while recording so the take replays exactly. Pause is not available during a take; Mute All ends the recording."
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
 * The More menu: Tips, and whatever the strip has no room for at this width
 * (Undo and Redo below 1600 px, Projects, Export below 1280 px, the Simple ·
 * Advanced switch, the offline state and the Update action, which the key
 * marks when one waits). It always lists all of them, so each is one place to
 * look whatever the width.
 */
function MoreMenu(props: { onOpenLibrary(): void; onOpenExport(): void; onOpenDevices(): void; projectName: string }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const history = useHistory();
  const tipsEnabled = useUi((s) => s.tipsEnabled);
  const uiMode = useUi((s) => s.uiMode);
  const updateReady = useOffline().state === 'update-ready';
  const close = () => setOpen(false);
  return (
    <>
      <Tooltip name="More" tip={updateReady ? 'A new version is ready: Update is in this menu. Also Tips, Undo, Redo, your projects, WAV export and MIDI & audio.' : 'Tips, Undo, Redo, Simple or Advanced, your projects, WAV export, and MIDI keyboards and audio input.'}>
        <button
          ref={btnRef}
          type="button"
          className={styles.more}
          aria-label={updateReady ? 'More: update ready, undo, redo, tips, projects, export, MIDI and audio' : 'More: undo, redo, tips, projects, export, MIDI and audio'}
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
            icon="sliders"
            role="menuitemcheckbox"
            checked={uiMode === 'advanced'}
            hint={uiMode === 'advanced' ? 'Advanced' : 'Simple'}
            onSelect={() => {
              setUiMode(uiMode === 'advanced' ? 'simple' : 'advanced');
              close();
            }}
          >
            Show every control (Advanced)
          </MenuItem>
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
          <MenuSeparator />
          <MenuItem
            icon="midi"
            onSelect={() => {
              close();
              props.onOpenDevices();
            }}
          >
            MIDI & audio…
          </MenuItem>
        </Popover>
      )}
    </>
  );
}

export function TransportBar(props: { onOpenLibrary(): void; onOpenExport(): void }) {
  const view = useUi((s) => s.view);
  const uiMode = useUi((s) => s.uiMode);
  const bpm = useProject((p) => p.bpm);
  const swing = useProject((p) => p.swing);
  const masterDb = useProject((p) => p.masterVolumeDb);
  const projectName = useProject((p) => p.name);
  const muteAll = useRuntime((s) => s.muteAll);
  const takeRecording = useRuntime((s) => s.recording === 'performance');
  const history = useHistory();
  const advanced = uiMode === 'advanced';
  const [devicesOpen, setDevicesOpen] = useState(false);
  // MIDI devices reconnect by themselves on a later visit, but only if the browser already allows them.
  useEffect(() => {
    void midi.autoConnect();
  }, []);

  return (
    <header className={styles.bar} data-mode={uiMode} aria-label="Transport">
      <SegmentedControl<View> label="View" kind="tabs" options={VIEW_OPTIONS} value={view} onChange={(v) => setView(v)} size="lg" lamp={false} className={styles.views} />

      <div className={`${styles.group} ${styles.playback}`} role="group" aria-label="Playback">
        <PlayPauseButton />
        <StopButton />
        <Position />
      </div>

      <div className={styles.group} role="group" aria-label="Tempo">
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
          chars={4}
          tip={BPM_SPEC.tip}
          onChange={(v, info) => session.setBpm(v, info.gesture)}
        />
        {advanced && (
          <NumberField
            label="Swing"
            layout="stacked"
            value={Math.round(swing * 100)}
            min={0}
            max={100}
            step={1}
            unit="%"
            size="sm"
            chars={4}
            tip={SWING_SPEC.tip}
            detail={SWING_SPEC.detail}
            onChange={(v, info) => session.setSwing(v / 100, info.gesture)}
          />
        )}
      </div>

      <RecordGroup />

      <div className={`${styles.group} ${styles.output}`} role="group" aria-label="Output">
        <Knob spec={MASTER_VOLUME_SPEC} value={masterDb} size="sm" onChange={(v, info) => session.setMasterVolume(v, info.gesture)} label="Master" className={styles.master} />
        <Tooltip name="Master level" tip={MASTER_METER_TIP} detail={MASTER_METER_DETAIL}>
          <div className={styles.meters} role="group" aria-label="Master level" data-master-meters="">
            <Meter read={() => readMeterFrame().masterPeakL} label="Master left level" orientation="vertical" length={36} thickness={5} />
            <Meter read={() => readMeterFrame().masterPeakR} label="Master right level" orientation="vertical" length={36} thickness={5} />
          </div>
        </Tooltip>
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
        <SegmentedControl<UiMode>
          label="Simple or Advanced"
          options={MODE_OPTIONS}
          value={uiMode}
          onChange={(m) => setUiMode(m)}
          size="sm"
          lamp={false}
          className={styles.modeSwitch}
        />
        <SaveStatus />
        <IconButton
          icon="undo"
          label={history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo'}
          disabled={!history.canUndo}
          onClick={() => session.undo()}
          size="sm"
          variant="ghost"
          aria-keyshortcuts="Control+Z"
          className={styles.historyKey}
        />
        <IconButton
          icon="redo"
          label={history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo'}
          disabled={!history.canRedo}
          onClick={() => session.redo()}
          size="sm"
          variant="ghost"
          aria-keyshortcuts="Control+Shift+Z"
          className={styles.historyKey}
        />
        <Button
          variant="ghost"
          size="sm"
          icon="folder"
          onClick={props.onOpenLibrary}
          tip={`Projects: open, rename, duplicate, import and export. Open now: ${projectName}.`}
          aria-label={`Projects (open: ${projectName})`}
          className={`${styles.project} ${styles.projectKey}`}
        >
          <span className={styles.projectName}>{projectName}</span>
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon="download"
          onClick={props.onOpenExport}
          tip="Export a WAV file: your song, a scene or a recorded performance."
          className={styles.exportKey}
        >
          Export
        </Button>
        <DevicesKey onOpen={() => setDevicesOpen(true)} className={styles.devicesKey} />
        <MoreMenu onOpenLibrary={props.onOpenLibrary} onOpenExport={props.onOpenExport} onOpenDevices={() => setDevicesOpen(true)} projectName={projectName} />
        {/* The app's own state (offline copy, waiting update) closes the strip. */}
        <OfflineStatus statusClassName={styles.offline} updateClassName={styles.update} />
      </div>
      <DevicesDialog open={devicesOpen} onClose={() => setDevicesOpen(false)} />
    </header>
  );
}
