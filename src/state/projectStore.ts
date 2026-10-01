/**
 * ProjectStore: the single owner of the current Project.
 *
 * Every edit is a named recipe run through immer's produceWithPatches; the
 * undo history stores forward and inverse patches, never whole copies.
 * Consecutive edits that carry the same gesture id (one knob drag) merge into
 * one history entry, and while an undo group is open (one Record Notes pass)
 * every recorded edit joins the group's entry. `updatedAt` is stamped outside the recorded patches, so
 * undo/redo count as fresh edits for autosave instead of rewinding the clock.
 *
 * Every history entry has an id that is never reused (gesture and group
 * merges keep it), so a message about an edit ("Moved clip" [Undo]) can tell
 * whether its edit is still the newest step.
 *
 * The edit lock refuses routing edits (labels starting with "patch:") while a
 * performance take is recording, including undo/redo of such edits and of
 * undoable whole-project swaps (which replace the patch as well). A lock can
 * narrow this to an allow-list of labels, and hold back undo/redo steps by the
 * paths they change. `replace()` itself is not locked: stop the take before
 * loading another project.
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
  /**
   * Change the project without recording an undo step. Clears redo, and drops
   * older undo steps whose recorded paths this change invalidates (for example
   * steps that edit notes of an array this change adds to or removes from).
   */
  skipHistory?: boolean;
}

export interface ApplyResult {
  changed: boolean;
  /** Set when the edit lock refused the edit: the lock reason. */
  refused?: string;
}

export interface HistoryEntry {
  /** Unique for the app's lifetime; kept when later edits merge into this step. */
  id: number;
  label: string;
  gesture?: string;
  patches: ImmerPatch[];
  inverse: ImmerPatch[];
  /**
   * The state before this step, kept only while its gesture is still open, so
   * a gesture that ends where it started leaves no step behind.
   */
  base?: Project;
}

export interface HistoryInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** Ids of the steps Undo and Redo would apply (see HistoryEntry.id). */
  undoId: number | null;
  redoId: number | null;
  lock: string | null;
}

export type Recipe = (draft: Project) => void;

/** Shared by every store, so an id never names steps of two different stores. */
let lastEntryId = 0;
const nextEntryId = (): number => ++lastEntryId;

/** "patch:Connect cable" -> "Connect cable". Labels without an area prefix are returned unchanged. */
export function displayLabel(label: string): string {
  const m = /^[a-z]+:(.*)$/.exec(label);
  return m ? m[1] : label;
}

function isPatchLabel(label: string): boolean {
  return label.startsWith(PATCH_LABEL_PREFIX);
}

type PatchPath = ImmerPatch['path'];

/** True when `inner` lies strictly below `outer`. */
function strictlyInside(inner: PatchPath, outer: PatchPath): boolean {
  if (inner.length <= outer.length) return false;
  for (let i = 0; i < outer.length; i++) if (inner[i] !== outer[i]) return false;
  return true;
}

/**
 * Where recorded patches stop being trustworthy after `p` is applied outside
 * the history: adding/removing an item shifts the indices of its siblings (so
 * everything in the container is suspect), and replacing a value swaps
 * everything beneath it.
 */
function unstableRoot(p: ImmerPatch): PatchPath {
  const last = p.path[p.path.length - 1];
  return p.op !== 'replace' || last === 'length' ? p.path.slice(0, -1) : p.path;
}

function valueAt(root: unknown, path: PatchPath): unknown {
  let v = root;
  for (const k of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string | number, unknown>)[k as string | number];
  }
  return v;
}

/** Structural equality for project data (plain objects and arrays). */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameData(x, bb[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  return ka.length === Object.keys(rb).length && ka.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && sameData(ra[k], rb[k]));
}

/**
 * Whether `state` equals `base` everywhere `entry` changed anything: the step
 * has no net effect (a part switched off and on again, a knob dragged back).
 * A change inside an array is checked on the whole array, so an item removed
 * and a different one added at the same index still counts as a change.
 */
function netUnchanged(entry: HistoryEntry, base: Project, state: Project): boolean {
  return entry.patches.every((p) => {
    const parent = p.path.slice(0, -1);
    const at = p.path.length > 1 && (Array.isArray(valueAt(state, parent)) || Array.isArray(valueAt(base, parent))) ? parent : p.path;
    return sameData(valueAt(state, at), valueAt(base, at));
  });
}

function entryTouches(entry: HistoryEntry, roots: readonly PatchPath[]): boolean {
  const hit = (q: ImmerPatch) => roots.some((r) => strictlyInside(q.path, r));
  return entry.patches.some(hit) || entry.inverse.some(hit);
}

/** Undo/redo steps the edit lock holds back: routing edits, and whole-project swaps (they replace the patch too). */
function lockedEntry(entry: HistoryEntry): boolean {
  return isPatchLabel(entry.label) || entry.patches.some((p) => p.path.length === 0);
}

export class ProjectStore implements ReadableStore<Project> {
  private readonly store: Store<Project>;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  /** Gesture of the most recent recorded apply; cleared by anything that ends the gesture. */
  private openGesture: string | null = null;
  /** Open undo group: its label, and its history entry once something was recorded. */
  private group: { label: string; entry: HistoryEntry | null } | null = null;
  private lock: string | null = null;
  /** While locked: which edits are still allowed (default: everything except routing edits). */
  private lockAllows: ((label: string) => boolean) | null = null;
  /** While locked: the paths an undo/redo step may change (default: any path of an allowed step). */
  private lockPaths: ((path: readonly (string | number)[]) => boolean) | null = null;
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
    if (this.lock !== null && !this.allowedWhileLocked(label)) return { changed: false, refused: this.lock };
    const base = this.store.getState();
    // Ignore any return value: immer treats a returned value as a replacement state.
    const [next, patches, inverse] = produceWithPatches(base, (d: Draft<Project>) => {
      recipe(d as Project);
    });
    if (patches.length === 0) return { changed: false };

