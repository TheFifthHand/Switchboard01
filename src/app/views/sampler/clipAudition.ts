/**
 * Audition of a clip's own recording (capability-01).
 *
 * The session's preview keys (NoteSource 'preview') play the part's own
 * recording; a clip that plays a recording of its own is heard through the
 * engine's per-note recording instead (NoteTrigger.sample), exactly as its
 * notes play it: through the part's instrument settings and effects, the
 * master chain and the limiter. Like a preview it skips Musical Assist, the
 * arpeggiator and recording; Stop and Mute All end it as they end every
 * voice.
 */
import type { ClipSample, Id } from '../../../project/types';
import { meterWake } from '../../../ui/components';
import { session } from '../../instance';

export interface ClipAuditionVoice {
  /** True once the sound has ended (by itself, Stop, Mute All). */
  readonly ended: boolean;
  /** Let go now. */
  stop(): void;
}

/**
 * Play `sample` on a sampler part at `pitch` for `seconds` (a one-shot plays
 * its whole region whatever the length). Null when there is no audio engine
 * yet or the recording could not be loaded.
 */
export async function auditionClipSample(trackId: Id, pitch: number, velocity: number, sample: ClipSample, seconds: number): Promise<ClipAuditionVoice | null> {
  const engine = session.engine;
  const ctx = session.ctx;
  if (!engine || !ctx) return null;
  // The recording is normally loaded already (the session loads clip recordings ahead).
  await engine.preloadSamples([sample.id]).catch(() => undefined);
  if (session.engine !== engine) return null;
  session.transport?.restoreSongGain();
  meterWake();
  const voice = engine.scheduleNote(trackId, { pitch, velocity, time: ctx.currentTime + 0.005, duration: Math.max(0.05, seconds), sample: { ...sample } });
  if (!voice) return null;
  return {
    get ended() {
      return voice.ended;
    },
    stop() {
      const t = ctx.currentTime;
      if (voice.stop) voice.stop(t);
      else voice.release(t);
    },
  };
}
