/**
 * "Start from a beat…": the beat presets (content/beats.ts) by style. A
 * press on a beat puts it in the drum loop and the loop plays, so the beat is
 * heard at once on the part's own kit (the real engine, on the audio clock).
 * Pressing another beat swaps it in: while the last beat tried is still the
 * newest edit, it is taken back first, so trying ten beats leaves one undo
 * step ("Start from <beat>"), and Undo goes back to what the loop held.
 *
 * In a fresh project (started blank, nothing else in it yet) a beat also
 * brings its own tempo, in the same undo step, and the notice says so; in
 * any other project the song keeps its tempo and the picker says the beats
 * play at it (each beat's own tempo is shown as a hint, "best at 90 BPM").
 *
 * Opened from the empty-pad menu (⋯ or right-click on an empty drum pad) and
 * from Play › Steps on a drum part; `inSong`: from the Song screen's editor
 * ("Try a ready-made beat…"), where the loop plays in the song: the pads are
 * left alone (a playing song plays the beat where the loop is), and with
 * nothing playing the beat is heard once on the part (the loop preview). In
 * Simple the words leave out BPM and bars.
 */
import { useMemo, useRef, useState } from 'react';
import { Button, Icon } from '../../ui/components';
import { BEATS, realizeBeat, type BeatDef } from '../../content/beats';
import { GENRES } from '../../content/loops';
import { uid } from '../../project/factory';
import { clipAtSlot, isSongSlot, trackClips } from '../../project/clips';
import type { ClipBars, Id, Project } from '../../project/types';
import * as cmd from '../../state/commands';
import { selectSlot, selectTrack } from '../../state/uiStore';
import { session, useProject, useUi } from '../instance';
import { notify, runtimeStore, useRuntime } from '../runtime';
import { startPreview, stopPreview } from '../preview';
import { MenuHeader, Popover, isEditLocked, LOCKED_TEXT, type MenuAnchor } from './ClipMenu';
import { followInSong } from './arrange/library/ReadyLoops';
import styles from './BeatPicker.module.css';

/** Styles that have beats, in the library's order, each with its beats (main style only). */
export function beatStyles(beats: readonly BeatDef[] = BEATS): { id: string; name: string; beats: BeatDef[] }[] {
  return GENRES.map((g) => ({ id: g.id as string, name: g.name, beats: beats.filter((b) => b.genre === g.id) })).filter((g) => g.beats.length > 0);
}

/** The style to show first: the one whose beat was written nearest the project's tempo. */
export function styleForTempo(bpm: number, beats: readonly BeatDef[] = BEATS): string {
  let best: BeatDef | null = null;
  for (const b of beats) if (!best || Math.abs(b.bpm - bpm) < Math.abs(best.bpm - bpm)) best = b;
  return best?.genre ?? 'house';
}

/** The loop's length with a beat in it: the loop's own when the beat repeats evenly in it, else the beat's. */
export function barsWithBeat(loopBars: number | null, beatBars: number): ClipBars {
  return (loopBars !== null && loopBars % beatBars === 0 ? loopBars : beatBars) as ClipBars;
}

/**
 * What a beat is like, in words: "chill · 90 BPM · 2 bars" where the beat brings its tempo (a fresh
 * project), else "chill · 2 bars · best at 90 BPM" (it plays at the song's tempo).
 */
export function beatMeta(b: BeatDef, setsTempo = true): string {
  const bars = `${b.bars} bar${b.bars === 1 ? '' : 's'}`;
  return setsTempo ? `${b.feel} · ${b.bpm} BPM · ${bars}` : `${b.feel} · ${bars} · best at ${b.bpm} BPM`;
}

/**
 * A project a beat may set the tempo of: started blank (Make a beat from scratch, the Blank starter)
 * and still empty apart from the loop the beat goes into (no notes in any other loop, nothing in the song).
 */
