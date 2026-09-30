/**
 * Patch module catalogue: which ports each module type exposes.
 *
 * Audio ports carry sound. Modulation ports carry a bipolar control signal
 * (-1..1) that is scaled by the connection amount and the target port's
 * range. Only the explicitly listed modulation inputs exist; nothing else can
 * be modulated.
 */
import type { ModuleType, PortKind } from './types';

export interface PortDef {
  id: string;
  kind: PortKind;
  direction: 'in' | 'out';
  label: string;
  /** Plain-language explanation shown in the cable panel. */
  tip: string;
  /**
   * Modulation inputs only: what a full-scale (+1) signal does to the
   * target. `unit` 'cents' means the signal is added to a detune/frequency
   * parameter in cents; 'param' means it is added in the target param's own
   * units; 'gain' means amplitude (1 = +/-100%).
   */
  modRange?: { amount: number; unit: 'cents' | 'param' | 'gain' | 'pan' };
}

export interface ModuleDef {
  type: ModuleType;
  label: string;
  /** Short label for sockets (<= 6 chars). */
  short: string;
  family: 'source' | 'mixer' | 'effect' | 'modulation' | 'output';
  description: string;
  ports: readonly PortDef[];
  /** Effects that can be inserted from the effects rack. */
  insertable: boolean;
  /** Protected modules cannot be removed. */
  protected: boolean;
}

const audioIn = (label = 'In', tip = 'Sound goes in here.'): PortDef => ({ id: 'in', kind: 'audio', direction: 'in', label, tip });
const audioOut = (label = 'Out', tip = 'Processed sound comes out here.'): PortDef => ({ id: 'out', kind: 'audio', direction: 'out', label, tip });

