/**
 * A sheet (Simple, round 7): another 2.4 view (Jam pads, Mixer, Every
 * setting) opened from the Song screen, under a slim bar that says how to
 * get back: "← Back to my song" (Esc does the same). The view itself is the
 * 2.4 component, unchanged; the shell renders it here in place of the home.
 *
 * Esc goes back only when nothing else wanted it: not while typing, not with
 * a dialog, menu or list open, and not when the view used the key itself.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '../../../ui/components';
import { isTypingTarget } from '../../../ui/hooks/useComputerKeyboard';
import type { View } from '../../../state/uiStore';
import styles from './Sheet.module.css';

/** What each sheet is called in Simple (the home, 'arrange', is never a sheet). */
export const SHEET_TITLES: Record<Exclude<View, 'arrange'>, string> = {
  play: 'Jam pads',
  mix: 'Mixer',
  shape: 'Every setting',
};

/** One line under the title: what the sheet is for, in plain words. */
const SHEET_LINES: Record<Exclude<View, 'arrange'>, string> = {
  play: 'Play loops live on pads. Your song stays as it is.',
  mix: 'Every instrument’s level, side to side and effects.',
  shape: 'Every setting of the selected instrument’s sound.',
};

/** Something open over the page that owns Esc (a dialog, a menu, a list, a popover). */
function somethingOpen(): boolean {
  return !!document.querySelector('[aria-modal="true"], [role="menu"], [role="listbox"], [role="dialog"]');
}

export function Sheet(props: { view: Exclude<View, 'arrange'>; onBack(): void; children: ReactNode }) {
  const { view, onBack } = props;
  const backRef = useRef<HTMLButtonElement>(null);
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });
  // Keyboard focus starts on the way back, so Tab goes on into the sheet and Enter returns.
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, [view]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target) || somethingOpen()) return;
      e.preventDefault();
      onBackRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const title = SHEET_TITLES[view];
  return (
    <div className={styles.sheet} data-sheet={view}>
      <div className={styles.bar} role="navigation" aria-label={`${title}: back to my song`}>
        <Button ref={backRef} variant="secondary" size="sm" icon="chevronLeft" onClick={onBack} aria-keyshortcuts="Escape" tip="Back to the song screen (Esc)." className={styles.back}>
          Back to my song
        </Button>
        <h2 className={styles.title}>{title}</h2>
        <p className={styles.line}>{SHEET_LINES[view]}</p>
        <span className={styles.esc} aria-hidden="true">
          Esc
        </span>
      </div>
      <div className={styles.body}>{props.children}</div>
    </div>
  );
}
