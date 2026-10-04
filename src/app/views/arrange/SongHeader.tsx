/**
 * The Song view's header, one tidy row:
 *
 *   Song  32 bars · 1:02   [⟳ Loop · Bars 9–16]  [− Fit +]  [Follow]  [Loops]
 *
 * - Loop switches looping of the loop range. With no range yet it sets one
 *   first: the selected loops' bars, else the section at the playhead, else
 *   the whole song.
 * - − Fit + zoom the timeline (Fit shows the whole song); Follow turns the
 *   page with the playhead; Loops shows or hides the loop browser.
 * - While the pads are playing (the person came from Play), a one-line chip
 *   offers the song instead: "Your pads are playing · [Play the song]".
 */
import { Button, IconButton, Tooltip } from '../../../ui/components';
import { songBars, spanOf } from '../../../project/arrangement';
import type { Project } from '../../../project/types';
import { clampBpm } from '../../../time/clock';
import { session, useProject } from '../../instance';
import { notify, runtimeStore, useRuntime } from '../../runtime';
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
  const padsPlaying = useRuntime((s) => (s.playing || s.paused) && s.mode === 'live');
  const recordingTake = useRuntime((s) => s.recording === 'performance');
  const length = lengthText(bars, bpm);
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
      {padsPlaying && hasRegions && !recordingTake && (
        <span className={styles.padsChip} role="status" data-testid="pads-playing">
          <span>Your pads are playing</span>
          <Button size="sm" variant="secondary" icon="play" onClick={() => void session.playSong()} data-testid="play-the-song" tip="Switch from your pads to the song: it plays from the playhead (or the loop).">
            Play the song
          </Button>
        </span>
      )}
      {/* The "Try this" chip's home in the Song view: the header's free middle, clear of the music and the keys. */}
      <span className={styles.headSpacer} data-hint-home="center" />
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
      <Button size="sm" variant="secondary" tone="teal" pressed={browserOpen} onClick={() => onBrowser(!browserOpen)} tip={browserOpen ? 'Hide the loop browser.' : 'Show your scenes and loops to drag into the song.'} data-testid="loops-toggle">
        Loops
      </Button>
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
