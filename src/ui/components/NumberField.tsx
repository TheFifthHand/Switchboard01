/**
 * NumberField — precise numeric entry (e.g. tempo).
 *
 * - Type a value and press Enter (or leave the field); units may be typed
 *   ("124 bpm"). Invalid text reverts. Escape reverts.
 * - `blurOnCommit` (fields in the instrument's own bar, e.g. Tempo): Enter
 *   commits and gives the keys back (the field loses focus, so Space plays
 *   and letters play notes again); a single Escape reverts and leaves too.
 * - Drag vertically on the field to change it (Shift = fine); a click
 *   without movement starts typing.
 * - Arrow Up/Down step (Shift = fine), PageUp/PageDown step x10.
 * - Values are clamped to [min, max] and rounded to the fine step; a drag
 *   moves in whole `dragStep`s when one is given (Shift: the fine step).
 * Gestures follow the Knob contract: one id per drag / key burst, the last
 * call has final: true.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Tooltip } from './Tooltip';
import { newGestureId, parsePlainNumber } from './valueInput';
import styles from './NumberField.module.css';

export interface NumberFieldChangeInfo {
  gesture: string;
  final: boolean;
}

export interface NumberFieldProps {
  label: string;
  hideLabel?: boolean;
  layout?: 'stacked' | 'inline';
  value: number;
  onChange(value: number, info: NumberFieldChangeInfo): void;
  min: number;
  max: number;
  /** Arrow-key / drag step (default 1). */
  step?: number;
  /** Shift step and rounding resolution (default step / 10). */
  fineStep?: number;
  /** PageUp/PageDown step (default step x 10). */
  pageStep?: number;
  /** Unit suffix shown after the number, e.g. "BPM". */
  unit?: string;
  /** Display formatting (default: trimmed to the fine step's decimals). */
  format?(value: number): string;
  /** Drag distance for one step (default 4 px). */
  dragPixelsPerStep?: number;
  /** A drag lands on whole multiples of this (e.g. 1 for whole BPM); Shift drags in the fine step. */
  dragStep?: number;
  /** Enter commits and leaves the field; one Escape reverts and leaves (fields in the transport). */
  blurOnCommit?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** Width of the number in characters (default 5). */
  chars?: number;
  disabled?: boolean;
  tip?: string;
  detail?: string;
  id?: string;
  className?: string;
}

const BURST_IDLE_MS = 700;
const DRAG_THRESHOLD_PX = 3;

function decimalsOf(n: number): number {
  if (!Number.isFinite(n) || Math.floor(n) === n) return 0;
  const s = n.toString();
  const e = s.indexOf('e-');
  if (e >= 0) return Number(s.slice(e + 2));
  return s.split('.')[1]?.length ?? 0;
}

