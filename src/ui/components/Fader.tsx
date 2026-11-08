/**
 * Fader — a vertical slider, like a console channel fader.
 *
 * Interaction model (the same rules as the Knob, see CLAUDE.md "Knobs"):
 * - Drag up or down anywhere on the fader, with pointer capture, so the drag
 *   continues outside it. The cap follows the pointer one to one (a press
 *   alone never jumps the value); Shift is 10x finer. While dragging,
 *   onChange is coalesced to at most once per animation frame.
 * - Touch (see touchDrag.ts): a finger drags at once only from the cap (at
 *   least 44 px around it), or anywhere on the fader after resting still for
 *   250 ms; a finger that moves first scrolls the page and changes nothing.
 * - Double-click (or Delete/Backspace) returns to the registry default.
 * - Arrow keys: 0.5 dB on a dB fader (Shift: 0.1 dB), otherwise 1% of travel
 *   (Shift 0.1%); PageUp/PageDown 10% of travel; Home/End the ends.
 * - Enter, or typing a digit or sign, opens numeric entry ("-6", "+1.5 dB").
 *   Enter commits, Escape cancels. A click on the value under the fader opens
 *   the same entry. The value row never spills: `formatShort` gives a shorter
 *   visible text ("Silent") while the full one stays in aria and the title.
 * - The mouse wheel only acts once the fader has keyboard focus (reached with
 *   Tab, or used with its own keys), so scrolling never moves a level by
 *   accident.
 * - Each drag, key/wheel burst, reset or typed entry carries one gesture id so
 *   the app stores it as one undo step; its last call has final: true.
 * - dB faders use an audio taper (travel proportional to gain^¼): about four
 *   fifths of the way up is 0 dB, so the useful range near unity gets most of
 *   the travel and the quiet end is compressed, as on a mixing desk.
 *
 * Accessible as role="slider" (vertical) with the value in aria-valuetext.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { clampParam, formatParam, fromNormalized, toNormalized, type ParamSpec } from '../../project/params';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { TOUCH_HOLD_MS, TOUCH_SLOP_PX, onTouchGrip, type PendingTouch } from './touchDrag';
import { newGestureId, paramEditText, parseParamInput } from './valueInput';
import styles from './Fader.module.css';

export const FADER_FINE_FACTOR = 0.1;
/** Arrow-key steps on dB faders. */
export const FADER_DB_STEP = 0.5;
export const FADER_DB_FINE_STEP = 0.1;
/** Arrow-key steps on other faders, as fractions of the travel. */
export const FADER_KEY_STEP = 0.01;
export const FADER_KEY_FINE_STEP = 0.001;
export const FADER_PAGE_STEP = 0.1;
/** A keyboard/wheel burst ends this long after its last change. */
export const FADER_BURST_IDLE_MS = 700;
/** Scale marks of a dB fader (those inside the range are drawn). */
export const FADER_DB_MARKS: readonly number[] = [6, 0, -10, -20, -40, -60];

const WHEEL_NOTCH_PX = 100;
/** dB per 1/4 power of gain: position follows 10^(dB/80). */
const TAPER_DB = 80;

export interface FaderChangeInfo {
  /** Same id for every call belonging to one drag / key burst / reset / entry. */
  gesture: string;
  /** True on the last call of the gesture. */
  final: boolean;
}

