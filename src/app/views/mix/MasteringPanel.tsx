/**
 * Mastering: the finishing chain on the whole mix (Project.mastering).
 *
 *   MASTERING ───────────────────────── [Compare A/B] [On/Off]
 *   Presets   [Clean] [Warm] [Punchy] …  + what the chosen one does
 *   Loudness  target (Streaming −14 · Gentle −18 · Loud −9)
 *             Momentary · Short-term · Integrated · True peak   [Reset]
 *             [Match target]  how far from the target, what Match did
 *   Spectrum  lows · mids · highs of the output
 *   Advanced: every control as knobs, grouped Clean-up / EQ / Glue (with the
 *             Glue gain-reduction indicator) / Colour / Stereo / Loudness.
 *
 * Live readouts (loudness, Glue) are written to the DOM from
 * requestAnimationFrame loops a few times a second; React only renders when a
 * setting, the mode or "is there a measurement" changes. Edits are undoable
 * commands (one step per knob gesture); a performance take refuses them and
 * the panel says why.
 */
import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { Button, Icon, IconButton, Knob, Panel, SegmentedControl, Switch, Tooltip, useRafLoop } from '../../../ui/components';
import { MASTERING_PRESETS } from '../../../content/mastering';
import { MASTERING_PARAMS, readParam, specById, type ParamSpec } from '../../../project/params';
import {
  MASTERING_LOCKED_MESSAGE,
  applyMasteringPreset,
  matchLoudnessTarget,
  setMasteringEnabled,
  setMasteringParam,
  type CommandResult,
  type LoudnessMatch,
} from '../../../state/commands';
import { session, useProject } from '../../instance';
import { notify, runtimeStore, useRuntime } from '../../runtime';
import { engageCompare, releaseCompare, useCompare } from './compare';
import { formatDb, formatLoudness, mixFrameLive, readMixFrame } from './mixMeters';
import { LOUDNESS_TARGETS, setLoudnessTarget, useLoudnessTarget, type LoudnessTarget, type LoudnessTargetId } from './mixPrefs';
import { Spectrum } from './Spectrum';
import styles from './MasteringPanel.module.css';

/** A press shorter than this is a click: the comparison stays on until the next click. */
export const COMPARE_HOLD_MS = 300;
const READOUT_INTERVAL_MS = 200;
/** After a match, readings older than this (ms) still reflect the old setting. */
const FRESH_READING_MS = 600;
/** Within this many dB of the target counts as on target. */
const ON_TARGET_DB = 1;
const MINUS = '−';

/** Report a mastering edit: the take lock gets its own explanation. */
function acceptMastering(r: CommandResult): boolean {
  if (r.refused) {
    notify(MASTERING_LOCKED_MESSAGE, 'warn');
    return false;
  }
  return session.accepted(r);
}

