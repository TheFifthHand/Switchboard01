import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/project/factory';
import { resolveAllParams } from '../../src/project/resolve';

describe('spine', () => {
  it('creates an 8-track project with a complete default patch', () => {
    const p = createProject();
    expect(p.tracks).toHaveLength(8);
    expect(p.scenes).toHaveLength(4);
    expect(p.patch.modules.find((m) => m.id === 'master')).toBeTruthy();
    const resolved = resolveAllParams(p);
    // Tone at 0.5 leaves the filter fully open
    expect(resolved.get('t1:filter')!.cutoff).toBeCloseTo(20000, 0);
  });
});