export function beatSetsTempo(p: Project, trackId: Id, slot: number): boolean {
  if (p.starterId !== 'blank' || p.arrangement.regions.length > 0) return false;
  return p.tracks.every((t) => trackClips(t).every(({ slot: s, clip }) => (t.id === trackId && s === slot) || clip.notes.length === 0));
}

/** The last beat tried, and the undo step it made (taken back when another beat is tried right after). */
let lastTry: { trackId: Id; slot: number; entry: number | null } | null = null;

/**
 * Put `beat` in the part's loop at `slot` (an empty pad gets a new loop), as
 * one undo step. False (with a plain notice) when it cannot.
 */
export function applyBeat(trackId: Id, slot: number, beat: BeatDef): boolean {
  if (isEditLocked()) {
    notify(`${LOCKED_TEXT}.`, 'warn');
    return false;
  }
  const store = session.store;
  const before = store.getState().tracks.find((t) => t.id === trackId);
  if (!before || before.instrument.kind !== 'drums') return false;
  // Trying another beat right after one: the earlier try goes, so the loop holds one beat and Undo has one step.
  if (lastTry && lastTry.trackId === trackId && lastTry.slot === slot && lastTry.entry !== null && store.undoEntryId() === lastTry.entry) store.undo();
  lastTry = null;
  const track = store.getState().tracks.find((t) => t.id === trackId);
  if (!track || track.instrument.kind !== 'drums') return false;
  const existing = clipAtSlot(track, slot);
  if (!existing && isSongSlot(slot)) return false;
  const bars = barsWithBeat(existing?.bars ?? null, beat.bars);
  const words = `Start from ${beat.name}`;
  const was = store.getState().bpm;
  const tempo = beatSetsTempo(store.getState(), trackId, slot) && Math.round(was) !== beat.bpm;
  store.beginGroup(words);
  let ok = true;
  try {
    if (tempo) ok = session.accepted(cmd.setBpm(store, beat.bpm));
    if (ok && !existing) ok = session.accepted(cmd.createClip(store, trackId, slot, bars));
    else if (ok && existing && existing.bars !== bars) ok = session.accepted(cmd.setClipBars(store, trackId, slot, bars));
    if (ok) {
      const kitId = track.instrument.kitId;
      const notes = realizeBeat(beat, { bars: bars as 1 | 2 | 4 | 8, kitId }).notes.map((n) => ({ ...n, id: uid('n') }));
      ok = session.accepted(cmd.setClipNotes(store, trackId, slot, notes, words));
    }
    if (ok && existing) followInSong(trackId, slot, existing.id, beat.name);
  } finally {
    store.endGroup();
  }
  if (!ok) return false;
  lastTry = { trackId, slot, entry: store.undoEntryId() };
  if (tempo) notify(`Tempo set to ${beat.bpm} BPM, ${beat.name}’s own (it was ${Math.round(was)}). Undo takes the beat and the tempo back.`, 'info', 'undo');
  return true;
}

/**
 * Make sure the loop at a pad plays on the live pads, so a beat put in it is
 * heard: a song playing stops first (the pads take over); the loop playing
 * or about to already is left alone.
 */
export async function hearLoop(trackId: Id, slot: number): Promise<void> {
  if (isSongSlot(slot)) return;
  const rt = runtimeStore.getState();
  const t = rt.tracks[trackId];
  const live = rt.mode === 'live';
  if (rt.playing && live && (t?.playingSlot === slot || t?.queued?.slot === slot) && !(t?.queued && t.queued.slot === null)) return;
  if (!live && (rt.playing || rt.paused)) session.stop();
  await session.pressClip(trackId, slot);
}

/** Hear a beat once on the part, as it is in the loop now (nothing else playing: the loop preview). */
export function previewLoopNow(trackId: Id, slot: number, key: string): void {
  const rt = runtimeStore.getState();
  if (rt.playing || rt.paused || rt.recording !== 'off') return;
  const t = session.store.getState().tracks.find((x) => x.id === trackId);
  const clip = t ? clipAtSlot(t, slot) : null;
  if (!clip) return;
  void startPreview(key, trackId, clip.notes, clip.bars);
}

