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

/**
 * A control that does nothing until another control of the same instrument
 * or module is raised (Unison Detune with Unison 1, an EQ band's pitch with
 * its gain at 0 dB). `when: 'above'` opens it while the other control is
 * above `value` (default 0); `'nonzero'` while it is not 0. `reason` says,
 * in plain words, what turns it on.
 */
export interface ParamGate {
  param: string;
  when: 'above' | 'nonzero';
  value?: number;
  reason: string;
}

export interface ParamSpec {
  id: string;
  label: string;
  /** Optional shorter plain word for very tight layouts (never an abbreviation). */
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
  /** The control only acts while another control is raised (see ParamGate and gateOpen). */
  gate?: ParamGate;
  /**
   * Shown (and typed) as minus the stored number: Gate Depth stores 60 and
   * reads "-60.0 dB" (it turns the closed gate down by 60 dB). See
   * displayValue / fromDisplayValue.
   */
  negate?: boolean;
}

const p = (s: ParamSpec): ParamSpec => s;

/* ------------------------------------------------------------------ */
/* Instruments                                                         */
/* ------------------------------------------------------------------ */

export const WAVE_OPTIONS = ['Saw', 'Square', 'Triangle', 'Sine'] as const;
/** Sub-oscillator shapes of the bass synth. */
export const SUB_WAVE_OPTIONS = ['Square', 'Sine'] as const;

/*
 * Synth voice features shared by the bass and poly synths (FM, pitch sweep).
 * Every default is neutral: a sound saved before these existed plays exactly
 * as it did, and a voice only builds the extra nodes a sound actually uses.
 */
const FM_AMOUNT = p({ id: 'fmAmount', label: 'FM Amount', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'Makes the main tone bell-like, glassy or metallic: electric pianos, bells, mallets, hard basses. Zero is off.', detail: 'Frequency modulation of the main oscillator by a hidden sine at FM Ratio × the note (index up to 8, velocity-scaled). Turned up from zero, it starts with the next note.' });
const FM_RATIO = p({ id: 'fmRatio', label: 'FM Ratio', min: 0.5, max: 16, default: 1, unit: 'x', curve: 'exp', tip: 'The colour of the FM tone: whole numbers (1, 2, 3) sound like pianos and organs, in-between values like bells and metal.', detail: 'Modulator frequency as a multiple of the note frequency.' });
const FM_DECAY = p({ id: 'fmDecay', label: 'FM Decay', min: 0.02, max: 8, default: 0.8, unit: 's', curve: 'exp', tip: 'How long the bright FM strike lasts. Long settings keep the tone bright while a note is held.', detail: 'FM depth envelope: from its peak toward 20% of it over this time.' });
const PITCH_SWEEP = p({ id: 'pitchEnv', label: 'Pitch Sweep', min: -24, max: 24, default: 0, unit: 'st', curve: 'lin', tip: 'Each note starts this far above (or, if negative, below) its pitch and slides onto it: drops, zaps, scoops and risers.', detail: 'Pitch envelope in semitones on every oscillator. Turned away from zero, it starts with the next note.' });
const SWEEP_TIME = p({ id: 'pitchDecay', label: 'Sweep Time', min: 0.005, max: 8, default: 0.1, unit: 's', curve: 'exp', tip: 'How long the pitch sweep takes to arrive on the note.', detail: 'Exponential glide of the pitch envelope (about 95% of the way after this time).', gate: { param: 'pitchEnv', when: 'nonzero', reason: 'Does nothing while Pitch Sweep is at 0.' } });

