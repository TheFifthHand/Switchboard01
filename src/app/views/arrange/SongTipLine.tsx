/**
 * The tip line at the bottom of the Song screen in Simple mode: one plain next
 * step, read from the song as it is (songTip: pick a beat, fill an empty
 * loop, try a ready-made song's loops, add drums, a bass, chords, make it
 * longer, share it), and Hide tips (the same switch as ⋯ › Tips). It
 * changes by itself as the song does; it never covers the music.
 */
import { useCallback, useRef } from 'react';
import { Button, Icon } from '../../../ui/components';
import type { Project } from '../../../project/types';
import { setTipsEnabled } from '../../../state/uiStore';
import { useProject, useUi } from '../../instance';
import { useStore } from '../../../state/store';
import { editorStore } from './editorStore';
import { isUntouchedStarter, songTip } from './songHome';
import styles from './SongView.module.css';

export function SongTipLine() {
  const on = useUi((s) => s.tipsEnabled);
  const editorOpen = useStore(editorStore, (e) => e !== null);
  // A ready-made song (Jump In, a starter) that nobody changed yet, until a loop of it is opened.
  const projectId = useProject((p) => p.id);
  const untouched = useProject(isUntouchedStarter);
  const opened = useRef<string | null>(null);
  if (editorOpen) opened.current = projectId;
  const fresh = untouched && opened.current !== projectId;
  const tip = useProject(
    useCallback((p: Project) => songTip(p, { editorOpen, fresh }), [editorOpen, fresh]),
    (a, b) => a.step === b.step && a.text === b.text,
  );
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
