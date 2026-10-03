/**
 * The transport strip, left to right in clear groups (docs/OMNI_UX.md):
 * views · Play/Pause, Stop and the position with its state word · tempo
 * (Swing in Advanced) · recording · master volume, meter and Mute All · the
 * Simple · Advanced switch, save state, Undo/Redo, Projects, Export and the
 * More menu. On narrower windows secondary controls move into the More menu
 * (it always holds Tips), so every control stays one press away without
 * squeezing the always-visible ones.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Button, Icon, Knob, Meter, NumberField, SegmentedControl, Tooltip, useRafLoop } from '../../ui/components';
import { BPM_SPEC, MASTER_VOLUME_SPEC, SWING_SPEC } from '../../project/params';
import { setTipsEnabled, setUiMode, setView, type UiMode, type View } from '../../state/uiStore';
import { session, useAutosave, useHistory, useProject, useUi } from '../instance';
import { notify, runtimeStore, transportWord, useOffline, useRuntime, type RuntimeState } from '../runtime';
import { PAUSE_UNAVAILABLE_MESSAGE } from '../session';
import type { MeterFrame } from '../../audio/contracts';
import { OfflineMenuItems, OfflineMenuStatus, OfflineStatus } from './OfflineStatus';
import { keysFor } from './hints/shortcuts';
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

/** Silence, before audio starts. Read-only. */
const SILENT_FRAME: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
/**
 * The meter frame of this animation frame: one engine read per frame, shared
 * with every other meter in the app (session.readMetersShared). Read-only.
 */
export function readMeterFrame(): MeterFrame {
  return session.readMetersShared() ?? SILENT_FRAME;
}

/** Nothing sounds and nothing is about to: no part plays a clip or has one queued (a Blank project, a scene with no clips). */
export function nothingToPlay(s: Pick<RuntimeState, 'tracks'>): boolean {
  for (const t of Object.values(s.tracks)) if (t.playingSlot !== null || (t.queued !== null && t.queued.slot !== null)) return false;
  return true;
}
/** "Nothing to play yet" waits this long, so the moment between Play and the first clip starting never shows it. */
const NOTHING_DELAY_MS = 600;

/**
 * True while the transport plays the pads with nothing sounding or about to
 * ("Nothing to play yet"), once that has lasted NOTHING_DELAY_MS. The tab's
 * title reads it too, so its ▶ agrees with the strip.
 */
export function useNothingToPlay(): boolean {
  const silent = useRuntime((s) => s.playing && s.mode === 'live' && nothingToPlay(s));
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    if (!silent) {
      setEmpty(false);
      return;
    }
    const t = window.setTimeout(() => setEmpty(nothingToPlay(runtimeStore.getState())), NOTHING_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [silent]);
  return silent && empty;
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

/**
 * Bar.beat with the transport's state word above it (Playing / Paused /
 * Stopped / Song / Replay). Playing with no clip sounding or waiting in any
 * part (a Blank project, a scene with no clips), it says "Nothing to play
 * yet" instead: the pads and keys still play, but the transport plays nothing.
 */
function Position() {
  const ref = useRef<HTMLSpanElement>(null);
  const playing = useRuntime((s) => s.playing);
  const paused = useRuntime((s) => s.paused);
  const mode = useRuntime((s) => s.mode);
  const nothing = useNothingToPlay();
  const word = nothing ? 'Nothing to play yet' : transportWord({ playing, paused, mode });
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
    <div className={styles.position} data-state={nothing ? 'empty' : word.toLowerCase()} role="group" aria-label="Position">
      <span className={styles.posWord} role="status">
        {word}
      </span>
      <span ref={ref} className={`${styles.posValue} mono`} role="timer" aria-label="Bar and beat" aria-hidden={nothing || undefined}>
        {playing ? '' : heldPositionText()}
      </span>
    </div>
  );
}

/**
 * One key: ▶ Play when stopped or paused, ❚❚ Pause while playing. In Arrange
 * (with blocks in the song) it plays the song, from the loop when one is set;
 * after a pause it continues whatever was playing.
 */
