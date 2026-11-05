/**
 * The loop browser beside the timeline (like GarageBand's loop browser), in
 * two tabs: "This song" (the project's own music, below) and "Library" (the
 * app's loops for any song: library/LibraryPanel). It opens on the Library
 * while the project has few loops of its own, on This song otherwise; the
 * person's choice is kept for the project.
 *
 * This song:
 *
 *   SCENES                         each scene as a card: "Groove · 4 bars ·
 *   [▶ Groove · 4 bars · 4 parts]   4 parts" with a dot in each part's colour;
 *   LOOPS BY PART                   ▶ hears it once on the pads
 *   Drums  [Four Floor 4] [Fill 1]  each part's loops as chips
 *
 * Drag a card onto the timeline: every part with a clip in that scene gets a
 * loop from the bar under the pointer (and a section named after the scene
 * where there is none). Drag a chip: it lands only on its own part's row,
 * which lights up while it is carried. Enter on a card or chip adds it at the
 * playhead instead (the keyboard way).
 *
 * The audition (▶) plays the scene once on the live pads and stops at the bar
 * line where its pass ends (the stop is queued on the audio clock, even when
 * another view opens meanwhile); a second press stops it at once. While the
 * pads already play it joins them at the next bar; while the song plays it is
 * unavailable and says why.
 */
import { memo, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ClipSketch, Icon, Tooltip } from '../../../ui/components';
import { clipById } from '../../../project/clips';
import { TICKS_PER_BAR, type Id, type Project } from '../../../project/types';
import { createStore, shallowEqual, useStore } from '../../../state/store';
import { session, useProject } from '../../instance';
import { notify, runtimeStore, useRuntime } from '../../runtime';
import type { Carry } from './laneController';
import { addLoop, addScene } from './songActions';
import { barsText, partHue, partLoops, sceneCardText, sceneCards, type SceneCard } from './songModel';
import { LibraryGhost } from './library/LibraryGhost';
import { LibraryPanel } from './library/LibraryPanel';
import { defaultTab, type BrowserTab } from './library/libraryModel';
import libStyles from './library/Library.module.css';
import styles from './SongView.module.css';

/** The tab the person chose, for the project it was chosen in (else the default for the project). */
export const browserTabStore = createStore<{ projectId: Id; tab: BrowserTab } | null>(null);

function useBrowserTab(): [BrowserTab, (tab: BrowserTab) => void] {
  const projectId = useProject((p) => p.id);
  const fallback = useProject(defaultTab);
  const chosen = useStore(browserTabStore, (s) => (s && s.projectId === projectId ? s.tab : null));
  return [chosen ?? fallback, (tab) => browserTabStore.setState({ projectId, tab })];
}

const TABS: { id: BrowserTab; name: string }[] = [
  { id: 'song', name: 'This song' },
  { id: 'library', name: 'Library' },
];

/* ------------------------------------------------------------------ */
/* Audition                                                            */
/* ------------------------------------------------------------------ */

/** A scene heard from its card: the pass it plays ends at `endTick` (a bar line). */
interface Audition {
  sceneId: Id;
  row: number;
  endTick: number;
  stopQueued: boolean;
}

/** How often the audition looks at the transport to queue its stop and tidy up (ms; it times nothing itself). */
const AUDITION_POLL_MS = 60;

let audition: Audition | null = null;
const listeners = new Set<() => void>();
function setAudition(a: Audition | null): void {
  audition = a;
  for (const l of listeners) l();
}

/** The scene being auditioned now (for tests and the cards). */
export function auditionedScene(): Id | null {
  return audition?.sceneId ?? null;
}

function useAudition(): Audition | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return audition;
}

function stopAudition(): void {
  if (!audition) return;
  setAudition(null);
  session.stop();
}

async function startAudition(s: SceneCard): Promise<void> {
  if (runtimeStore.getState().playing) {
    await session.launchScene(s.row);
    notify(`${s.name} plays on your pads from the next bar.`);
    return;
  }
  await session.launchScene(s.row);
  const after = runtimeStore.getState();
  if (!after.playing || after.mode !== 'live') return;
  setAudition({ sceneId: s.id, row: s.row, endTick: Math.max(1, s.bars) * TICKS_PER_BAR, stopQueued: false });
  watchAudition();
}

let watchTimer = 0;

