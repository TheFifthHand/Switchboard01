import { act, createElement as h, Fragment, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button, Dialog, Meter, NumberField, SegmentedControl, Switch, TipsProvider, ToastProvider, Tooltip, useToasts, type ToastApi } from '../../src/ui/components';
import { useRafLoop } from '../../src/ui/hooks/useRafLoop';
import { actFrame, cleanup, fire, frames, key, mount, pointer, pointIn, wait } from './ui-harness';

afterEach(cleanup);

/* ------------------------------------------------------------------ */
/* Meter                                                               */
/* ------------------------------------------------------------------ */

describe('Meter', () => {
  it('polls read() in its own animation-frame loop without React renders, and stops on unmount', async () => {
    let reads = 0;
    let level = 0.5;
    let renders = 0;
    function Host() {
      renders += 1;
      return h(Meter, { read: () => (reads++, level), label: 'Test meter', segments: 10, floorDb: -40 });
    }
    const m = mount(h(Host));
    await frames(6);
    expect(reads).toBeGreaterThanOrEqual(4);
    expect(renders).toBe(1);

    const segs = [...m.container.querySelectorAll<HTMLElement>('[data-on]')].filter((el) => el.hasAttribute('data-band'));
    expect(segs).toHaveLength(10);
    // 0.5 = -6 dB on a -40..0 dB scale -> 34/40 of 10 segments -> 9 lit
    expect(segs.filter((s) => s.dataset.on === '1')).toHaveLength(9);

    m.unmount();
    const after = reads;
    await frames(6);
    expect(reads).toBe(after);
  });

  it('lights the clip lamp near full scale and holds the peak', async () => {
    let level = 1.05;
    const m = mount(h(Meter, { read: () => level, label: 'Clip meter', segments: 12 }));
    await frames(3);
    const root = m.container.querySelector<HTMLElement>('[role="meter"]')!;
    const clip = [...root.querySelectorAll<HTMLElement>('[data-on]')].find((el) => !el.hasAttribute('data-band'))!;
    expect(clip.dataset.on).toBe('1');
    level = 0;
    await frames(3);
    // The level falls away but the clip lamp latches and the peak segment holds.
    const segs = [...root.querySelectorAll<HTMLElement>('[data-band]')];
    expect(clip.dataset.on).toBe('1');
    expect(segs[segs.length - 1].dataset.on).toBe('1');
    await wait(300);
    expect(root.getAttribute('aria-valuetext')).not.toBe('Silent');
  });

  it('shows silence as no lit segments', async () => {
    const m = mount(h(Meter, { read: () => 0, label: 'Quiet', segments: 8 }));
    await frames(3);
    expect(m.container.querySelectorAll('[data-band][data-on="1"]')).toHaveLength(0);
    await wait(300);
    expect(m.container.querySelector('[role="meter"]')!.getAttribute('aria-valuetext')).toBe('Silent');
  });
});

describe('useRafLoop', () => {
  it('runs only while active and stops on unmount', async () => {
    let calls = 0;
    function Host({ active }: { active: boolean }) {
      useRafLoop(() => {
        calls += 1;
      }, active);
      return null;
    }
    const m = mount(h(Host, { active: false }));
    await frames(3);
    expect(calls).toBe(0);
    m.rerender(h(Host, { active: true }));
    await frames(4);
    expect(calls).toBeGreaterThanOrEqual(2);
    m.unmount();
    const after = calls;
    await frames(4);
    expect(calls).toBe(after);
  });
});

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

function DialogHost() {
  const [open, setOpen] = useState(false);
  return h(
    Fragment,
    null,
    h('button', { 'data-testid': 'opener', onClick: () => setOpen(true) }, 'Open'),
    h(
      Dialog,
      { open, onClose: () => setOpen(false), title: 'Export audio', description: 'Renders a WAV file.', actions: h(Button, { onClick: () => setOpen(false) }, 'Done') },
      h('input', { 'data-testid': 'first', 'aria-label': 'Name' }),
    ),
  );
}

