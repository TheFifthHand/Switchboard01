/**
 * The first screen: the real instrument behind a small card.
 *
 * - First visit: **Jump In** (focused) is the user gesture that enables
 *   browser audio and starts a starter groove.
 * - Coming back (a stored project was reopened): **Continue “<name>”** is the
 *   main, focused key; **Start a new groove** is the secondary one (the
 *   earlier project stays in My projects, and the shell says so).
 * - "Other starters & projects" opens the project library on its Starters
 *   tab; "Just look around" (also Esc) closes the card.
 * - The card is modal: Tab and Shift+Tab stay on it.
 *
 * Someone coming back from SWITCHBOARD / 01 (the app's name before 2.0) is
 * told once, on this card, that it is now Omni Song and their projects are
 * still here.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
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

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface WelcomeProps {
  lastProject: { id: string; name: string } | null;
  /** What happened on reopen (a damaged project skipped, repairs made on load). */
  warnings?: readonly string[];
  storageError: string | null;
  /** Close the card (after Jump In or Continue). */
  onClose(): void;
  /** "Just look around" (or Esc): close the card without starting anything. Default: onClose. */
  onLookAround?(): void;
  /** Continue was pressed (after onClose). */
  onContinued?(): void;
  /** Open the project library (Starters tab). */
  onBrowse(): void;
  /** Jump In (or Start a new groove) finished loading its starter (after onClose). */
  onJumpedIn?(): void;
}

export function Welcome({ lastProject, warnings = [], storageError, onClose, onLookAround, onContinued, onBrowse, onJumpedIn }: WelcomeProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  // Continue resumes the loaded project; the library may have renamed or switched it meanwhile.
  const openName = useProject((p) => p.name);
  const returning = lastProject !== null;
  // Returning users (a stored project from before) learn about the new name once.
  const [renamed] = useState(() => returning && !readFlag(RENAME_NOTE_KEY));
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);
  // Noted on every first screen, so only people who used the app before 2.0 ever see the line.
  useEffect(() => {
    writeFlag(RENAME_NOTE_KEY);
  }, []);

  const lookAround = onLookAround ?? onClose;
  const onCloseRef = useRef(lookAround);
  useEffect(() => {
    onCloseRef.current = lookAround;
  });
  // Esc acts as "Just look around" (unless a dialog opened over the card, such as the library, used it).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.repeat) return;
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (modals.length && modals[modals.length - 1] !== cardRef.current?.parentElement) return;
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
    onContinued?.();
  };

  /** Tab and Shift+Tab go round the card's own controls. */
  const trapTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const items = Array.from(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.getClientRects().length > 0);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = !!active && !!cardRef.current?.contains(active);
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-labelledby="welcome-title" aria-describedby="welcome-desc" onKeyDown={trapTab}>
      <div ref={cardRef} className={styles.card}>
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
        {returning ? (
          <>
            <Button ref={primaryRef} variant="primary" size="lg" onClick={continueLast} disabled={busy} className={styles.jump} aria-describedby="welcome-continue">
              Continue “{openName}”
            </Button>
            <p id="welcome-continue" className={styles.soundNote}>
              Your song, as you left it.
            </p>
            <Button variant="secondary" onClick={jumpIn} disabled={busy} className={styles.secondary} aria-describedby="welcome-sound">
              {busy ? 'Starting…' : 'Start a new groove'}
            </Button>
            <p id="welcome-sound" className={styles.soundNote}>
              A new starter groove plays right away; “{openName}” stays in My projects.
            </p>
          </>
        ) : (
          <>
            <Button ref={primaryRef} variant="primary" size="lg" icon="play" onClick={jumpIn} disabled={busy} className={styles.jump} aria-describedby="welcome-sound">
              {busy ? 'Starting…' : 'Jump In'}
            </Button>
            <p id="welcome-sound" className={styles.soundNote}>
              A starter groove plays right away. Turn your volume to a comfortable level.
            </p>
          </>
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
          <button type="button" className={styles.link} onClick={lookAround} aria-keyshortcuts="Escape">
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
