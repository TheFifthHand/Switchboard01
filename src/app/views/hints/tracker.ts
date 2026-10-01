/**
 * Watches the real state for the actions the "Try this" hints suggest and
 * reports each one once it happens. No DOM and no timers: it only compares
 * successive states of the project, its undo history and the runtime.
 *
 *  pad         the bass part gets a clip launch queued (a pad or scene tap)
 *  mute        the drums part is muted, then unmuted again
 *  drag        a clip is moved, swapped or copied onto another pad
 *  tone        a part's Tone macro changes
 *  instrument  a part's instrument or sound changes
 *  master      the mastering preset or settings change
 *  record      a performance take is recorded and stopped
 *
 * Switching to another project (a starter, Open, Import) only re-reads the
 * starting point; it never counts as doing anything.
 */
import type { Instrument, Project } from '../../../project/types';
import type { HistoryInfo } from '../../../state/projectStore';
import type { ReadableStore } from '../../../state/store';
import type { RuntimeState } from '../../runtime';
import type { HintId } from './hintsState';
import { bassPart, drumsPart } from './steps';

export interface HintSources {
  project: ReadableStore<Project>;
  history: ReadableStore<HistoryInfo>;
  runtime: ReadableStore<RuntimeState>;
}

/** Undo labels of the clip drag-and-drop edits. */
const CLIP_DROP_LABELS: ReadonlySet<string> = new Set(['Move clip', 'Swap clips', 'Copy clip']);

function soundKey(i: Instrument): string {
  switch (i.kind) {
    case 'drums':
      return `drums:${i.kitId}`;
    case 'sampler':
      return `sampler:${i.sampleId ?? ''}`;
    default:
      return `${i.kind}:${i.presetId}`;
  }
}

function sameParams(a: Record<string, number>, b: Record<string, number>): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

/** Subscribe to the sources; `onDone` is called (possibly more than once) for each action seen. Returns the unsubscribe. */
export function watchHints(src: HintSources, onDone: (id: HintId) => void): () => void {
  // The drums part was seen muted (Mute pressed once); unmuting it then completes the step.
  let sawMuted = drumsPart(src.project.getState())?.mute ?? false;

  const offProject = src.project.subscribe((p, prev) => {
    if (p.id !== prev.id) {
      sawMuted = drumsPart(p)?.mute ?? false;
      return;
    }
    const drums = drumsPart(p);
    if (drums) {
      if (drums.mute) sawMuted = true;
      else if (sawMuted && prev.tracks.find((t) => t.id === drums.id)?.mute) onDone('mute');
    }
    if (p.tracks !== prev.tracks) {
      for (const t of p.tracks) {
        const before = prev.tracks.find((x) => x.id === t.id);
        if (!before || before === t) continue;
        const newSound = before.instrument !== t.instrument && soundKey(before.instrument) !== soundKey(t.instrument);
        if (newSound) onDone('instrument');
        // A new sound may bring its own macro settings: that is not turning Tone.
        else if (before.macros.tone !== t.macros.tone) onDone('tone');
      }
    }
    if (p.mastering !== prev.mastering && (p.mastering.presetId !== prev.mastering.presetId || !sameParams(p.mastering.params, prev.mastering.params))) {
      onDone('master');
    }
  });

  const offHistory = src.history.subscribe((h, prev) => {
    if (h !== prev && h.undoLabel !== null && CLIP_DROP_LABELS.has(h.undoLabel)) onDone('drag');
  });

  const offRuntime = src.runtime.subscribe((r, prev) => {
    const bass = bassPart(src.project.getState());
    if (bass) {
      const now = r.tracks[bass.id]?.queued ?? null;
      const before = prev.tracks[bass.id]?.queued ?? null;
      if (now && now.slot !== null && (!before || before.slot !== now.slot || before.atTick !== now.atTick)) onDone('pad');
    }
    if (prev.recording === 'performance' && r.recording !== 'performance') onDone('record');
  });

  return () => {
    offProject();
    offHistory();
    offRuntime();
  };
}
