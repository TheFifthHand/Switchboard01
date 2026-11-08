/**
 * The Song view's menus and the loop picker (Popover, as every menu in the
 * app: arrow keys, Escape, a press outside closes it).
 *
 * - Region menu (right-click, ⋯ on hover, Shift+F10): Play from here, Loop
 *   this, Duplicate, Split at playhead / Split here, Delete, Use another
 *   loop ▸, Edit notes, Make this one different (when its loop plays in
 *   other places too, or is also a pad's clip), Put on a pad (a loop of the
 *   song's own), Make it 2× longer, Name these bars as a section.
 * - Section menu: Rename, Duplicate, Move earlier / Move later, Delete
 *   section (the label) / Delete section and its music, the song moves
 *   (checked when on), Build up / Strip down / Breakdown (unavailable with
 *   the reason when they would do nothing), Loop this section, Play from here.
 * - Loop picker (double-click an empty spot on a row): the part's loops with
 *   their length and a picture of their notes (choosing one places it
 *   there), a new empty loop of 1, 2, 4 or 8 bars, and on drum parts "Start
 *   from a beat…": the beats by style, each with ▶ to hear it on the part.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ClipSketch, Icon } from '../../../ui/components';
import { regionEnd, sectionAt } from '../../../project/arrangement';
import { clipById } from '../../../project/clips';
import { SONG_MOVE_KINDS, TICKS_PER_BAR, type ClipBars, type Id, type SongRegion, type SongSection } from '../../../project/types';
import { shapeProblem, type ShapeKind } from '../../../state/commands';
import { session, useProject, useUi } from '../../instance';
import { startPreview, stopPreview, usePreviewKey } from '../../preview';
import { useRuntime } from '../../runtime';
import { MenuHeader, MenuItem, MenuSeparator, Popover, LOCKED_REASON, MOD_KEY, useEditLocked, type MenuAnchor } from '../ClipMenu';
import menuStyles from '../ClipMenu.module.css';
import { LaneIcon, type LaneIconName } from './laneIcons';
import { moveSectionStepNow } from './laneEdits';
import { beatMeta, beatsByStyle, libraryLoop, realizeFor } from './library/libraryModel';
import libStyles from './library/Library.module.css';
import { MOVE_ICON, MOVE_WORDS } from './SectionStrip';
import * as act from './songActions';
import { barsText, loopPlaces, partLoops, rangeText, sectionLabel } from './songModel';
import { lastsText } from './songHome';
import { nameNow, useInstrumentName } from '../useInstrumentName';
import styles from './SongView.module.css';

/** Reasons longer than this wrap under the label (a hint on the right would be cut off). */
const SHORT_REASON = 24;

/** A menu row with one of the lane's own icons (same look and keys as MenuItem); `submenu`: a chevron at its right end. */
export function LaneMenuItem(props: { icon: LaneIconName; children: ReactNode; hint?: string; disabled?: boolean; disabledReason?: string; role?: 'menuitem' | 'menuitemcheckbox'; checked?: boolean; submenu?: boolean; onSelect(): void }) {
  const { icon, children, hint, disabled, disabledReason, role = 'menuitem', checked, submenu, onSelect } = props;
  const reason = disabled && disabledReason ? disabledReason : null;
  const why = reason && reason.length > SHORT_REASON ? reason : null;
  const shown = why ? null : (reason ?? hint);
  return (
    <button
      type="button"
      role={role}
      tabIndex={-1}
      className={why ? `${menuStyles.item} ${styles.whyItem}` : menuStyles.item}
      aria-checked={role === 'menuitemcheckbox' ? !!checked : undefined}
      aria-haspopup={submenu ? 'menu' : undefined}
      data-checked={checked || undefined}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onSelect();
      }}
    >
      <span className={menuStyles.itemIcon} aria-hidden="true">
        <LaneIcon name={icon} size={14} />
      </span>
      <span className={menuStyles.itemText}>
        {children}
        {why && <span className={styles.itemWhy}>{why}</span>}
      </span>
      {shown && <span className={menuStyles.itemHint}>{shown}</span>}
      {submenu && (
        <span className={styles.itemChevron} aria-hidden="true">
          <Icon name="chevronRight" size={12} />
        </span>
      )}
    </button>
  );
}

