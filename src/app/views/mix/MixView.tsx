/**
 * Mix: levels, panning, the shared returns and mastering for the whole song.
 *
 *   [ MIXER: one strip per part · Reverb · Echo returns · Master ] [ MASTERING ]
 *   [ CHANNEL drawer (when open): the selected part's effects    ]
 *
 * Simple shows the essentials; Advanced adds the limiter readout, every
 * mastering control grouped by purpose, and (when its row is shown) each
 * part's effects and Reverb and Echo big knobs. Mastering stays beside the
 * mixer from 1340 px; narrower, it sits under it. Everything edits the real
 * project through the session and commands (undoable, recorded by a take
 * where a take can record it); every meter shows real engine output.
 *
 * The strips paint first; the mastering panel (with the spectrum) mounts in a
 * transition after that first frame, so switching to Mix shows the mixer at
 * once.
 */
import { startTransition, useEffect, useState } from 'react';
import { Button, Panel } from '../../../ui/components';
import { shallowEqual } from '../../../state/store';
import { useProject, useUi } from '../../instance';
import { ChannelDrawer } from './ChannelDrawer';
import { ChannelStrip, MasterStrip } from './ChannelStrip';
import { toggleChannelDrawer, useChannelDrawer } from './channelDrawer';
import { MasteringPanel } from './MasteringPanel';
import { setSendsRow, useSendsRow } from './mixPrefs';
import { ReturnStrip } from './ReturnStrip';
import styles from './MixView.module.css';

/** Mount after the first frame, in a transition (the strips are on screen first). */
function useAfterFirstFrame(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => startTransition(() => setReady(true)));
    return () => cancelAnimationFrame(raf);
  }, []);
  return ready;
}

export function MixView() {
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const selected = useUi((s) => s.selectedTrackId);
  const trackIds = useProject((p) => p.tracks.map((t) => t.id), shallowEqual);
  const soloCount = useProject((p) => p.tracks.filter((t) => t.solo).length);
  const selectedName = useProject((p) => p.tracks.find((t) => t.id === selected)?.name ?? p.tracks[0]?.name ?? '');
  const sends = useSendsRow();
  const drawer = useChannelDrawer();
  const ready = useAfterFirstFrame();
  const subtitle =
    soloCount > 0 ? (
      <span className={styles.solo} data-hint-home="">
        Solo on: only the {soloCount === 1 ? 'soloed part plays' : `${soloCount} soloed parts play`}
      </span>
    ) : (
      <span className={styles.hint} data-hint-home="">
        Drag a fader to set a part&rsquo;s level; double-click returns it to 0 dB.
      </span>
    );
  const drawerTrack = trackIds.includes(selected ?? '') ? selected! : trackIds[0];
  return (
    <div className={styles.view} data-mode={advanced ? 'advanced' : 'simple'} data-drawer={drawer.open || undefined} role="region" aria-label="Mix">
      <Panel
        title="Mixer"
        subtitle={subtitle}
        className={styles.mixer}
        bodyClassName={styles.mixerBody}
        actions={
          <>
            {advanced && (
              <Button
                size="sm"
                variant="ghost"
                icon={sends ? 'chevronUp' : 'chevronDown'}
                aria-expanded={sends}
                onClick={() => setSendsRow(!sends)}
                tip={sends ? 'Hide each part’s effects and Reverb and Echo knobs: the faders get the room.' : 'Show each part’s effects and its Reverb and Echo big knobs on the strips.'}
              >
                Sends &amp; effects
              </Button>
            )}
            {drawerTrack && (
              <Button
                size="sm"
                variant="ghost"
                icon={drawer.open ? 'chevronUp' : 'sliders'}
                aria-expanded={drawer.open}
                onClick={() => toggleChannelDrawer(drawerTrack)}
                tip={drawer.open ? 'Close the Channel drawer.' : `Edit ${selectedName}’s effects here, under the mixer: add an EQ or a compressor, turn its effects.`}
              >
                Channel
              </Button>
            )}
          </>
        }
      >
        <div className={styles.strips} style={{ ['--parts' as string]: trackIds.length }}>
          {trackIds.map((id, i) => (
            <ChannelStrip key={id} trackId={id} index={i} advanced={advanced} sends={sends} />
          ))}
          <ReturnStrip kind="reverb" />
          <ReturnStrip kind="delay" />
          <MasterStrip advanced={advanced} />
        </div>
      </Panel>
      {ready ? (
        <MasteringPanel advanced={advanced} className={styles.mastering} />
      ) : (
        // The same panel, empty, until the mastering mounts: nothing moves when it does.
        <Panel title="Mastering" className={styles.mastering} />
      )}
      <ChannelDrawer className={styles.drawer} />
    </div>
  );
}
