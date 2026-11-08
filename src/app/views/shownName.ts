/**
 * An instrument's name as the current interface mode shows it, outside React
 * (messages, file names): Simple's picker word until renamed ("Lead" →
 * "Melody"), Advanced's stored name. Pure but for reading the mode; the
 * hooks are in useInstrumentName.ts.
 */
import type { Track } from '../../project/types';
import { uiStore } from '../../state/uiStore';
import { trackNameIn } from '../labels';

export function nameNow(t: Pick<Track, 'name' | 'role' | 'renamed'>): string {
  return trackNameIn(t, uiStore.getState().uiMode);
}