export const BASS_PARAMS: readonly ParamSpec[] = [
  p({ id: 'wave', label: 'Wave', min: 0, max: 3, default: 0, unit: '', curve: 'enum', options: WAVE_OPTIONS, tip: 'Changes the basic character: Saw is buzzy, Square is hollow, Triangle and Sine are round.', detail: 'Main oscillator waveform.' }),
  p({ id: 'octave', label: 'Octave', min: -2, max: 2, default: 0, unit: '', curve: 'int', tip: 'Moves the whole bass up or down by octaves.', detail: 'Transposition in octaves, applied to every note.' }),
  p({ id: 'sub', label: 'Sub', min: 0, max: 1, default: 0.4, unit: '%', curve: 'lin', tip: 'Adds weight underneath the note.', detail: 'Sub-oscillator one octave below (shape: Sub Shape).' }),
  p({ id: 'subWave', label: 'Sub Shape', min: 0, max: 1, default: 0, unit: '', curve: 'enum', options: SUB_WAVE_OPTIONS, tip: 'Square gives a buzzy, present sub; Sine a pure, deep one that is felt more than heard.', detail: 'Sub-oscillator waveform.' }),
  p({ id: 'unisonDetune', label: 'Unison Detune', min: 0, max: 50, default: 0, unit: 'ct', curve: 'lin', tip: 'Adds two slightly detuned copies of the wave for a thick, moving "reese" bass. Zero is a single clean tone.', detail: 'Two extra oscillators at ± this many cents with offset start phases; the three are level-matched to one. Turned up from zero, it starts with the next note.' }),
  FM_AMOUNT,
  FM_RATIO,
  FM_DECAY,
  PITCH_SWEEP,
  SWEEP_TIME,
  p({ id: 'cutoff', label: 'Cutoff', min: 40, max: 12000, default: 700, unit: 'Hz', curve: 'exp', tip: 'Opens or closes the filter: lower is darker and rounder.', detail: '24 dB/oct low-pass cutoff frequency.' }),
  p({ id: 'resonance', label: 'Resonance', min: 0, max: 1, default: 0.25, unit: '%', curve: 'lin', tip: 'Adds a vocal, squelchy peak at the filter edge.', detail: 'Filter Q, limited to a controlled maximum.' }),
  p({ id: 'envAmount', label: 'Filter Envelope', min: 0, max: 1, default: 0.45, unit: '%', curve: 'lin', tip: 'How much each note opens the filter — more gives a plucky "bow".', detail: 'Filter envelope depth, up to +5 octaves.' }),
  p({ id: 'filterDecay', label: 'Filter Decay', min: 0.02, max: 2, default: 0.22, unit: 's', curve: 'exp', tip: 'How quickly the filter closes after each note starts.', detail: 'Filter envelope decay time.' }),
  p({ id: 'attack', label: 'Attack', min: 0.001, max: 1, default: 0.003, unit: 's', curve: 'exp', tip: 'Longer attack makes notes fade in instead of starting sharply.', detail: 'Amplitude envelope attack.' }),
  p({ id: 'decay', label: 'Decay', min: 0.02, max: 2, default: 0.3, unit: 's', curve: 'exp', tip: 'How quickly the note falls to its held level.', detail: 'Amplitude envelope decay.' }),
  p({ id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0.65, unit: '%', curve: 'lin', tip: 'How loud a held note stays.', detail: 'Amplitude envelope sustain level.' }),
  p({ id: 'release', label: 'Release', min: 0.01, max: 2, default: 0.08, unit: 's', curve: 'exp', tip: 'How long the note rings after you let go.', detail: 'Amplitude envelope release.' }),
  p({ id: 'glide', label: 'Glide', min: 0, max: 0.5, default: 0.04, unit: 's', curve: 'lin', tip: 'Slides between overlapping notes.', detail: 'Portamento time, applied to legato notes.' }),
  p({ id: 'drive', label: 'Saturation', min: 0, max: 1, default: 0.2, unit: '%', curve: 'lin', tip: 'Adds grit and helps the bass cut through small speakers.', detail: 'Post-filter soft saturation with level compensation.' }),
  p({ id: 'velocity', label: 'Velocity', min: 0, max: 1, default: 0.5, unit: '%', curve: 'lin', tip: 'How much harder hits get louder and brighter.', detail: 'Velocity sensitivity for amplitude and filter.' }),
  p({ id: 'level', label: 'Level', min: -24, max: 6, default: 0, unit: 'dB', curve: 'lin', tip: 'Instrument volume before effects.', detail: 'Output trim for level matching.' }),
];

