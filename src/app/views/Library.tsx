/**
 * Project library (a large dialog with two tabs).
 *
 * - Starters: the eight curated starters and a blank project. Starting one
 *   saves the open project first (it stays in My projects) and loads the new
 *   one without playing it — the user presses Play or taps a pad. When the
 *   open project cannot be kept (storage down, or its latest edits failed to
 *   save), the dialog asks first and offers to export it.
 * - My projects: every project stored in this browser, the open one marked,
 *   with Open, Rename, Duplicate and Delete (to Recently deleted, where it can
 *   be restored or deleted forever). The open project cannot be deleted while
 *   it is open; the dialog offers to open another one first.
 * - Import / export of the portable project file (.omnisong.zip; files from
 *   SWITCHBOARD / 01, .sb01.zip, still import) and a short explanation of
 *   browser storage versus project files.
 * - "Show the quick guide again" and "Show hints again".
 *
 * Storage failures (full, unavailable, blocked by another tab, missing
 * project) are shown as plain-language notices; the dialog never crashes on
 * them. Lists are re-read after every action.
 */
import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { Button, Dialog, Icon, Notice, SegmentedControl } from '../../ui/components';
import { BLANK_STARTER, STARTERS, getStarter, type StarterDef } from '../../content/starters';
import * as library from '../../persistence/library';
import type { ProjectSummary, TrashSummary } from '../../persistence/library';
import { StorageError } from '../../persistence/db';
import { BUNDLE_ACCEPT, BUNDLE_EXTENSION, LEGACY_BUNDLE_EXTENSIONS } from '../../persistence/bundle';
import { renameProject as renameProjectCmd } from '../../state/commands';
import { session, useAutosave, useProject } from '../instance';
import { notify, runtimeStore, useRuntime } from '../runtime';
import { downloadBlob } from '../download';
import styles from './Library.module.css';

export type LibraryTab = 'starters' | 'projects';

export interface LibraryProps {
  open: boolean;
  /** Tab shown when the dialog opens (default: Starters). */
  initialTab?: LibraryTab;
  onClose(): void;
  /** A project was started, opened or imported and is now on screen (the dialog should close). */
  onLoaded(how: 'starter' | 'open' | 'import'): void;
  /** Replay the three-step quick guide. */
  onShowGuide(): void;
  /** Start the "Try this" hints again from the first one (the button shows when this is given). */
  onShowHints?(): void;
}

const TAB_OPTIONS = [
  { value: 'starters', label: 'Starters' },
  { value: 'projects', label: 'My projects' },
] as const;

const NAME_MAX = 80;
/** Elements where Space does their own job (press, toggle, type). */
const SPACE_CONTROLS = 'button, input, select, textarea, a[href], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], [role="slider"], [contenteditable="true"]';
/** A freshly loaded project has no clips running: a pad or scene tap starts playback with it. */
const HEAR_IT = 'Tap a pad or a scene to hear it.';

type Message = { tone: 'error' | 'success' | 'info'; text: string; action?: { label: string; onAction(): void } };

