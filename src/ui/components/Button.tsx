/**
 * Buttons: hardware-style keys.
 *
 * - `variant`: primary (graphite key), secondary (light key), ghost (flat),
 *   transport (square key with an indicator LED), danger (coral legend).
 * - `pressed` turns a button into a toggle (aria-pressed): it sits lower and
 *   its LED lights in `tone` — amber = on/playing, teal = selected,
 *   coral = recording/muted. The label or icon should say what is on.
 */
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Icon, type IconName } from './Icon';
import { Tooltip } from './Tooltip';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'transport' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';
export type Tone = 'amber' | 'teal' | 'coral';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Toggle state; renders aria-pressed. Leave undefined for a plain button. */
  pressed?: boolean;
  /**
   * Light the key (it sits lower, its icon in `tone`) without making it a
   * toggle: for a key whose label already says the state, such as Play / Pause.
   */
  lit?: boolean;
  /** LED colour when pressed (default: amber; coral for danger). */
  tone?: Tone;
  icon?: IconName;
  iconRight?: IconName;
  /** Stretch to the container width. */
  block?: boolean;
  type?: 'button' | 'submit' | 'reset';
  /** Tooltip: plain-language tip and technical detail (shown when Tips are on). */
  tip?: string;
  detail?: string;
  ref?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}

const ICON_SIZE: Record<ButtonSize, number> = { sm: 14, md: 16, lg: 18 };

export function Button({
  variant = 'secondary',
  size = 'md',
  pressed,
  lit,
  tone,
  icon,
  iconRight,
  block,
  type = 'button',
  tip,
  detail,
  className,
  children,
  ref,
  ...rest
}: ButtonProps) {
  const toggle = pressed !== undefined;
  const on = toggle ? pressed : lit;
  const led = tone ?? (variant === 'danger' ? 'coral' : 'amber');
  const btn = (
    <button
      ref={ref}
      type={type}
      className={[styles.button, className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-size={size}
      data-tone={led}
      data-block={block || undefined}
      data-on={on || undefined}
      aria-pressed={toggle ? pressed : undefined}
      {...rest}
    >
      {toggle && variant !== 'ghost' && <span className={styles.led} aria-hidden="true" />}
      {icon && <Icon name={icon} size={ICON_SIZE[size]} className={styles.icon} />}
      {children !== undefined && children !== null && <span className={styles.text}>{children}</span>}
      {iconRight && <Icon name={iconRight} size={ICON_SIZE[size]} className={styles.icon} />}
    </button>
  );
  if (!tip && !detail) return btn;
  return (
    <Tooltip tip={tip} detail={detail}>
      {btn}
    </Tooltip>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'iconRight' | 'aria-label'> {
  icon: IconName;
  /** Accessible name, also shown as the tooltip name. */
  label: string;
}

/** A square button showing only an icon; its name appears as a tooltip. */
export function IconButton({ icon, label, variant = 'ghost', size = 'md', pressed, tone, tip, detail, className, ref, ...rest }: IconButtonProps) {
  const toggle = pressed !== undefined;
  const led = tone ?? (variant === 'danger' ? 'coral' : 'amber');
  return (
    <Tooltip name={label} tip={tip} detail={detail}>
      <button
        ref={ref}
        type="button"
        className={[styles.button, styles.iconOnly, className].filter(Boolean).join(' ')}
        data-variant={variant}
        data-size={size}
        data-tone={led}
        data-on={pressed || undefined}
        aria-pressed={toggle ? pressed : undefined}
        aria-label={label}
        {...rest}
      >
        <Icon name={icon} size={ICON_SIZE[size]} className={styles.icon} />
      </button>
    </Tooltip>
  );
}
