/**
 * Mastering: the finishing chain on the whole mix (Project.mastering).
 *
 *   MASTERING ───────────────────────── [Compare A/B] [On/Off]
 *   Presets   [Clean] [Warm] [Punchy] …        Level-matched (−6.4 dB)
 *             what the chosen one does
 *   Loudness  Loudness target (Streaming −14 · Gentle −18 · Loud −9)
 *             Momentary · Short-term · Integrated · True peak   [↺ Reset]
 *             how far from the target (or "Measuring the new setting…")
 *             [Match target]  Loudness drive 0.0 → +6.0 dB
 *             what true peak means (amber at the −1 dBTP ceiling, red above 0)
 *   Spectrum  lows · mids · highs of the output
 *   Advanced: every control as knobs, grouped Clean-up / EQ / Glue (with the
 *             Glue gain-reduction indicator) / Colour / Stereo / Loudness drive.
 *
 * Beside the mixer the sections stack in one scrolling column; below the
 * mixer (full width) Presets and Loudness sit left of the Spectrum.
 *
 * Live readouts (loudness, Glue, the A/B trim) are written to the DOM from
 * the meters' shared loop a few times a second, and sleep with it; React only
 * renders when a setting or the mode changes. The readings follow what is
 * heard now (loudnessMatch.ts): a change to the mastering or the master
 * volume restarts them. Edits are undoable commands (one step per knob
 * gesture); a performance take refuses them and the panel says why.
 */
import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { Button, Icon, Knob, Panel, SegmentedControl, Switch, Tooltip, meterWake } from '../../../ui/components';
import { MASTERING_PRESETS } from '../../../content/mastering';
import { MASTERING_PARAMS, readParam, specById, type ParamSpec } from '../../../project/params';
import { MASTERING_LOCKED_MESSAGE, applyMasteringPreset, setMasteringEnabled, setMasteringParam, type CommandResult } from '../../../state/commands';
import { session, useProject } from '../../instance';
import { notify, runtimeStore, useRuntime } from '../../runtime';
import { engageCompare, releaseCompare, useCompare } from './compare';
import {
  MATCH_PASSES,
  clearMatchResult,
  distanceText,
  loudnessTick,
  matchState,
  minusLufs,
  onMatchFocusRequest,
  readingBasis,
  startMatch,
  takeMatchFocusRequest,
  useMatchState,
  watchLoudness,
  type LoudnessReading,
} from './loudnessMatch';
import { formatDb, formatLoudness, mixFrameLive, readMixFrame } from './mixMeters';
import { LOUDNESS_TARGETS, setLoudnessTarget, useLoudnessTarget, type LoudnessTargetId } from './mixPrefs';
import { Spectrum } from './Spectrum';
import { useMixTask } from './useMixTask';
import styles from './MasteringPanel.module.css';

/** A press shorter than this is a click: the comparison stays on until the next click. */
export const COMPARE_HOLD_MS = 300;
const READOUT_INTERVAL_MS = 200;
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

const COMPARE_OFF = 'Compare A/B';
const COMPARE_ON = 'Hearing: no mastering';

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

  return (
    <Tooltip
      name="Compare with and without mastering"
      tip={
        !enabled && !active
          ? 'Mastering is off, so there is nothing to compare.'
          : 'Hold to hear your mix without mastering; let go to hear it with. A quick click keeps it off until you click again. Both are played at the same loudness, so you compare the sound, not the volume.'
      }
      detail="Only for listening: the project and every export keep their mastering. The un-mastered sound is turned up or down by the loudness difference of the last 3 seconds. Leaving the Mix view turns mastering back on."
    >
      <button
        type="button"
        className={styles.compare}
        data-active={active || undefined}
        aria-pressed={active}
        // The name starts with the words on the button (WCAG 2.5.3), then says what it does.
        aria-label={active ? `${COMPARE_ON} (Compare A/B)` : `${COMPARE_OFF} (hear without mastering)`}
        aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <Icon name="stereo" size={14} />
        {/* Both words take the same place, so the key keeps the width of the longer one and never moves. */}
        <span className={styles.compareWords}>
          <span data-shown={!active || undefined}>{COMPARE_OFF}</span>
          <span data-shown={active || undefined}>{COMPARE_ON}</span>
        </span>
      </button>
    </Tooltip>
  );
}

