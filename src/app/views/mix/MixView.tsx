/**
 * Mix: levels, panning and mastering for the whole song.
 *
 *   [ MIXER: one strip per part (fader + meter, Pan, Mute, Solo) · Master ]
 *   [ MASTERING: On/Off, A/B, presets, loudness target + Match, spectrum  ]
 *
 * Simple shows the essentials; Advanced adds each part's Reverb and Echo
 * amounts and effects (opening that part in Shape), the limiter readout, and
 * every mastering control grouped by purpose. Everything edits the real
 * project through the session and commands (undoable, recorded by a take
 * where a take can record it); every meter shows real engine output.
 */
import { Panel } from '../../../ui/components';
import { shallowEqual } from '../../../state/store';
import { useProject, useUi } from '../../instance';
import { ChannelStrip, MasterStrip } from './ChannelStrip';
import { MasteringPanel } from './MasteringPanel';
import styles from './MixView.module.css';

export function MixView() {
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const trackIds = useProject((p) => p.tracks.map((t) => t.id), shallowEqual);
  const soloCount = useProject((p) => p.tracks.filter((t) => t.solo).length);
  const subtitle =
    soloCount > 0 ? (
      <span className={styles.solo}>Solo on: only the {soloCount === 1 ? 'soloed part plays' : `${soloCount} soloed parts play`}</span>
    ) : (
      <span className={styles.hint}>Drag a fader to set a part&rsquo;s level; double-click returns it to 0 dB.</span>
    );
  return (
    <div className={styles.view} data-mode={advanced ? 'advanced' : 'simple'} role="region" aria-label="Mix">
      <Panel title="Mixer" subtitle={subtitle} className={styles.mixer} bodyClassName={styles.mixerBody}>
        <div className={styles.strips} style={{ ['--parts' as string]: trackIds.length }}>
          {trackIds.map((id, i) => (
            <ChannelStrip key={id} trackId={id} index={i} advanced={advanced} />
          ))}
          <MasterStrip advanced={advanced} />
        </div>
      </Panel>
      <MasteringPanel advanced={advanced} className={styles.mastering} />
    </div>
  );
}
