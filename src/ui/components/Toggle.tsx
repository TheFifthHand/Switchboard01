/**
 * Switch — a labelled, physical-looking slide switch with ON/OFF legends.
 * The whole row (label, switch, legend) is one role="switch" button, so it
 * is a generous click target and reads as "Metronome, switch, on".
 */
import { useId } from 'react';
import { Tooltip } from './Tooltip';
import styles from './Toggle.module.css';

export interface SwitchProps {
  checked: boolean;
  onChange(checked: boolean): void;
  label: string;
  /** Hide the visible label (it stays the accessible name). */
  hideLabel?: boolean;
  onText?: string;
  offText?: string;
  /** Lamp colour when on (default amber). */
  tone?: 'amber' | 'teal' | 'coral';
  size?: 'sm' | 'md';
  disabled?: boolean;
  tip?: string;
  detail?: string;
  id?: string;
  className?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  hideLabel = false,
  onText = 'On',
  offText = 'Off',
  tone = 'amber',
  size = 'md',
  disabled = false,
  tip,
  detail,
  id,
  className,
}: SwitchProps) {
  const labelId = useId();
  const btn = (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-labelledby={labelId}
      disabled={disabled}
      className={[styles.switch, className].filter(Boolean).join(' ')}
      data-on={checked || undefined}
      data-tone={tone}
      data-size={size}
      onClick={() => onChange(!checked)}
    >
      <span id={labelId} className={hideLabel ? 'visually-hidden' : styles.label}>
        {label}
      </span>
      <span className={styles.slot} aria-hidden="true">
        <span className={styles.lever} />
      </span>
      <span className={styles.state} aria-hidden="true">
        <span className={styles.lamp} />
        {checked ? onText : offText}
      </span>
    </button>
  );
  if (!tip && !detail) return btn;
  return (
    <Tooltip tip={tip} detail={detail}>
      {btn}
    </Tooltip>
  );
}

/** Alias: the product brief calls these "labeled switches". */
export const Toggle = Switch;
export type ToggleProps = SwitchProps;
