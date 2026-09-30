/**
 * ProjectStore: the single owner of the current Project.
 *
 * Every edit is a named recipe run through immer's produceWithPatches; the
 * undo history stores forward and inverse patches, never whole copies.
 * Consecutive edits that carry the same gesture id (one knob drag) merge into
 * one history entry. `updatedAt` is stamped outside the recorded patches, so
 * undo/redo count as fresh edits for autosave instead of rewinding the clock.
 *
 * The edit lock refuses routing edits (labels starting with "patch:") while a
 * performance take is recording, including undo/redo of such edits.
 */
import { applyPatches, enablePatches, freeze, produce, produceWithPatches, type Draft, type Patch as ImmerPatch } from 'immer';
import type { Project } from '../project/types';
import { createStore, type Listener, type ReadableStore, type Store } from './store';

enablePatches();

export const HISTORY_LIMIT = 200;
/** Labels with this prefix are routing edits, refused while the edit lock is set. */
export const PATCH_LABEL_PREFIX = 'patch:';

export interface ApplyOptions {
  /** Edits with the same gesture id, applied consecutively, form one undo step. */
  gesture?: string;
  /** Change the project without recording an undo step (and clear redo). */
  skipHistory?: boolean;
}

export interface ApplyResult {
  changed: boolean;
  /** Set when the edit lock refused the edit: the lock reason. */
  refused?: string;
}

export interface HistoryEntry {
  label: string;
  gesture?: string;
  patches: ImmerPatch[];
  inverse: ImmerPatch[];
}

export interface HistoryInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  lock: string | null;
}

export type Recipe = (draft: Project) => void;

/** "patch:Connect cable" -> "Connect cable". Labels without an area prefix are returned unchanged. */
export function displayLabel(label: string): string {
  const m = /^[a-z]+:(.*)$/.exec(label);
  return m ? m[1] : label;
}

function isPatchLabel(label: string): boolean {
  return label.startsWith(PATCH_LABEL_PREFIX);
}

export class ProjectStore implements ReadableStore<Project> {
  private readonly store: Store<Project>;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  /** Gesture of the most recent recorded apply; cleared by anything that ends the gesture. */
  private openGesture: string | null = null;
  private lock: string | null = null;
  private readonly now: () => number;
  private readonly limit: number;
  /** History and lock state, for undo buttons and lock banners. */
  readonly info: Store<HistoryInfo>;

