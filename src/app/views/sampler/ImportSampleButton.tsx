/**
 * Import a WAV or MP3 from this device onto a part (it becomes a sampler).
 *
 * - `variant="button"`: a compact import key with the limits beside it.
 * - `variant="dropzone"`: a drop target for a file dragged from the desktop,
 *   with a Choose file key, the limits and how imports behave.
 *
 * The limits are shown before anything is chosen. The file is decoded and
 * stored locally by session.importSample; progress ("Decoding…") and the
 * result appear in a live status line. When an import fails, the message
 * says what to do and the project is left exactly as it was.
 */
import { useId, useRef, useState, type DragEvent } from 'react';
import { Button, Icon } from '../../../ui/components';
import { IMPORT_LIMITS } from '../../../persistence/audioImport';
import { useStore } from '../../../state/store';
import { useProject } from '../../instance';
import { notify, useRuntime } from '../../runtime';
import { clearImportStatus, importFileToPart, importStatusOf, importStore } from './importState';
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
const TAKE_LOCK_TEXT = 'A performance is recording, so the sound can’t change. Stop recording to import.';

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
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
  const disabled = busy || takeLocked;

  const importFile = (file: File | undefined) => {
    if (!file || disabled) return;
    void importFileToPart(file, trackId).then((res) => {
      // A successful import from the drop zone replaces it with the sampler editor,
      // so the result is also announced as a notice (the new status line appears silently).
      if (res.ok && variant === 'dropzone') notify(res.message, 'info');
    });
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
          <span className={styles.spinner} aria-hidden="true" />
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

  if (variant === 'button') {
    return (
      <div className={styles.inline}>
        {input}
        <div className={styles.inlineRow}>
          <Button
            icon="upload"
            size="sm"
            disabled={disabled}
            aria-describedby={`${statusId} ${hintId}`}
            onClick={() => fileRef.current?.click()}
            tip={`Import a WAV or MP3 from this device onto ${partName}. ${IMPORT_PITCH_TEXT}`}
            detail={`${IMPORT_LIMITS_TEXT} ${IMPORT_PRIVACY_TEXT}`}
          >
            {busy ? 'Decoding…' : 'Import WAV or MP3…'}
          </Button>
          {statusLine}
        </div>
        <p id={hintId} className={styles.fine}>
          {IMPORT_PRIVACY_TEXT} {IMPORT_PITCH_TEXT}
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
      <Button icon="folder" size="sm" disabled={disabled} aria-describedby={`${statusId} ${hintId}`} onClick={() => fileRef.current?.click()}>
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
      </ul>
      {statusLine}
    </div>
  );
}