function PlayPauseButton() {
  const playing = useRuntime((s) => s.playing);
  const paused = useRuntime((s) => s.paused);
  const mode = useRuntime((s) => s.mode);
  const take = useRuntime((s) => s.recording === 'performance');
  const looping = useRuntime((s) => s.songLoop !== null);
  const arrange = useUi((s) => s.view === 'arrange');
  const hasSong = useProject((p) => p.arrangement.blocks.length > 0);
  const blocked = playing && take;
  // Play here starts the song (not the pads): its name and tip say so.
  const song = arrange && hasSong && !playing && !paused;
  const tip = blocked
    ? PAUSE_UNAVAILABLE_MESSAGE
    : playing
      ? `Pause: hold the position${mode === 'song' ? ' in the song' : ''}. Play continues from exactly here, in time.`
      : paused
        ? `Continue ${mode === 'song' ? 'the song ' : ''}from where you paused, in time.`
        : song
          ? `Play song: the blocks below in order, ${looping ? 'starting at the loop' : 'from the first one'}.`
          : 'Start the lit clips from bar 1.';
  return (
    <Button
      variant="transport"
      icon={playing ? 'pause' : 'play'}
      lit={playing}
      aria-disabled={blocked || undefined}
      aria-label={song ? 'Play song' : undefined}
      onClick={() => (blocked ? notify(PAUSE_UNAVAILABLE_MESSAGE, 'warn') : void session.togglePlay({ song: arrange }))}
      tip={tip}
      detail={song ? `${keysFor('play')} plays the song in Arrange and pauses it. ${keysFor('stop')} stops.` : `${keysFor('play')} plays and pauses. ${keysFor('stop')} stops.`}
      aria-keyshortcuts="Space"
      className={styles.play}
      data-song={song || undefined}
    >
      {song ? (
        <span className={styles.playWord}>
          Play
          {/* The leading space keeps the words apart for screen readers and copy; on screen they stack. */}
          <span className={styles.playSong}> song</span>
        </span>
      ) : playing ? (
        'Pause'
      ) : (
        'Play'
      )}
    </Button>
  );
}

function StopButton() {
  const playing = useRuntime((s) => s.playing);
  const paused = useRuntime((s) => s.paused);
  const take = useRuntime((s) => s.recording === 'performance');
  const song = useRuntime((s) => s.mode === 'song');
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
            : song
              ? 'Stop the song and go back to its start. Play (or Space) in Arrange plays it again.'
              : 'Stop and go back to bar 1. The clips that were playing stay lit and start again from the top on Play.'
      }
      detail={`${keysFor('stop')} also stops.`}
      aria-keyshortcuts="Shift+Space"
      className={styles.stop}
    >
      <span className={styles.stopText}>Stop</span>
    </Button>
  );
}

/**
 * "Saving failed" with its recovery actions, on the shared Popover (a
 * non-modal dialog: Esc and a press outside close it, focus goes back to
 * the save state). It stays while Try again or the export is writing, so
 * keyboard focus stays on the pressed button; when saving works again it
 * goes.
 */
function SaveFailedPopover(props: { message?: string; anchor: HTMLButtonElement | null; onClose(): void }) {
  return (
    <Popover anchor={anchorFromElement(props.anchor)} label="Saving failed" role="dialog" align="end" onClose={props.onClose} returnFocus={props.anchor} ignore={props.anchor} className={styles.savePopover}>
      <p className={styles.saveMessage} role="alert">
        {props.message}
      </p>
      <div className={styles.saveActions}>
        <Button size="sm" onClick={() => void session.autosaver?.retry()} data-autofocus="">
          Try again
        </Button>
        <Button size="sm" variant="secondary" onClick={() => window.dispatchEvent(new CustomEvent('sb:export-project'))}>
          Export project file
        </Button>
      </div>
    </Popover>
  );
}

/**
 * The save state's glyph: a shape per state in neutral ink, so colour is
 * never alone (and the button's name says it in words): a check (Saved), a
 * small arc that turns (Saving; still under reduced motion), a hollow ring
 * (Preview: not stored yet), a coral warning (Not saved).
 */
