/**
 * Notes mode: a 4x4 scale-aware note layout for the selected melodic part.
 *
 * With Musical Assist on, the 16 pads play consecutive notes of the project
 * key (bottom-left = the first in-key note from the chosen octave's C), so
 * nothing played can sound "wrong"; with Assist off they are 16 chromatic
 * semitones and notes outside the key are shaded. Root notes carry a ROOT
 * mark and a teal ring (like the keyboard's root keys). Pads play through the
 * session with a velocity from where they are struck and light while held.
 * Octave down/up moves the whole layout; the range is shown as text.
 *
 * Changing the pad view never touches playback or the project.
 */
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { IconButton, Pad, type PadPressEvent } from '../../ui/components';
import { isInScale, keyLabel, noteName, pitchClass, scaleDegreesInRange } from '../../music/scales';
import type { Id, ScaleId } from '../../project/types';
import { OCTAVE_RANGE, setNotesOctave } from '../../state/uiStore';
import { useProject, useUi } from '../instance';
import { useRuntime } from '../runtime';
import { HitReadout, PAD_GRID_ATTR, PAD_ORDER, PartChooser, PartStatus, PartSwitch, padGridKeyDown, playLive, useParts, useReplaying, useRovingPads, type PartInfo } from './DrumPads';
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

const NOTE_PAD_ID = 'note-pad-';
const onNoteGridKey = padGridKeyDown(NOTE_PAD_ID);

const NotePad = memo(function NotePad(props: { trackId: Id; index: number; pitch: number; isRoot: boolean; inKey: boolean; disabled: boolean; onHit(pitch: number, velocity: number): void }) {
  const { trackId, index, pitch, isRoot, inKey, disabled, onHit } = props;
  const lit = useRuntime((s) => s.held[trackId]?.includes(pitch) ?? false);
  // Releases the pitch sounding under this pad as struck, even if the octave moves meanwhile.
  const release = useRef<(() => void) | null>(null);
  const onPress = useCallback(
    (e: PadPressEvent) => {
      release.current?.();
      release.current = playLive(trackId, pitch, e.velocity, 'pad');
      onHit(pitch, e.velocity);
    },
    [trackId, pitch, onHit],
  );
  const onRelease = useCallback(() => {
    const r = release.current;
    release.current = null;
    r?.();
  }, []);
  const name = noteName(pitch);
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

function NoteLayout(props: { part: PartInfo; melodicParts: readonly PartInfo[] }) {
  const { part, melodicParts } = props;
  const trackId = part.id;
  const root = useProject((p) => p.root);
  const scale = useProject((p) => p.scale);
  const assist = useProject((p) => p.assist);
  const storedOctave = useUi((s) => s.notesOctave);
  const replaying = useReplaying();
  // The last note struck, remembered with its part (the readout only shows this part's).
  const [hit, setHit] = useState<{ trackId: Id; pitch: number; velocity: number } | null>(null);
  const onHit = useCallback((pitch: number, velocity: number) => setHit({ trackId, pitch, velocity }), [trackId]);
  const shownHit = hit && hit.trackId === trackId ? hit : null;
  const { gridRef, onFocus } = useRovingPads(NOTE_PAD_ID, 0);

  const top = useMemo(() => highestFullOctave(root, scale, assist), [root, scale, assist]);
  const octave = Math.min(storedOctave, top);
  const pitches = useMemo(() => notePadPitches(root, scale, assist, octave), [root, scale, assist, octave]);
  const low = pitches[0];
  const high = pitches[pitches.length - 1];
  const rangeText = `${noteName(low)}–${noteName(high)}`;
  const key = keyLabel(root, scale);
  const chromaticScale = scale === 'chromatic';

  const explain = assist ? (chromaticScale ? 'Musical Assist: the Chromatic scale includes every semitone.' : `Musical Assist: pads play only notes in ${key}.`) : 'Chromatic: every semitone.';
  const detail = assist || chromaticScale ? 'Root notes are marked ROOT.' : `Shaded pads are outside ${key}. Root notes are marked ROOT.`;

  const canDown = octave > OCTAVE_RANGE.min;
  const canUp = octave < top;

  return (
    <div className={shared.root}>
      <div className={shared.layout}>
        <div className={shared.info} role="group" aria-label={`Note pads for ${part.name}`}>
          <div className={shared.block}>
            <p className={shared.eyebrow}>Key</p>
            <h3 className={shared.title}>{key}</h3>
            <p className={styles.explain} aria-live="polite">
              {explain}
            </p>
            <p className={shared.desc}>{detail}</p>
          </div>

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
              <output className={`${styles.range} mono`} aria-label={`Pads play ${noteName(low)} to ${noteName(high)}`}>
                {rangeText}
              </output>
              <IconButton icon="octaveUp" label="Pads octave up" size="sm" variant="secondary" disabled={!canUp} onClick={() => setNotesOctave(octave + 1)} tip="Move all 16 pads one octave higher." />
            </div>
          </div>

          <div className={shared.block}>
            <p className={shared.eyebrow}>Part</p>
            <PartSwitch parts={melodicParts} selectedId={trackId} label="Part the note pads play" columns={melodicParts.length > 3 ? 2 : 1} compact={melodicParts.length > 3} />
          </div>

          <div className={shared.block}>
            <HitReadout label="Last note" hit={shownHit ? { name: noteName(shownHit.pitch), velocity: shownHit.velocity } : null} />
          </div>

          <div className={shared.foot}>
            <p className={shared.hint}>Tap pads to play {part.name}.</p>
            <p className={shared.subHint}>Strike lower on a pad to play louder.</p>
          </div>
        </div>

        <div className={shared.gridWrap}>
          <div className={shared.stage}>
            <PartStatus part={part} />
            <div
              ref={gridRef}
              className={shared.grid}
              role="group"
              aria-label={`Note pads for ${part.name}, ${rangeText}, 4 by 4, lowest note bottom-left. Arrow keys move between pads.`}
              onKeyDown={onNoteGridKey}
              onFocus={onFocus}
              {...{ [PAD_GRID_ATTR]: '' }}
            >
              {PAD_ORDER.map((index) => {
                const pitch = pitches[index];
                if (pitch === undefined) return <div key={index} className={styles.cell} />;
                return (
                  <NotePad
                    key={index}
                    trackId={trackId}
                    index={index}
                    pitch={pitch}
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
