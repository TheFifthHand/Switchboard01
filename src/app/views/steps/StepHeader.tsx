/**
 * Steps editor header: which part and clip are being edited (with inline
 * rename and length), the bar strip (an overview of the whole clip over one
 * key per bar, Follow, the grid) and the bar and clip tools (copy, paste,
 * copy to next bar, clear, double, transpose, and a Timing menu with tighten
 * and loosen). The bar line stays one line: tools fold into a "⋯" menu when
 * they do not fit. Every edit is one undo step.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
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
import { LENGTH_TIP, MenuHeader, MenuItem, MenuKeyRow, MenuSeparator, MoreIcon, Popover, anchorFromElement, type MenuAnchor } from '../ClipMenu';
import { mergedWords, plural, quantizeMoves } from './model';
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
  const stripRef = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const go = (p: number) => {
    setStepPage(trackId, p);
    refs.current[p]?.focus({ preventScroll: true });
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
  // Keep the shown bar's key in view when the strip scrolls sideways: the strip's own scroll only (the page stays put).
  useEffect(() => {
    const strip = stripRef.current;
    const key = refs.current[page];
    if (!strip || !key || strip.scrollWidth <= strip.clientWidth) return;
    const s = strip.getBoundingClientRect();
    const k = key.getBoundingClientRect();
    if (k.left < s.left) strip.scrollLeft -= s.left - k.left;
    else if (k.right > s.right) strip.scrollLeft += k.right - s.right;
  }, [page]);
  return (
    <div className={styles.barRow}>
      <div className={styles.field}>
        <span className={styles.fieldLabel} id={`steps-bars-${trackId}`}>
          Bar
        </span>
        <div ref={stripRef} className={styles.strip} data-bars={bars}>
          <div className={styles.stripInner} style={{ '--bars': String(bars) } as CSSProperties}>
            {/* The whole clip over the bar keys: each bar's notes sit above its number (pressing there shows that bar). */}
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
          hideLabel
          layout="inline"
          size="sm"
          value={gridName}
          options={GRID_OPTIONS}
          onChange={(v) => {
            if ((STEP_GRIDS as readonly string[]).includes(v)) setStepGrid(v as StepGrid);
          }}
          width={74}
          className={styles.gridSelect}
          tip="Grid: the cells of the piano roll, 16ths, 32nds, or 8th or 16th triplets. New notes and moves snap to it."
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
function handOffFocus(el: HTMLButtonElement | null | undefined): void {
  if (!el) return;
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

/** Notes that two of one pitch landing on one tick turned into one, as words for a toast (empty when none). */
function mergedSuffix(before: number, trackId: Id, slot: number): string {
  const after = currentClip(trackId, slot)?.notes.length ?? before;
  return before > after ? ` ${mergedWords(before - after)}.` : '';
}

type TransposeUnit = 'step' | 'semitone';

/** Transpose the clip by a scale step (Musical Assist) or a semitone, or an octave of either; one undo step and a toast. */
function transposeClip(trackId: Id, slot: number, unit: TransposeUnit, dir: 1 | -1, octave: boolean): void {
  const clip = currentClip(trackId, slot);
  if (!clip) return;
  if (clip.notes.length === 0) {
    notify(`${clip.name} has no notes to move yet.`);
    return;
  }
  const p = session.store.getState();
  const before = clip.notes.length;
  const r =
    unit === 'step'
      ? cmd.transposeClipInScale(session.store, trackId, slot, dir * (octave ? stepsPerOctave(p.scale) : 1))
      : cmd.transposeClip(session.store, trackId, slot, dir * (octave ? 12 : 1));
  if (!session.accepted(r)) return;
  notify(`${clip.name} moved ${dir > 0 ? 'up' : 'down'} ${octave ? 'an octave' : unit === 'step' ? 'one step' : 'one semitone'}.${mergedSuffix(before, trackId, slot)}`, 'info', 'undo');
}

/** − Transpose +: a scale step under Musical Assist, a semitone otherwise (Advanced keeps semitone keys too). Shift: an octave. */
function TransposeStepper({ trackId, slot, clipName, unit, text, keyName }: { trackId: Id; slot: number; clipName: string; unit: TransposeUnit; text: string; keyName: string }) {
  const words = unit === 'step' ? 'a scale step' : 'a semitone';
  const tip = (dir: string) =>
    unit === 'step' ? `Move every note of ${clipName} ${dir} one step of ${keyName}, so it stays in key. Shift-click: an octave.` : `Move every note of ${clipName} ${dir} a semitone. Shift-click: an octave.`;
  return (
    <div className={styles.transpose} role="group" aria-label={unit === 'step' ? 'Transpose clip in key' : 'Transpose clip by semitones'} data-unit={unit}>
      <IconButton icon="minus" size="sm" variant="ghost" label={`Transpose down ${words}`} tip={tip('down')} onClick={(e) => transposeClip(trackId, slot, unit, -1, e.shiftKey)} />
      <span className={styles.transposeText} aria-hidden="true">
        {text}
      </span>
      <IconButton icon="plus" size="sm" variant="ghost" label={`Transpose up ${words}`} tip={tip('up')} onClick={(e) => transposeClip(trackId, slot, unit, 1, e.shiftKey)} />
    </div>
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
  const { moved, merged } = quantizeMoves(clip.notes, QUANTIZE_TO_TICKS[to], strength / 100, clip.bars * TICKS_PER_BAR);
  const apply = () => {
    const before = clip.notes.length;
    const r = cmd.quantizeClip(session.store, trackId, slot, { grid: to, strength: strength / 100 });
    onClose();
    if (!session.accepted(r)) return;
    notify(`${plural(r.moved, 'note')} moved${strength < 100 ? ` ${strength}% of the way` : ''} to the ${to} grid.${mergedSuffix(before, trackId, slot)}`, 'info', 'undo');
  };
  const preview =
    moved === 0
      ? `Every note already starts on the ${to} grid.`
      : `${plural(moved, 'note')} of ${clip.notes.length} will move towards the ${to} grid. Lengths stay.${merged ? ` ${mergedWords(merged)} (two of one pitch on one tick become one).` : ''}`;
  return (
    <Popover anchor={anchor} label="Tighten timing" onClose={onClose} returnFocus={returnFocus}>
      <MenuHeader eyebrow={clip.name} title="Tighten timing">
        <div className={styles.menuMeta}>{preview}</div>
      </MenuHeader>
      <MenuKeyRow label="Grid" row="grid" options={QUANTIZE_OPTIONS} value={to} onSelect={(v) => setTo(v as QuantizeTo)} tip="The grid the note starts are pulled to." />
      <MenuKeyRow label="Strength" unit="%" row="strength" options={STRENGTH_OPTIONS} value={strength} onSelect={(v) => setStrength(Number(v))} tip="100% puts notes on the grid; 50% halves each note's distance to it." />
      <MenuSeparator />
      <MenuItem icon="check" disabled={moved === 0} disabledReason="Nothing to move" onSelect={apply}>
        {moved === 0 ? 'Tighten' : `Tighten ${plural(moved, 'note')}`}
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
    const before = clip.notes.length;
    const r = cmd.humanizeClip(session.store, trackId, slot, { timingTicks: timing, velocityPct: level, seed });
    onClose();
    if (!session.accepted(r)) return;
    notify(`Loosened ${plural(r.notes, 'note')}${r.moved ? ` (${r.moved} moved in time)` : ''}.${mergedSuffix(before, trackId, slot)}`, 'info', 'undo');
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

/**
 * How much of the toolbar folds into its "⋯" menu so the bar row stays one
 * line: 0 everything shown; 1 the bar tools fold; 2 Double and Timing too;
 * 3 the semitone keys too (Advanced, next to the in-key ones).
 */
export type ToolsFold = 0 | 1 | 2 | 3;
const MAX_FOLD: ToolsFold = 3;

type ToolMenu = { kind: 'more' | 'timing' | 'tighten' | 'loosen'; anchor: MenuAnchor; el: HTMLElement };

function Tools({ trackId, slot, page, clip, kind, trackName, fold }: { trackId: Id; slot: number; page: number; clip: HeaderClip; kind: InstrumentKind; trackName: string; fold: ToolsFold }) {
  const drums = kind === 'drums';
  const hasNotes = useProject(pageHasNotesSelector(trackId, slot, page));
  const clipHasNotes = useProject((p) => (p.tracks.find((t) => t.id === trackId)?.clips[slot]?.notes.length ?? 0) > 0);
  const inKey = useProject((p) => p.assist && p.scale !== 'chromatic');
  const keyName = useProject((p) => (p.scale === 'chromatic' ? 'Chromatic' : keyLabel(p.root, p.scale)));
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const clipboard = useBarClipboard();
  const clipKind = drums ? 'drums' : 'melodic';
  const canPaste = !!clipboard && clipboard.kind === clipKind;
  const bar = page + 1;
  const [menu, setMenu] = useState<ToolMenu | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const toNextRef = useRef<HTMLButtonElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  const doubleRef = useRef<HTMLButtonElement>(null);

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
    handOffFocus(toNextRef.current);
    notify(`Bar ${bar} copied to bar ${bar + 1}${lengthened ? ` — the clip is now ${barsLabel(page + 2)}` : ''}.`, 'info', 'undo');
  };
  const clear = () => {
    if (!session.accepted(cmd.clearPage(session.store, trackId, slot, page))) return;
    notify(`Cleared bar ${bar}.`, 'info', 'undo');
    handOffFocus(clearRef.current);
  };
  const double = () => {
    const to = Math.min(MAX_CLIP_BARS, clip.bars * 2);
    if (!session.accepted(cmd.duplicateClipContent(session.store, trackId, slot))) return;
    notify(`${clip.name} doubled to ${barsLabel(to)}.`, 'info', 'undo');
    handOffFocus(doubleRef.current);
  };
  const open = (k: ToolMenu['kind']) => (e: MouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    setMenu((m) => (m?.kind === k ? null : { kind: k, anchor: anchorFromElement(el), el }));
  };
  /** From inside a menu: open Tighten or Loosen in its place, anchored where the menu was. */
  const then = (k: 'tighten' | 'loosen') => setMenu((m) => (m ? { ...m, kind: k } : m));
  const after = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };

  const lastPage = page >= MAX_CLIP_BARS - 1;
  const longest = clip.bars >= MAX_CLIP_BARS;
  const pasteTip = canPaste
    ? `Replace bar ${bar} with the copied bar (${clipboard?.source}).`
    : clipboard
      ? `The copied bar is from a ${clipboard.kind === 'drums' ? 'drum' : 'melodic'} part; copy a bar from a ${drums ? 'drum' : 'melodic'} part to paste here.`
      : 'Copy a bar first.';
  const semitoneKeys = !drums && (!inKey || advanced);
  const stepKeys = !drums && inKey;
  // Semitone keys fold only when the in-key ones stay (with Assist off they are Transpose itself).
  const semitoneInline = semitoneKeys && !(fold >= 3 && stepKeys);
  const timingTip = clipHasNotes ? 'Tighten timing (quantize) or loosen it (humanize).' : 'Add some notes first.';

  return (
    <div className={styles.tools} data-fold={fold}>
      {fold === 0 ? (
        <div className={styles.group} role="group" aria-label={`Bar ${bar} tools`}>
          <IconButton className={styles.tool} icon="copy" size="sm" variant="ghost" label={`Copy bar ${bar}`} tip={`Copy bar ${bar} so you can paste it onto another bar or part of the same kind.`} onClick={copy} />
          <IconButton className={styles.tool} icon="paste" size="sm" variant="ghost" label={`Paste onto bar ${bar}`} tip={pasteTip} onClick={paste} disabled={!canPaste} />
          <Button
            ref={toNextRef}
            className={styles.tool}
            size="sm"
            variant="ghost"
            icon="duplicate"
            onClick={toNext}
            disabled={lastPage}
            tip={lastPage ? `Clips are at most ${MAX_CLIP_BARS} bars.` : `Copy bar ${bar} onto bar ${bar + 1}${page + 1 >= clip.bars ? ' (the clip gets longer)' : ''}.`}
          >
            {lastPage ? 'To next bar' : `To bar ${bar + 1}`}
          </Button>
          <IconButton ref={clearRef} className={styles.tool} icon="trash" size="sm" variant="ghost" label={`Clear bar ${bar}`} tip={hasNotes ? `Remove every note in bar ${bar}. Undo brings them back.` : `Bar ${bar} is already empty.`} onClick={clear} disabled={!hasNotes} />
        </div>
      ) : (
        <Button
          ref={moreRef}
          className={styles.more}
          size="sm"
          variant="ghost"
          aria-label={fold >= 2 ? `Bar ${bar} and clip tools` : `Bar ${bar} tools`}
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'more'}
          onClick={open('more')}
          tip={fold >= 2 ? `Copy, paste or clear bar ${bar}; double the clip; tighten or loosen its timing.` : `Copy, paste or clear bar ${bar}, or copy it to the next bar.`}
        >
          <MoreIcon />
        </Button>
      )}
      <div className={styles.group} role="group" aria-label="Clip tools">
        {fold < 2 && (
          <Button
            ref={doubleRef}
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
        )}
        {stepKeys && <TransposeStepper trackId={trackId} slot={slot} clipName={clip.name} unit="step" text="Transpose" keyName={keyName} />}
        {semitoneInline && <TransposeStepper trackId={trackId} slot={slot} clipName={clip.name} unit="semitone" text={inKey ? 'Semitone' : 'Transpose'} keyName={keyName} />}
        {fold < 2 && (
          <Button className={styles.tool} size="sm" variant="ghost" icon="clock" aria-haspopup="menu" aria-expanded={menu?.kind === 'timing'} disabled={!clipHasNotes} onClick={open('timing')} tip={timingTip}>
            Timing…
          </Button>
        )}
      </div>
      {menu?.kind === 'timing' && (
        <Popover anchor={menu.anchor} label="Timing" onClose={() => setMenu(null)} returnFocus={menu.el}>
          <MenuItem icon="clock" onSelect={() => then('tighten')}>
            Tighten timing…
          </MenuItem>
          <MenuItem icon="dice" onSelect={() => then('loosen')}>
            Loosen (humanize)…
          </MenuItem>
        </Popover>
      )}
      {menu?.kind === 'more' && (
        <Popover anchor={menu.anchor} label={fold >= 2 ? `Bar ${bar} and clip tools` : `Bar ${bar} tools`} onClose={() => setMenu(null)} returnFocus={menu.el}>
          <MenuHeader eyebrow={clip.name} title={`Bar ${bar}`} />
          <MenuItem icon="copy" onSelect={after(copy)}>
            Copy bar {bar}
          </MenuItem>
          <MenuItem icon="paste" disabled={!canPaste} disabledReason={clipboard ? 'Copied from another kind of part' : 'Copy a bar first'} onSelect={after(paste)}>
            Paste onto bar {bar}
          </MenuItem>
          <MenuItem icon="duplicate" disabled={lastPage} disabledReason={`Clips are at most ${MAX_CLIP_BARS} bars`} onSelect={after(toNext)}>
            {lastPage ? 'Copy to the next bar' : `Copy bar ${bar} to bar ${bar + 1}`}
          </MenuItem>
          <MenuItem icon="trash" disabled={!hasNotes} disabledReason="Already empty" onSelect={after(clear)}>
            Clear bar {bar}
          </MenuItem>
          {fold >= 2 && (
            <>
              <MenuSeparator />
              <MenuItem disabled={longest} disabledReason={`Already ${MAX_CLIP_BARS} bars`} onSelect={after(double)}>
                Double the clip (×2)
              </MenuItem>
              <MenuItem icon="clock" disabled={!clipHasNotes} disabledReason="No notes yet" onSelect={() => then('tighten')}>
                Tighten timing…
              </MenuItem>
              <MenuItem icon="dice" disabled={!clipHasNotes} disabledReason="No notes yet" onSelect={() => then('loosen')}>
                Loosen (humanize)…
              </MenuItem>
            </>
          )}
          {semitoneKeys && !semitoneInline && (
            <>
              <MenuSeparator />
              <MenuItem icon="plus" onSelect={after(() => transposeClip(trackId, slot, 'semitone', 1, false))}>
                Transpose up a semitone
              </MenuItem>
              <MenuItem icon="minus" onSelect={after(() => transposeClip(trackId, slot, 'semitone', -1, false))}>
                Transpose down a semitone
              </MenuItem>
            </>
          )}
        </Popover>
      )}
      {menu?.kind === 'tighten' && <TightenMenu trackId={trackId} slot={slot} anchor={menu.anchor} returnFocus={menu.el} onClose={() => setMenu(null)} />}
      {menu?.kind === 'loosen' && <LoosenMenu trackId={trackId} slot={slot} anchor={menu.anchor} returnFocus={menu.el} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * Fold the toolbar until the bar row fits on one line (see ToolsFold),
 * measured, so it holds at any width, zoom, bar count or Simple/Advanced:
 * the row's items keep their natural width, and when they need more than
 * the row has the next fold is tried. A wider row unfolds again (to the
 * fullest layout measured to fit). Starts over when what is shown changes.
 */
function useToolsFold(rowRef: { current: HTMLDivElement | null }, deps: readonly unknown[]): ToolsFold {
  const [fold, setFold] = useState<ToolsFold>(0);
  const needs = useRef<number[]>([]);
  useLayoutEffect(() => {
    needs.current = [];
    setFold(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const check = () => {
      const kids = [...row.children].filter((k) => getComputedStyle(k).display !== 'none') as HTMLElement[];
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const need = kids.reduce((sum, k) => sum + k.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1);
      const room = row.clientWidth;
      needs.current[fold] = need;
      if (need > room + 0.5 && fold < MAX_FOLD) {
        setFold((fold + 1) as ToolsFold);
        return;
      }
      for (let f = 0; f < fold; f++) {
        const n = needs.current[f];
        if (n !== undefined && n <= room + 0.5) {
          setFold(f as ToolsFold);
          return;
        }
      }
    };
    check();
    // Sizes settle after fonts and other layout: look again (a frame later, so it never feeds back within one frame).
    let raf = 0;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(check);
    }) : null;
    ro?.observe(row);
    for (const k of row.children) ro?.observe(k);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fold, ...deps]);
  return fold;
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
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const inKey = useProject((p) => p.assist && p.scale !== 'chromatic');
  const rowRef = useRef<HTMLDivElement>(null);
  const fold = useToolsFold(rowRef, [trackId, slot, clip?.bars ?? 0, clip?.name ?? '', kind, advanced, inKey, locked, page >= MAX_CLIP_BARS - 1]);
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
        <div ref={rowRef} className={`${styles.row} ${styles.barLine}`}>
          <BarStrip trackId={trackId} slot={slot} bars={clip.bars} page={page} kind={kind} />
          {/* During a performance take clips are locked: say so where the editing tools were. */}
          <div className={styles.status} role="status">
            {locked && (
              <span className={styles.lock}>
                <span className={styles.lockDot} aria-hidden="true" />
                Locked while a performance records. Stop the take to edit steps.
              </span>
            )}
          </div>
          {!locked && <Tools trackId={trackId} slot={slot} page={page} clip={clip} kind={kind} trackName={trackName} fold={fold} />}
        </div>
      )}
    </div>
  );
}, sameHeader);
