/**
 * A part's volume and pan in its Song header, the same controls as its Mix
 * strip: the part's channel `level` and `pan` (session.setModuleParam), so
 * Mix stays in step, a performance take records them and each drag is one
 * undo step that names the part ("Drums level").
 *
 *   [▮▮▮▮▮▮▯▯▯ −2.0 dB]  (◔)      a horizontal level slider with its value in dB, a pan dial
 *   ▬▬▬▬▬▬▬                       a thin meter of what the part plays (the shared meter loop)
 *
 * The slider follows the knob rules (CLAUDE.md): it drags with pointer
 * capture (sideways here, as it lies), never jumps on a press, Shift is
 * finer, a double-click (or Delete) returns it to 0 dB, the arrow keys move
 * 0.5 dB (Shift 0.1 dB), Home / End the ends, Enter or a typed digit opens
 * numeric entry. It uses the Mix fader's taper, so the same dB sits at the
 * same place of the travel. The mouse wheel never changes it. A finger
 * swipe scrolls the song; a finger that rests first drags it.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { FADER_BURST_IDLE_MS, Knob, Meter, TOUCH_HOLD_MS, TOUCH_SLOP_PX, Tooltip, faderPosition, faderStep, faderValue, newGestureId, parseParamInput, paramEditText, type KnobChangeInfo } from '../../../ui/components';
import { CHANNEL_PARAMS, clampParam, specById, type ParamSpec } from '../../../project/params';
import type { Id } from '../../../project/types';
import { shallowEqual } from '../../../state/store';
import { session, useProject } from '../../instance';
import { formatLevel, formatLevelShort, trackPeak } from '../mix/mixMeters';
import { channelController, channelOf, channelValue } from '../mix/mixState';
import styles from './SongView.module.css';

const LEVEL = specById(CHANNEL_PARAMS, 'level')!;
const PAN = specById(CHANNEL_PARAMS, 'pan')!;
/** A drag across the whole slider covers the whole travel; Shift is this much finer. */
const FINE = 0.1;
const PAGE = 0.1;

/** The meter on the slider's scale, so a level lights up under the same dB. */
const METER_SCALE = (db: number) => faderPosition(LEVEL, db);

interface ChannelInfo {
  channel: Id | null;
  level: number;
  pan: number;
  levelBy: string | null;
  panBy: string | null;
}

function useChannel(trackId: Id): ChannelInfo {
  return useProject(
    (p) => ({
      channel: channelOf(p, trackId),
      level: channelValue(p, trackId, 'level'),
      pan: channelValue(p, trackId, 'pan'),
      levelBy: channelController(p, trackId, 'level'),
      panBy: channelController(p, trackId, 'pan'),
    }),
    shallowEqual,
  );
}

interface Drag {
  pointerId: number;
  lastX: number;
  pos: number;
  width: number;
  gesture: string;
  raf: number;
  pending: number | null;
}

export interface LevelSliderProps {
  spec: ParamSpec;
  value: number;
  /** Accessible name ("Drums volume"). */
  label: string;
  onChange(value: number, gesture: string): void;
  /** Name of the big knob that sets it (read-only then, and said). */
  controlledBy?: string;
  disabled?: boolean;
  tip: string;
}

