/**
 * Runs AudioWorklet processor sources in Node: the source string is
 * evaluated with stand-ins for AudioWorkletProcessor / registerProcessor /
 * sampleRate, and processors are driven block by block like the browser
 * does (128 frames, a-rate parameter arrays of length 1 for constants).
 */

export interface FakePort {
  messages: unknown[];
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(m: unknown): void;
}

interface ProcessorInstance {
  port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
}

interface ProcessorClass {
  new (options?: unknown): ProcessorInstance;
  parameterDescriptors?: { name: string; defaultValue: number }[];
}

export function loadProcessors(source: string, sampleRate: number): Map<string, ProcessorClass> {
  const registry = new Map<string, ProcessorClass>();
  class FakeProcessor {
    port: FakePort;
    constructor() {
      const port: FakePort = {
        messages: [],
        onmessage: null,
        postMessage(m: unknown) {
          port.messages.push(m);
        },
      };
      this.port = port;
    }
  }
  const run = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source) as (
    base: unknown,
    register: (name: string, cls: ProcessorClass) => void,
    sr: number,
  ) => void;
  run(FakeProcessor, (name, cls) => registry.set(name, cls), sampleRate);
  return registry;
}

export interface RunResult {
  L: Float32Array;
  R: Float32Array;
  processor: ProcessorInstance;
}

/**
 * Process stereo input through a new processor instance. `params` holds
 * constant values; `paramAt` can change a value from a frame on.
 */
export function runProcessor(
  cls: ProcessorClass,
  inputL: Float32Array,
  inputR: Float32Array = inputL,
  opts: { options?: unknown; params?: Record<string, number>; onBlock?: (frame: number, p: ProcessorInstance, params: Record<string, number>) => void } = {},
): RunResult {
  const proc = new cls(opts.options ?? {});
  const values: Record<string, number> = {};
  for (const d of cls.parameterDescriptors ?? []) values[d.name] = d.defaultValue;
  Object.assign(values, opts.params ?? {});
  const n = inputL.length;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let f = 0; f < n; f += 128) {
    opts.onBlock?.(f, proc, values);
    const len = Math.min(128, n - f);
    const inL = new Float32Array(128);
    const inR = new Float32Array(128);
    inL.set(inputL.subarray(f, f + len));
    inR.set(inputR.subarray(f, f + len));
    const outL = new Float32Array(128);
    const outR = new Float32Array(128);
    const p: Record<string, Float32Array> = {};
    for (const [k, v] of Object.entries(values)) p[k] = new Float32Array([v]);
    proc.process([[inL, inR]], [[outL, outR]], p);
    L.set(outL.subarray(0, len), f);
    R.set(outR.subarray(0, len), f);
  }
  return { L, R, processor: proc };
}

export function sine(n: number, freq: number, amp: number, sampleRate: number, phase = 0): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate + phase);
  return x;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function dbfs(db: number): number {
  return Math.pow(10, db / 20);
}
