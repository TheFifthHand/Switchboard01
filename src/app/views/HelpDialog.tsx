/**
 * Help (⋯ → Help…, or the ? key). Simple mode: "How Omni Song works" (one
 * screen: the song, its loops, instruments, Make it longer, Share), the few
 * keys the Song screen uses, About, and "Show every control" for experts.
 * Advanced: every keyboard shortcut (generated from
 * the one table in hints/shortcuts.ts), the guide's three walkthroughs as
 * short steps with "Show the quick guide again" and "Show hints again", and
 * About: the version (from package.json, through a Vite define) and what is
 * new in it.
 */
import { useId, useState } from 'react';
import { Button, Dialog, Icon, SegmentedControl, type IconName } from '../../ui/components';
import { setTipsEnabled, setUiMode } from '../../state/uiStore';
import { session, useUi } from '../instance';
import { SHORTCUT_GROUPS, SIMPLE_SHORTCUT_GROUPS, isMac, showKeys } from './hints/shortcuts';
import { WALKTHROUGHS, WHATS_NEW } from './hints/guides';
import styles from './HelpDialog.module.css';

declare const __APP_VERSION__: string | undefined;

/** This build's version (package.json), or "development" when run without the build's define (tests). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : 'development';

export type HelpTab = 'how' | 'shortcuts' | 'guides' | 'about';

/** Simple mode's tabs: how the one screen works, its keys, the version. */
const SIMPLE_TABS = [
  { value: 'how', label: 'How it works', tip: 'Omni Song on one screen, in eight short lines.' },
  { value: 'shortcuts', label: 'Keys', tip: 'The keyboard keys your song screen uses.' },
  { value: 'about', label: 'About', tip: 'The version, and what is new in it.' },
] as const;

/** "How Omni Song works" (Simple): each line names a thing on the screen, with its icon. */
export const HOW_IT_WORKS: readonly { icon: IconName; title: string; text: string }[] = [
  { icon: 'play', title: 'Your song is this screen', text: 'Each row is an instrument; each block on it is a loop that repeats. Press Play (or Space) to hear it all.' },
  { icon: 'pencil', title: 'Click a loop to change it', text: 'It opens under your song. Draw: click squares to add notes. Play: play along on big squares, and record into the loop.' },
  { icon: 'sliders', title: 'Click an instrument’s name for its sound', text: 'Change sound… picks another one; the big knobs make it brighter, roomier, echoing or rougher.' },
  { icon: 'plus', title: '+ Add instrument', text: 'Adds drums, a bass, keys & chords, a melody and more. Each one starts with a loop that fits your song.' },
  { icon: 'layers', title: 'Loops, on the right', text: 'Press ▶ to hear one, then drag it onto an instrument. They are all in your song’s key.' },
  { icon: 'clock', title: 'Make it longer', text: 'Adds an intro, an ending, or another section made from your own music.' },
  { icon: 'record', title: 'Record', text: 'Plays along into your song from where it is. Undo takes back anything you do.' },
  { icon: 'upload', title: 'Share', text: 'Saves a music file to send to anyone, or the project to keep working on another day.' },
];

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
  const simple = useUi((s) => s.uiMode === 'simple');
  // Simple opens on How it works (About when asked for: What's new); Advanced keeps 2.4's tabs.
  const [tab, setTab] = useState<HelpTab>(simple ? (initialTab === 'about' ? 'about' : 'how') : initialTab === 'how' ? 'shortcuts' : initialTab);
  const panelId = useId();
  const mac = isMac();
  const tabs = simple ? SIMPLE_TABS : TABS;
  const groups = simple ? SIMPLE_SHORTCUT_GROUPS : SHORTCUT_GROUPS;
  const showEvery = () => {
    onClose();
    session.brace();
    setUiMode('advanced');
  };
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
        <SegmentedControl<HelpTab> label="Help sections" kind="tabs" options={tabs} value={tab} onChange={(v) => setTab(v)} controls={panelId} size="sm" />
      </div>
      <div id={panelId} role="tabpanel" aria-label={tabs.find((t) => t.value === tab)?.label} className={styles.panel} tabIndex={0}>
        {tab === 'how' && (
          <div className={styles.how} data-testid="help-how">
            <h3 className={styles.groupTitle}>How Omni Song works</h3>
            <ol className={styles.howList}>
              {HOW_IT_WORKS.map((h) => (
                <li key={h.title} className={styles.howItem}>
                  <span className={styles.howIcon} aria-hidden="true">
                    <Icon name={h.icon} size={14} />
                  </span>
                  <span>
                    <strong>{h.title}.</strong> {h.text}
                  </span>
                </li>
              ))}
            </ol>
            <div className={styles.again}>
              <Button size="sm" variant="secondary" icon="info" onClick={() => setTipsEnabled(true)} tip="The line at the bottom of your song that says what to try next.">
                Show tips
              </Button>
              <Button size="sm" variant="secondary" icon="sliders" onClick={showEvery} tip="For experts: every control, with the Play, Shape, Song and Mix tabs. Your music does not change; the same item in ⋯ brings Simple back.">
                Show every control
              </Button>
            </div>
          </div>
        )}
        {tab === 'shortcuts' && (
          <div className={styles.groups}>
            {groups.map((g) => (
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
