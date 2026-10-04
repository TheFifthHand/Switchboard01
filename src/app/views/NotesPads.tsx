/**
 * Notes mode: a 4x4 scale-aware layout for the selected melodic part.
 *
 * Single notes (the default): with Musical Assist on, the 16 pads play
 * consecutive notes of the project key (bottom-left = the first in-key note
 * from the chosen octave's C), so nothing played can sound "wrong"; with
 * Assist off they are 16 chromatic semitones and notes outside the key are
 * shaded. Root notes carry a bold "Root" label and a dotted outline (not the
 * teal of selection). Octave down/up moves the whole layout; the range is
 * shown as text.
 *
 * Chords (the "Chords" switch, remembered in uiStore.notesChords): pad n
 * plays the chord built on scale degree n of the key (chordAt / chordForPad:
 * a triad or a seventh, voiced around the part's register, in the inversion
 * chosen; the top rows an octave up). Pads are named by the chord, spelled
 * in the key ("B♭", "Dm7"), with its degree number small in a corner. Every
 * chord note goes through session.noteOn with the 'chord' source: Record
 * Notes, Performance takes and the arpeggiator get it as played, and Musical
 * Assist leaves it alone (the chord is already in the key; in pentatonic and
 * blues keys it holds notes of the parent scale that Assist would re-snap).
 * Two pads sharing a note sound it once, until both are let go (the counts
 * start again whenever the app releases every note).
 * "Write a progression…" (in the Part block) writes a common progression into
 * the part's selected clip. The side panel fits at 1366 x 768 in every mode.
 *
 * Pads play through the session with a velocity from where they are struck
 * and light while held. Changing the pad view never touches playback or the
 * project.
 */
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Pad, SegmentedControl, Select, Switch, type PadPressEvent } from '../../ui/components';
import { chordAt, chordName } from '../../music/chords';
import { isInScale, keyLabel, noteName, pitchClass, scaleDegreesInRange, type MusicalKey } from '../../music/scales';
import type { Id, Project, ScaleId } from '../../project/types';
import { chordForPad } from '../../state/commands';
import { createStore, useStore } from '../../state/store';
import { OCTAVE_RANGE, setNotesChords, setNotesOctave } from '../../state/uiStore';
import { session, useProject, useUi } from '../instance';
import { useRuntime } from '../runtime';
import { LOCKED_REASON, useEditLocked } from './ClipMenu';
import { HitReadout, PAD_GRID_ATTR, PAD_ORDER, PartChooser, PartStatus, PartSwitch, padGridKeyDown, playLive, useParts, useReplaying, useRovingPads, type PartInfo } from './DrumPads';
import { ProgressionDialog, progressionRefusal } from './ProgressionDialog';
import shared from './DrumPads.module.css';
import styles from './NotesPads.module.css';

export const NOTE_PADS = 16;
const MIDI_TOP = 127;

/** The pitches of the 16 pads, bottom-left first (fewer if the MIDI range ends). */
export function notePadPitches(root: number, scale: ScaleId, assist: boolean, octave: number): number[] {
  const from = (octave + 1) * 12;
  if (assist) return scaleDegreesInRange(root, scale, from, NOTE_PADS);
  const out: number[] = [];
  for (let m = from; m < from + NOTE_PADS && m <= MIDI_TOP; m++) out.push(m);
  return out;
}

/** Highest pad octave (within the UI octave range) whose layout still fills all 16 pads. */
export function highestFullOctave(root: number, scale: ScaleId, assist: boolean): number {
  let o: number = OCTAVE_RANGE.max;
  while (o > OCTAVE_RANGE.min && notePadPitches(root, scale, assist, o).length < NOTE_PADS) o--;
  return o;
}

/* ------------------------------------------------------------------ */
/* Chords                                                              */
/* ------------------------------------------------------------------ */

/** 'smooth': each chord in the close voicing nearest the part's register (neighbours move little); a number: that inversion. */
export type ChordInversion = 'smooth' | 0 | 1 | 2 | 3;

/** The chord pads' inversion, kept for the session (the size is remembered in uiStore.notesChords). */
export const chordVoicingStore = createStore<{ inversion: ChordInversion }>({ inversion: 'smooth' });

