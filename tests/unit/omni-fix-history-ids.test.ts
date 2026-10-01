/**
 * Every undo step has an id of its own, so a message about an edit ("Moved
 * clip" [Undo]) can tell whether its edit is still the newest step: the id is
 * kept while a knob drag or a Record Notes pass adds to the step, follows the
 * step to the redo side and back, and is never given to another step.
 */
import { describe, expect, it } from 'vitest';
import { notify, runtimeStore, setNoticeHistory } from '../../src/app/runtime';
import { createProject } from '../../src/project/factory';
import * as cmd from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';

const fresh = () => new ProjectStore(createProject({ name: 'ids', now: 1 }));

describe('History entry ids', () => {
  it('a new step gets a new id; a gesture or a group adding to it keeps the id', () => {
    const store = fresh();
    expect(store.undoEntryId()).toBeNull();
    cmd.setBpm(store, 130);
    const a = store.undoEntryId()!;
    cmd.setBpm(store, 131, 'drag');
    const b = store.undoEntryId()!;
    expect(b).not.toBe(a);
    cmd.setBpm(store, 132, 'drag');
    cmd.setBpm(store, 133, 'drag');
    expect(store.undoEntryId()).toBe(b);
    expect(store.historySize().undo).toBe(2);
    store.beginGroup('Record notes');
    cmd.setSwing(store, 0.2);
    const g = store.undoEntryId()!;
    cmd.setBpm(store, 140, 'other');
    expect(store.undoEntryId()).toBe(g);
    store.endGroup();
    expect(new Set([a, b, g]).size).toBe(3);
  });

  it('undo moves the step’s id to the redo side, redo brings it back; a new edit clears redo', () => {
    const store = fresh();
    cmd.setBpm(store, 130);
    const a = store.undoEntryId()!;
    cmd.setSwing(store, 0.3);
    const b = store.undoEntryId()!;
    store.undo();
    expect(store.undoEntryId()).toBe(a);
    expect(store.redoEntryId()).toBe(b);
    expect(store.info.getState()).toMatchObject({ undoId: a, redoId: b });
    store.redo();
    expect(store.undoEntryId()).toBe(b);
    expect(store.redoEntryId()).toBeNull();
    store.undo();
    cmd.setBpm(store, 125);
    const c = store.undoEntryId()!;
    expect(store.redoEntryId()).toBeNull();
    expect([a, b]).not.toContain(c);
  });

  it('ids are never reused, also across stores and project switches', () => {
    const one = fresh();
    const two = fresh();
    cmd.setBpm(one, 130);
    cmd.setBpm(two, 130);
    expect(one.undoEntryId()).not.toBe(two.undoEntryId());
    const before = one.undoEntryId()!;
    one.replace(createProject({ name: 'next', now: 2 }), { resetHistory: false, label: 'project:Load starter' });
    expect(one.undoEntryId()).toBeGreaterThan(before);
    one.replace(createProject({ name: 'other', now: 3 }));
    expect(one.info.getState()).toMatchObject({ undoId: null, redoId: null });
  });
});

describe('A notice with Undo', () => {
  it('names the step that was newest when it was made, or the one it is given', () => {
    const store = fresh();
    setNoticeHistory((action) => (action === 'undo' ? store.undoEntryId() : store.redoEntryId()));
    try {
      cmd.setBpm(store, 130);
      notify('Changed the tempo.', 'info', 'undo');
      expect(runtimeStore.getState().notice).toMatchObject({ text: 'Changed the tempo.', action: 'undo', entry: store.undoEntryId() });
      notify('Undid: Change tempo', 'info', 'redo', 42);
      expect(runtimeStore.getState().notice).toMatchObject({ action: 'redo', entry: 42 });
      // Nothing to undo: no Undo button.
      store.clearHistory();
      notify('Nothing to take back.', 'info', 'undo');
      expect(runtimeStore.getState().notice?.action).toBeUndefined();
      // A plain message has neither.
      notify('Hello.');
      expect(runtimeStore.getState().notice).not.toHaveProperty('entry');
    } finally {
      setNoticeHistory(null);
    }
  });
});
