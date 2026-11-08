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
import { Button, Icon, IconButton, Pad, SegmentedControl, Select, Switch, type PadPressEvent } from '../../ui/components';
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
import { keyMood } from './keyMood';
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

/**
 * One note pad. `plain` (Simple, in the Song screen's editor): no note names; the song's home note says "Home"
 * with the home icon (and keeps its outline), the rest are plain squares, numbered for screen readers.
 */
const NotePad = memo(function NotePad(props: { trackId: Id; index: number; pitch: number; name: string; isRoot: boolean; inKey: boolean; disabled: boolean; plain?: boolean; onHit(name: string, velocity: number): void }) {
  const { trackId, index, pitch, name, isRoot, inKey, disabled, plain = false, onHit } = props;
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
  const spoken = plain ? `${isRoot ? 'Home note' : 'Note'}${inKey ? '' : ', outside the song’s key'}` : `${name}${isRoot ? ', root note' : ''}${inKey ? '' : ', outside the key'}`;
  return (
    <div className={styles.cell} data-root={isRoot || undefined} data-outside={!inKey || undefined}>
      <Pad
        id={`${NOTE_PAD_ID}${index}`}
        state={lit ? 'playing' : 'ready'}
        caption={null}
        label={plain ? '' : name}
        disabled={disabled}
        onPress={onPress}
        onRelease={onRelease}
        ariaLabel={spoken}
        className={styles.pad}
      />
      {isRoot &&
        (plain ? (
          <span className={`${styles.rootMark} ${styles.homeMark}`} aria-hidden="true">
            <Icon name="home" size={12} />
            Home
          </span>
        ) : (
          <span className={styles.rootMark} aria-hidden="true">
            Root
          </span>
        ))}
    </div>
  );
});

