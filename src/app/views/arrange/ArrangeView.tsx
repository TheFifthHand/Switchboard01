/**
 * Song: build the song the way GarageBand's Tracks area does.
 *
 *   [ Song · 32 bars · 1:02          Loop · − Fit + · Follow · Loops ]
 *   [ timeline: ruler, sections, a row per part     │ loop browser   ]
 *   [ editor: the loop opened from the song (double-click, E)       ]
 *   [ Performances (one line until opened)                          ]
 *
 * Each part has its own row; drag a loop anywhere along it, drag its right
 * edge to make it play longer, and everything snaps to the bar lines. The
 * loop browser holds the project's scenes and each part's loops to drag in.
 * Play (and Space) here plays the song from the playhead; a click on the bar
 * numbers moves the playhead. Every edit is one undoable command and plays
 * at once, even while the song plays.
 *
 * A take's events open in a tall drawer of the Performances panel; the song
 * folds to its header row meanwhile (the timeline keeps its state, hidden).
 * The loop browser opens by itself while the song is empty or short (under
 * BROWSER_AUTO_BARS bars) until the person shows or hides it (remembered).
 *
 * Simple mode (round 7) makes this the home: SongHomeHeader ("Your song ·
 * 1:04", Repeat this part, Make it longer, + Add instrument), rows only for
 * the instruments with music, LOOPS open beside them from the start, the
 * Sound panel of one instrument in LOOPS' place while it is open (a click on
 * a row's name), and the tip line at the bottom. Advanced is 2.4's view.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { songBars } from '../../../project/arrangement';
import type { Id, Project } from '../../../project/types';
import { createStore, useStore } from '../../../state/store';
import { useProject, useUi } from '../../instance';
import { readBrowserOpen, readFollow, readTakesOpen, writeBrowserOpen, writeFollow, writeTakesOpen } from './laneSettings';
import { browserOpenStore, carriedStore } from './laneStore';
import { LoopBrowser } from './LoopBrowser';
import { LoopEditorPane, useEditorKeys } from './LoopEditorPane';
import { PerformancesPanel } from './PerformancesPanel';
import { SongHeader } from './SongHeader';
import { SongHomeHeader } from './SongHomeHeader';
import { SongTipLine } from './SongTipLine';
import { SoundPanel } from './SoundPanel';
import { closeSound, sidePanelStore } from './sidePanelStore';
import { SongTimeline, type TimelineHandle } from './SongTimeline';
import styles from './SongView.module.css';

/** Songs shorter than this (bars) show the loop browser until the person hides it. */
export const BROWSER_AUTO_BARS = 32;

const selectShort = (p: Project) => songBars(p) < BROWSER_AUTO_BARS;
const selectTrackIds = (p: Project) => p.tracks.map((t) => t.id).join(' ');

/** Simple: LOOPS open beside the song (open by default; the person can close it, for this visit of the app). */
export const simpleLoopsStore = createStore<boolean>(true);
const selectHasTakes = (p: Project) => p.performances.length > 0;

/** What a loop or scene picked up in the browser looks like while it is away from the rows. */
function Carried() {
  const c = useStore(carriedStore, (s) => s);
  if (!c || c.overRows) return null;
  return (
    <div className={styles.carried} style={{ left: c.x + 12, top: c.y + 12, '--h': c.hue ?? 214 } as CSSProperties} aria-hidden="true">
      {c.text}
    </div>
  );
}

export function ArrangeView() {
  const handle = useRef<TimelineHandle>(null);
  const [handleNow, setHandleNow] = useState<TimelineHandle | null>(null);
  const [follow, setFollow] = useState(readFollow);
  const short = useProject(selectShort);
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const [browserPref, setBrowserPref] = useState<boolean | null>(readBrowserOpen);
  const simpleLoops = useStore(simpleLoopsStore, (s) => s);
  const browserOpen = advanced ? (browserPref ?? short) : simpleLoops;
  // Simple: the Sound panel of one instrument takes the right-hand side while it is open.
  const side = useStore(sidePanelStore, (s) => s);
  const trackIds = useProject(selectTrackIds);
  const soundTrack = !advanced && side.kind === 'sound' && trackIds.split(' ').includes(side.trackId) ? side.trackId : null;
  useEffect(() => {
    const s = sidePanelStore.getState();
    if (s.kind === 'sound' && !trackIds.split(' ').includes(s.trackId)) closeSound();
  }, [trackIds]);
  useEffect(() => {
    browserOpenStore.setState(browserOpen);
    return () => browserOpenStore.setState(false);
  }, [browserOpen]);
  const [openTake, setOpenTake] = useState<Id | null>(null);
  // The Performances panel open or folded: the person's choice while there are takes (remembered); with none, a look
  // at how to record one lasts until the first take comes (or the last one goes).
  const hasTakes = useProject(selectHasTakes);
  const [takesPref, setTakesPref] = useState<boolean>(() => readTakesOpen() ?? false);
  const [howOpen, setHowOpen] = useState(false);
  useEffect(() => setHowOpen(false), [hasTakes]);
  const takesOpen = hasTakes ? takesPref : howOpen;
  const [status, setStatus] = useState('');
  useEffect(() => setHandleNow(handle.current), []);
  // The editor pane's keys (E, Esc). The open loop is kept while another view is open, as the scroll and the selection are.
  useEditorKeys();

  const onFollow = useCallback((on: boolean) => {
    setFollow(on);
    writeFollow(on);
  }, []);
  const onBrowser = useCallback(
    (open: boolean) => {
      if (!advanced) {
        simpleLoopsStore.setState(open);
        return;
      }
      setBrowserPref(open);
      writeBrowserOpen(open);
    },
    [advanced],
  );
  const openBrowserNow = useCallback(() => onBrowser(true), [onBrowser]);
  const onTakesOpen = useCallback(
    (open: boolean) => {
      if (!hasTakes) {
        setHowOpen(open);
        return;
      }
      setTakesPref(open);
      writeTakesOpen(open);
    },
    [hasTakes],
  );

  return (
    <div className={styles.view} data-take-open={openTake ? '' : undefined}>
      <section className={styles.song} aria-labelledby="song-title" data-folded={openTake ? '' : undefined}>
        {advanced ? (
          <SongHeader handle={handleNow} follow={follow} onFollow={onFollow} browserOpen={browserOpen} onBrowser={onBrowser} folded={!!openTake} onUnfold={() => setOpenTake(null)} status={status} />
        ) : (
          <SongHomeHeader handle={handleNow} browserOpen={browserOpen} onBrowser={onBrowser} folded={!!openTake} onUnfold={() => setOpenTake(null)} status={status} />
        )}
        <div className={styles.body} hidden={!!openTake}>
          <SongTimeline follow={advanced ? follow : true} handleRef={handle} onStatus={setStatus} openBrowser={openBrowserNow} />
          {soundTrack ? (
            <SoundPanel trackId={soundTrack} onClose={closeSound} />
          ) : (
            browserOpen && <LoopBrowser onCarry={(e, item) => handle.current?.carry(e, item)} playheadBar={() => handle.current?.playheadBar() ?? 0} onClose={() => onBrowser(false)} />
          )}
        </div>
        {!openTake && <LoopEditorPane />}
      </section>
      {/* Performances are an Advanced tool: Simple shows the panel only once the project has a take to replay. */}
      {(advanced || hasTakes) && <PerformancesPanel open={takesOpen} onOpenChange={onTakesOpen} openTake={openTake} onOpenTake={setOpenTake} />}
      {!advanced && <SongTipLine />}
      <Carried />
    </div>
  );
}
