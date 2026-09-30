/**
 * Steps editor header: which part and clip are being edited (with inline
 * rename and length), the bar pages, and the page/clip tools (copy, paste,
 * copy to next bar, clear, double, transpose). Every edit is one undo step.
 */
import { memo, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { SCENE_ROWS, TICKS_PER_BAR, type ClipBars, type Id, type InstrumentKind } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { selectSlot, selectTrack, setStepPage } from '../../../state/uiStore';
import { shallowEqual } from '../../../state/store';
import { Button, IconButton, Select, Tooltip } from '../../../ui/components';
import { session, useProject } from '../../instance';
import { notify, useRuntime } from '../../runtime';
import { barsLabel } from '../../labels';
import { barClipboard, useBarClipboard } from './shared';
import styles from './StepHeader.module.css';

export interface HeaderClip {
  id: Id;
  name: string;
  bars: ClipBars;
}

/* ------------------------------------------------------------------ */
/* Part and clip slot                                                  */
/* ------------------------------------------------------------------ */

function PartPicker({ trackId }: { trackId: Id }) {
  const names = useProject((p) => p.tracks.map((t) => `${t.id}\u0001${t.name}`), shallowEqual);
  const options = names.map((s, i) => {
    const [id, name] = s.split('\u0001');
    return { value: id, label: `${i + 1} · ${name}` };
  });
  return <Select label="Part" layout="inline" size="sm" value={trackId} options={options} onChange={(v) => selectTrack(v)} width={136} className={styles.partSelect} tip="The part whose steps you edit. Loops, keyboard and sound controls follow it." />;
}

function SlotPicker({ trackId, slot }: { trackId: Id; slot: number }) {
  const slots = useProject(
    (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      return Array.from({ length: SCENE_ROWS }, (_, i) => `${p.scenes[i]?.name ?? `Scene ${i + 1}`}\u0001${t?.clips[i]?.name ?? ''}`);
    },
    shallowEqual,
  );
  const playingSlot = useRuntime((s) => (s.playing ? (s.tracks[trackId]?.playingSlot ?? null) : null));
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const pick = (i: number) => {
    selectSlot(trackId, i);
    refs.current[i]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    let next = slot;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (slot + 1) % SCENE_ROWS;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (slot + SCENE_ROWS - 1) % SCENE_ROWS;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = SCENE_ROWS - 1;
    else return;
    e.preventDefault();
    pick(next);
  };
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel} id={`steps-slot-label-${trackId}`}>
        Clip
      </span>
      <div className={styles.slots} role="radiogroup" aria-labelledby={`steps-slot-label-${trackId}`} onKeyDown={onKey}>
        {slots.map((s, i) => {
          const [scene, clipName] = s.split('\u0001');
          const selected = i === slot;
          const playing = playingSlot === i;
          const state = clipName ? (playing ? 'playing' : 'ready') : 'empty';
          return (
            <button
              key={i}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              className={styles.slot}
              data-selected={selected || undefined}
              data-state={state}
              onClick={() => pick(i)}
              aria-label={`${scene}: ${clipName ? `${clipName}${playing ? ', playing' : ''}` : 'empty'}`}
              title={clipName ? `${scene}: ${clipName}` : `${scene}: empty slot`}
            >
              <span className={styles.slotLamp} aria-hidden="true" />
              {playing && (
                <span className={styles.slotPlay} aria-hidden="true">
                  ▶
                </span>
              )}
              <span className={styles.slotName}>{scene}</span>
              {!clipName && (
                <span className={styles.slotEmpty} aria-hidden="true">
                  +
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Clip name and length                                                */
/* ------------------------------------------------------------------ */

function ClipName({ trackId, slot, name }: { trackId: Id; slot: number; name: string }) {
  const [draft, setDraft] = useState(name);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(name);
  }, [name]);
  const commit = () => {
    editing.current = false;
    const next = draft.trim();
    if (!next || next === name) {
      setDraft(name);
      return;
    }
    if (!session.accepted(cmd.renameClip(session.store, trackId, slot, next))) setDraft(name);
  };
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>Name</span>
      <input
        className={styles.name}
        value={draft}
        maxLength={60}
        spellCheck={false}
        aria-label="Clip name"
        onFocus={(e) => {
          editing.current = true;
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            editing.current = false;
            setDraft(name);
            const el = e.currentTarget;
            requestAnimationFrame(() => el.blur());
          }
        }}
      />
    </label>
  );
}

function LengthPicker({ trackId, slot, bars }: { trackId: Id; slot: number; bars: ClipBars }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const set = (b: ClipBars) => {
    if (b === bars) return;
    const before = session.store.getState().tracks.find((t) => t.id === trackId)?.clips[slot]?.notes.length ?? 0;
    if (!session.accepted(cmd.setClipBars(session.store, trackId, slot, b))) return;
    const after = session.store.getState().tracks.find((t) => t.id === trackId)?.clips[slot]?.notes.length ?? 0;
    if (after < before) notify(`Clip shortened to ${barsLabel(b)}: ${before - after} note${before - after === 1 ? '' : 's'} past the end removed.`, 'info', 'undo');
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    let next = bars as number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(4, bars + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(1, bars - 1);
    else return;
    e.preventDefault();
    set(next as ClipBars);
    refs.current[next - 1]?.focus();
  };
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel} id={`steps-len-${trackId}`}>
        Length
      </span>
      <Tooltip tip="How many bars this clip loops over (1 to 4). Shorter removes notes past the new end; Undo brings them back.">
        <div className={styles.lengths} role="radiogroup" aria-labelledby={`steps-len-${trackId}`} onKeyDown={onKey}>
          {([1, 2, 3, 4] as const).map((b) => (
            <button
              key={b}
              ref={(el) => {
                refs.current[b - 1] = el;
              }}
              type="button"
              role="radio"
              aria-checked={b === bars}
              aria-label={barsLabel(b)}
              tabIndex={b === bars ? 0 : -1}
              className={styles.len}
              data-selected={b === bars || undefined}
              onClick={() => set(b)}
            >
              <span className={styles.slotLamp} aria-hidden="true" />
              {b}
            </button>
          ))}
        </div>
      </Tooltip>
      <span className={styles.unit}>{bars === 1 ? 'bar' : 'bars'}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bar pages                                                           */
/* ------------------------------------------------------------------ */

function PageTabs({ trackId, bars, page }: { trackId: Id; bars: number; page: number }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const go = (p: number) => {
    setStepPage(trackId, p);
    refs.current[p]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    let next = page;
    if (e.key === 'ArrowRight') next = Math.min(bars - 1, page + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, page - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = bars - 1;
    else return;
    e.preventDefault();
    go(next);
  };
  return (
    <div className={styles.pages} role="tablist" aria-label="Bar pages" onKeyDown={onKey}>
      {Array.from({ length: bars }, (_, i) => (
        <button
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`steps-page-${i}`}
          aria-selected={i === page}
          aria-controls="steps-page-panel"
          tabIndex={i === page ? 0 : -1}
          className={styles.page}
          data-selected={i === page || undefined}
          data-ph-page={i}
          onClick={() => go(i)}
        >
          <span className={styles.pageLamp} aria-hidden="true" />
          Bar {i + 1}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

function pageHasNotesSelector(trackId: Id, slot: number, page: number) {
  return (p: ReturnType<typeof session.store.getState>): boolean => {
    const clip = p.tracks.find((t) => t.id === trackId)?.clips[slot];
    if (!clip) return false;
    const a = page * TICKS_PER_BAR;
    return clip.notes.some((n) => n.tick >= a && n.tick < a + TICKS_PER_BAR);
  };
}

function Tools({ trackId, slot, page, clip, kind, trackName }: { trackId: Id; slot: number; page: number; clip: HeaderClip; kind: InstrumentKind; trackName: string }) {
  const drums = kind === 'drums';
  const hasNotes = useProject(pageHasNotesSelector(trackId, slot, page));
  const clipboard = useBarClipboard();
  const clipKind = drums ? 'drums' : 'melodic';
  const canPaste = !!clipboard && clipboard.kind === clipKind;
  const bar = page + 1;

  const copy = () => {
    const notes = cmd.copyPage(session.store.getState(), trackId, slot, page);
    barClipboard.setState({ kind: clipKind, notes, source: `${trackName} · ${clip.name}, bar ${bar}` });
    notify(`Copied bar ${bar} of ${clip.name} (${notes.length} note${notes.length === 1 ? '' : 's'}).`);
  };
  const paste = () => {
    if (!clipboard || !canPaste) return;
    if (session.accepted(cmd.pastePage(session.store, trackId, slot, page, clipboard.notes))) notify(`Pasted ${clipboard.source} onto bar ${bar}.`, 'info', 'undo');
  };
  const toNext = () => {
    const lengthened = page + 1 >= clip.bars;
    if (!session.accepted(cmd.duplicatePage(session.store, trackId, slot, page))) return;
    setStepPage(trackId, page + 1);
    notify(`Bar ${bar} copied to bar ${bar + 1}${lengthened ? ` — the clip is now ${barsLabel(page + 2)}` : ''}.`, 'info', 'undo');
  };
  const clear = () => {
    if (session.accepted(cmd.clearPage(session.store, trackId, slot, page))) notify(`Cleared bar ${bar}.`, 'info', 'undo');
  };
  const double = () => {
    const to = Math.min(4, clip.bars * 2);
    if (session.accepted(cmd.duplicateClipContent(session.store, trackId, slot))) notify(`${clip.name} doubled to ${barsLabel(to)}.`, 'info', 'undo');
  };
  const transpose = (dir: 1 | -1) => (e: MouseEvent<HTMLButtonElement>) => {
    session.accepted(cmd.transposeClip(session.store, trackId, slot, dir * (e.shiftKey ? 12 : 1)));
  };

  return (
    <div className={styles.tools}>
      <div className={styles.group} role="group" aria-label={`Bar ${bar} tools`}>
        <span className={styles.groupLabel} aria-hidden="true">
          Bar {bar}
        </span>
        <Button className={styles.tool} size="sm" variant="ghost" icon="copy" onClick={copy} tip={`Copy bar ${bar} so you can paste it onto another bar or part of the same kind.`}>
          Copy
        </Button>
        <Button
          className={styles.tool}
          size="sm"
          variant="ghost"
          icon="paste"
          onClick={paste}
          disabled={!canPaste}
          tip={canPaste ? `Replace bar ${bar} with the copied bar (${clipboard?.source}).` : clipboard ? `The copied bar is from a ${clipboard.kind === 'drums' ? 'drum' : 'melodic'} part; copy a bar from a ${drums ? 'drum' : 'melodic'} part to paste here.` : 'Copy a bar first.'}
        >
          Paste
        </Button>
        <Button className={styles.tool} size="sm" variant="ghost" icon="duplicate" onClick={toNext} disabled={page >= 3} tip={page >= 3 ? 'Clips are at most 4 bars.' : `Copy bar ${bar} onto bar ${bar + 1}${page + 1 >= clip.bars ? ' (the clip gets longer)' : ''}.`}>
          {page >= 3 ? 'To next bar' : `To bar ${bar + 1}`}
        </Button>
        <Button className={styles.tool} size="sm" variant="ghost" icon="trash" onClick={clear} disabled={!hasNotes} tip={`Remove every note in bar ${bar}. Undo brings them back.`}>
          Clear
        </Button>
      </div>
      <div className={styles.group} role="group" aria-label="Clip tools">
        <span className={styles.groupLabel} aria-hidden="true">
          Clip
        </span>
        <Button className={styles.tool} size="sm" variant="ghost" icon="plus" onClick={double} disabled={clip.bars >= 4} tip={clip.bars >= 4 ? 'The clip is already 4 bars, the longest a clip can be.' : `Repeat the clip to make it ${barsLabel(Math.min(4, clip.bars * 2))} long.`}>
          Double
        </Button>
        {!drums && (
          <div className={styles.transpose} role="group" aria-label="Transpose clip">
            <IconButton icon="minus" size="sm" variant="ghost" label="Transpose down a semitone" tip="Move every note of the clip down a semitone. Shift-click: an octave." onClick={transpose(-1)} />
            <span className={styles.transposeText} aria-hidden="true">
              Transpose
            </span>
            <IconButton icon="plus" size="sm" variant="ghost" label="Transpose up a semitone" tip="Move every note of the clip up a semitone. Shift-click: an octave." onClick={transpose(1)} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

export interface StepHeaderProps {
  trackId: Id;
  slot: number;
  page: number;
  clip: HeaderClip | null;
  kind: InstrumentKind;
  trackName: string;
  locked: boolean;
}

function sameHeader(a: StepHeaderProps, b: StepHeaderProps): boolean {
  return (
    a.trackId === b.trackId &&
    a.slot === b.slot &&
    a.page === b.page &&
    a.kind === b.kind &&
    a.trackName === b.trackName &&
    a.locked === b.locked &&
    (a.clip === b.clip || (!!a.clip && !!b.clip && a.clip.id === b.clip.id && a.clip.name === b.clip.name && a.clip.bars === b.clip.bars))
  );
}

/** Memoised: note edits (a velocity drag, say) re-render the lanes, not the header. */
export const StepHeader = memo(function StepHeader(props: StepHeaderProps) {
  const { trackId, slot, page, clip, kind, trackName, locked } = props;
  return (
    <div className={styles.head}>
      <div className={styles.row}>
        <PartPicker trackId={trackId} />
        <SlotPicker trackId={trackId} slot={slot} />
        <div className={styles.spacer} />
        {clip && <ClipName key={clip.id} trackId={trackId} slot={slot} name={clip.name} />}
        {clip && <LengthPicker trackId={trackId} slot={slot} bars={clip.bars} />}
      </div>
      {clip && (
        <div className={styles.row}>
          <PageTabs trackId={trackId} bars={clip.bars} page={page} />
          {locked && (
            <span className={styles.lock} role="status">
              Locked while a performance records
            </span>
          )}
          <div className={styles.spacer} />
          <Tools trackId={trackId} slot={slot} page={page} clip={clip} kind={kind} trackName={trackName} />
        </div>
      )}
    </div>
  );
}, sameHeader);
