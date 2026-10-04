/**
 * Application shell (Omni Song): transport strip, the current view, the
 * keyboard strip, dialogs (projects, export, Help), the quick guide and
 * "Try this" hints, banners (audio, a stall, a project open in another tab),
 * the toasts the shell itself raises, and global keys, focus and drops.
 */
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { Button, TipsProvider, ToastProvider, useToasts, type ToastApi, type ToastOptions } from '../ui/components';
import { DRUM_KEYS, NOTE_KEYS, isTypingTarget } from '../ui/hooks/useComputerKeyboard';
import { setTipsEnabled, uiStore } from '../state/uiStore';
import * as library from '../persistence/library';
import { BUNDLE_EXTENSION, LEGACY_BUNDLE_EXTENSIONS } from '../persistence/bundle';
import { session, useProject, useUi } from './instance';
import { IDLE_AUTOSAVE_STATE, type AutosaveState } from '../persistence/autosave';
import { createStore, useStore } from '../state/store';
import { notify, runtimeStore, setNoticeHistory, useRuntime, type NoticeAction } from './runtime';
import type { BootInfo } from './session';
import { TransportBar, useNothingToPlay } from './views/TransportBar';
import { PlayView } from './views/PlayView';
import { KeyboardStrip } from './views/KeyboardStrip';
import { Welcome } from './views/Welcome';
import { ExportDialog } from './views/ExportDialog';
import { Library, hearIt, storageMessage, type LibraryTab } from './views/Library';
import { Guide } from './views/Guide';
import { HelpDialog, APP_VERSION, type HelpTab } from './views/HelpDialog';
import { Hints, VIEW_NAMES, showHintsAgain, startHints } from './views/hints';
import { SEEN_VERSION_KEY, notesToShow } from './views/hints/guides';
import { useAudioInput } from './views/devices';
import { ShapeView } from './views/shape/ShapeView';
import { ArrangeView } from './views/arrange/ArrangeView';
import { MixView } from './views/mix/MixView';
import { downloadBlob } from './download';
import type { View } from '../state/uiStore';
import styles from './App.module.css';

/** Physical keys the computer keyboard plays notes or drum pads with. */
const NOTE_KEY_CODES: ReadonlySet<string> = new Set([...NOTE_KEYS, ...DRUM_KEYS].map((k) => k.code));

/** The step Undo (or Redo) of the app's project would apply now (its history entry id), or null. */
const historyTop = (action: NoticeAction): number | null => (action === 'undo' ? session.store.undoEntryId() : session.store.redoEntryId());

// Every "… [Undo]" message names the edit that was newest when it was made.
setNoticeHistory(historyTop);

/** Undid / Redid confirmations are short-lived: they confirm a key press and must not sit over the keyboard. */
export const HISTORY_TOAST_MS = 3000;

/** Controls that Space presses when a keyboard user reached them (Tab, arrow keys). */
const SPACE_CONTROLS =
  'button, [role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], a, summary';

/** Project files a drop on the window opens (.omnisong.zip, and .sb01.zip from SWITCHBOARD / 01). */
const PROJECT_FILE = new RegExp(`(${[BUNDLE_EXTENSION, ...LEGACY_BUNDLE_EXTENSIONS].map((x) => x.replace(/\./g, '\\.')).join('|')})$`, 'i');

function focusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage blocked: "What's new" may show again next time, which is harmless.
  }
}

/** Write the project file to the downloads, and say whether it worked. */
function exportProjectFile(): void {
  session
    .exportProjectFile()
    .then(({ blob, filename }) => {
      downloadBlob(blob, filename);
      notify(`Saved “${filename}” to your downloads. Keep it as your backup.`);
    })
    .catch((e: unknown) => notify(storageMessage(e, 'Exporting the project file'), 'error'));
}

