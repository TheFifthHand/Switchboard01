/**
 * r6 UX fixes, the pure parts:
 * - what a take or an added loop covered up on its row is said in its notice
 *   ("It replaced Bell Hook 2 (bars 10–11).");
 * - each project remembers the view it was last in (guarded storage);
 * - the "Click squares…" hint is only for the drums' grid, and its button
 *   says where ("Next, in Steps on Drums:"); a step the tour left out is
 *   never counted as done (the total never grows);
 * - the "Used 2×" badge.
 */
import { describe, expect, it } from 'vitest';
import { replacedLoopsText } from '../../src/app/replacedLoops';
import { PROJECT_VIEWS_KEY, projectView, rememberProjectView } from '../../src/app/projectViews';
import type { RuntimeState } from '../../src/app/runtime';
import { placesBadge, placesTip } from '../../src/app/views/arrange/songModel';
import type { HintId } from '../../src/app/views/hints/hintsState';
import { HINT_STEPS, currentHint, hintWhere, type HintContext } from '../../src/app/views/hints/steps';
import { watchHints } from '../../src/app/views/hints/tracker';
import { BLANK_STARTER, getStarter } from '../../src/content/starters';
import type { Project } from '../../src/project/types';
import { ProjectStore } from '../../src/state/projectStore';
import { createStore } from '../../src/state/store';
import type { View } from '../../src/state/uiStore';

function house(): Project {
  return getStarter('house')!.build();
}

describe('what an edit covered up on a row', () => {
  it('names a loop it removed with its bars, one it cut short as "part of", and nothing when it covered nothing', () => {
    const before = house();
    const bass = before.tracks[2];
    const clips = bass.clips.filter((c) => c);
    before.arrangement.regions = [
      { id: 'a', trackId: bass.id, clipId: clips[0]!.id, start: 9, bars: 2, offset: 0 },
      { id: 'b', trackId: bass.id, clipId: clips[1]!.id, start: 12, bars: 4, offset: 0 },
      { id: 'c', trackId: before.tracks[0].id, clipId: before.tracks[0].clips.find((c) => c)!.id, start: 8, bars: 4, offset: 0 },
    ];
    const after = structuredClone(before);
    after.arrangement.regions = after.arrangement.regions.filter((r) => r.id !== 'a');
    after.arrangement.regions.find((r) => r.id === 'b')!.start = 13;
    after.arrangement.regions.find((r) => r.id === 'b')!.bars = 3;
    after.arrangement.regions.find((r) => r.id === 'b')!.offset = 1;
    expect(replacedLoopsText(before, after, bass.id)).toBe(`It replaced ${clips[0]!.name} (bars 10–11) and part of ${clips[1]!.name}.`);
    // Another part's row is not this edit's business; an untouched row says nothing.
    expect(replacedLoopsText(before, after, before.tracks[0].id)).toBe('');
    expect(replacedLoopsText(before, before, bass.id)).toBe('');
  });

  it('a one-bar loop says "bar"; many are summed up', () => {
    const before = house();
    const bass = before.tracks[2];
    const clip = bass.clips.find((c) => c)!;
    before.arrangement.regions = [0, 2, 4, 6, 8].map((start, i) => ({ id: `r${i}`, trackId: bass.id, clipId: clip.id, start, bars: 1, offset: 0 }));
    const after = structuredClone(before);
    after.arrangement.regions = [];
    expect(replacedLoopsText(before, after, bass.id)).toBe(`It replaced ${clip.name} (bar 1), ${clip.name} (bar 3) and 3 more loops.`);
  });
});

