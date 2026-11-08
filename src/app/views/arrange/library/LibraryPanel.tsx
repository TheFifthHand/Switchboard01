/**
 * The loop browser's Library tab: the app's own loops (beats, percussion,
 * bass, chords, melodies, pads, textures), made for any song.
 *
 *   [🔍 Search loops            ]
 *   PART   [Beats] [Bass] [Chords] …     one part at a time (press again: all)
 *   STYLE  [House] [Trap] [Lo-fi] …      one style at a time
 *   [▶] ▒▒ Steady Four   1 bar · House
 *   [▶] ▒▒ Rolling Bass  2 bars · Techno
 *   [Show 30 more]
 *
 * Each row: ▶ hears the loop once on the part it would go to (in the song's
 * key, on that part's sound, from now); a second press stops it. While the
 * song or the pads play, ▶ is unavailable and says why. Drag a row onto a
 * part's row (a part of its kind: a beat onto a drum part), or press Enter
 * to add it at the playhead on its kind of part (the selected part when it
 * is one). The list shows LIBRARY_PAGE rows and "Show more" adds more.
 */
import { memo, useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ClipSketch, Icon, Tooltip } from '../../../../ui/components';
import type { LibraryLoop, LoopRole } from '../../../../content/loops';
import { TICKS_PER_BAR, type Id, type Project } from '../../../../project/types';
import { createStore, useStore } from '../../../../state/store';
import { uiStore } from '../../../../state/uiStore';
import { session, useProject, useUi } from '../../../instance';
import { startPreview, stopPreview, usePreviewKey } from '../../../preview';
import { useRuntime } from '../../../runtime';
import type { Carry } from '../laneController';
import { addLibraryLoopHere } from '../songActions';
import { barsText, partHue } from '../songModel';
import { INSTRUMENT_KINDS, shortOrLong } from '../songHome';
import { LIBRARY_PAGE, PART_CHIPS, libraryResults, loopRoleOf, loopTarget, realizeFor, styleChips, styleName, type LibraryQuery } from './libraryModel';
import styles from './Library.module.css';

/** Style chips shown until "more" is pressed. */
const STYLES_FOLDED = 5;

/** The search and chips, kept while the browser is closed or the other tab is open. */
export const libraryQueryStore = createStore<LibraryQuery | null>(null);

function initialQuery(): LibraryQuery {
  const p = session.store.getState();
  const t = p.tracks.find((x) => x.id === uiStore.getState().selectedTrackId);
  return { text: '', role: t ? loopRoleOf(t) : null, genre: null };
}

/** Why ▶ cannot play now (null: it can). */
function useHearBlock(): string | null {
  return useRuntime((s) => (s.mode === 'song' && (s.playing || s.paused) ? 'Stop the song to hear a loop' : s.mode === 'replay' && s.playing ? 'Stop the replay to hear a loop' : s.playing || s.paused ? 'Stop the pads to hear a loop' : s.recording !== 'off' ? 'Stop recording to hear a loop' : null));
}

/** The part each loop goes to, its name, hue and whether it is heard (muted or not soloed parts are not). */
interface Target {
  trackId: Id;
  name: string;
  hue: number;
  quiet: string | null;
}

function targetOf(p: Project, loop: LibraryLoop, selected: Id | null): Target | { problem: string } {
  const t = loopTarget(p, loop, selected);
  if ('problem' in t) return t;
  const i = p.tracks.findIndex((x) => x.id === t.trackId);
  const track = p.tracks[i];
  const anySolo = p.tracks.some((x) => x.solo);
  const quiet = track.mute ? `${track.name} is muted: unmute it to hear this loop` : anySolo && !track.solo ? `${track.name} is not heard: another instrument plays alone` : null;
  return { trackId: track.id, name: track.name, hue: partHue(i), quiet };
}

/** The notes a row draws and plays (worked out once per loop, part and key). */
const realized = new Map<string, ReturnType<typeof realizeFor>>();
function notesFor(p: Project, loop: LibraryLoop, trackId: Id): ReturnType<typeof realizeFor> {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return null;
  const key = `${loop.id}|${p.root}|${p.scale}|${t.instrument.kind}|${t.instrument.kind === 'drums' ? t.instrument.kitId : ''}|${t.role}`;
  let r = realized.get(key);
  if (r === undefined) {
    if (realized.size > 600) realized.clear();
    r = realizeFor(p, loop, t);
    realized.set(key, r);
  }
  return r;
}

