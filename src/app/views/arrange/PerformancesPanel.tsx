/**
 * Performances: recorded takes as a list (newest first) with Replay, Export,
 * Make song blocks, Delete and inline rename, and each take's editable events.
 *
 * - The panel folds to one line, with takes too ("2 takes ▸", the newest take
 *   and its Replay), so the song keeps the room; the choice is remembered.
 *   Until it is chosen, the panel is open only where the window has height to
 *   spare (the Arrange view decides).
 * - A take's events open in a tall side drawer beside the take list, with a
 *   sticky header (Replay, Export, Make song blocks, close); the song folds to
 *   its header row meanwhile. The drawer and the list keep the "Try this"
 *   chip off them (data-hint-avoid).
 * - Replay uses the take's snapshot and events (session.replayPerformance);
 *   the replaying row shows its real progress read from the transport.
 * - The event list shows the music's bar.beat.step (where the transport was,
 *   so a launch on a downbeat reads "5.1.1"), the kind of action and what it
 *   did in words. Every edit is an undoable command: delete an event (a
 *   note's press and release go together), change the value of a knob,
 *   macro, tempo, swing or volume change, start the take later or end it
 *   earlier (at a row, or at a typed position).
 * - Make song blocks turns the take's scene and pad launches into blocks after
 *   the song (one Undo); the toast says what was rounded and left out.
 * - Long takes render the first rows and grow on "Show more".
 */
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Icon, Led, Tooltip, parseParamInput, useRafLoop } from '../../../ui/components';
import { formatParam, type ParamSpec } from '../../../project/params';
import type { Id, Performance } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { setView } from '../../../state/uiStore';
import { session, useProject } from '../../instance';
import { notify, useRuntime } from '../../runtime';
import { formatSeconds } from '../../session';
import { eventCounts, formatPosition, parsePosition, performanceRows, performanceSeconds, takeTempoMap, type EventKind, type EventRow } from './perfEvents';
import * as act from './songActions';
import styles from './PerformancesPanel.module.css';

/** Rows shown when a take is opened, and how many more each "Show more" adds. */
export const EVENT_PAGE = 60;
export const EVENT_MORE = 120;

const KIND_TONE: Record<EventKind, 'amber' | 'teal' | 'coral' | 'neutral'> = {
  Launch: 'amber',
  Scene: 'amber',
  Note: 'amber',
  Macro: 'teal',
  Knob: 'teal',
  Mute: 'coral',
  Tempo: 'neutral',
  Swing: 'neutral',
  Master: 'neutral',
};

