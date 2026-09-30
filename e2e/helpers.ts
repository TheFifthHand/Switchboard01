import { expect, type Page } from '@playwright/test';

/** Open the app in a fresh profile and wait for the Jump In card. */
export async function openFresh(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  (page as Page & { __errors?: string[] }).__errors = errors;
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Jump In' })).toBeVisible();
}

export function pageErrors(page: Page): string[] {
  return (page as Page & { __errors?: string[] }).__errors ?? [];
}

export async function jumpIn(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Jump In' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__switchboard.runtime.getState().playing), { timeout: 10_000 }).toBe(true);
}

/** Highest master peak seen over `ms` of real playback. */
export async function masterPeakOver(page: Page, ms: number): Promise<{ peak: number; rms: number }> {
  return page.evaluate(async (ms) => {
    const sb = (window as any).__switchboard;
    let peak = 0;
    let rms = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      const m = sb.meters();
      peak = Math.max(peak, m.masterPeakL, m.masterPeakR);
      rms = Math.max(rms, m.masterRms);
      await new Promise((r) => setTimeout(r, 30));
    }
    return { peak, rms };
  }, ms);
}

export async function runtime<T = any>(page: Page, fn: string): Promise<T> {
  return page.evaluate((src) => new Function('rt', `return (${src})(rt)`)((window as any).__switchboard.runtime.getState()), fn);
}

export function parseWavHeader(buf: Buffer): { channels: number; sampleRate: number; bitDepth: number; frames: number; dataOffset: number } {
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bitDepth: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      expect(buf.readUInt16LE(off + 8)).toBe(1); // PCM
      fmt = { channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bitDepth: buf.readUInt16LE(off + 22) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('data before fmt');
      const frames = size / (fmt.channels * (fmt.bitDepth / 8));
      return { ...fmt, frames, dataOffset: off + 8 };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

/** Peak and RMS of a 16-bit PCM WAV body. */
export function wavStats16(buf: Buffer, dataOffset: number, frames: number, channels: number): { peak: number; rms: number; finite: boolean } {
  let peak = 0;
  let sum = 0;
  const n = frames * channels;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(dataOffset + i * 2) / 32768;
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, n)), finite: Number.isFinite(sum) };
}
