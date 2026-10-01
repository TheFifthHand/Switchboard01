/**
 * When the browser fails to start MIDI for a reason of its own (Chrome on
 * Linux without ALSA says "Platform dependent initialization failed."), the
 * MIDI dialog gives plain advice instead of the browser's error text, and
 * Connect MIDI can be pressed again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MIDI_DENIED_MESSAGE, MIDI_FAILED_MESSAGE, MidiController, type MidiEnvironment, type MidiSessionApi } from '../../src/app/midi';
import { createProject } from '../../src/project/factory';
import { ProjectStore } from '../../src/state/projectStore';

const session = (): MidiSessionApi => ({
  store: new ProjectStore(createProject({ name: 'm', now: 1 })),
  engine: {},
  noteOn() {},
  noteOff() {},
  setPitchBend() {},
  setMacro() {},
  setModuleParam() {},
  setMasterVolume() {},
  setBpm() {},
  onAllNotesReleased: () => () => {},
});

const failing = (error: unknown) => (): MidiEnvironment => ({
  requestAccess: () => Promise.reject(error),
  secure: true,
  permission: async () => 'prompt',
  hasUserActivation: () => true,
});

let controllers: MidiController[] = [];
afterEach(() => {
  for (const c of controllers) c.dispose();
  controllers = [];
});

describe('MIDI that cannot start', () => {
  it('says what to do in plain words, without the browser’s error text', async () => {
    for (const error of [new DOMException('Platform dependent initialization failed.', 'AbortError'), new Error('Something else'), 'odd']) {
      const midi = new MidiController(session(), failing(error));
      controllers.push(midi);
      expect(await midi.connect()).toBe(false);
      const st = midi.state.getState();
      expect(st.status).toBe('error');
      expect(st.message).toBe(MIDI_FAILED_MESSAGE);
      expect(st.message).not.toMatch(/Platform|initialization|Something else|odd/);
    }
    expect(MIDI_FAILED_MESSAGE).toBe('Omni Song can’t reach MIDI on this computer. Check the keyboard is plugged in, use Chrome or Edge, then press Connect MIDI again.');
  });

  it('a blocked permission still says how to allow it', async () => {
    const midi = new MidiController(session(), failing(new DOMException('Permission denied', 'NotAllowedError')));
    controllers.push(midi);
    expect(await midi.connect()).toBe(false);
    expect(midi.state.getState()).toMatchObject({ status: 'denied', message: MIDI_DENIED_MESSAGE });
  });
});