export const MODULE_DEFS: Record<ModuleType, ModuleDef> = {
  instrument: {
    type: 'instrument',
    label: 'Instrument',
    short: 'INST',
    family: 'source',
    description: 'The sound source of this part.',
    insertable: false,
    protected: true,
    ports: [
      audioOut('Out', 'The raw sound of this instrument.'),
      { id: 'pitch', kind: 'mod', direction: 'in', label: 'Pitch', tip: 'Movement here bends the pitch (vibrato).', modRange: { amount: 200, unit: 'cents' } },
      { id: 'cutoff', kind: 'mod', direction: 'in', label: 'Cutoff', tip: 'Movement here sweeps the synth filter.', modRange: { amount: 3600, unit: 'cents' } },
    ],
  },
  channel: {
    type: 'channel',
    label: 'Channel',
    short: 'CHAN',
    family: 'mixer',
    description: 'Level, pan, sends and pump for this part.',
    insertable: false,
    protected: true,
    ports: [
      audioIn('In', 'Mixer input for this part.'),
      audioOut('Out', 'Goes to the master output.'),
      { id: 'sendA', kind: 'audio', direction: 'out', label: 'Send A', tip: 'A copy of the sound for a shared effect (Reverb by default).' },
      { id: 'sendB', kind: 'audio', direction: 'out', label: 'Send B', tip: 'A copy of the sound for a shared effect (Delay by default).' },
      { id: 'level', kind: 'mod', direction: 'in', label: 'Level', tip: 'Movement here makes the volume pulse (tremolo).', modRange: { amount: 1, unit: 'gain' } },
      { id: 'pan', kind: 'mod', direction: 'in', label: 'Pan', tip: 'Movement here swings the sound left and right.', modRange: { amount: 1, unit: 'pan' } },
    ],
  },
  filter: {
    type: 'filter',
    label: 'Filter',
    short: 'FILT',
    family: 'effect',
    description: 'Low-pass / high-pass / band-pass filter with controlled resonance.',
    insertable: true,
    protected: false,
    ports: [audioIn(), audioOut(), { id: 'cutoff', kind: 'mod', direction: 'in', label: 'Cutoff', tip: 'Movement here sweeps the filter.', modRange: { amount: 4800, unit: 'cents' } }],
  },
  drive: {
    type: 'drive',
    label: 'Drive',
    short: 'DRIVE',
    family: 'effect',
    description: 'Saturation and distortion.',
    insertable: true,
    protected: false,
    ports: [audioIn(), audioOut(), { id: 'amount', kind: 'mod', direction: 'in', label: 'Amount', tip: 'Movement here pushes the drive harder and softer.', modRange: { amount: 1, unit: 'param' } }],
  },
  delay: {
    type: 'delay',
    label: 'Delay',
    short: 'DELAY',
    family: 'effect',
    description: 'Tempo-synced echo with bounded feedback.',
    insertable: true,
    protected: false,
    ports: [audioIn(), audioOut(), { id: 'mix', kind: 'mod', direction: 'in', label: 'Mix', tip: 'Movement here fades the echoes in and out.', modRange: { amount: 1, unit: 'param' } }],
  },
  reverb: {
    type: 'reverb',
    label: 'Reverb',
    short: 'VERB',
    family: 'effect',
    description: 'A room or hall around the sound.',
    insertable: true,
    protected: false,
    ports: [audioIn(), audioOut(), { id: 'mix', kind: 'mod', direction: 'in', label: 'Mix', tip: 'Movement here fades the room in and out.', modRange: { amount: 1, unit: 'param' } }],
  },
  chorus: {
    type: 'chorus',
    label: 'Chorus',
    short: 'CHOR',
    family: 'effect',
    description: 'Widening shimmer.',
    insertable: true,
    protected: false,
    ports: [audioIn(), audioOut(), { id: 'mix', kind: 'mod', direction: 'in', label: 'Mix', tip: 'Movement here fades the shimmer in and out.', modRange: { amount: 1, unit: 'param' } }],
  },
  phaser: {
    type: 'phaser',
    label: 'Phaser',
    short: 'PHASE',
    family: 'effect',
    description: 'Sweeping notch filter.',
    insertable: true,
    protected: false,
    ports: [audioIn(), audioOut(), { id: 'mix', kind: 'mod', direction: 'in', label: 'Mix', tip: 'Movement here fades the sweep in and out.', modRange: { amount: 1, unit: 'param' } }],
  },
  crusher: {
    type: 'crusher',
    label: 'Bit Crusher',
    short: 'CRUSH',
    family: 'effect',
    description: 'Bit and sample-rate reduction.',
    insertable: true,
    protected: false,
    ports: [audioIn(), audioOut(), { id: 'mix', kind: 'mod', direction: 'in', label: 'Mix', tip: 'Movement here fades the grit in and out.', modRange: { amount: 1, unit: 'param' } }],
  },
  lfo: {
    type: 'lfo',
    label: 'LFO',
    short: 'LFO',
    family: 'modulation',
    description: 'Tempo-synced movement source.',
    insertable: false,
    protected: false,
    ports: [{ id: 'out', kind: 'mod', direction: 'out', label: 'Mod Out', tip: 'Connect to a modulation input (teal socket) to make it move.' }],
  },
  master: {
    type: 'master',
    label: 'Master Out',
    short: 'MAIN',
    family: 'output',
    description: 'The protected main output with a limiter (ceiling -1 dBFS).',
    insertable: false,
    protected: true,
    ports: [audioIn('In', 'Everything connected here is heard.')],
  },
};

export function portDef(type: ModuleType, portId: string, direction: 'in' | 'out'): PortDef | undefined {
  return MODULE_DEFS[type].ports.find((p) => p.id === portId && p.direction === direction);
}

/** Effect types offered by the effects rack "Add effect" menu. */
export const INSERTABLE_EFFECTS: ModuleType[] = (Object.keys(MODULE_DEFS) as ModuleType[]).filter((t) => MODULE_DEFS[t].insertable);

/** Upper bounds that keep CPU and graph size sensible. */
export const PATCH_LIMITS = {
  maxModules: 72,
  maxConnections: 160,
  /** Insert effects per track (not counting its channel/instrument). */
  maxEffectsPerTrack: 6,
} as const;
