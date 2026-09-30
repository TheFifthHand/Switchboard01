/**
 * Parameter registry: the single source of truth for every numeric control.
 *
 * Knobs read label/range/unit/default/tips from here, validation clamps with
 * it, macros map onto it, and the audio engine reads values through
 * `readParam`, which falls back to the default. Enum params store an option
 * index. All values are finite and bounded.
 */
import type { InstrumentKind, ModuleType, ParamValues } from './types';

export type ParamUnit = '' | 'Hz' | 'dB' | 's' | 'ms' | '%' | 'st' | 'ct' | 'x' | 'bpm' | 'bits';
export type ParamCurve = 'lin' | 'exp' | 'enum' | 'int' | 'bool';

export interface ParamSpec {
  id: string;
  label: string;
  /** Up to 5 chars, for tight layouts. */
  short?: string;
  min: number;
  max: number;
  default: number;
  unit: ParamUnit;
  curve: ParamCurve;
  options?: readonly string[];
  /** Plain-language description of the audible result (shown first in Tips). */
  tip: string;
  /** Technical detail (shown second in Tips). */
  detail?: string;
}

const p = (s: ParamSpec): ParamSpec => s;

/* ------------------------------------------------------------------ */
/* Instruments                                                         */
/* ------------------------------------------------------------------ */

export const WAVE_OPTIONS = ['Saw', 'Square', 'Triangle', 'Sine'] as const;

export const BASS_PARAMS: readonly ParamSpec[] = [
  p({ id: 'wave', label: 'Wave', min: 0, max: 3, default: 0, unit: '', curve: 'enum', options: WAVE_OPTIONS, tip: 'Changes the basic character: Saw is buzzy, Square is hollow, Triangle and Sine are round.', detail: 'Main oscillator waveform.' }),
  p({ id: 'octave', label: 'Octave', short: 'OCT', min: -2, max: 2, default: 0, unit: '', curve: 'int', tip: 'Moves the whole bass up or down by octaves.', detail: 'Transposition in octaves, applied to every note.' }),
  p({ id: 'sub', label: 'Sub', min: 0, max: 1, default: 0.4, unit: '%', curve: 'lin', tip: 'Adds weight underneath the note.', detail: 'Square sub-oscillator one octave below.' }),
  p({ id: 'cutoff', label: 'Cutoff', short: 'CUT', min: 40, max: 12000, default: 700, unit: 'Hz', curve: 'exp', tip: 'Opens or closes the filter: lower is darker and rounder.', detail: '24 dB/oct low-pass cutoff frequency.' }),
  p({ id: 'resonance', label: 'Resonance', short: 'RES', min: 0, max: 1, default: 0.25, unit: '%', curve: 'lin', tip: 'Adds a vocal, squelchy peak at the filter edge.', detail: 'Filter Q, limited to a controlled maximum.' }),
  p({ id: 'envAmount', label: 'Env Amount', short: 'ENV', min: 0, max: 1, default: 0.45, unit: '%', curve: 'lin', tip: 'How much each note opens the filter — more gives a plucky "bow".', detail: 'Filter envelope depth, up to +5 octaves.' }),
  p({ id: 'filterDecay', label: 'Filter Decay', short: 'FDEC', min: 0.02, max: 2, default: 0.22, unit: 's', curve: 'exp', tip: 'How quickly the filter closes after each note starts.', detail: 'Filter envelope decay time.' }),
  p({ id: 'attack', label: 'Attack', short: 'ATK', min: 0.001, max: 1, default: 0.003, unit: 's', curve: 'exp', tip: 'Longer attack makes notes fade in instead of starting sharply.', detail: 'Amplitude envelope attack.' }),
  p({ id: 'decay', label: 'Decay', short: 'DEC', min: 0.02, max: 2, default: 0.3, unit: 's', curve: 'exp', tip: 'How quickly the note falls to its held level.', detail: 'Amplitude envelope decay.' }),
  p({ id: 'sustain', label: 'Sustain', short: 'SUS', min: 0, max: 1, default: 0.65, unit: '%', curve: 'lin', tip: 'How loud a held note stays.', detail: 'Amplitude envelope sustain level.' }),
  p({ id: 'release', label: 'Release', short: 'REL', min: 0.01, max: 2, default: 0.08, unit: 's', curve: 'exp', tip: 'How long the note rings after you let go.', detail: 'Amplitude envelope release.' }),
  p({ id: 'glide', label: 'Glide', min: 0, max: 0.5, default: 0.04, unit: 's', curve: 'lin', tip: 'Slides between overlapping notes.', detail: 'Portamento time, applied to legato notes.' }),
  p({ id: 'drive', label: 'Saturation', short: 'SAT', min: 0, max: 1, default: 0.2, unit: '%', curve: 'lin', tip: 'Adds grit and helps the bass cut through small speakers.', detail: 'Post-filter soft saturation with level compensation.' }),
  p({ id: 'velocity', label: 'Velocity', short: 'VEL', min: 0, max: 1, default: 0.5, unit: '%', curve: 'lin', tip: 'How much harder hits get louder and brighter.', detail: 'Velocity sensitivity for amplitude and filter.' }),
  p({ id: 'level', label: 'Level', short: 'LVL', min: -24, max: 6, default: 0, unit: 'dB', curve: 'lin', tip: 'Instrument volume before effects.', detail: 'Output trim for level matching.' }),
];

