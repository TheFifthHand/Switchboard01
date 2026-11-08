/**
 * Project ▾ (Simple top bar, round 7): the project's name with its save state
 * in words under it; pressed, a small panel with everything about the
 * project as a whole:
 *
 * - My projects… (the project library) and New song… (its starters);
 * - Rename (in place: Enter keeps, Esc keeps the old name; one undo step);
 * - Save a copy to my computer (the .omnisong.zip project file);
 * - Speed: a slow ↔ fast slider (the tempo; Simple shows it in words, the
 *   BPM number is in Advanced's tempo box). One drag or key burst is one
 *   undo step; the mouse wheel never moves it;
 * - Mood: 2.4's mood words for the key's scale. Choosing one moves the
 *   song's notes into it (transposeSong, one undo step; drums stay, and
 *   recordings keep their pitch);
 * - the save state in words ("Saved in this browser"), with Try again when
 *   saving failed.
 *
 * A non-modal panel (the shared Popover): Esc or a press outside closes it,
 * and focus goes back to the project button.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button, Icon, Tooltip, newGestureId } from '../../../ui/components';
import { BPM_SPEC } from '../../../project/params';
import { SCALE_ORDER } from '../../../music/scales';
import type { ScaleId } from '../../../project/types';
import { renameProject, transposeSong } from '../../../state/commands';
import { session, useAutosave, useProject } from '../../instance';
import { notify, useRuntime } from '../../runtime';
import { Popover, anchorFromElement } from '../ClipMenu';
import { MOOD_WORD } from '../keyMood';
import { SCALES } from '../../../music/scales';
import styles from './ProjectMenu.module.css';

/** The moods Simple offers: every scale with a mood word ("Every note", chromatic, is not a mood). */
export const MOODS: readonly ScaleId[] = SCALE_ORDER.filter((s) => s !== 'chromatic');

/** A burst of Speed key presses ends this long after the last one (as the faders' bursts do). */
const SPEED_BURST_MS = 700;

/** The speed in words, slow to fast (Simple shows no BPM number). */
export function speedWord(bpm: number): string {
  if (bpm < 76) return 'Very slow';
  if (bpm < 96) return 'Slow';
  if (bpm < 116) return 'Medium';
  if (bpm < 136) return 'Lively';
  if (bpm < 161) return 'Fast';
  return 'Very fast';
}

export type SaveWord = { state: 'saved' | 'saving' | 'preview' | 'error'; short: string; long: string };

/** The save state in words: short under the name, long in the panel. */
export function useSaveWords(): SaveWord {
  const save = useAutosave();
  const preview = useRuntime((s) => s.preview);
  const error = save.status === 'error';
  const busy = !error && (save.status === 'saving' || save.dirty);
  if (error) return { state: 'error', short: 'Not saved', long: save.lastError?.message ?? 'Not saved: saving to this browser failed.' };
  if (save.readonly) return { state: 'error', short: 'Not saved', long: 'Not saved here: this project is open in another tab.' };
  if (busy) return { state: 'saving', short: 'Saving…', long: 'Saving in this browser…' };
  if (preview) return { state: 'preview', short: 'Not kept yet', long: 'Not kept yet: your first change keeps it in My projects.' };
  return { state: 'saved', short: 'Saved', long: 'Saved in this browser. It saves by itself as you go.' };
}

/** "Mood: moody minor" — choosing one moves the song into it. */
function chooseMood(scale: ScaleId): void {
  const p = session.store.getState();
  if (p.scale === scale) return;
  const r = transposeSong(session.store, { root: p.root, scale });
  if (!session.accepted(r)) return;
  const moved = r.notes > 0 ? ' The song’s notes moved to fit; drums stay as they are.' : '';
  notify(`Mood: ${MOOD_WORD[scale]}.${moved}`, 'info', 'undo');
}

function Speed() {
  const bpm = useProject((p) => p.bpm);
  const id = useId();
  const gesture = useRef<string | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const end = () => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = null;
    gesture.current = null;
  };
  // A drag, or a burst of key presses, is one undo step: it ends with the pointer, or SPEED_BURST_MS after the last key.
  const begin = () => {
    gesture.current ??= newGestureId('speed');
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(end, SPEED_BURST_MS);
  };
  useEffect(() => end, []);
  const word = speedWord(bpm);
  return (
    <div className={styles.speed}>
      <div className={styles.rowHead}>
        <label htmlFor={id} className={styles.label}>
          Speed
        </label>
        <span className={styles.value} aria-hidden="true">
          {word}
        </span>
      </div>
      <div className={styles.sliderRow}>
        <span className={styles.end} aria-hidden="true">
          Slow
        </span>
        <input
          id={id}
          type="range"
          className={styles.slider}
          min={BPM_SPEC.min}
          max={BPM_SPEC.max}
          step={1}
          value={Math.round(bpm)}
          aria-valuetext={word}
          onPointerDown={begin}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyDown={(e) => {
            // Arrow keys change it; the song's keys (Space, letters) are not for this field.
            if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') begin();
          }}
          onBlur={end}
          onChange={(e) => {
            begin();
            session.setBpm(Number(e.currentTarget.value), gesture.current ?? undefined);
          }}
        />
        <span className={styles.end} aria-hidden="true">
          Fast
        </span>
      </div>
    </div>
  );
}

