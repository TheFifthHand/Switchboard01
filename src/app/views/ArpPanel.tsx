/**
 * Arpeggiator controls for the selected melodic part.
 *
 * `ArpStrip` is the compact block in the keyboard strip: an On/Off switch
 * and a summary key ("1/16 · Up · 1 oct") that opens `ArpSettings` above it
 * (rate, pattern, octave range, latch, gate). The arp itself runs in the
 * sequencer on the audio clock, so it follows the transport and tempo; the
 * notes it receives are already snapped by Musical Assist.
 */
import { useRef, useState, type RefObject } from 'react';
import { Icon, Knob, SegmentedControl, Switch } from '../../ui/components';
import { keyLabel } from '../../music/scales';
import type { ParamSpec } from '../../project/params';
import type { ArpDivision, ArpMode, ArpSettings as ArpSettingsData, Id } from '../../project/types';
import { setArp } from '../../state/commands';
import { session, useProject } from '../instance';
import { Popover, anchorFromElement } from './ClipMenu';
import styles from './ArpPanel.module.css';

export const ARP_DIVISION_OPTIONS: readonly { value: ArpDivision; label: string; tip: string }[] = [
  { value: '1/4', label: '1/4', tip: 'One note per beat.' },
  { value: '1/8', label: '1/8', tip: 'Two notes per beat.' },
  { value: '1/8T', label: '1/8T', tip: 'Three notes per beat (eighth-note triplets).' },
  { value: '1/16', label: '1/16', tip: 'Four notes per beat.' },
  { value: '1/16T', label: '1/16T', tip: 'Six notes per beat (sixteenth-note triplets).' },
  { value: '1/32', label: '1/32', tip: 'Eight notes per beat — a fast shimmer.' },
];

export const ARP_MODE_OPTIONS: readonly { value: ArpMode; label: string; tip: string }[] = [
  { value: 'up', label: 'Up', tip: 'Lowest held note to highest, then again.' },
  { value: 'down', label: 'Down', tip: 'Highest held note to lowest.' },
  { value: 'updown', label: 'Up-Down', tip: 'Up, then back down.' },
  { value: 'played', label: 'As played', tip: 'In the order you pressed the keys.' },
];

const OCTAVE_OPTIONS = [
  { value: '1', label: '1 oct', tip: 'Only the keys you hold.' },
  { value: '2', label: '2 oct', tip: 'Repeats the pattern one octave higher.' },
  { value: '3', label: '3 oct', tip: 'Climbs through three octaves.' },
] as const;

const MODE_SHORT: Record<ArpMode, string> = { up: 'Up', down: 'Down', updown: 'Up-Down', played: 'As played' };

export const ARP_GATE_SPEC: ParamSpec = {
  id: 'gate',
  label: 'Gate',
  min: 0.1,
  max: 1,
  default: 0.6,
  unit: '%',
  curve: 'lin',
  tip: 'How long each arp note sounds: low is short and plucky, high is smooth and connected.',
  detail: 'Note length as a share of each step (10–100%).',
};

export function arpSummary(arp: ArpSettingsData): string {
  return `${arp.division} · ${MODE_SHORT[arp.mode]} · ${arp.octaves} oct${arp.latch ? ' · Latch' : ''}`;
}

function update(trackId: Id, partial: Partial<ArpSettingsData>): void {
  session.accepted(setArp(session.store, trackId, partial));
}