export const POLY_PARAMS: readonly ParamSpec[] = [
  p({ id: 'osc1Wave', label: 'Tone 1', min: 0, max: 3, default: 0, unit: '', curve: 'enum', options: WAVE_OPTIONS, tip: 'The main tone colour.', detail: 'Oscillator 1 waveform.' }),
  p({ id: 'osc2Wave', label: 'Tone 2', min: 0, max: 3, default: 0, unit: '', curve: 'enum', options: WAVE_OPTIONS, tip: 'A second tone that blends with the first.', detail: 'Oscillator 2 waveform.' }),
  p({ id: 'osc2Semi', label: 'Tone 2 Pitch', min: -24, max: 24, default: 0, unit: 'st', curve: 'int', tip: 'Tunes the second tone — 12 is an octave, 7 a fifth.', detail: 'Oscillator 2 transposition in semitones.' }),
  p({ id: 'detune', label: 'Detune', min: 0, max: 40, default: 7, unit: 'ct', curve: 'lin', tip: 'Slightly out-of-tune tones make a wider, shimmering sound.', detail: 'Oscillator 2 detune in cents.' }),
  p({ id: 'osc2Level', label: 'Tone 2 Level', min: 0, max: 1, default: 0.5, unit: '%', curve: 'lin', tip: 'Balance of the second tone.', detail: 'Oscillator 2 level.' }),
  p({ id: 'noise', label: 'Noise', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'Adds breath and air.', detail: 'White noise level into the filter.' }),
  p({ id: 'width', label: 'Width', min: 0, max: 1, default: 0.3, unit: '%', curve: 'lin', tip: 'Spreads the sound between left and right.', detail: 'Stereo spread of the two oscillators (and of the Unison copies).' }),
  p({ id: 'unison', label: 'Unison', min: 1, max: 7, default: 1, unit: '', curve: 'int', tip: 'Stacks copies of Tone 1 for a thick, wide sound: 1 is a single tone, 5 to 7 make a huge "supersaw".', detail: 'Unison voices of oscillator 1, tuned apart by Unison Detune, spread by Width, each starting at a different phase. Starts with the next note. Above 4 copies (or together with FM) the part plays fewer notes at once, never fewer than 6.' }),
  p({ id: 'unisonDetune', label: 'Unison Detune', min: 0, max: 60, default: 20, unit: 'ct', curve: 'lin', tip: 'How far apart the stacked copies are tuned: a little shimmers, a lot sounds huge and wobbly.', detail: 'Spread of the unison voices in cents (the outermost at ± this value). No effect with Unison 1.', gate: { param: 'unison', when: 'above', value: 1, reason: 'Does nothing until Unison is above 1.' } }),
  FM_AMOUNT,
  FM_RATIO,
  FM_DECAY,
  p({ id: 'noiseColor', label: 'Noise Colour', min: 0, max: 1, default: 0.5, unit: '%', curve: 'lin', tip: 'Darker noise rumbles like wind and sea; brighter noise hisses like breath. 50% is plain white noise.', detail: 'Below 50%: low-pass on the noise down to 300 Hz; above: high-pass up to 8 kHz (level partly compensated). Moved away from 50%, it starts with the next note.', gate: { param: 'noise', when: 'above', reason: 'Does nothing while Noise is at 0.' } }),
  PITCH_SWEEP,
  SWEEP_TIME,
  p({ id: 'vibrato', label: 'Vibrato', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'A gentle pitch wobble that fades in on held notes, like a singer or a string player.', detail: 'Per-note sine vibrato up to ±50 cents, fading in over 0.35 s. Turned up from zero, it starts with the next note.' }),
  p({ id: 'vibratoRate', label: 'Vibrato Speed', min: 1, max: 12, default: 5.5, unit: 'Hz', curve: 'exp', tip: 'How fast the vibrato wobbles.', detail: 'Vibrato rate.', gate: { param: 'vibrato', when: 'above', reason: 'Does nothing while Vibrato is at 0.' } }),
  p({ id: 'drift', label: 'Drift', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'Makes every note slightly different in tuning and brightness, like an old analogue synth.', detail: 'Per-note random detune (up to ±10 cents per oscillator) and filter offset (up to ±1/4 octave), seeded from the note so renders repeat exactly.' }),
  p({ id: 'cutoff', label: 'Cutoff', min: 60, max: 18000, default: 3200, unit: 'Hz', curve: 'exp', tip: 'Brighter or darker: opens or closes the synth filter.', detail: '12 dB/oct low-pass cutoff.' }),
  p({ id: 'resonance', label: 'Resonance', min: 0, max: 1, default: 0.15, unit: '%', curve: 'lin', tip: 'Emphasises the filter edge for a more resonant tone.', detail: 'Filter Q, limited to a controlled maximum.' }),
  p({ id: 'filterEnv', label: 'Filter Envelope', min: 0, max: 1, default: 0.3, unit: '%', curve: 'lin', tip: 'Makes each note open up brighter at the start.', detail: 'Filter envelope depth, up to +4 octaves.' }),
  p({ id: 'filterDecay', label: 'Filter Decay', min: 0.02, max: 4, default: 0.4, unit: 's', curve: 'exp', tip: 'How long the brightness takes to settle.', detail: 'Filter envelope decay.' }),
  p({ id: 'attack', label: 'Attack', min: 0.001, max: 4, default: 0.005, unit: 's', curve: 'exp', tip: 'Longer attack makes chords swell in.', detail: 'Amplitude envelope attack.' }),
  p({ id: 'decay', label: 'Decay', min: 0.02, max: 4, default: 0.5, unit: 's', curve: 'exp', tip: 'How quickly notes fall to their held level.', detail: 'Amplitude envelope decay.' }),
  p({ id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0.6, unit: '%', curve: 'lin', tip: 'How loud held notes stay. Zero gives plucks.', detail: 'Amplitude envelope sustain level.' }),
  p({ id: 'release', label: 'Release', min: 0.01, max: 6, default: 0.35, unit: 's', curve: 'exp', tip: 'How long notes fade after they end.', detail: 'Amplitude envelope release.' }),
  p({ id: 'velocity', label: 'Velocity', min: 0, max: 1, default: 0.5, unit: '%', curve: 'lin', tip: 'How much harder hits get louder and brighter.', detail: 'Velocity sensitivity.' }),
  p({ id: 'level', label: 'Level', min: -24, max: 6, default: -4, unit: 'dB', curve: 'lin', tip: 'Instrument volume before effects.', detail: 'Output trim for level matching.' }),
];

export const SAMPLER_PARAMS: readonly ParamSpec[] = [
  p({ id: 'start', label: 'Start', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'Where playback begins in the recording.', detail: 'Trim start as a fraction of the file.' }),
  p({ id: 'end', label: 'End', min: 0, max: 1, default: 1, unit: '%', curve: 'lin', tip: 'Where playback stops in the recording.', detail: 'Trim end as a fraction of the file.' }),
  p({ id: 'gain', label: 'Gain', min: -24, max: 12, default: 0, unit: 'dB', curve: 'lin', tip: 'Makes the recording louder or quieter.', detail: 'Sample playback gain.' }),
  p({ id: 'pitch', label: 'Pitch', min: -24, max: 24, default: 0, unit: 'st', curve: 'int', tip: 'Plays the recording higher or lower. Speed changes with it.', detail: 'Playback-rate transposition. Pitch and speed change together in this version.' }),
  p({ id: 'fine', label: 'Fine', min: -100, max: 100, default: 0, unit: 'ct', curve: 'lin', tip: 'Small tuning adjustment.', detail: 'Fine tuning in cents (also changes speed).' }),
  p({ id: 'mode', label: 'Mode', min: 0, max: 1, default: 0, unit: '', curve: 'enum', options: ['One-shot', 'Loop'], tip: 'One-shot plays the whole region once per note, however short the note; Loop repeats it while the note is held.', detail: 'Playback mode.' }),
  p({ id: 'fadeIn', label: 'Fade In', min: 0, max: 500, default: 3, unit: 'ms', curve: 'lin', tip: 'Softens the start to avoid clicks.', detail: 'Fade-in time at the trim start.' }),
  p({ id: 'fadeOut', label: 'Fade Out', min: 0, max: 2000, default: 15, unit: 'ms', curve: 'lin', tip: 'Softens the end to avoid clicks.', detail: 'One-shot: fade-out at the trim end. Loop: crossfade at the loop point (at least 5 ms) and the shortest release.' }),
  p({ id: 'sync', label: 'Tempo Sync', min: 0, max: 1, default: 0, unit: '', curve: 'enum', options: ['Off', 'Speed'], tip: 'Speeds the loop up or down to follow the project tempo. Pitch changes with speed.', detail: 'rate = project BPM / original BPM. Not pitch-preserving.' }),
  p({ id: 'originalBpm', label: 'Original BPM', min: 40, max: 220, default: 120, unit: 'bpm', curve: 'lin', tip: 'The tempo the recording was made at.', detail: 'Used by Tempo Sync.' }),
  p({ id: 'rootNote', label: 'Root Note', min: 24, max: 96, default: 60, unit: '', curve: 'int', tip: 'The key that plays the recording at its original pitch.', detail: 'MIDI note number with no transposition.' }),
  p({ id: 'attack', label: 'Attack', min: 0.001, max: 2, default: 0.002, unit: 's', curve: 'exp', tip: 'Fades each note in.', detail: 'Amplitude envelope attack.' }),
  p({ id: 'release', label: 'Release', min: 0.005, max: 4, default: 0.05, unit: 's', curve: 'exp', tip: 'How long notes fade after they end (a one-shot only when Stop cuts it short).', detail: 'Amplitude envelope release.' }),
  p({ id: 'cutoff', label: 'Cutoff', min: 60, max: 20000, default: 20000, unit: 'Hz', curve: 'exp', tip: 'Darkens the recording.', detail: 'Per-voice 12 dB/oct low-pass.' }),
];