/** While comparing: how much the un-mastered sound is turned to match (MeterFrame.compareTrimDb). */
function LevelMatchNote() {
  const cmp = useCompare();
  const active = cmp.mode !== 'off';
  const ref = useRef<HTMLSpanElement>(null);
  /** Whether the comparison had a loudness reading to match from when it started. */
  const measured = useRef(false);
  useLayoutEffect(() => {
    if (!active) return;
    const l = readMixFrame().loudness;
    measured.current = !!l && Number.isFinite(l.shortTerm) && Number.isFinite(l.preMasteringShortTerm ?? NaN);
    meterWake();
  }, [active]);
  useMixTask(
    {
      frame() {
        const el = ref.current;
        if (!el) return false;
        const trim = readMixFrame().compareTrimDb ?? 0;
        const text = measured.current || Math.abs(trim) >= 0.05 ? `Level-matched (${formatDb(trim)})` : 'Not level-matched: play a few seconds first';
        if (el.textContent !== text) el.textContent = text;
        return false;
      },
    },
    active,
  );
  return (
    <span className={styles.levelMatch} role="status" data-testid="level-match">
      {active ? <span ref={ref} /> : null}
    </span>
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
    <section className={styles.section} aria-labelledby={titleId} data-section="presets">
      <SectionTitle id={titleId} aside={<LevelMatchNote />}>
        Presets
      </SectionTitle>
      <div className={styles.chips} role="group" aria-labelledby={titleId}>
        {MASTERING_PRESETS.map((p) => (
          <Tooltip key={p.id} tip={p.description}>
            <button type="button" className={styles.chip} aria-pressed={p.id === presetId} disabled={props.locked} onClick={() => choose(p.id)}>
              {p.name}
            </button>
          </Tooltip>
        ))}
      </div>
      <p className={`${styles.note} ${styles.presetNote}`} data-testid="preset-note" title={current ? `${current.name}: ${current.description}` : undefined}>
        {current ? (
          <>
            <strong>{current.name}:</strong> {current.description}
          </>
        ) : (
          'Custom settings: pick a preset to start again from one.'
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
  {
    key: 'integrated',
    name: 'Integrated',
    unit: 'LUFS',
    tip: 'Average loudness since you started playing, pressed Reset or changed the mastering or the master volume: the number streaming services use.',
  },
  {
    key: 'truePeak',
    name: 'True peak',
    unit: 'dBTP',
    tip: 'The highest peak so far, counting the peaks between samples too. The limiter keeps it at −1 dBTP. Amber: at that ceiling, which is normal for a loud master. Red: above 0 dBTP, which may distort on some players.',
  },
];

/** True peak this close under the limiter's −1 dBTP ceiling (or above it) reads amber: the limiter is catching peaks. */
export const TRUE_PEAK_NEAR_DB = -1.5;

/** How a true-peak reading is shown: plain, amber at the −1 dBTP ceiling (normal), red above 0 dBTP. */
export type PeakLevel = 'ok' | 'near' | 'over';
export function truePeakLevel(db: number | undefined): PeakLevel {
  if (db === undefined || !Number.isFinite(db)) return 'ok';
  return db > 0 ? 'over' : db > TRUE_PEAK_NEAR_DB ? 'near' : 'ok';
}

function LoudnessSection(props: { enabled: boolean; locked: boolean; comparing: boolean }) {
  const { enabled, locked, comparing } = props;
  const titleId = useId();
  const target = useLoudnessTarget();
  const loudnessDb = useProject((p) => readParam(MASTERING_PARAMS, p.mastering.params, 'loudness'));
  const playing = useRuntime((s) => s.playing && !s.paused);
  const measuring = useMatchState((s) => s.measuring);
  const matching = useMatchState((s) => s.matching);
  const result = useMatchState((s) => s.result);
  const lastMatch = useMatchState((s) => s.lastMatch);
  const values = useRef<Record<ReadoutKey, HTMLElement | null>>({ momentary: null, shortTerm: null, integrated: null, truePeak: null });
  const peakNameRef = useRef<HTMLSpanElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const matchRef = useRef<HTMLButtonElement>(null);
  const latest = useRef<LoudnessReading>({ integrated: -Infinity, shortTerm: -Infinity });
  const lastAt = useRef(-Infinity);
  /** There is a reading to match from (React state: it changes rarely, the readings themselves do not render). */
  const [hasBasis, setHasBasis] = useState(false);
  const targetRef = useRef(target);
  useLayoutEffect(() => {
    targetRef.current = target;
  });

  // Sent here by "Match target in Mix" (the export report): bring Match into view and focus it,
  // once the dialog that asked has closed and given focus back.
  useEffect(() => {
    let raf = 0;
    const go = () => {
      if (!takeMatchFocusRequest()) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => {
          const el = matchRef.current;
          if (!el) return;
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          el.focus({ preventScroll: true });
        });
      });
    };
    go();
    const off = onMatchFocusRequest(go);
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, []);

  // A new target, a new state of the readings, or of Match: the status line is written again at once.
  useLayoutEffect(() => {
    lastAt.current = -Infinity;
    meterWake();
  }, [target, measuring, matching, enabled, comparing, locked]);

  const reason = locked ? MASTERING_LOCKED_MESSAGE : !enabled ? 'Turn mastering on to match a target.' : comparing ? 'Finish comparing (A/B) first.' : null;
  const hasBasisRef = useRef(false);
  // Match waits for a fresh reading while the readings are being taken again; otherwise it needs one.
  const blocked = matching ? null : blockedReason(reason, hasBasis, measuring, playing);

  useMixTask({
    frame(now) {
      if (now - lastAt.current < READOUT_INTERVAL_MS) return runtimeStore.getState().playing;
      const dt = Number.isFinite(lastAt.current) ? now - lastAt.current : 0;
      lastAt.current = now;
      const l = readMixFrame().loudness;
      const live = mixFrameLive();
      let wrote = false;
      const write = (el: HTMLElement | null, text: string) => {
        if (el && el.textContent !== text) {
          el.textContent = text;
          wrote = true;
        }
      };
      write(values.current.momentary, formatLoudness(l?.momentary, ''));
      write(values.current.shortTerm, formatLoudness(l?.shortTerm, ''));
      write(values.current.integrated, formatLoudness(l?.integrated, ''));
      write(values.current.truePeak, formatLoudness(l?.truePeakDb, '', true));
      // Amber at the limiter's −1 dBTP ceiling (normal), red above 0 dBTP, which also says so in words.
      const level = truePeakLevel(l?.truePeakDb);
      const peakEl = values.current.truePeak;
      if (peakEl && peakEl.dataset.level !== level) peakEl.dataset.level = level;
      const peakName = level === 'over' ? 'Peak too high' : 'True peak';
      if (peakNameRef.current && peakNameRef.current.textContent !== peakName) {
        peakNameRef.current.textContent = peakName;
        peakNameRef.current.dataset.level = level;
      }
      const reading = { integrated: l?.integrated ?? -Infinity, shortTerm: l?.shortTerm ?? -Infinity };
      latest.current = reading;
      loudnessTick(now, reading, dt);
      const run = runtimeStore.getState();
      const isPlaying = run.playing && !run.paused;
      const t = targetRef.current;
      const fresh = !matchState().measuring;
      const basis = readingBasis(reading);
      let status: string;
      if (!fresh) {
        status = !isPlaying
          ? 'Start playback to measure the new setting.'
          : `Measuring the new setting… ${basis ? distanceText({ ...basis, which: 'Short-term' }, t.lufs, t.name) : ''}`.trim();
      } else if (!basis) {
        status = !live || !isPlaying ? 'Start playback to measure.' : !l ? 'Loudness metering is not available.' : 'Measuring: play a few seconds.';
      } else status = distanceText(basis, t.lufs, t.name);
      write(statusRef.current, status);
      if ((basis !== null) !== hasBasisRef.current) {
        hasBasisRef.current = basis !== null;
        setHasBasis(basis !== null);
      }
      return isPlaying || wrote;
    },
  });

  const match = () => {
    if (blocked || matching) return;
    startMatch(latest.current);
  };

  // "0.0 → +6.0 dB" while Loudness drive is still where the last match put it.
  const showMatch = lastMatch !== null && Math.abs(lastMatch.after - loudnessDb) < 0.05;
  const driveText = showMatch ? `${formatDb(lastMatch.before).replace(/ dB$/, '')} → ${formatDb(lastMatch.after)}` : formatDb(loudnessDb);
  const matchWords = matching ? `Matching… ${Math.max(1, matching.applied)}/${MATCH_PASSES}` : 'Match target';

  return (
    <section className={styles.section} aria-labelledby={titleId} data-section="loudness">
      {/* The section is named for its selector (design-16): the target, how far the song is from it, and Match. */}
      <SectionTitle id={titleId}>Loudness target</SectionTitle>
      <div className={styles.field}>
        <SegmentedControl<LoudnessTargetId>
          label="Loudness target"
          options={LOUDNESS_TARGETS.map((t) => ({ value: t.id, label: `${t.name} ${MINUS}${Math.abs(t.lufs)}`, tip: `${minusLufs(t.lufs)}. ${t.description}` }))}
          value={target.id}
          onChange={(id) => {
            setLoudnessTarget(id);
            clearMatchResult();
          }}
          block
          className={styles.targets}
        />
      </div>
      <div className={styles.readoutRow}>
        <div className={styles.readouts} role="group" aria-label="Loudness readings" data-hint-avoid="">
          {READOUTS.map((r) => (
            <Tooltip key={r.key} tip={r.tip}>
              <div className={styles.readout} data-key={r.key}>
                <span className={styles.readoutName} ref={r.key === 'truePeak' ? peakNameRef : undefined}>
                  {r.name}
                </span>
                <span className={styles.readoutValue}>
                  <span
                    className="mono"
                    data-testid={`loudness-${r.key}`}
                    ref={(el) => {
                      values.current[r.key] = el;
                    }}
                  >
                    {'—'}
                  </span>
                  <span className={styles.unit}>{r.unit}</span>
                </span>
              </div>
            </Tooltip>
          ))}
        </div>
        <Tooltip tip="Start measuring again from now (integrated loudness and true peak).">
          <button
            type="button"
            className={styles.reset}
            aria-label="Reset loudness readings"
            onClick={() => {
              session.resetLoudness();
              clearMatchResult();
              lastAt.current = -Infinity;
              meterWake();
            }}
          >
            <Icon name="undo" size={14} />
            <span>Reset</span>
          </button>
        </Tooltip>
      </div>
      <p ref={statusRef} className={styles.status} data-testid="loudness-status" data-hint-avoid="">
        Start playback to measure.
      </p>
      <div className={styles.matchRow}>
        <Button
          ref={matchRef}
          variant="primary"
          size="lg"
          icon="sparkle"
          onClick={match}
          aria-disabled={blocked || matching ? true : undefined}
          aria-label={matching ? `${matchWords}: matching the ${target.name} target` : undefined}
          data-blocked={blocked || matching ? '' : undefined}
          data-matching={matching ? '' : undefined}
          className={styles.match}
          tip={
            matching
              ? `Matching the ${target.name} target: after each fresh 3-second reading it corrects again, up to ${MATCH_PASSES} times, while the music plays. Stopping playback, Mute All, the A/B or any change to the song stops it.`
              : (blocked ?? `Set Loudness drive so the song lands on ${minusLufs(target.lufs)}.`)
          }
          detail={`Moves Loudness drive by the measured difference: the integrated reading when it is of the current settings, else the short-term one. The limiter holds peaks below ${MINUS}1 dBTP, so a push adds less than the numbers say; while the music plays, Match checks again after each fresh 3-second reading and corrects again, until it is within 0.5 dB or after ${MATCH_PASSES} passes. One press is one undo step.`}
        >
          {/* Both words take the same place, so the key keeps its width. */}
          <span className={styles.matchWords}>
            <span data-shown={!matching || undefined}>Match target</span>
            <span data-shown={matching ? true : undefined} aria-hidden={!matching || undefined}>
              {matching ? matchWords : `Matching… ${MATCH_PASSES}/${MATCH_PASSES}`}
            </span>
          </span>
        </Button>
        <span className={styles.loudnessNow} data-testid="loudness-control">
          <span className={styles.loudnessNowName}>Loudness drive</span> <span className={`${styles.loudnessNowValue} mono`}>{driveText}</span>
        </span>
      </div>
      {reason && !locked && <p className={styles.blocked}>{reason}</p>}
      <p className={styles.result} role="status" aria-live="polite" data-testid="match-result">
        {result ?? ''}
      </p>
      <p className={styles.fine} data-testid="true-peak-note">
        True peak amber: at the limiter’s {MINUS}1 dBTP ceiling (normal). Red: above 0 dBTP.
      </p>
    </section>
  );
}

/** Why Match cannot act now, or null. While the readings are being taken again it can (it waits for them). */
function blockedReason(reason: string | null, hasBasis: boolean, measuring: boolean, playing: boolean): string | null {
  if (reason) return reason;
  if (measuring) return playing ? null : 'Play your song to measure the new setting first.';
  return hasBasis ? null : 'Play your song for a few seconds to measure it first.';
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
  { id: 'loudness', title: 'Loudness drive', ids: ['loudness'], text: 'Drive into the limiter: louder, with less dynamic range. Match target sets it for you.' },
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
  const shown = useRef('');
  useMixTask({
    frame() {
      const gr = readMixFrame().glueReductionDb;
      const known = gr !== undefined && Number.isFinite(gr);
      const v = known ? Math.max(0, gr) : 0;
      const key = known ? String(Math.round(v * 10)) : '-';
      if (key === shown.current) return v >= 0.1;
      shown.current = key;
      if (barRef.current) barRef.current.style.transform = `scaleX(${Math.min(1, v / 12)})`;
      const text = !known ? '—' : v < 0.1 ? 'Resting' : `${MINUS}${v.toFixed(1)} dB`;
      if (textRef.current && textRef.current.textContent !== text) textRef.current.textContent = text;
      if (rootRef.current) {
        rootRef.current.setAttribute('aria-valuenow', String(Math.round(v * 10) / 10));
        rootRef.current.setAttribute('aria-valuetext', known ? (v < 0.1 ? 'Not compressing' : `Turning down ${v.toFixed(1)} dB`) : 'Not measured');
      }
      return true;
    },
  });
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

  // The readings follow what is heard now: changes to the mastering or the master volume restart them.
  useEffect(() => watchLoudness(), []);

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
            detail="The output limiter (peaks below −1 dBTP) always stays on."
          />
        </>
      }
    >
      {/* One column beside the mixer; below it (full width), Presets and Loudness left of the Spectrum. */}
      <div className={styles.layout}>
        {takeLocked && (
          <p className={styles.lock} role="note">
            <Icon name="lock" size={13} /> {MASTERING_LOCKED_MESSAGE}
          </p>
        )}
        <Presets locked={takeLocked} />
        <LoudnessSection enabled={enabled} locked={takeLocked} comparing={comparing} />
        <section className={`${styles.section} ${styles.spectrumSection}`} aria-labelledby={spectrumId} data-section="spectrum">
          <SectionTitle id={spectrumId}>Spectrum</SectionTitle>
          <Spectrum />
        </section>
        {advanced && <MasteringControls enabled={enabled} locked={takeLocked} />}
      </div>
    </Panel>
  );
}
