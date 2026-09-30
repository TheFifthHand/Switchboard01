/**
 * Led — a small indicator lamp with a text legend (colour is never the only
 * cue: the legend says what the lamp means, e.g. "Saved", "Rec", "Assist").
 */
import styles from './Led.module.css';

export interface LedProps {
  on: boolean;
  label: string;
  /** Lamp colour when on. 'neutral' is a graphite lamp for plain status. */
  tone?: 'amber' | 'teal' | 'coral' | 'neutral';
  /** Hide the legend visually (keep it for screen readers) when text is adjacent. */
  hideLabel?: boolean;
  /** Slow blink while on (e.g. waiting / armed). */
  blink?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  id?: string;
}

export function Led({ on, label, tone = 'amber', hideLabel = false, blink = false, size = 'md', className, id }: LedProps) {
  return (
    <span
      id={id}
      className={[styles.led, className].filter(Boolean).join(' ')}
      data-on={on || undefined}
      data-tone={tone}
      data-blink={(on && blink) || undefined}
      data-size={size}
    >
      <span className={styles.lamp} aria-hidden="true" />
      <span className={hideLabel ? 'visually-hidden' : styles.text}>{label}</span>
    </span>
  );
}
