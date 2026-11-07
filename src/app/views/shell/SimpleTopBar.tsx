/**
 * The top bar in Simple (round 7, EASY_SPEC §1), left to right:
 * [Project ▾] [▶ Play / ❚❚ Pause] [■ Stop] [● Record] [↶] [↷] … [Share] [⋯].
 * Nothing else: no view tabs (the Song screen is the one home; other views
 * open as sheets from ⋯), no tempo box (Speed is in Project ▾), no master
 * knob or meters, no Mute All (⋯ › Mute all sound), no recording options
 * (Advanced), no Simple/Advanced switch (⋯ › Show every control).
 *
 * Play always plays the song (see simplePlay.ts). ● Record records what is
 * played on the selected instrument into the song from the playhead (2.4's
 * song recording, with its count-in); while it records the key reads
 * "Stop recording" and a line beside it says what records.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../ui/components';
import { session, useProject, useUi } from '../../instance';
import { useRuntime } from '../../runtime';
import { keysFor } from '../hints/shortcuts';
import { DevicesDialog, DevicesKey, midi } from '../devices';
import { HistoryKeys, useTransportHeight } from '../TransportBar';
import { MoreMenu } from './MoreMenu';
import { ProjectMenu } from './ProjectMenu';
import { playSimple } from './simplePlay';
import styles from './SimpleTopBar.module.css';

function PlayKey() {
  const playing = useRuntime((s) => s.playing);
  const take = useRuntime((s) => s.recording === 'performance');
  const blocked = playing && take;
  return (
    <Button
      variant="transport"
      icon={playing ? 'pause' : 'play'}
      lit={playing}
      aria-disabled={blocked || undefined}
      onClick={() => {
        if (!blocked) void playSimple();
      }}
      tip={blocked ? 'Pause waits until the take being recorded is stopped.' : playing ? 'Pause your song. Play carries on from here.' : 'Play your song.'}
      detail={`${keysFor('play')} plays and pauses. ${keysFor('stop')} stops.`}
      aria-keyshortcuts="Space"
      className={styles.play}
    >
      {playing ? 'Pause' : 'Play'}
    </Button>
  );
}

function StopKey() {
  const playing = useRuntime((s) => s.playing);
  const paused = useRuntime((s) => s.paused);
  const idle = !playing && !paused;
  return (
    <Button
      variant="transport"
      icon="stop"
      disabled={idle}
      onClick={() => session.stop()}
      tip={idle ? 'Stopped.' : 'Stop, and go back to where you started playing.'}
      detail={`${keysFor('stop')} also stops.`}
      aria-keyshortcuts="Shift+Space"
      className={styles.stop}
    >
      Stop
    </Button>
  );
}

/** The words beside ● Record while it records: what records, and where. */
export function simpleRecordLine(opts: { performance: boolean; countingIn: boolean; part: string; nothingHere: boolean }): string {
  if (opts.performance) return 'Recording a take';
  if (opts.countingIn) return `Get ready: ${opts.part} records after the count`;
  if (opts.nothingHere) return `${opts.part}: no loop here yet`;
  return `Recording ${opts.part} into your song`;
}

function RecordKey() {
  const recording = useRuntime((s) => s.recording);
  const countingIn = useRuntime((s) => s.countingIn || (s.recording === 'notes' && s.playing && s.recordStartsAtTick != null));
  const nothingHere = useRuntime((s) => s.recording === 'notes' && s.mode === 'song' && s.recordTargetAudible === false && !s.songRecording);
  const selected = useUi((s) => s.selectedTrackId);
  const targetId = useRuntime((s) => s.songRecording?.trackId ?? s.recordTarget?.trackId ?? null);
  const part = useProject((p) => p.tracks.find((t) => t.id === (targetId ?? selected))?.name ?? '');
  const on = recording !== 'off';
  const line = on ? simpleRecordLine({ performance: recording === 'performance', countingIn, part, nothingHere }) : null;
  return (
    <div className={styles.rec} role="group" aria-label="Recording">
      <Button
        variant="secondary"
        tone="coral"
        icon={on ? 'stop' : 'record'}
        pressed={on}
        aria-pressed={undefined}
        onClick={() => {
          if (recording === 'performance') void session.togglePerformance();
          else void session.toggleRecordNotes({ song: true });
        }}
        aria-label={on ? 'Stop recording' : `Record ${part} into the song`}
        tip={on ? 'Stop recording. What you played stays in the song; Undo takes it out in one step.' : `Record what you play on ${part || 'the selected instrument'} into your song, from where the song is now.`}
        detail="Play notes with your computer keys (A S D F …) or a MIDI keyboard. A short count comes first. Click an instrument’s name to choose what records."
        className={`${styles.recKey}${on ? ` ${styles.recOn}` : ''}`}
      >
        {on ? 'Stop recording' : 'Record'}
      </Button>
      {line && (
        <span className={styles.recLine} aria-live="polite">
          <span className={styles.recDot} aria-hidden="true" />
          {line}
        </span>
      )}
    </div>
  );
}

export interface SimpleTopBarProps {
  onOpenLibrary(): void;
  onNewProject(): void;
  onOpenShare(): void;
  onOpenHelp(): void;
  onOpenTakes(): void;
}

export function SimpleTopBar(props: SimpleTopBarProps) {
  const barRef = useRef<HTMLElement>(null);
  useTransportHeight(barRef);
  const [devicesOpen, setDevicesOpen] = useState(false);
  // MIDI devices reconnect by themselves on a later visit, but only if the browser already allows them.
  useEffect(() => {
    void midi.autoConnect();
  }, []);
  return (
    <header ref={barRef} className={styles.bar} data-mode="simple" aria-label="Transport">
      <ProjectMenu onOpenLibrary={props.onOpenLibrary} onNewProject={props.onNewProject} />
      <div className={styles.group} role="group" aria-label="Playback">
        <PlayKey />
        <StopKey />
      </div>
      <RecordKey />
      <div className={styles.group}>
        <HistoryKeys />
      </div>
      <div className={styles.right}>
        <DevicesKey onOpen={() => setDevicesOpen(true)} />
        <Button variant="primary" icon="upload" onClick={props.onOpenShare} tip="Share your song: save a music file to send, or the project to keep working on." className={styles.share}>
          Share
        </Button>
        <MoreMenu onOpenDevices={() => setDevicesOpen(true)} onOpenHelp={props.onOpenHelp} onOpenTakes={props.onOpenTakes} />
      </div>
      <DevicesDialog open={devicesOpen} onClose={() => setDevicesOpen(false)} />
    </header>
  );
}