export function setChordInversion(inversion: ChordInversion): void {
  chordVoicingStore.setState((s) => (s.inversion === inversion ? s : { inversion }));
}

export interface ChordPadInfo {
  /** Scale degree, 0-based (0 = I). */
  degree: number;
  /** Chord name spelled in the key ('Gm', 'B♭', 'Dm7'). */
  name: string;
  /** MIDI notes, low to high. */
  notes: number[];
}

/**
 * The 16 chord pads, bottom-left first: pad i plays the chord on degree i % 7,
 * an octave up for each full turn of the scale. 'smooth' keeps every chord in
 * the close voicing nearest the part's register (chordForPad); an inversion
 * number voices each chord that way around the same centre.
 */
export function chordPadLayout(p: Project, trackId: Id, size: 3 | 4, inversion: ChordInversion): ChordPadInfo[] {
  const inv = size === 3 && inversion === 3 ? 0 : inversion;
  const out: ChordPadInfo[] = [];
  for (let i = 0; i < NOTE_PADS; i++) {
    const degree = i % 7;
    const auto = chordForPad(p, trackId, degree, size);
    let notes = auto;
    if (inv !== 'smooth') {
      const near = auto.reduce((a, b) => a + b, 0) / auto.length;
      notes = chordAt(p.root, p.scale, degree, { size, inversion: inv, near });
    }
    let up = notes.map((n) => n + 12 * Math.floor(i / 7));
    while (up[up.length - 1] > MIDI_TOP) up = up.map((n) => n - 12);
    out.push({ degree, name: chordName(p.root, p.scale, degree, { size }), notes: up });
  }
  return out;
}

function sameLayout(a: ChordPadInfo[], b: ChordPadInfo[]): boolean {
  return a.length === b.length && a.every((c, i) => c.name === b[i].name && c.notes.join() === b[i].notes.join());
}

/**
 * How many chord pads hold each sounding note, per part, so a note two pads share sounds once
 * until both let go. When the app releases every note (Stop, Mute All, a window switch…) the
 * counts start again: the pads still down must not keep the next chord's shared notes silent,
 * and their later release (from before) must not end notes pressed since. Counts are per part,
 * so changing the part leaves them right (each pad releases on the part it played).
 */
const chordHolds = new Map<string, number>();
let holdEpoch = 0;

/** Forget every count (the session has just released every note). */
export function resetChordHolds(): void {
  chordHolds.clear();
  holdEpoch += 1;
}
session.onAllNotesReleased(resetChordHolds);

/** Play a chord through the session ('chord' source); returns its release. */
export function playChord(trackId: Id, notes: readonly number[], velocity: number): () => void {
  const epoch = holdEpoch;
  for (const n of notes) {
    const k = `${trackId}:${n}`;
    const held = chordHolds.get(k) ?? 0;
    chordHolds.set(k, held + 1);
    if (held === 0) session.noteOn(trackId, n, velocity, 'chord');
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    // Released by the app meanwhile: these notes are already off, and the counts are newer presses'.
    if (epoch !== holdEpoch) return;
    for (const n of notes) {
      const k = `${trackId}:${n}`;
      const held = chordHolds.get(k) ?? 0;
      if (held <= 1) {
        chordHolds.delete(k);
        session.noteOff(trackId, n, 'chord');
      } else chordHolds.set(k, held - 1);
    }
  };
}

const SIZE_OPTIONS = [
  { value: '3', label: 'Triads', tip: 'Three-note chords.' },
  { value: '4', label: '7ths', tip: 'Four-note chords: a seventh on top, richer and jazzier.' },
] as const;

/** Inversion choices (a 7th chord has a third inversion). */
function inversionOptions(size: 3 | 4) {
  const all = [
    { value: 'smooth', label: 'Smooth' },
    { value: '0', label: 'Root position' },
    { value: '1', label: '1st inversion' },
    { value: '2', label: '2nd inversion' },
    { value: '3', label: '3rd inversion' },
  ];
  return size === 4 ? all : all.slice(0, 4);
}

