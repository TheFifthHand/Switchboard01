/**
 * Application shell (Omni Song): transport strip, the current view, the
 * keyboard strip, dialogs, the quick guide and "Try this" hints, and global
 * keyboard/focus handling.
 */
import { useEffect, useState } from 'react';
import { Button, TipsProvider, ToastProvider, useToasts } from '../ui/components';
import { DRUM_KEYS, NOTE_KEYS, isTypingTarget } from '../ui/hooks/useComputerKeyboard';
import { setTipsEnabled } from '../state/uiStore';
import { session, useUi } from './instance';
import { notify, useRuntime } from './runtime';
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

function Notices() {
  const notice = useRuntime((s) => s.notice);
  const toasts = useToasts();
  useEffect(() => {
    if (!notice) return;
    toasts.show({
      id: 'notice',
      tone: notice.tone === 'error' ? 'error' : notice.tone === 'warn' ? 'warning' : 'info',
      message: notice.text,
      action: notice.action === 'undo' ? { label: 'Undo', onAction: () => session.undo() } : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice?.id]);
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
      // Shortcuts belong to an open modal dialog while it is showing.
      if (document.querySelector('[aria-modal="true"]')) return;
      const mod = e.ctrlKey || e.metaKey;
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
      if (e.code === 'Space' && !mod && !e.altKey && !e.repeat) {
        const t = e.target as HTMLElement | null;
        // Space on a focused button or slider activates that control instead.
        if (t && t !== document.body && t.closest('button, [role="tab"], [role="radio"], a, summary')) return;
        e.preventDefault();
        if (e.shiftKey) session.stop();
        else void session.togglePlay();
      }
    };
    // Never leave notes hanging when focus leaves the window.
    const release = () => session.releaseAllNotes();
    const onVis = () => {
      if (document.visibilityState === 'hidden') release();
    };
    window.addEventListener('keydown', onPartKey, true);
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
