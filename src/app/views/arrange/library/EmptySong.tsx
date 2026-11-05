/**
 * The empty song (no loops, whatever section labels are left): one line
 * that says what to do, [Open the loop library] and, when the pads have
 * clips, [Make a song from my scenes]. It steps aside while something is
 * dragged in.
 *
 * SongTimeline shows it in place of its own empty note (see the lanelib
 * hand-off); `openBrowser` opens the loop browser when it is hidden.
 */
import { Button } from '../../../../ui/components';
import { useStore } from '../../../../state/store';
import { session } from '../../../instance';
import { browserTabStore } from '../LoopBrowser';
import { browserOpenStore, dragStore } from '../laneStore';
import * as act from '../songActions';
import laneStyles from '../SongView.module.css';
import styles from './Library.module.css';

/** The empty song's line. */
export function emptySongText(hasScenes: boolean): string {
  return hasScenes ? 'The song is empty. Add loops from the library, or drag a scene or a loop here.' : 'The song is empty. Add loops from the library to start it.';
}

/** Show the loop browser on its Library tab, with the search field focused. */
export function openLoopLibrary(openBrowser?: () => void): void {
  browserTabStore.setState({ projectId: session.store.getState().id, tab: 'library' });
  if (!browserOpenStore.getState()) {
    if (openBrowser) openBrowser();
    else document.querySelector<HTMLButtonElement>('[data-testid="loops-toggle"]')?.click();
  }
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="library-search"]')?.focus());
}

export function EmptySong({ hasScenes, openBrowser }: { hasScenes: boolean; openBrowser?: () => void }) {
  const dragging = useStore(dragStore, (d) => d !== null);
  if (dragging) return null;
  return (
    <div className={laneStyles.empty} data-testid="song-empty">
      <p className={laneStyles.emptyText}>{emptySongText(hasScenes)}</p>
      <div className={styles.emptyActions}>
        <Button variant={hasScenes ? 'secondary' : 'primary'} icon="search" onClick={() => openLoopLibrary(openBrowser)} data-testid="empty-open-library">
          Open the loop library
        </Button>
        {hasScenes && (
          <Button variant="primary" icon="sparkle" onClick={() => act.fillFromScenes()} data-testid="empty-make-song">
            Make a song from my scenes
          </Button>
        )}
      </div>
    </div>
  );
}
