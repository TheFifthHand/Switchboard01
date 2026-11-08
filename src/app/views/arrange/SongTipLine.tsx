/**
 * The tip line at the bottom of the Song screen in Simple mode: one plain next
 * step, read from the song as it is (songTip: pick a beat, fill an empty
 * loop, hear a ready-made song whole, try its loops, add drums, a bass,
 * chords, make it longer, share it, then ideas of what to do next), and Hide
 * tips (the same switch as ⋯ › Tips). It changes by itself as the song does;
 * it never covers the music and never runs out: after Share it offers one
 * idea at a time (Another idea). With tips hidden a small "What next?" key
 * stays, which says the one next step once.
 *
 * What it has seen (a loop opened, the repeat switched off, the song shared)
 * is kept per project in tipMemory, so leaving the Song screen for a sheet,
 * or coming back another day, does not bring an old step back.
 */
import { useCallback, useEffect } from 'react';
import { Button, Icon } from '../../../ui/components';
import { songBars } from '../../../project/arrangement';
import type { Project } from '../../../project/types';
import { setTipsEnabled } from '../../../state/uiStore';
import { session, useProject, useUi } from '../../instance';
import { notify, runtimeStore, useRuntime } from '../../runtime';
import { useStore } from '../../../state/store';
import { simpleLoopsStore } from './ArrangeView';
import { editorStore } from './editorStore';
import { shownRowsStore } from './laneStore';
import { sidePanelStore } from './sidePanelStore';
import { isUntouchedStarter, repeatName, songTip, type TipState } from './songHome';
import { nextIdea, noteHeardWhole, noteLoopOpened, tipMemoryStore } from './tipMemory';
import styles from './SongView.module.css';

/** Keeps tipMemory up to date while the Song screen shows: a loop opened, the repeat switched off. */
function useTipMemory(): void {
  useEffect(() => {
    const offEditor = editorStore.subscribe((e) => {
      if (e) noteLoopOpened(session.store.getState().id);
    });
    if (editorStore.getState()) noteLoopOpened(session.store.getState().id);
    const offRepeat = runtimeStore.subscribe((s, prev) => {
      if (prev.songLoop && !s.songLoop) noteHeardWhole(session.store.getState().id);
    });
    return () => {
      offEditor();
      offRepeat();
    };
  }, []);
}

export function SongTipLine() {
  const on = useUi((s) => s.tipsEnabled);
  useTipMemory();
  const editorOpen = useStore(editorStore, (e) => e !== null);
  const projectId = useProject((p) => p.id);
  const memory = useStore(tipMemoryStore, (m) => m);
  // A ready-made song (Jump In, a starter) that nobody changed yet, until a loop of it is opened.
  const untouched = useProject(isUntouchedStarter);
  const fresh = untouched && !memory.opened.has(projectId);
  // A ready-made song repeating its main part (Jump In): until the repeat goes off once, say how to hear it whole.
  const loop = useRuntime((s) => s.songLoop);
  const starter = useProject((p) => !!p.starterId && p.starterId !== 'blank');
  const repeating = useProject(useCallback((p: Project) => (loop && starter ? repeatName(p.arrangement.sections, loop, songBars(p)) : null), [loop, starter]));
  const whole = repeating && repeating !== 'the whole song' && !memory.heardWhole.has(projectId) ? repeating : null;
  const loopsOpen = useStore(simpleLoopsStore, (s) => s);
  const soundOpen = useStore(sidePanelStore, (s) => s.kind === 'sound');
  const shown = useStore(shownRowsStore, (s) => s);
  const loops: TipState['loops'] = soundOpen ? 'sound' : loopsOpen ? 'shown' : 'closed';
  const shared = memory.shared.has(projectId);
  const idea = memory.idea;
  const tip = useProject(
    useCallback(
      (p: Project) => songTip(p, { editorOpen, fresh, repeating: whole, loops, shown: shown ?? undefined, shared, idea }),
      [editorOpen, fresh, whole, loops, shown, shared, idea],
    ),
    (a, b) => a.step === b.step && a.text === b.text,
  );
  if (!on)
    return (
      <div className={styles.tipLine} data-testid="song-tip-off" data-off="">
        <Button size="sm" variant="ghost" icon="info" onClick={() => notify(`Next: ${tip.text}.`)} data-testid="what-next" tip="Say one thing to try next. ⋯ › Tips shows the tips all the time.">
          What next?
        </Button>
      </div>
    );
  return (
    <div className={styles.tipLine} data-testid="song-tip" data-step={tip.step}>
      <Icon name="info" size={14} />
      <span className={styles.tipText} role="status">
        <strong>Next:</strong> {tip.text}
      </span>
      {tip.step === 'next' && (
        <Button size="sm" variant="ghost" onClick={nextIdea} data-testid="another-idea" tip="Show another idea of what to do next.">
          Another idea
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => setTipsEnabled(false)} data-testid="hide-tips" tip="Hide the tips. ⋯ › Tips brings them back; What next? still says one.">
        Hide tips
      </Button>
    </div>
  );
}
