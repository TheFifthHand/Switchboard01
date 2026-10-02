/**
 * Application shell (Omni Song): transport strip, the current view, the
 * keyboard strip, dialogs, the quick guide and "Try this" hints, and global
 * keyboard/focus handling.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, TipsProvider, ToastProvider, useToasts } from '../ui/components';
import { DRUM_KEYS, NOTE_KEYS, isTypingTarget } from '../ui/hooks/useComputerKeyboard';
import { setTipsEnabled } from '../state/uiStore';
import { session, useUi } from './instance';
import { notify, setNoticeHistory, useRuntime, type NoticeAction } from './runtime';
import type { BootInfo } from './session';
import { TransportBar } from './views/TransportBar';
import { PlayView } from './views/PlayView';
import { KeyboardStrip } from './views/KeyboardStrip';
import { Welcome } from './views/Welcome';
import { ExportDialog } from './views/ExportDialog';
import { Library, storageMessage, type LibraryTab } from './views/Library';
import { Guide } from './views/Guide';
import { Hints, showHintsAgain, startHints } from './views/hints';
import { uiStore } from '../state/uiStore';
import { ShapeView } from './views/shape/ShapeView';
import { ArrangeView } from './views/arrange/ArrangeView';
import { MixView } from './views/mix/MixView';
import { downloadBlob } from './download';
import styles from './App.module.css';

/** Physical keys the computer keyboard plays notes or drum pads with. */
const NOTE_KEY_CODES: ReadonlySet<string> = new Set([...NOTE_KEYS, ...DRUM_KEYS].map((k) => k.code));

/** The step Undo (or Redo) of the app's project would apply now (its history entry id), or null. */
const historyTop = (action: NoticeAction): number | null => (action === 'undo' ? session.store.undoEntryId() : session.store.redoEntryId());

// Every "… [Undo]" message names the edit that was newest when it was made.
setNoticeHistory(historyTop);

/** Controls that Space presses when a keyboard user reached them (Tab, arrow keys). */
const SPACE_CONTROLS =
  'button, [role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], a, summary';

function focusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * The toast for runtime notices. A message about an edit ("Moved … " [Undo],
 * "Undid: …" [Redo]) is tied to that history step: its button acts only while
 * the step is still the one Undo (or Redo) would apply, and the toast goes away
 * as soon as it is not (Ctrl+Z, another edit, another project).
 */