/** "chill · 2 bars"-free words for Simple: the feel alone ("chill"). */
export function beatMetaPlain(b: BeatDef): string {
  return b.feel;
}

export interface BeatPickerProps {
  trackId: Id;
  slot: number;
  /** Opened from the Song screen's editor: the loop plays in the song (see the file comment). */
  inSong?: boolean;
  anchor: MenuAnchor;
  returnFocus?: HTMLElement | null;
  ignore?: Element | null;
  onClose(): void;
}

export function BeatPicker({ trackId, slot, inSong = false, anchor, returnFocus, ignore, onClose }: BeatPickerProps) {
  const styleList = useMemo(() => beatStyles(), []);
  const bpm = useProject((p) => p.bpm);
  const setsTempo = useProject((p) => beatSetsTempo(p, trackId, slot));
  const partName = useProject((p) => p.tracks.find((t) => t.id === trackId)?.name ?? 'Drums');
  const [style, setStyle] = useState(() => styleForTempo(bpm));
  const [picked, setPicked] = useState<string | null>(null);
  const plain = useUi((s) => s.uiMode !== 'advanced') && inSong;
  const songPlays = useRuntime((s) => s.playing);
  const listRef = useRef<HTMLUListElement>(null);
  const current = styleList.find((s) => s.id === style) ?? styleList[0];
  const pick = (b: BeatDef) => {
    if (!applyBeat(trackId, slot, b)) return;
    selectTrack(trackId);
    selectSlot(trackId, slot);
    setPicked(b.id);
    if (!inSong) void hearLoop(trackId, slot);
    else previewLoopNow(trackId, slot, `beat:${b.id}`);
  };
  const close = () => {
    if (inSong) stopPreview();
    onClose();
  };
  const title = inSong ? 'Try a ready-made beat' : 'Start from a beat';
  const meta = (b: BeatDef) => (plain ? beatMetaPlain(b) : beatMeta(b, setsTempo));
  const note = plain
    ? `Click a beat to put it in this loop${songPlays ? ': you hear it in your song' : ' and hear it'}. Click another to swap it. Undo goes back.${setsTempo ? ' Each beat brings its own speed to this new song.' : ''}`
    : null;
  return (
    <Popover anchor={anchor} label={title} role="dialog" onClose={close} returnFocus={returnFocus} ignore={ignore} className={styles.picker}>
      <MenuHeader eyebrow={partName} title={title}>
        <div className={styles.note}>
          {note ?? (
            <>
              Press a beat to hear it in this loop. Press another to swap it. Undo goes back.{' '}
              {setsTempo ? 'Each beat brings its own tempo to this new project.' : `Beats play at your song’s tempo, ${Math.round(bpm)} BPM.`}
            </>
          )}
        </div>
      </MenuHeader>
      <div className={styles.styles} role="radiogroup" aria-label="Style">
        {styleList.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={s.id === current.id}
            className={styles.style}
            onClick={() => {
              setStyle(s.id);
              listRef.current?.scrollTo?.({ top: 0 });
            }}
          >
            {s.name}
          </button>
        ))}
      </div>
      <ul ref={listRef} className={styles.list} aria-label={`${current.name} beats`}>
        {current.beats.map((b) => {
          const on = picked === b.id;
          return (
            <li key={b.id}>
              <button type="button" className={styles.beat} data-picked={on || undefined} aria-pressed={on} aria-label={`${b.name}, ${meta(b)}${on ? ', in the loop' : ''}`} onClick={() => pick(b)} data-beat={b.id}>
                <Icon name={on ? 'check' : 'play'} size={14} className={styles.beatIcon} />
                <span className={styles.beatName}>{b.name}</span>
                <span className={styles.beatMeta}>{on ? 'In the loop' : meta(b)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className={styles.foot}>
        <Button size="sm" variant={picked ? 'primary' : 'secondary'} onClick={close}>
          {picked ? 'Keep this beat' : 'Close'}
        </Button>
      </div>
    </Popover>
  );
}