function SectionTitle(props: { id: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className={styles.sectionHead}>
      <h3 id={props.id} className={styles.sectionTitle}>
        {props.children}
      </h3>
      {props.aside}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* A/B                                                                 */
/* ------------------------------------------------------------------ */

function CompareButton(props: { enabled: boolean }) {
  const { enabled } = props;
  const cmp = useCompare();
  const active = cmp.mode !== 'off';
  const disabled = !active && !enabled;
  const press = useRef<{ pointerId: number; at: number; wasLatched: boolean } | null>(null);

  // Leaving the Mix view (or the panel) always brings the mastering back.
  useEffect(() => () => releaseCompare(), []);
  // A press that loses the window (alt-tab while holding) ends a held comparison.
  useEffect(() => {
    const onBlur = () => {
      if (press.current) {
        press.current = null;
        releaseCompare();
      }
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || disabled) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    const wasLatched = cmp.mode === 'latched';
    press.current = { pointerId: e.pointerId, at: performance.now(), wasLatched };
    if (!wasLatched) engageCompare('held');
  };
  const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.pointerId !== e.pointerId) return;
    press.current = null;
    if (p.wasLatched) releaseCompare();
    else if (performance.now() - p.at < COMPARE_HOLD_MS) engageCompare('latched');
    else releaseCompare();
  };
  const onPointerCancel = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.pointerId !== e.pointerId) return;
    press.current = null;
    if (!p.wasLatched) releaseCompare();
  };
  // Keyboard and assistive technology (clicks without a pointer press) toggle it.
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (e.detail !== 0) return;
    if (active) releaseCompare();
    else if (!disabled) engageCompare('latched');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Escape' && active) {
      e.preventDefault();
      releaseCompare();
    } else if ((e.key === 'Enter' || e.key === ' ') && e.repeat) {
      // Holding the key down does not flip it back and forth.
      e.preventDefault();
    }
  };

  const label = active ? 'Hearing: no mastering' : 'Compare A/B';
  return (
    <Tooltip
      name="Compare with and without mastering"
      tip={
        !enabled && !active
          ? 'Mastering is off, so there is nothing to compare.'
          : 'Hold to hear your mix without mastering; let go to hear it with. A quick click keeps it off until you click again.'
      }
      detail="Only for listening: the project and every export keep their mastering. Leaving the Mix view turns it back on."
    >
      <button
        type="button"
        className={styles.compare}
        data-active={active || undefined}
        aria-pressed={active}
        aria-label="Hear without mastering (A/B)"
        aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <Icon name="stereo" size={14} />
        <span>{label}</span>
      </button>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

function Presets(props: { locked: boolean }) {
  const titleId = useId();
  const presetId = useProject((p) => p.mastering.presetId);
  const current = MASTERING_PRESETS.find((x) => x.id === presetId);
  const choose = (id: string) => {
    const preset = MASTERING_PRESETS.find((x) => x.id === id);
    const r = applyMasteringPreset(session.store, id);
    if (acceptMastering(r) && preset) notify(`Mastering: ${preset.name}. ${preset.description}`, 'info', 'undo');
  };
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <SectionTitle id={titleId}>Presets</SectionTitle>
      <div className={styles.chips} role="group" aria-labelledby={titleId}>
        {MASTERING_PRESETS.map((p) => (
          <Tooltip key={p.id} tip={p.description}>
            <button type="button" className={styles.chip} aria-pressed={p.id === presetId} disabled={props.locked} onClick={() => choose(p.id)}>
              {p.name}
            </button>
          </Tooltip>
        ))}
      </div>
      <p className={styles.note} data-testid="preset-note">
        {current ? (
          <>
            <strong>{current.name}:</strong> {current.description}
          </>
        ) : (
          'Custom settings: your own changes. Pick a preset to start again from one.'
        )}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Loudness                                                            */
/* ------------------------------------------------------------------ */

type ReadoutKey = 'momentary' | 'shortTerm' | 'integrated' | 'truePeak';

const READOUTS: readonly { key: ReadoutKey; name: string; unit: string; tip: string }[] = [
  { key: 'momentary', name: 'Momentary', unit: 'LUFS', tip: 'Loudness of the last 0.4 seconds: jumps with every hit.' },
  { key: 'shortTerm', name: 'Short-term', unit: 'LUFS', tip: 'Loudness of the last 3 seconds: how loud this part of the song feels.' },
  { key: 'integrated', name: 'Integrated', unit: 'LUFS', tip: 'Average loudness since you started playing (or pressed Reset): the number streaming services use.' },
  { key: 'truePeak', name: 'True peak', unit: 'dBTP', tip: 'The highest peak so far, between samples too. The limiter keeps it near −1 dB.' },
];

const minusLufs = (lufs: number) => `${lufs < 0 ? MINUS : ''}${Math.abs(lufs)} LUFS`;

function describeMatch(r: LoudnessMatch, target: LoudnessTarget, which: string, measured: number): string {
  const parts = [`Loudness ${formatDb(r.before)} → ${formatDb(r.after)}: the ${which} reading was ${formatLoudness(measured)}, the ${target.name} target is ${minusLufs(target.lufs)}.`];
  if (r.limit === 'max') parts.push('That is as far as Loudness goes. To get louder still, raise the parts or the master volume.');
  if (r.limit === 'min') parts.push('Loudness is now at 0 dB. To get quieter still, lower the master volume.');
  parts.push('Measuring again from now: play on, then match again to fine-tune.');
  return parts.join(' ');
}

function LoudnessSection(props: { enabled: boolean; locked: boolean; comparing: boolean }) {
  const { enabled, locked, comparing } = props;
  const titleId = useId();
  const target = useLoudnessTarget();
  const loudnessDb = useProject((p) => readParam(MASTERING_PARAMS, p.mastering.params, 'loudness'));
  const values = useRef<Record<ReadoutKey, HTMLElement | null>>({ momentary: null, shortTerm: null, integrated: null, truePeak: null });
  const statusRef = useRef<HTMLParagraphElement>(null);
  const latest = useRef({ integrated: -Infinity, shortTerm: -Infinity });
  const hasRef = useRef(false);
  const lastAt = useRef(-Infinity);
  /**
   * After a match: the next one waits for an integrated reading taken at the
   * new setting (the old reading, a report already on its way from the meter,
   * and the 3 s short-term window all still hold the old level).
   */
  const freshAfter = useRef<number | null>(null);
  const [measured, setMeasured] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // A new target refreshes the distance-to-target line at once.
  useLayoutEffect(() => {
    lastAt.current = -Infinity;
  }, [target]);

  useRafLoop((_, now) => {
    if (now - lastAt.current < READOUT_INTERVAL_MS) return;
    lastAt.current = now;
    const l = readMixFrame().loudness;
    const live = mixFrameLive();
    const text: Record<ReadoutKey, string> = {
      momentary: formatLoudness(l?.momentary, ''),
      shortTerm: formatLoudness(l?.shortTerm, ''),
      integrated: formatLoudness(l?.integrated, ''),
      truePeak: formatLoudness(l?.truePeakDb, '', true),
    };
    for (const k of Object.keys(text) as ReadoutKey[]) {
      const el = values.current[k];
      if (el && el.textContent !== text[k]) el.textContent = text[k];
    }
    const peakEl = values.current.truePeak;
    if (peakEl) peakEl.dataset.over = l && Number.isFinite(l.truePeakDb) && l.truePeakDb > -1 ? '1' : '0';
    const integrated = l?.integrated ?? -Infinity;
    const shortTerm = l?.shortTerm ?? -Infinity;
    if (freshAfter.current !== null && ((now >= freshAfter.current && Number.isFinite(integrated)) || !live)) freshAfter.current = null;
    const waiting = freshAfter.current !== null;
    latest.current = waiting ? { integrated: -Infinity, shortTerm: -Infinity } : { integrated, shortTerm };
    const basis = waiting
      ? null
      : Number.isFinite(integrated)
        ? { which: 'Integrated', v: integrated }
        : Number.isFinite(shortTerm)
          ? { which: 'Short-term', v: shortTerm }
          : null;
    let status: string;
    if (!basis) {
      const playing = runtimeStore.getState().playing;
      status = !live || !playing ? 'Start playback to measure.' : !l ? 'Loudness metering is not available.' : 'Measuring: play a few seconds.';
    } else {
      const t = target;
      const diff = basis.v - t.lufs;
      status =
        Math.abs(diff) < ON_TARGET_DB
          ? `${basis.which}: on the ${t.name} target, ${minusLufs(t.lufs)} (within ${ON_TARGET_DB} dB).`
          : `${basis.which}: ${Math.abs(diff).toFixed(1)} dB ${diff < 0 ? 'quieter' : 'louder'} than the ${t.name} target, ${minusLufs(t.lufs)}.`;
    }
    if (statusRef.current && statusRef.current.textContent !== status) statusRef.current.textContent = status;
    const has = basis !== null;
    if (has !== hasRef.current) {
      hasRef.current = has;
      setMeasured(has);
    }
  }, true);

  const reason = locked ? MASTERING_LOCKED_MESSAGE : !enabled ? 'Turn mastering on to match a target.' : comparing ? 'Finish comparing (A/B) first.' : null;
  const blocked = reason ?? (!measured ? 'Play your song for a few seconds to measure it first.' : null);

  const match = () => {
    if (blocked) return;
    const t = target;
    const m = latest.current;
    const useIntegrated = Number.isFinite(m.integrated);
    const value = useIntegrated ? m.integrated : m.shortTerm;
    const r = matchLoudnessTarget(session.store, t.lufs, value);
    if (r.refused) {
      notify(MASTERING_LOCKED_MESSAGE, 'warn');
      return;
    }
    if (!r.changed) {
      setResult(
        r.message ??
          (r.limit === 'min'
            ? `Louder than the ${t.name} target already, with Loudness at 0 dB. Lower the master volume to get quieter.`
            : r.limit === 'max'
              ? `Quieter than the ${t.name} target, with Loudness already at its most (${formatDb(r.after)}). Raise the parts or the master volume to get louder.`
              : `Already on the ${t.name} target.`),
      );
      return;
    }
    session.resetLoudness();
    // The next match needs a reading taken at the new setting.
    freshAfter.current = performance.now() + FRESH_READING_MS;
    latest.current = { integrated: -Infinity, shortTerm: -Infinity };
    hasRef.current = false;
    setMeasured(false);
    lastAt.current = -Infinity;
    const text = describeMatch(r, t, useIntegrated ? 'integrated' : 'short-term', value);
    setResult(text);
    notify(`Loudness set to ${formatDb(r.after)} to aim for ${minusLufs(t.lufs)}.`, 'info', 'undo');
  };

  const reset = () => {
    session.resetLoudness();
    setResult(null);
    lastAt.current = -Infinity;
  };

  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <SectionTitle id={titleId}>Loudness</SectionTitle>
      <SegmentedControl<LoudnessTargetId>
        label="Loudness target"
        options={LOUDNESS_TARGETS.map((t) => ({ value: t.id, label: `${t.name} ${MINUS}${Math.abs(t.lufs)}`, tip: `${minusLufs(t.lufs)}. ${t.description}` }))}
        value={target.id}
        onChange={(id) => {
          setLoudnessTarget(id);
          setResult(null);
        }}
        block
        className={styles.targets}
      />
      <div className={styles.readoutRow}>
        <div className={styles.readouts} role="group" aria-label="Loudness readings">
          {READOUTS.map((r) => (
            <Tooltip key={r.key} tip={r.tip}>
              <div className={styles.readout} data-key={r.key}>
                <span className={styles.readoutName}>{r.name}</span>
                <span className={styles.readoutValue}>
                  <span
                    className="mono"
                    data-testid={`loudness-${r.key}`}
                    ref={(el) => {
                      values.current[r.key] = el;
                    }}
                  >
                    {'\u2014'}
                  </span>{' '}
                  <span className={styles.unit}>{r.unit}</span>
                </span>
              </div>
            </Tooltip>
          ))}
        </div>
        <IconButton
          icon="undo"
          size="sm"
          variant="ghost"
          label="Reset the loudness measurement"
          onClick={reset}
          tip="Start measuring again from now (integrated loudness and true peak)."
          className={styles.reset}
        />
      </div>
      <p ref={statusRef} className={styles.status} data-testid="loudness-status">
        Start playback to measure.
      </p>
      <div className={styles.matchRow}>
        <Button
          variant="primary"
          size="lg"
          icon="sparkle"
          onClick={match}
          aria-disabled={blocked ? true : undefined}
          data-blocked={blocked ? '' : undefined}
          className={styles.match}
          tip={blocked ?? `Set the Loudness control so the song lands on ${minusLufs(target.lufs)}.`}
          detail="Uses the integrated reading when there is one, otherwise the short-term one. One undo step."
        >
          Match target
        </Button>
        <span className={`${styles.loudnessNow} mono`} aria-label={`Loudness control: ${formatDb(loudnessDb)}`}>
          Loudness {formatDb(loudnessDb)}
        </span>
      </div>
      {reason && !locked && <p className={styles.blocked}>{reason}</p>}
      <p className={styles.result} role="status" aria-live="polite" data-testid="match-result">
        {result ?? ''}
      </p>
      <p className={styles.fine}>
        Match target moves Loudness by the measured difference. It is approximate: the limiter holds peaks below {MINUS}1 dBFS, so a big push adds less than the
        numbers say.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Advanced controls                                                   */
/* ------------------------------------------------------------------ */

interface Group {
  id: string;
  title: string;
  ids: readonly string[];
  text: string;
}

export const MASTERING_GROUPS: readonly Group[] = [
  { id: 'cleanup', title: 'Clean-up', ids: ['lowCut'], text: 'Removes deep rumble you hardly hear but that uses up loudness.' },
  { id: 'eq', title: 'EQ', ids: ['lowGain', 'lowFreq', 'midGain', 'midFreq', 'highGain', 'highFreq', 'air'], text: 'The lows, mids and highs of the whole mix.' },
  { id: 'glue', title: 'Glue', ids: ['glue', 'punch'], text: 'Gentle compression that makes the parts sound like one song.' },
  { id: 'colour', title: 'Colour', ids: ['saturation'], text: 'Analogue-style warmth and density.' },
  { id: 'stereo', title: 'Stereo', ids: ['width', 'monoBass'], text: 'How wide the mix is, and solid centred lows.' },
  { id: 'loudness', title: 'Loudness', ids: ['loudness'], text: 'Drive into the limiter: louder, with less dynamic range.' },
];

function groupsWithSpecs(): { group: Group; specs: ParamSpec[] }[] {
  const used = new Set<string>();
  const out = MASTERING_GROUPS.map((group) => {
    const specs = group.ids.map((id) => specById(MASTERING_PARAMS, id)).filter((s): s is ParamSpec => !!s);
    for (const s of specs) used.add(s.id);
    return { group, specs };
  }).filter((g) => g.specs.length > 0);
  const rest = MASTERING_PARAMS.filter((s) => !used.has(s.id));
  if (rest.length) out.push({ group: { id: 'more', title: 'More', ids: rest.map((s) => s.id), text: 'Further mastering controls.' }, specs: [...rest] });
  return out;
}

const MasteringKnob = memo(function MasteringKnob(props: { spec: ParamSpec; disabled: boolean }) {
  const { spec, disabled } = props;
  const value = useProject((p) => readParam(MASTERING_PARAMS, p.mastering.params, spec.id));
  return (
    <Knob
      spec={spec}
      value={value}
      size="sm"
      disabled={disabled}
      onChange={(v, info) => acceptMastering(setMasteringParam(session.store, spec.id, v, info.gesture))}
    />
  );
});

/** How much the Glue compressor turns the mix down right now (written to the DOM). */
function GlueMeter() {
  const barRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const at = useRef(0);
  useRafLoop((_, now) => {
    if (now - at.current < 60) return;
    at.current = now;
    const gr = readMixFrame().glueReductionDb;
    const known = gr !== undefined && Number.isFinite(gr);
    const v = known ? Math.max(0, gr) : 0;
    if (barRef.current) barRef.current.style.transform = `scaleX(${Math.min(1, v / 12)})`;
    const text = !known ? '—' : v < 0.1 ? 'Resting' : `${MINUS}${v.toFixed(1)} dB`;
    if (textRef.current && textRef.current.textContent !== text) textRef.current.textContent = text;
    if (rootRef.current) {
      const now10 = String(Math.round(v * 10) / 10);
      if (rootRef.current.getAttribute('aria-valuenow') !== now10) {
        rootRef.current.setAttribute('aria-valuenow', now10);
        rootRef.current.setAttribute('aria-valuetext', known ? (v < 0.1 ? 'Not compressing' : `Turning down ${v.toFixed(1)} dB`) : 'Not measured');
      }
    }
  }, true);
  return (
    <Tooltip tip="How much Glue is turning the mix down right now. A few dB on the loudest moments sounds natural." detail="Glue compressor gain reduction, from 0 to 12 dB.">
      <div ref={rootRef} className={styles.glue} role="meter" aria-label="Glue gain reduction" aria-valuemin={0} aria-valuemax={12} aria-valuenow={0} aria-valuetext="Not measured">
        <span className={styles.glueTrack}>
          <span ref={barRef} className={styles.glueBar} />
        </span>
        <span ref={textRef} className={`${styles.glueText} mono`}>
          {'—'}
        </span>
      </div>
    </Tooltip>
  );
}

function MasteringControls(props: { enabled: boolean; locked: boolean }) {
  const groups = groupsWithSpecs();
  return (
    <div className={styles.groups}>
      {!props.enabled && <p className={styles.note}>Mastering is off: changes are kept, and heard once you switch it on.</p>}
      {groups.map(({ group, specs }) => (
        <GroupBox key={group.id} group={group}>
          <div className={styles.knobs}>
            {specs.map((s) => (
              <MasteringKnob key={s.id} spec={s} disabled={props.locked} />
            ))}
          </div>
          {group.id === 'glue' && <GlueMeter />}
        </GroupBox>
      ))}
    </div>
  );
}

function GroupBox(props: { group: Group; children: ReactNode }) {
  const id = useId();
  return (
    <section className={styles.group} aria-labelledby={id} data-group={props.group.id}>
      <h4 id={id} className={styles.groupTitle}>
        {props.group.title}
      </h4>
      <p className={styles.groupText}>{props.group.text}</p>
      {props.children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function MasteringPanel(props: { advanced: boolean; className?: string }) {
  const { advanced } = props;
  const enabled = useProject((p) => p.mastering.enabled);
  const takeLocked = useRuntime((s) => s.recording === 'performance');
  const cmp = useCompare();
  const comparing = cmp.mode !== 'off' || cmp.waiting;
  const spectrumId = useId();

  const onSwitch = (on: boolean) => {
    if (comparing) releaseCompare();
    acceptMastering(setMasteringEnabled(session.store, on));
  };

  return (
    <Panel
      title="Mastering"
      className={props.className}
      bodyClassName={styles.body}
      actions={
        <>
          <CompareButton enabled={enabled} />
          <Switch
            label="Mastering"
            hideLabel
            checked={enabled || comparing}
            onChange={onSwitch}
            disabled={takeLocked}
            tip={enabled ? 'Switch the whole mastering chain off: you hear the mix exactly as it is.' : 'Switch mastering on.'}
            detail="The output limiter (peaks below −1 dBFS) always stays on."
          />
        </>
      }
    >
      {takeLocked && (
        <p className={styles.lock} role="note">
          <Icon name="lock" size={13} /> {MASTERING_LOCKED_MESSAGE}
        </p>
      )}
      <Presets locked={takeLocked} />
      <LoudnessSection enabled={enabled} locked={takeLocked} comparing={comparing} />
      <section className={`${styles.section} ${styles.spectrumSection}`} aria-labelledby={spectrumId}>
        <SectionTitle id={spectrumId}>Spectrum</SectionTitle>
        <Spectrum />
      </section>
      {advanced && <MasteringControls enabled={enabled} locked={takeLocked} />}
    </Panel>
  );
}
