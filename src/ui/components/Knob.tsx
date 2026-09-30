/**
 * Knob — the rotary control used for every sound parameter.
 *
 * Interaction model (see CLAUDE.md "Knobs"):
 * - Vertical drag with pointer capture, so the drag continues outside the
 *   control. 200 px of travel covers the full range in normalised space
 *   (exp curves feel even across the range); Shift is 10x finer. Stepped
 *   parameters (options, small integer ranges) use a shorter throw.
 * - Double-click (or Delete/Backspace) resets to the registry default.
 * - Arrow keys: 1% of travel, Shift 0.1%; PageUp/PageDown 10%; Home/End.
 *   Stepped parameters always move by at least one step.
 * - Enter, or typing a digit, opens inline numeric entry ("2.5k", "-6",
 *   "220 ms", "L20", an option name). Enter commits, Escape cancels.
 * - The mouse wheel only acts once the knob has keyboard focus (reached with
 *   Tab, or used with its own keys), so page scrolling never changes a sound
 *   by accident — not after a click, a right-click, or Space for Play.
 * - Each drag / keyboard-or-wheel burst carries one gesture id so the app can
 *   store it as one undo step; the last call of a gesture has final: true
 *   (pointer up, blur, or ~0.7 s after the last key). During a drag onChange
 *   is coalesced to at most once per animation frame.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { clampParam, formatParam, fromNormalized, toNormalized, type ParamSpec } from '../../project/params';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { newGestureId, paramEditText, parseParamInput } from './valueInput';
import styles from './Knob.module.css';

export const KNOB_DRAG_TRAVEL_PX = 200;
export const KNOB_FINE_FACTOR = 0.1;
export const KNOB_KEY_STEP = 0.01;
export const KNOB_KEY_FINE_STEP = 0.001;
export const KNOB_PAGE_STEP = 0.1;
/** A keyboard/wheel burst ends this long after its last change. */
export const KNOB_BURST_IDLE_MS = 700;

const SWEEP = 270;
const START_ANGLE = -135;
const WHEEL_NOTCH_PX = 100;
const WHEEL_STEP = 0.02;

export interface KnobChangeInfo {
  /** Same id for every call belonging to one drag / key burst / entry. */
  gesture: string;
  /** True on the last call of the gesture. */
  final: boolean;
}

export type KnobSize = 'sm' | 'md' | 'lg';

export interface KnobProps {
  spec: ParamSpec;
  value: number;
  onChange(value: number, info: KnobChangeInfo): void;
  size?: KnobSize;
  /** Visible label and accessible name (defaults to the spec label; small knobs use the spec's short label). */
  label?: string;
  accent?: 'amber' | 'teal';
  /** A modulation cable reaches this parameter: teal arc plus a wave mark. */
  modulated?: boolean;
  /** Name of the macro controlling this parameter; the knob becomes read-only and shows it. */
  controlledBy?: string;
  disabled?: boolean;
  /** Plain-language tip (defaults to spec.tip). */
  tip?: string;
  /** Technical detail (defaults to spec.detail). */
  detail?: string;
  showValue?: boolean;
  id?: string;
  className?: string;
}

function isStepped(spec: ParamSpec): boolean {
  return spec.curve === 'enum' || spec.curve === 'int' || spec.curve === 'bool';
}

function stepCount(spec: ParamSpec): number {
  return Math.max(1, Math.round(spec.max - spec.min));
}

/** Short-throw stepped control (few discrete positions). */
function isShortStepped(spec: ParamSpec): boolean {
  return isStepped(spec) && stepCount(spec) <= 12;
}

function travelPx(spec: ParamSpec): number {
  if (isShortStepped(spec)) return Math.min(KNOB_DRAG_TRAVEL_PX, Math.max(64, stepCount(spec) * 32));
  return KNOB_DRAG_TRAVEL_PX;
}

function isBipolar(spec: ParamSpec): boolean {
  return spec.min < 0 && Math.abs(spec.max + spec.min) < 1e-9;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Move a value by a fraction of the control's normalised travel. Stepped
 * parameters always move by at least one unit so small steps never stall.
 */
export function stepParam(spec: ParamSpec, value: number, deltaNorm: number): number {
  const cur = clampParam(spec, value);
  let v = fromNormalized(spec, toNormalized(spec, cur) + deltaNorm);
  if (v === cur && deltaNorm !== 0 && isStepped(spec)) v = clampParam(spec, cur + Math.sign(deltaNorm));
  return v;
}

function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [50 + r * Math.sin(a), 50 - r * Math.cos(a)];
}

