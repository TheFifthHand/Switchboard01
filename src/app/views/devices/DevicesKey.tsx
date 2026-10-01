/**
 * The transport's MIDI & audio key: shown only while MIDI is connected or an
 * audio input is open. Its lamp flashes (amber) with MIDI activity, a mic
 * shows an open input, and a coral dot an audio take being recorded; the
 * accessible name says all of it in words. Pressing it opens MIDI & audio.
 */
import { Icon, Tooltip } from '../../../ui/components';
import { MidiActivityLamp } from './DevicesDialog';
import { useAudioInput, useMidi } from './instances';
import styles from './DevicesKey.module.css';

export function DevicesKey(props: { onOpen(): void; className?: string }) {
  const midiOn = useMidi((s) => s.status === 'connected');
  const inputs = useMidi((s) => s.inputs.length);
  const inputOpen = useAudioInput((s) => s.status === 'open');
  const recording = useAudioInput((s) => s.take !== null);
  if (!midiOn && !inputOpen && !recording) return null;
  const parts = [
    midiOn ? (inputs ? `${inputs} MIDI input${inputs === 1 ? '' : 's'}` : 'MIDI on, nothing plugged in') : null,
    inputOpen ? 'audio input on' : null,
    recording ? 'recording audio' : null,
  ].filter(Boolean);
  const label = `MIDI & audio: ${parts.join(', ')}`;
  return (
    <Tooltip name="MIDI & audio" tip={`${parts.join(', ').replace(/^./, (c) => c.toUpperCase())}. Press for devices, MIDI learn and the input.`}>
      <button type="button" className={[styles.key, props.className].filter(Boolean).join(' ')} aria-label={label} onClick={props.onOpen} data-recording={recording || undefined}>
        {midiOn && <Icon name="midi" size={14} />}
        {(inputOpen || recording) && <Icon name="mic" size={14} />}
        {midiOn && <MidiActivityLamp className={styles.lamp} />}
        {recording && <span className={styles.rec} aria-hidden="true" />}
      </button>
    </Tooltip>
  );
}