export const DRUM_KIT_PARAMS: readonly ParamSpec[] = [
  p({ id: 'tune', label: 'Tune', min: -12, max: 12, default: 0, unit: 'st', curve: 'lin', tip: 'Raises or lowers the pitch of every drum.', detail: 'Global kit tuning in semitones.' }),
  p({ id: 'decay', label: 'Decay', min: 0.25, max: 2, default: 1, unit: 'x', curve: 'exp', tip: 'Shorter drums sound tight; longer ones ring out.', detail: 'Global decay multiplier.' }),
  p({ id: 'cutoff', label: 'Cutoff', min: 200, max: 20000, default: 20000, unit: 'Hz', curve: 'exp', tip: 'Softens the whole kit.', detail: 'Kit low-pass filter.' }),
  p({ id: 'velocity', label: 'Velocity', min: 0, max: 1, default: 0.6, unit: '%', curve: 'lin', tip: 'How much harder hits get louder.', detail: 'Velocity sensitivity.' }),
  p({ id: 'level', label: 'Level', min: -24, max: 6, default: 0, unit: 'dB', curve: 'lin', tip: 'Kit volume before effects.', detail: 'Output trim.' }),
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
  p({ id: 'level', label: 'Level', min: -60, max: 6, default: 0, unit: 'dB', curve: 'lin', tip: 'How loud this part is in the mix.', detail: 'Channel fader gain.' }),
  p({ id: 'pan', label: 'Pan', min: -1, max: 1, default: 0, unit: '', curve: 'lin', tip: 'Places the part left or right.', detail: 'Equal-power stereo pan.' }),
  p({ id: 'sendA', label: 'Reverb Amount', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'How much of this part goes to the shared Reverb.', detail: 'Taken after the part’s level, so its reverb follows when you turn the part up or down.' }),
  p({ id: 'sendB', label: 'Echo Amount', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'How much of this part goes to the shared Echo.', detail: 'Taken after the part’s level, so its echoes follow when you turn the part up or down.' }),
  p({ id: 'pump', label: 'Pump', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'Makes the part duck and swell in time with the beat.', detail: 'Tempo-synced ducking envelope on the channel gain. It follows the transport grid; it does not listen to other tracks (no audio sidechain).' }),
  p({ id: 'pumpDiv', label: 'Pump Speed', min: 0, max: 2, default: 0, unit: '', curve: 'enum', options: PUMP_DIVISIONS, tip: 'How often the part ducks.', detail: 'Ducking envelope period.' }),
];

export const FILTER_PARAMS: readonly ParamSpec[] = [
  p({ id: 'mode', label: 'Mode', min: 0, max: 2, default: 0, unit: '', curve: 'enum', options: ['Low-pass', 'High-pass', 'Band-pass'], tip: 'Low-pass removes highs, High-pass removes lows, Band-pass keeps the middle.', detail: 'Biquad filter type.' }),
  p({ id: 'cutoff', label: 'Cutoff', min: 20, max: 20000, default: 20000, unit: 'Hz', curve: 'exp', tip: 'Where the filter starts to act.', detail: '12 dB/oct cutoff frequency.' }),
  p({ id: 'resonance', label: 'Resonance', min: 0, max: 1, default: 0.1, unit: '%', curve: 'lin', tip: 'Adds a peak at the cutoff.', detail: 'Q from 0.5 to 12 (bounded).' }),
  p({ id: 'bright', label: 'Brightness', min: -12, max: 12, default: 0, unit: 'dB', curve: 'lin', tip: 'Adds or removes sparkle at the top.', detail: 'High-shelf at 3.5 kHz.' }),
];

const DRIVE_GATE: ParamGate = { param: 'amount', when: 'above', reason: 'Does nothing while Drive is at 0.' };

