/**
 * Test and diagnostics hooks on window.__switchboard. They expose read-only
 * views of the running app plus helpers that drive it the same way the UI
 * does. No network or storage side effects of their own.
 */
import { session } from './instance';
import { runtimeStore } from './runtime';
import { uiStore } from '../state/uiStore';
import type { MeterFrame } from '../audio/contracts';
import * as analysis from '../render/analysis';

export function installTestHooks(): void {
  const frame: MeterFrame = { masterPeakL: 0, masterPeakR: 0, masterRms: 0, limiterReductionDb: 0, tracks: [] };
  window.__switchboard = {
    session,
    runtime: runtimeStore,
    ui: uiStore,
    analysis,
    project: () => session.store.getState(),
    stats: () => session.stats(),
    meters: () => {
      session.readMeters(frame);
      return { ...frame, tracks: frame.tracks.map((t) => ({ ...t })) };
    },
    audioState: () => session.ctx?.state ?? 'none',
    position: () => session.transport?.getPosition() ?? null,
  };
}