function SaveGlyph({ state }: { state: 'saved' | 'saving' | 'preview' | 'error' }) {
  if (state === 'error') return <Icon name="warning" size={14} />;
  if (state === 'saved') return <Icon name="check" size={14} className={styles.saveGlyph} />;
  if (state === 'preview') return <span className={styles.saveRing} aria-hidden="true" />;
  return (
    <svg className={styles.saveSpin} width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M8 2.6 A5.4 5.4 0 1 1 2.6 8" />
    </svg>
  );
}

/**
 * Saved / Saving… / Not saved, or Preview for the untouched first-launch
 * starter (stored on its first change). Pressing it opens your projects; when
 * saving failed it says why and how to recover.
 */
function SaveStatus(props: { onOpenLibrary(): void }) {
  const save = useAutosave();
  const preview = useRuntime((s) => s.preview);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const actionId = useId();
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
  const state = error ? 'error' : busy ? 'saving' : idlePreview ? 'preview' : 'saved';
  const tone = error ? styles.saveError : busy ? styles.saveBusy : idlePreview ? styles.savePreview : styles.saveOk;
  const tip = error
    ? save.lastError?.message
    : idlePreview
      ? 'This starter is a preview and is not stored yet. Your first change adds it to My projects; from then on it saves automatically in this browser.'
      : 'Your project saves automatically in this browser. Press for your projects.';
  return (
    <div className={styles.saveWrap}>
      <Tooltip tip={tip} detail={`Browser storage is working storage. Export a project file for a portable backup. ${keysFor('save')} saves at once.`}>
        <button
          ref={btnRef}
          type="button"
          className={`${styles.save} ${tone}`}
          aria-live="polite"
          aria-label={idlePreview ? 'Autosave: Preview, not stored until you change it' : `Autosave: ${text}`}
          aria-describedby={actionId}
          aria-haspopup="dialog"
          aria-expanded={error ? open : undefined}
          data-save={state}
          onClick={() => {
            if (error) setOpen((o) => !o);
            else props.onOpenLibrary();
          }}
        >
          <SaveGlyph state={state} />
          <span className={styles.saveText}>{text}</span>
        </button>
      </Tooltip>
      {/* What pressing it does (the library opens, or why saving failed). */}
      <span id={actionId} hidden>
        {error ? 'Opens why it was not saved and how to recover.' : 'Opens your projects.'}
      </span>
      {failing && open && <SaveFailedPopover message={save.lastError?.message} anchor={btnRef.current} onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * While Record Notes waits for its downbeat (the clip's launch at the next
 * bar, or the end of a count-in), the beats left before recording starts, as
 * heard (runtime.recordStartsAtTick against the audible position).
 */
function beatsLeft(startsAt: number): number | null {
  const t = session.transport;
  if (!t || !t.playing) return null;
  const left = startsAt - t.audibleTick();
  return left > 0 ? Math.ceil(left / 96 - 1e-6) : null;
}

/** "Recording in 3…": the count down to the downbeat, updated by the audio clock's position (no re-render per beat). */
function RecordCountdown(props: { startsAt: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef<number | null>(null);
  const write = () => {
    const n = beatsLeft(props.startsAt);
    if (n === last.current || !ref.current) return;
    last.current = n;
    ref.current.textContent = n === null ? 'Recording' : `Recording in ${n}…`;
  };
  useLayoutEffect(() => {
    last.current = -1;
    write();
  });
  useRafLoop(write, true);
  return <span ref={ref} aria-hidden="true" />;
}

/** Record Notes, Record Performance and their options, with the recording status as the caption. */
function RecordGroup() {
  const recording = useRuntime((s) => s.recording);
  const countingIn = useRuntime((s) => s.countingIn);
  const targetId = useRuntime((s) => s.recordTarget?.trackId ?? null);
  // Record Notes waits for its downbeat: the caption counts the beats down.
  const startsAt = useRuntime((s) => (s.recording === 'notes' && s.playing && s.recordStartsAtTick != null ? s.recordStartsAtTick : null));
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
      ? startsAt !== null
        ? null
        : countingIn
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
        {caption !== null ? (
          <span className={styles.recText}>{caption}</span>
        ) : (
          <span className={styles.recText}>
            <RecordCountdown startsAt={startsAt!} />
            {/* Read out once (the count itself is not, beat by beat). */}
            <span className="visually-hidden">Recording starts on the downbeat</span>
            {` · ${targetName}`}
          </span>
        )}
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
 * The More menu: a waiting Update first, then Undo and Redo, Simple or
 * Advanced and Tips, New project…, Projects…, Export WAV…, MIDI & audio…
 * and Help…, and last the offline state as plain text. It lists everything
 * the strip has no room for at this width (the Simple · Advanced switch and
 * Export below 1366 px, Projects below 1440 px, MIDI & audio, and the Update
 * action below 1600 px, which the key marks with a coral dot), so each is
 * one place to look whatever the width.
 */
/**
 * Opening a menu gives focus to its first item that can be used (Undo comes
 * first and often has nothing to undo). It runs before the menu's own
 * focusing, which then leaves it be.
 */
function FocusFirstUsable() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current?.closest<HTMLElement>('[role="menu"]');
    if (!menu || menu.contains(document.activeElement)) return;
    menu.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus({ preventScroll: true });
  }, []);
  return <span ref={ref} hidden />;
}

function MoreMenu(props: { onOpenLibrary(): void; onNewProject(): void; onOpenExport(): void; onOpenDevices(): void; onOpenHelp(): void; projectName: string }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const history = useHistory();
  const tipsEnabled = useUi((s) => s.tipsEnabled);
  const uiMode = useUi((s) => s.uiMode);
  const updateReady = useOffline().state === 'update-ready';
  const close = () => setOpen(false);
  /** Close the menu, then run the action (dialogs open with the menu gone, so focus goes to them). */
  const then = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <>
      <Tooltip name="More" tip={updateReady ? 'A new version is ready: Update is in this menu. Also Undo, Redo, Tips, projects, WAV export, MIDI & audio and Help.' : 'Undo, Redo, Simple or Advanced, Tips, a new project, your projects, WAV export, MIDI & audio, and Help.'}>
        <button
          ref={btnRef}
          type="button"
          className={styles.more}
          aria-label={updateReady ? 'More: update ready, undo, redo, tips, projects, export, MIDI and audio, help' : 'More: undo, redo, tips, projects, export, MIDI and audio, help'}
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
          <FocusFirstUsable />
          <OfflineMenuItems onDone={close} />
          <MenuItem
            icon="undo"
            hint={keysFor('undo', MOD_KEY === '⌘')}
            keyShortcut={`${MOD_ARIA}+Z`}
            disabled={!history.canUndo}
            disabledReason="Nothing to undo"
            onSelect={then(() => session.undo())}
          >
            {history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo'}
          </MenuItem>
          <MenuItem
            icon="redo"
            hint={`${MOD_KEY}Shift+Z`}
            keyShortcut={`${MOD_ARIA}+Shift+Z`}
            disabled={!history.canRedo}
            disabledReason="Nothing to redo"
            onSelect={then(() => session.redo())}
          >
            {history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon="sliders"
            role="menuitemcheckbox"
            checked={uiMode === 'advanced'}
            hint={uiMode === 'advanced' ? 'Advanced' : 'Simple'}
            onSelect={then(() => switchMode(uiMode === 'advanced' ? 'simple' : 'advanced'))}
          >
            Show every control (Advanced)
          </MenuItem>
          <MenuItem icon="info" role="menuitemcheckbox" checked={tipsEnabled} hint={tipsEnabled ? 'On' : 'Off'} onSelect={then(() => setTipsEnabled(!tipsEnabled))}>
            Tips
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon="plus" hint="Starters" onSelect={then(props.onNewProject)}>
            New project…
          </MenuItem>
          <MenuItem icon="folder" hint={props.projectName} onSelect={then(props.onOpenLibrary)}>
            Projects…
          </MenuItem>
          <MenuItem icon="download" onSelect={then(props.onOpenExport)}>
            Export WAV…
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon="midi" onSelect={then(props.onOpenDevices)}>
            MIDI & audio…
          </MenuItem>
          <MenuItem icon="keys" hint="?" keyShortcut="?" onSelect={then(props.onOpenHelp)}>
            Help…
          </MenuItem>
          {/* The app's own state closes the menu, as plain text. */}
          <OfflineMenuStatus />
        </Popover>
      )}
    </>
  );
}

/** Simple or Advanced: playback is braced first (every view re-renders), and the switch shows at once. */
function switchMode(mode: UiMode): void {
  session.brace();
  setUiMode(mode);
}

/** Another view: playback is braced first (the new view mounts), then the tab changes at once. */
function switchView(view: View): void {
  session.brace();
  setView(view);
}

/**
 * Undo and Redo, always on the strip: an icon and the word where there is
 * room (from 1600 px), the icon alone (its name still "Undo …", its tooltip
 * naming the step) narrower or where a waiting update, a failed save or the
 * MIDI & audio key needs the room.
 * Unavailable, they stay focusable and their tip says why ("Nothing to
 * undo", or the take lock); available, the tip names the step ("Undo: Move
 * block").
 */
function HistoryKey(props: { kind: 'undo' | 'redo' }) {
  const { kind } = props;
  const history = useHistory();
  const undo = kind === 'undo';
  const can = undo ? history.canUndo : history.canRedo;
  const what = undo ? history.undoLabel : history.redoLabel;
  const word = undo ? 'Undo' : 'Redo';
  const tip = can
    ? `${word}: ${what ?? 'the last change'}.`
    : what && history.lock
      ? `${word} waits: ${history.lock}`
      : undo
        ? 'Nothing to undo yet.'
        : 'Nothing to redo: Redo brings back a step you undid.';
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={kind}
      aria-disabled={!can || undefined}
      aria-label={can && what ? `${word} ${what}` : word}
      aria-keyshortcuts={undo ? `${MOD_ARIA}+Z` : `${MOD_ARIA}+Shift+Z ${MOD_ARIA}+Y`}
      onClick={() => {
        if (!can) return;
        if (undo) session.undo();
        else session.redo();
      }}
      tip={tip}
      detail={keysFor(undo ? 'undo' : 'redo', MOD_KEY === '⌘')}
      className={styles.historyKey}
      data-history={kind}
    >
      <span className={styles.historyWord}>{word}</span>
    </Button>
  );
}

