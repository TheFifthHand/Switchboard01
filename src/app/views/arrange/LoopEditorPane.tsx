/**
 * The Song view's editor pane: the loop a region plays, edited under the
 * rows (GarageBand's editor area), so the song, its ruler and the playhead
 * stay in view.
 *
 *   ═══════════════ grip (drag, or arrow keys: the pane's height) ═══════════
 *   [ Rolling · Bass   Also plays at bars 49–64   [Make this one different] ✕ ]
 *   [ the step grid (drums) or the piano roll (every other part)            ]
 *
 * Double-click a loop, press E with a loop chosen, or use its menu's Edit
 * notes to open it here; opening another loop switches the pane. Opened
 * from the keyboard (E, the menu), focus moves into the grid. Every edit
 * is an undoable command and plays at once (the song re-plans live). The
 * playhead shows where the song is inside the loop while a region of it
 * plays (the region's start and offset taken into account by the
 * transport's clip phase). Make this one different gives the region the pane
 * was opened from its own copy of the loop and goes on editing that copy.
 * Close (✕) or Esc closes the pane; it closes by itself when its loop is
 * gone (deleted, or taken away by Undo).
 *
 * The pane takes its own keys: the Song view's keys (move, delete, copy…)
 * never act on the song while the editor has focus.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { isSongSlot } from '../../../project/clips';
import { TICKS_PER_STEP, type Id, type InstrumentKind } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { GRID_TICKS } from '../../../state/commands/notes';
import { useStore } from '../../../state/store';
import { selectSlot, selectTrack, setStepPage, stepPageFor } from '../../../state/uiStore';
import { Button, IconButton } from '../../../ui/components';
import { session, useProject, useUi } from '../../instance';
import { notify } from '../../runtime';
import { pickBarAt, useBarsShown } from '../StepEditor';
import { DrumSteps } from '../steps/DrumSteps';
import { PitchLane } from '../steps/PitchLane';
import { RowZoom } from '../steps/RowZoom';
import { BarStrip } from '../steps/StepHeader';
import { usePlayhead } from '../steps/shared';
import { EDITOR_MIN_H, alsoPlaysText, clampEditorHeight, closeLoopEditor, defaultEditorHeight, editorStore, openLoopEditor, readEditorHeight, resolveEditor, writeEditorHeight, type EditorTarget } from './editorStore';
import { selectionStore, setSelection } from './laneStore';
import styles from './LoopEditorPane.module.css';

/** Arrow keys on the grip move it this far (px; Shift: 4 times). */
const GRIP_STEP = 20;

/** Elements whose own keys come first (as the Song view's OWN_KEYS, plus the editor pane itself). */
const TAKES_KEYS = 'input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [role="listbox"], [role="slider"], [role="spinbutton"], [role="combobox"]';

function modalOpen(): boolean {
  return !!document.querySelector('[aria-modal="true"]') || document.body.hasAttribute('data-popover-open');
}

/** Put keyboard focus back on a loop of the song (after Esc, or Close). */
function focusRegion(id: Id | null): void {
  if (!id) return;
  document.querySelector<HTMLElement>(`[data-region-id="${id}"]`)?.focus({ preventScroll: true });
}

/**
 * The editor's keys in the Song view: E opens the loop that has keyboard
 * focus (or the chosen one, while the rows have focus) and closes the pane
 * when it shows that loop already; Esc closes the pane (after anything that
 * uses Esc itself, such as clearing a selection). Opening another project
 * closes the pane.
 */
export function useEditorKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (modalOpen()) return;
      const open = editorStore.getState();
      if (e.key === 'Escape') {
        if (!open) return;
        const onNothing = !t || t === document.body;
        const inPane = !!t?.closest('[data-loop-editor]');
        const inSong = !!t?.closest('section[aria-labelledby="song-title"]');
        if (!onNothing && !inPane && !inSong) return;
        if (t && !inPane && t.closest(TAKES_KEYS)) return;
        e.preventDefault();
        closeLoopEditor();
        if (inPane || onNothing) focusRegion(open.regionId);
        return;
      }
      if (e.key !== 'e' && e.key !== 'E') return;
      if (e.shiftKey || !t || t.closest('[data-loop-editor]') || t.closest(TAKES_KEYS)) return;
      const regionEl = t.closest<HTMLElement>('[data-region-id]');
      const inRows = !!t.closest('[data-testid="song-timeline"]');
      const sel = selectionStore.getState();
      const id = regionEl?.dataset.regionId ?? (inRows ? (sel.focus && sel.ids.includes(sel.focus) ? sel.focus : sel.ids[0]) : undefined);
      if (!id) return;
      e.preventDefault();
      const p = session.store.getState();
      const r = p.arrangement.regions.find((x) => x.id === id);
      if (open && r && open.trackId === r.trackId && open.clipId === r.clipId) {
        closeLoopEditor();
        return;
      }
      if (openLoopEditor(p, id, { focus: true })) setSelection({ ids: [id], focus: id });
    };
    document.addEventListener('keydown', onKey);
    // Another project (open, import, a starter): its loops are not this one's.
    const offProject = session.store.subscribe((p, prev) => {
      if (p.id !== prev.id) closeLoopEditor();
    });
    return () => {
      document.removeEventListener('keydown', onKey);
      offProject();
    };
  }, []);
}

