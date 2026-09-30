/**
 * Arrange: turn scenes into a song, and keep live performances.
 *
 *   [ SONG — scene blocks in play order, repeats, playhead, palette      ]
 *   [ PERFORMANCES — recorded takes: replay, export, rename, edit events ]
 *
 * Everything edits the real project through undoable commands; playback
 * goes through the session (song mode, performance replay), so what the view
 * shows is what the transport plays.
 */
import { PerformancesPanel } from './PerformancesPanel';
import { SongPanel } from './SongPanel';
import styles from './ArrangeView.module.css';

export function ArrangeView() {
  return (
    <div className={styles.view}>
      <SongPanel />
      <PerformancesPanel />
    </div>
  );
}
