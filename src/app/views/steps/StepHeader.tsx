/**
 * Steps editor header: which part and clip are being edited (with inline
 * rename and length), the bar strip (an overview of the whole clip over one
 * key per bar, Follow, the grid) and the bar and clip tools (copy, paste,
 * copy to next bar, clear, double, transpose, tighten timing, loosen). Every
 * edit is one undo step.
 */
import { memo, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { CLIP_BAR_CHOICES, MAX_CLIP_BARS, TICKS_PER_BAR, type ClipBars, type Id, type InstrumentKind, type Note } from '../../../project/types';
import { keyLabel, stepsPerOctave } from '../../../music/scales';
import * as cmd from '../../../state/commands';
import { QUANTIZE_TO_TICKS, type QuantizeTo } from '../../../state/commands/notes';
import { STEP_GRIDS, selectSlot, selectTrack, setStepGrid, setStepPage, setStepsFollow, type StepGrid } from '../../../state/uiStore';
import { shallowEqual } from '../../../state/store';
import { Button, ClipSketch, IconButton, Select, Tooltip } from '../../../ui/components';
import { session, useProject, useUi } from '../../instance';
import { notify, useRuntime } from '../../runtime';
import { barsLabel } from '../../labels';
import { LENGTH_TIP, MenuHeader, MenuItem, MenuKeyRow, MenuSeparator, Popover, anchorFromElement, type MenuAnchor } from '../ClipMenu';
import { plural, quantizeMoves } from './model';
import { barClipboard, useBarClipboard } from './shared';
import styles from './StepHeader.module.css';

export interface HeaderClip {
  id: Id;
  name: string;
  bars: ClipBars;
}

const NO_NOTES: readonly Note[] = [];

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
  // One key per scene row of the project (1 to 8).
  const slots = useProject(
    (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      return p.scenes.map((sc, i) => `${sc.name || `Scene ${i + 1}`}\u0001${t?.clips[i]?.name ?? ''}`);
    },
    shallowEqual,
  );
  const count = slots.length;
  const playingSlot = useRuntime((s) => (s.playing ? (s.tracks[trackId]?.playingSlot ?? null) : null));
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const pick = (i: number) => {
    selectSlot(trackId, i);
    refs.current[i]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    let next = slot;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (slot + 1) % count;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (slot + count - 1) % count;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
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

function ClipName({ trackId, slot, name, locked }: { trackId: Id; slot: number; name: string; locked: boolean }) {
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
        readOnly={locked}
        title={locked ? 'Locked while a performance records' : undefined}
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

function LengthPicker({ trackId, slot, bars, locked }: { trackId: Id; slot: number; bars: ClipBars; locked: boolean }) {
  // 1, 2, 3, 4 and 8 bars; a clip Double or Repeat made 5-7 bars long shows its own length too.
  const choices = [...new Set<ClipBars>([...CLIP_BAR_CHOICES, bars])].sort((x, y) => x - y);
  const refs = useRef(new Map<number, HTMLButtonElement | null>());
  const set = (b: ClipBars) => {
    if (b === bars || locked) return;
    const before = session.store.getState().tracks.find((t) => t.id === trackId)?.clips[slot]?.notes.length ?? 0;
    if (!session.accepted(cmd.setClipBars(session.store, trackId, slot, b))) return;
    const after = session.store.getState().tracks.find((t) => t.id === trackId)?.clips[slot]?.notes.length ?? 0;
    if (after < before) notify(`Clip shortened to ${barsLabel(b)}: ${before - after} note${before - after === 1 ? '' : 's'} past the end removed.`, 'info', 'undo');
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (locked) return;
    const i = choices.indexOf(bars);
    let next = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(choices.length - 1, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = choices.length - 1;
    else return;
    e.preventDefault();
    set(choices[next]);
    refs.current.get(choices[next])?.focus();
  };
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel} id={`steps-len-${trackId}`}>
        Length
      </span>
      <Tooltip tip={locked ? 'Locked while a performance records.' : LENGTH_TIP}>
        <div className={styles.lengths} role="radiogroup" aria-labelledby={`steps-len-${trackId}`} onKeyDown={onKey}>
          {choices.map((b) => (
            <button
              key={b}
              ref={(el) => {
                refs.current.set(b, el);
              }}
              type="button"
              role="radio"
              aria-checked={b === bars}
              aria-disabled={locked || undefined}
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
/* Bar strip: the whole clip at a glance, one key per bar, Follow, grid */
/* ------------------------------------------------------------------ */

const GRID_OPTIONS: readonly { value: StepGrid; label: string }[] = [
  { value: '1/16', label: '1/16' },
  { value: '1/32', label: '1/32' },
  { value: '1/8T', label: '1/8T' },
  { value: '1/16T', label: '1/16T' },
];

function BarStrip({ trackId, slot, bars, page, kind }: { trackId: Id; slot: number; bars: number; page: number; kind: InstrumentKind }) {
  const notes = useProject((p) => p.tracks.find((t) => t.id === trackId)?.clips[slot]?.notes ?? NO_NOTES);
  const follow = useUi((s) => s.stepsFollow);
  const gridName = useUi((s) => s.stepGrid);
  const drums = kind === 'drums';
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
  // Keep the shown bar's key in view when the strip scrolls (8 bars on a narrow window).
  useEffect(() => {
    refs.current[page]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [page]);
  return (
    <div className={styles.barRow}>
      <div className={styles.field}>
        <span className={styles.fieldLabel} id={`steps-bars-${trackId}`}>
          Bar
        </span>
        <div className={styles.strip} data-bars={bars}>
          <div className={styles.stripInner} style={{ '--bars': String(bars) } as CSSProperties}>
            {/* The whole clip over the bar keys: each bar's notes sit above its key (pressing there shows that bar). */}
            <div className={styles.overview} aria-hidden="true">
              <ClipSketch notes={notes} lengthTicks={bars * TICKS_PER_BAR} kind={drums ? 'drums' : 'notes'} />
            </div>
            <div className={styles.pages} role="tablist" aria-labelledby={`steps-bars-${trackId}`} onKeyDown={onKey}>
              {Array.from({ length: bars }, (_, i) => (
                <button
                  key={i}
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`steps-page-${i}`}
                  aria-label={`Bar ${i + 1}`}
                  aria-selected={i === page}
                  aria-controls="steps-page-panel"
                  tabIndex={i === page ? 0 : -1}
                  className={styles.page}
                  data-selected={i === page || undefined}
                  data-ph-page={i}
                  onClick={() => go(i)}
                >
                  <span className={styles.pageNum}>
                    <span className={styles.pageLamp} aria-hidden="true" />
                    {i + 1}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <Button
        className={styles.follow}
        size="sm"
        pressed={follow}
        tone="amber"
        onClick={() => setStepsFollow(!follow)}
        tip={follow ? 'Following: the shown bar turns with the playhead while this clip plays.' : 'Turn the shown bar with the playhead while this clip plays.'}
        detail="It waits while you drag or draw."
      >
        Follow
      </Button>
      {!drums && (
        <Select
          label="Grid"
          layout="inline"
          size="sm"
          value={gridName}
          options={GRID_OPTIONS}
          onChange={(v) => {
            if ((STEP_GRIDS as readonly string[]).includes(v)) setStepGrid(v as StepGrid);
          }}
          width={74}
          className={styles.gridSelect}
          tip="The cells of the piano roll: 16ths, 32nds, or 8th or 16th triplets. New notes and moves snap to it."
          detail="Hold Alt while dragging to place notes off the grid."
        />
      )}
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

/**
 * A tool that switched itself off (Clear on a now-empty bar, Double at 8
 * bars, copying onto bar 8) would strand keyboard focus: hand it to the step
 * grid instead.
 */
function handOffFocus(el: HTMLButtonElement): void {
  requestAnimationFrame(() => {
    if (!el.isConnected || !el.disabled) return;
    const active = document.activeElement;
    if (active && active !== el && active !== document.body) return;
    el.closest('[data-steps-root]')?.querySelector<HTMLElement>('[data-steps-entry]')?.focus();
  });
}

function currentClip(trackId: Id, slot: number) {
  return session.store.getState().tracks.find((t) => t.id === trackId)?.clips[slot] ?? null;
}

/** − Transpose +: a scale step under Musical Assist, a semitone otherwise (Advanced keeps semitone keys too). Shift: an octave. */
function Transpose({ trackId, slot, clipName }: { trackId: Id; slot: number; clipName: string }) {
  const inKey = useProject((p) => p.assist && p.scale !== 'chromatic');
  const key = useProject((p) => (p.scale === 'chromatic' ? 'Chromatic' : keyLabel(p.root, p.scale)));
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const move = (unit: 'step' | 'semitone', dir: 1 | -1) => (e: MouseEvent<HTMLButtonElement>) => {
    const clip = currentClip(trackId, slot);
    if (!clip) return;
    if (clip.notes.length === 0) {
      notify(`${clip.name} has no notes to move yet.`);
      return;
    }
    const octave = e.shiftKey;
    const p = session.store.getState();
    const r =
      unit === 'step'
        ? cmd.transposeClipInScale(session.store, trackId, slot, dir * (octave ? stepsPerOctave(p.scale) : 1))
        : cmd.transposeClip(session.store, trackId, slot, dir * (octave ? 12 : 1));
    if (!session.accepted(r)) return;
    notify(`${clip.name} moved ${dir > 0 ? 'up' : 'down'} ${octave ? 'an octave' : unit === 'step' ? 'one step' : 'one semitone'}.`, 'info', 'undo');
  };
  const stepper = (unit: 'step' | 'semitone', text: string) => {
    const words = unit === 'step' ? 'a scale step' : 'a semitone';
    const tip = (dir: string) =>
      unit === 'step'
        ? `Move every note of ${clipName} ${dir} one step of ${key}, so it stays in key. Shift-click: an octave.`
        : `Move every note of ${clipName} ${dir} a semitone. Shift-click: an octave.`;
    return (
      <div className={styles.transpose} role="group" aria-label={unit === 'step' ? 'Transpose clip in key' : 'Transpose clip by semitones'} data-unit={unit}>
        <IconButton icon="minus" size="sm" variant="ghost" label={`Transpose down ${words}`} tip={tip('down')} onClick={move(unit, -1)} />
        <span className={styles.transposeText} aria-hidden="true">
          {text}
        </span>
        <IconButton icon="plus" size="sm" variant="ghost" label={`Transpose up ${words}`} tip={tip('up')} onClick={move(unit, 1)} />
      </div>
    );
  };
  return (
    <>
      {inKey && stepper('step', 'Transpose')}
      {(!inKey || advanced) && stepper('semitone', inKey ? 'Semitone' : 'Transpose')}
    </>
  );
}

const QUANTIZE_GRIDS: readonly QuantizeTo[] = ['1/4', '1/8', '1/16', '1/32', '1/8T', '1/16T'];
const QUANTIZE_OPTIONS = QUANTIZE_GRIDS.map((g) => ({ value: g, label: g, ariaLabel: `Grid ${g}` }));
const STRENGTH_OPTIONS = [25, 50, 75, 100].map((v) => ({ value: v, label: String(v), ariaLabel: `Strength ${v}%` }));

function TightenMenu({ trackId, slot, anchor, returnFocus, onClose }: { trackId: Id; slot: number; anchor: MenuAnchor; returnFocus: HTMLElement | null; onClose(): void }) {
  const gridName = useUi((s) => s.stepGrid);
  const [to, setTo] = useState<QuantizeTo>(gridName);
  const [strength, setStrength] = useState(100);
  const clip = useProject((p) => p.tracks.find((t) => t.id === trackId)?.clips[slot] ?? null);
  if (!clip) return null;
  const moves = quantizeMoves(clip.notes, QUANTIZE_TO_TICKS[to], strength / 100, clip.bars * TICKS_PER_BAR);
  const apply = () => {
    const r = cmd.quantizeClip(session.store, trackId, slot, { grid: to, strength: strength / 100 });
    onClose();
    if (!session.accepted(r)) return;
    notify(`${plural(r.moved, 'note')} moved${strength < 100 ? ` ${strength}% of the way` : ''} to the ${to} grid.`, 'info', 'undo');
  };
  return (
    <Popover anchor={anchor} label="Tighten timing" onClose={onClose} returnFocus={returnFocus}>
      <MenuHeader eyebrow={clip.name} title="Tighten timing">
        <div className={styles.menuMeta}>{moves === 0 ? `Every note already starts on the ${to} grid.` : `${plural(moves, 'note')} of ${clip.notes.length} will move towards the ${to} grid. Lengths stay.`}</div>
      </MenuHeader>
      <MenuKeyRow label="Grid" row="grid" options={QUANTIZE_OPTIONS} value={to} onSelect={(v) => setTo(v as QuantizeTo)} tip="The grid the note starts are pulled to." />
      <MenuKeyRow label="Strength" unit="%" row="strength" options={STRENGTH_OPTIONS} value={strength} onSelect={(v) => setStrength(Number(v))} tip="100% puts notes on the grid; 50% halves each note's distance to it." />
      <MenuSeparator />
      <MenuItem icon="check" disabled={moves === 0} disabledReason="Nothing to move" onSelect={apply}>
        {moves === 0 ? 'Tighten' : `Tighten ${plural(moves, 'note')}`}
      </MenuItem>
    </Popover>
  );
}

const TIMING_TICKS = [0, 2, 4, 8] as const;
const LEVEL_PCT = [0, 5, 10, 20] as const;
/** Each press of Loosen rolls new dice (per clip, this session); the result is stored in the notes. */
const looseSeeds = new Map<Id, number>();

function LoosenMenu({ trackId, slot, anchor, returnFocus, onClose }: { trackId: Id; slot: number; anchor: MenuAnchor; returnFocus: HTMLElement | null; onClose(): void }) {
  const [timing, setTiming] = useState(4);
  const [level, setLevel] = useState(10);
  const bpm = useProject((p) => p.bpm);
  const clip = useProject((p) => p.tracks.find((t) => t.id === trackId)?.clips[slot] ?? null);
  if (!clip) return null;
  const ms = (ticks: number) => Math.round((ticks * 60000) / (Math.max(1, bpm) * 96));
  const timingOptions = TIMING_TICKS.map((t) => ({ value: t, label: t === 0 ? 'Off' : `±${ms(t)}`, ariaLabel: t === 0 ? 'Timing off' : `Timing up to ${ms(t)} milliseconds either way` }));
  const levelOptions = LEVEL_PCT.map((v) => ({ value: v, label: v === 0 ? 'Off' : `±${v}`, ariaLabel: v === 0 ? 'Level off' : `Level up to ${v}% either way` }));
  const nothing = clip.notes.length === 0 || (timing === 0 && level === 0);
  const apply = () => {
    const seed = (looseSeeds.get(clip.id) ?? 0) + 1;
    looseSeeds.set(clip.id, seed);
    const r = cmd.humanizeClip(session.store, trackId, slot, { timingTicks: timing, velocityPct: level, seed });
    onClose();
    if (!session.accepted(r)) return;
    notify(`Loosened ${plural(r.notes, 'note')}${r.moved ? ` (${r.moved} moved in time)` : ''}.`, 'info', 'undo');
  };
  return (
    <Popover anchor={anchor} label="Loosen (humanize)" onClose={onClose} returnFocus={returnFocus}>
      <MenuHeader eyebrow={clip.name} title="Loosen (humanize)">
        <div className={styles.menuMeta}>Small random shifts in timing and level, so programmed notes feel played. Each press rolls again; Undo goes back.</div>
      </MenuHeader>
      <MenuKeyRow label="Timing" unit="ms" row="timing" options={timingOptions} value={timing} onSelect={(v) => setTiming(Number(v))} tip="How far a note may start early or late." />
      <MenuKeyRow label="Level" unit="%" row="level" options={levelOptions} value={level} onSelect={(v) => setLevel(Number(v))} tip="How much softer or louder a note may play." />
      <MenuSeparator />
      <MenuItem icon="sparkle" disabled={nothing} disabledReason={clip.notes.length === 0 ? 'No notes yet' : 'Choose an amount'} onSelect={apply}>
        {`Loosen ${plural(clip.notes.length, 'note')}`}
      </MenuItem>
    </Popover>
  );
}

function Tools({ trackId, slot, page, clip, kind, trackName }: { trackId: Id; slot: number; page: number; clip: HeaderClip; kind: InstrumentKind; trackName: string }) {
  const drums = kind === 'drums';
  const hasNotes = useProject(pageHasNotesSelector(trackId, slot, page));
  const clipHasNotes = useProject((p) => (p.tracks.find((t) => t.id === trackId)?.clips[slot]?.notes.length ?? 0) > 0);
  const clipboard = useBarClipboard();
  const clipKind = drums ? 'drums' : 'melodic';
  const canPaste = !!clipboard && clipboard.kind === clipKind;
  const bar = page + 1;
  const [menu, setMenu] = useState<{ kind: 'tighten' | 'loosen'; anchor: MenuAnchor; el: HTMLElement } | null>(null);

  const copy = () => {
    const notes = cmd.copyPage(session.store.getState(), trackId, slot, page);
    barClipboard.setState({ kind: clipKind, notes, source: `${trackName} · ${clip.name}, bar ${bar}` });
    notify(`Copied bar ${bar} of ${clip.name} (${notes.length} note${notes.length === 1 ? '' : 's'}).`);
  };
  const paste = () => {
    if (!clipboard || !canPaste) return;
    if (session.accepted(cmd.pastePage(session.store, trackId, slot, page, clipboard.notes))) notify(`Pasted ${clipboard.source} onto bar ${bar}.`, 'info', 'undo');
  };
  const toNext = (e: MouseEvent<HTMLButtonElement>) => {
    const lengthened = page + 1 >= clip.bars;
    if (!session.accepted(cmd.duplicatePage(session.store, trackId, slot, page))) return;
    setStepPage(trackId, page + 1);
    handOffFocus(e.currentTarget);
    notify(`Bar ${bar} copied to bar ${bar + 1}${lengthened ? ` — the clip is now ${barsLabel(page + 2)}` : ''}.`, 'info', 'undo');
  };
  const clear = (e: MouseEvent<HTMLButtonElement>) => {
    if (!session.accepted(cmd.clearPage(session.store, trackId, slot, page))) return;
    notify(`Cleared bar ${bar}.`, 'info', 'undo');
    handOffFocus(e.currentTarget);
  };
  const double = (e: MouseEvent<HTMLButtonElement>) => {
    const to = Math.min(MAX_CLIP_BARS, clip.bars * 2);
    if (!session.accepted(cmd.duplicateClipContent(session.store, trackId, slot))) return;
    notify(`${clip.name} doubled to ${barsLabel(to)}.`, 'info', 'undo');
    handOffFocus(e.currentTarget);
  };
  const open = (kind: 'tighten' | 'loosen') => (e: MouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    setMenu((m) => (m?.kind === kind ? null : { kind, anchor: anchorFromElement(el), el }));
  };

  const lastPage = page >= MAX_CLIP_BARS - 1;
  const toNextLabel = lastPage ? 'To next bar' : `To bar ${bar + 1}`;
  const longest = clip.bars >= MAX_CLIP_BARS;

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
          tip={
            canPaste
              ? `Replace bar ${bar} with the copied bar (${clipboard?.source}).`
              : clipboard
                ? `The copied bar is from a ${clipboard.kind === 'drums' ? 'drum' : 'melodic'} part; copy a bar from a ${drums ? 'drum' : 'melodic'} part to paste here.`
                : 'Copy a bar first.'
          }
        >
          Paste
        </Button>
        <Button
          className={styles.tool}
          size="sm"
          variant="ghost"
          icon="duplicate"
          onClick={toNext}
          disabled={lastPage}
          tip={lastPage ? `Clips are at most ${MAX_CLIP_BARS} bars.` : `Copy bar ${bar} onto bar ${bar + 1}${page + 1 >= clip.bars ? ' (the clip gets longer)' : ''}.`}
        >
          {toNextLabel}
        </Button>
        <Button className={styles.tool} size="sm" variant="ghost" icon="trash" onClick={clear} disabled={!hasNotes} tip={hasNotes ? `Remove every note in bar ${bar}. Undo brings them back.` : `Bar ${bar} is already empty.`}>
          Clear
        </Button>
      </div>
      <div className={styles.group} role="group" aria-label="Clip tools">
        <span className={styles.groupLabel} aria-hidden="true">
          Clip
        </span>
        <Button
          className={styles.tool}
          size="sm"
          variant="ghost"
          onClick={double}
          disabled={longest}
          tip={longest ? `The clip is already ${MAX_CLIP_BARS} bars, the longest a clip can be.` : `Repeat the clip to make it ${barsLabel(Math.min(MAX_CLIP_BARS, clip.bars * 2))} long.`}
        >
          <span className={styles.times} aria-hidden="true">
            ×2
          </span>
          Double
        </Button>
        {!drums && <Transpose trackId={trackId} slot={slot} clipName={clip.name} />}
        <Button
          className={styles.tool}
          size="sm"
          variant="ghost"
          icon="clock"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'tighten'}
          aria-label="Tighten timing…"
          disabled={!clipHasNotes}
          onClick={open('tighten')}
          tip={clipHasNotes ? 'Pull notes towards the grid (quantize), with a strength.' : 'Add some notes first.'}
        >
          Tighten…
        </Button>
        <Button
          className={styles.tool}
          size="sm"
          variant="ghost"
          icon="dice"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'loosen'}
          aria-label="Loosen (humanize)…"
          disabled={!clipHasNotes}
          onClick={open('loosen')}
          tip={clipHasNotes ? 'Small random shifts in timing and level (humanize), so programmed notes feel played.' : 'Add some notes first.'}
        >
          Loosen…
        </Button>
      </div>
      {menu?.kind === 'tighten' && <TightenMenu trackId={trackId} slot={slot} anchor={menu.anchor} returnFocus={menu.el} onClose={() => setMenu(null)} />}
      {menu?.kind === 'loosen' && <LoosenMenu trackId={trackId} slot={slot} anchor={menu.anchor} returnFocus={menu.el} onClose={() => setMenu(null)} />}
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

/** Memoised: note edits (a velocity drag, say) re-render the lanes and the overview, not the rest of the header. */
export const StepHeader = memo(function StepHeader(props: StepHeaderProps) {
  const { trackId, slot, page, clip, kind, trackName, locked } = props;
  return (
    <div className={styles.head}>
      <div className={styles.row}>
        <PartPicker trackId={trackId} />
        <SlotPicker trackId={trackId} slot={slot} />
        <div className={styles.spacer} />
        {clip && <ClipName key={clip.id} trackId={trackId} slot={slot} name={clip.name} locked={locked} />}
        {clip && <LengthPicker trackId={trackId} slot={slot} bars={clip.bars} locked={locked} />}
      </div>
      {clip && (
        <div className={styles.row}>
          <BarStrip trackId={trackId} slot={slot} bars={clip.bars} page={page} kind={kind} />
          <div className={styles.spacer} />
          {/* During a performance take clips are locked: say so where the editing tools were. */}
          <div className={styles.status} role="status">
            {locked && (
              <span className={styles.lock}>
                <span className={styles.lockDot} aria-hidden="true" />
                Locked while a performance records. Stop the take to edit steps.
              </span>
            )}
          </div>
          {!locked && <Tools trackId={trackId} slot={slot} page={page} clip={clip} kind={kind} trackName={trackName} />}
        </div>
      )}
    </div>
  );
}, sameHeader);
