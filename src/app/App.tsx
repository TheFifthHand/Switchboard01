/**
 * Application shell: transport strip, the current view, the keyboard strip,
 * dialogs and global keyboard/focus handling.
 */
import { useEffect, useState } from 'react';
import { Button, TipsProvider, ToastProvider, useToasts } from '../ui/components';
import { isTypingTarget } from '../ui/hooks/useComputerKeyboard';
import { setTipsEnabled } from '../state/uiStore';
import { session, useUi } from './instance';
import { useRuntime } from './runtime';
import type { BootInfo } from './session';
import { TransportBar } from './views/TransportBar';
import { PlayView } from './views/PlayView';
import { KeyboardStrip } from './views/KeyboardStrip';
import { Welcome } from './views/Welcome';
import { ExportDialog } from './views/ExportDialog';
import { downloadBlob } from './download';
import styles from './App.module.css';

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
    case 'play':
    default:
      return <PlayView />;
  }
}

export function App({ boot }: { boot: BootInfo }) {
  const [welcome, setWelcome] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const tips = useUi((s) => s.tipsEnabled);

  // Global shortcuts: Space = play/stop, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y = undo/redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
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
        if (t && t !== document.body && t.closest('button, [role="slider"], [role="tab"], [role="radio"], a, summary')) return;
        e.preventDefault();
        void session.togglePlay();
      }
    };
    // Never leave notes hanging when focus leaves the window.
    const release = () => session.releaseAllNotes();
    const onVis = () => {
      if (document.visibilityState === 'hidden') release();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVis);
    const onExportProject = () => {
      void session.exportProjectFile().then(({ blob, filename }) => downloadBlob(blob, filename));
    };
    window.addEventListener('sb:export-project', onExportProject);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('sb:export-project', onExportProject);
    };
  }, []);

  return (
    <TipsProvider enabled={tips} onEnabledChange={(on) => setTipsEnabled(on)}>
      <ToastProvider>
        <div className={styles.app} inert={welcome ? true : undefined}>
          <TransportBar onOpenLibrary={() => setWelcome(true)} onOpenExport={() => setExportOpen(true)} />
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
        {welcome && <Welcome lastProject={boot.lastProject} storageError={boot.storageError} onClose={() => setWelcome(false)} onBrowse={() => setWelcome(false)} />}
        <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
        <Notices />
      </ToastProvider>
    </TipsProvider>
  );
}