export const POLY_PARAMS: readonly ParamSpec[] = [
  p({ id: 'osc1Wave', label: 'Osc 1', min: 0, max: 3, default: 0, unit: '', curve: 'enum', options: WAVE_OPTIONS, tip: 'The main tone colour.', detail: 'Oscillator 1 waveform.' }),
  p({ id: 'osc2Wave', label: 'Osc 2', min: 0, max: 3, default: 0, unit: '', curve: 'enum', options: WAVE_OPTIONS, tip: 'A second tone that blends with the first.', detail: 'Oscillator 2 waveform.' }),
  p({ id: 'osc2Semi', label: 'Osc 2 Pitch', short: 'SEMI', min: -24, max: 24, default: 0, unit: 'st', curve: 'int', tip: 'Tunes the second tone — 12 is an octave, 7 a fifth.', detail: 'Oscillator 2 transposition in semitones.' }),
  p({ id: 'detune', label: 'Detune', short: 'DTN', min: 0, max: 40, default: 7, unit: 'ct', curve: 'lin', tip: 'Slightly out-of-tune tones make a wider, shimmering sound.', detail: 'Oscillator 2 detune in cents.' }),
  p({ id: 'osc2Level', label: 'Osc 2 Level', short: 'MIX', min: 0, max: 1, default: 0.5, unit: '%', curve: 'lin', tip: 'Balance of the second tone.', detail: 'Oscillator 2 level.' }),
  p({ id: 'noise', label: 'Noise', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'Adds breath and air.', detail: 'White noise level into the filter.' }),
  p({ id: 'width', label: 'Width', min: 0, max: 1, default: 0.3, unit: '%', curve: 'lin', tip: 'Spreads the sound between left and right.', detail: 'Stereo spread of the two oscillators.' }),
  p({ id: 'cutoff', label: 'Cutoff', short: 'CUT', min: 60, max: 18000, default: 3200, unit: 'Hz', curve: 'exp', tip: 'Brighter or darker: opens or closes the synth filter.', detail: '12 dB/oct low-pass cutoff.' }),
  p({ id: 'resonance', label: 'Resonance', short: 'RES', min: 0, max: 1, default: 0.15, unit: '%', curve: 'lin', tip: 'Emphasises the filter edge for a more resonant tone.', detail: 'Filter Q, limited to a controlled maximum.' }),
  p({ id: 'filterEnv', label: 'Filter Env', short: 'FENV', min: 0, max: 1, default: 0.3, unit: '%', curve: 'lin', tip: 'Makes each note open up brighter at the start.', detail: 'Filter envelope depth, up to +4 octaves.' }),
  p({ id: 'filterDecay', label: 'Filter Decay', short: 'FDEC', min: 0.02, max: 4, default: 0.4, unit: 's', curve: 'exp', tip: 'How long the brightness takes to settle.', detail: 'Filter envelope decay.' }),
  p({ id: 'attack', label: 'Attack', short: 'ATK', min: 0.001, max: 4, default: 0.005, unit: 's', curve: 'exp', tip: 'Longer attack makes chords swell in.', detail: 'Amplitude envelope attack.' }),
  p({ id: 'decay', label: 'Decay', short: 'DEC', min: 0.02, max: 4, default: 0.5, unit: 's', curve: 'exp', tip: 'How quickly notes fall to their held level.', detail: 'Amplitude envelope decay.' }),
  p({ id: 'sustain', label: 'Sustain', short: 'SUS', min: 0, max: 1, default: 0.6, unit: '%', curve: 'lin', tip: 'How loud held notes stay. Zero gives plucks.', detail: 'Amplitude envelope sustain level.' }),
  p({ id: 'release', label: 'Release', short: 'REL', min: 0.01, max: 6, default: 0.35, unit: 's', curve: 'exp', tip: 'How long notes fade after they end.', detail: 'Amplitude envelope release.' }),
  p({ id: 'velocity', label: 'Velocity', short: 'VEL', min: 0, max: 1, default: 0.5, unit: '%', curve: 'lin', tip: 'How much harder hits get louder and brighter.', detail: 'Velocity sensitivity.' }),
  p({ id: 'level', label: 'Level', short: 'LVL', min: -24, max: 6, default: -4, unit: 'dB', curve: 'lin', tip: 'Instrument volume before effects.', detail: 'Output trim for level matching.' }),
];

