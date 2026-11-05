/**
 * The Export dialog opens on the whole song whenever the song has loops, in
 * any view ("The whole song (0:10)"), else on the selected scene; it never
 * opens on a choice that cannot be exported. With a song loop set it offers
 * the loop (its bars once, with the tail), and its duration is the loop's
 * bars plus the tail. It offers every scene the project has (1 to 8).
 */
import '../../src/ui/theme.css';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { ExportDialog } from '../../src/app/views/ExportDialog';
import { createClip, createProject } from '../../src/project/factory';
import type { Project } from '../../src/project/types';
import { selectSlot, selectTrack, setView } from '../../src/state/uiStore';
import { cleanup, mount } from './ui-harness';

/** 120 BPM, four one-bar clips; the song plays them over bars 1, 2–3, 4 and 5 (2 s per bar). */
function song(): Project {
  const p = createProject({ bpm: 120, now: 0 });
  for (const t of p.tracks) t.clips = t.clips.map(() => null);
  for (let row = 0; row < 4; row++) p.tracks[0].clips[row] = createClip(`r${row}`, 1, [{ tick: 0, pitch: 36, duration: 48, velocity: 0.9 }]);
  const at = [[0, 1], [1, 2], [3, 1], [4, 1]];
  p.arrangement = { tailSeconds: 2, sections: [], regions: at.map(([start, bars], row) => ({ id: `r${row}`, trackId: 't1', clipId: p.tracks[0].clips[row]!.id, start, bars, offset: 0 })) };
  return p;
}

const reset = () => patchRuntime({ playing: false, paused: false, mode: 'live', songLoop: null, songLooping: false, recording: 'off' });

beforeEach(() => {
  session.store.replace(song(), { resetHistory: true });
  selectTrack('t1');
  reset();
});
afterEach(() => {
  cleanup();
  reset();
  setView('play');
});

function open() {
  const m = mount(h(ExportDialog, { open: true, onClose: () => {} }), { width: 900 });
  const select = () => document.querySelector<HTMLSelectElement>('select')!;
  const summary = () => [...document.querySelectorAll('p')].map((p) => p.textContent ?? '').find((t) => t.startsWith('Duration')) ?? '';
  return { m, select, summary, labels: () => [...select().options].map((o) => o.textContent) };
}

describe('What the Export dialog offers', () => {
  it('opened in the Song view it offers the whole song, named with its length, from bar 1 to its end', () => {
    setView('arrange');
    const d = open();
    expect(d.select().value).toBe('song');
    expect(d.labels()).toContain('The whole song (0:10)');
    expect(d.summary()).toContain('Duration 12.0 s (10.0 s of music + 2 s tail)');
  });

  it('opened anywhere while the song plays (or is paused) it offers the song', () => {
    setView('play');
    patchRuntime({ playing: false, paused: true, mode: 'song' });
    expect(open().select().value).toBe('song');
  });

  it('in Play, stopped, it opens on the whole song too when the song has loops (never on a choice that cannot be exported)', () => {
    setView('play');
    const d = open();
    expect(d.select().value).toBe('song');
    // Nothing plays: "the loops playing now" is not offered (it would export silence).
    expect(d.labels().some((l) => l?.startsWith('The loops playing now'))).toBe(false);
  });

  it('with no loops in the song it opens on the selected scene, or the first scene with loops', () => {
    const p = song();
    p.arrangement.regions = [];
    act(() => session.store.replace(p, { resetHistory: true }));
    act(() => selectSlot('t1', 2));
    expect(open().select().value).toBe('scene:2');
    cleanup();
    act(() => selectSlot('t1', 3));
    const q = session.store.getState();
    act(() => session.store.replace({ ...q, tracks: q.tracks.map((t, i) => (i === 0 ? { ...t, clips: t.clips.map((c, r) => (r === 3 ? null : c)) } : t)) }, { resetHistory: true }));
    expect(open().select().value).toBe('scene:0');
  });

  it('offers every scene of the project, in words: 8 scenes give 8 choices, 2 scenes give 2', () => {
    setView('play');
    for (const names of [['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], ['Intro', 'Drop']]) {
      act(() => session.store.replace(createProject({ scenes: names, now: 0 }), { resetHistory: true }));
      const d = open();
      const scenes = d.labels().filter((l) => l?.startsWith('Scene '));
      expect(scenes.map((l) => l!.replace(/ \(\d+:\d\d\)$/, ''))).toEqual(names.map((n) => `Scene “${n}”, looped`));
      cleanup();
    }
  });

  it('with a loop set: the looped part of the song exports those bars once with the tail; cleared, the song again', () => {
    setView('arrange');
    patchRuntime({ songLoop: { fromBar: 1, toBar: 4 } });
    const d = open();
    expect(d.labels()).toContain('The looped part of the song, bars 2–4 (0:06)');
    act(() => {
      const s = d.select();
      s.value = 'loop';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(d.select().value).toBe('loop');
    // Three bars: 6 s of music.
    expect(d.summary()).toContain('(6.0 s of music + 2 s tail)');
    expect([...document.querySelectorAll('input')].map((i) => i.placeholder).find((x) => x)).toMatch(/Bars 2–4$/);
    // One bar.
    act(() => patchRuntime({ songLoop: { fromBar: 3, toBar: 4 } }));
    expect(d.labels()).toContain('The looped part of the song, bar 4 (0:02)');
    expect(d.summary()).toContain('(2.0 s of music + 2 s tail)');
    act(() => patchRuntime({ songLoop: null }));
    expect(d.labels().some((l) => l?.startsWith('The looped part'))).toBe(false);
    expect(d.select().value).toBe('song');
  });
});
