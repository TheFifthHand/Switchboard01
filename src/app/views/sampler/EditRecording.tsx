/**
 * Edit the recording, Audacity-style: Normalize, Reverse, Crop to the
 * region, Fade in, Fade out and Gain, each on the trimmed region (what the
 * part plays). Each edit makes a new version of the recording for the part
 * in one undo step (sampleVersions.ts); the status line says what changed.
 */
import { useId, useState } from 'react';
import { Button, Icon, NumberField, Select } from '../../../ui/components';
import type { Id } from '../../../project/types';
import { useStore } from '../../../state/store';
import { useRuntime } from '../../runtime';
import { useAudioInput } from '../devices';
import { FADE_LENGTHS, GAIN_EDIT_LIMIT_DB, type FadeLength, type SampleEdit, type SampleEditKind } from './sampleEdit';
import { clearEditStatus, editRecording, editStore } from './sampleVersions';
import { useSamplerValues } from './samplerValues';
import styles from './RecordEdit.module.css';

const FADE_OPTIONS = FADE_LENGTHS.map((f) => ({ value: f.value, label: f.label }));

const WORKING: Record<SampleEditKind, string> = {
  normalize: 'Normalizing…',
  reverse: 'Reversing…',
  crop: 'Cropping…',
  fadeIn: 'Fading in…',
  fadeOut: 'Fading out…',
  gain: 'Changing the gain…',
};

export function EditRecording(props: { trackId: Id; available: boolean }) {
  const { trackId, available } = props;
  const titleId = useId();
  const status = useStore(editStore, (s) => s[trackId] ?? { phase: 'idle' as const });
  const takeLocked = useRuntime((s) => s.recording === 'performance');
  const recordingHere = useAudioInput((s) => s.take !== null && s.take.trackId === trackId);
  const region = useSamplerValues(trackId, ['start', 'end'] as const);
  const [fade, setFade] = useState<FadeLength>('half');
  const [gainDb, setGainDb] = useState(3);
  const working = status.phase === 'working';
  const whole = Math.min(region.start, region.end) <= 0.0005 && Math.max(region.start, region.end) >= 0.9995;
  const blocked = takeLocked
    ? 'A performance is recording, so the recording can’t change until you stop.'
    : recordingHere
      ? 'Audio is being recorded onto this part.'
      : !available
        ? 'This recording’s audio is not in this browser, so it cannot be edited.'
        : null;

  const run = (edit: SampleEdit) => {
    if (working || blocked) return;
    void editRecording(trackId, edit);
  };

  const key = (kind: SampleEditKind, label: string, tip: string, edit: () => SampleEdit, extra: { disabledWhy?: string | null } = {}) => {
    const why = blocked ?? extra.disabledWhy ?? null;
    return (
      <Button
        size="sm"
        className={styles.editKey}
        disabled={!!why}
        // While an edit is made, the keys keep focus but do nothing.
        aria-disabled={working || undefined}
        onClick={() => run(edit())}
        tip={why ?? tip}
      >
        {working && status.phase === 'working' && status.kind === kind ? WORKING[kind] : label}
      </Button>
    );
  };

  const tone = status.phase === 'done' ? (status.ok ? 'ok' : 'error') : blocked ? 'error' : undefined;
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <div className={styles.head}>
        <h3 id={titleId} className={styles.sectionTitle}>
          Edit recording
        </h3>
        <span className={styles.rule} aria-hidden="true" />
      </div>
      <p className={styles.fine}>Edits change the trimmed region (what plays, in amber). Each one makes a new version for this part; Undo goes back.</p>
      <div className={styles.editKeys} role="group" aria-label="Edits">
        {key('normalize', 'Normalize', 'Makes the region as loud as it can be without clipping: its loudest peak reaches -1 dB.', () => ({ kind: 'normalize' }))}
        {key('reverse', 'Reverse', 'Plays the region backwards.', () => ({ kind: 'reverse' }))}
        {key('crop', 'Crop to region', 'Keeps only the region and drops the rest of the recording. Start and End then cover all of it.', () => ({ kind: 'crop' }), {
          disabledWhy: whole ? 'The region already covers the whole recording. Move Start or End first, then crop.' : null,
        })}
        {key('fadeIn', 'Fade in', 'The start of the region rises from silence over the fade length.', () => ({ kind: 'fadeIn', length: fade }))}
        {key('fadeOut', 'Fade out', 'The end of the region falls to silence over the fade length.', () => ({ kind: 'fadeOut', length: fade }))}
      </div>
      <div className={styles.row}>
        <Select label="Fade length" layout="inline" size="sm" value={fade} options={FADE_OPTIONS} onChange={(v) => setFade(v as FadeLength)} disabled={!!blocked} tip="How long Fade in and Fade out take (never longer than the region)." />
        <div className={styles.gain}>
          <NumberField
            label="Gain"
            layout="inline"
            size="sm"
            value={gainDb}
            min={-GAIN_EDIT_LIMIT_DB}
            max={GAIN_EDIT_LIMIT_DB}
            step={0.5}
            fineStep={0.1}
            unit="dB"
            chars={5}
            disabled={!!blocked}
            onChange={(v) => setGainDb(v)}
            tip="How much louder (+) or quieter (−) Apply gain makes the region."
          />
          {key('gain', 'Apply gain', `Makes the region ${Math.abs(gainDb)} dB ${gainDb >= 0 ? 'louder' : 'quieter'}. Peaks over full scale would clip: Normalize never does.`, () => ({ kind: 'gain', db: gainDb }))}
        </div>
      </div>
      <div className={styles.status} role="status" aria-live="polite" data-tone={tone}>
        {working && (
          <>
            <span className={styles.spinner} aria-hidden="true" />
            <span className={styles.statusText}>{WORKING[status.kind]}</span>
          </>
        )}
        {!working && status.phase === 'done' && (
          <>
            <Icon name={status.ok ? 'check' : 'warning'} size={14} className={styles.statusIcon} />
            <span className={styles.statusText}>{status.message}</span>
            <button type="button" className={styles.dismiss} aria-label="Dismiss edit message" onClick={() => clearEditStatus(trackId)}>
              <Icon name="close" size={12} />
            </button>
          </>
        )}
        {!working && status.phase !== 'done' && blocked && (
          <>
            <Icon name="warning" size={14} className={styles.statusIcon} />
            <span className={styles.statusText}>{blocked}</span>
          </>
        )}
      </div>
    </section>
  );
}
