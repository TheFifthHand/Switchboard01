/**
 * Recording options: a small popover next to the record buttons with the
 * metronome, the one-bar count-in for Record Notes and how Record Notes
 * lines up played notes (quantize). Stored in the project settings;
 * metronome and count-in stay off unless chosen.
 */
import { useRef, useState } from 'react';
import { Icon, SegmentedControl, Switch, Tooltip } from '../../ui/components';
import type { ProjectSettings, QuantizeGrid } from '../../project/types';
import { setSettings } from '../../state/commands';
import { session, useProject } from '../instance';
import { Popover, anchorFromElement } from './ClipMenu';
import styles from './RecordOptions.module.css';

export const QUANTIZE_OPTIONS: readonly { value: QuantizeGrid; label: string; tip: string }[] = [
  { value: 'off', label: 'Off', tip: 'Keep notes exactly where you played them.' },
  { value: '1/4', label: '1/4', tip: 'Snap to the nearest beat.' },
  { value: '1/8', label: '1/8', tip: 'Snap to the nearest half-beat.' },
  { value: '1/16', label: '1/16', tip: 'Snap to the nearest sixteenth.' },
  { value: '1/32', label: '1/32', tip: 'Snap to a fine grid.' },
];

export const QUANTIZE_EXPLAINED: Record<QuantizeGrid, string> = {
  off: 'Notes stay exactly where you played them, with all of your own feel.',
  '1/4': 'Each note moves to the nearest beat. Good for simple, steady parts.',
  '1/8': 'Each note moves to the nearest half-beat.',
  '1/16': 'Each note moves to the nearest sixteenth: tight, and still natural.',
  '1/32': 'A fine grid: small slips are fixed and most of your feel stays.',
};

export function quantizeWord(q: QuantizeGrid): string {
  return q === 'off' ? 'off' : q;
}

/** The Record Notes grid in a word or two, for captions: "Snap 1/16", or "No snap" when off. */
export function quantizeCaption(q: QuantizeGrid): string {
  return q === 'off' ? 'No snap' : `Snap ${q}`;
}

/** Short text of the options that are on, for the record group caption ('' when none). */
export function recordOptionsCaption(s: ProjectSettings): string {
  return [s.metronome ? 'Click' : null, s.countIn ? 'Count-in' : null].filter(Boolean).join(' · ');
}

function change(partial: Partial<ProjectSettings>): void {
  session.accepted(setSettings(session.store, partial));
}

export function RecordOptionsPanel() {
  const metronome = useProject((p) => p.settings.metronome);
  const countIn = useProject((p) => p.settings.countIn);
  const quantize = useProject((p) => p.settings.recordQuantize);
  return (
    <div className={styles.panel}>
      <div className={styles.title}>Recording options</div>
      <div className={styles.option}>
        <Switch label="Metronome" checked={metronome} onChange={(on) => change({ metronome: on })} size="sm" />
        <p className={styles.help}>A click on every beat while playing. It is never part of an export.</p>
      </div>
      <div className={styles.option}>
        <Switch label="One-bar count-in" checked={countIn} onChange={(on) => change({ countIn: on })} size="sm" />
        <p className={styles.help}>When Record Notes starts playback, you hear one bar of clicks before recording begins.</p>
      </div>
      <div className={styles.option}>
        <span className={styles.label} aria-hidden="true">
          Record Notes timing
        </span>
        <SegmentedControl<QuantizeGrid> label="Record Notes quantize" size="sm" block options={QUANTIZE_OPTIONS} value={quantize} onChange={(v) => change({ recordQuantize: v })} />
        <p className={styles.help} aria-live="polite">
          <strong>{quantize === 'off' ? 'Off' : quantize}:</strong> {QUANTIZE_EXPLAINED[quantize]}
        </p>
        <p className={styles.help}>Notes the arpeggiator plays are recorded on its own grid, as you heard them.</p>
      </div>
    </div>
  );
}

export function RecordOptions() {
  const metronome = useProject((p) => p.settings.metronome);
  const countIn = useProject((p) => p.settings.countIn);
  const quantize = useProject((p) => p.settings.recordQuantize);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const state = `metronome ${metronome ? 'on' : 'off'}, count-in ${countIn ? 'on' : 'off'}, Record Notes quantize ${quantizeWord(quantize)}`;
  return (
    <>
      <Tooltip name="Recording options" tip="Metronome, one-bar count-in and how Record Notes lines up your timing." detail={`Now: ${state}.`}>
        <button
          ref={btnRef}
          type="button"
          className={styles.trigger}
          data-on={metronome || countIn || undefined}
          aria-label={`Recording options: ${state}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="metronome" size={16} />
          <span className={styles.led} aria-hidden="true" />
        </button>
      </Tooltip>
      {open && (
        <Popover
          anchor={anchorFromElement(btnRef.current)}
          role="dialog"
          label="Recording options"
          align="end"
          className={styles.popover}
          onClose={() => setOpen(false)}
          returnFocus={btnRef.current}
          ignore={btnRef.current}
        >
          <RecordOptionsPanel />
        </Popover>
      )}
    </>
  );
}
