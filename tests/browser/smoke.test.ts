import { describe, expect, it } from 'vitest';

describe('browser test environment', () => {
  it('renders audio with a real OfflineAudioContext', async () => {
    const ctx = new OfflineAudioContext(2, 4800, 48000);
    const osc = ctx.createOscillator();
    osc.connect(ctx.destination);
    osc.start(0);
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0;
    for (const v of d) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.5);
  });
});
