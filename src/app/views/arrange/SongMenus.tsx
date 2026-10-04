/**
 * The Song view's menus and the loop picker (Popover, as every menu in the
 * app: arrow keys, Escape, a press outside closes it).
 *
 * - Region menu (right-click, ⋯ on hover, Shift+F10): Play from here, Loop
 *   this, Duplicate, Split at playhead / Split here, Delete, Use another
 *   loop ▸, Edit notes, Make it 2× longer, Name these bars as a section.
 * - Section menu: Rename, Duplicate, Delete section (the label) / Delete
 *   section and its music, the song moves (checked when on), Build up /
 *   Strip down / Breakdown (unavailable with the reason when they would do
 *   nothing), Loop this section, Play from here.
 * - Loop picker (double-click an empty spot on a row): the part's loops with
 *   their length and a picture of their notes; choosing one places it there.
 */
import { useState, type ReactNode } from 'react';
import { ClipSketch } from '../../../ui/components';
import { regionEnd, sectionAt } from '../../../project/arrangement';
import { SONG_MOVE_KINDS, TICKS_PER_BAR, type Id, type SongRegion, type SongSection } from '../../../project/types';
import { shapeProblem, type ShapeKind } from '../../../state/commands';
import { session, useProject } from '../../instance';
import { MenuHeader, MenuItem, MenuSeparator, Popover, LOCKED_REASON, MOD_KEY, useEditLocked, type MenuAnchor } from '../ClipMenu';
import menuStyles from '../ClipMenu.module.css';
import { LaneIcon, type LaneIconName } from './laneIcons';
import { MOVE_ICON, MOVE_WORDS } from './SectionStrip';
import * as act from './songActions';
import { barsText, partLoops, rangeText, sectionLabel } from './songModel';
import styles from './SongView.module.css';

/** A menu row with one of the lane's own icons (same look and keys as MenuItem). */
/** Reasons longer than this wrap under the label (a hint on the right would be cut off). */
const SHORT_REASON = 24;

