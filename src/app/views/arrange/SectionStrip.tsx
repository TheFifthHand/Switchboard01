/**
 * The sections strip under the ruler: each section (Intro, Drop …) as a
 * labelled bar over its bars, with icons for its song moves (fades, filter
 * rise, echo throw). A click selects the loops that start in it, a
 * double-click (or F2) renames it in place, its edges resize the label, a
 * drag moves it with its music (laneController); right-click, the ⋯ that
 * shows near its end under the pointer (clear of the edge grip), or
 * Shift+F10 opens its actions. Hovering a stretch of the song no section
 * covers, or the bars after the song, offers "+ Add section" there (just "+"
 * where it is narrow); a new section opens for its name at once. Its name
 * stays in sight at the view's left edge while the section starts left of
 * it. Ctrl+A selects the sections with the loops (teal outline).
 *
 * The sections are one Tab stop: ← and → move between them.
 */
import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { sectionGaps } from '../../../project/arrangement';
import { MAX_SECTION_NAME, type Id, type SongMoveKind, type SongSection } from '../../../project/types';
import { MoreIcon, isMenuKey } from '../ClipMenu';
import { LaneIcon, type LaneIconName } from './laneIcons';
import { useSelectedSections } from './laneStore';
import { addSectionAt, renameSectionTo } from './songActions';
import { sectionLabel } from './songModel';
import styles from './SongView.module.css';

export const MOVE_ICON: Record<SongMoveKind, LaneIconName> = { fadeIn: 'fadeIn', fadeOut: 'fadeOut', filterRise: 'filterRise', echoThrow: 'echoThrow' };
export const MOVE_WORDS: Record<SongMoveKind, string> = { fadeIn: 'Fade in', fadeOut: 'Fade out', filterRise: 'Filter rise', echoThrow: 'Echo throw' };

