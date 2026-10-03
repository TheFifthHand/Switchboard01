/**
 * Import a WAV or MP3 from this device onto a part, as a new clip that plays
 * it (shape-05; a part that is not a sampler becomes one).
 *
 * - `variant="button"`: a compact import key with the limits beside it.
 * - `variant="dropzone"`: a drop target for a file dragged from the desktop,
 *   with a Choose file key, the limits and how imports behave.
 *
 * The limits are shown before anything is chosen. A chosen file is checked
 * first (importState.chooseFileForPart): a part with no empty pad says why
 * at once; a drum or synth part with clips asks first (ImportConfirm), and
 * offers a sampler part with room instead. The file is decoded and stored
 * locally by session.importSample; progress ("Decoding…") and the result
 * appear in a live status line, and the result in the toast with Undo. When
 * an import fails, the message says what to do and the project is left
 * exactly as it was.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Button, Icon } from '../../../ui/components';
import { IMPORT_LIMITS } from '../../../persistence/audioImport';
import type { Id } from '../../../project/types';
import { useStore } from '../../../state/store';
import { useProject } from '../../instance';
import { useRuntime } from '../../runtime';
import { chooseFileForPart, clearImportStatus, importStatusOf, importStore, resolveImport } from './importState';
import styles from './ImportSampleButton.module.css';

export interface ImportSampleButtonProps {
  trackId: string;
  variant?: 'button' | 'dropzone';
}

/** File types offered by the file picker. */
export const IMPORT_ACCEPT = '.wav,.mp3,audio/wav,audio/mpeg';

const MB = 1024 * 1024;
/** "WAV or MP3, up to 50 MB and 60 seconds." — from the real import limits. */
export const IMPORT_LIMITS_TEXT = `WAV or MP3, up to ${Math.round(IMPORT_LIMITS.maxBytes / MB)} MB and ${IMPORT_LIMITS.maxSeconds} seconds.`;
export const IMPORT_PRIVACY_TEXT = 'Files stay on this device: decoded and kept in this browser, never uploaded.';
export const IMPORT_PITCH_TEXT = 'Imported recordings keep their pitch unless you change Pitch.';
/** What an import makes. */
export const IMPORT_CLIP_TEXT = 'Each import gets its own clip on an empty pad; other clips keep their recordings.';
const TAKE_LOCK_TEXT = 'A performance is recording, so the sound can’t change. Stop recording to import.';

function hasFiles(e: { dataTransfer: DataTransfer | null }): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/**
 * While a drop zone is on screen, a file released just outside it must not make the browser
 * open that file in place of the app. Drops the zone handles are already default-prevented.
 */
function useNearMissGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const guard = (e: globalThis.DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e)) return;
      e.preventDefault();
      if (e.type === 'dragover' && e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, [active]);
}

