/**
 * Panel — a console section with a printed, fine-line header legend
 * ("SOUND ───────────"), optional header actions and a working surface.
 */
import { useId, type ReactNode } from 'react';
import styles from './Panel.module.css';

export interface PanelProps {
  title: string;
  /** Extra header content after the title (e.g. the selected part name). */
  subtitle?: ReactNode;
  /** Controls on the right side of the header. */
  actions?: ReactNode;
  children?: ReactNode;
  /** 'surface' = cool working surface (default), 'shell' = warm shell, 'inset' = recessed tray. */
  surface?: 'surface' | 'shell' | 'inset';
  /** Tighter padding for dense sections. */
  dense?: boolean;
  id?: string;
  className?: string;
  bodyClassName?: string;
}

export function Panel({ title, subtitle, actions, children, surface = 'surface', dense = false, id, className, bodyClassName }: PanelProps) {
  const titleId = useId();
  return (
    <section id={id} className={[styles.panel, className].filter(Boolean).join(' ')} data-surface={surface} data-dense={dense || undefined} aria-labelledby={titleId}>
      <header className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {subtitle !== undefined && <span className={styles.subtitle}>{subtitle}</span>}
        <span className={styles.rule} aria-hidden="true" />
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      <div className={[styles.body, bodyClassName].filter(Boolean).join(' ')}>{children}</div>
    </section>
  );
}