/** A horizontal level slider in dB (see the file comment for its keys and gestures). */
export function LevelSlider({ spec, value, label, onChange, controlledBy, disabled, tip }: LevelSliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const hold = useRef<{ pointerId: number; x: number; y: number; timer: number } | null>(null);
  const burst = useRef<{ gesture: string; timer: number } | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const [entry, setEntry] = useState<{ text: string; invalid: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const readOnly = !!controlledBy;
  const live = !disabled && !readOnly;
  const pos = faderPosition(spec, value);
  const full = formatLevel(value, spec.min);
  const short = formatLevelShort(value, spec.min);
  const valueText = controlledBy ? `${full}, set by ${controlledBy}` : full;

  useEffect(
    () => () => {
      if (drag.current?.raf) cancelAnimationFrame(drag.current.raf);
      if (hold.current) window.clearTimeout(hold.current.timer);
      if (burst.current) window.clearTimeout(burst.current.timer);
    },
    [],
  );

  const emit = useCallback(
    (v: number, gesture: string) => {
      const c = clampParam(spec, v);
      if (c === latest.current) return;
      latest.current = c;
      onChange(c, gesture);
    },
    [spec, onChange],
  );

  /** Keys and typed values in a burst share one undo step. */
  const burstGesture = (): string => {
    const b = burst.current;
    if (b) window.clearTimeout(b.timer);
    const gesture = b?.gesture ?? newGestureId('song-level');
    burst.current = { gesture, timer: window.setTimeout(() => (burst.current = null), FADER_BURST_IDLE_MS) };
    return gesture;
  };

  const begin = (el: HTMLElement, pointerId: number, x: number) => {
    try {
      el.setPointerCapture(pointerId);
    } catch {
      /* the pointer is gone */
    }
    drag.current = { pointerId, lastX: x, pos: faderPosition(spec, latest.current), width: Math.max(24, el.getBoundingClientRect().width), gesture: newGestureId('song-level'), raf: 0, pending: null };
    setDragging(true);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !live || entry) return;
    // The lane's own gestures never see a press on the slider.
    e.stopPropagation();
    if (e.pointerType === 'touch') {
      const el = e.currentTarget;
      const pointerId = e.pointerId;
      const x = e.clientX;
      hold.current = { pointerId, x, y: e.clientY, timer: window.setTimeout(() => {
        if (hold.current?.pointerId !== pointerId) return;
        hold.current = null;
        begin(el, pointerId, x);
      }, TOUCH_HOLD_MS) };
      return;
    }
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    begin(e.currentTarget, e.pointerId, e.clientX);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const h = hold.current;
    if (h && h.pointerId === e.pointerId) {
      // A finger that moves before it rested: a swipe (the song scrolls), nothing changes.
      if (Math.hypot(e.clientX - h.x, e.clientY - h.y) >= TOUCH_SLOP_PX) {
        window.clearTimeout(h.timer);
        hold.current = null;
      }
      return;
    }
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    d.pos = Math.min(1, Math.max(0, d.pos + ((e.clientX - d.lastX) / d.width) * (e.shiftKey ? FINE : 1)));
    d.lastX = e.clientX;
    d.pending = faderValue(spec, d.pos);
    if (!d.raf)
      d.raf = requestAnimationFrame(() => {
        d.raf = 0;
        if (d.pending !== null) emit(d.pending, d.gesture);
        d.pending = null;
      });
  };

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    const h = hold.current;
    if (h && h.pointerId === e.pointerId) {
      window.clearTimeout(h.timer);
      hold.current = null;
    }
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (d.raf) cancelAnimationFrame(d.raf);
    if (d.pending !== null) emit(d.pending, d.gesture);
    drag.current = null;
    setDragging(false);
  };

  const openEntry = (text: string) => setEntry({ text, invalid: false });
  const commitEntry = (keepFocus: boolean) => {
    if (!entry) return;
    const v = parseParamInput(spec, entry.text, latest.current);
    if (v === null) {
      setEntry({ ...entry, invalid: true });
      return;
    }
    emit(v, newGestureId('song-level'));
    setEntry(null);
    if (keepFocus) requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!live || e.ctrlKey || e.metaKey || e.altKey) return;
    const cur = latest.current;
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = faderStep(spec, cur, 1, e.shiftKey);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = faderStep(spec, cur, -1, e.shiftKey);
        break;
      case 'PageUp':
        next = faderValue(spec, faderPosition(spec, cur) + PAGE);
        break;
      case 'PageDown':
        next = faderValue(spec, faderPosition(spec, cur) - PAGE);
        break;
      case 'Home':
        next = spec.min;
        break;
      case 'End':
        next = spec.max;
        break;
      case 'Delete':
      case 'Backspace':
        next = spec.default;
        break;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        openEntry(paramEditText(spec, cur));
        return;
      default:
        if (/^[0-9+\-−.,]$/.test(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          openEntry(e.key === '−' ? '-' : e.key);
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    emit(next, burstGesture());
  };

  const style = { '--pos': pos } as CSSProperties;
  return (
    <span className={styles.level} data-dragging={dragging || undefined} data-readonly={readOnly || undefined} data-disabled={disabled || undefined}>
      <Tooltip
        name={label}
        tip={controlledBy ? `${tip} It is set by the ${controlledBy} big knob now: turn ${controlledBy} to change it.` : tip}
        hint={live ? 'Drag sideways (Shift: finer). Arrow keys move 0.5 dB. Double-click returns it to 0 dB; type a number for an exact value.' : undefined}
      >
        <div
          ref={ref}
          className={styles.levelTrack}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={label}
          aria-orientation="horizontal"
          aria-valuemin={spec.min}
          aria-valuemax={spec.max}
          aria-valuenow={value}
          aria-valuetext={valueText}
          aria-readonly={readOnly || undefined}
          aria-disabled={disabled || undefined}
          style={style}
          data-side={pos > 0.55 ? 'left' : 'right'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onLostPointerCapture={onPointerEnd}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (live) emit(spec.default, newGestureId('song-level'));
          }}
          onKeyDown={onKeyDown}
        >
          <span className={styles.levelFill} aria-hidden="true" />
          <span className={styles.levelCap} aria-hidden="true" />
          <span className={styles.levelValue} aria-hidden="true" style={entry ? { visibility: 'hidden' } : undefined}>
            {short}
          </span>
        </div>
      </Tooltip>
      {entry && (
        <input
          className={styles.levelEntry}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          data-invalid={entry.invalid || undefined}
          aria-invalid={entry.invalid || undefined}
          aria-label={`${label} in dB`}
          value={entry.text}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setEntry({ text: e.currentTarget.value, invalid: false })}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commitEntry(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEntry(null);
              requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
            }
          }}
          onBlur={() => {
            if (entry) {
              const v = parseParamInput(spec, entry.text, latest.current);
              if (v !== null) emit(v, newGestureId('song-level'));
            }
            setEntry(null);
          }}
        />
      )}
    </span>
  );
}

