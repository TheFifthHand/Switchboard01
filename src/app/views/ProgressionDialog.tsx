/**
 * "Write a progression…": write a common chord progression into the selected
 * clip of a melodic part, in the project's key (createProgressionClip, one
 * undo step). Pick a progression by its plain name — each shows its chords
 * spelled in the key — a rhythm (held, stabs or off-beats), triads or 7ths
 * and a length of 1 to 8 bars. The preview draws exactly the clip that will
 * be written (the command run on a scratch copy of the project) and each of
 * its chords can be heard by pressing it. Drum and sampler parts are refused
 * with the command's reason (progressionRefusal), shown where the button is.
 * Deterministic and made from fixed rules (music/chords), no AI.
 */
import { useId, useMemo, useState } from 'react';
import { Button, ClipSketch, Dialog, SegmentedControl } from '../../ui/components';
import { PROGRESSIONS, resolveProgression } from '../../music/chords';
import { keyLabel } from '../../music/scales';
import { CLIP_BAR_CHOICES, TICKS_PER_BAR, TICKS_PER_BEAT, type Id, type Note, type Project } from '../../project/types';
import { createProgressionClip, type ProgressionRhythm } from '../../state/commands';
import { ProjectStore } from '../../state/projectStore';
import { slotFor } from '../../state/uiStore';
import { session, useProject, useUi } from '../instance';
import { notify } from '../runtime';
import { useEditLocked } from './ClipMenu';
import styles from './ProgressionDialog.module.css';

const RHYTHM_OPTIONS: readonly { value: ProgressionRhythm; label: string; tip: string }[] = [
  { value: 'held', label: 'Held', tip: 'Each chord held until the next one.' },
  { value: 'stabs', label: 'Stabs', tip: 'A short chord on every beat.' },
  { value: 'offbeats', label: 'Off-beats', tip: 'Short chords between the beats, for a bouncy feel.' },
];

const SIZE_OPTIONS = [
  { value: '3', label: 'Triads', tip: 'Three-note chords.' },
  { value: '4', label: '7ths', tip: 'Four-note chords: a seventh on top.' },
] as const;

const BAR_OPTIONS = CLIP_BAR_CHOICES.map((b) => ({ value: String(b), label: String(b), tip: `${b} bar${b === 1 ? '' : 's'}` }));

/**
 * Why a part cannot take a progression (drums, samplers), in the command's
 * own words, or null when it can. A dry run on a scratch copy, so the reason
 * shown is exactly the one the command gives.
 */
export function progressionRefusal(p: Project, trackId: Id): string | null {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return 'That part no longer exists.';
  if (t.instrument.kind !== 'drums' && t.instrument.kind !== 'sampler') return null;
  const r = createProgressionClip(new ProjectStore(p), trackId, 0, { progressionId: PROGRESSIONS[0].id, rhythm: 'held', bars: 1, size: 3 });
  return r.changed ? null : (r.message ?? 'This part cannot take a progression.');
}

/** The chords as they will sound: the notes starting at each change of the first pass. */
function chordsOf(notes: readonly Note[], bars: number, changes: number): number[][] {
  const span = bars >= 4 ? TICKS_PER_BAR : bars * TICKS_PER_BEAT;
  const out: number[][] = [];
  for (let k = 0; k < changes; k++) {
    const inSpan = notes.filter((n) => n.tick >= k * span && n.tick < (k + 1) * span);
    if (inSpan.length === 0) break;
    const first = Math.min(...inSpan.map((n) => n.tick));
    out.push(inSpan.filter((n) => n.tick === first).map((n) => n.pitch).sort((a, b) => a - b));
  }
  return out;
}