/* ------------------------------------------------------------------ */
/* Pads                                                                */
/* ------------------------------------------------------------------ */

const NOTE_PAD_ID = 'note-pad-';
const onNoteGridKey = padGridKeyDown(NOTE_PAD_ID);

const NotePad = memo(function NotePad(props: { trackId: Id; index: number; pitch: number; name: string; isRoot: boolean; inKey: boolean; disabled: boolean; onHit(name: string, velocity: number): void }) {
  const { trackId, index, pitch, name, isRoot, inKey, disabled, onHit } = props;
  const lit = useRuntime((s) => s.held[trackId]?.includes(pitch) ?? false);
  // Releases the pitch sounding under this pad as struck, even if the octave moves meanwhile.
  const release = useRef<(() => void) | null>(null);
  const onPress = useCallback(
    (e: PadPressEvent) => {
      release.current?.();
      release.current = playLive(trackId, pitch, e.velocity, 'pad');
      onHit(name, e.velocity);
    },
    [trackId, pitch, name, onHit],
  );
  const onRelease = useCallback(() => {
    const r = release.current;
    release.current = null;
    r?.();
  }, []);
  const spoken = `${name}${isRoot ? ', root note' : ''}${inKey ? '' : ', outside the key'}`;
  return (
    <div className={styles.cell} data-root={isRoot || undefined} data-outside={!inKey || undefined}>
      <Pad
        id={`${NOTE_PAD_ID}${index}`}
        state={lit ? 'playing' : 'ready'}
        caption={null}
        label={name}
        disabled={disabled}
        onPress={onPress}
        onRelease={onRelease}
        ariaLabel={spoken}
        className={styles.pad}
      />
      {isRoot && (
        <span className={styles.rootMark} aria-hidden="true">
          Root
        </span>
      )}
    </div>
  );
});

