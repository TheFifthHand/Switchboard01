/**
 * Views may name an undo step in their own words: the Mix view calls a part's
 * Space knob "Drums reverb" and a return's Mix "Reverb return level".
 */
import { describe, expect, it } from 'vitest';
import { ProjectStore } from '../../src/state/projectStore';
import { setBypass, setMacro, setModuleParam } from '../../src/state/commands';
import { STARTERS } from '../../src/content/starters';

function house() {
  return new ProjectStore(STARTERS[0].build());
}

describe('display words for undo steps', () => {
  it('setMacro, setModuleParam and setBypass take the caller’s words; without them the defaults stay', () => {
    const store = house();
    const p = store.getState();
    const t = p.tracks[0];
    setMacro(store, t.id, 'space', 0.7, undefined, { display: `${t.name} reverb` });
    expect(store.info.getState().undoLabel).toBe(`${t.name} reverb`);
    setMacro(store, t.id, 'space', 0.2);
    expect(store.info.getState().undoLabel).toBe('Change Space');
    const fx = p.patch.modules.find((m) => m.type === 'reverb' || m.type === 'delay')!;
    setModuleParam(store, fx.id, 'mix', 0.5, undefined, { display: 'Reverb return level' });
    expect(store.info.getState().undoLabel).toBe('Reverb return level');
    setBypass(store, fx.id, true, { display: 'Mute Reverb return' });
    expect(store.info.getState().undoLabel).toBe('Mute Reverb return');
    setBypass(store, fx.id, false);
    expect(store.info.getState().undoLabel).toBe('Turn effect back on');
  });
});