/** A part's volume slider, pan dial and meter (its channel's level and pan, as in Mix). */
export const PartControls = memo(function PartControls({ trackId, name }: { trackId: Id; name: string }) {
  const info = useChannel(trackId);
  const panSpec = useMemo<ParamSpec>(() => ({ ...PAN, label: `${name} pan`, short: 'Pan' }), [name]);
  const channel = info.channel;
  const setLevel = useCallback(
    (v: number, gesture: string) => {
      if (channel) session.setModuleParam(channel, 'level', v, gesture);
    },
    [channel],
  );
  const setPan = useCallback(
    (v: number, i: KnobChangeInfo) => {
      if (channel) session.setModuleParam(channel, 'pan', v, i.gesture);
    },
    [channel],
  );
  const read = useCallback(() => trackPeak(trackId), [trackId]);
  return (
    <span className={styles.partControls} data-part-controls="">
      <span className={styles.levelStack}>
        <LevelSlider
          spec={LEVEL}
          value={info.level}
          label={`${name} volume`}
          onChange={setLevel}
          controlledBy={info.levelBy ?? undefined}
          disabled={!channel}
          tip={`How loud ${name} is in the song. It is the same level as ${name}’s fader in Mix.`}
        />
        <Meter read={read} label={`${name} meter`} orientation="horizontal" thickness={2} segments={20} floorDb={LEVEL.min} scale={METER_SCALE} showClip={false} className={styles.partMeter} />
      </span>
      <Knob
        spec={panSpec}
        value={info.pan}
        size="sm"
        showValue={false}
        onChange={setPan}
        controlledBy={info.panBy ?? undefined}
        disabled={!channel}
        tip={`Places ${name} left or right. The same as the Pan knob in Mix.`}
        className={styles.partPan}
      />
    </span>
  );
});
