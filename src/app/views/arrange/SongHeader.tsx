/**
 * The Song view's header, one tidy row:
 *
 *   Song  32 bars · 1:02  Paused   [⟳ Loop · Bars 9–16]  [− Fit +]  [Follow]  [Shape the song…]  [+ Add loops]
 *
 * - Loop switches looping of the loop range. With no range yet it sets one
 *   first: the selected loops' bars, else the section at the playhead, else
 *   the whole song.
 * - − Fit + zoom the timeline (Fit shows the whole song); Follow turns the
 *   page with the playhead; Shape the song… adds an intro or an ending;
 *   Add loops shows or hides the loop browser (the scenes and loops to drag
 *   in).
 * - While the song is paused, the word Paused says so (the playhead is not
 *   amber then). While the pads play or are paused (the person came from
 *   Play), a one-line chip offers the song instead: "Your pads are playing ·
 *   [Play the song]"; with an empty song it says that the song is empty.
 */
import { useState } from 'react';
import { Button, IconButton, Tooltip } from '../../../ui/components';
import { songBars, spanOf } from '../../../project/arrangement';
import type { Project } from '../../../project/types';
import { clampBpm } from '../../../time/clock';
import { session, useProject } from '../../instance';
import { notify, runtimeStore, useRuntime } from '../../runtime';
import { MenuHeader, Popover, LOCKED_REASON, anchorFromElement, useEditLocked, type MenuAnchor } from '../ClipMenu';
import { LaneMenuItem } from './SongMenus';
import { addEndingNow, addIntroNow } from './songActions';
import { LaneIcon } from './laneIcons';
import { loopKeyRange, rangeWords } from './laneLoop';
import { rangeStore, selectionStore, usePxPerBar, useRange } from './laneStore';
import { MAX_PX_PER_BAR, MIN_PX_PER_BAR } from './songLayout';
import { lengthText } from './songModel';
import type { TimelineHandle } from './SongTimeline';
import { currentBar } from './SongTimeline';
import styles from './SongView.module.css';

const selectBars = (p: Project) => songBars(p);
const selectBpm = (p: Project) => clampBpm(p.bpm);
const selectHasRegions = (p: Project) => p.arrangement.regions.length > 0;

/** Switch looping on or off (setting the range first when there is none). */
export function toggleLoop(handle: TimelineHandle | null): void {
  if (runtimeStore.getState().songLoop) {
    session.setSongLoop(null);
    return;
  }
  let r = rangeStore.getState();
  if (!r) {
    const p = session.store.getState();
    const ids = selectionStore.getState().ids;
    r = loopKeyRange({ selection: spanOf(p.arrangement.regions.filter((x) => ids.includes(x.id))), sections: p.arrangement.sections, cursorBar: currentBar(), songBars: songBars(p) });
  }
  if (!r) {
    notify('Put some loops in the song first, then loop part of it.', 'warn');
    return;
  }
  if (handle) handle.loopBars(r.fromBar, r.toBar);
  else {
    rangeStore.setState(r);
    session.setSongLoop(r);
  }
}

export interface SongHeaderProps {
  handle: TimelineHandle | null;
  follow: boolean;
  onFollow(on: boolean): void;
  browserOpen: boolean;
  onBrowser(open: boolean): void;
  /** A take's events are open: the song is folded (Show the song brings it back). */
  folded: boolean;
  onUnfold(): void;
  status: string;
}