export function NumberField({
  label,
  hideLabel = false,
  layout = 'stacked',
  value,
  onChange,
  min,
  max,
  step = 1,
  fineStep,
  pageStep,
  unit,
  format,
  dragPixelsPerStep = 4,
  dragStep,
  blurOnCommit = false,
  size = 'md',
  chars = 5,
  disabled = false,
  tip,
  detail,
  id,
  className,
}: NumberFieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const fine = fineStep ?? step / 10;
  const page = pageStep ?? step * 10;
  const dec = Math.min(6, decimalsOf(fine));

  const quantize = useCallback(
    (v: number) => {
      const c = Math.min(max, Math.max(min, v));
      const q = Math.round(c / fine) * fine;
      return Number(Math.min(max, Math.max(min, q)).toFixed(dec));
    },
    [min, max, fine, dec],
  );
  const fmt = useCallback((v: number) => (format ? format(v) : String(Number(v.toFixed(dec)))), [format, dec]);

  const [draft, setDraft] = useState<string | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const shown = live ?? value;

  const inputRef = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  const latest = useRef(shown);
  const burst = useRef<{ gesture: string; timer: number; last: number } | null>(null);
  const drag = useRef<{ pointerId: number; startY: number; lastY: number; acc: number; moved: boolean; gesture: string; pending: number | null; emitted: number | null; raf: number } | null>(null);
  const escaping = useRef(false);

  useLayoutEffect(() => {
    onChangeRef.current = onChange;
    if (!drag.current && !burst.current) latest.current = shown;
  });

  const finishBurst = useCallback(() => {
    const b = burst.current;
    if (!b) return;
    burst.current = null;
    window.clearTimeout(b.timer);
    setLive(null);
    onChangeRef.current(b.last, { gesture: b.gesture, final: true });
  }, []);

  const burstChange = (v: number) => {
    if (v === latest.current) return;
    let b = burst.current;
    if (!b) {
      b = { gesture: newGestureId('number-key'), timer: 0, last: v };
      burst.current = b;
    }
    window.clearTimeout(b.timer);
    b.last = v;
    latest.current = v;
    setLive(v);
    if (draft !== null) setDraft(fmt(v));
    onChangeRef.current(v, { gesture: b.gesture, final: false });
    b.timer = window.setTimeout(finishBurst, BURST_IDLE_MS);
  };

  const endDrag = useCallback((pointerId?: number) => {
    const d = drag.current;
    if (!d || (pointerId !== undefined && pointerId !== d.pointerId)) return null;
    drag.current = null;
    if (d.raf) cancelAnimationFrame(d.raf);
    const el = inputRef.current;
    try {
      if (el?.hasPointerCapture(d.pointerId)) el.releasePointerCapture(d.pointerId);
    } catch {
      /* already released */
    }
    setDragging(false);
    setLive(null);
    const v = d.pending ?? d.emitted;
    if (v !== null) onChangeRef.current(v, { gesture: d.gesture, final: true });
    return d;
  }, []);

  useEffect(
    () => () => {
      endDrag();
      finishBurst();
    },
    [endDrag, finishBurst],
  );

  const commitDraft = (): boolean => {
    if (draft === null) return true;
    const parsed = parsePlainNumber(draft, unit);
    if (parsed === null) {
      setInvalid(true);
      setDraft(fmt(latest.current));
      return false;
    }
    setInvalid(false);
    const v = quantize(parsed);
    setDraft(fmt(v));
    if (v !== latest.current) {
      latest.current = v;
      onChangeRef.current(v, { gesture: newGestureId('number-entry'), final: true });
    }
    return true;
  };

  const onPointerDown = (e: PointerEvent<HTMLInputElement>) => {
    if (disabled || e.button !== 0) return;
    const el = e.currentTarget;
    if (document.activeElement === el) return; // already typing: let the caret move
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    finishBurst();
    drag.current = { pointerId: e.pointerId, startY: e.clientY, lastY: e.clientY, acc: latest.current, moved: false, gesture: newGestureId('number-drag'), pending: null, emitted: null, raf: 0 };
  };

  const onPointerMove = (e: PointerEvent<HTMLInputElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.moved) {
      if (Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD_PX) return;
      d.moved = true;
      d.lastY = e.clientY;
      setDragging(true);
      return;
    }
    const dy = d.lastY - e.clientY;
    d.lastY = e.clientY;
    d.acc = Math.min(max, Math.max(min, d.acc + (dy / dragPixelsPerStep) * (e.shiftKey ? fine : step)));
    const v = dragStep && !e.shiftKey ? quantize(Math.round(d.acc / dragStep) * dragStep) : quantize(d.acc);
    if (v === (d.pending ?? d.emitted ?? latest.current)) return;
    d.pending = v;
    if (!d.raf)
      d.raf = requestAnimationFrame(() => {
        const cur = drag.current;
        if (!cur) return;
        cur.raf = 0;
        if (cur.pending === null) return;
        cur.emitted = cur.pending;
        cur.pending = null;
        latest.current = cur.emitted;
        setLive(cur.emitted);
        onChangeRef.current(cur.emitted, { gesture: cur.gesture, final: false });
      });
  };

  const onPointerUp = (e: PointerEvent<HTMLInputElement>) => {
    const d = endDrag(e.pointerId);
    if (d && !d.moved) {
      // A click without movement: start typing.
      const el = inputRef.current;
      el?.focus();
      el?.select();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    const cur = draft !== null && parsePlainNumber(draft, unit) !== null && burst.current === null ? quantize(parsePlainNumber(draft, unit) as number) : latest.current;
    switch (e.key) {
      case 'ArrowUp':
        burstChange(quantize(cur + (e.shiftKey ? fine : step)));
        break;
      case 'ArrowDown':
        burstChange(quantize(cur - (e.shiftKey ? fine : step)));
        break;
      case 'PageUp':
        burstChange(quantize(cur + page));
        break;
      case 'PageDown':
        burstChange(quantize(cur - page));
        break;
      case 'Enter':
        finishBurst();
        if (commitDraft()) {
          if (blurOnCommit) {
            // Committed: hand the keys back to the instrument.
            escaping.current = true;
            e.currentTarget.blur();
            escaping.current = false;
          } else e.currentTarget.select();
        }
        break;
      case 'Escape': {
        finishBurst();
        const changed = draft !== null && draft !== fmt(latest.current);
        if (changed) {
          setDraft(fmt(latest.current));
          setInvalid(false);
          e.stopPropagation(); // the Escape that reverts is used up (a second one may close a dialog)
        }
        if (!changed || blurOnCommit) {
          escaping.current = true;
          e.currentTarget.blur();
          escaping.current = false;
        }
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  const text = draft ?? fmt(shown);

  const input = (
    <input
      ref={inputRef}
      id={inputId}
      className={styles.input}
      type="text"
      inputMode="decimal"
      role="spinbutton"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-valuetext={unit ? `${fmt(shown)} ${unit}` : fmt(shown)}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      spellCheck={false}
      autoComplete="off"
      value={text}
      style={{ width: `${chars + 0.6}ch` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={(e) => endDrag(e.pointerId)}
      onLostPointerCapture={(e) => endDrag(e.pointerId)}
      onFocus={(e) => {
        setDraft(fmt(latest.current));
        setInvalid(false);
        e.currentTarget.select();
      }}
      onBlur={() => {
        finishBurst();
        if (!escaping.current) commitDraft();
        setDraft(null);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        setInvalid(false);
      }}
      onKeyDown={onKeyDown}
    />
  );

  return (
    <div className={[styles.wrap, className].filter(Boolean).join(' ')} data-layout={layout} data-size={size} data-disabled={disabled || undefined}>
      <label htmlFor={inputId} className={hideLabel ? 'visually-hidden' : styles.label}>
        {label}
      </label>
      <span className={styles.field} data-dragging={dragging || undefined} data-invalid={invalid || undefined}>
        {tip || detail ? (
          <Tooltip tip={tip} detail={detail}>
            {input}
          </Tooltip>
        ) : (
          input
        )}
        {unit && (
          <span className={styles.unit} aria-hidden="true">
            {unit}
          </span>
        )}
      </span>
    </div>
  );
}
