/**
 * SegmentedControl — a row of hardware selector keys where exactly one is
 * engaged (raised, with a lit teal lamp: teal = selection).
 *
 * kind='tabs'  -> role=tablist / tab (views like Play / Shape / Arrange;
 *                 pass `controls` with the panel id).
 * kind='radio' -> role=radiogroup / radio (modes like Loops / Drums / Notes / Steps).
 *
 * Keyboard: roving focus, Arrow keys move and select (selection follows
 * focus), Home/End jump to the ends.
 */
import { useId, useRef, type KeyboardEvent } from 'react';
import { Icon, type IconName } from './Icon';
import { Tooltip } from './Tooltip';
import styles from './SegmentedControl.module.css';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /** Tooltip tip text. */
  tip?: string;
  /** Small key hint, e.g. a shortcut. */
  keyHint?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentOption<T>[];
  value: NoInfer<T>;
  onChange(value: NoInfer<T>): void;
  /** Accessible name of the group. */
  label: string;
  kind?: 'tabs' | 'radio';
  /** Tabs: id of the panel the tabs control (or a function per value). */
  controls?: string | ((value: T) => string);
  size?: 'sm' | 'md' | 'lg';
  /** Stretch segments to fill the width. */
  block?: boolean;
  /** Show the teal lamp on each key (default). Without it the engaged key is still raised and bold. */
  lamp?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  kind = 'radio',
  controls,
  size = 'md',
  block = false,
  lamp = true,
  disabled = false,
  id,
  className,
}: SegmentedControlProps<T>) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabs = kind === 'tabs';
  // -1 when the value matches no option: nothing is shown as engaged.
  const selectedIndex = options.findIndex((o) => o.value === value);

  const enabledIndices = options.map((o, i) => (o.disabled || disabled ? -1 : i)).filter((i) => i >= 0);
  // Roving tabindex: the engaged segment, or the first usable one when the
  // engaged segment is disabled or missing, so Tab can always reach the group.
  const tabStop = enabledIndices.includes(selectedIndex) ? selectedIndex : (enabledIndices[0] ?? -1);

  const move = (from: number, dir: 1 | -1 | 'first' | 'last') => {
    if (enabledIndices.length === 0) return;
    let target: number;
    if (dir === 'first') target = enabledIndices[0];
    else if (dir === 'last') target = enabledIndices[enabledIndices.length - 1];
    else {
      const pos = enabledIndices.indexOf(from);
      const start = pos < 0 ? 0 : pos;
      target = enabledIndices[(start + dir + enabledIndices.length) % enabledIndices.length];
    }
    refs.current[target]?.focus();
    if (options[target].value !== value) onChange(options[target].value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        move(index, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        move(index, -1);
        break;
      case 'Home':
        move(index, 'first');
        break;
      case 'End':
        move(index, 'last');
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div
      id={id}
      role={tabs ? 'tablist' : 'radiogroup'}
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={[styles.group, className].filter(Boolean).join(' ')}
      data-size={size}
      data-block={block || undefined}
      data-lamp={lamp ? undefined : 'off'}
    >
      {options.map((o, i) => {
        const selected = i === selectedIndex;
        const segDisabled = disabled || o.disabled;
        const controlsId = tabs && controls ? (typeof controls === 'function' ? controls(o.value) : controls) : undefined;
        const btn = (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            id={`${base}-${i}`}
            role={tabs ? 'tab' : 'radio'}
            aria-selected={tabs ? selected : undefined}
            aria-checked={tabs ? undefined : selected}
            aria-controls={controlsId}
            tabIndex={i === tabStop ? 0 : -1}
            disabled={segDisabled}
            className={styles.segment}
            data-selected={selected || undefined}
            onClick={() => !selected && onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {lamp && <span className={styles.lamp} aria-hidden="true" />}
            {o.icon && <Icon name={o.icon} size={size === 'sm' ? 14 : size === 'lg' ? 18 : 16} />}
            <span className={styles.text}>{o.label}</span>
            {o.keyHint && (
              <span className={styles.key} aria-hidden="true">
                {o.keyHint}
              </span>
            )}
          </button>
        );
        return o.tip ? (
          <Tooltip key={o.value} tip={o.tip}>
            {btn}
          </Tooltip>
        ) : (
          btn
        );
      })}
    </div>
  );
}
