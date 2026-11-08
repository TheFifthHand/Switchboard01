/**
 * An instrument's name as the current interface mode shows it (round 7):
 * Simple calls it by the picker's word until it is renamed ("Lead" →
 * "Melody"), Advanced by its stored name (see trackNameIn in labels.ts).
 * One place, so the rows, the editor, ● Record, ⋯, the sheets and the
 * messages all say the same name.
 */
import type { Id, Track } from '../../project/types';
import { useProject, useUi } from '../instance';
import { trackNameIn } from '../labels';

/** The current mode's name for `trackId`, or `fallback` when there is no such instrument. */
export function useInstrumentName(trackId: Id | null | undefined, fallback = ''): string {
  const mode = useUi((s) => s.uiMode);
  return useProject((p) => {
    const t = trackId ? p.tracks.find((x) => x.id === trackId) : undefined;
    return t ? trackNameIn(t, mode) : fallback;
  });
}

/** A function naming any instrument the current mode's way (re-renders when the mode changes). */
export function useNameOf(): (t: Pick<Track, 'name' | 'role' | 'renamed'>) => string {
  const mode = useUi((s) => s.uiMode);
  return (t) => trackNameIn(t, mode);
}

export { nameNow } from './shownName';