/** Open a stored project and say so (or why not). */
async function openStored(id: string): Promise<void> {
  try {
    // Opening a project stops what plays: say so, so the silence is not a surprise.
    const wasPlaying = runtimeStore.getState().playing;
    await session.openProject(id);
    const name = session.store.getState().name;
    notify(wasPlaying ? `Opened “${name}”. Playback stopped: press Play (or Space) to hear it.` : `Opened “${name}”.`);
  } catch (e) {
    notify(storageMessage(e, 'Opening the project'), 'error');
  }
}


/**
 * The toast for runtime notices. A message about an edit ("Moved … " [Undo],
 * "Undid: …" [Redo]) is tied to that history step: its button acts only while
 * the step is still the one Undo (or Redo) would apply, and the toast goes away
 * as soon as it is not (Ctrl+Z, another edit, another project). "Undid" and
 * "Redid" confirmations last 3 s.
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
      ...(/^(Undid|Redid): /.test(notice.text) ? { duration: HISTORY_TOAST_MS } : {}),
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

/** Hands the toast API to the shell (App renders the provider, so it cannot use the hook itself). */
function ToastBridge({ apiRef }: { apiRef: { current: ToastApi | null } }) {
  const toasts = useToasts();
  useEffect(() => {
    apiRef.current = toasts;
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, toasts]);
  return null;
}

/** A failed save, once per run of failures: what went wrong, with Export project file. */
export function saveFailedText(kind: string | undefined): string {
  switch (kind) {
    case 'quota':
      return 'Not saved: browser storage is full.';
    case 'unavailable':
      return 'Not saved: browser storage is not available in this window.';
    case 'blocked':
      return 'Not saved: another Omni Song tab is holding the storage.';
    default:
      return 'Not saved: saving to this browser failed.';
  }
}