export const SAMPLER_PARAMS: readonly ParamSpec[] = [
  p({ id: 'start', label: 'Start', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'Where playback begins in the recording.', detail: 'Trim start as a fraction of the file.' }),
  p({ id: 'end', label: 'End', min: 0, max: 1, default: 1, unit: '%', curve: 'lin', tip: 'Where playback stops in the recording.', detail: 'Trim end as a fraction of the file.' }),
  p({ id: 'gain', label: 'Gain', min: -24, max: 12, default: 0, unit: 'dB', curve: 'lin', tip: 'Makes the recording louder or quieter.', detail: 'Sample playback gain.' }),
  p({ id: 'pitch', label: 'Pitch', min: -24, max: 24, default: 0, unit: 'st', curve: 'int', tip: 'Plays the recording higher or lower. Speed changes with it.', detail: 'Playback-rate transposition. Pitch and speed change together in this version.' }),
  p({ id: 'fine', label: 'Fine', min: -100, max: 100, default: 0, unit: 'ct', curve: 'lin', tip: 'Small tuning adjustment.', detail: 'Fine tuning in cents (also changes speed).' }),
  p({ id: 'mode', label: 'Mode', min: 0, max: 1, default: 0, unit: '', curve: 'enum', options: ['One-shot', 'Loop'], tip: 'One-shot plays once per note; Loop repeats while the note is held.', detail: 'Playback mode.' }),
  p({ id: 'fadeIn', label: 'Fade In', short: 'FIN', min: 0, max: 500, default: 3, unit: 'ms', curve: 'lin', tip: 'Softens the start to avoid clicks.', detail: 'Fade-in time at the trim start.' }),
  p({ id: 'fadeOut', label: 'Fade Out', short: 'FOUT', min: 0, max: 2000, default: 15, unit: 'ms', curve: 'lin', tip: 'Softens the end to avoid clicks.', detail: 'Fade-out time at the trim end / note release.' }),
  p({ id: 'sync', label: 'Tempo Sync', short: 'SYNC', min: 0, max: 1, default: 0, unit: '', curve: 'enum', options: ['Off', 'Speed'], tip: 'Speeds the loop up or down to follow the project tempo. Pitch changes with speed.', detail: 'rate = project BPM / original BPM. Not pitch-preserving.' }),
  p({ id: 'originalBpm', label: 'Original BPM', short: 'OBPM', min: 40, max: 220, default: 120, unit: 'bpm', curve: 'lin', tip: 'The tempo the recording was made at.', detail: 'Used by Tempo Sync.' }),
  p({ id: 'rootNote', label: 'Root Note', short: 'ROOT', min: 24, max: 96, default: 60, unit: '', curve: 'int', tip: 'The key that plays the recording at its original pitch.', detail: 'MIDI note number with no transposition.' }),
  p({ id: 'attack', label: 'Attack', short: 'ATK', min: 0.001, max: 2, default: 0.002, unit: 's', curve: 'exp', tip: 'Fades each note in.', detail: 'Amplitude envelope attack.' }),
  p({ id: 'release', label: 'Release', short: 'REL', min: 0.005, max: 4, default: 0.05, unit: 's', curve: 'exp', tip: 'How long notes fade after they end.', detail: 'Amplitude envelope release.' }),
  p({ id: 'cutoff', label: 'Cutoff', short: 'CUT', min: 60, max: 20000, default: 20000, unit: 'Hz', curve: 'exp', tip: 'Darkens the recording.', detail: 'Per-voice 12 dB/oct low-pass.' }),
];