export function ProgressionDialog(props: { trackId: Id; onClose(): void }) {
  const { trackId, onClose } = props;
  const listName = useId();
  const slot = useUi((s) => slotFor(s, trackId));
  const defaultSize = useUi((s) => s.notesChords.size);
  const project = useProject((p) => p);
  const locked = useEditLocked();
  const track = project.tracks.find((t) => t.id === trackId);
  const clip = track?.clips[slot] ?? null;
  const sceneName = project.scenes[slot]?.name ?? `Row ${slot + 1}`;
  const [progressionId, setProgressionId] = useState(PROGRESSIONS[0].id);
  const [rhythm, setRhythm] = useState<ProgressionRhythm>('held');
  const [bars, setBars] = useState<number>(() => (clip && (CLIP_BAR_CHOICES as readonly number[]).includes(clip.bars) ? clip.bars : 4));
  const [size, setSize] = useState<3 | 4>(defaultSize);
  const key = keyLabel(project.root, project.scale);

  const choices = useMemo(() => PROGRESSIONS.map((prog) => ({ prog, names: resolveProgression(project.root, project.scale, prog, size).names })), [project.root, project.scale, size]);
  const chosen = choices.find((c) => c.prog.id === progressionId) ?? choices[0];

  // Exactly what Write will do, on a scratch copy of the project.
  const preview = useMemo(() => {
    const scratch = new ProjectStore(project);
    const r = createProgressionClip(scratch, trackId, slot, { progressionId, rhythm, bars, size });
    const written = scratch.getState().tracks.find((t) => t.id === trackId)?.clips[slot] ?? null;
    return { ok: r.changed, reason: r.changed ? null : (r.message ?? null), message: r.message, notes: r.changed && written ? written.notes : [] };
  }, [project, trackId, slot, progressionId, rhythm, bars, size]);
  const heard = useMemo(() => chordsOf(preview.notes, bars, chosen.prog.degrees.length), [preview.notes, bars, chosen.prog.degrees.length]);

  const target = clip ? `“${clip.name}”` : `a new clip in ${sceneName}`;
  const replaces = clip && clip.notes.length > 0 ? `Replaces the ${clip.notes.length} note${clip.notes.length === 1 ? '' : 's'} in “${clip.name}” (Undo brings them back).` : null;

  const write = () => {
    const r = createProgressionClip(session.store, trackId, slot, { progressionId, rhythm, bars, size });
    if (!session.accepted(r)) return;
    onClose();
    const where = `${track?.name ?? 'the part'} · ${clip ? clip.name : sceneName}`;
    notify(`Wrote the ${chosen.prog.name} progression (${r.chords.join(' ')}) into ${where}, ${bars} bar${bars === 1 ? '' : 's'}.${r.message ? ` ${r.message}` : ''}`, 'info', 'undo');
  };
  const hear = (pitches: readonly number[]) => {
    for (const p of pitches) session.audition(trackId, p, 0.75, 700);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Write a progression"
      description={`Chords in ${key} for ${track?.name ?? 'this part'}, written into ${target}. One Undo takes it back.`}
      size="md"
      className={styles.dialog}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={write} disabled={!preview.ok || locked} icon="pencil">
            Write into {clip ? `“${clip.name}”` : 'a new clip'}
          </Button>
        </>
      }
    >
      <fieldset className={styles.list}>
        <legend className={styles.label}>Progression</legend>
        {choices.map(({ prog, names }) => (
          <label key={prog.id} className={styles.choice} data-on={prog.id === progressionId || undefined}>
            <input type="radio" name={listName} value={prog.id} checked={prog.id === progressionId} onChange={() => setProgressionId(prog.id)} className={styles.radio} />
            <span className={styles.choiceName}>{prog.name}</span>
            <span className={styles.choiceChords}>{names.join(' ')}</span>
            <span className={`${styles.choiceNumerals} mono`} aria-hidden="true">
              {prog.numerals}
            </span>
          </label>
        ))}
      </fieldset>

      <div className={styles.options}>
        <div className={styles.option}>
          <span className={styles.label} aria-hidden="true">
            Rhythm
          </span>
          <SegmentedControl<ProgressionRhythm> label="Rhythm" size="sm" options={RHYTHM_OPTIONS} value={rhythm} onChange={setRhythm} />
        </div>
        <div className={styles.option}>
          <span className={styles.label} aria-hidden="true">
            Chords
          </span>
          <SegmentedControl<'3' | '4'> label="Chord size" size="sm" options={SIZE_OPTIONS} value={String(size) as '3' | '4'} onChange={(v) => setSize(v === '4' ? 4 : 3)} />
        </div>
        <div className={styles.option}>
          <span className={styles.label} aria-hidden="true">
            Length
          </span>
          <SegmentedControl<string> label="Length in bars" size="sm" options={BAR_OPTIONS} value={String(bars)} onChange={(v) => setBars(Number(v))} />
          <span className={styles.unit} aria-hidden="true">
            bars
          </span>
        </div>
      </div>

      <section className={styles.preview} aria-label="Preview">
        <div className={styles.previewHead}>
          <span className={styles.label}>Preview</span>
          <span className={styles.previewNote}>Press a chord to hear it.</span>
        </div>
        {preview.ok ? (
          <>
            <div className={styles.sketch} aria-hidden="true">
              <ClipSketch notes={preview.notes} lengthTicks={bars * TICKS_PER_BAR} kind="notes" />
            </div>
            <div className={styles.hear} role="group" aria-label="Hear the chords">
              {heard.map((pitches, i) => (
                <button key={i} type="button" className={styles.chip} onClick={() => hear(pitches)} aria-label={`Hear ${chosen.names[i] ?? 'chord'}`}>
                  {chosen.names[i] ?? '?'}
                </button>
              ))}
            </div>
            {(replaces || preview.message) && <p className={styles.previewNote}>{[replaces, preview.message].filter(Boolean).join(' ')}</p>}
          </>
        ) : (
          <p className={styles.refused}>{preview.reason ?? 'This part cannot take a progression.'}</p>
        )}
      </section>
    </Dialog>
  );
}
