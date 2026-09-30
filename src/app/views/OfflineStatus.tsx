/**
 * Offline readiness and update state of the installed app (service worker).
 *
 * - `OfflineStatus` sits at the end of the transport strip: a compact icon
 *   (words in its tooltip and accessible text), or an Update button when a
 *   new version is waiting.
 * - `OfflineMenuItems` repeats both in the transport's More menu, which is
 *   where they live when the strip has no room for them.
 *
 * Updates are applied only when the user presses Update, never during
 * playback or a recording: pending edits are written first, and the page
 * reloads into the new version only if they were stored.
 */
import { Button, Icon, Tooltip, type IconName } from '../../ui/components';
import { session } from '../instance';
import { notify, runtimeStore, useOffline, useRuntime, type OfflineState } from '../runtime';
import { MenuItem, MenuSeparator } from './ClipMenu';
import styles from './OfflineStatus.module.css';

type Passive = Exclude<OfflineState, 'unsupported' | 'update-ready'>;

const PASSIVE: Record<Passive, { text: string; icon: IconName; tip: string; short: string }> = {
  installing: { text: 'Caching…', icon: 'clock', tip: 'Storing the app in this browser so it can work without an internet connection.', short: 'Storing the app' },
  ready: { text: 'Offline ready', icon: 'check', tip: 'Everything the app needs is stored in this browser, so it works without an internet connection.', short: 'Works without internet' },
  error: { text: 'Online only', icon: 'info', tip: 'Offline caching is unavailable here; the app still works while this page is open.', short: 'No offline copy' },
};

/** "Available offline": a check in a circle (a status badge, unlike the save lamp and the Export arrow). */
function OfflineReadyGlyph() {
  return (
    <svg className={styles.icon} width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx={8} cy={8} r={6.1} vectorEffect="non-scaling-stroke" />
      <path d="M5.3 8.2 L7.2 10.1 L10.8 6.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const UPDATE_TIP = 'A new version is ready. Your projects are kept; the page reloads, which takes a second.';
const UPDATE_BUSY = 'Stop playback first: updating reloads the page.';

/** Write pending edits, then reload into the new version, unless that would interrupt or lose something. */
export async function applyUpdate(apply: () => void): Promise<void> {
  await session.autosaver?.flush();
  if (session.autosaver?.status.getState().status === 'error') {
    notify('The update waits: your latest changes could not be saved. Try saving again or export the project file first.', 'warn');
    return;
  }
  const rt = runtimeStore.getState();
  // Playback or a recording started meanwhile: never reload under it.
  if (rt.playing || rt.recording !== 'off') return;
  apply();
}

/** True while an update would interrupt something (playback or a recording). */
function useUpdateBlocked(): boolean {
  const playing = useRuntime((s) => s.playing);
  const recording = useRuntime((s) => s.recording !== 'off');
  return playing || recording;
}

export function OfflineStatus(props: { statusClassName?: string; updateClassName?: string }) {
  const { state, apply } = useOffline();
  const blocked = useUpdateBlocked();
  if (state === 'unsupported') return null;
  if (state === 'update-ready' && apply) {
    return (
      <Button
        size="sm"
        variant="secondary"
        icon="download"
        disabled={blocked}
        onClick={() => void applyUpdate(apply)}
        tip={blocked ? `A new version is ready. ${UPDATE_BUSY}` : UPDATE_TIP}
        className={[styles.update, props.updateClassName].filter(Boolean).join(' ')}
      >
        Update
      </Button>
    );
  }
  const view = PASSIVE[state === 'update-ready' ? 'ready' : state];
  return (
    <Tooltip tip={view.tip}>
      <span className={[styles.status, state === 'ready' ? styles.ready : '', props.statusClassName].filter(Boolean).join(' ')} role="status" tabIndex={0}>
        {state === 'ready' || state === 'update-ready' ? <OfflineReadyGlyph /> : <Icon name={view.icon} size={14} className={styles.icon} />}
        <span className="visually-hidden">{view.text}</span>
      </span>
    </Tooltip>
  );
}

/** The offline state (and the Update action) as More-menu rows; nothing when offline caching is unsupported. */
export function OfflineMenuItems({ onDone }: { onDone(): void }) {
  const { state, apply } = useOffline();
  const blocked = useUpdateBlocked();
  if (state === 'unsupported') return null;
  const passive = PASSIVE[state === 'update-ready' ? 'ready' : state];
  return (
    <>
      {state === 'update-ready' && apply ? (
        <MenuItem
          icon="download"
          disabled={blocked}
          disabledReason={UPDATE_BUSY}
          hint="Reloads the page"
          onSelect={() => {
            onDone();
            void applyUpdate(apply);
          }}
        >
          Update to the new version
        </MenuItem>
      ) : (
        <MenuItem icon={passive.icon} disabled disabledReason={passive.short} onSelect={onDone}>
          {passive.text}
        </MenuItem>
      )}
      <MenuSeparator />
    </>
  );
}