describe('the view a project was last in', () => {
  function memory() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  }

  it('is remembered per project, newest first, and anything malformed is ignored', () => {
    const s = memory();
    expect(projectView('p1', s)).toBeNull();
    rememberProjectView('p1', 'arrange', s);
    rememberProjectView('p2', 'mix', s);
    rememberProjectView('p1', 'shape', s);
    expect(projectView('p1', s)).toBe('shape');
    expect(projectView('p2', s)).toBe('mix');
    expect(JSON.parse(s.m.get(PROJECT_VIEWS_KEY)!)[0]).toEqual(['p1', 'shape']);
    s.setItem(PROJECT_VIEWS_KEY, '{nope');
    expect(projectView('p1', s)).toBeNull();
    s.setItem(PROJECT_VIEWS_KEY, JSON.stringify([['p3', 'kitchen'], ['p4', 'play']]));
    expect(projectView('p3', s)).toBeNull();
    expect(projectView('p4', s)).toBe('play');
  });

  it('a storage that throws never breaks anything', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(() => rememberProjectView('p1', 'mix', broken)).not.toThrow();
    expect(projectView('p1', broken)).toBeNull();
  });
});

describe('the beat hint', () => {
  const beat = HINT_STEPS.find((s) => s.id === 'beat')!;
  const ctx = (over: Partial<HintContext> = {}): HintContext => ({ view: 'play', padMode: 'steps', bassName: 'Bass', drumsName: 'Drums', drumsMuted: false, recording: false, drumsHasNotes: false, ...over });

  it('is here only while Steps shows the drums; elsewhere it says where, with the part', () => {
    expect(beat.here(ctx())).toBe(true);
    expect(beat.here(ctx({ drumsSelected: true }))).toBe(true);
    expect(beat.here(ctx({ drumsSelected: false }))).toBe(false);
    expect(beat.go).toMatchObject({ view: 'play', padMode: 'steps', part: 'drums' });
    expect(hintWhere(beat.go!, ctx({ drumsSelected: false }))).toBe('Next, in Steps on Drums:');
    expect(hintWhere(beat.go!, ctx({ view: 'mix' }))).toBe('Next, in Play on Drums:');
    const now = currentHint([], ctx({ drumsSelected: false }));
    expect(now?.step.id).toBe('beat');
  });

  it('a step the tour leaves out is not counted when it is done (the total never grows)', () => {
    // A starter's drums already play a beat: the beat step is left out, and adding a hit does not count.
    const store = new ProjectStore(house());
    const rt = createStore<RuntimeState>({ playing: false, paused: false, mode: 'live', tracks: {}, recording: 'off' } as unknown as RuntimeState);
    const seen: HintId[] = [];
    watchHints({ project: store, history: store.info, runtime: rt, view: createStore<View>('play') }, (id) => seen.push(id));
    store.apply('test:Hit', (d) => {
      d.tracks[0].clips.find((c) => c)!.notes.push({ id: 'x', tick: 0, pitch: 0, velocity: 0.8, duration: 6 });
    });
    expect(seen).not.toContain('beat');
    // A blank project's empty drums: the same hit is the step.
    const blank = new ProjectStore(BLANK_STARTER.build());
    const seen2: HintId[] = [];
    watchHints({ project: blank, history: blank.info, runtime: rt, view: createStore<View>('play') }, (id) => seen2.push(id));
    blank.apply('test:Loop', (d) => {
      d.tracks[0].clips[0] = { id: 'c1', name: 'Drums 1', bars: 1, notes: [] } as unknown as (typeof d.tracks)[0]['clips'][0];
    });
    blank.apply('test:Hit', (d) => {
      d.tracks[0].clips[0]!.notes.push({ id: 'x', tick: 0, pitch: 0, velocity: 0.8, duration: 6 });
    });
    expect(seen2).toContain('beat');
  });
});

describe('the places badge', () => {
  it('reads "Used 2×", never a bare "×2" that looks like a repeat count; its tooltip says what it means', () => {
    expect(placesBadge(1)).toBeNull();
    expect(placesBadge(2)).toBe('Used 2×');
    expect(placesTip(2)).toBe('This loop plays in 2 places');
  });
});