/** What the menus need from the timeline. */
export interface MenuHost {
  /** Play the song from a bar. */
  playFrom(bar: number): void;
  /** Set the loop range to these bars and loop them. */
  loopBars(fromBar: number, toBar: number): void;
  /** The song cursor (where Play starts), or the playhead while the song plays. */
  playheadBar(): number;
  /** Open a loop's notes in Play › Steps. */
  editNotes(id: Id): void;
  /** Start renaming a section in place. */
  renameSection(id: Id): void;
}

/* ------------------------------------------------------------------ */
/* Region menu                                                         */
/* ------------------------------------------------------------------ */

export function RegionMenu(props: {
  region: SongRegion;
  /** The selection it acts on (the region's, when it is selected). */
  targets: readonly Id[];
  clickedBar: number | null;
  anchor: MenuAnchor;
  returnFocus: HTMLElement | null;
  /** The key that opened it (its own click closes it again). */
  ignore?: Element | null;
  host: MenuHost;
  onClose(): void;
}) {
  const { region, targets, clickedBar, anchor, returnFocus, ignore, host, onClose } = props;
  const [view, setView] = useState<'main' | 'swap'>('main');
  const locked = useEditLocked();
  const loops = useProject((p) => partLoops(p, region.trackId));
  const partName = useInstrumentName(region.trackId, 'part');
  const loop = loops.find((l) => l.clipId === region.clipId);
  const clipName = loop?.name ?? 'Loop';
  const places = useProject((p) => loopPlaces(p, region.trackId, region.clipId));
  const padsFull = useProject((p) => !p.tracks.find((t) => t.id === region.trackId)?.clips.some((c) => c === null));
  const hasSection = useProject((p) => p.arrangement.sections.some((s) => s.start < regionEnd(region) && regionEnd(s) > region.start));
  const many = targets.length > 1;
  const what = many ? `${targets.length} loops` : clipName;
  // Simple speaks of instruments, places and seconds: no bar numbers, no pads.
  const simple = useUi((s) => s.uiMode === 'simple');
  const bpm = useProject((p) => p.bpm);
  const regionSection = useProject((p) => sectionAt(p.arrangement.sections, region.start)?.name ?? null);
  const playhead = host.playheadBar();
  const splitAt = (bar: number) => region.start < bar && bar < regionEnd(region);
  const canSplitPlayhead = targets.some((id) => {
    const r = session.store.getState().arrangement.regions.find((x) => x.id === id);
    return !!r && r.start < playhead && playhead < regionEnd(r);
  });
  const reason = locked ? LOCKED_REASON : undefined;
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  if (view === 'swap') {
    return (
      <Popover anchor={anchor} label={`Use another loop for ${clipName}`} onClose={onClose} returnFocus={returnFocus} ignore={ignore}>
        <MenuHeader eyebrow={partName} title="Use another loop" />
        <MenuItem icon="chevronLeft" onSelect={() => setView('main')}>
          Back
        </MenuItem>
        <MenuSeparator />
        {loops.map((l) => {
          const now = l.clipId === region.clipId;
          // The loop it plays now is ticked (choosing it again changes nothing).
          return (
            <MenuItem key={l.clipId} icon={now ? 'check' : undefined} role="menuitemcheckbox" checked={now} hint={simple ? (now ? 'Playing' : undefined) : now ? `Playing · ${barsText(l.bars)}` : barsText(l.bars)} disabled={locked} disabledReason={reason} onSelect={run(() => !now && act.swapLoopClip(region.id, l.clipId))}>
              {l.name}
            </MenuItem>
          );
        })}
      </Popover>
    );
  }
  return (
    <Popover anchor={anchor} label={`Actions for ${what}`} onClose={onClose} returnFocus={returnFocus} ignore={ignore}>
      <MenuHeader eyebrow={many ? 'Selected loops' : partName} title={many ? what : simple ? (regionSection ? `${clipName} · ${regionSection}` : clipName) : `${clipName} · ${rangeText(region.start, regionEnd(region))}`} />
      <MenuItem icon="play" onSelect={run(() => host.playFrom(region.start))}>
        Play from here
      </MenuItem>
      <LaneMenuItem icon="loop" onSelect={run(() => host.loopBars(region.start, regionEnd(region)))}>
        {simple ? 'Repeat this' : 'Loop this'}
      </LaneMenuItem>
      <MenuSeparator />
      <MenuItem icon="duplicate" hint={`${MOD_KEY}D`} keyShortcut={`${MOD_KEY === '⌘' ? 'Meta' : 'Control'}+D`} disabled={locked} disabledReason={reason} onSelect={run(() => act.duplicateLoops(targets))}>
        Duplicate
      </MenuItem>
      <MenuItem
        icon="scissors"
        hint={`${MOD_KEY}E`}
        keyShortcut={canSplitPlayhead ? `${MOD_KEY === '⌘' ? 'Meta' : 'Control'}+E` : undefined}
        disabled={locked || !canSplitPlayhead}
        disabledReason={reason ?? (simple ? 'The playing line is not on this loop' : targets.length > 1 ? 'Playhead not in these loops' : 'Playhead not in this loop')}
        onSelect={run(() => act.splitLoops(targets, playhead))}
      >
        {simple ? 'Split at the playing line' : 'Split at playhead'}
      </MenuItem>
      {clickedBar !== null && splitAt(clickedBar) && (
        <MenuItem icon="cut" hint={simple ? undefined : `Bar ${clickedBar + 1}`} disabled={locked} disabledReason={reason} onSelect={run(() => act.splitLoops([region.id], clickedBar))}>
          Split here
        </MenuItem>
      )}
      <MenuItem icon="trash" tone="danger" hint="Delete" keyShortcut="Delete" disabled={locked} disabledReason={reason} onSelect={run(() => act.deleteLoops(targets))}>
        Delete
      </MenuItem>
      <MenuSeparator />
      {!many && (
        <LaneMenuItem icon="layers" submenu hint={loops.length > 1 ? `${loops.length} loops` : undefined} disabled={locked || loops.length < 2} disabledReason={reason ?? 'Only one loop'} onSelect={() => setView('swap')}>
          Use another loop
        </LaneMenuItem>
      )}
      {!many && (
        <MenuItem icon="pencil" hint={simple ? 'Click' : 'Double-click'} onSelect={run(() => host.editNotes(region.id))}>
          Edit notes
        </MenuItem>
      )}
      {!many && loop && (places > 1 || !loop.inSong) && (
        <MenuItem
          icon="copy"
          hint={places > 1 ? `Plays in ${places} places` : simple ? 'Also on the jam pads' : 'Also on a pad'}
          disabled={locked}
          disabledReason={reason}
          onSelect={run(() => act.makeLoopDifferent(region.id))}
        >
          Make this one different
        </MenuItem>
      )}
      {!many && loop?.inSong && !simple && (
        <MenuItem icon="paste" disabled={locked || padsFull} disabledReason={reason ?? `Every ${partName} pad has a loop`} onSelect={run(() => act.putLoopOnPad(region.trackId, region.clipId))}>
          Put on a pad
        </MenuItem>
      )}
      {!many && (
        <MenuItem icon="plus" hint={simple ? lastsText(region.bars * 2, bpm) : barsText(region.bars * 2)} disabled={locked} disabledReason={reason} onSelect={run(() => act.doubleLoop(region.id))}>
          {simple ? 'Make it twice as long' : 'Make it 2× longer'}
        </MenuItem>
      )}
      {!many && !hasSection && (
        <MenuItem icon="scene" disabled={locked} disabledReason={reason} onSelect={run(() => {
            // The new section opens for its name at once.
            const r = act.addSectionAt(region.start, region.bars);
            if (r.changed && r.sectionId) host.renameSection(r.sectionId);
          })}>
          {simple ? 'Name it as a section' : 'Name these bars as a section'}
        </MenuItem>
      )}
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* Section menu                                                        */
/* ------------------------------------------------------------------ */

const SHAPES: { kind: ShapeKind; icon: LaneIconName; what: string }[] = [
  { kind: 'build', icon: 'buildUp', what: 'Instruments come in one by one across the section.' },
  { kind: 'strip', icon: 'stripDown', what: 'Every instrument first, then they drop out one by one.' },
  { kind: 'breakdown', icon: 'breakdown', what: 'The drums, percussion and bass leave this section.' },
];

export function SectionMenu(props: { section: SongSection; anchor: MenuAnchor; returnFocus: HTMLElement | null; host: MenuHost; onClose(): void }) {
  const { section, anchor, returnFocus, host, onClose } = props;
  const locked = useEditLocked();
  const simple = useUi((s) => s.uiMode === 'simple');
  const live = useProject((p) => p.arrangement.sections.find((s) => s.id === section.id) ?? section);
  const problems = useProject((p) => SHAPES.map((s) => shapeProblem(p, section.id, s.kind)).join('\u0000'));
  const problemOf = (i: number) => problems.split('\u0000')[i] || null;
  const reason = locked ? LOCKED_REASON : undefined;
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const moves = new Set((live.moves ?? []).map((m) => m.kind));
  const order = useProject((p) => {
    const sorted = [...p.arrangement.sections].sort((a, b) => a.start - b.start);
    const i = sorted.findIndex((x) => x.id === section.id);
    return { first: i <= 0, last: i < 0 || i === sorted.length - 1 };
  }, (a, b) => a.first === b.first && a.last === b.last);
  return (
    <Popover anchor={anchor} label={`Actions for the section ${live.name}`} onClose={onClose} returnFocus={returnFocus} className={styles.sectionMenu}>
      <MenuHeader eyebrow="Section" title={simple ? live.name : sectionLabel(live)} />
      <MenuItem icon="play" onSelect={run(() => host.playFrom(live.start))}>
        Play from here
      </MenuItem>
      <LaneMenuItem icon="loop" onSelect={run(() => host.loopBars(live.start, regionEnd(live)))}>
        {simple ? 'Repeat this section' : 'Loop this section'}
      </LaneMenuItem>
      <MenuSeparator />
      <MenuItem icon="pencil" hint="F2" disabled={locked} disabledReason={reason} onSelect={run(() => host.renameSection(live.id))}>
        Rename
      </MenuItem>
      <MenuItem icon="duplicate" disabled={locked} disabledReason={reason} onSelect={run(() => act.duplicateSectionNow(live.id))}>
        Duplicate
      </MenuItem>
      <MenuItem icon="chevronLeft" hint="Alt+←" disabled={locked || order.first} disabledReason={reason ?? 'Already the first section'} onSelect={run(() => moveSectionStepNow(live.id, -1))}>
        Move earlier
      </MenuItem>
      <MenuItem icon="chevronRight" hint="Alt+→" disabled={locked || order.last} disabledReason={reason ?? 'Already the last section'} onSelect={run(() => moveSectionStepNow(live.id, 1))}>
        Move later
      </MenuItem>
      <MenuItem icon="close" disabled={locked} disabledReason={reason} onSelect={run(() => act.removeSectionNow(live.id, false))}>
        Delete section (keep the music)
      </MenuItem>
      <MenuItem icon="trash" tone="danger" disabled={locked} disabledReason={reason} onSelect={run(() => act.removeSectionNow(live.id, true))}>
        Delete section and its music
      </MenuItem>
      <MenuSeparator />
      {SONG_MOVE_KINDS.map((kind) => (
        <LaneMenuItem key={kind} icon={MOVE_ICON[kind]} role="menuitemcheckbox" checked={moves.has(kind)} hint={moves.has(kind) ? 'On' : undefined} disabled={locked} disabledReason={reason} onSelect={() => act.toggleSectionMoveNow(live.id, kind)}>
          {MOVE_WORDS[kind]}
        </LaneMenuItem>
      ))}
      <MenuSeparator />
      {SHAPES.map((s, i) => {
        const problem = problemOf(i);
        return (
          <LaneMenuItem key={s.kind} icon={s.icon} disabled={locked || !!problem} disabledReason={reason ?? problem ?? undefined} hint={undefined} onSelect={run(() => act.shapeSectionNow(live.id, s.kind))}>
            <span title={problem ? undefined : s.what}>{act.SHAPE_WORDS[s.kind]}</span>
          </LaneMenuItem>
        );
      })}
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* Loop picker                                                         */
/* ------------------------------------------------------------------ */

/** Lengths "New empty loop" offers (bars). */
export const NEW_LOOP_BARS: readonly ClipBars[] = [1, 2, 4, 8];

export function LoopPicker(props: { trackId: Id; bar: number; anchor: MenuAnchor; returnFocus: HTMLElement | null; onClose(): void }) {
  const { trackId, bar, anchor, returnFocus, onClose } = props;
  const [view, setView] = useState<'main' | 'beats'>('main');
  const locked = useEditLocked();
  const loops = useProject((p) => partLoops(p, trackId));
  const track = useProject((p) => p.tracks.find((t) => t.id === trackId) ?? null);
  const trackName = useInstrumentName(trackId);
  const kind = track?.instrument.kind === 'drums' ? 'drums' : 'notes';
  const section = useProject((p) => sectionAt(p.arrangement.sections, bar)?.name ?? null);
  const simple = useUi((s) => s.uiMode === 'simple');
  const bpm = useProject((p) => p.bpm);
  // Simple: lengths in seconds and places by name, never bars.
  const len = (n: number) => (simple ? lastsText(n, bpm) : barsText(n));
  const eyebrow = simple ? `${trackName || 'Instrument'}${section ? ` · ${section}` : ''}` : `${track?.name ?? 'Part'} · bar ${bar + 1}${section ? ` · ${section}` : ''}`;
  if (view === 'beats' && track) return <BeatPicker trackId={trackId} bar={bar} eyebrow={eyebrow} anchor={anchor} returnFocus={returnFocus} onBack={() => setView('main')} onClose={onClose} />;
  return (
    <Popover anchor={anchor} label={simple ? `Add a loop to ${trackName || 'this instrument'}${section ? ` in ${section}` : ''}` : `Add a loop to ${track?.name ?? 'this part'} at bar ${bar + 1}`} onClose={onClose} returnFocus={returnFocus} className={styles.picker}>
      <MenuHeader eyebrow={eyebrow} title="Add a loop here" />
      {loops.map((l) => (
        <button
          key={l.clipId}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={`${menuStyles.item} ${styles.pickerItem}`}
          aria-disabled={locked || undefined}
          aria-label={`${l.name}, ${len(l.bars)}`}
          onClick={() => {
            if (locked) return;
            onClose();
            act.addLoop(trackId, l.clipId, bar);
          }}
        >
          <span className={styles.pickerSketch} aria-hidden="true">
            <ClipSketch notes={(track && clipById(track, l.clipId)?.notes) || []} lengthTicks={l.bars * TICKS_PER_BAR} kind={kind} />
          </span>
          <span className={menuStyles.itemText}>{l.name}</span>
          <span className={menuStyles.itemHint}>{locked ? LOCKED_REASON : len(l.bars)}</span>
        </button>
      ))}
      {loops.length > 0 && <MenuSeparator />}
      <div className={libStyles.newLoop} data-testid="new-empty-loop">
        <span className={libStyles.newLoopLabel}>New empty loop</span>
        {NEW_LOOP_BARS.map((n) => (
          <button
            key={n}
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-row="new-loop"
            className={libStyles.barsKey}
            aria-label={`New empty loop, ${len(n)}`}
            aria-disabled={locked || undefined}
            title={locked ? LOCKED_REASON : `An empty loop of ${len(n)} here, opened below to add notes`}
            data-bars={n}
            onClick={() => {
              if (locked) return;
              onClose();
              act.newEmptyLoop(trackId, bar, n);
            }}
          >
            {simple ? `${Math.round((n * 240) / Math.max(1, bpm))} s` : n}
          </button>
        ))}
      </div>
      {kind === 'drums' && (
        <LaneMenuItem icon="layers" submenu disabled={locked} disabledReason={LOCKED_REASON} onSelect={() => setView('beats')}>
          Start from a beat…
        </LaneMenuItem>
      )}
    </Popover>
  );
}

/** "Start from a beat…": the beats by style; ▶ hears one on the part, choosing one places it at the bar. */
function BeatPicker(props: { trackId: Id; bar: number; eyebrow: string; anchor: MenuAnchor; returnFocus: HTMLElement | null; onBack(): void; onClose(): void }) {
  const { trackId, bar, eyebrow, anchor, returnFocus, onBack, onClose } = props;
  const locked = useEditLocked();
  const hearing = usePreviewKey();
  const block = useRuntime((s) => (s.playing || s.paused ? 'Stop playback to hear a beat' : s.recording !== 'off' ? 'Stop recording to hear a beat' : null));
  const quiet = useProject((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return null;
    return t.mute ? `${nameNow(t)} is muted` : p.tracks.some((x) => x.solo) && !t.solo ? `${nameNow(t)} is not soloed` : null;
  });
  // Stop hearing a beat when the menu closes.
  useEffect(() => () => stopPreview(), []);
  const hear = (id: string) => {
    if (hearing === id) {
      stopPreview();
      return;
    }
    const p = session.store.getState();
    const t = p.tracks.find((x) => x.id === trackId);
    const loop = libraryLoop(id);
    const notes = t && loop ? realizeFor(p, loop, t) : null;
    if (notes) void startPreview(id, trackId, notes.notes, notes.bars);
  };
  const why = block ?? quiet;
  return (
    <Popover anchor={anchor} label="Start from a beat" onClose={onClose} returnFocus={returnFocus} className={styles.picker}>
      <MenuHeader eyebrow={eyebrow} title="Start from a beat" />
      <MenuItem icon="chevronLeft" onSelect={onBack}>
        Back
      </MenuItem>
      <MenuSeparator />
      <div className={libStyles.beatList} data-testid="beat-picker">
        {beatsByStyle().map((g) => (
          <div key={g.genre} role="group" aria-label={g.name}>
            <p className={libStyles.beatStyle} aria-hidden="true">
              {g.name}
            </p>
            {g.beats.map((b) => {
              const on = hearing === b.id;
              const off = !on && why !== null;
              return (
                <div key={b.id} className={libStyles.beatRow}>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    data-row={b.id}
                    data-beat={b.id}
                    className={menuStyles.item}
                    aria-disabled={locked || undefined}
                    aria-label={`${b.name}, ${g.name}, ${beatMeta(b)}`}
                    onClick={() => {
                      if (locked) return;
                      onClose();
                      act.addLibraryLoop(b.id, trackId, bar, { say: true });
                    }}
                  >
                    <span className={menuStyles.itemText}>{b.name}</span>
                    <span className={menuStyles.itemHint}>{locked ? LOCKED_REASON : beatMeta(b)}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    data-row={b.id}
                    data-beat-hear={b.id}
                    className={libStyles.beatHear}
                    data-hearing={on || undefined}
                    aria-pressed={on}
                    aria-disabled={off || undefined}
                    aria-label={on ? `Stop hearing ${b.name}` : off ? `Hear ${b.name} (${why})` : `Hear ${b.name}`}
                    title={on ? `Stop ${b.name}` : (why ?? `Hear ${b.name} once on this part`)}
                    onClick={() => {
                      if (!off) hear(b.id);
                    }}
                  >
                    <Icon name={on ? 'stop' : 'play'} size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Popover>
  );
}