export const DRUM_KIT_PARAMS: readonly ParamSpec[] = [
  p({ id: 'tune', label: 'Tune', min: -12, max: 12, default: 0, unit: 'st', curve: 'lin', tip: 'Raises or lowers the pitch of every drum.', detail: 'Global kit tuning in semitones.' }),
  p({ id: 'decay', label: 'Decay', short: 'DEC', min: 0.25, max: 2, default: 1, unit: 'x', curve: 'exp', tip: 'Shorter drums sound tight; longer ones ring out.', detail: 'Global decay multiplier.' }),
  p({ id: 'cutoff', label: 'Cutoff', short: 'CUT', min: 200, max: 20000, default: 20000, unit: 'Hz', curve: 'exp', tip: 'Softens the whole kit.', detail: 'Kit low-pass filter.' }),
  p({ id: 'velocity', label: 'Velocity', short: 'VEL', min: 0, max: 1, default: 0.6, unit: '%', curve: 'lin', tip: 'How much harder hits get louder.', detail: 'Velocity sensitivity.' }),
  p({ id: 'level', label: 'Level', short: 'LVL', min: -24, max: 6, default: 0, unit: 'dB', curve: 'lin', tip: 'Kit volume before effects.', detail: 'Output trim.' }),
];

export const DRUM_VOICE_PARAM_SPECS = {
  tune: p({ id: 'tune', label: 'Tune', min: -12, max: 12, default: 0, unit: 'st', curve: 'lin', tip: 'Pitch of this drum.' }),
  decay: p({ id: 'decay', label: 'Decay', min: 0.25, max: 2, default: 1, unit: 'x', curve: 'exp', tip: 'Length of this drum.' }),
  level: p({ id: 'level', label: 'Level', min: 0, max: 1.5, default: 1, unit: '', curve: 'lin', tip: 'Volume of this drum.' }),
  pan: p({ id: 'pan', label: 'Pan', min: -1, max: 1, default: 0, unit: '', curve: 'lin', tip: 'Left/right position of this drum.' }),
} as const;

export const INSTRUMENT_PARAMS: Record<InstrumentKind, readonly ParamSpec[]> = {
  drums: DRUM_KIT_PARAMS,
  bass: BASS_PARAMS,
  poly: POLY_PARAMS,
  sampler: SAMPLER_PARAMS,
};

/* ------------------------------------------------------------------ */
/* Patch modules                                                       */
/* ------------------------------------------------------------------ */

export const DELAY_DIVISIONS = ['1/16', '1/8', '1/8 dotted', '1/4', '1/4 dotted', '1/2'] as const;
/** Delay division lengths in beats (quarter notes). */
export const DELAY_DIVISION_BEATS = [0.25, 0.5, 0.75, 1, 1.5, 2] as const;

export const LFO_WAVES = ['Sine', 'Triangle', 'Saw Up', 'Saw Down', 'Square', 'Random'] as const;
export const LFO_DIVISIONS = ['4 bars', '2 bars', '1 bar', '1/2', '1/4', '1/8', '1/16', '1/4 triplet', '1/8 triplet'] as const;
/** LFO cycle lengths in beats (quarter notes). */
export const LFO_DIVISION_BEATS = [16, 8, 4, 2, 1, 0.5, 0.25, 2 / 3, 1 / 3] as const;

export const PUMP_DIVISIONS = ['1/4', '1/2', '1/8'] as const;
export const PUMP_DIVISION_BEATS = [1, 2, 0.5] as const;

