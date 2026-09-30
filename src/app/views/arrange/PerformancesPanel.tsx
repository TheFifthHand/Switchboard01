/**
 * Performances: recorded takes as a list (newest first) with Replay, Export,
 * Delete and inline rename, and each take's editable event list.
 *
 * - Replay uses the take's snapshot and events (session.replayPerformance);
 *   the replaying row shows its real progress read from the transport.
 * - The event list shows bar.beat.step from the start of the take, the kind
 *   of action and what it did in words. Deleting an event is an undoable
 *   command; a note's press and release are deleted together.
 * - Long takes render the first rows and grow on "Show more".
 */
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Icon, Led, Tooltip, useRafLoop } from '../../../ui/components';
import type { Id, Performance } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { setView } from '../../../state/uiStore';
import { session, useProject } from '../../instance';
import { notify, useRuntime } from '../../runtime';
import { formatSeconds } from '../../session';
import { eventCounts, performanceRows, performanceSeconds, type EventKind, type EventRow } from './perfEvents';
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
  useRafLoop(() => {
    const t = session.transport;
    if (!t) return;
    const tick = t.getPosition().tick;
    const f = Math.min(1, Math.max(0, (tick - perf.startTick) / Math.max(1, perf.endTick - perf.startTick)));
    if (barRef.current) barRef.current.style.transform = `scaleX(${f.toFixed(4)})`;
    const text = `${lengthText(f * seconds)} / ${lengthText(seconds)}`;
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

function EventList(props: { perf: Performance; replaying: boolean; listId: string }) {
  const { perf, replaying, listId } = props;
  const rows = useMemo(() => performanceRows(perf), [perf]);
  const [limit, setLimit] = useState(EVENT_PAGE);
  const [active, setActive] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const shown = rows.length > limit ? rows.slice(0, limit) : rows;
  const activeIndex = Math.min(active, Math.max(0, shown.length - 1));

  useLayoutEffect(() => {
    const i = pendingFocus.current;
    if (i === null) return;
    pendingFocus.current = null;
    const buttons = bodyRef.current?.querySelectorAll<HTMLButtonElement>('[data-evdel]');
    if (!buttons || buttons.length === 0) return;
    buttons[Math.min(i, buttons.length - 1)].focus({ preventScroll: false });
  });

  const remove = (row: EventRow, at: number) => {
    const r = cmd.deletePerformanceEvent(session.store, perf.id, row.index);
    if (!session.accepted(r)) return;
    const what = row.kind === 'Note' && row.pairIndex !== undefined ? `the note at ${row.time} (its press and release)` : `the ${row.kind.toLowerCase()} event at ${row.time}`;
    notify(`Deleted ${what} from ${perf.name}.`, 'info', 'undo');
    setActive(at);
    pendingFocus.current = at;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (!t.dataset.evdel) return;
    const i = Number(t.dataset.evdel);
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
    }
    if (next < 0) return;
    e.preventDefault();
    setActive(next);
    pendingFocus.current = next;
  };

  const counts = eventCounts(perf);
  const notes = counts.find((c) => c.key === 'note');

  return (
    <div id={listId} className={styles.events}>
      <p className={styles.eventsHint}>
        Times are <span className="mono">bar.beat.step</span> from the start of the take.{notes ? ' Deleting a note removes its press and release together.' : ''} Undo brings back anything you delete.
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
              <span className="visually-hidden">Delete</span>
            </span>
          </div>
          <div ref={bodyRef} role="rowgroup" onKeyDown={onKeyDown}>
            {shown.map((r, i) => (
              <div key={`${r.index}:${r.tick}:${r.kind}`} className={styles.row} role="row" aria-rowindex={i + 2}>
                <span role="cell" className={`${styles.time} mono`}>
                  {r.time}
                </span>
                <span role="cell" className={styles.kind} data-tone={KIND_TONE[r.kind]}>
                  <span className={styles.kindDot} aria-hidden="true" />
                  {r.kind}
                </span>
                <span role="cell" className={styles.detail} title={r.detail}>
                  {r.detail}
                </span>
                <span role="cell" className={styles.delCell}>
                  <button
                    type="button"
                    className={styles.del}
                    data-evdel={i}
                    tabIndex={i === activeIndex ? 0 : -1}
                    aria-label={`Delete ${r.kind.toLowerCase()} at ${r.time}: ${r.detail}${r.kind === 'Note' && r.pairIndex !== undefined ? ' (press and release)' : ''}`}
                    onClick={() => remove(r, i)}
                    onFocus={() => setActive(i)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              </div>
            ))}
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
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

const TakeRow = memo(function TakeRow(props: { perf: Performance; expanded: boolean; replaying: boolean; onToggle(id: Id): void }) {
  const { perf, expanded, replaying, onToggle } = props;
  const seconds = useMemo(() => performanceSeconds(perf), [perf]);
  const counts = useMemo(() => eventCounts(perf), [perf]);
  const listId = useId();
  const countsText = counts.length ? counts.map((c) => c.text).join(' · ') : 'No recorded actions';
  const itemRef = useRef<HTMLLIElement>(null);

  // Opening a take brings its events into view (the list scrolls, the page does not).
  useEffect(() => {
    const li = itemRef.current;
    const list = li?.closest<HTMLElement>('[data-scroll-body]');
    if (!expanded || !li || !list || list.scrollHeight <= list.clientHeight) return;
    // The scroll body is positioned, so offsetTop is measured from its top.
    list.scrollTo({ top: Math.max(0, li.offsetTop - 8), behavior: 'smooth' });
  }, [expanded]);

  const del = () => {
    if (replaying) session.stop();
    if (session.accepted(cmd.deletePerformance(session.store, perf.id))) notify(`Deleted “${perf.name}”.`, 'info', 'undo');
  };

  return (
    <li ref={itemRef} className={styles.take} data-replaying={replaying || undefined} data-expanded={expanded || undefined}>
      <div className={styles.takeHead}>
        <button
          type="button"
          className={styles.expand}
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-label={`${expanded ? 'Hide' : 'Show'} the events of ${perf.name}`}
          onClick={() => onToggle(perf.id)}
        >
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
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
        <div className={styles.actions}>
          {replaying ? (
            <Button size="sm" variant="secondary" icon="stop" pressed onClick={() => session.stop()} aria-label={`Stop replaying ${perf.name}`} tip="Stop the replay. Your pads take over again on the next Play.">
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="secondary" icon="play" onClick={() => void session.replayPerformance(perf.id)} aria-label={`Replay ${perf.name}`} tip="Play the take back exactly as recorded: launches, notes and knob moves." detail="Uses the sounds and routing captured when the take started. Pads and keys are ignored while it replays.">
              Replay
            </Button>
          )}
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
          <Tooltip name="Delete take" tip="Remove this performance from the project. Undo brings it back.">
            <button type="button" className={styles.remove} aria-label={`Delete ${perf.name}`} onClick={del}>
              <Icon name="trash" size={14} />
            </button>
          </Tooltip>
        </div>
      </div>
      {expanded && <EventList perf={perf} replaying={replaying} listId={listId} />}
    </li>
  );
});

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function PerformancesPanel() {
  const performances = useProject((p) => p.performances);
  const recording = useRuntime((s) => s.recording === 'performance');
  const replayId = useRuntime((s) => (s.playing && s.mode === 'replay' ? s.replayId : null));
  const [expanded, setExpanded] = useState<Id | null>(null);
  const ordered = useMemo(() => [...performances].reverse(), [performances]);

  // A take that no longer exists cannot stay open.
  useEffect(() => {
    if (expanded && !performances.some((p) => p.id === expanded)) setExpanded(null);
  }, [expanded, performances]);

  const onToggle = (id: Id) => setExpanded((cur) => (cur === id ? null : id));

  return (
    <section className={styles.panel} aria-labelledby="perf-title">
      <header className={styles.head}>
        <h2 id="perf-title" className={styles.title}>
          Performances
          {performances.length > 0 && <span className={`${styles.count} mono`}>{performances.length}</span>}
        </h2>
        <p className={styles.explain}>Record Performance captures clip launches, notes and knob moves, and replays them exactly. Takes are saved with the project.</p>
        {recording && (
          <span className={styles.recording} role="status">
            <Led on tone="coral" label="Recording a take" size="sm" blink />
            <span className={styles.recordingText}>it appears here when you stop</span>
          </span>
        )}
      </header>
      <div className={styles.body} data-scroll-body>
        {ordered.length === 0 ? (
          <div className={styles.empty}>
            <Icon name="recordPerformance" size={22} />
            <div className={styles.emptyText}>
              <strong>No performances yet.</strong>
              <span>
                Press <b>Performance</b> in the transport’s Record group, play pads, keys and knobs, then press it again to keep the take. It shows up here to replay, edit and export.
              </span>
            </div>
            <Button size="sm" icon="chevronRight" onClick={() => setView('play')} tip="Go to the pads and keyboard to play something to record.">
              Go to Play
            </Button>
          </div>
        ) : (
          <ul className={styles.list} aria-label="Recorded performances, newest first">
            {ordered.map((p) => (
              <TakeRow key={p.id} perf={p} expanded={expanded === p.id} replaying={replayId === p.id} onToggle={onToggle} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
