/**
 * The Song screen's header in Simple mode (the home, EASY_SPEC §2):
 *
 *   Your song · 1:04     [⟳ Repeat this part: Groove] [Make it longer ▾] [+ Add instrument]  − Fit +
 *
 * - "Your song · 1:04": how long it plays, in minutes and seconds.
 * - Repeat this part: plays the part of the song under the playhead again and
 *   again (the section there, else the whole song) until it is pressed again
 *   (2.4's Loop, named by its section).
 * - Make it longer ▾: Add an intro · Add an ending · Repeat <part> again ·
 *   Add a section after <part> (a new section gets the next plain name: Verse,
 *   Chorus, Bridge, Verse 2…). Each is one undo step, said with Undo.
 * - + Add instrument: the instruments that have no row yet (Simple shows only
 *   those with music), by picture and name. Choosing one puts the first loop
 *   of its kind over the part at the playhead and plays it, and shows LOOPS
 *   filtered to that kind to try others (a Recording just gets its row and
 *   its Sound panel).
 * - − Fit +: zoom, small.
 *
 * Advanced keeps 2.4's header (SongHeader).
 */
import { useCallback, useState } from 'react';
import { Button, IconButton, useRafLoop } from '../../../ui/components';
import { mainSection, partPlace, regionEnd, sectionAt, songBars, sortSections } from '../../../project/arrangement';
import type { Id, Project, SongSection } from '../../../project/types';
import { useStore } from '../../../state/store';
import { selectTrack } from '../../../state/uiStore';
import { session, useProject } from '../../instance';
import { notify, runtimeStore, useRuntime } from '../../runtime';
import { songPlayheadBar, useSongPlaying } from '../../songPlayback';
import { MenuHeader, MenuItem, MenuSeparator, Popover, LOCKED_REASON, anchorFromElement, useEditLocked, type MenuAnchor } from '../ClipMenu';
import { editorStore, openLoopEditor } from './editorStore';
import { browserTabStore } from './LoopBrowser';
import { LaneIcon } from './laneIcons';
import { LaneMenuItem } from './SongMenus';
import { rangeStore, revealRow, shownRowsStore, usePxPerBar } from './laneStore';
import { libraryQueryStore } from './library/LibraryPanel';
import { loopRoleOf } from './library/libraryModel';
import { closeSound, openSound } from './sidePanelStore';
import { addEndingNow, addInstrumentNow, addIntroNow, growSongNow, shortenSongNow } from './songActions';
import { hiddenInstruments, instrumentName, repeatName, secondsWords, shorterChoices, songClock, songEdges, songSeconds } from './songHome';
import { MAX_PX_PER_BAR, MIN_PX_PER_BAR } from './songLayout';
import type { TimelineHandle } from './SongTimeline';
import styles from './SongView.module.css';

const selectHasRegions = (p: Project) => p.arrangement.regions.length > 0;
const selectSections = (p: Project) => p.arrangement.sections;
const selectSeconds = (p: Project) => Math.round(songSeconds(p));
const selectClock = (p: Project) => songClock(p);
/** What Make it longer names: the main part it repeats, and the part a new one goes after. */
const selectGrowNames = (p: Project) => {
  const main = mainSection(p);
  return { main: main?.name ?? null, after: main ? partPlace(p, main).name : null };
};

/** The whole bar the playhead is in (live while the song plays, else where Play starts). */
function usePlayheadBar(): number {
  const songOn = useSongPlaying();
  const cursor = useRuntime((s) => s.songCursor);
  const [bar, setBar] = useState(0);
  useRafLoop(() => {
    const b = songPlayheadBar();
    if (b === null) return;
    const whole = Math.max(0, Math.floor(b + 1e-6));
    setBar((cur) => (cur === whole ? cur : whole));
  }, songOn);
  return songOn ? bar : Math.max(0, Math.round(cursor));
}

