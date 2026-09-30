/**
 * Instrument factory: one InstrumentEngine per track, chosen by instrument
 * kind. The engine swaps engines (with a crossfade) when the kind changes.
 */
import type { InstrumentFactory } from '../contracts';
import { DrumKitEngine } from './drumKit';
import { MonoSynthEngine } from './monoSynth';
import { PolySynthEngine } from './polySynth';
import { SamplerEngine } from './sampler';

export const createInstrumentEngine: InstrumentFactory = (ictx, instrument) => {
  switch (instrument.kind) {
    case 'drums':
      return new DrumKitEngine(ictx, instrument);
    case 'bass':
      return new MonoSynthEngine(ictx, instrument);
    case 'poly':
      return new PolySynthEngine(ictx, instrument);
    case 'sampler':
      return new SamplerEngine(ictx, instrument);
    default:
      // Unreachable for validated projects; fail loudly rather than hand the engine `undefined`.
      throw new Error(`Unknown instrument kind "${(instrument as { kind?: unknown }).kind}"`);
  }
};

export { DrumKitEngine } from './drumKit';
export { MonoSynthEngine } from './monoSynth';
export { PolySynthEngine } from './polySynth';
export { SamplerEngine } from './sampler';
export { SampleBank, audioBufferFromChannels } from './sampleBank';
