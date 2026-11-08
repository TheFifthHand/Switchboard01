/**
 * Round 7 fix 2b: one name per instrument in Simple, plain drum words, the
 * package version as the one source, and file names that keep every script.
 */
import { describe, expect, it } from 'vitest';
import { getKitVoiceNames } from '../../src/audio/instruments/kits';
import { KITS } from '../../src/content/catalog';
import { getStarter } from '../../src/content/starters';
import { SIMPLE_DRUM_WORDS, drumNamesIn, simpleDrumName, simpleTrackName, trackNameIn } from '../../src/app/labels';
import { instrumentName } from '../../src/app/views/arrange/songHome';
import { placesBadge } from '../../src/app/views/arrange/songModel';
import { CORE_VOICES } from '../../src/app/views/steps/DrumSteps';
import { drumMixGroups } from '../../src/app/views/shape/drumMix';
import { nameLosesCharacters, safeName, withShownNames } from '../../src/app/views/share/fileMaker';
import { bundleFileName, BUNDLE_EXTENSION } from '../../src/persistence/bundle';
import { songMidi } from '../../src/render/midi';
import { stemFileNames, stemParts } from '../../src/render/stems';
import { validateProject } from '../../src/project/validate';
import { renameTrack } from '../../src/state/commands';
import { ProjectStore } from '../../src/state/projectStore';
import { avoidedWords } from './r7-words-avoid';

const house = () => getStarter('house')!.build();
const byRole = (p: ReturnType<typeof house>, role: string) => p.tracks.find((t) => t.role === role)!;