/** The stretch of the song "Repeat this section" would repeat at `bar`: its section, else the whole song. */
function repeatRange(sections: readonly SongSection[], bar: number, length: number): { fromBar: number; toBar: number; name: string | null } | null {
  const s = sectionAt(sortSections(sections), bar);
  if (s) return { fromBar: s.start, toBar: regionEnd(s), name: s.name };
  return length > 0 ? { fromBar: 0, toBar: length, name: null } : null;
}

export interface SongHomeHeaderProps {
  handle: TimelineHandle | null;
  browserOpen: boolean;
  onBrowser(open: boolean): void;
  folded: boolean;
  onUnfold(): void;
  status: string;
}

export function SongHomeHeader({ handle, browserOpen, onBrowser, folded, onUnfold, status }: SongHomeHeaderProps) {
  const clock = useProject(selectClock);
  const seconds = useProject(selectSeconds);
  const hasRegions = useProject(selectHasRegions);
  const sections = useProject(selectSections);
  const songPaused = useRuntime((s) => s.mode === 'song' && s.paused);
  const loop = useRuntime((s) => s.songLoop);
  const ppb = usePxPerBar();
  const bar = usePlayheadBar();
  const length = useProject(songBars);
  const here = repeatRange(sections, bar, length);
  const loopName = loop ? repeatName(sections, loop, length) : null;
  const [longer, setLonger] = useState<MenuAnchor | null>(null);
  const [add, setAdd] = useState<MenuAnchor | null>(null);

  const toggleRepeat = () => {
    if (runtimeStore.getState().songLoop) {
      session.setSongLoop(null);
      return;
    }
    if (!here) {
      notify('Put some music in your song first: pick a beat from LOOPS.', 'warn');
      return;
    }
    if (handle) handle.loopBars(here.fromBar, here.toBar);
    else {
      rangeStore.setState({ fromBar: here.fromBar, toBar: here.toBar });
      session.setSongLoop({ fromBar: here.fromBar, toBar: here.toBar });
    }
  };

  return (
    <header className={styles.head} data-simple="">
      <h2 id="song-title" className={styles.title} data-hint-avoid="">
        Your song
      </h2>
      <span className={styles.homeLength} data-testid="song-length" data-hint-avoid="" role="img" aria-label={`Your song is ${secondsWords(seconds)} long`}>
        · {clock}
      </span>
      {songPaused && (
        <span className={styles.pausedWord} role="status" data-testid="song-paused">
          Paused
        </span>
      )}
      {/* The "Try this" chip's home (hidden in Simple by the shell later): the header's free middle. */}
      <span className={styles.headSpacer} data-hint-home="center" data-hint-one-line="" />
      <Button
        size="sm"
        variant="secondary"
        tone="teal"
        pressed={!!loop}
        className={styles.loopKey}
        aria-disabled={!hasRegions || undefined}
        onClick={toggleRepeat}
        data-testid="repeat-part"
        tip={loop ? `Press to hear your whole song: ${loopName} stops repeating and the song plays on to its end.` : here ? `Play ${here.name ?? 'the whole song'} again and again, until you press this again.` : 'Put some music in your song first.'}
      >
        <LaneIcon name="loop" size={14} />
        <span>{loop ? `Repeating: ${loopName}` : here?.name ? `Repeat this section: ${here.name}` : 'Repeat the whole song'}</span>
      </Button>
      <Button
        size="sm"
        variant="secondary"
        iconRight="chevronDown"
        onClick={(e) => setLonger((m) => (m ? null : anchorFromElement(e.currentTarget)))}
        aria-haspopup="menu"
        aria-expanded={!!longer}
        data-testid="make-longer"
        tip="Add an intro, an ending, or more of your song, made from its own music. Or take a section out."
      >
        Make it longer
      </Button>
      <AddInstrumentButton open={add} setOpen={setAdd} playheadBar={bar} onBrowser={onBrowser} />
      <span className={styles.zoom} role="group" aria-label="Zoom" data-small="">
        <IconButton icon="minus" label="Zoom out" size="sm" variant="ghost" disabled={ppb <= MIN_PX_PER_BAR} onClick={() => handle?.zoom(-1)} tip="See more of your song." />
        <Button size="sm" variant="ghost" onClick={() => handle?.fit()} tip="Show the whole song." data-testid="zoom-fit">
          Fit
        </Button>
        <IconButton icon="plus" label="Zoom in" size="sm" variant="ghost" disabled={ppb >= MAX_PX_PER_BAR} onClick={() => handle?.zoom(1)} tip="See your song bigger." />
      </span>
      {!browserOpen && (
        <Button size="sm" variant="secondary" tone="teal" icon="plus" onClick={() => onBrowser(true)} tip="Show LOOPS: beats, bass lines and tunes to drag into your song." data-testid="loops-toggle">
          Loops
        </Button>
      )}
      {folded && (
        <Button size="sm" variant="secondary" icon="chevronDown" onClick={onUnfold} data-testid="show-song" tip="Close the take’s events and show the song again.">
          Show the song
        </Button>
      )}
      {longer && <LongerMenu anchor={longer} playheadBar={bar} onClose={() => setLonger(null)} onDone={() => handle?.fit()} />}
      <span className={styles.srOnly} role="status" aria-live="polite" data-testid="lane-status">
        {status}
      </span>
    </header>
  );
}