export interface FaderProps {
  spec: ParamSpec;
  value: number;
  onChange(value: number, info: FaderChangeInfo): void;
  /** Accessible name, e.g. "Drums level" (defaults to the spec label). */
  label?: string;
  /** Text for the value (display and aria-valuetext); defaults to the registry format. */
  format?(value: number): string;
  /** Shorter visible text for the value row (e.g. "Silent"); aria-valuetext and the title keep `format`. */
  formatShort?(value: number): string;
  /** Name of the macro controlling this level; the fader becomes read-only and says so. */
  controlledBy?: string;
  /** A modulation cable moves this level: teal mark, and the value text says so. */
  modulated?: boolean;
  disabled?: boolean;
  /** Plain-language tip (defaults to spec.tip) and technical detail (defaults to spec.detail). */
  tip?: string;
  detail?: string;
  /** Scale marks in the spec's units; defaults to FADER_DB_MARKS on dB faders, none otherwise. */
  marks?: readonly number[];
  showValue?: boolean;
  id?: string;
  className?: string;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const isDb = (spec: ParamSpec) => spec.unit === 'dB';
const taperRoot = (db: number) => Math.pow(10, db / TAPER_DB);

/** Position (0 = bottom, 1 = top) of a value on the fader. */
export function faderPosition(spec: ParamSpec, value: number): number {
  const v = clampParam(spec, value);
  if (!isDb(spec)) return toNormalized(spec, v);
  const lo = taperRoot(spec.min);
  const hi = taperRoot(spec.max);
  return hi === lo ? 0 : clamp01((taperRoot(v) - lo) / (hi - lo));
}

/** Value at a fader position (inverse of faderPosition); dB values are rounded to 0.1 dB. */
export function faderValue(spec: ParamSpec, position: number): number {
  const t = clamp01(position);
  if (!isDb(spec)) return fromNormalized(spec, t);
  const lo = taperRoot(spec.min);
  const hi = taperRoot(spec.max);
  const db = TAPER_DB * Math.log10(lo + t * (hi - lo));
  return clampParam(spec, Math.round(db * 10) / 10);
}

/** One keyboard step from `value` (direction ±1), fine with Shift. */
export function faderStep(spec: ParamSpec, value: number, direction: 1 | -1, fine: boolean): number {
  const cur = clampParam(spec, value);
  if (isDb(spec)) return clampParam(spec, Math.round((cur + direction * (fine ? FADER_DB_FINE_STEP : FADER_DB_STEP)) * 10) / 10);
  const v = faderValue(spec, faderPosition(spec, cur) + direction * (fine ? FADER_KEY_FINE_STEP : FADER_KEY_STEP));
  // Stepped parameters always move by at least one unit.
  if (v === cur && (spec.curve === 'int' || spec.curve === 'enum')) return clampParam(spec, cur + direction);
  return v;
}

function markText(spec: ParamSpec, v: number): string {
  if (!isDb(spec)) return formatParam(spec, v);
  return v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0';
}

function gestureHint(spec: ParamSpec, format: (v: number) => string): string {
  const home = format(clampParam(spec, spec.default));
  const fine = isDb(spec) ? 'arrow keys move 0.5 dB (Shift: 0.1 dB)' : 'arrow keys move it in small steps (Shift: finer)';
  return `Drag up or down (hold Shift for fine moves); ${fine}. Double-click returns it to ${home}. For an exact value, click the value under it, or click the fader and type a number.`;
}

interface DragState {
  pointerId: number;
  lastY: number;
  pos: number;
  travel: number;
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

export function Fader(props: FaderProps) {
  const { spec, value, onChange, label, format, formatShort, controlledBy, modulated = false, disabled = false, tip, detail, marks, showValue = true, id, className } = props;
  const readOnly = Boolean(controlledBy);
  const interactive = !disabled && !readOnly;
  const name = label ?? spec.label;
  const fmt = format ?? ((v: number) => formatParam(spec, v));

  const [live, setLive] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [entry, setEntry] = useState<Entry | null>(null);
  const shown = clampParam(spec, live ?? value);

  const sliderRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const capRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingTouch = useRef<PendingTouch | null>(null);
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

  const emit = useCallback((v: number, info: FaderChangeInfo) => onChangeRef.current(v, info), []);

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
        b = { gesture: newGestureId('fader-key'), timer: 0, last: v };
        burst.current = b;
      }
      window.clearTimeout(b.timer);
      b.last = v;
      latest.current = v;
      setLive(v);
      emit(v, { gesture: b.gesture, final: false });
      b.timer = window.setTimeout(finishBurst, FADER_BURST_IDLE_MS);
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