function HistoryKeys() {
  return (
    <div className={styles.history} role="group" aria-label="Undo and redo">
      <HistoryKey kind="undo" />
      <HistoryKey kind="redo" />
    </div>
  );
}

export interface TransportBarProps {
  onOpenLibrary(): void;
  onOpenExport(): void;
  /** New project…: the project library's Starters. */
  onNewProject?(): void;
  /** Help… (also the ? key). */
  onOpenHelp?(): void;
}

/**
 * How far down the top chrome reaches on screen, on the page root
 * (--transport-h): the strip's bottom edge, or the bottom of the banners the
 * shell shows right under it (a project open in another tab, playback
 * stopped: [data-banners], the strip's next sibling) while they are in view.
 * Toasts sit just under it (Toast.module.css), so they never hide a banner's
 * keys, and never float down where a banner was once the page has scrolled
 * it away (below 1024 px the strip is sticky and the banners scroll). Kept
 * up to date as the strip wraps or grows, as banners come and go, and as
 * the page scrolls.
 */
function useTransportHeight(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const below = el.nextElementSibling instanceof HTMLElement && el.nextElementSibling.matches('[data-banners]') ? el.nextElementSibling : null;
    let last = -1;
    let frame = 0;
    const write = () => {
      frame = 0;
      const bar = el.getBoundingClientRect().bottom;
      const banners = below && below.getBoundingClientRect().height > 0 ? below.getBoundingClientRect().bottom : bar;
      const h = Math.max(0, Math.ceil(Math.max(bar, banners)));
      if (h === last) return;
      last = h;
      root.style.setProperty('--transport-h', `${h}px`);
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(write);
    };
    write();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(write) : null;
    ro?.observe(el);
    if (below) ro?.observe(below);
    window.addEventListener('scroll', soon, { capture: true, passive: true });
    return () => {
      ro?.disconnect();
      window.removeEventListener('scroll', soon, { capture: true });
      cancelAnimationFrame(frame);
      root.style.removeProperty('--transport-h');
    };
  }, [ref]);
}