  constructor(project: Project, opts: { now?: () => number; historyLimit?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.limit = opts.historyLimit ?? HISTORY_LIMIT;
    this.store = createStore(freeze(project, true));
    this.info = createStore<HistoryInfo>(this.computeInfo());
  }

  getState = (): Project => this.store.getState();

  subscribe = (listener: Listener<Project>): (() => void) => this.store.subscribe(listener);

  /**
   * Run a named edit. Returns {changed:false} when the recipe changed nothing,
   * or {changed:false, refused} when the edit lock blocks it.
   */
  apply(label: string, recipe: Recipe, opts: ApplyOptions = {}): ApplyResult {
    if (this.lock !== null && isPatchLabel(label)) return { changed: false, refused: this.lock };
    const base = this.store.getState();
    const [next, patches, inverse] = produceWithPatches(base, recipe as (d: Draft<Project>) => void);
    if (patches.length === 0) return { changed: false };

    if (opts.skipHistory) {
      // Redo entries were recorded against the pre-change state; they would no longer apply cleanly.
      this.redoStack = [];
    } else {
      const top = this.undoStack[this.undoStack.length - 1];
      if (opts.gesture !== undefined && top && top.gesture === opts.gesture && this.openGesture === opts.gesture) {
        top.patches.push(...patches);
        // Inverses run newest-first.
        top.inverse = [...inverse, ...top.inverse];
      } else {
        this.undoStack.push({ label, gesture: opts.gesture, patches, inverse });
        if (this.undoStack.length > this.limit) this.undoStack.splice(0, this.undoStack.length - this.limit);
      }
      this.openGesture = opts.gesture ?? null;
      this.redoStack = [];
    }
    this.commit(next);
    return { changed: true };
  }

  /** Close the current gesture so the next edit with the same id starts a new undo step. */
  endGesture(): void {
    this.openGesture = null;
  }

  canUndo(): boolean {
    const top = this.undoStack[this.undoStack.length - 1];
    return !!top && !(this.lock !== null && isPatchLabel(top.label));
  }

  canRedo(): boolean {
    const top = this.redoStack[this.redoStack.length - 1];
    return !!top && !(this.lock !== null && isPatchLabel(top.label));
  }

  /** Display text of the edit Undo would revert ("Connect cable"), or null. */
  undoLabel(): string | null {
    const top = this.undoStack[this.undoStack.length - 1];
    return top ? displayLabel(top.label) : null;
  }

  redoLabel(): string | null {
    const top = this.redoStack[this.redoStack.length - 1];
    return top ? displayLabel(top.label) : null;
  }

  undo(): ApplyResult {
    const entry = this.undoStack[this.undoStack.length - 1];
    if (!entry) return { changed: false };
    if (this.lock !== null && isPatchLabel(entry.label)) return { changed: false, refused: this.lock };
    this.undoStack.pop();
    this.redoStack.push(entry);
    this.openGesture = null;
    this.commit(applyPatches(this.store.getState(), entry.inverse));
    return { changed: true };
  }

  redo(): ApplyResult {
    const entry = this.redoStack[this.redoStack.length - 1];
    if (!entry) return { changed: false };
    if (this.lock !== null && isPatchLabel(entry.label)) return { changed: false, refused: this.lock };
    this.redoStack.pop();
    this.undoStack.push(entry);
    this.openGesture = null;
    this.commit(applyPatches(this.store.getState(), entry.patches));
    return { changed: true };
  }

  /**
   * Swap in another project (open, import, load starter). By default the
   * history is cleared. With resetHistory:false the swap itself becomes one
   * undoable step.
   */
  replace(project: Project, opts: { resetHistory?: boolean; label?: string } = {}): void {
    const next = freeze(project, true);
    const prev = this.store.getState();
    this.openGesture = null;
    if (opts.resetHistory === false) {
      this.undoStack.push({
        label: opts.label ?? 'project:Replace project',
        patches: [{ op: 'replace', path: [], value: next }],
        inverse: [{ op: 'replace', path: [], value: prev }],
      });
      if (this.undoStack.length > this.limit) this.undoStack.splice(0, this.undoStack.length - this.limit);
      this.redoStack = [];
    } else {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.store.setState(next);
    this.info.setState(this.computeInfo());
  }

  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.openGesture = null;
    this.info.setState(this.computeInfo());
  }

  /** Lock routing edits (reason shown to the user), or unlock with null. */
  setLock(reason: string | null): void {
    this.lock = reason;
    this.info.setState(this.computeInfo());
  }

  getLock(): string | null {
    return this.lock;
  }

  historySize(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  private commit(next: Project): void {
    const stamped = produce(next, (d) => {
      d.updatedAt = this.now();
    });
    this.store.setState(stamped);
    this.info.setState(this.computeInfo());
  }

  private computeInfo(): HistoryInfo {
    const next: HistoryInfo = { canUndo: this.canUndo(), canRedo: this.canRedo(), undoLabel: this.undoLabel(), redoLabel: this.redoLabel(), lock: this.lock };
    const cur = this.info?.getState();
    // Keep the same object when nothing changed so subscribers are not woken.
    if (cur && cur.canUndo === next.canUndo && cur.canRedo === next.canRedo && cur.undoLabel === next.undoLabel && cur.redoLabel === next.redoLabel && cur.lock === next.lock) return cur;
    return next;
  }
}
