/**
 * The first screen: the real instrument behind a small card with Jump In.
 * Jump In is the user gesture that enables browser audio. "Other starters &
 * projects" opens the project library on its Starters tab.
 *
 * Someone coming back from SWITCHBOARD / 01 (the app's name before 2.0) is
 * told once, on this card, that it is now Omni Song and their projects are
 * still here.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/components';
import { session, useProject } from '../instance';
import styles from './Welcome.module.css';

/** Remembered (localStorage) once the "now called Omni Song" line has been shown. */
export const RENAME_NOTE_KEY = 'omnisong.renameNoted';

function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    globalThis.localStorage?.setItem(key, '1');
  } catch {
    // Storage blocked: the line may show again next time, which is harmless.
  }
}

export interface WelcomeProps {
  lastProject: { id: string; name: string } | null;
  /** What happened on reopen (a damaged project skipped, repairs made on load). */
  warnings?: readonly string[];
  storageError: string | null;
  onClose(): void;
  /** Open the project library (Starters tab). */
  onBrowse(): void;
  /** Jump In finished loading its starter (after onClose). */
  onJumpedIn?(): void;
}

export function Welcome({ lastProject, warnings = [], storageError, onClose, onBrowse, onJumpedIn }: WelcomeProps) {
  const jumpRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  // Continue resumes the loaded project; the library may have renamed or switched it meanwhile.
  const openName = useProject((p) => p.name);
  // Returning users (a stored project from before) learn about the new name once.
  const [renamed] = useState(() => lastProject !== null && !readFlag(RENAME_NOTE_KEY));
  useEffect(() => {
    jumpRef.current?.focus();
  }, []);
  // Noted on every first screen, so only people who used the app before 2.0 ever see the line.
  useEffect(() => {
    writeFlag(RENAME_NOTE_KEY);
  }, []);

  const jumpIn = () => {
    if (busy) return;
    setBusy(true);
    // Must run synchronously inside the click so the browser allows audio.
    void session.jumpIn().finally(() => {
      onClose();
      onJumpedIn?.();
    });
  };
  const continueLast = () => {
    void session.continueProject();
    onClose();
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-labelledby="welcome-title" aria-describedby="welcome-desc">
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <h1 id="welcome-title" className={styles.name}>
            Omni Song
          </h1>
        </div>
        <p id="welcome-desc" className={styles.tagline}>
          Start with a beat. Make it yours.
        </p>
        {renamed && (
          <p className={styles.renamed} data-testid="welcome-renamed">
            SWITCHBOARD / 01 is now called Omni Song. Your projects and settings are all still here.
          </p>
        )}
        <Button ref={jumpRef} variant="primary" size="lg" icon="play" onClick={jumpIn} disabled={busy} className={styles.jump} aria-describedby="welcome-sound">
          {busy ? 'Starting…' : 'Jump In'}
        </Button>
        <p id="welcome-sound" className={styles.soundNote}>
          A starter groove plays right away. Turn your volume to a comfortable level.
        </p>
        {lastProject && (
          <Button variant="secondary" onClick={continueLast} className={styles.secondary}>
            Continue “{openName}”
          </Button>
        )}
        {warnings.length > 0 && (
          <div className={styles.warn} role="status">
            {warnings.map((w, i) => (
              <p key={i} className={styles.warnLine}>
                {w}
              </p>
            ))}
          </div>
        )}
        <div className={styles.links}>
          <button type="button" className={styles.link} onClick={onBrowse} aria-haspopup="dialog">
            Other starters & projects
          </button>
          <span aria-hidden>·</span>
          <button type="button" className={styles.link} onClick={onClose}>
            Just look around
          </button>
        </div>
        {storageError && (
          <p className={styles.warn} role="status">
            Saving is unavailable in this browser window ({storageError}). You can still play and export audio and project files.
          </p>
        )}
        <p className={styles.fine}>Everything runs on this device. No account, no uploads.</p>
      </div>
    </div>
  );
}