export const DRIVE_PARAMS: readonly ParamSpec[] = [
  p({ id: 'amount', label: 'Drive', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'Warms up and then distorts the sound. Zero is clean.', detail: 'Pre-gain into a soft clipper, level-compensated.' }),
  p({ id: 'character', label: 'Character', min: 0, max: 2, default: 0, unit: '', curve: 'enum', options: ['Warm', 'Hard', 'Fold'], tip: 'Warm is tape-like, Hard is crunchy, Fold is metallic.', detail: 'Waveshaper transfer curve.', gate: DRIVE_GATE }),
  // Stored as "tone"; called Fizz so it is not confused with the Tone big knob or the Reverb and Echo Tone.
  p({ id: 'tone', label: 'Fizz', min: 0, max: 1, default: 0.7, unit: '%', curve: 'lin', tip: 'How much of the bright fizz the drive adds is kept: lower is smoother and darker.', detail: 'A low-pass after the drive, from 1.5 kHz (smooth) to 18 kHz (all the fizz). It shapes only the drive, not the Tone big knob.', gate: DRIVE_GATE }),
  p({ id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, unit: '%', curve: 'lin', tip: 'Blend between clean and driven sound.', detail: 'Dry/wet balance.', gate: DRIVE_GATE }),
];

export const DELAY_PARAMS: readonly ParamSpec[] = [
  p({ id: 'division', label: 'Time', min: 0, max: 5, default: 2, unit: '', curve: 'enum', options: DELAY_DIVISIONS, tip: 'Echo timing, locked to the tempo.', detail: 'Tempo-synced delay time.' }),
  p({ id: 'feedback', label: 'Feedback', min: 0, max: 0.85, default: 0.38, unit: '%', curve: 'lin', tip: 'How many times the echo repeats.', detail: 'Internal feedback, bounded below unity.' }),
  p({ id: 'tone', label: 'Tone', min: 500, max: 12000, default: 3800, unit: 'Hz', curve: 'exp', tip: 'Darker echoes sit further back.', detail: 'Low-pass in the feedback path.' }),
  // Stored as "width".
  p({ id: 'width', label: 'Ping-pong', min: 0, max: 1, default: 0.6, unit: '%', curve: 'lin', tip: 'Bounces the echoes between left and right.', detail: 'How far each repeat swings to the other side: 0% keeps the echoes where the sound is.' }),
  p({ id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, unit: '%', curve: 'lin', tip: 'Echo level. As a send return this is the return level.', detail: 'Wet level. As a return fed only by sends there is no dry sound; as an insert the dry sound passes at 1 - mix.' }),
];

export const REVERB_PARAMS: readonly ParamSpec[] = [
  p({ id: 'decay', label: 'Size', min: 0.3, max: 9, default: 2.4, unit: 's', curve: 'exp', tip: 'Small rooms to huge halls.', detail: 'Impulse-response decay time (RT60 approx.).' }),
  p({ id: 'predelay', label: 'Pre-delay', min: 0, max: 120, default: 12, unit: 'ms', curve: 'lin', tip: 'A short gap before the room answers keeps sounds clear.', detail: 'Pre-delay before the convolver.' }),
  p({ id: 'tone', label: 'Tone', min: 1000, max: 16000, default: 6500, unit: 'Hz', curve: 'exp', tip: 'Darker rooms feel softer and further away.', detail: 'Low-pass on the reverb output.' }),
  p({ id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, unit: '%', curve: 'lin', tip: 'Room level. As a send return this is the return level.', detail: 'Wet level. As a return fed only by sends there is no dry sound; as an insert the dry sound passes at 1 - mix.' }),
];

export const CHORUS_PARAMS: readonly ParamSpec[] = [
  p({ id: 'rate', label: 'Rate', min: 0.05, max: 5, default: 0.5, unit: 'Hz', curve: 'exp', tip: 'Speed of the shimmer.', detail: 'Modulation rate.' }),
  p({ id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.45, unit: '%', curve: 'lin', tip: 'How wide and wobbly the shimmer is.', detail: 'Delay-time modulation depth (up to 6 ms).' }),
  p({ id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.5, unit: '%', curve: 'lin', tip: 'Blend of the chorused sound.', detail: 'Dry/wet.' }),
];

export const PHASER_PARAMS: readonly ParamSpec[] = [
  p({ id: 'rate', label: 'Rate', min: 0.05, max: 5, default: 0.3, unit: 'Hz', curve: 'exp', tip: 'Speed of the sweep.', detail: 'Modulation rate.' }),
  p({ id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.6, unit: '%', curve: 'lin', tip: 'How far the sweep travels.', detail: 'All-pass centre-frequency sweep range.' }),
  p({ id: 'feedback', label: 'Feedback', min: 0, max: 0.8, default: 0.4, unit: '%', curve: 'lin', tip: 'Makes the sweep more pronounced.', detail: 'All-pass chain feedback, bounded.' }),
  p({ id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.5, unit: '%', curve: 'lin', tip: 'Blend of the phased sound.', detail: 'Dry/wet.' }),
];

export const CRUSHER_PARAMS: readonly ParamSpec[] = [
  p({ id: 'bits', label: 'Bits', min: 2, max: 16, default: 16, unit: 'bits', curve: 'lin', tip: 'Fewer bits make the sound gritty and lo-fi.', detail: 'Bit-depth quantisation.' }),
  p({ id: 'downsample', label: 'Lo-fi Rate', min: 1, max: 32, default: 1, unit: 'x', curve: 'exp', tip: 'Higher values make a crunchy, aliased old-sampler sound.', detail: 'Sample-and-hold factor (sample-rate reduction).' }),
  p({ id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, unit: '%', curve: 'lin', tip: 'Blend of the crushed sound.', detail: 'Dry/wet.' }),
];

