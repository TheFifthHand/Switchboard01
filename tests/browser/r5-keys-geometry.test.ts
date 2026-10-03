/**
 * Every key is pressable where it is drawn, in the running app at 1024, 1366, 1536 and 1920 px
 * wide (round 5: "you can't press all the keys"). The middle of every key's visible area hits that
 * key (elementFromPoint) and a real mouse click there plays exactly that note.
 *
 * - The piano (Musical Assist off): each black key is centred on the line between its two white
 *   keys, about 60 % of a white key wide and at most 62 % of the keys tall, and every white key
 *   keeps at least 34 px to press below the black keys. A white key is clicked below the black
 *   keys and, where it shows between them, above too.
 * - The scale keyboard (Assist on): equal keys edge to edge, each its own note.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { setAssist } from '../../src/state/commands';
import { selectTrack, setKeyboardOctave } from '../../src/state/uiStore';
import { openApp, setUp, tearDown } from './r4-play-helpers';
import { click, settleFrames, type Pt } from './r4-uikit-input';
import { keyboard, recordPlayed, resetKeyboardFold, strip } from './r4-keys-helpers';

beforeEach(async () => {
  await setUp();
  resetKeyboardFold();
  act(() => setKeyboardOctave(4));
});
afterEach(async () => {
  await tearDown();
  resetKeyboardFold();
});

const WIDTHS = [
  { w: 1024, h: 768 },
  { w: 1366, h: 768 },
  { w: 1536, h: 864 },
  { w: 1920, h: 1080 },
] as const;

const keys = () => [...keyboard().querySelectorAll<HTMLElement>('[data-midi]')];
const isBlack = (k: HTMLElement) => /black/.test(k.className);

async function bass(w: number, h: number, assist: boolean): Promise<void> {
  await openApp(w, h);
  act(() => {
    selectTrack('t3');
    session.accepted(setAssist(session.store, assist));
  });
  await settleFrames(3);
  strip().scrollIntoView({ block: 'end' });
  await settleFrames(1);
}

/** The middle of what shows of each key: a black key's face; a white key below the black keys, and between them where it shows. */
function visiblePoints(all: HTMLElement[]): { key: HTMLElement; at: Pt; where: string }[] {
  const blacks = all.filter(isBlack).map((k) => k.getBoundingClientRect());
  const out: { key: HTMLElement; at: Pt; where: string }[] = [];
  for (const key of all) {
    const r = key.getBoundingClientRect();
    if (isBlack(key)) {
      out.push({ key, at: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, where: 'black face' });
      continue;
    }
    const over = blacks.filter((b) => b.right > r.left && b.left < r.right);
    const blackBottom = over.length ? Math.max(...over.map((b) => b.bottom)) : r.top;
    out.push({ key, at: { x: r.left + r.width / 2, y: (blackBottom + r.bottom) / 2 }, where: 'below the black keys' });
    if (!over.length) continue;
    // The strip of the white key that shows between its black neighbours.
    const left = Math.max(r.left, ...over.filter((b) => b.left < r.left).map((b) => b.right));
    const right = Math.min(r.right, ...over.filter((b) => b.right > r.right).map((b) => b.left));
    if (right - left >= 6) out.push({ key, at: { x: (left + right) / 2, y: (r.top + blackBottom) / 2 }, where: 'between the black keys' });
  }
  return out;
}

/** Every point hits its key (elementFromPoint), and a real click there plays that key's note. */
async function clickEvery(points: { key: HTMLElement; at: Pt; where: string }[]): Promise<void> {
  for (const p of points) {
    const hit = document.elementFromPoint(p.at.x, p.at.y)?.closest<HTMLElement>('[data-midi]');
    expect(hit?.dataset.note, `${p.key.dataset.note} ${p.where}`).toBe(p.key.dataset.note);
  }
  const rec = recordPlayed();
  try {
    for (const p of points) await click(p.at);
    expect(rec.ons().map((x) => x.pitch)).toEqual(points.map((p) => Number(p.key.dataset.midi)));
    expect(rec.played.filter((x) => !x.on)).toHaveLength(points.length);
  } finally {
    rec.restore();
  }
}

describe('the piano (Musical Assist off)', () => {
  for (const { w, h } of WIDTHS) {
    it(`${w} px: black keys centred between their white keys, 60 % wide, at most 62 % tall; 34 px of every white key below them; every key plays where it is drawn`, async () => {
      await bass(w, h, false);
      const all = keys();
      expect(all.length).toBeGreaterThanOrEqual(25);
      const byMidi = new Map(all.map((k) => [Number(k.dataset.midi), k]));
      for (const b of all.filter(isBlack)) {
        const m = Number(b.dataset.midi);
        const br = b.getBoundingClientRect();
        const lo = byMidi.get(m - 1)!.getBoundingClientRect();
        const hi = byMidi.get(m + 1)!.getBoundingClientRect();
        // The line between the two white keys, and the black key's centre on it.
        expect(Math.abs(lo.right - hi.left), b.dataset.note).toBeLessThan(1);
        expect(Math.abs(br.left + br.width / 2 - lo.right), b.dataset.note).toBeLessThan(1);
        expect(br.width / lo.width, b.dataset.note).toBeGreaterThan(0.56);
        expect(br.width / lo.width, b.dataset.note).toBeLessThan(0.64);
        expect(br.height / lo.height, b.dataset.note).toBeLessThanOrEqual(0.62);
        expect(Math.abs(br.top - lo.top)).toBeLessThan(0.5);
        for (const white of [lo, hi]) expect(white.bottom - br.bottom, b.dataset.note).toBeGreaterThanOrEqual(34);
      }
      const points = visiblePoints(all);
      // Every key is hit at least once; most white keys twice (below and between the black keys).
      expect(new Set(points.map((p) => p.key)).size).toBe(all.length);
      await clickEvery(points);
    });
  }
});

describe('the scale keyboard (Musical Assist on)', () => {
  for (const { w, h } of WIDTHS) {
    it(`${w} px: equal keys edge to edge, each a different note, each playing where it is drawn`, async () => {
      await bass(w, h, true);
      const all = keys();
      expect(all.some(isBlack)).toBe(false);
      expect(all.length).toBeGreaterThanOrEqual(15);
      expect(new Set(all.map((k) => k.dataset.midi)).size).toBe(all.length);
      for (const k of all) expect(k.getBoundingClientRect().width, k.dataset.note).toBeGreaterThanOrEqual(w >= 1366 ? 44 : 34);
      // The middle of each key, and near its left and right edges (no dead strip between keys).
      const points = all.flatMap((key) => {
        const r = key.getBoundingClientRect();
        return [0.5, 0.06, 0.94].map((fx) => ({ key, at: { x: r.left + r.width * fx, y: r.top + r.height * 0.55 }, where: `at ${fx * 100} % across` }));
      });
      await clickEvery(points);
    });
  }
});