function SaveFailureToast() {
  const streak = useSave((s) => ((s.failures ?? 0) > 0 ? (s.firstFailureAt ?? null) : null));
  const toasts = useToasts();
  /** The run of failures already told about (its start time). */
  const told = useRef<number | null>(null);
  useEffect(() => {
    if (streak === null) {
      // Saving works again: a toast about the failure would be stale now.
      if (told.current !== null) toasts.dismiss('save-failed');
      told.current = null;
      return;
    }
    if (told.current === streak) return;
    told.current = streak;
    const kind = session.autosaver?.status.getState().lastError?.kind;
    toasts.show({ id: 'save-failed', tone: 'error', message: saveFailedText(kind), action: { label: 'Export project file', onAction: exportProjectFile } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streak]);
  return null;
}

/**
 * This tab does not save the open project: it is open in another tab
 * ('other-tab': Take over / Open a copy), or another tab saved it after this
 * one opened it ('conflict': Open the latest / Open a copy).
 */
function ReadonlyBanner() {
  const readonly = useSave((s) => s.readonly ?? null);
  const [busy, setBusy] = useState(false);
  if (!readonly) return null;
  const run = (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };
  const takeOver = () =>
    run(async () => {
      await session.autosaver?.takeOver();
      const after = session.autosaver?.status.getState().readonly ?? null;
      if (after === null) notify('This tab saves the project now. The other tab stops saving it.');
    });
  const openCopy = () =>
    run(async () => {
      try {
        const copy = await library.saveCopy(session.store.getState());
        await session.openProject(copy.id);
        notify(`Opened a copy, “${copy.name}”. This tab saves it.`);
      } catch (e) {
        notify(storageMessage(e, 'Making a copy'), 'error');
      }
    });
  const openLatest = () =>
    run(async () => {
      try {
        await session.openProject(session.store.getState().id);
        notify(`Opened the latest “${session.store.getState().name}”.`);
      } catch (e) {
        notify(storageMessage(e, 'Opening the latest version'), 'error');
      }
    });
  return (
    <div className={`${styles.banner} ${styles.readonly}`} role="status" data-readonly={readonly}>
      <span>
        {readonly === 'other-tab'
          ? 'This project is open in another tab. Changes here are not saved.'
          : 'This project was changed in another tab after this tab opened it. Changes here are not saved.'}
      </span>
      {readonly === 'other-tab' ? (
        <Button size="sm" variant="primary" onClick={takeOver} aria-busy={busy || undefined} tip="Save this tab's project from now on. The other tab stops saving it.">
          Take over
        </Button>
      ) : (
        <Button size="sm" variant="primary" onClick={openLatest} aria-busy={busy || undefined} tip="Load the project as the other tab saved it. The changes made here are dropped.">
          Open the latest
        </Button>
      )}
      <Button size="sm" variant="secondary" onClick={openCopy} aria-busy={busy || undefined} tip="Keep what is on screen here as a new project, saved by this tab.">
        Open a copy
      </Button>
    </div>
  );
}

function AudioBanner() {
  const audio = useRuntime((s) => s.audio);
  const message = useRuntime((s) => s.audioMessage);
  const stalled = useRuntime((s) => s.stalled);
  if (stalled) {
    // The message says "Press Play to continue": this is that Play.
    return (
      <div className={styles.banner} role="alert">
        <span>{stalled}</span>
        <Button size="sm" variant="primary" icon="play" aria-label="Play from where it stopped" onClick={() => void session.resumeAfterStall()}>
          Play
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

/**
 * The view on screen. The tab changes at once (its urgent render is small);
 * the new view renders right after, in a deferred render the browser can
 * paint around (session.brace() keeps playback ahead meanwhile).
 */
function Workspace({ view }: { view: View }) {
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

/**
 * The autosave state, narrowed by `selector`: a component re-renders only
 * when what it reads changes (the whole state changes on every save).
 */
const noSaver = createStore<AutosaveState>({ ...IDLE_AUTOSAVE_STATE });
function useSave<S>(selector: (s: AutosaveState) => S): S {
  return useStore(session.autosaver?.status ?? noSaver, selector);
}

/**
 * The tab's title: "<project> — Omni Song", with ▶ while something plays
 * (not while the transport says "Nothing to play yet"); just "Omni Song"
 * behind the Welcome card. A leaf of its own, so Play / Pause re-renders
 * only this, never the app.
 */
function DocumentTitle({ welcome }: { welcome: boolean }): null {
  const name = useProject((p) => p.name);
  const playing = useRuntime((s) => s.playing);
  const nothing = useNothingToPlay();
  const sounding = playing && !nothing;
  useEffect(() => {
    document.title = welcome ? 'Omni Song' : `${sounding ? '▶ ' : ''}${name} — Omni Song`;
  }, [welcome, name, sounding]);
  return null;
}

/**
 * Ask before leaving only when leaving would lose something: a performance
 * or audio take recording, an export rendering, or edits that could not be
 * saved. Not while merely playing (an intentional reload must not nag), nor
 * for Record Notes (its notes are edits: the save state covers them). A leaf
 * of its own, reading narrow booleans: saves do not re-render the app.
 */
function LeaveGuard({ exportOpen }: { exportOpen: boolean }): null {
  const takeRecording = useRuntime((s) => s.recording === 'performance');
  const audioTake = useAudioInput((s) => s.take !== null);
  const unsaved = useSave((s) => s.dirty && s.status === 'error');
  const armed = takeRecording || audioTake || exportOpen || unsaved;
  useEffect(() => {
    if (!armed) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const st = session.autosaver?.status.getState();
      const losing = runtimeStore.getState().recording === 'performance' || audioTake || session.exporting || (!!st && st.dirty && st.status === 'error');
      if (!losing) return;
      e.preventDefault();
      // Older browsers need a value to show the prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [armed, audioTake]);
  return null;
}

export function App({ boot }: { boot: BootInfo }) {
  const [welcome, setWelcome] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSource, setExportSource] = useState<string | undefined>(undefined);
  const tips = useUi((s) => s.tipsEnabled);
  const view = useUi((s) => s.view);
  // The tab changes at once; the view itself follows in a deferred render.
  const shownView = useDeferredValue(view);
  const projectName = useProject((p) => p.name);
  // Project library (transport project button → My projects; Welcome → Starters) and the quick guide.
  const [library, setLibrary] = useState<{ tab: LibraryTab; fromWelcome: boolean } | null>(null);
  const [guide, setGuideState] = useState(false);
  /**
   * The quick guide takes the stage first: toasts about the start (which
   * project this one took the place of, what is new) wait until it is closed,
   * so they never sit over its words.
   */
  const guideOpen = useRef(false);
  const waiting = useRef<ToastOptions[]>([]);
  const setGuide = (on: boolean) => {
    guideOpen.current = on;
    setGuideState(on);
    if (on) return;
    const list = waiting.current;
    waiting.current = [];
    for (const t of list) toastsRef.current?.show(t);
  };
  const stageToast = (t: ToastOptions) => {
    if (guideOpen.current) waiting.current.push(t);
    else toastsRef.current?.show(t);
  };
  const [help, setHelp] = useState<HelpTab | null>(null);
  // Each replay starts from step 1, even when the guide is still open.
  const [guideRun, setGuideRun] = useState(0);
  // Where keyboard focus goes once the Welcome card has gone: the guide's Next (once it is on screen), or Play / Pause.
  const [focusGuide, setFocusGuide] = useState(false);
  const [focusPlay, setFocusPlay] = useState(false);
  const toastsRef = useRef<ToastApi | null>(null);

  // The guide is offered once, for the first project; the hints start with it (they show after the guide).
  const offerGuide = (): boolean => {
    if (uiStore.getState().guideDone) return false;
    setGuide(true);
    return true;
  };
  const firstProject = (): boolean => {
    const guided = offerGuide();
    startHints();
    return guided;
  };

  /** After Jump In (or Start a new groove): say which stored project it took the place of, with Open it. */
  const announceReplaced = () => {
    const rt = runtimeStore.getState();
    const replaced = rt.starterReplaced !== undefined ? rt.starterReplaced : boot.lastProject;
    if (!replaced || replaced.id === session.store.getState().id) return;
    const name = session.store.getState().name;
    stageToast({
      id: 'starter-replaced',
      tone: 'info',
      message: `Started a new ${name}. Your earlier “${replaced.name}” is in My projects.`,
      action: { label: 'Open it', onAction: () => void openStored(replaced.id) },
    });
  };
  const jumpedIn = () => {
    if (firstProject()) setFocusGuide(true);
    else setFocusPlay(true);
    announceReplaced();
  };

  // Keyboard focus after the Welcome card when no guide is offered: Play / Pause.
  useEffect(() => {
    if (welcome || !focusPlay) return;
    setFocusPlay(false);
    const raf = requestAnimationFrame(() => document.querySelector<HTMLElement>('header[aria-label="Transport"] button[aria-keyshortcuts="Space"]')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, [welcome, focusPlay]);

  // After an update: once, a toast offers what is new (Help → About keeps it).
  useEffect(() => {
    if (welcome || APP_VERSION === 'development') return;
    const seen = readStorage(SEEN_VERSION_KEY);
    // No version stored yet: a first run, or someone coming from a version that did not store it (they have projects).
    const notes = notesToShow(APP_VERSION, seen ?? (boot.lastProject ? 'earlier' : null));
    writeStorage(SEEN_VERSION_KEY, APP_VERSION);
    if (!notes) return;
    stageToast({
      id: 'whats-new',
      tone: 'info',
      message: `Omni Song is updated to version ${notes.version}.`,
      action: { label: 'What’s new', onAction: () => setHelp('about') },
      duration: 12000,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [welcome]);

  // Global shortcuts: Space = Play/Pause, Shift+Space = Stop, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y = undo/redo,
  // Ctrl+S = save now, ? = Help, M = mute / unmute the selected part.
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
    /** Ctrl/⌘+S: save now (never the browser's "Save page as"), and say where it went. */
    const saveNow = async () => {
      const saver = session.autosaver;
      await saver?.flush();
      const st = saver?.status.getState();
      const api = toastsRef.current;
      if (!api) return;
      const action = { label: 'Export project file', onAction: exportProjectFile };
      if (st?.readonly === 'other-tab') api.show({ id: 'save-now', tone: 'warning', message: 'Not saved: this project is open in another tab.', action });
      else if (st?.readonly === 'conflict') api.show({ id: 'save-now', tone: 'warning', message: 'Not saved: another tab saved this project after this tab opened it.', action });
      else if (st?.status === 'error') api.show({ id: 'save-now', tone: 'warning', message: saveFailedText(st.lastError?.kind), action });
      else if (session.isPreview) api.show({ id: 'save-now', tone: 'info', message: 'This starter is a preview: your first change stores it in this browser.', action });
      else api.show({ id: 'save-now', tone: 'info', message: 'Saved in this browser.', action });
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      // Ctrl/⌘+S anywhere, also in a field or behind a dialog: the browser's own Save page is never what is meant.
      if (mod && !e.altKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (!e.repeat) void saveNow();
        return;
      }
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      // Ctrl/⌘+A that no view used (the song lane selects its blocks with it): never select the page's text.
      if (mod && !e.altKey && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        return;
      }
      // Shortcuts belong to an open modal dialog while it is showing.
      if (document.querySelector('[aria-modal="true"]')) return;
      // ? (Shift+/ on most keyboards): Help.
      if (e.key === '?' && !mod && !e.altKey) {
        e.preventDefault();
        if (!e.repeat) setHelp('shortcuts');
        return;
      }
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
      // (Except a control that says Space plays there: the quick guide's Next on its Play step.)
      if (!e.shiftKey && t instanceof Element && t.closest(SPACE_CONTROLS) && !t.closest('[data-space-plays]') && viaKeyboard.get(t) !== false) return;
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
    /**
     * A project file (.omnisong.zip, .sb01.zip) dropped anywhere on the window
     * opens it. Drops a view handled itself (a sampler's drop zone) keep their
     * own handling; any other file dropped is refused, so the browser never
     * opens it in place of the app.
     */
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onDragOver = (e: DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = document.querySelector('[aria-modal="true"]') ? 'none' : 'copy';
    };
    const onDrop = (e: DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e)) return;
      e.preventDefault();
      if (document.querySelector('[aria-modal="true"]')) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      const file = files.find((f) => PROJECT_FILE.test(f.name));
      if (!file) {
        notify(`Only Omni Song project files (${BUNDLE_EXTENSION}) open when dropped here. To use a recording, drop it on a sampler part’s drop zone in Shape.`, 'warn');
        return;
      }
      void (async () => {
        try {
          const res = await session.importProjectFile(file);
          notify(res.ok ? `${res.message} ${hearIt()}` : res.message, res.ok ? 'info' : 'error');
        } catch (err) {
          notify(storageMessage(err, 'Opening the project file'), 'error');
        }
      })();
    };
    window.addEventListener('keydown', onPartKey, true);
    window.addEventListener('keydown', onSpaceDown, true);
    window.addEventListener('keyup', onSpaceUp, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    // The recovery export offered when saving fails.
    window.addEventListener('sb:export-project', exportProjectFile);
    // Any view can open the export dialog with a preselected source ('song', 'perf:<id>', 'scene:<row>', 'now').
    const onOpenExport = (e: Event) => {
      setExportSource((e as CustomEvent<{ source?: string }>).detail?.source);
      setExportOpen(true);
    };
    window.addEventListener('sb:open-export', onOpenExport);
    // Any view can open Help (optionally on a tab).
    const onOpenHelp = (e: Event) => setHelp((e as CustomEvent<{ tab?: HelpTab }>).detail?.tab ?? 'shortcuts');
    window.addEventListener('sb:open-help', onOpenHelp);
    return () => {
      window.removeEventListener('keydown', onPartKey, true);
      window.removeEventListener('keydown', onSpaceDown, true);
      window.removeEventListener('keyup', onSpaceUp, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('sb:export-project', exportProjectFile);
      window.removeEventListener('sb:open-export', onOpenExport);
      window.removeEventListener('sb:open-help', onOpenHelp);
    };
  }, []);

  const showGuide = () => {
    setLibrary(null);
    setHelp(null);
    setWelcome(false);
    setGuideRun((n) => n + 1);
    setGuide(true);
  };
  const showHints = () => {
    setLibrary(null);
    setHelp(null);
    setWelcome(false);
    setGuide(false);
    // Hints are part of Tips: asking for them turns Tips back on.
    setTipsEnabled(true);
    showHintsAgain();
  };

  return (
    <TipsProvider enabled={tips} onEnabledChange={(on) => setTipsEnabled(on)}>
      <ToastProvider>
        <ToastBridge apiRef={toastsRef} />
        {/* Before the instrument in the DOM so Tab reaches the guide first; it never blocks the pads. */}
        <Guide
          key={guideRun}
          open={guide}
          focusNext={focusGuide}
          onClose={() => {
            setGuide(false);
            setFocusGuide(false);
          }}
        />
        <div className={styles.app} inert={welcome ? true : undefined}>
          <TransportBar
            onOpenLibrary={() => setLibrary({ tab: 'projects', fromWelcome: false })}
            onNewProject={() => setLibrary({ tab: 'starters', fromWelcome: false })}
            onOpenExport={() => {
              setExportSource(undefined);
              setExportOpen(true);
            }}
            onOpenHelp={() => setHelp('shortcuts')}
          />
          <div className={styles.bannerSlot} data-banners="">
            <ReadonlyBanner />
            <AudioBanner />
          </div>
          <main className={styles.main}>
            {/* One heading per view, for screen readers: what this is and which project is open. */}
            <h1 className="visually-hidden">{`Omni Song — ${VIEW_NAMES[shownView]} · ${projectName}`}</h1>
            <Workspace view={shownView} />
          </main>
          <footer className={styles.keyboard}>
            <KeyboardStrip />
          </footer>
        </div>
        {/* After the instrument in the DOM: a non-blocking chip in a free spot, shown after the guide. */}
        <Hints active={!welcome && !guide} shownView={shownView} />
        {welcome && (
          <Welcome
            lastProject={boot.lastProject}
            warnings={boot.warnings}
            storageError={boot.storageError}
            onClose={() => setWelcome(false)}
            onLookAround={() => {
              setWelcome(false);
              startHints();
            }}
            onContinued={() => setFocusPlay(true)}
            onBrowse={() => setLibrary({ tab: 'starters', fromWelcome: true })}
            onJumpedIn={jumpedIn}
          />
        )}
        <Library
          open={library !== null}
          initialTab={library?.tab}
          onClose={() => setLibrary(null)}
          onLoaded={(how) => {
            const fromWelcome = !!library?.fromWelcome;
            setLibrary(null);
            setWelcome(false);
            // The first project, picked on Welcome (a starter, Blank, or one opened or imported): the guide for a
            // starter, and the hints for any.
            if (fromWelcome) {
              if (how === 'starter') offerGuide();
              startHints();
            }
          }}
          onShowGuide={showGuide}
          onShowHints={showHints}
        />
        <ExportDialog
          open={exportOpen}
          initialSource={exportSource}
          onClose={() => {
            setExportOpen(false);
            setExportSource(undefined);
          }}
        />
        <HelpDialog open={help !== null} initialTab={help ?? undefined} onClose={() => setHelp(null)} onShowGuide={showGuide} onShowHints={showHints} />
        <Notices />
        <SaveFailureToast />
        <DocumentTitle welcome={welcome} />
        <LeaveGuard exportOpen={exportOpen} />
      </ToastProvider>
    </TipsProvider>
  );
}