export function ImportSampleButton({ trackId, variant = 'button' }: ImportSampleButtonProps) {
  const status = useStore(importStore, (s) => importStatusOf(s, trackId));
  const takeLocked = useRuntime((s) => s.recording === 'performance');
  const partName = useProject((p) => p.tracks.find((t) => t.id === trackId)?.name ?? 'this part');
  const fileRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const statusId = useId();
  const hintId = useId();
  const busy = status.phase === 'decoding';
  const disabled = busy || takeLocked || status.phase === 'confirm';
  useNearMissGuard(variant === 'dropzone');

  // The result is also in the toast (with Undo): a successful import from the drop zone replaces it
  // with the sampler editor, whose status line appears silently.
  const importFile = (file: File | undefined) => {
    if (!file || disabled) return;
    void chooseFileForPart(file, trackId);
  };

  // While decoding, the key keeps keyboard focus (aria-disabled) but opens nothing.
  const choose = () => {
    if (!disabled) fileRef.current?.click();
  };

  const input = (
    <input
      ref={fileRef}
      type="file"
      accept={IMPORT_ACCEPT}
      className="visually-hidden"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = '';
        importFile(file);
      }}
    />
  );

  const lockedIdle = takeLocked && status.phase === 'idle';
  const tone = status.phase === 'done' ? (status.ok ? 'ok' : 'error') : lockedIdle ? 'error' : status.phase;
  const statusLine = (
    <div id={statusId} className={styles.status} role="status" aria-live="polite" data-tone={tone}>
      {lockedIdle && (
        <>
          <Icon name="warning" size={14} className={styles.statusIcon} />
          <span className={styles.statusText}>{TAKE_LOCK_TEXT}</span>
        </>
      )}
      {status.phase === 'decoding' && (
        <>
          <span className={styles.spinner} aria-hidden="true">
            <span className={styles.spinnerWord}>Loading…</span>
          </span>
          <span className={styles.statusText}>Decoding “{status.fileName}” on this device…</span>
        </>
      )}
      {status.phase === 'done' && (
        <>
          <Icon name={status.ok ? 'check' : 'warning'} size={14} className={styles.statusIcon} />
          <span className={styles.statusText}>
            {status.ok ? '' : <span className="visually-hidden">Import failed: </span>}
            {status.message}
          </span>
          <button type="button" className={styles.dismiss} aria-label="Dismiss import message" onClick={() => clearImportStatus(trackId)}>
            <Icon name="close" size={12} />
          </button>
        </>
      )}
      {status.phase === 'idle' && !takeLocked && variant === 'button' && <span className={styles.statusText}>{IMPORT_LIMITS_TEXT}</span>}
    </div>
  );
  const confirm = <ImportConfirm trackId={trackId} />;

  if (variant === 'button') {
    return (
      <div className={styles.inline}>
        {input}
        <div className={styles.inlineRow}>
          <Button
            icon="upload"
            size="sm"
            disabled={takeLocked}
            aria-disabled={busy || undefined}
            className={busy ? styles.busy : undefined}
            aria-describedby={`${statusId} ${hintId}`}
            onClick={choose}
            tip={`Import a WAV or MP3 from this device onto ${partName}. ${IMPORT_PITCH_TEXT}`}
            detail={`${IMPORT_LIMITS_TEXT} ${IMPORT_PRIVACY_TEXT}`}
          >
            {busy ? 'Decoding…' : 'Import WAV or MP3…'}
          </Button>
          {statusLine}
        </div>
        {confirm}
        <p id={hintId} className={styles.fine}>
          {IMPORT_CLIP_TEXT} {IMPORT_PRIVACY_TEXT} {IMPORT_PITCH_TEXT}
        </p>
      </div>
    );
  }

  return (
    <div
      className={styles.zone}
      data-over={over || undefined}
      data-disabled={disabled || undefined}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        const to = e.relatedTarget as Node | null;
        if (to && e.currentTarget.contains(to)) return;
        setOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(false);
        importFile(e.dataTransfer.files[0]);
      }}
    >
      {input}
      <span className={styles.zoneIcon} aria-hidden="true">
        <Icon name="upload" size={18} />
      </span>
      <p className={styles.zoneTitle}>{over ? 'Release to import' : 'Drop a WAV or MP3 here'}</p>
      <Button
        icon="folder"
        size="sm"
        disabled={takeLocked}
        aria-disabled={busy || undefined}
        className={busy ? styles.busy : undefined}
        aria-describedby={`${statusId} ${hintId}`}
        onClick={choose}
      >
        {busy ? 'Decoding…' : 'Choose file…'}
      </Button>
      <p className={styles.limits}>{IMPORT_LIMITS_TEXT}</p>
      <ul id={hintId} className={styles.facts}>
        <li>
          <Icon name="lock" size={12} className={styles.factIcon} />
          {IMPORT_PRIVACY_TEXT}
        </li>
        <li>
          <Icon name="wave" size={12} className={styles.factIcon} />
          {IMPORT_PITCH_TEXT}
        </li>
        <li>
          <Icon name="layers" size={12} className={styles.factIcon} />
          {IMPORT_CLIP_TEXT}
        </li>
      </ul>
      {statusLine}
      {confirm}
    </div>
  );
}

/**
 * A file waiting for a choice (a drum or synth part with clips): what the
 * import would do to them, and the ways on. Renders nothing otherwise.
 */
export function ImportConfirm(props: { trackId: Id; className?: string }) {
  const { trackId, className } = props;
  const status = useStore(importStore, (s) => importStatusOf(s, trackId));
  const partName = useProject((p) => p.tracks.find((t) => t.id === trackId)?.name ?? 'this part');
  const titleId = useId();
  const firstRef = useRef<HTMLButtonElement>(null);
  const waiting = status.phase === 'confirm';
  // The choice takes keyboard focus as it appears (the file chooser or the drop left it nowhere useful).
  useEffect(() => {
    if (waiting) firstRef.current?.focus({ preventScroll: true });
  }, [waiting]);
  if (status.phase !== 'confirm') return null;
  const alt = status.alternative;
  return (
    <div className={[styles.confirm, className].filter(Boolean).join(' ')} role="group" aria-labelledby={titleId}>
      <p id={titleId} className={styles.confirmText}>
        <Icon name="warning" size={14} className={styles.confirmIcon} />
        <span>
          <strong>Import “{status.fileName}” onto {partName}?</strong> {status.message}
        </span>
      </p>
      <div className={styles.confirmKeys}>
        {alt && (
          <Button ref={firstRef} size="sm" variant="primary" icon="upload" onClick={() => void resolveImport(trackId, 'alternative')} tip={`Puts the recording in a new clip on ${alt.name}, a sampler part with an empty pad. ${partName} stays as it is.`}>
            Put it on {alt.name} instead
          </Button>
        )}
        <Button ref={alt ? undefined : firstRef} size="sm" variant={alt ? 'secondary' : 'primary'} onClick={() => void resolveImport(trackId, 'here')} tip={`Makes ${partName} a sampler with the recording in a new clip. Undo brings its sound back.`}>
          Import onto {partName} anyway
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void resolveImport(trackId, 'cancel')} tip="Nothing is imported.">
          Cancel
        </Button>
      </div>
    </div>
  );
}
