/**
 * Blank project: eight parts with their default sounds, balanced faders, no
 * clips and an empty arrangement, ready for someone who wants to start from
 * nothing.
 */
import { ROLE_DEFAULT_SOUND, createProject } from '../../project/factory';
import type { TrackRole } from '../../project/types';
import { assignSound, setChannel, starterSeed } from './dsl';
import type { StarterDef } from './index';

/** Faders that let freshly written parts sit together without mixing first. */
const BLANK_LEVELS: Record<TrackRole, number> = {
  drums: -3,
  percussion: -8,
  bass: -4,
  chords: -8,
  lead: -9,
  pad: -11,
  texture: -15,
  sampler: -10,
};

export const BLANK: StarterDef = {
  id: 'blank',
  name: 'Blank',
  bpm: 120,
  key: 'C minor',
  description: 'Eight empty parts with ready-to-play sounds, for starting from scratch.',
  build() {
    const project = createProject({ name: 'Blank Project', bpm: 120 });
    project.starterId = 'blank';
    project.seed = starterSeed('blank');
    project.root = 0;
    project.scale = 'minor';
    for (const track of project.tracks) {
      assignSound(project, track.id, ROLE_DEFAULT_SOUND[track.role]);
      setChannel(project, track.id, { level: BLANK_LEVELS[track.role], pan: 0 });
    }
    project.arrangement = { blocks: [], tailSeconds: 3 };
    return project;
  },
};