export const LFO_PARAMS: readonly ParamSpec[] = [
  p({ id: 'wave', label: 'Shape', min: 0, max: 5, default: 0, unit: '', curve: 'enum', options: LFO_WAVES, tip: 'The shape of the movement.', detail: 'LFO waveform. Random is a seeded step pattern.' }),
  p({ id: 'division', label: 'Rate', min: 0, max: 8, default: 2, unit: '', curve: 'enum', options: LFO_DIVISIONS, tip: 'How often the movement repeats, locked to the tempo.', detail: 'Cycle length, phase-aligned to the transport.' }),
  p({ id: 'depth', label: 'Depth', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'How much movement is sent through the cable.', detail: 'Output amplitude (bipolar).' }),
];

export const AUTOPAN_SHAPES = ['Sine', 'Triangle', 'Square'] as const;
export const AUTOPAN_MODES = ['Pan', 'Tremolo'] as const;

const EQ_LOWS_GATE: ParamGate = { param: 'lowGain', when: 'nonzero', reason: 'Does nothing while Lows is at 0 dB.' };
const EQ_MIDS_GATE: ParamGate = { param: 'midGain', when: 'nonzero', reason: 'Does nothing while Mids is at 0 dB.' };
const EQ_HIGHS_GATE: ParamGate = { param: 'highGain', when: 'nonzero', reason: 'Does nothing while Highs is at 0 dB.' };

export const EQ_PARAMS: readonly ParamSpec[] = [
  p({ id: 'lowCut', label: 'Low Cut', min: 20, max: 1000, default: 20, unit: 'Hz', curve: 'exp', tip: 'Removes rumble and mud below this pitch. All the way down is off.', detail: '12 dB/oct high-pass; 20 Hz = off.' }),
  p({ id: 'lowGain', label: 'Lows', min: -15, max: 15, default: 0, unit: 'dB', curve: 'lin', tip: 'More or less bass and weight.', detail: 'Low shelf gain.' }),
  p({ id: 'lowFreq', label: 'Lows Pitch', min: 40, max: 500, default: 120, unit: 'Hz', curve: 'exp', tip: 'Where the bass control starts.', detail: 'Low shelf corner frequency.', gate: EQ_LOWS_GATE }),
  p({ id: 'midGain', label: 'Mids', min: -15, max: 15, default: 0, unit: 'dB', curve: 'lin', tip: 'Pushes the body of the sound forward or back.', detail: 'Peaking band gain.' }),
  p({ id: 'midFreq', label: 'Mids Pitch', min: 150, max: 8000, default: 1000, unit: 'Hz', curve: 'exp', tip: 'Which middle range the Mids control moves.', detail: 'Peaking band centre frequency.', gate: EQ_MIDS_GATE }),
  p({ id: 'midQ', label: 'Mids Width', min: 0.3, max: 6, default: 0.9, unit: 'x', curve: 'exp', tip: 'Wide changes sound natural; narrow ones pick out a single ring.', detail: 'Peaking band Q.', gate: EQ_MIDS_GATE }),
  p({ id: 'highGain', label: 'Highs', min: -15, max: 15, default: 0, unit: 'dB', curve: 'lin', tip: 'More or less sparkle and air.', detail: 'High shelf gain.' }),
  p({ id: 'highFreq', label: 'Highs Pitch', min: 1500, max: 16000, default: 6000, unit: 'Hz', curve: 'exp', tip: 'Where the treble control starts.', detail: 'High shelf corner frequency.', gate: EQ_HIGHS_GATE }),
  p({ id: 'highCut', label: 'High Cut', min: 1000, max: 20000, default: 20000, unit: 'Hz', curve: 'exp', tip: 'Removes hiss and harshness above this pitch. All the way up is off.', detail: '12 dB/oct low-pass; 20 kHz = off.' }),
];

export const COMPRESSOR_PARAMS: readonly ParamSpec[] = [
  p({ id: 'threshold', label: 'Threshold', min: -60, max: 0, default: -18, unit: 'dB', curve: 'lin', tip: 'Sounds louder than this get squeezed. Lower means more squeeze.', detail: 'Compressor threshold.' }),
  p({ id: 'ratio', label: 'Squeeze', min: 1, max: 20, default: 4, unit: 'x', curve: 'exp', tip: 'How hard loud moments are held down: 2 is gentle, 10 is strong.', detail: 'Compression ratio (n:1).' }),
  p({ id: 'attack', label: 'Attack', min: 0.1, max: 100, default: 10, unit: 'ms', curve: 'exp', tip: 'Slower attack lets the punch of each hit through.', detail: 'Attack time.' }),
  p({ id: 'release', label: 'Release', min: 10, max: 1000, default: 150, unit: 'ms', curve: 'exp', tip: 'How quickly the sound recovers after a loud moment.', detail: 'Release time.' }),
  p({ id: 'makeup', label: 'Makeup', min: 0, max: 24, default: 0, unit: 'dB', curve: 'lin', tip: 'Turns the squeezed sound back up.', detail: 'Make-up gain after compression.' }),
  p({ id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, unit: '%', curve: 'lin', tip: 'Blend with the untouched sound (parallel compression).', detail: 'Dry/wet.' }),
];

