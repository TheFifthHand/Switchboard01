/**
 * Steps mode: the editor for the selected part's selected clip, one bar per
 * page (clips are 1-8 bars; the header's bar strip shows the whole clip).
 *
 * - Drum parts: a 16-step grid of the kit's sounds, the large pads of the
 *   chosen sound, velocity underneath.
 * - Melodic parts (bass, poly, sampler): a piano roll on the chosen grid
 *   (1/16, 1/32, 1/8 or 1/16 triplets) with a note selection, note length
 *   and per-note velocity.
 * - An empty slot offers to create a 1, 2, 4 or 8 bar clip right here.
 * - Until a slot is chosen for the part, the clip it plays is opened.
 *
 * Every edit is an undoable command on the project; the global Undo reverts
 * it. The playhead shows the step that is heard while this clip plays, and
 * with Follow on the shown bar turns with it.
 */
import { useEffect, useRef } from 'react';
import { TICKS_PER_STEP, type ClipBars, type Id } from '../../project/types';
import * as cmd from '../../state/commands';
import { GRID_TICKS } from '../../state/commands/notes';
import { selectSlot, setStepPage, stepPageFor } from '../../state/uiStore';
import { shallowEqual, useStore } from '../../state/store';
import { Button } from '../../ui/components';
import { session, useProject, useUi } from '../instance';
import { useRuntime } from '../runtime';
import { DrumSteps } from './steps/DrumSteps';
import { PitchLane } from './steps/PitchLane';
import { StepHeader } from './steps/StepHeader';
import { usePlayhead } from './steps/shared';
import styles from './StepEditor.module.css';

function EmptySlot({ trackId, slot, locked, onOpen }: { trackId: Id; slot: number; locked: boolean; onOpen(): void }) {
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
    if (!session.accepted(cmd.createClip(session.store, trackId, slot, bars))) return;
    setStepPage(trackId, 0);
    onOpen();
  };
  const lockTip = 'Locked while a performance records. Stop the take to create a clip.';
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
        {locked ? (
          <p className={styles.emptyLock} role="status">
            <span className={styles.lockDot} aria-hidden="true" />
            Locked while a performance records. Stop the take to create a clip.
          </p>
        ) : (
          <p className={styles.emptyText}>Create a clip here, then click steps to write a pattern. It plays when you launch the {sceneName} pad or scene.</p>
        )}
        <div className={styles.emptyActions} role="group" aria-label="Create a clip here">
          <Button icon="plus" onClick={() => create(1)} disabled={locked} tip={locked ? lockTip : 'A one-bar loop: 16 steps.'}>
            Create a 1-bar clip
          </Button>
          <Button icon="plus" onClick={() => create(2)} disabled={locked} tip={locked ? lockTip : 'A two-bar loop: 2 pages of 16 steps.'}>
            2-bar clip
          </Button>
          <Button icon="plus" onClick={() => create(4)} disabled={locked} tip={locked ? lockTip : 'A four-bar loop: 4 pages of 16 steps.'}>
            4-bar clip
          </Button>
          <Button icon="plus" onClick={() => create(8)} disabled={locked} tip={locked ? lockTip : 'An eight-bar phrase: 8 pages of 16 steps.'}>
            8-bar clip
          </Button>
        </div>
        {others.length > 0 && (
          <div className={styles.others} role="group" aria-label={`Edit another ${trackName} clip`}>
            <span className={styles.othersLabel}>Or edit</span>
            {others.map((o) => {
              const [i, scene, name] = o.split('\u0001');
              const playing = playingSlot === Number(i);
              return (
                <Button
                  key={i}
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onOpen();
                    selectSlot(trackId, Number(i));
                  }}
                  aria-label={`Edit ${name} (${scene})${playing ? ', playing' : ''}`}
                >
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

/**
 * The clip slot to edit. An explicit choice (a pad pressed in Loops, a slot
 * picked here) wins; with none yet, open the clip the part is playing, else
 * its first clip, so Steps never greets you with an empty slot while the
 * part plays another one (e.g. right after Jump In).
 */
function useEditedSlot(trackId: Id): number {
  const chosen = useUi((s) => s.selectedSlot[trackId] as number | undefined);
  const playingSlot = useRuntime((s) => s.tracks[trackId]?.playingSlot ?? null);
  const firstClip = useProject((p) => {
    const i = p.tracks.find((t) => t.id === trackId)?.clips.findIndex((c) => !!c) ?? -1;
    return i < 0 ? 0 : i;
  });
  const slot = chosen ?? playingSlot ?? firstClip;
  // Make it the part's selected slot, so Loops, Record Notes and Variation agree with what is shown.
  useEffect(() => {
    if (chosen === undefined) selectSlot(trackId, slot);
  }, [chosen, trackId, slot]);
  return slot;
}

export function StepEditor() {
  const trackId = useUi((s) => s.selectedTrackId);
  const slot = useEditedSlot(trackId);
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
  const follow = useUi((s) => s.stepsFollow);
  const gridName = useUi((s) => s.stepGrid);
  const rootRef = useRef<HTMLDivElement>(null);

  const bars = clip?.bars ?? 1;
  const page = Math.min(storedPage, bars - 1);
  useEffect(() => {
    if (clip && storedPage > bars - 1) setStepPage(trackId, bars - 1);
  }, [clip, storedPage, bars, trackId]);

  // Drums light 1/16 steps; the piano roll lights the cells of its grid.
  const cellTicks = track?.kind === 'drums' ? TICKS_PER_STEP : GRID_TICKS[gridName];
  usePlayhead(rootRef, trackId, slot, bars, page, { cellTicks, follow });

  // Creating a clip (or opening another one) from the empty slot replaces the
  // focused button: move focus into the new editor instead of losing it.
  const focusEntry = useRef(false);
  const clipId = clip?.id ?? null;
  useEffect(() => {
    if (!clipId || !focusEntry.current) return;
    focusEntry.current = false;
    rootRef.current?.querySelector<HTMLElement>('[data-steps-entry]')?.focus();
  }, [clipId]);

  if (!track) return null;
  const headerClip = clip ? { id: clip.id, name: clip.name, bars: clip.bars } : null;

  return (
    <div ref={rootRef} className={styles.editor} data-locked={locked || undefined} data-steps-root="">
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
        <EmptySlot
          trackId={trackId}
          slot={slot}
          locked={locked}
          onOpen={() => {
            focusEntry.current = true;
          }}
        />
      )}
    </div>
  );
}
