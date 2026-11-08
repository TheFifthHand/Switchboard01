/**
 * Round 7 words: the string tables and word builders Simple mode shows carry none of the avoided words
 * (EASY_SPEC › Vocabulary: bar, BPM, scene, pad, part, step, clip, macro, master, mix, LUFS, quantize,
 * MIDI, velocity, arpeggiator; plus note names, "root", "major/minor" and scale names), and Advanced keeps
 * its 2.4 words where it shares a builder.
 */
import { describe, expect, it } from 'vitest';
import { getStarter } from '../../src/content/starters';
import { SOUND_CATEGORIES } from '../../src/content/catalog';
import { HOW_IT_WORKS } from '../../src/app/views/HelpDialog';
import { SIMPLE_SHORTCUT_GROUPS } from '../../src/app/views/hints/shortcuts';
import { MOOD_WORD } from '../../src/app/views/keyMood';
import { INSTRUMENT_KINDS, hiddenInstruments, instrumentName, lastsText, repeatName, shortOrLong, songTip, timeAt } from '../../src/app/views/arrange/songHome';
import { lengthBadge, moveBadge, regionLabel, startBadge } from '../../src/app/views/arrange/songModel';
import { simpleBarName } from '../../src/app/views/steps/StepLanes';
import { avoidedWords } from './r7-words-avoid';

const house = () => getStarter('house')!.build();

describe('the avoid-list checker', () => {
  it('finds the words and lets the named exceptions through', () => {
    expect(avoidedWords('Bars 9–24 · 124 BPM, G4 root, moody minor')).toEqual(['Bars', 'BPM', 'G4', 'root', 'minor']);
    expect(avoidedWords('Jam pads · MIDI & audio…')).toEqual([]);
    expect(avoidedWords('Pad')).toEqual([]);
    expect(avoidedWords('Root Pulse plays', ['Root Pulse'])).toEqual([]);
    expect(avoidedWords('drag onto a part')).toEqual(['part']);
  });
});

describe('Simple string tables', () => {
  it('Help: How Omni Song works and the Simple keys', () => {
    for (const h of HOW_IT_WORKS) expect(avoidedWords(`${h.title} ${h.text}`), h.title).toEqual([]);
    expect(HOW_IT_WORKS.map((h) => h.title)).toEqual(expect.arrayContaining(['Click a loop to change it', '+ Add instrument', 'Make it longer', 'Share']));
    for (const g of SIMPLE_SHORTCUT_GROUPS) {
      expect(avoidedWords(`${g.title} ${g.where ?? ''}`), g.id).toEqual([]);
      for (const s of g.items) expect(avoidedWords(s.does), s.id).toEqual([]);
    }
  });

  it('moods are mood words alone; instrument kinds and the sound browser speak plainly', () => {
    for (const w of Object.values(MOOD_WORD)) expect(avoidedWords(w), w).toEqual([]);
    expect(new Set(Object.values(MOOD_WORD)).size).toBe(Object.values(MOOD_WORD).length);
    for (const k of Object.values(INSTRUMENT_KINDS)) expect(avoidedWords(k.name)).toEqual([]);
    for (const c of SOUND_CATEGORIES) expect(avoidedWords(c.blurb), c.id).toEqual([]);
  });

  it('every tip-line step', () => {
    const p = house();
    const empty = { ...p, arrangement: { ...p.arrangement, regions: [] } };
    const texts = [songTip(empty).text, songTip(p).text, songTip(p, false, false).text];
    for (const t of texts) expect(avoidedWords(t), t).toEqual([]);
  });

  it('instrument names match the picker words for 2.4 default names, and keep given names', () => {
    expect(instrumentName('Lead', 'lead')).toBe('Melody');
    expect(instrumentName('Chords', 'chords')).toBe('Keys & chords');
    expect(instrumentName('Sampler', 'sampler')).toBe('Recording');
    expect(instrumentName('Vocal', 'sampler')).toBe('Vocal');
    expect(instrumentName('My Lead', 'lead')).toBe('My Lead');
    const p = house();
    // The + Add instrument picker never shows a 2.4 name beside the word it uses.
    for (const h of hiddenInstruments(p, [])) expect(['Lead', 'Chords', 'Sampler']).not.toContain(h.name);
  });
});

describe('places and lengths in plain words', () => {
  it('times, seconds and short/long instead of bars', () => {
    expect(timeAt(8, 120)).toBe('0:16');
    expect(lastsText(2, 120)).toBe('4 seconds');
    expect(lastsText(32, 124)).toBe('1 minute 2 seconds');
    expect(shortOrLong(1)).toBe('Short');
    expect(shortOrLong(4)).toBe('Long');
    expect(simpleBarName(1, 2)).toBe('2nd half');
    expect(simpleBarName(2, 4)).toBe('Page 3');
  });

  it('drag badges and spoken loop names: times with a tempo (Simple), bars without (Advanced)', () => {
    expect(moveBadge(8, false, 1, 120)).toBe('At 0:16');
    expect(moveBadge(8, true, 2, 120)).toBe('+ Copy · 2 loops · At 0:16');
    expect(lengthBadge(8, 2, 1, 120)).toBe('16 s · plays 4×');
    expect(startBadge(4, 1, 120)).toBe('starts at 0:08');
    expect(regionLabel('Four Floor', 'Drums', { start: 8, bars: 8, offset: 0 }, 2, 120)).toBe('Four Floor, Drums, from 0:16 to 0:32, plays 4 times');
    for (const t of [moveBadge(8, true, 2, 120), lengthBadge(8, 2, 3, 120), startBadge(4, 2, 120), regionLabel('X', 'Drums', { start: 8, bars: 8, offset: 1 }, 2, 120)]) expect(avoidedWords(t, ['X']), t).toEqual([]);
    // Advanced keeps 2.4's bars.
    expect(moveBadge(8, false)).toBe('Bar 9');
    expect(lengthBadge(8, 2)).toBe('8 bars · plays 4×');
    expect(regionLabel('Four Floor', 'Drums', { start: 8, bars: 8, offset: 0 }, 2)).toBe('Four Floor, Drums, bars 9 to 16, plays 4 times');
  });

  it('what a repeat is called: the section, the whole song, or the marked stretch', () => {
    const sections = [
      { name: 'Intro', start: 0, bars: 8 },
      { name: 'Groove', start: 8, bars: 16 },
    ];
    expect(repeatName(sections, { fromBar: 8, toBar: 24 }, 24)).toBe('Groove');
    expect(repeatName(sections, { fromBar: 0, toBar: 24 }, 24)).toBe('the whole song');
    expect(repeatName(sections, { fromBar: 2, toBar: 4 }, 24)).toBe('the marked stretch');
  });
});
