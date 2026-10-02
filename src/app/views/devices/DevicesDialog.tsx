/**
 * MIDI & audio: MIDI keyboards and controllers (connect, inputs with live
 * activity lights, which part each plays, pitch bend range, MIDI learn) and
 * the audio input for recording (device, level, mono or stereo, monitoring,
 * recording offset). Opened from the transport's More menu (and its MIDI &
 * audio key) and from the sampler editor's input settings.
 *
 * Everything here belongs to this browser's setup, not to the project, and
 * nothing leaves the device.
 */
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { Button, Dialog, Icon, Meter, NumberField, SegmentedControl, Select, Switch, useRafLoop, type SelectOption } from '../../../ui/components';
import { shallowEqual } from '../../../state/store';
import { useProject } from '../../instance';
import { MONITOR_WARNING, OFFSET_RANGE_MS } from '../../audioInput';
import { ACTIVITY_MS, LEARN_TARGETS, MAX_BEND_RANGE, learnTargetFromKey, learnTargetKey, learnTargetName, type LearnTarget, type MidiMapping } from '../../midi';
import { audioInput, midi, useAudioInput, useMidi } from './instances';
import styles from './DevicesDialog.module.css';

export interface DevicesDialogProps {
  open: boolean;
  onClose(): void;
  /** Section to start in (keyboard focus goes to its first control). */
  focus?: 'midi' | 'audio';
}

