/**
 * The small keyboard: ~2 octaves, octave shift, computer-key legends,
 * Musical Assist (in-key notes) with a visible explanation and a chromatic
 * mode. Simple shows the key as a summary ("Key: G Dorian"); Advanced adds
 * the key and scale pickers and the arpeggiator strip. A drum part gets one
 * key per kit sound (16), with no octave to shift. The keyboard folds to a
 * slim bar (remembered); the computer keys still play then.
 *
 * Every held key (mouse, touch or computer key) keeps the release of the note
 * it started, so changing the part, the octave or the arpeggiator while it is
 * down still ends that note, on its part and at its pitch.
 */
import { useCallback, useMemo, useRef } from 'react';
import { IconButton, MiniKeyboard, Select, Switch, Tooltip, noteKeyLabels, useComputerKeyboard, useKeyCapLabels } from '../../ui/components';
import { ROOT_NAMES, SCALES, SCALE_ORDER, keyLabel, noteName, scaleMask } from '../../music/scales';
import { setAssist, setKey } from '../../state/commands';
import { OCTAVE_RANGE, setKeyboardCollapsed, setKeyboardOctave, shiftKeyboardOctave } from '../../state/uiStore';
import { DRUM_VOICES, type ScaleId } from '../../project/types';
import { session, useProject, useUi } from '../instance';
import { useRuntime } from '../runtime';
import { ArpStrip } from './ArpPanel';
import { playLive } from './DrumPads';
import styles from './KeyboardStrip.module.css';

const ROOT_OPTIONS = ROOT_NAMES.map((n, i) => ({ value: String(i), label: n }));
const SCALE_OPTIONS = SCALE_ORDER.map((id) => ({ value: id, label: SCALES[id].name }));
/** A kit keyboard always starts at C4: its keys are sounds, not pitches. */
const KIT_BASE_NOTE = 60;

/** Release the note a key started (if it is still down) and forget it. */
function release(map: Map<number, () => void>, key: number): void {
  const r = map.get(key);
  map.delete(key);
  r?.();
}

