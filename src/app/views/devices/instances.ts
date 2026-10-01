/**
 * The app's MIDI and audio-input controllers (one each, bound to the app's
 * session) and store hooks for the views.
 */
import { useStore } from '../../../state/store';
import { AudioInputController, type AudioInputState } from '../../audioInput';
import { session } from '../../instance';
import { MidiController, type MidiState } from '../../midi';

export const midi = new MidiController(session);
export const audioInput = new AudioInputController(session);

export function useMidi<S>(selector: (s: MidiState) => S, equality?: (a: S, b: S) => boolean): S {
  return useStore(midi.state, selector, equality);
}

export function useAudioInput<S>(selector: (s: AudioInputState) => S, equality?: (a: S, b: S) => boolean): S {
  return useStore(audioInput.state, selector, equality);
}