/**
 * Make it longer ▾ (each item unavailable, with the reason, while there is no
 * music to make it from): Add an intro and Add an ending while the song has
 * none (songEdges), Repeat <main part> again, Add a section after <part>; and
 * Make it shorter: Remove the last section, Remove <the section at the
 * playhead> (never the only one). Each is one undo step, said with Undo.
 */
function LongerMenu({ anchor, playheadBar, onClose, onDone }: { anchor: MenuAnchor; playheadBar: number; onClose(): void; onDone(): void }) {
  const locked = useEditLocked();
  const hasRegions = useProject(selectHasRegions);
  const reason = locked ? LOCKED_REASON : !hasRegions ? 'Put some music in first' : undefined;
  // The song's main part (the most music), whatever the playhead is on; null while no section names it.
  const names = useProject(selectGrowNames, (a, b) => a.main === b.main && a.after === b.after);
  const edges = useProject(songEdges, (a, b) => a.intro === b.intro && a.ending === b.ending);
  const shorter = useProject(
    useCallback((p: Project) => {
      const c = shorterChoices(p, playheadBar);
      return { last: c.last ? { id: c.last.id, name: c.last.name } : null, here: c.here ? { id: c.here.id, name: c.here.name } : null };
    }, [playheadBar]),
    (a, b) => a.last?.id === b.last?.id && a.last?.name === b.last?.name && a.here?.id === b.here?.id && a.here?.name === b.here?.name,
  );
  const part = names.main;
  const run = (fn: () => unknown) => () => {
    onClose();
    if (fn()) onDone();
  };
  const cut = locked ? LOCKED_REASON : !shorter.last ? 'Only one section' : undefined;
  return (
    <Popover anchor={anchor} label="Make it longer or shorter" onClose={onClose} align="end" ignore={document.querySelector('[data-testid="make-longer"]')}>
      <MenuHeader eyebrow="Your song" title="Make it longer" />
      {!edges.intro && (
        <LaneMenuItem icon="intro" disabled={!!reason} disabledReason={reason} onSelect={run(() => addIntroNow({ plain: true })?.changed)}>
          Add an intro
        </LaneMenuItem>
      )}
      {!edges.ending && (
        <LaneMenuItem icon="ending" disabled={!!reason} disabledReason={reason} onSelect={run(() => addEndingNow({ plain: true })?.changed)}>
          Add an ending
        </LaneMenuItem>
      )}
      <LaneMenuItem icon="loop" disabled={!!reason} disabledReason={reason} onSelect={run(() => growSongNow('again')?.changed)}>
        {part ? `Repeat ${part} again` : 'Repeat it all again'}
      </LaneMenuItem>
      <LaneMenuItem icon="layers" disabled={!!reason} disabledReason={reason} onSelect={run(() => growSongNow('after')?.changed)}>
        {names.after ? `Add a section after ${names.after}` : 'Add a section after it'}
      </LaneMenuItem>
      <MenuSeparator />
      <MenuHeader title="Make it shorter" />
      <MenuItem icon="minus" disabled={!!cut} disabledReason={cut} onSelect={run(() => shorter.last && shortenSongNow(shorter.last.id)?.changed)}>
        {shorter.last ? `Remove the last section (${shorter.last.name})` : 'Remove the last section'}
      </MenuItem>
      {shorter.here && !cut && (
        <MenuItem icon="minus" onSelect={run(() => shorter.here && shortenSongNow(shorter.here.id)?.changed)}>
          {`Remove ${shorter.here.name} (where the song is now)`}
        </MenuItem>
      )}
    </Popover>
  );
}

