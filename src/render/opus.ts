/**
 * "Smaller file for sharing": rendered audio → an Ogg Opus file, encoded on
 * this device by the browser's own Opus encoder (WebCodecs AudioEncoder; no
 * download, nothing leaves the device). Opus works at 48 kHz, so the audio
 * given here must be at 48 kHz. The Ogg container is written by ogg.ts.
 *
 * `opusSupported()` asks the browser first: the Export dialog offers the
 * format only where it can be made.
 */
import { oggOpus, preSkipOf, type OpusPacket } from './ogg';

export const OPUS_RATE = 48000;
/** About 1 MB a minute: transparent for most music, about a tenth of a 16-bit WAV. */
export const OPUS_BITRATE = 128_000;
/** The encoder's look-ahead at 48 kHz when it does not say (libopus: 6.5 ms). */
const DEFAULT_PRE_SKIP = 312;
/** Audio handed to the encoder per call, in frames (1 s). */
const SLICE = OPUS_RATE;

function config(channels: number): AudioEncoderConfig {
  return { codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: channels, bitrate: OPUS_BITRATE };
}

let support: Promise<boolean> | null = null;
let known: boolean | null = null;

/** True where this browser can encode stereo Opus at 48 kHz. */
export function opusSupported(): Promise<boolean> {
  support ??= (async () => {
    try {
      if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return false;
      const r = await AudioEncoder.isConfigSupported(config(2));
      return r.supported === true;
    } catch {
      return false;
    }
  })().then((ok) => (known = ok));
  return support;
}

/** The answer of opusSupported() once it is in (null until then). */
export function opusSupportKnown(): boolean | null {
  return known;
}

function abortError(): Error {
  return new DOMException('Encoding cancelled', 'AbortError');
}

/** Encode 48 kHz audio (one array per channel, 1 or 2) as an Ogg Opus file. */
export async function encodeOggOpus(channels: readonly Float32Array[], opts: { title?: string; signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<Uint8Array> {
  const nCh = Math.min(2, channels.length);
  if (!nCh) throw new RangeError('No audio to encode');
  const frames = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const packets: OpusPacket[] = [];
  let description: Uint8Array | null = null;
  let failure: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const d = meta?.decoderConfig?.description;
      if (d && !description) description = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array((d as ArrayBufferView).buffer.slice(0));
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      // An Opus packet is 2.5 to 120 ms; WebCodecs gives its duration in microseconds.
      const samples = chunk.duration ? Math.round((chunk.duration * OPUS_RATE) / 1e6) : 960;
      packets.push({ data, samples });
    },
    error: (e) => {
      failure = e;
    },
  });
  try {
    encoder.configure(config(nCh));
    for (let at = 0; at < frames; at += SLICE) {
      if (opts.signal?.aborted) throw abortError();
      if (failure) throw failure;
      const n = Math.min(SLICE, frames - at);
      const planar = new Float32Array(n * nCh);
      for (let ch = 0; ch < nCh; ch++) planar.set(channels[ch].subarray(at, at + n), ch * n);
      const data = new AudioData({ format: 'f32-planar', sampleRate: OPUS_RATE, numberOfFrames: n, numberOfChannels: nCh, timestamp: Math.round((at / OPUS_RATE) * 1e6), data: planar });
      encoder.encode(data);
      data.close();
      // Let the encoder catch up (and the page breathe) every few seconds of audio.
      if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
      opts.onProgress?.(Math.min(1, (at + n) / frames));
    }
    await encoder.flush();
    if (failure) throw failure;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  const comments = ['ENCODER=Omni Song', ...(opts.title ? [`TITLE=${opts.title}`] : [])];
  return oggOpus({ channels: nCh, preSkip: preSkipOf(description) ?? DEFAULT_PRE_SKIP, inputSampleRate: OPUS_RATE, frames, packets, vendor: 'Omni Song', comments });
}
