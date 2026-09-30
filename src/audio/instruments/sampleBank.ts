/**
 * Decoded sample buffers for the sampler: imported recordings (added by
 * the persistence/import layer) and built-in samples. Built-in ids
 * ("builtin:...") are synthesised on first use by the original DSP in
 * ./builtinSamples at the bank's sample rate and cached; nothing is
 * downloaded.
 */
import { builtinSampleInfo } from '../../content/catalog';
import type { SampleProvider } from '../contracts';
import { generateBuiltinSample } from './builtinSamples';

const BUILTIN_PREFIX = 'builtin:';
/** AudioBuffer sample-rate range every browser accepts. */
const MIN_BUFFER_RATE = 8000;
const MAX_BUFFER_RATE = 192000;

/**
 * An AudioBuffer holding `channels` (at least one channel and one frame;
 * shorter channels are zero-padded, non-finite samples become 0).
 */
export function audioBufferFromChannels(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const rate = Number.isFinite(sampleRate) ? Math.min(MAX_BUFFER_RATE, Math.max(MIN_BUFFER_RATE, Math.round(sampleRate))) : 48000;
  const numberOfChannels = Math.max(1, Math.min(32, channels.length));
  let length = 1;
  for (const c of channels) length = Math.max(length, c.length);
  const buffer = new AudioBuffer({ length, numberOfChannels, sampleRate: rate });
  for (let ch = 0; ch < Math.min(numberOfChannels, channels.length); ch++) {
    const src = channels[ch];
    const dst = buffer.getChannelData(ch);
    dst.set(src);
    for (let i = 0; i < src.length; i++) if (!Number.isFinite(dst[i])) dst[i] = 0;
  }
  return buffer;
}

export class SampleBank implements SampleProvider {
  private readonly buffers = new Map<string, AudioBuffer>();
  /** Built-in ids the generator does not know (avoids retrying on every note). */
  private readonly missing = new Set<string>();

  constructor(private readonly sampleRate: number) {}

  /** Register (or replace) a decoded buffer under an id. */
  add(id: string, buffer: AudioBuffer): void {
    this.buffers.set(id, buffer);
    this.missing.delete(id);
  }

  remove(id: string): void {
    this.buffers.delete(id);
    this.missing.delete(id);
  }

  /** True if `get(id)` can supply a buffer (loaded, or a known built-in id). */
  has(id: string): boolean {
    if (this.buffers.has(id)) return true;
    return id.startsWith(BUILTIN_PREFIX) && !this.missing.has(id) && builtinSampleInfo(id) !== undefined;
  }

  get(id: string): AudioBuffer | null {
    const hit = this.buffers.get(id);
    if (hit) return hit;
    if (!id.startsWith(BUILTIN_PREFIX) || this.missing.has(id)) return null;
    const generated = generateBuiltinSample(id, this.sampleRate);
    if (!generated || generated.channels.length === 0) {
      this.missing.add(id);
      return null;
    }
    const buffer = audioBufferFromChannels(generated.channels, generated.sampleRate);
    this.buffers.set(id, buffer);
    return buffer;
  }
}