/** A lamp that flashes (amber: signal) while a MIDI input, or any input, sends messages. */
export function MidiActivityLamp(props: { inputId?: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const lit = useRef(false);
  useRafLoop((_, now) => {
    const on = now - midi.lastActivity(props.inputId) < ACTIVITY_MS;
    if (on !== lit.current && ref.current) {
      lit.current = on;
      if (on) ref.current.dataset.on = '1';
      else delete ref.current.dataset.on;
    }
  }, true);
  return <span ref={ref} className={[styles.lamp, props.className].filter(Boolean).join(' ')} aria-hidden="true" />;
}

const BEND_OPTIONS: SelectOption[] = Array.from({ length: MAX_BEND_RANGE }, (_, i) => ({ value: String(i + 1), label: `±${i + 1} semitone${i ? 's' : ''}` }));

function mappingText(m: MidiMapping): string {
  return `CC ${m.cc} · channel ${m.channel + 1} · ${m.inputName || 'MIDI input'}`;
}

function MidiSection(props: { headingId: string; headingRef: RefObject<HTMLHeadingElement | null>; actionRef: RefObject<HTMLButtonElement | null> }) {
  const st = useMidi((s) => ({ status: s.status, message: s.message, inputs: s.inputs, learning: s.learning, learned: s.learned, settings: s.settings }), shallowEqual);
  const parts = useProject((p) => p.tracks.map((t, i) => ({ id: t.id, name: `${i + 1} · ${t.name}` })), (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id && x.name === b[i].name));
  const [targetKey, setTargetKey] = useState('macro:tone');
  const target = learnTargetFromKey(targetKey) ?? LEARN_TARGETS[0];
  const unavailable = midi.unavailableReason();
  const connected = st.status === 'connected';
  // Learning stops when the dialog closes.
  useEffect(() => () => midi.cancelLearn(), []);

  const routeOptions: SelectOption[] = useMemo(() => [{ value: 'selected', label: 'The selected part' }, ...parts.map((p) => ({ value: p.id, label: p.name, group: 'Always this part' }))], [parts]);
  const learnOptions: SelectOption[] = LEARN_TARGETS.map((t) => ({ value: learnTargetKey(t), label: learnTargetName(t) }));

  const statusText =
    st.message ??
    (st.status === 'requesting'
      ? 'Waiting for the browser… If it asks, allow MIDI devices.'
      : connected
        ? st.inputs.length
          ? `${st.inputs.length} MIDI input${st.inputs.length === 1 ? '' : 's'} connected.`
          : 'Connected. Plug in a MIDI keyboard or controller: it appears here by itself.'
        : unavailable ?? 'Connect asks the browser for your MIDI devices. Nothing leaves this device.');

  return (
    <section className={styles.section} aria-labelledby={props.headingId}>
      <div className={styles.head}>
        <Icon name="midi" size={16} className={styles.headIcon} />
        <h3 id={props.headingId} ref={props.headingRef} tabIndex={-1} className={styles.title}>
          MIDI keyboards and controllers
        </h3>
      </div>
      <div className={styles.row}>
        {connected ? (
          <Button ref={props.actionRef} size="sm" variant="ghost" onClick={() => midi.disconnect()} tip="Stop listening to MIDI devices. Notes held now are let go of, and MIDI does not reconnect by itself next time.">
            Turn MIDI off
          </Button>
        ) : (
          <Button
            ref={props.actionRef}
            variant="secondary"
            icon="midi"
            disabled={!!unavailable}
            aria-disabled={st.status === 'requesting' || undefined}
            onClick={() => {
              if (st.status !== 'requesting') void midi.connect();
            }}
            tip="Play the app from a MIDI keyboard or controller. The browser asks for permission the first time; after that it reconnects by itself."
          >
            Connect MIDI
          </Button>
        )}
        <p className={styles.status} role="status" data-tone={st.status === 'denied' || st.status === 'error' || st.status === 'unsupported' ? 'error' : connected ? 'ok' : undefined}>
          {statusText}
        </p>
      </div>

      {connected && st.inputs.length > 0 && (
        <>
          <p className={styles.fine}>The light next to a device flashes when it sends notes or controls.</p>
          <ul className={styles.inputs} aria-label="MIDI inputs">
            {st.inputs.map((input) => (
              <li key={input.id} className={styles.input}>
                <MidiActivityLamp inputId={input.id} />
                <span className={styles.inputName}>{input.name}</span>
                <span className={styles.plays} aria-hidden="true">
                  plays
                </span>
                <Select
                  label={`${input.name} plays`}
                  hideLabel
                  size="sm"
                  className={styles.route}
                  value={midi.routeOf(input.id)}
                  options={routeOptions}
                  onChange={(v) => midi.setRoute(input.id, v)}
                  tip="The part this device plays: the part selected on screen (it follows your choice), or always the same part."
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {connected && (
        <>
          <div className={styles.row}>
            <Select
              label="Pitch bend range"
              layout="inline"
              size="sm"
              value={String(st.settings.bendRange)}
              options={BEND_OPTIONS}
              onChange={(v) => midi.setBendRange(Number(v))}
              tip="How far the pitch wheel bends notes up or down. Drum parts do not bend."
            />
          </div>
          <ul className={styles.facts}>
            <li>The sustain pedal holds notes until you let go of it.</li>
            <li>The mod wheel moves the Motion macro of the part the device plays (recorded like a knob).</li>
            <li>Drum parts follow the General MIDI drum map: C1 Kick, D1 Snare, D#1 Clap, F#1 Closed hat, A#1 Open hat, C#2 Crash.</li>
            <li>Notes go through Musical Assist and the arpeggiator, and Record Notes and Record Performance record them, as with the computer keyboard.</li>
          </ul>
          <LearnBlock target={target} targetKey={targetKey} setTargetKey={setTargetKey} learnOptions={learnOptions} learning={st.learning} learned={st.learned} mappings={st.settings.mappings} />
        </>
      )}
    </section>
  );
}

function LearnBlock(props: {
  target: LearnTarget;
  targetKey: string;
  setTargetKey(k: string): void;
  learnOptions: SelectOption[];
  learning: LearnTarget | null;
  learned: MidiMapping | null;
  mappings: MidiMapping[];
}) {
  const { target, targetKey, setTargetKey, learnOptions, learning, learned, mappings } = props;
  const titleId = useId();
  const text = learning
    ? `Move a knob, fader or wheel on your controller to control ${learnTargetName(learning)}…`
    : learned
      ? `Mapped: ${mappingText(learned)} now controls ${learnTargetName(learned.target)}.`
      : 'Choose what to control, press Learn, then move a knob or fader on your controller.';
  return (
    <div className={styles.learn} role="group" aria-labelledby={titleId}>
      <h4 id={titleId} className={styles.subTitle}>
        Knobs and faders on your controller (MIDI learn)
      </h4>
      <div className={styles.row}>
        <Select label="Control" layout="inline" size="sm" value={targetKey} options={learnOptions} onChange={setTargetKey} disabled={!!learning} tip="What the knob or fader you move next will control. Macros and Volume follow the selected part; tempo goes from 60 to 187 BPM." />
        {learning ? (
          <Button size="sm" tone="teal" pressed onClick={() => midi.cancelLearn()} aria-label="Cancel learning" tip="Stop waiting for a control.">
            Cancel
          </Button>
        ) : (
          <Button size="sm" icon="link" onClick={() => midi.startLearn(target)} tip={`Then move a knob, fader or wheel on your controller: it will control ${learnTargetName(target)}.`}>
            Learn
          </Button>
        )}
      </div>
      <p className={styles.status} role="status" data-tone={learning ? 'wait' : learned ? 'ok' : undefined}>
        {text}
      </p>
      {mappings.length > 0 ? (
        <ul className={styles.mappings} aria-label="Learned controls">
          {mappings.map((m) => (
            <li key={m.id} className={styles.mapping}>
              <span className={styles.mappingText}>
                <span className="mono">{mappingText(m)}</span> → <strong>{learnTargetName(m.target)}</strong>
              </span>
              <Button size="sm" variant="ghost" icon="trash" onClick={() => midi.removeMapping(m.id)} aria-label={`Remove: ${mappingText(m)} controls ${learnTargetName(m.target)}`}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.fine}>No controls learned yet. They are remembered in this browser, for every project.</p>
      )}
    </div>
  );
}

function AudioSection(props: { headingId: string; headingRef: RefObject<HTMLHeadingElement | null>; actionRef: RefObject<HTMLButtonElement | null> }) {
  const st = useAudioInput(
    (s) => ({ status: s.status, message: s.message, devices: s.devices, deviceId: s.deviceId, deviceLabel: s.deviceLabel, channels: s.channels, monitor: s.monitor, offsetMs: s.offsetMs, recording: s.take !== null }),
    shallowEqual,
  );
  const open = st.status === 'open';
  const unavailable = audioInput.unavailableReason();
  const lat = audioInput.latency();
  const deviceOptions: SelectOption[] = st.devices.length ? st.devices.map((d) => ({ value: d.id, label: d.label })) : [{ value: st.deviceId ?? '', label: st.deviceLabel ?? 'Default input', disabled: true }];
  const statusText =
    st.message ??
    (st.status === 'requesting'
      ? 'Waiting for the browser… If it asks, allow the microphone.'
      : open
        ? `Using “${st.deviceLabel ?? 'Audio input'}”.`
        : unavailable ?? 'Use input asks the browser for the microphone or instrument input. The sound stays on this device.');
  return (
    <section className={styles.section} aria-labelledby={props.headingId}>
      <div className={styles.head}>
        <Icon name="mic" size={16} className={styles.headIcon} />
        <h3 id={props.headingId} ref={props.headingRef} tabIndex={-1} className={styles.title}>
          Audio input (microphone or instrument)
        </h3>
      </div>
      <div className={styles.row}>
        {open ? (
          <Button ref={st.recording ? undefined : props.actionRef} size="sm" variant="ghost" disabled={st.recording} onClick={() => audioInput.close()} tip="Close the input: the browser stops listening.">
            Turn input off
          </Button>
        ) : (
          <Button
            ref={props.actionRef}
            variant="secondary"
            icon="mic"
            disabled={!!unavailable}
            aria-disabled={st.status === 'requesting' || undefined}
            onClick={() => {
              if (st.status !== 'requesting') void audioInput.open();
            }}
            tip="Open the microphone or instrument input to see its level and record from it. Echo cancellation, noise suppression and automatic level are off, so instruments sound as they are."
          >
            Use input
          </Button>
        )}
        <p className={styles.status} role="status" data-tone={st.status === 'denied' || st.status === 'error' || st.status === 'unsupported' || st.status === 'nodevice' ? 'error' : open ? 'ok' : undefined}>
          {statusText}
        </p>
      </div>
      <div className={styles.grid}>
        <Select
          label="Input"
          layout="inline"
          size="sm"
          className={styles.device}
          value={st.deviceId ?? ''}
          options={deviceOptions}
          disabled={!open || st.devices.length === 0 || st.recording}
          onChange={(id) => void audioInput.setDevice(id)}
          tip="Which microphone or audio interface input to record from. Names appear once the browser allowed the microphone."
        />
        <div className={styles.meterRow}>
          <span className={styles.meterLabel}>Level</span>
          {open ? <Meter read={() => audioInput.readLevel()} label="Input level" thickness={10} className={styles.meter} /> : <span className={styles.meterOff}>Off</span>}
        </div>
        <SegmentedControl<'1' | '2'>
          label="Record in"
          size="sm"
          className={styles.channels}
          options={[
            { value: '1', label: 'Mono', tip: 'One channel: a voice, a guitar, one microphone.' },
            { value: '2', label: 'Stereo', tip: 'Two channels: a keyboard’s left and right outputs, a stereo microphone.' },
          ]}
          value={String(st.channels) as '1' | '2'}
          disabled={st.recording}
          onChange={(v) => void audioInput.setChannels(v === '2' ? 2 : 1)}
        />
        <Switch
          label="Hear the input"
          size="sm"
          checked={st.monitor}
          disabled={!open}
          onChange={(on) => audioInput.setMonitor(on)}
          tip="Monitoring: plays the input through your speakers or headphones while you play. Mute All silences it."
          detail="Off by default. Through the output limiter (ceiling -1 dBFS)."
        />
      </div>
      <p className={styles.warn}>
        <Icon name="headphones" size={14} className={styles.warnIcon} />
        <span>{MONITOR_WARNING}</span>
      </p>
      <div className={styles.row}>
        <NumberField
          label="Recording offset"
          layout="inline"
          size="sm"
          value={st.offsetMs}
          min={OFFSET_RANGE_MS.min}
          max={OFFSET_RANGE_MS.max}
          step={1}
          unit="ms"
          chars={4}
          onChange={(v) => audioInput.setOffset(v)}
          tip="Moves recordings in time to match what you heard. If takes sound late, raise it; if they sound early, lower it."
        />
        <p className={styles.fine}>
          Measured delay: about {lat.outputMs + lat.inputMs} ms (sound out {lat.outputMs} ms, input {lat.inputMs} ms). Takes are moved earlier by that, plus this offset.
        </p>
      </div>
    </section>
  );
}

export function DevicesDialog({ open, onClose, focus = 'midi' }: DevicesDialogProps) {
  const midiId = useId();
  const audioId = useId();
  const midiHeading = useRef<HTMLHeadingElement>(null);
  const audioHeading = useRef<HTMLHeadingElement>(null);
  // Each section's first action (Connect MIDI / Turn MIDI off, Use input / Turn input off): focus starts there.
  const midiAction = useRef<HTMLButtonElement>(null);
  const audioAction = useRef<HTMLButtonElement>(null);
  /** Read when the dialog opens (after its sections mounted): the section's action, or its heading when the action is unavailable. */
  const initialFocus = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        const action = focus === 'audio' ? audioAction.current : midiAction.current;
        const heading = focus === 'audio' ? audioHeading.current : midiHeading.current;
        return action && !action.disabled ? action : heading;
      },
    }),
    [focus],
  );
  // Opened for the audio input (from the sampler editor): show that section.
  useEffect(() => {
    if (!open || focus !== 'audio') return;
    const raf = requestAnimationFrame(() => audioHeading.current?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(raf);
  }, [open, focus]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="MIDI & audio"
      size="lg"
      description="Play from a MIDI keyboard or controller, and record from a microphone or instrument. These settings belong to this browser, not to the project."
      // Focus starts on the section's first action (Connect MIDI, or Use input from the sampler editor); a
      // section whose action is unavailable starts at its heading, which is read out first.
      initialFocusRef={initialFocus}
      actions={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className={styles.body}>
        <MidiSection headingId={midiId} headingRef={midiHeading} actionRef={midiAction} />
        <AudioSection headingId={audioId} headingRef={audioHeading} actionRef={audioAction} />
      </div>
    </Dialog>
  );
}
