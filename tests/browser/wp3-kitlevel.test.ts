/**
 * Kit Level in the Shape view (real Chromium, real session): resetting a
 * kit's Level returns it to the level that matches the kit to the rest of
 * the project, and a part switched to a kit starts at that level.
 */
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../src/ui/theme.css';
import { TipsProvider } from '../../src/ui/components';
import { session } from '../../src/app/instance';
import { ShapeView } from '../../src/app/views/shape/ShapeView';
import { kitInfo } from '../../src/content/catalog';
import { BLANK } from '../../src/content/starters/blank';
import { HOUSE } from '../../src/content/starters/house';
import type { Project } from '../../src/project/types';
import * as cmd from '../../src/state/commands';
import { selectModule, selectTrack, setCablesOpen, setUiMode } from '../../src/state/uiStore';
import { cleanup, fire, key, mount } from './ui-harness';

const project = (): Project => session.store.getState();
const level = (trackId: string) => project().tracks.find((t) => t.id === trackId)!.instrument.params.level;

function setup(p: Project, trackId: string) {
  act(() => {
    session.store.replace(p);
    selectTrack(trackId);
    setCablesOpen(false);
    selectModule(null);
    // The kit-wide knobs live in the instrument panel, shown with every setting (Advanced).
    setUiMode('advanced');
  });
  const m = mount(h(TipsProvider, { enabled: false }, h(ShapeView)), { width: 1366 });
  m.container.style.height = '720px';
  return m;
}

/** The kit-wide Level knob (the voice table's knobs are named "<voice> level"). */
function kitLevel(root: HTMLElement): HTMLElement {
  const section = root.querySelector<HTMLElement>('section[aria-label="Whole kit"]');
  const el = section?.querySelector<HTMLElement>('[role="slider"][aria-label="Level"]');
  if (!el) throw new Error('No kit Level knob');
  return el;
}

const dblclick = (el: HTMLElement) => fire(el, new MouseEvent('dblclick', { bubbles: true, cancelable: true }));

beforeEach(async () => {
  await page.viewport(1366, 768);
});

afterEach(() => cleanup());

describe('Kit Level', () => {
  it('double-click returns a kit to its matched level, not to 0 dB', () => {
    const house = HOUSE.build();
    const drums = house.tracks.find((t) => t.instrument.kind === 'drums' && t.instrument.kitId === 'tight-circuit')!;
    const perc = house.tracks.find((t) => t.instrument.kind === 'drums' && t.instrument.kitId === 'hand-percussion')!;
    const m = setup(house, drums.id);
    const knob = kitLevel(m.container);
    expect(level(drums.id)).toBe(-12.5);
    dblclick(knob);
    expect(level(drums.id)).toBe(kitInfo('tight-circuit')!.level);
    expect(Number(knob.getAttribute('aria-valuenow'))).toBe(-11);
    // Delete resets too; the hand kit has its own matched level.
    act(() => selectTrack(perc.id));
    key(kitLevel(m.container), 'keydown', { key: 'Delete' });
    expect(level(perc.id)).toBe(kitInfo('hand-percussion')!.level);
  });

  it('a lead part switched to a drum kit plays at the level of the project’s own drums', () => {
    const blank = BLANK.build();
    const lead = blank.tracks.find((t) => t.role === 'lead')!;
    const drums = blank.tracks.find((t) => t.role === 'drums')!;
    const m = setup(blank, lead.id);
    act(() => void session.accepted(cmd.changeInstrumentSound(session.store, lead.id, 'drums', 'bright-steel')));
    expect(level(lead.id)).toBe(level(drums.id));
    expect(Number(kitLevel(m.container).getAttribute('aria-valuenow'))).toBe(-11);
  });
});
