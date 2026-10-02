/**
 * The Export dialog, opened from Arrange or while the song plays, offers the
 * song; with a song loop set it offers the loop (its blocks once, with the
 * tail), and its duration is the loop's bars plus the tail.
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

/** 120 BPM, four one-bar scenes; song: b0 b1 (x2) b2 b3 (2 s per bar). */
function song(): Project {
  const p = createProject({ bpm: 120, now: 0 });
  for (const t of p.tracks) t.clips = t.clips.map(() => null);
  for (let row = 0; row < 4; row++) p.tracks[0].clips[row] = createClip(`r${row}`, 1, [{ tick: 0, pitch: 36, duration: 48, velocity: 0.9 }]);
  p.arrangement = { tailSeconds: 2, blocks: p.scenes.map((s, i) => ({ id: `b${i}`, sceneId: s.id, repeats: i === 1 ? 2 : 1 })) };
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

describe('Export from Arrange', () => {
  it('opened in Arrange it offers the song', () => {
    setView('arrange');
    const d = open();
    expect(d.select().value).toBe('song');
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

  it('with a loop set: "Loop (blocks 2–3)" exports those blocks once with the tail; cleared, the song again', () => {
    setView('arrange');
    patchRuntime({ songLoop: { fromBlockId: 'b2', toBlockId: 'b1' } });
    const d = open();
    expect(d.labels()).toContain('Loop (blocks 2–3)');
    act(() => {
      const s = d.select();
      s.value = 'loop';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(d.select().value).toBe('loop');
    // b1 (2 bars) and b2 (1 bar): 6 s of music.
    expect(d.summary()).toContain('(6.0 s of music + 2 s tail)');
    expect([...document.querySelectorAll('input')].map((i) => i.placeholder).find((x) => x)).toMatch(/Loop 2-3$/);
    // One block: "Loop (block 4)".
    act(() => patchRuntime({ songLoop: { fromBlockId: 'b3', toBlockId: 'b3' } }));
    expect(d.labels()).toContain('Loop (block 4)');
    expect(d.summary()).toContain('(2.0 s of music + 2 s tail)');
    act(() => patchRuntime({ songLoop: null }));
    expect(d.labels().some((l) => l?.startsWith('Loop'))).toBe(false);
    expect(d.select().value).toBe('song');
  });
});
