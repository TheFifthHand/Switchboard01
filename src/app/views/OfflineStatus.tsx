/**
 * Offline readiness and update state of the installed app (service worker).
 * Updates are applied only when the user chooses, never during playback.
 */
import { Button, Tooltip } from '../../ui/components';
import { useOffline } from '../pwa';
import { useRuntime } from '../runtime';
import styles from './OfflineStatus.module.css';

export function OfflineStatus() {
  const { state, apply } = useOffline();
  const playing = useRuntime((s) => s.playing);
  const recording = useRuntime((s) => s.recording !== 'off');
  if (state === 'unsupported') return null;
  if (state === 'update-ready' && apply) {
    const busy = playing || recording;
    return (
      <Tooltip tip={busy ? 'A new version is ready. Stop playback to update — nothing interrupts your performance.' : 'A new version is ready. Your projects are kept. Reloading takes a second.'}>
        <Button size="sm" variant="secondary" icon="download" disabled={busy} onClick={apply} className={styles.update}>
          Update
        </Button>
      </Tooltip>
    );
  }
  const text = state === 'ready' ? 'Offline ready' : state === 'installing' ? 'Caching…' : 'Online only';
  const tip =
    state === 'ready'
      ? 'Everything the app needs is stored in this browser, so it works without an internet connection.'
      : state === 'installing'
        ? 'Storing the app in this browser so it can work offline.'
        : 'Offline caching is unavailable here; the app still works while this page is open.';
  return (
    <Tooltip tip={tip}>
      <span className={`${styles.status} ${state === 'ready' ? styles.ready : ''}`} role="status" tabIndex={0}>
        <span className={styles.dot} aria-hidden />
        {text}
      </span>
    </Tooltip>
  );
}
