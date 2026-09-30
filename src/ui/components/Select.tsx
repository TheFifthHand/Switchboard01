/**
 * Select — a styled native <select>: full keyboard and screen-reader support
 * for free, with the console's raised-key look and a chevron.
 */
import { useId, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import styles from './Select.module.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Options with the same group are shown under a heading (consecutive). */
  group?: string;
}

export interface SelectProps {
  value: string;
  onChange(value: string): void;
  options: readonly SelectOption[];
  label: string;
  hideLabel?: boolean;
  /** 'stacked' puts the label above, 'inline' to the left. */
  layout?: 'stacked' | 'inline';
  size?: 'sm' | 'md';
  disabled?: boolean;
  tip?: string;
  detail?: string;
  id?: string;
  className?: string;
  /** Minimum width of the field in px. */
  width?: number;
}

export function Select({
  value,
  onChange,
  options,
  label,
  hideLabel = false,
  layout = 'stacked',
  size = 'md',
  disabled = false,
  tip,
  detail,
  id,
  className,
  width,
}: SelectProps) {
  const auto = useId();
  const selectId = id ?? auto;

  const children: ReactNode[] = [];
  let i = 0;
  while (i < options.length) {
    const g = options[i].group;
    if (g === undefined) {
      const o = options[i];
      children.push(
        <option key={`o-${o.value}`} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>,
      );
      i += 1;
      continue;
    }
    const items: SelectOption[] = [];
    while (i < options.length && options[i].group === g) items.push(options[i++]);
    children.push(
      <optgroup key={`g-${g}-${i}`} label={g}>
        {items.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </optgroup>,
    );
  }

  const select = (
    <select id={selectId} className={styles.select} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {children}
    </select>
  );

  return (
    <div className={[styles.wrap, className].filter(Boolean).join(' ')} data-layout={layout} data-size={size} data-disabled={disabled || undefined}>
      <label htmlFor={selectId} className={hideLabel ? 'visually-hidden' : styles.label}>
        {label}
      </label>
      <span className={styles.field} style={width ? { minWidth: width } : undefined}>
        {tip || detail ? (
          <Tooltip tip={tip} detail={detail}>
            {select}
          </Tooltip>
        ) : (
          select
        )}
        <Icon name="chevronDown" size={14} className={styles.chevron} />
      </span>
    </div>
  );
}
