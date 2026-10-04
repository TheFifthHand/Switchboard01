/**
 * Record audio onto a sampler part: from a microphone or an instrument, in
 * time with the music. An optional one-bar count-in, then 1, 2, 4 or 8 bars
 * from a downbeat; the take goes into its own clip on the part, which plays
 * it from the downbeat, and the part's other clips keep their recordings
 * (one undo step; capability-01). Input choice, level, monitoring and the
 * recording offset are in MIDI & audio.
 */
import { useId, useRef, useState } from 'react';
import { Button, Icon, SegmentedControl, Switch, useRafLoop } from '../../../ui/components';
import type { Id } from '../../../project/types';
import { shallowEqual } from '../../../state/store';
import { RECORD_BAR_CHOICES, type RecordBars, type TakeInfo } from '../../audioInput';
import { session } from '../../instance';
import { useRuntime } from '../../runtime';
import { DevicesDialog, audioInput, useAudioInput } from '../devices';
import styles from './RecordEdit.module.css';

type BarsValue = `${RecordBars}`;
const BAR_OPTIONS = RECORD_BAR_CHOICES.map((b) => ({ value: String(b) as BarsValue, label: String(b), tip: `Record ${b} bar${b === 1 ? '' : 's'}.` }));

/** What Record audio does with the take (its tooltip). */
export const TAKE_CLIP_TEXT = 'The take goes into its own clip on this part; other clips keep their recordings.';

/** "Count-in: 3 beats" / "Recording: bar 2 of 4" and a bar that fills, from the transport position (display only). */
function TakeProgress(props: { take: TakeInfo }) {
  const { take } = props;
  const textRef = useRef<HTMLSpanElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const last = useRef('');
  useRafLoop(() => {
    const t = session.transport;
    if (!t || !textRef.current || !fillRef.current) return;
    const tick = t.getPosition().tick;
    let text: string;
    let frac = 0;
    if (take.phase === 'saving') {
      text = 'Saving the take…';
      frac = 1;
    } else if (tick < take.startTick) {
      const beats = Math.max(1, Math.ceil((take.startTick - tick) / 96));
      text = `${tick < 0 ? 'Count-in' : 'Starts in'}: ${beats} beat${beats === 1 ? '' : 's'}`;
    } else {
      const bar = Math.min(take.bars, Math.floor((tick - take.startTick) / 384) + 1);
      text = `Recording: bar ${bar} of ${take.bars}`;
      frac = Math.min(1, (tick - take.startTick) / (take.endTick - take.startTick));
    }
    if (text !== last.current) {
      last.current = text;
      textRef.current.textContent = text;
    }
    fillRef.current.style.width = `${(frac * 100).toFixed(1)}%`;
  }, true);
  return (
    <div className={styles.progress} data-phase={take.phase}>
      <span className={styles.recDot} aria-hidden="true" />
      <span ref={textRef} className={styles.progressText} />
      <span className={styles.track} aria-hidden="true">
        <span ref={fillRef} className={styles.fill} />
      </span>
    </div>
  );
}