function Notices() {
  const notice = useRuntime((s) => s.notice);
  const toasts = useToasts();
  /** The step the toast showing now is about, if any. */
  const tied = useRef<{ action: NoticeAction; entry: number } | null>(null);
  useEffect(() => {
    if (!notice) return;
    tied.current = null;
    let action: { label: string; onAction(): void } | undefined;
    if (notice.action) {
      const kind = notice.action;
      const entry = notice.entry ?? historyTop(kind);
      // Only while that step is still there to undo (redo); otherwise the words alone.
      if (entry !== null && historyTop(kind) === entry) {
        tied.current = { action: kind, entry };
        action = {
          label: kind === 'undo' ? 'Undo' : 'Redo',
          onAction: () => {
            if (historyTop(kind) !== entry) return;
            if (kind === 'undo') session.undo();
            else session.redo();
          },
        };
      }
    }
    toasts.show({
      id: 'notice',
      tone: notice.tone === 'error' ? 'error' : notice.tone === 'warn' ? 'warning' : 'info',
      message: notice.text,
      action,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice?.id]);
  useEffect(
    () =>
      session.store.info.subscribe(() => {
        const t = tied.current;
        if (t && historyTop(t.action) !== t.entry) {
          tied.current = null;
          toasts.dismiss('notice');
        }
      }),
    [toasts],
  );
  return null;
}

function AudioBanner() {
  const audio = useRuntime((s) => s.audio);
  const message = useRuntime((s) => s.audioMessage);
  const stalled = useRuntime((s) => s.stalled);
  if (stalled) {
    return (
      <div className={styles.banner} role="alert">
        <span>{stalled}</span>
        <Button size="sm" variant="primary" icon="play" onClick={() => void session.resumeAfterStall()}>
          Resume
        </Button>
      </div>
    );
  }
  if (audio === 'suspended' || audio === 'error') {
    return (
      <div className={styles.banner} role="alert">
        <span>{message ?? 'Audio is paused.'}</span>
        {audio === 'suspended' && (
          <Button size="sm" variant="primary" onClick={() => void session.resumeAudio()}>
            Resume audio
          </Button>
        )}
      </div>
    );
  }
  return null;
}

function Workspace() {
  const view = useUi((s) => s.view);
  switch (view) {
    case 'shape':
      return <ShapeView />;
    case 'arrange':
      return <ArrangeView />;
    case 'mix':
      return <MixView />;
    case 'play':
    default:
      return <PlayView />;
  }
}

export function App({ boot }: { boot: BootInfo }) {
  const [welcome, setWelcome] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSource, setExportSource] = useState<string | undefined>(undefined);
  const tips = useUi((s) => s.tipsEnabled);
  // Project library (transport project button → My projects; Welcome → Starters) and the quick guide.
  const [library, setLibrary] = useState<{ tab: LibraryTab; fromWelcome: boolean } | null>(null);
  const [guide, setGuide] = useState(false);
  // Each replay starts from step 1, even when the guide is still open.
  const [guideRun, setGuideRun] = useState(0);
  // The guide is offered once, after the first Jump In (or first starter picked from Welcome).
  const offerGuide = () => {
    if (!uiStore.getState().guideDone) setGuide(true);
  };
  // Jump In also starts the "Try this" hints (once; they show after the guide).
  const jumpedIn = () => {
    offerGuide();
    startHints();
  };

  // Global shortcuts: Space = Play/Pause, Shift+Space = Stop, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y = undo/redo,
  // M = mute / unmute the selected part.
  useEffect(() => {
    /**
     * M mutes / unmutes the selected part. M plays no note on the computer
     * keyboard, so it means the same everywhere (except while typing). Solo has
     * no letter on purpose: S plays a note, and one key must not do two things.
     * Runs in the capture phase so it can claim the key first.
     */
    const onPartKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return;
      if (e.key.toLowerCase() !== 'm' || NOTE_KEY_CODES.has(e.code)) return;
      if (isTypingTarget(e.target) || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      session.toggleMute(uiStore.getState().selectedTrackId);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      // Ctrl/⌘+A that no view used (the song lane selects its blocks with it): never select the page's text.
      if (mod && !e.altKey && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        return;
      }
      // Shortcuts belong to an open modal dialog while it is showing.
      if (document.querySelector('[aria-modal="true"]')) return;
      if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) session.redo();
        else session.undo();
        return;
      }
      if (mod && !e.altKey && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        session.redo();
        return;
      }
    };
    /**
     * How each element last got focus: true when it showed its focus ring then
     * (Tab, arrow keys, a script right after a key), false when it was clicked.
     * Read as focus arrives: once any key goes down, the browser shows the
     * ring on a clicked control too.
     */
    const viaKeyboard = new WeakMap<Element, boolean>();
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Element) viaKeyboard.set(e.target, focusVisible(e.target));
    };
    // Clicking the control that already has focus makes it a clicked control.
    const onPointerDown = (e: PointerEvent) => {
      const active = document.activeElement;
      if (active && e.target instanceof Node && active.contains(e.target)) viaKeyboard.set(active, false);
    };
    /**
     * Space = Play / Pause and Shift+Space = Stop, wherever focus is: also on
     * a control that was clicked (a pad, Mute, a scene, the button that opened
     * a dialog), so clicking never takes the key away from the transport. Not
     * while typing or with a modal dialog open; and Space (not Shift+Space) on
     * a control a keyboard user reached presses that control. Capture phase,
     * so a clicked pad's own key handler does not get the key first.
     */
    let spaceTaken = false;
    const onSpaceDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      // Each Space press decides afresh (a key up lost to a window switch must not swallow the next one).
      spaceTaken = false;
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented) return;
      if (isTypingTarget(e.target) || document.querySelector('[aria-modal="true"]')) return;
      const t = e.target;
      if (!e.shiftKey && t instanceof Element && t.closest(SPACE_CONTROLS) && viaKeyboard.get(t) !== false) return;
      // Neither the browser (it would press the focused button) nor the control's own handler gets it.
      e.preventDefault();
      e.stopPropagation();
      spaceTaken = true;
      if (e.repeat) return;
      if (e.shiftKey) session.stop();
      // In Arrange, Space plays the song (as the transport's Play song key does); a pause resumes what was playing.
      else void session.togglePlay({ song: uiStore.getState().view === 'arrange' });
    };
    // The key up of a Space the transport took does not reach the control either.
    const onSpaceUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !spaceTaken) return;
      spaceTaken = false;
      e.preventDefault();
      e.stopPropagation();
    };
    // Never leave notes hanging when focus leaves the window.
    const release = () => session.releaseAllNotes();
    const onVis = () => {
      if (document.visibilityState === 'hidden') release();
    };
    window.addEventListener('keydown', onPartKey, true);
    window.addEventListener('keydown', onSpaceDown, true);
    window.addEventListener('keyup', onSpaceUp, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVis);
    // The recovery export offered when saving fails: say whether it worked.
    const onExportProject = () => {
      session
        .exportProjectFile()
        .then(({ blob, filename }) => {
          downloadBlob(blob, filename);
          notify(`Saved “${filename}” to your downloads. Keep it as your backup.`);
        })
        .catch((e: unknown) => notify(storageMessage(e, 'Exporting the project file'), 'error'));
    };
    window.addEventListener('sb:export-project', onExportProject);
    // Any view can open the export dialog with a preselected source ('song', 'perf:<id>', 'scene:<row>', 'now').
    const onOpenExport = (e: Event) => {
      setExportSource((e as CustomEvent<{ source?: string }>).detail?.source);
      setExportOpen(true);
    };
    window.addEventListener('sb:open-export', onOpenExport);
    return () => {
      window.removeEventListener('keydown', onPartKey, true);
      window.removeEventListener('keydown', onSpaceDown, true);
      window.removeEventListener('keyup', onSpaceUp, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('sb:export-project', onExportProject);
      window.removeEventListener('sb:open-export', onOpenExport);
    };
  }, []);

  return (
    <TipsProvider enabled={tips} onEnabledChange={(on) => setTipsEnabled(on)}>
      <ToastProvider>
        {/* Before the instrument in the DOM so Tab reaches the guide first; it never blocks the pads. */}
        <Guide key={guideRun} open={guide} onClose={() => setGuide(false)} />
        <div className={styles.app} inert={welcome ? true : undefined}>
          <TransportBar onOpenLibrary={() => setLibrary({ tab: 'projects', fromWelcome: false })} onOpenExport={() => { setExportSource(undefined); setExportOpen(true); }} />
          <div className={styles.bannerSlot}>
            <AudioBanner />
          </div>
          <main className={styles.main}>
            <Workspace />
          </main>
          <footer className={styles.keyboard}>
            <KeyboardStrip />
          </footer>
        </div>
        {/* After the instrument in the DOM: a non-blocking chip in a free spot, shown after the guide. */}
        <Hints active={!welcome && !guide} />
        {welcome && (
          <Welcome
            lastProject={boot.lastProject}
            warnings={boot.warnings}
            storageError={boot.storageError}
            onClose={() => setWelcome(false)}
            onBrowse={() => setLibrary({ tab: 'starters', fromWelcome: true })}
            onJumpedIn={jumpedIn}
          />
        )}
        <Library
          open={library !== null}
          initialTab={library?.tab}
          onClose={() => setLibrary(null)}
          onLoaded={(how) => {
            const firstStart = !!library?.fromWelcome && how === 'starter';
            setLibrary(null);
            setWelcome(false);
            if (firstStart) offerGuide();
          }}
          onShowGuide={() => {
            setLibrary(null);
            setWelcome(false);
            setGuideRun((n) => n + 1);
            setGuide(true);
          }}
          onShowHints={() => {
            setLibrary(null);
            setWelcome(false);
            setGuide(false);
            // Hints are part of Tips: asking for them turns Tips back on.
            setTipsEnabled(true);
            showHintsAgain();
          }}
        />
        <ExportDialog open={exportOpen} initialSource={exportSource} onClose={() => { setExportOpen(false); setExportSource(undefined); }} />
        <Notices />
      </ToastProvider>
    </TipsProvider>
  );
}