const ChordPad = memo(function ChordPad(props: { trackId: Id; index: number; chord: ChordPadInfo; spelled: string; disabled: boolean; onHit(name: string, velocity: number): void }) {
  const { trackId, index, chord, spelled, disabled, onHit } = props;
  const notesKey = chord.notes.join(',');
  // Lit while every note of this chord sounds on the part.
  const lit = useRuntime((s) => {
    const held = s.held[trackId];
    return !!held && notesKey.split(',').every((n) => held.includes(Number(n)));
  });
  // Releases the chord struck, even if the size, inversion or key changes meanwhile.
  const release = useRef<(() => void) | null>(null);
  const onPress = useCallback(
    (e: PadPressEvent) => {
      release.current?.();
      release.current = playChord(
        trackId,
        notesKey.split(',').map((n) => Number(n)),
        e.velocity,
      );
      onHit(chord.name, e.velocity);
    },
    [trackId, notesKey, chord.name, onHit],
  );
  const onRelease = useCallback(() => {
    const r = release.current;
    release.current = null;
    r?.();
  }, []);
  return (
    <div className={styles.cell} data-chord="" data-notes={notesKey}>
      <Pad
        id={`${NOTE_PAD_ID}${index}`}
        state={lit ? 'playing' : 'ready'}
        caption={null}
        label={chord.name}
        disabled={disabled}
        onPress={onPress}
        onRelease={onRelease}
        ariaLabel={`${chord.name} chord, degree ${chord.degree + 1}: ${spelled}`}
        className={styles.pad}
      />
      <span className={`${styles.degree} mono`} aria-hidden="true">
        {chord.degree + 1}
      </span>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function NoteLayout(props: { part: PartInfo; melodicParts: readonly PartInfo[] }) {
  const { part, melodicParts } = props;
  const trackId = part.id;
  const root = useProject((p) => p.root);
  const scale = useProject((p) => p.scale);
  const assist = useProject((p) => p.assist);
  const storedOctave = useUi((s) => s.notesOctave);
  const chordsOn = useUi((s) => s.notesChords.on);
  const size = useUi((s) => s.notesChords.size);
  const storedInversion = useStore(chordVoicingStore, (s) => s.inversion);
  const inversion: ChordInversion = size === 3 && storedInversion === 3 ? 'smooth' : storedInversion;
  const replaying = useReplaying();
  const locked = useEditLocked();
  const [writing, setWriting] = useState(false);
  const writeRef = useRef<HTMLButtonElement>(null);
  // The last note or chord struck, remembered with its part (the readout only shows this part's).
  const [hit, setHit] = useState<{ trackId: Id; name: string; velocity: number } | null>(null);
  const onHit = useCallback((name: string, velocity: number) => setHit({ trackId, name, velocity }), [trackId]);
  const shownHit = hit && hit.trackId === trackId ? hit : null;
  const { gridRef, onFocus } = useRovingPads(NOTE_PAD_ID, 0);

  const top = useMemo(() => highestFullOctave(root, scale, assist), [root, scale, assist]);
  const octave = Math.min(storedOctave, top);
  const pitches = useMemo(() => notePadPitches(root, scale, assist, octave), [root, scale, assist, octave]);
  const chordPads = useProject((p) => (chordsOn ? chordPadLayout(p, trackId, size, inversion) : []), sameLayout);
  const key: MusicalKey = useMemo(() => ({ root, scale }), [root, scale]);
  const refusal = useProject((p) => progressionRefusal(p, trackId));
  const low = pitches[0];
  const high = pitches[pitches.length - 1];
  // Note names spelled the way the key writes them (B♭ in G Dorian, not A#).
  const spell = (m: number) => noteName(m, key);
  const rangeText = `${spell(low)}–${spell(high)}`;
  const keyName = keyLabel(root, scale);
  const chromaticScale = scale === 'chromatic';

  const explain = chordsOn
    ? `Chords: each pad plays a chord from ${keyName}.`
    : assist
      ? chromaticScale
        ? 'Musical Assist: the Chromatic scale includes every semitone.'
        : `Musical Assist: pads play only notes in ${keyName}.`
      : chromaticScale
        ? 'Chromatic: every semitone.'
        : `Chromatic: every semitone. Shaded pads are outside ${keyName}.`;

  const canDown = octave > OCTAVE_RANGE.min;
  const canUp = octave < top;
  const writeDisabled = locked || refusal !== null;

  return (
    <div className={shared.root}>
      <div className={shared.layout}>
        <div className={shared.info} role="group" aria-label={`Note pads for ${part.name}`}>
          {/* The key, and how the pads play it: single notes or chords. One block, so the panel fits at 1366 x 768. */}
          <div className={shared.block}>
            <p className={shared.eyebrow}>Key</p>
            <h3 className={shared.title}>{keyName}</h3>
            <p className={styles.explain} aria-live="polite">
              {explain}
            </p>
            <div className={styles.playRow}>
              <Switch
                checked={chordsOn}
                onChange={(on) => setNotesChords({ on })}
                label="Chords"
                size="sm"
                tone="teal"
                tip="One pad plays a whole chord from the key. The small number on a pad is the chord’s step in the key (1 = home)."
                detail="Off: each pad plays one note. Chords play exactly as written (Musical Assist has nothing to fix: they are already in the key). Record Notes, Performance and the arpeggiator take them like keys."
              />
            </div>
            {chordsOn && (
              <div className={styles.chordRow}>
                <SegmentedControl<'3' | '4'> label="Chord size" size="sm" options={SIZE_OPTIONS} value={String(size) as '3' | '4'} onChange={(v) => setNotesChords({ size: v === '4' ? 4 : 3 })} />
                <Select
                  label="Inversion"
                  hideLabel
                  size="sm"
                  value={String(inversion)}
                  options={inversionOptions(size)}
                  onChange={(v) => setChordInversion(v === 'smooth' ? 'smooth' : (Number(v) as 0 | 1 | 2 | 3))}
                  tip="Which note of each chord is at the bottom. Smooth keeps every chord close to the others, so changes move little."
                  className={styles.inversion}
                />
              </div>
            )}
          </div>

          {!chordsOn && (
            <div className={shared.block}>
              <p className={shared.eyebrow}>Range</p>
              <div className={styles.rangeRow}>
                <IconButton
                  icon="octaveDown"
                  label="Pads octave down"
                  size="sm"
                  variant="secondary"
                  disabled={!canDown}
                  onClick={() => setNotesOctave(octave - 1)}
                  tip="Move all 16 pads one octave lower."
                />
                <output className={`${styles.range} mono`} aria-label={`Pads play ${spell(low)} to ${spell(high)}`}>
                  {rangeText}
                </output>
                <IconButton icon="octaveUp" label="Pads octave up" size="sm" variant="secondary" disabled={!canUp} onClick={() => setNotesOctave(octave + 1)} tip="Move all 16 pads one octave higher." />
              </div>
            </div>
          )}

          {/* The part, and writing a progression into its selected clip. */}
          <div className={shared.block}>
            <div className={styles.partHead}>
              <p className={shared.eyebrow}>Part</p>
              <Button
                ref={writeRef}
                size="sm"
                variant="secondary"
                icon="pencil"
                disabled={writeDisabled}
                onClick={() => setWriting(true)}
                aria-describedby={writeDisabled ? `write-why-${trackId}` : undefined}
                tip="A common chord progression, in the key, written into this part's selected clip."
              >
                Write a progression…
              </Button>
            </div>
            <PartSwitch parts={melodicParts} selectedId={trackId} label="Part the note pads play" columns={melodicParts.length > 3 ? 2 : 1} compact={melodicParts.length > 3} />
            {writeDisabled && (
              <p id={`write-why-${trackId}`} className={styles.writeWhy}>
                {locked ? `${LOCKED_REASON}.` : refusal}
              </p>
            )}
          </div>

          <div className={shared.block}>
            <HitReadout label={chordsOn ? 'Last chord' : 'Last note'} hit={shownHit ? { name: shownHit.name, velocity: shownHit.velocity } : null} />
          </div>

          <div className={shared.foot}>
            <p className={shared.hint}>Strike lower on a pad to play louder.</p>
          </div>
        </div>

        <div className={shared.gridWrap}>
          <div className={shared.stage}>
            <PartStatus part={part} />
            <div
              ref={gridRef}
              className={shared.grid}
              role="group"
              aria-label={
                chordsOn
                  ? `Chord pads for ${part.name} in ${keyName}, 4 by 4, the home chord bottom-left. Arrow keys move between pads.`
                  : `Note pads for ${part.name}, ${rangeText}, 4 by 4, lowest note bottom-left. Arrow keys move between pads.`
              }
              onKeyDown={onNoteGridKey}
              onFocus={onFocus}
              {...{ [PAD_GRID_ATTR]: '' }}
            >
              {chordsOn
                ? PAD_ORDER.map((index) => {
                    const chord = chordPads[index];
                    if (!chord) return <div key={index} className={styles.cell} />;
                    return (
                      <ChordPad
                        key={index}
                        trackId={trackId}
                        index={index}
                        chord={chord}
                        spelled={chord.notes.map(spell).join(', ')}
                        disabled={replaying}
                        onHit={onHit}
                      />
                    );
                  })
                : PAD_ORDER.map((index) => {
                    const pitch = pitches[index];
                    if (pitch === undefined) return <div key={index} className={styles.cell} />;
                    return (
                      <NotePad
                        key={index}
                        trackId={trackId}
                        index={index}
                        pitch={pitch}
                        name={spell(pitch)}
                        isRoot={pitchClass(pitch) === pitchClass(root)}
                        inKey={assist || chromaticScale || isInScale(pitch, root, scale)}
                        disabled={replaying}
                        onHit={onHit}
                      />
                    );
                  })}
            </div>
          </div>
        </div>
      </div>
      {writing && <ProgressionDialog trackId={trackId} onClose={() => setWriting(false)} />}
    </div>
  );
}

export function NotesPads() {
  const trackId = useUi((s) => s.selectedTrackId);
  const parts = useParts();
  const part = parts.find((p) => p.id === trackId);
  const melodicParts = useMemo(() => parts.filter((p) => p.kind !== 'drums'), [parts]);
  if (!part || part.kind === 'drums') return <PartChooser mode="notes" current={part} options={melodicParts} />;
  // Not keyed by part: the part switch keeps keyboard focus when it changes the part.
  return <NoteLayout part={part} melodicParts={melodicParts} />;
}
