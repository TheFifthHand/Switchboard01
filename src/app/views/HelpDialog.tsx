/**
 * Help (⋯ → Help…, or the ? key): every keyboard shortcut (generated from
 * the one table in hints/shortcuts.ts), the guide's three walkthroughs as
 * short steps with "Show the quick guide again" and "Show hints again", and
 * About: the version (from package.json, through a Vite define) and what is
 * new in it.
 */
import { useId, useState } from 'react';
import { Button, Dialog, SegmentedControl } from '../../ui/components';
import { SHORTCUT_GROUPS, isMac, showKeys } from './hints/shortcuts';
import { WALKTHROUGHS, WHATS_NEW } from './hints/guides';
import styles from './HelpDialog.module.css';

declare const __APP_VERSION__: string | undefined;

/** This build's version (package.json), or "development" when run without the build's define (tests). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : 'development';

export type HelpTab = 'shortcuts' | 'guides' | 'about';

const TABS = [
  { value: 'shortcuts', label: 'Shortcuts', tip: 'Every keyboard shortcut, by where it works.' },
  { value: 'guides', label: 'Guides', tip: 'Three short walkthroughs, and the quick guide and hints again.' },
  { value: 'about', label: 'About', tip: 'The version, and what is new in it.' },
] as const;

export interface HelpDialogProps {
  open: boolean;
  onClose(): void;
  /** Tab shown when it opens (default: Shortcuts). */
  initialTab?: HelpTab;
  onShowGuide(): void;
  onShowHints(): void;
}

export function HelpDialog(props: HelpDialogProps) {
  if (!props.open) return null;
  return <HelpBody {...props} />;
}

function HelpBody({ onClose, initialTab = 'shortcuts', onShowGuide, onShowHints }: HelpDialogProps) {
  const [tab, setTab] = useState<HelpTab>(initialTab);
  const panelId = useId();
  const mac = isMac();
  return (
    <Dialog
      open
      onClose={onClose}
      title="Help"
      size="lg"
      className={styles.dialog}
      actions={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className={styles.tabs}>
        <SegmentedControl<HelpTab> label="Help sections" kind="tabs" options={TABS} value={tab} onChange={(v) => setTab(v)} controls={panelId} size="sm" />
      </div>
      <div id={panelId} role="tabpanel" aria-label={TABS.find((t) => t.value === tab)?.label} className={styles.panel} tabIndex={0}>
        {tab === 'shortcuts' && (
          <div className={styles.groups}>
            {SHORTCUT_GROUPS.map((g) => (
              <section key={g.id} className={styles.group} aria-labelledby={`${panelId}-${g.id}`}>
                <h3 id={`${panelId}-${g.id}`} className={styles.groupTitle}>
                  {g.title}
                </h3>
                {g.where && <p className={styles.where}>{g.where}</p>}
                <dl className={styles.list}>
                  {g.items.map((s) => (
                    <div key={s.id} className={styles.row} data-shortcut={s.id}>
                      <dt className={styles.keys}>
                        {s.keys.map((k, i) => {
                          const shown = showKeys(k, mac);
                          // A row of keys ("A S D F …"): one key cap each, wrapping in the column rather than running into the words beside it.
                          const row = shown.includes(' ') && !shown.includes('+') ? shown.split(' ') : null;
                          return (
                            <span key={k} className={styles.alt}>
                              {i > 0 && <span className={styles.or}> or </span>}
                              {row ? (
                                <kbd className={styles.seq}>
                                  {row.map((key, j) => (
                                    <kbd key={j} className={styles.kbd}>
                                      {key}
                                    </kbd>
                                  ))}
                                </kbd>
                              ) : (
                                <kbd className={styles.kbd}>{shown}</kbd>
                              )}
                            </span>
                          );
                        })}
                      </dt>
                      <dd className={styles.does}>{s.does}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        )}
        {tab === 'guides' && (
          <div className={styles.guides}>
            <div className={styles.again}>
              <Button size="sm" variant="secondary" icon="sparkle" onClick={onShowGuide} tip="Three quick pointers: Play and Pause, the pads with Mute, and Change instrument with the big knobs.">
                Show the quick guide again
              </Button>
              <Button size="sm" variant="secondary" icon="info" onClick={onShowHints} tip="Small “Try this” suggestions, one at a time, from the first one. They turn Tips on.">
                Show hints again
              </Button>
            </div>
            {WALKTHROUGHS.map((w) => (
              <section key={w.id} className={styles.walk} aria-labelledby={`${panelId}-${w.id}`}>
                <h3 id={`${panelId}-${w.id}`} className={styles.groupTitle}>
                  {w.title} <span className={styles.time}>({w.time})</span>
                </h3>
                <ol className={styles.steps}>
                  {w.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
        {tab === 'about' && <About />}
      </div>
    </Dialog>
  );
}

function About() {
  const notes = WHATS_NEW.find((n) => n.version === APP_VERSION) ?? WHATS_NEW[0];
  return (
    <div className={styles.about}>
      <p className={styles.name}>
        Omni Song <span className={styles.version} data-testid="app-version">version {APP_VERSION}</span>
      </p>
      <p className={styles.where}>Everything runs on this device: no account, no uploads. Your projects are kept in this browser; export a project file as a backup.</p>
      {notes && (
        <section className={styles.news} aria-labelledby="help-whats-new">
          <h3 id="help-whats-new" className={styles.groupTitle}>
            What’s new in {notes.version}
          </h3>
          <ul className={styles.steps}>
            {notes.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
