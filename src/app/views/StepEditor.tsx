/**
 * Steps mode: a numbered 16-step editor for the selected part's selected
 * clip, one bar per page (clips are 1-4 bars).
 *
 * - Drum parts: choose a kit sound in the overview, then click its steps on
 *   the large pads; velocity underneath.
 * - Melodic parts (bass, poly, sampler): a pitch lane (small piano roll) with
 *   note length and velocity.
 * - An empty slot offers to create a 1, 2 or 4 bar clip right here.
 *
 * Every edit is an undoable command on the project; the global Undo reverts
 * it. The playhead shows the sounding step while this clip plays.
 */
import { useEffect, useRef } from 'react';
import type { ClipBars, Id } from '../../project/types';
import * as cmd from '../../state/commands';
import { selectSlot, setStepPage, slotFor, stepPageFor } from '../../state/uiStore';
import { shallowEqual, useStore } from '../../state/store';
import { Button } from '../../ui/components';
import { session, useProject, useUi } from '../instance';
import { useRuntime } from '../runtime';
import { DrumSteps } from './steps/DrumSteps';
import { PitchLane } from './steps/PitchLane';
import { StepHeader } from './steps/StepHeader';
import { usePlayhead } from './steps/shared';
import styles from './StepEditor.module.css';

function EmptySlot({ trackId, slot }: { trackId: Id; slot: number }) {
  const trackName = useProject((p) => p.tracks.find((t) => t.id === trackId)?.name ?? 'This part');
  const sceneName = useProject((p) => p.scenes[slot]?.name ?? `Scene ${slot + 1}`);
  // The part's other clips, so an empty slot is never a dead end.
  const others = useProject(
    (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      if (!t) return [];
      return t.clips.flatMap((c, i) => (c && i !== slot ? [`${i}\u0001${p.scenes[i]?.name ?? `Scene ${i + 1}`}\u0001${c.name}`] : []));
    },
    shallowEqual,
  );
  const playingSlot = useRuntime((s) => (s.playing ? (s.tracks[trackId]?.playingSlot ?? null) : null));
  const create = (bars: ClipBars) => {
    if (session.accepted(cmd.createClip(session.store, trackId, slot, bars))) setStepPage(trackId, 0);
  };
  return (
    <div className={styles.empty}>
      <div className={styles.emptyCard}>
        <div className={styles.emptyIcon} aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <h3 className={styles.emptyTitle}>
          {trackName} has no clip in {sceneName}
        </h3>
        <p className={styles.emptyText}>Create a clip here, then click steps to write a pattern. It plays when you launch the {sceneName} pad or scene.</p>
        <div className={styles.emptyActions} role="group" aria-label="Create a clip here">
          <Button icon="plus" onClick={() => create(1)} tip="A one-bar loop: 16 steps.">
            Create a 1-bar clip
          </Button>
          <Button icon="plus" onClick={() => create(2)} tip="A two-bar loop: 2 pages of 16 steps.">
            2-bar clip
          </Button>
          <Button icon="plus" onClick={() => create(4)} tip="A four-bar loop: 4 pages of 16 steps.">
            4-bar clip
          </Button>
        </div>
        {others.length > 0 && (
          <div className={styles.others} role="group" aria-label={`Edit another ${trackName} clip`}>
            <span className={styles.othersLabel}>Or edit</span>
            {others.map((o) => {
              const [i, scene, name] = o.split('\u0001');
              const playing = playingSlot === Number(i);
              return (
                <Button key={i} size="sm" variant="ghost" onClick={() => selectSlot(trackId, Number(i))} aria-label={`Edit ${name} (${scene})${playing ? ', playing' : ''}`}>
                  {playing && (
                    <span className={styles.othersPlay} aria-hidden="true">
                      ▶
                    </span>
                  )}
                  {name}
                  <span className={styles.othersScene}>{scene}</span>
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function StepEditor() {
  const trackId = useUi((s) => s.selectedTrackId);
  const slot = useUi((s) => slotFor(s, trackId));
  const storedPage = useUi((s) => stepPageFor(s, trackId));
  const track = useProject(
    (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      if (!t) return null;
      return { name: t.name, kind: t.instrument.kind, kitId: t.instrument.kind === 'drums' ? t.instrument.kitId : '' };
    },
    (a, b) => a === b || (!!a && !!b && shallowEqual(a, b)),
  );
  const clip = useProject((p) => p.tracks.find((t) => t.id === trackId)?.clips[slot] ?? null);
  const locked = useStore(session.store.info, (s) => s.lock !== null);
  const rootRef = useRef<HTMLDivElement>(null);

  const bars = clip?.bars ?? 1;
  const page = Math.min(storedPage, bars - 1);
  useEffect(() => {
    if (clip && storedPage > bars - 1) setStepPage(trackId, bars - 1);
  }, [clip, storedPage, bars, trackId]);

  usePlayhead(rootRef, trackId, slot, bars, page);

  if (!track) return null;
  const headerClip = clip ? { id: clip.id, name: clip.name, bars: clip.bars } : null;

  return (
    <div ref={rootRef} className={styles.editor} data-locked={locked || undefined}>
      <StepHeader trackId={trackId} slot={slot} page={page} clip={headerClip} kind={track.kind} trackName={track.name} locked={locked} />
      {clip ? (
        <div id="steps-page-panel" className={styles.body} role="tabpanel" aria-labelledby={`steps-page-${page}`}>
          {track.kind === 'drums' ? (
            <DrumSteps trackId={trackId} slot={slot} page={page} clip={clip} kitId={track.kitId} />
          ) : (
            <PitchLane trackId={trackId} slot={slot} page={page} clip={clip} kind={track.kind} />
          )}
        </div>
      ) : (
        <EmptySlot trackId={trackId} slot={slot} />
      )}
    </div>
  );
}
