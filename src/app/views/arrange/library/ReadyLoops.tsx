/**
 * "Try a ready-made loop…": the library's loops for one instrument (bass
 * loops for a bass, chords for keys…), in the song's key, put straight into
 * the loop the editor shows. The melodic twin of "Try a ready-made beat…"
 * (BeatPicker), so chords and bass never need theory.
 *
 *   [▶] Bouncy Bass        House · bouncy
 *   [▶] Rolling Eights     Techno · driving     ← a click puts it in this loop
 *
 * ▶ hears a loop once on the instrument (the loop preview) while nothing
 * plays; while the song plays, a click on a loop puts it in and the song
 * plays it where this loop is. Trying another loop right after takes the
 * last one back first, so ten tries leave one undo step ("Use <loop>") and
 * Undo goes back to what the loop held. A loop shorter than this one is
 * repeated to fill it; a longer one (or one that does not repeat evenly in
 * it) brings its own length.
 */
import { useMemo, useState } from 'react';
import { Button, Icon, Tooltip } from '../../../../ui/components';
import type { LibraryLoop } from '../../../../content/loops';
import { uid } from '../../../../project/factory';
import { clipAtSlot, isSongSlot } from '../../../../project/clips';
import { uiStore } from '../../../../state/uiStore';
import type { Id } from '../../../../project/types';
import * as cmd from '../../../../state/commands';
import { shallowEqual } from '../../../../state/store';
import { session, useProject } from '../../../instance';
import { startPreview, stopPreview, usePreviewKey } from '../../../preview';
import { notify, useRuntime } from '../../../runtime';
import { MenuHeader, Popover, isEditLocked, LOCKED_TEXT, type MenuAnchor } from '../../ClipMenu';
import { freshName, partProblem, realizeFor, styleName } from './libraryModel';
import { fitReadyLoop, readyLoopsFor } from './readyLoops';
import beat from '../../BeatPicker.module.css';
import styles from './Library.module.css';
import own from './ReadyLoops.module.css';

/** The last loop tried, and the undo step it made (taken back when another is tried right after). */
let lastTry: { trackId: Id; slot: number; entry: number | null } | null = null;

/**
 * Put library loop `loop` in the part's loop at `slot` (in the song's key, on
 * the part), as one undo step. False (with a plain notice) when it cannot.
 */
export function applyReadyLoop(trackId: Id, slot: number, loop: LibraryLoop): boolean {
  if (isEditLocked()) {
    notify(`${LOCKED_TEXT}.`, 'warn');
    return false;
  }
  const store = session.store;
  // Trying another loop right after one: the earlier try goes, so the loop holds one and Undo has one step.
  if (lastTry && lastTry.trackId === trackId && lastTry.slot === slot && lastTry.entry !== null && store.undoEntryId() === lastTry.entry) store.undo();
  lastTry = null;
  const p = store.getState();
  const track = p.tracks.find((t) => t.id === trackId);
  const existing = track ? clipAtSlot(track, slot) : null;
  if (!track || !existing) return false;
  const problem = partProblem(loop, track);
  const realized = realizeFor(p, loop, track);
  if (problem || !realized) {
    notify(problem ?? `${loop.name} cannot play on ${track.name}.`, 'warn');
    return false;
  }
  const fit = fitReadyLoop(realized, existing.bars);
  const words = `Use ${loop.name}`;
  store.beginGroup(words);
  let ok = true;
  try {
    if (existing.bars !== fit.bars) ok = session.accepted(cmd.setClipBars(store, trackId, slot, fit.bars));
    if (ok) ok = session.accepted(cmd.setClipNotes(store, trackId, slot, fit.notes.map((n) => ({ ...n, id: uid('n') })), words));
    if (ok) followInSong(trackId, slot, existing.id, loop.name);
  } finally {
    store.endGroup();
  }
  if (!ok) return false;
  lastTry = { trackId, slot, entry: store.undoEntryId() };
  return true;
}

/**
 * Simple: a loop of the song that now holds another loop is called by it
 * (the block reads "Four Chord Pop", not the old name), and the song plays
 * it through when it got longer (fitSongToLoop). Pad loops and Advanced keep
 * 2.4's ways (the name stays, the regions keep their length). Runs inside
 * the caller's undo group.
 */
export function followInSong(trackId: Id, slot: number, clipId: Id, name: string): void {
  if (!isSongSlot(slot) || uiStore.getState().uiMode !== 'simple') return;
  const store = session.store;
  const t = store.getState().tracks.find((x) => x.id === trackId);
  const clip = t ? clipAtSlot(t, slot) : null;
  if (!t || !clip) return;
  if (clip.name !== name) session.accepted(cmd.renameClip(store, trackId, slot, freshName(t, name)));
  session.accepted(cmd.fitSongToLoop(store, trackId, clipId));
}

