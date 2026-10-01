/** Display helpers shared by views. */
import { builtinSampleInfo, kitInfo, presetInfo } from '../content/catalog';
import type { Instrument, Project, TrackRole } from '../project/types';

export function soundName(project: Project, inst: Instrument): string {
  switch (inst.kind) {
    case 'drums':
      return kitInfo(inst.kitId)?.name ?? 'Drum kit';
    case 'bass':
    case 'poly':
      return presetInfo(inst.presetId)?.name ?? 'Synth';
    case 'sampler':
      if (!inst.sampleId) return 'No recording';
      return builtinSampleInfo(inst.sampleId)?.name ?? project.samples.find((s) => s.id === inst.sampleId)?.name ?? 'Recording';
  }
}

export const INSTRUMENT_LABEL: Record<Instrument['kind'], string> = {
  drums: 'Drum kit',
  bass: 'Bass synth',
  poly: 'Synth',
  sampler: 'Sampler',
};

/** Short role glyphs for column headers. */
export const ROLE_SHORT: Record<TrackRole, string> = {
  drums: 'DRM',
  percussion: 'PRC',
  bass: 'BAS',
  chords: 'CHD',
  lead: 'LED',
  pad: 'PAD',
  texture: 'TEX',
  sampler: 'SMP',
};

export function barsLabel(bars: number): string {
  return bars === 1 ? '1 bar' : `${bars} bars`;
}
