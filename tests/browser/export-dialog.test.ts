/**
 * The Export dialog, opened from the Song view or while the song plays,
 * offers the song (bar 1 to its end); with a song loop set it offers the loop
 * (its bars once, with the tail), and its duration is the loop's bars plus
 * the tail. It offers every scene the project has (1 to 8).
 */
import '../../src/ui/theme.css';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { ExportDialog } from '../../src/app/views/ExportDialog';
import { createClip, createProject } from '../../src/project/factory';
import type { Project } from '../../src/project/types';
import { setView } from '../../src/state/uiStore';
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

describe('Export from the Song view', () => {
  it('opened in the Song view it offers the song, from bar 1 to its end', () => {
    setView('arrange');
    const d = open();
    expect(d.select().value).toBe('song');
    expect(d.labels()).toContain('Song (5 bars)');
    expect(d.summary()).toContain('Duration 12.0 s (10.0 s of music + 2 s tail)');
  });

  it('opened anywhere while the song plays (or is paused) it offers the song', () => {
    setView('play');
    patchRuntime({ playing: false, paused: true, mode: 'song' });
    expect(open().select().value).toBe('song');
  });

  it('in Play with the pads it keeps the clips playing now', () => {
    setView('play');
    expect(open().select().value).toBe('now');
  });

  it('offers every scene of the project: 8 scenes give 8 choices, 2 scenes give 2', () => {
    setView('play');
    for (const names of [['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], ['Intro', 'Drop']]) {
      act(() => session.store.replace(createProject({ scenes: names, now: 0 }), { resetHistory: true }));
      const d = open();
      const scenes = d.labels().filter((l) => l?.startsWith('Scene: '));
      expect(scenes).toEqual(names.map((n) => `Scene: ${n} (loop)`));
      cleanup();
    }
  });

  it('with a loop set: "Loop (bars 2–4)" exports those bars once with the tail; cleared, the song again', () => {
    setView('arrange');
    patchRuntime({ songLoop: { fromBar: 1, toBar: 4 } });
    const d = open();
    expect(d.labels()).toContain('Loop (bars 2–4)');
    act(() => {
      const s = d.select();
      s.value = 'loop';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(d.select().value).toBe('loop');
    // Three bars: 6 s of music.
    expect(d.summary()).toContain('(6.0 s of music + 2 s tail)');
    expect([...document.querySelectorAll('input')].map((i) => i.placeholder).find((x) => x)).toMatch(/Bars 2–4$/);
    // One bar: "Loop (bar 4)".
    act(() => patchRuntime({ songLoop: { fromBar: 3, toBar: 4 } }));
    expect(d.labels()).toContain('Loop (bar 4)');
    expect(d.summary()).toContain('(2.0 s of music + 2 s tail)');
    act(() => patchRuntime({ songLoop: null }));
    expect(d.labels().some((l) => l?.startsWith('Loop'))).toBe(false);
    expect(d.select().value).toBe('song');
  });
});