export function SongHeader({ handle, follow, onFollow, browserOpen, onBrowser, folded, onUnfold, status }: SongHeaderProps) {
  const bars = useProject(selectBars);
  const bpm = useProject(selectBpm);
  const hasRegions = useProject(selectHasRegions);
  const looping = useRuntime((s) => !!s.songLoop);
  const range = useRange();
  const ppb = usePxPerBar();
  const pads = useRuntime((s) => (s.mode !== 'live' ? null : s.paused ? 'paused' : s.playing ? 'playing' : null));
  const songPaused = useRuntime((s) => s.mode === 'song' && s.paused);
  const recordingTake = useRuntime((s) => s.recording === 'performance');
  const length = lengthText(bars, bpm);
  const [shape, setShape] = useState<MenuAnchor | null>(null);
  return (
    <header className={styles.head}>
      <h2 id="song-title" className={styles.title}>
        Song
      </h2>
      <Tooltip tip="How long the song plays: to the end of its last loop." detail={`At ${Math.round(bpm)} BPM. Exports add the echo tail so echoes and reverb can ring out.`}>
        <span className={styles.length} data-testid="song-length" tabIndex={0} aria-label={`Song length: ${length.replace(' · ', ', about ')}`}>
          {length}
        </span>
      </Tooltip>
      {songPaused && (
        <span className={styles.pausedWord} role="status" data-testid="song-paused">
          Paused
        </span>
      )}
      {pads && !recordingTake && (
        <span className={styles.padsChip} role="status" data-testid="pads-playing" data-paused={pads === 'paused' || undefined}>
          <span>{!hasRegions ? `The song is empty: your pads are ${pads}` : `Your pads are ${pads}`}</span>
          {hasRegions && (
            <Button size="sm" variant="secondary" icon="play" onClick={() => void session.playSong()} data-testid="play-the-song" tip="Switch from your pads to the song: it plays from the playhead (or the loop).">
              Play the song
            </Button>
          )}
        </span>
      )}
      {/* The "Try this" chip's home in the Song view: the header's free middle, clear of the music and the keys, in one line. */}
      <span className={styles.headSpacer} data-hint-home="center" data-hint-one-line="" />
      <Button
        size="sm"
        variant="secondary"
        tone="teal"
        pressed={looping}
        className={styles.loopKey}
        aria-disabled={!hasRegions || undefined}
        onClick={() => hasRegions && toggleLoop(handle)}
        data-testid="loop-toggle"
        tip={looping ? 'Stop looping: the song plays on to its end.' : range ? `Loop ${rangeWords(range)} again and again.` : 'Loop part of the song: the selected loops, the section at the playhead, or the whole song.'}
        detail="Drag along the bar numbers to choose what loops; drag the band’s ends to change it."
      >
        <LaneIcon name="loop" size={14} />
        <span>Loop{range ? ` · ${rangeWords(range)}` : ''}</span>
      </Button>
      <span className={styles.zoom} role="group" aria-label="Zoom">
        <IconButton icon="minus" label="Zoom out" size="sm" variant="secondary" disabled={ppb <= MIN_PX_PER_BAR} onClick={() => handle?.zoom(-1)} tip="See more bars." detail="Ctrl+wheel over the song zooms around the pointer." />
        <Button size="sm" variant="secondary" onClick={() => handle?.fit()} tip="Show the whole song." data-testid="zoom-fit">
          Fit
        </Button>
        <IconButton icon="plus" label="Zoom in" size="sm" variant="secondary" disabled={ppb >= MAX_PX_PER_BAR} onClick={() => handle?.zoom(1)} tip="See the bars bigger." detail="Ctrl+wheel over the song zooms around the pointer." />
      </span>
      <Button size="sm" variant="secondary" tone="teal" pressed={follow} onClick={() => onFollow(!follow)} tip={follow ? 'Stop turning the page with the playhead.' : 'Turn the page when the playhead reaches the edge.'} data-testid="follow">
        Follow
      </Button>
      <Button size="sm" variant="secondary" onClick={(e) => setShape((m) => (m ? null : anchorFromElement(e.currentTarget)))} aria-haspopup="menu" aria-expanded={!!shape} data-testid="shape-song" tip="Add an intro or an ending made from your song’s own loops.">
        Shape the song…
      </Button>
      <Button size="sm" variant="secondary" tone="teal" icon="plus" pressed={browserOpen} onClick={() => onBrowser(!browserOpen)} tip={browserOpen ? 'Hide the scenes and loops.' : 'Show your scenes and loops, to drag into the song.'} data-testid="loops-toggle">
        Add loops
      </Button>
      {shape && <ShapeMenu anchor={shape} onClose={() => setShape(null)} />}
      {folded && (
        <Button size="sm" variant="secondary" icon="chevronDown" onClick={onUnfold} data-testid="show-song" tip="Close the take’s events and show the song again.">
          Show the song
        </Button>
      )}
      <span className={styles.srOnly} role="status" aria-live="polite" data-testid="lane-status">
        {status}
      </span>
    </header>
  );
}

/** "Shape the song…": add an intro or an ending (unavailable, with the reason, while there is no music to make them from). */
function ShapeMenu({ anchor, onClose }: { anchor: MenuAnchor; onClose(): void }) {
  const locked = useEditLocked();
  const hasRegions = useProject(selectHasRegions);
  const reason = locked ? LOCKED_REASON : !hasRegions ? 'Put some loops in the song first' : undefined;
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Popover anchor={anchor} label="Shape the song" onClose={onClose} align="end" ignore={document.querySelector('[data-testid="shape-song"]')}>
      <MenuHeader eyebrow="Song" title="Shape the song" />
      <LaneMenuItem icon="intro" disabled={!!reason} disabledReason={reason} onSelect={run(() => addIntroNow())}>
        Add an intro
      </LaneMenuItem>
      <LaneMenuItem icon="ending" disabled={!!reason} disabledReason={reason} onSelect={run(() => addEndingNow())}>
        Add an ending
      </LaneMenuItem>
    </Popover>
  );
}
