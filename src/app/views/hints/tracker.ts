/**
 * Watches the real state for the actions the "Try this" hints suggest and
 * reports each one once it happens. No DOM and no timers: it hands every
 * change of the project, its undo history, the runtime, the view and the
 * finished exports to each step's own `detect` (steps.ts keeps a step's
 * words and its detection together).
 *
 * Switching to another project (a starter, Open, Import) only re-reads the
 * starting point; it never counts as doing anything.
 */
import type { Project } from '../../../project/types';
import type { HistoryInfo } from '../../../state/projectStore';
import type { ReadableStore } from '../../../state/store';
import type { View } from '../../../state/uiStore';
import type { RuntimeState } from '../../runtime';
import type { HintId } from './hintsState';
import { HINT_STEPS, type HintChange, type HintMemo } from './steps';

export interface HintSources {
  project: ReadableStore<Project>;
  history: ReadableStore<HistoryInfo>;
  runtime: ReadableStore<RuntimeState>;
  /** The open view (the song steps are about the Song view). Absent: Play. */
  view?: ReadableStore<View>;
  /** How many exports have finished (a WAV was made); each new one is a change. Absent: none. */
  exports?: ReadableStore<number>;
}

/** Subscribe to the sources; `onDone` is called (possibly more than once) for each action seen. Returns the unsubscribe. */
export function watchHints(src: HintSources, onDone: (id: HintId) => void): () => void {
  let memos = new Map<HintId, HintMemo>();
  const remember = (p: Project) => {
    memos = new Map(HINT_STEPS.map((s) => [s.id, s.init ? s.init(p) : {}]));
  };
  remember(src.project.getState());

  // The last state seen of every source, so each change is compared with what came before it.
  let project = src.project.getState();
  let history = src.history.getState();
  let runtime = src.runtime.getState();
  let view: View = src.view?.getState() ?? 'play';

  const handle = (c: HintChange) => {
    for (const step of HINT_STEPS) {
      let memo = memos.get(step.id);
      if (!memo) memos.set(step.id, (memo = {}));
      if (step.detect(c, memo)) onDone(step.id);
    }
  };
  const base = () => ({ project, prevProject: project, history, prevHistory: history, runtime, prevRuntime: runtime, view, prevView: view });

  const offs: (() => void)[] = [];
  offs.push(
    src.project.subscribe((p, prev) => {
      project = p;
      if (p.id !== prev.id) {
        remember(p);
        return;
      }
      handle({ ...base(), source: 'project', project: p, prevProject: prev });
    }),
  );
  offs.push(
    src.history.subscribe((h, prev) => {
      history = h;
      handle({ ...base(), source: 'history', history: h, prevHistory: prev });
    }),
  );
  offs.push(
    src.runtime.subscribe((r, prev) => {
      runtime = r;
      handle({ ...base(), source: 'runtime', runtime: r, prevRuntime: prev });
    }),
  );
  if (src.view) {
    offs.push(
      src.view.subscribe((v, prev) => {
        if (v === prev) return;
        view = v;
        handle({ ...base(), source: 'view', view: v, prevView: prev });
      }),
    );
  }
  if (src.exports) {
    offs.push(
      src.exports.subscribe((n, prev) => {
        if (n > prev) handle({ ...base(), source: 'export' });
      }),
    );
  }
  return () => {
    for (const off of offs) off();
  };
}