function formatCreated(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${d.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })} ${time}`;
}

/** "1.4 s" under a minute, "2:17" above (same style as the export dialog). */
function lengthText(s: number): string {
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s - m * 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Inline rename                                                       */
/* ------------------------------------------------------------------ */

function TakeName(props: { perf: Performance }) {
  const { perf } = props;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(perf.name);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  const errorId = useId();

  useLayoutEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const start = () => {
    done.current = false;
    setValue(perf.name);
    setError(null);
    setEditing(true);
  };
  const finish = (commit: boolean) => {
    if (done.current) return;
    const v = value.replace(/\s+/g, ' ').trim();
    if (commit && v && v !== perf.name) {
      if (!session.accepted(cmd.renamePerformance(session.store, perf.id, v))) return;
    }
    if (commit && !v) {
      setError('Type a name, or press Escape to keep the old one.');
      return;
    }
    done.current = true;
    setEditing(false);
    requestAnimationFrame(() => buttonRef.current?.focus({ preventScroll: true }));
  };

  if (editing) {
    return (
      <span className={styles.renameWrap}>
        <input
          ref={inputRef}
          className={styles.renameInput}
          value={value}
          maxLength={80}
          spellCheck={false}
          autoComplete="off"
          aria-label={`Name of ${perf.name}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setValue(e.currentTarget.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              finish(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              finish(false);
            }
          }}
          onBlur={() => {
            // Leaving the field keeps a valid name and drops an empty one.
            if (value.trim()) finish(true);
            else finish(false);
          }}
        />
        {error && (
          <span id={errorId} className={styles.renameError} role="alert">
            {error}
          </span>
        )}
      </span>
    );
  }
  return (
    <Tooltip tip="Click to rename this take." detail="F2 on a focused name also renames.">
      <button
        ref={buttonRef}
        type="button"
        className={styles.name}
        aria-label={`${perf.name}. Rename`}
        onClick={start}
        onKeyDown={(e) => {
          if (e.key === 'F2') {
            e.preventDefault();
            start();
          }
        }}
      >
        {perf.name}
      </button>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/* Replay progress                                                     */
/* ------------------------------------------------------------------ */

function ReplayProgress(props: { perf: Performance; seconds: number }) {
  const { perf, seconds } = props;
  const barRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const last = useRef('');
  // Elapsed time follows the take's recorded tempo changes, like its length.
  const tempo = useMemo(() => takeTempoMap(perf), [perf]);
  useRafLoop(() => {
    const t = session.transport;
    if (!t) return;
    const tick = Math.min(perf.endTick, Math.max(perf.startTick, t.getPosition().tick));
    const elapsed = Math.min(seconds, Math.max(0, tempo.timeAt(tick)));
    const f = seconds > 0 ? elapsed / seconds : 0;
    if (barRef.current) barRef.current.style.transform = `scaleX(${f.toFixed(4)})`;
    const text = `${lengthText(elapsed)} / ${lengthText(seconds)}`;
    if (textRef.current && text !== last.current) {
      last.current = text;
      textRef.current.textContent = text;
    }
  }, true);
  return (
    <>
      <span ref={textRef} className={`${styles.replayTime} mono`}>
        {`${lengthText(0)} / ${lengthText(seconds)}`}
      </span>
      <span className={styles.progress} aria-hidden="true">
        <span ref={barRef} className={styles.progressFill} />
      </span>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Event list                                                          */
/* ------------------------------------------------------------------ */

/**
 * Inline text entry used to change a recorded value and the take's end.
 * Enter applies (a refusal keeps the field open with the reason), Escape
 * cancels, leaving the field applies a valid entry and drops an invalid one.
 */
function InlineEntry(props: { label: string; initial: string; className?: string; chars: number; onApply(text: string): string | null; onClose(refocus: boolean): void }) {
  const { label, initial, className, chars, onApply, onClose } = props;
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const errorId = useId();

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (apply: boolean, keepOpenOnError: boolean) => {
    if (done.current) return;
    if (apply && value.trim() !== initial.trim()) {
      const why = onApply(value);
      if (why && keepOpenOnError) {
        setError(why);
        return;
      }
    }
    done.current = true;
    // Enter and Escape hand focus back to the control that opened the entry; a click elsewhere keeps its focus.
    onClose(keepOpenOnError || !apply);
  };

  return (
    <span className={[styles.entry, className].filter(Boolean).join(' ')}>
      <input
        ref={inputRef}
        className={`${styles.entryInput} mono`}
        style={{ width: `${chars + 2}ch` }}
        value={value}
        maxLength={24}
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => {
          setValue(e.currentTarget.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true, true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false, false);
          }
        }}
        onBlur={() => finish(true, false)}
      />
      {error && (
        <span id={errorId} className={styles.entryError} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** A row's value that can be edited: its range and its current value. */
interface EditableValue {
  spec: ParamSpec;
  value: number;
}

type EventCol = 'value' | 'end' | 'del';

/** "1 recorded action", "3 recorded actions". */
const actionsText = (n: number) => `${n} recorded ${n === 1 ? 'action' : 'actions'}`;

/** Shorten a take to end at `endTick` (one undo step) and say what went. */
function trimTake(perf: Performance, rows: readonly EventRow[], endTick: number, at: string): boolean {
  const removed = rows.filter((r) => r.tick >= endTick).length;
  if (!session.accepted(cmd.trimPerformance(session.store, perf.id, endTick))) return false;
  notify(`${perf.name} now ends at ${at}${removed ? `; ${actionsText(removed)} from there on removed` : ''}.`, 'info', 'undo');
  return true;
}

/** Start a take later, at `tick` (one undo step); what happened before becomes its starting state. */
function startTakeAt(perf: Performance, rows: readonly EventRow[], tick: number, at: string): boolean {
  const before = rows.filter((r) => r.tick < tick).length;
  if (!session.accepted(cmd.trimTakeStart(session.store, perf.id, tick))) return false;
  notify(`${perf.name} now starts at ${at}${before ? `; the ${actionsText(before)} before it became its starting state` : ''}.`, 'info', 'undo');
  return true;
}

/** Where the take starts and ends (the music's bar.beat.step), with entries to start it later and end it earlier. */
function TakeBounds(props: { perf: Performance; rows: readonly EventRow[] }) {
  const { perf, rows } = props;
  const [editing, setEditing] = useState<'start' | 'end' | null>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLButtonElement>(null);
  const startText = formatPosition(perf.startTick);
  const endText = formatPosition(perf.endTick);
  const close = (which: 'start' | 'end') => (refocus: boolean) => {
    setEditing(null);
    if (refocus) requestAnimationFrame(() => (which === 'start' ? startRef : endRef).current?.focus({ preventScroll: true }));
  };
  const help = `Type a bar.beat.step after ${startText} and before ${endText}.`;
  const applyEnd = (text: string): string | null => {
    const tick = parsePosition(text);
    if (tick === null || tick <= perf.startTick || tick >= perf.endTick) return help;
    trimTake(perf, rows, tick, formatPosition(tick));
    return null;
  };
  const applyStart = (text: string): string | null => {
    const tick = parsePosition(text);
    if (tick === null || tick <= perf.startTick || tick >= perf.endTick) return help;
    startTakeAt(perf, rows, tick, formatPosition(tick));
    return null;
  };
  return (
    <div className={styles.endLine} data-testid="take-bounds">
      <span className={styles.endText}>
        Starts at <span className="mono">{startText}</span>
      </span>
      {editing === 'start' ? (
        <>
          <InlineEntry label={`New start of ${perf.name}, as bar.beat.step`} initial={startText} chars={8} onApply={applyStart} onClose={close('start')} />
          <span className={styles.endHint}>Enter starts the take there; what happened before becomes its starting state. Esc cancels.</span>
        </>
      ) : (
        <Button ref={startRef} size="sm" variant="ghost" icon="chevronRight" data-take-start="" onClick={() => setEditing('start')} tip="Start the take later: type where it should begin. What happened before (pads playing, knob positions) becomes its starting state; Undo brings it back.">
          Start later…
        </Button>
      )}
      <span className={styles.endText}>
        Ends at <span className="mono">{endText}</span>
      </span>
      {editing === 'end' ? (
        <>
          <InlineEntry label={`New end of ${perf.name}, as bar.beat.step`} initial={endText} chars={8} onApply={applyEnd} onClose={close('end')} />
          <span className={styles.endHint}>Enter shortens the take; actions from that point on are removed. Esc cancels.</span>
        </>
      ) : (
        <Button ref={endRef} size="sm" variant="ghost" icon="stop" data-take-end="" onClick={() => setEditing('end')} tip="End the take earlier: type where it should stop. Actions from that point on are removed; Undo brings them back.">
          End earlier…
        </Button>
      )}
    </div>
  );
}

function EventList(props: { perf: Performance; replaying: boolean; listId: string }) {
  const { perf, replaying, listId } = props;
  const rows = useMemo(() => performanceRows(perf), [perf]);
  // Knob, macro, tempo, swing and volume changes carry a value that can be changed.
  const editable = useMemo(() => {
    const out = new Map<number, EditableValue>();
    for (const r of rows) {
      const e = perf.events[r.index];
      const spec = e ? cmd.performanceEventSpec(perf, e) : null;
      const value = e ? cmd.performanceEventValue(e) : null;
      if (spec && value !== null) out.set(r.index, { spec, value });
    }
    return out;
  }, [rows, perf]);
  const [limit, setLimit] = useState(EVENT_PAGE);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ row: number; col: EventCol } | null>(null);
  const shown = rows.length > limit ? rows.slice(0, limit) : rows;
  const activeIndex = Math.min(active, Math.max(0, shown.length - 1));

  useLayoutEffect(() => {
    const f = pendingFocus.current;
    if (f === null) return;
    pendingFocus.current = null;
    const rowEls = bodyRef.current?.querySelectorAll<HTMLElement>('[role="row"]');
    if (!rowEls || rowEls.length === 0) {
      // The last action went: keep focus in this take, on its end control.
      listRef.current?.querySelector<HTMLButtonElement>('[data-take-end]')?.focus({ preventScroll: true });
      return;
    }
    const row = rowEls[Math.min(f.row, rowEls.length - 1)];
    const target = row.querySelector<HTMLButtonElement>(`[data-evcol="${f.col}"]:not(:disabled)`) ?? row.querySelector<HTMLButtonElement>('[data-evcol="del"]');
    target?.focus({ preventScroll: false });
  });

  const remove = (row: EventRow, at: number) => {
    const r = cmd.deletePerformanceEvent(session.store, perf.id, row.index);
    if (!session.accepted(r)) return;
    const what = row.kind === 'Note' && row.pairIndex !== undefined ? `the note at ${row.time} (its press and release)` : `the ${row.kind.toLowerCase()} event at ${row.time}`;
    notify(`Deleted ${what} from ${perf.name}.`, 'info', 'undo');
    setActive(at);
    pendingFocus.current = { row: at, col: 'del' };
  };

  const endHere = (row: EventRow, at: number) => {
    if (!trimTake(perf, rows, row.tick, row.time)) return;
    const next = Math.max(0, at - 1);
    setActive(next);
    pendingFocus.current = { row: next, col: 'end' };
  };

  const applyValue = (row: EventRow, text: string): string | null => {
    const ed = editable.get(row.index);
    if (!ed) return null;
    const { spec } = ed;
    const v = parseParamInput(spec, text, ed.value);
    if (v === null) return `Type a value from ${formatParam(spec, spec.min)} to ${formatParam(spec, spec.max)}.`;
    const r = cmd.setPerformanceEventValue(session.store, perf.id, row.index, v);
    if (r.changed) notify(`Changed ${spec.label} at ${row.time} in ${perf.name} to ${formatParam(spec, v)}.`, 'info', 'undo');
    else if (r.refused || r.message) return r.refused ?? r.message ?? null;
    return null;
  };

  const closeValue = (at: number, refocus: boolean) => {
    setEditing(null);
    setActive(at);
    if (refocus) pendingFocus.current = { row: at, col: 'value' };
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const col = t.dataset.evcol as EventCol | undefined;
    if (!col) return;
    const i = Number(t.dataset.evrow);
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(shown.length - 1, i + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = shown.length - 1;
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const row = shown[i];
      if (row) remove(row, i);
      return;
    } else if (e.key === 'F2' && col === 'value') {
      e.preventDefault();
      const row = shown[i];
      if (row) setEditing(row.index);
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    setActive(next);
    pendingFocus.current = { row: next, col };
  };

  const counts = eventCounts(perf);
  const notes = counts.find((c) => c.key === 'note');

  return (
    <div ref={listRef} id={listId} className={styles.events}>
      <p className={styles.eventsHint}>
        Times are the music’s <span className="mono">bar.beat.step</span>. Click a knob, macro, tempo, swing or volume value to change it.{notes ? ' Deleting a note removes its press and release together.' : ''} Undo brings back anything you change.
        {replaying && <strong className={styles.replayNote}> Edits apply the next time you replay this take.</strong>}
      </p>
      {rows.length === 0 ? (
        <p className={styles.noEvents}>No recorded actions. Replay plays the clips that were running when the take started, for {formatSeconds(performanceSeconds(perf))}.</p>
      ) : (
        <div className={styles.table} role="table" aria-label={`Events of ${perf.name}`} aria-rowcount={rows.length + 1}>
          <div className={styles.headRow} role="row">
            <span role="columnheader">Time</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">What happened</span>
            <span role="columnheader">
              <span className="visually-hidden">Actions</span>
            </span>
          </div>
          <div ref={bodyRef} role="rowgroup" onKeyDown={onKeyDown}>
            {shown.map((r, i) => {
              const ed = editable.get(r.index);
              const tab = i === activeIndex ? 0 : -1;
              const canEnd = r.tick > perf.startTick && r.tick < perf.endTick;
              return (
                <div key={`${r.index}:${r.tick}:${r.kind}`} className={styles.row} role="row" aria-rowindex={i + 2} data-editing={editing === r.index || undefined}>
                  <span role="cell" className={`${styles.time} mono`}>
                    {r.time}
                  </span>
                  <span role="cell" className={styles.kind} data-tone={KIND_TONE[r.kind]}>
                    <span className={styles.kindDot} aria-hidden="true" />
                    {r.kind}
                  </span>
                  <span role="cell" className={styles.detail} data-value={ed ? '' : undefined} title={editing === r.index ? undefined : r.detail}>
                    {ed && editing === r.index ? (
                      <InlineEntry
                        label={`New ${ed.spec.label} value at ${r.time}`}
                        initial={formatParam(ed.spec, ed.value)}
                        chars={10}
                        onApply={(text) => applyValue(r, text)}
                        onClose={(refocus) => closeValue(i, refocus)}
                      />
                    ) : ed ? (
                      <Tooltip tip="Click to change the recorded value (F2 on a focused value too)." detail={`${ed.spec.label}: ${formatParam(ed.spec, ed.spec.min)} to ${formatParam(ed.spec, ed.spec.max)}.`}>
                        <button
                          type="button"
                          className={styles.valueButton}
                          data-evrow={i}
                          data-evcol="value"
                          tabIndex={tab}
                          aria-label={`Change the value: ${r.detail}, at ${r.time}`}
                          onClick={() => setEditing(r.index)}
                          onFocus={() => setActive(i)}
                        >
                          {r.detail}
                        </button>
                      </Tooltip>
                    ) : (
                      r.detail
                    )}
                  </span>
                  <span role="cell" className={styles.actionCell}>
                    <Tooltip name="End take here" tip="The take ends here: this action and everything after it are removed. Undo brings them back.">
                      <button
                        type="button"
                        className={styles.rowAction}
                        data-evrow={i}
                        data-evcol="end"
                        tabIndex={tab}
                        disabled={!canEnd}
                        aria-label={`End ${perf.name} at ${r.time}, removing this ${r.kind.toLowerCase()} and everything after it`}
                        onClick={() => endHere(r, i)}
                        onFocus={() => setActive(i)}
                      >
                        <Icon name="stop" size={12} />
                      </button>
                    </Tooltip>
                    <button
                      type="button"
                      className={styles.del}
                      data-evrow={i}
                      data-evcol="del"
                      tabIndex={tab}
                      aria-label={`Delete ${r.kind.toLowerCase()} at ${r.time}: ${r.detail}${r.kind === 'Note' && r.pairIndex !== undefined ? ' (press and release)' : ''}`}
                      onClick={() => remove(r, i)}
                      onFocus={() => setActive(i)}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {rows.length > limit && (
        <div className={styles.more}>
          <span>
            Showing {limit} of {rows.length} events
          </span>
          <Button size="sm" variant="secondary" icon="chevronDown" onClick={() => setLimit((l) => l + EVENT_MORE)}>
            Show {Math.min(EVENT_MORE, rows.length - limit)} more
          </Button>
        </div>
      )}
      <TakeBounds perf={perf} rows={rows} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

/** How many song blocks Make song blocks would add from a take (0: it makes none). */
function useTakeBlockCount(perf: Performance): number {
  return useProject((p) => (p.performances.some((x) => x.id === perf.id) ? (cmd.takeToBlocks(p, perf.id)?.blocks.length ?? 0) : 0));
}

/** Make song blocks from a take; the lane selects them (it is told by an event, as it may be folded away). */
function makeSongBlocks(perf: Performance): boolean {
  const r = act.songFromTake(perf.id);
  if (!r) return false;
  window.dispatchEvent(new CustomEvent('omni:song-blocks', { detail: { ids: r.ids } }));
  return true;
}

function MakeBlocksButton(props: { perf: Performance; compact?: boolean; onDone?(): void }) {
  const { perf, compact, onDone } = props;
  const n = useTakeBlockCount(perf);
  const locked = useRuntime((s) => s.recording === 'performance');
  const why = locked ? 'The song is locked while a take records.' : n === 0 ? 'Nothing in this take plays a scene long enough to fill a block.' : null;
  return (
    <Button
      size="sm"
      variant="secondary"
      icon="plus"
      aria-disabled={why !== null || undefined}
      aria-label={`Make song blocks from ${perf.name}`}
      data-make-blocks=""
      onClick={() => {
        if (why) {
          notify(why, 'warn');
          return;
        }
        if (makeSongBlocks(perf)) onDone?.();
      }}
      tip={why ?? `Adds ${n === 1 ? '1 block' : `${n} blocks`} after the song: one for each stretch between the take’s scene and pad launches.`}
      detail="Rounded to whole passes of each scene. Played notes and knob moves stay in the take: blocks hold only scenes and parts."
    >
      {compact ? 'Song blocks' : 'Make song blocks'}
    </Button>
  );
}

function ReplayButton(props: { perf: Performance; replaying: boolean }) {
  const { perf, replaying } = props;
  return replaying ? (
    <Button size="sm" variant="secondary" icon="stop" pressed onClick={() => session.stop()} aria-label={`Stop replaying ${perf.name}`} tip="Stop the replay. Your pads take over again on the next Play.">
      Stop
    </Button>
  ) : (
    <Button size="sm" variant="secondary" icon="play" onClick={() => void session.replayPerformance(perf.id)} aria-label={`Replay ${perf.name}`} tip="Play the take back exactly as recorded: launches, notes and knob moves." detail="Uses the sounds and routing captured when the take started. Pads and keys are ignored while it replays. Starting a replay ends a take that is recording.">
      Replay
    </Button>
  );
}

function ExportButton({ perf }: { perf: Performance }) {
  return (
    <Button
      size="sm"
      variant="secondary"
      icon="download"
      onClick={() => window.dispatchEvent(new CustomEvent('sb:open-export', { detail: { source: `perf:${perf.id}` } }))}
      aria-label={`Export ${perf.name} as WAV`}
      tip="Render this take to a WAV file with the same sounds and timing."
    >
      Export
    </Button>
  );
}

const TakeRow = memo(function TakeRow(props: { perf: Performance; open: boolean; compact: boolean; replaying: boolean; onToggle(id: Id): void }) {
  const { perf, open, compact, replaying, onToggle } = props;
  const seconds = useMemo(() => performanceSeconds(perf), [perf]);
  const counts = useMemo(() => eventCounts(perf), [perf]);
  const countsText = counts.length ? counts.map((c) => c.text).join(' · ') : 'No recorded actions';

  const del = () => {
    if (replaying) session.stop();
    if (session.accepted(cmd.deletePerformance(session.store, perf.id))) notify(`Deleted “${perf.name}”.`, 'info', 'undo');
  };

  return (
    <li className={styles.take} data-replaying={replaying || undefined} data-expanded={open || undefined} data-compact={compact || undefined}>
      <div className={styles.takeHead}>
        <button
          type="button"
          className={styles.expand}
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} the events of ${perf.name}`}
          onClick={() => onToggle(perf.id)}
        >
          <Icon name={open ? 'chevronLeft' : 'chevronRight'} size={14} />
        </button>
        <div className={styles.identity}>
          <TakeName perf={perf} />
          <span className={styles.meta}>
            <span>{formatCreated(perf.createdAt)}</span>
            <span aria-hidden="true">·</span>
            <span className="mono" aria-label={`Length ${lengthText(seconds)}`}>
              {lengthText(seconds)}
            </span>
          </span>
        </div>
        {!compact && (
          <div className={styles.counts} title={countsText}>
            {replaying ? (
              <span className={styles.replaying}>
                <Led on tone="amber" label="Replaying" size="sm" />
                <ReplayProgress perf={perf} seconds={seconds} />
              </span>
            ) : (
              <span className={styles.countsText}>{countsText}</span>
            )}
          </div>
        )}
        <div className={styles.actions}>
          {(!compact || replaying) && <ReplayButton perf={perf} replaying={replaying} />}
          {!compact && <ExportButton perf={perf} />}
          {!compact && <MakeBlocksButton perf={perf} />}
          <Tooltip name="Delete take" tip="Remove this performance from the project. Undo brings it back.">
            <button type="button" className={styles.remove} aria-label={`Delete ${perf.name}`} onClick={del}>
              <Icon name="trash" size={14} />
            </button>
          </Tooltip>
        </div>
      </div>
    </li>
  );
});

/* ------------------------------------------------------------------ */
/* The take drawer                                                     */
/* ------------------------------------------------------------------ */

/**
 * A take's events in a tall side drawer: its header stays at the top
 * (Replay, Export, Make song blocks, close) while the events scroll under it.
 */
function TakeDrawer(props: { perf: Performance; replaying: boolean; onClose(): void }) {
  const { perf, replaying, onClose } = props;
  const listId = useId();
  const seconds = useMemo(() => performanceSeconds(perf), [perf]);
  const counts = useMemo(() => eventCounts(perf), [perf]);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Opening the drawer puts keyboard focus in it (on its close key), so the keys reach the events.
  useLayoutEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, [perf.id]);
  return (
    <aside className={styles.drawer} aria-label={`Events of ${perf.name}`} data-hint-avoid="" data-testid="take-drawer" onKeyDown={(e) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input')) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }}>
      <header className={styles.drawerHead} data-replaying={replaying || undefined}>
        <div className={styles.drawerTitle}>
          <h3 className={styles.drawerName}>{perf.name}</h3>
          <span className={styles.meta}>
            <span>{formatCreated(perf.createdAt)}</span>
            <span aria-hidden="true">·</span>
            <span className="mono">{lengthText(seconds)}</span>
            {counts.length > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>{counts.map((c) => c.text).join(' · ')}</span>
              </>
            )}
          </span>
          {replaying && (
            <span className={styles.replaying}>
              <Led on tone="amber" label="Replaying" size="sm" />
              <ReplayProgress perf={perf} seconds={seconds} />
            </span>
          )}
        </div>
        <div className={styles.actions}>
          <ReplayButton perf={perf} replaying={replaying} />
          <ExportButton perf={perf} />
          <MakeBlocksButton perf={perf} onDone={onClose} />
          <Tooltip name="Close" tip="Close the events and show the song again (Esc).">
            <button ref={closeRef} type="button" className={styles.remove} aria-label={`Close the events of ${perf.name} and show the song`} onClick={onClose}>
              <Icon name="close" size={14} />
            </button>
          </Tooltip>
        </div>
      </header>
      <div className={styles.drawerBody}>
        <EventList perf={perf} replaying={replaying} listId={listId} />
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export interface PerformancesPanelProps {
  /** The take list is shown (true) or the panel is its one-line bar (false). */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /** The take whose events are open in the side drawer, or null. */
  openTake?: Id | null;
  onOpenTake?(id: Id | null): void;
}

export function PerformancesPanel(props: PerformancesPanelProps = {}) {
  const performances = useProject((p) => p.performances);
  const recording = useRuntime((s) => s.recording === 'performance');
  const replayId = useRuntime((s) => (s.playing && s.mode === 'replay' ? s.replayId : null));
  // Standalone (a test mounts the panel alone): it keeps its own open state.
  const [ownOpen, setOwnOpen] = useState<boolean>(() => performances.length > 0);
  const [ownTake, setOwnTake] = useState<Id | null>(null);
  const open = props.open ?? ownOpen;
  const setOpen = props.onOpenChange ?? setOwnOpen;
  const openTake = props.openTake !== undefined ? props.openTake : ownTake;
  const setOpenTake = props.onOpenTake ?? setOwnTake;
  const ordered = useMemo(() => [...performances].reverse(), [performances]);
  const bodyId = useId();
  const none = performances.length === 0;
  const take = openTake ? performances.find((p) => p.id === openTake) ?? null : null;

  // A take that no longer exists cannot stay open.
  useEffect(() => {
    if (openTake && !performances.some((p) => p.id === openTake)) setOpenTake(null);
  }, [openTake, performances, setOpenTake]);

  const onToggle = useCallback((id: Id) => setOpenTake(openTake === id ? null : id), [openTake, setOpenTake]);

  const recordingChip = recording && (
    <span className={styles.recording} role="status">
      <Led on tone="coral" label="Recording a take" size="sm" blink />
      <span className={styles.recordingText}>it appears here when you stop</span>
    </span>
  );

  if (!open && !take) {
    const newest = ordered[0];
    return (
      <section className={styles.panel} data-collapsed="" aria-labelledby="perf-title" data-testid="performances">
        <header className={styles.bar}>
          <h2 id="perf-title" className={styles.title}>
            Performances
          </h2>
          {none ? (
            <button type="button" className={styles.barButton} aria-expanded={false} onClick={() => setOpen(true)}>
              <span className={styles.barText}>
                No takes yet. <b>Performance</b> in the transport records one: launches, notes and knob moves, replayed exactly.
              </span>
              <span className={styles.barMore}>
                How
                <Icon name="chevronDown" size={14} />
              </span>
            </button>
          ) : (
            <>
              <button type="button" className={`${styles.barButton} ${styles.barTakes}`} aria-expanded={false} aria-controls={bodyId} onClick={() => setOpen(true)} data-testid="takes-open">
                <span className={styles.barCount}>{performances.length === 1 ? '1 take' : `${performances.length} takes`}</span>
                <Icon name="chevronRight" size={14} />
              </button>
              {newest && (
                <span className={styles.barNewest} data-hint-avoid="">
                  <span className={styles.barNewestName}>Newest: {newest.name}</span>
                  <span className="mono">{lengthText(performanceSeconds(newest))}</span>
                  <ReplayButton perf={newest} replaying={replayId === newest.id} />
                </span>
              )}
            </>
          )}
          {recordingChip}
        </header>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="perf-title" data-testid="performances" data-drawer={take ? '' : undefined}>
      <header className={styles.head}>
        <h2 id="perf-title" className={styles.title}>
          Performances
          {performances.length > 0 && <span className={`${styles.count} mono`}>{performances.length}</span>}
        </h2>
        <p className={styles.explain}>Record Performance captures clip launches, notes and knob moves, and replays them exactly. Takes are saved with the project.</p>
        {recordingChip}
        <button
          type="button"
          className={styles.barButton}
          aria-expanded
          aria-controls={bodyId}
          onClick={() => {
            setOpenTake(null);
            setOpen(false);
          }}
          data-testid="takes-fold"
        >
          <span className={styles.barMore}>
            Fold
            <Icon name="chevronUp" size={14} />
          </span>
        </button>
      </header>
      <div className={styles.split}>
        <div id={bodyId} className={styles.body} data-scroll-body data-hint-avoid="">
          {ordered.length === 0 ? (
            <div className={styles.empty}>
              <Icon name="recordPerformance" size={22} />
              <div className={styles.emptyText}>
                <strong>No performances yet.</strong>
                <span>
                  Press <b>Performance</b> in the transport’s Record group, play pads, keys and knobs, then press it again to keep the take. It shows up here to replay, edit, export or turn into song blocks.
                </span>
              </div>
              <Button size="sm" icon="chevronRight" onClick={() => setView('play')} tip="Go to the pads and keyboard to play something to record.">
                Go to Play
              </Button>
            </div>
          ) : (
            <ul className={styles.list} aria-label="Recorded performances, newest first" data-testid="take-list">
              {ordered.map((p) => (
                <TakeRow key={p.id} perf={p} open={openTake === p.id} compact={!!take} replaying={replayId === p.id} onToggle={onToggle} />
              ))}
            </ul>
          )}
        </div>
        {take && <TakeDrawer key={take.id} perf={take} replaying={replayId === take.id} onClose={() => setOpenTake(null)} />}
      </div>
    </section>
  );
}
