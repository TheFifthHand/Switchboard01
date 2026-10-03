/**
 * Where the song plays, for the Song view and the transport.
 *
 * Song time is absolute: the sequencer maps the transport onto the song
 * timeline through passes (a song loop starts a new pass at its end), so the
 * bar under the playhead is read straight from it, at the position you hear
 * (the output delay taken off), cheaply enough for every animation frame.
 * Nothing here is React state per frame: views move the playhead in a rAF
 * loop with `songPlayheadBar()` and re-render only when the song starts,
 * pauses or stops (`useSongPlaying`).
 */
import { session } from './instance';
import { useRuntime } from './runtime';

/**
 * The song bar (fractional, 0-based) under the playhead right now while the
 * song plays or is paused, at the position you hear; null otherwise (the
 * song is stopped, or the pads or a take play). It waits at the start bar
 * until the sound gets there, and at the end of the song after it.
 */
export function songPlayheadBar(): number | null {
  const t = session.transport;
  const seq = session.sequencer;
  if (!t || !seq || seq.mode.kind !== 'song' || !(seq.playing || seq.paused)) return null;
  return seq.songBarAt(t.audibleTick());
}

/** The song plays or is paused (the transport is in song mode). */
export function useSongPlaying(): boolean {
  return useRuntime((s) => s.mode === 'song' && (s.playing || s.paused));
}