/** Queue the stop at the end of the pass, and give up when anything else takes over (Stop, the song, a pad). */
function watchAudition(): void {
  if (watchTimer) return;
  watchTimer = window.setInterval(() => {
    const cur = audition;
    const end = () => {
      window.clearInterval(watchTimer);
      watchTimer = 0;
    };
    if (!cur) {
      end();
      return;
    }
    const rt = runtimeStore.getState();
    const t = session.transport;
    if (!t || !rt.playing || rt.mode !== 'live') {
      setAudition(null);
      end();
      return;
    }
    const takenOver = Object.values(rt.tracks).some((tr) => (tr.playingSlot !== null && tr.playingSlot !== cur.row) || (tr.queued && tr.queued.slot !== null && tr.queued.slot !== cur.row));
    if (takenOver) {
      setAudition(null);
      end();
      return;
    }
    const tick = t.getPosition().tick;
    if (!cur.stopQueued && tick >= 0 && tick >= cur.endTick - TICKS_PER_BAR) {
      cur.stopQueued = true;
      session.stopAllClips();
    }
    if (cur.stopQueued && tick >= cur.endTick) {
      setAudition(null);
      end();
      session.stop();
    }
  }, AUDITION_POLL_MS);
}

/* ------------------------------------------------------------------ */
/* The browser                                                         */
/* ------------------------------------------------------------------ */

interface PartLoops {
  trackId: Id;
  name: string;
  hue: number;
  kind: 'notes' | 'drums';
  loops: ReturnType<typeof partLoops>;
}

function selectParts(p: Project): PartLoops[] {
  return p.tracks.map((t, i) => ({ trackId: t.id, name: t.name, hue: partHue(i), kind: t.instrument.kind === 'drums' ? 'drums' : 'notes', loops: partLoops(p, t.id) }));
}

function sameParts(a: PartLoops[], b: PartLoops[]): boolean {
  return a.length === b.length && a.every((x, i) => x.trackId === b[i].trackId && x.name === b[i].name && x.kind === b[i].kind && x.loops.length === b[i].loops.length && x.loops.every((l, j) => shallowEqual(l, b[i].loops[j])));
}

function sameCards(a: SceneCard[], b: SceneCard[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.name === b[i].name && x.bars === b[i].bars && x.row === b[i].row && x.parts.length === b[i].parts.length && x.parts.every((q, j) => q.trackId === b[i].parts[j].trackId));
}

/** The notes of a clip (for a chip's picture). */
function useClipNotes(trackId: Id, clipId: Id) {
  return useProject((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    return (t && clipById(t, clipId)?.notes) ?? null;
  });
}

function ChipSketch({ trackId, clipId, bars, kind }: { trackId: Id; clipId: Id; bars: number; kind: 'notes' | 'drums' }) {
  const notes = useClipNotes(trackId, clipId);
  if (!notes) return null;
  return (
    <span className={styles.chipSketch} aria-hidden="true">
      <ClipSketch notes={notes} lengthTicks={bars * TICKS_PER_BAR} kind={kind} />
    </span>
  );
}

export interface LoopBrowserProps {
  /** Pick a card or chip up (the timeline's controller carries it). */
  onCarry(e: ReactPointerEvent<HTMLElement>, item: Carry): void;
  /** Where Enter adds a card or chip: the playhead / song start point. */
  playheadBar(): number;
  onClose(): void;
}