function arcPath(r: number, a0: number, a1: number): string {
  const [from, to] = a0 <= a1 ? [a0, a1] : [a1, a0];
  const [x0, y0] = polar(r, from);
  const [x1, y1] = polar(r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

interface DragState {
  pointerId: number;
  lastY: number;
  norm: number;
  gesture: string;
  pending: number | null;
  emitted: number | null;
  raf: number;
}

interface Burst {
  gesture: string;
  timer: number;
  last: number;
}

interface Entry {
  text: string;
  invalid: boolean;
  selectAll: boolean;
}

export function Knob(props: KnobProps) {
  const {
    spec,
    value,
    onChange,
    size = 'md',
    label,
    accent = 'amber',
    modulated = false,
    controlledBy,
    disabled = false,
    tip,
    detail,
    showValue = true,
    id,
    className,
  } = props;

  const readOnly = Boolean(controlledBy);
  const interactive = !disabled && !readOnly;
  const name = label ?? spec.label;
  const shownLabel = label ?? (size === 'sm' && spec.short ? spec.short : spec.label);

  const [live, setLive] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [entry, setEntry] = useState<Entry | null>(null);

  const shown = clampParam(spec, live ?? value);

  const sliderRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const latest = useRef(shown);
  const specRef = useRef(spec);
  const interactiveRef = useRef(interactive);
  const onChangeRef = useRef(onChange);
  const drag = useRef<DragState | null>(null);
  const burst = useRef<Burst | null>(null);
  const entryOpen = useRef(false);
  const wheelArmed = useRef(false);
  const pointerFocusing = useRef(false);
  const wheelAcc = useRef(0);

  useLayoutEffect(() => {
    onChangeRef.current = onChange;
    specRef.current = spec;
    interactiveRef.current = interactive;
    if (!drag.current && !burst.current) latest.current = shown;
  });

  const emit = useCallback((v: number, info: KnobChangeInfo) => onChangeRef.current(v, info), []);

  const finishBurst = useCallback(() => {
    const b = burst.current;
    if (!b) return;
    burst.current = null;
    window.clearTimeout(b.timer);
    setLive(null);
    emit(b.last, { gesture: b.gesture, final: true });
  }, [emit]);

  const burstChange = useCallback(
    (v: number) => {
      if (v === latest.current) return;
      let b = burst.current;
      if (!b) {
        b = { gesture: newGestureId('knob-key'), timer: 0, last: v };
        burst.current = b;
      }
      window.clearTimeout(b.timer);
      b.last = v;
      latest.current = v;
      setLive(v);
      emit(v, { gesture: b.gesture, final: false });
      b.timer = window.setTimeout(finishBurst, KNOB_BURST_IDLE_MS);
    },
    [emit, finishBurst],
  );

  const flushDrag = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    d.raf = 0;
    if (d.pending === null) return;
    const v = d.pending;
    d.pending = null;
    d.emitted = v;
    latest.current = v;
    setLive(v);
    emit(v, { gesture: d.gesture, final: false });
  }, [emit]);

  const endDrag = useCallback(
    (pointerId?: number) => {
      const d = drag.current;
      if (!d || (pointerId !== undefined && pointerId !== d.pointerId)) return;
      drag.current = null;
      if (d.raf) cancelAnimationFrame(d.raf);
      const el = sliderRef.current;
      try {
        if (el?.hasPointerCapture(d.pointerId)) el.releasePointerCapture(d.pointerId);
      } catch {
        /* capture already gone */
      }
      setDragging(false);
      setLive(null);
      const finalValue = d.pending ?? d.emitted;
      if (finalValue !== null) {
        latest.current = finalValue;
        emit(finalValue, { gesture: d.gesture, final: true });
      }
    },
    [emit],
  );

  // Close any open gesture on unmount so the app never keeps a dangling undo step.
  useEffect(
    () => () => {
      endDrag();
      finishBurst();
    },
    [endDrag, finishBurst],
  );

  // Lose interactivity (disabled / taken over by a macro) mid-gesture: close it.
  useEffect(() => {
    if (!interactive) {
      endDrag();
      finishBurst();
      entryOpen.current = false;
      setEntry(null);
    }
  }, [interactive, endDrag, finishBurst]);

  // Wheel: a native non-passive listener, active only with keyboard focus.
  useEffect(() => {
    const el = sliderRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (document.activeElement !== el || !wheelArmed.current || !interactiveRef.current) return;
      e.preventDefault();
      const s = specRef.current;
      let delta = e.deltaY !== 0 ? e.deltaY : e.deltaX; // Shift+wheel scrolls horizontally in Chrome
      if (e.deltaMode === 1) delta *= 16;
      else if (e.deltaMode === 2) delta *= 400;
      if (isShortStepped(s)) {
        wheelAcc.current += delta;
        if (Math.abs(wheelAcc.current) < WHEEL_NOTCH_PX / 2) return;
        const dir = wheelAcc.current < 0 ? 1 : -1;
        wheelAcc.current = 0;
        burstChange(stepParam(s, latest.current, dir * 1e-6));
      } else {
        const dn = (-delta / WHEEL_NOTCH_PX) * WHEEL_STEP * (e.shiftKey ? KNOB_FINE_FACTOR : 1);
        burstChange(stepParam(s, latest.current, dn));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [burstChange]);

  /* ---------------- pointer ---------------- */

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // Any press is pointer focus, never keyboard focus: right and middle
    // clicks (and presses on read-only knobs) focus natively later in this
    // same task, so keep the flag up until the task ends.
    wheelArmed.current = false;
    pointerFocusing.current = true;
    window.setTimeout(() => {
      pointerFocusing.current = false;
    }, 0);
    if (e.button !== 0 || !interactive) return;
    const el = e.currentTarget;
    e.preventDefault(); // no text selection; focus is set explicitly below
    el.focus({ preventScroll: true });
    finishBurst();
    endDrag();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
    drag.current = {
      pointerId: e.pointerId,
      lastY: e.clientY,
      norm: toNormalized(spec, latest.current),
      gesture: newGestureId('knob-drag'),
      pending: null,
      emitted: null,
      raf: 0,
    };
    setDragging(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dy = d.lastY - e.clientY;
    d.lastY = e.clientY;
    if (dy === 0) return;
    d.norm = clamp01(d.norm + (dy / travelPx(spec)) * (e.shiftKey ? KNOB_FINE_FACTOR : 1));
    const v = fromNormalized(spec, d.norm);
    if (v === (d.pending ?? d.emitted ?? latest.current)) return;
    d.pending = v;
    if (!d.raf) d.raf = requestAnimationFrame(flushDrag);
  };

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => endDrag(e.pointerId);

  const onDoubleClick = () => {
    if (!interactive) return;
    endDrag();
    finishBurst();
    const def = clampParam(spec, spec.default);
    latest.current = def;
    emit(def, { gesture: newGestureId('knob-reset'), final: true });
  };

  /* ---------------- keyboard ---------------- */

  const openEntry = (text: string, selectAll: boolean) => {
    finishBurst();
    entryOpen.current = true;
    setEntry({ text, invalid: false, selectAll });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || e.ctrlKey || e.metaKey || e.altKey) return;
    const fine = e.shiftKey;
    const cur = latest.current;
    let v: number;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        v = stepParam(spec, cur, fine ? KNOB_KEY_FINE_STEP : KNOB_KEY_STEP);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        v = stepParam(spec, cur, -(fine ? KNOB_KEY_FINE_STEP : KNOB_KEY_STEP));
        break;
      case 'PageUp':
        v = stepParam(spec, cur, KNOB_PAGE_STEP);
        break;
      case 'PageDown':
        v = stepParam(spec, cur, -KNOB_PAGE_STEP);
        break;
      case 'Home':
        v = clampParam(spec, spec.min);
        break;
      case 'End':
        v = clampParam(spec, spec.max);
        break;
      case 'Delete':
      case 'Backspace':
        v = clampParam(spec, spec.default);
        break;
      case 'Enter':
        e.preventDefault();
        openEntry(paramEditText(spec, cur), true);
        return;
      default:
        if (e.key.length === 1 && /[0-9.,+-]/.test(e.key)) {
          e.preventDefault();
          openEntry(e.key, false);
        }
        // Other keys (Shift alone, Space for Play, letters that play notes)
        // are not "using this knob", so they do not arm the wheel.
        return;
    }
    e.preventDefault();
    // Deliberate keyboard use of this knob arms the wheel.
    wheelArmed.current = true;
    burstChange(v);
  };

  const onFocus = () => {
    wheelArmed.current = !pointerFocusing.current;
  };
  const onBlur = () => {
    wheelArmed.current = false;
    wheelAcc.current = 0;
    finishBurst();
  };

  /* ---------------- numeric entry ---------------- */

  useEffect(() => {
    if (!entry) return;
    const input = inputRef.current;
    if (!input || document.activeElement === input) return;
    input.focus({ preventScroll: true });
    if (entry.selectAll) input.select();
    else input.setSelectionRange(input.value.length, input.value.length);
  }, [entry]);

  const closeEntry = (refocus: boolean) => {
    entryOpen.current = false;
    setEntry(null);
    if (refocus) sliderRef.current?.focus({ preventScroll: true });
  };

  const commitEntry = (refocus: boolean) => {
    if (!entryOpen.current || !entry) return;
    const v = parseParamInput(spec, entry.text, latest.current);
    if (v === null) {
      if (refocus) setEntry({ ...entry, invalid: true, selectAll: false });
      else closeEntry(false);
      return;
    }
    closeEntry(refocus);
    latest.current = v;
    emit(v, { gesture: newGestureId('knob-entry'), final: true });
  };

  /* ---------------- render ---------------- */

  const norm = toNormalized(spec, shown);
  const angle = START_ANGLE + SWEEP * norm;
  const optionKnob = spec.curve === 'enum' || spec.curve === 'bool';
  const shortStepped = isShortStepped(spec);
  const tickCount = shortStepped ? stepCount(spec) + 1 : 11;
  const baseAngle = isBipolar(spec) ? 0 : START_ANGLE;
  const formatted = formatParam(spec, shown);
  const valueText = formatted + (controlledBy ? `, set by ${controlledBy}` : '') + (modulated ? ', modulated' : '');
  const arcTone = disabled ? 'off' : modulated ? 'teal' : accent;
  const activeTick = shortStepped ? Math.round(norm * (tickCount - 1)) : -1;

  const ticks = [];
  if (size !== 'sm' || shortStepped) {
    for (let i = 0; i < tickCount; i++) {
      const a = START_ANGLE + (SWEEP * i) / (tickCount - 1);
      if (shortStepped) {
        const [x, y] = polar(47, a);
        ticks.push(<circle key={i} cx={x} cy={y} r={i === activeTick ? 2.6 : 1.9} className={i === activeTick ? styles.tickOn : styles.tickDot} />);
      } else {
        const major = i === 0 || i === tickCount - 1 || i === (tickCount - 1) / 2;
        const [x0, y0] = polar(major ? 44.5 : 46, a);
        const [x1, y1] = polar(49.5, a);
        ticks.push(<line key={i} x1={x0} y1={y0} x2={x1} y2={y1} className={major ? styles.tickMajor : styles.tick} />);
      }
    }
  }

  const tipDetail =
    [
      detail ?? spec.detail,
      controlledBy ? `Set by the ${controlledBy} macro: turn ${controlledBy} to change it.` : undefined,
      modulated ? 'A modulation cable is moving this control.' : undefined,
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  const rootClass = [styles.knob, className].filter(Boolean).join(' ');

  return (
    <div
      className={rootClass}
      data-size={size}
      data-disabled={disabled || undefined}
      data-readonly={readOnly || undefined}
      data-dragging={dragging || undefined}
      data-tone={arcTone}
    >
      <Tooltip name={name} tip={tip ?? spec.tip} detail={tipDetail}>
        <div
          ref={sliderRef}
          id={id}
          className={styles.slider}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={name}
          aria-valuemin={spec.min}
          aria-valuemax={spec.max}
          aria-valuenow={shown}
          aria-valuetext={valueText}
          aria-disabled={disabled || undefined}
          aria-readonly={readOnly || undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onLostPointerCapture={onPointerEnd}
          onDoubleClick={onDoubleClick}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          <div className={styles.dial}>
            <svg className={styles.ring} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
              {ticks}
              {!optionKnob && <path className={styles.track} d={arcPath(40, START_ANGLE, START_ANGLE + SWEEP)} />}
              {!optionKnob && Math.abs(angle - baseAngle) > 0.5 && <path className={styles.arc} d={arcPath(40, baseAngle, angle)} />}
            </svg>
            <div className={styles.body} style={{ '--angle': `${angle}deg` } as CSSProperties}>
              <div className={styles.skirt} />
              <div className={styles.cap} />
              <div className={styles.rotor}>
                <div className={styles.pointer} />
              </div>
            </div>
            {controlledBy && (
              <span className={styles.badge} aria-hidden="true">
                <Icon name="link" size={10} />
                {controlledBy}
              </span>
            )}
          </div>
          <div className={styles.label}>{shownLabel}</div>
          {showValue && (
            <div className={styles.value} data-kind={optionKnob ? 'option' : 'number'} aria-hidden="true" style={entry ? { visibility: 'hidden' } : undefined}>
              {modulated && <Icon name="wave" size={10} className={styles.modMark} />}
              {formatted}
            </div>
          )}
        </div>
      </Tooltip>
      {entry && (
        <input
          ref={inputRef}
          className={styles.entry}
          data-invalid={entry.invalid || undefined}
          aria-invalid={entry.invalid || undefined}
          aria-label={`${name} value`}
          value={entry.text}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setEntry({ ...entry, text: e.target.value, invalid: false })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commitEntry(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              closeEntry(true);
            }
          }}
          onBlur={() => commitEntry(false)}
        />
      )}
    </div>
  );
}