describe('Dialog', () => {
  it('is a labelled modal that takes focus, traps Tab, closes on Escape and restores focus', () => {
    const m = mount(h(DialogHost));
    const opener = m.container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    opener.focus();
    fire(opener, new MouseEvent('click', { bubbles: true }));

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('Export audio');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent).toBe('Renders a WAV file.');
    const first = dialog.querySelector<HTMLInputElement>('[data-testid="first"]')!;
    expect(document.activeElement).toBe(first);

    // Tab from the last focusable element wraps to the first; Shift+Tab from the first wraps to the last.
    const focusables = [...dialog.querySelectorAll<HTMLElement>('button, input')];
    const last = focusables[focusables.length - 1];
    last.focus();
    const tab = key(last, 'keydown', { key: 'Tab' });
    expect(tab.defaultPrevented).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    const firstFocusable = focusables[0];
    firstFocusable.focus();
    key(firstFocusable, 'keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    // Focus escaping the dialog is pulled back in.
    opener.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);

    key(document.activeElement!, 'keydown', { key: 'Escape' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on a backdrop press but not on a press inside', () => {
    const m = mount(h(DialogHost));
    fire(m.container.querySelector('[data-testid="opener"]')!, new MouseEvent('click', { bubbles: true }));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    pointer(dialog, 'pointerdown');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    pointer(dialog.parentElement!, 'pointerdown');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Tooltip / Tips                                                      */
/* ------------------------------------------------------------------ */

function TipHost({ enabled }: { enabled: boolean }) {
  return h(
    TipsProvider,
    { enabled },
    h(Tooltip, { name: 'Space', tip: 'Adds a room around this sound.', detail: 'Reverb send amount.', children: h('button', { 'data-testid': 'trigger' }, 'Space') }),
    h('button', { 'data-testid': 'other' }, 'Other'),
  );
}

const bubble = () => [...document.body.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].find((el) => el.textContent?.includes('Adds a room')) ?? null;

describe('Tooltip', () => {
  it('shows plain language first and detail second on keyboard focus, immediately', async () => {
    const m = mount(h(TipHost, { enabled: true }));
    const other = m.container.querySelector<HTMLElement>('[data-testid="other"]')!;
    const trigger = m.container.querySelector<HTMLElement>('[data-testid="trigger"]')!;
    other.focus();
    key(other, 'keydown', { key: 'Tab' }); // mark the interaction as keyboard for :focus-visible
    trigger.focus();
    await actFrame();
    const b = bubble();
    expect(b).not.toBeNull();
    const text = b!.textContent!;
    expect(text.indexOf('Adds a room')).toBeLessThan(text.indexOf('Reverb send'));
    expect(getComputedStyle(b!).pointerEvents).toBe('none');
    // Stays inside the viewport.
    const r = b!.getBoundingClientRect();
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
    // Pressing hides it so it never gets in the way.
    pointer(trigger, 'pointerdown', pointIn(trigger));
    expect(bubble()).toBeNull();
  });

  it('appears after a hover delay, and describes the trigger for screen readers', async () => {
    const m = mount(h(TipHost, { enabled: true }));
    const trigger = m.container.querySelector<HTMLElement>('[data-testid="trigger"]')!;
    pointer(trigger, 'pointerover', { ...pointIn(trigger), buttons: 0 });
    await wait(120);
    expect(bubble()).toBeNull();
    await wait(400);
    await actFrame();
    expect(bubble()).not.toBeNull();
    pointer(trigger, 'pointerout', { ...pointIn(trigger), buttons: 0, relatedTarget: document.body });
    expect(bubble()).toBeNull();
    const desc = document.getElementById(trigger.getAttribute('aria-describedby')!)!;
    expect(desc.textContent).toContain('Adds a room around this sound.');
  });

  it('with Tips off, only the name is available', async () => {
    const m = mount(h(TipHost, { enabled: false }));
    const trigger = m.container.querySelector<HTMLElement>('[data-testid="trigger"]')!;
    const desc = document.getElementById(trigger.getAttribute('aria-describedby')!)!;
    expect(desc.textContent).toContain('Space');
    expect(desc.textContent).not.toContain('Adds a room');
  });
});

/* ------------------------------------------------------------------ */
/* SegmentedControl                                                    */
/* ------------------------------------------------------------------ */

const MODES = [
  { value: 'loops', label: 'Loops' },
  { value: 'drums', label: 'Drums' },
  { value: 'notes', label: 'Notes' },
  { value: 'steps', label: 'Steps' },
] as const;

function SegHost({ kind, log }: { kind: 'tabs' | 'radio'; log: string[] }) {
  const [v, setV] = useState<(typeof MODES)[number]['value']>('loops');
  return h(SegmentedControl, {
    label: 'Pad mode',
    kind,
    options: MODES,
    value: v,
    controls: 'panel',
    onChange: (next: (typeof MODES)[number]['value']) => {
      log.push(next);
      setV(next);
    },
  });
}

describe('SegmentedControl', () => {
  it('radio group: arrow keys move and select with roving focus; Home/End jump', () => {
    const log: string[] = [];
    const m = mount(h(SegHost, { kind: 'radio', log }));
    const group = m.container.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute('aria-label')).toBe('Pad mode');
    const radios = () => [...m.container.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
    radios()[0].focus();
    key(radios()[0], 'keydown', { key: 'ArrowRight' });
    expect(log).toEqual(['drums']);
    expect(document.activeElement).toBe(radios()[1]);
    expect(radios()[1].getAttribute('aria-checked')).toBe('true');
    key(radios()[1], 'keydown', { key: 'End' });
    key(radios()[3], 'keydown', { key: 'ArrowRight' }); // wraps
    key(radios()[0], 'keydown', { key: 'ArrowLeft' });
    expect(log).toEqual(['drums', 'steps', 'loops', 'steps']);
  });

  it('tabs: tablist semantics, aria-selected and aria-controls; clicks select', () => {
    const log: string[] = [];
    const m = mount(h(SegHost, { kind: 'tabs', log }));
    expect(m.container.querySelector('[role="tablist"]')).toBeTruthy();
    const tabs = [...m.container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].getAttribute('aria-controls')).toBe('panel');
    fire(tabs[2], new MouseEvent('click', { bubbles: true }));
    expect(log).toEqual(['notes']);
  });
});

/* ------------------------------------------------------------------ */
/* NumberField                                                         */
/* ------------------------------------------------------------------ */

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  fire(input, new Event('input', { bubbles: true }));
}

describe('NumberField', () => {
  function setup(value = 120) {
    const calls: [number, { gesture: string; final: boolean }][] = [];
    const m = mount(h(NumberField, { label: 'Tempo', value, min: 40, max: 220, step: 1, fineStep: 0.1, unit: 'BPM', onChange: (v: number, info: { gesture: string; final: boolean }) => calls.push([v, info]) }));
    const input = m.container.querySelector<HTMLInputElement>('input')!;
    return { calls, input, m };
  }

  it('typed values are clamped and committed on Enter, units allowed', () => {
    const { calls, input } = setup();
    input.focus();
    setInput(input, '124.5 bpm');
    key(input, 'keydown', { key: 'Enter' });
    expect(calls.at(-1)).toEqual([124.5, expect.objectContaining({ final: true })]);
    setInput(input, '999');
    key(input, 'keydown', { key: 'Enter' });
    expect(calls.at(-1)![0]).toBe(220);
  });

  it('invalid text reverts without a change', () => {
    const { calls, input } = setup();
    input.focus();
    setInput(input, 'fast');
    key(input, 'keydown', { key: 'Enter' });
    expect(calls).toEqual([]);
    expect(input.value).toBe('120');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('arrow keys step (Shift = fine) as one gesture', () => {
    const { calls, input } = setup();
    input.focus();
    key(input, 'keydown', { key: 'ArrowUp' });
    key(input, 'keydown', { key: 'ArrowUp', shiftKey: true });
    key(input, 'keydown', { key: 'PageDown' });
    expect(calls.map((c) => c[0])).toEqual([121, 121.1, 111.1]);
    expect(new Set(calls.map((c) => c[1].gesture)).size).toBe(1);
    input.blur();
    expect(calls.at(-1)![1].final).toBe(true);
  });

  it('dragging up raises the value; a click without movement starts typing', async () => {
    const { calls, input } = setup();
    const p = pointIn(input);
    pointer(input, 'pointerdown', p);
    pointer(input, 'pointermove', { ...p, clientY: p.clientY - 5 }); // passes the drag threshold
    pointer(input, 'pointermove', { ...p, clientY: p.clientY - 25 }); // 20 px = 5 steps
    await actFrame();
    pointer(input, 'pointerup', { ...p, clientY: p.clientY - 25 });
    expect(calls.at(-1)).toEqual([125, expect.objectContaining({ final: true })]);
    expect(document.activeElement).not.toBe(input);

    pointer(input, 'pointerdown', p);
    pointer(input, 'pointerup', p);
    expect(document.activeElement).toBe(input);
  });

  it('exposes spinbutton semantics', () => {
    const { input } = setup(124);
    expect(input.getAttribute('role')).toBe('spinbutton');
    expect(input.getAttribute('aria-valuenow')).toBe('124');
    expect(input.getAttribute('aria-valuetext')).toBe('124 BPM');
    expect(input.labels?.[0]?.textContent).toBe('Tempo');
  });
});

/* ------------------------------------------------------------------ */
/* Switch, Button, toasts                                              */
/* ------------------------------------------------------------------ */

describe('Switch and Button', () => {
  it('Switch is a named role=switch with a visible On/Off legend', () => {
    const log: boolean[] = [];
    const m = mount(h(Switch, { label: 'Metronome', checked: false, onChange: (v: boolean) => log.push(v) }));
    const sw = m.container.querySelector<HTMLElement>('[role="switch"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.textContent).toContain('Off');
    fire(sw, new MouseEvent('click', { bubbles: true }));
    expect(log).toEqual([true]);
    const labelId = sw.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelId)!.textContent).toBe('Metronome');
  });

  it('a toggle button exposes aria-pressed', () => {
    const m = mount(h(Button, { pressed: true, variant: 'transport' }, 'Play'));
    expect(m.container.querySelector('button')!.getAttribute('aria-pressed')).toBe('true');
    const plain = mount(h(Button, null, 'Save'));
    expect(plain.container.querySelector('button')!.hasAttribute('aria-pressed')).toBe(false);
  });
});

describe('Toasts', () => {
  it('shows an undo notice whose action runs once and dismisses the toast', async () => {
    let api: ToastApi | null = null;
    let undone = 0;
    function Grab() {
      api = useToasts();
      return null;
    }
    mount(h(ToastProvider, null, h(Grab)));
    act(() => {
      api!.show({ message: 'Variation applied to Bass.', action: { label: 'Undo', onAction: () => undone++ } });
    });
    const status = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((el) => el.textContent?.includes('Variation applied'))!;
    expect(status).toBeTruthy();
    const undo = [...status.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!;
    fire(undo, new MouseEvent('click', { bubbles: true }));
    expect(undone).toBe(1);
    expect([...document.querySelectorAll('[role="status"]')].some((el) => el.textContent?.includes('Variation applied'))).toBe(false);
  });
});