export const LoopBrowser = memo(function LoopBrowser({ onCarry, playheadBar, onClose }: LoopBrowserProps) {
  const [tab, setTab] = useBrowserTab();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    setTab(TABS[j].id);
    tabRefs.current[j]?.focus();
  };
  return (
    <aside className={styles.browser} aria-label="Loops: drag a scene or a loop onto the song" data-testid="loop-browser" data-tab={tab}>
      <div className={styles.browserHead}>
        <h3 className={styles.browserTitle}>Loops</h3>
        <Tooltip name="Hide the loops" tip="Hide this panel to give the song more room. The Loops key above brings it back.">
          <button type="button" className={styles.browserClose} aria-label="Hide the loops" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        </Tooltip>
      </div>
      <div className={libStyles.tabs} role="tablist" aria-label="Which loops">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`loops-tab-${t.id}`}
            aria-controls="loops-tab-panel"
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            className={libStyles.tab}
            data-testid={`loops-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.name}
          </button>
        ))}
      </div>
      <div className={styles.browserBody} role="tabpanel" id="loops-tab-panel" aria-labelledby={`loops-tab-${tab}`}>
        {tab === 'song' ? <SongLoops onCarry={onCarry} playheadBar={playheadBar} /> : <LibraryPanel playheadBar={playheadBar} onCarry={onCarry} />}
      </div>
      <LibraryGhost />
    </aside>
  );
});

/** The "This song" tab: the project's scenes and each part's loops. */
function SongLoops({ onCarry, playheadBar }: Pick<LoopBrowserProps, 'onCarry' | 'playheadBar'>) {
  const cards = useProject(sceneCards, sameCards);
  const parts = useProject(selectParts, sameParts);
  const a = useAudition();
  const songOn = useRuntime((s) => s.mode === 'song' && (s.playing || s.paused));
  const replaying = useRuntime((s) => s.mode === 'replay' && s.playing);
  const paused = useRuntime((s) => s.paused);
  const padsPlaying = useRuntime((s) => s.playing && s.mode === 'live');
  useEffect(() => {
    if (a && !cards.some((s) => s.id === a.sceneId)) setAudition(null);
  }, [a, cards]);
  const onCardKey = (e: KeyboardEvent<HTMLElement>, c: SceneCard) => {
    if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
    e.preventDefault();
    addScene(c.row, playheadBar());
  };
  return (
    <>
        <h4 className={styles.browserGroup}>Scenes</h4>
        {cards.length === 0 && <p className={styles.browserNote}>No scenes with loops yet: make some on the pads in Play.</p>}
        <ul className={styles.cards}>
          {cards.map((c) => {
            const hearing = a?.sceneId === c.id;
            const why = songOn ? 'Stop the song to hear a scene' : replaying ? 'Stop the replay to hear a scene' : paused ? 'Stop playback to hear a scene' : null;
            return (
              <li
                key={c.id}
                className={styles.card}
                tabIndex={0}
                data-scene-row={c.row}
                aria-label={`Scene ${sceneCardText(c)}. Drag it onto the song, or press Enter to add it at the playhead.`}
                onPointerDown={(e) => {
                  if ((e.target as Element).closest('button')) return;
                  onCarry(e, { kind: 'scene', row: c.row, name: c.name, bars: c.bars });
                }}
                onKeyDown={(e) => onCardKey(e, c)}
              >
                <Tooltip name={why ?? (hearing ? `Stop ${c.name}` : `Hear ${c.name}`)} tip={why ? undefined : hearing ? undefined : padsPlaying ? `Play ${c.name} on your pads from the next bar.` : `Hear ${c.name} once on the pads.`}>
                  <button
                    type="button"
                    className={styles.cardPlay}
                    data-hearing={hearing || undefined}
                    aria-pressed={hearing}
                    aria-label={hearing ? `Stop hearing ${c.name}` : `Hear ${c.name}`}
                    aria-disabled={why !== null || undefined}
                    data-testid="scene-audition"
                    onClick={() => {
                      if (hearing) stopAudition();
                      else if (!why) void startAudition(c);
                    }}
                  >
                    <Icon name={hearing ? 'stop' : 'play'} size={11} />
                  </button>
                </Tooltip>
                <span className={styles.cardText}>
                  <span className={styles.cardName}>{c.name}</span>
                  <span className={styles.cardMeta}>{hearing ? 'Playing once' : `${barsText(c.bars)} · ${c.parts.length === 1 ? '1 part' : `${c.parts.length} parts`}`}</span>
                </span>
                <span className={styles.cardDots} aria-hidden="true">
                  {c.parts.map((q) => (
                    <span key={q.trackId} className={styles.dot} style={{ '--h': q.hue } as CSSProperties} title={q.name} />
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
        <h4 className={styles.browserGroup}>Loops by part</h4>
        {parts.map((part) => (
          <div key={part.trackId} className={styles.partLoops} style={{ '--h': part.hue } as CSSProperties}>
            <span className={styles.partLoopsName}>{part.name}</span>
            {part.loops.length === 0 && <span className={styles.browserNote}>No loops</span>}
            <ul className={styles.chips}>
              {part.loops.map((l) => (
                <li
                  key={l.clipId}
                  className={styles.chip}
                  tabIndex={0}
                  data-chip={l.clipId}
                  data-track={part.trackId}
                  aria-label={`${part.name} loop ${l.name}, ${barsText(l.bars)}. Drag it onto the ${part.name} row, or press Enter to add it at the playhead.`}
                  onPointerDown={(e) => onCarry(e, { kind: 'loop', trackId: part.trackId, clipId: l.clipId, name: l.name, bars: l.bars, hue: part.hue })}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    addLoop(part.trackId, l.clipId, playheadBar());
                  }}
                >
                  <ChipSketch trackId={part.trackId} clipId={l.clipId} bars={l.bars} kind={part.kind} />
                  <span className={styles.chipName}>{l.name}</span>
                  <span className={styles.chipBars}>{barsText(l.bars)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </>
  );
}