/** Full settings, shown in a popover above the keyboard strip. */
export function ArpSettings({ trackId }: { trackId: Id }) {
  const arp = useProject((p) => p.tracks.find((t) => t.id === trackId)?.arp ?? null);
  const name = useProject((p) => p.tracks.find((t) => t.id === trackId)?.name ?? '');
  const assist = useProject((p) => p.assist);
  const keyName = useProject((p) => keyLabel(p.root, p.scale));
  // Gate knob: shown live while dragging, stored once when the gesture ends (one undo step).
  const [gateDraft, setGateDraft] = useState<number | null>(null);
  if (!arp) return null;
  return (
    <div className={styles.settings}>
      <div className={styles.head}>
        <div className={styles.titles}>
          <div className={styles.eyebrow}>{name}</div>
          <div className={styles.title}>Arpeggiator</div>
        </div>
        <Switch label="Arpeggiator" hideLabel checked={arp.enabled} onChange={(on) => update(trackId, { enabled: on })} size="sm" onText="On" offText="Off" />
      </div>

      <div className={styles.field}>
        <span className={styles.label} aria-hidden="true">
          Rate
        </span>
        <SegmentedControl<ArpDivision> label="Arpeggiator rate" size="sm" block options={ARP_DIVISION_OPTIONS} value={arp.division} onChange={(v) => update(trackId, { division: v })} />
      </div>
      <div className={styles.field}>
        <span className={styles.label} aria-hidden="true">
          Pattern
        </span>
        <SegmentedControl<ArpMode> label="Arpeggiator pattern" size="sm" block options={ARP_MODE_OPTIONS} value={arp.mode} onChange={(v) => update(trackId, { mode: v })} />
      </div>
      <div className={styles.row}>
        <div className={styles.field}>
          <span className={styles.label} aria-hidden="true">
            Range
          </span>
          <SegmentedControl<'1' | '2' | '3'>
            label="Arpeggiator octave range"
            size="sm"
            options={OCTAVE_OPTIONS}
            value={String(arp.octaves) as '1' | '2' | '3'}
            onChange={(v) => update(trackId, { octaves: Number(v) as 1 | 2 | 3 })}
          />
        </div>
        <Knob
          spec={ARP_GATE_SPEC}
          value={gateDraft ?? arp.gate}
          size="sm"
          className={styles.gate}
          onChange={(v, info) => {
            if (info.final) {
              setGateDraft(null);
              update(trackId, { gate: v });
            } else setGateDraft(v);
          }}
        />
      </div>
      <Switch
        label="Latch"
        checked={arp.latch}
        onChange={(on) => update(trackId, { latch: on })}
        size="sm"
        tip="Keeps the pattern going after you let go of the keys. Press new keys to change it; switch Latch off to end it."
        detail="Stopping playback also ends a latched pattern."
      />
      <p className={styles.tip}>
        Hold keys and the arpeggiator plays them one at a time, in time with the beat — it keeps time even while playback is stopped.{' '}
        {assist ? `Musical Assist keeps every note in ${keyName}.` : 'Musical Assist is off, so it plays exactly the keys you hold.'}
      </p>
    </div>
  );
}

/** Compact block for the keyboard strip. */
export function ArpStrip({ trackId, stripRef }: { trackId: Id; stripRef?: RefObject<HTMLElement | null> }) {
  const arp = useProject((p) => p.tracks.find((t) => t.id === trackId)?.arp ?? null);
  const isDrums = useProject((p) => p.tracks.find((t) => t.id === trackId)?.instrument.kind === 'drums');
  const name = useProject((p) => p.tracks.find((t) => t.id === trackId)?.name ?? '');
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Selecting a drum part closes the settings, so they do not pop up again later on their own.
  if (isDrums && open) setOpen(false);
  if (!arp) return null;

  if (isDrums) {
    return (
      <div className={styles.strip} role="group" aria-label="Arpeggiator">
        <span className={styles.stripTitle}>Arpeggiator</span>
        <p className={styles.stripNote}>For melodic parts. {name} plays a drum kit: select a synth or sampler part to use it.</p>
      </div>
    );
  }

  const summary = arpSummary(arp);
  return (
    <div className={styles.strip} role="group" aria-label="Arpeggiator">
      <Switch
        label="Arp"
        size="sm"
        checked={arp.enabled}
        onChange={(on) => update(trackId, { enabled: on })}
        tip="Turns held keys into a rhythmic pattern that plays in time with the beat."
        detail={`Musical Assist keeps it in key. Settings: ${summary}.`}
      />
      <button
        ref={btnRef}
        type="button"
        className={styles.summary}
        data-on={arp.enabled || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Arpeggiator settings for ${name}: ${summary}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`${styles.summaryText} mono`}>{summary}</span>
        <Icon name={open ? 'chevronDown' : 'chevronUp'} size={12} />
      </button>
      {open && (
        <Popover
          anchor={anchorFromElement(btnRef.current)}
          placement="above"
          role="dialog"
          label={`Arpeggiator settings for ${name}`}
          className={styles.popover}
          onClose={() => setOpen(false)}
          returnFocus={btnRef.current}
          ignore={stripRef?.current ?? btnRef.current}
        >
          <ArpSettings trackId={trackId} />
        </Popover>
      )}
    </div>
  );
}
