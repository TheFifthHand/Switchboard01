/**
 * Pad — a pale silicone pad with a small, controlled pool of light.
 *
 * Its state is always readable without colour: a caption with an icon
 * ("▶ Playing", "Next bar", "● Rec", "Stopping"), a recessed look with a "+"
 * for empty slots, and a ring for the selected pad. onPress fires on
 * pointerdown for low latency, with a velocity from where the pad is struck
 * (lower = harder), and on Space/Enter when focused.
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Icon, type IconName } from './Icon';
import styles from './Pad.module.css';

export type PadState = 'empty' | 'ready' | 'queued' | 'playing' | 'recording' | 'stopping';

export interface PadPressEvent {
  /** 0..1 */
  velocity: number;
}

export interface PadProps {
  state: PadState;
  selected?: boolean;
  label: string;
  sublabel?: string;
  /** Colour of the light when active (recording is always coral). */
  accent?: 'amber' | 'teal' | 'coral';
  /** 0..1, scales the light (e.g. a step's velocity). */
  intensity?: number;
  /** 'fill' (default) stretches to the grid cell. */
  size?: 'sm' | 'md' | 'lg' | 'fill';
  onPress(e: PadPressEvent): void;
  onRelease?(): void;
  ariaLabel?: string;
  /** Computer key that plays this pad, shown in a corner. */
  keyHint?: string;
  disabled?: boolean;
  /** Replaces the state caption (null hides it, e.g. for drum and note pads). */
  caption?: string | null;
  id?: string;
  className?: string;
}

/** Velocity from the vertical strike position (0 = top edge, 1 = bottom edge). */
export function velocityFromPosition(fraction: number, min = 0.4): number {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0.5));
  return Math.round((min + (1 - min) * f) * 1000) / 1000;
}

/** Velocity used for keyboard activation. */
export const PAD_KEY_VELOCITY = 0.8;

export const PAD_STATE_TEXT: Record<PadState, string> = {
  empty: 'Empty',
  ready: 'Ready',
  queued: 'Next bar',
  playing: 'Playing',
  recording: 'Rec',
  stopping: 'Stopping',
};

const PAD_STATE_SPOKEN: Record<PadState, string> = {
  empty: 'empty',
  ready: 'ready',
  queued: 'starts on the next bar',
  playing: 'playing',
  recording: 'recording',
  stopping: 'stopping at the next bar',
};

const STATE_ICON: Partial<Record<PadState, IconName>> = {
  queued: 'clock',
  playing: 'play',
  recording: 'record',
  stopping: 'stop',
};

export function Pad(props: PadProps) {
  const {
    state,
    selected = false,
    label,
    sublabel,
    accent = 'amber',
    intensity = 1,
    size = 'fill',
    onPress,
    onRelease,
    ariaLabel,
    keyHint,
    disabled = false,
    caption,
    id,
    className,
  } = props;

  const [pressed, setPressed] = useState(false);
  const pointer = useRef<number | null>(null);
  const keyDown = useRef<string | null>(null);
  const onReleaseRef = useRef(onRelease);
  useEffect(() => {
    onReleaseRef.current = onRelease;
  });

  const release = () => {
    if (pointer.current === null && keyDown.current === null) return;
    pointer.current = null;
    keyDown.current = null;
    setPressed(false);
    onReleaseRef.current?.();
  };

  // A pad disabled while held (e.g. the part becomes locked) would never see
  // its pointerup or key-up: release it now.
  useEffect(() => {
    if (!disabled || (pointer.current === null && keyDown.current === null)) return;
    pointer.current = null;
    keyDown.current = null;
    setPressed(false);
    onReleaseRef.current?.();
  }, [disabled]);

  // Never leave a pad held: release on window blur and on unmount.
  useEffect(() => {
    const onBlur = () => {
      if (pointer.current === null && keyDown.current === null) return;
      pointer.current = null;
      keyDown.current = null;
      setPressed(false);
      onReleaseRef.current?.();
    };
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      onBlur();
    };
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (pointer.current !== null) return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const velocity = velocityFromPosition(r.height > 0 ? (e.clientY - r.top) / r.height : 0.5);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    pointer.current = e.pointerId;
    setPressed(true);
    onPress({ velocity });
  };

  const onPointerEnd = (e: PointerEvent<HTMLButtonElement>) => {
    if (pointer.current !== e.pointerId) return;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    release();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (disabled || e.repeat || keyDown.current !== null || e.ctrlKey || e.metaKey || e.altKey) return;
    keyDown.current = e.key;
    setPressed(true);
    onPress({ velocity: PAD_KEY_VELOCITY });
  };

  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== keyDown.current) return;
    e.preventDefault();
    if (pointer.current === null) release();
    else keyDown.current = null;
  };

  const shownCaption = caption === undefined ? (state === 'empty' ? null : PAD_STATE_TEXT[state]) : caption;
  const icon = STATE_ICON[state];
  const light = state === 'recording' ? 'coral' : accent;
  const lvl = Math.min(1, Math.max(0, intensity));
  const spoken =
    ariaLabel ??
    [label, sublabel, caption === null || caption === undefined ? PAD_STATE_SPOKEN[state] : caption, selected ? 'selected' : null].filter(Boolean).join(', ');

  const cls = [styles.pad, className].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      id={id}
      className={cls}
      data-state={state}
      data-light={light}
      data-size={size}
      data-selected={selected || undefined}
      data-pressed={pressed || undefined}
      data-keyhint={keyHint ? true : undefined}
      data-wrap={!sublabel && !shownCaption ? true : undefined}
      disabled={disabled}
      aria-label={spoken}
      aria-keyshortcuts={keyHint || undefined}
      style={{ '--intensity': String(0.35 + 0.65 * lvl) } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={() => keyDown.current !== null && pointer.current === null && release()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className={styles.light} aria-hidden="true" />
      <span className={styles.face} aria-hidden="true">
        {state === 'empty' && (
          <span className={styles.plus}>
            <Icon name="plus" size={14} />
          </span>
        )}
        <span className={styles.text}>
          <span className={styles.label}>{label}</span>
          {sublabel && <span className={styles.sublabel}>{sublabel}</span>}
        </span>
        {shownCaption && (
          <span className={styles.caption}>
            {icon && <Icon name={icon} size={10} className={styles.capIcon} />}
            <span className={styles.capText}>{shownCaption}</span>
          </span>
        )}
        {keyHint && <span className={styles.key}>{keyHint}</span>}
      </span>
    </button>
  );
}