function Mood() {
  const scale = useProject((p) => p.scale);
  return (
    <div className={styles.mood} role="group" aria-label="Mood">
      <div className={styles.rowHead}>
        <span className={styles.label}>Mood</span>
        <span className={styles.value}>{MOOD_WORD[scale]}</span>
      </div>
      <div className={styles.moods}>
        {MOODS.map((m) => (
          <button key={m} type="button" className={styles.moodKey} aria-pressed={m === scale} title={`${SCALES[m].name} scale`} onClick={() => chooseMood(m)}>
            {m === scale && <Icon name="check" size={12} />}
            {MOOD_WORD[m]}
          </button>
        ))}
      </div>
      <p className={styles.hint}>Changing the mood moves the notes to fit. Undo puts them back.</p>
    </div>
  );
}

function RenameField(props: { onDone(): void }) {
  const name = useProject((p) => p.name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = ref.current?.value.trim() ?? '';
    props.onDone();
    if (!keep || next === '' || next === name) return;
    if (session.accepted(renameProject(session.store, next))) notify(`Renamed to “${session.store.getState().name}”.`, 'info', 'undo');
  };
  return (
    <input
      ref={ref}
      className={styles.rename}
      defaultValue={name}
      maxLength={80}
      aria-label="Song name"
      spellCheck={false}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          // Esc here keeps the old name; the panel stays open.
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

export interface ProjectMenuProps {
  onOpenLibrary(): void;
  onNewProject(): void;
}

export function ProjectMenu(props: ProjectMenuProps) {
  const name = useProject((p) => p.name);
  const readonly = useAutosave().readonly ?? null;
  const saved = useSaveWords();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const renameRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setRenaming(false);
  };
  const then = (fn: () => void) => () => {
    close();
    fn();
  };
  // After renaming, the Rename key gets focus back.
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus) renameRef.current?.focus({ preventScroll: true });
  }, [refocus]);
  return (
    <>
      <Tooltip tip="Your song: its name, speed and mood, your other projects, and a new song." detail="It saves by itself in this browser as you go.">
        <button
          ref={btnRef}
          type="button"
          className={styles.trigger}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Project: ${name}. ${saved.short}`}
          data-save={saved.state}
          onClick={() => (open ? close() : setOpen(true))}
        >
          <span className={styles.name}>{name}</span>
          <span className={styles.saveWord} aria-hidden="true">
            {saved.state === 'error' ? <Icon name="warning" size={11} /> : saved.state === 'saved' ? <Icon name="check" size={11} /> : null}
            {saved.short}
          </span>
          <Icon name="chevronDown" size={14} className={styles.caret} />
        </button>
      </Tooltip>
      {open && (
        <Popover anchor={anchorFromElement(btnRef.current)} label="Project" role="dialog" align="start" onClose={close} returnFocus={btnRef.current} ignore={btnRef.current} className={styles.panel}>
          <div className={styles.head}>
            {renaming ? (
              <RenameField
                onDone={() => {
                  setRenaming(false);
                  setRefocus((n) => n + 1);
                }}
              />
            ) : (
              <p className={styles.title}>{name}</p>
            )}
            <p className={styles.saveLine} data-save={saved.state} role="status">
              {saved.long}
            </p>
            {saved.state === 'error' && !readonly && (
              <Button size="sm" variant="secondary" onClick={() => void session.autosaver?.retry()}>
                Try again
              </Button>
            )}
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.item} onClick={then(props.onOpenLibrary)} data-autofocus="">
              <Icon name="folder" size={14} />
              My projects…
            </button>
            <button type="button" className={styles.item} onClick={then(props.onNewProject)}>
              <Icon name="plus" size={14} />
              New song…
            </button>
            <button
              ref={renameRef}
              type="button"
              className={styles.item}
              aria-disabled={readonly ? true : undefined}
              onClick={() => {
                if (readonly) notify('This project is open in another tab: rename it there, or take over here first.', 'warn');
                else setRenaming(true);
              }}
            >
              <Icon name="pencil" size={14} />
              Rename
            </button>
            <button type="button" className={styles.item} onClick={then(() => window.dispatchEvent(new CustomEvent('sb:export-project')))}>
              <Icon name="download" size={14} />
              Save a copy to my computer
            </button>
          </div>
          <Speed />
          <Mood />
        </Popover>
      )}
    </>
  );
}