/** Forget the last try (another loop opened: its next try is a step of its own). */
export function forgetReadyLoopTry(): void {
  lastTry = null;
}

export interface ReadyLoopsProps {
  trackId: Id;
  slot: number;
  anchor: MenuAnchor;
  returnFocus?: HTMLElement | null;
  ignore?: Element | null;
  onClose(): void;
}

export function ReadyLoops({ trackId, slot, anchor, returnFocus, ignore, onClose }: ReadyLoopsProps) {
  const part = useProject((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    return t ? { name: t.name, role: t.role, kind: t.instrument.kind } : null;
  }, shallowEqual);
  const loops = useMemo(() => (part ? readyLoopsFor(part.role, part.kind) : []), [part]);
  const [picked, setPicked] = useState<string | null>(null);
  const hearing = usePreviewKey();
  const playing = useRuntime((s) => s.playing || s.paused || s.recording !== 'off');
  const close = () => {
    stopPreview();
    onClose();
  };
  const hear = (loop: LibraryLoop) => {
    const key = `ready:${loop.id}`;
    if (hearing === key) {
      stopPreview();
      return;
    }
    const p = session.store.getState();
    const t = p.tracks.find((x) => x.id === trackId);
    const notes = t ? realizeFor(p, loop, t) : null;
    if (notes) void startPreview(key, trackId, notes.notes, notes.bars);
  };
  const pick = (loop: LibraryLoop) => {
    if (!applyReadyLoop(trackId, slot, loop)) return;
    setPicked(loop.id);
    // Nothing playing: hear it once, as it is in the loop now.
    if (!playing) hear(loop);
  };
  const name = part?.name ?? 'Instrument';
  return (
    <Popover anchor={anchor} label="Try a ready-made loop" role="dialog" onClose={close} returnFocus={returnFocus} ignore={ignore} className={beat.picker}>
      <MenuHeader eyebrow={name} title="Try a ready-made loop">
        <div className={beat.note}>
          {playing
            ? 'Click a loop to put it in this loop: you hear it in your song. Click another to swap it. Undo goes back.'
            : 'Press ▶ to hear a loop, or click it to put it in this loop. Click another to swap it. Undo goes back.'}{' '}
          Every loop plays in your song’s key.
        </div>
      </MenuHeader>
      {loops.length === 0 ? (
        <p className={`${beat.note} ${own.empty}`}>
          There are no ready-made loops for {name}. Draw notes in the grid, or play them on the Play side.
        </p>
      ) : (
        <ul className={beat.list} aria-label={`Ready-made loops for ${name}`} data-testid="ready-loops">
          {loops.map((l) => {
            const on = picked === l.id;
            const isHearing = hearing === `ready:${l.id}`;
            const meta = `${styleName(l.genres[0])} · ${l.feel}`;
            return (
              <li key={l.id} className={own.row}>
                <Tooltip name={isHearing ? `Stop ${l.name}` : playing ? 'Playing now: click the loop to hear it in your song' : `Hear ${l.name}`}>
                  <button
                    type="button"
                    className={styles.play}
                    data-hearing={isHearing || undefined}
                    aria-pressed={isHearing}
                    aria-label={isHearing ? `Stop hearing ${l.name}` : `Hear ${l.name}`}
                    aria-disabled={(playing && !isHearing) || undefined}
                    onClick={() => {
                      if (playing && !isHearing) return;
                      hear(l);
                    }}
                    data-ready-hear={l.id}
                  >
                    <Icon name={isHearing ? 'stop' : 'play'} size={11} />
                  </button>
                </Tooltip>
                <button
                  type="button"
                  className={beat.beat}
                  data-picked={on || undefined}
                  aria-pressed={on}
                  aria-label={`${l.name}, ${meta}${on ? ', in the loop' : ''}`}
                  onClick={() => pick(l)}
                  data-ready-loop={l.id}
                >
                  <Icon name={on ? 'check' : 'plus'} size={14} className={beat.beatIcon} />
                  <span className={beat.beatName}>{l.name}</span>
                  <span className={beat.beatMeta}>{on ? 'In the loop' : meta}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className={beat.foot}>
        <Button size="sm" variant={picked ? 'primary' : 'secondary'} onClick={close}>
          {picked ? 'Keep this loop' : 'Close'}
        </Button>
      </div>
    </Popover>
  );
}
