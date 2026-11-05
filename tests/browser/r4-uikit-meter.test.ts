/**
 * Meters in real Chromium: one drawn element per meter (a canvas), one shared animation-frame loop
 * that draws at most 30 times a second and sleeps once every meter is silent (no meter frames at
 * all when stopped), wakes by itself when sound comes back, a peak-hold number (coral above
 * −1 dBFS, a real click resets it), a custom scale (the fader taper) and the accessible value.
 */
import { createElement as h, Fragment } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/ui/theme.css';
import { Meter, faderPosition, meterWake } from '../../src/ui/components';
import { metersAwake } from '../../src/ui/components/meterScheduler';
import { CHANNEL_PARAMS, specById } from '../../src/project/params';
import { cleanup, frames, mount, wait } from './ui-harness';
import { centre, click } from './r4-uikit-input';

afterEach(cleanup);

const LEVEL = specById(CHANNEL_PARAMS, 'level')!;
const lin = (db: number) => 10 ** (db / 20);

/** Lit segments as drawn on a meter's canvas (from the bottom or the left), with their colours. */
function drawn(meter: Element): (string | null)[] {
  const canvas = meter.querySelector<HTMLCanvasElement>('canvas[data-meter-bar]')!;
  const n = Number(canvas.dataset.segments);
  const vertical = meter.getAttribute('data-orientation') === 'vertical';
  const ctx = canvas.getContext('2d')!;
  const len = vertical ? canvas.height : canvas.width;
  const gap = Math.max(1, Math.round(2 * devicePixelRatio));
  const pitch = (len + gap) / n;
  const off = getComputedStyle(meter).getPropertyValue('--seg-off').trim();
  return Array.from({ length: n }, (_, i) => {
    const mid = Math.floor(i * pitch + (pitch - gap) / 2);
    const px = vertical ? ctx.getImageData(Math.floor(canvas.width / 2), canvas.height - 1 - mid, 1, 1).data : ctx.getImageData(mid, Math.floor(canvas.height / 2), 1, 1).data;
    const hex = `#${[px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    return hex === off ? null : hex;
  });
}
const litCount = (meter: Element) => drawn(meter).filter(Boolean).length;

/** Count requestAnimationFrame calls made while `fn` runs. */
async function countRaf(ms: number): Promise<number> {
  const real = window.requestAnimationFrame;
  let calls = 0;
  window.requestAnimationFrame = (cb) => {
    calls += 1;
    return real.call(window, cb);
  };
  try {
    await wait(ms);
  } finally {
    window.requestAnimationFrame = real;
  }
  return calls;
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (cond()) return true;
    await wait(50);
  }
  return cond();
}

function strip(n: number, level: { v: number }, extra: Record<string, unknown> = {}) {
  return mount(
    h(
      'div',
      { style: { display: 'flex', gap: '10px', height: '260px' } },
      h(Fragment, null, ...Array.from({ length: n }, (_, i) => h(Meter, { key: i, read: () => level.v, label: `Part ${i + 1} meter`, orientation: 'vertical', thickness: 6, segments: 24, ...extra }))),
    ),
  );
}

describe('meters draw into one element each', () => {
  it('9 meters of 24 segments create 9 drawn elements, not 216 segment spans', async () => {
    const level = { v: 0.5 };
    const m = strip(9, level);
    await frames(4);
    const meters = [...m.container.querySelectorAll('[role="meter"]')];
    expect(meters).toHaveLength(9);
    expect(m.container.querySelectorAll('[data-meter-bar]')).toHaveLength(9);
    // Each meter is its canvas plus the clip lamp: nothing per segment.
    for (const meter of meters) expect(meter.querySelectorAll('*').length).toBe(2);
    // -6 dBFS on the default -48..0 scale: 42/48 of 24 segments = 21 lit.
    for (const meter of meters) expect(litCount(meter)).toBe(21);
    // No glow and a contained box.
    expect(getComputedStyle(meters[0]).contain).toBe('strict');
  });

  it('colours by level: amber, light amber from −12 dBFS, coral from −3 dBFS; the held peak keeps its segment', async () => {
    const level = { v: 1 };
    const m = strip(1, level);
    await frames(4);
    const meter = m.container.querySelector('[role="meter"]')!;
    const cs = getComputedStyle(meter);
    const hexOf = (name: string) => {
      const el = document.createElement('span');
      el.style.color = cs.getPropertyValue(name);
      document.body.append(el);
      const [r, g, b] = getComputedStyle(el).color.match(/\d+/g)!.map(Number);
      el.remove();
      return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    };
    const segs = drawn(meter);
    expect(segs.every(Boolean)).toBe(true);
    expect(segs[0]).toBe(hexOf('--amber'));
    expect(segs[19]).toBe(hexOf('--amber-hi')); // top edge -8 dB
    expect(segs[23]).toBe(hexOf('--coral')); // top edge 0 dB
    level.v = 0;
    await wait(800);
    // The level falls away (24 dB/s), the peak still holds its (coral) segment.
    const after = drawn(meter);
    expect(after[23]).toBe(hexOf('--coral'));
    expect(after.slice(0, 20).filter(Boolean).length).toBeLessThan(20);
  });
});

describe('one shared loop that sleeps', () => {
  it('draws at most 30 times a second, however often the level changes', async () => {
    // A level that climbs 3 dB at every read (one segment is 2 dB), so every frame shows something new.
    let k = 0;
    mount(h(Meter, { read: () => lin(-45 + 3 * (k++ % 15)), label: 'Busy meter', orientation: 'vertical', segments: 24, thickness: 6, length: 200 }));
    await frames(3);
    const proto = CanvasRenderingContext2D.prototype;
    const realClear = proto.clearRect;
    let draws = 0;
    proto.clearRect = function (...args: Parameters<CanvasRenderingContext2D['clearRect']>) {
      draws += 1;
      return realClear.apply(this, args);
    };
    try {
      await wait(1000);
    } finally {
      proto.clearRect = realClear;
    }
    expect(draws).toBeGreaterThan(10);
    expect(draws).toBeLessThanOrEqual(32);
  });

  it('when everything has decayed to the floor, no meter animation frames run at all; sound coming back wakes them', async () => {
    const level = { v: 0.8 };
    const m = strip(9, level);
    await frames(3);
    expect(metersAwake()).toBe(true);
    expect(await countRaf(300)).toBeGreaterThan(5);
    // Stopped: the levels fall (24 dB/s), the peaks after their hold, then the loop sleeps.
    level.v = 0;
    expect(await until(() => !metersAwake(), 6000)).toBe(true);
    const meters = [...m.container.querySelectorAll('[role="meter"]')];
    for (const meter of meters) expect(litCount(meter)).toBe(0);
    expect(meters[0].getAttribute('aria-valuetext')).toBe('Silent');
    expect(await countRaf(1000)).toBe(0);
    // Sound starts again without anyone calling meterWake (a MIDI note, a song after a silent bar).
    level.v = 0.5;
    expect(await until(() => litCount(meters[0]) > 0, 800)).toBe(true);
    expect(metersAwake()).toBe(true);
  });

  it('meterWake() starts the loop at once', async () => {
    const level = { v: 0 };
    strip(2, level);
    expect(await until(() => !metersAwake(), 3000)).toBe(true);
    meterWake();
    expect(metersAwake()).toBe(true);
    // And it sleeps again after half a second of silence.
    expect(await until(() => !metersAwake(), 2000)).toBe(true);
  });
});

describe('peak hold and scale', () => {
  it('shows the highest peak, coral above −1 dBFS; a real click resets it', async () => {
    const level = { v: lin(-6) };
    const m = mount(h('div', { style: { height: '240px', display: 'flex' } }, h(Meter, { read: () => level.v, label: 'Bass meter', orientation: 'vertical', segments: 24, thickness: 6, peakHold: true })));
    await frames(4);
    const hold = m.container.querySelector<HTMLButtonElement>('button[data-meter-hold]')!;
    expect(hold.textContent).toBe('−6.0');
    expect(hold.hasAttribute('data-hot')).toBe(false);
    expect(hold.getAttribute('aria-label')).toBe('Bass meter peak: −6.0 dB. Press to reset.');
    level.v = lin(-0.4);
    await frames(4);
    expect(hold.textContent).toBe('−0.4');
    expect(hold.hasAttribute('data-hot')).toBe(true);
    const coral = document.createElement('span');
    coral.style.color = 'var(--coral-ink)';
    document.body.append(coral);
    expect(getComputedStyle(hold).color).toBe(getComputedStyle(coral).color);
    coral.remove();
    expect(getComputedStyle(hold.firstElementChild!).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    // Quieter again: the number keeps the highest peak until it is reset.
    level.v = lin(-20);
    await frames(4);
    expect(hold.textContent).toBe('−0.4');
    // The press target is at least 32 x 32 px around the small number.
    const box = hold.getBoundingClientRect();
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(32);
    await click(centre(hold));
    await frames(4);
    expect(hold.textContent).toBe('−20.0');
    expect(hold.hasAttribute('data-hot')).toBe(false);
  });

  it('a strip meter can use the fader taper, so a level lines up with the fader marks', async () => {
    const level = { v: lin(-16) };
    const taper = (db: number) => faderPosition(LEVEL, db);
    const m = mount(h('div', { style: { display: 'flex', gap: '10px', height: '260px' } }, h(Meter, { read: () => level.v, label: 'Taper', orientation: 'vertical', segments: 24, scale: taper }), h(Meter, { read: () => level.v, label: 'Linear', orientation: 'vertical', segments: 24 })));
    await frames(4);
    const [tapered, linear] = [...m.container.querySelectorAll('[role="meter"]')];
    expect(litCount(tapered)).toBe(Math.ceil(faderPosition(LEVEL, -16) * 24 - 1e-9));
    expect(litCount(linear)).toBe(Math.ceil(((48 - 16) / 48) * 24 - 1e-9));
    expect(litCount(tapered)).not.toBe(litCount(linear));
  });

  it('is a meter for assistive technology: dB value, clipping in the value text, no stray text', async () => {
    const level = { v: 1.2 };
    const m = mount(h(Meter, { read: () => level.v, label: 'Master left level', segments: 20 }));
    await frames(3);
    await wait(300);
    const meter = m.container.querySelector('[role="meter"]')!;
    expect(meter.getAttribute('aria-label')).toBe('Master left level');
    expect(meter.getAttribute('aria-valuetext')).toMatch(/^\d+ dB, clipping$/);
    expect(meter.textContent).toBe('');
    expect(meter.querySelector('[data-meter-clip]')!.getAttribute('data-on')).toBe('1');
  });

  it('the clip lamp is its own cap, a gap beyond the bar: an outline while off, white-hot in a coral ring when lit', async () => {
    const quiet = { v: lin(-12) };
    const loud = { v: 1.2 };
    const m = mount(
      h(
        'div',
        { style: { display: 'flex', gap: '10px', height: '240px' } },
        h(Meter, { read: () => quiet.v, label: 'Quiet', orientation: 'vertical', segments: 24, thickness: 6 }),
        h(Meter, { read: () => loud.v, label: 'Loud', orientation: 'vertical', segments: 24, thickness: 6 }),
      ),
    );
    await frames(4);
    await wait(200);
    const [off, on] = [...m.container.querySelectorAll('[role="meter"]')].map((meter) => ({
      lamp: meter.querySelector<HTMLElement>('[data-meter-clip]')!,
      bar: meter.querySelector<HTMLElement>('canvas[data-meter-bar]')!,
    }));
    const colour = (css: string) => {
      const el = document.createElement('span');
      el.style.color = css;
      document.body.append(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    };
    for (const { lamp, bar } of [off, on]) {
      // Above the bar with clear space between: a cap, not one more segment.
      expect(bar.getBoundingClientRect().top - lamp.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(3);
    }
    expect(off.lamp.dataset.on).toBe('0');
    const offStyle = getComputedStyle(off.lamp);
    expect(offStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(offStyle.backgroundImage).toBe('none');
    expect(offStyle.boxShadow).toMatch(/inset/);
    expect(on.lamp.dataset.on).toBe('1');
    const onStyle = getComputedStyle(on.lamp);
    // White at its centre (not the flat coral of the top segments), ringed in deep coral.
    expect(onStyle.backgroundImage).toMatch(/^radial-gradient\(.*rgb\(255, 255, 255\)/);
    expect(onStyle.boxShadow).toContain(colour('var(--coral-key)'));
    expect(onStyle.boxShadow).toMatch(/inset/);
  });
});
