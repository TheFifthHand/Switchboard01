/**
 * Drum steps: pick a kit sound in the overview (all 16 sounds x 16 steps of
 * this bar), then edit its steps on the large numbered pads below. A lit pad
 * is a hit; its brightness and the velocity lane show how hard it plays.
 */
import { memo, useCallback, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { getKitVoiceNames } from '../../../audio/instruments/kits';
import { DRUM_VOICES, STEPS_PER_BAR, type Clip, type Id } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { drumVoiceFor, selectDrumVoice } from '../../../state/uiStore';
import { session, useUi } from '../../instance';
import { STEP_INDICES, clampVelocity, drumPageGrid, noteIdsAt, percent, stepColumn, velocityBucket } from './model';
import { auditionBlip, useKeyBurst } from './shared';
import { StepNumbers, VelocityLane } from './StepLanes';
import grid from './StepGrid.module.css';
import styles from './DrumSteps.module.css';

const VOICES = Array.from({ length: DRUM_VOICES }, (_, i) => i);

export interface DrumStepsProps {
  trackId: Id;
  slot: number;
  page: number;
  clip: Clip;
  kitId: string;
}

/* ------------------------------------------------------------------ */
/* Voice overview                                                      */
/* ------------------------------------------------------------------ */

/** One kit sound: its name and this bar's hits. Clicking (or Space/Enter) selects it and plays it once. */
const VoiceRow = memo(function VoiceRow(props: { voice: number; name: string; pattern: string; selected: boolean; page: number; onPick(voice: number): void }) {
  const { voice, name, pattern, selected, page, onPick } = props;
  const hits = pattern.replace(/0/g, '').length;
  const onClick = () => onPick(voice);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      className={`${grid.cols} ${styles.voiceRow}`}
      data-selected={selected || undefined}
      data-voice={voice}
      onClick={onClick}
      aria-label={`${name}: ${hits === 0 ? 'no hits' : `${hits} hit${hits === 1 ? '' : 's'}`} in bar ${page + 1}${selected ? ', editing' : ''}`}
    >
      <span className={styles.voiceName}>
        <span className={`${styles.voiceNum} mono`}>{voice + 1}</span>
        <span className={styles.voiceText}>{name}</span>
      </span>
      {STEP_INDICES.map((s) => (
        <span key={s} className={styles.cell} style={{ gridColumn: stepColumn(s) }} data-v={pattern[s]} aria-hidden="true" />
      ))}
    </button>
  );
});

/* ------------------------------------------------------------------ */
/* Step pads                                                           */
/* ------------------------------------------------------------------ */

const StepPad = memo(function StepPad(props: { step: number; velocity: number; voiceName: string; tabbable: boolean; onToggle(step: number): void; onFocusStep(step: number): void }) {
  const { step, velocity, voiceName, tabbable, onToggle, onFocusStep } = props;
  const on = velocity >= 0;
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    onFocusStep(step);
    onToggle(step);
  };
  // Pointer presses toggle on pointerdown; clicks from Space/Enter (detail 0) toggle here.
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (e.detail === 0) onToggle(step);
  };
  return (
    <button
      type="button"
      className={styles.step}
      style={{ gridColumn: stepColumn(step), '--vel': String(on ? velocity : 0) } as CSSProperties}
      data-on={on || undefined}
      data-beat={step % 4 === 0 || undefined}
      data-step={step}
      data-ph-step={step}
      tabIndex={tabbable ? 0 : -1}
      data-steps-entry={tabbable ? '' : undefined}
      aria-pressed={on}
      aria-label={`Step ${step + 1}, ${voiceName}, ${on ? `on, velocity ${percent(velocity)}` : 'off'}`}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onFocus={() => onFocusStep(step)}
    >
      <span className={styles.light} aria-hidden="true" />
      <span className={`${styles.stepNum} mono`}>{step + 1}</span>
      <span className={`${styles.stepVel} mono`} aria-hidden="true">
        {on ? Math.round(velocity * 100) : ''}
      </span>
    </button>
  );
});

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