export function RecordAudio(props: { trackId: Id }) {
  const { trackId } = props;
  const hintId = useId();
  const st = useAudioInput(
    (s) => ({
      status: s.status,
      message: s.message,
      deviceLabel: s.deviceLabel,
      bars: s.bars,
      countIn: s.countIn,
      take: s.take,
      result: s.result && s.result.trackId === trackId ? s.result : null,
    }),
    shallowEqual,
  );
  const rt = useRuntime((s) => ({ recording: s.recording, replayId: s.replayId, mode: s.mode, playing: s.playing, paused: s.paused }), shallowEqual);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const mine = st.take !== null && st.take.trackId === trackId;
  const blocked = mine ? null : st.take ? 'Another part is recording audio. Wait for it to finish.' : audioInput.blockedReason(trackId, rt);
  const unavailable = audioInput.unavailableReason();
  const saving = mine && st.take?.phase === 'saving';
  // While a take runs, the status line says so in words (the bar counter above changes every beat, so it is not announced).
  const phaseText =
    mine && st.take
      ? st.take.phase === 'saving'
        ? 'Saving the take on this device…'
        : st.take.phase === 'waiting'
          ? `Get ready: recording ${st.take.bars} bar${st.take.bars === 1 ? '' : 's'} starts on the next downbeat.`
          : `Recording ${st.take.bars} bar${st.take.bars === 1 ? '' : 's'}…`
      : null;
  const status = phaseText ?? blocked ?? unavailable ?? st.result?.message ?? (st.status !== 'open' && st.status !== 'off' && st.status !== 'requesting' ? st.message : null);
  const tone = phaseText ? 'rec' : blocked || unavailable ? 'error' : st.result ? (st.result.ok ? 'ok' : 'error') : st.message && st.status !== 'open' ? 'error' : undefined;
  const input = st.status === 'open' ? `Input: ${st.deviceLabel ?? 'audio input'}` : 'Input: none yet. Record audio asks the browser for the microphone.';

  return (
    <div className={styles.block}>
      <div className={styles.row}>
        {mine ? (
          <Button
            size="sm"
            tone="coral"
            icon="stop"
            pressed
            aria-pressed={undefined}
            aria-disabled={saving || undefined}
            className={styles.recActive}
            onClick={() => {
              if (!saving) audioInput.stopTake('button');
            }}
            tip={saving ? 'The take is being stored.' : 'Stop recording now. Before its first downbeat nothing is kept; after it, what was recorded is kept.'}
          >
            {saving ? 'Saving…' : 'Stop recording'}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            tone="coral"
            icon="record"
            disabled={!!blocked || !!unavailable}
            aria-describedby={hintId}
            onClick={() => void audioInput.record(trackId)}
            tip={`Record ${st.bars} bar${st.bars === 1 ? '' : 's'} from the microphone or instrument${st.countIn ? ' after a one-bar count-in' : ''}, in time with the music. ${TAKE_CLIP_TEXT}`}
            detail="It goes on the selected pad when that is empty, else on the first empty one (with every pad taken it replaces the selected clip). Playback starts if it is stopped; while it plays, the take starts at the next bar. Undo removes the whole result."
          >
            Record audio
          </Button>
        )}
        <SegmentedControl<BarsValue>
          label="Bars to record"
          size="sm"
          options={BAR_OPTIONS}
          value={String(st.bars) as BarsValue}
          disabled={mine}
          onChange={(v) => audioInput.setBars(Number(v) as RecordBars)}
        />
        <Switch
          label="Count-in"
          size="sm"
          onText="1 bar"
          offText="Off"
          checked={st.countIn}
          disabled={mine}
          onChange={(on) => audioInput.setCountIn(on)}
          tip="One bar of clicks (and the music) before recording starts, so you can come in on the downbeat."
        />
      </div>
      {mine && st.take && <TakeProgress take={st.take} />}
      <div className={styles.status} role="status" aria-live="polite" data-tone={tone}>
        {status && (
          <>
            <Icon name={tone === 'ok' ? 'check' : tone === 'error' ? 'warning' : tone === 'rec' ? 'record' : 'info'} size={14} className={styles.statusIcon} />
            <span className={styles.statusText}>{status}</span>
          </>
        )}
      </div>
      <div className={styles.inputRow}>
        <p id={hintId} className={styles.fine}>
          {input}
        </p>
        <Button size="sm" variant="ghost" icon="settings" onClick={() => setDevicesOpen(true)} tip="Choose the input, see its level, hear it while you play, and correct the timing of takes.">
          Input settings…
        </Button>
      </div>
      <DevicesDialog open={devicesOpen} focus="audio" onClose={() => setDevicesOpen(false)} />
    </div>
  );
}