export const GATE_PARAMS: readonly ParamSpec[] = [
  p({ id: 'threshold', label: 'Threshold', min: -80, max: 0, default: -50, unit: 'dB', curve: 'lin', tip: 'Quieter sounds than this are silenced: cleans up noise and tails.', detail: 'Gate opening threshold.' }),
  // Stored as a positive attenuation; shown as the level change it makes ("-60.0 dB").
  p({ id: 'range', label: 'Depth', min: 0, max: 80, default: 60, unit: 'dB', curve: 'lin', negate: true, tip: 'How far the closed gate turns things down: -60 dB makes them 60 dB quieter.', detail: 'Attenuation while the gate is closed.' }),
  p({ id: 'attack', label: 'Attack', min: 0.1, max: 50, default: 1, unit: 'ms', curve: 'exp', tip: 'How fast the gate opens.', detail: 'Opening time.' }),
  p({ id: 'release', label: 'Release', min: 5, max: 1000, default: 80, unit: 'ms', curve: 'exp', tip: 'How fast the gate closes once the sound drops.', detail: 'Closing time.' }),
];

export const AUTOPAN_PARAMS: readonly ParamSpec[] = [
  p({ id: 'mode', label: 'Mode', min: 0, max: 1, default: 0, unit: '', curve: 'enum', options: AUTOPAN_MODES, tip: 'Pan swings the sound left and right; Tremolo pulses its volume.', detail: 'Stereo pan or amplitude modulation.' }),
  p({ id: 'division', label: 'Rate', min: 0, max: 8, default: 4, unit: '', curve: 'enum', options: LFO_DIVISIONS, tip: 'How fast it moves, locked to the tempo.', detail: 'Cycle length, phase-aligned to the transport.' }),
  p({ id: 'shape', label: 'Shape', min: 0, max: 2, default: 0, unit: '', curve: 'enum', options: AUTOPAN_SHAPES, tip: 'Smooth, steady or choppy movement.', detail: 'Modulation waveform.' }),
  p({ id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.6, unit: '%', curve: 'lin', tip: 'How far it moves.', detail: 'Modulation depth.' }),
];

export const WIDENER_PARAMS: readonly ParamSpec[] = [
  p({ id: 'width', label: 'Width', min: 0, max: 2, default: 1.4, unit: 'x', curve: 'lin', tip: 'Below 1 narrows towards mono, above 1 spreads the sound wider.', detail: 'Mid/side side gain (1 = unchanged).' }),
  p({ id: 'monoBass', label: 'Mono Bass', min: 20, max: 400, default: 120, unit: 'Hz', curve: 'exp', tip: 'Keeps the lows centred so the bass stays solid. All the way down is off.', detail: 'Sides are high-passed at this frequency; 20 Hz = off.' }),
];

export const FLANGER_PARAMS: readonly ParamSpec[] = [
  p({ id: 'rate', label: 'Rate', min: 0.02, max: 5, default: 0.15, unit: 'Hz', curve: 'exp', tip: 'Speed of the jet-plane sweep.', detail: 'Modulation rate.' }),
  p({ id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.7, unit: '%', curve: 'lin', tip: 'How far the sweep travels.', detail: 'Delay-time modulation (0.3–8 ms).' }),
  p({ id: 'feedback', label: 'Feedback', min: 0, max: 0.85, default: 0.5, unit: '%', curve: 'lin', tip: 'Makes the sweep sharper and more metallic.', detail: 'Feedback, bounded below unity.' }),
  p({ id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.5, unit: '%', curve: 'lin', tip: 'Blend of the flanged sound.', detail: 'Dry/wet.' }),
];

export const TAPE_PARAMS: readonly ParamSpec[] = [
  p({ id: 'drive', label: 'Saturation', min: 0, max: 1, default: 0.35, unit: '%', curve: 'lin', tip: 'Warm, rounded tape compression and harmonics.', detail: 'Soft tape-style saturation, level-compensated.' }),
  p({ id: 'wobble', label: 'Wobble', min: 0, max: 1, default: 0.2, unit: '%', curve: 'lin', tip: 'The gentle pitch drift of an old tape machine.', detail: 'Wow and flutter (slow + fast pitch modulation).' }),
  p({ id: 'tone', label: 'Tone', min: 0, max: 1, default: 0.6, unit: '%', curve: 'lin', tip: 'Darker sounds older; brighter sounds fresher.', detail: 'Post low-pass from 3 kHz to 20 kHz.' }),
  p({ id: 'hiss', label: 'Hiss', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'Adds a little tape noise for vintage feel.', detail: 'Seeded noise floor, follows the signal level.' }),
  p({ id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, unit: '%', curve: 'lin', tip: 'Blend with the clean sound.', detail: 'Dry/wet.' }),
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
  eq: EQ_PARAMS,
  compressor: COMPRESSOR_PARAMS,
  gate: GATE_PARAMS,
  autopan: AUTOPAN_PARAMS,
  widener: WIDENER_PARAMS,
  flanger: FLANGER_PARAMS,
  tape: TAPE_PARAMS,
  lfo: LFO_PARAMS,
  master: MASTER_PARAMS,
};

/* ------------------------------------------------------------------ */
/* Mastering (master bus, schema v2)                                   */
/* ------------------------------------------------------------------ */

/**
 * The mastering chain, in signal order: low cut → three-band EQ (+ air) →
 * glue compressor → saturation → stereo width / mono bass → loudness drive
 * into the protected limiter (ceiling −1 dBFS, not adjustable). Every default
 * is neutral, so a project with default mastering sounds exactly as without.
 */