export function LaneMenuItem(props: { icon: LaneIconName; children: ReactNode; hint?: string; disabled?: boolean; disabledReason?: string; role?: 'menuitem' | 'menuitemcheckbox'; checked?: boolean; onSelect(): void }) {
  const { icon, children, hint, disabled, disabledReason, role = 'menuitem', checked, onSelect } = props;
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
  const partName = useProject((p) => p.tracks.find((t) => t.id === region.trackId)?.name ?? 'part');
  const clipName = loops.find((l) => l.clipId === region.clipId)?.name ?? 'Loop';
  const hasSection = useProject((p) => p.arrangement.sections.some((s) => s.start < regionEnd(region) && regionEnd(s) > region.start));
  const many = targets.length > 1;
  const what = many ? `${targets.length} loops` : clipName;
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
        {loops.map((l) => (
          <MenuItem key={l.clipId} role="menuitemcheckbox" checked={l.clipId === region.clipId} hint={barsText(l.bars)} disabled={locked || l.clipId === region.clipId} disabledReason={reason} onSelect={run(() => act.swapLoopClip(region.id, l.clipId))}>
            {l.name}
          </MenuItem>
        ))}
      </Popover>
    );
  }
  return (
    <Popover anchor={anchor} label={`Actions for ${what}`} onClose={onClose} returnFocus={returnFocus} ignore={ignore}>
      <MenuHeader eyebrow={many ? 'Selected loops' : partName} title={many ? what : `${clipName} · ${rangeText(region.start, regionEnd(region))}`} />
      <MenuItem icon="play" onSelect={run(() => host.playFrom(region.start))}>
        Play from here
      </MenuItem>
      <LaneMenuItem icon="loop" onSelect={run(() => host.loopBars(region.start, regionEnd(region)))}>
        Loop this
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
        disabledReason={reason ?? (targets.length > 1 ? 'Playhead not in these loops' : 'Playhead not in this loop')}
        onSelect={run(() => act.splitLoops(targets, playhead))}
      >
        Split at playhead
      </MenuItem>
      {clickedBar !== null && splitAt(clickedBar) && (
        <MenuItem icon="cut" hint={`Bar ${clickedBar + 1}`} disabled={locked} disabledReason={reason} onSelect={run(() => act.splitLoops([region.id], clickedBar))}>
          Split here
        </MenuItem>
      )}
      <MenuItem icon="trash" tone="danger" hint="Delete" keyShortcut="Delete" disabled={locked} disabledReason={reason} onSelect={run(() => act.deleteLoops(targets))}>
        Delete
      </MenuItem>
      <MenuSeparator />
      {!many && (
        <MenuItem icon="chevronRight" hint={loops.length > 1 ? `${loops.length} loops` : 'Only one'} disabled={locked || loops.length < 2} disabledReason={reason ?? 'This part has one loop'} onSelect={() => setView('swap')}>
          Use another loop
        </MenuItem>
      )}
      {!many && (
        <MenuItem icon="pencil" hint="Double-click" onSelect={run(() => host.editNotes(region.id))}>
          Edit notes
        </MenuItem>
      )}
      {!many && (
        <MenuItem icon="plus" hint={barsText(region.bars * 2)} disabled={locked} disabledReason={reason} onSelect={run(() => act.doubleLoop(region.id))}>
          Make it 2× longer
        </MenuItem>
      )}
      {!many && !hasSection && (
        <MenuItem icon="scene" disabled={locked} disabledReason={reason} onSelect={run(() => act.addSectionAt(region.start, region.bars))}>
          Name these bars as a section
        </MenuItem>
      )}
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* Section menu                                                        */
/* ------------------------------------------------------------------ */

const SHAPES: { kind: ShapeKind; icon: LaneIconName; what: string }[] = [
  { kind: 'build', icon: 'buildUp', what: 'Parts come in one by one across the section.' },
  { kind: 'strip', icon: 'stripDown', what: 'Every part first, then they drop out one by one.' },
  { kind: 'breakdown', icon: 'breakdown', what: 'The drums, percussion and bass leave this section.' },
];

export function SectionMenu(props: { section: SongSection; anchor: MenuAnchor; returnFocus: HTMLElement | null; host: MenuHost; onClose(): void }) {
  const { section, anchor, returnFocus, host, onClose } = props;
  const locked = useEditLocked();
  const live = useProject((p) => p.arrangement.sections.find((s) => s.id === section.id) ?? section);
  const problems = useProject((p) => SHAPES.map((s) => shapeProblem(p, section.id, s.kind)).join('\u0000'));
  const problemOf = (i: number) => problems.split('\u0000')[i] || null;
  const reason = locked ? LOCKED_REASON : undefined;
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const moves = new Set((live.moves ?? []).map((m) => m.kind));
  return (
    <Popover anchor={anchor} label={`Actions for the section ${live.name}`} onClose={onClose} returnFocus={returnFocus} className={styles.sectionMenu}>
      <MenuHeader eyebrow="Section" title={sectionLabel(live)} />
      <MenuItem icon="play" onSelect={run(() => host.playFrom(live.start))}>
        Play from here
      </MenuItem>
      <LaneMenuItem icon="loop" onSelect={run(() => host.loopBars(live.start, regionEnd(live)))}>
        Loop this section
      </LaneMenuItem>
      <MenuSeparator />
      <MenuItem icon="pencil" hint="F2" disabled={locked} disabledReason={reason} onSelect={run(() => host.renameSection(live.id))}>
        Rename
      </MenuItem>
      <MenuItem icon="duplicate" disabled={locked} disabledReason={reason} onSelect={run(() => act.duplicateSectionNow(live.id))}>
        Duplicate
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

export function LoopPicker(props: { trackId: Id; bar: number; anchor: MenuAnchor; returnFocus: HTMLElement | null; onClose(): void }) {
  const { trackId, bar, anchor, returnFocus, onClose } = props;
  const locked = useEditLocked();
  const loops = useProject((p) => partLoops(p, trackId));
  const track = useProject((p) => p.tracks.find((t) => t.id === trackId) ?? null);
  const kind = track?.instrument.kind === 'drums' ? 'drums' : 'notes';
  const section = useProject((p) => sectionAt(p.arrangement.sections, bar)?.name ?? null);
  return (
    <Popover anchor={anchor} label={`Add a loop to ${track?.name ?? 'this part'} at bar ${bar + 1}`} onClose={onClose} returnFocus={returnFocus} className={styles.picker}>
      <MenuHeader eyebrow={`${track?.name ?? 'Part'} · bar ${bar + 1}${section ? ` · ${section}` : ''}`} title={loops.length ? 'Add a loop here' : 'No loops yet'} />
      {loops.length === 0 && <p className={styles.pickerEmpty}>Make a loop for this part on the pads in Play first.</p>}
      {loops.map((l) => (
        <button
          key={l.clipId}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={`${menuStyles.item} ${styles.pickerItem}`}
          aria-disabled={locked || undefined}
          aria-label={`${l.name}, ${barsText(l.bars)}`}
          onClick={() => {
            if (locked) return;
            onClose();
            act.addLoop(trackId, l.clipId, bar);
          }}
        >
          <span className={styles.pickerSketch} aria-hidden="true">
            <ClipSketch notes={track?.clips[l.slot]?.notes ?? []} lengthTicks={l.bars * TICKS_PER_BAR} kind={kind} />
          </span>
          <span className={menuStyles.itemText}>{l.name}</span>
          <span className={menuStyles.itemHint}>{locked ? LOCKED_REASON : barsText(l.bars)}</span>
        </button>
      ))}
    </Popover>
  );
}