/** Inline state of one row: a rename field or a confirmation. */
type RowMode =
  | { kind: 'rename'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'delete-open'; id: string }
  | { kind: 'purge'; id: string };

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Plain-language text for a storage failure, with what to do next. */
export function storageMessage(e: unknown, action: string): string {
  if (e instanceof StorageError) {
    switch (e.kind) {
      case 'quota':
        return `${action} failed: browser storage is full. Export the projects you want to keep as files, then delete old ones here.`;
      case 'unavailable':
        return `${action} failed: browser storage is not available in this window (private browsing or blocked by settings). You can still play and export a project file.`;
      case 'blocked':
        return `${action} failed: another Omni Song tab is using the storage. Close the other tabs and try again.`;
      case 'not-found':
        return `${e.message} The list has been refreshed.`;
      default:
        return e.message;
    }
  }
  const detail = e instanceof Error ? e.message : String(e);
  return `${action} failed: ${detail}`;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", "12 Sep". */
export function timeAgo(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, now - ts) / 1000;
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d <= 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

const quote = (name: string) => `“${name}”`;

/** Id of the latest toast, to tell whether a session call raised its own warning. */
const lastNoticeId = () => runtimeStore.getState().notice?.id ?? 0;

/**
 * Say what was loaded. A warning the load raised itself (storage full, a
 * migrated or partly damaged project) is kept in the same message instead of
 * being replaced, and then nothing is claimed about what was saved.
 */
function announceLoaded(text: string, noticeBefore: number, extra = ''): void {
  const n = runtimeStore.getState().notice;
  if (n && n.id !== noticeBefore && n.tone !== 'info') notify(`${text} ${n.text}`, n.tone);
  else notify(`${text}${extra ? ` ${extra}` : ''} ${HEAR_IT}`);
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export function Library(props: LibraryProps) {
  // Unmounted while closed, so every opening starts fresh (tab, lists, messages).
  if (!props.open) return null;
  return <LibraryDialog {...props} />;
}

function LibraryDialog({ initialTab = 'starters', onClose, onLoaded, onShowGuide, onShowHints }: LibraryProps) {
  const [tab, setTab] = useState<LibraryTab>(initialTab);
  const currentId = useProject((p) => p.id);
  const currentName = useProject((p) => p.name);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [trash, setTrash] = useState<TrashSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [row, setRow] = useState<RowMode | null>(null);
  const [confirmStart, setConfirmStart] = useState<StarterDef | null>(null);
  // The open project's latest edits could not be stored (e.g. storage full).
  const saveFailing = useAutosave().status === 'error';
  const preview = useRuntime((s) => s.preview);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Element id to focus once the row UI has re-rendered (returning focus after a confirmation). */
  const focusAfter = useRef<string | null>(null);
  const panelId = useId();
  /** Focus starts on the selected tab (the dialog would otherwise pick the first tab button). */
  const initialFocus = useRef<HTMLElement | null>(null);
  const tabsRef = useCallback((el: HTMLDivElement | null) => {
    initialFocus.current = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([library.listProjects(), library.listTrash()]);
      if (!alive.current) return;
      setProjects(p);
      setTrash(t);
      setListError(null);
    } catch (e) {
      if (!alive.current) return;
      setListError(storageMessage(e, 'Reading your projects'));
      setProjects((p) => p ?? []);
      setTrash((t) => t ?? []);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    // Write pending edits first so the list shows the open project as it is now.
    void (async () => {
      await session.autosaver?.flush();
      await refresh();
    })();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  // If a control that had focus disappears, focus falls to the page; Escape must still close the dialog.
  // While the dialog is open, Space on something that is not a control (the list, the page) must not
  // reach the instrument's Space = Play/Stop shortcut behind it; it still scrolls the list.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const active = document.activeElement;
      const lost = !active || active === document.body;
      if (e.key === 'Escape' && lost) {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const t = e.target instanceof Element ? e.target : null;
        if (!t || !t.closest(SPACE_CONTROLS)) e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    const el = document.getElementById(id) ?? panelRef.current;
    el?.focus({ preventScroll: false });
  });

  /** Run one library action: one at a time, errors shown in the dialog, lists refreshed afterwards. */
  const run = async (key: string, failAction: string, fn: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      if (alive.current) setMessage({ tone: 'error', text: storageMessage(e, failAction) });
    } finally {
      busyRef.current = false;
      if (alive.current) {
        setBusy(null);
        await refresh();
      }
    }
  };

  const stored = !!projects?.some((p) => p.id === currentId);
  const storageDown = listError !== null;

  /* ---------- starters ---------- */

  /** `discardCurrent`: the user confirmed replacing a project whose latest edits could not be stored. */
  const startStarter = (def: StarterDef, discardCurrent = false) =>
    run(`start:${def.id}`, 'Starting the project', async () => {
      const previous = session.store.getState().name;
      const keptPrevious = stored && !discardCurrent;
      const before = lastNoticeId();
      await session.newFromStarter(def.id, { discardCurrent });
      // The project is on screen now, even if the dialog was closed meanwhile.
      const name = session.store.getState().name;
      announceLoaded(`Started ${quote(name)}.`, before, keptPrevious ? `${quote(previous)} is still in My projects.` : '');
      onLoaded('starter');
    });

  const pickStarter = (def: StarterDef) => {
    if (busyRef.current) return;
    // Without working storage, or with edits that failed to save, the open project cannot be kept: ask first.
    if (storageDown || saveFailing) setConfirmStart(def);
    else void startStarter(def);
  };

  /* ---------- import / export ---------- */

  const exportCurrent = () =>
    run('export', 'Exporting the project file', async () => {
      const { blob, filename } = await session.exportProjectFile();
      downloadBlob(blob, filename);
      if (alive.current) setMessage({ tone: 'success', text: `Saved ${quote(filename)} to your downloads. Keep it as a backup, or import it in another browser.` });
    });

  const onImportFile = (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    // Reset so choosing the same file again still triggers a change.
    input.value = '';
    if (!file) return;
    void run('import', 'Importing the project file', async () => {
      const res = await session.importProjectFile(file);
      if (!res.ok) {
        if (alive.current) setMessage({ tone: 'error', text: res.message });
        else notify(res.message, 'error');
        return;
      }
      notify(`${res.message} ${HEAR_IT}`);
      onLoaded('import');
    });
  };

  /* ---------- project rows ---------- */

  const openProject = (p: ProjectSummary) =>
    run(`open:${p.id}`, `Opening ${quote(p.name)}`, async () => {
      const before = lastNoticeId();
      await session.openProject(p.id);
      announceLoaded(`Opened ${quote(session.store.getState().name)}.`, before);
      onLoaded('open');
    });

  /** Open another project so the (formerly) open one can be deleted, then ask to delete it. */
  const openOtherThenDelete = (other: ProjectSummary, target: ProjectSummary) =>
    run(`open:${other.id}`, `Opening ${quote(other.name)}`, async () => {
      await session.openProject(other.id);
      if (!alive.current) return;
      setMessage({ tone: 'info', text: `Opened ${quote(other.name)}. You can delete ${quote(target.name)} now.` });
      setRow({ kind: 'delete', id: target.id });
    });

  const rename = (p: ProjectSummary, raw: string): Promise<boolean> => {
    const name = cleanName(raw);
    let ok = false;
    return run(`rename:${p.id}`, 'Renaming the project', async () => {
      if (p.id === session.store.getState().id) {
        // The open project: rename through the store so the editor, undo and autosave agree.
        const r = renameProjectCmd(session.store, name);
        if (!r.changed) {
          setMessage({ tone: 'error', text: r.refused ?? r.message ?? 'The project could not be renamed.' });
          return;
        }
        await session.autosaver?.flush();
      }
      await library.renameProject(p.id, name);
      ok = true;
      if (!alive.current) return;
      setRow(null);
      focusAfter.current = `lib-rename-${p.id}`;
      setMessage({ tone: 'success', text: `Renamed to ${quote(name)}.` });
    }).then(() => ok);
  };

  const duplicate = (p: ProjectSummary) =>
    run(`duplicate:${p.id}`, 'Duplicating the project', async () => {
      // The stored copy of the open project must include its latest edits.
      await session.autosaver?.flush();
      const copy = await library.duplicateProject(p.id);
      if (alive.current) setMessage({ tone: 'success', text: `Made a copy: ${quote(copy.name)}.` });
    });

  const restore = (t: { id: string; name: string }) =>
    run(`restore:${t.id}`, 'Restoring the project', async () => {
      await library.restoreProject(t.id);
      if (!alive.current) return;
      // The Restore button leaves with its row: keep focus in the dialog.
      focusAfter.current = panelId;
      setMessage({ tone: 'success', text: `${quote(t.name)} is back in My projects.` });
    });

  const remove = (p: ProjectSummary) =>
    run(`delete:${p.id}`, 'Deleting the project', async () => {
      if (p.id === session.store.getState().id) {
        setRow({ kind: 'delete-open', id: p.id });
        return;
      }
      await library.deleteProject(p.id);
      if (!alive.current) return;
      setRow(null);
      focusAfter.current = panelId;
      setMessage({ tone: 'success', text: `${quote(p.name)} moved to Recently deleted.`, action: { label: 'Undo', onAction: () => void restore(p) } });
    });

  const purge = (t: TrashSummary) =>
    run(`purge:${t.id}`, 'Deleting the project forever', async () => {
      await library.deleteForever(t.id);
      if (!alive.current) return;
      setRow(null);
      focusAfter.current = panelId;
      setMessage({ tone: 'success', text: `${quote(t.name)} was deleted forever.` });
    });

  const cancelRow = (returnTo?: string) => {
    setRow(null);
    if (returnTo) focusAfter.current = returnTo;
  };

  const askDelete = (p: ProjectSummary) => {
    setMessage(null);
    setRow({ kind: p.id === currentId ? 'delete-open' : 'delete', id: p.id });
  };

  // Escape first closes an open rename field or confirmation, then the dialog.
  const onRootKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (row) {
      e.preventDefault();
      e.stopPropagation();
      const back = row.kind === 'rename' ? `lib-rename-${row.id}` : row.kind === 'purge' ? `lib-purge-${row.id}` : `lib-delete-${row.id}`;
      cancelRow(back);
    } else if (confirmStart) {
      e.preventDefault();
      e.stopPropagation();
      setConfirmStart(null);
    }
  };

  // Open project first, then the rest by most recent edit.
  const ordered = projects ? [...projects].sort((a, b) => (a.id === currentId ? -1 : b.id === currentId ? 1 : b.updatedAt - a.updatedAt)) : null;
  const projectCount = projects?.length ?? 0;
  const now = Date.now();

  return (
    <Dialog
      open
      onClose={onClose}
      title="Project library"
      size="lg"
      className={styles.dialog}
      closeLabel="Close the project library"
      initialFocusRef={initialFocus}
      actions={
        <div className={styles.footer}>
          <p className={`${styles.storageNote} ${styles.footerNote}`}>
            <Icon name="info" size={14} className={styles.noteIcon} />
            <span>{library.LIBRARY_STORAGE_NOTE}</span>
          </p>
          <div className={styles.footerActions}>
            <input ref={fileRef} type="file" accept={BUNDLE_ACCEPT} hidden onChange={onImportFile} aria-hidden="true" tabIndex={-1} data-testid="library-import-input" />
            <Button
              size="sm"
              icon="upload"
              onClick={() => fileRef.current?.click()}
              disabled={busy !== null}
              tip={`Open a ${BUNDLE_EXTENSION} project file saved from Omni Song. It is added to My projects; nothing is replaced.`}
              detail={`Project files from SWITCHBOARD / 01, the app's name before 2.0 (${LEGACY_BUNDLE_EXTENSIONS.join(', ')}), open the same way.`}
              aria-busy={busy === 'import' || undefined}
            >
              {busy === 'import' ? 'Importing…' : 'Import project file…'}
            </Button>
            <Button size="sm" icon="download" onClick={() => void exportCurrent()} disabled={busy !== null} tip={`Save ${quote(currentName)} with its recordings as one file: your portable backup.`} aria-busy={busy === 'export' || undefined}>
              {busy === 'export' ? 'Exporting…' : 'Export this project'}
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.root} onKeyDown={onRootKeyDown}>
        <div className={styles.tabRow} ref={tabsRef}>
          <SegmentedControl<LibraryTab> label="Library sections" kind="tabs" options={TAB_OPTIONS} value={tab} onChange={(v) => setTab(v)} controls={panelId} size="sm" />
          {tab === 'projects' && projectCount > 0 && !listError && (
            <span className={styles.count}>
              {projectCount === 1 ? '1 project' : `${projectCount} projects`} in this browser
            </span>
          )}
          <Button size="sm" variant="ghost" icon="sparkle" className={styles.guideButton} onClick={onShowGuide} tip="Three quick pointers: Play and Pause, the pads with Mute, and Change instrument with the big knobs.">
            Show the quick guide again
          </Button>
          {onShowHints && (
            <Button size="sm" variant="ghost" icon="info" className={styles.hintsButton} onClick={onShowHints} tip="Small “Try this” suggestions, one at a time, from the first one. They turn Tips on.">
              Show hints again
            </Button>
          )}
        </div>

        {(message || listError) && (
          <div className={styles.messages}>
            {listError && (
              <Notice tone="warning" title="Browser storage is not working right now">
                {listError}
              </Notice>
            )}
            {message && (
              <Notice
                tone={message.tone}
                action={message.action}
                onDismiss={() => {
                  setMessage(null);
                  focusAfter.current = panelId;
                }}
                dismissLabel="Dismiss message"
              >
                {message.text}
              </Notice>
            )}
          </div>
        )}

        <div id={panelId} ref={panelRef} className={styles.panel} role="tabpanel" aria-label={tab === 'starters' ? 'Starters' : 'My projects'} tabIndex={-1}>
          {tab === 'starters' ? (
            <StartersPanel
              currentName={currentName}
              loaded={projects !== null}
              stored={stored}
              storageDown={storageDown}
              saveFailing={saveFailing}
              busy={busy}
              confirm={confirmStart}
              onPick={pickStarter}
              onConfirm={(def) => {
                setConfirmStart(null);
                void startStarter(def, true);
              }}
              onCancelConfirm={() => setConfirmStart(null)}
              onExport={() => void exportCurrent()}
            />
          ) : ordered === null ? (
            <p className={styles.empty}>Loading your projects…</p>
          ) : (
            <>
              {!listError && (saveFailing || preview) && (
                <p className={styles.previewNote}>
                  <Icon name="info" size={14} className={styles.noteIcon} />
                  <span>
                    {saveFailing
                      ? `The latest changes to ${quote(currentName)} could not be saved in this browser. Export it as a file to keep them.`
                      : `${quote(currentName)} on screen is a preview. As soon as you change it, it is added to My projects and saved automatically.`}
                  </span>
                </p>
              )}
              {ordered.length === 0 ? (
                <p className={styles.empty}>No saved projects yet. Start one from Starters, or import a project file.</p>
              ) : (
                <ul className={styles.list} aria-label="Saved projects">
                  {ordered.map((p) => {
                    const isOpen = p.id === currentId;
                    const others = ordered.filter((o) => o.id !== p.id);
                    return (
                      <ProjectRow
                        key={p.id}
                        project={p}
                        displayName={isOpen ? currentName : p.name}
                        isOpen={isOpen}
                        now={now}
                        mode={row && row.id === p.id ? row.kind : null}
                        busy={busy}
                        nextToOpen={others[0] ?? null}
                        onOpen={() => void openProject(p)}
                        onRenameStart={() => {
                          setMessage(null);
                          setRow({ kind: 'rename', id: p.id });
                        }}
                        onRename={(name) => rename(p, name)}
                        onDuplicate={() => void duplicate(p)}
                        onDeleteAsk={() => askDelete(p)}
                        onDeleteConfirm={() => void remove(p)}
                        onOpenOther={(other) => void openOtherThenDelete(other, p)}
                        onGoToStarters={() => {
                          setRow(null);
                          setTab('starters');
                        }}
                        onCancel={(back) => cancelRow(back)}
                      />
                    );
                  })}
                </ul>
              )}

              <section className={styles.trash} aria-labelledby={`${panelId}-trash`}>
                <h3 id={`${panelId}-trash`} className={styles.sectionLabel}>
                  Recently deleted{trash && trash.length > 0 ? ` · ${trash.length}` : ''}
                </h3>
                {!trash || trash.length === 0 ? (
                  <p className={styles.emptySmall}>Nothing here. Deleted projects wait here until you restore them or delete them forever.</p>
                ) : (
                  <ul className={styles.list} aria-label="Recently deleted projects">
                    {trash.map((t) => (
                      <TrashRow
                        key={t.id}
                        item={t}
                        now={now}
                        confirming={row?.kind === 'purge' && row.id === t.id}
                        busy={busy}
                        onRestore={() => void restore(t)}
                        onPurgeAsk={() => {
                          setMessage(null);
                          setRow({ kind: 'purge', id: t.id });
                        }}
                        onPurgeConfirm={() => void purge(t)}
                        onCancel={() => cancelRow(`lib-purge-${t.id}`)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
          {/* Short windows (e.g. 200 % zoom): the note moves here so the footer stays one row. */}
          <p className={`${styles.storageNote} ${styles.panelNote}`}>
            <Icon name="info" size={14} className={styles.noteIcon} />
            <span>{library.LIBRARY_STORAGE_NOTE}</span>
          </p>
        </div>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Starters                                                            */
/* ------------------------------------------------------------------ */

function StartersPanel(props: {
  currentName: string;
  /** The project list has been read (until then it is unknown whether the open project is stored). */
  loaded: boolean;
  stored: boolean;
  storageDown: boolean;
  /** The open project's latest edits could not be saved. */
  saveFailing: boolean;
  busy: string | null;
  confirm: StarterDef | null;
  onPick(def: StarterDef): void;
  onConfirm(def: StarterDef): void;
  onCancelConfirm(): void;
  onExport(): void;
}) {
  const { currentName, loaded, stored, storageDown, saveFailing, busy, confirm } = props;
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirm) confirmRef.current?.focus();
  }, [confirm]);

  let intro: string;
  if (!loaded) intro = 'Pick a starting point.';
  else if (storageDown) intro = `Starting a project replaces ${quote(currentName)} on screen, and it cannot be kept in this browser right now.`;
  else if (saveFailing) intro = `Starting a project replaces ${quote(currentName)} on screen, and its latest changes could not be saved in this browser.`;
  else if (stored) intro = `Pick a starting point. Your current project ${quote(currentName)} stays in My projects.`;
  else intro = `Pick a starting point. It loads without playing: ${HEAR_IT.toLowerCase()}`;

  const cards: StarterDef[] = [...STARTERS, BLANK_STARTER];
  return (
    <div className={styles.starters}>
      <p className={styles.intro}>{intro}</p>
      {confirm && (
        <div className={styles.confirm} role="group" aria-label={`Start ${confirm.name}?`}>
          <p className={styles.confirmText}>
            Replace {quote(currentName)} with {confirm === BLANK_STARTER ? 'a blank project' : quote(confirm.name)}?{' '}
            {storageDown
              ? `Browser storage is not working, so ${quote(currentName)} will be lost unless you export it first.`
              : 'Its latest changes could not be saved in this browser. Export it first if you want to keep them.'}
          </p>
          <div className={styles.confirmActions}>
            <Button size="sm" variant="ghost" onClick={props.onCancelConfirm}>
              Cancel
            </Button>
            <Button size="sm" icon="download" onClick={props.onExport} disabled={busy !== null}>
              Export it first
            </Button>
            <Button ref={confirmRef} size="sm" variant="danger" onClick={() => props.onConfirm(confirm)} disabled={busy !== null}>
              Replace it
            </Button>
          </div>
        </div>
      )}
      <ul className={styles.cards} aria-label="Starter projects">
        {cards.map((def) => {
          const starting = busy === `start:${def.id}`;
          const blank = def === BLANK_STARTER;
          const title = blank ? 'Blank project' : def.name;
          return (
            <li key={def.id} className={styles.cardItem}>
              <button
                type="button"
                className={styles.card}
                data-blank={blank || undefined}
                data-starting={starting || undefined}
                disabled={busy !== null}
                aria-busy={starting || undefined}
                aria-label={`Start ${title} — ${def.bpm} BPM, ${def.key}${starting ? '. Starting…' : ''}`}
                aria-describedby={`starter-desc-${def.id}`}
                data-starter={def.id}
                onClick={() => props.onPick(def)}
              >
                <span className={styles.cardHead}>
                  <span className={styles.cardName}>{title}</span>
                  <span className={`${styles.cardBpm} mono`}>{def.bpm} BPM</span>
                </span>
                <span className={`${styles.cardKey} mono`}>{def.key}</span>
                <span id={`starter-desc-${def.id}`} className={styles.cardDesc}>
                  {def.description}
                </span>
                <span className={styles.cardGo} aria-hidden="true">
                  {starting ? (
                    'Starting…'
                  ) : (
                    <>
                      Start <Icon name="chevronRight" size={12} />
                    </>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

function projectMeta(p: ProjectSummary, now: number): string {
  const origin = p.starterId ? getStarter(p.starterId) : undefined;
  const parts = [`${Math.round(p.bpm)} BPM`];
  if (origin) parts.push(origin === BLANK_STARTER ? 'from Blank' : `from ${origin.name}`);
  parts.push(`edited ${timeAgo(p.updatedAt, now)}`);
  return parts.join(' · ');
}

function ProjectRow(props: {
  project: ProjectSummary;
  displayName: string;
  isOpen: boolean;
  now: number;
  mode: RowMode['kind'] | null;
  busy: string | null;
  nextToOpen: ProjectSummary | null;
  onOpen(): void;
  onRenameStart(): void;
  onRename(name: string): Promise<boolean>;
  onDuplicate(): void;
  onDeleteAsk(): void;
  onDeleteConfirm(): void;
  onOpenOther(other: ProjectSummary): void;
  onGoToStarters(): void;
  onCancel(returnFocusTo?: string): void;
}) {
  const { project: p, displayName, isOpen, now, mode, busy, nextToOpen } = props;
  const id = p.id;
  const disabled = busy !== null;
  const nameId = `lib-name-${id}`;
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (mode === 'delete' || mode === 'delete-open') keepRef.current?.focus();
  }, [mode]);

  return (
    <li className={styles.row} data-open={isOpen || undefined} aria-current={isOpen ? 'true' : undefined} aria-labelledby={nameId}>
      <div className={styles.rowMain}>
        {mode === 'rename' ? (
          <RenameField initial={displayName} busy={busy === `rename:${id}`} onSubmit={props.onRename} onCancel={() => props.onCancel(`lib-rename-${id}`)} />
        ) : (
          <div className={styles.rowText}>
            <div className={styles.rowTitle}>
              <span id={nameId} className={styles.rowName}>
                {displayName}
              </span>
              {isOpen && (
                <span className={styles.openBadge}>
                  <span className={styles.openLamp} aria-hidden="true" />
                  Open now
                </span>
              )}
            </div>
            <div className={styles.rowMeta}>{projectMeta(p, now)}</div>
          </div>
        )}
        {mode !== 'rename' && (
          <div className={styles.rowActions}>
            {!isOpen && (
              <Button size="sm" variant="secondary" icon="folder" onClick={props.onOpen} disabled={disabled} aria-label={`Open ${displayName}`} aria-busy={busy === `open:${id}` || undefined}>
                {busy === `open:${id}` ? 'Opening…' : 'Open'}
              </Button>
            )}
            <Button id={`lib-rename-${id}`} size="sm" variant="ghost" onClick={props.onRenameStart} disabled={disabled} aria-label={`Rename ${displayName}`}>
              Rename
            </Button>
            <Button id={`lib-duplicate-${id}`} size="sm" variant="ghost" icon="duplicate" onClick={props.onDuplicate} disabled={disabled} aria-label={`Duplicate ${displayName}`} aria-busy={busy === `duplicate:${id}` || undefined}>
              {busy === `duplicate:${id}` ? 'Copying…' : 'Duplicate'}
            </Button>
            <Button id={`lib-delete-${id}`} size="sm" variant="ghost" icon="trash" className={styles.deleteButton} onClick={props.onDeleteAsk} disabled={disabled} aria-label={`Delete ${displayName}`} aria-expanded={mode === 'delete' || mode === 'delete-open'}>
              Delete
            </Button>
          </div>
        )}
      </div>

      {mode === 'delete' && (
        <div className={styles.confirm} role="group" aria-label={`Delete ${displayName}?`}>
          <p className={styles.confirmText}>
            Delete {quote(displayName)}? It moves to Recently deleted, where you can restore it.
          </p>
          <div className={styles.confirmActions}>
            <Button ref={keepRef} size="sm" variant="ghost" onClick={() => props.onCancel(`lib-delete-${id}`)}>
              Keep it
            </Button>
            <Button size="sm" variant="danger" icon="trash" onClick={props.onDeleteConfirm} disabled={disabled} aria-busy={busy === `delete:${id}` || undefined}>
              {busy === `delete:${id}` ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </div>
      )}

      {mode === 'delete-open' && (
        <div className={styles.confirm} role="group" aria-label={`${displayName} is open`}>
          <p className={styles.confirmText}>
            {quote(displayName)} is open, so it cannot be deleted right now.{' '}
            {nextToOpen ? `Open ${quote(nextToOpen.name)} first, then delete this one.` : 'Start another project from Starters first, then delete this one.'}
          </p>
          <div className={styles.confirmActions}>
            <Button ref={keepRef} size="sm" variant="ghost" onClick={() => props.onCancel(`lib-delete-${id}`)}>
              Cancel
            </Button>
            {nextToOpen ? (
              <Button size="sm" icon="folder" onClick={() => props.onOpenOther(nextToOpen)} disabled={disabled} aria-busy={busy === `open:${nextToOpen.id}` || undefined}>
                {busy === `open:${nextToOpen.id}` ? 'Opening…' : `Open ${quote(nextToOpen.name)}`}
              </Button>
            ) : (
              <Button size="sm" onClick={props.onGoToStarters}>
                Go to Starters
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function RenameField(props: { initial: string; busy: boolean; onSubmit(name: string): Promise<boolean>; onCancel(): void }) {
  const { initial, busy, onSubmit, onCancel } = props;
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = cleanName(value);
    if (!v) {
      setError('Type a name, or press Escape to keep the old one.');
      inputRef.current?.focus();
      return;
    }
    if (v === initial) {
      onCancel();
      return;
    }
    void onSubmit(v).then((ok) => {
      if (!ok) inputRef.current?.focus();
    });
  };

  return (
    <form className={styles.rename} onSubmit={submit}>
      <label htmlFor={inputId} className="visually-hidden">
        New name for {quote(initial)}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        className={styles.renameInput}
        value={value}
        maxLength={NAME_MAX}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => {
          setValue(e.currentTarget.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className={styles.renameActions}>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" icon="check" disabled={busy}>
          {busy ? 'Saving…' : 'Save name'}
        </Button>
      </div>
      {error && (
        <p id={errorId} className={styles.renameError} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function TrashRow(props: {
  item: TrashSummary;
  now: number;
  confirming: boolean;
  busy: string | null;
  onRestore(): void;
  onPurgeAsk(): void;
  onPurgeConfirm(): void;
  onCancel(): void;
}) {
  const { item: t, now, confirming, busy } = props;
  const disabled = busy !== null;
  const nameId = `lib-trash-name-${t.id}`;
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);
  return (
    <li className={styles.row} data-trashed aria-labelledby={nameId}>
      <div className={styles.rowMain}>
        <div className={styles.rowText}>
          <div className={styles.rowTitle}>
            <span id={nameId} className={styles.rowName}>
              {t.name}
            </span>
          </div>
          <div className={styles.rowMeta}>Deleted {timeAgo(t.deletedAt, now)}</div>
        </div>
        <div className={styles.rowActions}>
          <Button size="sm" variant="secondary" icon="undo" onClick={props.onRestore} disabled={disabled} aria-label={`Restore ${t.name}`} aria-busy={busy === `restore:${t.id}` || undefined}>
            {busy === `restore:${t.id}` ? 'Restoring…' : 'Restore'}
          </Button>
          <Button id={`lib-purge-${t.id}`} size="sm" variant="ghost" className={styles.deleteButton} onClick={props.onPurgeAsk} disabled={disabled} aria-label={`Delete ${t.name} forever`} aria-expanded={confirming}>
            Delete forever
          </Button>
        </div>
      </div>
      {confirming && (
        <div className={styles.confirm} role="group" aria-label={`Delete ${t.name} forever?`}>
          <p className={styles.confirmText}>Delete {quote(t.name)} forever? This cannot be undone.</p>
          <div className={styles.confirmActions}>
            <Button ref={keepRef} size="sm" variant="ghost" onClick={props.onCancel}>
              Keep it
            </Button>
            <Button size="sm" variant="danger" icon="trash" onClick={props.onPurgeConfirm} disabled={disabled} aria-busy={busy === `purge:${t.id}` || undefined}>
              {busy === `purge:${t.id}` ? 'Deleting…' : 'Delete forever'}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