export interface LibraryPanelProps {
  /** Where Enter adds a loop: the playhead / song start point. */
  playheadBar(): number;
  /** A row pressed: carry its loop onto the song (the timeline's LaneController). */
  onCarry(e: ReactPointerEvent<HTMLElement>, item: Carry): void;
}

export const LibraryPanel = memo(function LibraryPanel({ playheadBar, onCarry }: LibraryPanelProps) {
  const stored = useStore(libraryQueryStore, (s) => s);
  const q = stored ?? initialQuery();
  const set = (next: Partial<LibraryQuery>) => libraryQueryStore.setState({ ...q, ...next });
  const [shown, setShown] = useState(LIBRARY_PAGE);
  const [allStyles, setAllStyles] = useState(false);
  useEffect(() => setShown(LIBRARY_PAGE), [q.text, q.role, q.genre]);
  // Stop hearing a loop when the library goes away.
  useEffect(() => () => stopPreview(), []);
  // Simple speaks of instruments, never parts or bars.
  const simple = useUi((s) => s.uiMode === 'simple');
  const results = useMemo(() => libraryResults(q), [q.text, q.role, q.genre]);
  const styleList = useMemo(() => styleChips(q.role), [q.role]);
  const visible = results.slice(0, shown);
  // A few styles until more are asked for (the chosen one always shows).
  const styleShown = allStyles || styleList.length <= STYLES_FOLDED + 1 ? styleList : styleList.filter((g, i) => i < STYLES_FOLDED || g.id === q.genre);
  const chooseRole = (role: LoopRole) => {
    const nextRole = q.role === role ? null : role;
    // A style the new part has no loops in is let go of.
    const keep = q.genre && styleChips(nextRole).some((g) => g.id === q.genre) ? q.genre : null;
    set({ role: nextRole, genre: keep });
  };
  const onRowKey = (e: KeyboardEvent<HTMLLIElement>, loop: LibraryLoop) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      addLibraryLoopHere(loop.id, playheadBar());
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const sib = (e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null;
      sib?.focus();
    }
  };
  return (
    <div className={styles.library} data-testid="loop-library">
      <label className={styles.search}>
        <Icon name="search" size={13} />
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search loops"
          aria-label="Search the loop library"
          value={q.text}
          onChange={(e) => set({ text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && q.text) {
              e.preventDefault();
              e.stopPropagation();
              set({ text: '' });
            }
          }}
          data-testid="library-search"
        />
      </label>
      <div className={styles.chipGroup} role="group" aria-label={simple ? 'Instrument' : 'Part'}>
        <span className={styles.chipLabel} aria-hidden="true">
          {simple ? 'Instrument' : 'Part'}
        </span>
        {PART_CHIPS.map((c) => (
          <button key={c.role} type="button" className={styles.filter} aria-pressed={q.role === c.role} data-role-chip={c.role} onClick={() => chooseRole(c.role)}>
            {q.role === c.role && <Icon name="check" size={10} />}
            {simple ? INSTRUMENT_KINDS[c.role].name : c.name}
          </button>
        ))}
      </div>
      <div className={styles.chipGroup} role="group" aria-label="Style">
        <span className={styles.chipLabel} aria-hidden="true">
          Style
        </span>
        {styleShown.map((g) => (
          <button key={g.id} type="button" className={styles.filter} aria-pressed={q.genre === g.id} data-style-chip={g.id} onClick={() => set({ genre: q.genre === g.id ? null : g.id })}>
            {q.genre === g.id && <Icon name="check" size={10} />}
            {g.name}
          </button>
        ))}
        {styleShown.length < styleList.length || allStyles ? (
          <button type="button" className={styles.moreStyles} aria-expanded={allStyles} data-testid="library-styles-more" onClick={() => setAllStyles((v) => !v)}>
            {allStyles ? 'Fewer' : `${styleList.length - styleShown.length} more`}
          </button>
        ) : null}
      </div>
      <p className={styles.count} role="status" data-testid="library-count">
        {results.length === 0 ? 'No loops match.' : `${results.length === 1 ? '1 loop' : `${results.length} loops`} · drag onto ${simple ? 'an instrument' : 'a part'}, or press Enter`}
      </p>
      {results.length === 0 && (
        <button type="button" className={styles.more} onClick={() => libraryQueryStore.setState({ text: '', role: null, genre: null })}>
          Show every loop
        </button>
      )}
      <LibraryRows loops={visible} onRowKey={onRowKey} onCarry={onCarry} simple={simple} />
      {results.length > shown && (
        <button type="button" className={styles.more} onClick={() => setShown((n) => n + LIBRARY_PAGE)} data-testid="library-more">
          Show {Math.min(LIBRARY_PAGE, results.length - shown)} more
        </button>
      )}
    </div>
  );
});