/** "+ Add instrument" and its picker of the instruments with no row yet. */
function AddInstrumentButton({
  open,
  setOpen,
  playheadBar,
  onBrowser,
}: {
  open: MenuAnchor | null;
  setOpen(a: MenuAnchor | null | ((a: MenuAnchor | null) => MenuAnchor | null)): void;
  playheadBar: number;
  onBrowser(open: boolean): void;
}) {
  const shown = useStore(shownRowsStore, (s) => s);
  const projectId = useProject((p) => p.id);
  const hidden = useProject(
    useCallback((p: Project) => (shown ? hiddenInstruments(p, shown) : []), [shown]),
    (a, b) => a.length === b.length && a.every((x, i) => x.trackId === b[i].trackId && x.name === b[i].name),
  );
  const locked = useEditLocked();
  const none = hidden.length === 0;
  const choose = (trackId: Id) => {
    setOpen(null);
    const p = session.store.getState();
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return;
    selectTrack(trackId);
    const role = loopRoleOf(t);
    const r = addInstrumentNow(trackId, playheadBar);
    if (!r) return;
    if (!r.loop || !role) {
      // Nothing to play yet (a Recording): its row shows, with its sound open beside it.
      revealRow(projectId, trackId);
      openSound(trackId);
      notify(`Added ${instrumentName(t.name, t.role, t.renamed)}: its row is ready. Choose its sound on the right, then press Record to play into it.`);
      return;
    }
    // The editor, when it is open, follows the instrument just added (its loop, ready to change).
    if (editorStore.getState() && r.regionId) openLoopEditor(session.store.getState(), r.regionId);
    // LOOPS shows this kind of instrument's loops, to try others.
    closeSound();
    browserTabStore.setState({ projectId, tab: 'library' });
    libraryQueryStore.setState({ text: '', role, genre: null });
    onBrowser(true);
    // (Heard at once: addInstrumentNow plays the song where the new loop is, out of a repeat that leaves it out.)
  };
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        tone="teal"
        icon="plus"
        aria-disabled={none || locked || undefined}
        aria-haspopup="menu"
        aria-expanded={!!open}
        data-testid="add-instrument"
        tip={none ? 'Every instrument is in your song already.' : 'Add an instrument to your song: drums, bass, keys, a melody…'}
        onClick={(e) => {
          if (none) return;
          if (locked) {
            notify(LOCKED_REASON, 'warn');
            return;
          }
          const el = e.currentTarget;
          setOpen((m) => (m ? null : anchorFromElement(el)));
        }}
      >
        Add instrument
      </Button>
      {open && (
        <Popover anchor={open} label="Add an instrument" onClose={() => setOpen(null)} align="end" ignore={document.querySelector('[data-testid="add-instrument"]')}>
          <MenuHeader eyebrow="Add" title="What should it be?" />
          {hidden.map((h) => (
            <MenuItem key={h.trackId} icon={h.icon} hint={h.name !== h.kind ? h.name : undefined} onSelect={() => choose(h.trackId)}>
              {h.kind}
            </MenuItem>
          ))}
        </Popover>
      )}
    </>
  );
}
