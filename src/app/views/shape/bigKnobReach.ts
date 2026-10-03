/**
 * What a big knob reaches, in the words the Shape view uses: heard; waiting
 * for an effect that is switched off (turning it on makes the big knob heard
 * again, so the big knob can still be set); or moving nothing (what it moved
 * is gone or not heard). Built on the model's macroReach.
 *
 * Pure (no React, no audio): unit-tested in tests/unit/r4-shape-logic.test.ts.
 */
import { findModule } from '../../../project/graph';
import type { Id, MacroId, Project } from '../../../project/types';
import { macroReach } from '../../../state/commands';
import { moduleName } from './paramState';

export interface BigKnobReach {
  reach: 'audible' | 'off' | 'none';
  /** 'off': the switched-off effects that would make it heard ("Drive", "Reverb"). */
  off: string[];
}

const HEARD: BigKnobReach = { reach: 'audible', off: [] };
const NONE: BigKnobReach = { reach: 'none', off: [] };

/** Whether a part's big knob is heard, waits for a switched-off effect, or moves nothing. */
export function bigKnobReach(p: Project, trackId: Id, macro: MacroId): BigKnobReach {
  if (macroReach(p, trackId, macro) === 'audible') return HEARD;
  const targets = p.tracks.find((t) => t.id === trackId)?.macroMap[macro] ?? [];
  // The switched-off modules it depends on: its targets, where an LFO target's cables go, where a send goes.
  const off = new Set<Id>();
  const consider = (id: Id) => {
    if (findModule(p.patch, id)?.bypass) off.add(id);
  };
  for (const x of targets) {
    const m = findModule(p.patch, x.module);
    if (!m) continue;
    consider(m.id);
    if (m.type === 'lfo') for (const c of p.patch.connections) if (c.from.module === m.id) consider(c.to.module);
    if (m.type === 'channel' && (x.param === 'sendA' || x.param === 'sendB')) for (const c of p.patch.connections) if (c.from.module === m.id && c.from.port === x.param) consider(c.to.module);
  }
  if (!off.size) return NONE;
  const on: Project = { ...p, patch: { ...p.patch, modules: p.patch.modules.map((m) => (off.has(m.id) ? { ...m, bypass: false } : m)) } };
  if (macroReach(on, trackId, macro) !== 'audible') return NONE;
  const names = [...off].map((id) => moduleName(p, findModule(p.patch, id), trackId).replace(/ \(shared\)$/, ''));
  return { reach: 'off', off: [...new Set(names)] };
}

const joinAnd = (xs: readonly string[]) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** "Drive is off", "Drive and Filter are off" (a big knob's caption). */
export function offCaption(off: readonly string[]): string {
  return `${joinAnd(off)} ${off.length > 1 ? 'are' : 'is'} off`;
}

/** "Drive is switched off: turn it on to hear what Drive moves." */
export function offSentence(off: readonly string[], bigKnob: string): string {
  return `${joinAnd(off)} ${off.length > 1 ? 'are' : 'is'} switched off: turn ${off.length > 1 ? 'them' : 'it'} on to hear what ${bigKnob} moves.`;
}