  const cancelPending = useCallback(() => {
    const p = pendingTouch.current;
    if (!p) return;
    pendingTouch.current = null;
    window.clearTimeout(p.timer);
  }, []);

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
      cancelPending();
      endDrag();
      finishBurst();
    },
    [cancelPending, endDrag, finishBurst],
  );

  // Losing interactivity (disabled, taken over by a macro) mid-gesture closes it.
  useEffect(() => {
    if (!interactive) {
      cancelPending();
      endDrag();
      finishBurst();
      entryOpen.current = false;
      setEntry(null);
    }
  }, [interactive, cancelPending, endDrag, finishBurst]);

  // Touch: once a drag has begun, the finger's moves must not scroll the page (only a non-passive
  // touchmove listener can stop that after the touch started; the lane allows panning).
  useEffect(() => {
    const el = sliderRef.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (drag.current && e.cancelable) e.preventDefault();
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, []);

  // Wheel: a native non-passive listener, active only with keyboard focus.
  useEffect(() => {
    const el = sliderRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (document.activeElement !== el || !wheelArmed.current || !interactiveRef.current) return;
      e.preventDefault();
      let delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (e.deltaMode === 1) delta *= 16;
      else if (e.deltaMode === 2) delta *= 400;
      wheelAcc.current += delta;
      if (Math.abs(wheelAcc.current) < WHEEL_NOTCH_PX / 2) return;
      const dir = wheelAcc.current < 0 ? 1 : -1;
      wheelAcc.current = 0;
      burstChange(faderStep(specRef.current, latest.current, dir, e.shiftKey));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [burstChange]);

  /* ---------------- pointer ---------------- */

  /** Start a drag with `pointerId` from `clientY` (the press, or where a resting finger is). */
  const beginDrag = (el: HTMLDivElement, pointerId: number, clientY: number) => {
    el.focus({ preventScroll: true });
    finishBurst();
    endDrag();
    try {
      el.setPointerCapture(pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
    const laneH = laneRef.current?.getBoundingClientRect().height ?? 0;
    const capH = capRef.current?.getBoundingClientRect().height ?? 0;
    drag.current = {
      pointerId,
      lastY: clientY,
      pos: faderPosition(specRef.current, latest.current),
      travel: Math.max(40, laneH - capH),
      gesture: newGestureId('fader-drag'),
      pending: null,
      emitted: null,
      raf: 0,
    };
    setDragging(true);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    wheelArmed.current = false;
    pointerFocusing.current = true;
    window.setTimeout(() => {
      pointerFocusing.current = false;
    }, 0);
    if (e.button !== 0 || !interactive) return;
    const el = e.currentTarget;
    if (e.pointerType === 'touch') {
      if (drag.current || pendingTouch.current) return; // a second finger
      if (!onTouchGrip(capRef.current, e.clientX, e.clientY)) {
        // Off the cap: a swipe scrolls the page; a finger that rests still takes the fader.
        const pointerId = e.pointerId;
        const pending: PendingTouch = { pointerId, x: e.clientX, y: e.clientY, lastY: e.clientY, timer: 0 };
        pending.timer = window.setTimeout(() => {
          if (pendingTouch.current !== pending) return;
          pendingTouch.current = null;
          if (interactiveRef.current && sliderRef.current) beginDrag(sliderRef.current, pointerId, pending.lastY);
        }, TOUCH_HOLD_MS);
        pendingTouch.current = pending;
        return;
      }
    }
    e.preventDefault();
    beginDrag(el, e.pointerId, e.clientY);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = pendingTouch.current;
    if (p && e.pointerId === p.pointerId) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) >= TOUCH_SLOP_PX) cancelPending();
      else p.lastY = e.clientY;
      return;
    }
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dy = d.lastY - e.clientY;
    d.lastY = e.clientY;
    if (dy === 0) return;
    d.pos = clamp01(d.pos + (dy / d.travel) * (e.shiftKey ? FADER_FINE_FACTOR : 1));
    const v = faderValue(spec, d.pos);
    if (v === (d.pending ?? d.emitted ?? latest.current)) return;
    d.pending = v;
    if (!d.raf) d.raf = requestAnimationFrame(flushDrag);
  };

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (pendingTouch.current?.pointerId === e.pointerId) cancelPending();
    endDrag(e.pointerId);
  };

  const onDoubleClick = () => {
    if (!interactive) return;
    endDrag();
    finishBurst();
    const def = clampParam(spec, spec.default);
    latest.current = def;
    emit(def, { gesture: newGestureId('fader-reset'), final: true });
  };

  /* ---------------- keyboard ---------------- */

  const openEntry = (text: string, selectAll: boolean) => {
    finishBurst();
    entryOpen.current = true;
    setEntry({ text, invalid: false, selectAll });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || e.ctrlKey || e.metaKey || e.altKey) return;
    const cur = latest.current;
    let v: number;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        v = faderStep(spec, cur, 1, e.shiftKey);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        v = faderStep(spec, cur, -1, e.shiftKey);
        break;
      case 'PageUp':
        v = faderValue(spec, faderPosition(spec, cur) + FADER_PAGE_STEP);
        break;
      case 'PageDown':
        v = faderValue(spec, faderPosition(spec, cur) - FADER_PAGE_STEP);
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
        return;
    }
    e.preventDefault();
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
    const parsed = parseParamInput(spec, entry.text, latest.current);
    if (parsed === null) {
      if (refocus) setEntry({ ...entry, invalid: true, selectAll: false });
      else closeEntry(false);
      return;
    }
    const v = isDb(spec) ? clampParam(spec, Math.round(parsed * 10) / 10) : parsed;
    closeEntry(refocus);
    latest.current = v;
    emit(v, { gesture: newGestureId('fader-entry'), final: true });
  };

  /* ---------------- render ---------------- */

  const pos = faderPosition(spec, shown);
  const formatted = fmt(shown);
  const shortText = formatShort ? formatShort(shown) : formatted;
  const valueText = formatted + (controlledBy ? `, set by ${controlledBy}` : '') + (modulated ? ', moved by a cable' : '');
  const scale = (marks ?? (isDb(spec) ? FADER_DB_MARKS : [])).filter((m) => m >= spec.min && m <= spec.max);
  const tipDetail =
    [detail ?? spec.detail, controlledBy ? `Set by the ${controlledBy} macro: turn ${controlledBy} to change it.` : undefined, modulated ? 'A modulation cable is moving this level.' : undefined]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div
      className={[styles.fader, className].filter(Boolean).join(' ')}
      data-disabled={disabled || undefined}
      data-readonly={readOnly || undefined}
      data-dragging={dragging || undefined}
      data-modulated={modulated || undefined}
    >
      <Tooltip name={name} tip={tip ?? spec.tip} detail={tipDetail} hint={interactive ? gestureHint(spec, fmt) : undefined}>
        <div
          ref={sliderRef}
          id={id}
          className={styles.slider}
          role="slider"
          aria-orientation="vertical"
          tabIndex={disabled ? -1 : 0}
          aria-label={name}
          aria-valuemin={spec.min}
          aria-valuemax={spec.max}
          aria-valuenow={shown}
          aria-valuetext={valueText}
          aria-disabled={disabled || undefined}
          aria-readonly={readOnly || undefined}
          style={{ '--pos': pos } as CSSProperties}
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
          {scale.length > 0 && (
            <span className={styles.scale} aria-hidden="true">
              {scale.map((m) => (
                <span key={m} className={styles.mark} data-unity={isDb(spec) && m === 0 ? '' : undefined} style={{ '--at': faderPosition(spec, m) } as CSSProperties}>
                  {markText(spec, m)}
                </span>
              ))}
            </span>
          )}
          <div ref={laneRef} className={styles.lane}>
            <span className={styles.slot} />
            {scale.map((m) => (
              <span key={m} className={styles.tick} data-unity={isDb(spec) && m === 0 ? '' : undefined} style={{ '--at': faderPosition(spec, m) } as CSSProperties} />
            ))}
            <span ref={capRef} className={styles.cap}>
              <span className={styles.capLine} />
            </span>
          </div>
        </div>
      </Tooltip>
      {showValue &&
        (interactive ? (
          <button
            type="button"
            className={`${styles.value} mono`}
            tabIndex={-1}
            title={valueText}
            aria-label={`${name}: ${valueText}, type a value`}
            style={entry ? { visibility: 'hidden' } : undefined}
            onClick={() => openEntry(paramEditText(spec, latest.current), true)}
          >
            {modulated && <Icon name="wave" size={10} className={styles.modMark} />}
            <span className={styles.valueText}>{shortText}</span>
          </button>
        ) : (
          <div className={`${styles.value} mono`} title={valueText} aria-hidden="true" style={entry ? { visibility: 'hidden' } : undefined}>
            {modulated && <Icon name="wave" size={10} className={styles.modMark} />}
            {controlledBy ? (
              <span className={styles.badge}>
                <Icon name="link" size={10} />
                <span className={styles.valueText}>{controlledBy}</span>
              </span>
            ) : (
              <span className={styles.valueText}>{shortText}</span>
            )}
          </div>
        ))}
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