export const CHANNEL_PARAMS: readonly ParamSpec[] = [
  p({ id: 'level', label: 'Level', short: 'LVL', min: -60, max: 6, default: 0, unit: 'dB', curve: 'lin', tip: 'How loud this part is in the mix.', detail: 'Channel fader gain.' }),
  p({ id: 'pan', label: 'Pan', min: -1, max: 1, default: 0, unit: '', curve: 'lin', tip: 'Places the part left or right.', detail: 'Equal-power stereo pan.' }),
  p({ id: 'sendA', label: 'Reverb Send', short: 'REV', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'How much of this part goes into the shared room.', detail: 'Post-fader send A (default patch: Reverb).' }),
  p({ id: 'sendB', label: 'Delay Send', short: 'DLY', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'How much of this part goes into the echo.', detail: 'Post-fader send B (default patch: Delay).' }),
  p({ id: 'pump', label: 'Pump', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'Makes the part duck and swell in time with the beat.', detail: 'Tempo-synced ducking envelope on the channel gain. It follows the transport grid; it does not listen to other tracks (no audio sidechain).' }),
  p({ id: 'pumpDiv', label: 'Pump Rate', short: 'PRATE', min: 0, max: 2, default: 0, unit: '', curve: 'enum', options: PUMP_DIVISIONS, tip: 'How often the part ducks.', detail: 'Ducking envelope period.' }),
];

export const FILTER_PARAMS: readonly ParamSpec[] = [
  p({ id: 'mode', label: 'Mode', min: 0, max: 2, default: 0, unit: '', curve: 'enum', options: ['Low-pass', 'High-pass', 'Band-pass'], tip: 'Low-pass removes highs, High-pass removes lows, Band-pass keeps the middle.', detail: 'Biquad filter type.' }),
  p({ id: 'cutoff', label: 'Cutoff', short: 'CUT', min: 20, max: 20000, default: 20000, unit: 'Hz', curve: 'exp', tip: 'Where the filter starts to act.', detail: '12 dB/oct cutoff frequency.' }),
  p({ id: 'resonance', label: 'Resonance', short: 'RES', min: 0, max: 1, default: 0.1, unit: '%', curve: 'lin', tip: 'Adds a peak at the cutoff.', detail: 'Q from 0.5 to 12 (bounded).' }),
  p({ id: 'bright', label: 'Brightness', short: 'BRT', min: -12, max: 12, default: 0, unit: 'dB', curve: 'lin', tip: 'Adds or removes sparkle at the top.', detail: 'High-shelf at 3.5 kHz.' }),
];

export const DRIVE_PARAMS: readonly ParamSpec[] = [
  p({ id: 'amount', label: 'Drive', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'Warms up and then distorts the sound. Zero is clean.', detail: 'Pre-gain into a soft clipper, level-compensated.' }),
  p({ id: 'character', label: 'Character', short: 'CHAR', min: 0, max: 2, default: 0, unit: '', curve: 'enum', options: ['Warm', 'Hard', 'Fold'], tip: 'Warm is tape-like, Hard is crunchy, Fold is metallic.', detail: 'Waveshaper transfer curve.' }),
  p({ id: 'tone', label: 'Tone', min: 0, max: 1, default: 0.7, unit: '%', curve: 'lin', tip: 'Tames or keeps the fizz that drive adds.', detail: 'Post-drive low-pass from 1.5 kHz to 18 kHz.' }),
  p({ id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, unit: '%', curve: 'lin', tip: 'Blend between clean and driven sound.', detail: 'Dry/wet balance.' }),
];

export const DELAY_PARAMS: readonly ParamSpec[] = [
  p({ id: 'division', label: 'Time', min: 0, max: 5, default: 2, unit: '', curve: 'enum', options: DELAY_DIVISIONS, tip: 'Echo timing, locked to the tempo.', detail: 'Tempo-synced delay time.' }),
  p({ id: 'feedback', label: 'Feedback', short: 'FDBK', min: 0, max: 0.85, default: 0.38, unit: '%', curve: 'lin', tip: 'How many times the echo repeats.', detail: 'Internal feedback, bounded below unity.' }),
  p({ id: 'tone', label: 'Tone', min: 500, max: 12000, default: 3800, unit: 'Hz', curve: 'exp', tip: 'Darker echoes sit further back.', detail: 'Low-pass in the feedback path.' }),
  p({ id: 'width', label: 'Width', min: 0, max: 1, default: 0.6, unit: '%', curve: 'lin', tip: 'Bounces echoes between left and right.', detail: 'Ping-pong amount.' }),
  p({ id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, unit: '%', curve: 'lin', tip: 'Echo level. As a send return, leave at 100%.', detail: 'Wet level (dry passes at 1 - mix when used as an insert).' }),
];