export const MASTERING_PARAMS: readonly ParamSpec[] = [
  p({ id: 'lowCut', label: 'Low Cut', min: 10, max: 120, default: 10, unit: 'Hz', curve: 'exp', tip: 'Removes sub-sonic rumble that eats loudness. All the way down is off.', detail: 'High-pass (24 dB/oct); 10 Hz = off.' }),
  p({ id: 'lowGain', label: 'Lows', min: -6, max: 6, default: 0, unit: 'dB', curve: 'lin', tip: 'More or less weight in the whole mix.', detail: 'Low shelf gain.' }),
  p({ id: 'lowFreq', label: 'Lows Pitch', min: 40, max: 300, default: 110, unit: 'Hz', curve: 'exp', tip: 'Where the Lows control starts.', detail: 'Low shelf corner.' }),
  p({ id: 'midGain', label: 'Mids', min: -6, max: 6, default: 0, unit: 'dB', curve: 'lin', tip: 'Brings vocals and leads forward, or makes room.', detail: 'Wide peaking band gain.' }),
  p({ id: 'midFreq', label: 'Mids Pitch', min: 200, max: 6000, default: 1200, unit: 'Hz', curve: 'exp', tip: 'Which middle range the Mids control moves.', detail: 'Peaking band centre (Q 0.7).' }),
  p({ id: 'highGain', label: 'Highs', min: -6, max: 6, default: 0, unit: 'dB', curve: 'lin', tip: 'More or less brightness in the whole mix.', detail: 'High shelf gain.' }),
  p({ id: 'highFreq', label: 'Highs Pitch', min: 2000, max: 12000, default: 5000, unit: 'Hz', curve: 'exp', tip: 'Where the Highs control starts.', detail: 'High shelf corner.' }),
  p({ id: 'air', label: 'Air', min: 0, max: 6, default: 0, unit: 'dB', curve: 'lin', tip: 'A gentle lift of the very top for an open, expensive sound.', detail: 'High shelf at 14 kHz.' }),
  p({ id: 'glue', label: 'Glue', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'Gently compresses the whole mix so the parts feel like one song. Zero is off.', detail: 'Peak-sensing bus compressor: threshold and ratio rise together (up to −24 dB, 4:1); attack set by Punch, automatic release and make-up.' }),
  p({ id: 'punch', label: 'Punch', min: 0, max: 1, default: 0.5, unit: '%', curve: 'lin', tip: 'Higher lets more of each drum hit through the Glue.', detail: 'Glue attack from 1 ms to 30 ms.' }),
  p({ id: 'saturation', label: 'Warmth', min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip: 'Adds analogue-style harmonics and density. Zero is clean.', detail: 'Soft saturation at 4x oversampling, level-compensated.' }),
  p({ id: 'width', label: 'Width', min: 0, max: 1.6, default: 1, unit: 'x', curve: 'lin', tip: 'Narrower or wider stereo image. 1 is unchanged.', detail: 'Mid/side side gain.' }),
  p({ id: 'monoBass', label: 'Mono Bass', min: 20, max: 300, default: 20, unit: 'Hz', curve: 'exp', tip: 'Keeps everything below this pitch in the centre, for solid lows on every system. All the way down is off.', detail: 'Sides high-passed at this frequency; 20 Hz = off.' }),
  p({ id: 'loudness', label: 'Loudness', min: 0, max: 15, default: 0, unit: 'dB', curve: 'lin', tip: 'Pushes the whole mix into the limiter: louder, with less dynamic range. The peak ceiling stays at −1 dBFS.', detail: 'Gain into the output limiter.' }),
];

/** Neutral mastering values (the chain changes nothing). */
export function neutralMasteringParams(): ParamValues {
  return defaultParams(MASTERING_PARAMS);
}

export const MASTER_VOLUME_SPEC = p({
  id: 'masterVolume', label: 'Master', min: -60, max: 6, default: 0, unit: 'dB', curve: 'lin',
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

/**
 * Whether a gated control acts (see ParamGate): true for controls without a
 * gate. Pass the instrument's or module's effective values (with big knobs
 * applied, e.g. resolveModuleParams), so a macro-driven value counts. A value
 * missing from `params` reads as its default from `specs` (0 without specs).
 */
export function gateOpen(spec: ParamSpec, params: ParamValues | undefined, specs?: readonly ParamSpec[]): boolean {
  const g = spec.gate;
  if (!g) return true;
  const raw = params?.[g.param];
  const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : (specs ? specById(specs, g.param)?.default : undefined) ?? 0;
  return g.when === 'nonzero' ? v !== 0 : v > (g.value ?? 0);
}

/** The number a control shows for a stored value (minus it for `negate` controls such as Gate Depth). */
export function displayValue(spec: ParamSpec, value: number): number {
  return spec.negate ? -value : value;
}

/** The stored value for a number typed in a control's display units (inverse of displayValue). */
export function fromDisplayValue(spec: ParamSpec, shown: number): number {
  return spec.negate ? -shown : shown;
}

/** Milliseconds: one decimal below 10 ms, so short times read every step ("2.3 ms"; 0 is "0 ms"). */
function formatMs(ms: number): string {
  const tenths = Math.round(ms * 10) / 10;
  if (tenths === 0) return '0 ms';
  return tenths < 10 ? `${tenths.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

export function formatParam(spec: ParamSpec, value: number): string {
  const v = clampParam(spec, value);
  if (spec.curve === 'enum' && spec.options) return spec.options[v] ?? String(v);
  if (spec.curve === 'bool') return v ? 'On' : 'Off';
  switch (spec.unit) {
    case 'Hz':
      return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`;
    case 'dB': {
      const d = displayValue(spec, v);
      return `${d > 0 ? '+' : ''}${d.toFixed(1)} dB`;
    }
    case 's':
      return v < 1 ? formatMs(v * 1000) : `${v.toFixed(2)} s`;
    case 'ms':
      return formatMs(v);
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