describe('one name per instrument', () => {
  it('Simple says the picker’s word for 2.4’s default names; Advanced and any other name stay as stored', () => {
    expect(simpleTrackName({ name: 'Lead', role: 'lead' })).toBe('Melody');
    expect(simpleTrackName({ name: 'Chords', role: 'chords' })).toBe('Keys & chords');
    expect(simpleTrackName({ name: 'Sampler', role: 'sampler' })).toBe('Recording');
    expect(simpleTrackName({ name: 'Bass', role: 'bass' })).toBe('Bass');
    // Only the role's own old default: a pad someone called "Chords" is "Chords".
    expect(simpleTrackName({ name: 'Chords', role: 'pad' })).toBe('Chords');
    expect(simpleTrackName({ name: 'My lead', role: 'lead' })).toBe('My lead');
    expect(trackNameIn({ name: 'Lead', role: 'lead' }, 'advanced')).toBe('Lead');
    expect(trackNameIn({ name: 'Lead', role: 'lead' }, 'simple')).toBe('Melody');
    expect(instrumentName('Lead', 'lead')).toBe('Melody');
    expect(instrumentName('Lead', 'lead', true)).toBe('Lead');
  });

  it('renaming to an old default name works and shows: the part is marked renamed, in one undo step', () => {
    const store = new ProjectStore(house());
    const lead = byRole(store.getState(), 'lead');
    expect(lead.name).toBe('Lead');
    expect(simpleTrackName(lead)).toBe('Melody');
    // The person types "Lead" in the Sound panel's name field.
    expect(renameTrack(store, lead.id, 'Lead').changed).toBe(true);
    const after = store.getState().tracks.find((t) => t.id === lead.id)!;
    expect(after.name).toBe('Lead');
    expect(after.renamed).toBe(true);
    expect(simpleTrackName(after)).toBe('Lead');
    store.undo();
    const back = store.getState().tracks.find((t) => t.id === lead.id)!;
    expect(back.renamed).toBeUndefined();
    expect(simpleTrackName(back)).toBe('Melody');
  });

  it('the renamed mark survives a save and load; anything but true is dropped', () => {
    const store = new ProjectStore(house());
    const lead = byRole(store.getState(), 'lead');
    renameTrack(store, lead.id, 'Lead');
    const r = validateProject(structuredClone(store.getState()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.tracks.find((t) => t.id === lead.id)!.renamed).toBe(true);
    const raw = structuredClone(house()) as unknown as { tracks: Record<string, unknown>[] };
    raw.tracks[0].renamed = 'yes';
    const r2 = validateProject(raw);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect('renamed' in r2.project.tracks[0]).toBe(false);
  });

  it('Share’s files name instruments as Simple does (per-instrument files, MIDI track names); the project keeps its names', () => {
    const p = house();
    const shown = withShownNames(p, 'simple');
    expect(p.tracks.map((t) => t.name)).toContain('Lead');
    const parts = stemParts(shown, { kind: 'song' });
    const names = stemFileNames(parts.map((x) => ({ name: x.name, index: shown.tracks.findIndex((t) => t.id === x.trackId) })), 'wav');
    expect(names.join(' ')).not.toMatch(/\b(Lead|Chords|Sampler)\.wav/);
    expect(names.some((n) => /Keys & chords\.wav$/.test(n))).toBe(true);
    const mid = new TextDecoder('latin1').decode(songMidi(shown, { kind: 'song' })!);
    expect(mid).toContain('Keys & chords');
    expect(mid).not.toMatch(/\x03\x06Chords/);
    // Advanced: the stored names, and the same project object.
    expect(withShownNames(p, 'advanced')).toBe(p);
  });
});

describe('drum sounds in plain words (Simple)', () => {
  it('the list: drummer’s shorthand becomes everyday words', () => {
    expect(simpleDrumName('Rim')).toBe('Rim click');
    expect(simpleDrumName('Low Tom')).toBe('Low drum');
    expect(simpleDrumName('Crash')).toBe('Crash cymbal');
    expect(simpleDrumName('Open Hat')).toBe('Open hi-hat');
    expect(simpleDrumName('Closed Hat')).toBe('Closed hi-hat');
    expect(simpleDrumName('Kick')).toBe('Kick');
    expect(simpleDrumName('Snare')).toBe('Snare');
    for (const [from, to] of Object.entries(SIMPLE_DRUM_WORDS)) expect(to, from).not.toBe(from);
  });

  it('every kit’s main eight sounds read without “Hat”, “Tom”, a bare “Crash” or “Ride”, or a number for a name; Advanced keeps the kit’s names', () => {
    for (const k of KITS) {
      const kit = getKitVoiceNames(k.id);
      const plain = drumNamesIn(kit, 'simple');
      for (const v of CORE_VOICES) {
        expect(plain[v], `${k.id} ${kit[v]}`).not.toMatch(/\b(Hat|Tom|Toms)\b|^(Crash|Ride|Perc|\d+)$/);
        expect(avoidedWords(plain[v]), `${k.id} ${plain[v]}`).toEqual([]);
      }
      expect(drumNamesIn(kit, 'advanced')).toEqual(kit);
    }
  });

  it('Every setting’s drum knobs say Hi-hats and plain voice names', () => {
    expect(drumMixGroups('tight-circuit', new Map()).map((g) => g.label)).toEqual(['Kick', 'Snare & clap', 'Hi-hats']);
    const one = drumMixGroups('tight-circuit', new Map([[4, 8]]));
    expect(one.map((g) => g.label)).toEqual(['Closed hi-hat']);
  });
});

describe('editor and song words', () => {
  it('a loop used in several places says "3 places" on its region in Simple, "Used 3×" in Advanced', () => {
    expect(placesBadge(3, true)).toBe('3 places');
    expect(placesBadge(3)).toBe('Used 3×');
    expect(placesBadge(1, true)).toBeNull();
  });
});

describe('file names keep every script', () => {
  it('the project file keeps letters of any script and drops what file systems refuse', () => {
    expect(bundleFileName({ name: '歌' })).toBe(`歌${BUNDLE_EXTENSION}`);
    expect(bundleFileName({ name: 'Песня 2' })).toBe(`Песня-2${BUNDLE_EXTENSION}`);
    expect(bundleFileName({ name: 'Café' })).toBe(`Café${BUNDLE_EXTENSION}`);
    expect(bundleFileName({ name: 'name.' })).toBe(`name${BUNDLE_EXTENSION}`);
    expect(bundleFileName({ name: 'a\tb\u0007c' })).toBe(`a-bc${BUNDLE_EXTENSION}`);
    expect(bundleFileName({ name: 'Night Drive / v2?' })).toBe(`Night-Drive-v2${BUNDLE_EXTENSION}`);
    expect(bundleFileName({ name: '///' })).toBe(`omni-song-project${BUNDLE_EXTENSION}`);
  });

  it('a music file name drops control characters and a trailing dot', () => {
    expect(safeName('歌')).toBe('歌');
    expect(safeName('name.')).toBe('name');
    expect(safeName('a\u0000b')).toBe('a b');
    expect(safeName('My: song / test?')).toBe('My song test');
    expect(nameLosesCharacters('name.')).toBe(true);
    expect(nameLosesCharacters('a\u0001b')).toBe(true);
    expect(nameLosesCharacters('歌 1')).toBe(false);
  });
});
