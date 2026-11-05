/**
 * Blank project: eight parts with their default sounds, balanced faders, no
 * clips and an empty song, ready for someone who wants to start from
 * nothing.
 */
import { kitInfo } from '../catalog';
import { ROLE_DEFAULT_SOUND, createProject } from '../../project/factory';
import type { TrackRole } from '../../project/types';
import { assignSound, keyLabel, setChannel, setInstrumentParams, starterGainStaging, starterSeed } from './dsl';
import type { StarterDef } from './index';

/**
 * Faders (dB) that let freshly written parts sit together without mixing
 * first. Like the starters, the synthesized kits are trimmed at the source
 * (they play 10-13 dB hotter than the synth presets): each kit plays at its
 * matched Level (catalog KitInfo.level). The values come from offline renders
 * of typical first parts (a four-on-the-floor beat, a bass line, chord stabs,
 * a lead line, a sustained pad) measured against the drums with the same
 * loudness targets the starters use.
 */
const BLANK_LEVELS: Record<TrackRole, number> = {
  drums: -3,
  percussion: -8,
  bass: -7,
  chords: -3.5,
  lead: -1,
  pad: -5,
  texture: -10,
  sampler: -9,
};

export const BLANK: StarterDef = {
  id: 'blank',
  name: 'Blank',
  bpm: 120,
  key: keyLabel(0, 'minor'),
  description: 'Eight empty parts with ready-to-play sounds, for starting from scratch.',
  build() {
    const project = createProject({ name: 'Blank project', bpm: 120 });
    project.starterId = 'blank';
    project.seed = starterSeed('blank');
    project.root = 0;
    project.scale = 'minor';
    // The balance was set against a master at -3 dB; like the starters, that level goes onto the faders.
    const { channelLiftDb, masterDb } = starterGainStaging(project.masterVolumeDb, project.tracks.map((t) => BLANK_LEVELS[t.role]));
    project.masterVolumeDb = masterDb;
    for (const track of project.tracks) {
      assignSound(project, track.id, ROLE_DEFAULT_SOUND[track.role]);
      const kit = track.instrument.kind === 'drums' ? kitInfo(track.instrument.kitId) : undefined;
      if (kit) setInstrumentParams(project, track.id, { level: kit.level });
      setChannel(project, track.id, { level: BLANK_LEVELS[track.role] + channelLiftDb, pan: 0 });
    }
    project.arrangement = { regions: [], sections: [], tailSeconds: 3 };
    return project;
  },
};
