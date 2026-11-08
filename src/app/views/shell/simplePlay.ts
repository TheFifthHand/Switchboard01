/**
 * Play in Simple (round 7): one home, one way to play. Play (and Space)
 * always plays the song: playing, it pauses; paused, it continues; stopped,
 * the song plays from its playhead (in the part set to repeat, when one is).
 * With nothing in the song it says how to start one instead of playing the
 * pads, which Simple does not show.
 */
import { songBars } from '../../../project/arrangement';
import { session } from '../../instance';
import { notify } from '../../runtime';

/** What Play says when the song has nothing in it yet (Simple words). */
export const EMPTY_SONG_MESSAGE = 'Your song is empty. Drag a loop in from LOOPS on the right, then press Play.';

export function playSimple(): Promise<void> {
  if (session.playing || session.transport?.paused) return session.togglePlay({ song: true });
  if (songBars(session.store.getState()) === 0) {
    notify(EMPTY_SONG_MESSAGE, 'warn');
    return Promise.resolve();
  }
  return session.togglePlay({ song: true });
}
