/**
 * The curated starter projects (PRODUCT_BRIEF.md section 5) and the blank
 * project. Each starter builds a complete, editable Project: eight parts with
 * designed sounds and balanced levels, four musical scenes and a song
 * arrangement. Jump In loads House and launches its Groove row immediately.
 * The first eight are the product brief's electronic styles; the five after
 * them (round 6) are for beat makers: Trap, Lo-fi Hip Hop, Pop, Afrobeats
 * and Boom Bap.
 */
import type { Project } from '../../project/types';
import { AFROBEATS } from './afrobeats';
import { AMBIENT } from './ambient';
import { BLANK } from './blank';
import { BOOM_BAP } from './boomBap';
import { BREAKBEAT } from './breakbeat';
import { DOWNTEMPO } from './downtempo';
import { DRUM_AND_BASS } from './drumAndBass';
import { GARAGE } from './garage';
import { HOUSE } from './house';
import { LOFI } from './lofi';
import { POP } from './pop';
import { SYNTHWAVE } from './synthwave';
import { TECHNO } from './techno';
import { TRAP } from './trap';

export interface StarterDef {
  id: string;
  name: string;
  bpm: number;
  /** e.g. 'A minor' */
  key: string;
  /** One friendly sentence. */
  description: string;
  build(): Project;
}

/** The eight starters in the order of the product brief, then the five beat-maker starters. */
export const STARTERS: StarterDef[] = [HOUSE, SYNTHWAVE, AMBIENT, TECHNO, BREAKBEAT, DRUM_AND_BASS, DOWNTEMPO, GARAGE, TRAP, LOFI, POP, AFROBEATS, BOOM_BAP];

export const BLANK_STARTER: StarterDef = BLANK;

/** Jump In loads this starter ... */
export const JUMP_IN_STARTER_ID = 'house';
/** ... and launches this scene row (House 'Groove': drums, percussion, bass and chords). */
export const JUMP_IN_SCENE_ROW = 1;

/** A starter (or the blank project) by id. */
export function getStarter(id: string): StarterDef | undefined {
  if (id === BLANK_STARTER.id) return BLANK_STARTER;
  return STARTERS.find((s) => s.id === id);
}