/** One chord pad. `plain` (Simple, in the Song screen's editor): no chord names; the home chord says "Home". */
const ChordPad = memo(function ChordPad(props: { trackId: Id; index: number; chord: ChordPadInfo; spelled: string; disabled: boolean; plain?: boolean; onHit(name: string, velocity: number): void }) {
  const { trackId, index, chord, spelled, disabled, plain = false, onHit } = props;
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
    <div className={styles.cell} data-chord="" data-notes={notesKey} data-root={(plain && chord.degree === 0) || undefined}>
      <Pad
        id={`${NOTE_PAD_ID}${index}`}
        state={lit ? 'playing' : 'ready'}
        caption={null}
        label={plain ? '' : chord.name}
        disabled={disabled}
        onPress={onPress}
        onRelease={onRelease}
        ariaLabel={plain ? `${chord.degree === 0 ? 'Home chord' : `Chord ${chord.degree + 1}`}` : `${chord.name} chord, degree ${chord.degree + 1}: ${spelled}`}
        className={styles.pad}
      />
      {plain ? (
        chord.degree === 0 && (
          <span className={`${styles.rootMark} ${styles.homeMark}`} aria-hidden="true">
            <Icon name="home" size={12} />
            Home
          </span>
        )
      ) : (
        <span className={`${styles.degree} mono`} aria-hidden="true">
          {chord.degree + 1}
        </span>
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function NoteLayout(props: { part: PartInfo; melodicParts: readonly PartInfo[]; embedded?: boolean }) {
  const { part, melodicParts, embedded = false } = props;
  const trackId = part.id;
  const root = useProject((p) => p.root);
  const scale = useProject((p) => p.scale);
  const assist = useProject((p) => p.assist);
  const storedOctave = useUi((s) => s.notesOctave);
  const chordsOn = useUi((s) => s.notesChords.on);
  const advanced = useUi((s) => s.uiMode === 'advanced');
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

  // Simple's Song-screen editor: squares without note or chord names (the home one marked).
  const plainPads = embedded && !advanced;
  const canDown = octave > OCTAVE_RANGE.min;
  const canUp = octave < top;
  const writeDisabled = locked || refusal !== null;

  const pads = (
    <div className={shared.gridWrap}>
      <div className={shared.stage}>
        <PartStatus part={part} plain={embedded} />
        <div
          ref={gridRef}
          className={shared.grid}
          role="group"
          aria-label={
            chordsOn
              ? plainPads
                ? `Chord squares for ${part.name}, 4 by 4, the home chord bottom-left. Arrow keys move between them.`
                : `Chord pads for ${part.name} in ${keyName}, 4 by 4, the home chord bottom-left. Arrow keys move between pads.`
              : plainPads
                ? `Note squares for ${part.name}, 4 by 4, lowest note bottom-left. Arrow keys move between them.`
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
                    plain={plainPads}
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
                    plain={plainPads}
                    onHit={onHit}
                  />
                );
              })}
        </div>
      </div>
    </div>
  );

  if (embedded) {
    // The Song screen's editor (Play side): how the pads play, then the pads. Simple says it without note names (and calls them squares).
    const plainExplain = chordsOn ? 'Each square plays a chord that fits your song.' : assist || chromaticScale ? 'Every square plays a note that fits your song.' : 'Shaded squares are outside the song’s key.';
    return (
      <div className={shared.root} data-embedded="">
        <div className={styles.embed}>
          <div className={styles.embedSide} role="group" aria-label={`How the squares play ${part.name}`}>
            <Switch checked={chordsOn} onChange={(on) => setNotesChords({ on })} label="Chords" size="sm" tone="teal" tip="One square plays a whole chord that fits your song." />
            {chordsOn && advanced && (
              <div className={styles.chordRow}>
                <SegmentedControl<'3' | '4'> label="Chord size" size="sm" options={SIZE_OPTIONS} value={String(size) as '3' | '4'} onChange={(v) => setNotesChords({ size: v === '4' ? 4 : 3 })} />
                <Select
                  label="Inversion"
                  hideLabel
                  size="sm"
                  value={String(inversion)}
                  options={inversionOptions(size)}
                  onChange={(v) => setChordInversion(v === 'smooth' ? 'smooth' : (Number(v) as 0 | 1 | 2 | 3))}
                  className={styles.inversion}
                />
              </div>
            )}
            {!chordsOn &&
              (advanced ? (
                <div className={styles.rangeRow}>
                  <IconButton icon="octaveDown" label="Pads octave down" size="sm" variant="secondary" disabled={!canDown} onClick={() => setNotesOctave(octave - 1)} tip="Move all 16 pads one octave lower." />
                  <output className={`${styles.range} mono`} aria-label={`Pads play ${spell(low)} to ${spell(high)}`}>
                    {rangeText}
                  </output>
                  <IconButton icon="octaveUp" label="Pads octave up" size="sm" variant="secondary" disabled={!canUp} onClick={() => setNotesOctave(octave + 1)} tip="Move all 16 pads one octave higher." />
                </div>
              ) : (
                <div className={styles.rangeRow} role="group" aria-label="Notes higher or lower">
                  <Button size="sm" variant="secondary" icon="octaveDown" disabled={!canDown} onClick={() => setNotesOctave(octave - 1)} tip="Every square plays lower notes.">
                    Lower
                  </Button>
                  <Button size="sm" variant="secondary" icon="octaveUp" disabled={!canUp} onClick={() => setNotesOctave(octave + 1)} tip="Every square plays higher notes.">
                    Higher
                  </Button>
                </div>
              ))}
            <p className={styles.explain} aria-live="polite">
              {advanced ? explain : plainExplain}
            </p>
          </div>
          {pads}
        </div>
      </div>
    );
  }

  return (
    <div className={shared.root}>
      <div className={shared.layout}>
        <div className={shared.info} role="group" aria-label={`Note pads for ${part.name}`}>
          {/* The key, and how the pads play it: single notes or chords. One block, so the panel fits at 1366 x 768. */}
          <div className={shared.block}>
            <p className={shared.eyebrow}>Key</p>
            {/* In everyday words ("G · jazzy minor"); the scale's own name is in Advanced and on hover. */}
            <h3 className={shared.title} title={keyName} aria-label={advanced ? keyName : `${keyMood(root, scale)}, ${keyName}`}>
              {advanced ? keyName : keyMood(root, scale)}
            </h3>
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
                tip="A common chord progression, in the key, written into this part's selected loop."
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

        {pads}
      </div>
      {writing && <ProgressionDialog trackId={trackId} onClose={() => setWriting(false)} />}
    </div>
  );
}

/**
 * The note (or chord) pads of one melodic part, for the Song screen's editor
 * (its Play side): the Chords switch and Lower / Higher beside the pads.
 */
export function EditorNotePads(props: { trackId: Id }) {
  const parts = useParts();
  const part = parts.find((p) => p.id === props.trackId);
  if (!part || part.kind === 'drums') return null;
  return <NoteLayout part={part} melodicParts={[]} embedded />;
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