function RenameField({ section, onDone }: { section: SongSection; onDone(): void }) {
  const [value, setValue] = useState(section.name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const v = value.replace(/\s+/g, ' ').trim();
    if (save && v && v !== section.name) renameSectionTo(section.id, v);
    onDone();
  };
  return (
    <input
      ref={ref}
      className={styles.sectionRename}
      value={value}
      maxLength={MAX_SECTION_NAME}
      spellCheck={false}
      autoComplete="off"
      aria-label={`Name of the section ${section.name}`}
      onChange={(e) => setValue(e.currentTarget.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

export interface SectionStripProps {
  sections: readonly SongSection[];
  /** The song's length in bars (gaps are offered up to here). */
  songBars: number;
  /** A section drag in progress: the section as it would land (drawn raised). */
  dragged: SongSection | null;
  /** A scene card would add this section. */
  newSection: { start: number; bars: number; name: string } | null;
  renaming: Id | null;
  onRenameDone(): void;
  onMenu(id: Id, trigger: HTMLElement): void;
  onRename(id: Id): void;
}

/** Bars an "+ Add section" after the song (or its last section) offers. */
export const AFTER_END_BARS = 8;

export const SectionStrip = memo(function SectionStrip({ sections, songBars, dragged, newSection, renaming, onRenameDone, onMenu, onRename }: SectionStripProps) {
  const [tabId, setTabId] = useState<Id | null>(null);
  const selected = useSelectedSections();
  // The section under the pointer shows a ⋯ at its end (its actions, as a right-click opens them).
  const [hovered, setHovered] = useState<Id | null>(null);
  const hoveredSection = !dragged && renaming === null ? sections.find((s) => s.id === hovered) : undefined;
  const tab = sections.find((s) => s.id === tabId)?.id ?? sections[0]?.id ?? null;
  const lastEnd = sections.reduce((e, s) => Math.max(e, s.start + s.bars), 0);
  const afterEnd = Math.max(songBars, lastEnd);
  const gaps = dragged ? [] : [...sectionGaps(sections, songBars), [afterEnd, afterEnd + AFTER_END_BARS] as [number, number]];
  const add = (a: number, b: number) => {
    const r = addSectionAt(a, b - a);
    if (r.changed && r.sectionId) onRename(r.sectionId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>, s: SongSection) => {
    if (isMenuKey(e)) {
      e.preventDefault();
      onMenu(s.id, e.currentTarget);
      return;
    }
    if (e.key === 'F2' || e.key === 'Enter') {
      e.preventDefault();
      onRename(s.id);
      return;
    }
    const i = sections.findIndex((x) => x.id === s.id);
    const to = e.key === 'ArrowRight' ? sections[i + 1] : e.key === 'ArrowLeft' ? sections[i - 1] : e.key === 'Home' ? sections[0] : e.key === 'End' ? sections[sections.length - 1] : undefined;
    if (!to || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    setTabId(to.id);
    (e.currentTarget.parentElement?.querySelector(`[data-section-id="${to.id}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className={styles.sections} data-sections="" data-space-plays="" role="group" aria-label="Sections of the song (← → move between them, F2 renames, Shift+F10 for actions)">
      {sections.map((s) => {
        const isDragged = dragged?.id === s.id;
        const moves = s.moves ?? [];
        return (
          <div
            key={s.id}
            className={styles.section}
            role="button"
            tabIndex={s.id === tab ? 0 : -1}
            aria-label={`Section ${sectionLabel(s)}${moves.length ? `, with ${moves.map((m) => MOVE_WORDS[m.kind].toLowerCase()).join(', ')}` : ''}`}
            aria-haspopup="menu"
            data-section-id={s.id}
            data-dragged={isDragged || undefined}
            data-selected={selected.includes(s.id) || undefined}
            aria-pressed={selected.includes(s.id) || undefined}
            style={{ '--s': s.start, '--b': s.bars } as CSSProperties}
            onFocus={() => setTabId(s.id)}
            onKeyDown={(e) => onKeyDown(e, s)}
            onPointerEnter={(e) => e.pointerType === 'mouse' && setHovered(s.id)}
            onPointerLeave={(e) => {
              if (!(e.relatedTarget instanceof Element && e.relatedTarget.closest('[data-section-more]'))) setHovered((h) => (h === s.id ? null : h));
            }}
          >
            {renaming === s.id ? (
              <RenameField section={s} onDone={onRenameDone} />
            ) : (
              <>
                <span className={styles.sectionName}>{s.name}</span>
                {moves.length > 0 && (
                  <span className={styles.sectionMoves} aria-hidden="true">
                    {moves.map((m) => (
                      <LaneIcon key={m.id} name={MOVE_ICON[m.kind]} size={12} />
                    ))}
                  </span>
                )}
              </>
            )}
            <span className={styles.sectionEdge} data-section-edge="start" aria-hidden="true" />
            <span className={styles.sectionEdge} data-section-edge="end" aria-hidden="true" />
          </div>
        );
      })}
      {hoveredSection && hoveredSection.bars > 1 && (
        <button
          type="button"
          className={styles.sectionMore}
          data-section-more=""
          tabIndex={-1}
          aria-label={`Actions for the section ${hoveredSection.name}`}
          aria-haspopup="menu"
          style={{ '--e': hoveredSection.start + hoveredSection.bars } as CSSProperties}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerLeave={() => setHovered(null)}
          onClick={(e) => onMenu(hoveredSection.id, e.currentTarget)}
        >
          <MoreIcon size={12} />
        </button>
      )}
      {newSection && (
        <div className={styles.section} data-new="" aria-hidden="true" style={{ '--s': newSection.start, '--b': newSection.bars } as CSSProperties}>
          <span className={styles.sectionName}>{newSection.name}</span>
        </div>
      )}
      {gaps.map(([a, b]) => (
        <button
          key={`gap-${a}`}
          type="button"
          className={styles.addSection}
          data-section-gap=""
          style={{ '--s': a, '--b': b - a } as CSSProperties}
          aria-label={`Add a section over bars ${a + 1} to ${b}`}
          title={`Add a section over bars ${a + 1} to ${b}`}
          data-after-end={a >= afterEnd || undefined}
          tabIndex={-1}
          onClick={() => add(a, b)}
        >
          <span aria-hidden="true">+</span>
          <span className={styles.addSectionText}> Add section</span>
        </button>
      ))}
    </div>
  );
});
