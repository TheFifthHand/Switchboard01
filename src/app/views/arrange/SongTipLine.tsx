/**
 * The tip line at the bottom of the Song screen in Simple mode: one plain next
 * step, read from the song as it is (songTip: pick a beat, fill an empty
 * loop, add a bass, make it longer, share it), and Hide tips (the same switch as ⋯ › Tips). It
 * changes by itself as the song does; it never covers the music.
 */
import { Button, Icon } from '../../../ui/components';
import { setTipsEnabled } from '../../../state/uiStore';
import { useProject, useUi } from '../../instance';
import { useStore } from '../../../state/store';
import { editorStore } from './editorStore';
import { songTip } from './songHome';
import styles from './SongView.module.css';

export function SongTipLine() {
  const on = useUi((s) => s.tipsEnabled);
  const editorOpen = useStore(editorStore, (e) => e !== null);
  const tip = useProject((p) => songTip(p, editorOpen), (a, b) => a.step === b.step && a.text === b.text);
  if (!on) return null;
  return (
    <div className={styles.tipLine} data-testid="song-tip" data-step={tip.step}>
      <Icon name="info" size={14} />
      <span className={styles.tipText} role="status">
        <strong>Next:</strong> {tip.text}
      </span>
      <Button size="sm" variant="ghost" onClick={() => setTipsEnabled(false)} data-testid="hide-tips" tip="Hide the tips. ⋯ › Tips brings them back.">
        Hide tips
      </Button>
    </div>
  );
}
