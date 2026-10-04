/**
 * Match target iterates (the Mix view measures, moves Loudness, measures
 * again): passes that share a gesture id are one undo step, labelled like a
 * single match; without one each pass stays its own step.
 */
import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/project/factory';
import { MASTERING_PARAMS, readParam } from '../../src/project/params';
import { ProjectStore } from '../../src/state/projectStore';
import { matchLoudnessTarget, setMasteringParam } from '../../src/state/commands';

const fresh = () => new ProjectStore(createProject({ now: 0 }));
const loudness = (s: ProjectStore) => readParam(MASTERING_PARAMS, s.getState().mastering.params, 'loudness');

describe('matchLoudnessTarget gesture', () => {
  it('passes with one gesture id are one undo step back to where the match started', () => {
    const s = fresh();
    setMasteringParam(s, 'loudness', 2);
    const before = s.historySize().undo;
    expect(matchLoudnessTarget(s, -14, -20, 'match-1')).toMatchObject({ changed: true, before: 2, after: 8 });
    expect(matchLoudnessTarget(s, -14, -15.2, 'match-1')).toMatchObject({ changed: true, before: 8, after: 9.2 });
    expect(matchLoudnessTarget(s, -14, -14.3, 'match-1')).toMatchObject({ changed: true, before: 9.2, after: 9.5 });
    // A pass that changes nothing adds nothing.
    expect(matchLoudnessTarget(s, -14, -14.01, 'match-1')).toMatchObject({ changed: false });
    expect(s.historySize().undo).toBe(before + 1);
    expect(s.undoLabel()).toBe('Match loudness target');
    s.undo();
    expect(loudness(s)).toBe(2);
    s.redo();
    expect(loudness(s)).toBe(9.5);
  });

  it('without a gesture (or with another id) each pass is its own step', () => {
    const s = fresh();
    const before = s.historySize().undo;
    matchLoudnessTarget(s, -14, -20);
    matchLoudnessTarget(s, -14, -15);
    matchLoudnessTarget(s, -14, -16, 'match-a');
    matchLoudnessTarget(s, -14, -15, 'match-b');
    expect(s.historySize().undo).toBe(before + 4);
    s.undo();
    s.undo();
    expect(loudness(s)).toBe(7);
  });
});