    if (opts.skipHistory) {
      // Redo entries were recorded against the pre-change state; they would no longer apply cleanly.
      this.redoStack = [];
      // Undo entries are path/index based (immer records "remove notes[5]"). If this
      // unrecorded edit restructured something an entry points into, undoing that
      // entry would change the wrong item: drop it and everything older.
      const roots = patches.map(unstableRoot);
      for (let i = this.undoStack.length - 1; i >= 0; i--) {
        if (!entryTouches(this.undoStack[i], roots)) continue;
        this.undoStack.splice(0, i + 1);
        this.openGesture = null;
        break;
      }
    } else {
      const top = this.undoStack[this.undoStack.length - 1];
      const inGroup = !!this.group && !!top && this.group.entry === top;
      let undone = false;
      if (inGroup || (opts.gesture !== undefined && top && top.gesture === opts.gesture && this.openGesture === opts.gesture)) {
        top.patches.push(...patches);
        // Inverses run newest-first.
        top.inverse = [...inverse, ...top.inverse];
        // A gesture back where it started leaves no undo step (its next edit starts a new one).
        if (!inGroup && top.base && netUnchanged(top, top.base, next)) {
          this.undoStack.pop();
          undone = true;
        }
      } else {
        if (top) delete top.base;
        const entry: HistoryEntry = { id: nextEntryId(), label: this.group?.label ?? label, gesture: opts.gesture, patches, inverse };
        if (opts.gesture !== undefined && !this.group) entry.base = base;
        this.undoStack.push(entry);
        if (this.group) this.group.entry = entry;
        if (this.undoStack.length > this.limit) this.undoStack.splice(0, this.undoStack.length - this.limit);
      }
      // After a gesture cancelled itself out, its next edit starts a fresh step.
      this.openGesture = undone ? null : (opts.gesture ?? null);
      this.redoStack = [];
    }
    this.commit(next);
    return { changed: true };
  }

  /** Close the current gesture so the next edit with the same id starts a new undo step. */
  endGesture(): void {
    this.openGesture = null;
    const top = this.undoStack[this.undoStack.length - 1];
    if (top) delete top.base;
  }

  /**
   * Open an undo group: until endGroup(), every recorded edit, whatever its
   * gesture, joins one undo step labelled `label` (a Record Notes pass with
   * any knob moves made during it). An undo inside the group removes what was
   * recorded so far; later edits start the group's step again.
   */
  beginGroup(label: string): void {
    this.group = { label, entry: null };
    this.openGesture = null;
  }

  endGroup(): void {
    this.group = null;
    this.openGesture = null;
  }

  canUndo(): boolean {
    const top = this.undoStack[this.undoStack.length - 1];
    return !!top && !(this.lock !== null && this.entryLocked(top));
  }

  canRedo(): boolean {
    const top = this.redoStack[this.redoStack.length - 1];
    return !!top && !(this.lock !== null && this.entryLocked(top));
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

  /** Id of the step Undo would revert (the newest edit), or null. */
  undoEntryId(): number | null {
    return this.undoStack[this.undoStack.length - 1]?.id ?? null;
  }

  /** Id of the step Redo would apply again, or null. */
  redoEntryId(): number | null {
    return this.redoStack[this.redoStack.length - 1]?.id ?? null;
  }

  undo(): ApplyResult {
    const entry = this.undoStack[this.undoStack.length - 1];
    if (!entry) return { changed: false };
    if (this.lock !== null && this.entryLocked(entry)) return { changed: false, refused: this.lock };
    this.undoStack.pop();
    this.redoStack.push(entry);
    this.openGesture = null;
    this.commit(applyPatches(this.store.getState(), entry.inverse));
    return { changed: true };
  }

  redo(): ApplyResult {
    const entry = this.redoStack[this.redoStack.length - 1];
    if (!entry) return { changed: false };
    if (this.lock !== null && this.entryLocked(entry)) return { changed: false, refused: this.lock };
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
        id: nextEntryId(),
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

  /**
   * Lock edits (reason shown to the user), or unlock with null. By default only
   * routing edits are refused; `allows` narrows the lock to an allow-list of
   * labels (a performance take allows only the edits it records). `paths`
   * also holds back undo/redo steps that change anything outside those paths
   * (a take can only record value changes, so an undo it could not record
   * waits until the take ends), whatever their label says.
   */
  setLock(reason: string | null, allows?: (label: string) => boolean, paths?: (path: readonly (string | number)[]) => boolean): void {
    this.lock = reason;
    this.lockAllows = reason === null ? null : (allows ?? null);
    this.lockPaths = reason === null ? null : (paths ?? null);
    this.info.setState(this.computeInfo());
  }

  private allowedWhileLocked(label: string): boolean {
    return this.lockAllows ? this.lockAllows(label) : !isPatchLabel(label);
  }

  private entryLocked(entry: HistoryEntry): boolean {
    if (lockedEntry(entry) || !this.allowedWhileLocked(entry.label)) return true;
    const paths = this.lockPaths;
    return !!paths && ![...entry.patches, ...entry.inverse].every((p) => paths(p.path));
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
    const next: HistoryInfo = {
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      undoLabel: this.undoLabel(),
      redoLabel: this.redoLabel(),
      undoId: this.undoEntryId(),
      redoId: this.redoEntryId(),
      lock: this.lock,
    };
    const cur = this.info?.getState();
    // Keep the same object when nothing changed so subscribers are not woken.
    if (cur && (Object.keys(next) as (keyof HistoryInfo)[]).every((k) => cur[k] === next[k])) return cur;
    return next;
  }
}
