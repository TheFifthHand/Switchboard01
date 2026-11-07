/**
 * ⋯ in Simple (round 7): everything the Song screen does not show, one press
 * away. A waiting Update first; Show every control (Advanced, 2.4's tabs and
 * every control; the music does not change); the sheets — Jam pads (2.4
 * Play), Mixer (Mix), Every setting (Shape) — each opening over the song with
 * "← Back to my song"; Recorded takes (when the project has some); Mute all
 * sound (2.4's Mute All: voices and effect tails); MIDI & audio; Help; Tips;
 * and the app's offline state as plain text.
 *
 * Cables are in Advanced only (⋯ › Show every control, then Shape).
 * Recording options (metronome, count-in, timing) are in Advanced too: in
 * Simple, ● Record uses them as they are set (count-in on by default).
 */
import { useRef, useState } from 'react';
import { Tooltip } from '../../../ui/components';
import { setTipsEnabled, setUiMode, setView, type View } from '../../../state/uiStore';
import { session, useProject, useUi } from '../../instance';
import { useOffline, useRuntime } from '../../runtime';
import { MenuItem, MenuSeparator, MoreIcon, Popover, anchorFromElement } from '../ClipMenu';
import { OfflineMenuItems, OfflineMenuStatus } from '../OfflineStatus';
import styles from './SimpleTopBar.module.css';

export interface MoreMenuProps {
  onOpenDevices(): void;
  onOpenHelp(): void;
  /** Show the recorded takes (Performances) on the Song screen. */
  onOpenTakes(): void;
}

/** Open a 2.4 view as a sheet over the song (playback is braced first: the view mounts). */
export function openSheet(view: Exclude<View, 'arrange'>): void {
  session.brace();
  setView(view);
}

export function MoreMenu(props: MoreMenuProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const tipsEnabled = useUi((s) => s.tipsEnabled);
  const view = useUi((s) => s.view);
  const selected = useUi((s) => s.selectedTrackId);
  const partName = useProject((p) => p.tracks.find((t) => t.id === selected)?.name ?? '');
  const takes = useProject((p) => p.performances.length);
  const muteAll = useRuntime((s) => s.muteAll);
  const updateReady = useOffline().state === 'update-ready';
  const close = () => setOpen(false);
  /** Close the menu, then act (dialogs open with the menu gone, so focus goes to them). */
  const then = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <>
      <Tooltip name="More" tip={updateReady ? 'A new version is ready: Update is in this menu.' : 'More: every control, jam pads, the mixer, Mute all, MIDI & audio, Help and Tips.'}>
        <button
          ref={btnRef}
          type="button"
          className={styles.more}
          aria-label={updateReady ? 'More: update ready' : 'More'}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <MoreIcon size={18} />
          {updateReady && <span className={styles.moreBadge} aria-hidden="true" />}
        </button>
      </Tooltip>
      {open && (
        <Popover anchor={anchorFromElement(btnRef.current)} label="More" align="end" onClose={close} returnFocus={btnRef.current} ignore={btnRef.current}>
          <OfflineMenuItems onDone={close} />
          <MenuItem
            icon="sliders"
            role="menuitemcheckbox"
            checked={false}
            hint="Advanced"
            onSelect={then(() => {
              session.brace();
              setUiMode('advanced');
            })}
          >
            Show every control
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon="drum" hint={view === 'play' ? 'Open' : undefined} onSelect={then(() => openSheet('play'))}>
            Jam pads
          </MenuItem>
          <MenuItem icon="stereo" hint={view === 'mix' ? 'Open' : undefined} onSelect={then(() => openSheet('mix'))}>
            Mixer
          </MenuItem>
          <MenuItem icon="settings" hint={view === 'shape' ? 'Open' : partName} onSelect={then(() => openSheet('shape'))}>
            Every setting
          </MenuItem>
          {takes > 0 && (
            <MenuItem icon="recordPerformance" hint={String(takes)} onSelect={then(props.onOpenTakes)}>
              Recorded takes
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon="mute" role="menuitemcheckbox" checked={muteAll} hint={muteAll ? 'On' : 'Off'} onSelect={then(() => session.toggleMuteAll())}>
            Mute all sound
          </MenuItem>
          <MenuItem icon="midi" onSelect={then(props.onOpenDevices)}>
            MIDI & audio…
          </MenuItem>
          <MenuItem icon="keys" hint="?" keyShortcut="?" onSelect={then(props.onOpenHelp)}>
            Help…
          </MenuItem>
          <MenuItem icon="info" role="menuitemcheckbox" checked={tipsEnabled} hint={tipsEnabled ? 'On' : 'Off'} onSelect={then(() => setTipsEnabled(!tipsEnabled))}>
            Tips
          </MenuItem>
          <OfflineMenuStatus />
        </Popover>
      )}
    </>
  );
}