export function DrumSteps({ trackId, slot, page, clip, kitId }: DrumStepsProps) {
  const voice = useUi((s) => drumVoiceFor(s, trackId));
  const names = useMemo(() => getKitVoiceNames(kitId), [kitId]);
  const hits = useMemo(() => drumPageGrid(clip.notes, page, DRUM_VOICES), [clip.notes, page]);
  const patterns = useMemo(() => hits.map((row) => row.map((v) => velocityBucket(v)).join('')), [hits]);
  const lane = hits[voice] ?? [];
  const voiceName = names[voice] ?? `Sound ${voice + 1}`;
  const [focusStep, setFocusStep] = useState(0);
  const laneRef = useRef<HTMLDivElement>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  const burst = useKeyBurst();

  // Latest values for stable callbacks.
  const cur = useRef({ trackId, slot, page, voice, clip });
  cur.current = { trackId, slot, page, voice, clip };

  const onPick = useCallback((v: number) => {
    const c = cur.current;
    selectDrumVoice(c.trackId, v);
    auditionBlip(c.trackId, v, cmd.DEFAULT_STEP_VELOCITY);
  }, []);

  const onToggle = useCallback((step: number) => {
    const c = cur.current;
    const r = cmd.toggleStep(session.store, c.trackId, c.slot, c.page * STEPS_PER_BAR + step, c.voice, cmd.DEFAULT_STEP_VELOCITY);
    if (session.accepted(r) && r.added) auditionBlip(c.trackId, c.voice, cmd.DEFAULT_STEP_VELOCITY);
  }, []);

  const setVelocity = useCallback((step: number, velocity: number, gesture: string) => {
    const c = cur.current;
    for (const id of noteIdsAt(c.clip.notes, c.page, step, c.voice)) {
      if (!session.accepted(cmd.setNoteVelocity(session.store, c.trackId, c.slot, id, velocity, gesture))) return;
    }
  }, []);

  const focusPad = (step: number) => {
    setFocusStep(step);
    laneRef.current?.querySelector<HTMLButtonElement>(`[data-step="${step}"]`)?.focus();
  };

  const onLaneKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-step]');
    if (!el || e.ctrlKey || e.metaKey || e.altKey) return;
    const step = Number(el.dataset.step);
    let delta = 0;
    switch (e.key) {
      case 'ArrowRight':
        focusPad(Math.min(15, step + 1));
        break;
      case 'ArrowLeft':
        focusPad(Math.max(0, step - 1));
        break;
      case 'Home':
        focusPad(0);
        break;
      case 'End':
        focusPad(15);
        break;
      case 'ArrowUp':
      case '+':
      case '=':
        delta = e.shiftKey && e.key === 'ArrowUp' ? 0.01 : 0.1;
        break;
      case 'ArrowDown':
      case '-':
      case '_':
        delta = e.shiftKey && e.key === 'ArrowDown' ? -0.01 : -0.1;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (delta !== 0) {
      const v = lane[step];
      if (v < 0) return;
      setVelocity(step, clampVelocity(v + delta), burst(`${voice}:${page}:${step}`));
    }
  };

  const onOverviewKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let next = voice;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = Math.min(DRUM_VOICES - 1, voice + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = Math.max(0, voice - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = DRUM_VOICES - 1;
    else return;
    e.preventDefault();
    selectDrumVoice(trackId, next);
    overviewRef.current?.querySelector<HTMLButtonElement>(`[data-voice="${next}"]`)?.focus();
  };

  const laneHits = lane.filter((v) => v >= 0).length;
  const velocities = useMemo(() => lane.map((v) => (v >= 0 ? v : null)), [lane]);

  return (
    <div className={styles.drums}>
      <StepNumbers label={<span className={styles.colHead}>Sounds</span>} />
      <div ref={overviewRef} className={styles.overview} role="radiogroup" aria-label={`Kit sounds, bar ${page + 1}: choose the sound whose steps you edit`} onKeyDown={onOverviewKey}>
        {VOICES.map((v) => (
          <VoiceRow key={v} voice={v} name={names[v] ?? `Sound ${v + 1}`} pattern={patterns[v]} selected={v === voice} page={page} onPick={onPick} />
        ))}
      </div>
      <div ref={laneRef} className={`${grid.cols} ${styles.lane}`} role="group" aria-label={`${voiceName} steps, bar ${page + 1}. Arrow keys move, Space toggles, Up and Down change velocity.`} onKeyDown={onLaneKey}>
        <div className={styles.laneLabel}>
          <span className={styles.laneName}>{voiceName}</span>
          <span className={styles.laneMeta}>{laneHits === 0 ? `Bar ${page + 1}: no hits yet. Click a pad.` : `${laneHits} hit${laneHits === 1 ? '' : 's'} · bar ${page + 1}`}</span>
        </div>
        {STEP_INDICES.map((s) => (
          <StepPad key={s} step={s} velocity={lane[s] ?? -1} voiceName={voiceName} tabbable={s === focusStep} onToggle={onToggle} onFocusStep={setFocusStep} />
        ))}
      </div>
      <VelocityLane className={styles.velocity} values={velocities} onSet={setVelocity} title="Velocity" hint="Drag a bar ↕" />
    </div>
  );
}
