/**
 * Pad — a pale silicone pad with a small, controlled pool of light.
 *
 * Its state is always readable without colour: a caption with an icon
 * ("▶ Playing", "Next bar", "● Rec", "Stopping"), a recessed look with a "+"
 * for empty slots, and a ring for the selected pad. onPress fires on
 * pointerdown for low latency, with a velocity from where the pad is struck
 * (lower = harder), and on Space/Enter when focused. A pad that can also be
 * dragged (`activateOn="release"`, the clip pads) presses on pointerup
 * instead, and only when the pointer moved less than TAP_SLOP_PX, so a drag
 * never launches it.
 *
 * Playing pads show an even amber wash (recording: coral). A caller can draw
 * how far a playing clip is through its loop: write the CSS variable
 * `--loop-progress` (a number 0..1) on the pad (`ref`) or any ancestor from an
 * animation-frame loop that reads the audio clock (no React state per frame);
 * the 3 px bar along the bottom appears only once it is written. `sketch` is
 * a small picture of the pad's content (see ClipSketch), shown in the empty
 * middle of pads at least 100 px tall. A long name fades out at its end
 * instead of an ellipsis; while it is cut, the pad's native title has it whole
 * (measured when the pointer comes over the pad, so a pad whose name fits
 * shows no second tooltip). On large pads (about 150 x 120 px and up) a large
 * name steps up to --fs-2xl.
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref } from 'react';
import { Icon, type IconName } from './Icon';
import styles from './Pad.module.css';

export type PadState = 'empty' | 'ready' | 'queued' | 'playing' | 'recording' | 'stopping';

/** Movement (CSS px) after which a press on a draggable pad becomes a drag instead of a tap. */
export const TAP_SLOP_PX = 6;

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
  /** 'press' (default): onPress on pointerdown. 'release': on pointerup after a tap (moving TAP_SLOP_PX or more makes it a drag). */
  activateOn?: 'press' | 'release';
  /** Larger name (clip pads). */
  labelSize?: 'md' | 'lg';
  /** Empty pads: show only a faint "+"; the label appears on hover and keyboard focus. */
  quietEmpty?: boolean;
  /** Icon for a caption shown without a state icon of its own (e.g. "Paused"). */
  captionIcon?: IconName;
  /**
   * A small key sits over the pad's top-right corner (e.g. the selected clip
   * pad's '⋯'): the name and length make room for it, so it never covers
   * them, and the state caption at the bottom keeps the whole width.
   */
  cornerKey?: boolean;
  /** Keys that act on the focused pad, besides its own computer key (e.g. "Shift+F10 F2"). */
  shortcuts?: string;
  /** A small picture of the content (e.g. a ClipSketch), drawn in the pad's empty middle when it is at least 100 px tall. */
  sketch?: ReactNode;
  /**
   * Native title of the pad. Default (undefined): the label, only while the name is cut on screen
   * (checked when the pointer enters); a string: always that; null: never.
   */
  title?: string | null;
  /** The pad's button, e.g. to write `--loop-progress` from an animation-frame loop. */
  ref?: Ref<HTMLButtonElement>;
  /** Set by a Tooltip around the pad (its description). */
  'aria-describedby'?: string;
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
    activateOn = 'press',
    labelSize = 'md',
    quietEmpty = false,
    captionIcon,
    cornerKey = false,
    shortcuts,
    sketch,
    title,
    ref,
    id,
    className,
  } = props;
  const describedBy = props['aria-describedby'];

  const [pressed, setPressed] = useState(false);
  const pointer = useRef<number | null>(null);
  /** Release mode: where the pointer went down, and the velocity it would play with; null once it became a drag. */
  const tap = useRef<{ x: number; y: number; velocity: number } | null>(null);
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
    if (activateOn === 'release') tap.current = { x: e.clientX, y: e.clientY, velocity };
    else onPress({ velocity });
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const t = tap.current;
    if (!t || pointer.current !== e.pointerId) return;
    if (Math.hypot(e.clientX - t.x, e.clientY - t.y) >= TAP_SLOP_PX) {
      // A drag: it never presses the pad.
      tap.current = null;
      setPressed(false);
    }
  };

  const onPointerEnd = (e: PointerEvent<HTMLButtonElement>) => {
    if (pointer.current !== e.pointerId) return;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const t = tap.current;
    tap.current = null;
    if (t && e.type === 'pointerup' && !disabled) onPress({ velocity: t.velocity });
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
  const icon = captionIcon ?? STATE_ICON[state];
  const light = state === 'recording' ? 'coral' : accent;
  const lvl = Math.min(1, Math.max(0, intensity));
  const spoken =
    ariaLabel ??
    [label, sublabel, caption === null || caption === undefined ? PAD_STATE_SPOKEN[state] : caption, selected ? 'selected' : null].filter(Boolean).join(', ');

  const cls = [styles.pad, className].filter(Boolean).join(' ');

  // The full name as a native title only while it is cut: measured as the pointer arrives, and
  // again if the name or state changes after that (no stale name left in the title).
  const titled = useRef<HTMLButtonElement | null>(null);
  const applyTitle = (el: HTMLButtonElement) => {
    if (title !== undefined) return;
    const name = el.querySelector<HTMLElement>('[data-pad-name]');
    const cut = !!name && state !== 'empty' && (name.scrollWidth > name.clientWidth + 0.5 || name.scrollHeight > name.clientHeight + 0.5);
    if (cut) el.title = label;
    else el.removeAttribute('title');
  };
  const titleWhenCut = (e: PointerEvent<HTMLButtonElement>) => {
    titled.current = e.currentTarget;
    applyTitle(e.currentTarget);
  };
  useEffect(() => {
    if (titled.current?.isConnected) applyTitle(titled.current);
  }, [label, state, title]);

  return (
    <button
      ref={ref}
      type="button"
      id={id}
      title={title ?? undefined}
      className={cls}
      data-state={state}
      data-light={light}
      data-size={size}
      data-selected={selected || undefined}
      data-pressed={pressed || undefined}
      data-keyhint={keyHint ? true : undefined}
      data-wrap={!sublabel && !shownCaption ? true : undefined}
      data-label={labelSize === 'lg' ? 'lg' : undefined}
      data-quiet={quietEmpty && state === 'empty' ? true : undefined}
      data-corner={cornerKey || undefined}
      disabled={disabled}
      aria-label={spoken}
      aria-describedby={describedBy}
      aria-keyshortcuts={[keyHint, shortcuts].filter(Boolean).join(' ') || undefined}
      style={{ '--intensity': String(0.35 + 0.65 * lvl) } as CSSProperties}
      onPointerEnter={titleWhenCut}
      onPointerDown={onPointerDown}
      onPointerMove={activateOn === 'release' ? onPointerMove : undefined}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={() => keyDown.current !== null && pointer.current === null && release()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className={styles.light} aria-hidden="true" />
      <span className={styles.progress} aria-hidden="true" />
      <span className={styles.face} aria-hidden="true">
        {state === 'empty' && (
          <span className={styles.plus}>
            <Icon name="plus" size={14} />
          </span>
        )}
        <span className={styles.text}>
          <span className={styles.label} data-pad-name="">
            {label}
          </span>
          {sublabel && <span className={styles.sublabel}>{sublabel}</span>}
        </span>
        {sketch && state !== 'empty' && <span className={styles.sketch}>{sketch}</span>}
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