export const REVERB_PARAMS: readonly ParamSpec[] = [
  p({ id: 'decay', label: 'Size', min: 0.3, max: 9, default: 2.4, unit: 's', curve: 'exp', tip: 'Small rooms to huge halls.', detail: 'Impulse-response decay time (RT60 approx.).' }),
  p({ id: 'predelay', label: 'Pre-delay', short: 'PRE', min: 0, max: 120, default: 12, unit: 'ms', curve: 'lin', tip: 'A short gap before the room answers keeps sounds clear.', detail: 'Pre-delay before the convolver.' }),
  p({ id: 'tone', label: 'Tone', min: 1000, max: 16000, default: 6500, unit: 'Hz', curve: 'exp', tip: 'Darker rooms feel softer and further away.', detail: 'Low-pass on the reverb output.' }),
  p({ id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, unit: '%', curve: 'lin', tip: 'Room level. As a send return, leave at 100%.', detail: 'Wet level (dry passes at 1 - mix when used as an insert).' }),
];

export const CHORUS_PARAMS: readonly ParamSpec[] = [
  p({ id: 'rate', label: 'Rate', min: 0.05, max: 5, default: 0.5, unit: 'Hz', curve: 'exp', tip: 'Speed of the shimmer.', detail: 'Modulation rate.' }),
  p({ id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.45, unit: '%', curve: 'lin', tip: 'How wide and wobbly the shimmer is.', detail: 'Delay-time modulation depth (up to 6 ms).' }),
  p({ id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.5, unit: '%', curve: 'lin', tip: 'Blend of the chorused sound.', detail: 'Dry/wet.' }),
];

export const PHASER_PARAMS: readonly ParamSpec[] = [
  p({ id: 'rate', label: 'Rate', min: 0.05, max: 5, default: 0.3, unit: 'Hz', curve: 'exp', tip: 'Speed of the sweep.', detail: 'Modulation rate.' }),
  p({ id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.6, unit: '%', curve: 'lin', tip: 'How far the sweep travels.', detail: 'All-pass centre-frequency sweep range.' }),
  p({ id: 'feedback', label: 'Feedback', short: 'FDBK', min: 0, max: 0.8, default: 0.4, unit: '%', curve: 'lin', tip: 'Makes the sweep more pronounced.', detail: 'All-pass chain feedback, bounded.' }),
  p({ id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.5, unit: '%', curve: 'lin', tip: 'Blend of the phased sound.', detail: 'Dry/wet.' }),
];

export const CRUSHER_PARAMS: readonly ParamSpec[] = [
  p({ id: 'bits', label: 'Bits', min: 2, max: 16, default: 16, unit: 'bits', curve: 'lin', tip: 'Fewer bits make the sound gritty and lo-fi.', detail: 'Bit-depth quantisation.' }),
  p({ id: 'downsample', label: 'Downsample', short: 'DOWN', min: 1, max: 32, default: 1, unit: 'x', curve: 'exp', tip: 'Higher values make a crunchy, aliased old-sampler sound.', detail: 'Sample-and-hold factor (sample-rate reduction).' }),
  p({ id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, unit: '%', curve: 'lin', tip: 'Blend of the crushed sound.', detail: 'Dry/wet.' }),
];

export const LFO_PARAMS: readonly ParamSpec[] = [
  p({ id: 'wave', label: 'Shape', min: 0, max: 5, default: 0, unit: '', curve: 'enum', options: LFO_WAVES, tip: 'The shape of the movement.', detail: 'LFO waveform. Random is a seeded step pattern.' }),
  p({ id: 'division', label: 'Rate', min: 0, max: 8, default: 2, unit: '', curve: 'enum', options: LFO_DIVISIONS, tip: 'How often the movement repeats, locked to the tempo.', detail: 'Cycle length, phase-aligned to the transport.' }),
  p({ id: 'depth', label: 'Depth', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'How much movement is sent through the cable.', detail: 'Output amplitude (bipolar).' }),
];

export const MASTER_PARAMS: readonly ParamSpec[] = [];
export const INSTRUMENT_MODULE_PARAMS: readonly ParamSpec[] = [];

