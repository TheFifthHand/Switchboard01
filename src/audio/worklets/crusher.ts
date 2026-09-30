/**
 * Bit crusher AudioWorklet processor ('sb-crusher'), shipped as a source
 * string so the engine can load it from a Blob URL with
 * `ctx.audioWorklet.addModule` (no separate asset, works offline and in
 * OfflineAudioContext renders).
 *
 * AudioParams (all a-rate, so smoothed automation stays click-free):
 *  - bits        2..16  quantiser resolution; fractional values give
 *                       intermediate step sizes. Mid-tread rounding keeps
 *                       silence silent.
 *  - downsample  1..32  sample-and-hold factor (sample-rate reduction);
 *                       fractional factors hold for a varying 1-2 frames.
 *  - mix         0..1   dry/wet blend inside the processor.
 *
 * Stereo in, stereo out; both channels are sampled on the same frames. The
 * processor keeps itself alive until the node posts 'dispose'.
 */

export const CRUSHER_PROCESSOR_NAME = 'sb-crusher';

export const CRUSHER_WORKLET_SOURCE = `
class SbCrusherProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 16, minValue: 2, maxValue: 16, automationRate: 'a-rate' },
      { name: 'downsample', defaultValue: 1, minValue: 1, maxValue: 32, automationRate: 'a-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
    ];
  }

  constructor() {
    super();
    this.alive = true;
    this.remaining = 0;
    this.held = [0, 0];
    this.lastBits = -1;
    this.levels = 32768;
    this.port.onmessage = (e) => {
      if (e.data === 'dispose') this.alive = false;
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const input = inputs[0];
    const frames = output[0].length;
    const bitsP = parameters.bits;
    const dsP = parameters.downsample;
    const mixP = parameters.mix;
    const channels = Math.min(2, output.length);
    if (!input || input.length === 0) {
      for (let c = 0; c < channels; c++) output[c].fill(0);
      this.held[0] = 0;
      this.held[1] = 0;
      this.remaining = 0;
      return this.alive;
    }
    const inL = input[0];
    const inR = input.length > 1 ? input[1] : input[0];
    const outL = output[0];
    const outR = channels > 1 ? output[1] : null;
    for (let i = 0; i < frames; i++) {
      let bits = bitsP.length > 1 ? bitsP[i] : bitsP[0];
      let ds = dsP.length > 1 ? dsP[i] : dsP[0];
      let mix = mixP.length > 1 ? mixP[i] : mixP[0];
      bits = bits >= 2 ? (bits <= 16 ? bits : 16) : 2;
      ds = ds >= 1 ? (ds <= 32 ? ds : 32) : 1;
      mix = mix >= 0 ? (mix <= 1 ? mix : 1) : 0;
      if (bits !== this.lastBits) {
        this.lastBits = bits;
        this.levels = Math.pow(2, bits - 1);
      }
      // Sample-and-hold: take a new sample every ds frames (on average).
      if (this.remaining > ds) this.remaining = ds;
      if (this.remaining <= 0) {
        this.held[0] = inL[i];
        this.held[1] = inR[i];
        this.remaining += ds;
      }
      this.remaining -= 1;
      const L = this.levels;
      const xl = inL[i];
      const ql = Math.round(this.held[0] * L) / L;
      outL[i] = xl + mix * (ql - xl);
      if (outR) {
        const xr = inR[i];
        const qr = Math.round(this.held[1] * L) / L;
        outR[i] = xr + mix * (qr - xr);
      }
    }
    return this.alive;
  }
}

try {
  registerProcessor('${CRUSHER_PROCESSOR_NAME}', SbCrusherProcessor);
} catch (e) {
  // Already registered in this context (module loaded twice): keep the first.
}
`;

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** Load the crusher processor into a context once (Blob URL, no network). */
export function loadCrusherWorklet(ctx: BaseAudioContext): Promise<void> {
  const existing = loaded.get(ctx);
  if (existing) return existing;
  const url = URL.createObjectURL(new Blob([CRUSHER_WORKLET_SOURCE], { type: 'text/javascript' }));
  const p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
  loaded.set(ctx, p);
  return p;
}
