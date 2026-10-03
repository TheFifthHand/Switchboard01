/**
 * What a part's big knobs move, put back: shared by Simple's "Reset big
 * knobs" and Advanced's "Reset mappings".
 */
import { moduleId as mid } from '../../../project/factory';
import { findModule, trackChain } from '../../../project/graph';
import { MACRO_IDS, type Id } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { session } from '../../instance';
import { MACRO_SPECS } from '../../macros';
import { notify } from '../../runtime';
import { bigKnobReach, offSentence } from './bigKnobReach';
import { possessive } from './shared';

const joinAnd = (xs: readonly string[]) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * Reset big knobs: give a part's big knobs back what its sound designs them
 * to move (resetMacroMap, which skips modules no longer in the patch) and,
 * when its LFO lost its only cable with a removed filter, cable the LFO to
 * the part's filter again, so Motion moves it. One undo step. Positions stay.
 */
export function resetBigKnobs(trackId: Id): void {
  const store = session.store;
  const before = store.getState();
  const t0 = before.tracks.find((t) => t.id === trackId);
  if (!t0) return;
  if (store.getLock() !== null) {
    session.accepted(cmd.resetMacroMap(store, trackId));
    return;
  }
  store.beginGroup('Reset big knobs');
  try {
    cmd.resetMacroMap(store, trackId);
    const p = store.getState();
    const lfo = mid.lfo(trackId);
    const lfoMod = findModule(p.patch, lfo);
    if (lfoMod?.type === 'lfo' && !p.patch.connections.some((c) => c.from.module === lfo)) {
      const own = findModule(p.patch, mid.filter(trackId))?.type === 'filter' ? mid.filter(trackId) : null;
      const filter = own ?? (trackChain(p.patch, trackId) ?? []).find((id) => findModule(p.patch, id)?.type === 'filter') ?? null;
      if (filter) cmd.connect(store, { module: lfo, port: 'out' }, { module: filter, port: 'cutoff' }, 1);
    }
  } finally {
    store.endGroup();
  }
  const after = store.getState();
  const reach = MACRO_IDS.map((m) => ({ label: MACRO_SPECS[m].label, r: bigKnobReach(after, trackId, m) }));
  const still = reach.filter((x) => x.r.reach === 'none').map((x) => x.label);
  const waiting = reach.filter((x) => x.r.reach === 'off');
  const stillText =
    (still.length ? ` ${joinAnd(still)} still ${still.length > 1 ? 'move' : 'moves'} nothing: the effect ${still.length > 1 ? 'they move is' : 'it moves is'} not in this part (Add effect puts one back).` : '') +
    waiting.map((x) => ` ${offSentence(x.r.off, x.label)}`).join('');
  if (after === before) notify(`${possessive(t0.name)} big knobs already move what its sound is designed to move.${stillText}`, 'info');
  else notify(`${possessive(t0.name)} big knobs move what its sound is designed to move again.${stillText}`, 'info', 'undo');
}