export function KeyboardStrip(props: { children?: React.ReactNode }) {
  const trackId = useUi((s) => s.selectedTrackId);
  const padMode = useUi((s) => s.padMode);
  const view = useUi((s) => s.view);
  const octave = useUi((s) => s.keyboardOctave);
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const collapsed = useUi((s) => s.keyboardCollapsed);
  const trackName = useProject((p) => p.tracks.find((t) => t.id === trackId)?.name ?? '');
  const kind = useProject((p) => p.tracks.find((t) => t.id === trackId)?.instrument.kind);
  const isDrums = kind === 'drums';
  const isSampler = kind === 'sampler';
  const root = useProject((p) => p.root);
  const scale = useProject((p) => p.scale);
  const assist = useProject((p) => p.assist);
  const held = useRuntime((s) => s.held[trackId]);
  const arpOn = useProject((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    return !!t && t.arp.enabled && t.instrument.kind !== 'drums';
  });
  const capLabels = useKeyCapLabels();

  const baseNote = isDrums ? KIT_BASE_NOTE : (octave + 1) * 12;
  // Drum pads own the computer keys only while they are on screen with a kit selected.
  const drumPadsOwnKeys = padMode === 'drums' && view === 'play' && isDrums;
  const mask = useMemo(() => (assist ? scaleMask(root, scale) : undefined), [assist, root, scale]);
  const stripRef = useRef<HTMLElement>(null);
  // One legend per white key: the computer key, except on C keys (and the root), which show their note name.
  // Two stacked legends would run into the scale dots on a keyboard this short.
  const keyLabels = useMemo(() => {
    // When the drum pads own the keys, the keyboard shows no computer-key legends.
    if (drumPadsOwnKeys) return {};
    const all = noteKeyLabels(baseNote, capLabels);
    const out: Record<number, string> = {};
    for (const [midi, label] of Object.entries(all)) {
      const pc = Number(midi) % 12;
      if (pc === 0 || (!isDrums && pc === root)) continue;
      out[Number(midi)] = label;
    }
    return out;
  }, [baseNote, capLabels, isDrums, root, drumPadsOwnKeys]);
  const active = useMemo(() => {
    if (!held || isDrums) return new Set<number>();
    return new Set(held);
  }, [held, isDrums]);

  // Drum parts: key n from the left plays kit sound n.
  const toPitch = useCallback((midi: number) => (isDrums ? Math.max(0, Math.min(DRUM_VOICES - 1, midi - baseNote)) : midi), [isDrums, baseNote]);

  // Releases of the notes held down: by MIDI note (on-screen keys) and by key index (computer keys).
  const pointerNotes = useRef(new Map<number, () => void>());
  const keyNotes = useRef(new Map<number, () => void>());

  const onNoteOn = useCallback(
    (midi: number, velocity: number) => {
      release(pointerNotes.current, midi);
      pointerNotes.current.set(midi, playLive(trackId, toPitch(midi), velocity, 'keyboard'));
    },
    [trackId, toPitch],
  );
  const onNoteOff = useCallback((midi: number) => release(pointerNotes.current, midi), []);

  // Computer keys: notes layout except in Drums pad mode (handled by the drum pads).
  useComputerKeyboard({
    enabled: !drumPadsOwnKeys,
    layout: 'notes',
    onNoteOn: (index, velocity) => {
      // A kit has 16 sounds: the keys past them play nothing.
      if (isDrums && index >= DRUM_VOICES) return;
      release(keyNotes.current, index);
      keyNotes.current.set(index, playLive(trackId, toPitch(baseNote + index), velocity, 'computer'));
    },
    onNoteOff: (index) => release(keyNotes.current, index),
    onOctave: (delta) => {
      if (!isDrums) shiftKeyboardOctave(delta);
    },
  });

  const assistTip = !assist
    ? 'Musical Assist is off: the keyboard is chromatic and plays exactly the key you press.'
    : isSampler
      ? `Musical Assist is on, but ${trackName} plays a recording, which Assist never re-pitches: every key plays exactly as pressed, and the Root Note key plays it at its own pitch. The dots show the notes of ${keyLabel(root, scale)}.`
      : `Musical Assist is on: every key plays a note from ${keyLabel(root, scale)}. Keys outside the key (dimmed) play the nearest in-key note.`;
  // One short line that fits the column whole (the tip says more, e.g. that the dots still show the key).
  const assistNote = isDrums
    ? `${trackName}: keys play the kit sounds.`
    : !assist
      ? 'Every key plays as pressed'
      : isSampler
        ? 'Recordings play as pressed'
        : `Snapping to ${keyLabel(root, scale)}`;

  const keyName = keyLabel(root, scale);
  // Simple hides the arpeggiator strip; a part whose arpeggiator is on still says so.
  const arpNote = !advanced && arpOn ? 'Arpeggiator on (settings in Advanced)' : null;
  const assistSwitch = (
    <Tooltip tip={assistTip} detail="Recorded notes follow the same rule. Recordings (sampler parts) are never re-pitched by Assist.">
      <div>
        <Switch checked={assist} onChange={(on) => session.accepted(setAssist(session.store, on))} label="Musical Assist" onText="IN KEY" offText="CHROMATIC" tone="teal" size="sm" />
      </div>
    </Tooltip>
  );
  const foldKey = (
    <IconButton
      icon={collapsed ? 'chevronUp' : 'chevronDown'}
      label={collapsed ? 'Show the keyboard' : 'Hide the keyboard'}
      tip={collapsed ? 'Show the on-screen keyboard.' : 'Fold the keyboard away to give the pads more room. The computer keys still play.'}
      size="sm"
      variant="ghost"
      aria-expanded={!collapsed}
      onClick={() => setKeyboardCollapsed(!collapsed)}
      className={styles.fold}
    />
  );

  if (collapsed) {
    return (
      <section ref={stripRef} className={styles.strip} data-collapsed="" aria-label="Keyboard">
        {foldKey}
        <span className={styles.foldedLabel}>Keyboard</span>
        <span className={styles.foldedNote}>
          {isDrums ? `${trackName}: computer keys play the kit sounds.` : `Computer keys play ${trackName}. ${assist ? `Key: ${keyName}.` : 'Chromatic.'}`}
        </span>
        {props.children}
      </section>
    );
  }

  return (
    <section ref={stripRef} className={styles.strip} aria-label="Keyboard">
      {foldKey}
      <div className={styles.octave}>
        <IconButton icon="octaveDown" label="Octave down (Z)" size="sm" onClick={() => shiftKeyboardOctave(-1)} disabled={isDrums || octave <= OCTAVE_RANGE.min} />
        <div className={styles.octLabel}>
          <span className={`${styles.octValue} mono`}>{isDrums ? 'KIT' : noteName(baseNote)}</span>
          <span className={styles.octCaption}>{isDrums ? '16 sounds' : 'lowest key'}</span>
        </div>
        <IconButton icon="octaveUp" label="Octave up (X)" size="sm" onClick={() => shiftKeyboardOctave(1)} disabled={isDrums || octave >= OCTAVE_RANGE.max} />
        <button type="button" className={styles.reset} onClick={() => setKeyboardOctave(4)} disabled={isDrums} aria-label="Reset octave to C4">
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
          rootPc={isDrums ? undefined : root}
          keys={isDrums ? DRUM_VOICES : 25}
          height={90}
          label={`Keyboard playing ${trackName}`}
        />
      </div>

      <div className={styles.assist}>
        {advanced ? (
          <div className={styles.keyRow}>
            <Select label="Key" layout="inline" size="sm" value={String(root)} options={ROOT_OPTIONS} onChange={(v) => session.accepted(setKey(session.store, Number(v), scale))} width={60} tip="The home note of the project. Notes pads and Musical Assist use it." />
            <Select label="Scale" hideLabel size="sm" value={scale} options={SCALE_OPTIONS} onChange={(v) => session.accepted(setKey(session.store, root, v as ScaleId))} width={132} tip="Which notes belong to the key." />
          </div>
        ) : (
          // Plain text (not a tab stop: it does nothing); the pointer still gets the explanation.
          <Tooltip tip={`The project's key is ${keyName}. The Notes pads and Musical Assist use it.`} detail="Advanced shows the key and scale pickers.">
            <p className={styles.keySummary}>
              Key: <strong>{keyName}</strong>
            </p>
          </Tooltip>
        )}
        {assistSwitch}
        <p className={styles.assistNote} aria-live="polite">
          {arpNote ?? assistNote}
        </p>
      </div>
      {advanced && <ArpStrip trackId={trackId} stripRef={stripRef} />}
      {props.children}
    </section>
  );
}