/** The resolved loop as a stable key ('' when the pane has nothing to show). */
function useResolvedKey(target: EditorTarget | null): string {
  return useProject((p) => {
    const r = resolveEditor(p, target);
    return r ? `${r.trackId}\u0001${r.regionId}\u0001${r.slot}` : '';
  });
}

export function LoopEditorPane() {
  const target = useStore(editorStore, (s) => s);
  const key = useResolvedKey(target);
  // The loop is gone: close. The region it was opened from went but the loop plays on elsewhere: follow that one.
  useEffect(() => {
    if (!target) return;
    if (!key) {
      closeLoopEditor();
      return;
    }
    const regionId = key.split('\u0001')[1];
    if (regionId !== target.regionId) editorStore.setState({ ...target, regionId });
  }, [target, key]);
  if (!target || !key) return null;
  const [trackId, regionId, slot] = key.split('\u0001');
  return <Pane key={`${trackId}|${target.clipId}`} trackId={trackId} clipId={target.clipId} regionId={regionId} slot={Number(slot)} focusAsk={target.focus ?? 0} />;
}

function Pane({ trackId, clipId, regionId, slot, focusAsk }: { trackId: Id; clipId: Id; regionId: Id; slot: number; focusAsk: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Opened from the keyboard (E, a menu's Edit notes): focus goes to the grid, as Play › Steps does; Esc brings it back to the loop.
  useEffect(() => {
    if (!focusAsk) return;
    // After the grid has its final size (the bars shown are measured) and a closing menu has put its focus back.
    const id = requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('[data-steps-entry]')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [focusAsk]);
  const clip = useProject((p) => resolveEditor(p, { trackId, clipId, regionId })?.clip ?? null);
  const track = useProject((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    return t ? `${t.name}\u0001${t.instrument.kind}\u0001${t.instrument.kind === 'drums' ? t.instrument.kitId : ''}` : '';
  });
  const also = useProject((p) => alsoPlaysText(p, trackId, clipId, regionId));
  const uses = useProject((p) => cmd.loopUse(p, trackId, clipId));
  const padName = useProject((p) => (isSongSlot(slot) ? null : (p.scenes[slot]?.name ?? `Row ${slot + 1}`)));
  const locked = useStore(session.store.info, (s) => s.lock !== null);
  const follow = useUi((s) => s.stepsFollow);
  const gridName = useUi((s) => s.stepGrid);
  const storedPage = useUi((s) => stepPageFor(s, trackId));
  const [name, kind, kitId] = track.split('\u0001') as [string, string, string];

  // The part and its loop become the selected ones (Play › Steps, the keyboard and Variation follow them).
  useEffect(() => {
    selectTrack(trackId);
    selectSlot(trackId, slot);
  }, [trackId, slot]);
  // Another loop opens on its first bar.
  useEffect(() => {
    setStepPage(trackId, 0);
  }, [trackId, clipId]);

  const bars = clip?.bars ?? 1;
  const page = Math.min(storedPage, bars - 1);
  const { span, first } = useBarsShown(rootRef, bars, page);
  const cellTicks = kind === 'drums' ? TICKS_PER_STEP : GRID_TICKS[gridName];
  usePlayhead(rootRef, trackId, slot, bars, first, { cellTicks, follow, span });

  /* ---------- height ---------- */

  const [chosen, setHeight] = useState(readEditorHeight);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const section = rootRef.current?.parentElement;
    if (!section) return;
    const measure = () => setRoom(section.clientHeight);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(section);
    return () => ro?.disconnect();
  }, []);
  const height = chosen ?? defaultEditorHeight(room);
  const shownH = room ? clampEditorHeight(height, room) : height;
  const drag = useRef<{ pointerId: number; y0: number; h0: number } | null>(null);
  const setTo = useCallback(
    (px: number) => {
      const next = room ? clampEditorHeight(px, room) : px;
      setHeight(next);
      writeEditorHeight(next);
    },
    [room],
  );
  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    drag.current = { pointerId: e.pointerId, y0: e.clientY, h0: shownH };
  };
  const onGripMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const next = room ? clampEditorHeight(d.h0 + (d.y0 - e.clientY), room) : d.h0 + (d.y0 - e.clientY);
    setHeight(next);
  };
  const onGripEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setTo(height);
  };
  const onGripKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? GRIP_STEP * 4 : GRIP_STEP;
    if (e.key === 'ArrowUp') setTo(shownH + step);
    else if (e.key === 'ArrowDown') setTo(shownH - step);
    else return;
    e.preventDefault();
  };

  /* ---------- make this one different ---------- */

  const regionWords = useProject((p) => {
    const r = p.arrangement.regions.find((x) => x.id === regionId);
    return r ? (r.bars <= 1 ? `Bar ${r.start + 1}` : `Bars ${r.start + 1}–${r.start + r.bars}`) : '';
  });
  const canSplit = !!clip && (uses > 1 || padName !== null);
  const makeDifferent = () => {
    const r = cmd.makeLoopUnique(session.store, regionId);
    if (!session.accepted(r) || !r.clipId) return;
    editorStore.setState({ trackId, clipId: r.clipId, regionId });
    const made = session.store.getState().tracks.find((t) => t.id === trackId);
    const copy = made?.songClips?.find((c) => c.id === r.clipId)?.name ?? 'a copy';
    notify(`${regionWords} now play their own loop, ${copy}: edits here change only these bars.`, 'info', 'undo');
  };
  const splitTip = !clip
    ? ''
    : padName !== null && uses <= 1
      ? `${clip.name} is also the loop on the ${padName} pad. Give these bars their own copy, so edits here leave the pad as it is.`
      : `Give these bars their own copy of ${clip.name}, so edits here leave the other places as they are.`;
  const where = padName !== null ? `${also} · also on the ${padName} pad` : also;

  const close = () => {
    closeLoopEditor();
    focusRegion(regionId);
  };

  if (!clip || !track) return null;
  const drums = kind === 'drums';
  const paging = span < bars;

  return (
    <div
      ref={rootRef}
      className={styles.pane}
      style={{ '--pane-h': `${shownH}px` } as CSSProperties}
      role="region"
      aria-label={`Editor: ${clip.name} (${name})`}
      data-loop-editor=""
      data-own-keys=""
      data-steps-root=""
      data-locked={locked || undefined}
    >
      <div
        className={styles.grip}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Editor height: drag, or use the arrow keys"
        aria-valuenow={shownH}
        aria-valuemin={EDITOR_MIN_H}
        aria-valuemax={room || undefined}
        tabIndex={0}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripEnd}
        onPointerCancel={onGripEnd}
        onKeyDown={onGripKey}
      >
        <span className={styles.gripMark} aria-hidden="true" />
      </div>
      <div className={styles.head}>
        <h2 className={styles.title}>
          <span className={styles.loopName}>{clip.name}</span>
          <span className={styles.partName}>{name}</span>
        </h2>
        <span className={styles.where} data-shared={uses > 1 || padName !== null || undefined}>
          {where}
        </span>
        {locked && (
          <span className={styles.lock} role="status">
            <span className={styles.lockDot} aria-hidden="true" />
            Locked while a performance records.
          </span>
        )}
        <span className={styles.spacer} />
        {!drums && !paging && <RowZoom />}
        {canSplit && (
          <Button size="sm" icon="copy" onClick={makeDifferent} disabled={locked} tip={locked ? 'Locked while a performance records.' : splitTip}>
            Make this one different
          </Button>
        )}
        <IconButton icon="close" label="Close the editor (Esc)" size="sm" variant="ghost" onClick={close} />
      </div>
      {paging && (
        <div className={styles.bars}>
          <BarStrip trackId={trackId} slot={slot} bars={bars} page={page} kind={kind as InstrumentKind} />
        </div>
      )}
      <div
        id="steps-page-panel"
        className={styles.body}
        role="tabpanel"
        aria-label={`${clip.name}, ${span > 1 ? `all ${bars} bars` : `bar ${page + 1}`}`}
        data-span={span}
        onPointerDownCapture={(e) => pickBarAt(rootRef.current, trackId, span, e)}
      >
        {drums ? (
          <DrumSteps trackId={trackId} slot={slot} page={first} span={span} clip={clip} kitId={kitId} pads={false} />
        ) : (
          <PitchLane trackId={trackId} slot={slot} page={first} span={span} clip={clip} kind={kind as 'bass' | 'poly' | 'sampler'} />
        )}
      </div>
    </div>
  );
}
