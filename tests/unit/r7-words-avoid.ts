/**
 * Round 7 vocabulary (EASY_SPEC › Vocabulary): words Simple mode never shows, as one checker for the unit
 * and browser word sweeps. Allowed on purpose: "Pad" / "Pads" as the instrument kind the picker names,
 * "Jam pads" and "MIDI & audio" (the ⋯ items the spec names), and loop names, which are read, not learnt
 * (passed in `names`).
 */
export const AVOID =
  /\b(bars?|BPM|scenes?|pads?|parts?|steps?|clips?|macros?|master|mix|LUFS|dBTP|dB|quantiz\w*|MIDI|velocity|arpeggiator|root|octaves?|major|minor|Dorian|Phrygian|Lydian|Mixolydian|semitones?|[A-G][#b♯♭]?\d)\b/i;

const ALLOWED: readonly RegExp[] = [/\bJam pads\b/gi, /\bMIDI & audio\b/g, /^Pads?$/, /\bPads? \(/g];

/** The avoided words in `text` (empty when clean), after taking out allowed phrases and the given names. */
export function avoidedWords(text: string, names: readonly string[] = []): string[] {
  let t = text;
  for (const n of names) if (n) t = t.split(n).join(' ');
  for (const a of ALLOWED) t = t.replace(a, ' ');
  const out: string[] = [];
  const re = new RegExp(AVOID.source, 'gi');
  for (const m of t.matchAll(re)) out.push(m[0]);
  return out;
}