function LibraryRows({ loops, onRowKey, onCarry, simple }: { loops: readonly LibraryLoop[]; onRowKey(e: KeyboardEvent<HTMLLIElement>, loop: LibraryLoop): void; onCarry: LibraryPanelProps['onCarry']; simple: boolean }) {
  // The rows follow the parts, the key and the selection (where Enter puts a loop and ▶ plays it).
  const p = useProject((x) => x);
  const selected = useStore(uiStore, (s) => s.selectedTrackId);
  const hearing = usePreviewKey();
  const block = useHearBlock();
  return (
    <ul className={styles.rows} aria-label="Library loops">
      {loops.map((loop) => {
        const target = targetOf(p, loop, selected);
        const ok = !('problem' in target);
        const notes = ok ? notesFor(p, loop, target.trackId) : null;
        const isOn = hearing === loop.id;
        const why = isOn ? null : !ok ? target.problem : (block ?? target.quiet);
        // Simple: "Short · House" (no bar counts); Advanced: "2 bars · House".
        const meta = `${simple ? shortOrLong(loop.bars) : barsText(loop.bars)} · ${styleName(loop.genres[0])}`;
        return (
          <li
            key={loop.id}
            className={styles.row}
            tabIndex={0}
            data-library-loop={loop.id}
            style={{ '--h': ok ? target.hue : 210 } as CSSProperties}
            aria-label={
              simple
                ? `${loop.name}, ${meta}${ok ? `, for ${target.name}` : ''}. Drag it onto an instrument, or press Enter to add it where the song is${ok ? ` on ${target.name}` : ''}.`
                : `${loop.name}, ${meta}${ok ? `, for ${target.name}` : ''}. Drag it onto a part, or press Enter to add it at the playhead${ok ? ` on ${target.name}` : ''}.`
            }
            onPointerDown={(e) => {
              if ((e.target as Element).closest('button')) return;
              onCarry(e, { kind: 'library', loop, name: loop.name, bars: loop.bars, hue: ok ? target.hue : 210 });
            }}
            onKeyDown={(e) => onRowKey(e, loop)}
          >
            <Tooltip name={why ?? (isOn ? `Stop ${loop.name}` : `Hear ${loop.name}`)} tip={why || isOn || !ok ? undefined : `Hear ${loop.name} once on ${target.name}, in the song’s key.`}>
              <button
                type="button"
                className={styles.play}
                data-hearing={isOn || undefined}
                aria-pressed={isOn}
                aria-label={isOn ? `Stop hearing ${loop.name}` : `Hear ${loop.name}`}
                aria-disabled={why !== null || undefined}
                data-testid="library-audition"
                onClick={() => {
                  if (isOn) stopPreview();
                  else if (!why && ok && notes) void startPreview(loop.id, target.trackId, notes.notes, notes.bars);
                }}
              >
                <Icon name={isOn ? 'stop' : 'play'} size={11} />
              </button>
            </Tooltip>
            <span className={styles.sketch} aria-hidden="true">
              {notes && <ClipSketch notes={notes.notes} lengthTicks={loop.bars * TICKS_PER_BAR} kind={loop.part.kind === 'drums' ? 'drums' : 'notes'} />}
            </span>
            <span className={styles.text}>
              <span className={styles.name}>{loop.name}</span>
              <span className={styles.meta}>{isOn ? `Playing on ${ok ? target.name : ''}` : meta}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