export function TransportBar(props: TransportBarProps) {
  const barRef = useRef<HTMLElement>(null);
  useTransportHeight(barRef);
  const view = useUi((s) => s.view);
  const uiMode = useUi((s) => s.uiMode);
  const bpm = useProject((p) => p.bpm);
  const swing = useProject((p) => p.swing);
  const masterDb = useProject((p) => p.masterVolumeDb);
  const projectName = useProject((p) => p.name);
  const muteAll = useRuntime((s) => s.muteAll);
  const takeRecording = useRuntime((s) => s.recording === 'performance');
  const advanced = uiMode === 'advanced';
  const [devicesOpen, setDevicesOpen] = useState(false);
  // MIDI devices reconnect by themselves on a later visit, but only if the browser already allows them.
  useEffect(() => {
    void midi.autoConnect();
  }, []);

  return (
    <header ref={barRef} className={styles.bar} data-mode={uiMode} aria-label="Transport">
      <SegmentedControl<View> label="View" kind="tabs" options={VIEW_OPTIONS} value={view} onChange={switchView} size="lg" lamp={false} className={styles.views} />

      <div className={`${styles.group} ${styles.playback}`} role="group" aria-label="Playback">
        <PlayPauseButton />
        <StopButton />
        <Position />
      </div>

      {/* Enter commits and hands the keys back (Space plays, letters play notes); a drag moves in whole BPM (Shift: tenths). */}
      <div className={`${styles.group} ${styles.tempoGroup}`} role="group" aria-label="Tempo">
        <NumberField
          label="Tempo"
          layout="stacked"
          value={bpm}
          min={BPM_SPEC.min}
          max={BPM_SPEC.max}
          step={1}
          fineStep={0.1}
          dragStep={1}
          blurOnCommit
          unit="BPM"
          size="sm"
          chars={4}
          tip={BPM_SPEC.tip}
          onChange={(v, info) => session.setBpm(v, info.gesture)}
          className={styles.tempo}
        />
        {advanced && (
          <NumberField
            label="Swing"
            layout="stacked"
            value={Math.round(swing * 100)}
            min={0}
            max={100}
            step={1}
            dragStep={1}
            blurOnCommit
            unit="%"
            size="sm"
            chars={4}
            tip={SWING_SPEC.tip}
            detail={SWING_SPEC.detail}
            onChange={(v, info) => session.setSwing(v / 100, info.gesture)}
            className={styles.swing}
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
          onChange={switchMode}
          size="sm"
          lamp={false}
          className={styles.modeSwitch}
        />
        <SaveStatus onOpenLibrary={props.onOpenLibrary} />
        <HistoryKeys />
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
          tip={view === 'arrange' ? 'Export the song as a WAV file (a scene or a recorded performance can be chosen instead).' : 'Export a WAV file: your song, a scene or a recorded performance.'}
          className={styles.exportKey}
        >
          Export
        </Button>
        <DevicesKey onOpen={() => setDevicesOpen(true)} className={styles.devicesKey} />
        <MoreMenu
          onOpenLibrary={props.onOpenLibrary}
          onNewProject={props.onNewProject ?? props.onOpenLibrary}
          onOpenExport={props.onOpenExport}
          onOpenDevices={() => setDevicesOpen(true)}
          onOpenHelp={props.onOpenHelp ?? (() => window.dispatchEvent(new CustomEvent('sb:open-help')))}
          projectName={projectName}
        />
        {/* The app's own state (offline copy, waiting update) closes the strip. */}
        <OfflineStatus statusClassName={styles.offline} updateClassName={styles.update} />
      </div>
      <DevicesDialog open={devicesOpen} onClose={() => setDevicesOpen(false)} />
    </header>
  );
}
