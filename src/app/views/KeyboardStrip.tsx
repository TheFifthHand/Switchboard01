/**
 * The small keyboard: ~2 octaves, octave shift, computer-key legends,
 * Musical Assist (in-key notes) with a visible explanation and a chromatic
 * mode, and the key selector.
 */
import { useCallback, useMemo } from 'react';
import { IconButton, MiniKeyboard, Select, Switch, Tooltip, noteKeyLabels, useComputerKeyboard, useKeyCapLabels } from '../../ui/components';
import { ROOT_NAMES, SCALES, SCALE_ORDER, keyLabel, noteName, scaleMask } from '../../music/scales';
import { setAssist, setKey } from '../../state/commands';
import { OCTAVE_RANGE, setKeyboardOctave, shiftKeyboardOctave } from '../../state/uiStore';
import type { ScaleId } from '../../project/types';
import { session, useProject, useUi } from '../instance';
import { useRuntime } from '../runtime';
import styles from './KeyboardStrip.module.css';

const ROOT_OPTIONS = ROOT_NAMES.map((n, i) => ({ value: String(i), label: n }));
const SCALE_OPTIONS = SCALE_ORDER.map((id) => ({ value: id, label: SCALES[id].name }));

export function KeyboardStrip(props: { children?: React.ReactNode }) {
  const trackId = useUi((s) => s.selectedTrackId);
  const padMode = useUi((s) => s.padMode);
  const octave = useUi((s) => s.keyboardOctave);
  const trackName = useProject((p) => p.tracks.find((t) => t.id === trackId)?.name ?? '');
  const isDrums = useProject((p) => p.tracks.find((t) => t.id === trackId)?.instrument.kind === 'drums');
  const root = useProject((p) => p.root);
  const scale = useProject((p) => p.scale);
  const assist = useProject((p) => p.assist);
  const held = useRuntime((s) => s.held[trackId]);
  const capLabels = useKeyCapLabels();

  const baseNote = (octave + 1) * 12;
  const mask = useMemo(() => (assist ? scaleMask(root, scale) : undefined), [assist, root, scale]);
  const keyLabels = useMemo(() => noteKeyLabels(baseNote, capLabels), [baseNote, capLabels]);
  const active = useMemo(() => {
    if (!held || isDrums) return new Set<number>();
    return new Set(held);
  }, [held, isDrums]);

  // Drum parts: keys from the left play the 16 kit sounds.
  const toPitch = useCallback((midi: number) => (isDrums ? Math.max(0, Math.min(15, midi - baseNote)) : midi), [isDrums, baseNote]);

  const onNoteOn = useCallback((midi: number, velocity: number) => session.noteOn(trackId, toPitch(midi), velocity, 'keyboard'), [trackId, toPitch]);
  const onNoteOff = useCallback((midi: number) => session.noteOff(trackId, toPitch(midi), 'keyboard'), [trackId, toPitch]);

  // Computer keys: notes layout except in Drums pad mode (handled by the drum pads).
  useComputerKeyboard({
    enabled: padMode !== 'drums',
    layout: 'notes',
    onNoteOn: (index, velocity) => session.noteOn(trackId, toPitch(baseNote + index), velocity, 'computer'),
    onNoteOff: (index) => session.noteOff(trackId, toPitch(baseNote + index), 'computer'),
    onOctave: (delta) => shiftKeyboardOctave(delta),
  });

  return (
    <section className={styles.strip} aria-label="Keyboard">
      <div className={styles.octave}>
        <IconButton icon="octaveDown" label="Octave down (Z)" size="sm" onClick={() => shiftKeyboardOctave(-1)} disabled={octave <= OCTAVE_RANGE.min} />
        <div className={styles.octLabel}>
          <span className={`${styles.octValue} mono`}>{isDrums ? 'KIT' : noteName(baseNote)}</span>
          <span className={styles.octCaption}>{isDrums ? '16 sounds' : 'lowest key'}</span>
        </div>
        <IconButton icon="octaveUp" label="Octave up (X)" size="sm" onClick={() => shiftKeyboardOctave(1)} disabled={octave >= OCTAVE_RANGE.max} />
        <button type="button" className={styles.reset} onClick={() => setKeyboardOctave(4)} aria-label="Reset octave to C4">
          C4
        </button>
      </div>

      <div className={styles.keys}>
        <MiniKeyboard
          baseNote={baseNote}
          onNoteOn={onNoteOn}
          onNoteOff={onNoteOff}
          activeNotes={active}
          scaleMask={isDrums ? undefined : mask}
          keyLabels={keyLabels}
          rootPc={root}
          keys={25}
          height={74}
          label={`Keyboard playing ${trackName}`}
        />
      </div>

      <div className={styles.assist}>
        <div className={styles.keyRow}>
          <Select label="Key" layout="inline" size="sm" value={String(root)} options={ROOT_OPTIONS} onChange={(v) => session.accepted(setKey(session.store, Number(v), scale))} width={60} tip="The home note of the project. Notes pads and Musical Assist use it." />
          <Select label="Scale" hideLabel size="sm" value={scale} options={SCALE_OPTIONS} onChange={(v) => session.accepted(setKey(session.store, root, v as ScaleId))} width={132} tip="Which notes belong to the key." />
        </div>
        <Tooltip tip={assist ? `Musical Assist is on: every key plays a note from ${keyLabel(root, scale)}. Keys outside the key (dimmed) play the nearest in-key note.` : 'Musical Assist is off: the keyboard is chromatic and plays exactly the key you press.'} detail="Recorded notes follow the same rule. Imported recordings are never re-pitched by Assist.">
          <div>
            <Switch checked={assist} onChange={(on) => session.accepted(setAssist(session.store, on))} label="Musical Assist" onText="IN KEY" offText="CHROMATIC" tone="teal" size="sm" />
          </div>
        </Tooltip>
        <p className={styles.assistNote} aria-live="polite">
          {isDrums ? `${trackName}: keys play the kit sounds.` : assist ? `Snapping to ${keyLabel(root, scale)}` : 'Every key plays as pressed'}
        </p>
      </div>
      {props.children}
    </section>
  );
}
