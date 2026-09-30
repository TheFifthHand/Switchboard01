/**
 * The first screen: the real instrument behind a small card with Jump In.
 * Jump In is the user gesture that enables browser audio. "Other starters &
 * projects" opens the project library on its Starters tab.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/components';
import { session, useProject } from '../instance';
import styles from './Welcome.module.css';

export interface WelcomeProps {
  lastProject: { id: string; name: string } | null;
  storageError: string | null;
  onClose(): void;
  /** Open the project library (Starters tab). */
  onBrowse(): void;
  /** Jump In finished loading its starter (after onClose). */
  onJumpedIn?(): void;
}

export function Welcome({ lastProject, storageError, onClose, onBrowse, onJumpedIn }: WelcomeProps) {
  const jumpRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  // The reopened project may have been renamed in the library meanwhile.
  const lastName = useProject((p) => (lastProject && p.id === lastProject.id ? p.name : null)) ?? lastProject?.name;
  useEffect(() => {
    jumpRef.current?.focus();
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
          <span id="welcome-title" className={styles.name}>
            SWITCHBOARD
          </span>
          <span className={`${styles.num} mono`}>/ 01</span>
        </div>
        <p id="welcome-desc" className={styles.tagline}>
          Start with a beat. Make it yours.
        </p>
        <Button ref={jumpRef} variant="primary" size="lg" icon="play" onClick={jumpIn} disabled={busy} className={styles.jump} aria-describedby="welcome-sound">
          {busy ? 'Starting…' : 'Jump In'}
        </Button>
        <p id="welcome-sound" className={styles.soundNote}>
          A starter groove plays right away. Turn your volume to a comfortable level.
        </p>
        {lastProject && (
          <Button variant="secondary" onClick={continueLast} className={styles.secondary}>
            Continue “{lastName}”
          </Button>
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
