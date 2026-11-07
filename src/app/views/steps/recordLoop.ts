/**
 * "● Record into this loop" (the Song screen's editor, Play side): what is
 * played on the pads, the keys or a MIDI keyboard goes into the loop the
 * editor shows, while the song repeats that place.
 *
 * It is 2.4's Record Notes in the song (session.toggleRecordNotes: one undo
 * step for the whole pass, notes overdubbed each time round, timed on the
 * audio clock), aimed at this loop: the song repeats the region the editor
 * was opened from (a song loop, runtime only, never saved) and plays from
 * its start, unless it already plays inside it. The repeat the person had
 * before comes back when the recording ends (Stop, this button, a pause),
 * unless they changed it meanwhile.
 */
import type { Id } from '../../../project/types';
import type { SongLoop } from '../../../time/contracts';
import { selectTrack } from '../../../state/uiStore';
import { session } from '../../instance';
import { notify, runtimeStore } from '../../runtime';
import { songPlayheadBar } from '../../songPlayback';

/** The repeat set for a recording, and the one to bring back when it ends. */
let restore: { set: SongLoop; prev: SongLoop | null } | null = null;
let watching = false;

function sameLoop(a: SongLoop | null, b: SongLoop | null): boolean {
  return a === b || (!!a && !!b && a.fromBar === b.fromBar && a.toBar === b.toBar);
}

/** Bring the person's repeat back once the recording has ended. */
function watchEnd(): void {
  if (watching) return;
  watching = true;
  runtimeStore.subscribe((s, prev) => {
    if (!restore || s.recording === 'notes' || prev.recording !== 'notes') return;
    const r = restore;
    restore = null;
    if (sameLoop(s.songLoop, r.set)) session.setSongLoop(r.prev);
  });
}

/** True while Record Notes records into `trackId`'s loop at `slot`. */
export function recordingInto(rt: { recording: string; recordTarget: { trackId: Id; slot: number } | null }, trackId: Id, slot: number): boolean {
  return rt.recording === 'notes' && rt.recordTarget?.trackId === trackId && rt.recordTarget.slot === slot;
}

/**
 * Start recording into the loop region `regionId` plays (or stop the
 * recording running now). Resolves when the recording has started or was
 * refused (the session says why).
 */
export async function toggleRecordIntoLoop(regionId: Id): Promise<void> {
  if (session.recordingNotes) {
    session.stopRecordNotes();
    return;
  }
  if (session.recordingPerformance) {
    // Playing the song from here would end the take: it finishes first.
    notify('Finish the performance recording first.', 'warn');
    return;
  }
  const p = session.store.getState();
  const r = p.arrangement.regions.find((x) => x.id === regionId);
  if (!r) return;
  watchEnd();
  selectTrack(r.trackId);
  const rt = runtimeStore.getState();
  const set: SongLoop = { fromBar: r.start, toBar: r.start + r.bars };
  const at = songPlayheadBar();
  const inside = rt.mode === 'song' && (rt.playing || rt.paused) && at !== null && at >= r.start && at < r.start + r.bars;
  const prev = rt.songLoop;
  if (!session.setSongLoop(set)) return;
  restore = { set: runtimeStore.getState().songLoop ?? set, prev };
  if (!inside) await session.playSong({ fromBar: r.start });
  await session.toggleRecordNotes();
  // Refused (a performance take records, nothing to record into…): the repeat goes back at once.
  if (!session.recordingNotes && restore) {
    const back = restore;
    restore = null;
    if (sameLoop(runtimeStore.getState().songLoop, back.set)) session.setSongLoop(back.prev);
  }
}