export const MODULE_PARAMS: Record<ModuleType, readonly ParamSpec[]> = {
  instrument: INSTRUMENT_MODULE_PARAMS,
  channel: CHANNEL_PARAMS,
  filter: FILTER_PARAMS,
  drive: DRIVE_PARAMS,
  delay: DELAY_PARAMS,
  reverb: REVERB_PARAMS,
  chorus: CHORUS_PARAMS,
  phaser: PHASER_PARAMS,
  crusher: CRUSHER_PARAMS,
  lfo: LFO_PARAMS,
  master: MASTER_PARAMS,
};

export const MASTER_VOLUME_SPEC = p({
  id: 'masterVolume', label: 'Master', min: -60, max: 6, default: -3, unit: 'dB', curve: 'lin',
  tip: 'Overall volume of everything.', detail: 'Master gain before the output limiter (ceiling -1 dBFS).',
});
export const BPM_SPEC = p({ id: 'bpm', label: 'Tempo', min: 40, max: 220, default: 120, unit: 'bpm', curve: 'lin', tip: 'Speed of the music in beats per minute.' });
export const SWING_SPEC = p({ id: 'swing', label: 'Swing', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'Delays every second 16th note for a looser, shuffled groove.', detail: '0% = straight, 100% = triplet shuffle (off-beat 16ths delayed by one third of a step).' });

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function specById(specs: readonly ParamSpec[], id: string): ParamSpec | undefined {
  return specs.find((s) => s.id === id);
}

export function clampParam(spec: ParamSpec, value: number): number {
  if (!Number.isFinite(value)) return spec.default;
  let v = Math.min(spec.max, Math.max(spec.min, value));
  if (spec.curve === 'enum' || spec.curve === 'int' || spec.curve === 'bool') v = Math.round(v);
  return v;
}

/** Read a parameter with registry default fallback and clamping. */
export function readParam(specs: readonly ParamSpec[], values: ParamValues | undefined, id: string): number {
  const spec = specById(specs, id);
  if (!spec) throw new Error(`Unknown parameter "${id}"`);
  const raw = values?.[id];
  return raw === undefined ? spec.default : clampParam(spec, raw);
}

export function defaultParams(specs: readonly ParamSpec[]): ParamValues {
  const out: ParamValues = {};
  for (const s of specs) out[s.id] = s.default;
  return out;
}

/** Normalised 0..1 position of a value on its control (respects exp curves). */
export function toNormalized(spec: ParamSpec, value: number): number {
  const v = clampParam(spec, value);
  if (spec.max === spec.min) return 0;
  if (spec.curve === 'exp' && spec.min > 0) {
    return Math.log(v / spec.min) / Math.log(spec.max / spec.min);
  }
  return (v - spec.min) / (spec.max - spec.min);
}

/** Inverse of toNormalized. */
export function fromNormalized(spec: ParamSpec, n: number): number {
  const t = Math.min(1, Math.max(0, n));
  let v: number;
  if (spec.curve === 'exp' && spec.min > 0) v = spec.min * Math.pow(spec.max / spec.min, t);
  else v = spec.min + t * (spec.max - spec.min);
  return clampParam(spec, v);
}

export function formatParam(spec: ParamSpec, value: number): string {
  const v = clampParam(spec, value);
  if (spec.curve === 'enum' && spec.options) return spec.options[v] ?? String(v);
  if (spec.curve === 'bool') return v ? 'On' : 'Off';
  switch (spec.unit) {
    case 'Hz':
      return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`;
    case 'dB':
      return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
    case 's':
      return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
    case 'ms':
      return `${Math.round(v)} ms`;
    case '%':
      return `${Math.round(v * 100)}%`;
    case 'st':
      return `${v > 0 ? '+' : ''}${Number.isInteger(v) ? v : v.toFixed(1)} st`;
    case 'ct':
      return `${v > 0 ? '+' : ''}${Math.round(v)} ct`;
    case 'x':
      return `${v.toFixed(2)}×`;
    case 'bpm':
      return `${v.toFixed(v % 1 ? 1 : 0)} BPM`;
    case 'bits':
      return `${Math.round(v)} bit`;
    default:
      if (spec.id === 'pan') return Math.abs(v) < 0.005 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`;
      return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
}

export function dbToGain(db: number): number {
  return db <= -60 ? 0 : Math.pow(10, db / 20);
}
